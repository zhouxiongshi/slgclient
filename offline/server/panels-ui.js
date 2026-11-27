/* 六大面板 UI —— 浏览器端独立脚本，由 /__slg/panels/ui.js 下发。
 * 只在运行时注入到 index.html 的响应里，磁盘 web/ 与打包产物逐字节不变。
 * 与 server/skills.js 的覆盖层完全解耦：不引用、不修改它的任何全局变量。
 */
;(function () {
  'use strict';
  if (window.__slgPanels) return;

  var API = '/__slg/panels';
  /* 后端根路径。编队/运输/赏赐等走 /__slg/strategy/action，
     绝不能拿 API 去拼（会得到 /__slg/panels/strategy/action → 404）。 */
  var API_ROOT = API.replace(/\/panels$/, '');   // '/__slg'
  var data = null;
  var ui = {
    tab: 'general', genId: 0, genTab: 'skill',
    itemFilter: 'all', skillFilter: 'all', skillQuery: '', openSkill: 0, skillLimit: 24,
    selectedCity: 0, dockOpen: false, // 默认折叠：战略层已有左上按钮坞，六府只留右上角一枚小按钮，不割裂分层地图
    genPick: [], dispatchTo: 0,       // ★ P51：批量调防的勾选与目标城
  };
  /* ★ 验收 #18：六府面板的选中对象与未完成输入（页签/选中武将/搜索词/筛选/选中城）
     跨切页、跨面板开关、跨刷新保持。白名单恢复——dockOpen 这类纯视觉开关不落盘。 */
  var UI_KEY = 'slg.panels.ui';
  var UI_KEEP = ['tab', 'genId', 'genTab', 'itemFilter', 'skillFilter', 'skillQuery', 'openSkill', 'selectedCity', 'skillLimit', 'genPick', 'dispatchTo'];
  (function restoreUI() {
    try {
      var v = JSON.parse(window.sessionStorage.getItem(UI_KEY) || 'null');
      if (!v) return;
      UI_KEEP.forEach(function (k) {
        if (v[k] != null && typeof v[k] === typeof ui[k]) ui[k] = v[k];
      });
      /* 属性页已并入人物卡；老存档里残留的 attr 归一到战法页，避免空白。 */
      if (ui.genTab === 'attr') ui.genTab = 'skill';
      if (!Array.isArray(ui.genPick)) ui.genPick = [];
      ui.genPick = ui.genPick.map(Number).filter(function (v) { return v > 0; });
    } catch (e) { /* 隐私模式静默降级 */ }
  })();
  function persistUI() {
    try {
      var o = {};
      UI_KEEP.forEach(function (k) { o[k] = ui[k]; });
      window.sessionStorage.setItem(UI_KEY, JSON.stringify(o));
    } catch (e) { /* 同上 */ }
  }

  var dock = null, mask = null, toastEl = null;
  /* ★ P51：武将页左右两栏各自的滚动位置，换人只重置详情，列表原地不动。 */
  var genScroll = { list: 0, detail: 0, gid: 0, tab: '' };
  /* 资源内部键→玩家可见名。岗位产出键、流水兜底都走这里，禁止把 grain/gold 直接弹出。 */
  var POST_RES_LABEL = {
    wood: '木', iron: '铁', stone: '石', grain: '粮',
    gold: '金', decree: '政令', jungong: '军工',
  };

  /* ---------------- 基础工具 ---------------- */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function n(v) { var x = Number(v); return Number.isFinite(x) ? x : 0; }
  function fmt(v) { return n(v).toLocaleString('zh-CN'); }
  function pct(a, b) { return b > 0 ? (n(a) / n(b) * 100).toFixed(1) + '%' : '—'; }
  /* 兵刃面板：把配置对象的键翻成中文，禁止把 JSON 报文直接甩给用户。 */
  var COST_LABELS = { gold: '金', grain: '粮', wood: '木', iron: '铁', stone: '石', jungong: '军工', labor: '人力' };
  function statBonusText(o) {
    var keys = o ? Object.keys(o) : [];
    if (!keys.length) return '无属性加成';
    return keys.map(function (k) {
      var label = (data && data.statLabels && data.statLabels[k]) || k;
      return label + ' +' + n(o[k]) + '%';
    }).join('、');
  }
  function costText(o) {
    var keys = o ? Object.keys(o) : [];
    if (!keys.length) return '无需材料';
    return keys.map(function (k) { return (COST_LABELS[k] || k) + ' ' + fmt(o[k]); }).join(' · ');
  }
  function toast(msg, bad) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.background = bad ? 'rgba(110,36,30,.96)' : 'rgba(22,32,20,.96)';
    toastEl.style.borderColor = bad ? '#d8846a' : '#ba9a52';
    toastEl.style.display = 'block';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.style.display = 'none'; }, 3200);
  }
  function fetchState(cb) {
    fetch(API + '/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        if (!v || !v.ok) throw new Error('面板数据不可用');
        data = v;
        if (!ui.genId && v.generals.length) ui.genId = v.generals[0].id;
        if (!ui.selectedCity && v.strategy.cities.length) ui.selectedCity = v.strategy.cities[0].id;
        render(); if (cb) cb();
        /* ★ P4-①：新档未举义 → 全屏举义页（旧档 done=true 永不弹） */
        if (v.oath && v.oath.done === false) showOath();
      })
      .catch(function (e) { toast('读取面板数据失败：' + e.message, true); });
  }
  function post(action, cb) {
    fetch(API + '/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    }).then(function (r) { return r.json(); }).then(function (r) {
      toast(r.message || (r.ok ? '完成' : '失败'), !r.ok);
      if (r.view) { data = r.view; render(); }
      else if (r.ok) fetchState();
      if (cb) cb(r);
    }).catch(function (e) { toast('操作失败：' + e.message, true); });
  }
  function currentGeneral() {
    return (data.generals || []).find(function (g) { return g.id === ui.genId; })
      || data.generals[0] || null;
  }
  function confirmBox(text, onYes) {
    /* ★ 2026-11-19：Electron 不支持 window.confirm/prompt，一律用页面内弹窗。 */
    var mask2 = document.createElement('div');
    mask2.style.cssText = 'position:fixed;inset:0;z-index:100820;background:rgba(0,0,0,.55);'
      + 'display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'width:420px;max-width:90vw;background:#20221c;border:1px solid #8a7038;'
      + 'border-radius:8px;padding:18px 20px;color:#e2d6b8;font:13px "Microsoft YaHei",sans-serif;';
    var p = document.createElement('div'); p.textContent = text; p.style.lineHeight = '1.9';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
    var mk = function (label, primary, fn) {
      var b = document.createElement('button'); b.textContent = label;
      b.style.cssText = 'background:' + (primary ? '#4a4225' : '#20221c') + ';color:#e8c670;'
        + 'border:1px solid ' + (primary ? '#ba9a52' : '#6a624a') + ';border-radius:4px;'
        + 'padding:5px 14px;cursor:pointer;font:12px "Microsoft YaHei",sans-serif;';
      b.onclick = function () { mask2.remove(); fn(); };
      return b;
    };
    bar.appendChild(mk('取消', false, function () {}));
    bar.appendChild(mk('确定', true, onYes));
    box.appendChild(p); box.appendChild(bar); mask2.appendChild(box); document.body.appendChild(mask2);
  }
  /* ★ P63：战法研习对话框（游戏化，参考三国志「委任研究」）。
     只展示玩家需要决策的三件事：这条战法是什么、研到哪了、派谁研。
     不再套通用「决策前预览」的「会发生什么 / 风险与失败态 / 数值依据」——
     对一个纯正向的投卷涨进度操作，那三栏是开发者视角的噪音。 */
  function researchBox(cfgId) {
    var s = (data.library || []).find(function (x) { return Number(x.cfgId) === Number(cfgId); });
    if (!s) return;
    var assign = (data.researchAssignments || []).find(function (x) { return Number(x.cfgId) === Number(cfgId); });
    var cands = data.researchCandidates || [];
    var mask2 = document.createElement('div');
    mask2.className = 'slgResearchMask';
    mask2.style.cssText = 'position:fixed;inset:0;z-index:100820;background:rgba(0,0,0,.62);'
      + 'display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.className = 'slgResearchBox';
    box.style.cssText = 'width:620px;max-width:94vw;max-height:88vh;overflow:auto;'
      + 'background:linear-gradient(180deg,#26261c,#1b1d17);border:1px solid #a98a48;'
      + 'border-radius:10px;padding:20px 22px;color:#ecdfbd;font:13px "Microsoft YaHei",sans-serif;'
      + 'box-shadow:0 18px 48px rgba(0,0,0,.6);';
    /* ★ P66：研习完成后不阻塞——已解锁给装配引导，未解锁给换条战法入口，卷尽给自行推敲说明。 */
    var unlocked = s.status === 'unlocked';
    var noScroll = (data.scrolls || 0) <= 0;
    var others = (data.library || []).filter(function (x) {
      return x.status !== 'unlocked' && Number(x.cfgId) !== Number(cfgId);
    });
    var pct = unlocked ? 100 : (s.research ? Math.min(100, Math.round(s.research.progress / s.research.need * 100)) : 0);
    var headH = '<div style="display:flex;align-items:baseline;gap:10px;border-bottom:1px solid #4a4229;'
      + 'padding-bottom:10px;margin-bottom:14px"><b style="font-size:18px;color:#f2d98a">战法研习</b>'
      + '<span style="font-size:11px;color:#9c9176">委派武将逐旬自动推进；残卷用尽也能自行推敲，进度不会停</span>'
      + '<span style="margin-left:auto;font-size:12px;color:#c9b98a">兵书残卷 ' + esc(data.scrolls || 0) + ' 卷</span></div>';
    var infoH = '<div style="display:flex;gap:16px">'
      + '<div style="flex:1.15">'
      + '<div style="margin-bottom:6px"><b style="font-size:16px">' + esc(s.name) + '</b> '
      + '<span class="tag">' + esc(s.trigger || '战法') + '</span></div>'
      + '<div style="color:#c9bfa2;line-height:1.75;min-height:56px">' + esc(s.des || '暂无效果说明') + '</div>'
      + '<div style="margin:10px 0 4px;font-size:12px;color:#a89c7f">'
      + (unlocked ? '已研习完成 · 可直接装配' : '研习进度 ' + (s.research ? esc(s.research.progress) : '0') + ' / ' + (s.research ? esc(s.research.need) : '100'))
      + ' · ' + pct + '%</div>'
      + '<div style="height:10px;background:#12150f;border:1px solid #4a4229;border-radius:5px;overflow:hidden">'
      + '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#8a6d2e,#d8b45c)"></div></div>'
      + '</div><div style="flex:1;border-left:1px solid #4a4229;padding-left:16px">'
      + '<div style="font-size:12px;color:#c9b98a;margin-bottom:8px">委派武将 · 谋略决定速度，政治决定省卷</div>';
    if (unlocked) {
      /* ★ P66：研习完成后的明确出路——不让玩家盯着灰色按钮发呆。 */
      infoH += '<div style="background:#26361f;border:1px solid #4e7a3e;border-radius:6px;padding:10px;margin-bottom:10px;line-height:1.8">'
        + '<div style="color:#bfe0a3;font-weight:600">此战法已研习完成</div>'
        + '<div style="font-size:12px;color:#b9c9a0">到「武将」页选一名武将，在战法槽点「装配」即可使用；'
        + '也可在下方「换一条研习」继续解锁其它战法。</div>'
        + '<button data-ract="gotoGeneral" style="margin-top:8px;background:#2f3a28;color:#cfe6b4;border:1px solid #6a8a52;'
        + 'border-radius:4px;padding:4px 12px;cursor:pointer;font:12px \'Microsoft YaHei\'">去武将页装配 →</button></div>';
    } else {
      if (assign) {
        var eta = Math.max(1, Math.ceil((assign.need - assign.progress) / assign.points));
        infoH += '<div style="background:#2f2c1c;border:1px solid #7a6535;border-radius:6px;padding:10px;margin-bottom:10px">'
          + '<div><b style="color:#f0d488">' + esc(assign.generalName) + '</b> 研习中</div>'
          + '<div style="font-size:12px;color:#b9ad8c;margin-top:4px">每旬约 +' + esc(assign.points)
          + ' 点 · 耗 ' + esc(assign.scrolls) + ' 卷 · 进度 ' + esc(assign.progress) + '/' + esc(assign.need)
          + ' · 约 ' + eta + ' 旬可成</div>'
          + '<button data-ract="unassign" style="margin-top:8px;background:#20221c;color:#d9c58e;border:1px solid #6a624a;'
          + 'border-radius:4px;padding:4px 12px;cursor:pointer;font:12px \'Microsoft YaHei\'">撤回委派（进度保留）</button></div>';
      }
      if (noScroll) {
        infoH += '<div style="background:#2a2618;border:1px solid #6a5a32;border-radius:6px;padding:8px 10px;margin-bottom:10px;'
          + 'font-size:12px;color:#d8c79a;line-height:1.7">兵书残卷已用尽：委派的武将仍会自行推敲，每旬约 +'
          + esc(cands.length ? cands[0].points : 7) + ' 点（进度照常增长）。'
          + '残卷可通过打胜仗、守城、斩将获得。</div>';
      }
      if (cands.length) {
        infoH += '<div style="font-size:12px;color:#a89c7f;margin-bottom:4px">改派 / 新派一名武将（研习为文职，在编亦可）</div>'
          + '<select data-rsel="general" style="width:100%;box-sizing:border-box;background:#12150f;color:#f0e2b8;'
          + 'border:1px solid #6a624a;border-radius:4px;padding:6px;font:12px \'Microsoft YaHei\'">'
          + cands.map(function (g) {
            return '<option value="' + g.id + '">' + esc(g.name) + (g.inArmy ? '（在编）' : '')
              + ' · 谋' + g.strategy + ' 政' + g.politics
              + '（约 +' + g.points + '/旬，耗 ' + g.scrolls + ' 卷）</option>';
          }).join('') + '</select>'
          + '<button data-ract="assign" style="margin-top:8px;width:100%;background:#4a4225;color:#f0d488;'
          + 'border:1px solid #ba9a52;border-radius:4px;padding:6px;cursor:pointer;font:12px \'Microsoft YaHei\'">委派研习</button>';
      } else {
        infoH += '<div style="font-size:12px;color:#8f8676;line-height:1.7">没有可委派的武将。</div>';
      }
      /* ★ P66：换一条战法研习——列表可绝对没有一条能研习吗？有残卷或已委派就能继续。 */
      if (others.length) {
        infoH += '<div style="margin-top:10px;border-top:1px dashed #4a4229;padding-top:9px">'
          + '<div style="font-size:12px;color:#a89c7f;margin-bottom:4px">换一条战法研习（进度各自保留）</div>'
          + '<select data-rsel="switch" style="width:100%;box-sizing:border-box;background:#12150f;color:#f0e2b8;'
          + 'border:1px solid #6a624a;border-radius:4px;padding:6px;font:12px \'Microsoft YaHei\'">'
          + others.map(function (x) {
            return '<option value="' + x.cfgId + '">' + esc(x.name)
              + (x.status === 'researching' ? '（研习中 ' + (x.research ? x.research.progress : 0) + '/' + (x.research ? x.research.need : 100) + '）' : '（未研习）')
              + '</option>';
          }).join('') + '</select>'
          + '<button data-ract="switch" style="margin-top:6px;width:100%;background:#20221c;color:#d9c58e;'
          + 'border:1px solid #6a624a;border-radius:4px;padding:5px;cursor:pointer;font:12px \'Microsoft YaHei\'">切换去研习这条 →</button></div>';
      }
    }
    infoH += '</div></div>';
    var footH = '<div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #4a4229;'
      + 'padding-top:12px;margin-top:14px">'
      + '<button data-ract="close" style="background:#20221c;color:#c9b98a;border:1px solid #6a624a;'
      + 'border-radius:4px;padding:6px 16px;cursor:pointer;font:12px \'Microsoft YaHei\'">关闭</button>'
      + (unlocked ? '<span style="font-size:12px;color:#8f8676;align-self:center">已研习完成，无需再投卷</span>'
        : '<button data-ract="manual" style="background:#4a4225;color:#f0d488;border:1px solid #ba9a52;'
        + 'border-radius:4px;padding:6px 16px;cursor:pointer;font:12px \'Microsoft YaHei\'">'
        + ((data.scrolls || 0) > 0 ? '当场研习（耗残卷）' : '当场研习（无残卷，自行推敲）') + '</button>')
      + '</div>';
    box.innerHTML = headH + infoH + footH;
    mask2.appendChild(box); document.body.appendChild(mask2);
    function close() { mask2.remove(); }
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ract]'); if (!b) return;
      var ract = b.getAttribute('data-ract');
      if (ract === 'close') { close(); return; }
      if (ract === 'manual') {
        var selNow = box.querySelector('[data-rsel="general"]');
        var gidNow = selNow ? Number(selNow.value) : (assign ? assign.generalId : 0);
        post({ type: 'studyNow', cfgId: Number(cfgId), generalId: gidNow }, function () {
          close();
          researchBox(Number(cfgId));
        });
        return;
      }
      if (ract === 'assign') {
        var sel = box.querySelector('[data-rsel="general"]');
        var gid = sel ? Number(sel.value) : 0;
        if (!gid) { toast('先选一名武将', true); return; }
        close(); post({ type: 'assignResearch', cfgId: Number(cfgId), generalId: gid }, function () {
          researchBox(Number(cfgId));
        });
        return;
      }
      if (ract === 'unassign') {
        close(); post({ type: 'unassignResearch', cfgId: Number(cfgId) }, function () {
          researchBox(Number(cfgId));
        });
        return;
      }
      if (ract === 'gotoGeneral') {
        close();
        if (window.__slgPanels && typeof window.__slgPanels.open === 'function') {
          window.__slgPanels.open('general');
        }
        return;
      }
      if (ract === 'switch') {
        var sw = box.querySelector('[data-rsel="switch"]');
        var next = sw ? Number(sw.value) : 0;
        if (!next) { toast('先选一条战法', true); return; }
        close(); researchBox(next);
        return;
      }
    });
    mask2.addEventListener('click', function (e) { if (e.target === mask2) close(); });
  }
  /* 文本输入（替代 window.prompt） */
  function askText(text, defaultValue, onYes) {
    var mask2 = document.createElement('div');
    mask2.style.cssText = 'position:fixed;inset:0;z-index:100820;background:rgba(0,0,0,.55);'
      + 'display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'width:430px;max-width:90vw;background:#20221c;border:1px solid #8a7038;'
      + 'border-radius:8px;padding:18px 20px;color:#e2d6b8;font:13px "Microsoft YaHei",sans-serif;';
    var p = document.createElement('div'); p.textContent = text; p.style.lineHeight = '1.9';
    var input = document.createElement('input');
    input.type = 'number'; input.value = defaultValue || '500'; input.min = '1';
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#12150f;color:#f0e2b8;'
      + 'border:1px solid #6a624a;border-radius:4px;padding:8px 10px;'
      + 'font:14px "Microsoft YaHei",sans-serif;';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
    var mk = function (label, primary, fn) {
      var b = document.createElement('button'); b.textContent = label;
      b.style.cssText = 'background:' + (primary ? '#4a4225' : '#20221c') + ';color:#e8c670;'
        + 'border:1px solid ' + (primary ? '#ba9a52' : '#6a624a') + ';border-radius:4px;'
        + 'padding:5px 14px;cursor:pointer;font:12px "Microsoft YaHei",sans-serif;';
      b.onclick = function () { mask2.remove(); fn(); };
      return b;
    };
    bar.appendChild(mk('取消', false, function () {}));
    bar.appendChild(mk('确定', true, function () { onYes(String(input.value || '').trim()); }));
    box.appendChild(p); box.appendChild(input); box.appendChild(bar);
    mask2.appendChild(box); document.body.appendChild(mask2);
    try { input.focus(); } catch (e) { /* 忽略焦点权限 */ }
  }
  /* ★ P0/P1/P3 编队/运输/赏赐：走 /__slg/strategy/action。
     修 U01：旧写法 fetch(API + '/strategy/action') 会拼成
     /__slg/panels/strategy/action（服务端无此路由，404）。改用 API_ROOT。
     这条路径与 skills.js 的出征面板一致，必须用绝对根路径。 */
  /* ★ 2026-11-22：动作失败一律中文，reason 只是内部协议码，禁止拼进玩家提示。
     领域层已在失败返回体里带同源 text（如招降拒绝/越狱），这里再做一层兜底映射。 */
  var ACTION_REASON_TEXT = {
    no_army: '没有这支队伍', marching: '队伍行军中，不可整编',
    dup_general: '同一武将不能重复上阵', in_other_army: '该武将已在别的队伍',
    too_many_troops: '兵力分配超出该队现有兵力', not_own_city: '只能运输到己方城池',
    bad_amount: '数量不合法', no_grain: '粮草不足', no_gold: '金钱不足',
    no_general: '找不到该武将', same_city: '该武将已在此城', no_city: '目标城不存在',
    /* ★ P54：编队拒绝原因与征兵页同源，玩家永远看不到英文协议码。 */
    general_other_city: '该武将不在本队驻城，请先调防',
    /* ★ P56：整编/解散失败也要中文，别把 no_home_city 之类内部码弹给玩家。 */
    over_cap: '有槽位超过带兵上限', empty_formup: '三槽全空不能整编，请直接解散队伍',
    no_home_city: '没有可接收余兵的己方城', protagonist_locked: '主公不可合成或转卖',
    no_captive: '该俘虏已不在营中，请刷新名单后再试',
    refused: '对方拒绝归降，忠诚下降；本次未扣金',
    escaped: '对方宁死不降，趁夜越狱；本次未扣金',
  };
  function strategyAction(body, cb) {
    fetch(API_ROOT + '/strategy/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); }).then(function (r) {
      var overCapMsg = r.reason === 'over_cap'
        ? ('第 ' + (r.slot + 1) + ' 槽带兵上限 ' + fmt(r.cap) + '（该槽武将官阶越高上限越高），现填 ' + fmt(r.have))
        : null;
      var failText = r.text || r.hint || ACTION_REASON_TEXT[r.reason] || '操作未生效，请刷新后再试';
      toast(overCapMsg || (r.ok && !r.text && !r.hint ? '完成' : failText), !r.ok);
      if (r.ok) fetchState();
      if (cb) cb(r);
    }).catch(function (e) { toast('操作失败：' + e.message, true); });
  }
  /* ★ 2026-11-21 队伍整编重做：统一 0 基下标、实时合计/余兵反馈、一键平分。
     上限一律用服务端随 allGenerals 下发的 slotCap，不在前端重写功勋/等级公式。 */
  function formupBox(army) {
    var mask = document.createElement('div');
    mask.id = 'slgFormup';
    /* ★ P55：旧值 100004 低于六府窗的 100100——从「六府→战略」点整编时弹窗被面板
       遮住，玩家只看到一闪或根本点不到。抬到确认框层 100820（与调防弹窗一致）。 */
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:100820;display:flex;align-items:center;justify-content:center;';
    /* ★ P54：整编只认队伍驻城。别城武将不进下拉，先在武将页调防过来。 */
    var armyCity = Number(army.cityId) || 0;
    var allGens = data.strategy.allGenerals || [];
    var gens = allGens.filter(function (g) { return Number(g.cityId) === armyCity; });
    var hiddenOtherCity = allGens.length - gens.length;
    var armyCityName = (data.strategy.cities || []).filter(function (c) { return Number(c.id) === armyCity; })
      .map(function (c) { return c.name || ''; })[0] || '';
    var genById = {};
    gens.forEach(function (g) { genById[g.id] = g; });
    var slotCapOfGen = function (g) { return g ? (Number(g.slotCap) || 5000) : 5000; };
    var total = (army.soldiers || []).reduce(function (s, v) { return s + (Number(v) || 0); }, 0);
    var sel = function (slot, curId) {
      return '<select data-fup="gen' + slot + '" class="fsel">'
        + '<option value="0">（空槽）</option>'
        + gens.map(function (g) {
          var inThis = (army.generals || [])[slot] && army.generals[slot].id === g.id;
          var busyElsewhere = (data.strategy.armies || []).some(function (a) {
            return a.id !== army.id && (a.generals || []).some(function (gg) { return gg && gg.id === g.id; });
          });
          var sameArmyOther = (army.generals || []).some(function (gg, i) { return i !== slot && gg && gg.id === g.id; });
          var busy = busyElsewhere || sameArmyOther;
          /* ★ P54：data-busy 只记队外占用；同队重复由 refresh() 按当前三个下拉实时禁用。 */
          return '<option value="' + g.id + '" data-busy="' + (busyElsewhere ? 1 : 0) + '"'
            + (inThis ? ' selected' : '') + (busy && !inThis ? ' disabled' : '') + '>'
            + esc(g.name) + (g.cityName ? '（' + esc(g.cityName) + '）' : '')
            + (g.rank ? ' · ' + esc(g.rank) : '') + (busy && !inThis ? ' · 在编' : '') + '</option>';
        }).join('') + '</select>';
    };
    mask.innerHTML = '<div id="slgFormupDlg">'
      + '<div class="fhead"><div><b>整编队伍 · 第 ' + army.order + ' 军</b>'
      + '<span class="fsub">驻城：' + esc(armyCityName || ('#' + armyCity)) + ' · 现兵 ' + fmt(total) + '</span></div>'
      + '<span class="fx" data-fup="cancel" title="关闭">✕</span></div>'
      + '<div class="fbody">'
      + '<div class="fnote">三槽即战位：前锋 / 中军 / 大营，对应盾步 / 弓兵 / 骑兵。'
      + '只列本城武将、一人只在一队；已在别队者先从原队撤下，他城武将请先调防'
      + (hiddenOtherCity ? '（已隐藏他城武将 ' + hiddenOtherCity + ' 人）' : '') + '。'
      + '兵力只在本队现有 ' + fmt(total) + ' 人内重分，余兵退回驻城。每槽上限取本机按该槽武将官阶与等级算出的真实值（基础 5000 + 官阶×300 +（等级−1）×200，满级三公 9500），换将后自动刷新。</div>'
      + '<div id="slgFormupSummary" class="fsummary"></div>'
      + '<div class="fslots">'
      + [1, 2, 3].map(function (slot) {
        var s = slot - 1;
        var cur = army.generals[s];
        var captain = cur ? genById[cur.id] : null;
        var cap = slotCapOfGen(captain);
        return '<div class="fslot"><div class="frole">'
          + '<b>第 ' + (slot + 1) + ' 槽</b><span>' + esc((army.armsNames || ['盾步', '弓兵', '骑兵'])[s]) + '</span></div>'
          + sel(s, cur && cur.id)
          + '<label class="ftroop">兵力<input type="number" min="0" max="' + cap + '" value="' + (army.soldiers[s] || 0) + '" data-fup="troop' + s + '"></label>'
          + '<span class="fmeta" data-fup="cap' + s + '">上限 ' + fmt(cap) + (captain && captain.rank ? '（' + captain.rank + '阶）' : '') + '</span>'
          + '<span class="fmeta" data-fup="apt' + s + '">' + (cur ? ('适性 ' + cur.apt + '% · 忠' + cur.loyal) : '空槽') + '</span>'
          + '</div>';
      }).join('')
      + '</div></div>'
      + '<div class="ffoot"><button data-fup="even" class="fbtn">按现兵平分</button>'
      + '<span class="fsp"></span>'
      + '<button data-fup="cancel" class="fbtn">取消</button>'
      + '<button data-fup="disband" class="fbtn">解散此队</button>'
      + '<button data-fup="ok" class="fbtn primary">确认整编</button></div></div>';
    var readSlots = function () {
      var ids = [0, 1, 2].map(function (slot) { return Number(mask.querySelector('[data-fup="gen' + slot + '"]').value) || 0; });
      var vals = [0, 1, 2].map(function (slot) { return Math.max(0, Math.floor(Number(mask.querySelector('[data-fup="troop' + slot + '"]').value) || 0)); });
      return { ids: ids, vals: vals };
    };
    var refresh = function () {
      var cur = readSlots();
      /* ★ P54：同一人在本弹窗内也只能占一个槽；队外占用由 data-busy 继承，当前选中项保持可选。 */
      [0, 1, 2].forEach(function (slot) {
        var node = mask.querySelector('[data-fup="gen' + slot + '"]');
        if (!node) return;
        Array.prototype.forEach.call(node.options, function (o) {
          var id = Number(o.value) || 0;
          if (!id) return;
          var repeated = cur.ids.some(function (v, i) { return i !== slot && v === id; });
          o.disabled = id !== cur.ids[slot] && (o.getAttribute('data-busy') === '1' || repeated);
        });
      });
      var caps = cur.ids.map(function (id) { return slotCapOfGen(genById[id]); });
      cur.vals.forEach(function (v, i) {
        var input = mask.querySelector('[data-fup="troop' + i + '"]');
        input.max = caps[i];
        var capEl = mask.querySelector('[data-fup="cap' + i + '"]');
        if (capEl) capEl.textContent = '上限 ' + fmt(caps[i]) + (genById[cur.ids[i]] && genById[cur.ids[i]].rank ? '（' + genById[cur.ids[i]].rank + '阶）' : '');
      });
      var sum = cur.vals.reduce(function (a, b) { return a + b; }, 0);
      var diff = total - sum;
      var summary = mask.querySelector('#slgFormupSummary');
      var bad = diff < 0 || cur.vals.some(function (v, i) { return v > caps[i]; });
      summary.style.color = bad ? '#f0a389' : '#f0d998';
      summary.textContent = '本队现兵 ' + fmt(total) + ' · 已分配 ' + fmt(sum)
        + (diff >= 0 ? ' · 余 ' + fmt(diff) + ' 将退回驻城' : ' · 超出 ' + fmt(-diff) + ' 人，确认会被拒绝')
        + (cur.vals.some(function (v, i) { return v > caps[i]; }) ? ' · 有槽位超过带兵上限' : '');
    };
    document.body.appendChild(mask);
    mask.addEventListener('input', function (e) {
      if (e.target && e.target.getAttribute && /^troop[012]$/.test(e.target.getAttribute('data-fup') || '')) refresh();
    });
    mask.addEventListener('change', function (e) {
      if (e.target && e.target.getAttribute && /^gen[012]$/.test(e.target.getAttribute('data-fup') || '')) refresh();
    });
    mask.addEventListener('click', function (e) {
      var t = e.target.closest('[data-fup]');
      if (!t) return;
      var k = t.getAttribute('data-fup');
      if (k === 'cancel') { mask.remove(); return; }
      if (k === 'even') {
        var picked = readSlots();
        var caps = picked.ids.map(function (id) { return slotCapOfGen(genById[id]); });
        var left = total, vals = [0, 0, 0];
        for (var i = 0; i < 3; i++) { vals[i] = Math.min(caps[i], Math.floor(left / (3 - i))); left -= vals[i]; }
        for (var j = 0; j < 3 && left > 0; j++) { var room = caps[j] - vals[j]; var add = Math.min(room, left); vals[j] += add; left -= add; }
        vals.forEach(function (v, i2) { mask.querySelector('[data-fup="troop' + i2 + '"]').value = v; });
        refresh();
        return;
      }
      if (k === 'disband') {
        /* ★ P56：整编弹窗也提供真正的解散入口，不再逼玩家把三槽清零（旧服务端会拒绝）。 */
        confirmBox('解散第 ' + army.order + ' 军？', function () {
          strategyAction({ action: 'disbandArmy', armyId: army.id }, function (r) {
            if (r.ok) { toast('队伍已解散，余兵退回驻城', false); mask.remove(); }
          });
        });
        return;
      }
      if (k === 'ok') {
        /* 下拉 gen0/gen1/gen2 与兵力输入 troop0/troop1/troop2 现在共用同一套 0 基下标，
           旧版 troop1~3 与 gen0~2 混用会让确认按钮整体失效。 */
        var generals = [0, 1, 2].map(function (slot) { return Number(mask.querySelector('[data-fup="gen' + slot + '"]').value) || 0; });
        var soldiers = [0, 1, 2].map(function (slot) { return Math.max(0, Math.floor(Number(mask.querySelector('[data-fup="troop' + slot + '"]').value) || 0)); });
        strategyAction({ action: 'formup', armyId: army.id, generals: generals, soldiers: soldiers });
        mask.remove();
      }
    });
    refresh();
  }

  /* ★ 修 bug-13：运输起点可选 —— 旧实现 from 写死首都，只能从首都一条线调粮。
     这里给一个起点下拉 + 数量输入的小弹窗，走 strategyTransport 的 fromCityId。 */
  function openTransport(tCity) {
    var own = (data.strategy.cities || []).filter(function (c) {
      return c.owner === 'player' && c.id !== tCity.id;
    });
    if (!own.length) { toast('没有别的城可以调粮', false); return; }
    var mask = document.createElement('div');
    mask.id = 'slgTransportBox';
    /* ★ P55：与整编弹窗同理，运粮从六府「府库」打开时必须盖过面板（100100）。 */
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:100820;display:flex;'
      + 'align-items:center;justify-content:center;';
    var selStyle = 'background:#2a2617;border:1px solid #ba9a52;color:#fff;padding:4px 6px;border-radius:4px;'
      + 'font:13px "Microsoft YaHei",sans-serif;';
    mask.innerHTML = '<div style="background:#1d1a12;border:1px solid #ba9a52;border-radius:8px;'
      + 'padding:18px 22px;min-width:400px;color:#e8e0cc;font:13px \'Microsoft YaHei\',sans-serif">'
      + '<h3 style="margin:0 0 8px;color:#ffdf9a">运粮到 ' + esc(tCity.name) + '</h3>'
      + '<div class="muted" style="margin-bottom:12px">粮从起点城城库出，按里程算天数（辎重队速度固定 70）。'
      + '前线囤粮可省掉府库 25% 的途中损耗。</div>'
      + '<label style="display:block;margin-bottom:10px">起点城 '
      + '<select id="slgTrFrom" style="' + selStyle + '">'
      + own.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.name) + '（城库 ' + fmt(c.store || 0) + '）</option>';
      }).join('') + '</select></label>'
      + '<label style="display:block;margin-bottom:14px">运多少粮 '
      + '<input id="slgTrAmt" type="number" min="1" step="100" value="2000" style="' + selStyle + 'width:110px"></label>'
      + '<div style="text-align:right"><button id="slgTrCancel" style="background:none;border:1px solid #777;'
      + 'color:#ccc;padding:5px 14px;border-radius:4px;cursor:pointer">取消</button> '
      + '<button id="slgTrOk" style="background:#7a5c1e;border:1px solid #ba9a52;color:#ffe9b0;'
      + 'padding:5px 18px;border-radius:4px;cursor:pointer">起运</button></div></div>';
    document.body.appendChild(mask);
    mask.querySelector('#slgTrCancel').onclick = function () { mask.remove(); };
    mask.querySelector('#slgTrOk').onclick = function () {
      var from = Number(mask.querySelector('#slgTrFrom').value) || 0;
      var grain = Math.max(1, Math.floor(Number(mask.querySelector('#slgTrAmt').value) || 0));
      mask.remove();
      strategyAction({ action: 'transport', cityId: tCity.id, fromCityId: from, grain: grain });
    };
  }

  /* ---------------- 样式 ---------------- */
  var CSS = [
    /* 层级让位：对方的城池窗/确认框/toast 是 100000~100003，六府入口压在它们上面会挡住按钮。
       取 99999：高于战略沙盘 overlay(99998) 仍可点，低于对方所有弹层，冲突时以对方为主。 */
    '#slgPanelsDock{position:fixed;right:12px;top:12px;z-index:99999;display:flex;flex-direction:column;gap:4px;',
      '  align-items:flex-end;padding:5px 7px;border-radius:9px;',
      '  background:linear-gradient(180deg,rgba(26,28,20,.95),rgba(13,14,10,.95));',
      '  border:1px solid rgba(186,154,82,.5);box-shadow:0 6px 22px rgba(0,0,0,.5);}',
    /* 分组小标题：与左上按钮坞的「沙盘 / 浮窗」同款写法，两处观感一致 */
    '#slgPanelsDock .cap{color:#8d8567;font:10.5px "Microsoft YaHei",sans-serif;letter-spacing:2px;',
      '  align-self:flex-end;padding:0 2px;user-select:none;}',
    /* 七个页签竖排常驻：横排会撑到 528px，压住战略层的分层地图与城池窗 */
    '#slgPanelsBtns{display:flex;flex-direction:column;gap:3px;align-items:stretch;}',
    '#slgPanelsDock .pb{background:transparent;color:#d9cba6;border:1px solid transparent;border-radius:5px;',
      '  padding:4px 9px;min-width:86px;cursor:pointer;font:12.5px/1.35 "Microsoft YaHei",sans-serif;',
      '  text-align:left;letter-spacing:.5px;transition:background .12s,color .12s,border-color .12s;}',
    '#slgPanelsDock .pb:hover{background:rgba(186,154,82,.18);color:#ffe9b0;border-color:rgba(186,154,82,.4);}',
    '#slgPanelsDock .pb.on{background:rgba(186,154,82,.22);color:#fff2cf;border-color:#ba9a52;}',
    '#slgPanelsDock .pb{position:relative;}',
    '#slgPanelsDock .dot{position:absolute;right:4px;top:4px;width:8px;height:8px;border-radius:50%;'
      + 'background:#e04a3a;box-shadow:0 0 4px rgba(224,74,58,.8);display:none;}',
    /* ★ P41：保留 dock DOM 与原有 z-index 契约，只把视觉入口收起——
       真正的入口已并入沙盘顶部「六府」分组；点击仍转发到这里的按钮，红点与打开逻辑不变。 */
    '#slgPanelsDock{display:none!important;}',
    '#slgPanelsMask{position:fixed;inset:0;z-index:100100;background:rgba(6,8,6,.9);display:none;}',
    '#slgPanelsWin{position:absolute;inset:18px;max-width:1280px;margin:0 auto;background:#151811;',
    '  border:1px solid #75643d;border-radius:10px;box-shadow:0 18px 70px rgba(0,0,0,.8);display:flex;overflow:hidden;}',
    '#slgPanelsWin .side{width:178px;flex:0 0 178px;background:#101209;border-right:1px solid #3a3325;padding:14px 10px;overflow-y:auto;}',
    '#slgPanelsWin .brand{color:#e8c670;font:700 16px "Microsoft YaHei",sans-serif;letter-spacing:2px;padding:4px 8px 14px;}',
    '#slgPanelsWin .side .nav{display:block;width:100%;text-align:left;background:transparent;color:#c9bfa3;',
    '  border:1px solid transparent;border-radius:5px;padding:9px 10px;margin-bottom:5px;cursor:pointer;',
    '  font:14px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .side .nav:hover{background:#20221c;color:#f0dca8;}',
    '#slgPanelsWin .side .nav.on{background:#3a3325;border-color:#ba9a52;color:#ffe6a6;}',
    '#slgPanelsWin .side .tip{color:#8f8676;font:12px/1.7 "Microsoft YaHei",sans-serif;padding:10px 8px;border-top:1px solid #2b2b20;margin-top:10px;}',
    '#slgPanelsWin .main{flex:1;min-width:0;display:flex;flex-direction:column;}',
    '#slgPanelsWin .top{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:12px;padding:0 16px;',
    '  border-bottom:1px solid #3a3325;background:#1b1d14;color:#e8c670;font:14px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .top .sp{flex:1;color:#b9b197;font-size:13px;}',
    '#slgPanelsWin .top button{background:#2a2c22;color:#e8c670;border:1px solid #6a624a;border-radius:4px;',
    '  padding:4px 12px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .body{flex:1;overflow-y:auto;padding:16px 18px 28px;color:#e2d6ba;',
    '  font:13px/1.75 "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .body::-webkit-scrollbar{width:9px;}#slgPanelsWin .body::-webkit-scrollbar-thumb{background:#4a4436;border-radius:5px;}',
    '#slgPanelsWin h3{color:#e8c670;font:700 15px "Microsoft YaHei",sans-serif;margin:0 0 10px;letter-spacing:1px;}',
    '#slgPanelsWin h4{color:#cbb477;font:700 13px "Microsoft YaHei",sans-serif;margin:16px 0 8px;}',
    '#slgPanelsWin .card{background:#20221c;border:1px solid #3d3b2b;border-radius:7px;padding:12px 14px;margin-bottom:12px;}',
    '#slgPanelsWin .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:10px;}',
    '#slgPanelsWin .k{color:#8f9c84;}#slgPanelsWin .v{color:#f0e2b8;}',
    '#slgPanelsWin .up{color:#e8a06a;}#slgPanelsWin .down{color:#9dca8b;}',    '#slgPanelsWin .btn{background:#2c2f22;color:#e8c670;border:1px solid #7a6a42;border-radius:4px;',
    '  padding:4px 11px;cursor:pointer;font:12px "Microsoft YaHei",sans-serif;margin:2px 4px 2px 0;}',
    '#slgPanelsWin .btn:hover{background:#474029;}#slgPanelsWin .btn:disabled{opacity:.4;cursor:not-allowed;}',
    '#slgPanelsWin .btn.warn{border-color:#a8664c;color:#e6a786;}',
    '#slgPanelsWin .capbtn{flex:0 0 62px;background:#2c2f22;color:#e8d7a8;border:1px solid #7a6a42;',
    '  border-radius:5px;padding:7px 10px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;white-space:nowrap;}',
    '#slgPanelsWin .capbtn:hover{background:#474029;border-color:#ba9a52;color:#ffe6a6;}',
    '#slgPanelsWin .capbtn.danger{border-color:#a8664c;color:#f0b39b;}',
    '#slgPanelsWin .capbtn.danger:hover{background:#4a2b24;color:#ffd0bb;}',
    '#slgPanelsWin .caprow .genrow small{color:#b3a88f;}',
    '#slgPanelsWin .capPanel{border-left:3px solid #9c6b3f;}',
    '#slgPanelsWin .capPanel td{vertical-align:middle;}',
    '#slgPanelsWin .capPanel .rate{display:inline-block;min-width:44px;color:#f0d998;font-weight:600;}',
    '#slgPanelsWin table{width:100%;border-collapse:collapse;font-size:13px;}',
    '#slgPanelsWin th,#slgPanelsWin td{border-bottom:1px solid #33302a;padding:7px 9px;text-align:left;}',
    '#slgPanelsWin th{color:#c2ac74;font-weight:600;background:#20221600;}',
    '#slgPanelsWin .tag{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;margin-right:5px;border:1px solid #5c573c;color:#c9bd97;}',
    '#slgPanelsWin .tag.ok{background:#26361f;border-color:#4e7a3e;color:#bfe0a3;}',
    '#slgPanelsWin .tag.mid{background:#37301b;border-color:#8a7038;color:#e8c670;}',
    '#slgPanelsWin .tag.no{background:#2a211d;border-color:#6a4a3c;color:#bfa18e;}',
    '#slgPanelsWin .tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;}',
    '#slgPanelsWin .tabs button{background:#20221c;color:#bcb292;border:1px solid #4a4436;border-radius:4px;',
    '  padding:5px 13px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .tabs button.on{background:#3a3325;border-color:#ba9a52;color:#ffe6a6;}',
    '#slgPanelsWin .genlist{width:218px;flex:0 0 218px;max-height:100%;overflow-y:auto;border-right:1px solid #33302a;padding-right:9px;}',
    /* ★ P51：武将页左右两栏各自独立滚动。旧结构只有 .body 一个真滚动容器，
       列表滚到底会把详情一起带走；这里让两栏等高、各自成滚动区并切断滚动链。 */
    '#slgPanelsWin .body.gen-body{display:flex;flex-direction:column;overflow:hidden;padding-bottom:12px;}',
    '#slgPanelsWin .gen-body .cols{flex:1;min-height:0;overflow:hidden;align-items:stretch;}',
    '#slgPanelsWin .gen-body .genlist{height:100%;max-height:none;overscroll-behavior:contain;}',
    '#slgPanelsWin .gen-body .cols>.right{height:100%;overflow-y:auto;overscroll-behavior:contain;padding-right:8px;}',
    '#slgPanelsWin .genpickbar{display:flex;flex-wrap:wrap;gap:5px;align-items:center;position:sticky;top:0;',
    '  z-index:2;background:#151811;padding:4px 0 8px;border-bottom:1px solid #3a3325;margin-bottom:7px;}',
    '#slgPanelsWin .genpickbar .btn{font-size:11px;padding:2px 7px;margin:0;}',
    '#slgPanelsWin .genpickbar .citypickbtn{color:#ffe1a2;border-color:#8a7038;max-width:190px;',
    '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    /* 选城弹窗：确认框层 100820，高于六府窗(100100)；关闭即回到原列表位置。 */
    '#slgDispatchMask{position:fixed;inset:0;z-index:100820;background:rgba(0,0,0,.62);',
    '  display:flex;align-items:center;justify-content:center;}',
    '#slgDispatchDlg{width:780px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;',
    '  background:#20221c;border:1px solid #ba9a52;border-radius:10px;color:#e2d6b8;',
    '  box-shadow:0 18px 60px rgba(0,0,0,.8);font:13px "Microsoft YaHei",sans-serif;}',
    '#slgDispatchDlg .dhead{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid #3a3325;}',
    '#slgDispatchDlg .dhead b{font-size:15px;color:#f0d998;}',
    '#slgDispatchDlg .dhead .x{margin-left:auto;cursor:pointer;color:#9c9382;padding:0 5px;}',
    /* ★ P55：按城址找城 + 大地图可点选。 */
    '#slgDispatchDlg .dsearch{padding:9px 16px 0;}',
    '#slgDispatchDlg .dsearch input{width:100%;box-sizing:border-box;background:#151811;color:#e2d6b8;',
    '  border:1px solid #6a5f42;border-radius:5px;padding:7px 10px;font:12.5px "Microsoft YaHei",sans-serif;}',
    '#slgDispatchDlg .dsearch input:focus{outline:1px solid #ba9a52;border-color:#ba9a52;}',
    '#slgDispatchDlg .dbody{display:flex;gap:14px;padding:10px 16px 12px;min-height:0;overflow:hidden;}',
    '#slgDispatchDlg .dcities{width:300px;flex:0 0 300px;overflow-y:auto;max-height:52vh;}',
    '#slgDispatchDlg .dcity{display:block;width:100%;text-align:left;background:#151811;color:#c9bfa3;',
    '  border:1px solid #3a3325;border-radius:5px;padding:7px 9px;margin-bottom:5px;cursor:pointer;',
    '  font:12.5px "Microsoft YaHei",sans-serif;line-height:1.5;}',
    '#slgDispatchDlg .dcity:hover{background:#262a1e;}',
    '#slgDispatchDlg .dcity.on{background:#3a3325;border-color:#ba9a52;color:#ffe6a6;}',
    '#slgDispatchDlg .dcity .addr{display:block;color:#a89c7c;font-size:11px;}',
    '#slgDispatchDlg .dcity .garrison{display:block;color:#8f9c84;font-size:11px;}',
    '#slgDispatchDlg .dmap{flex:1;min-width:0;min-height:280px;background:#10150f;border:1px solid #3a3325;',
    '  border-radius:6px;overflow:hidden;display:flex;flex-direction:column;}',
    '#slgDispatchDlg .dmap svg{display:block;width:100%;height:100%;flex:1;min-height:0;}',
    '#slgDispatchDlg .dmap .dpin.own:hover circle:last-of-type{stroke:#ffe9b0;stroke-width:8;}',
    /* ★ P55：整编弹窗统一到「深底 + 金线 + 分区」语言，与调防弹窗同一套观感。 */
    '#slgFormupDlg{width:760px;max-width:94vw;max-height:88vh;overflow:auto;background:#20221c;',
    '  border:1px solid #ba9a52;border-radius:10px;color:#e2d6b8;box-shadow:0 18px 60px rgba(0,0,0,.8);',
    '  font:13px "Microsoft YaHei",sans-serif;}',
    '#slgFormupDlg .fhead{display:flex;align-items:center;padding:13px 18px;border-bottom:1px solid #3a3325;}',
    '#slgFormupDlg .fhead b{font-size:15px;color:#f0d998;}',
    '#slgFormupDlg .fhead .fsub{display:block;color:#a89c7c;font-size:11.5px;margin-top:3px;}',
    '#slgFormupDlg .fhead .fx{margin-left:auto;cursor:pointer;color:#9c9382;font-size:16px;padding:0 5px;}',
    '#slgFormupDlg .fbody{padding:14px 18px;}',
    '#slgFormupDlg .fnote{color:#a89c7c;line-height:1.75;font-size:12px;margin-bottom:11px;}',
    '#slgFormupDlg .fsummary{background:#242820;border:1px solid #6a5f42;border-radius:5px;',
    '  padding:8px 11px;margin-bottom:12px;color:#f0d998;font-size:12.5px;}',
    '#slgFormupDlg .fslots{display:flex;flex-direction:column;gap:9px;}',
    '#slgFormupDlg .fslot{display:flex;gap:9px;align-items:center;background:#191b14;',
    '  border:1px solid #3a3325;border-radius:7px;padding:10px 12px;}',
    '#slgFormupDlg .frole{flex:0 0 86px;color:#ffdf9a;}',
    '#slgFormupDlg .frole b{display:block;font-size:13px;}',
    '#slgFormupDlg .frole span{font-size:11.5px;color:#a89c7c;}',
    '#slgFormupDlg .fsel{flex:1;min-width:140px;max-width:240px;background:#2a2617;border:1px solid #7a6a42;',
    '  color:#e8e0cc;padding:6px 7px;border-radius:4px;font:12.5px "Microsoft YaHei",sans-serif;}',
    '#slgFormupDlg .ftroop{flex:0 0 116px;color:#a89c7c;font-size:11px;}',
    '#slgFormupDlg .ftroop input{display:block;width:100%;box-sizing:border-box;margin-top:3px;background:#2a2617;',
    '  border:1px solid #7a6a42;color:#fff;padding:5px 6px;border-radius:4px;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgFormupDlg .fmeta{flex:0 0 118px;color:#a89c7c;font-size:11.5px;line-height:1.5;}',
    '#slgFormupDlg .ffoot{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid #3a3325;}',
    '#slgFormupDlg .fsp{flex:1;}',
    '#slgFormupDlg .fbtn{background:#2c2f22;border:1px solid #7a6a42;color:#e8d7a8;',
    '  padding:6px 15px;border-radius:4px;cursor:pointer;font:12.5px "Microsoft YaHei",sans-serif;}',
    '#slgFormupDlg .fbtn:hover{background:#474029;}',
    '#slgFormupDlg .fbtn.primary{background:#7a5c1e;border-color:#ba9a52;color:#ffe9b0;}',
    '#slgDispatchDlg .dfoot{display:flex;align-items:center;gap:8px;padding:11px 16px;border-top:1px solid #3a3325;}',
    '#slgDispatchDlg .dfoot .dest{color:#f0d998;flex:1;}',
    '#slgPanelsWin .genrow{display:flex;align-items:center;gap:4px;width:100%;text-align:left;background:transparent;color:#c9bfa3;border:1px solid transparent;',
    '  border-radius:5px;padding:7px 9px;margin-bottom:3px;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .genrow .genpick{flex:0 0 15px;width:15px;height:15px;accent-color:#ba9a52;cursor:pointer;margin:0;}',
    '#slgPanelsWin .genrow .genmain{flex:1;min-width:0;background:transparent;border:0;color:inherit;',
    '  font:inherit;text-align:left;cursor:pointer;padding:0;}',
    '#slgPanelsWin .genrow:hover{background:#20221c;}#slgPanelsWin .genrow.on{background:#3a3325;border-color:#ba9a52;color:#ffe6a6;}',
    '#slgPanelsWin .genrow small{color:#a49a84;display:block;font-size:11px;line-height:1.5;}',
    /* 人物卡：原版立绘主视觉 + 阵营色描边 + 史载五维条（不编造数值，取自 lore.historyStats） */
    '#slgPanelsWin .genrow{min-height:52px;}',
    '#slgPanelsWin .genrow .hcThumb{float:left;width:35px;height:47px;object-fit:cover;object-position:top;',
    '  border:1px solid #8a7a52;border-radius:4px;margin:1px 9px 0 0;background:#12150f;',
    '  box-shadow:0 2px 7px #0009;}',
    '#slgPanelsWin .genrow .hcThumbFallback{float:left;width:35px;height:47px;line-height:47px;text-align:center;',
    '  border:1px solid #8a7a52;border-radius:4px;margin:1px 9px 0 0;background:linear-gradient(160deg,#3a3a24,#1b1d14);',
    '  color:#f0d998;font:19px "KaiTi",serif;}',
    '#slgPanelsWin .genrow.on .hcThumb,#slgPanelsWin .genrow.on .hcThumbFallback{border-color:#e8c670;}',
    '#slgPanelsWin .hcCard{position:relative;display:flex;gap:18px;background:',
    '  radial-gradient(circle at 12% 8%,rgba(232,198,112,.10),transparent 42%),linear-gradient(135deg,#25271d,#171a12 68%);',
    '  border:1px solid #6a5f42;border-left:4px solid var(--hcc,#ba9a52);border-radius:10px;padding:15px 18px;margin-bottom:14px;',
    '  box-shadow:0 8px 24px #0006,0 0 0 1px #0d0f0a inset;}',
    '#slgPanelsWin .hcCard:before{content:"";position:absolute;right:10px;top:10px;width:58px;height:58px;',
    '  border-top:1px solid rgba(232,198,112,.24);border-right:1px solid rgba(232,198,112,.24);pointer-events:none;}',
    '#slgPanelsWin .hcArt{flex:0 0 176px;position:relative;border:1px solid var(--hcc,#ba9a52);border-radius:8px;',
    '  overflow:hidden;background:#12150f;box-shadow:0 6px 18px #000a,0 0 0 3px #0e100b inset;}',
    '#slgPanelsWin .hcArt img.hcPortrait{display:block;width:176px;height:246px;object-fit:cover;object-position:top center;}',
    '#slgPanelsWin .hcArt .hcNoArt{width:176px;height:246px;display:flex;align-items:center;justify-content:center;',
    '  font:700 82px "KaiTi",serif;color:#e8c670;background:radial-gradient(circle at 50% 30%,#494934,#14160f);}',
    '#slgPanelsWin .hcArt .hcRank{position:absolute;left:0;right:0;bottom:0;padding:16px 8px 7px;',
    '  background:linear-gradient(transparent,#0b0c08 54%);color:#ffe6a6;font:700 19px "KaiTi",serif;text-align:center;',
    '  letter-spacing:3px;text-shadow:0 2px 5px #000;}',
    '#slgPanelsWin .hcArt .hcSeal{position:absolute;left:7px;top:7px;padding:2px 7px;border:1px solid var(--hcc,#ba9a52);',
    '  border-radius:3px;background:#0c0e0ad9;color:#f0d998;font:11px "KaiTi",serif;letter-spacing:2px;}',
    '#slgPanelsWin .hcMeta{flex:1;min-width:0;}',
    '#slgPanelsWin .hcName{font:700 29px "KaiTi","Microsoft YaHei",serif;color:#ffe6a6;letter-spacing:3px;',
    '  text-shadow:0 2px 8px #0008;}',
    '#slgPanelsWin .hcName .hcStar{color:#f0c14b;font:14px "Microsoft YaHei",sans-serif;letter-spacing:1px;margin-left:10px;}',
    '#slgPanelsWin .hcLine{margin-top:7px;color:#b9ac8f;font-size:12px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
    '#slgPanelsWin .hcLine .hcCamp{display:inline-block;padding:2px 9px;border:1px solid var(--hcc,#ba9a52);',
    '  border-radius:9px;color:#f0d998;background:#2a2a1b;}',
    '#slgPanelsWin .hcLine .hcChip{padding:2px 8px;border:1px solid #4b4636;border-radius:9px;background:#1b1e15;color:#cfc4a6;}',
    '#slgPanelsWin .hcStars{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-top:13px;}',
    '#slgPanelsWin .hcStars .hcS{background:linear-gradient(#20231a,#171912);border:1px solid #514935;border-radius:6px;',
    '  padding:7px 8px;min-height:56px;}',
    '#slgPanelsWin .hcStars .hcS .n{color:#a89e86;font-size:11px;letter-spacing:1px;}',
    '#slgPanelsWin .hcStars .hcS .b{height:5px;background:#2b2d20;border-radius:3px;margin-top:7px;overflow:hidden;}',
    '#slgPanelsWin .hcStars .hcS .b i{display:block;height:100%;background:linear-gradient(90deg,#8c6c31,#e8c670);}',
    '#slgPanelsWin .hcStars .hcS .v{color:#f0e2b8;font:700 16px "Microsoft YaHei",sans-serif;text-align:right;',
    '  margin-top:2px;}',
    '#slgPanelsWin .hcStars .hcS .v.na{color:#7f7768;font-size:13px;}',
    '#slgPanelsWin .hcBrief{margin-top:12px;color:#d9cba8;font-size:12px;line-height:1.75;',
    '  border-top:1px solid #4a4331;padding-top:9px;}',
    '#slgPanelsWin .hcBrief:before{content:"「";color:#e8c670;font:20px "KaiTi",serif;margin-right:2px;}',
    '#slgPanelsWin .hcTags{margin-top:8px;color:#a99e84;font-size:11px;display:flex;gap:8px;flex-wrap:wrap;}',
    '#slgPanelsWin .hcTags span{padding:2px 7px;background:#1d2017;border:1px solid #3d3a2c;border-radius:3px;}',
    '#slgPanelsWin .hcTags b{color:#d8c9a5;font-weight:600;}',
    '#slgPanelsWin .hcEvidence{margin-top:10px;font-size:12px;color:#b3a88f;}',
    '#slgPanelsWin .hcEvidence summary{cursor:pointer;color:#e3c46a;padding:3px 0;}',
    '#slgPanelsWin .hcEvidence .evbody{padding:6px 0 2px;line-height:1.7;}',
    '#slgPanelsWin .hcState{margin-top:12px;}',
    '#slgPanelsWin .hcState>.card{margin-top:9px;}',
    '#slgPanelsWin .hcNote{margin-top:10px;padding:8px 10px;border-left:2px solid #ba9a52;',
    '  background:#202318;color:#c7ba98;font-size:12px;line-height:1.7;}',
    '#slgPanelsWin .cols{display:flex;gap:16px;align-items:flex-start;}#slgPanelsWin .cols>.right{flex:1;min-width:0;}',
    '#slgPanelsWin .src{border-left:2px solid #6a5a32;padding:4px 0 4px 11px;margin:8px 0;}',
    '#slgPanelsWin .src b{color:#e8c670;}#slgPanelsWin .src .muted{color:#9c9382;font-size:12px;}',
    '#slgPanelsWin .skill{border:1px solid #3d3b2b;border-radius:6px;margin-bottom:7px;background:#1b1e15;}',
    '#slgPanelsWin .skill .hd{padding:9px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;}',
    '#slgPanelsWin .skill .hd:hover{background:#22261900;}#slgPanelsWin .skill .dt{padding:0 14px 12px;border-top:1px solid #33302a;}',
    '#slgPanelsWin .bar{height:7px;background:#2b2d20;border-radius:4px;overflow:hidden;margin:5px 0;}',
    '#slgPanelsWin .bar i{display:block;height:100%;background:#a98a45;}',
    '#slgPanelsWin select,#slgPanelsWin input[type=text]{background:#20221c;color:#e2d6ba;border:1px solid #5a5539;',
    '  border-radius:4px;padding:4px 7px;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .muted{color:#9c9382;}',
    '#slgPanelsToast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100130;display:none;',
    '  padding:9px 20px;border:1px solid #ba9a52;border-radius:5px;color:#f4e7bf;font:14px "Microsoft YaHei",sans-serif;}',
  ].join('');

  var NAV = [
    ['general', '武将', '帐下与在野'], ['strategy', '战略', '国势与推演'],
    ['war', '出征', '选城选队列兵'],
    ['interior', '内政', '委任与政令'], ['depot', '府库', '分类账'],
    ['equip', '兵刃', '四槽穿戴与锻造'], ['library', '战法库', '全库与配方'],
  ];

  /* ---------------- 各面板 ---------------- */
  /* ★ 2026-11-17 调防：把闲置武将派往另一座己方城（只改所在城，不动兵力与城池归属）。 */
  function cityPickHtml(g) {
    var own = ((data.strategy || {}).cities || []).filter(function (c) {
      return c.owner === 'player' && Number(c.id) !== Number(g.cityId);
    });
    if (!own.length) return '<span class="muted">暂无其他己方城可调</span>';
    return '<select data-act="dispatchpick" data-gid="' + g.id + '" style="background:#2a2617;border:1px solid #ba9a52;color:#e8e0cc;padding:2px 6px;border-radius:4px">'
      + own.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('')
      + '</select> <button class="btn" data-act="dispatch" data-gid="' + g.id + '">调防</button>';
  }

  /* 人物卡：立绘 URL 走 skills.js 下发的全局资产桥（web/ 磁盘零改动）。
     资产映射是异步 fetch 的，渲染时可能还没就绪——img 带 data-slgcid，
     skills.js 的 slg:portraits-ready 回填会把占位补成真实立绘。 */
  function portraitUrl(cfgId) {
    return (typeof window.__slgPortraitUrl === 'function') ? (window.__slgPortraitUrl(cfgId) || '') : '';
  }
  /* 阵营配色：沿用战场红/蓝基调，扩到多势力；史载五维口径 0~100 同源展示。 */
  var HC_CAMP_COLORS = ['#ba9a52', '#c0392b', '#2c5f8a', '#3e8e5a', '#8a5a9c', '#b0752e', '#4a6b8a', '#9c4a4a'];
  function campColor(camp) {
    return HC_CAMP_COLORS[(Number(camp) || 0) % HC_CAMP_COLORS.length];
  }
  function portraitThumb(g) {
    var url = portraitUrl(g.cfgId);
    if (url) return '<img class="hcThumb" data-slgcid="' + esc(g.cfgId) + '" src="' + esc(url)
      + '" alt="' + esc(g.name) + '" loading="lazy">';
    return '<span class="hcThumbFallback" data-slgcid="' + esc(g.cfgId) + '">'
      + esc(String(g.name || '将').slice(0, 1)) + '</span>';
  }
  /* 人物卡大图：立绘主视觉 + 阵营描边 + 星级 + 唯一一套五维 + 本局状态。
     ★ 2026-11-21：删掉旧的「属性 · 武将」表格页（基础/装备/增量/最终四列），
       保留图片右边这五格作为唯一属性展示：有史载取 lore.historyStats，
       无史载（主角 / 编辑器新武将）取本局 g.final，绝不编造史载值。
       原属性页里有价值的「本局状态 / 调防 / 赏赐 / 关系」全部平移进人物卡。 */
  var CARD_STAT_KEYS = { 统率: 'defense', 武力: 'force', 智力: 'strategy', 政治: 'politics' };
  function heroCardHtml(g) {
    var color = campColor(g.camp);
    var url = portraitUrl(g.cfgId);
    var art = url
      ? '<img class="hcPortrait" data-slgcid="' + esc(g.cfgId) + '" src="' + esc(url) + '" alt="' + esc(g.name) + '">'
      : '<div class="hcNoArt" data-slgcid="' + esc(g.cfgId) + '">' + esc(String(g.name || '将').slice(0, 1)) + '</div>';
    var star = Math.round(Number(g.star) || 0);
    var starTxt = '★'.repeat(Math.max(0, Math.min(5, star))) + '☆'.repeat(Math.max(0, 5 - star));
    var lore = g.lore;
    var dims = ['统率', '武力', '智力', '政治', '魅力'];
    var loreStats = (lore && lore.historyStats) || null;
    var hasLoreStats = !!loreStats && dims.some(function (d) { return Number(loreStats[d]) > 0; });
    var localStats = (g.final && Object.keys(g.final).length) ? g.final : g.base;
    var hasLocalStats = !!localStats && Object.keys(CARD_STAT_KEYS).some(function (d) {
      return Number(localStats[CARD_STAT_KEYS[d]]) > 0;
    });
    var starsHtml = dims.map(function (d) {
      var raw = hasLoreStats ? loreStats[d]
        : (CARD_STAT_KEYS[d] ? (localStats || {})[CARD_STAT_KEYS[d]] : (loreStats || {})[d]);
      var known = raw != null && Number(raw) > 0;
      var v = known ? Math.max(0, Math.min(100, Math.round(Number(raw)))) : 0;
      return '<div class="hcS"><div class="n">' + d + '</div>'
        + '<div class="v' + (known ? '' : ' na') + '">' + (known ? v : '未设') + '</div>'
        + '<div class="b"><i style="width:' + (known ? v : 0) + '%"></i></div></div>';
    }).join('');
    var sourceName = hasLoreStats ? '史料档案 · 史载五维（0~100）' : '本局档案 · 设定五维（0~100）';
    var note = sourceName + '：本局战斗数值 0~100，上方五格是唯一属性口径；史载值直接作为本局基础值，'
      + '装备与军功加成并入战斗结算，不再另列基础/装备/增量表。'
      + (hasLoreStats ? '' : ' 本局人物没有史载魅力值时显示「未设」，不编造。');
    var brief = lore && lore.brief ? esc(lore.brief)
      : '本局设定人物，史无明载；五维取本局设定值，与史载五维同为 0~100 口径。';
    var tags = lore
      ? ['字 ' + esc(lore.zi || '—'), '籍贯 ' + esc(lore.hometown || '—'), esc(lore.era || '')]
      : ['本局设定人物', hasLocalStats ? '本局属性已入卡' : '属性待设定'];
    if (g.cityName) tags.push('驻 ' + esc(g.cityName));
    return '<div class="hcCard" style="--hcc:' + color + '">'
      + '<div class="hcArt">' + art
      + '<div class="hcSeal">' + (hasLoreStats ? '史载' : '本局') + '</div>'
      + '<div class="hcRank">' + esc(g.name || '武将') + '</div></div>'
      + '<div class="hcMeta">'
      + '<div class="hcName">' + esc(g.name || '武将') + '<span class="hcStar">' + starTxt + '</span></div>'
      + '<div class="hcLine"><span class="hcCamp">' + (g.isProtagonist ? '主公' : (Number(g.camp) ? ('势力 ' + g.camp) : '在野')) + '</span>'
      + '<span class="hcChip">Lv ' + esc(g.level) + '</span>'
      + '<span class="hcChip">' + esc(g.careerName || '干才') + '</span>'
      + '<span class="hcChip">' + esc(g.state) + '</span>'
      + '<span class="hcChip">忠诚 ' + (g.loyal != null ? esc(g.loyal) : '—') + '</span></div>'
      + '<div class="hcStars">' + starsHtml + '</div>'
      + '<div class="hcNote">' + esc(note) + '</div>'
      + '<div class="hcBrief">' + brief + '<div class="hcTags">'
      + tags.map(function (t) { return '<span>' + t + '</span>'; }).join('')
      + '</div></div>'
      + '<details class="hcEvidence"><summary>依据</summary><div class="evbody">'
      + (hasLoreStats ? '史载人物：五维取史料档案所载数值，逐字沿用不改；无记载的一维显示「未设」，不补造。'
        : '本局设定人物：史无明载，五维取当前存档设定值；无记载的一维显示「未设」，不补造。')
      + ' 两者同为 0~100 口径，战斗中以本局五维为唯一权威。'
      + '</div></details>'
      + '</div></div>'
      + heroStateHtml(g);
  }

  /* 原「属性·」页的状态信息平移到人物卡下方；不再重复五维表。 */
  function heroStateHtml(g) {
    if (!g || g.id == null || !g.base) return '';
    var progress = g.progress || {};
    return '<div class="hcState"><div class="card"><h3>本局状态</h3>'
      + '<div class="grid">'
      + '<div><span class="k">所在城</span> <b class="v">' + esc(g.cityName || '—') + '</b>　' + cityPickHtml(g) + '</div>'
      + '<div><span class="k">体力 / 等级</span> <b class="v">' + esc(g.physical) + ' / Lv' + esc(g.level)
        + (progress.advanced ? ' <span class="tag">进阶</span>' : '') + '</b></div>'
      + '<div><span class="k">经验</span> <b class="v">' + (progress.capped ? ('已满 ' + esc(progress.cap || 10) + ' 级')
        : fmt(progress.exp != null ? progress.exp : g.exp) + '/' + fmt(progress.need || 0)) + '</b>'
      + (progress.next ? '<div class="muted">' + esc(progress.next) + '</div>' : '')
      + (progress.advanced ? '' : (Number(g.level) >= 10
        ? '<button class="btn" data-act="advance" data-id="' + g.id + '">进阶（1200 金）</button>' : ''))
      + '</div>'
      + '<div><span class="k">在编岗位</span> <b class="v">' + (g.appointed && g.appointed.length ? esc(g.appointed.join('、')) : '无') + '</b></div>'
      + '<div><span class="k">状态</span> <b class="v">' + esc(g.state) + '</b></div>'
      + '<div><span class="k">忠诚 / 旬俸</span> <b class="v" style="color:'
        + (g.loyal >= 80 ? '#9ec97f' : g.loyal >= 55 ? '#d8b45a' : '#e07a5f') + '">'
        + (g.loyal != null ? esc(g.loyal) : '—') + '</b>'
        + ' / ' + fmt(g.salaryPerXun || 20 * (g.star || 3)) + ' 金'
        + '<button class="btn" data-act="reward" data-id="' + g.id + '">赏赐</button></div>'
      + '</div>'
      + '<div class="muted" style="margin-top:8px">委任 +0.6/旬；闲置回落到基线 70 后不再下降；欠饷 −5、民心崩额外 −1；低于 55 预警，低于 40 才有出走风险。出征中的武将内政收益减半。</div>'
      + '</div>' + relationCardHtml(g) + '</div>';
  }

  function genListHtml() {
    var ownCities = ((data.strategy || {}).cities || []).filter(function (c) {
      return c.owner === 'player';
    });
    if (!ownCities.some(function (c) { return Number(c.id) === Number(ui.dispatchTo); })) {
      ui.dispatchTo = ownCities.length ? Number(ownCities[0].id) : 0;
    }
    /* 勾选只认当前在册武将：换档/招降后不会残留看不见的旧勾选。 */
    ui.genPick = ui.genPick.filter(function (id) {
      return (data.generals || []).some(function (g) {
        return g.id === Number(id) && !g.isProtagonist;
      });
    });
    var out = '<div class="genlist"><div class="genpickbar">'
      + '<button class="btn" data-act="genpickAll">全选</button>'
      + '<button class="btn" data-act="genpickClear">清空</button>'
      + '<span class="muted">已选 ' + ui.genPick.length + ' 人</span>'
      + (ownCities.length
        ? '<button class="btn citypickbtn" data-act="dispatchPickCity" title="弹窗选城，沙盘同步定位">目的城：'
          + esc((ownCities.find(function (c) { return Number(c.id) === Number(ui.dispatchTo); }) || {}).name || '未选')
          + '</button><button class="btn" data-act="dispatchBatch">批量调防</button>'
        : '<span class="muted">暂无其他己方城</span>')
      + '</div><h4>帐下武将（' + data.generals.length + '）</h4>';
    data.generals.forEach(function (g) {
      out += '<div class="genrow' + (g.id === ui.genId ? ' on' : '') + '">'
        + '<input class="genpick" type="checkbox" data-act="genpick" data-id="' + g.id + '"'
        + (g.isProtagonist ? ' disabled title="主公不参与批量调防，请单独派遣"' : ' title="勾选批量调防"')
        + (ui.genPick.indexOf(Number(g.id)) >= 0 ? ' checked' : '') + '>'
        + '<button class="genmain" data-act="gen" data-id="' + g.id + '">'
        + portraitThumb(g)
        + esc(g.name) + ' <span class="tag">' + esc(g.state) + '</span><small>Lv' + g.level + ' · ★' + g.star
        + ' · <span style="color:' + (g.loyal >= 80 ? '#9ec97f' : g.loyal >= 70 ? '#d8b45a' : '#e07a5f') + '">忠' + (g.loyal != null ? g.loyal : 88) + '</span>'
        + (g.appointed.length ? ' · 委任中' : '') + ' · 驻' + esc(g.cityName || '—') + '</small></button></div>';
    });
    out += '<h4>在野名士（可招贤）<span class="muted" style="font-weight:normal;font-size:11px"> · 下列统率为史载五维 0~100</span></h4>';
    (data.prospects || []).forEach(function (p, i) {
      out += '<button class="genrow' + (ui.genId === -i - 1 ? ' on' : '') + '" data-act="prospect" data-i="' + i + '">'
        + portraitThumb(p)
        + esc(p.name) + '<small>' + esc(p.zi === '史无明载' ? '' : '字' + p.zi) + ' · ' + esc(p.faction)
        + ' · 史载统率 ' + esc(p.historyStats.统率) + '</small></button>';
    });
    /* ★ 2026-11-21：俘虏不再挤在 218px 左栏里直接放三个按钮。
       左栏只留索引，点「查看处置」滚到右侧完整的「阵前俘虏」表格。 */
    if ((data.captives || []).length) {
      out += '<h4>阵前俘虏（' + data.captives.length + ' 人）</h4>';
      data.captives.forEach(function (c) {
        out += '<div class="card caprow" style="padding:7px 9px;margin-bottom:6px">'
          + '<button class="genrow" style="margin:0" data-act="captiveFocus" data-id="' + c.idx + '">'
          + esc(c.name) + '<small>押 ' + c.days + ' 旬 · 忠 ' + c.loyal + ' · 把握 ' + c.rate + '% · 查看处置</small></button>'
          + '</div>';
      });
    }
    return out + '</div>';
  }

  /* ★ P55：批量调防选城弹窗的「大地图」——与沙盘共用 2400×1350 坐标系，
     直接铺真实全景底图（/__slg/strategy/panorama.png，与沙盘同一张），全部城池按
     配置坐标落点；己方城是可点的金色标记，点地图上的城即可选为目的地，
     并同步把沙盘定位到该城。这里只画位置/城址，不重算任何战力/粮耗。 */
  function dispatchMapSvg(destId) {
    var cities = (data.strategy || {}).cities || [];
    var dest = cities.find(function (c) { return Number(c.id) === Number(destId); });
    var src = {};
    (data.generals || []).forEach(function (g) {
      if (ui.genPick.indexOf(Number(g.id)) < 0) return;
      var from = cities.find(function (c) {
        return Number(c.id) === Number(g.cityId) || c.name === g.cityName;
      });
      if (from && Number(from.id) !== Number(destId)) src[from.id] = true;
    });
    var lines = !dest ? '' : Object.keys(src).map(Number).map(function (id) {
      var c = cities.find(function (x) { return Number(x.id) === id; });
      if (!c || !Number(c.x) || !Number(c.y)) return '';
      return '<line x1="' + c.x + '" y1="' + c.y + '" x2="' + dest.x + '" y2="' + dest.y
        + '" stroke="#ffcf6b" stroke-width="8" stroke-dasharray="22 15" opacity=".85"/>';
    }).join('');
    /* 所有城池都落点：己方金点可点选、他在灰点仅作方位参照。each pin carries
       data-city so paint() can bind a real click → 选城不再只能靠左侧列表。 */
    var pins = cities.filter(function (c) { return Number(c.x) && Number(c.y); }).map(function (c) {
      var own = c.owner === 'player';
      var isSrc = !!src[c.id];
      var isDest = !!dest && Number(c.id) === Number(dest.id);
      var addr = [c.province, c.jun, c.today].filter(Boolean).join(' · ');
      var title = esc(c.name + (addr ? '（' + addr + '）' : '') + (own ? ' · 己方' : ''));
      if (isDest) return ''; // 目的城单独画大标记，避免重叠
      var r = own ? (isSrc ? 19 : 13) : 7;
      var fill = own ? (isSrc ? '#ffcf6b' : '#9fc47a') : '#5b6350';
      var label = (own || isSrc) ? '<text x="' + (c.x + r + 9) + '" y="' + (c.y + 16)
        + '" font-size="42" fill="' + (isSrc ? '#ffe9b0' : '#cfe0b4') + '">' + esc(c.name) + '</text>' : '';
      return '<g class="dpin' + (own ? ' own' : '') + '" data-city="' + c.id + '" title="' + title + '"'
        + (own ? ' style="cursor:pointer"' : '') + '>'
        + '<circle cx="' + c.x + '" cy="' + c.y + '" r="' + (r + 9) + '" fill="transparent"/>'
        + '<circle cx="' + c.x + '" cy="' + c.y + '" r="' + r + '" fill="' + fill
        + '" stroke="#10150f" stroke-width="5"/>' + label + '</g>';
    }).join('');
    var mark = !dest ? '' : (function () {
      var right = Number(dest.x) > 1850;
      return '<g data-city="' + dest.id + '" style="cursor:pointer">'
        + '<circle cx="' + dest.x + '" cy="' + dest.y + '" r="52" fill="none" stroke="#ffcf6b" stroke-width="11" opacity=".95"/>'
        + '<circle cx="' + dest.x + '" cy="' + dest.y + '" r="22" fill="#ffcf6b" stroke="#3a2c12" stroke-width="7"/>'
        + '<text x="' + (dest.x + (right ? -66 : 66)) + '" y="' + (dest.y + 24) + '" font-size="66"'
        + ' text-anchor="' + (right ? 'end' : 'start') + '" fill="#ffe9b0" font-weight="bold">' + esc(dest.name) + '</text></g>';
    })();
    return '<div style="padding:7px 10px;color:#b9ad90;font-size:11.5px;border-bottom:1px solid #3a3325">'
      + '金圈＝目的城市 · 浅金点＝调出城 · 虚线＝调遣方向；金点＝可选己方城、灰点＝他城方位；<b>直接点地图上的城即可选定</b>，沙盘同步定位。</div>'
      + '<svg viewBox="0 0 2400 1350" preserveAspectRatio="xMidYMid meet" aria-label="调防目的地大地图">'
      + '<image href="/__slg/strategy/panorama.png" x="0" y="0" width="2400" height="1350"'
      + ' preserveAspectRatio="none" opacity=".62"/>'
      + '<rect x="0" y="0" width="2400" height="1350" fill="#10150f" opacity=".18"/>'
      + lines + pins + mark + '</svg>';
  }

  function openDispatchDialog() {
    var prev = Number(ui.dispatchTo) || 0;
    var old = document.getElementById('slgDispatchMask');
    if (old) old.remove();
    var cities = ((data.strategy || {}).cities || []).filter(function (c) {
      return c.owner === 'player' && Number(c.id);
    });
    var mask = document.createElement('div');
    mask.id = 'slgDispatchMask';
    mask.innerHTML = '<div id="slgDispatchDlg">'
      + '<div class="dhead"><b>批量调防 · 选择目的城市</b><span class="x" data-close="1" title="关闭">✕</span></div>'
      + '<div class="dsearch"><input data-role="query" type="search" placeholder="按城名 / 州郡 / 今地找城，如 长安 / 司隶 / 陕西"'
      + ' autocomplete="off"/></div>'
      + '<div class="dbody"><div class="dcities" data-role="cities"></div>'
      + '<div class="dmap" data-role="map"></div></div>'
      + '<div class="dfoot"><span class="dest" data-role="dest"></span>'
      + '<button class="btn" data-act="dispatchDlgCancel">取消</button>'
      + '<button class="btn" data-act="dispatchDlgOk">确认调防</button></div></div>';
    document.body.appendChild(mask);
    var query = '';
    function close(restore) {
      if (restore) { ui.dispatchTo = prev; persistUI(); }
      mask.remove();
      render();
    }
    var addrOf = function (c) { return [c.province, c.jun, c.today].filter(Boolean).join(' · '); };
    function pick(id) {
      ui.dispatchTo = Number(id) || 0;
      persistUI();
      paint();
      if (ui.dispatchTo && window.__slgMapPreviewCity) window.__slgMapPreviewCity(ui.dispatchTo);
    }
    function paint() {
      var box = mask.querySelector('[data-role="cities"]');
      var q = String(query || '').trim();
      var shown = cities.filter(function (c) {
        if (!q) return true;
        return (c.name + addrOf(c)).indexOf(q) >= 0;
      });
      box.innerHTML = (shown.length ? shown : cities).map(function (c) {
        var on = Number(c.id) === Number(ui.dispatchTo);
        return '<button class="dcity' + (on ? ' on' : '') + '" data-city="' + c.id + '">'
          + (on ? '◉ ' : '○ ') + esc(c.name)
          + '<span class="addr">' + esc(addrOf(c) || '—') + '</span>'
          + '<span class="garrison">驻军 ' + fmt(c.garrison || c.troops || 0) + '</span></button>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.dcity'), function (b) {
        b.onclick = function () { pick(b.getAttribute('data-city')); };
      });
      var mapEl = mask.querySelector('[data-role="map"]');
      mapEl.innerHTML = dispatchMapSvg(ui.dispatchTo);
      /* ★ P55：大地图上的城点真可点——只接受己方城作目的地，他城点给出中文说明。 */
      Array.prototype.forEach.call(mapEl.querySelectorAll('.dpin'), function (p) {
        p.onclick = function () {
          var cid = Number(p.getAttribute('data-city')) || 0;
          var c = cities.find(function (x) { return Number(x.id) === cid; });
          if (!c) return;
          if (c.owner !== 'player') return toast('只能调往己方城池：' + c.name, true);
          pick(cid);
        };
      });
      var d = cities.find(function (c) { return Number(c.id) === Number(ui.dispatchTo); });
      mask.querySelector('[data-role="dest"]').textContent = '已选 ' + ui.genPick.length + ' 人 → '
        + (d ? '目的城：' + d.name + '（' + (d.province || '—') + '）' : '请先选目的城市');
    }
    var queryEl = mask.querySelector('[data-role="query"]');
    if (queryEl) queryEl.addEventListener('input', function () { query = queryEl.value || ''; paint(); });
    mask.querySelector('[data-close]').onclick = function () { close(true); };
    mask.querySelector('[data-act="dispatchDlgCancel"]').onclick = function () { close(true); };
    mask.querySelector('[data-act="dispatchDlgOk"]').onclick = function () {
      var to = Number(ui.dispatchTo) || 0;
      if (!to) return toast('请先选目的城市', true);
      if (!ui.genPick.length) return toast('请先勾选要调遣的武将', true);
      mask.remove();
      render();
      return strategyAction({ action: 'dispatchGenerals', generalIds: ui.genPick.slice(), toCityId: to },
        function (r) { if (r.ok) { ui.genPick = []; persistUI(); render(); } });
    };
    mask.onclick = function (e) { if (e.target === mask) close(true); };
    paint();
    if (ui.dispatchTo && window.__slgMapPreviewCity) window.__slgMapPreviewCity(ui.dispatchTo);
  }

  /* 旧 genAttrHtml 已删除：五维只在人物卡显示，原状态信息由 heroStateHtml 承接。 */

  /* ★ U15 相性与关系网：相性/义理是「本作设定」派生值，关系逐条标演义回目。
     不用纯列表：亲爱/君臣/敌对分组 + 连线感的色带，悬停看注。 */
  function relationCardHtml(g) {
    var r = g.relations || { sworn: [], lord: [], rival: [], note: '' };
    var chip = function (b, tone) {
      var color = tone === 'rival' ? '#e07a5f' : tone === 'lord' ? '#8fb3d9' : '#9ec97f';
      return '<span title="' + esc(b.type + '：' + b.note + '（' + (b.source || '') + '）') + '" '
        + 'style="display:inline-block;margin:2px 6px 2px 0;padding:1px 6px;border:1px solid ' + color
        + ';border-radius:9px;font-size:12px;color:' + color + '">' + esc(b.name)
        + '<span class="muted" style="color:#8a8f99"> ' + esc(b.type) + '</span></span>';
    };
    var group = function (label, list, tone) {
      if (!list || !list.length) return '';
      return '<div style="margin-top:6px"><span class="k">' + label + '</span><br>'
        + list.map(function (b) { return chip(b, tone); }).join('') + '</div>';
    };
    var xxHtml = g.xiangxing != null
      ? '<div class="grid" style="margin-bottom:6px">'
        + '<div><span class="k">相性</span> <span class="v">' + esc(g.xiangxing) + '</span>'
        + '<span class="muted"> / 149 环形 · 本作设定</span></div>'
        + '<div><span class="k">义理</span> <span class="v">' + esc(g.yili) + '</span>'
        + '<span class="muted"> / 100 · 由史载政治/魅力折算</span></div></div>'
      : '';
    return '<div class="card"><h3>相性与关系</h3>' + xxHtml
      + group('亲爱 / 亲族 / 师徒', r.sworn, 'sworn')
      + group('君臣', r.lord, 'lord')
      + group('敌对 / 宿怨', r.rival, 'rival')
      + '<div class="muted" style="margin-top:8px">' + esc(r.note || '')
      + '相性影响登庸与忠诚判定，但不是唯一参数；本项为本作设定值，并非史实数据。</div></div>';
  }

  /* ★ P58：装配目标槽 = 已开启且还空着的第一槽（学习 → 觉醒）。
     旧实现永远发 pos=1，「学习槽已满、觉醒槽空着」时会反把已学会的战法顶掉；
     两个槽都没开时按钮照发，玩家点了只得到一句失败提示，看不到缺什么。 */
  function skillTargetSlot(g) {
    var empty = [], filled = [], locked = [];
    [1, 2].forEach(function (pos) {
      var s = (g.slots || [])[pos] || {};
      var un = s.unlock || {};
      if (!un.open) { locked.push(pos); return; }
      if (s.skill) filled.push(pos); else empty.push(pos);
    });
    var name = ['自带', '学习', '觉醒'];
    if (empty.length) return { pos: empty[0], note: '', locked: locked, filled: filled };
    var note;
    if (filled.length && locked.length) {
      note = name[filled[0]] + '槽已有战法，' + name[locked[0]] + '槽还没开（' + ((g.slots || [])[locked[0]] || {}).lockText + '）';
    } else if (filled.length) note = '学习槽和觉醒槽都已有战法，先卸下一个';
    else {
      note = locked.map(function (pos) {
        return name[pos] + '槽 ' + (((g.slots || [])[pos] || {}).lockText || '未开启');
      }).join('；');
    }
    return { pos: -1, note: note, locked: locked, filled: filled };
  }

  function genSkillHtml(g) {
    var guide = (data.interior && data.interior.output && data.interior.output.guide) || {};
    var slotName = ['自带', '学习', '觉醒'];
    var out = '<h3>战法 · ' + esc(g.name) + '</h3>'
      + '<div class="card"><div class="muted">自带槽入营就有，不能换成别的战法，在这里升级。'
      + '学习槽要武将 5 级。觉醒槽要武将 10 级，并且自带战法升到 10 级。'
      + '每条战法的装配名额有限（1~6 人，以战法档案为准）。当前军工 <b class="v">' + fmt(guide.jungong || 0) + '</b>。'      + esc(guide.rule || '') + '</div></div>';
    g.slots.forEach(function (s) {
      var un = s.unlock || { open: true, text: '', short: '' };
      out += '<div class="card"><span class="tag ' + (s.skill ? 'ok' : un.open ? 'mid' : 'no') + '">'
        + slotName[s.pos] + '槽</span>'
        + '<span class="tag ' + (un.open ? 'ok' : 'no') + '">' + (un.open ? '已开启' : '未开启') + '</span>';
      if (s.skill) {
        out += '<b class="v">' + esc(s.skill.name) + '</b> <span class="muted">Lv' + esc(s.skill.level)
          + ' · 发动率 ' + esc(s.skill.probability == null ? '—' : s.skill.probability + '%') + '</span>'
          + '<div style="margin-top:6px">' + esc(s.skill.des || '没有效果说明') + '</div>';
        if (s.skill.maxed) {
          out += '<div class="muted" style="margin-top:6px">已满 10 级</div>';
        } else {
          out += '<div class="muted" style="margin-top:6px">下一级：' + esc(s.skill.nextDes || '没有效果说明') + '</div>';
          if (s.skill.upgradeBlock) {
            out += '<div class="muted" style="margin-top:6px">' + esc(s.skill.upgradeBlock)
              + '。这一级要军工 ' + esc(s.skill.upgradeCost) + '。</div>';
          } else {
            out += '<button class="btn" data-act="lvskill" data-gid="' + g.id + '" data-pos="' + s.pos + '">'
              + '升级到 Lv' + (Number(s.skill.level) + 1) + '（军工 ' + esc(s.skill.upgradeCost) + '）</button>';
          }
        }
        /* 学习/觉醒槽可以腾出来换别的战法；自带槽不能卸。 */
        if (s.pos > 0) {
          out += '<button class="btn warn" data-act="unskill" data-gid="' + g.id + '" data-pos="' + s.pos + '">'
            + '卸下此槽</button>';
        }
      } else {
        out += '<span class="muted">空槽位</span>';
      }
      /* ★ P58：解锁条件必须每个槽都写出来（开着也写，玩家才知道下一步能干什么）。 */
      out += '<div class="muted" style="margin-top:6px">解锁条件：'
        + esc(un.text || '—')
        + (un.open ? '' : '（现在 Lv' + esc(g.level) + '）') + '</div>';
      out += '</div>';
    });
    var tgt = skillTargetSlot(g);
    var unlocked = data.library.filter(function (x) { return x.status === 'unlocked'; }).slice(0, 8);
    out += '<div class="card"><h3>装配已解锁战法</h3><div class="muted" style="margin-bottom:8px">'
      + (tgt.pos > 0
        ? '装到' + slotName[tgt.pos] + '槽。'
        : '当前没有可用的空槽：' + esc(tgt.note) + '。')
      + '槽位规则：自带不可替换、Lv5 开学习槽、Lv10 且自带 10 级开觉醒槽；每条战法的装配名额有限（1~6 人，以战法档案为准）。</div>';
    if (!unlocked.length) out += '<div class="muted">还没有已解锁的战法，先到战法库研习。</div>';
    unlocked.forEach(function (s) {
      out += '<div class="card"><b class="v">' + esc(s.name) + '</b>'
        + '<div style="margin-top:6px">' + esc(s.des || '没有效果说明') + '</div>'
        + (tgt.pos > 0
          ? '<button class="btn" data-act="learn" data-gid="' + g.id + '" data-pos="' + tgt.pos
            + '" data-cfg="' + s.cfgId + '">' + esc(s.name) + ' → ' + slotName[tgt.pos] + '槽</button>'
          : '<button class="btn" disabled title="' + esc(tgt.note) + '">装不上 · ' + esc(tgt.note) + '</button>')
        + '</div>';
    });
    out += '<div style="margin-top:8px"><button class="btn" data-act="tab" data-id="library">去战法库看全部 '
      + data.library.length + ' 条</button></div></div>';
    return out;
  }

  function equipSlotsHtml(g, withForge) {
    var out = '<h3>兵刃四槽 · ' + esc(g.name) + '</h3><div class="grid">';
    data.slots.forEach(function (sl) {
      var worn = g.equipment[sl.id];
      out += '<div class="card"><span class="tag">' + esc(sl.name) + '</span>';
      if (worn) {
        out += '<b class="v">' + esc(worn.name) + '</b><div class="muted" style="margin:5px 0">特性：' + esc(worn.trait) + '</div>'
          + '<div class="muted">典故：' + esc(worn.set) + ' · 加成 ' + esc(statBonusText(worn.bonusPct)) + '</div>'
          + '<button class="btn warn" data-act="unequip" data-gid="' + g.id + '" data-slot="' + sl.id + '">卸下（无消耗）</button>';
      } else out += '<span class="muted">未佩戴</span>';
      var candidates = data.items.filter(function (i) { return i.slot === sl.id && !i.ownerGeneralId; });
      if (candidates.length) {
        out += '<div style="margin-top:8px"><div class="muted">府库候选（换装 delta 预览）：</div>';
        candidates.slice(0, 6).forEach(function (i) {
          var delta = Object.keys(i.bonusPct || {}).map(function (k) {
            return data.statLabels[k] + ' +' + Math.round((g.base[k] || 0) * i.bonusPct[k] / 100);
          }).join('、');
          out += '<div class="muted" style="font-size:12px">· ' + esc(i.name) + ' → ' + esc(delta || '机制型') + '</div>'
            + '<button class="btn" data-act="equip" data-gid="' + g.id + '" data-slot="' + sl.id
            + '" data-item="' + i.id + '">穿戴 ' + esc(i.name) + '</button>';
        });
        out += '</div>';
      } else out += '<div class="muted" style="margin-top:8px">府库无此槽装备，可到下方锻造。</div>';
      out += '</div>';
    });
    out += '</div><div class="card"><b>穿戴规则</b><div class="muted">'
      + '单件 ≤8%、全套 ≤25%；特性只改时机／目标／条件，不改伤害率。禁止随机词条、强化失败、洗练、无视／免疫、绑定不可卸。</div></div>';
    if (withForge) {
      out += '<div class="card"><h3>锻造（100% 成功 · 词条固定可预览）</h3><div class="muted" style="margin-bottom:8px">'
        + '全库 ' + (data.forgeCatalog || []).length + ' 件配方开局公开；图纸不明码售卖，材料来自资源与名城拾遗。</div><div class="grid">';
      (data.forgeCatalog || []).forEach(function (i) {
        out += '<div style="margin-bottom:6px"><b class="v">' + esc(i.name) + '</b> <span class="muted">'
          + esc(i.slotName) + ' · ' + esc(i.trait) + '</span><br><span class="muted">'
          + esc(costText(i.forge.cost)) + '</span> <button class="btn" data-act="forge" data-cfg="'
          + i.id + '">锻造</button></div>';
      });
      out += '</div></div>';
    }
    return out;
  }

  function genStoryHtml(g) {
    var l = g.lore, m = g.merits;
    var nextRank = g.nextRankMerit != null ? (' · 距下一阶还需功勋 ' + fmt(Math.max(0, g.nextRankMerit - g.merit))) : ' · 已至极品';
    var out = '<h3>经历 · ' + esc(g.name) + '</h3><div class="card"><h3>本局战功簿</h3>'
      + '官阶 <b class="v">' + esc(g.rankName || '白身') + '</b> · 功勋 ' + fmt(g.merit)
      + nextRank
      + '<div class="muted" style="margin-top:6px">立功升官：武将统帅随官阶提升，谋臣政治家政治提升。功勋来自出征、攻城、守土与治政。</div>'
      + '<div style="margin-top:8px">参战 ' + esc(m.battles) + ' 次 · 战功 ' + esc(m.merits) + ' · 守城 ' + esc(m.defense)
      + ' · 以少胜多 ' + esc(m.upset) + '<div class="muted" style="margin-top:6px">战功回流兵书残卷，用于战法研习。</div></div></div>';
    if (l) {
      out += '<div class="card"><h3>履历</h3>' + esc(l.brief)
        + '<div class="muted" style="margin-top:8px">' + esc(l.deeds) + '</div></div>'
        + '<div class="card"><h3>演义形象</h3>' + esc(l.romance) + '</div>'
        + '<div class="card"><h3>关系</h3><span class="muted">并肩／结怨关系见演义既有网络；当前不影响数值。</span></div>';
    } else {
      out += '<div class="card muted">本局穿越者，史无明载；本局画像由章节事件逐步写入。</div>';
    }
    return out;
  }

  /* ★ 2026-11-21 阵前俘虏重做：独立表格 + 三个明确出口。
     旧版把按钮塞在 218px 左栏，且按钮只带 data-i（点击处理器读 data-id），
     于是多个俘虏时全部作用在索引 0——这就是「点谁都像在同一个人身上操作」的失真源。 */
  function captivePanelHtml() {
    var list = data.captives || [];
    if (!list.length) return '';
    var rateText = function (c) {
      var parts = (c.rateParts && c.rateParts.parts || []).map(function (p) {
        return p.label + ' ' + p.value + '%';
      }).join('，');
      return '<span class="rate">' + c.rate + '%</span>'
        + '<div class="muted" style="font-size:11px">' + esc(parts || '按关押旬数与君主政治结算') + '</div>';
    };
    return '<div class="card capPanel" id="slgCaptivePanel"><h3>阵前俘虏 · 处置（' + list.length + ' 人）</h3>'
      + '<div class="muted" style="margin-bottom:8px">这里只列战报确认擒获的守将。战报没有记录原属势力，界面不猜测；'
      + '「被俘地点」是实际发生战斗的位置。招降花 300 金，失败忠诚 −10（降到 0 以下会越狱）；放归与处斩会影响名望和诸势力态度。</div>'
      + '<table><thead><tr><th>俘虏</th><th>被俘地点</th><th>关押</th><th>忠诚</th><th>招降把握</th><th>处置</th></tr></thead><tbody>'
      + list.map(function (c) {
        var loyalColor = c.loyal >= 70 ? '#9ec97f' : c.loyal >= 40 ? '#d8b45a' : '#e07a5f';
        return '<tr><td><b class="v">' + esc(c.name) + '</b>'
          + '<div class="muted" style="font-size:11px">' + esc('★'.repeat(Math.max(0, Math.min(5, Number(c.star) || 0))))
          + ' ' + esc(c.careerName || '干才') + (c.top ? ' · 长于' + esc(c.top) : '') + '</div></td>'
          + '<td>' + esc(c.from || '战报未记') + '</td>'
          + '<td>' + esc(c.days) + ' 旬<div class="muted" style="font-size:11px">第 ' + esc(c.day || '—') + ' 日入押</div></td>'
          + '<td><b style="color:' + loyalColor + '">' + esc(c.loyal) + '</b></td>'
          + '<td>' + rateText(c) + '</td>'
          + '<td><button class="btn" data-act="captive" data-id="' + c.idx + '">招降（300 金）</button>'
          + '<button class="capbtn" data-act="captiveRelease" data-id="' + c.idx + '">放归</button> '
          + '<button class="capbtn danger" data-act="captiveExecute" data-id="' + c.idx + '">处斩</button></td></tr>';
      }).join('')
      + '</tbody></table></div>';
  }

  function viewGeneral() {
    var prospect = ui.genId < 0 ? data.prospects[-ui.genId - 1] : null;
    var body;
    if (prospect) {
      var rateRows = (prospect.recruitParts || []).map(function (p) {
        return '<tr><td>' + esc(p.label) + '</td><td class="v">' + (p.value > 0 ? '+' : '') + p.value + '%</td></tr>';
      }).join('');
      var pCard = {
        cfgId: prospect.cfgId, name: prospect.name, camp: 0, star: 0,
        level: '—', careerName: '在野名士', state: '在野', cityName: '',
        isProtagonist: false,
        lore: {
          historyStats: prospect.historyStats, zi: prospect.zi,
          hometown: prospect.faction, era: '在野', brief: prospect.brief,
        },
      };
      body = heroCardHtml(pCard)
        + '<h3>在野名士 · ' + esc(prospect.name)
        + '<span class="muted" style="font-weight:normal;font-size:11px;margin-left:8px">史载五维 0~100；招贤后即为本局战斗数值（同一 0~100 口径）</span></h3><div class="card">'
        + '<div class="grid">' + ['统率', '武力', '智力', '政治', '魅力'].map(function (s) {
          return '<div><span class="k">' + s + '</span> <span class="v">' + esc(prospect.historyStats[s]) + '</span></div>';
        }).join('') + '</div><div style="margin-top:8px">字 ' + esc(prospect.zi) + ' · 势力 ' + esc(prospect.faction)
        + ' · 相性 ' + esc(prospect.xiangxing) + '（差 ' + esc(prospect.xiangxingGap) + '）· 义理 ' + esc(prospect.yili)
        + '</div><div style="margin-top:6px">' + esc(prospect.brief) + '</div></div>'
        + '<div class="card"><h3>登庸成功率构成（' + esc(prospect.recruitRate) + '%）</h3>'
        + '<table><thead><tr><th>加成项</th><th>百分点</th></tr></thead><tbody>' + rateRows + '</tbody></table>'
        + '<div class="muted">各项相加即为成功率；被拒后再次登门（三顾之礼）+12%/次。'
        + '相性差越小越容易，义理越高越难挖——这就是「为什么这人挖不动」的答案。</div></div>'
        + '<div class="muted">在野武将仅可预览；招贤请到酒馆。师承不需要把他招进帐下也能学战法。</div>';
    } else {
      var g = currentGeneral();
      if (!g) return '<div class="muted">暂无武将</div>';
      var tabs = [['skill', '战法'], ['equip', '兵刃'], ['story', '经历']];
      if (!tabs.some(function (t) { return t[0] === ui.genTab; })) ui.genTab = 'skill';
      body = heroCardHtml(g)
        + captivePanelHtml()
        + '<div class="tabs">' + tabs.map(function (t) {
        return '<button class="' + (ui.genTab === t[0] ? 'on' : '') + '" data-act="gtab" data-id="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div>';
      if (ui.genTab === 'skill') body += genSkillHtml(g);
      else if (ui.genTab === 'equip') body += equipSlotsHtml(g, false);
      else body += genStoryHtml(g);
    }
    return '<div class="cols">' + genListHtml() + '<div class="right">' + body + '</div></div>';
  }

  function viewStrategy() {
    var s = data.strategy;
    var out = '<h3>国势 · 第 ' + data.month + ' 月（游戏日 ' + data.day + '）</h3><div class="grid">'
      + [['我方城池', s.cityCount + ' / ' + s.totalCities], ['在编兵力', fmt(s.soldiers)],
         ['帐下武将', s.generalCount + ' / ' + s.generalCapacity
           + (s.generalCount >= s.generalCapacity ? '（已满，扩城才收得下）' : '')],
         ['旬俸合计', fmt(s.salaryDue) + ' 金/旬'],
         ['可出征邻城', (s.marchable ? s.marchable.length : 0) + ' 座'],
         ['章节进度', '第 ' + s.chapter + ' 章' + (s.ending ? ' · ' + esc(s.ending) : '')]].map(function (p) {
        return '<div class="card"><span class="k">' + p[0] + '</span><div class="v" style="font-size:19px">' + p[1] + '</div></div>';
      }).join('') + '</div>';

    /* ★ 2026-11-20：里程碑进度条。旧版 18 城之后玩家没有任何新锚点，
       一路只剩「继续打」；现在把 4 个阶段 + 一统线全部明写，并标出还差几城。 */
    if (s.stages && s.stages.length) {
      var ng = s.nextStage || {};
      out += '<div class="card"><h3>霸业进程'
        + (s.sandboxEnding ? '　<b style="color:#9ec97f">已达成「' + esc(s.endingTitle || '天下一统') + '」</b>'
          + '（第 ' + fmt(s.sandboxEnding.day) + ' 日 · ' + fmt(s.sandboxEnding.cities) + ' 城）' : '')
        + '</h3><div class="muted" style="margin-bottom:8px">'
        + (s.sandboxEnding ? '阶段称帝已记录；真正的终局是「四海归一」。'
          : '下一目标：<b>' + esc(ng.title || '—') + '</b>（还差 ' + fmt(ng.need == null ? 0 : ng.need) + ' 城）　' + esc(ng.hint || ''))
        + '　称帝线 ' + fmt(s.unifyCities) + ' 城　终局线 ' + fmt(s.grandEndingCities || 30) + ' 城</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
        + s.stages.map(function (st) {
          return '<span class="winTag" style="opacity:' + (st.done ? 1 : 0.55) + '">'
            + (st.done ? '✓ ' : '') + esc(st.title) + ' ' + st.at + ' 城'
            + (st.done && st.day ? '（第' + fmt(st.day) + '日）' : '') + '</span>';
        }).join('')
        + '</div></div>';
    }
    /* ★ P61-S6：真正的终局史评——唯一真源 grandEnding；24 城「称帝」只是阶段。 */
    if (s.grandEnding) {
      out += '<div class="card" style="border-color:#e8c670"><h3>终局 · ' + esc(s.grandEnding.title) + '</h3>'
        + '<div style="line-height:1.8;margin-bottom:8px">' + esc(s.grandEnding.history || s.grandEnding.hint || '') + '</div>'
        + '<div class="muted" style="font-size:11px;margin-bottom:8px">关键抉择：'
        + ((s.grandEnding.decisions || []).length
          ? esc((s.grandEnding.decisions || []).join('；')) : '此局未有载入史册的大事') + '</div>'
        + '<div class="muted" style="font-size:11px;margin-bottom:8px">终局线 '
        + fmt(s.grandEndingCities || 30) + ' 城 · 达成于第 ' + fmt(s.grandEnding.day) + ' 日</div>'
        + (s.endGameFrozen
          ? '<button class="btn" data-act="continueSandbox">继续沙盘（保留史评，解除回合冻结）</button>'
          : '<span class="tag ok">已选择继续沙盘，史评保留</span>')
        + '</div>';
    }

    /* ★ P47#14：两处都读 state.roleRes（全局府库），不是逐城 cityEcon；
       旧文案不写口径，玩家把这里和城内页不同的刷新时点误认成「资源丢失」。 */
    out += '<div class="card"><h3>资源与产出</h3>'
      + '<div class="muted" style="font-size:11px;line-height:1.6;margin:-2px 0 6px">'
      + '库存为全局府库（全部城池共用），日产为全局日产；与城内页同一份账，仅刷新时点可能相差一瞬。</div>'
      + '<table><thead><tr><th>资源</th><th>库存</th><th>日产</th><th>府库上限</th></tr></thead><tbody>'
      + data.interior.output.resources.map(function (r) {
        return '<tr><td>' + esc(r.label) + '</td><td class="v">' + fmt(r.stock) + '</td><td>+' + fmt(r.yield)
          + '</td><td class="muted">' + (r.capacity ? fmt(r.capacity) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    out += '<div class="card"><h3>目标推演（只给数据，不替你决定）</h3>'
      + '<label class="muted">选择目标城（全 ' + s.cities.length + ' 城）：</label><select data-act="citypick">'
      + s.cities.map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === ui.selectedCity ? ' selected' : '') + '>'
          + esc(c.name) + '（' + esc(c.province) + ' Lv' + esc(c.level) + ' · '
          + esc(c.ownerName || c.owner) + (c.reachable ? ' · 可达' : '') + '）</option>';
      }).join('') + '</select>';
    var c = s.cities.find(function (x) { return x.id === ui.selectedCity; }) || s.cities[0];
    if (c) {
      var mine = s.soldiers, est = c.troops != null ? c.troops : c.garrison;
      var win = !c.reachable ? '道路不通 / 关隘封锁'
        : c.owner === 'player' ? '我军城池'
        : mine > est * 1.35 ? '较有把握' : mine > est * 0.9 ? '胜负参半' : '不宜轻进';
      out += '<div class="grid" style="margin-top:10px">'
        + '<div class="card"><span class="k">守军（沙盘实时）</span><div class="v">' + fmt(est) + '</div></div>'
        + '<div class="card"><span class="k">我军可出</span><div class="v">' + fmt(mine) + '</div></div>'
        + '<div class="card"><span class="k">胜算</span><div class="v">' + win + '</div></div>'
        + '<div class="card"><span class="k">归属 / 行军</span><div class="v">'
        + esc(c.ownerName || c.owner) + ' / ' + (c.reachable ? '可达' : '不可达') + '</div></div>'
        + '<div class="card"><span class="k">农业 / 商业 / 城防</span><div class="v">'
        + esc(c.agriculture) + ' / ' + esc(c.commerce) + ' / '
        + esc(c.cityDef != null ? c.cityDef : c.defense) + '</div></div>'
        + '<div class="card"><span class="k">地形 / 特产</span><div class="v">'
        + esc(c.terrain || '—') + ' / ' + esc(c.specialty || '—') + '</div></div></div>'
        + '<div class="muted" style="margin-top:8px">' + esc(c.note) + '。实际胜负由确定性战斗内核裁定。</div>';
    }
    out += '<div style="margin-top:10px">'
      + '<button class="btn" data-act="openwar">打开出征面板</button> '
      /* ★ 2026-11-20：外交视图本来就在出征窗第 5 个页签里，功能齐全但玩家找不到。
         这里给一个直达入口——不做新面板、不改协议，只复用 __slgWarWindow({tab:'diplo'})。 */
      + '<button class="btn" data-act="diplomacy">外交 · 诸侯态度</button> '
      + '<button class="btn" data-act="gotostrategy">打开天下沙盘</button></div></div>';

    // ★ P2/P3 城池经营：人口/逐城产出/城库/灾害 + 运粮入口
    var mineCities = (s.cities || []).filter(function (c) { return c.owner === 'player'; });
    if (mineCities.length) {
      out += '<div class="card"><h3>城池经营（' + mineCities.length + ' 城）</h3><table><thead><tr>'
        + '<th>城池</th><th>人口</th><th>粮产/日</th><th>金产/日</th><th>城库存粮</th><th>状态</th><th>运粮</th></tr></thead><tbody>'
        + mineCities.map(function (c) {
          var status = c.disaster && c.disaster.name
            ? (c.disaster.name === '丰收' ? '<span class="up">' + esc(c.disaster.name) + '</span>' : '<span class="tag no">' + esc(c.disaster.name) + '</span>')
            : (c.modLabel ? '<span class="' + (c.modLabel === '丰产中' ? 'up' : 'tag no') + '">' + esc(c.modLabel) + '</span>' : '<span class="muted">安定</span>');
          return '<tr><td>' + esc(c.name) + '</td><td class="v">' + fmt(c.pop || 0) + '</td>'
            + '<td>+' + fmt(c.yieldGrain || 0) + '</td><td>+' + fmt(c.yieldGold || 0) + '</td>'
            + '<td class="v">' + fmt(c.store || 0) + '</td><td>' + status + '</td>'
            + '<td><button class="btn" data-act="transport" data-id="' + c.id + '">运粮</button></td></tr>';
        }).join('') + '</tbody></table>'
        + '<div class="muted">★ 行军粮优先从出发城城库扣（前线囤粮可省 25% 损耗）；蝗灾会蚀耗城库存粮——灾前把粮运走是保命操作。兵役按「一户一丁」计，每征 1 丁人口基数 −4，每旬只征一次；人口每 30 日自然增长。</div></div>';
    }
    // ★ P0 编队入口
    out += '<div class="card"><h3>队伍整编</h3>' + (s.armies || []).map(function (a) {
      var gs = (a.generals || []).map(function (g) {
        return g ? esc(g.name) + '<small>（' + esc(g.arms || '') + ' 适性' + g.apt + '% · 忠' + g.loyal + '）</small>' : '<span class="muted">空</span>';
      }).join('、');
      return '<div style="margin-bottom:8px"><b>队伍#' + a.order + '</b>' + (a.marching ? '<span class="tag no">行军中</span>' : '')
        + '<div>' + gs + '</div><div class="muted">兵力 ' + (a.soldiers || []).join(' / ') + '（盾步/弓兵/骑兵）</div>'
        + (a.marching ? '' : '<button class="btn" data-act="formup" data-id="' + a.id + '">整编</button>') + '</div>';
    }).join('')
      + '<div class="muted">出征走「出征」面板（沙盘顶部 / 六府·出征）：可选出发城、具体队伍与目标，'
      + '出兵前能看到实出人数与行军日数，出发后还能撤回。粮草按「出发城城库 → 府库+25%损耗」顺序扣。</div></div>';

    // 关隘与行军：直接复用战略层的 march.js 结果，和「出征」按钮走的是同一份校验
    var gates = s.gates || [];
    out += '<div class="card"><h3>关隘与行军（与出征校验同一份规则）</h3>';
    out += gates.length ? '<div class="grid">' + gates.map(function (g) {
      var blocked = String(g.status) === '封锁' || g.status === 'blocked' || g.status === false;
      return '<div><span class="k">' + esc(g.name) + '</span> '
        + '<span class="tag ' + (blocked ? 'no' : 'ok') + '">' + esc(blocked ? '封锁' : '通行') + '</span></div>';
    }).join('') + '</div>' : '<div class="muted">当前行军图无关隘数据。</div>';
    var marchNames = (s.marchable || []).map(function (cid) {
      var row = (data.strategy.cities || []).find(function (c) { return String(c.id) === String(cid); });
      return row ? row.name : ('城' + cid);
    });
    out += '<div class="muted" style="margin-top:6px">本城可出征 '
      + marchNames.length + ' 座：' + esc(marchNames.join('、') || '暂无') + '</div></div>';

    // 诸侯战役意图：读战略层决策脑锁定的目标，不自己改写
    var plans = s.plans || [];
    out += '<div class="card"><h3>诸侯战役意图（决策脑锁定目标）</h3>';
    out += plans.length ? plans.map(function (p) {
      return '<div class="src"><b>' + esc(p.name) + '</b> <span class="tag mid">' + esc(p.type) + '</span>'
        + ' 目标 ' + esc(p.targetName || '—')
        + (p.lockedUntil ? '（锁至第 ' + esc(p.lockedUntil) + ' 月）' : '')
        + '<div class="muted">' + esc(p.reason || '') + '</div></div>';
    }).join('') : '<div class="muted">诸侯尚未锁定战役目标，推演一月后可见。</div></div>';

    // 出征账：战略层结算的粮饷 / 马料流水
    var books = s.books || [];
    out += '<div class="card"><h3>出征账（粮饷 / 马料）</h3>';
    out += books.length ? books.map(function (b) {
      return '<h4>第 ' + esc(b.month != null ? Number(b.month) : '?') + ' 月</h4>'
        + '<table><thead><tr><th>势力</th><th>田赋粮 / 金</th><th>征兵粮</th><th>出征粮 / 金</th><th>战马</th></tr></thead><tbody>'
        + (b.rows || []).map(function (r) {
          return '<tr><td>' + esc(r.name) + '</td><td>' + fmt(r.grainIn) + ' / ' + fmt(r.goldIn)
            + '</td><td>' + fmt(r.grainRecruit) + '</td><td>' + fmt(r.grainMarch) + ' / '
            + fmt(r.goldMarch) + '</td><td>' + fmt(r.horses) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).join('') : '<div class="muted">暂无出征账，推演一月后由战略层结算。</div></div>';

    out += '<div class="card"><h3>边境威胁</h3>';
    out += s.threats.length ? s.threats.map(function (t) {
      var siegeTxt = '';
      if (t.besieging) {
        siegeTxt = '　<b style="color:#e07a5f">正在围' + esc(t.targetName || '城') + '</b>'
          + '（民心 ' + fmt(t.targetMorale == null ? 0 : t.targetMorale) + '，民心≤20 即开城）';
      } else if (t.daysToSiege > 0) {
        siegeTxt = '　' + (t.targetName ? '兵锋指向 ' + esc(t.targetName) + '，' : '')
          + '约 ' + t.daysToSiege + ' 日后开始围城';
      } else if (t.targetName) {
        siegeTxt = '　兵锋指向 ' + esc(t.targetName);
      }
      return '<div>· ' + esc(t.name || '来犯军') + '　兵 ' + fmt(t.soldiers || 0)
        + (t.faction ? '　来自 ' + esc(t.faction) : '') + (t.patrol ? '　巡弋中' : '') + siegeTxt + '</div>';
    }).join('') : '<div class="muted">当前无来犯军。</div>';
    out += '<div class="muted" style="margin-top:6px">围城 40 日后开始掉守军与民心，民心崩到 20 以内城内开门；'
      + '180 日仍不破则客军粮尽自退。清剿请到「本城 → 军情」；盟约与背盟预警以天下沙盘为准。</div></div>';

    /* ★ 2026-11-20：势力动态独立成栏。NPC 官阶晋升/学艺/登庸属于「世界在动」，
       不再挤占上面的军情流（旧版 150 旬 480 条事件里大半是这类背景音）。 */
    var dyn = s.dynamics || [];
    if (dyn.length) {
      out += '<div class="card"><h3>势力动态 <span class="muted" style="font-size:12px">（近 ' + Math.min(dyn.length, 8) + ' 条 · 背景音，不影响你的决策）</span></h3>'
        + dyn.slice(-8).reverse().map(function (e) {
          return '<div class="muted">· 第' + esc(e.month) + '月　' + esc(e.text) + '</div>';
        }).join('') + '</div>';
    }

    // 优先显示战略层拟人月志（对方叙事层），未产出时回退旧事件流
    var monthLogs = (s.chronicle || []).length
      ? (s.chronicle || []).map(function (m) { return '<div>· ' + esc(m.text || '') + '</div>'; }).join('')
      : (s.events.length ? s.events.map(function (e) {
          return '<div>· 第 ' + esc(e.month || (e.turn != null ? Math.max(1, e.turn) : '?')) + '月 '
            + esc(e.text) + '</div>';
        }).join('') : '<div class="muted">暂无事件</div>');
    out += '<div class="card"><h3>近月天下日志（战略层拟人月志）</h3>' + monthLogs + '</div>';

    out += '<div class="card"><h3>最近战报</h3>' + (s.recentReports.length ? s.recentReports.map(function (r, i) {
      return '<div class="src"><b>' + esc(r.summary || r.title || ('战报 ' + (i + 1))) + '</b>'
        + '<div class="muted">' + esc(r.analysis || '') + '</div></div>';
    }).join('') : '<div class="muted">暂无战报，出征后在此复盘。</div>') + '</div>';

    out += '<div class="card muted">' + esc(s.note) + '</div>';
    return out;
  }

  function viewInterior() {
    var it = data.interior, out = '';
    var guide = it.output.guide || {};
    out += '<h3>内政委任台</h3><div class="card"><h3>资源流水线</h3>'
      + '<div class="muted" style="margin-bottom:8px">' + esc(guide.rule || '') + '</div><table><thead><tr>'
      + '<th>资源</th><th>库存</th><th>用途</th><th>基础产量</th><th>委任加成</th><th>府库上限</th><th>满仓预警</th></tr></thead><tbody>'
      + it.output.resources.map(function (r) {
        var full = r.full || (r.capacity && r.stock >= r.capacity);
        var eff = Math.floor((r.yield || 0) * (1 + (r.bonusPct || 0) / 100));
        return '<tr><td>' + esc(r.label) + '</td><td class="v">' + fmt(r.stock) + '</td>'
          + '<td class="muted">' + esc(r.use || '') + '</td><td>+' + fmt(r.yield)
          + '</td><td>' + (r.bonusPct ? '<span class="up">+' + r.bonusPct + '%（实际 +' + fmt(eff) + '）</span>'
            : '<span class="muted">—</span>') + '</td>'
          + '<td class="muted">' + (r.capacity ? fmt(r.capacity) : '—') + '</td><td>'
          + (full ? '<span class="tag no">已满仓，日产不再入库</span>' : '<span class="muted">正常</span>') + '</td></tr>';
      }).join('') + '</tbody></table>'
      + '<div class="muted">委任加成已计入每天入账。花掉库存的按钮在「府库」。</div></div>';

    /* ★ M4-12：生效设施与城池内页同源 —— 两处内政入口不再各说各话。
       协议侧已隐藏未参与结算的原版占位设施，这里把隐藏数量如实写明。 */
    var fac = it.facilities || { rows: [], hiddenCount: 0, allCount: 0 };
    out += '<div class="card"><h3>生效设施（与城池内页同源）</h3>'
      + '<div class="muted" style="margin-bottom:8px">仅列参与本版本结算或解锁玩法的设施'
      + (fac.hiddenCount ? '；另有 ' + fac.hiddenCount + ' 项原版占位设施未生效，已隐藏且不可升级' : '')
      + '。升级在城池内页「府库」办理。</div>'
      + (fac.rows.length
        ? '<table><thead><tr><th>设施</th><th>等级</th><th>实际作用</th></tr></thead><tbody>'
          + fac.rows.map(function (f) {
            return '<tr><td>' + esc(f.name) + '</td><td class="v">Lv' + esc(f.level) + '/' + esc(f.maxLevel)
              + '</td><td class="muted">' + esc(f.effectText) + '</td></tr>';
          }).join('') + '</tbody></table>'
        : '<div class="muted">本城暂无设施数据。</div>')
      + '</div>';

    out += '<div class="card"><h3>三条硬约束</h3><div class="grid">'
      + [['民心', it.constraints.morale.morale, '过低触发减产'], ['治安', it.constraints.order.order, '过低触发流寇'],
         ['腐败', it.constraints.corruption.corruption, '随城数上升，人事可压制']].map(function (p) {
        return '<div><span class="k">' + p[0] + '</span> <span class="v">' + esc(p[1]) + '</span>'
          + '<div class="muted">' + p[2] + '</div></div>';
      }).join('') + '</div></div>';

    /* ★ P3-01 / P11：六府·内政也要看得到逐城人口与兵役，不再与城池内页信息不对称 */
    var ownRows = (data.strategy.cities || []).filter(function (c) { return c.owner === 'player' && c.levy; });
    if (ownRows.length) {
      out += '<div class="card"><h3>户口与兵役（与城池内页同源）</h3><table><thead><tr>'
        + '<th>城池</th><th>人口</th><th>户数</th><th>适龄壮丁</th><th>已征</th><th>本旬可征</th></tr></thead><tbody>'
        + ownRows.map(function (c) {
          var v = c.levy;
          return '<tr><td>' + esc(c.name) + '</td><td class="v">' + fmt(v.pop) + '</td>'
            + '<td class="v">' + fmt(v.households) + '</td><td class="v">' + fmt(v.adultMales) + '</td>'
            + '<td class="v">' + fmt(v.levied) + '</td>'
            + '<td class="v">' + (v.quota > 0 ? '<span class="up">' + fmt(v.quota) + '</span>'
              : '<span class="tag no">' + esc(v.reasonText || '需先生息') + '</span>') + '</td></tr>';
        }).join('') + '</tbody></table>'
        + '<div class="muted">一户一丁、妇孺老弱免征；每城每旬只征一次。兵源耗尽先在城池内页办「劝课生息」。</div></div>';
    }

    /* ★ P50 太守制总览：每城太守/方针/在办一目了然，补任与改方针在城池内页办理。 */
    var govRows = data.strategy.governors || [];
    if (govRows.length) {
      out += '<h3>天下太守总览（内政全自动）</h3>'
        + '<div class="card" style="margin-bottom:8px"><div class="muted">每城由太守按方针逐旬自动办政（产出与亲手派单同源）；'
        + '任免太守与改方针到城池内页「太守 · 方针」卡办理。补任只填空缺：行军中、已任他城太守或已掌岗位者不参与。</div>'
        + '<button class="btn" style="margin-top:7px" data-act="governorAutoFill">一键补任空缺太守</button>'
        + '<table style="margin-top:8px"><thead><tr><th>城池</th><th>太守</th><th>方针</th><th>状态</th><th>在办</th></tr></thead><tbody>'
        + govRows.map(function (g) {
          var stTag = g.status === 'blocked'
            ? '<span class="tag no">暂停：' + esc(g.blockedReason || '缺金') + '</span>'
            : '<span class="tag ok">办政中 · ' + esc(g.policyLabel) + '</span>';
          return '<tr><td>' + esc(g.city) + '</td>'
            + '<td>' + (g.officer ? esc(g.officer) + '（' + esc(g.officerStat) + '）' : '<span class="muted">空缺 · 太守亲办 ×1.5</span>') + '</td>'
            + '<td>' + esc(g.policyLabel) + '</td>'
            + '<td>' + stTag + '</td>'
            + '<td>' + (g.active.length ? g.active.map(function (t) { return esc(t.label); }).join('、') : '<span class="muted">—</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    out += '<h3>岗位委任（换人 delta 实时预览）</h3>'
      + '<div class="card" style="margin-bottom:8px"><div class="muted">一键委任只补空缺：按该岗位对应属性挑最高的闲置武将；'
      + '在编/出征、军师、猛将和已在岗者不参与，同分看忠诚。已有任命不会被覆盖。</div>'
      + '<button class="btn" style="margin-top:7px" data-act="appointAll">一键委任空缺岗位</button></div><div class="grid">';
    it.posts.forEach(function (p) {
      var now = data.generals.find(function (g) { return g.id === p.generalId; });
      out += '<div class="card"><b class="v">' + esc(p.name) + '</b> <span class="muted">' + esc(p.desc) + '</span>'
        + '<div style="margin:6px 0">现任：<span class="v">' + esc(p.generalName || '空缺') + '</span></div>'
        + '<div>当前岗位加成：<span class="up">+' + esc(it.output.bonusPct[p.id] || 0) + '%</span> '
        + '<span class="muted">' + esc(POST_RES_LABEL[p.resource] || '资源产出') + '</span></div>'
        + '<div style="margin-top:8px"><select data-act="appoint" data-post="' + esc(p.id) + '">'
        + '<option value="0">— 撤任 —</option>'
        + data.generals.map(function (g) {
          // ★ P4：军师/猛将不上内政岗——下拉里直接禁用，选中也会被服务端拒绝
          var unfit = g.career === 'warrior' || g.career === 'strategist';
          return '<option value="' + g.id + '"' + (g.id === p.generalId ? ' selected' : '')
            + (unfit ? ' disabled' : '') + '>'
            + esc(g.name) + '（' + esc(g.careerName || '干才') + ' · ' + esc(g.state) + '）</option>';
        }).join('') + '</select></div>'
        + '<div class="muted" style="margin-top:6px">上限 30%，随城数递减；'
        + (now && now.state === '在编' ? '该武将出征中，收益已减半。' : '') + '</div></div>';
    });
    out += '</div><div class="card">' + esc(it.visibleRule) + '</div>';

    out += '<h3>本回合政令提案（三选一）</h3><div class="grid">';
    it.proposals.forEach(function (p) {
      var used = it.appliedThisTurn === p.id;
      out += '<div class="card"><b class="v">' + esc(p.name) + '</b><div style="margin:6px 0">'
        + esc(p.effect) + '</div><div class="muted">代价：' + esc(p.cost) + ' · 持续 ' + esc(p.turns) + ' 回合</div>'
        + '<button class="btn" data-act="proposal" data-id="' + esc(p.id) + '"'
        + (it.appliedThisTurn ? ' disabled' : '') + '>' + (used ? '本回合已颁行' : '颁行') + '</button></div>';
    });
    out += '</div><div class="muted">每回合只可颁行一张；提案按回合确定性轮换，无随机。</div>';
    return out;
  }

  function viewDepot() {
    var filters = [['all', '全部'], ['equip', '兵刃'], ['scroll', '兵书秘卷'], ['material', '材料'], ['relic', '信物']];
    var guide = (data.interior.output && data.interior.output.guide) || {};
    var out = '<h3>府库分类账</h3><div class="muted" style="margin-bottom:10px">'
      + esc(guide.brief || '')
      + ' 分类账里的兵刃/兵书按件堆叠、无格子限制；兵书残卷现存 <b class="v">' + esc(data.scrolls) + '</b> 卷。</div>'
      + '<div class="tabs">' + filters.map(function (f) {
        return '<button class="' + (ui.itemFilter === f[0] ? 'on' : '') + '" data-act="itemfilter" data-id="' + f[0] + '">' + f[1] + '</button>';
      }).join('') + '</div>';

    var list = data.items.filter(function (i) { return ui.itemFilter === 'all' || i.kind === ui.itemFilter; });
    var fullNames = (data.interior.output.resources || []).filter(function (r) { return r.full; }).map(function (r) { return r.label; });
    out += '<div class="card"><h3>资源：库存 / 日产 / 用途 / 上限</h3>'
      + '<div class="muted" style="margin-bottom:8px">' + esc(guide.rule || '') + '</div>'
      + (fullNames.length ? '<div class="muted" style="color:#e07a5f;margin-bottom:8px">已满仓，日产不再入库：' + esc(fullNames.join('、')) + '</div>' : '')
      + '<table><thead><tr><th>资源</th><th>库存</th><th>日产</th><th>用途</th><th>上限</th><th>状态</th></tr></thead><tbody>'
      + data.interior.output.resources.map(function (r) {
        var eff = Math.floor((r.yield || 0) * (1 + (r.bonusPct || 0) / 100));
        return '<tr><td>' + esc(r.label) + '</td><td class="v">' + fmt(r.stock) + '</td>'
          + '<td>+' + fmt(r.yield)
          + (r.bonusPct ? '<span class="up">（委任 +' + r.bonusPct + '% → 实际 +' + fmt(eff) + '）</span>' : '')
          + '</td><td class="muted">' + esc(r.use || '—') + '</td>'
          + '<td class="muted">' + (r.capacity ? fmt(r.capacity) : '不占仓库') + '</td>'
          + '<td>' + (r.full ? '<span class="tag no">已满仓</span>' : '<span class="muted">正常</span>') + '</td></tr>';
      }).join('') + '</tbody></table>'
      + '<div class="muted" style="margin-top:8px">「库存」是现在能动用的量；「日产」是每天入账量；「上限」只对木铁石粮金生效，满仓后当天不再入库。</div>'
      + '</div>';

    out += '<div class="card"><h3>物资去处 · 即时办理</h3>'
      + '<div class="muted" style="margin-bottom:8px">下列动作点了立刻结算，代价直接写在按钮下方；不派武将、不占工期。'
      + '金驱动的发展由各城太守按方针自动办理（见城池内页「太守 · 方针」）。</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(224px,1fr));gap:7px">'
      + (guide.actions || []).map(function (a) {
        return '<div><button class="btn" data-act="armory" data-id="' + esc(a.id) + '">'
          + esc(a.label) + '</button><div class="muted" style="margin-top:3px">' + esc(a.note || '') + '</div></div>';
      }).join('') + '</div></div>';

    // ★ P0-3：收支流水——玩家第一次能回答「我的资源怎么没的」
    var lg = data.interior.output && data.interior.output.ledger;
    if (lg) {
      out += '<div class="card"><h3>收支流水（近期净变化）</h3><div class="grid">'
        + lg.net.map(function (n) {
          var cls = n.delta > 0 ? 'up' : (n.delta < 0 ? 'down' : 'muted');
          return '<div><span class="k">' + esc(n.label) + '</span> <span class="' + cls + '">'
            + (n.delta > 0 ? '+' : '') + fmt(n.delta) + '</span></div>';
        }).join('') + '</div>';
      if (lg.entries.length) {
        out += '<table><thead><tr><th>游戏日</th><th>资源</th><th>增减</th><th>事由</th></tr></thead><tbody>'
          + lg.entries.map(function (e) {
            var lbl = (data.interior.output.resources.find(function (r) { return r.key === e.res; }) || {}).label
              || POST_RES_LABEL[e.res] || '其他收支';
            var d = Number(e.delta) || 0;
            return '<tr><td class="muted">' + esc(e.day) + '</td><td>' + esc(lbl) + '</td><td class="'
              + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + fmt(d) + '</td><td class="muted">'
              + esc(e.reason) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      } else {
        out += '<div class="muted">还没有收支记录：每日结算、锻造、政令都会在这里记账。</div></div>';
      }
    }

    if (!list.length) return out + '<div class="card muted">该分类暂无物品。</div>';
    out += '<div class="grid">' + list.map(function (i) {
      var actions = '';
      if (i.slot) actions += '<button class="btn" data-act="tab" data-id="equip">给谁穿</button>';
      if (i.kind === 'scroll') actions += '<button class="btn" data-act="tab" data-id="library">去研习</button>';
      if (!i.ownerGeneralId && i.kind === 'equip') {
        actions += '<button class="btn warn" data-act="dismantle" data-item="' + i.id + '">分解成材料</button>';
      }
      return '<div class="card"><b class="v">' + esc(i.name) + '</b> ×' + esc(i.count)
        + (i.slotName ? ' <span class="tag">' + esc(i.slotName) + '</span>' : '')
        + '<div class="muted" style="margin:5px 0">' + esc(i.tale) + '</div>'
        + (i.trait ? '<div>特性：' + esc(i.trait) + '</div>' : '')
        + '<div class="muted">来源：' + esc(i.source) + ' · 当前佩戴：' + esc(i.ownerName || '无') + '</div>'
        + '<div style="margin-top:7px">' + actions + '</div></div>';
    }).join('') + '</div>';
    return out;
  }

  function viewEquip() {
    var g = currentGeneral();
    var out = '<div class="card"><h3>选择武将</h3>' + data.generals.map(function (x) {
      return '<button class="btn' + (x.id === ui.genId ? ' on' : '') + '" data-act="gen" data-id="' + x.id + '">'
        + esc(x.name) + '</button>';
    }).join('') + '</div>';
    if (!g) return out + '<div class="muted">暂无武将</div>';
    return out + equipSlotsHtml(g, true);
  }

  function viewLibrary() {
    var L = data.library, sm = data.librarySummary;
    /* sessionStorage 恢复的是字符串/旧值，先归一，否则 slice(0,'24') 会得到空列表 */
    if (!(Number(ui.skillLimit) > 0)) ui.skillLimit = 24;
    ui.skillLimit = Number(ui.skillLimit);
    var out = '<h3>战法库（势力级资产）</h3><div class="grid">'
      + [['全库', sm.total + ' 条'], ['已解锁', sm.unlocked + ' 条'], ['研习中', sm.researching + ' 条'],
         ['兵书残卷', (data.scrolls || 0) + ' 卷'], ['≥2 条获取途径', sm.sourcesCovered + ' / ' + sm.total]].map(function (p) {
        return '<div class="card"><span class="k">' + p[0] + '</span><div class="v" style="font-size:19px">' + p[1] + '</div></div>';
      }).join('') + '</div>';
    out += '<div class="card muted">全部配方开局公开：名称／类型／描述／数值均已在本作统一登记；'
      + '没有随机、没有不可逆的意外、没有死路（每条至少两条路径，战功研习永久兜底）。'
      + '解锁条件分两层：<b>战法先要解锁</b>（研习或战功途径，见每条展开后的「如何获得」）；'
      + '<b>解锁后还要有槽</b>——学习槽要武将 5 级，觉醒槽要武将 10 级且自带战法 10 级。'
      + '兵书残卷现存 <b class="v">' + esc(data.scrolls || 0) + '</b> 卷。</div>';

    var fs = [['all', '全部'], ['unlocked', '已解锁'], ['researching', '研习中'], ['locked', '未解锁'],
              ['主战法', '主战法'], ['库战法', '库战法'], ['主动', '主动'], ['内政', '内政']];
    out += '<div class="tabs">' + fs.map(function (f) {
      return '<button class="' + (ui.skillFilter === f[0] ? 'on' : '') + '" data-act="skillfilter" data-id="'
        + esc(f[0]) + '">' + f[1] + '</button>';
    }).join('') + '</div><input type="text" data-act="skillquery" placeholder="按名称检索" value="'
      + esc(ui.skillQuery) + '" style="width:220px;margin-bottom:10px">';

    var list = L.filter(function (s) {
      var f = ui.skillFilter;
      if (f === 'unlocked' || f === 'researching' || f === 'locked') { if (s.status !== f) return false; }
      else if (f === '主战法' || f === '库战法') { if (s.sourceGroup !== f) return false; }
      else if (f === '主动') { if (s.trigger !== '主动') return false; }
      else if (f === '内政') { if (s.tags.indexOf('内政') < 0) return false; }
      if (ui.skillQuery && String(s.name).indexOf(ui.skillQuery) < 0) return false;
      return true;
    });
    out += '<div class="muted" style="margin-bottom:8px">筛出 ' + list.length + ' 条'
      + (list.length > ui.skillLimit ? '，先显示前 ' + ui.skillLimit + ' 条（列表底部可继续加载）' : '')
      + '。</div>';

    /* ★ PF-05 修：51 条战法全量渲染会让单视角 DOM 增量到 604 节点（预算 400）。
       本作设计 的降级顺序第 1/2 条是「先降表现、离屏不算不画」，所以这里分批渲染：
       首屏 24 条，底部「显示更多」按需追加。筛选与检索会重置回 24 条，
       因此「找某条战法」的路径没有变慢（筛完通常只剩几条）。 */
    var shown = list.slice(0, ui.skillLimit);
    out += shown.map(function (s) {
      /* ★ P65：「研习中」必须能分清有人在督研（会涨）与只有半截进度没人管（卡住），
         否则玩家盯着一条没有委派源的预置进度，只会看到永远不动的进度条。 */
      var tag = s.status === 'unlocked' ? '<span class="tag ok">已解锁 Lv' + esc(s.level) + '</span>'
        : s.status === 'researching'
          ? '<span class="tag mid">研习中</span>' + (s.assignment
            ? '<span class="tag ok" style="margin-left:4px">' + esc(s.assignment.generalName)
              + ' 督研 · 每旬 +' + esc(s.assignment.points) + '</span>'
            : '<span class="tag no" style="margin-left:4px">待委派 · 进度停滞</span>')
          : '<span class="tag no">未解锁</span>';
      // ★ P3：语义摘要——不展开就能看到「怎么触发、Lv10 发动率、效果值」
      var lv10 = s.levels && s.levels[10];
      /* 修 U09：图鉴必须显示「有效距离」，否则玩家查不到战法射程，
         描述与内核计算虽然同源，但只有点进战斗才知道。 */
      var rangeTxt = (s.range == null || s.range >= 9) ? '无距离限制'
        : ('有效距离 ' + esc(s.range) + '（前锋0/中军1/大营2，跨阵营距离=双方槽位+1）');
      var digest = lv10 ? ('Lv10 发动 ' + esc(lv10.probability) + '%'
        + (lv10.effect_value && lv10.effect_value.length
          ? ' · 效果 ' + esc(lv10.effect_value.join('/')) : '')) : '';
      var h = '<div class="skill"><div class="hd" data-act="skilldetail" data-cfg="' + s.cfgId + '">'
        + tag + '<b class="v">' + esc(s.name) + '</b><span class="muted">' + esc(s.trigger) + ' · '
        + esc(s.sourceGroup) + ' · ' + esc(s.tags.join('/')) + '</span>'
        + (digest ? '<span class="muted" style="color:#c8b88a">' + digest + '</span>' : '')
        + '<span class="tag mid" style="margin-left:6px" data-term="有效距离">' + rangeTxt + '</span>'
        + '<span style="flex:1"></span><span class="muted">' + (ui.openSkill === s.cfgId ? '收起 ▲' : '展开获取途径 ▼') + '</span></div>';
      if (ui.openSkill === s.cfgId) {
        h += '<div class="dt"><div style="margin:8px 0">' + esc(s.des) + '</div>'
          + '<div class="muted" style="font-size:11px;margin-top:-5px">'
          + '描述中的 %n 对应下方各级效果值。</div>'
          + '<div class="muted">装配 ' + s.equippedBy.length + ' / ' + s.equipLimit + ' 人 · 目标类型 '
          + esc(s.target) + ' · 适性兵种 ' + esc((s.arms || []).join(',')) + '</div>'
          + '<h4>10 级数值曲线</h4><table><thead><tr><th>等级</th><th>发动率</th><th>效果值</th></tr></thead><tbody>'
          + Object.keys(s.levels).map(function (lv) {
            return '<tr><td>Lv' + esc(lv) + '</td><td>' + esc(s.levels[lv].probability) + '%</td><td>'
              + esc((s.levels[lv].effect_value || []).join(' / ')) + '</td></tr>';
          }).join('') + '</tbody></table>'
          + '<h4>如何获得（' + s.sources.length + ' 条路径，全部公开）</h4>';
        s.sources.forEach(function (src) {
          h += '<div class="src"><b>' + esc(src.label) + '</b> · ' + esc(src.where)
            + '<div>消耗：' + esc(src.cost) + '</div><div class="muted">' + esc(src.detail) + '</div></div>';
        });
        h += '<div class="muted">' + esc(s.guarantee) + '</div>';
        if (s.research) {
          h += '<div class="bar"><i style="width:' + Math.min(100, s.research.progress / s.research.need * 100) + '%"></i></div>'
            + '<div class="muted">研习进度 ' + esc(s.research.progress) + ' / ' + esc(s.research.need) + '</div>';
        }
        /* ★ P58：解锁条件写全 —— 战法层的「还差多少研习」+ 槽位层的「武将几级」，
           旧版只给一个「投入 10 残卷研习」按钮，残卷不够时点了才报错。 */
        h += '<div class="card muted" style="margin-top:9px"><b>解锁条件</b><div>'
          + (s.status === 'unlocked'
            ? '战法已解锁。还差一个空槽：学习槽要武将 5 级，觉醒槽要武将 10 级且自带战法 10 级。'
            : '研习进度要满 ' + (s.research ? esc(s.research.need) : '100')
              + (s.research ? '（现在 ' + esc(s.research.progress) + '，还差 ' + esc(Math.max(0, s.research.need - s.research.progress)) + '）' : '')
              + '；每次最多投 10 卷，兵书残卷现有 ' + esc(data.scrolls || 0) + ' 卷。')
          + '</div></div>';
        h += '<div style="margin-top:9px">';
        if (s.status === 'unlocked') {
          var cg = currentGeneral();
          var lt = cg ? skillTargetSlot(cg) : { pos: -1, note: '先在「武将」页选一名武将' };
          h += lt.pos > 0
            ? '<button class="btn" data-act="learn" data-gid="' + cg.id + '" data-pos="' + lt.pos
              + '" data-cfg="' + s.cfgId + '">装配给 ' + esc(cg.name) + ' 的' + ['自带', '学习', '觉醒'][lt.pos] + '槽</button>'
            : '<button class="btn" disabled title="' + esc(lt.note) + '">暂不能装 · ' + esc(lt.note) + '</button>';
        } else {
          /* ★ P66：研习入口永远可点——残卷用尽也能委派武将自行推敲（领域层已支持），
             旧版「无卷且无委派就禁用」会把玩家锁死在灰色按钮前，必须去掉。
             框内会自己说明当前状态、进度与获取残卷的路径。 */
          h += '<button class="btn" data-act="openResearch" data-cfg="' + s.cfgId + '"'
            + ' title="打开研习框：委派武将逐旬推进，残卷用尽也能自行推敲">研习 · 委派武将</button>';
        }
        h += '</div></div>';
      }
      return h + '</div>';
    }).join('');
    if (list.length > shown.length) {
      out += '<div style="margin:12px 0"><button class="btn" data-act="skillmore">显示更多（还有 '
        + (list.length - shown.length) + ' 条）</button></div>';
    }
    return out;
  }

  var VIEWS = { general: viewGeneral, strategy: viewStrategy, interior: viewInterior,
                depot: viewDepot, equip: viewEquip, library: viewLibrary };

  /* ---------------- 渲染 / 事件 ---------------- */
  function render() {
    if (!data || !mask) return;
    if (!mask._built) {
      mask.innerHTML = '<div id="slgPanelsWin"><div class="side"><div class="brand">霜寒 · 六府</div>'
        + '<div id="slgPanelsNav"></div><div class="tip">原画面未改动；本覆盖层由离线运行时注入。<br>ESC 关闭。</div></div>'
        + '<div class="main"><div class="top"><b id="slgPanelsTitle"></b><span class="sp" id="slgPanelsSub"></span>'
        + '<button data-act="refresh">刷新</button><button data-act="close">关闭</button></div>'
        + '<div class="body" id="slgPanelsBody"></div></div></div>';
      mask._built = true;
      mask.addEventListener('click', onClick);
      mask.addEventListener('change', onChange);
      mask.addEventListener('input', onInput);
    }
    var nav = document.getElementById('slgPanelsNav');
    nav.innerHTML = NAV.map(function (x) {
      return '<button class="nav' + (ui.tab === x[0] ? ' on' : '') + '" data-act="tab" data-id="' + x[0] + '">'
        + x[1] + '<div style="font-size:11px;color:#8f8676">' + x[2] + '</div></button>';
    }).join('');
    var cur = NAV.find(function (x) { return x[0] === ui.tab; }) || NAV[0];
    document.getElementById('slgPanelsTitle').textContent = cur[1] + ' · ' + cur[2];
    document.getElementById('slgPanelsSub').textContent =
      '第 ' + data.month + ' 月 · 游戏日 ' + data.day + ' · 武将 ' + data.generals.length
      + ' · 物品 ' + data.items.length + ' · 战法 ' + data.library.length;
    var body = document.getElementById('slgPanelsBody');
    var scroll = body.scrollTop;
    var lg0 = body.querySelector('.genlist'), rt0 = body.querySelector('.cols>.right');
    if (lg0) genScroll.list = lg0.scrollTop;
    if (rt0) genScroll.detail = rt0.scrollTop;
    var sameHero = genScroll.gid === ui.genId && genScroll.tab === ui.genTab;
    body.className = 'body' + (ui.tab === 'general' ? ' gen-body' : '');
    body.innerHTML = (VIEWS[ui.tab] || viewGeneral)();
    if (ui.tab === 'general') {
      var lg1 = body.querySelector('.genlist'), rt1 = body.querySelector('.cols>.right');
      if (lg1) lg1.scrollTop = genScroll.list;
      if (rt1) rt1.scrollTop = sameHero ? genScroll.detail : 0;
    } else body.scrollTop = scroll;
    genScroll.gid = ui.genId; genScroll.tab = ui.genTab;
    persistUI();
    Array.prototype.forEach.call(dock.querySelectorAll('.pb'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-id') === ui.tab && mask.style.display === 'flex');
    });
  }

  function open(tab) {
    /* ★ P11 一屏一窗：六府展开时收掉城市内部页与其它主窗口，避免互相遮挡 */
    var city = document.getElementById('slgCityPage');
    if (city) {
      if (window.__slgCityClose) window.__slgCityClose();
      else city.remove();
    }
    Array.prototype.forEach.call(document.querySelectorAll('#slgUIv2 .win'), function (w) { w.remove(); });
    if (tab) ui.tab = tab;
    mask.style.display = 'flex';
    if (!data) fetchState(); else render();
    dock.style.opacity = '1';
  }
  function close() { mask.style.display = 'none'; render(); }

  function onClick(e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    if (act === 'close') return close();
    if (act === 'refresh') return fetchState();
    if (act === 'continueSandbox') return strategyAction({ action: 'continueSandbox' });
    if (act === 'tab') {
      /* ★ 出征是独立作战面板（出击/行军队列/战报），不在六府这套 DOM 里渲染 */
      if (id === 'war') {
        close();
        if (typeof window.__slgWarWindow === 'function') window.__slgWarWindow();
        else toast('出征面板尚未就绪，请稍候', false);
        return;
      }
      return open(id);
    }
    if (act === 'dispatch') {
      var dgid = Number(t.getAttribute('data-gid'));
      var pick = t.parentNode.querySelector('[data-act="dispatchpick"]');
      var to = pick ? Number(pick.value) : 0;
      if (!to) return toast('请先选目标城', false);
      /* 走 /__slg/strategy/action 的 dispatchGeneral；成功自动刷新面板，失败给中文原因。 */
      return strategyAction({ action: 'dispatchGeneral', generalId: dgid, toCityId: to });
    }
    /* ★ P51 批量调防：勾选走 change；这批按钮只处理批量动作。 */
    if (act === 'genpick') return;
    if (act === 'genpickAll') {
      /* ★ P56：主公与在编武将不进「全选」。旧实现把全队一把调走，
         主公离队后征兵页按城过滤就再也看不到他，玩家以为武将丢了。 */
      ui.genPick = (data.generals || []).filter(function (g) {
        return !g.isProtagonist && g.state !== '在编';
      }).map(function (g) { return Number(g.id); });
      return render();
    }
    if (act === 'genpickClear') { ui.genPick = []; return render(); }
    if (act === 'dispatchPickCity') return openDispatchDialog();
    if (act === 'dispatchBatch') {
      ui.genPick = ui.genPick.filter(function (id) {
        return !(data.generals || []).some(function (g) { return g.id === Number(id) && g.isProtagonist; });
      });
      if (!ui.genPick.length) return toast('请先勾选要调遣的武将', true);
      return openDispatchDialog();
    }
    if (act === 'gen') { ui.genId = Number(t.getAttribute('data-id')); return render(); }
    if (act === 'prospect') { ui.genId = -Number(t.getAttribute('data-i')) - 1; return render(); }
    if (act === 'gtab') { ui.genTab = id; return render(); }
    if (act === 'itemfilter') { ui.itemFilter = id; return render(); }
    if (act === 'skillfilter') { ui.skillFilter = id; ui.skillLimit = 24; return render(); }
    if (act === 'skillmore') { ui.skillLimit += 24; return render(); }
    if (act === 'skilldetail') {
      var cfg = Number(t.getAttribute('data-cfg'));
      ui.openSkill = ui.openSkill === cfg ? 0 : cfg; return render();
    }
    if (act === 'equip') return post({ type: 'equip', gId: Number(t.getAttribute('data-gid')),
      slot: t.getAttribute('data-slot'), itemId: Number(t.getAttribute('data-item')) });
    if (act === 'unequip') return post({ type: 'unequip', gId: Number(t.getAttribute('data-gid')),
      slot: t.getAttribute('data-slot') });
    if (act === 'forge') return post({ type: 'forge', cfgId: Number(t.getAttribute('data-cfg')) });
    if (act === 'dismantle') return confirmBox('分解不可逆，确认分解这件装备？', function () {
      post({ type: 'dismantle', itemId: Number(t.getAttribute('data-item')) });
    });
    /* ★ P63：打开游戏化研习对话框（不再是通用决策前预览）。 */
    if (act === 'openResearch') return researchBox(Number(t.getAttribute('data-cfg')));
    if (act === 'research') return post({ type: 'research', cfgId: Number(t.getAttribute('data-cfg')), amount: 10 });
    if (act === 'unskill') return confirmBox('卸下这个槽的战法？卸下后战法回到战法库，可再装配给别人。', function () {
      post({ type: 'downSkill', gId: Number(t.getAttribute('data-gid')), pos: Number(t.getAttribute('data-pos')) });
    });
    if (act === 'learn') return post({ type: 'learn', gId: Number(t.getAttribute('data-gid')),
      pos: Number(t.getAttribute('data-pos')), cfgId: Number(t.getAttribute('data-cfg')) });
    if (act === 'lvskill') return post({ type: 'lvSkill', gId: Number(t.getAttribute('data-gid')),
      pos: Number(t.getAttribute('data-pos')) });
    if (act === 'armory') {
      var guideAct = (((data.interior || {}).output || {}).guide || {}).actions || [];
      var picked = null;
      for (var ai = 0; ai < guideAct.length; ai++) if (guideAct[ai].id === id) picked = guideAct[ai];
      if (!picked) return;
      var body = {};
      Object.keys(picked.body || {}).forEach(function (k) { body[k] = picked.body[k]; });
      if (picked.needsCity) body.cityId = Number((data.strategy || {}).playerCity) || 0;
      return strategyAction(body);
    }
    if (act === 'proposal') return confirmBox('颁行后本回合不可更改，确认？', function () {
      post({ type: 'proposal', id: id });
    });
    // ★ P0/P1/P3：整编 / 运粮 / 赏赐
    if (act === 'formup') {
      var fArmy = (data.strategy.armies || []).find(function (a) { return a.id === Number(id); });
      if (fArmy) formupBox(fArmy);
      return;
    }
    if (act === 'transport') {
      var tCity = (data.strategy.cities || []).find(function (c) { return c.id === Number(id); });
      if (tCity) openTransport(tCity);
      return;
    }
    if (act === 'reward') {
      var g0 = data.generals.find(function (x) { return x.id === Number(id); });
      askText('赏赐 ' + (g0 ? g0.name : '武将') + ' 多少金？每 100 金提升 1 点忠诚（单次上限 15）。', '500', function (amt2) {
        if (amt2) strategyAction({ action: 'reward', generalId: Number(id), amount: Number(amt2) });
      });
      return;
    }
    if (act === 'advance') {
      var g1 = data.generals.find(function (x) { return x.id === Number(id); });
      return confirmBox('进阶 ' + (g1 ? g1.name : '武将') + '？花费 1200 金，解锁 11~15 级成长（每级战斗加成 2%）。', function () {
        strategyAction({ action: 'advanceGeneral', generalId: Number(id) });
      });
    }
    if (act === 'captiveFocus') {
      var box0 = document.getElementById('slgCaptivePanel');
      if (box0 && box0.scrollIntoView) box0.scrollIntoView({ block: 'nearest' });
      else toast('阵前俘虏表格已在武将页上方');
      return;
    }
    if (act === 'captiveRelease' || act === 'captiveExecute') {
      var cx = (data.captives || []).find(function (x) { return x.idx === Number(id); });
      if (!cx) return toast('找不到该俘虏，请刷新后再试', true);
      var kill = act === 'captiveExecute';
      confirmBox((kill ? '处斩「' : '放归「') + cx.name + '」？ '
        + (kill ? '此人将不再可用，主公恶名上升；除董卓外诸势力态度下降。'
          : '不消耗金钱，主公名望上升，诸势力态度改善；此人回到战场后可能再度为敌。'), function () {
        strategyAction({ action: act, idx: cx.idx }, function (r) {
          if (r.ok) toast((kill ? '已处斩 ' : '已放归 ') + cx.name, true);
        });
      });
      return;
    }
    if (act === 'captive') {
      var c0 = (data.captives || []).find(function (x) { return x.idx === Number(id); });
      if (!c0) return toast('找不到该俘虏，请刷新后再试', true);
      var parts = (c0.rateParts && c0.rateParts.parts || []).map(function (p) {
        return p.label + ' ' + p.value + '%';
      }).join('，');
      confirmBox('招降「' + c0.name + '」？费用 300 金，当前把握 ' + c0.rate + '%（' + (parts || '按规则结算') + '）。'
        + '失败：忠诚 −10，降到 0 以下会越狱逃走。', function () {
        strategyAction({ action: 'captive', idx: c0.idx });
      });
      return;
    }
    if (act === 'openwar') {
      close();
      if (typeof window.__slgWarWindow === 'function') window.__slgWarWindow();
      else toast('出征面板尚未就绪，请稍候', false);
      return;
    }
    /* ★ 2026-11-20：外交直达。落到既有出征窗的外交页签，不新建视图/协议。 */
    if (act === 'diplomacy') {
      close();
      if (typeof window.__slgWarWindow === 'function') window.__slgWarWindow({ tab: 'diplo' });
      else toast('外交面板尚未就绪，请稍候', false);
      return;
    }
    if (act === 'gotostrategy') {      close();
      if (typeof window.__slgStrategyShow === 'function') window.__slgStrategyShow();
      else toast('天下沙盘尚未就绪，请稍候');
      return;
    }
  }
  function onChange(e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act === 'appoint') return post({ type: 'appoint', post: t.getAttribute('data-post'), target: Number(t.value) });
    if (act === 'appointAll') return post({ type: 'appointAll' });
    if (act === 'governorAutoFill') return post({ type: 'governorAutoFill' });
    if (act === 'citypick') { ui.selectedCity = Number(t.value); return render(); }
    if (act === 'genpick') {
      var gid = Number(t.getAttribute('data-id'));
      var at = ui.genPick.indexOf(gid);
      if (t.checked && at < 0) ui.genPick.push(gid);
      if (!t.checked && at >= 0) ui.genPick.splice(at, 1);
      persistUI();
      /* 只改计数不整页重绘：否则勾选框失焦、详情跳回顶部。 */
      var counter = document.querySelector('.genpickbar .muted');
      if (counter) counter.textContent = '已选 ' + ui.genPick.length + ' 人';
      return;
    }
  }
  function onInput(e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.getAttribute('data-act') !== 'skillquery') return;
    ui.skillQuery = t.value;
    ui.skillLimit = 24;   /* 检索结果从第一批开始，避免「搜到了却停在列表末尾」 */
    var pos = t.selectionStart;
    render();
    var again = document.querySelector('[data-act="skillquery"]');
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
  }

  /* ---------------- 战报红点（P0-2） ---------------- */
  function fetchReportsHead(cb) {
    fetch(API_ROOT + '/panels/reports-head', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) { if (cb) cb(v); }).catch(function () {});
  }
  /* ---------------- 开局举义页（P4-①）：择主 8 诸侯卡 + 择都 3 候选城 ---------------- */
  var oathEl = null;
  /* ★ P7：举义页切城后「另择明主」要能回退——lords 原先只是 renderOathLords 的局部变量，
     在 renderOathCities 的回调里根本取不到（冒烟报 ReferenceError）。 */
  var oathLords = [];
  /* ★ P61-S5：开局难度四档，默认常规；选中的档位随举义请求写入存档 knobs */
  var oathDifficulties = [];
  var oathDifficulty = 'normal';
  function showOath() {
    if (oathEl) return;
    oathEl = document.createElement('div');
    oathEl.id = 'slgOath';
    oathEl.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;'
      + 'background:radial-gradient(120% 90% at 50% 0%, #1d1710 0%, #0e0c08 60%, #080704 100%);overflow-y:auto;';
    oathEl.innerHTML = '<div id="slgOathBox" style="width:min(1060px,94vw);padding:26px 30px 30px;border:1px solid #ba9a52;border-radius:14px;'
      + 'background:rgba(20,18,10,.92);box-shadow:0 18px 60px rgba(0,0,0,.7);color:#e6dac0;font:13px/1.7 "Microsoft YaHei",sans-serif;">'
      + '<div style="text-align:center;font:bold 30px/1.4 KaiTi,STKaiti,serif;color:#f0d998;letter-spacing:8px;">举 义</div>'
      + '<div style="text-align:center;color:#9c9382;margin:6px 0 18px;font-size:12.5px;">汉室倾颓，群雄并起 —— 择一主而事之，定一都而图天下</div>'
      + '<div id="slgOathBody"><div style="text-align:center;color:#8f8676;padding:30px 0;">正召集诸侯……</div></div>'
      + '</div>';
    document.body.appendChild(oathEl);
    // 服务端若已被举义（比如另一窗口完成选择），覆盖层自动收起，不把新档玩家锁死。
    // 直接按 DOM 收（getElementById），不依赖闭包变量——多实例/外部完成场景也兜得住。
    var poll = setInterval(function () {
      var el2 = document.getElementById('slgOath');
      if (!el2) { clearInterval(poll); return; }
      fetch('/__slg/oath/options', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (v) {
          if (v && v.ok && v.done) {
            clearInterval(poll);
            /* ★ P11：渐隐期间这层是全屏 z-index 2147483646，摘掉 id 只是骗过
               「元素存在性」检查，鼠标仍会被它整屏吃掉（真鼠标试玩在这里翻车）。
               隐藏的第一帧就必须让点击穿透。 */
            el2.removeAttribute('id');
            el2.style.pointerEvents = 'none';
            el2.style.transition = 'opacity .4s'; el2.style.opacity = '0';
            setTimeout(function () { el2.remove(); }, 420);
          }
        })
        .catch(function () {});
    }, 1000);
    fetch('/__slg/oath/options', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        if (!v || !v.ok) throw new Error('无法读取诸侯名录');
        if (v.done) { hideOath(); return; }
        oathDifficulties = v.difficulties || [];
        renderOathLords(v.lords || []);
      })
      .catch(function (e) {
        var b = document.getElementById('slgOathBody');
        if (b) b.innerHTML = '<div style="text-align:center;color:#ff9d7a;padding:30px 0;">诸侯名录读取失败：' + esc(e.message)
          + '<br><button onclick="location.reload()" style="margin-top:10px;background:#2a2c30;color:#e8c670;border:1px solid #ba9a52;border-radius:6px;padding:6px 18px;cursor:pointer;">重试</button></div>';
      });
  }
  function hideOath() {
    oathEl = null;
    var el = document.getElementById('slgOath');
    if (!el) return;
    el.removeAttribute('id');   // 立即摘 id：外部「元素存在性」检查与渐隐动画解耦
    el.style.pointerEvents = 'none'; // ★ P11：渐隐的 520ms 不许继续拦截鼠标
    el.style.transition = 'opacity .5s'; el.style.opacity = '0';
    setTimeout(function () { el.remove(); }, 520);
  }
  function renderOathLords(lords) {
    oathLords = lords || oathLords || [];
    var box = document.getElementById('slgOathBody');
    if (!box) return;
    box.innerHTML = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">'
      + lords.map(function (f) {
        return '<div class="slgOathLord" data-lord="' + esc(f.id) + '" style="cursor:pointer;border:1px solid #3a3325;border-radius:10px;padding:0 0 10px;background:rgba(255,255,255,.03);transition:border-color .15s,transform .15s;">'
          + '<div style="height:52px;border-radius:9px 9px 0 0;background:' + esc(f.color) + ';display:flex;align-items:center;justify-content:center;position:relative;">'
          + '<span style="font:bold 24px KaiTi,STKaiti,serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6);letter-spacing:3px;">' + esc(f.name) + '</span>'
          + '</div>'
          + '<div style="padding:8px 12px 0;">'
          + '<div style="color:#e8c670;font-weight:bold;">特技 · ' + esc(f.trait.name) + '</div>'
          + '<div style="color:#9c9382;font-size:12px;">' + esc(f.trait.desc) + '</div>'
          + '<div style="margin-top:6px;color:#b9ac8f;font-size:12px;line-height:1.6;min-height:42px;">' + esc(f.blurb) + '</div>'
          + '<div style="margin-top:6px;color:#8fb98a;font-size:12px;">初始武将团：' + f.generals.map(esc).join('、') + '</div>'
          + '</div></div>';
      }).join('')
      + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.slgOathLord'), function (card) {
      card.addEventListener('mouseenter', function () { card.style.borderColor = '#e8c670'; card.style.transform = 'translateY(-3px)'; });
      card.addEventListener('mouseleave', function () { card.style.borderColor = '#3a3325'; card.style.transform = ''; });
      card.addEventListener('click', function () {
        var id = card.getAttribute('data-lord');
        for (var i = 0; i < lords.length; i++) if (lords[i].id === id) { renderOathCities(lords[i]); return; }
      });
    });
  }
  function renderOathCities(f) {
    var box = document.getElementById('slgOathBody');
    if (!box) return;
    var head = '<div style="display:flex;align-items:baseline;gap:12px;margin:4px 0 14px;">'
      + '<button id="slgOathBack" style="background:#2a2c30;color:#e8c670;border:1px solid #ba9a52;border-radius:6px;padding:4px 14px;cursor:pointer;">‹ 另择明主</button>'
      + '<span style="font:bold 22px KaiTi,STKaiti,serif;color:' + esc(f.color) + ';letter-spacing:4px;">事 ' + esc(f.name) + '</span>'
      + '<span style="color:#9c9382;">特技 · ' + esc(f.trait.name) + '（' + esc(f.trait.desc) + '）</span>'
      + '</div>';
    var cards = (f.cities || []).map(function (c) {
      return '<div class="slgOathCity" data-city="' + c.id + '" style="cursor:pointer;border:1px solid #3a3325;border-radius:10px;padding:14px 16px;background:rgba(255,255,255,.03);transition:border-color .15s,transform .15s;">'
        + '<div style="display:flex;justify-content:space-between;align-items:baseline;">'
        + '<span style="font:bold 19px KaiTi,STKaiti,serif;color:#f0d998;letter-spacing:2px;">' + esc(c.name) + '</span>'
        + '<span style="color:#e8c670;font-size:12px;border:1px solid #ba9a52;border-radius:4px;padding:1px 8px;">' + esc(c.type) + '</span>'
        + '</div>'
        + '<div style="margin-top:6px;color:#9c9382;font-size:12px;">' + esc(c.note) + '</div>'
        + '<div style="margin-top:10px;color:#b9ac8f;font-size:12px;">定都于此，' + esc(f.name) + '名下城池尽归主公，初始武将团即日入营。</div>'
        + '</div>';
    }).join('');
    /* ★ P61-S5：难度选择行——档位与预期胜率公开，不再是纸面设计 */
    var diffRow = '<div style="margin:0 0 16px;padding:10px 12px;border:1px solid #4b422e;border-radius:8px;background:rgba(255,255,255,.02)">'
      + '<div style="color:#c9bb95;font-size:12px;margin-bottom:7px">难度（开局锁定后写入存档，可在设置里重选）</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
      + oathDifficulties.map(function (d) {
        return '<button type="button" data-difficulty="' + esc(d.id) + '" class="slgOathDiff" '
          + 'style="flex:1;min-width:120px;text-align:left;padding:7px 10px;border-radius:5px;cursor:pointer;'
          + 'border:1px solid ' + (d.id === oathDifficulty ? '#e8c670' : '#4b422e') + ';'
          + 'background:' + (d.id === oathDifficulty ? 'rgba(232,198,112,.14)' : 'transparent') + ';'
          + 'color:' + (d.id === oathDifficulty ? '#f0d998' : '#a9a48f') + '">'
          + '<b>' + esc(d.label) + '</b> <span style="opacity:.7;font-size:11px">目标胜率 ' + Math.round((d.targetWinRate || 0) * 100) + '%</span>'
          + '<div style="font-size:11px;opacity:.75;margin-top:3px">' + esc(d.desc || '') + '</div></button>';
      }).join('') + '</div></div>';
    box.innerHTML = head + diffRow + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">' + cards + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-difficulty]'), function (btn) {
      btn.addEventListener('click', function () {
        oathDifficulty = btn.getAttribute('data-difficulty');
        renderOathCities(f);
      });
    });
    document.getElementById('slgOathBack').addEventListener('click', function () { renderOathLords(oathLords); });
    Array.prototype.forEach.call(box.querySelectorAll('.slgOathCity'), function (card) {
      card.addEventListener('mouseenter', function () { card.style.borderColor = '#e8c670'; card.style.transform = 'translateY(-3px)'; });
      card.addEventListener('mouseleave', function () { card.style.borderColor = '#3a3325'; card.style.transform = ''; });
      card.addEventListener('click', function () {
        var city = Number(card.getAttribute('data-city'));
        card.style.pointerEvents = 'none';
        fetch('/__slg/oath/choose', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lord: f.id, city: city, difficulty: oathDifficulty }),
        }).then(function (r) { return r.json(); }).then(function (r) {
          if (!r || !r.ok) {
            toast(r && r.reason === 'bad_city' ? '该城不可定都' : '举义失败', true);
            card.style.pointerEvents = '';
            return;
          }
          hideOath();
          toast('已举义：承' + r.lordName + '之业，定都' + r.city + '，' + (r.generals || []).join('、') + '入营');
          fetchState();
        }).catch(function (e) { toast('举义失败：' + e.message, true); card.style.pointerEvents = ''; });
      });
    });
  }

  function reportDots() {
    /* ★ P42：六府入口并入沙盘横向菜单后，旧 dock 被隐藏，红点必须同步到
       可见的横向「战报」chip，否则玩家再也看不到未读提醒。 */
    return [document.getElementById('slgRepDot'), document.getElementById('slgRepDotTop')];
  }
  function pollReports() {
    fetchReportsHead(function (v) {
      reportDots().forEach(function (dot) { if (dot && v) dot.style.display = v.unread > 0 ? 'block' : 'none'; });
    });
  }
  function markReportsSeen() {
    /* ★ P47#13：旧版只把红点藏起来并写 localStorage，从未回写领域层的
       `a_is_read/d_is_read`。下一次 pollReports 拿到 unread>0 又把红点点亮，
       玩家反复点开同一份战报也永远清不掉。现在先发 `war.read`（id:0=全部），
       本地隐藏只作即时反馈，权威状态由战报列表自己说了算。 */
    try {
      if (typeof window.__slgSend === 'function') {
        Promise.resolve(window.__slgSend('war.read', { id: 0 })).catch(function () { /* 断线不卡界面 */ });
      }
    } catch (_) { /* 启动早期协议未就绪，不影响本地隐藏 */ }
    reportDots().forEach(function (dot) { if (dot) dot.style.display = 'none'; });
    fetchReportsHead(function (v) {
      if (v && typeof v.latest === 'number') {
        try { localStorage.setItem('slgLastReportSeen', String(v.latest)); } catch (_) {}
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (document.getElementById('slgPanelsDock')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    dock = document.createElement('div');
    dock.id = 'slgPanelsDock';
    /* ★ 用户 ⑩：「六府不要做成隐藏下拉菜单」，与左上按钮坞统一风格。
       ① 去掉「六府 ▸/▾」折叠壳，七个入口常驻可见；
       ② 出征在左上坞已有主按钮（金色强调），这里不再重复挂一份，
          六府窗内的侧边导航仍保留「出征」，面板本身的功能一个都没少；
       ③ 加一条「六府」小标题，和左上坞的「沙盘 / 浮窗」分组标签同一套写法。 */
    dock.innerHTML = '<div class="cap">六府</div><div id="slgPanelsBtns">'
      + NAV.filter(function (x) { return x[0] !== 'war'; }).map(function (x) {
        return '<button class="pb" data-id="' + x[0] + '">' + x[1] + '</button>';
      }).join('')
      /* ★ P0-2：战报入口常驻六府 dock——原「战报」按钮只在天下大势全屏地图里，
         玩家在城内视图找不到，等于没有入口。红点 = 有未读战报。 */
      + '<button class="pb" data-id="__reports">战报<span class="dot" id="slgRepDot"></span></button>'
      + '</div>';
    dock.addEventListener('click', function (e) {
      var b = e.target.closest('.pb');
      if (!b) return;
      var id = b.getAttribute('data-id');
      if (id === '__reports') {
        if (window.__slgReportsWindow) window.__slgReportsWindow();
        markReportsSeen();
        return;
      }
      open(id);
    });
    document.body.appendChild(dock);
    // ⑦ 常驻可见，不再有折叠态
    ui.dockOpen = true;
    document.getElementById('slgPanelsBtns').style.display = '';

    mask = document.createElement('div');
    mask.id = 'slgPanelsMask';
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.body.appendChild(mask);

    toastEl = document.createElement('div');
    toastEl.id = 'slgPanelsToast';
    document.body.appendChild(toastEl);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mask.style.display === 'flex') close();
    });

    /* 立绘资产异步下发：映射到位后，若武将页正开着就重绘一次，把占位的
       缩略图/大字占位换成真实原版立绘（skills.js 只回填 img[data-slgcid]，
       本层的 span/div 占位由这里负责换成 img）。 */
    window.addEventListener('slg:portraits-ready', function () {
      if (data && mask && mask.style.display === 'flex' && ui.tab === 'general') render();
    });

    window.__slgPanels = {
      open: open, close: close, refresh: fetchState,
      state: function () { return data; },
      ui: ui,
      render: render,
      setData: function (v) { data = v; render(); },
    };
    pollReports();
    setInterval(pollReports, 25000);
    fetchState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
