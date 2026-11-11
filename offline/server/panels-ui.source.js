/* 六大面板 UI —— 浏览器端独立脚本，由 /__slg/panels/ui.js 下发。
 * 只在运行时注入到 index.html 的响应里，磁盘 web/ 与打包产物逐字节不变。
 * 与 server/skills.js 的覆盖层完全解耦：不引用、不修改它的任何全局变量。
 */
;(function () {
  'use strict';
  if (window.__slgPanels) return;

  var API = '/__slg/panels';
  var data = null;
  var ui = {
    tab: 'general', genId: 0, genTab: 'attr',
    itemFilter: 'all', skillFilter: 'all', skillQuery: '', openSkill: 0,
    selectedCity: 0, dockOpen: true,
  };
  var dock = null, mask = null, toastEl = null;

  /* ---------------- 基础工具 ---------------- */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function n(v) { var x = Number(v); return Number.isFinite(x) ? x : 0; }
  function fmt(v) { return n(v).toLocaleString('zh-CN'); }
  function pct(a, b) { return b > 0 ? (n(a) / n(b) * 100).toFixed(1) + '%' : '—'; }
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
    if (window.confirm(text)) onYes();
  }

  /* ---------------- 样式 ---------------- */
  var CSS = [
    '#slgPanelsDock{position:fixed;right:12px;top:12px;z-index:100090;display:flex;flex-direction:column;gap:5px;align-items:flex-end;}',
    '#slgPanelsDock .pb{background:rgba(20,22,16,.94);color:#e8c670;border:1px solid #ba9a52;border-radius:5px;',
    '  padding:5px 10px;min-width:88px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;text-align:left;letter-spacing:1px;}',
    '#slgPanelsDock .pb:hover{background:#3a3423;color:#ffe6a6;}',
    '#slgPanelsDock .pb.on{background:#6b5527;color:#fff2cf;}',
    '#slgPanelsDock .fold{background:rgba(20,22,16,.9);color:#c9b98c;border:1px solid #6a624a;border-radius:5px;',
    '  padding:2px 9px;cursor:pointer;font:12px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsMask{position:fixed;inset:0;z-index:100100;background:rgba(6,8,6,.9);display:none;}',
    '#slgPanelsWin{position:absolute;inset:18px;max-width:1280px;margin:0 auto;background:#151811;',
    '  border:1px solid #75643d;border-radius:10px;box-shadow:0 18px 70px rgba(0,0,0,.8);display:flex;overflow:hidden;}',
    '#slgPanelsWin .side{width:178px;flex:0 0 178px;background:#101209;border-right:1px solid #3b3829;padding:14px 10px;overflow-y:auto;}',
    '#slgPanelsWin .brand{color:#e8c670;font:700 16px "Microsoft YaHei",sans-serif;letter-spacing:2px;padding:4px 8px 14px;}',
    '#slgPanelsWin .side .nav{display:block;width:100%;text-align:left;background:transparent;color:#c9bfa3;',
    '  border:1px solid transparent;border-radius:5px;padding:9px 10px;margin-bottom:5px;cursor:pointer;',
    '  font:14px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .side .nav:hover{background:#23261a;color:#f0dca8;}',
    '#slgPanelsWin .side .nav.on{background:#3a3220;border-color:#ba9a52;color:#ffe6a6;}',
    '#slgPanelsWin .side .tip{color:#8d8a74;font:12px/1.7 "Microsoft YaHei",sans-serif;padding:10px 8px;border-top:1px solid #2b2b20;margin-top:10px;}',
    '#slgPanelsWin .main{flex:1;min-width:0;display:flex;flex-direction:column;}',
    '#slgPanelsWin .top{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:12px;padding:0 16px;',
    '  border-bottom:1px solid #3b3829;background:#1b1d14;color:#e8c670;font:14px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .top .sp{flex:1;color:#b9b197;font-size:13px;}',
    '#slgPanelsWin .top button{background:#2a2c22;color:#e8c670;border:1px solid #6a624a;border-radius:4px;',
    '  padding:4px 12px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .body{flex:1;overflow-y:auto;padding:16px 18px 28px;color:#ddd2b6;',
    '  font:13px/1.75 "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .body::-webkit-scrollbar{width:9px;}#slgPanelsWin .body::-webkit-scrollbar-thumb{background:#4b4632;border-radius:5px;}',
    '#slgPanelsWin h3{color:#e8c670;font:700 15px "Microsoft YaHei",sans-serif;margin:0 0 10px;letter-spacing:1px;}',
    '#slgPanelsWin h4{color:#cbb477;font:700 13px "Microsoft YaHei",sans-serif;margin:16px 0 8px;}',
    '#slgPanelsWin .card{background:#1d2017;border:1px solid #3d3b2b;border-radius:7px;padding:12px 14px;margin-bottom:12px;}',
    '#slgPanelsWin .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:10px;}',
    '#slgPanelsWin .k{color:#8f9c84;}#slgPanelsWin .v{color:#f0e2bd;}',
    '#slgPanelsWin .up{color:#e8a06a;}#slgPanelsWin .down{color:#9dca8b;}',
    '#slgPanelsWin .btn{background:#2c2f22;color:#e8c670;border:1px solid #7a6a42;border-radius:4px;',
    '  padding:4px 11px;cursor:pointer;font:12px "Microsoft YaHei",sans-serif;margin:2px 4px 2px 0;}',
    '#slgPanelsWin .btn:hover{background:#474029;}#slgPanelsWin .btn:disabled{opacity:.4;cursor:not-allowed;}',
    '#slgPanelsWin .btn.warn{border-color:#a8664c;color:#e6a786;}',
    '#slgPanelsWin table{width:100%;border-collapse:collapse;font-size:13px;}',
    '#slgPanelsWin th,#slgPanelsWin td{border-bottom:1px solid #333326;padding:7px 9px;text-align:left;}',
    '#slgPanelsWin th{color:#c2ac74;font-weight:600;background:#20221600;}',
    '#slgPanelsWin .tag{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;margin-right:5px;border:1px solid #5c573c;color:#c9bd97;}',
    '#slgPanelsWin .tag.ok{background:#26361f;border-color:#4e7a3e;color:#bfe0a3;}',
    '#slgPanelsWin .tag.mid{background:#37301b;border-color:#8a7037;color:#e8c670;}',
    '#slgPanelsWin .tag.no{background:#2a211d;border-color:#6a4a3c;color:#bfa18e;}',
    '#slgPanelsWin .tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;}',
    '#slgPanelsWin .tabs button{background:#1d2017;color:#bcb292;border:1px solid #454231;border-radius:4px;',
    '  padding:5px 13px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .tabs button.on{background:#3a3220;border-color:#ba9a52;color:#ffe6a6;}',
    '#slgPanelsWin .genlist{width:206px;flex:0 0 206px;max-height:100%;overflow-y:auto;border-right:1px solid #333326;padding-right:8px;}',
    '#slgPanelsWin .genrow{display:block;width:100%;text-align:left;background:transparent;color:#c9bfa3;border:1px solid transparent;',
    '  border-radius:5px;padding:7px 9px;margin-bottom:3px;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .genrow:hover{background:#23261a;}#slgPanelsWin .genrow.on{background:#3a3220;border-color:#ba9a52;color:#ffe6a6;}',
    '#slgPanelsWin .genrow small{color:#8d8a74;display:block;font-size:11px;}',
    '#slgPanelsWin .cols{display:flex;gap:16px;align-items:flex-start;}#slgPanelsWin .cols>.right{flex:1;min-width:0;}',
    '#slgPanelsWin .src{border-left:2px solid #6a5a32;padding:4px 0 4px 11px;margin:8px 0;}',
    '#slgPanelsWin .src b{color:#e8c670;}#slgPanelsWin .src .muted{color:#9d9882;font-size:12px;}',
    '#slgPanelsWin .skill{border:1px solid #3d3b2b;border-radius:6px;margin-bottom:7px;background:#1b1e15;}',
    '#slgPanelsWin .skill .hd{padding:9px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;}',
    '#slgPanelsWin .skill .hd:hover{background:#22261900;}#slgPanelsWin .skill .dt{padding:0 14px 12px;border-top:1px solid #333326;}',
    '#slgPanelsWin .bar{height:7px;background:#2b2d20;border-radius:4px;overflow:hidden;margin:5px 0;}',
    '#slgPanelsWin .bar i{display:block;height:100%;background:#a98a45;}',
    '#slgPanelsWin select,#slgPanelsWin input[type=text]{background:#202317;color:#e6dbb9;border:1px solid #5a5539;',
    '  border-radius:4px;padding:4px 7px;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgPanelsWin .muted{color:#97927c;}',
    '#slgPanelsToast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100130;display:none;',
    '  padding:9px 20px;border:1px solid #ba9a52;border-radius:5px;color:#f4e7bf;font:14px "Microsoft YaHei",sans-serif;}',
  ].join('');

  var NAV = [
    ['general', '武将', '帐下与在野'], ['strategy', '战略', '国势与推演'],
    ['interior', '内政', '委任与政令'], ['depot', '府库', '分类账'],
    ['equip', '兵刃', '四槽穿戴与锻造'], ['library', '战法库', '全库与配方'],
  ];

  /* ---------------- 各面板 ---------------- */
  function genListHtml() {
    var out = '<div class="genlist"><h4>帐下武将（' + data.generals.length + '）</h4>';
    data.generals.forEach(function (g) {
      out += '<button class="genrow' + (g.id === ui.genId ? ' on' : '') + '" data-act="gen" data-id="' + g.id + '">'
        + esc(g.name) + ' <span class="tag">' + esc(g.state) + '</span><small>Lv' + g.level + ' · ★' + g.star
        + (g.appointed.length ? ' · 委任中' : '') + '</small></button>';
    });
    out += '<h4>在野名士（可招贤）</h4>';
    (data.prospects || []).forEach(function (p, i) {
      out += '<button class="genrow' + (ui.genId === -i - 1 ? ' on' : '') + '" data-act="prospect" data-i="' + i + '">'
        + esc(p.name) + '<small>' + esc(p.zi === '史无明载' ? '' : '字' + p.zi) + ' · ' + esc(p.faction)
        + ' · 统' + esc(p.historyStats.统率) + '</small></button>';
    });
    return out + '</div>';
  }

  function genAttrHtml(g) {
    var rows = '';
    Object.keys(data.statLabels).forEach(function (k) {
      var b = g.base[k] || 0, a = g.added[k] || 0, eb = g.equipBonus[k] || 0;
      rows += '<tr><td>' + esc(data.statLabels[k]) + '</td><td class="v">' + fmt(b) + '</td>'
        + '<td class="' + (eb > 0 ? 'up' : '') + '">+' + fmt(eb) + '</td>'
        + '<td class="muted">+' + fmt(a) + '</td><td class="v"><b>' + fmt(g.final[k]) + '</b></td>'
        + '<td class="muted">' + pct(a, b) + '</td></tr>';
    });
    var lore = g.lore;
    var loreHtml = lore ? '<div class="card"><h3>史料档案</h3><div class="grid">'
      + ['统率', '武力', '智力', '政治', '魅力'].map(function (s) {
        return '<div><span class="k">' + s + '</span> <span class="v">' + esc(lore.historyStats[s]) + '</span></div>';
      }).join('')
      + '</div><div style="margin-top:8px" class="muted">字 ' + esc(lore.zi) + ' · 籍贯 ' + esc(lore.hometown)
      + ' · 势力 ' + esc(lore.faction) + ' · 分期 ' + esc(lore.era) + '</div>'
      + '<div style="margin-top:6px">' + esc(lore.brief) + '</div></div>'
      : '<div class="card muted">主公为本局穿越者，史无明载。五维取本局设定值。</div>';
    return '<h3>属性 · ' + esc(g.name) + '</h3><div class="card"><table><thead><tr>'
      + '<th>维度</th><th>基础</th><th>＋装备</th><th>＋增量合计</th><th>最终</th><th>增幅</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="muted" style="margin-top:8px">装备单件 ≤8%、全套 ≤25%（当前武力增幅 '
      + pct(g.added.force, g.base.force) + '）。不显示单一「战力」数值，保留搭配讨论空间。</div></div>'
      + loreHtml
      + '<div class="card"><h3>本局状态</h3>体力 ' + esc(g.physical) + ' · 经验 ' + fmt(g.exp)
      + ' · 状态 ' + esc(g.state) + ' · 在编岗位 ' + (g.appointed.length ? esc(g.appointed.join('、')) : '无')
      + '<div class="muted" style="margin-top:6px">出征中的武将内政收益减半（明写规则，不做隐藏惩罚）。</div></div>';
  }

  function genSkillHtml(g) {
    var out = '<h3>战法 · ' + esc(g.name) + '</h3>';
    g.slots.forEach(function (s) {
      out += '<div class="card"><span class="tag ' + (s.skill ? 'ok' : s.locked ? 'no' : 'mid') + '">'
        + ['自带', '学习', '觉醒'][s.pos] + '</span>';
      if (s.skill) {
        out += '<b class="v">' + esc(s.skill.name) + '</b> <span class="muted">Lv' + esc(s.skill.level)
          + ' · 发动率 ' + esc(s.skill.probability == null ? '—' : s.skill.probability + '%') + '</span>'
          + '<div style="margin-top:6px">' + esc(s.skill.des) + '</div>';
      } else {
        out += '<span class="muted">空槽位 · ' + esc(s.lockText) + '</span>';
      }
      out += '</div>';
    });
    var unlocked = data.library.filter(function (x) { return x.status === 'unlocked'; }).slice(0, 8);
    out += '<div class="card"><h3>装配已解锁战法</h3><div class="muted" style="margin-bottom:8px">'
      + '槽位规则沿用既有设计：自带不可替换、Lv5 开学习槽、Lv20＋自带 10 级开觉醒槽；每条战法同时最多 2 人装配。</div>';
    unlocked.forEach(function (s) {
      out += '<button class="btn" data-act="learn" data-gid="' + g.id + '" data-pos="1" data-cfg="' + s.cfgId + '">'
        + esc(s.name) + ' → 学习槽</button>';
    });
    out += '<div style="margin-top:8px"><button class="btn" data-act="tab" data-id="library">去战法库看全部 51 条</button></div></div>';
    return out;
  }

  function equipSlotsHtml(g, withForge) {
    var out = '<h3>兵刃四槽 · ' + esc(g.name) + '</h3><div class="grid">';
    data.slots.forEach(function (sl) {
      var worn = g.equipment[sl.id];
      out += '<div class="card"><span class="tag">' + esc(sl.name) + '</span>';
      if (worn) {
        out += '<b class="v">' + esc(worn.name) + '</b><div class="muted" style="margin:5px 0">特性：' + esc(worn.trait) + '</div>'
          + '<div class="muted">典故：' + esc(worn.set) + ' · 加成 ' + esc(JSON.stringify(worn.bonusPct)) + '</div>'
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
          + esc(JSON.stringify(i.forge.cost)) + '</span> <button class="btn" data-act="forge" data-cfg="'
          + i.id + '">锻造</button></div>';
      });
      out += '</div></div>';
    }
    return out;
  }

  function genStoryHtml(g) {
    var l = g.lore, m = g.merits;
    var out = '<h3>经历 · ' + esc(g.name) + '</h3><div class="card"><h3>本局战功簿</h3>'
      + '参战 ' + esc(m.battles) + ' 次 · 战功 ' + esc(m.merits) + ' · 守城 ' + esc(m.defense)
      + ' · 以少胜多 ' + esc(m.upset) + '<div class="muted" style="margin-top:6px">战功回流兵书残卷，用于战法研习。</div></div>';
    if (l) {
      out += '<div class="card"><h3>履历</h3>' + esc(l.brief)
        + '<div class="muted" style="margin-top:8px">' + esc(l.deeds) + '</div></div>'
        + '<div class="card"><h3>演义形象</h3>' + esc(l.romance) + '</div>'
        + '<div class="card"><h3>关系</h3><span class="muted">并肩／结怨将在 P3 接入宿命链；当前不影响数值。</span></div>';
    } else {
      out += '<div class="card muted">本局穿越者，史无明载；本局画像由章节事件逐步写入。</div>';
    }
    return out;
  }

  function viewGeneral() {
    var prospect = ui.genId < 0 ? data.prospects[-ui.genId - 1] : null;
    var body;
    if (prospect) {
      body = '<h3>在野名士 · ' + esc(prospect.name) + '</h3><div class="card">'
        + '<div class="grid">' + ['统率', '武力', '智力', '政治', '魅力'].map(function (s) {
          return '<div><span class="k">' + s + '</span> <span class="v">' + esc(prospect.historyStats[s]) + '</span></div>';
        }).join('') + '</div><div style="margin-top:8px">字 ' + esc(prospect.zi) + ' · 势力 ' + esc(prospect.faction)
        + '</div><div style="margin-top:6px">' + esc(prospect.brief) + '</div>'
        + '<div class="muted" style="margin-top:10px">在野武将仅可预览；招贤请到酒馆。师承不需要把他招进帐下也能学战法。</div></div>';
    } else {
      var g = currentGeneral();
      if (!g) return '<div class="muted">暂无武将</div>';
      var tabs = [['attr', '属性'], ['skill', '战法'], ['equip', '兵刃'], ['story', '经历']];
      body = '<div class="tabs">' + tabs.map(function (t) {
        return '<button class="' + (ui.genTab === t[0] ? 'on' : '') + '" data-act="gtab" data-id="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div>';
      if (ui.genTab === 'attr') body += genAttrHtml(g);
      else if (ui.genTab === 'skill') body += genSkillHtml(g);
      else if (ui.genTab === 'equip') body += equipSlotsHtml(g, false);
      else body += genStoryHtml(g);
    }
    return '<div class="cols">' + genListHtml() + '<div class="right">' + body + '</div></div>';
  }

  function viewStrategy() {
    var s = data.strategy;
    var out = '<h3>国势 · 第 ' + data.month + ' 月（游戏日 ' + data.day + '）</h3><div class="grid">'
      + [['我方城池', s.cityCount + ' / ' + s.totalCities], ['在编兵力', fmt(s.soldiers)],
         ['章节进度', '第 ' + s.chapter + ' 章' + (s.ending ? ' · ' + esc(s.ending) : '')],
         ['天下日志', s.events.length + ' 条（近月）']].map(function (p) {
        return '<div class="card"><span class="k">' + p[0] + '</span><div class="v" style="font-size:19px">' + p[1] + '</div></div>';
      }).join('') + '</div>';

    out += '<div class="card"><h3>资源与产出</h3><table><thead><tr><th>资源</th><th>库存</th><th>日产</th><th>府库上限</th></tr></thead><tbody>'
      + data.interior.output.resources.map(function (r) {
        return '<tr><td>' + esc(r.label) + '</td><td class="v">' + fmt(r.stock) + '</td><td>+' + fmt(r.yield)
          + '</td><td class="muted">' + (r.capacity ? fmt(r.capacity) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    out += '<div class="card"><h3>目标推演（只给数据，不替你决定）</h3>'
      + '<label class="muted">选择目标城：</label><select data-act="citypick">'
      + s.cities.map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === ui.selectedCity ? ' selected' : '') + '>'
          + esc(c.name) + '（' + esc(c.province) + ' Lv' + esc(c.level) + '）</option>';
      }).join('') + '</select>';
    var c = s.cities.find(function (x) { return x.id === ui.selectedCity; }) || s.cities[0];
    if (c) {
      var mine = s.soldiers, est = c.garrison;
      var win = mine > est * 1.35 ? '较有把握' : mine > est * 0.9 ? '胜负参半' : '不宜轻进';
      out += '<div class="grid" style="margin-top:10px">'
        + '<div class="card"><span class="k">敌军驻军（估算）</span><div class="v">' + fmt(est) + '</div></div>'
        + '<div class="card"><span class="k">我军可出</span><div class="v">' + fmt(mine) + '</div></div>'
        + '<div class="card"><span class="k">胜算</span><div class="v">' + win + '</div></div>'
        + '<div class="card"><span class="k">农业 / 商业 / 城防</span><div class="v">'
        + esc(c.agriculture) + ' / ' + esc(c.commerce) + ' / ' + esc(c.defense) + '</div></div></div>'
        + '<div class="muted" style="margin-top:8px">' + esc(c.note) + '。实际胜负由确定性战斗内核裁定。</div>';
    }
    out += '<div style="margin-top:10px"><button class="btn" data-act="gotostrategy">打开天下沙盘出征</button></div></div>';

    out += '<div class="card"><h3>边境威胁</h3>';
    out += s.threats.length ? s.threats.map(function (t) {
      return '<div>· ' + esc(t.name || t.text || JSON.stringify(t)) + '</div>';
    }).join('') : '<div class="muted">当前无来犯军。</div>';
    out += '<div class="muted" style="margin-top:6px">盟约到期与背盟预警将在 P2 接入意图层。</div></div>';

    out += '<div class="card"><h3>近月天下日志</h3>' + (s.events.length ? s.events.map(function (e) {
      return '<div>· 第 ' + esc(e.month || (e.turn != null ? e.turn + 1 : '?')) + '月 '
        + esc(e.text) + '</div>';
    }).join('') : '<div class="muted">暂无事件</div>') + '</div>';

    out += '<div class="card"><h3>最近战报</h3>' + (s.recentReports.length ? s.recentReports.map(function (r, i) {
      return '<div class="src"><b>' + esc(r.summary || r.title || ('战报 ' + (i + 1))) + '</b>'
        + '<div class="muted">' + esc(r.analysis || '') + '</div></div>';
    }).join('') : '<div class="muted">暂无战报，出征后在此复盘。</div>') + '</div>';

    out += '<div class="card muted">' + esc(s.note) + '</div>';
    return out;
  }

  function viewInterior() {
    var it = data.interior, out = '';
    out += '<h3>内政委任台</h3><div class="card"><h3>资源流水线</h3><table><thead><tr>'
      + '<th>资源</th><th>库存</th><th>产量</th><th>府库上限</th><th>满仓预警</th></tr></thead><tbody>'
      + it.output.resources.map(function (r) {
        var full = r.capacity && r.stock >= r.capacity;
        return '<tr><td>' + esc(r.label) + '</td><td class="v">' + fmt(r.stock) + '</td><td>+' + fmt(r.yield)
          + '</td><td class="muted">' + (r.capacity ? fmt(r.capacity) : '—') + '</td><td>'
          + (full ? '<span class="tag no">已满仓</span>' : '<span class="muted">正常</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    out += '<div class="card"><h3>三条硬约束</h3><div class="grid">'
      + [['民心', it.constraints.morale.morale, '过低触发减产'], ['治安', it.constraints.order.order, '过低触发流寇'],
         ['腐败', it.constraints.corruption.corruption, '随城数上升，人事可压制']].map(function (p) {
        return '<div><span class="k">' + p[0] + '</span> <span class="v">' + esc(p[1]) + '</span>'
          + '<div class="muted">' + p[2] + '</div></div>';
      }).join('') + '</div></div>';

    out += '<h3>岗位委任（换人 delta 实时预览）</h3><div class="grid">';
    it.posts.forEach(function (p) {
      var now = data.generals.find(function (g) { return g.id === p.generalId; });
      out += '<div class="card"><b class="v">' + esc(p.name) + '</b> <span class="muted">' + esc(p.desc) + '</span>'
        + '<div style="margin:6px 0">现任：<span class="v">' + esc(p.generalName || '空缺') + '</span></div>'
        + '<div>当前岗位加成：<span class="up">+' + esc(it.output.bonusPct[p.id] || 0) + '%</span> '
        + '<span class="muted">' + esc(p.resource) + '</span></div>'
        + '<div style="margin-top:8px"><select data-act="appoint" data-post="' + esc(p.id) + '">'
        + '<option value="0">— 撤任 —</option>'
        + data.generals.map(function (g) {
          return '<option value="' + g.id + '"' + (g.id === p.generalId ? ' selected' : '') + '>'
            + esc(g.name) + '（' + esc(g.state) + '，' + esc(p.stat) + '向）</option>';
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
    var out = '<h3>府库分类账</h3><div class="muted" style="margin-bottom:10px">'
      + '不数格子：分类账堆叠无上限，资源受府库容量约束。兵书残卷现存 <b class="v">' + esc(data.scrolls) + '</b> 卷。</div>'
      + '<div class="tabs">' + filters.map(function (f) {
        return '<button class="' + (ui.itemFilter === f[0] ? 'on' : '') + '" data-act="itemfilter" data-id="' + f[0] + '">' + f[1] + '</button>';
      }).join('') + '</div>';

    var list = data.items.filter(function (i) { return ui.itemFilter === 'all' || i.kind === ui.itemFilter; });
    out += '<div class="card"><h3>资源</h3><div class="grid">' + data.interior.output.resources.map(function (r) {
      return '<div><span class="k">' + esc(r.label) + '</span> <span class="v">' + fmt(r.stock) + '</span>'
        + '<div class="muted">日产 +' + fmt(r.yield) + '</div></div>';
    }).join('') + '</div></div>';

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
    var out = '<h3>战法库（势力级资产）</h3><div class="grid">'
      + [['全库', sm.total + ' 条'], ['已解锁', sm.unlocked + ' 条'], ['研习中', sm.researching + ' 条'],
         ['≥2 条获取途径', sm.sourcesCovered + ' / ' + sm.total]].map(function (p) {
        return '<div class="card"><span class="k">' + p[0] + '</span><div class="v" style="font-size:19px">' + p[1] + '</div></div>';
      }).join('') + '</div>';
    out += '<div class="card muted">全部配方开局公开：名称／类型／描述／数值逐字取自 battle-kit 原文；'
      + '没有随机、没有不可逆的意外、没有死路（每条至少两条路径，战功研习永久兜底）。</div>';

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
    out += '<div class="muted" style="margin-bottom:8px">筛出 ' + list.length + ' 条。</div>';

    out += list.map(function (s) {
      var tag = s.status === 'unlocked' ? '<span class="tag ok">已解锁 Lv' + esc(s.level) + '</span>'
        : s.status === 'researching' ? '<span class="tag mid">研习中</span>' : '<span class="tag no">未解锁</span>';
      var h = '<div class="skill"><div class="hd" data-act="skilldetail" data-cfg="' + s.cfgId + '">'
        + tag + '<b class="v">' + esc(s.name) + '</b><span class="muted">' + esc(s.trigger) + ' · '
        + esc(s.sourceGroup) + ' · ' + esc(s.tags.join('/')) + '</span>'
        + '<span style="flex:1"></span><span class="muted">' + (ui.openSkill === s.cfgId ? '收起 ▲' : '展开获取途径 ▼') + '</span></div>';
      if (ui.openSkill === s.cfgId) {
        h += '<div class="dt"><div style="margin:8px 0">' + esc(s.des) + '</div>'
          + '<div class="muted" style="font-size:11px;margin-top:-5px">描述逐字取自 battle-kit 原文；'
          + '其中 %n 对应下方各级效果值，未改写。</div>'
          + '<div class="muted">装配 ' + s.equippedBy.length + ' / ' + s.equipLimit + ' 人 · 目标类型 '
          + esc(s.target) + ' · 适性兵种 ' + esc((s.arms || []).join(',')) + '</div>'
          + '<h4>10 级数值曲线（原文数值）</h4><table><thead><tr><th>等级</th><th>发动率</th><th>效果值</th></tr></thead><tbody>'
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
        h += '<div style="margin-top:9px">';
        if (s.status === 'unlocked') {
          h += '<button class="btn" data-act="learn" data-gid="' + (currentGeneral() ? currentGeneral().id : 0)
            + '" data-pos="1" data-cfg="' + s.cfgId + '">装配给当前武将</button>';
        } else {
          h += '<button class="btn" data-act="research" data-cfg="' + s.cfgId + '">投入 10 残卷研习</button>';
        }
        h += '</div></div>';
      }
      return h + '</div>';
    }).join('');
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
        + x[1] + '<div style="font-size:11px;color:#8d8a74">' + x[2] + '</div></button>';
    }).join('');
    var cur = NAV.find(function (x) { return x[0] === ui.tab; }) || NAV[0];
    document.getElementById('slgPanelsTitle').textContent = cur[1] + ' · ' + cur[2];
    document.getElementById('slgPanelsSub').textContent =
      '第 ' + data.month + ' 月 · 游戏日 ' + data.day + ' · 武将 ' + data.generals.length
      + ' · 物品 ' + data.items.length + ' · 战法 ' + data.library.length;
    var body = document.getElementById('slgPanelsBody');
    var scroll = body.scrollTop;
    body.innerHTML = (VIEWS[ui.tab] || viewGeneral)();
    body.scrollTop = scroll;
    Array.prototype.forEach.call(dock.querySelectorAll('.pb'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-id') === ui.tab && mask.style.display === 'flex');
    });
  }

  function open(tab) {
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
    if (act === 'tab') return open(id);
    if (act === 'gen') { ui.genId = Number(t.getAttribute('data-id')); return render(); }
    if (act === 'prospect') { ui.genId = -Number(t.getAttribute('data-i')) - 1; return render(); }
    if (act === 'gtab') { ui.genTab = id; return render(); }
    if (act === 'itemfilter') { ui.itemFilter = id; return render(); }
    if (act === 'skillfilter') { ui.skillFilter = id; return render(); }
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
    if (act === 'research') return post({ type: 'research', cfgId: Number(t.getAttribute('data-cfg')), amount: 10 });
    if (act === 'learn') return post({ type: 'learn', gId: Number(t.getAttribute('data-gid')),
      pos: Number(t.getAttribute('data-pos')), cfgId: Number(t.getAttribute('data-cfg')) });
    if (act === 'proposal') return confirmBox('颁行后本回合不可更改，确认？', function () {
      post({ type: 'proposal', id: id });
    });
    if (act === 'gotostrategy') {
      close();
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
    if (act === 'citypick') { ui.selectedCity = Number(t.value); return render(); }
  }
  function onInput(e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.getAttribute('data-act') !== 'skillquery') return;
    ui.skillQuery = t.value;
    var pos = t.selectionStart;
    render();
    var again = document.querySelector('[data-act="skillquery"]');
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (document.getElementById('slgPanelsDock')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    dock = document.createElement('div');
    dock.id = 'slgPanelsDock';
    dock.innerHTML = '<button class="fold" data-fold="1">六府 ▾</button><div id="slgPanelsBtns">'
      + NAV.map(function (x) {
        return '<button class="pb" data-id="' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div>';
    dock.addEventListener('click', function (e) {
      if (e.target.hasAttribute('data-fold')) {
        ui.dockOpen = !ui.dockOpen;
        document.getElementById('slgPanelsBtns').style.display = ui.dockOpen ? '' : 'none';
        e.target.textContent = ui.dockOpen ? '六府 ▾' : '六府 ▸';
        return;
      }
      var b = e.target.closest('.pb');
      if (b) open(b.getAttribute('data-id'));
    });
    document.body.appendChild(dock);

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

    window.__slgPanels = {
      open: open, close: close, refresh: fetchState,
      state: function () { return data; },
      ui: ui,
      render: render,
      setData: function (v) { data = v; render(); },
    };
    fetchState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
