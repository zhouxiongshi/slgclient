/* ============================================================================
 * 界面外壳（UI Shell / P11）—— 登录门禁 + 一屏一窗 + 浮窗收束
 * ----------------------------------------------------------------------------
 * 工程红线：独立 IIFE，由 index.js 在 index.html 的 HTTP 响应末尾追加一个 script
 *   下发；磁盘 web/ 逐字节不变，不改协议，不写存档，不引用任何领域模块。
 *
 * 解决三件事（用户 2026-11-13 的第 2/3/6 项）：
 *   1. 未登录前看不到任何游戏面板数据：html[data-slg-phase="login"] 下，
 *      所有注入层根节点一律 display:none，连透镜 / 当前事务 / 推进前预览都不渲染出来。
 *      登录态只认服务端真实 WS `account.login` 成功，不认「页面加载完成」。
 *   2. 一屏一窗：城市内部页 / 六府遮罩 / skills 的 .win / 交互层 modal 四类主窗口
 *      同时只留一个；新窗打开时旧窗让位，浮窗（透镜/事务/队列/引导/地图侧栏）自动收起。
 *   3. 浮窗收束：静止态把四张浮窗挪到互不重叠的角，并提供「专注」开关一键全收。
 * ========================================================================== */
;(function () {
  'use strict';
  if (window.__slgShell) return;

  var CSS_ID = 'slgShellCss';
  if (!document.getElementById(CSS_ID)) {
    /* ★ P11 修：只有「主窗口」（城内页 / 六府 / .win）才让浮窗与按钮坞让位。
       决策预览、事件卡这类 modal/drawer 不该把沙盘按钮坞整个 display:none
       ——真鼠标试玩里推演一旬后弹事件卡，玩家就再也点不到「推演一月」了。 */
    var MAIN = ':is(html[data-slg-window="city"],html[data-slg-window="panels"],html[data-slg-window="win"])';
    var css = ''
      /* ---- 静止态：四张浮窗各占一角，互不遮挡 ---- */
      + 'html[data-slg-phase="game"] #slgIxAgenda{right:12px;top:96px;width:250px;max-height:184px;overflow:auto}'
      + 'html[data-slg-phase="game"] #slgIxLens{left:12px;top:auto;bottom:118px;width:212px;max-height:132px;overflow:auto}'
      + 'html[data-slg-phase="game"] #slgIxQueue{left:50%;bottom:12px;transform:translateX(-50%);max-width:52vw;justify-content:center}'
      + 'html[data-slg-phase="game"] #slgIxGuide{left:50%;top:52px;bottom:auto;'
      + 'transform:translateX(-50%);width:min(520px,76vw);z-index:100240}'
      + 'html[data-slg-phase="game"] #slgIxPhase{left:12px;bottom:74px}'
      + 'html[data-slg-phase="game"] #slgStratFoot{bottom:12px;max-width:300px}'
      /* ---- 专注开关：一键收掉全部浮窗 ---- */
      + 'html[data-slg-floaters="off"] #slgIxAgenda,'
      + 'html[data-slg-floaters="off"] #slgIxLens,'
      + 'html[data-slg-floaters="off"] #slgIxQueue,'
      + 'html[data-slg-floaters="off"] #slgIxGuide,'
      + 'html[data-slg-floaters="off"] #slgIxPhase,'
      + 'html[data-slg-floaters="off"] #slgStratFoot,'
      + 'html[data-slg-floaters="off"] #slgStratIntro,'
      + 'html[data-slg-floaters="off"] #slgLegend{display:none!important}'
      /* ---- 主窗口打开时，浮窗一律让位 ---- */
      + MAIN + ' #slgIxAgenda,'
      + MAIN + ' #slgIxLens,'
      + MAIN + ' #slgIxQueue,'
      + MAIN + ' #slgIxGuide,'
      + MAIN + ' #slgIxPhase,'
      + MAIN + ' #slgPanelsDock,'
      + MAIN + ' #slgDock,'
      + MAIN + ' #slgStratFoot,'
      + MAIN + ' #slgStratIntro,'
      + MAIN + ' #slgStratSide,'
      + MAIN + ' #slgLegend{display:none!important}'
      /* ---- 有弹窗时：地图图例与外壳开关一律让位 ----
         实机真鼠标试玩里，「确认执行 →」「确认出征」这些按钮的落点正好压在图例
         和右下角开关上，点了会被它们吃掉（表面症状就是「按钮点了没反应」）。 */
      + 'html[data-slg-dialog="1"] #slgLegend,'
      + 'html[data-slg-dialog="1"] #slgShellToggle,'
      + 'html[data-slg-dialog="1"] #slgIxAgenda,'
      + 'html[data-slg-dialog="1"] #slgIxLens,'
      + 'html[data-slg-dialog="1"] #slgIxGuide,'
      + 'html[data-slg-dialog="1"] #slgStratFoot,'
      + 'html[data-slg-dialog="1"] #slgStratIntro{display:none!important}'
      /* ---- 同层 .win 只允许一个，且不与城市内页并存 ---- */
      + 'html[data-slg-window="city"] #slgUIv2 .win{display:none!important}'
      + 'html[data-slg-window="panels"] #slgUIv2 .win{display:none!important}'
      /* ---- 外壳自己的开关按钮 ---- */
      + '#slgShellToggle{position:fixed;right:12px;bottom:12px;z-index:100500;'
      + 'background:rgba(18,24,18,.94);color:#e8d9a8;border:1px solid #8a7038;border-radius:5px;'
      + 'padding:6px 11px;font:12px "Microsoft YaHei",sans-serif;cursor:pointer;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.45)}'
      + '#slgShellToggle:hover{background:rgba(80,62,26,.96);color:#ffe9b0}'
      + 'html[data-slg-phase="login"] #slgShellToggle{display:none!important}'
      + 'html[data-slg-window] #slgShellToggle{display:none!important}';
    var st = document.createElement('style'); st.id = CSS_ID; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------------- 1. 登录门禁 ---------------- */
  var rootEl = document.documentElement;
  function applyPhase(p) {
    var next = p === 'game' ? 'game' : 'login';
    if (rootEl.getAttribute('data-slg-phase') !== next) {
      rootEl.setAttribute('data-slg-phase', next);
      try { window.dispatchEvent(new CustomEvent('slg:phase', { detail: { phase: next } })); } catch (e) { /* 老浏览器忽略 */ }
    }
    return next;
  }
  function pollSession() {
    fetch('/__slg/session', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { applyPhase(d && d.ready ? 'game' : 'login'); })
      .catch(function () { /* 服务重启瞬间保持上一帧，不闪屏 */ });
  }
  pollSession();
  setInterval(pollSession, 1200);

  /* ---------------- 2. 专注开关 ---------------- */
  try {
    var saved = localStorage.getItem('slgShellFloaters');
    if (saved === 'off') rootEl.setAttribute('data-slg-floaters', 'off');
  } catch (e) { /* 隐私模式 */ }
  function ensureToggle() {
    if (document.getElementById('slgShellToggle')) return;
    var b = document.createElement('button');
    b.id = 'slgShellToggle';
    b.type = 'button';
    b.textContent = '◱ 专注';
    b.title = '收起 / 展开地图透镜、当前事务、进度队列等浮窗';
    b.onclick = function () {
      var off = rootEl.getAttribute('data-slg-floaters') === 'off';
      if (off) rootEl.removeAttribute('data-slg-floaters');
      else rootEl.setAttribute('data-slg-floaters', 'off');
      try { localStorage.setItem('slgShellFloaters', off ? 'on' : 'off'); } catch (e) { /* ignore */ }
      b.textContent = off ? '◱ 专注' : '▣ 展开';
    };
    if (rootEl.getAttribute('data-slg-floaters') === 'off') b.textContent = '▣ 展开';
    document.body.appendChild(b);
  }

  /* ---------------- 3. 一屏一窗 ---------------- */
  var busy = false, queued = false;
  function snapshot() {
    var city = document.getElementById('slgCityPage');
    var pm = document.getElementById('slgPanelsMask');
    var panels = !!(pm && window.getComputedStyle(pm).display !== 'none');
    var wins = Array.prototype.slice.call(document.querySelectorAll('#slgUIv2 .win'));
    /* 两种弹窗都要算：交互层预览 .slgIx-modal，城池/出征确认框 #slgUIv2 .modal */
    var modals = document.querySelectorAll('.slgIx-modal, #slgUIv2 .modal').length;
    var drawer = document.getElementById('slgIxDrawer');
    return { city: city, panels: panels, wins: wins, modals: modals, drawer: !!drawer };
  }
  function reconcile() {
    if (busy) { queued = true; return; }
    busy = true;
    try {
      var s = snapshot();
      var key = '';
      if (s.city) key = 'city';
      else if (s.panels) key = 'panels';
      else if (s.wins.length) key = 'win';
      else if (s.modals) key = 'modal';
      else if (s.drawer) key = 'drawer';

      if (s.city) {
        /* 进城：六府遮罩与所有 .win 收掉，只留城市内部页 */
        if (s.panels && window.__slgPanels && window.__slgPanels.close) window.__slgPanels.close();
        s.wins.forEach(function (w) { w.remove(); });
      } else if (s.panels) {
        s.wins.forEach(function (w) { w.remove(); });
      } else if (s.wins.length > 1) {
        /* 多个 .win 只保留最后打开的那个（出征 / 武将 / 战报互斥） */
        s.wins.slice(0, -1).forEach(function (w) { w.remove(); });
      }
      if (key) rootEl.setAttribute('data-slg-window', key);
      else rootEl.removeAttribute('data-slg-window');
      /* 弹窗态单独打标：图例/开关要给它让位，否则会吃掉弹窗右下角按钮的点击 */
      if (s.modals) rootEl.setAttribute('data-slg-dialog', '1');
      else rootEl.removeAttribute('data-slg-dialog');
    } finally {
      busy = false;
      if (queued) { queued = false; setTimeout(reconcile, 0); }
    }
  }
  var mo = new MutationObserver(function () {
    clearTimeout(mo._t);
    mo._t = setTimeout(reconcile, 30);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('.x, [data-close], #slgCityBack');
    if (t) setTimeout(reconcile, 40);
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setTimeout(reconcile, 60); });

  function boot() { ensureToggle(); reconcile(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__slgShell = {
    phase: function () { return rootEl.getAttribute('data-slg-phase'); },
    window: function () { return rootEl.getAttribute('data-slg-window') || ''; },
    floaters: function (on) {
      if (on === false) rootEl.setAttribute('data-slg-floaters', 'off');
      else rootEl.removeAttribute('data-slg-floaters');
      reconcile();
    },
    reconcile: reconcile,
    session: pollSession,
  };
})();
