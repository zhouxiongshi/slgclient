/**
 * P71 玩家可见战法数值全局同源闸。
 *
 * 背景（同一缺陷第三次漏网）：
 *   - P68 扫战斗表（skills.js），漏了战法库 UI 拼的原始表；
 *   - P69 修战法库 levels/des，漏了武将页学习槽（panels.js skillConfOf 原始 conf）；
 *   - P70 改反击 70→115，学习槽仍显示原始 75%，研习/战斗显示 90%。
 *
 * 本闸不再逐点补测试：把「同一条战法在每条展示路径上应该看到什么」写成全表断言。
 * 任何一条展示路径退回原始 conf，或某条战法被单独改写而未同步其余路径，立刻变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SKILLS, skillById, kernelSkillAt } from '../server/skills.js';
import { panelState, PANEL_CONF } from '../server/domain/panels.js';
import { researchView } from '../server/domain/research.js';
import { desText } from '../server/domain/battle-narrative.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { loadConfig } from '../server/config.js';

const cfg = loadConfig();
const fresh = () => normalizeWorld(createWorld(cfg), cfg);
const rt = (id) => skillById(Number(id));
const nameOf = (s) => s?.ui?.name ?? s?.name ?? '战法';
const levelOf = (s, lv) => s?.ui?.levels?.[Math.max(0, Math.min(9, Number(lv) - 1))] || null;

test('P71-① 战法库：全库名称、描述、十级曲线逐条等于运行时表', () => {
  const state = fresh();
  const lib = panelState(state, cfg).library;
  assert.ok(lib.length >= 80, `战法库条目过少（${lib.length}）`);
  for (const row of lib) {
    const s = rt(row.cfgId);
    assert.ok(s, `战法库 ${row.cfgId} 不在运行时表`);
    assert.equal(row.name, nameOf(s), `${row.cfgId} 战法库名称与运行时不一致`);
    assert.equal(row.des, desText(s, row.level || 1) || s.ui?.des || '', `${row.cfgId} 战法库描述与运行时不一致`);
    assert.equal(row.levelCount, s.ui?.levels?.length || 0, `${row.cfgId} 等级数不一致`);
    for (let lv = 1; lv <= (row.levelCount || 0); lv += 1) {
      assert.deepEqual(row.levels[lv].effect_value, levelOf(s, lv).effect_value,
        `${row.cfgId} Lv${lv} 战法库曲线与运行时不一致`);
      assert.equal(row.levels[lv].probability, levelOf(s, lv).probability,
        `${row.cfgId} Lv${lv} 战法库发动率与运行时不一致`);
    }
  }
});

test('P71-② 武将页三槽：名称、描述、下一级、发动率逐条等于运行时表', () => {
  const state = fresh();
  const g = state.generals[0];
  assert.ok(g, '没有主公');
  g.level = 10;
  /* 自带槽放主公战法，学习槽放 10025，觉醒槽放另一条有成长的战法。
     三槽分别覆盖「原始表有/原始表平线/运行时成长」三种情况。 */
  g.skills = [
    { id: 19001, cfgId: 19001, lv: 10 },
    { id: 10025, cfgId: 10025, lv: 5 },
    { id: 10020, cfgId: 10020, lv: 4 },
  ];
  const view = panelState(state, cfg).generals.find((x) => x.id === g.id);
  assert.ok(view, '主公不在武将页投影里');
  for (let pos = 0; pos < 3; pos += 1) {
    const got = view.slots[pos].skill;
    const id = g.skills[pos].cfgId;
    const lv = g.skills[pos].lv;
    const s = rt(id);
    assert.ok(got, `第 ${pos} 槽没有战法详情`);
    assert.equal(got.name, nameOf(s), `${id} 槽位名称与运行时不一致`);
    assert.equal(got.des, desText(s, lv) || s.ui?.des || '', `${id} 槽位描述与运行时不一致`);
    assert.equal(got.nextDes, lv >= 10 ? '' : desText(s, lv + 1), `${id} 槽位「下一级」与运行时不一致`);
    assert.equal(got.probability, levelOf(s, lv).probability, `${id} 槽位发动率与运行时不一致`);
  }
  /* 用户点名的那一条：反击 Lv5 学习槽必须显示 90%，不再是原始表的 75%。 */
  assert.match(view.slots[1].skill.des, /90%/, '反击 Lv5 学习槽应显示运行时伤害率 90%');
});

test('P71-③ 研习回执与视图：名称等于运行时表，研习不改战法数值', () => {
  const state = fresh();
  state.skillbook.assign = { '10025': { generalId: state.generals[0].id, since: 1 } };
  state.skillbook.research = { '10025': { progress: 10, need: 100 } };
  const view = researchView(state, cfg);
  const row = view.find((x) => Number(x.cfgId) === 10025);
  assert.ok(row, '研习视图缺反击');
  assert.equal(row.name, nameOf(rt(10025)), '研习视图名称与运行时不一致');
  /* 研习只管进度，不下发另一套数值——若哪天加了 des/levels 字段，必须同源。 */
  if (row.des != null) assert.equal(row.des, desText(rt(10025), 1));
  if (row.levels != null) assert.deepEqual(row.levels, rt(10025).ui.levels);
});

test('P71-④ 战斗内核：等级数值直接取 ui.levels，rate_from_ui 逐条核对', () => {
  let checked = 0;
  for (const s of SKILLS) {
    const id = Number(s.cfgId);
    if (!Array.isArray(s.ui?.levels) || s.ui.levels.length !== 10) continue;
    const k = s.kernel || {};
    for (const e of (Array.isArray(k.effects) ? k.effects : [k])) {
      const counter = e.mechanics?.counter;
      if (!counter?.rate_from_ui) continue;
      for (let lv = 1; lv <= 10; lv += 1) {
        const got = kernelSkillAt(id, lv).effects[0].mechanics.counter.rate_pct;
        assert.equal(got, levelOf(s, lv).effect_value[0], `${id} Lv${lv} 内核回击伤害率与 UI 不同源`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, '没有核到任何 rate_from_ui 战法');
});

test('P71-⑤ 用户点名条目：反击 70→115、主公回击 87% 全路径一致', () => {
  const counter = rt(10025);
  assert.deepEqual(counter.ui.levels.map((l) => l.effect_value[0]),
    [70, 75, 80, 85, 90, 95, 100, 105, 110, 115]);
  assert.equal(kernelSkillAt(10025, 1).effects[0].mechanics.counter.rate_pct, 70);
  assert.equal(kernelSkillAt(10025, 10).effects[0].mechanics.counter.rate_pct, 115);

  /* 用户报告的真实场景：反击已解锁到 Lv5 并装在主公学习槽，研习框与学习槽必须同一句。
     未解锁时研习框按 Lv1 展示是设计口径（研习目标初始值），不算不同步。 */
  const st = fresh();
  st.generals[0].level = 10;
  st.generals[0].skills[1] = { id: 10025, cfgId: 10025, lv: 5 };
  st.skillbook.unlocked['10025'] = { level: 5, source: '研习' };
  const view = panelState(st, cfg);
  const slotDes = view.generals[0].slots[1].skill.des;
  const libDes = view.library.find((x) => Number(x.cfgId) === 10025).des;
  const rate5 = kernelSkillAt(10025, 5).effects[0].mechanics.counter.rate_pct;
  assert.equal(slotDes, libDes, 'Lv5 已解锁：学习槽与研习框必须显示同一句');
  assert.match(slotDes, new RegExp(`${rate5}%`), 'Lv5 已解锁：展示必须与内核伤害率同源');

  /* 19001 的 87% 硬编码在描述文案与 counter.rate_pct 两处，不在 ui.levels 里。
     这里锁住「两处必须相等」——编辑器将来若改 rate_pct 而没改描述，本闸立刻变红。 */
  const lord = rt(19001);
  assert.ok(lord, '主公战法 19001 不在运行时表');
  const rate = lord.kernel.effects[1].mechanics.counter.rate_pct;
  assert.match(lord.ui.des, new RegExp(`${rate}%\\s*策略伤害`), '主公描述里的回击伤害率与内核配置漂移');
  for (const lv of [1, 5, 10]) {
    const got = kernelSkillAt(19001, lv).effects[1].mechanics.counter.rate_pct;
    assert.equal(got, rate, `主公 Lv${lv} 回击伤害率漂移`);
    assert.match(desText(lord, lv), new RegExp(`${rate}%\\s*策略伤害`), `主公 Lv${lv} 描述漂移`);
  }
});

test('P71-⑥ 没有展示路径再从原始 conf 取战法数值', () => {
  /* 静态锁：panels.js 的展示取数必须走 displaySkillOf（运行时优先），
     不允许把 skillConfOf 直接接回 slots/library 投影——P71 的根因就是那一行。 */
  const src = readFileSync(new URL('../server/domain/panels.js', import.meta.url), 'utf8');
  assert.match(src, /function displaySkillOf|const displaySkillOf/, 'panels.js 缺统一直展示取数入口');
  const slotsBlock = src.slice(src.indexOf('const slots = [0, 1, 2].map'), src.indexOf('const gname ='));
  assert.match(slotsBlock, /displaySkillOf\(cfgId\)/, '武将页三槽退回原始 conf 取数');
  const libBlock = src.slice(src.indexOf('const library = SKILLS.map'), src.indexOf('/* 战略台数据源对齐'));
  assert.match(libBlock, /displaySkillOf\(raw\.cfgId\)/, '战法库投影退回原始 conf 取数');
  const research = readFileSync(new URL('../server/domain/research.js', import.meta.url), 'utf8');
  assert.match(research, /displayName\(/, '研习回执退回原始 conf 取名称');
});
