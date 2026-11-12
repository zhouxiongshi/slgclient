/**
 * R3 · UI 真点击全路径审计
 *
 * 与 smoke.cjs 的分工：smoke 只验「关键节点是否活着」，本文件负责
 * 把每一个页签、每一个面板入口、每一条分支真的点一遍并留证：
 *   - 点了之后面板是否可见
 *   - 正文是否有预期关键词（不是空白壳）
 *   - 有没有新的未捕获异常 / error 级控制台输出
 *
 * 输出 reports/ui-audit-<tag>.json，结构：
 *   { paths:[{id, ok, visible, keyword, textLen, sample}], failed:[...], pageErrors, consoleErrors }
 *
 * 触发方式：SLG_AUDIT=1（见 electron/main.cjs）
 */
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTO_LOGIN = `(function(){
  try {
    var cc = window.cc || (window.game && window.game.cc);
    if (!cc || !cc.director) return { ok:false, why:'no cc global' };
    var scene = cc.director.getScene();
    if (!scene) return { ok:false, why:'no scene' };
    var found = null;
    (function walk(n){
      if (!n || found) return;
      var comps = n.components || [];
      for (var i=0;i<comps.length;i++){
        var c = comps[i];
        var ctor = (c && c.constructor && c.constructor.name) || '';
        if (/LoginLogic/i.test(ctor) || (typeof c.onClickLogin === 'function')) { found = c; return; }
      }
      (n.children || []).forEach(walk);
    })(scene);
    if (!found) return { ok:false, why:'LoginLogic not found' };
    if (found.editName) found.editName.string = 'player';
    if (found.editPass) found.editPass.string = 'audit123';
    found.onClickLogin();
    return { ok:true, why:'clicked via LoginLogic.onClickLogin' };
  } catch (e) { return { ok:false, why:String(e && e.stack || e) }; }
})()`;

const WALK = `(async function(){
  var out = [];
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var vis = function(el){
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  };
  var txt = function(el){ return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; };
  async function wait(fn, ms){
    var t0 = Date.now();
    while (Date.now() - t0 < (ms || 9000)) {
      try { var v = fn(); if (v) return v; } catch (e) {}
      await sleep(140);
    }
    return null;
  }
  function rec(id, expect, extra){
    var t = extra && extra.text != null ? String(extra.text) : '';
    var kw = (expect || []).filter(function(k){ return t.indexOf(k) >= 0; });
    out.push({
      id: id,
      ok: !!extra && extra.visible !== false && (expect || []).length > 0 ? kw.length > 0 : !!extra && extra.visible !== false,
      visible: !!(extra && extra.visible),
      keyword: kw,
      expect: expect || [],
      textLen: t.length,
      sample: t.slice(0, 140),
      note: (extra && extra.note) || '',
    });
  }

  /* ---------- 0. 等沙盘就绪 ---------- */
  await wait(function(){ return document.getElementById('slgDock') || (typeof window.__slgStrategyShow === 'function'); }, 12000);

  /* ---------- 1. 举义页：8 卡 → 择都 → 提交 ---------- */
  var oathEl = await wait(function(){ return document.getElementById('slgOath'); }, 8000);
  if (oathEl) {
    var lords = Array.from(document.querySelectorAll('.slgOathLord'));
    rec('oath.render', ['举', '义'], { visible: vis(oathEl), text: txt(oathEl) + ' ' + lords.length });
    if (lords.length) { lords[0].click(); await sleep(500); }
    var cities = Array.from(document.querySelectorAll('.slgOathCity'));
    rec('oath.cities', ['都'], { visible: cities.length > 0, text: cities.map(function(c){ return txt(c); }).join(' ') });
    if (cities.length) {
      cities[0].click();
      await wait(function(){ return !document.getElementById('slgOath'); }, 8000);
      await sleep(600);
    }
    rec('oath.submit', [], { visible: !document.getElementById('slgOath'), text: 'submitted' });
  } else {
    rec('oath.render', [], { visible: true, text: '旧档已举义，跳过', note: 'skipped:oath-done' });
  }

  /* 让沙盘重新拉一次状态，举义后城归属已变 */
  if (typeof window.__slgStrategyShow === 'function') { try { window.__slgStrategyShow(); } catch (e) {} }
  await sleep(900);

  /* ---------- 2. 六府：7 个入口 + 每个面板内部页签 ---------- */
  var PANELS = [
    ['general', '武将', ['武将', '帐下']],
    ['strategy', '战略', ['城', '国势']],
    ['interior', '内政', ['内政', '委任']],
    ['depot', '府库', ['府库', '物品']],
    ['equip', '兵刃', ['兵刃', '装备']],
    ['library', '战法库', ['战法', '库']],
  ];
  for (var pi = 0; pi < PANELS.length; pi++) {
    var p = PANELS[pi];
    var navBtn = document.querySelector('#slgPanelsNav button[data-id="' + p[0] + '"]');
    if (!navBtn) {
      rec('panel.' + p[0], p[2], { visible: false, text: '', note: 'nav-missing' });
      continue;
    }
    navBtn.click();
    await sleep(650);
    var body = document.getElementById('slgPanelsBody');
    var title = document.getElementById('slgPanelsTitle');
    rec('panel.' + p[0], p[2], { visible: vis(body), text: txt(title) + ' ' + txt(body) });

    // 内部页签（.tabs 里的按钮）逐个点
    var subCount = document.querySelectorAll('#slgPanelsBody .tabs button').length;
    for (var si = 0; si < subCount; si++) {
      var btns = document.querySelectorAll('#slgPanelsBody .tabs button');
      if (!btns[si]) continue;
      var label = txt(btns[si]);
      btns[si].click();
      await sleep(360);
      var b2 = document.getElementById('slgPanelsBody');
      rec('panel.' + p[0] + '.tab' + si, [], { visible: vis(b2), text: txt(b2), note: 'tab=' + label });
    }
  }

  /* 第 7 个入口：出征（独立面板，不在六府 DOM 内） */
  var warNav = document.querySelector('#slgPanelsNav button[data-id="war"]');
  if (warNav) {
    var before = (typeof window.__slgWarWindow) + '/' + (document.getElementById('slgWarWin') ? 'has' : 'none');
    warNav.click();
    await sleep(380);
    var earlyToast = document.querySelector('#slgUIv2 .toast');
    var earlyToastText = earlyToast ? txt(earlyToast) : '';
    /* 出征窗是异步渲染的：必须等它「真的有尺寸」再断言，固定毫秒会误报 */
    var ww = await wait(function(){
      var w = document.getElementById('slgWarWin');
      return w && w.getBoundingClientRect().width > 100 ? w : null;
    }, 10000);
    var anyWin = document.getElementById('slgWarWin');
    var toastText = '';
    var tEl = document.querySelector('#slgUIv2 .toast');
    if (tEl) toastText = txt(tEl);
    rec('panel.war', ['出征', '出击'], {
      visible: !!ww,
      text: txt(ww || anyWin),
      note: ww ? '' : ('not-visible-in-10s; before=' + before
        + '; exists=' + (anyWin ? ('rect=' + Math.round(anyWin.getBoundingClientRect().width) + 'x' + Math.round(anyWin.getBoundingClientRect().height)) : 'no')
        + '; earlyToast=' + earlyToastText),
    });
  } else {
    rec('panel.war', ['出征'], { visible: false, note: 'nav-missing' });
  }

  /* ---------- 3. 城池窗：本城 7 页签 ---------- */
  try { if (window.__slgPanels) window.__slgPanels.close(); } catch (e) {}
  await sleep(300);

  var HOME_TABS = ['概览', '内政', '征兵', '武将', '酒馆', '战报', '府库'];
  if (typeof window.__slgHomeWindow === 'function') window.__slgHomeWindow();
  await wait(function(){ return document.getElementById('slgCityWin'); }, 9000);
  await sleep(900);
  var cw = document.getElementById('slgCityWin');
  rec('city.home.open', ['本城'], { visible: vis(cw), text: txt(cw) });

  for (var ht = 0; ht < HOME_TABS.length; ht++) {
    var clicked = false;
    for (var tryN = 0; tryN < 3 && !clicked; tryN++) {
      var tabs = Array.from(document.querySelectorAll('#slgCityWin .tabs button'));
      var target = tabs.find(function(b){ return txt(b).indexOf(HOME_TABS[ht]) >= 0; });
      if (target) { target.click(); clicked = true; await sleep(650); }
      else { await sleep(400); }
    }
    var w2 = document.getElementById('slgCityWin');
    var text2 = txt(w2);
    rec('city.home.' + HOME_TABS[ht], [], {
      visible: vis(w2),
      text: text2,
      note: clicked ? '' : 'tab-not-found',
    });
  }

  /* 存档卡专项（府库页） */
  var slotText = txt(document.getElementById('slgCityWin'));
  rec('save.card', ['号档'], {
    visible: vis(document.getElementById('slgCityWin')),
    text: slotText,
    note: /导出存档文件/.test(slotText) ? '' : 'no-export-button',
  });
  rec('save.import', ['导入存档文件'], { visible: /导入存档文件/.test(slotText), text: slotText });

  /* ---------- 4. 城池窗：外城（选一个非己方城） ---------- */
  try { window.__slgCityClose && window.__slgCityClose(); } catch (e) {}
  await sleep(350);
  var st = await (await fetch('/__slg/strategy/state', { cache: 'no-store' })).json();
  var own = (st.cities || []).filter(function(c){ return c.owner === 'player'; }).map(function(c){ return c.id; });
  var foreign = (st.cities || []).find(function(c){ return c.owner !== 'player'; });
  if (foreign && typeof window.__slgCityWindow === 'function') {
    window.__slgCityWindow(foreign.id);
    await wait(function(){ return document.getElementById('slgCityWin'); }, 9000);
    await sleep(900);
    var fw = document.getElementById('slgCityWin');
    rec('city.foreign.open', [foreign.name], { visible: vis(fw), text: txt(fw) });

    var F_TABS = ['概览', '内政', '征兵', '武将', '酒馆', '战报'];
    for (var ft = 0; ft < F_TABS.length; ft++) {
      var tabs2 = Array.from(document.querySelectorAll('#slgCityWin .tabs button'));
      var t2 = tabs2.find(function(b){ return txt(b).indexOf(F_TABS[ft]) >= 0; });
      if (t2) { t2.click(); await sleep(550); }
      var fw2 = document.getElementById('slgCityWin');
      rec('city.foreign.' + F_TABS[ft], [], { visible: vis(fw2), text: txt(fw2), note: t2 ? '' : 'tab-not-found' });
    }
    /* 出征分支必须存在且可操作（P8 核心）：先切回「概览」，否则读到的是战报页正文 */
    var ovTab = Array.from(document.querySelectorAll('#slgCityWin .tabs button'))
      .find(function(b){ return txt(b).indexOf('概览') >= 0; });
    if (ovTab) { ovTab.click(); await sleep(650); }
    var fText = txt(document.getElementById('slgCityWin'));
    rec('city.foreign.war-entry', ['出征', '行军', '相邻'], {
      visible: vis(document.getElementById('slgCityWin')), text: fText,
    });
  } else {
    rec('city.foreign.open', [], { visible: false, note: 'no-foreign-city' });
  }
  try { window.__slgCityClose && window.__slgCityClose(); } catch (e) {}

  /* ---------- 5. 出征面板三页签 ---------- */
  if (typeof window.__slgWarWindow === 'function') {
    window.__slgWarWindow({ tab: 'go' });
    await wait(function(){ return document.getElementById('slgWarWin'); }, 9000);
    await sleep(800);
    var W_TABS = ['出击', '行军队列', '战报'];
    for (var wt = 0; wt < W_TABS.length; wt++) {
      var wb = Array.from(document.querySelectorAll('#slgWarWin .tabs button'));
      var tw = wb.find(function(b){ return txt(b).indexOf(W_TABS[wt]) >= 0; });
      if (tw) { tw.click(); await sleep(560); }
      var ww2 = document.getElementById('slgWarWin');
      rec('war.' + W_TABS[wt], [W_TABS[wt]], { visible: vis(ww2), text: txt(ww2), note: tw ? '' : 'tab-not-found' });
    }
    // 点回「出击」，再断言三块内容（否则读到的是最后点过的战报页）
    var goTab = Array.from(document.querySelectorAll('#slgWarWin .tabs button'))
      .find(function(b){ return txt(b).indexOf('出击') >= 0; });
    if (goTab) { goTab.click(); await sleep(600); }
    var goText = txt(document.getElementById('slgWarWin'));
    rec('war.go.content', ['出发城', '可派队伍', '可攻目标', '目标'], {
      visible: /出发城|目标|队伍/.test(goText), text: goText,
    });
    var closeW = document.querySelector('#slgWarWin [data-act="close"], #slgWarWin button');
    if (closeW) { try { closeW.click(); } catch (e) {} }
  } else {
    rec('war.go.content', [], { visible: false, note: '__slgWarWindow missing' });
  }

  /* ---------- 6. 沙盘交互：图层 / 缩放 / 检索 ---------- */
  if (typeof window.__slgStrategyShow === 'function') { try { window.__slgStrategyShow(); } catch (e) {} }
  await sleep(700);
  var dock = document.getElementById('slgDock');
  rec('map.dock', ['推演'], { visible: vis(dock), text: txt(dock) });

  var zoomIn = document.getElementById('slgBtnZoomIn');
  if (zoomIn) { zoomIn.click(); await sleep(260); zoomIn.click(); await sleep(260); }
  var zoomOut = document.getElementById('slgBtnZoomOut');
  if (zoomOut) { zoomOut.click(); await sleep(260); }
  rec('map.zoom', [], { visible: vis(dock), text: 'zoom-clicked', note: (zoomIn ? '' : 'no-zoom-in') + (zoomOut ? '' : ' no-zoom-out') });

  var side = document.getElementById('slgStratSide');
  var boxes = side ? side.querySelectorAll('input[type="checkbox"]') : [];
  rec('map.layers', ['图层'], {
    visible: vis(side) && boxes.length >= 6,
    text: (side ? txt(side) : '') + ' checkboxes=' + boxes.length,
    note: boxes.length >= 6 ? '' : 'layer-checkboxes-missing',
  });

  // 切换一个图层，确认不抛错且能点回来
  if (boxes.length) {
    boxes[0].click();
    await sleep(320);
    boxes[0].click();
    await sleep(320);
  }

  var searchInput = document.getElementById('slgStratFind');
  if (searchInput) {
    searchInput.value = '长安';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(450);
  }
  rec('map.search', [], {
    visible: !!searchInput,
    text: searchInput ? searchInput.value : '',
    note: searchInput ? '' : 'no-search-input',
  });

  /* ---------- 7. 交互增强层：术语 / 议程 / 队列 / 透镜 ---------- */
  var IX = window.__slgIX;
  if (IX) {
    var termNodes = document.querySelectorAll('[data-term]');
    rec('ix.terms', [], { visible: termNodes.length > 0, text: 'data-term=' + termNodes.length });

    /* 悬停靠的是 200~300ms 计时 + 真实鼠标坐标，脚本派发事件不可靠，
       改用交互层自己暴露的 IX.tip(id) —— 与玩家按 K 锁定是同一条路径 */
    var termId = termNodes[0] ? termNodes[0].getAttribute('data-term') : '';
    if (termId && IX.tip) { try { IX.tip(termId); } catch (e) {} await sleep(450); }
    var tip = document.querySelector('.slgIx-tip');
    rec('ix.tip', [], {
      visible: vis(tip),
      text: tip ? txt(tip) : '',
      note: termId ? 'term=' + termId : 'no-term-nodes',
    });

    rec('ix.agenda', [], { visible: vis(document.getElementById('slgIxAgenda')), text: txt(document.getElementById('slgIxAgenda')) });
    rec('ix.queue', [], { visible: vis(document.getElementById('slgIxQueue')), text: txt(document.getElementById('slgIxQueue')) });

    var lens = document.querySelectorAll('#slgIxLens button');
    rec('ix.lens', [], { visible: lens.length >= 6, text: 'lenses=' + lens.length });
    if (lens.length > 1) { lens[1].click(); await sleep(300); }
  } else {
    rec('ix.terms', [], { visible: false, note: '__slgIX missing' });
  }

  /* ---------- 8. 收尾：关掉所有覆盖层，确认回到沙盘 ---------- */
  try { if (window.__slgIX) window.__slgIX.closeAll(); } catch (e) {}
  try { if (window.__slgPanels) window.__slgPanels.close(); } catch (e) {}
  await sleep(300);
  rec('final.back-to-map', ['推演'], { visible: vis(document.getElementById('slgDock')), text: txt(document.getElementById('slgDock')) });

  return { paths: out, pageErrors: (window.__slgErrors || []).slice(0, 40) };
})()`;

async function runAudit(win, server, app) {
  const wc = win.webContents;
  const tag = process.env.SLG_SMOKE_TAG || 'original';
  const outDir = process.env.SLG_SMOKE_REPORT_DIR || path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });

  const consoleErrors = [];
  wc.on('console-message', (_e, level, message) => {
    const text = String(message);
    if (/Electron Security Warning/i.test(text)) return;
    if (level >= 2) consoleErrors.push(text);
  });

  const report = { startedAt: new Date().toISOString(), mode: 'ui-audit', tag, paths: [], pageErrors: [], consoleErrors: [] };

  try {
    // 采集页面异常（与 smoke 同一套钩子）
    await wc.executeJavaScript(`(function(){
      window.__slgErrors = [];
      window.addEventListener('error', function(e){
        window.__slgErrors.push({ msg:String(e.message), stack:String(e.error && e.error.stack || ''), src:String(e.filename)+':'+e.lineno });
      });
      window.addEventListener('unhandledrejection', function(e){
        window.__slgErrors.push({ msg:'unhandledrejection: '+String(e.reason), stack:String(e.reason && e.reason.stack || '') });
      });
      return true;
    })()`, true);

    // 等客户端连上并进入地图
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const has = await wc.executeJavaScript('!!(window.cc && window.cc.director && window.cc.director.getScene())', true);
      if (has) break;
      await sleep(400);
    }
    const login = await wc.executeJavaScript(AUTO_LOGIN, true);
    report.autoLogin = login;

    // 等沙盘外壳就绪
    await wc.executeJavaScript(`(async function(){
      var t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        if (typeof window.__slgStrategyShow === 'function' && document.getElementById('slgDock')) return true;
        await new Promise(function(r){ setTimeout(r, 200); });
      }
      return false;
    })()`, true);

    const res = await wc.executeJavaScript(WALK, true);
    report.paths = res.paths || [];
    report.pageErrors = res.pageErrors || [];

    try {
      const img = await wc.capturePage();
      fs.writeFileSync(path.join(outDir, `ui-audit-${tag}.png`), img.toPNG());
    } catch { /* 截图失败不影响结果 */ }
  } catch (err) {
    report.fatal = String((err && err.stack) || err);
  }

  report.consoleErrors = consoleErrors;
  report.failed = report.paths.filter((p) => !p.ok).map((p) => p.id);
  report.passed = !report.fatal && report.failed.length === 0 && report.pageErrors.length === 0 && consoleErrors.length === 0;
  report.counts = {
    paths: report.paths.length,
    ok: report.paths.filter((p) => p.ok).length,
    failed: report.failed.length,
    pageErrors: report.pageErrors.length,
    consoleErrors: consoleErrors.length,
  };
  report.finishedAt = new Date().toISOString();

  fs.writeFileSync(path.join(outDir, `ui-audit-${tag}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log('[slg-offline:audit]', JSON.stringify({
    passed: report.passed, counts: report.counts, failed: report.failed, fatal: report.fatal,
  }, null, 2));

  if (process.env.SLG_SMOKE_EXIT === '1') {
    setTimeout(() => app.exit(report.passed ? 0 : 1), 500);
  }
  return report;
}

module.exports = { runAudit };
