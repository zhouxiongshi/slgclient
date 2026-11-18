/**
 * ★ M4-11 武将编辑器 UI —— 浏览器端独立 IIFE，由 /__slg/editor/ui.js 下发。
 *   - 运行时注入，不改 offline/web/ 任何磁盘文件（红线）。
 *   - 浮层类名 slgEd-*：不带 .slgIx-modal 前缀，不计入 ui-shell 的
 *     「一屏一窗」统计；z-index 100840（确认框 100820 之上、toast 100900 之下）。
 *   - 无 Math.random（面板层禁令）；无外部依赖；Esc 关闭；焦点可见。
 *   - 入口：interaction 设置面板「武将编辑器」按钮 → window.__slgEditorOpen()。
 * ★ 2026-11-17 升级为「初始数据编辑器」（用户：「技能和属性要提供新增和编辑功能。
 *   不是存档编辑，是初始编辑……我要自己来修改和创建」）：
 *   - 页签【武将】：既有列表 + 「新增武将」（890001+ 自动编号，初始口径，
 *     新开局/酒馆生效，不改当前存档）+ 自定义武将删除。
 *   - 页签【战法】：全战法表 + 新增/编辑（conf/campaign/custom-skills.json
 *     覆盖层）+ 重置。编辑器侧校验与 skill-balance 平衡闸同口径。
 */
(function () {
  'use strict';
  if (window.__slgEditor) return;

  var API = '/__slg/editor';
  var DATA = null;           // { total, rows, ranges }
  var SKILLS = [];           // [{cfgId,name,cls,custom}]
  var SKILL_ROWS = null;     // 技能页签数据 { total, rows, meta }
  var currentCfgId = 0;
  var currentSkillId = 0;    // 0 = 新建
  var page = 0;
  var PAGE_SIZE = 50;
  var query = '';
  var onlyOverridden = false;
  var tab = 'gen';           // 'gen' | 'skill'
  var creatingGeneral = false;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, kind) {
    var box = document.getElementById('slgIxToast');
    if (!box) return;
    box.textContent = msg;
    box.className = 'slgIx-toast ' + (kind || 'info');
    box.style.display = 'block';
    clearTimeout(box._edT);
    box._edT = setTimeout(function () { box.style.display = 'none'; }, 3200);
  }
  function injectCss() {
    if (document.getElementById('slgEdCss')) return;
    var s = document.createElement('style');
    s.id = 'slgEdCss';
    s.textContent = ''
      + '.slgEd{font-size:12px;line-height:1.5;color:#e8e0cc;font-family:"Microsoft YaHei","PingFang SC",sans-serif}'
      + '.slgEd-modal{position:fixed;inset:0;z-index:100840;background:rgba(10,14,10,.62);display:flex;align-items:center;justify-content:center}'
      + '.slgEd .box{width:min(920px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#1c241c;border:1px solid #5c6b4e;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.5);padding:14px 16px}'
      + '.slgEd h3{margin:0 0 8px;font-size:16px;color:#f0e2b8}'
      + '.slgEd h4{margin:10px 0 6px;font-size:13px;color:#f0e2b8}'
      + '.slgEd .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}'
      + '.slgEd .tabbtn{border-bottom:2px solid transparent}'
      + '.slgEd .tabbtn.on{color:#f0e2b8;border-bottom-color:#e3c46a}'
      + '.slgEd input[type=text],.slgEd input[type=number],.slgEd select{font:inherit;background:#243026;color:#e8e0cc;border:1px solid #5c6b4e;border-radius:3px;padding:4px 7px;min-height:26px}'
      + '.slgEd input:focus-visible,.slgEd select:focus-visible,.slgEd button:focus-visible{outline:2px solid #e3c46a;outline-offset:1px}'
      + '.slgEd button{font:inherit;cursor:pointer;background:#243026;color:#e8e0cc;border:1px solid #5c6b4e;border-radius:3px;padding:4px 10px;min-height:26px}'
      + '.slgEd button:hover{background:#33402f;border-color:#ba9a52}'
      + '.slgEd button.primary{border-color:#ba9a52;color:#f0e2b8}'
      + '.slgEd .list{flex:1;overflow:auto;border:1px solid #3a4436;border-radius:4px;min-height:180px;max-height:42vh}'
      + '.slgEd table{width:100%;border-collapse:collapse}'
      + '.slgEd th,.slgEd td{padding:4px 7px;text-align:left;border-bottom:1px solid #2c352b;white-space:nowrap}'
      + '.slgEd th{position:sticky;top:0;background:#222b22;color:#a9a48f;font-weight:normal;font-size:11px}'
      + '.slgEd tr[data-cfgid]{cursor:pointer}'
      + '.slgEd tr[data-cfgid]:hover, .slgEd tr.sel{background:#2b3a2c}'
      + '.slgEd tr.ovr td:first-child{box-shadow:inset 3px 0 0 #ba9a52}'
      + '.slgEd .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}'
      + '.slgEd .fld{display:flex;flex-direction:column;gap:2px}'
      + '.slgEd .fld .lb{font-size:11px;color:#a9a48f}'
      + '.slgEd .ovr-tag{display:inline-block;padding:0 5px;border:1px solid #ba9a52;border-radius:2px;font-size:10px;color:#e3c46a;margin-left:6px}'
      + '.slgEd .muted{color:#a9a48f}';
    document.head.appendChild(s);
  }

  function fetchJson(url, body) {
    var opt = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' };
    return fetch(url, opt).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ---------------- 武将页签 ---------------- */

  function filteredRows() {
    var rows = (DATA && DATA.rows) || [];
    var q = query.trim().toLowerCase();
    return rows.filter(function (r) {
      if (onlyOverridden && !r.overridden) return false;
      if (!q) return true;
      return r.name.toLowerCase().indexOf(q) >= 0 || String(r.cfgId).indexOf(q) >= 0;
    });
  }

  function renderList(container) {
    var rows = filteredRows();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (page >= pages) page = pages - 1;
    var slice = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    var head = '<tr><th>武将</th><th>星</th><th>武</th><th>谋</th><th>统帅</th><th>速</th><th>攻</th><th>政</th><th>统御</th><th>自带战法</th></tr>';
    container.innerHTML = '<table>' + head + '</table><table>'
      + slice.map(function (r) {
        var sk = (SKILL_MAP[r.skillCfgId] || {}).name;
        var tags = (r.isProtagonist ? ' <span class="muted">(主公)</span>' : '')
          + (r.custom ? '<span class="ovr-tag">自建</span>' : r.overridden ? '<span class="ovr-tag">已改</span>' : '');
        return '<tr data-cfgid="' + r.cfgId + '" class="' + (r.overridden ? 'ovr' : '')
          + (r.cfgId === currentCfgId && !creatingGeneral ? ' sel' : '') + '">'
          + '<td>' + esc(r.name) + tags + '</td>'
          + '<td>' + r.star + '</td>'
          + '<td>' + r.stats.force + '</td><td>' + r.stats.strategy + '</td><td>' + r.stats.defense + '</td>'
          + '<td>' + r.stats.speed + '</td><td>' + r.stats.destroy + '</td>'
          + '<td>' + r.stats.politics + '</td><td>' + r.cost + '</td>'
          + '<td>' + (sk ? esc(sk) : '<span class="muted">—</span>') + '</td></tr>';
      }).join('') + '</table>';
    return { rows: rows.length, pages: pages };
  }

  var SKILL_MAP = {};

  function renderGeneralDetail(detail) {
    var row = DATA.rows.find(function (r) { return r.cfgId === currentCfgId; });
    if (!row) { detail.innerHTML = '<span class="muted">点击上方列表选择武将，或点「新增武将」。</span>'; return; }
    var ranges = DATA.ranges;
    var statKeys = ['force', 'strategy', 'defense', 'speed', 'destroy', 'politics'];
    var growKeys = ['force_grow', 'strategy_grow', 'defense_grow', 'speed_grow', 'destroy_grow'];
    var growNames = { force_grow: '武力成长', strategy_grow: '谋略成长', defense_grow: '防御成长', speed_grow: '速度成长', destroy_grow: '攻城成长' };
    function fld(k, v, r) {
      return '<div class="fld"><span class="lb">' + esc(r.label || k) + ' (' + r.min + '~' + r.max + ')</span>'
        + '<input type="number" data-field="' + k + '" value="' + v + '" min="' + r.min + '" max="' + r.max + '"></div>';
    }
    var skillOpts = '<option value="0">— 无（白板）—</option>' + SKILLS.map(function (s) {
      return '<option value="' + s.cfgId + '"' + (s.cfgId === row.skillCfgId ? ' selected' : '') + '>'
        + esc(s.name) + ' #' + s.cfgId + '</option>';
    }).join('');
    detail.innerHTML = '<h4>' + esc(row.name) + '（#' + row.cfgId + '）'
      + (row.custom ? '<span class="ovr-tag">自建 · 可删除</span>' : row.overridden ? '<span class="ovr-tag">已改 · 可重置</span>' : '') + '</h4>'
      + '<div class="grid">'
      + statKeys.map(function (k) { return fld(k, row.stats[k], ranges[k]); }).join('')
      + '<div class="fld"><span class="lb">统御上限 (1~45)</span><input type="number" data-field="cost" value="' + row.cost + '" min="1" max="45"></div>'
      + '<div class="fld"><span class="lb">星级 (1~5)</span><input type="number" data-field="star" value="' + row.star + '" min="1" max="5"></div>'
      + '</div>'
      + '<h4>每级成长率（Lv10 属性 = 基础 + 9×每级点数，点数 = 成长率/10，上限按 100 封顶）</h4>'
      + '<div class="grid">' + growKeys.map(function (k) { return fld(k, row.grows[k], ranges[k]); }).join('') + '</div>'
      + '<h4>自带战法</h4>'
      + '<div class="bar"><select data-field="skillCfgId" style="max-width:340px">' + skillOpts + '</select>'
      + '<span class="muted">新招募/新开局按此生效；当前存档武将立即同步。</span></div>'
      + '<div class="bar" style="margin-top:10px">'
      + '<button class="primary" data-act="save">保存</button>'
      + (row.custom ? '<button data-act="delcustom">删除该自建武将</button>' : row.overridden ? '<button data-act="reset">重置为原值</button>' : '')
      + '<span class="muted">保存写入 GM 覆盖层 conf/campaign/overrides.json（generals 段），原表逐字不动。</span>'
      + '</div>';
  }

  function renderCreateGeneral(detail) {
    var ranges = DATA.ranges;
    var statKeys = ['force', 'strategy', 'defense', 'speed', 'destroy', 'politics'];
    var growKeys = ['force_grow', 'strategy_grow', 'defense_grow', 'speed_grow', 'destroy_grow'];
    var growNames = { force_grow: '武力成长', strategy_grow: '谋略成长', defense_grow: '防御成长', speed_grow: '速度成长', destroy_grow: '攻城成长' };
    function fld(k, label, min, max, v) {
      return '<div class="fld"><span class="lb">' + esc(label) + ' (' + min + '~' + max + ')</span>'
        + '<input type="number" data-field="' + k + '" value="' + (v == null ? '' : v) + '" min="' + min + '" max="' + max + '"></div>';
    }
    var skillOpts = '<option value="0">— 无（白板）—</option>' + SKILLS.map(function (s) {
      return '<option value="' + s.cfgId + '">' + esc(s.name) + ' #' + s.cfgId + '</option>';
    }).join('');
    detail.innerHTML = '<h4>新增武将 <span class="muted">（cfgId 自动从 890001 起分配；初始口径：新开局与酒馆客池生效，不改当前存档）</span></h4>'
      + '<div class="bar">'
      + '<div class="fld"><span class="lb">武将名（必填，1~12 字）</span><input type="text" data-field="name" maxlength="12" style="width:160px"></div>'
      + '<div class="fld"><span class="lb">势力/籍贯（可空）</span><input type="text" data-field="country" maxlength="6" style="width:110px"></div>'
      + '<div class="fld"><span class="lb">主兵种 (1~9)</span><input type="number" data-field="arms" value="1" min="1" max="9"></div>'
      + '</div>'
      + '<div class="grid">'
      + statKeys.map(function (k) { return fld(k, ranges[k].label, ranges[k].min, ranges[k].max, 50); }).join('')
      + fld('cost', '统御上限', 1, 45, 15)
      + fld('star', '星级', 1, 5, 3)
      + '</div>'
      + '<h4>每级成长率（留空按 30）</h4>'
      + '<div class="grid">' + growKeys.map(function (k) { return fld(k, growNames[k], 1, 100, 30); }).join('') + '</div>'
      + '<h4>自带战法</h4>'
      + '<div class="bar"><select data-field="skillCfgId" style="max-width:340px">' + skillOpts + '</select></div>'
      + '<div class="bar" style="margin-top:10px">'
      + '<button class="primary" data-act="create">创建</button>'
      + '<button data-act="cancelcreate">取消</button>'
      + '</div>';
  }

  /* ---------------- 战法页签 ---------------- */

  var CLS_NAMES = { 指挥: '指挥', 被动: '被动', 主动: '主动', 追击: '追击' };
  var EFF_NAMES = { PHYSICAL_DAMAGE: '兵刃伤害', STRATEGY_DAMAGE: '谋略伤害', HEAL: '治疗', CONTROL: '控制' };
  var TGT_NAMES = { enemy_single: '敌军单体', enemy_all: '敌军全体', ally_group: '我方全体', self: '自身' };

  function filteredSkillRows() {
    var rows = (SKILL_ROWS && SKILL_ROWS.rows) || [];
    var q = query.trim().toLowerCase();
    return rows.filter(function (r) {
      if (onlyOverridden && !r.custom) return false;
      if (!q) return true;
      return r.name.toLowerCase().indexOf(q) >= 0 || String(r.cfgId).indexOf(q) >= 0;
    });
  }

  function renderSkillList(container) {
    var rows = filteredSkillRows();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (page >= pages) page = pages - 1;
    var slice = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    var head = '<tr><th>战法</th><th>类别</th><th>效果</th><th>目标</th><th>发动率</th><th>数值 Lv1→Lv10</th></tr>';
    container.innerHTML = '<table>' + head + '</table><table>'
      + slice.map(function (r) {
        var tags = r.custom ? '<span class="ovr-tag">自建</span>' : '';
        var val = r.effect === 'CONTROL' ? ('命中 ' + r.rate1 + '→' + r.rate10 + '%')
          : r.rate10 > 0 ? (EFF_NAMES[r.effect] === '治疗' ? '治疗率 ' : '伤害率 ') + r.rate1 + '→' + r.rate10 + '%'
          : '<span class="muted">—</span>';
        return '<tr data-cfgid="' + r.cfgId + '" class="' + (r.custom ? 'ovr' : '')
          + (r.cfgId === currentSkillId ? ' sel' : '') + '">'
          + '<td>' + esc(r.name) + ' #' + r.cfgId + tags + '</td>'
          + '<td>' + esc(r.cls || '') + '</td>'
          + '<td>' + esc(EFF_NAMES[r.effect] || r.effect || '—') + '</td>'
          + '<td>' + esc(TGT_NAMES[r.target] || r.target || '—') + '</td>'
          + '<td>' + r.p1 + '→' + r.p10 + '%</td>'
          + '<td>' + val + '</td></tr>';
      }).join('') + '</table>';
    return { rows: rows.length, pages: pages };
  }

  /* 由服务端 buildCustomSkill 校验；多槽战法被重写前由用户自查（列表展示效果构成）。 */

  function renderSkillDetail(detail) {
    var meta = (SKILL_ROWS && SKILL_ROWS.meta) || {};
    var row = null;
    if (currentSkillId) row = ((SKILL_ROWS && SKILL_ROWS.rows) || []).find(function (r) { return r.cfgId === currentSkillId; });
    var isCmd = false, isCtl = false, eff = 'PHYSICAL_DAMAGE';
    var v1 = 100, v10 = 200, p1 = 35, p10 = 40;
    if (row) {
      eff = row.effect || 'PHYSICAL_DAMAGE';
      isCmd = row.cls === '指挥' || row.cls === '被动';
      isCtl = eff === 'CONTROL';
      v1 = row.rate1; v10 = row.rate10; p1 = row.p1; p10 = row.p10;
    }
    var clsSel = row ? row.cls : '主动';
    var tgtSel = row ? (row.target || 'enemy_single') : 'enemy_single';
    var clsOpts = ['指挥', '被动', '主动', '追击'].map(function (c) {
      return '<option value="' + c + '"' + (c === clsSel ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
    var effOpts = Object.keys(EFF_NAMES).map(function (k) {
      return '<option value="' + k + '"' + (k === eff ? ' selected' : '') + '>' + EFF_NAMES[k] + '</option>';
    }).join('');
    var tgtOpts = Object.keys(TGT_NAMES).map(function (k) {
      return '<option value="' + k + '"' + (k === tgtSel ? ' selected' : '') + '>' + TGT_NAMES[k] + '</option>';
    }).join('');
    var ctlSel = (row && row.controlState) || '混乱';
    var ctlOpts = (meta.controlStates || ['混乱', '动摇', '犹豫']).map(function (c) {
      return '<option value="' + c + '"' + (c === ctlSel ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
    var valueLabel = isCtl ? '命中率 Lv1（1~50，Lv10 自动 ×2）' : (EFF_NAMES[eff] === '治疗' ? '治疗率' : '伤害率') + ' Lv1（5~300）';
    detail.innerHTML = '<h4>' + (row ? '编辑战法「' + esc(row.name) + '」（#' + row.cfgId + (row.custom ? ' · 自建，可重置/删除' : ' · 原表条目，保存即覆盖') + '）'
      : '新增战法 <span class="muted">（cfgId 自动从 29001 起分配）</span>') + '</h4>'
      + '<div class="bar">'
      + '<div class="fld"><span class="lb">战法名（1~10 字）</span><input type="text" data-field="name" maxlength="10" style="width:150px" value="' + (row ? esc(row.name) : '') + '"></div>'
      + '<div class="fld"><span class="lb">类别</span><select data-field="skillClass">' + clsOpts + '</select></div>'
      + '<div class="fld"><span class="lb">效果</span><select data-field="effectType">' + effOpts + '</select></div>'
      + '<div class="fld"><span class="lb">目标</span><select data-field="targetType">' + tgtOpts + '</select></div>'
      + '<div class="fld" data-ctlwrap><span class="lb">控制状态</span><select data-field="controlState">' + ctlOpts + '</select></div>'
      + '</div>'
      + '<div class="bar">'
      + '<div class="fld"><span class="lb">发动率 Lv1 %（30~45）</span><input type="number" data-field="probLv1" value="' + p1 + '" min="1" max="100"></div>'
      + '<div class="fld"><span class="lb">发动率 Lv10 %（32~50）</span><input type="number" data-field="probLv10" value="' + p10 + '" min="1" max="100"></div>'
      + '<div class="fld"><span class="lb">' + esc(valueLabel) + '</span><input type="number" data-field="valueLv1" value="' + v1 + '" min="1" max="300"></div>'
      + '<div class="fld" data-v10wrap><span class="lb">数值 Lv10</span><input type="number" data-field="valueLv10" value="' + (isCtl ? v1 * 2 : v10) + '" min="1" max="300"></div>'
      + '<span class="muted" data-hint style="max-width:280px"></span>'
      + '</div>'
      + '<div class="bar" style="margin-top:10px">'
      + '<button class="primary" data-act="skillSave">' + (row ? '保存（' + (row.custom ? '更新自建' : '覆盖原表条目') + '）' : '创建') + '</button>'
      + (row && row.custom ? '<button data-act="skillReset">重置/删除</button>' : '')
      + '<button data-act="skillNew">新建另一条</button>'
      + '<span class="muted">写入 conf/campaign/custom-skills.json 覆盖层，原五表逐字不动；指挥/被动恒 100% 发动；输出指数按平衡口径校验（300~2000）。</span>'
      + '</div>';
    syncSkillFormUI(detail);
  }

  /** 按当前表单值联动：指挥/被动锁 100%、控制隐藏 Lv10、实时输出指数提示。 */
  function syncSkillFormUI(detail) {
    var cls = detail.querySelector('[data-field=skillClass]').value;
    var eff = detail.querySelector('[data-field=effectType]').value;
    var tgt = detail.querySelector('[data-field=targetType]').value;
    var isCmd = cls === '指挥' || cls === '被动';
    var isCtl = eff === 'CONTROL';
    detail.querySelector('[data-ctlwrap]').style.display = isCtl ? '' : 'none';
    detail.querySelector('[data-v10wrap]').style.display = isCtl ? 'none' : '';
    var p1 = detail.querySelector('[data-field=probLv1]');
    var p10 = detail.querySelector('[data-field=probLv10]');
    if (isCmd) { p1.value = 100; p10.value = 100; p1.disabled = true; p10.disabled = true; }
    else { p1.disabled = false; p10.disabled = false; if (Number(p1.value) > 45) p1.value = 45; if (Number(p10.value) > 50) p10.value = 50; }
    // ★ 与服务端 buildCustomSkill 同口径：输出指数取 Lv10 数值（不是 Lv1），
    //   否则 UI 提示"通过"却被服务端闸拒绝（或反之）。
    var v10 = Number(detail.querySelector('[data-field=valueLv10]').value) || 0;
    var casts = cls === '指挥' ? 1 : 8;
    var targets = /group|all|ally/i.test(tgt) ? 3 : 1;
    var idx = isCtl ? 0 : Math.round(casts * (Number(p10.value) / 100) * v10 * targets);
    var hint = detail.querySelector('[data-hint]');
    if (isCtl) hint.textContent = '控制命中率 Lv10 自动取 Lv1×2（≤100%）。';
    else if (isCmd) hint.textContent = '输出指数 ≈ ' + idx + '（必发动技 ≤ 2000）';
    else hint.textContent = '输出指数 ≈ ' + idx + '（应 300~2000' + (targets >= 3 ? '，群体下限 600' : '') + '）';
  }

  /* ---------------- 渲染调度 ---------------- */

  function render(box) {
    var tabBtns = box.querySelector('.tabs');
    tabBtns.innerHTML = '<button class="tabbtn' + (tab === 'gen' ? ' on' : '') + '" data-tab="gen">武将</button>'
      + '<button class="tabbtn' + (tab === 'skill' ? ' on' : '') + '" data-tab="skill">战法</button>';
    var listWrap = box.querySelector('.list');
    var detail = box.querySelector('.detail');
    var info = box.querySelector('.ed-info');
    var barExtra = box.querySelector('.bar-extra');
    if (tab === 'gen') {
      var g = renderList(listWrap);
      info.textContent = '共 ' + DATA.total + ' 位；筛选后 ' + g.rows + ' 位（第 ' + (page + 1) + '/' + g.pages + ' 页）';
      barExtra.innerHTML = '<label style="display:flex;align-items:center;gap:4px"><input type="checkbox" class="ovrOnly"' + (onlyOverridden ? ' checked' : '') + '>只看已改/自建</label>'
        + '<button data-act="newgeneral"' + (creatingGeneral ? ' disabled' : '') + '>新增武将</button>'
        + '<input type="text" class="q" placeholder="搜索武将名 / cfgId" style="width:180px" value="' + esc(query) + '">';
      if (creatingGeneral) { currentCfgId = 0; renderCreateGeneral(detail); }
      else renderGeneralDetail(detail);
    } else {
      var s = renderSkillList(listWrap);
      info.textContent = '共 ' + SKILL_ROWS.total + ' 条；筛选后 ' + s.rows + ' 条（第 ' + (page + 1) + '/' + s.pages + ' 页）';
      barExtra.innerHTML = '<label style="display:flex;align-items:center;gap:4px"><input type="checkbox" class="ovrOnly"' + (onlyOverridden ? ' checked' : '') + '>只看自建</label>'
        + '<button data-act="newskill">新增战法</button>'
        + '<input type="text" class="q" placeholder="搜索战法名 / cfgId" style="width:180px" value="' + esc(query) + '">';
      renderSkillDetail(detail);
    }
    wire(box);
  }

  var wired = null;
  function wire(box) {
    if (wired) wired(); // 解绑上一轮监听
    var offs = [];
    function on(node, ev, fn) { node.addEventListener(ev, fn); offs.push(function () { node.removeEventListener(ev, fn); }); }

    box.querySelectorAll('.tabbtn').forEach(function (b) {
      on(b, 'click', function () {
        tab = b.dataset.tab; page = 0; query = ''; // 切页签清空搜索词，避免上一页关键词误过滤当前页签
        currentSkillId = 0; creatingGeneral = false; render(box);
      });
    });
    var q = box.querySelector('.q');
    if (q) on(q, 'input', function () { query = q.value; page = 0; render(box); });
    var ov = box.querySelector('.ovrOnly');
    if (ov) on(ov, 'change', function (e) { onlyOverridden = e.target.checked; page = 0; render(box); });
    on(box.querySelector('[data-act=prev]'), 'click', function () { if (page > 0) { page -= 1; render(box); } });
    on(box.querySelector('[data-act=next]'), 'click', function () { page += 1; render(box); });
    on(box.querySelector('[data-act=close]'), 'click', function () { mask.remove(); });

    var listWrap = box.querySelector('.list');
    on(listWrap, 'click', function (e) {
      var tr = e.target.closest('tr[data-cfgid]');
      if (!tr) return;
      var id = Number(tr.dataset.cfgid);
      if (tab === 'gen') { currentCfgId = id; creatingGeneral = false; }
      else currentSkillId = id;
      render(box);
    });

    var detail = box.querySelector('.detail');
    var onFormInput = function (e) {
      if (tab === 'skill' && e.target.matches && e.target.matches('[data-field]')) syncSkillFormUI(detail);
    };
    on(detail, 'input', onFormInput);
    on(detail, 'click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var act = b.dataset.act;
      if (act === 'cancelcreate') { creatingGeneral = false; render(box); return; }
      if (act === 'newgeneral') { creatingGeneral = true; currentCfgId = 0; render(box); return; }
      if (act === 'newskill') { currentSkillId = 0; render(box); return; }
      if (act === 'skillSave') {
        var payload = {};
        detail.querySelectorAll('[data-field]').forEach(function (i) { payload[i.dataset.field] = i.value; });
        if (currentSkillId) payload.cfgId = currentSkillId;
        fetchJson(API + '/skill/save', payload).then(function (r) {
          if (!r.ok) { toast(r.message || '保存失败', 'fail'); return; }
          toast(r.message || '已保存', 'ok');
          return reloadAll().then(function () { render(box); });
        }).catch(function (err) { toast('保存失败：' + err.message, 'fail'); });
        return;
      }
      if (act === 'skillReset') {
        fetchJson(API + '/skill/reset', { cfgId: currentSkillId }).then(function (r) {
          if (!r.ok) { toast(r.message || '重置失败', 'fail'); return; }
          toast(r.message || '已重置', 'ok');
          currentSkillId = 0;
          return reloadAll().then(function () { render(box); });
        }).catch(function (err) { toast('重置失败：' + err.message, 'fail'); });
        return;
      }
      if (act === 'create') {
        var cg = {};
        detail.querySelectorAll('[data-field]').forEach(function (i) { cg[i.dataset.field] = i.value; });
        fetchJson(API + '/create', cg).then(function (r) {
          if (!r.ok) { toast(r.message || '创建失败', 'fail'); return; }
          toast(r.message || '已创建', 'ok');
          creatingGeneral = false;
          currentCfgId = r.cfgId;
          return reloadAll().then(function () { render(box); });
        }).catch(function (err) { toast('创建失败：' + err.message, 'fail'); });
        return;
      }
      if (!currentCfgId && (act === 'save' || act === 'reset' || act === 'delcustom')) return;
      if (act === 'save') {
        var payload2 = { cfgId: currentCfgId };
        detail.querySelectorAll('[data-field]').forEach(function (i) { payload2[i.dataset.field] = i.value; });
        fetchJson(API + '/save', payload2).then(function (r) {
          if (!r.ok) { toast(r.message || '保存失败', 'fail'); return; }
          toast('已保存 ' + (r.row ? r.row.name : '') + ' 的修改' + (r.stateSynced ? '，当前存档已同步' : ''), 'ok');
          return reloadAll().then(function () { render(box); });
        }).catch(function (err) { toast('保存失败：' + err.message, 'fail'); });
      }
      if (act === 'reset') {
        fetchJson(API + '/reset', { cfgId: currentCfgId }).then(function (r) {
          if (!r.ok) { toast(r.message || '重置失败', 'fail'); return; }
          toast('已恢复原值', 'ok');
          return reloadAll().then(function () { render(box); });
        }).catch(function (err) { toast('重置失败：' + err.message, 'fail'); });
      }
      if (act === 'delcustom') {
        fetchJson(API + '/delete', { cfgId: currentCfgId }).then(function (r) {
          if (!r.ok) { toast(r.message || '删除失败', 'fail'); return; }
          toast(r.message || '已删除', 'ok');
          currentCfgId = 0;
          return reloadAll().then(function () { render(box); });
        }).catch(function (err) { toast('删除失败：' + err.message, 'fail'); });
      }
    });
    detail.addEventListener('input', function (e) {
      if (tab === 'skill' && e.target.matches('[data-field]')) syncSkillFormUI(detail);
    });
    wired = function () { offs.forEach(function (f) { f(); }); };
  }

  var mask = null;

  function open() {
    injectCss();
    mask = el('div', 'slgEd-modal');
    var box = el('div', 'box slgEd');
    box.innerHTML = '<h3>初始数据编辑器 <span class="muted" style="font-size:11px;font-weight:normal">武将 / 战法 · 新增与编辑 · 覆盖层写法，原表逐字不动</span></h3>'
      + '<div class="bar">'
      + '<span class="tabs" style="display:flex;gap:8px"></span>'
      + '<span class="bar-extra" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:1"></span>'
      + '<button data-act="prev">上一页</button><button data-act="next">下一页</button>'
      + '<span class="ed-info muted"></span>'
      + '<button data-act="close">关闭 (Esc)</button>'
      + '</div>'
      + '<div class="list"></div>'
      + '<div class="detail" style="margin-top:10px"></div>';
    mask.appendChild(box);
    (document.getElementById('slgIxRoot') || document.body).appendChild(mask);
    render(box);
    var escHandler = function (e) {
      if (e.key === 'Escape' && mask.isConnected) { mask.remove(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
  }

  function loadGenerals() {
    return fetchJson(API + '/state').then(function (d) {
      if (!d.ok) throw new Error(d.message || '加载失败');
      DATA = d;
      SKILLS = d.skills || [];
      SKILL_MAP = {};
      SKILLS.forEach(function (s) { SKILL_MAP[s.cfgId] = s; });
    });
  }
  function loadSkills() {
    return fetchJson(API + '/skills').then(function (d) {
      if (!d.ok) throw new Error(d.message || '加载失败');
      SKILL_ROWS = d;
    });
  }
  function reloadAll() {
    return loadGenerals().then(loadSkills).catch(function () { /* 战法页失败不阻塞武将页 */ });
  }

  window.__slgEditorOpen = function () {
    var go = function () { open(); };
    if (!DATA) {
      reloadAll().then(go).catch(function (err) { toast('编辑器数据不可用：' + err.message, 'fail'); });
      return;
    }
    /* 重开时刷新一次（属性可能被 GM/剧情改动过）。 */
    reloadAll().then(go).catch(go);
  };
  window.__slgEditor = { open: window.__slgEditorOpen };
})();
