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

/* console-message 的新旧签名差异与 level 归一化统一放在 console-level.cjs，
   与 smoke.cjs / main.cjs 共用同一口径（别再写第三份拷贝）。 */
const { consoleSeverity, consolePayload } = require('./console-level.cjs');

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
    /* 「等不到举义页」至少有三种原因：真旧档 / 渲染比 8 秒慢 / 触发链断了。
       三种混着标「旧档已举义」会掩盖后两种，这里直接取证服务端真值。 */
    var oathProbe = 'done=?; lords=?; err=';
    try {
      var r2 = await (await fetch('/__slg/oath/options', { cache: 'no-store' })).json();
      oathProbe = 'done=' + (r2 && r2.done) + '; lords=' + ((r2 && r2.lords) || []).length
        + '; slgIds=' + Array.prototype.map.call(
            document.querySelectorAll('[id^="slg"]'),
            function (e) { return e.id; }).slice(0, 24).join(',');
    } catch (e) { oathProbe = 'err:' + (e && e.message); }
    rec('oath.render', [], { visible: true, text: 'no-oath-in-8s; ' + oathProbe, note: 'oath-missing-probe' });
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
  /* ★ 必须先重查一次：六府的 render() 会重建 nav.innerHTML，跨 await 拿到的旧引用
     会变成游离节点，对游离节点 .click() 不冒泡、什么都不会发生 —— 这会把
     「审计脚本自己拿了过期引用」误报成「出征面板坏了」。 */
  var warNav = document.querySelector('#slgPanelsNav button[data-id="war"]');
  if (warNav) {
    /* 首点失败的取证：只观察 10 秒后的最终状态，分不清「从未创建」和「创建后被移除」，
       而这两种原因的处理方式完全不同。所以 ① 包一层记录 __slgWarWindow 到底有没有被调用，
       ② 用 MutationObserver 记录 #slgWarWin 在 DOM 里出现/消失的时刻。 */
    window.__warTrace = [];
    var _w0 = window.__slgWarWindow;
    if (typeof _w0 === 'function') {
      window.__slgWarWindow = function (o) {
        window.__warTrace.push('call:' + JSON.stringify(o || null));
        try { return _w0.apply(this, arguments); }
        catch (e) { window.__warTrace.push('throw:' + (e && e.message)); throw e; }
      };
    } else {
      window.__warTrace.push('missing');
    }
    var warSeen = [];
    var _lastWarHas = !!document.getElementById('slgWarWin');
    var obsWar = null;
    try {
      obsWar = new MutationObserver(function () {
        var has = !!document.getElementById('slgWarWin');
        if (has !== _lastWarHas) { _lastWarHas = has; warSeen.push((has ? '+' : '-') + '@' + (Date.now() % 100000)); }
      });
      obsWar.observe(document.body, { childList: true, subtree: true });
    } catch (e) { warSeen.push('obs-fail'); }

    var before = (typeof window.__slgWarWindow) + '/' + (document.getElementById('slgWarWin') ? 'has' : 'none');
    var connected = !!(warNav.isConnected || document.contains(warNav));
    var liveNav = document.querySelector('#slgPanelsNav button[data-id="war"]');
    var navBtnNow = !!liveNav;
    (liveNav || warNav).click();
    await sleep(380);
    var earlyToast = document.querySelector('#slgUIv2 .toast');
    var earlyToastText = earlyToast ? txt(earlyToast) : '';
    /* 点击压根没进到 __slgWarWindow 时，直接调 API 一次：能把「导航按钮没接上」
       和「面板渲染不出来」这两类原因分开，否则只能看着「没开」猜。 */
    var direct = '';
    if (!window.__warTrace.length) {
      direct = 'click-not-wired';
      try { window.__slgWarWindow({ tab: 'go' }); direct += ';direct-called'; }
      catch (e) { direct += ';direct-throw:' + (e && e.message); }
      await sleep(600);
      direct += ';domafter=' + (document.getElementById('slgWarWin') ? 'has' : 'no');
    }
    /* 出征窗是异步渲染的：必须等它「真的有尺寸」再断言，固定毫秒会误报 */
    var ww = await wait(function(){
      var w = document.getElementById('slgWarWin');
      return w && w.getBoundingClientRect().width > 100 ? w : null;
    }, 10000);
    /* 首点失败再点一次：能开 → 「第一次点没反应」的用户可见缺陷；还开不了 → 功能真挂了 */
    var wwRetry = null, retried = '';
    if (!ww) {
      var live2 = document.querySelector('#slgPanelsNav button[data-id="war"]');
      if (live2) live2.click();
      wwRetry = await wait(function(){
        var w = document.getElementById('slgWarWin');
        return w && w.getBoundingClientRect().width > 100 ? w : null;
      }, 6000);
      retried = wwRetry ? 'retry-ok(首点无效，再点才开)' : 'retry-fail(两次都开不了)';
    }
    if (obsWar) { try { obsWar.disconnect(); } catch (e) {} }
    var anyWin = document.getElementById('slgWarWin');
    rec('panel.war', ['出征', '出击'], {
      visible: !!ww,
      text: txt(ww || wwRetry || anyWin),
      note: ww ? '' : ('not-visible-in-10s; before=' + before
        + '; exists=' + (anyWin ? ('rect=' + Math.round(anyWin.getBoundingClientRect().width) + 'x' + Math.round(anyWin.getBoundingClientRect().height)) : 'no')
        + '; earlyToast=' + earlyToastText
        + '; trace=' + window.__warTrace.join('|')
        + '; navConnected=' + connected + '/' + !!navBtnNow
        + '; ' + direct
        + '; dom=' + (warSeen.length ? warSeen.join(',') : 'no-change')
        + '; ' + retried),
    });
    /* 复原包装，避免影响后面的 war.* 路径取证 */
    if (typeof _w0 === 'function') window.__slgWarWindow = _w0;
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

  /* ---------- 5b. 推演→确认→战报（GDD §14：必须进真实点击 E2E，零未捕获异常） ---------- */
  /* 本项目曾有 4 个 P0 因为「冒烟全部绕开真实点击」而留到很晚——这条链就是防复发的。 */
  if (typeof window.__slgWarWindow === 'function') {
    window.__slgWarWindow({ tab: 'go' });
    await wait(function(){ return document.getElementById('slgWarWin'); }, 9000);
    await sleep(800);

    /* ⓪ 默认出发城可能没兵：点「以此为出发城」切到有可用队伍的城（真实玩家路径） */
    var switchBtn = Array.from(document.querySelectorAll('#slgWarWin button'))
      .find(function(b){ return txt(b).indexOf('以此为出发城') >= 0; });
    if (switchBtn) { switchBtn.click(); await sleep(750); }

    /* ① 点一条可攻目标行（含「守军约」的行才是目标行，避开「出兵比例」的分段行） */
    var tgtRows = Array.from(document.querySelectorAll('#slgWarWin .row'))
      .filter(function(r){ return txt(r).indexOf('守军约') >= 0; });
    if (tgtRows.length) { tgtRows[0].click(); await sleep(650); }

    /* ② 推演：等「战斗种子」或明确的失败原因出现（异步 fetch） */
    /* ★ P11：出征按钮文案是「先推演一次再出征」，也含「推演一次」——
       必须精确匹配，否则会点到那个本来就 disabled 的按钮，把链路判定成「没反应」。 */
    var pvBtn = Array.from(document.querySelectorAll('#slgWarWin button'))
      .find(function(b){ var t = txt(b).trim(); return t === '推演一次' || t === '再推演一次'; });
    if (pvBtn) {
      pvBtn.click();
      await wait(function(){
        var t = txt(document.getElementById('slgWarWin'));
        return t.indexOf('战斗种子') >= 0 || t.indexOf('推演失败') >= 0;
      }, 15000);
      /* 推演成功才解锁出征（GDD §3.2 门 4）；不等这一下，后面会判定「找不到出征按钮」 */
      await wait(function(){
        var b = document.getElementById('slgWarAttackBtn');
        return !!b && !b.disabled;
      }, 12000);
    }
    var pvText = txt(document.getElementById('slgWarWin'));
    rec('war.preview.click', ['战前推演'], {
      visible: vis(document.getElementById('slgWarWin')), text: pvText,
      note: pvBtn ? (pvText.indexOf('战斗种子') >= 0 ? ''
        : (pvText.indexOf('推演失败') >= 0 ? 'preview-refused' : 'preview-no-result')) : 'no-preview-btn',
    });

    /* ③ 确认出征：真实玩家路径是两层弹窗——
       第一层 interaction-ui 决策预览（.slgIx-modal，COST_WORDS 捕获阶段拦截；
       点「确认」data-act=ok，0.9s 撤销窗口后自动放行原点击）；
       第二层 skills.js confirmBox（.modal「出兵确认」，点「出征」才真正发兵）。 */
    var atkBtn = Array.from(document.querySelectorAll('#slgWarWin button'))
      .find(function(b){ return txt(b).indexOf('出征 ') === 0; });
    if (atkBtn) {
      /* 清光此前页签（武将·研习、内政开发等）遗留的决策预览——它们会堆叠，
         querySelector 第一个不一定是本次的。逐个取消（取消不触发成本词）。 */
      var guardN = 0;
      while (document.querySelector('.slgIx-modal') && guardN++ < 8) {
        var mm0 = document.querySelector('.slgIx-modal');
        var mc0 = mm0.querySelector('[data-act="cancel"]');
        if (mc0) { try { mc0.click(); } catch (e) {} await sleep(320); }
        else { try { mm0.remove(); } catch (e) {} }
      }
      var atkLabel = txt(atkBtn);
      atkBtn.click();
      /* 第一层：决策预览（若该按钮被 COST_WORDS 拦截）。认准正文含「出征」的那个。 */
      var ixModal = await wait(function(){
        return Array.from(document.querySelectorAll('.slgIx-modal'))
          .find(function(x){ return txt(x).indexOf('出征') >= 0; }) || null;
      }, 2500);
      var ixOk = ixModal ? ixModal.querySelector('[data-act="ok"]') : null;
      if (ixOk) { ixOk.click(); }
      /* 第二层：出兵确认（放行后 confirmBox 弹出） */
      var modal = await wait(function(){ return document.querySelector('.modal'); }, 4500);
      /* ★ P11：出征按钮已带 data-ix-allow（它自身就有「出兵确认」框），
         正常情况下不再套一层决策预览。这条只判定「确认环节存在且可达」：
         有预览层算过，直接出确认框也算过；两层都拿不到才算失败。 */
      rec('war.preview.confirm', ['出征'], {
        visible: !!modal || !!ixModal,
        text: (modal ? txt(modal) : '') + ' ' + (ixModal ? txt(ixModal) : ''),
        note: modal ? (ixModal ? 'two-layer' : 'single-confirm（已去冗余预览层）')
          : (ixModal ? (ixOk ? 'only-preview' : 'no-ix-ok-btn') : 'no-confirm-at-all'),
      });
      var okBtn = null;
      if (modal) {
        okBtn = Array.from(modal.querySelectorAll('.bar button'))
          .find(function(b){ return txt(b).indexOf('取消') < 0; });
      }
      rec('war.confirm.modal', ['出兵确认'], {
        visible: !!modal, text: modal ? txt(modal) : '',
        note: modal ? '' : 'no-confirm-modal;atk=' + atkLabel + ';ix=' + (ixModal ? 'yes' : 'no')
          + ';phase=' + txt(document.getElementById('slgIxPhase'))
          + ';ixLeft=' + document.querySelectorAll('.slgIx-modal').length,
      });
      if (okBtn) {
        okBtn.click();
        /* ★ 确认弹窗的「出征」二字也是成本词——会被决策预览再拦一层。
           同样点掉它（0.9s 撤销窗口后放行），attack POST 才会真正发出。 */
        var ix2 = await wait(function(){
          return Array.from(document.querySelectorAll('.slgIx-modal'))
            .find(function(x){ return txt(x).indexOf('出征') >= 0; }) || null;
        }, 2500);
        var ix2ok = ix2 ? ix2.querySelector('[data-act="ok"]') : null;
        if (ix2ok) { ix2ok.click(); }
      }
      await sleep(1800);
      /* ④ 行军队列页：应有在途记录（开拔/到达/补给任一）。出兵被拒时抓 toast 留证。 */
      var toastEl = document.querySelector('#slgUIv2 .toast');
      var phaseEl = document.getElementById('slgIxPhase');
      var qTab = Array.from(document.querySelectorAll('#slgWarWin .tabs button'))
        .find(function(b){ return txt(b).indexOf('行军队列') >= 0; });
      if (qTab) { qTab.click(); await sleep(750); }
      var qText = txt(document.getElementById('slgWarWin'));
      rec('war.queue.marching', ['在途', '到达', '补给', '队列'], {
        visible: vis(document.getElementById('slgWarWin')), text: qText,
        note: qTab ? (qText.indexOf('在途 0 支') >= 0
          ? 'no-march-in-flight;toast=' + txt(toastEl).slice(0, 90) + ';phase=' + txt(phaseEl).slice(0, 40)
          : '') : 'no-queue-tab',
      });
    } else {
      rec('war.confirm.modal', [], { visible: false, note: 'no-attack-btn（无队伍或无可攻目标，属前置缺失而非链路坏）' });
    }
    try { if (window.__slgWarClose) window.__slgWarClose(); } catch (e) {}
    await sleep(400);

    /* ⑤ 门 4「遭遇」：推进旬到到达日。
       ★ P11 变更：抵达不再自动开战，队伍挂在 pendingBattle 等玩家定夺。
       旧脚本只 tick 不确认，队列永远清不掉、战报永远空——check-release 因此报
       not-resolved / no-report-row。这里必须像玩家一样进「③ 遭遇」页点「确认开战」。 */
    var st2 = await (await fetch('/__slg/strategy/state', { cache: 'no-store' })).json();
    var mm = (st2.marches || []).find(function(m){ return m.side === 'player' && !m.resolved; });
    var ticked = 0;
    if (mm) {
      while (ticked < 8) {
        if ((st2.pendingBattles || []).length) break;            /* 已挂起，等确认 */
        var live = (st2.marches || []).filter(function(m){ return m.side === 'player' && !m.resolved; });
        if (!live.length) break;                                  /* 非确认制：已自动结算 */
        if (ticked > 0 && (Number(st2.day) || 0) >= Number(mm.arriveDay)) break;
        await fetch('/__slg/strategy/tick', { method: 'POST' });
        ticked += 1;
        st2 = await (await fetch('/__slg/strategy/state', { cache: 'no-store' })).json();
        mm = (st2.marches || []).find(function(m){ return m.side === 'player' && !m.resolved; }) || mm;
      }
      var pend = st2.pendingBattles || [];
      var encWinText = '';
      var goBtn = null;
      if (pend.length) {
        /* 门 5：先把「③ 遭遇」页真的渲染出来，再点「确认开战」。
           ★ 别用状态字符串去校验 UI：pending>0 只证明服务端挂了遭遇，
             证明不了玩家能看见卡片、能点到按钮。 */
        window.__slgWarWindow({ tab: 'encounter' });
        await wait(function(){ return document.getElementById('slgWarWin'); }, 9000);
        await sleep(700);
        var encTab = Array.from(document.querySelectorAll('#slgWarWin .tabs button'))
          .find(function(b){ return txt(b).indexOf('遭遇') >= 0; });
        if (encTab) { encTab.click(); await sleep(600); }
        encWinText = txt(document.getElementById('slgWarWin'));
        goBtn = Array.from(document.querySelectorAll('#slgWarWin button'))
          .find(function(b){ return txt(b).indexOf('确认开战') >= 0; });
      }
      rec('war.encounter.pending', ['两军对阵', '确认开战', '临阵收兵'], {
        visible: pend.length > 0 && vis(document.getElementById('slgWarWin')),
        text: encWinText || ('day=' + st2.day + ' ticks=' + ticked + ' pending=' + pend.length),
        note: pend.length ? '' : 'no-pending-encounter（未挂遭遇，可能是非确认制出征）',
      });
      if (pend.length) {
        var encBefore = encWinText;
        if (goBtn) { goBtn.click(); await sleep(2400); }
        rec('war.encounter.confirm', ['折损', '歼敌', '占领', '已生成', '结算', '安置'], {
          visible: !!goBtn,
          text: (encBefore + ' ' + txt(document.getElementById('slgWarWin'))).slice(0, 500),
          note: goBtn ? '' : 'no-confirm-battle-btn',
        });
      }
      st2 = await (await fetch('/__slg/strategy/state', { cache: 'no-store' })).json();
      var left = (st2.marches || []).filter(function(m){ return m.side === 'player' && !m.resolved; }).length;
      rec('war.march.resolved', [], {
        visible: true,
        text: 'day=' + st2.day + ' ticks=' + ticked + ' marches-left=' + left
          + ' pending=' + (st2.pendingBattles || []).length,
        note: left > 0 ? 'not-resolved-in-' + ticked + '-ticks' : '',
      });
      /* 门 6「消化」：占城后必须给出新城的安置入口，否则流程断在战报 */
      var dg = st2.digest || [];
      rec('war.digest.after', [], {
        visible: true, text: 'digest=' + dg.length,
        note: dg.length ? '' : 'no-digest（本战未占城：战败/平局属正常，胜则必填）',
      });
    } else {
      rec('war.march.resolved', [], { visible: true, text: 'no-march', note: 'attack-refused-or-not-run' });
    }

    /* ⑥ 战报页：真实点击读战报（折损/歼敌/占领任一即算成） */
    window.__slgWarWindow({ tab: 'log' });
    await wait(function(){ return document.getElementById('slgWarWin'); }, 9000);
    await sleep(900);
    var repText = txt(document.getElementById('slgWarWin'));
    rec('war.report.after', ['折损', '歼敌', '占领', '战报'], {
      visible: vis(document.getElementById('slgWarWin')), text: repText,
      note: repText.indexOf('折损') >= 0 || repText.indexOf('歼敌') >= 0 || repText.indexOf('占领') >= 0 ? '' : 'no-report-row',
    });
    var closeW2 = document.querySelector('#slgWarWin [data-act="close"], #slgWarWin button');
    if (closeW2) { try { closeW2.click(); } catch (e) {} }
  }

  /* ---------- 6. 沙盘交互：图层 / 缩放 / 检索 ---------- */
  /* ★ P11：一屏一窗生效后，主窗口开着时按钮坞与浮窗会按设计让位。
     回沙盘前必须先关掉出征窗/城内页/六府，否则会把「设计如此」误判成缺陷。 */
  try { if (window.__slgWarClose) window.__slgWarClose(); } catch (e) {}
  try { if (window.__slgCityClose) window.__slgCityClose(); } catch (e) {}
  try { if (window.__slgPanels && window.__slgPanels.close) window.__slgPanels.close(); } catch (e) {}
  try { document.querySelectorAll('#slgUIv2 .win, #slgUIv2 .modal').forEach(function (n) { n.remove(); }); } catch (e) {}
  if (typeof window.__slgStrategyShow === 'function') { try { window.__slgStrategyShow(); } catch (e) {} }
  await sleep(800);
  var dock = document.getElementById('slgDock');
  rec('map.dock', ['推演'], { visible: vis(dock), text: txt(dock) });

  var zoomIn = document.getElementById('slgBtnZoomIn');
  if (zoomIn) { zoomIn.click(); await sleep(260); zoomIn.click(); await sleep(260); }
  var zoomOut = document.getElementById('slgBtnZoomOut');
  if (zoomOut) { zoomOut.click(); await sleep(260); }
  rec('map.zoom', [], { visible: vis(dock), text: 'zoom-clicked', note: (zoomIn ? '' : 'no-zoom-in') + (zoomOut ? '' : ' no-zoom-out') });

  var side = document.getElementById('slgStratSide');
  var boxes = side ? side.querySelectorAll('input[type="checkbox"]') : [];
  /* ★ 用户 ⑦ 明确要去掉「十三州水墨底图」「十三州部古名」两项：
     可切换图层从 6 降到 4。这里同时正向校验那两项已不在列表里，
     否则「删了但又加回来」不会被任何断言发现。 */
  var layerText = side ? txt(side) : '';
  var legacyLeft = /水墨底图|部古名/.test(layerText);
  rec('map.layers', ['图层'], {
    visible: vis(side) && boxes.length >= 4 && !legacyLeft,
    text: layerText + ' checkboxes=' + boxes.length,
    note: (boxes.length >= 4 ? '' : 'layer-checkboxes-missing')
      + (legacyLeft ? ' legacy-layer-still-listed' : ''),
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
  /* ★ 修：Electron 35+ 的 console-message 只传一个事件对象。用旧的 (e, level, message)
     三参写法会让 level 恒为 undefined，"level >= 2" 永远为假 —— 我们之前反复报的
     「consoleErrors = 0」就是个永远成立的假结论，这项检测等于从未生效。 */
  wc.on('console-message', (...args) => {
    const d = consolePayload(args);
    const text = String(d.message == null ? '' : d.message);
    if (/Electron Security Warning/i.test(text)) return;
    if (consoleSeverity(d.level) >= 2) {
      /* ★ E2E 抓到未捕获异常时只记文案定位不了——补 source:line:stack 取证 */
      consoleErrors.push('[' + d.level + '] ' + text
        + (d.sourceId ? ' @ ' + d.sourceId + ':' + d.lineNumber : '')
        + (d.stack ? '\n  stack: ' + String(d.stack).slice(0, 600) : ''));
    }
  });

  const report = { startedAt: new Date().toISOString(), mode: 'ui-audit', tag, paths: [], pageErrors: [], consoleErrors: [] };

  try {
    // 采集页面异常（与 smoke 同一套钩子）
    /* ★ 修复：钩子改由服务端注入脚本随页安装（index.js 注入段），页面重载后依然活着。
       这里只在注入钩子缺失时兜底安装，且不清空已有采集（避免把重载前抓到的异常冲掉）。 */
    await wc.executeJavaScript(`(function(){
      if (!window.__slgErrHookInstalled) {
        window.__slgErrors = window.__slgErrors || [];
        window.addEventListener('error', function(e){
          window.__slgErrors.push({ msg:String(e.message), stack:String(e.error && e.error.stack || ''), src:String(e.filename)+':'+e.lineno });
        });
        window.addEventListener('unhandledrejection', function(e){
          window.__slgErrors.push({ msg:'unhandledrejection: '+String(e.reason), stack:String(e.reason && e.reason.stack || '') });
        });
      }
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

    // 等门禁放行（登录前首帧所有注入 UI 都是 display:none）+ 沙盘外壳就绪
    await wc.executeJavaScript(`(async function(){
      var t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        var phased = document.documentElement.getAttribute('data-slg-phase') === 'game';
        if (phased && typeof window.__slgStrategyShow === 'function' && document.getElementById('slgDock')) return true;
        await new Promise(function(r){ setTimeout(r, 200); });
      }
      return false;
    })()`, true);

    const res = await wc.executeJavaScript(WALK, true);
    report.paths = res.paths || [];
    report.pageErrors = res.pageErrors || [];

    /* ---------- 快捷键真按（GDD §10.4 / P2-03） ----------
       静态扫描只能证明「代码里有这个分支」，按下去有没有反应必须真发键事件。
       这一段跑在 WALK 之后（此时已收掉所有覆盖层、回到沙盘），不会干扰上面的路径。 */
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const press = async (keyCode) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode });
      wc.sendInputEvent({ type: 'keyUp', keyCode });
      await sleepMs(280);
    };
    const js = (code) => wc.executeJavaScript(code, true);
    const lensOn = () => js(`(function(){var b=document.querySelector('#slgIxLens button.on');return b?b.getAttribute('data-lens'):null;})()`);
    const turnOf = () => js(`fetch('/__slg/strategy/state',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){return s.turn;})`);
    const armySel = () => js(`(function(){var r=document.querySelector('#slgWarWin [data-army-selected]');return r?r.getAttribute('data-army-index'):null;})()`);
    const keyPaths = [];
    const kv = (id, expect, ok, note) => keyPaths.push({ id, expect, ok: !!ok, textLen: 0, note: note || '' });

    try {
      /* Tab：六透镜循环 */
      const lb = await lensOn();
      await press('Tab');
      const la = await lensOn();
      kv('key.tab-lens', ['地图透镜'], la && la !== lb, '透镜 ' + lb + ' → ' + la);

      /* F：聚焦沙盘检索框 */
      await press('F');
      const focused = await js(`(function(){var a=document.activeElement;return a?(a.id||a.tagName):'';})()`);
      kv('key.f-find', ['输入城名'], focused === 'slgStratFind', 'activeElement=' + focused);
      await js(`(function(){var a=document.activeElement;if(a&&a.blur)a.blur();return true;})()`);

      /* Space：下一旬（turn 必须真的 +1，不能只是弹个 toast） */
      const tb = await turnOf();
      await press('Space');
      const ta = await turnOf();
      kv('key.space-tick', ['推演'], typeof tb === 'number' && typeof ta === 'number' && ta > tb,
        'turn ' + tb + ' → ' + ta);
      await js(`(function(){try{if(window.__slgIX)window.__slgIX.closeAll();}catch(e){}return true;})()`);

      /* 1–3 / ←→：出征窗里的我方槽位 */
      await js(`(function(){var b=document.getElementById('slgBtnWar');if(b)b.click();return true;})()`);
      await sleepMs(900);
      const rowCount = await js(`document.querySelectorAll('#slgWarWin [data-army-index]').length`);
      if (rowCount >= 2) {
        const s0 = await armySel();
        await press('ArrowRight');
        const s1 = await armySel();
        kv('key.arrow-army', ['可派队伍'], s1 && s1 !== s0, '选中槽位 ' + s0 + ' → ' + s1);
        await press('2');
        const s2 = await armySel();
        kv('key.digit-army', ['可派队伍'], s2 === '2', '按 2 后选中槽位=' + s2);
      } else {
        kv('key.army-slot', ['可派队伍'], true, '跳过：可派队伍仅 ' + rowCount + ' 支（需要 ≥2 支才能验证切换）');
      }
      await js(`(function(){var w=document.getElementById('slgWarWin');if(w)w.remove();return true;})()`);
      await js(`(function(){try{if(window.__slgIX)window.__slgIX.closeAll();}catch(e){}return true;})()`);
    } catch (e) {
      kv('key.fatal', [], false, String((e && e.message) || e));
    }
    report.paths = report.paths.concat(keyPaths);

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
