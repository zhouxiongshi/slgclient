/**
 * ★ M4-11 武将编辑器 UI —— 浏览器端独立 IIFE，由 /__slg/editor/ui.js 下发。
 *   - 运行时注入，不改 offline/web/ 任何磁盘文件（红线）。
 *   - 浮层类名 slgEd-*：不带 .slgIx-modal 前缀，不计入 ui-shell 的
 *     「一屏一窗」统计；z-index 100840（确认框 100820 之上、toast 100900 之下）。
 *   - 无 Math.random（面板层禁令）；无外部依赖；Esc 关闭；焦点可见。
 *   - 入口：interaction 设置面板「武将编辑器」按钮 → window.__slgEditorOpen()。
 */
(function () {
  'use strict';
  if (window.__slgEditor) return;

  var API = '/__slg/editor';
  var DATA = null;           // { total, rows, ranges }
  var SKILLS = [];           // [{cfgId,name}]
  var currentCfgId = 0;
  var page = 0;
  var PAGE_SIZE = 50;
  var query = '';
  var onlyOverridden = false;

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
      + '.slgEd .box{width:min(880px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#1c241c;border:1px solid #5c6b4e;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.5);padding:14px 16px}'
      + '.slgEd h3{margin:0 0 8px;font-size:16px;color:#f0e2b8}'
      + '.slgEd h4{margin:10px 0 6px;font-size:13px;color:#f0e2b8}'
      + '.slgEd .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}'
      + '.slgEd input[type=text],.slgEd input[type=number],.slgEd select{font:inherit;background:#243026;color:#e8e0cc;border:1px solid #5c6b4e;border-radius:3px;padding:4px 7px;min-height:26px}'
      + '.slgEd input:focus-visible,.slgEd select:focus-visible,.slgEd button:focus-visible{outline:2px solid #e3c46a;outline-offset:1px}'
      + '.slgEd button{font:inherit;cursor:pointer;background:#243026;color:#e8e0cc;border:1px solid #5c6b4e;border-radius:3px;padding:4px 10px;min-height:26px}'
      + '.slgEd button:hover{background:#33402f;border-color:#ba9a52}'
      + '.slgEd button.primary{border-color:#ba9a52;color:#f0e2b8}'
      + '.slgEd .list{flex:1;overflow:auto;border:1px solid #3a4436;border-radius:4px;min-height:180px;max-height:46vh}'
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
        return '<tr data-cfgid="' + r.cfgId + '" class="' + (r.overridden ? 'ovr' : '')
          + (r.cfgId === currentCfgId ? ' sel' : '') + '">'
          + '<td>' + esc(r.name) + (r.isProtagonist ? ' <span class="muted">(主公)</span>' : '') + (r.overridden ? '<span class="ovr-tag">已改</span>' : '') + '</td>'
          + '<td>' + r.star + '</td>'
          + '<td>' + r.stats.force + '</td><td>' + r.stats.strategy + '</td><td>' + r.stats.defense + '</td>'
          + '<td>' + r.stats.speed + '</td><td>' + r.stats.destroy + '</td>'
          + '<td>' + r.stats.politics + '</td><td>' + r.cost + '</td>'
          + '<td>' + (sk ? esc(sk) : '<span class="muted">—</span>') + '</td></tr>';
      }).join('') + '</table>';
    return { rows: rows.length, pages: pages };
  }

  var SKILL_MAP = {};

  function render(box) {
    var listWrap = box.querySelector('.list');
    var info = renderList(listWrap);
    box.querySelector('.ed-info').textContent =
      '共 ' + DATA.total + ' 位；筛选后 ' + info.rows + ' 位（第 ' + (page + 1) + '/' + info.pages + ' 页）';
    var detail = box.querySelector('.detail');
    var row = DATA.rows.find(function (r) { return r.cfgId === currentCfgId; });
    if (!row) { detail.innerHTML = '<span class="muted">点击上方列表选择武将。</span>'; return; }
    var ranges = DATA.ranges;
    var statKeys = ['force', 'strategy', 'defense', 'speed', 'destroy', 'politics'];
    var growKeys = ['force_grow', 'strategy_grow', 'defense_grow', 'speed_grow', 'destroy_grow'];
    var statNames = { force: '武力', strategy: '谋略', defense: '统帅', speed: '速度', destroy: '攻城', politics: '政治' };
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
      + (row.overridden ? '<span class="ovr-tag">已改 · 可重置</span>' : '') + '</h4>'
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
      + (row.overridden ? '<button data-act="reset">重置为原值</button>' : '')
      + '<span class="muted">保存写入 GM 覆盖层 conf/campaign/overrides.json（generals 段），原表逐字不动。</span>'
      + '</div>';
  }

  function open() {
    if (!DATA) return;
    injectCss();
    var mask = el('div', 'slgEd-modal');
    var box = el('div', 'box slgEd');
    box.innerHTML = '<h3>武将编辑器 <span class="muted" style="font-size:11px;font-weight:normal">M4-11 · 全部武将属性与自带战法（覆盖层，可重置）</span></h3>'
      + '<div class="bar">'
      + '<input type="text" class="q" placeholder="搜索武将名 / cfgId" style="width:200px">'
      + '<label style="display:flex;align-items:center;gap:4px"><input type="checkbox" class="ovrOnly">只看已改</label>'
      + '<button data-act="prev">上一页</button><button data-act="next">下一页</button>'
      + '<span class="ed-info muted"></span>'
      + '<span style="flex:1"></span>'
      + '<button data-act="close">关闭 (Esc)</button>'
      + '</div>'
      + '<div class="list"></div>'
      + '<div class="detail" style="margin-top:10px"></div>';
    mask.appendChild(box);
    (document.getElementById('slgIxRoot') || document.body).appendChild(mask);
    render(box);

    var q = box.querySelector('.q');
    q.addEventListener('input', function () { query = q.value; page = 0; render(box); });
    box.querySelector('.ovrOnly').addEventListener('change', function (e) { onlyOverridden = e.target.checked; page = 0; render(box); });
    box.querySelector('[data-act=prev]').addEventListener('click', function () { if (page > 0) { page -= 1; render(box); } });
    box.querySelector('[data-act=next]').addEventListener('click', function () { page += 1; render(box); });
    box.querySelector('[data-act=close]').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    var escHandler = function (e) {
      if (e.key === 'Escape' && mask.isConnected) { mask.remove(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    box.querySelector('.list').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-cfgid]');
      if (!tr) return;
      currentCfgId = Number(tr.dataset.cfgid);
      render(box);
    });
    box.querySelector('.detail').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var act = b.dataset.act;
      if (!currentCfgId) return;
      var payload = { cfgId: currentCfgId };
      box.querySelectorAll('[data-field]').forEach(function (i) {
        payload[i.dataset.field] = i.value;
      });
      if (act === 'save') {
        fetchJson(API + '/save', payload).then(function (r) {
          if (!r.ok) { toast(r.message || '保存失败', 'fail'); return; }
          toast('已保存 ' + (r.row ? r.row.name : '') + ' 的修改' + (r.stateSynced ? '，当前存档已同步' : ''), 'ok');
          return loadData().then(function () { render(box); });
        }).catch(function (err) { toast('保存失败：' + err.message, 'fail'); });
      }
      if (act === 'reset') {
        fetchJson(API + '/reset', { cfgId: currentCfgId }).then(function (r) {
          if (!r.ok) { toast(r.message || '重置失败', 'fail'); return; }
          toast('已恢复原值', 'ok');
          return loadData().then(function () { render(box); });
        }).catch(function (err) { toast('重置失败：' + err.message, 'fail'); });
      }
    });
  }

  function loadData() {
    return fetchJson(API + '/state').then(function (d) {
      if (!d.ok) throw new Error(d.message || '加载失败');
      DATA = d;
      SKILLS = d.skills || [];
      SKILL_MAP = {};
      SKILLS.forEach(function (s) { SKILL_MAP[s.cfgId] = s; });
    });
  }

  window.__slgEditorOpen = function () {
    if (!DATA) {
      loadData().then(open).catch(function (err) { toast('编辑器数据不可用：' + err.message, 'fail'); });
      return;
    }
    /* 重开时刷新一次（属性可能被 GM/剧情改动过）。 */
    loadData().then(open).catch(function () { open(); });
  };
  window.__slgEditor = { open: window.__slgEditorOpen };
})();
