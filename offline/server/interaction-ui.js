/* ============================================================================
 * 交互增强层（Interaction Layer / 简称 IX）
 * ----------------------------------------------------------------------------
 * 依据《三国 SLG 交互原型设计提示词 v1.0》实现，覆盖 6.1~6.11 中「纯前端注入层
 * 可实现」的部分。工程红线：
 *   - 独立 IIFE，唯一一份浏览器脚本，由 index.js 在 index.html 的 HTTP 响应里
 *     追加 <script src="/__slg/interaction/ui.js"> 下发；磁盘 web/ 逐字节不变。
 *   - 不引用、不修改 skills.js / panels-ui.js 的任何局部变量，只通过 window.__slg*
 *     的公开入口与 DOM 事件代理协作。
 *   - 不改 {seq,name,msg} 协议、不改 AES/GZIP；只读新增的 GET /__slg/interaction/state
 *     聚合端点（服务端 domain/interaction.js 纯函数）。
 *   - 面板层禁用 Math.random；术语表由 conf/interaction/terms.json 构建期内联，
 *     运行时零网络请求、零外部依赖。
 *   - 描述 = 计算 = 战报同源：所有数值都标 source / confidence / 推导口径，
 *     服务端没给的字段一律显示「服务端未提供 + 降级方案」，不伪装成权威值。
 *
 * 章节 K（字段缺口与降级）在 domain/interaction.js:fieldGaps，界面「设置 → 字段缺口」可查。
 * ========================================================================== */
;(function () {
  'use strict';
  if (window.__slgIX) return;

  /* ---------------- 0. 常量与状态 ---------------- */
  var TERMS = (window.SLG_TERMS && window.SLG_TERMS.terms) || [];
  var BY_ID = {}, BY_NAME = {};
  TERMS.forEach(function (t) { BY_ID[t.id] = t; BY_NAME[t.名称] = t; });
  var NAME_LIST = Object.keys(BY_NAME).sort(function (a, b) { return b.length - a.length; });
  var API = '/__slg/interaction/state';
  var LENSES = [
    { k: '1', id: 'faction', name: '势力', icon: '■', desc: '按归属着色，看版图与接壤' },
    { k: '2', id: 'supply', name: '粮道', icon: '═', desc: '己方城连通与出发城城库；断粮风险用「▲」+文字双编码' },
    { k: '3', id: 'stock', name: '兵源与库存', icon: '▣', desc: '逐城人口 / 城库存粮 / 支撑日数' },
    { k: '4', id: 'general', name: '武将分布', icon: '◆', desc: '武将驻城与低忠诚预警' },
    { k: '5', id: 'intel', name: '情报覆盖', icon: '◇', desc: '精确 / 估算 / 传闻三级，模糊一律标注原因' },
    { k: '6', id: 'terrain', name: '地形道路', icon: '▲', desc: '地形、特产、主要兵种、关隘' },
  ];
  var GUIDE = [
    { id: 'g1', title: '选城与内政', hint: '点开一座己方城，看「人口 / 城库 / 灾害风险」，做一次内政开发。', term: 'neizheng', done: 'cityOpened' },
    { id: 'g2', title: '委任与报告', hint: '在武将页委任一名官员：开发度逐旬推进，回合报告会写清「谁让哪座城涨了多少」。', term: 'weiren', done: 'appointed' },
    { id: 'g3', title: '探索登庸', hint: '在酒馆探索在野贤才；被拒一次后再次登门，成功率 +12%。', term: 'dengyong', done: 'explored' },
    { id: 'g4', title: '编队出征', hint: '编好队伍后选出发城与目标城，行军时长按里程 ÷ 速度计算，地图军标逐日推进。', term: 'chuzheng', done: 'attacked' },
    { id: 'g5', title: '涂色与断粮', hint: '粮道是补给线；出征前看出发城城库能撑几日，不足先运粮。', term: 'liangdao', done: 'transported' },
    { id: 'g6', title: '政策与经济', hint: '人口→兵役→征兵、逐城产量→全局府库、俸禄→忠诚，是一条完整回路。', term: 'renkou', done: 'economyRead' },
  ];

  var S = {
    data: null, hoverTip: null, pinned: [], crumbs: [], hoverTimer: 0,
    layers: [], lens: 'faction', lensOpen: false, agendaOpen: true,
    undo: [], pendingCommit: null, guideStep: 0, guideDismissed: false,
    ignored: {}, keys: {}, fontScale: 100, reduceMotion: false,
    drawer: null, lastFocus: null, fetchTimer: 0,
  };
  try {
    var saved = JSON.parse(localStorage.getItem('slgIX') || '{}');
    S.guideStep = saved.guideStep || 0;
    S.guideDismissed = !!saved.guideDismissed;
    S.ignored = saved.ignored || {};
    S.keys = saved.keys || {};
    S.fontScale = saved.fontScale || 100;
    S.reduceMotion = !!saved.reduceMotion;
    S.lens = saved.lens || 'faction';
  } catch (e) { /* 存档损坏用默认值，不阻塞 */ }
  function persist() {
    try {
      localStorage.setItem('slgIX', JSON.stringify({
        guideStep: S.guideStep, guideDismissed: S.guideDismissed, ignored: S.ignored,
        keys: S.keys, fontScale: S.fontScale, reduceMotion: S.reduceMotion, lens: S.lens,
      }));
    } catch (e) { /* 隐私模式下不可写，降级为本次会话内存 */ }
  }

  /* ---------------- 1. 小工具 ---------------- */
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function n(v, d) { var x = Number(v); return Number.isFinite(x) ? x : (d || 0); }
  function fmt(v) { return n(v).toLocaleString('zh-CN'); }
  function el(tag, css, html) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function on(node, ev, fn, cap) { node.addEventListener(ev, fn, !!cap); }
  function fetchJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function keyOf(action, def) { return (S.keys && S.keys[action]) || def; }
  function toast(msg, kind) {
    var box = document.getElementById('slgIxToast');
    if (!box) return;
    box.textContent = msg;
    box.className = 'slgIx-toast ' + (kind || 'info');
    box.style.display = 'block';
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.style.display = 'none'; }, 3600);
  }
  /* 四态反馈：待提交(灰) / 处理中(蓝) / 成功(绿) / 失败(红+原因+下一步) —— P7 */
  function phase(text, kind) {
    var p = document.getElementById('slgIxPhase');
    if (!p) return;
    p.textContent = text;
    p.className = 'slgIx-phase ' + (kind || 'idle');
    if (kind === 'ok' || kind === 'fail') {
      clearTimeout(p._t);
      p._t = setTimeout(function () { p.textContent = ''; p.className = 'slgIx-phase idle'; }, 5000);
    }
  }

  /* ---------------- 2. 样式（设计规格第 9 章：字号≥12 / 行高1.5 / 色盲双编码） ---------------- */
  function injectCss() {
    if (document.getElementById('slgIxCss')) return;
    var css = ''
      + '.slgIx{font-size:12px;line-height:1.5;color:#e8e0cc;font-family:"Microsoft YaHei","PingFang SC",sans-serif}'
      + '.slgIx button{font:inherit;cursor:pointer;background:#243026;color:#e8e0cc;border:1px solid #5c6b4e;border-radius:3px;padding:4px 9px;min-height:26px}'
      + '.slgIx button:hover{background:#35452f;border-color:#ba9a52}'
      + '.slgIx button:focus-visible{outline:2px solid #e3c46a;outline-offset:1px}'
      + '.slgIx .muted{color:#a9a48f}.slgIx b{color:#f0e2b8}'
      + '.slgIx .tag{display:inline-block;padding:1px 6px;border:1px solid #6b6142;border-radius:2px;font-size:11px;margin-right:4px}'
      + '.slgIx .tag.ok{border-color:#4f8a5b;color:#a9d8ae}'
      + '.slgIx .tag.warn{border-color:#b07a3c;color:#efc189}'
      + '.slgIx .tag.bad{border-color:#a84f47;color:#f0a49c}'
      + '#slgIxToast{position:fixed;left:50%;bottom:74px;transform:translateX(-50%);z-index:100390;'
      + 'padding:9px 16px;border:1px solid #ba9a52;background:rgba(22,32,20,.97);border-radius:4px;display:none;max-width:70vw}'
      + '#slgIxToast.ok{border-color:#4f8a5b}#slgIxToast.fail{border-color:#a84f47;background:rgba(58,24,20,.97)}'
      + '#slgIxPhase{position:fixed;left:12px;bottom:12px;z-index:100120;font-size:12px;padding:3px 9px;'
      + 'border-left:3px solid #6b6142;background:rgba(14,18,14,.88);color:#b9b29b}'
      + '#slgIxPhase.busy{border-color:#6f9fd0;color:#c7dcf2}'
      + '#slgIxPhase.ok{border-color:#4f8a5b;color:#a9d8ae}'
      + '#slgIxPhase.fail{border-color:#a84f47;color:#f0a49c}'
      + '.slgIx-tip{position:fixed;z-index:100210;width:322px;max-height:340px;overflow:auto;'
      + 'background:rgba(18,24,18,.985);border:1px solid #ba9a52;border-radius:4px;padding:11px 13px;'
      + 'box-shadow:0 6px 26px rgba(0,0,0,.62);pointer-events:auto}'
      + '.slgIx-tip.pinned{border-color:#e3c46a}'
      + '.slgIx-tip h4{margin:0 0 6px;font-size:14px;color:#f0e2b8}'
      + '.slgIx-tip .meta{font-size:11px;color:#a9a48f;margin-bottom:7px}'
      + '.slgIx-tip .body{font-size:12px;line-height:1.6}'
      + '.slgIx-tip .src{margin-top:8px;font-size:11px;color:#9cae8c;border-top:1px solid #3d4636;padding-top:6px}'
      + '.slgIx-tip .links{margin-top:7px;display:flex;flex-wrap:wrap;gap:5px}'
      + '.slgIx-tip .links button{padding:2px 7px;min-height:22px;font-size:11px}'
      + '.slgIx-tip .crumb{font-size:11px;color:#c9b98c;margin-bottom:6px;word-break:break-all}'
      + '.slgIx-term{color:#e3c46a;border-bottom:1px dotted #ba9a52;cursor:help}'
      + '#slgIxAgenda{position:fixed;right:12px;top:96px;z-index:100100;width:268px;'
      + 'background:rgba(16,22,16,.95);border:1px solid #5c6b4e;border-radius:4px;padding:9px 11px}'
      + '#slgIxAgenda h4{margin:0 0 7px;font-size:13px;color:#f0e2b8;display:flex;justify-content:space-between}'
      + '#slgIxAgenda .row{border-top:1px solid #33402f;padding:6px 0;cursor:pointer}'
      + '#slgIxAgenda .row:hover{background:rgba(90,110,70,.18)}'
      + '#slgIxAgenda .row .t{font-size:12px;color:#e8e0cc}'
      + '#slgIxAgenda .row .d{font-size:11px;color:#a9a48f;margin-top:2px}'
      + '#slgIxAgenda .urg{font-size:11px;margin-right:5px}'
      + '#slgIxLens{position:fixed;left:12px;top:96px;z-index:100100;width:224px;'
      + 'background:rgba(16,22,16,.95);border:1px solid #5c6b4e;border-radius:4px;padding:8px 10px}'
      + '#slgIxLens .lg{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}'
      + '#slgIxLens .lg button{padding:2px 7px;min-height:24px;font-size:11px}'
      + '#slgIxLens .lg button.on{background:#5a6338;border-color:#e3c46a;color:#fff2cc}'
      + '#slgIxLens .list{max-height:190px;overflow:auto;font-size:11px}'
      + '#slgIxLens .list div{padding:2px 0;border-bottom:1px dotted #33402f}'
      + '#slgIxQueue{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:100110;'
      + 'display:flex;gap:7px;align-items:center;background:rgba(16,22,16,.94);'
      + 'border:1px solid #5c6b4e;border-radius:4px;padding:5px 10px;font-size:11px;max-width:76vw;overflow:auto}'
      + '#slgIxQueue .qi{border-right:1px solid #3d4636;padding-right:8px;white-space:nowrap}'
      + '#slgIxDrawer{position:fixed;right:0;top:0;bottom:0;width:372px;z-index:100150;'
      + 'background:rgba(14,20,14,.985);border-left:2px solid #ba9a52;padding:14px 16px;overflow:auto;'
      + 'box-shadow:-8px 0 28px rgba(0,0,0,.55)}'
      + '#slgIxDrawer h3{margin:0 0 8px;color:#f0e2b8;font-size:15px}'
      + '#slgIxDrawer table{width:100%;border-collapse:collapse;font-size:12px}'
      + '#slgIxDrawer td,#slgIxDrawer th{border-bottom:1px solid #33402f;padding:4px 5px;text-align:left}'
      + '#slgIxDrawer th{color:#a9a48f;font-weight:normal;width:38%}'
      + '.slgIx-modal{position:fixed;inset:0;z-index:100300;background:rgba(0,0,0,.66);'
      + 'display:flex;align-items:center;justify-content:center}'
      + '.slgIx-modal .box{width:min(660px,90vw);max-height:82vh;overflow:auto;'
      + 'background:rgba(18,24,18,.99);border:1px solid #ba9a52;border-radius:5px;padding:16px 19px}'
      + '.slgIx-modal h3{margin:0 0 10px;color:#f0e2b8;font-size:16px}'
      + '.slgIx-modal .delta{font-size:12px;margin:5px 0;padding-left:12px;border-left:2px solid #5c6b4e}'
      + '.slgIx-modal .final{border-left-color:#e3c46a;color:#f0e2b8}'
      + '.slgIx-modal .acts{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}'
      + '.slgIx-modal .acts button{padding:6px 15px;min-height:30px}'
      + '.slgIx-modal .acts .go{background:#4a5c34;border-color:#ba9a52}'
      + '#slgIxGuide{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:100250;'
      + 'width:min(520px,88vw);background:rgba(22,30,20,.98);border:1px solid #e3c46a;'
      + 'border-radius:5px;padding:11px 14px;box-shadow:0 6px 24px rgba(0,0,0,.6)}'
      + '#slgIxGuide .gt{font-size:13px;color:#f0e2b8;margin-bottom:5px}'
      + '#slgIxGuide .gb{font-size:12px;line-height:1.6}'
      + '#slgIxGuide .ga{margin-top:9px;display:flex;gap:7px;justify-content:flex-end}'
      + '.slgIx input[type=text]{background:#1a2419;border:1px solid #5c6b4e;color:#e8e0cc;padding:4px 7px;font:inherit;min-height:26px}'
      + '#slgIxRoot.reduce *{transition:none!important;animation:none!important}'
      + '@media (max-width:1100px){#slgIxAgenda,#slgIxLens{display:none}}';
    var s = el('style', '', css); s.id = 'slgIxCss'; document.head.appendChild(s);
    var root = el('div', '', ''); root.id = 'slgIxRoot'; root.className = 'slgIx' + (S.reduceMotion ? ' reduce' : '');
    document.body.appendChild(root);
    root.appendChild(el('div', '', '')).id = 'slgIxToast';
    root.appendChild(el('div', '', '')).id = 'slgIxPhase';
    root.appendChild(el('div', '', '')).id = 'slgIxAgenda';
    root.appendChild(el('div', '', '')).id = 'slgIxLens';
    root.appendChild(el('div', '', '')).id = 'slgIxQueue';
    applyFontScale();
  }
  function applyFontScale() {
    var r = document.getElementById('slgIxRoot');
    if (r) r.style.fontSize = (12 * S.fontScale / 100) + 'px';
  }

  /* ---------------- 3. 6.1 术语提示系统（嵌套 / 锁定 / 面包屑 / Esc 逐级） ---------------- */
  var TIP_POOL = [];
  function tipNode(i) {
    if (TIP_POOL[i]) return TIP_POOL[i];
    var t = el('div', 'display:none', ''); t.className = 'slgIx-tip';
    t.dataset.tipIndex = String(i);
    (document.getElementById('slgIxRoot') || document.body).appendChild(t);
    TIP_POOL[i] = t;
    bindTip(t, i);
    return t;
  }
  function termHtml(t, crumbs) {
    var link = (t.关联词条 || []).filter(function (id) { return BY_ID[id]; }).map(function (id) {
      return '<button data-term="' + esc(id) + '">' + esc(BY_ID[id].名称) + ' ›</button>';
    }).join('');
    var src = (t.数值来源 || []).map(function (s) { return '<div>· ' + esc(s) + '</div>'; }).join('');
    var crumb = crumbs && crumbs.length
      ? '<div class="crumb">路径：' + crumbs.map(function (c) { return esc(BY_ID[c] ? BY_ID[c].名称 : c); }).join(' › ') + '</div>' : '';
    return crumb
      + '<h4>' + esc(t.名称) + ' <span class="tag">' + esc(t.分类) + '</span></h4>'
      + '<div class="meta">证据：' + esc(t.证据级别 || '本作设定') + ' · 可信度 '
      + esc(t.confidence || '中') + (t.source_id ? ' · ' + esc(t.source_id) : '') + '</div>'
      + '<div class="body">' + esc(t.简述 || '') + '</div>'
      + (src ? '<div class="src"><b>数值来源</b>' + src + '</div>' : '')
      + (link ? '<div class="links">' + link + '<button data-act="ixEncy" data-id="' + esc(t.id) + '">在百科中打开 ↗</button></div>' : '')
      + '<div class="meta" style="margin-top:8px">悬停框内词条可继续展开 · 点此框或按 K 锁定 · Esc 关闭最上层</div>';
  }
  function placeTip(node, x, y) {
    var w = 322, h = Math.min(340, node.offsetHeight || 260);
    var left = x + 16, top = y + 14;
    if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 16);
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    node.style.left = left + 'px'; node.style.top = top + 'px';
  }
  function showTip(id, x, y, opt) {
    var t = BY_ID[id]; if (!t) return;
    var o = opt || {};
    var pinned = !!o.pinned;
    var idx = pinned ? (S.pinned.length) : 0;
    if (pinned && S.pinned.length >= 3) { toast('最多同时锁定 3 个提示框，请先关闭一个', 'fail'); return; }
    var node = tipNode(pinned ? (S.pinned.length + 1) : 0);
    node.className = 'slgIx-tip' + (pinned ? ' pinned' : '');
    node.innerHTML = termHtml(t, o.crumbs || []);
    node.style.display = 'block';
    node._termId = id; node._pinned = pinned; node._crumbs = (o.crumbs || []).slice();
    placeTip(node, x, y);
    if (pinned) {
      S.pinned.push(node);
      makeDraggable(node);
    } else {
      S.hoverTip = node;
    }
    if (S.layers.indexOf(node) < 0) S.layers.push(node);
  }
  function hideTip(node) {
    if (!node) return;
    node.style.display = 'none';
    var i = S.pinned.indexOf(node); if (i >= 0) S.pinned.splice(i, 1);
    i = S.layers.indexOf(node); if (i >= 0) S.layers.splice(i, 1);
    if (S.hoverTip === node) S.hoverTip = null;
  }
  function closeTop() {
    var node = S.layers[S.layers.length - 1];
    if (!node) return false;
    if (node._pinned && node._crumbs && node._crumbs.length) {
      /* 面包屑逐级返回：先回上一层术语，而不是直接关框（CK3 套娃迷路优化） */
      var prev = node._crumbs.pop();
      var t = BY_ID[prev];
      if (t) { node.innerHTML = termHtml(t, node._crumbs.slice()); return true; }
    }
    hideTip(node); return true;
  }
  function closeAll() {
    S.layers.slice().forEach(function (n) {
      /* 模态框（百科/快捷键/预览）必须真正移出 DOM，hideTip 只隐藏会累积节点 */
      if (n && n.classList && n.classList.contains('slgIx-modal')) {
        n.remove();
        var i = S.layers.indexOf(n); if (i >= 0) S.layers.splice(i, 1);
      } else hideTip(n);
    });
  }
  function makeDraggable(node) {
    var sx = 0, sy = 0, ox = 0, oy = 0, moving = false;
    function down(e) {
      if (e.target.closest('button')) return;
      moving = true; sx = e.clientX; sy = e.clientY;
      ox = parseFloat(node.style.left) || 0; oy = parseFloat(node.style.top) || 0;
      e.preventDefault();
    }
    function move(e) {
      if (!moving) return;
      node.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      node.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    }
    function up() { moving = false; }
    on(node, 'mousedown', down); on(document, 'mousemove', move); on(document, 'mouseup', up);
  }
  function bindTip(node) {
    on(node, 'mouseover', function (e) {
      var b = e.target.closest && e.target.closest('[data-term]');
      if (!b) return;
      clearTimeout(S.hoverTimer);
      S.hoverTimer = setTimeout(function () {
        var id = b.getAttribute('data-term');
        var t = BY_ID[id]; if (!t) return;
        /* 嵌套：把当前术语压入面包屑，最多 4 层，超过给「在百科中打开」出口 */
        var crumbs = (node._crumbs || []).concat(node._termId ? [node._termId] : []);
        var r = b.getBoundingClientRect();
        showTip(id, r.right, r.top, { crumbs: crumbs.slice(-4) });
      }, 250);
    });
    on(node, 'mouseout', function (e) {
      if (e.target.closest && e.target.closest('[data-term]')) clearTimeout(S.hoverTimer);
    });
    on(node, 'click', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'ixEncy') { openEncyclopedia(b.dataset.id); return; }
      var id = b.getAttribute('data-term');
      if (id) {
        var r = b.getBoundingClientRect();
        var crumbs = (node._crumbs || []).concat(node._termId ? [node._termId] : []);
        showTip(id, r.right, r.top, { crumbs: crumbs.slice(-4) });
        return;
      }
    });
  }
  /* 自动术语标注：只处理文本节点，跳过输入控件 / 脚本 / 已标注节点，限流避免卡顿。
     对动态渲染的面板用 MutationObserver 增量扫描（设计规格 6.1 性能要求）。 */
  var SCAN_SKIP = { SCRIPT: 1, STYLE: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, BUTTON: 1 };
  function scanTerms(root) {
    if (!NAME_LIST.length || !root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var texts = [], node, budget = 260;
    while ((node = walker.nextNode()) && budget-- > 0) {
      var p = node.parentNode;
      if (!p || SCAN_SKIP[p.nodeName] || p.classList.contains('slgIx-term')
        || p.closest('.slgIx-tip, .slgIx-modal, #slgIxGuide, script, style')) continue;
      var v = node.nodeValue || '';
      if (v.length < 2 || v.length > 900) continue;
      var hit = null;
      for (var i = 0; i < NAME_LIST.length; i++) {
        if (v.indexOf(NAME_LIST[i]) >= 0) { hit = NAME_LIST[i]; break; }
      }
      if (hit) texts.push({ node: node, name: hit });
    }
    texts.forEach(function (it) {
      var p = it.node.parentNode; if (!p) return;
      var parts = it.node.nodeValue.split(it.name);
      var frag = document.createDocumentFragment();
      parts.forEach(function (part, i) {
        if (part) frag.appendChild(document.createTextNode(part));
        if (i < parts.length - 1) {
          var sp = el('span', '', esc(it.name));
          sp.className = 'slgIx-term';
          sp.dataset.term = BY_NAME[it.name].id;
          frag.appendChild(sp);
        }
      });
      try { p.replaceChild(frag, it.node); } catch (e) { /* 节点已被别的脚本替换 */ }
    });
  }
  function bindGlobalHover() {
    on(document, 'mouseover', function (e) {
      var t = e.target.closest && e.target.closest('[data-term], .slgIx-term');
      if (!t) return;
      var id = t.getAttribute('data-term');
      var term = BY_ID[id] || BY_NAME[(t.textContent || '').trim()];
      if (!term) return;
      clearTimeout(S.hoverTimer);
      S.hoverTimer = setTimeout(function () {
        if (S.hoverTip) hideTip(S.hoverTip);
        var r = t.getBoundingClientRect();
        showTip(term.id, r.right, r.top, { crumbs: [] });
      }, 250);
    });
    on(document, 'mouseout', function (e) {
      if (!(e.target.closest && e.target.closest('[data-term], .slgIx-term'))) return;
      clearTimeout(S.hoverTimer);
      setTimeout(function () {
        if (S.hoverTip && !S.hoverTip.matches(':hover') && !S.hoverTip._pinned) hideTip(S.hoverTip);
      }, 320);
    });
    on(document, 'click', function (e) {
      var t = e.target.closest && e.target.closest('[data-term], .slgIx-term');
      if (!t || !e.altKey) return;         /* Alt+点击 = 锁定，避免抢普通点击 */
      var id = t.getAttribute('data-term');
      var term = BY_ID[id] || BY_NAME[(t.textContent || '').trim()];
      if (!term) return;
      var r = t.getBoundingClientRect();
      showTip(term.id, r.right, r.top, { pinned: true, crumbs: [] });
      toast('已锁定术语框（最多 3 个，可拖动；Esc 关闭最上层）');
    }, true);
  }

  /* ---------------- 4. 6.11 离线百科（可搜索 / 超链接 / 与提示框同源） ---------------- */
  function openEncyclopedia(focusId) {
    closeAll();
    var mask = el('div', '', ''); mask.className = 'slgIx-modal';
    var box = el('div', '', ''); box.className = 'box';
    function render(q) {
      var list = TERMS.filter(function (t) {
        return !q || (t.名称 + t.分类 + t.简述 + (t.关联词条 || []).join('')).indexOf(q) >= 0;
      });
      box.innerHTML = '<h3>内置百科 · 离线（' + list.length + ' / ' + TERMS.length + ' 条）</h3>'
        + '<div style="display:flex;gap:7px;margin-bottom:10px"><input type="text" id="slgIxEncyQ" '
        + 'placeholder="检索术语 / 分类 / 数值来源" style="flex:1" value="' + esc(q || '') + '">'
        + '<button data-act="close">关闭 (Esc)</button></div>'
        + '<div class="muted" style="font-size:11px;margin-bottom:9px">术语间可点击跳转（这是《文明7》百科无超链接的教训）；'
        + '每条标注 证据级别 / source_id / confidence，放在详情层不干扰主流程。</div>'
        + '<div id="slgIxEncyList" style="max-height:54vh;overflow:auto">'
        + list.map(function (t) {
          return '<div style="border-top:1px solid #33402f;padding:7px 0;cursor:pointer" data-open="' + esc(t.id) + '">'
            + '<b>' + esc(t.名称) + '</b> <span class="tag">' + esc(t.分类) + '</span>'
            + '<span class="muted">' + esc(t.证据级别) + ' · ' + esc(t.confidence) + '</span>'
            + '<div class="muted" style="font-size:11px">' + esc(String(t.简述 || '').slice(0, 92)) + '…</div></div>';
        }).join('') + '</div>';
      var inp = box.querySelector('#slgIxEncyQ');
      on(inp, 'input', function () { render(inp.value.trim()); var i = box.querySelector('#slgIxEncyQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
      if (focusId && BY_ID[focusId]) {
        var t = BY_ID[focusId];
        box.querySelector('#slgIxEncyList').insertAdjacentHTML('afterbegin',
          '<div style="border:1px solid #ba9a52;padding:10px;margin-bottom:9px">'
          + termHtml(t, []) + '</div>');
        on(box.querySelector('#slgIxEncyList'), 'click', function (e) {
          var b = e.target.closest('[data-term]');
          if (b) openEncyclopedia(b.getAttribute('data-term'));
        });
      }
    }
    mask.appendChild(box); (document.getElementById('slgIxRoot') || document.body).appendChild(mask);
    S.layers.push(mask); render('');
    /* 监听只绑一次：render 会反复重写 innerHTML，绑在 render 里会叠加处理器 */
    on(box, 'click', function (e) {
      var row = e.target.closest('[data-open]');
      if (row) { openEncyclopedia(row.dataset.open); return; }
      if (e.target.closest('[data-act=close]')) { mask.remove(); S.layers.splice(S.layers.indexOf(mask), 1); return; }
    });
    on(mask, 'click', function (e) { if (e.target === mask) { mask.remove(); S.layers.splice(S.layers.indexOf(mask), 1); } });
  }

  /* ---------------- 4.5 M3-6 事件弹窗卡（GDD §8.3） ----------------
   *  数据来自 /__slg/interaction/state 的 pendingEvents（只读投影）；
   *  点选 POST /__slg/strategy/action eventChoice（落账在 strategy 层）。
   *  选择是必答的（队列未决不堆叠，选完 loadState 拉下一条）；按钮带
   *  data-ix-allow，避免被 interceptCosts 成本词预览二次拦截（两层弹窗协议）。 */
  var ACT = '/__slg/strategy/action';
  var LAYER_NAMES = { node: '史实节点', cond: '时局', rel: '关系' };
  function buildEventCards(d) {
    var list = d && Array.isArray(d.pendingEvents) ? d.pendingEvents : [];
    var cur = document.querySelector('.slgIx-modal.slgIxEvent');
    var want = list.length ? list[0] : null;
    if (cur && want && cur.dataset.evtId === want.id) return;
    if (cur) { cur.remove(); var li = S.layers.indexOf(cur); if (li >= 0) S.layers.splice(li, 1); }
    if (!want) return;
    var mask = el('div', '', ''); mask.className = 'slgIx-modal slgIxEvent'; mask.dataset.evtId = want.id;
    var box = el('div', '', ''); box.className = 'box';
    var html = '<h3>【' + esc(LAYER_NAMES[want.layer] || '事件') + '】' + esc(want.title) + '</h3>';
    if (want.speaker) html += '<div class="muted" style="font-size:12px;margin-bottom:6px">' + esc(want.speaker) + '</div>';
    html += want.text.map(function (t) {
      return '<p style="margin:6px 0;line-height:1.6">' + esc(t) + '</p>';
    }).join('');
    html += '<div style="display:flex;flex-direction:column;gap:7px;margin-top:14px">'
      + want.choices.map(function (c) {
        return '<button data-evt-choice="' + esc(c.id) + '" data-ix-allow="1" '
          + 'style="text-align:left;padding:8px 12px;min-height:34px">'
          + esc(c.label)
          + (c.preview ? '<div class="muted" style="font-size:11px;font-weight:normal;margin-top:3px">' + esc(c.preview) + '</div>' : '')
          + '</button>';
      }).join('') + '</div>'
      + '<div class="muted" style="font-size:11px;margin-top:10px">抉择写入史册（结局回放可查）；本旬事件至多两件，逐件处理。</div>';
    box.innerHTML = html;
    mask.appendChild(box);
    (document.getElementById('slgIxRoot') || document.body).appendChild(mask);
    S.layers.push(mask);
    on(box, 'click', function (e) {
      var b = e.target.closest('[data-evt-choice]');
      if (!b || b.disabled) return;
      var btns = box.querySelectorAll('[data-evt-choice]');
      btns.forEach(function (x) { x.disabled = true; });
      fetch(ACT, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ act: 'eventChoice', id: want.id, choice: b.dataset.evtChoice }),
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (res) {
        if (res && res.ok === false) {
          toast('事件点选未生效：' + (res.reason || res.detail || '未知'), 'fail');
          btns.forEach(function (x) { x.disabled = false; });
          return;
        }
        var eff = (res && Array.isArray(res.applied) ? res.applied : [])
          .filter(function (a) { return a.kind !== 'nothing'; })
          .map(function (a) { return (a.kind === 'flag' ? '立flag「' + a.name + '」' : a.target ? a.target + (a.delta > 0 ? '+' : '') + a.delta : a.kind + ' ' + (a.delta > 0 ? '+' : '') + a.delta); })
          .join('、');
        toast('抉择已记录' + (eff ? '：' + eff : ''));
        mask.remove(); var i = S.layers.indexOf(mask); if (i >= 0) S.layers.splice(i, 1);
        loadState();
      }).catch(function (err) {
        toast('事件点选失败：' + err.message, 'fail');
        btns.forEach(function (x) { x.disabled = false; });
      });
    });
    on(mask, 'click', function (e) { if (e.target === mask) e.stopPropagation(); }); // 必答卡：点遮罩不关闭
  }

  /* ---------------- 5. 6.2 决策预览 + 6.3 撤销 + 四态反馈 ---------------- */
  var COST_WORDS = [
    { re: /招降/, title: '招降俘虏', cost: '300 金', term: 'zhaoxiang', reversible: false },
    { re: /探索|登庸|三顾/, title: '探索登庸', cost: '100 金', term: 'dengyong', reversible: false },
    { re: /征兵|募兵/, title: '征兵', cost: '金 / 粮 / 人口', term: 'zhengding', reversible: false },
    { re: /出征|进军|开拔/, title: '出征', cost: '行军粮 + 部队兵力', term: 'chuzheng', reversible: true },
    { re: /运输|运粮/, title: '运输粮草', cost: '出发城城库粮', term: 'yunshu', reversible: true },
    { re: /赏赐/, title: '赏赐武将', cost: '金', term: 'zhongcheng', reversible: false },
    { re: /编队|整编|配置/, title: '编队整编', cost: '无（重分配兵力）', term: 'biandui', reversible: true },
    { re: /研习/, title: '战法研习', cost: '10 残卷', term: 'zhanfa', reversible: false },
    { re: /开发|屯田|农田|市集|兵营|城防|治安/, title: '内政开发', cost: '全局金 → 逐城开发度', term: 'neizheng', reversible: false },
    { re: /推演一月|推进|结束回合|下一回合/, title: '时间推进', cost: '本回合结算（不可逆）', term: 'duilie', reversible: false },
  ];
  function matchCost(el0) {
    if (!el0) return null;
    if (el0.dataset.ixCost) return { title: el0.dataset.ixCost, cost: el0.dataset.ixCostValue || '见预览', term: '', reversible: false };
    if (el0.dataset.ixAllow) return null;
    var txt = (el0.textContent || '').trim().slice(0, 30);
    if (!txt) return null;
    for (var i = 0; i < COST_WORDS.length; i++) if (COST_WORDS[i].re.test(txt)) return COST_WORDS[i];
    return null;
  }
  function previewFor(m, el0, proceed) {
    var d = S.data || {};
    var tp = d.turnPreview || {};
    var isTurn = /时间推进/.test(m.title);
    var mask = el('div', '', ''); mask.className = 'slgIx-modal';
    var box = el('div', '', ''); box.className = 'box';
    var parts = [];
    parts.push({ k: '直接消耗', v: m.cost });
    if (m.term && BY_ID[m.term]) parts.push({ k: '规则', v: String(BY_ID[m.term].简述 || '').slice(0, 110) });
    if (isTurn) {
      (tp.willHappen || []).forEach(function (x, i) { parts.push({ k: '将发生 ' + (i + 1), v: x }); });
      parts.push({ k: '推进方式', v: tp.note || '正式回合结算' });
      parts.push({ k: '尚需日数', v: (tp.need || 0) + ' 日 → 下一回合日 ' + (tp.nextTurnDay || '—') });
    }
    if (/招降/.test(m.title) && d.captives && d.captives.length) {
      var c = d.captives[0];
      (c.parts && c.parts.parts || []).forEach(function (p) {
        parts.push({ k: p.label, v: (p.value > 0 ? '+' : '') + p.value + '%' });
      });
      parts.push({ k: '最终成功率', v: (c.parts ? c.parts.final : c.rate) + '%（构成逐项可查）', final: true });
      parts.push({ k: '失败后果', v: '不扣费；俘虏忠诚 -10，低于 0 越狱' });
    }
    if (!d.ok) parts.push({ k: '服务端数据', v: '聚合端点未就绪，以下为按公开规则推算，不视为权威值' });
    /* ★ M0-3（GDD §14.2-2 / §2.1 判据「预览含如果钱不够会怎样」）：
       决策预览不只给收益，还必须给三种失败态——做不成会怎样。 */
    (function failStates() {
      var tw = (d.treasury && d.treasury.gold) || 0;
      /* ① 资源不足：从成本文案里抽「N 金 / N 粮」与府库比对 */
      var needGold = (String(m.cost).match(/(\d+)\s*金/) || [0, 0])[1];
      var needGrain = (String(m.cost).match(/(\d+)\s*粮/) || [0, 0])[1];
      if (Number(needGold) > 0 && tw < Number(needGold)) {
        parts.push({ k: '失败态 · 资源不足', v: '需要 ' + needGold + ' 金，府库现有 ' + tw
          + ' 金。点了会怎样：请求被服务端拒绝（资源不足），不扣费、状态不变；'
          + '建议先招商/等田赋或降级做更便宜的任务。', bad: true });
      }
      if (Number(needGrain) > 0 && d.treasury && Number(needGrain) > (d.treasury.grain || 0)) {
        parts.push({ k: '失败态 · 粮不足', v: '需要 ' + needGrain + ' 粮，现有 ' + (d.treasury.grain || 0)
          + ' 粮。同上：服务端拒绝，不扣粮。可先屯田/调运。', bad: true });
      }
      /* ② 粮道断：出征/运输类动作 + 存在断粮城 */
      if (/出征|进军|运输|运粮/.test(m.title) && d.alerts && d.alerts.supplyCut && d.alerts.supplyCut.length) {
        var cut = d.alerts.supplyCut[0];
        parts.push({ k: '失败态 · 粮道断', v: cut.name + ' 粮道已断 ' + (cut.days || 10)
          + ' 日（粮产 ×0.55）。从此城出发的部队行军粮更紧，粮尽后每旬士气 −5、3 旬起逃兵 2%。'
          + '建议先修粮道（夺回关隘）或换后方城出发。', bad: true });
      }
      /* ③ 超时：可逆窗口只有 0.9 秒；时间推进的结算有 2.5 秒判据 */
      if (m.reversible) {
        parts.push({ k: '失败态 · 超时', v: '确认后 0.9 秒内不按 Ctrl+Z 即视为最终提交，'
          + '此后只能读档回退。提交动画超过 2.5 秒视为卡顿 bug（请反馈）。', bad: false });
      } else if (isTurn && (tp.need || 0) > 10) {
        parts.push({ k: '失败态 · 超时', v: '本次推进需结算 ' + tp.need + ' 日（>10 日长结算），'
          + '期间输入会被排队，完成后统一刷新；不是卡死。', bad: false });
      }
    })();
    parts.push({ k: '间接连锁', v: isTurn ? '结算后本回合作废，只能读档或看回合报告' : '成功后相关面板刷新，选中对象与地图视口保持不变（P4）' });
    parts.push({ k: '可逆性', v: m.reversible ? '可逆：提交前 2 秒可按 Ctrl+Z 撤销' : '不可逆：已提交结算，需读档回退' });
    box.innerHTML = '<h3>决策前预览 · ' + esc(m.title) + '</h3>'
      + '<div class="muted" style="font-size:11px;margin-bottom:9px">设计规格 6.2：点确认之前就知道会发生什么；'
      + '数值按「基础 → 加成项 → 最终」拆解；服务端未提供者标注为推算值。</div>'
      + parts.map(function (p) {
        var cls = 'delta' + (p.final ? ' final' : '') + (p.bad ? ' bad' : '');
        var style = p.bad ? ' style="border-color:#a33;background:rgba(170,51,51,.08)"' : '';
        return '<div class="' + cls + '"' + style + '><span class="muted">' + esc(p.k)
          + '：</span>' + esc(p.v) + '</div>';
      }).join('')
      + (m.term && BY_ID[m.term] ? '<div style="margin-top:10px"><button data-act="term" data-id="' + esc(m.term)
        + '">查看术语「' + esc(BY_ID[m.term].名称) + '」与数值来源</button></div>' : '')
      + '<div class="acts"><button data-act="cancel">取消 (Esc)</button>'
      + '<button class="go" data-act="ok">确认执行</button></div>';
    mask.appendChild(box);
    (document.getElementById('slgIxRoot') || document.body).appendChild(mask);
    S.layers.push(mask);
    function close() { mask.remove(); var i = S.layers.indexOf(mask); if (i >= 0) S.layers.splice(i, 1); }
    on(box, 'click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'term') { var t = BY_ID[b.dataset.id]; if (t) showTip(t.id, window.innerWidth / 2, 120, { pinned: true }); return; }
      if (b.dataset.act === 'cancel') { close(); phase('已取消：' + m.title, 'idle'); return; }
      if (b.dataset.act === 'ok') { close(); proceed(); }
    });
    on(mask, 'click', function (e) { if (e.target === mask) close(); });
  }
  function interceptCosts() {
    on(document, 'click', function (e) {
      var t = e.target.closest && e.target.closest('button, [role=button], .btn, [data-act]');
      if (!t) return;
      var m = matchCost(t);
      if (!m) return;
      /* 捕获阶段拦截：先预览，确认后才放行原点击（纯前端，不改协议） */
      e.preventDefault(); e.stopPropagation();
      previewFor(m, t, function () {
        phase('处理中：' + m.title, 'busy');
        /* 撤销窗口：可逆操作在真正发出前留 2 秒，Ctrl+Z 可撤回（6.3 降级方案） */
        S.pendingCommit = { title: m.title, el: t, reversible: m.reversible, timer: 0 };
        var go = function () {
          if (!S.pendingCommit) return;
          S.pendingCommit = null;
          S.undo.unshift({ label: m.title, ts: Date.now(), reversible: m.reversible, target: t.textContent.trim().slice(0, 20) });
          /* ★ M0-4：撤销深度来自服务端下发的 undo.depth（undoDepth 参数化，不再硬编码 5） */
          S.undo = S.undo.slice(0, (S.data && S.data.undo && Number(S.data.undo.depth)) || 5);
          t.dataset.ixAllow = '1';
          try { t.click(); } finally { delete t.dataset.ixAllow; }
          phase('已提交：' + m.title, 'ok');
          setTimeout(loadState, 900);
        };
        if (m.reversible) {
          S.pendingCommit.timer = setTimeout(go, 900);
          toast('可逆操作：0.9 秒内按 Ctrl+Z 可撤回', 'info');
        } else go();
      });
    }, true);
  }
  function undoLast() {
    if (S.pendingCommit) {
      clearTimeout(S.pendingCommit.timer);
      var title = S.pendingCommit.title; S.pendingCommit = null;
      phase('已撤销（未提交）：' + title, 'ok');
      toast('已撤销：' + title, 'ok');
      return;
    }
    var last = S.undo[0];
    if (!last) { toast('没有可撤销的操作', 'fail'); return; }
    toast(last.reversible
      ? '「' + last.label + '」已提交服务端，前端无法回滚；请通过读档回退（设计规格 6.3：撤销栈应入存档，当前协议无此字段）'
      : '「' + last.label + '」属不可逆操作，需读档回退', 'fail');
  }
  /* 四态反馈：包装 fetch，只对同域 /__slg/ 请求显示状态，不改请求体与协议 */
  function wrapFetch() {
    if (window.__slgIxFetchWrapped) return;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var isAct = /\/__slg\/.*(action|tick|choose|restart|slot|import)/.test(url) && (!init || init.method === 'POST');
      if (isAct) phase('处理中：' + url.split('?')[0], 'busy');
      return orig.apply(this, arguments).then(function (r) {
        if (isAct) phase(r.ok ? '成功：' + url.split('?')[0] : '失败：HTTP ' + r.status, r.ok ? 'ok' : 'fail');
        return r;
      }).catch(function (e) {
        if (isAct) phase('失败：' + e.message + '（可重试或检查服务端）', 'fail');
        throw e;
      });
    };
    window.__slgIxFetchWrapped = true;
  }

  /* ---------------- 6. 6.4 当前事务 / 军师建言 ---------------- */
  function buildAgendaHtml() {
    var box = document.getElementById('slgIxAgenda'); if (!box) return;
    var d = S.data;
    if (!d || !d.ok) {
      box.innerHTML = '<h4>当前事务 <button data-act="refresh">刷新</button></h4>'
        + '<div class="muted">加载中… 若持续失败，检查 GET ' + esc(API) + ' 是否可用。</div>';
      return;
    }
    var agenda = (d.agenda || []).filter(function (a) { return !S.ignored[a.id]; }).slice(0, 5);
    var urgent = { 1: ['▲', 'bad'], 2: ['▲', 'bad'], 3: ['●', 'warn'], 4: ['●', 'ok'], 5: ['◇', 'warn'], 6: ['◇', 'warn'] };
    box.innerHTML = '<h4><span>当前事务 · 军师建言 <span class="muted">Top ' + agenda.length + '</span></span>'
      + '<span><button data-act="refresh" title="刷新">↻</button> <button data-act="fold" title="折叠">−</button></span></h4>'
      + (S.agendaOpen ? (agenda.length ? agenda.map(function (a) {
        var u = urgent[a.urgency] || ['●', 'ok'];
        return '<div class="row" data-jump="' + esc(a.jump ? a.jump.kind : '') + '" data-id="'
          + esc(a.jump ? a.jump.id : '') + '" data-agid="' + esc(a.id) + '">'
          + '<div class="t"><span class="urg tag ' + u[1] + '">' + u[0] + ' ' + esc(a.urgency) + '</span>'
          + esc(a.title) + '</div>'
          + '<div class="d">' + esc(a.action) + ' · ' + esc(a.deadline) + ' · '
          + esc(a.source) + '（可信度' + esc(a.confidence) + '）</div>'
          + '<div class="d muted">' + esc(a.detail) + '</div>'
          + '<button data-act="ignore" data-agid="' + esc(a.id) + '" style="font-size:10px;padding:1px 5px;min-height:18px;margin-top:3px">本回合忽略</button>'
          + '</div>';
      }).join('') : '<div class="muted">暂无待办。可展开六府或推进回合。</div>'
        + '<div class="muted" style="margin-top:7px;font-size:11px">建言免费常驻，可信度分档，不与评分／成就挂钩（6.4）。</div>') : '');
  }
  function bindAgenda() {
    var box = document.getElementById('slgIxAgenda'); if (!box) return;
    on(box, 'click', function (e) {
      var b = e.target.closest('button');
      if (b && b.dataset.act === 'refresh') { loadState(); return; }
      if (b && b.dataset.act === 'fold') { S.agendaOpen = !S.agendaOpen; buildAgendaHtml(); return; }
      if (b && b.dataset.act === 'ignore') {
        S.ignored[b.dataset.agid] = true; persist(); buildAgendaHtml();
        toast('已忽略本回合，可在回合报告找回'); return;
      }
      var row = e.target.closest('[data-jump]'); if (!row) return;
      jumpTo(row.dataset.jump, n(row.dataset.id));
    });
  }
  function jumpTo(kind, id) {
    try {
      if (kind === 'city' && typeof window.__slgCityWindow === 'function') window.__slgCityWindow(id);
      else if (kind === 'war' && typeof window.__slgWarWindow === 'function') window.__slgWarWindow({ tab: 'go' });
      else if (kind === 'captive' && window.__slgPanels) window.__slgPanels.open('general');
      else if (kind === 'general' && window.__slgPanels) window.__slgPanels.open('general');
      else if (window.__slgPanels) window.__slgPanels.open('strategy');
      openDrawer(kind, id);
      toast('已跳转到目标对象；地图视口与选中态未丢失（P4）');
    } catch (err) { toast('跳转失败：' + err.message, 'fail'); }
  }

  /* ---------------- 7. 6.9 就地抽屉（不脱离地图上下文，可一键返回） ---------------- */
  function openDrawer(kind, id) {
    S.lastFocus = { kind: kind, id: id };
    var d = S.data || {};
    var exists = document.getElementById('slgIxDrawer');
    if (exists) exists.remove();
    var box = el('div', '', ''); box.id = 'slgIxDrawer';
    var title = kind === 'city' ? '城池就地抽屉' : kind === 'general' ? '武将就地抽屉' : '上下文抽屉';
    var rows = [];
    if (kind === 'city') {
      var c = (d.cities || []).find(function (x) { return n(x.id) === n(id); });
      if (c) {
        rows = [
          ['城池', c.name + ' · ' + c.province], ['特产 / 主要兵种', (c.specialty || '—') + ' / ' + (c.arms || '—')],
          ['人口', fmt(c.pop)], ['城库存粮', fmt(c.store) + '（可支撑 ' + c.supportDays + ' 日）'],
          ['治安 / 民心', c.order + ' / ' + c.morale],
          ['灾害风险', c.disasterRisk + '（' + c.disasterBasis + '）'],
          ['开发度 农/商/兵/防', [c.devAgri, c.devTrade, c.devArms, c.devDef].join(' / ')],
          ['内政冷却', c.investReady ? '就绪' : '冷却中'],
        ];
        title = c.name + ' · 就地抽屉';
      }
    } else if (kind === 'general') {
      var g = (d.generals || []).find(function (x) { return n(x.id) === n(id); });
      if (g) rows = [['武将', g.name], ['星级', g.star], ['忠诚', g.loyal], ['旬俸', g.due + ' 金']];
    }
    if (!rows.length) rows = [['说明', '服务端未提供该对象的详情字段；以下为聚合态占位，见「字段缺口」。']];
    box.innerHTML = '<h3>' + esc(title) + '</h3>'
      + '<div class="muted" style="font-size:11px;margin-bottom:9px">面包屑：'
      + (S.lastFocus ? '当前对象' : '—') + ' › 就地抽屉 · '
      + '按 Esc 收起；地图视口与选中态保持不变（6.9）。</div>'
      + '<table>' + rows.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>'
      + '<div style="margin-top:12px;display:flex;gap:7px;flex-wrap:wrap">'
      + '<button data-act="back">← 返回刚才那个对象</button>'
      + '<button data-act="panels">在六府深度浏览</button>'
      + '<button data-act="close">收起 (Esc)</button></div>'
      + '<div class="muted" style="margin-top:10px;font-size:11px">字段权威源：GET /__slg/interaction/state（domain/interaction.js）。'
      + '所有数值在顶栏／城池面板／建言卡中同源，不各算一份（5.4）。</div>';
    (document.getElementById('slgIxRoot') || document.body).appendChild(box);
    S.drawer = box; S.layers.push(box);
    on(box, 'click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'close') { box.remove(); S.drawer = null; return; }
      if (b.dataset.act === 'back' && S.lastFocus) { jumpTo(S.lastFocus.kind, S.lastFocus.id); return; }
      if (b.dataset.act === 'panels' && window.__slgPanels) window.__slgPanels.open(kind === 'general' ? 'general' : 'strategy');
    });
    scanTerms(box);
  }

  /* ---------------- 8. 6.5 地图六透镜（1–6，只换数据层不换视口） ---------------- */
  function lensRows() {
    var d = S.data || {}, cities = d.cities || [], marches = d.marches || [];
    var lens = S.lens;
    if (lens === 'faction') return cities.map(function (c) { return '● ' + c.name + ' · ' + c.province; });
    if (lens === 'supply') return cities.slice().sort(function (a, b) {
      /* ★ U20 真正断粮的城排最前（supply.connected === false），其次才是城库见底 */
      var ca = (a.supply && a.supply.connected === false) ? 0 : 1;
      var cb = (b.supply && b.supply.connected === false) ? 0 : 1;
      return ca - cb || a.supportDays - b.supportDays;
    }).map(function (c) {
      var sp = c.supply || {};
      if (sp.connected === false) {
        return '▲ 粮道断绝 ' + (sp.days || 0) + ' 日 · ' + c.name + '（民心 ' + fmt(c.morale)
          + ' · 粮产五成 · 城库撑 ' + c.supportDays + ' 日）';
      }
      return (c.supportDays < 10 ? '▲ 缺粮 ' : '● ') + c.name + ' 粮道 ' + (sp.hops || 0) + ' 跳'
        + (sp.via && sp.via.length ? '（经 ' + sp.via.join('→') + '）' : '')
        + ' · 城库 ' + fmt(c.store) + ' · 撑 ' + c.supportDays + ' 日';
    });
    if (lens === 'stock') return cities.slice().sort(function (a, b) { return b.pop - a.pop; })
      .map(function (c) { return '▣ ' + c.name + ' 人口 ' + fmt(c.pop) + ' · 粮 ' + fmt(c.store); });
    if (lens === 'general') return (d.generals || []).slice(0, 12).map(function (g) {
      return (g.loyal < 70 ? '▲ ' : '◆ ') + g.name + ' 忠诚 ' + g.loyal + ' · 旬俸 ' + g.due;
    });
    if (lens === 'intel') return marches.map(function (m) {
      var mark = m.intel === 'precise' ? '● 精确' : m.intel === 'estimated' ? '◇ 估算' : '◇ 传闻';
      return mark + ' ' + m.fromName + '→' + m.toName + ' · ' + m.remain + ' 日后抵达（' + (m.side === 'faction' ? '诸侯' : '我军') + '）';
    }).concat(['情报不足不是随机：可派斥候 / 探索提升覆盖（4.4）']);
    return cities.map(function (c) { return '▲ ' + c.name + ' · ' + (c.specialty || '无特产') + ' / ' + (c.arms || '—'); });
  }
  function buildLens() {
    var box = document.getElementById('slgIxLens'); if (!box) return;
    var cur = LENSES.find(function (l) { return l.id === S.lens; }) || LENSES[0];
    box.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center">'
      + '<b style="font-size:12px">地图透镜 <span class="muted">' + esc(cur.icon + ' ' + cur.name) + '</span></b>'
      + '<button data-act="fold" style="font-size:10px;padding:1px 6px;min-height:20px">' + (S.lensOpen ? '−' : '+') + '</button></div>'
      + '<div class="lg">' + LENSES.map(function (l) {
        return '<button class="' + (l.id === S.lens ? 'on' : '') + '" data-lens="' + l.id + '" '
          + 'title="' + esc(l.desc) + '">' + l.k + ' ' + esc(l.icon + l.name) + '</button>';
      }).join('') + '</div>'
      + (S.lensOpen ? '<div class="muted" style="font-size:11px;margin-bottom:5px">' + esc(cur.desc) + '</div>'
        + '<div class="list">' + lensRows().slice(0, 14).map(function (r) { return '<div>' + esc(r) + '</div>'; }).join('') + '</div>'
        + '<div class="muted" style="font-size:10px;margin-top:5px">切换只替换数据层，空间布局与视口不变；'
        + '沙盘 token 叠加依赖原容器，找不到时降级为本列表（章节 K）。</div>' : '');
  }
  function bindLens() {
    var box = document.getElementById('slgIxLens'); if (!box) return;
    on(box, 'click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'fold') { S.lensOpen = !S.lensOpen; buildLens(); return; }
      if (b.dataset.lens) {
        S.lens = b.dataset.lens; persist(); buildLens();
        /* 只借《文明6》透镜的交互手法，不借 4X 玩法层（设计规格 4.2） */
        try {
          var map = document.querySelector('#slgStrategyWin, #slgStrategyMap, [data-ix-map]');
          if (map) { map.dataset.ixLens = S.lens; map.style.setProperty('--slg-lens', S.lens); }
        } catch (err) { /* 原沙盘容器不存在 → 保留列表降级 */ }
        toast('透镜：' + LENSES.find(function (l) { return l.id === S.lens; }).name);
      }
    });
  }

  /* ---------------- 9. 6.10 队列 / 回合报告 / 推进预览 ---------------- */
  function buildQueue() {
    var box = document.getElementById('slgIxQueue'); if (!box) return;
    var d = S.data || {}, tp = d.turnPreview || {};
    var ms = d.marches || [];
    var parts = ['<span class="qi"><b>第 ' + (d.turn || 0) + ' 回合</b> · 第 ' + (d.day || 1) + ' 日 · ' + esc(d.season || '') + '</span>'];
    parts.push('<span class="qi">金 ' + fmt((d.treasury || {}).gold) + ' · 粮 ' + fmt((d.treasury || {}).grain) + '</span>');
    parts.push('<span class="qi">俸禄 ' + fmt((d.salary || {}).total) + ' 金 · 覆盖 ' + ((d.salary || {}).coveragePct) + '%</span>');
    parts.push('<span class="qi">在途 ' + ms.length + ' 队</span>');
    if (ms.length) parts.push(ms.slice(0, 3).map(function (m) {
      return '<span class="qi">' + (m.side === 'faction' ? '◇' : '●') + ' ' + esc(m.fromName) + '→' + esc(m.toName)
        + ' · 剩 ' + m.remain + ' 日</span>';
    }).join(''));
    parts.push('<span class="qi">下回合还需 ' + (tp.need || 0) + ' 日</span>');
    parts.push('<button data-act="preview" style="padding:2px 8px;min-height:22px;font-size:11px">推进前预览</button>');
    parts.push('<button data-act="report" style="padding:2px 8px;min-height:22px;font-size:11px">回合报告</button>');
    box.innerHTML = parts.join('');
  }
  function bindQueue() {
    var box = document.getElementById('slgIxQueue'); if (!box) return;
    on(box, 'click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'preview') {
        previewFor({ title: '时间推进', cost: '本回合结算（不可逆）', reversible: false, term: 'duilie' }, b,
          function () { toast('预览已确认：请在界面点击「推演一月」执行，本层不代发时间推进指令'); });
      }
      if (b.dataset.act === 'report') showTurnReport();
    });
  }
  function showTurnReport() {
    var d = S.data || {}, tp = d.turnPreview || {};
    var mask = el('div', '', ''); mask.className = 'slgIx-modal';
    var box = el('div', '', ''); box.className = 'box';
    box.innerHTML = '<h3>回合报告 · 第 ' + (d.turn || 0) + ' 回合 / 第 ' + (d.day || 1) + ' 日</h3>'
      + '<div class="muted" style="font-size:11px">按城 / 按武将归因，可折叠；告警置顶但不阻塞（6.10）。</div>'
      + '<div style="margin-top:10px">' + (tp.willHappen || []).map(function (x) {
        return '<div class="delta">' + esc(x) + '</div>';
      }).join('') + '</div>'
      + '<h4 style="margin-top:14px;color:#f0e2b8">告警（置顶）</h4>'
      + ((d.alerts && d.alerts.lowGrain || []).map(function (a) {
        return '<div class="delta"><span class="tag bad">▲ 断粮</span>' + esc(a.name) + ' 城库仅撑 ' + a.supportDays + ' 日</div>';
      }).join('') + (d.alerts && d.alerts.lowLoyalty || []).map(function (a) {
        return '<div class="delta"><span class="tag warn">▲ 忠诚</span>' + esc(a.name) + ' ' + esc(a.reason) + '</div>';
      }).join('') || '<div class="muted">无告警</div>')
      + '<h4 style="margin-top:14px;color:#f0e2b8">在途队列</h4>'
      + ((d.marches || []).map(function (m) {
        return '<div class="delta">● ' + esc(m.fromName) + ' → ' + esc(m.toName) + '，剩余 ' + m.remain
          + ' 日（' + (m.intel === 'precise' ? '精确' : '估算/传闻') + '）</div>';
      }).join('') || '<div class="muted">无在途队伍</div>')
      + '<div class="acts"><button data-act="close">关闭 (Esc)</button></div>';
    mask.appendChild(box); (document.getElementById('slgIxRoot') || document.body).appendChild(mask);
    S.layers.push(mask);
    on(box, 'click', function (e) { if (e.target.closest('[data-act=close]')) mask.remove(); });
    on(mask, 'click', function (e) { if (e.target === mask) mask.remove(); });
  }

  /* ---------------- 10. 6.11 渐进引导（不阻塞 / 可跳过 / 可重看 / 情境触发） ---------------- */
  function buildGuide() {
    var old = document.getElementById('slgIxGuide'); if (old) old.remove();
    if (S.guideDismissed || S.guideStep >= GUIDE.length) return;
    var g = GUIDE[S.guideStep];
    var box = el('div', '', ''); box.id = 'slgIxGuide';
    box.innerHTML = '<div class="gt">渐进教学 ' + (S.guideStep + 1) + ' / ' + GUIDE.length + ' · ' + esc(g.title) + '</div>'
      + '<div class="gb">' + esc(g.hint) + (BY_ID[g.term] ? ' <span class="slgIx-term" data-term="' + esc(g.term) + '">' + esc(BY_ID[g.term].名称) + '</span>' : '') + '</div>'
      + '<div class="ga"><button data-act="skip">跳过教学</button>'
      + '<button data-act="later">稍后</button>'
      + '<button data-act="next">知道了，下一关 →</button></div>';
    (document.getElementById('slgIxRoot') || document.body).appendChild(box);
    on(box, 'click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'skip') { S.guideDismissed = true; persist(); box.remove(); return; }
      if (b.dataset.act === 'later') { box.remove(); return; }
      S.guideStep += 1; persist(); buildGuide();
    });
    scanTerms(box);
  }

  /* ---------------- 11. 快捷键 / 设置 / 无障碍 ---------------- */
  var DEFAULT_KEYS = {
    pin: 'k', lens: '1', agenda: 'g', ency: 'e', help: '?', undo: 'z',
    guide: 'h', drawer: 'd',
  };
  function key(action) { return S.keys[action] || DEFAULT_KEYS[action]; }
  function openKeys() {
    var mask = el('div', '', ''); mask.className = 'slgIx-modal';
    var box = el('div', '', ''); box.className = 'box';
    var gaps = (S.data && S.data.fieldGaps) || [];
    box.innerHTML = '<h3>快捷键 / 设置 / 字段缺口（章节 K）</h3>'
      + '<div class="muted" style="font-size:11px;margin-bottom:9px">键位可重映射：点右侧输入框后按新键；'
      + '字号可缩放、减少动效、色盲双编码（颜色 + 形状/文字标签）。</div>'
      + '<table>' + Object.keys(DEFAULT_KEYS).map(function (a) {
        return '<tr><th>' + esc({ pin: '锁定术语框', lens: '透镜 1–6', agenda: '当前事务', ency: '内置百科', help: '本页', undo: '撤销 Ctrl+', guide: '重看教学', drawer: '就地抽屉' }[a])
          + '</th><td><input type="text" data-key="' + esc(a) + '" value="' + esc(key(a)) + '" style="width:70px"></td></tr>';
      }).join('') + '</table>'
      + '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<button data-act="font-">字号 −</button><button data-act="font+">字号 +</button>'
      + '<span>当前 ' + S.fontScale + '%</span>'
      + '<button data-act="motion">' + (S.reduceMotion ? '动效：已减少' : '动效：正常') + '</button>'
      + '<button data-act="reset">恢复默认键位</button></div>'
      + '<h4 style="margin-top:15px;color:#f0e2b8">字段缺口与降级方案（设计规格 2.2 / 章节 K）</h4>'
      + (gaps.length ? gaps.map(function (g) {
        return '<div class="delta"><b>' + esc(g.field) + '</b>（' + esc(g.use) + '）<br>'
          + '<span class="muted">降级：' + esc(g.fallback) + '</span></div>';
      }).join('') : '<div class="muted">聚合端点未就绪，字段缺口列表暂不可用。</div>')
      + '<div class="acts"><button data-act="close">关闭 (Esc)</button></div>';
    mask.appendChild(box); (document.getElementById('slgIxRoot') || document.body).appendChild(mask);
    S.layers.push(mask);
    on(box, 'click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'close') { mask.remove(); return; }
      if (b.dataset.act === 'font+') { S.fontScale = Math.min(150, S.fontScale + 10); applyFontScale(); persist(); openKeysAgain(mask); }
      if (b.dataset.act === 'font-') { S.fontScale = Math.max(80, S.fontScale - 10); applyFontScale(); persist(); openKeysAgain(mask); }
      if (b.dataset.act === 'motion') { S.reduceMotion = !S.reduceMotion; var r = document.getElementById('slgIxRoot'); if (r) r.className = 'slgIx' + (S.reduceMotion ? ' reduce' : ''); persist(); openKeysAgain(mask); }
      if (b.dataset.act === 'reset') { S.keys = {}; persist(); openKeysAgain(mask); }
    });
    on(box, 'keydown', function (e) {
      var i = e.target.closest('[data-key]'); if (!i) return;
      if (['Control', 'Shift', 'Alt', 'Tab'].indexOf(e.key) >= 0) return;
      e.preventDefault();
      S.keys[i.dataset.key] = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      i.value = S.keys[i.dataset.key]; persist();
    });
    on(mask, 'click', function (e) { if (e.target === mask) mask.remove(); });
  }
  function openKeysAgain(mask) { mask.remove(); openKeys(); }
  function bindKeys() {
    on(document, 'keydown', function (e) {
      var tag = (e.target && e.target.nodeName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') {
        if (e.shiftKey) { closeAll(); var mods = document.querySelectorAll('.slgIx-modal, #slgIxDrawer'); mods.forEach(function (m) { m.remove(); }); return; }
        var top = S.layers[S.layers.length - 1];
        if (top && top.classList && (top.classList.contains('slgIx-modal') || top.id === 'slgIxDrawer')) { top.remove(); S.layers.pop(); return; }
        if (closeTop()) return;
        return;
      }
      if (typing) return;
      if (e.ctrlKey && e.key.toLowerCase() === key('undo')) { e.preventDefault(); undoLast(); return; }
      if (e.ctrlKey) return;
      if (/^[1-6]$/.test(e.key)) { S.lens = LENSES[Number(e.key) - 1].id; persist(); buildLens(); return; }
      var k = e.key.toLowerCase();
      if (k === key('pin')) {
        var ht = S.hoverTip;
        if (ht) { var r = ht.getBoundingClientRect(); showTip(ht._termId, r.left, r.top, { pinned: true, crumbs: ht._crumbs }); hideTip(ht); }
        else toast('先悬停到一个术语，再按 ' + key('pin').toUpperCase() + ' 锁定');
      }
      else if (k === key('ency')) openEncyclopedia();
      else if (k === key('help')) openKeys();
      else if (k === key('agenda')) { S.agendaOpen = !S.agendaOpen; buildAgendaHtml(); toast(S.agendaOpen ? '当前事务已展开' : '当前事务已折叠'); }
      else if (k === key('guide')) { S.guideDismissed = false; S.guideStep = 0; persist(); buildGuide(); }
      else if (k === key('drawer')) { if (S.drawer) { S.drawer.remove(); S.drawer = null; } else openDrawer('city', (S.data && S.data.cities && S.data.cities[0] && S.data.cities[0].id) || 0); }
    });
  }

  /* ---------------- 12. 数据加载与启动 ---------------- */
  function loadState() {
    return fetchJSON(API).then(function (d) {
      /* ★ M0-4（验收 B2/B3）：撤销栈策略来自服务端（d.undo），前端不复算。
         B2 战斗结算后清栈：battleCount 增加；
         B3 读档后清栈：turn 回退（比上次小）视为读档。 */
      var up = d && d.undo;
      if (up) {
        var battleNow = Number(up.battleCount) || 0;
        var turnNow = Number(up.turn) || 0;
        if (S.undoSignal) {
          if (up.clearOnBattle && battleNow > S.undoSignal.battle) {
            if (S.undo.length) { S.undo = []; toast('战斗已结算，撤销栈已清空（战斗不可撤）', 'info'); }
          }
          if (up.clearOnLoad && turnNow < S.undoSignal.turn) {
            if (S.undo.length) { S.undo = []; toast('检测到读档回退，撤销栈已清空', 'info'); }
          }
        }
        S.undoSignal = { battle: battleNow, turn: turnNow };
      }
      S.data = d;
      buildEventCards(d);
      buildAgendaHtml(); buildLens(); buildQueue();
      scanTerms(document.getElementById('slgPanelsMask') || document.body);
    }).catch(function (e) {
      S.data = { ok: false, error: e.message };
      buildAgendaHtml(); buildQueue();
      phase('交互数据不可用：' + e.message + '（检查 /__slg/interaction/state）', 'fail');
    });
  }
  function boot() {
    injectCss();
    bindGlobalHover(); bindTipEvents(); interceptCosts(); wrapFetch();
    bindAgenda(); bindLens(); bindQueue(); bindKeys();
    buildAgendaHtml(); buildLens(); buildQueue(); buildGuide();
    loadState();
    setInterval(loadState, 20000);
    /* 动态面板：增量扫描术语，避免全量遍历卡顿（6.1 性能要求） */
    var mo = new MutationObserver(function (recs) {
      var touched = null;
      for (var i = 0; i < recs.length; i++) {
        if (recs[i].addedNodes && recs[i].addedNodes.length) { touched = recs[i].target; break; }
      }
      if (touched && touched.closest && !touched.closest('.slgIx-tip, .slgIx-modal, #slgIxRoot')) {
        clearTimeout(S.scanTimer);
        S.scanTimer = setTimeout(function () { scanTerms(touched); }, 220);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    window.__slgIX = {
      state: function () { return S.data; },
      refresh: loadState,
      tip: function (id) { if (BY_ID[id]) showTip(id, 120, 120, { pinned: true }); },
      encyclopedia: openEncyclopedia,
      keys: openKeys,
      guide: function () { S.guideDismissed = false; S.guideStep = 0; persist(); buildGuide(); },
      drawer: openDrawer,
      lens: function (id) { S.lens = id; persist(); buildLens(); },
      terms: function () { return TERMS.slice(); },
      undo: function () { return S.undo.slice(); },
      closeAll: closeAll,
    };
    phase('交互增强层已就绪 · 按 ? 查看快捷键与字段缺口', 'ok');
  }
  function bindTipEvents() { /* 节点池在首次 showTip 时按需绑定，这里保留扩展位 */ }

  if (document.readyState === 'loading') on(document, 'DOMContentLoaded', boot);
  else boot();
})();
