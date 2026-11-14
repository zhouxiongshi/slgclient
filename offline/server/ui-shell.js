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
      /* ---- 注入层基础 token（P3-01 / P3-02）----
         注入层元素如果自己不写 font-family / color，就会从原版 web/style.css 继承
         Arial，未设颜色的元素则拿到浏览器默认黑。实测结果是 4 套字体族并存、
         深色面板上出现看不见的黑字。这里把注入层所有根节点钉死到同一套字体与
         正文色，子元素再各自覆盖。书法标题（KaiTi）是刻意保留的第二档。 */
      + '#slgUIv2,#slgIxRoot,#slgPanelsWin,#slgCityWin,#slgCityPage,#slgWarWin,'
      + '#slgDock,#slgPanelsDock,#slgStratSide,#slgStratFoot,#slgLegend,#slgShellToggle{'
      + 'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
      + 'color:#e6dac0}'
      /* ★ 修「战报文字居中」的根因：原版 web/style.css 给 body 设了 text-align:center
         （Cocos 的 H5 模板常这么干），注入层没有一处统一声明，于是所有没写
         text-align 的块（战报正文、卡片说明、推演结果）全部继承居中——中文长句
         居中读起来很费劲，作者只能在个别块里零散地补 text-align:left。
         这里在注入层根节点一次性钉死左对齐，需要居中的（.empty 等）自己声明。 */
      + '#slgUIv2,#slgIxRoot,#slgPanelsWin,#slgCityWin,#slgCityPage,#slgWarWin,'
      + '#slgDock,#slgPanelsDock,#slgStratSide,#slgStratFoot,#slgLegend,'
      + '#slgStratOverlay,#slgBattleOverlay{text-align:left}'
      /* 表单控件不吃继承：浏览器对 input/select/textarea/button 用 UA 默认字体
         （Arial）与黑字，实测有 15 个 input 落在 Arial 上、深色面板里是黑字。 */
      + '#slgUIv2 input,#slgUIv2 select,#slgUIv2 textarea,#slgUIv2 button,'
      + '#slgIxRoot input,#slgIxRoot select,#slgIxRoot textarea,#slgIxRoot button,'
      + '#slgPanelsWin input,#slgPanelsWin select,#slgPanelsWin textarea,#slgPanelsWin button,'
      + '#slgCityWin input,#slgCityWin select,#slgCityWin textarea,#slgCityWin button,'
      + '#slgCityPage input,#slgCityPage select,#slgCityPage textarea,#slgCityPage button,'
      + '#slgWarWin input,#slgWarWin select,#slgWarWin textarea,#slgWarWin button,'
      + '#slgDock input,#slgDock select,#slgDock button,'
      + '#slgStratSide input,#slgStratSide select,#slgStratSide button'
      + '{font-family:inherit;color:inherit}'
      /* ---- 静止态：四张浮窗各占一角，互不遮挡 ---- */
      /* ★ 六府 dock 常驻展开后占住右上 230px：当前事务必须往下让，否则会盖住
         「内政/府库/兵刃/战法库」四个入口（探针实测被盖住四枚按钮）。 */
      + 'html[data-slg-phase="game"] #slgIxAgenda{right:12px;top:232px;width:250px;max-height:24vh;overflow:auto}'
      + 'html[data-slg-phase="game"] #slgIxLens{left:12px;top:auto;bottom:118px;width:212px;max-height:132px;overflow:auto}'
      + 'html[data-slg-phase="game"] #slgIxQueue{left:50%;bottom:12px;transform:translateX(-50%);max-width:52vw;justify-content:center}'
      + 'html[data-slg-phase="game"] #slgIxGuide{left:50%;top:52px;bottom:auto;'
      + 'transform:translateX(-50%);width:min(520px,76vw);z-index:100240}'
      + 'html[data-slg-phase="game"] #slgIxPhase{left:12px;bottom:74px}'
      + 'html[data-slg-phase="game"] #slgStratFoot{bottom:12px;max-width:300px}'
      /* ---- 单张浮窗独立开关（用户 ⑧：图层检索 / 透镜 / 事务 都要能各自收起） ---- */
      + 'html[data-slg-float-side="off"] #slgStratSide,'
      + 'html[data-slg-float-lens="off"] #slgIxLens,'
      + 'html[data-slg-float-agenda="off"] #slgIxAgenda,'
      + 'html[data-slg-float-legend="off"] #slgLegend{display:none!important}'
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

  /* ---------------- 2.5 浮窗：单张收起 / 拖动 / 记住位置 ----------------
   * ★ 用户 ⑧：「图层与检索可以做成可拖动，也可隐藏和显示功能；地图透镜和当前事务
   *    都要支持隐藏和显示」。三张浮窗分散在三个模块里创建（skills 的 #slgStratSide、
   *    interaction 的 #slgIxLens / #slgIxAgenda），谁都不想为拖拽互相引用。
   *    所以「拖动 + 开关」统一由外壳负责：外层只认 DOM id，不认识业务；
   *    开与关只落一个 html[data-slg-float-*] 属性，样式在 CSS 里，任何模块都能查。
   */
  var FLOATS = {
    side: 'slgStratSide',     /* 图层与检索 */
    lens: 'slgIxLens',        /* 地图透镜 */
    agenda: 'slgIxAgenda',    /* 当前事务 */
    legend: 'slgLegend',      /* 势力面板（原势力图例） */
  };
  function readFloatState() {
    try {
      var raw = localStorage.getItem('slgFloatState');
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { return {}; }
  }
  function applyFloatState(st) {
    Object.keys(FLOATS).forEach(function (k) {
      var on = !(st[k] === 0 || st[k] === false);
      if (on) rootEl.removeAttribute('data-slg-float-' + k);
      else rootEl.setAttribute('data-slg-float-' + k, 'off');
    });
  }
  var floatState = readFloatState();
  applyFloatState(floatState);

  function setFloat(name, on) {
    if (!FLOATS[name]) return false;
    floatState[name] = on ? 1 : 0;
    try { localStorage.setItem('slgFloatState', JSON.stringify(floatState)); } catch (e) { /* 隐私模式 */ }
    applyFloatState(floatState);
    try {
      window.dispatchEvent(new CustomEvent('slg:float', { detail: { name: name, on: !!on } }));
    } catch (e) { /* ignore */ }
    return !!on;
  }
  function isFloatOn(name) {
    return rootEl.getAttribute('data-slg-float-' + name) !== 'off';
  }

  /* 拖动：把节点切到 fixed 定位后按指针位移移动，并夹在视口内。
     位置按 id 存 localStorage，下次打开还在原处（换分辨率时由 clampAll 兜底）。 */
  function dragify(node) {
    if (!node || node.dataset.slgDrag === '1') return;
    node.dataset.slgDrag = '1';
    var drag = null;
    var KEY = 'slgPos:' + node.id;
    /* 恢复上次位置（越界就丢弃，避免外接显示器拔掉后窗口跑到屏幕外） */
    try {
      var p = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (p && Number(p.l) >= 0 && Number(p.t) >= 0
        && Number(p.l) < window.innerWidth - 40 && Number(p.t) < window.innerHeight - 40) {
        node.style.position = 'fixed';
        node.style.left = p.l + 'px';
        node.style.top = p.t + 'px';
        node.style.right = 'auto';
        node.style.bottom = 'auto';
        node.style.margin = '0';
      }
    } catch (e) { /* ignore */ }
    node.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      /* 表单控件与按钮上按下不算拖动，否则输入城名时会拖走面板 */
      if (e.target.closest && e.target.closest('input,button,select,textarea,label,a,[data-nodrag]')) return;
      var r = node.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, l: r.left, t: r.top };
      node.style.position = 'fixed';
      node.style.left = r.left + 'px';
      node.style.top = r.top + 'px';
      node.style.right = 'auto';
      node.style.bottom = 'auto';
      node.style.margin = '0';
      node.style.zIndex = String(Math.max(100120, Number(node.style.zIndex) || 0));
      node.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var w = node.offsetWidth, h = node.offsetHeight;
      var l = Math.max(2, Math.min(window.innerWidth - w - 2, drag.l + (e.clientX - drag.x)));
      var t = Math.max(2, Math.min(window.innerHeight - h - 2, drag.t + (e.clientY - drag.y)));
      node.style.left = l + 'px';
      node.style.top = t + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      node.style.cursor = '';
      try {
        localStorage.setItem(KEY, JSON.stringify({ l: parseFloat(node.style.left) || 0, t: parseFloat(node.style.top) || 0 }));
      } catch (e) { /* ignore */ }
    });
  }
  function attachFloaters() {
    /* dragify 自带幂等（dataset.slgDrag），重复调用无副作用 */
    Object.keys(FLOATS).forEach(function (k) { dragify(document.getElementById(FLOATS[k])); });
  }
  function clampAll() {
    Object.keys(FLOATS).forEach(function (k) {
      var node = document.getElementById(FLOATS[k]);
      if (!node || node.style.position !== 'fixed') return;
      var r = node.getBoundingClientRect();
      if (r.right > window.innerWidth || r.bottom > window.innerHeight) {
        var l = Math.max(2, Math.min(window.innerWidth - node.offsetWidth - 2, r.left));
        var t = Math.max(2, Math.min(window.innerHeight - node.offsetHeight - 2, r.top));
        node.style.left = l + 'px';
        node.style.top = t + 'px';
      }
    });
  }
  window.addEventListener('resize', clampAll);

  /* ---------------- 3. 一屏一窗 ---------------- */
  var busy = false, queued = false;
  function snapshot() {
    var city = document.getElementById('slgCityPage');
    var pm = document.getElementById('slgPanelsMask');
    var panels = !!(pm && window.getComputedStyle(pm).display !== 'none');
    var wins = Array.prototype.slice.call(document.querySelectorAll('#slgUIv2 .win'));
    /* 两种弹窗都要算：交互层预览 .slgIx-modal，城池/出征确认框 #slgUIv2 .modal。
       ★ M4-6：事件卡 .slgIxEvent 已改为右下角非模态卡片，不能算「一屏一窗」的
         模态弹窗——否则它一出现就把 dock / 图例全隐藏，玩家等于又被挡住一层。 */
    var modals = document.querySelectorAll('.slgIx-modal:not(.slgIxEvent), #slgUIv2 .modal').length;
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
      /* 浮窗是三块各自模块创建的，这里顺手挂上拖动（幂等） */
      attachFloaters();
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
    /* 浮窗开关：任何模块都可以直接调，不互相引用 */
    float: function (name, on) {
      if (on === undefined) return isFloatOn(name);
      return setFloat(name, on);
    },
    toggleFloat: function (name) { return setFloat(name, !isFloatOn(name)); },
    floatState: function () { return Object.assign({}, floatState); },
    floats: Object.keys(FLOATS),
    attachFloaters: attachFloaters,
  };
})();
