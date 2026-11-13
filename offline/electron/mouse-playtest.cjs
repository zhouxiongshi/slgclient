/**
 * P11 · 真实鼠标全流程试玩（不是 element.click()，也不是只打接口）
 * ---------------------------------------------------------------------------
 * 用户 2026-11-13 第 5/6 项：「不能只看后台接口调用判断流程是否正常，要自己用鼠标
 * 在电脑面板上操作来检查是否可行」。本文件用 Electron 的 webContents.sendInputEvent
 * 把 mouseMove / mouseDown / mouseUp 真派发给渲染进程，坐标由 DOM
 * getBoundingClientRect() 取，点击前还用 elementFromPoint 校验「这个点最上面
 * 是不是目标元素」——被别的窗口盖住时会直接判失败并留证。
 *
 * 唯一的例外是 Cocos 画布内的登录按钮（没有 DOM 节点），沿用 ui-audit 的
 * LoginLogic.onClickLogin()；以及「把沙盘显示出来」这一步环境准备。其余所有
 * 按钮、页签、地图城池、确认框，全部是真实鼠标点击。
 *
 * 输出 reports/mouse-playtest-<tag>.json + 若干截图。
 * 触发：SLG_MOUSE=1（见 electron/main.cjs、tools/mouse-playtest.js）
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
    if (found.editName) found.editName.string = 'player';
    if (found.editPass) found.editPass.string = 'mouse123';
    found.onClickLogin();
    return { ok:true, why:'clicked via LoginLogic.onClickLogin' };
  } catch (e) { return { ok:false, why:String(e && e.stack || e) }; }
})()`;

/** 在渲染进程里算目标中心点，并检查是否被别的窗口盖住。 */
const RECT_OF = `(function(sel){
  var e = (typeof sel === 'string') ? document.querySelector(sel) : sel;
  if (!e) return { ok:false, why:'no element' };
  try { e.scrollIntoView({ block:'center', inline:'center', behavior:'instant' }); } catch (err) {}
  var r = e.getBoundingClientRect();
  var cs = getComputedStyle(e);
  var x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
  var top = document.elementFromPoint(x, y);
  var hit = !!top && (top === e || e.contains(top) || (e.tagName === 'CANVAS' && top === e));
  return {
    ok: r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden',
    x:x, y:y, w:Math.round(r.width), h:Math.round(r.height),
    topmost: hit, topTag: top ? (top.tagName + (top.id ? '#'+top.id : '')) : 'none',
    topCls: top ? String(top.className || '') : '',
    topText: top ? (top.textContent || '').replace(/\\s+/g,' ').trim().slice(0,40) : '',
    ownPos: cs.position, ownZ: cs.zIndex,
    topZ: top ? getComputedStyle(top).zIndex : '',
    topPos: top ? getComputedStyle(top).position : '',
    topPe: top ? getComputedStyle(top).pointerEvents : '',
    vw: window.innerWidth, vh: window.innerHeight,
    box: (function () {
      var m = e.closest('.slgIx-modal, .modal');
      if (!m) return null;
      var mr = m.getBoundingClientRect(), ms = getComputedStyle(m);
      var bx = e.closest('.box');
      var br = bx ? bx.getBoundingClientRect() : null;
      return { mask: [Math.round(mr.left), Math.round(mr.top), Math.round(mr.width), Math.round(mr.height)],
               box: br ? [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)] : null,
               display: ms.display, visibility: ms.visibility, opacity: ms.opacity,
               pe: ms.pointerEvents, zi: ms.zIndex };
    })(),
    chain: (function () {
      var n = e, out = [];
      for (var i = 0; n && i < 5; i++, n = n.parentElement) {
        out.push(n.tagName + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).split(/\s+/).join('.') : ''));
      }
      return out.join(' < ');
    })(),
    text: (e.textContent || '').replace(/\\s+/g,' ').trim().slice(0,90),
    disabled: !!e.disabled,
  };
})`;

async function runMousePlaytest(win, server, app) {
  const wc = win.webContents;
  const tag = process.env.SLG_SMOKE_TAG || 'original';
  const outDir = process.env.SLG_SMOKE_REPORT_DIR || path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(), mode: 'mouse-playtest', tag,
    steps: [], pageErrors: [], consoleErrors: [], serverErrors: [], screenshots: [],
    inputMode: 'webContents.sendInputEvent(mouseMove/mouseDown/mouseUp)',
  };
  const consoleErrors = [];
  wc.on('console-message', (...args) => {
    const d = consolePayload(args);
    if (consoleSeverity(d.level) >= 2) {
      const t = String(d.message == null ? '' : d.message);
      if (!/Electron Security Warning/i.test(t)) consoleErrors.push(t);
    }
  });
  const js = (expr) => wc.executeJavaScript(expr, true);
  /* ★ 检测器自身必须先活着：extra 里常带 RECT_OF 的 r.ok，若展开在后会把
     本步骤的判定 ok 覆盖成「元素可见」→「被遮挡」也被记成通过（同 T-01 教训）。 */
  const rec = (id, ok, note, extra) => report.steps.push({ ...(extra || {}), id, ok: !!ok, note: note || '' });
  const shot = async (name) => {
    try {
      const img = await wc.capturePage();
      const f = path.join(outDir, `mouse-${tag}-${name}.png`);
      fs.writeFileSync(f, img.toPNG());
      report.screenshots.push(path.basename(f));
    } catch { /* 截图失败不影响结论 */ }
  };

  async function mouse(rawX, rawY) {
    /* ★ Electron 45 的 MouseInputEvent.type 只认 mouseDown / mouseUp，
       写成 mousePressed / mouseReleased 会直接抛 "Invalid event object"。
       x/y 必须是有限整数，否则同样被拒（并会把 NaN 送进渲染进程）。 */
    const x = Math.round(Number(rawX)), y = Math.round(Number(rawY));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`invalid mouse coords: ${rawX},${rawY}`);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(35);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(70);
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }
  async function click(sel, id, note) {
    const r = await js(`(${RECT_OF})(${JSON.stringify(sel)})`);
    if (!r || !r.ok) { rec(id, false, (note || '') + ' 找不到/不可见: ' + (r ? (r.why || ('w=' + r.w + ',h=' + r.h)) : 'null')); return false; }
    if (!r.topmost) { rec(id, false, (note || '') + ' 被遮挡，最上层=' + r.topTag + '.' + r.topCls, r); return false; }
    if (r.disabled) { rec(id, false, (note || '') + ' 按钮被禁用', r); return false; }
    await mouse(r.x, r.y);
    rec(id, true, (note || '') + ' 真实点击 (' + r.x + ',' + r.y + ') ' + r.text, r);
    return true;
  }
  async function wait(expr, ms, id, note) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 9000)) {
      try { if (await js(expr)) { rec(id, true, note || '条件达成'); return true; } } catch { /* retry */ }
      await sleep(180);
    }
    rec(id, false, (note || '等待超时') + ' / ' + expr.slice(0, 90));
    return false;
  }
  /* 每一步留一份紧凑 DOM 快照：「按钮点到了但没反应」时，靠它区分
     是渲染没跟上、被弹窗拦了、还是窗口被外壳收掉了。 */
  const trace = async (label) => {
    const t = await js(`(function(){
      var nav = document.querySelector('#slgCityNav button.on');
      var bd = document.getElementById('slgCityBody');
      return {
        tabOn: nav ? nav.textContent.trim() : '',
        cityPage: !!document.getElementById('slgCityPage'),
        warWin: !!document.getElementById('slgWarWin'),
        windowAttr: document.documentElement.getAttribute('data-slg-window') || '',
        phase: document.documentElement.getAttribute('data-slg-phase') || '',
        quickBtns: document.querySelectorAll('[data-quick-levy]').length,
        modals: document.querySelectorAll('.slgIx-modal, #slgUIv2 .modal').length,
        body: (bd ? bd.textContent : '').replace(/\\s+/g, ' ').slice(0, 90),
        warFn: typeof window.__slgWarWindow,
      };
    })()`);
    report.trace = report.trace || [];
    report.trace.push({ label, ...t });
    return t;
  };
  /* 回合推进会弹事件抉择卡 / 决策预览 / 事件结算卡；玩家必须先处理它才能继续。
     这里同样用真实鼠标点掉，不用 element.click() 偷懒。
     ★ 三个必须做对的细节：
       1) 从「最后一个」弹窗开始处理——后插入的才是压在顶上的那个；
       2) 事件卡会连锁（选完一项又弹结算卡），所以要循环到「连续两次都没有弹窗」为止；
       3) 点完要留出渲染时间，立刻复查会读到旧 DOM，误判成「已经清干净」。 */
  async function probeBlocker() {
    return await js(`(function(){
      var mods = Array.prototype.slice.call(document.querySelectorAll('.slgIx-modal, #slgUIv2 .modal'));
      /* 只排除真正不参与布局/命中的：display:none / visibility:hidden。
         不要按 opacity 过滤——事件卡有淡入过渡，过渡期间它已经在吃点击了，
         按透明度跳过会导致「以为清干净了，实际点不动」。 */
      mods = mods.filter(function (m) {
        var cs = getComputedStyle(m);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      for (var i = mods.length - 1; i >= 0; i--) {
        var m = mods[i];
        var bs = Array.prototype.slice.call(m.querySelectorAll('button, [data-ix-allow="1"]'));
        var b = bs.find(function (x) { return x.dataset && x.dataset.act === 'ok'; })
          || bs.find(function (x) { return /确认执行|确定|接受|采纳|继续|跳过/.test(x.textContent || ''); })
          || bs.find(function (x) { return /关闭|取消/.test(x.textContent || ''); })
          || bs[0];
        if (b) { b.setAttribute('data-mouse-target', 'blocker-' + i);
          return { sel: '[data-mouse-target="blocker-' + i + '"]', text: (b.textContent || '').trim().slice(0, 40) }; }
        return { remove: true };
      }
      return null;
    })()`);
  }
  /* 点一个按钮，若被必答事件卡挡住：先按玩家真实做法处理卡片，再重新点。
     事件卡是异步出现的，可能出现于「清完」与「点击」之间的空档，所以必须重试。 */
  async function clickThrough(sel, id, note, tries) {
    const n = tries || 3;
    for (let i = 0; i < n; i += 1) {
      if (i === 0) { await clearBlockers(id + '.pre'); }
      const ok = await click(sel, i ? id + '#' + i : id, note);
      if (ok) return true;
      await clearBlockers(id + '.clear' + i);
      await sleep(350);
    }
    return false;
  }
  async function clearBlockers(id) {
    let cleared = 0;
    for (let i = 0; i < 8; i += 1) {
      const info = await probeBlocker();
      if (!info) {
        if (!cleared) return false;
        await sleep(650);
        if (!(await probeBlocker())) return true;   // 连锁弹窗已停
        continue;
      }
      if (info.remove) {
        await js(`(function(){ document.querySelectorAll('.slgIx-modal, #slgUIv2 .modal').forEach(function(m){ m.remove(); }); return true; })()`);
        cleared += 1;
        await sleep(300);
        continue;
      }
      if (await click(info.sel, id + (i ? '#' + i : ''), '真鼠标处理遮挡弹窗：' + info.text)) cleared += 1;
      await sleep(500);
    }
    return cleared > 0;
  }

  try {
    /* ---------- 0. 页面就绪 ----------
       冷启动 Cocos 场景可能要 40s+ 才挂出 cc.director.getScene()（与 smoke 同口径），
       等不够会把「还没加载完」误判成产品缺陷。先等注入脚本落地，再等场景。 */
    await wait('!!window.__slgGateDebug', 30000, 'page.injected', '登录门禁脚本已随页面下发');
    /* 先把「页面是否被系统节流」取证：rAF 停掉时 Cocos 永远不建场景，
       不记录这一项就会把环境问题误报成产品缺陷。 */
    const vis = await js(`(function(){
      var c = document.querySelector('canvas');
      return { visibility: document.visibilityState, hidden: document.hidden,
               focused: document.hasFocus(), canvas: !!c,
               ccGlobal: typeof window.cc };
    })()`);
    rec('page.visibility', vis && vis.visibility === 'visible' && vis.focused,
      '页面可见且获得焦点（Cocos 才会跑 rAF）', vis);
    await wait('!!(window.cc && window.cc.director && window.cc.director.getScene())', 90000, 'page.cc', 'Cocos 场景就绪');
    const before = await js(`(function(){
      return { phase: document.documentElement.getAttribute('data-slg-phase'),
               agendaVisible: (function(){ var e=document.getElementById('slgIxAgenda');
                 return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 4; })(),
               lensVisible: (function(){ var e=document.getElementById('slgIxLens');
                 return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 4; })() };
    })()`);
    report.beforeLogin = before;
    rec('gate.beforeLogin', !before.agendaVisible && !before.lensVisible,
      '登录前透镜/当前事务不可见（phase=' + before.phase + '）', before);
    await shot('00-login');

    /* Cocos 画布内登录按钮没有 DOM 节点，这一处沿用组件调用；其余全真鼠标。
       与 smoke 一样重试：场景刚建好时 LoginLogic 组件可能还差一帧才挂上。 */
    let login = null;
    for (let i = 0; i < 12; i += 1) {
      login = await js(AUTO_LOGIN);
      if (login && login.ok) break;
      await sleep(1000);
    }
    report.autoLogin = login;
    rec('login', !!login?.ok, 'Cocos 登录（唯一非 DOM 入口）: ' + (login ? login.why : 'null'));
    await js(`(function(){ if(window.__slgGatePoll) window.__slgGatePoll(); return true; })()`);
    await wait(`document.documentElement.getAttribute('data-slg-phase')==='game'`, 20000, 'gate.afterLogin', '登录后进入 game 阶段');
    await js(`(function(){ if(window.__slgShell) window.__slgShell.session(); return true; })()`);
    await sleep(1200);

    /* 城内页「莫名消失」必须能定位到调用方，否则只能猜。
       这里监听 remove/removeChild，把谁拆的 #slgCityPage 连调用栈一起记下来。 */
    await js(`(function(){
      if (window.__slgDomLog) return true;
      var log = window.__slgDomLog = [];
      var rec = function (how, id) {
        log.push({ how: how, id: id, at: Date.now(), stack: (new Error()).stack.split('\\n').slice(2, 6).join(' | ') });
        if (log.length > 60) log.shift();
      };
      var rp = Element.prototype.remove;
      Element.prototype.remove = function () { if (this.id) rec('remove', this.id); return rp.apply(this, arguments); };
      var rc = Element.prototype.removeChild;
      Element.prototype.removeChild = function (n) { if (n && n.id) rec('removeChild', n.id); return rc.apply(this, arguments); };
      /* 记录所有 __slg POST 的请求体与服务端回包：「点了没生效」时这是唯一能定责的证据 */
      var of = window.fetch;
      window.__slgFetchLog = [];
      window.fetch = function (url, opt) {
        var u = String((url && url.url) || url || '');
        var p = of.apply(this, arguments);
        if (u.indexOf('/__slg/') >= 0 && opt && String(opt.method || '').toUpperCase() === 'POST') {
          p.then(function (res) {
            res.clone().json().then(function (j) {
              window.__slgFetchLog.push({ url: u, body: String(opt.body || '').slice(0, 200), rsp: j });
              if (window.__slgFetchLog.length > 30) window.__slgFetchLog.shift();
            }).catch(function () {});
          }).catch(function () {});
        }
        return p;
      };
      /* 记录浏览器实际收到的 click：真鼠标派发是否落到 DOM，一眼可辨 */
      window.__slgClicks = [];
      document.addEventListener('click', function (e) {
        var t = e.target || {};
        window.__slgClicks.push({
          tag: t.tagName || '', id: t.id || '', cls: String(t.className || '').slice(0, 30),
          text: String(t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
          x: e.clientX, y: e.clientY, at: Date.now(),
        });
        if (window.__slgClicks.length > 60) window.__slgClicks.shift();
      }, true);
      var tst = window.__slgToast;
      if (tst) {
        window.__slgToast = function (msg, ok) {
          (window.__slgToasts = window.__slgToasts || []).push({ msg: String(msg), ok: !!ok, at: Date.now() });
          if (window.__slgToasts.length > 40) window.__slgToasts.shift();
          return tst.apply(this, arguments);
        };
      }
      /* 再记一层「谁开的城内页」：自动弹页会打断「点地图进城」的验证 */
      var open = window.__slgCityInterior;
      window.__slgCityInterior = function () {
        if (!window.__slgDomLog.some(function (x) { return x.how === 'open' && Date.now() - x.at < 400; })) {
          rec('open', String(arguments[0]));
        }
        return open.apply(this, arguments);
      };
      return true;
    })()`);

    /* ---------- 1. 举义（真鼠标） ---------- */
    await wait(`!!document.getElementById('slgOath') || !!(window.__slgStrategyShow && document.getElementById('slgStratTick'))`,
      12000, 'oath.ready', '举义页或沙盘已就绪');
    const hasOath = await js(`!!document.getElementById('slgOath')`);
    if (hasOath) {
      rec('oath.page', true, '举义页出现');
      /* 举义页先渲染「正召集诸侯……」，诸侯/都城卡是异步拉回来的；
         不等卡片有尺寸就点，会命中零尺寸容器（看起来像选择器错了）。 */
      await wait(`(function(){ var e=document.querySelector('.slgOathLord'); return !!e && e.getBoundingClientRect().width > 2; })()`,
        15000, 'oath.lordReady', '诸侯卡片渲染完成');
      await click('.slgOathLord', 'oath.lord', '点第一张诸侯卡');
      await sleep(600);
      await wait(`(function(){ var e=document.querySelector('.slgOathCity'); return !!e && e.getBoundingClientRect().width > 2; })()`,
        12000, 'oath.cityReady', '候选都城卡片渲染完成');
      await click('.slgOathCity', 'oath.city', '点第一座候选都城（自动提交）');
      /* 渐隐层 520ms 后才真正移除；只等 id 消失会在这段时间点到全屏遮罩上 */
      await wait(`!document.getElementById('slgOath') && !document.getElementById('slgOathBody')`,
        9000, 'oath.submit', '举义页（含渐隐遮罩）完全收起');
    } else {
      rec('oath.page', true, '旧档已举义，跳过');
    }

    /* ---------- 2. 沙盘 + 点城「进城」（真鼠标点画布） ---------- */
    await js(`(function(){ if(window.__slgStrategyShow) window.__slgStrategyShow(); return true; })()`);
    await sleep(1200);
    /* 验证「点地图进城」之前必须先处于沙盘态：任何残留城内页都算前置不成立 */
    if (await js(`!!document.getElementById('slgCityPage')`)) {
      await js(`(function(){ if(window.__slgCityClose) window.__slgCityClose(); return true; })()`);
      await sleep(500);
      rec('map.sandboxReset', true, '点城前先关掉残留城内页，回到沙盘（取证见 __slgDomLog）');
    }
    const st = await js(`(async function(){ var r = await fetch('/__slg/strategy/state',{cache:'no-store'}); return await r.json(); })()`);
    const homeId = Number(st.playerCity) || (st.cities || []).find((c) => c.owner === 'player')?.id || 1;
    const home = (st.cities || []).find((c) => Number(c.id) === Number(homeId));
    report.homeCity = home ? { id: home.id, name: home.name } : null;
    await js(`(function(){ if(window.__slgFocusCity) window.__slgFocusCity(${JSON.stringify(String(home?.name || homeId))}); return true; })()`);
    await sleep(700);
    const pos = await js(`(function(){ return window.__slgCityScreenPos ? window.__slgCityScreenPos(${Number(homeId)}) : null; })()`);
    if (!pos || !pos.inView) {
      rec('map.cityClick', false, '城池屏幕坐标不可用或不在视口内', pos);
    } else {
      const top = await js(`(function(){ var t=document.elementFromPoint(${pos.x},${pos.y}); return t ? t.tagName+(t.id?'#'+t.id:'') : 'none'; })()`);
      /* 点之前必须确认最上层是沙盘画布本身，任何残留遮罩都算真缺陷（不留假通过） */
      const clearTop = /^CANVAS/.test(top) || /slgStrategyOverlay|slgStrat/i.test(top);
      if (!clearTop) {
        rec('map.cityClick', false, `城点被遮挡，最上层=${top}`, { ...pos, top });
      } else {
        await mouse(pos.x, pos.y);
        rec('map.cityClick', true, `真实鼠标点地图 ${pos.name} (${pos.x},${pos.y})，命中 ${top}`, pos);
      }
    }
    const cityOpened = await wait(`!!document.getElementById('slgCityPage')`, 9000, 'city.enter', '点城后进入城市内部页');
    const cityDefault = await js(`(function(){ var b=document.querySelector('#slgCityNav button.on'); return b?b.textContent.trim():''; })()`);
    rec('city.defaultTab', cityDefault === '内政', '己方城默认落在「内政」页，实际=' + cityDefault);
    const onlyOne = await js(`(function(){
      var w=document.querySelectorAll('#slgUIv2 .win').length;
      var c=!!document.getElementById('slgCityPage');
      return { wins:w, city:c, window:document.documentElement.getAttribute('data-slg-window') };
    })()`);
    rec('window.single', onlyOne.wins === 0 && onlyOne.city, '一屏一窗：城内页打开时无其它 .win', onlyOne);
    await trace('after city.enter');
    await shot('01-city-interior');

    /* ---------- 3. 内政（真鼠标） ---------- */
    await click('#slgCityNav button[data-citytab="home"]', 'city.tab.home', '点「内政」页签');
    await sleep(500);
    const interior = await js(`(function(){ var b=document.getElementById('slgCityBody'); return b ? b.textContent : ''; })()`);
    rec('city.interior', /劝课生息/.test(interior), '内政页含「劝课生息」（人口→兵源闭环）');
    await trace('after city.tab.home');
    const populateSel = await js(`(function(){
      var bs=Array.prototype.slice.call(document.querySelectorAll('#slgCityBody button'));
      var b=bs.find(function(x){ return /劝课生息/.test(x.textContent||''); });
      if(!b) return null;
      /* 给按钮做一次性标记，供真实鼠标定位 */
      b.setAttribute('data-mouse-target','populate'); return b.textContent.trim().slice(0,40);
    })()`);
    if (populateSel) {
      const okBefore = await js(`(async function(){ var r=await fetch('/__slg/strategy/state',{cache:'no-store'}); var s=await r.json();
        return (s.interiorTasks||[]).length; })()`);
      await click('#slgCityBody button[data-mouse-target="populate"]', 'city.populate.click', '真鼠标点「劝课生息」');
      await sleep(900);
      const okAfter = await js(`(function(){ var b=document.getElementById('slgCityBody'); return b ? /已委派|进行中|已办/.test(b.textContent) : false; })()`);
      rec('city.populate.result', okAfter, '内政派单有反馈；before=' + okBefore);
    } else rec('city.populate.click', false, '找不到「劝课生息」按钮');

    /* ---------- 4. 征兵：兵源台账 + 一键征兵（真鼠标） ---------- */
    await click('#slgCityNav button[data-citytab="army"]', 'city.tab.army', '点「征兵」页签');
    await sleep(700);
    const levy = await js(`(async function(){ var r=await fetch('/__slg/strategy/state',{cache:'no-store'}); var s=await r.json();
      var c=(s.cities||[]).find(function(x){return Number(x.id)===Number(${Number(homeId)});});
      return c && c.levy ? c.levy : null; })()`);
    report.levy = levy;
    rec('levy.view', !!levy && levy.adultMales < levy.households,
      '兵源台账：妇孺老弱户免征（' + (levy ? levy.exempt : '?') + ' 户）');
    const quickOk = await click('#slgCityBody button[data-quick-levy="100"]', 'levy.quick', '真鼠标点「征 100 丁」');
    if (quickOk) {
      await sleep(1300);
      const after = await js(`(async function(){ var r=await fetch('/__slg/strategy/state',{cache:'no-store'}); var s=await r.json();
        var c=(s.cities||[]).find(function(x){return Number(x.id)===Number(${Number(homeId)});});
        return c && c.levy ? { levied:c.levy.levied, quota:c.levy.quota, reason:c.levy.reason } : null; })()`);
      report.levyAfter = after;
      rec('levy.once', !!after && (after.levied > 0 || after.reason === 'levy_cooldown'),
        '一键征兵写入台账，同旬再征会被拦', after);
      /* 再点一次，验证「不允许反复征兵」：点了不该再涨，台账必须原地不动 */
      const readLevied = `(async function(){ var r=await fetch('/__slg/strategy/state',{cache:'no-store'}); var s=await r.json();
        var c=(s.cities||[]).find(function(x){return Number(x.id)===Number(${Number(homeId)});});
        return c && c.levy ? { levied:c.levy.levied, canLevy:c.levy.canLevy, reason:c.levy.reason } : null; })()`;
      const beforeRepeat = await js(readLevied);
      await click('#slgCityBody button[data-quick-levy="100"]', 'levy.repeat.click', '同旬第二次点征兵');
      await sleep(1000);
      const afterRepeat = await js(readLevied);
      rec('levy.repeat', !!beforeRepeat && !!afterRepeat
        && afterRepeat.levied === beforeRepeat.levied && afterRepeat.canLevy === false,
        '同旬重复征兵被拦：已征户不变（' + (beforeRepeat && beforeRepeat.levied) + ' → '
        + (afterRepeat && afterRepeat.levied) + '），canLevy=' + (afterRepeat && afterRepeat.canLevy),
        { before: beforeRepeat, after: afterRepeat });
    }
    await trace('after levy.quick');
    /* 真缺陷断言：办完一件事，城内页必须还在（不许闪退、不许退回沙盘） */
    await wait(`!!document.getElementById('slgCityPage')`, 6000, 'city.persist', '征兵后城内页仍在（不闪退）');
    await shot('02-city-levy');

    /* ---------- 5. 出征向导（真鼠标，全六门） ---------- */
    await click('#slgCityNav button[data-citytab="war"]', 'war.open', '真鼠标点「自本城出征」');
    await trace('after war.open.click');
    await wait(`!!document.getElementById('slgWarWin')`, 9000, 'war.panel', '出征面板打开');
    await trace('after war.panel.wait');
    const rail = await js(`(function(){ var b=document.querySelector('#slgWarWin .body'); return b?b.textContent.slice(0,240):''; })()`);
    rec('war.wizard', /出征四步/.test(rail), '出征四步向导可见');
    const locked = await js(`(function(){ var b=document.getElementById('slgWarAttackBtn'); return b?b.disabled:null; })()`);
    rec('war.gate', locked === true, '未推演前「出征」按钮被锁', { disabled: locked });
    /* 推演按钮：给一次性标记，避免选择器踩到别的同名按钮。
       注意出征按钮文案是「先推演一次再出征」，也含「推演一次」，所以这里必须精确匹配，
       否则会命中那个本来就 disabled 的按钮，把产品判定成「按钮被禁用」。 */
    await js(`(function(){ var bs=Array.prototype.slice.call(document.querySelectorAll('#slgWarWin button'));
      var b=bs.find(function(x){ var t=(x.textContent||'').trim(); return t==='推演一次' || t==='再推演一次'; });
      if(b) b.setAttribute('data-mouse-target','preview'); return !!b; })()`);
    await click('#slgWarWin button[data-mouse-target="preview"]', 'war.preview', '真鼠标点「推演一次」');
    await wait(`(function(){ var b=document.getElementById('slgWarAttackBtn'); return !!b && !b.disabled; })()`, 12000,
      'war.unlock', '推演成功后解锁出征');
    await click('#slgWarAttackBtn', 'war.attack', '真鼠标点「出征」');
    /* 确认框有两种可能：本窗自带的 .modal（正常路径），或交互层误拦的 .slgIx-modal。
       两者都要能测出来，不能只等一种还宣布「没弹出」。 */
    await wait(`!!document.querySelector('#slgUIv2 .modal') || !!document.querySelector('.slgIx-modal')`, 6000, 'war.confirmBox', '出征确认框出现');
    await js(`(function(){ var bs=Array.prototype.slice.call(document.querySelectorAll('#slgUIv2 .modal button'));
      var b=bs.find(function(x){ return /^出征/.test((x.textContent||'').trim()); });
      if(b) b.setAttribute('data-mouse-target','attack-ok'); return !!b; })()`);
    await click('#slgUIv2 .modal button[data-mouse-target="attack-ok"]', 'war.confirm', '真鼠标确认出征');
    await sleep(1200);
    const march = await js(`(async function(){ var r=await fetch('/__slg/strategy/state',{cache:'no-store'}); var s=await r.json();
      return { marches:(s.marches||[]).filter(function(m){return m.side==='player'&&!m.resolved;}).length,
               pending:(s.pendingBattles||[]).length, day:s.day,
               all:(s.marches||[]).map(function(m){return m.side+'/'+m.kind+'/'+m.resolved;}) }; })()`);
    /* 出兵失败时游戏会 toast 原因，把话术带进报告，别只写「没有行军队列」 */
    const toastTxt = await js(`(function(){
      var a = document.querySelector('#slgUIv2 .toast');
      var b = document.getElementById('slgIxToast');
      return ((a && a.textContent) || '') + ' | ' + ((b && b.textContent) || '');
    })()`);
    report.march = march;
    report.toastAfterAttack = toastTxt;
    rec('war.marching', march.marches > 0, '行军队列出现（toast: ' + String(toastTxt).trim().slice(0, 80) + '）', march);
    await shot('03-war-marching');

    /* ---------- 6. 推演回合（真鼠标点沙盘按钮）直到抵达，验证「遭遇」门 ---------- */
    await js(`(function(){ var w=document.getElementById('slgWarWin'); if(w) w.remove(); return true; })()`);
    await sleep(400);
    let pendingCount = 0;
    for (let i = 0; i < 8; i++) {
      const p = await js(`(async function(){ var r=await fetch('/__slg/strategy/state',{cache:'no-store'}); var s=await r.json();
        return (s.pendingBattles||[]).length; })()`);
      if (p > 0) { pendingCount = p; break; }
      await clearBlockers(`turn.clear${i}`);
      /* 城内页是整屏的，会把沙盘的「推演一月」盖住；城里也有同源的「推演一旬」，
         所以按当前所处界面选入口——两个入口本来就是同一实现。 */
      const inCity = await js(`!!document.getElementById('slgCityPage')`);
      const tickSel = inCity ? '#slgCityTick' : '#slgStratTick';
      await clickThrough(tickSel, `turn.tick${i}`, '真鼠标点「推演」' + (inCity ? '（城内页）' : '（沙盘）'));
      await sleep(850);
    }
    if (!pendingCount) {
      pendingCount = await js(`(async function(){ var r=await fetch('/__slg/strategy/state',{cache:'no-store'}); var s=await r.json();
        return (s.pendingBattles||[]).length; })()`);
    }
    rec('war.encounter', pendingCount > 0, '抵城进入「遭遇」待决，不自动开打', { pendingCount });
    if (pendingCount > 0) {
      await js(`(function(){ if(window.__slgWarWindow) window.__slgWarWindow({tab:'encounter'}); return true; })()`);
      await wait(`!!document.getElementById('slgWarWin')`, 8000, 'war.encounterPanel', '打开遭遇页');
      const enc = await js(`(function(){ var b=document.querySelector('#slgWarWin .body'); return b?b.textContent.slice(0,260):''; })()`);
      rec('war.encounter.buttons', /确认开战/.test(enc) && /临阵收兵/.test(enc), '遭遇页含确认/撤军两条出路');
      await js(`(function(){ var bs=Array.prototype.slice.call(document.querySelectorAll('#slgWarWin button'));
        var b=bs.find(function(x){ return /确认开战/.test(x.textContent||''); });
        if(b) b.setAttribute('data-mouse-target','battle-confirm'); return !!b; })()`);
      /* 推演回合期间可能弹「必答」事件卡，会盖住遭遇页的操作条。
         这属于设计内的必答拦截，玩家也是先处理它再点开战——测试同样照做。 */
      await clearBlockers('enc.clear');
      await clickThrough('#slgWarWin button[data-mouse-target="battle-confirm"]', 'war.battleConfirm', '真鼠标确认开战');
      await sleep(1200);
      const done = await js(`(async function(){ var r=await fetch('/__slg/strategy/state',{cache:'no-store'}); var s=await r.json();
        return { pending:(s.pendingBattles||[]).length, digest:(s.digest||[]).length }; })()`);
      report.afterBattle = done;
      rec('war.settled', done.pending === 0, '确认后战报结算，遭遇待决清空', done);
    }
    await shot('04-final');

    /* ---------- 7. 日志排错 ---------- */
    const errs = await js(`(function(){ return (window.__slgErrors||[]).slice(); })()`);
    report.pageErrors = errs || [];
    try {
      const status = server && server.status ? server.status() : null;
      if (status && Array.isArray(status.logs)) {
        report.serverErrors = status.logs.filter((l) => l.level === 'error').map((l) => l.message);
      }
    } catch (e) { report.serverErrors.push('status 读取失败: ' + e.message); }
    /* 未捕获异常里只保留真错误；Cocos 侧的历史竞态若已被引擎吞掉不计入 */
    report.consoleErrors = consoleErrors;
    report.domLog = await js(`(function(){ return (window.__slgDomLog||[]).slice(-40); })()`);
    report.toasts = await js(`(function(){ return (window.__slgToasts||[]).slice(-20); })()`);
    report.fetchLog = await js(`(function(){ return (window.__slgFetchLog||[]).slice(-14); })()`);
    report.clicks = await js(`(function(){ return (window.__slgClicks||[]).slice(-24); })()`);
    rec('runtime.noPageError', report.pageErrors.length === 0, '页面无未捕获异常', { count: report.pageErrors.length });
    rec('runtime.noServerError', report.serverErrors.length === 0, '服务端日志无 error', { count: report.serverErrors.length });
  } catch (err) {
    report.fatal = String((err && err.stack) || err);
    rec('fatal', false, report.fatal);
  }

  report.failed = report.steps.filter((s) => !s.ok).map((s) => s.id);
  report.passed = !report.fatal && report.failed.length === 0 && report.pageErrors.length === 0;
  report.counts = { steps: report.steps.length, ok: report.steps.length - report.failed.length, failed: report.failed.length };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, `mouse-playtest-${tag}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log('[slg-offline:mouse]', JSON.stringify({
    passed: report.passed, counts: report.counts, failed: report.failed,
    pageErrors: report.pageErrors.length, serverErrors: report.serverErrors.length,
    fatal: report.fatal,
  }, null, 2));
  if (process.env.SLG_SMOKE_EXIT === '1') setTimeout(() => app.exit(report.passed ? 0 : 1), 500);
  return report;
}

module.exports = { runMousePlaytest };
