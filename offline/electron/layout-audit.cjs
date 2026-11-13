/**
 * LY + AE · 页面布局与设计美观审计
 *
 * 布局（几何）：5 档分辨率 × 4 个界面状态，检查
 *   - 视觉元素是否溢出视口 / 被裁切
 *   - 主窗是否严格遵守「一屏一窗」
 *   - 可点元素是否 ≥28×28（低精度鼠标与触控下限）
 *   - 字号三档（85/100/120）下文本是否溢出容器
 * 美观（视觉）：
 *   - 注入层实际渲染出的色值/字体/圆角/动效时长分布（token 是否收敛）
 *   - 文案洁净（undefined / NaN / 占位符）
 *
 * 为什么不用截图比对：本项目 UI 全部运行时注入，像素基线会随字号与分辨率
 * 一起变，维护成本极高且容易假红。几何与样式分布是可断言的客观量，
 * 截图只作留证（reports/layout-<tag>.png）。
 *
 * 输出 reports/layout-<tag>.json
 * 触发：SLG_LAYOUT=1
 */
const fs = require('node:fs');
const path = require('node:path');
const { consoleSeverity, consolePayload } = require('./console-level.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  [1280, 720], [1366, 768], [1920, 1080], [2560, 1440], [3440, 1440],
];
const FONT_TIERS = [85, 100, 120];
/* GDD §10.1 表：按视口宽度给出期望的抽屉宽 */
const DRAWER_BY_WIDTH = [[1280, 360], [1365, 380], [1920, 420], [2560, 460], [3440, 480]];

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
    if (found.editPass) found.editPass.string = 'layout123';
    found.onClickLogin();
    return { ok:true, why:'clicked' };
  } catch (e) { return { ok:false, why:String(e && e.stack || e) }; }
})()`;

/** 在 renderer 里量一次当前界面。状态由主进程切换。 */
const MEASURE = `(function(){
  var out = {
    viewport: { w: innerWidth, h: innerHeight, dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100 },
    offscreen: [], clipped: [], smallTargets: [], mainWins: [], drawer: null,
    styles: { colors: {}, fonts: {}, radii: {}, durations: {} },
    textIssues: [],
  };
  var r0 = function(v){ return Math.round(v); };
  function box(el){
    var r = el.getBoundingClientRect();
    return { l: r0(r.left), t: r0(r.top), r: r0(r.right), b: r0(r.bottom), w: r0(r.width), h: r0(r.height) };
  }
  function visible(el){
    if (!el) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  function label(el){
    if (el.id) return '#' + el.id;
    var c = String(el.className || '').split(' ')[0];
    return el.tagName.toLowerCase() + (c ? '.' + c : '');
  }

  /* 1) 溢出视口：只查「浮层/主容器」，不含画布内部与允许滚动的正文 */
  out.containers = [];
  var containers = document.querySelectorAll(
    '#slgPanelsWin, #slgCityWin, #slgWarWin, #slgStratSide, #slgDock, .slgIx-drawer, .slgIx-modal, .slgIx-panel, #slgIxRoot > .slgIx-tip');
  Array.prototype.forEach.call(containers, function(el){
    if (!visible(el)) return;
    var b = box(el);
    out.containers.push({ el: label(el), box: b });
    if (b.r > innerWidth + 1 || b.b > innerHeight + 1 || b.l < -1 || b.t < -1) {
      out.offscreen.push({ el: label(el), box: b });
    }
  });
  /* 自证字段：没有这些，「零裁切」就分不清是真没问题还是根本没渲染 */
  out.containerCount = out.containers.length;
  out.textLen = {
    panelsBody: ((document.getElementById('slgPanelsBody') || {}).textContent || '').length,
    cityWin: ((document.getElementById('slgCityWin') || {}).textContent || '').length,
    warWin: ((document.getElementById('slgWarWin') || {}).textContent || '').length,
    dock: ((document.getElementById('slgDock') || {}).textContent || '').length,
  };
  /* 空壳取证：内容不达门槛时把真实结构留一份，否则只能猜 */
  var wEl = document.getElementById('slgWarWin');
  if (wEl) out.warDump = { children: wEl.children.length, html: wEl.innerHTML.slice(0, 420) };
  var cEl = document.getElementById('slgCityWin');
  if (cEl) out.cityDump = { children: cEl.children.length, html: cEl.innerHTML.slice(0, 260) };

  /* 2) 文本裁切：只看叶子文本节点，且 overflow 为 hidden/scroll 的容器 */
  Array.prototype.forEach.call(
    document.querySelectorAll('#slgPanelsWin *, #slgCityWin *, #slgWarWin *, #slgIxRoot *'),
    function(el){
      if (el.children.length > 0 || !visible(el)) return;
      var t = (el.textContent || '').trim();
      if (!t) return;
      var cs = getComputedStyle(el);
      if (cs.overflow === 'visible') return;
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
        out.clipped.push({ text: t.slice(0, 20), sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight });
      }
    });
  out.clipped = out.clipped.slice(0, 12);

  /* 3) 一屏一窗：同时可见的主窗 */
  Array.prototype.forEach.call(document.querySelectorAll('.win'), function(w){
    if (visible(w)) out.mainWins.push(w.id || label(w));
  });

  /* 4) 最小点击区 */
  Array.prototype.forEach.call(
    document.querySelectorAll('#slgPanelsWin button, #slgCityWin button, #slgWarWin button, #slgIxRoot button, #slgDock button'),
    function(b){
      if (!visible(b)) return;
      var r = b.getBoundingClientRect();
      if (r.width < 28 || r.height < 28) {
        out.smallTargets.push({ t: (b.textContent || '').trim().slice(0, 10), w: r0(r.width), h: r0(r.height) });
      }
    });
  out.smallTargets = out.smallTargets.slice(0, 12);

  /* 5) 抽屉实际宽度（GDD §10.1 五档） */
  var drawer = document.querySelector('.slgIx-drawer');
  if (drawer && visible(drawer)) {
    out.drawer = { w: r0(drawer.getBoundingClientRect().width), label: label(drawer) };
  }

  /* 6) 样式分布（美观维度）：只统计实际可见元素 */
  var seen = 0;
  Array.prototype.forEach.call(
    document.querySelectorAll('#slgPanelsWin *, #slgCityWin *, #slgWarWin *, #slgIxRoot *, #slgDock *, #slgStratSide *'),
    function(el){
      if (!visible(el)) return;
      seen += 1;
      if (seen > 4000) return; // 防御：极端视图不把主进程拖死
      var cs = getComputedStyle(el);
      var bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') out.styles.colors[bg] = (out.styles.colors[bg] || 0) + 1;
      var fg = cs.color;
      if (fg) out.styles.colors['fg ' + fg] = (out.styles.colors['fg ' + fg] || 0) + 1;
      var ff = cs.fontFamily;
      if (ff) out.styles.fonts[ff] = (out.styles.fonts[ff] || 0) + 1;
      var br = cs.borderRadius;
      if (br && br !== '0px') out.styles.radii[br] = (out.styles.radii[br] || 0) + 1;
      var td = cs.transitionDuration;
      if (td && td !== '0s') out.styles.durations[td] = (out.styles.durations[td] || 0) + 1;
    });
  out.nodeCount = seen;

  /* 7) 文案洁净 */
  var bodyText = document.body.innerText || '';
  ['undefined', 'NaN', '[object Object]', '占位符', 'TODO:', 'lorem'].forEach(function(k){
    if (bodyText.indexOf(k) >= 0) out.textIssues.push(k);
  });

  return out;
})()`;

/** 状态切换全部走已公开的 API，避免依赖「某个按钮在不在」。 */
const STATE_MAP = `(function(){
  try { if (window.__slgPanels) window.__slgPanels.close(); } catch (e) {}
  try { if (window.__slgCityClose) window.__slgCityClose(); } catch (e) {}
  var w = document.getElementById('slgWarWin'); if (w) w.remove();
  var c = document.getElementById('slgCityWin'); if (c && c.parentNode) c.parentNode.removeChild(c);
  return true;
})()`;

const STATE_PANELS = `(function(){
  try { if (window.__slgPanels) window.__slgPanels.open('general'); } catch (e) { return 'err:' + e.message; }
  return true;
})()`;

const STATE_WAR = `(function(){
  var b = document.getElementById('slgBtnWar');
  if (!b) return 'no-btn:slgBtnWar';
  b.click();
  return 'click:slgBtnWar';
})()`;

/* 城池内部页与出征窗一律走玩家真实入口（dock 常驻按钮），
   不用内部 API 猜参数 —— 猜错的代价是量到空壳还以为全绿。 */
const STATE_CITY = `(function(){
  var b = document.getElementById('slgBtnHome');
  if (!b) return 'no-btn:slgBtnHome';
  b.click();
  return 'click:slgBtnHome';
})()`;

/** 举义：必须做，否则玩家没有城，出征窗会正确显示「尚未举义」，
 *  城池页只有导航骨架 —— 那样量到的「零溢出」毫无意义（空页当然不溢出）。 */
const STEP_OATH = `(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var found = null;
  for (var i = 0; i < 60; i++) {
    found = document.getElementById('slgOath');
    if (found) break;
    await sleep(200);
  }
  if (!found) return 'no-oath';
  var lords = document.querySelectorAll('.slgOathLord');
  if (!lords.length) return 'no-lords';
  lords[0].click();
  await sleep(520);
  var cities = document.querySelectorAll('.slgOathCity');
  if (!cities.length) return 'no-cities';
  cities[0].click();
  for (var j = 0; j < 60; j++) {
    if (!document.getElementById('slgOath')) { await sleep(600); return 'done'; }
    await sleep(200);
  }
  return 'timeout';
})()`;

async function runLayout(win, server, app) {
  const wc = win.webContents;
  const tag = process.env.SLG_SMOKE_TAG || 'original';
  const outDir = process.env.SLG_SMOKE_REPORT_DIR || path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });

  const consoleErrors = [];
  wc.on('console-message', (...args) => {
    const d = consolePayload(args);
    const text = String(d.message == null ? '' : d.message);
    if (/Electron Security Warning/i.test(text)) return;
    if (consoleSeverity(d.level) >= 2) consoleErrors.push('[' + d.level + '] ' + text);
  });

  const report = {
    startedAt: new Date().toISOString(),
    mode: 'layout', tag,
    viewports: [], fontTiers: [],
    aesthetics: {}, issues: [], pageErrors: [], consoleErrors: [],
  };

  try {
    await wc.executeJavaScript(`(function(){
      if (!window.__slgErrHookInstalled) {
        window.__slgErrors = window.__slgErrors || [];
        window.addEventListener('error', function(e){ window.__slgErrors.push({ msg:String(e.message) }); });
        window.addEventListener('unhandledrejection', function(e){ window.__slgErrors.push({ msg:'unhandledrejection: '+String(e.reason) }); });
      }
      return true;
    })()`, true);

    const tWait = Date.now();
    while (Date.now() - tWait < 30000) {
      const has = await wc.executeJavaScript('!!(window.cc && window.cc.director && window.cc.director.getScene())', true);
      if (has) break;
      await sleep(300);
    }
    report.autoLogin = await wc.executeJavaScript(AUTO_LOGIN, true);
    await wc.executeJavaScript(`(async function(){
      var t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        if (document.documentElement.getAttribute('data-slg-phase') === 'game'
          && typeof window.__slgPanels === 'object' && document.getElementById('slgDock')) return true;
        await new Promise(function(r){ setTimeout(r, 150); });
      }
      return false;
    })()`, true);

    const originalSize = win.getContentSize();
    /* 举义：没有自己的城，出征窗与城池页都只剩空壳 */
    report.oath = await wc.executeJavaScript(STEP_OATH, true);
    await wc.executeJavaScript("(function(){ try { if (window.__slgStrategyShow) window.__slgStrategyShow(); } catch(e){} return true; })()", true);
    await sleep(900);

    /** 等入场动画跑完再量。城内页有 220ms 的 translateY(10px) 入场动画，
     *  在动画中途测量会量到 4~9px 的「溢出」—— 这是实测踩到的假阳性。 */
    const waitAnim = async () => {
      await wc.executeJavaScript(`(async function(){
        var t0 = Date.now();
        while (Date.now() - t0 < 2500) {
          var running = (document.getAnimations ? document.getAnimations() : [])
            .filter(function(a){ return a.playState === 'running'; });
          if (!running.length) return true;
          await new Promise(function(r){ setTimeout(r, 90); });
        }
        return false;
      })()`, true);
    };

    /** 等某个容器真的渲染出内容再测量。
     *  固定 sleep 会量到空壳（实测：city 只有 114 字符、war 只有 29 字符），
     *  于是「零溢出零裁切」全是假的 —— 空壳当然不会溢出。 */
    const waitContent = async (id, minLen, ms) => {
      const t0 = Date.now();
      let len = 0;
      while (Date.now() - t0 < ms) {
        len = await wc.executeJavaScript(
          `(function(){var e=document.getElementById(${JSON.stringify(id)});return e?(e.textContent||'').length:0;})()`, true);
        if (len >= minLen) return { len, waited: Date.now() - t0, ok: true };
        await sleep(120);
      }
      return { len, waited: Date.now() - t0, ok: false };
    };

    /* ---------- 5 档分辨率 × 4 状态 ---------- */
    for (const [w, h] of VIEWPORTS) {
      try { win.setContentSize(w, h); } catch { /* 超出屏幕时允许失败，记录在案 */ }
      await sleep(420);
      const entry = { req: { w, h }, states: {} };

      for (const [stateName, script] of [
        ['map', STATE_MAP],
        ['panels', STATE_PANELS],
        ['city', STATE_CITY],
        ['war', STATE_WAR],
      ]) {
        const applied = await wc.executeJavaScript(script, true);
        /* 内容门槛：低于这个长度就是空壳，量了也没意义。超时则记录 short 供追查。 */
        const gate = { panels: ['slgPanelsBody', 300], city: ['slgCityWin', 260], war: ['slgWarWin', 120] }[stateName];
        let content = null;
        if (gate) content = await waitContent(gate[0], gate[1], 4000);
        else await sleep(280);
        await waitAnim();
        const m = await wc.executeJavaScript(MEASURE, true);
        entry.states[stateName] = { applied, contentReady: content, ...m };
        if (stateName !== 'war') {
          await wc.executeJavaScript(STATE_MAP, true);
          await sleep(160);
        }
      }
      report.viewports.push(entry);
    }

    /* ---------- 字号三档（1280 + 1920 两个极端，六府与城池各一次） ---------- */
    for (const [w, h] of [[1280, 720], [1920, 1080]]) {
      try { win.setContentSize(w, h); } catch { /* ignore */ }
      await sleep(400);
      for (const tier of FONT_TIERS) {
        /* 直接施加到交互层根字号：与设置面板「小/中/大」三档等价（12px × 档位%）。
           按钮链路本身由 tests/m4-a11y.test.js 覆盖，这里只测排版后果。 */
        await wc.executeJavaScript(`(function(){
          var r = document.getElementById('slgIxRoot');
          if (r) r.style.fontSize = (12 * ${tier} / 100) + 'px';
          return r ? getComputedStyle(r).fontSize : null;
        })()`, true);
        const applied = await wc.executeJavaScript(STATE_PANELS, true);
        await sleep(420);
        const m = await wc.executeJavaScript(MEASURE, true);
        report.fontTiers.push({ viewport: [w, h], tier, applied, clipped: m.clipped, clippedCount: m.clipped.length, offscreen: m.offscreen });
        await wc.executeJavaScript(STATE_MAP, true);
        await sleep(150);
      }
    }
    /* 归档回中档，避免影响后面的截图 */
    await wc.executeJavaScript(`(function(){
      var r = document.getElementById('slgIxRoot'); if (r) r.style.fontSize = '12px'; return true;
    })()`, true);

    try { win.setContentSize(originalSize[0], originalSize[1]); } catch { /* ignore */ }
    await sleep(300);

    /* ---------- 美观汇总（取 1920 档的样式分布，样本最完整） ---------- */
    const base = report.viewports.find((v) => v.req.w === 1920) || report.viewports[0];
    const collect = (pick) => {
      const acc = {};
      for (const v of report.viewports) {
        const s = pick(v);
        if (!s) continue;
        for (const [k, n] of Object.entries(s)) acc[k] = (acc[k] || 0) + n;
      }
      return acc;
    };
    const colors = collect((v) => v.states.panels && v.states.panels.styles && v.states.panels.styles.colors);
    const fonts = collect((v) => v.states.panels && v.states.panels.styles && v.states.panels.styles.fonts);
    const radii = collect((v) => v.states.panels && v.states.panels.styles && v.states.panels.styles.radii);
    const durations = collect((v) => v.states.panels && v.states.panels.styles && v.states.panels.styles.durations);

    const uniq = (o) => Object.keys(o).length;
    const aesthetic = {
      colorTokenCount: uniq(colors),
      fontFamilyCount: uniq(fonts),
      radiusCount: uniq(radii),
      durations: Object.keys(durations),
      fonts: Object.keys(fonts),
      radii: Object.keys(radii),
      topColors: Object.entries(colors).sort((a, b) => b[1] - a[1]).slice(0, 14),
      verdicts: [],
    };
    /* 阈值说明：这些是「token 收敛」的经验线，超标记偏差而不是硬失败
       —— 硬失败只留给几何问题，否则配色微调会把发版卡死。 */
    const push = (id, name, ok, detail) => aesthetic.verdicts.push({ id, name, ok, detail });
    push('AE-02', '配色 token 收敛', uniq(colors) <= 40, `可见色值 ${uniq(colors)} 种（阈值 40）`);
    push('AE-03', '字体族收敛', uniq(fonts) <= 3, `字体族 ${uniq(fonts)} 种：${Object.keys(fonts).slice(0, 4).join(' / ')}`);
    push('AE-04', '圆角档位收敛', uniq(radii) <= 8, `圆角 ${uniq(radii)} 档：${Object.keys(radii).slice(0, 10).join(' ')}`);
    const unexpectedDur = Object.keys(durations).filter((d) => !/^(0\.12s|0\.18s|0\.4s|0\.6s|1s|1\.2s|2s|3\.2s|150ms|120ms|180ms|400ms|600ms|0\.15s|0\.2s|0\.3s|0\.25s)/.test(d));
    push('AE-05', '动效时长成套', unexpectedDur.length <= 3, unexpectedDur.length ? `非标准时长：${unexpectedDur.join(' ')}` : '全部落在标准档');
    aesthetic.base1920 = base ? base.req : null;
    report.aesthetics = aesthetic;

    /* ---------- 汇总问题 ---------- */
    for (const v of report.viewports) {
      for (const [name, s] of Object.entries(v.states)) {
        if (!s || !s.viewport) continue;
        if (s.contentReady && s.contentReady.ok === false) {
          /* 内容没到位 = 这个状态的测量无效，必须算硬问题，不能当绿 */
          report.issues.push({ kind: 'content-short', viewport: v.req, state: name, items: [s.contentReady] });
        }
        if (s.offscreen && s.offscreen.length) {
          report.issues.push({ kind: 'offscreen', viewport: v.req, state: name, items: s.offscreen });
        }
        if (s.mainWins && s.mainWins.length > 1) {
          report.issues.push({ kind: 'multi-window', viewport: v.req, state: name, items: s.mainWins });
        }
        if (s.textIssues && s.textIssues.length) {
          report.issues.push({ kind: 'text-dirty', viewport: v.req, state: name, items: s.textIssues });
        }
      }
    }
    const clippedTotal = report.viewports.reduce((n, v) => n + Object.values(v.states)
      .reduce((m, s) => m + ((s && s.clipped && s.clipped.length) || 0), 0), 0);
    report.clippedTotal = clippedTotal;
    report.fontTierClipped = report.fontTiers.reduce((n, f) => n + (f.clippedCount || 0), 0);

    const errs = await wc.executeJavaScript('window.__slgErrors || []', true);
    report.pageErrors = errs || [];

    try {
      const img = await wc.capturePage();
      fs.writeFileSync(path.join(outDir, `layout-${tag}.png`), img.toPNG());
    } catch { /* ignore */ }
  } catch (err) {
    report.fatal = String((err && err.stack) || err);
  }

  report.consoleErrors = consoleErrors;
  const hardIssues = report.issues.filter((i) => i.kind === 'offscreen' || i.kind === 'multi-window' || i.kind === 'content-short');
  report.passed = !report.fatal && report.pageErrors.length === 0 && consoleErrors.length === 0
    && hardIssues.length === 0;
  report.finishedAt = new Date().toISOString();

  fs.writeFileSync(path.join(outDir, `layout-${tag}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log('[slg-offline:layout]', JSON.stringify({
    passed: report.passed,
    viewports: report.viewports.length,
    hardIssues: hardIssues.length,
    clippedTotal: report.clippedTotal,
    fontTierClipped: report.fontTierClipped,
    aesthetic: (report.aesthetics.verdicts || []).map((v) => `${v.id}${v.ok ? '✓' : '⚠'} ${v.detail}`),
    pageErrors: report.pageErrors.length,
    consoleErrors: consoleErrors.length,
    fatal: report.fatal,
  }, null, 2));

  if (process.env.SLG_SMOKE_EXIT === '1') {
    setTimeout(() => app.exit(report.passed ? 0 : 1), 400);
  }
  return report;
}

module.exports = { runLayout, VIEWPORTS, FONT_TIERS, DRAWER_BY_WIDTH };
