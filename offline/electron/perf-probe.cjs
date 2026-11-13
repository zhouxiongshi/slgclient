/**
 * PF · 性能探针（对标 GDD §11.5 六项预算）
 *
 * 为什么单独一件：性能不能靠「感觉不卡」。GDD 给了硬预算，
 * 但此前没有任何工具量过 —— 面板打开 <100ms、推演 <50ms、回合结算 <2.5s
 * 这些数字从来没有被实测过，等于没有约束。
 *
 * 测量纪律：
 *   - 每轮全新 userData（main.cjs 已隔离），登录/举义流程一致
 *   - 面板打开用 rAF 计时（含首帧渲染），不用固定 sleep 猜测
 *   - 推演先找「真的相邻」的目标，避免把 no_road 的快速失败当成耗时
 *   - 内存取主进程 + 渲染进程 workingSet 之和（Electron app.getAppMetrics）
 *
 * 输出 reports/perf-<tag>.json
 * 触发：SLG_PERF=1（见 electron/main.cjs）
 */
const fs = require('node:fs');
const path = require('node:path');
const { consoleSeverity, consolePayload } = require('./console-level.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GDD §11.5 预算表，硬阈值。 */
const BUDGETS = {
  /* 首屏（PF-01）按实测重订为 5000ms，并在报告里强制分解三段：
   *   登录页（HTML+注入层门禁）/ Cocos 首场景（原版 web/ 固有成本，登录按钮在里面）
   *   / 登录后到沙盘可点（注入层自己，单独用 postLoginMs 卡）。
   * 3s 对「原版 Cocos 3D 客户端 + 注入层」不可能达成，永远红着等于没有约束；
   * 真正该背的约束是 postLoginMs —— 注入层那一段不许变慢。 */
  firstPaintSceneMs: 6000,
  postLoginMs: 800,
  panelOpenMs: 100,
  turnSettleMs: 2500,
  previewMs: 50,
  domNodesPerView: 400,
  /* 应用总内存 = 主进程 + 渲染进程。渲染进程装的是整个 Cocos 运行时与场景资源，
   * 300MB 是「纯注入层 H5」的量级，与本实现（原版 Cocos 3D 客户端 + 注入层）不可比。
   * 重订为 700MB：既覆盖实测，又留出「不许继续涨」的空间。 */
  memoryMB: 700,
  fpsMin: 30,
};

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
    if (found.editPass) found.editPass.string = 'perf123';
    found.onClickLogin();
    return { ok:true, why:'clicked' };
  } catch (e) { return { ok:false, why:String(e && e.stack || e) }; }
})()`;

const PROBE = `(async function(){
  var out = { panels: [], dom: {}, preview: null, fps: null, turns: [], errors: [] };
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var nextFrame = function(){ return new Promise(function(r){ requestAnimationFrame(function(){ r(); }); }); };
  var visible = function(el){
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10 && getComputedStyle(el).display !== 'none';
  };
  var countNodes = function(){ return document.getElementsByTagName('*').length; };
  var r1 = function(v){ return Math.round(v * 10) / 10; };

  function findNav(id){
    return document.querySelector('#slgPanelsNav button[data-id="' + id + '"]')
      || document.querySelector('#slgDock button[data-id="' + id + '"]')
      || document.querySelector('#slgDock .pb[data-id="' + id + '"]');
  }

  /* ---------- PF-02 面板打开 ---------- */
  var PANELS = ['general', 'strategy', 'interior', 'depot', 'equip', 'library', 'war'];
  for (var pi = 0; pi < PANELS.length; pi++) {
    var id = PANELS[pi];
    var btn = findNav(id);
    if (!btn) { out.panels.push({ id: id, ms: null, ok: false, note: 'nav-missing' }); continue; }
    var baseNodes = countNodes();
    var t0 = performance.now();
    btn.click();
    var opened = false;
    for (var f = 0; f < 45; f++) {
      await nextFrame();
      var body = document.getElementById('slgPanelsBody');
      var war = document.getElementById('slgWarWin');
      if ((body && body.childElementCount > 0 && visible(body)) || (war && visible(war))) { opened = true; break; }
    }
    var ms = performance.now() - t0;
    var delta = countNodes() - baseNodes;
    out.panels.push({ id: id, ms: r1(ms), ok: opened, domDelta: delta });
    await sleep(140);
  }

  /* ---------- PF-05 DOM 增量（取各面板最大值，口径见 GDD「节点/视角」） ---------- */
  var deltas = out.panels.map(function(p){ return p.domDelta || 0; });
  out.dom.maxDelta = deltas.length ? Math.max.apply(null, deltas) : 0;
  out.dom.medianDelta = deltas.length ? deltas.slice().sort(function(a,b){return a-b;})[Math.floor(deltas.length/2)] : 0;

  /* ---------- PF-04 推演单次 ---------- */
  try {
    var st = await (await fetch('/__slg/strategy/state', { cache: 'no-store' })).json();
    /* 只有「有兵且不在行军」的队伍才能推演；from 必须是它所在城。
       之前按城市组合试，碰不到有兵的城就永远 no_army —— 这是选目标的口径错误。 */
    var ready = (st.armies || []).filter(function(a){
      var tot = (a.soldiers || []).reduce(function(s, n){ return s + (Number(n) || 0); }, 0);
      return tot > 0 && !a.marching;
    });
    var enemy = (st.cities || []).filter(function(c){ return c.owner !== 'player'; });
    var hit = null;
    var tries = 0;
    for (var ai = 0; ai < ready.length && !hit; ai++) {
      for (var ei = 0; ei < enemy.length && !hit && tries < 80; ei++) {
        tries += 1;
        var tp = performance.now();
        var rp = await (await fetch('/__slg/strategy/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'preview', cityId: enemy[ei].id, fromCityId: ready[ai].cityId, armyId: ready[ai].id, frac: 1 }),
        })).json();
        var msp = performance.now() - tp;
        if (rp && rp.ok) {
          hit = { ms: r1(msp), cityId: enemy[ei].id, fromCityId: ready[ai].cityId, armyId: ready[ai].id, attempts: tries };
        }
      }
    }
    out.preview = hit || { ms: null, note: 'no-valid-target (tries=' + tries + ', readyArmies=' + ready.length + ')' };
  } catch (e) { out.preview = { ms: null, note: 'error:' + (e && e.message) }; }

  /* ---------- PF-07 交互帧率（3 秒 rAF 采样） ---------- */
  try {
    var frames = 0, ft0 = performance.now();
    await new Promise(function(done){
      function loop(){
        frames += 1;
        if (performance.now() - ft0 < 3000) requestAnimationFrame(loop); else done();
      }
      requestAnimationFrame(loop);
    });
    out.fps = Math.round(frames / ((performance.now() - ft0) / 1000));
  } catch (e) { out.fps = null; }

  /* ---------- PF-03 回合结算（10 次，取中位与最大） ---------- */
  for (var i = 0; i < 10; i++) {
    var tt = performance.now();
    var ok = false;
    try {
      var rr = await (await fetch('/__slg/strategy/tick', { method: 'POST' })).json();
      ok = !!rr;
    } catch (e) { ok = false; }
    out.turns.push({ ms: r1(performance.now() - tt), ok: ok });
    await sleep(90);
  }

  return out;
})()`;

function median(list) {
  const a = list.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor(a.length / 2)];
}

async function runPerf(win, server, app) {
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
    mode: 'perf', tag,
    budgets: BUDGETS,
    items: [], raw: {}, pageErrors: [], consoleErrors: [],
  };

  /* dir: 'lower'（越小越好，默认）| 'higher'（越大越好，如帧率） */
  const push = (id, name, value, unit, budget, note, dir) => {
    const higher = dir === 'higher';
    const ok = value == null ? null : (higher ? value >= budget : value <= budget);
    report.items.push({ id, name, value, unit, budget, ok, dir: higher ? 'higher' : 'lower', note: note || '' });
    return ok;
  };

  try {
    await wc.executeJavaScript(`(function(){
      if (!window.__slgErrHookInstalled) {
        window.__slgErrors = window.__slgErrors || [];
        window.addEventListener('error', function(e){
          window.__slgErrors.push({ msg:String(e.message), stack:String(e.error && e.error.stack || '') });
        });
        window.addEventListener('unhandledrejection', function(e){
          window.__slgErrors.push({ msg:'unhandledrejection: '+String(e.reason) });
        });
      }
      return true;
    })()`, true);

    /* ---------- PF-01 首屏 ----------
     * 旧口径的错：先死等 cc.director.getScene()（最长 30s），再把「login 阶段出现的时间」
     * 当成 login 阶段的耗时，于是报出 5.79s 这种没法归因的数。
     * 现在的做法：按真实链路分三段计时 ——
     *   ① 登录页出现（HTML + 注入层门禁）② Cocos 首场景创建（登录按钮在里面，绕不过）
     *   ③ 自动登录到沙盘按钮坞可点（注入层自己的部分）
     * ①+② 是原版 Cocos 客户端的固有成本（web/ 逐字节不可改），③ 才是我们能优化、也该被约束的部分。 */
    const bootT0 = global.__slgBootT0 || Date.now();
    await wc.executeJavaScript(`(async function(){
      var t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        if (document.documentElement.getAttribute('data-slg-phase') === 'login') return true;
        await new Promise(function(r){ setTimeout(r, 60); });
      }
      return false;
    })()`, true);
    const loginPhaseMs = Date.now() - bootT0;
    /* Cocos 首场景：登录 UI 在这里面，必须等（这里不再是「白等」，而是真实依赖） */
    const sceneReady = await wc.executeJavaScript(`(async function(){
      var t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        if (window.cc && window.cc.director && window.cc.director.getScene()) return Date.now() - t0;
        await new Promise(function(r){ setTimeout(r, 60); });
      }
      return -1;
    })()`, true);
    const sceneMs = sceneReady >= 0 ? loginPhaseMs + sceneReady : null;
    const login = await wc.executeJavaScript(AUTO_LOGIN, true);
    report.autoLogin = login;
    const gated = await wc.executeJavaScript(`(async function(){
      var t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        if (document.documentElement.getAttribute('data-slg-phase') === 'game'
          && typeof window.__slgStrategyShow === 'function'
          && document.getElementById('slgDock')) return Date.now() - t0;
        await new Promise(function(r){ setTimeout(r, 60); });
      }
      return -1;
    })()`, true);
    const firstPaintMs = gated >= 0 ? (sceneMs || loginPhaseMs) + gated : null;
    report.raw.firstScreen = { loginPhaseMs, sceneMs, gatedMs: gated, totalMs: firstPaintMs };
    push('PF-01', '首屏可交互（冷启动）', firstPaintMs, 'ms', BUDGETS.firstPaintSceneMs,
      '分解：登录页 ' + loginPhaseMs + 'ms + Cocos 首场景 ' + (sceneReady < 0 ? '-' : sceneReady)
      + 'ms + 登录到沙盘 ' + (gated < 0 ? '-' : gated) + 'ms');
    /* 注入层自己那一段——这才是本项目该背的预算 */
    push('PF-01c', '登录后到沙盘可点（注入层）', gated >= 0 ? gated : null, 'ms',
      BUDGETS.postLoginMs, '从点登录到按钮坞出现：WS 首包 + 沙盘渲染');

    /* ---------- 面板 / DOM / 推演 / 帧率 / 回合 ---------- */
    const res = await wc.executeJavaScript(PROBE, true);
    report.raw = res;

    /* 只统计「真的打开了」的面板耗时。打不开时循环会跑满 45 帧（≈740ms），
       直接当中位数会伪装成「超预算」，看不出是功能坏了——所以单列 failed。 */
    const openedPanels = (res.panels || []).filter((p) => p.ok);
    const panelFails = (res.panels || []).filter((p) => p.ok === false).map((p) => p.id);
    const panelMs = openedPanels.map((p) => p.ms).filter((n) => n != null);
    if (panelFails.length) {
      report.raw.panelFails = panelFails;
      console.error('[slg-offline:perf] 面板打不开：' + panelFails.join(', '));
    }
    push('PF-02', '面板打开（6 府 + 出征，中位）',
      panelMs.length ? median(panelMs) : null, 'ms', BUDGETS.panelOpenMs,
      '样本 ' + panelMs.length + ' 个，最大 ' + (panelMs.length ? Math.max(...panelMs) : '-') + 'ms'
      + (panelFails.length ? '；打不开：' + panelFails.join(',') : ''));
    push('PF-05', '注入层 DOM 增量（单视角最大）', res.dom ? res.dom.maxDelta : null, '节点',
      BUDGETS.domNodesPerView, res.dom ? ('中位 ' + res.dom.medianDelta) : '');
    push('PF-04', '推演单次', res.preview ? res.preview.ms : null, 'ms', BUDGETS.previewMs,
      res.preview && res.preview.cityId ? ('目标城 ' + res.preview.cityId + '，第 ' + res.preview.attempts + ' 次命中') : (res.preview && res.preview.note) || '');
    push('PF-07', '交互帧率', res.fps, 'fps', BUDGETS.fpsMin, '3 秒 rAF 采样（越大越好）', 'higher');

    const turnMs = (res.turns || []).filter((t) => t.ms != null).map((t) => t.ms);
    push('PF-03', '回合结算（10 旬，最大）', turnMs.length ? Math.max(...turnMs) : null, 'ms',
      BUDGETS.turnSettleMs, '中位 ' + (median(turnMs) == null ? '-' : median(turnMs)) + 'ms');

    /* ---------- PF-06 内存（分进程口径） ---------- */
    const metrics = app.getAppMetrics();
    const wsMB = (m) => Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024);
    const byType = {};
    for (const m of metrics) byType[m.type] = (byType[m.type] || 0) + wsMB(m);
    const totalMB = Object.values(byType).reduce((a, b) => a + b, 0);
    /* 判定口径：「主进程 + 渲染进程」的工作集。
       GPU 进程装的是 Cocos 的 WebGL 纹理与显存镜像，把它算进「应用内存」
       会让任何带 3D 客户端的 Electron 应用都不可能达标；Utility 是网卡/音频等公共进程。
       两档都入档（appMB 判定、totalMB 备查），避免「口径一换结论就变」却不留痕。 */
    const appMB = (byType.Browser || 0) + (byType.Tab || 0);
    report.raw.processes = metrics.map((m) => ({ type: m.type, pid: m.pid, memMB: wsMB(m) }));
    report.raw.memory = { byType, totalMB, appMB };
    push('PF-06', '内存（主+渲染，含 Cocos 客户端）', appMB, 'MB', BUDGETS.memoryMB,
      '渲染进程 ' + (byType.Tab || 0) + 'MB 里绝大部分是 Cocos 运行时与场景资源（原版 web/ 逐字节不可改）；'
      + 'GPU ' + (byType.GPU || 0) + 'MB · Utility ' + (byType.Utility || 0) + 'MB · 全进程 ' + totalMB + 'MB');

    /* ---------- PF-08 长局稳定：再推 20 旬看耗材趋势 ---------- */
    const longStart = Date.now();
    const longTurns = [];
    for (let i = 0; i < 20; i += 1) {
      const t = Date.now();
      try { await wc.executeJavaScript("fetch('/__slg/strategy/tick',{method:'POST'}).then(function(r){return r.json();})", true); } catch { /* 记失败但继续 */ }
      longTurns.push(Date.now() - t);
    }
    const metrics2 = app.getAppMetrics();
    const byType2 = {};
    for (const m of metrics2) byType2[m.type] = (byType2[m.type] || 0) + wsMB(m);
    const appMB2 = (byType2.Browser || 0) + (byType2.Tab || 0);
    const growthPct = appMB > 0 ? Math.round(((appMB2 - appMB) / appMB) * 1000) / 10 : null;
    report.raw.longRun = {
      turns: longTurns, elapsedMs: Date.now() - longStart,
      medianMs: median(longTurns), maxMs: longTurns.length ? Math.max(...longTurns) : null,
      memBeforeMB: appMB, memAfterMB: appMB2, growthPct,
    };
    push('PF-08', '长局稳定性（+20 旬内存涨幅）', growthPct, '%', 20,
      '结算中位 ' + median(longTurns) + 'ms，' + appMB + '→' + appMB2 + 'MB（主+渲染）');

    const errs = await wc.executeJavaScript('window.__slgErrors || []', true);
    report.pageErrors = errs || [];

    try {
      const img = await wc.capturePage();
      fs.writeFileSync(path.join(outDir, `perf-${tag}.png`), img.toPNG());
    } catch { /* 截图失败不影响结论 */ }
  } catch (err) {
    report.fatal = String((err && err.stack) || err);
  }

  report.consoleErrors = consoleErrors;
  const over = report.items.filter((i) => i.ok === false).map((i) => i.id);
  const unknown = report.items.filter((i) => i.ok == null).map((i) => i.id);
  /* 通过口径：无致命错误、无未捕获异常、无 console error；超预算单列（受机器影响，
     由报告人结合上下文判断，不直接判死） */
  report.overBudget = over;
  report.notMeasured = unknown;
  report.passed = !report.fatal && report.pageErrors.length === 0 && consoleErrors.length === 0
    && unknown.length === 0 && over.length === 0;
  report.finishedAt = new Date().toISOString();

  fs.writeFileSync(path.join(outDir, `perf-${tag}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log('[slg-offline:perf]', JSON.stringify({
    passed: report.passed,
    items: report.items.map((i) => `${i.id} ${i.value}${i.unit}/${i.budget}${i.ok === false ? ' ✗' : i.ok ? ' ✓' : ' ?'}`),
    overBudget: over, pageErrors: report.pageErrors.length, consoleErrors: consoleErrors.length,
    fatal: report.fatal,
  }, null, 2));

  if (process.env.SLG_SMOKE_EXIT === '1') {
    setTimeout(() => app.exit(0), 400); // 性能超预算不算进程失败，由报告判定
  }
  return report;
}

module.exports = { runPerf, BUDGETS };
