/**
 * M2-3 第二轮补丁（GDD §9.2 / §3.4 / §3.5 / §9.5）。
 *
 * 锁四件事：
 *  1. knobs：30 参数、区间钳制、存档覆盖优先于默认值、消费口真实生效；
 *  2. 失败态四出路：破产裁军/卖粮、兵尽紧急征兵·雇佣、无将代将（出征不再卡死）、迁都；
 *  3. 结局判定：败亡 / 统一 / 偏安脚手架，关键决定回放；
 *  4. sim-60turns：确定性（两次运行逐旬一致）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyAttack, strategyViewState,
} from '../server/domain/strategy.js';
import { KNOBS, knobGet, knobSet, knobSnapshot } from '../server/domain/knobs.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import {
  failstates, disarmForGold, sellGrain, emergencyConscript,
  makeStandInGeneral, relocateCapital, evaluateEnding,
} from '../server/domain/failstate.js';
import { runSim, simHash } from '../tools/sim-60turns.mjs';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  return { state, st: state.strategy };
}

test('M2-3·knobs：30 参数齐备，区间钳制与存档覆盖', () => {
  assert.equal(Object.keys(KNOBS).length, 30, `应有 30 个 knob，实际 ${Object.keys(KNOBS).length}`);
  // 区间钳制：越界写被钳回，不报错
  const state = { knobs: {} };
  assert.equal(knobSet(state, 'undoDepth', 99).value, 10, 'undoDepth 上限 10');
  assert.equal(knobSet(state, 'undoDepth', 1).value, 3, 'undoDepth 下限 3');
  // 存档覆盖优先
  const w = { knobs: { turnDays: 7 } };
  assert.equal(knobGet(w, 'turnDays'), 7, '存档覆盖生效');
  assert.equal(knobGet({}, 'turnDays'), 10, '无覆盖取默认');
  assert.equal(knobGet({}, 'no_such_knob'), undefined, '未知名显式失败');
  // 快照 30 项
  const snap = knobSnapshot({});
  assert.equal(Object.keys(snap).length, 30);
  assert.equal(snap.previewCost, 0, '预演消耗写死 0');
});

test('M2-3·knobs：undo.depth 从参数表下发（M0-4 的口径收口）', () => {
  const { state } = oathWorld();
  const view = strategyViewState(state, cfg);
  void view;
  // interactionState 是另一个入口；这里只验证 knobGet 与 interaction 的联动由既有测试锁，
  // 本用例锁「存档覆盖改 undoDepth 后读到的就是新值」
  assert.equal(knobSet(state, 'undoDepth', 7).value, 7);
  assert.equal(knobGet(state, 'undoDepth'), 7);
});

test('M2-3·破产：判定 + 裁军返还 30% + 卖粮有旬上限', () => {
  const { state, st } = oathWorld();
  state.roleRes.gold = 0;
  state.roleRes.grain = 100;
  const f = failstates(state);
  assert.equal(f.bankrupt, true, '金 0 且粮 <500 应判破产');
  assert.ok(f.actions.some((a) => a.kind === 'disarm'), '破产必须给出路（恢复感原则）');

  // 裁军：主军 2000 兵 → 遣散 500 → 返还 500×2×0.3 = 300 金
  const army = state.armys[0];
  army.soldiers = [2000, 0, 0];
  const r1 = disarmForGold(state, { push() {} }, { armyId: army.id, count: 500 });
  assert.equal(r1.ok, true);
  assert.equal(army.soldiers[0], 1500, '兵应被遣散');
  assert.equal(state.roleRes.gold, 300, '返还 30% 兵值金');

  // 卖粮：1 粮 = 0.5 金，每旬上限 2000
  state.roleRes.grain = 5000;
  const r2 = sellGrain(state, { push() {} }, { grain: 1500 });
  assert.equal(r2.ok, true);
  assert.equal(r2.gold, 750);
  const r3 = sellGrain(state, { push() {} }, { grain: 900 });
  assert.equal(r3.grain, 500, '本旬只剩 500 粮额度');
  assert.equal(r3.ok, true);
  const r4 = sellGrain(state, { push() {} }, { grain: 1 });
  assert.equal(r4.ok, false);
  assert.equal(r4.reason, 'turn_cap', '超旬上限如实拒绝');
});

test('M2-3·兵尽：判定 + 紧急征兵（民心 −10）与雇佣兵（贵 3 倍）', () => {
  const { state, st } = oathWorld();
  const cid = Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
  st.cities[cid].troops = 150;
  const f = failstates(state);
  assert.ok(f.troopsStarved.includes(cid), '守军 <200 应列兵尽');
  assert.ok(f.actions.some((a) => a.kind === 'emergencyConscript'));

  state.roleRes.gold = 100000;
  const m0 = st.cityEcon[cid].morale ?? 60;
  const r1 = emergencyConscript(state, { push() {} }, { cityId: cid, count: 300 });
  assert.equal(r1.ok, true);
  assert.equal(r1.cost, 600, '紧急征兵 2 金/兵');
  assert.equal(st.cities[cid].troops, 450);
  assert.equal(st.cityEcon[cid].morale, Math.max(0, m0 - 10), '强征伤民心 −10');

  const r2 = emergencyConscript(state, { push() {} }, { cityId: cid, count: 100, mercenary: true });
  assert.equal(r2.cost, 600, '雇佣兵 6 金/兵（贵 3 倍）');
  assert.equal(r2.mercenary, true);
});

test('M2-3·无将：出征自动生成代将（五维 50、无战法），不再 no_general 卡死', () => {
  const { state, st } = oathWorld();
  const army = state.armys[0];
  army.soldiers = [1500, 0, 0];
  army.generals = [0, 0, 0];
  army.marchId = 0;
  const cid = Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
  army.cityId = cid;
  const view = strategyViewState(state, cfg);
  const row = view.cities.find((c) => Number(c.id) === cid);
  const target = (row?.marchRoutes || []).map((rt) => Number(rt.id))
    .find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  assert.ok(target, '应有相邻敌城');
  state.roleRes.grain = 100000;

  const atk = strategyAttack(state, cfg, { push() {} }, { cityId: target, armyId: army.id, fromCityId: cid });
  assert.equal(atk.ok, true, `无将出征应自动代将：${JSON.stringify(atk)}`);
  const g = (state.generals || []).find((x) => x.isStandIn);
  assert.ok(g, '应生成代将');
  assert.equal(g.name.startsWith('代将'), true);
  assert.equal(army.generals[0], g.id, '代将应进队伍空槽');
  assert.equal((g.skills || []).length, 0, '代将无战法');
  const f = failstates(state);
  assert.equal(f.noGeneral, false, '代将就位后不再判无将');
  void makeStandInGeneral;
});

test('M2-3·迁都：都城失陷 → 迁往己方城，保留 50% 资源', () => {
  const { state, st } = oathWorld();
  const capital = Number(st.playerCity);
  const other = Number(Object.keys(st.cities)
    .find((id) => st.cities[id].owner === 'player' && Number(id) !== capital));
  assert.ok(other, '应有另一座己方城');
  st.cities[capital].owner = 'wei';
  const f = failstates(state);
  assert.equal(f.capitalLost, true, '都城失陷应判定');
  assert.ok(f.actions.some((a) => a.kind === 'relocate'));

  state.roleRes.gold = 8000;
  state.roleRes.grain = 9000;
  const r = relocateCapital(state, { push() {} }, { cityId: other });
  assert.equal(r.ok, true);
  assert.equal(st.playerCity, other, '都城应改写');
  assert.equal(state.roleRes.gold, 4000, '保留 50% 金');
  assert.equal(state.roleRes.grain, 4500, '保留 50% 粮');
  const bad = relocateCapital(state, { push() {} }, { cityId: capital });
  assert.equal(bad.ok, false, '迁去敌城拒绝');
});

test('M2-3·结局：败亡（零城）/ 统一（全州治+诸侯出局）都给关键决定回放', () => {
  const { state, st } = oathWorld();
  assert.equal(evaluateEnding(state), null, '正常局面无结局');

  // 统一：全部城归玩家 + 诸侯出局
  for (const [id] of Object.entries(st.cities)) st.cities[id].owner = 'player';
  st.scenarioGoal = null;
  const e1 = evaluateEnding(state);
  assert.ok(e1, '全图归一应给结局');
  assert.equal(e1.type, 'unified');
  assert.ok(Array.isArray(e1.decisions), '结局必须回放关键决定');

  // 败亡：玩家零城
  for (const [id] of Object.entries(st.cities)) st.cities[id].owner = 'wei';
  const e2 = evaluateEnding(state);
  assert.ok(e2, '零城应给结局');
  assert.equal(e2.type, 'fallen', '零城判败亡');
  assert.ok(e2.text.includes('履历'), '败亡不是 Game Over 三个字');

  // 偏安脚手架：配置了阶段目标且达成才给
  const { state: w2, st: s2 } = oathWorld();
  const goals = Object.keys(s2.cities).filter((id) => s2.cities[id].owner === 'player').map(Number);
  s2.scenarioGoal = { cities: goals, turns: s2.turn + 1, untilDay: 9999 };
  s2.turn += 1;
  const e3 = evaluateEnding(w2);
  assert.ok(e3 && e3.type === 'partial', '达成阶段目标应给偏安');
});

test('M2-3·sim：确定性（同种子两次运行逐旬一致）+ 经济指标成形', () => {
  const a = runSim({ seed: 42, turns: 6 });
  const b = runSim({ seed: 42, turns: 6 });
  assert.equal(simHash(a), simHash(b), '同一输入两次运行必须完全一致（GDD §9.5，含 NPC 决策聊天）');
  assert.equal(a.series.length, 6);
  for (const row of a.series) {
    assert.ok(row.cities >= 1, '玩家至少有 1 城');
    assert.ok(row.troops >= 0 && Number.isFinite(row.troops), '兵力指标成形');
    assert.ok(Number.isFinite(row.gold) && Number.isFinite(row.grain), '金粮指标成形');
  }
  // 跨种子只要求同样确定性 + 能跑完（6 旬内局面可能尚未分叉，不做 notEqual 断言）
  const c = runSim({ seed: 43, turns: 6 });
  assert.equal(simHash(c), simHash(runSim({ seed: 43, turns: 6 })), '种子 43 同样确定');
});
