/**
 * UX 取证探针（ui-probe）—— 复现玩家报障用
 *
 * 为什么单独一件：玩家报「一键征兵报错」「推演返回一串代码」这类问题时，
 * 靠读代码猜根因经常猜错（本轮就猜错两次：把动画中途测量当成溢出、
 * 把未举义时面板的正确提示当成空面板）。这个工具把真实点击后的
 *   ① DOM 文本 ② 控制台错误 ③ 截图
 * 一起留档，让根因可见。
 *
 * 触发：SLG_DIAG=1（见 electron/main.cjs）
 * 输出：reports/ui-probe.json + reports/probe-*.png
 */
const fs = require('node:fs');
const path = require('node:path');
const { consoleSeverity, consolePayload } = require('./console-level.cjs');

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
    if (found.editName) found.editName.string = 'probe';
    if (found.editPass) found.editPass.string = 'probe123';
    found.onClickLogin();
    return { ok:true, why:'clicked' };
  } catch (e) { return { ok:false, why:String(e && e.stack || e) }; }
})()`;

/** 收集页内错误并安装钩子（幂等）。 */
const ERR_HOOK = `(function(){
  if (!window.__slgErrHookInstalled) {
    window.__slgErrors = window.__slgErrors || [];
    window.addEventListener('error', function(e){
      window.__slgErrors.push({ msg:String(e.message), stack:String(e.error && e.error.stack || '').slice(0,800) });
    });
    window.addEventListener('unhandledrejection', function(e){
      window.__slgErrors.push({ msg:'unhandledrejection: '+String(e.reason) });
    });
    window.__slgErrHookInstalled = true;
  }
  return true;
})()`;

/** 场景 A：城内页 → 征兵 → 一键征满。抓 toast（skills.js 用 .toast 而非 #slgIxToast）+ 服务端原始返回。 */
const SCENARIO_LEVY = `(async function(){
  var out = { steps: [] };
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var grabToast = function(){
    var list = document.querySelectorAll('.toast, #slgIxToast, #slgPanelsToast');
    var txt = [];
    Array.prototype.forEach.call(list, function(t){
      if (getComputedStyle(t).display !== 'none' && (t.textContent||'').trim()) txt.push(t.textContent.trim());
    });
    return txt.join(' / ');
  };
  try {
    var s = await (await fetch('/__slg/strategy/state', { cache:'no-store' })).json();
    out.playerCity = s.playerCity;
    var cid = s.playerCity || 1;
    window.__slgCityInterior(cid, 'army');
    var page = null;
    for (var i = 0; i < 40; i++) {
      await sleep(200);
      page = document.getElementById('slgCityPage');
      if (page && page.querySelector('[data-quick-levy]')) break;
    }
    if (!page) return { ok:false, reason:'city page not open' };
    var btns = page.querySelectorAll('[data-quick-levy]');
    out.quickButtons = [];
    Array.prototype.forEach.call(btns, function(b){
      out.quickButtons.push({ label:(b.textContent||'').trim(), disabled:!!b.disabled,
        val:b.getAttribute('data-quick-levy') });
    });
    /* 资源与成本：判断「一键征满」是不是必然被资源拒绝 */
    try {
      var res = await (await fetch('/__slg/panels/state', { cache:'no-store' })).json();
      out.depot = res && res.depot ? {
        wood: res.depot.wood, iron: res.depot.iron, grain: res.depot.grain, gold: res.depot.gold } : null;
    } catch(e) {}
    var target = btns[btns.length - 1];
    if (!target) return { ok:false, reason:'no quick levy button' };
    var card = target.closest('.card');
    out.levyCardText = card ? (card.innerText || '').slice(0, 900) : '';
    /* 直接从服务端问一次：一键征满这个数量到底能不能成 */
    try {
      var st2 = await (await fetch('/__slg/strategy/state', { cache:'no-store' })).json();
      var army0 = (st2.armies || []).filter(function(a){
        return (a.generals || []).some(function(g){ return !!g; }) && !a.marching;
      })[0];
      if (army0) {
        var cnt = [0,0,0]; cnt[0] = Number(target.getAttribute('data-quick-levy'));
        out.serverDirect = { armyId: army0.id, cityId: army0.cityId };
      }
    } catch(e) {}
    target.click();
    out.toastAfterClick = '';
    for (var k = 0; k < 16; k++) {
      await sleep(200);
      var tx = grabToast();
      if (tx) { out.toastAfterClick = tx; break; }
    }
    await sleep(1500);
    out.toastLater = grabToast();
    var page2 = document.getElementById('slgCityPage');
    out.afterText = page2 ? (page2.innerText || '').slice(0, 400) : '';
    out.errors = (window.__slgErrors || []).slice(-8);
    out.ok = true;
    return out;
  } catch (e) { return { ok:false, error:String(e && e.stack || e) }; }
})()`;

/** 场景 B：出征面板 → 推演一次，抓推演区原始文本（玩家说的「一串代码」）。 */
const SCENARIO_PREVIEW = `(async function(){
  var out = { steps: [] };
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  try {
    if (typeof window.__slgWarWindow !== 'function') return { ok:false, reason:'no war window' };
    window.__slgWarWindow({ tab:'go' });
    var win = null;
    for (var i = 0; i < 40; i++) { await sleep(200); win = document.getElementById('slgWarWin'); if (win && win.getBoundingClientRect().width > 100) break; }
    if (!win) return { ok:false, reason:'war panel not shown' };
    out.goText = (win.innerText || '').slice(0, 1200);
    var btn = null;
    Array.prototype.forEach.call(win.querySelectorAll('button'), function(b){
      if (!btn && (b.textContent || '').trim() === '推演一次') btn = b;
    });
    if (!btn) return { ok:false, reason:'no preview button', text:out.goText.slice(0,400) };
    var outBox = btn.closest('.card');
    btn.click();
    for (var k = 0; k < 40; k++) {
      await sleep(250);
      if (btn.textContent.indexOf('再推演') >= 0) break;
    }
    outBox = btn.closest('.card') || outBox;
    out.previewCardText = outBox ? (outBox.innerText || '').slice(0, 2000) : '';
    out.previewCardHtml = outBox ? (outBox.innerHTML || '').slice(0, 4000) : '';
    /* 同时留一份服务端原始返回，判断是「服务端给了代码」还是「前端拼错了」 */
    try {
      var st = await (await fetch('/__slg/strategy/state', { cache:'no-store' })).json();
      var army = (st.armies || []).filter(function(a){
        var t = (a.soldiers||[]).reduce(function(x,y){ return x + (Number(y)||0); }, 0);
        return t > 0 && !a.marching;
      })[0];
      if (army) {
        var routes = ((st.cities||[]).filter(function(c){ return c.id === army.cityId; })[0] || {}).marchRoutes || [];
        var tgt = (routes.filter(function(r){
          var c = (st.cities||[]).filter(function(x){ return x.id === r.id; })[0];
          return c && c.owner !== 'player';
        })[0] || {}).id;
        if (tgt) {
          var rp = await (await fetch('/__slg/strategy/action', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'preview', cityId:tgt, armyId:army.id, frac:1, fromCityId:army.cityId }),
          })).json();
          out.serverPreview = {
            ok: rp.ok, keys: Object.keys(rp).slice(0, 40),
            attribution: rp.attribution, caveat: rp.caveat, summary: rp.summary,
            intelNote: rp.intelNote, counterNote: rp.counterNote,
            hasReport: !!rp.report, reportType: typeof rp.report,
          };
        }
      }
    } catch (e) { out.serverPreviewError = String(e && e.message); }
    out.errors = (window.__slgErrors || []).slice(-8);
    out.ok = true;
    return out;
  } catch (e) { return { ok:false, error:String(e && e.stack || e) }; }
})()`;

/** 场景 C：打一仗 → 取战报详情文本 + 回放是否可播。 */
const SCENARIO_REPORT = `(async function(){
  var out = {};
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  try {
    var head = await (await fetch('/__slg/panels/reports-head', { cache:'no-store' })).json();
    out.head = head;
    var rsp = await (await fetch('/__slg/strategy/state', { cache:'no-store' })).json();
    out.battleLogLen = (rsp.battleLog || []).length;
    window.__slgReportsWindow && window.__slgReportsWindow();
    await sleep(900);
    var win = document.getElementById('slgRepWin');
    out.listText = win ? (win.innerText || '').slice(0, 900) : '';
    var detail = null;
    if (win) {
      Array.prototype.forEach.call(win.querySelectorAll('button'), function(b){
        if (!detail && /详情/.test(b.textContent || '')) detail = b;
      });
    }
    if (detail) {
      detail.click();
      await sleep(700);
      var d = document.getElementById('slgRepDetail');
      out.detailText = d ? (d.innerText || '').slice(0, 2500) : '';
    }
    out.errors = (window.__slgErrors || []).slice(-8);
    out.ok = true;
    return out;
  } catch (e) { return { ok:false, error:String(e && e.stack || e) }; }
})()`;

/** 场景 D：真打一仗（出征 → 推演 → 抵达遭遇 → 确认开战），取战报详情与该战 anim。 */
const SCENARIO_BATTLE = `(async function(){
  var out = {};
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var post = function(body){
    return fetch('/__slg/strategy/action', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body) }).then(function(r){ return r.json(); });
  };
  try {
    var st = await (await fetch('/__slg/strategy/state', { cache:'no-store' })).json();
    var army = (st.armies || []).filter(function(a){
      var t = (a.soldiers||[]).reduce(function(x,y){ return x + (Number(y)||0); }, 0);
      return t > 0 && !a.marching && (a.generals||[]).some(function(g){ return !!g; });
    })[0];
    if (!army) return { ok:false, reason:'no ready army' };
    var city = (st.cities || []).filter(function(c){ return c.id === army.cityId; })[0] || {};
    var routes = city.marchRoutes || [];
    var tgt = null;
    for (var i = 0; i < routes.length; i++) {
      var c = (st.cities||[]).filter(function(x){ return x.id === routes[i].id; })[0];
      if (c && c.owner !== 'player') { tgt = c; break; }
    }
    if (!tgt) return { ok:false, reason:'no enemy neighbour' };
    var atk = await post({ action:'attack', cityId:tgt.id, armyId:army.id, frac:1, fromCityId:army.cityId, confirmBattle:true });
    out.attack = { ok: atk.ok, arriveDay: atk.arriveDay, km: atk.km, deploy: atk.deploy, reason: atk.reason };
    if (!atk.ok) return { ok:false, reason:'attack failed: ' + (atk.reason || '') };
    for (var t = 0; t < 8; t++) {
      await fetch('/__slg/strategy/tick', { method:'POST' });
      await sleep(120);
      var st2 = await (await fetch('/__slg/strategy/state', { cache:'no-store' })).json();
      var m = (st2.pendingBattles || [])[0];
      if (m) { out.march = { marchId: m.marchId, to: m.to, toName: m.toName, troops: m.troops, enemyTroops: m.enemyTroops }; break; }
    }
    if (!out.march) return { ok:false, reason:'never reached pendingBattle', attack: out.attack };
    var res = await post({ action:'battleConfirm', marchId: out.march.marchId });
    out.battle = { ok: res.ok, result: res.result, city: res.city, reason: res.reason };
    await sleep(500);
    var st3 = await (await fetch('/__slg/strategy/state', { cache:'no-store' })).json();
    out.battleLogLen = (st3.battleLog || []).length;
    /* 取最新战报的 anim 结构，检查有没有打斗动作与战法名 */
    var list = [];
    try {
      var wrapped = await window.__slgSend('war.report', {});
      list = (wrapped && wrapped.rsp && wrapped.rsp.msg && wrapped.rsp.msg.list) || [];
    } catch (e) { out.reportFetchError = String(e && e.message); }
    out.reportCount = list.length;
    var r0 = list[0];
    if (r0 && r0.anim) {
      out.anim = {
        place: r0.anim.place, winner: r0.anim.winner,
        rounds: (r0.anim.rounds || []).length,
        actKinds: {},
        sampleActs: (r0.anim.rounds || []).slice(0, 2).map(function(rd){
          return (rd.acts || []).slice(0, 8).map(function(a){ return a.t + ':' + (a.skill || ''); });
        }),
      };
      (r0.anim.rounds || []).forEach(function(rd){
        (rd.acts || []).forEach(function(a){ out.anim.actKinds[a.t] = (out.anim.actKinds[a.t]||0)+1; });
      });
    }
    /* 打开战报详情，抓文本 */
    if (window.__slgReportsWindow) { window.__slgReportsWindow(); await sleep(900); }
    var win = document.getElementById('slgRepWin');
    out.listText = win ? (win.innerText || '').slice(0, 600) : '';
    var detail = null;
    if (win) Array.prototype.forEach.call(win.querySelectorAll('button'), function(b){
      if (!detail && /详情/.test(b.textContent || '')) detail = b;
    });
    if (detail) {
      detail.click();
      await sleep(700);
      var d = document.getElementById('slgRepDetail');
      out.detailText = d ? (d.innerText || '').slice(0, 3000) : '';
      out.detailHtml = d ? (d.innerHTML || '').slice(0, 2500) : '';
    }
    /* 回放：真播一次并抓一帧 */
    if (r0 && r0.anim && window.__slgPlayBattle) {
      window.__slgPlayBattle(r0.anim);
      await sleep(1800);
      out.replayOverlay = !!document.getElementById('slgBattleOverlay')
        && getComputedStyle(document.getElementById('slgBattleOverlay')).display !== 'none';
    }
    out.errors = (window.__slgErrors || []).slice(-8);
    out.ok = true;
    return out;
  } catch (e) { return { ok:false, error:String(e && e.stack || e) }; }
})()`;

/** 场景 E：界面收敛（用户 ⑦⑧⑨⑩⑪ 的 DOM 取证）。
 *  不看代码猜，直接量：按钮坞里还剩哪些按钮、图层列表还剩几项、六府有没有折叠、
 *  浮窗开关是否真能隐藏、势力面板能否选势力看版图、推演预览能否收起。 */
const SCENARIO_UI = `(async function(){
  var out = {};
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var txt = function(n){ return n ? (n.innerText || '').replace(/\s+/g, ' ').trim() : ''; };
  try {
    if (window.__slgCityClose) window.__slgCityClose();
    Array.prototype.slice.call(document.querySelectorAll('#slgUIv2 .win')).forEach(function(w){ w.remove(); });
    if (window.__slgPlayBattle && document.getElementById('slgBattleOverlay')) {
      var ov = document.getElementById('slgBattleOverlay'); if (ov) ov.style.display = 'none';
    }
    /* ★ 先清掉上一场景留下的弹窗/主窗口：外壳在 data-slg-window / data-slg-dialog
       存在时会主动把浮窗与按钮坞让位（display:none!important）。不清掉就量不到
       「浮窗开关是否真的生效」，只会量到「让位规则是否生效」。 */
    Array.prototype.slice.call(document.querySelectorAll('.slgIx-modal, #slgUIv2 .modal'))
      .forEach(function(m){ m.remove(); });
    Array.prototype.slice.call(document.querySelectorAll('#slgCityPage, #slgPanelsMask'))
      .forEach(function(m){ m.remove(); });
    if (window.__slgShell && window.__slgShell.reconcile) window.__slgShell.reconcile();
    if (window.__slgStrategyShow) window.__slgStrategyShow();
    await sleep(900);

    var dock = document.getElementById('slgDock');
    out.dockButtons = dock ? Array.prototype.map.call(dock.querySelectorAll('button'), function(b){
      return (b.textContent || '').trim();
    }) : [];

    var side = document.getElementById('slgStratSide');
    out.layerLabels = side ? Array.prototype.map.call(side.querySelectorAll('label'), function(l){
      return (l.textContent || '').trim();
    }) : [];

    var pd = document.getElementById('slgPanelsDock');
    out.panelsDock = {
      hasFoldButton: !!(pd && pd.querySelector('.fold')),
      ids: pd ? Array.prototype.map.call(pd.querySelectorAll('.pb'), function(b){ return b.getAttribute('data-id'); }) : [],
      width: pd ? Math.round(pd.getBoundingClientRect().width) : 0,
      visible: !!(pd && getComputedStyle(pd).display !== 'none'),
    };

    var chips = dock ? Array.prototype.slice.call(dock.querySelectorAll('[data-float]')) : [];
    out.floatChips = chips.map(function(c){ return c.getAttribute('data-float'); });
    out.dragAttached = !!(side && side.dataset && side.dataset.slgDrag === '1');

    var chipSide = chips.filter(function(c){ return c.getAttribute('data-float') === 'side'; })[0];
    if (chipSide && side) {
      chipSide.click(); await sleep(150);
      out.sideHidden = getComputedStyle(side).display === 'none';
      chipSide.click(); await sleep(150);
      out.sideShown = getComputedStyle(side).display !== 'none';
    }
    var chipLegend = chips.filter(function(c){ return c.getAttribute('data-float') === 'legend'; })[0];
    var lg = document.getElementById('slgLegend');
    var probe0 = function(tagName){
      return {
        step: tagName,
        attr: document.documentElement.getAttribute('data-slg-float-legend'),
        winAttr: document.documentElement.getAttribute('data-slg-window'),
        inline: lg ? lg.style.display : null,
        computed: lg ? getComputedStyle(lg).display : null,
      };
    };
    if (chipLegend && lg) {
      out.legendSteps = [probe0('before')];
      chipLegend.click(); await sleep(200);
      out.legendSteps.push(probe0('after-hide'));
      out.legendHidden = getComputedStyle(lg).display === 'none';
      chipLegend.click(); await sleep(200);
      out.legendSteps.push(probe0('after-show'));
      out.legendShown = getComputedStyle(lg).display !== 'none';
    }

    out.legendRows = lg ? Array.prototype.map.call(lg.querySelectorAll('.lg-row'), function(b){
      return (b.textContent || '').replace(/\s+/g, ' ').trim();
    }) : [];
    var pick = lg ? Array.prototype.filter.call(lg.querySelectorAll('.lg-row'), function(b){
      var fid = b.getAttribute('data-fid');
      return fid && fid !== 'player';
    })[0] : null;
    if (pick) {
      pick.click(); await sleep(500);
      out.legendPicked = pick.getAttribute('data-fid');
      out.legendDetail = txt(lg).slice(0, 500);
      out.legendRange = /势力范围/.test(txt(lg));
      var clear = lg.querySelector('[data-lg="clear"]');
      if (clear) { clear.click(); await sleep(300); }
    }

    /* ⑨ 推进前预览的最小化：点沙盘「推演一月」→ 弹出预览 → 收起明细 */
    var tickBtn = document.getElementById('slgStratTick');
    if (tickBtn) {
      tickBtn.click(); await sleep(900);
      var pv = document.querySelector('.slgIxPV');
      out.previewShown = !!pv;
      if (pv) {
        out.previewHead = txt(pv.querySelector('.pv-head')).slice(0, 160);
        var fold = pv.querySelector('.acts .foldbtn');
        out.previewHasFold = !!fold;
        if (fold) {
          fold.click(); await sleep(200);
          out.previewFolded = pv.classList.contains('folded');
          var cols = pv.querySelector('.pv-cols');
          out.previewColsHidden = cols ? getComputedStyle(cols).display === 'none' : null;
        }
        var cancel = pv.querySelector('[data-act="cancel"]');
        if (cancel) cancel.click();
      }
    }
    out.errors = (window.__slgErrors || []).slice(-8);
    out.ok = true;
    return out;
  } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
})()`;

async function shot(wc, dir, name) {
  try {
    const png = await wc.capturePage();
    fs.writeFileSync(path.join(dir, name), png.toPNG());
    return name;
  } catch (e) { return 'failed: ' + String(e && e.message || e); }
}

async function runProbe(win, server, app) {
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
  const pageErrors = [];
  wc.on('preload-error', (_e, p, err) => pageErrors.push(String(err)));
  wc.on('render-process-gone', (_e, d) => pageErrors.push('renderer gone ' + JSON.stringify(d)));

  const report = { startedAt: new Date().toISOString(), mode: 'ui-probe', tag, scenarios: {} };
  try {
    let status = server.status();
    for (let i = 0; i < 120 && status.connections < 1; i += 1) { await sleep(1000); status = server.status(); }

    for (let i = 0; i < 30; i += 1) {
      const r = await wc.executeJavaScript(AUTO_LOGIN, true);
      if (r.ok) { report.autoLogin = r; break; }
      await sleep(1000);
    }
    /* 等门禁放行 */
    await wc.executeJavaScript(`(async function(){
      var t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        if (document.documentElement.getAttribute('data-slg-phase') === 'game') return true;
        await new Promise(function(r){ setTimeout(r, 80); });
      }
      return false;
    })()`, true);
    await wc.executeJavaScript(ERR_HOOK, true);

    /* 举义：新档必须先择主定都，否则所有面板都「没兵没城」 */
    report.oath = await wc.executeJavaScript(`(async function(){
      try {
        var v = await (await fetch('/__slg/oath/options', { cache:'no-store' })).json();
        if (!v || !v.ok) return { ok:false, reason:'options failed' };
        if (v.done) { var o0 = document.getElementById('slgOath'); if (o0) o0.style.display='none'; return { ok:true, already:true }; }
        var f = (v.lords || [])[0];
        if (!f || !f.cities || !f.cities.length) return { ok:false, reason:'no lord/city' };
        var r = await (await fetch('/__slg/oath/choose', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ lord: f.id, city: f.cities[0].id }),
        })).json();
        var o = document.getElementById('slgOath'); if (o) o.style.display='none';
        for (var k = 0; k < 10; k++) { await new Promise(function(x){ setTimeout(x, 300); });
          if (!document.getElementById('slgOath')) break; }
        return { ok: !!(r && r.ok), lord: r && r.lordName, city: r && r.city };
      } catch (e) { return { ok:false, error:String(e && e.message) }; }
    })()`, true);
    await sleep(1500);

    /* 先推进两旬：让城库/人口/兵源有底数，征兵才有额 */
    await wc.executeJavaScript(`(async function(){
      await fetch('/__slg/strategy/tick', { method:'POST' }); return true;
    })()`, true);
    await sleep(1200);

    report.scenarios.levy = await wc.executeJavaScript(SCENARIO_LEVY, true);
    report.scenarios.levyShot = await shot(wc, outDir, `probe-levy-${tag}.png`);

    report.scenarios.preview = await wc.executeJavaScript(SCENARIO_PREVIEW, true);
    report.scenarios.previewShot = await shot(wc, outDir, `probe-preview-${tag}.png`);

    report.scenarios.battle = await wc.executeJavaScript(SCENARIO_BATTLE, true);
    report.scenarios.battleShot = await shot(wc, outDir, `probe-battle-${tag}.png`);
    report.scenarios.reports = await wc.executeJavaScript(SCENARIO_REPORT, true);
    report.scenarios.reportShot = await shot(wc, outDir, `probe-report-${tag}.png`);
    report.scenarios.ui = await wc.executeJavaScript(SCENARIO_UI, true);
    report.scenarios.uiShot = await shot(wc, outDir, `probe-ui-${tag}.png`);

    report.pageErrors = pageErrors.concat(await wc.executeJavaScript('window.__slgErrors || []', true));
    report.consoleErrors = consoleErrors;
  } catch (err) {
    report.fatal = String(err && err.stack || err);
  }
  const out = path.join(outDir, `ui-probe-${tag}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log('[slg-offline:probe] 报告 ' + out);
  console.log('[slg-offline:probe] consoleErrors=' + report.consoleErrors.length
    + ' pageErrors=' + (report.pageErrors || []).length);
  try { await server.close(); } catch { /* ignore */ }
  app.exit(0);
}

module.exports = { runProbe };
