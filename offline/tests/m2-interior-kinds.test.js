/**
 * M2-2 内政任务 5 → 12 类（GDD §5.4）。
 *
 * 新增 7 类：兴学（人事供给）/ 招抚（维稳）/ 屯田（军粮）/ 练兵（战术前置）/
 * 修路（改变路网）/ 侦察（补情报）/ 离间（人事战）。
 * 全部走同一任务对象（reason/cancelable/target 三个新字段），效果在完工时结算，
 * 消费口分别接：酒馆来访位 / loyaltyTick 叛逃概率 / 城库 / 出征攻击加成（预演同源）/
 * marchPlan 行军日 / st.intel 情报档 / 敌城 unrest。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyInvest, strategyAttack,
  previewAssault, marchPlan, strategyViewState,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { KINDS, roadEdgeKey, beginInteriorTask, advanceInteriorTasks } from '../server/domain/interior-task.js';
import { todaysGuests } from '../server/domain/tavern.js';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  state.roleRes.gold = 100000;               // 测试预算充足
  state.roleRes.grain = 100000;               // 行军粮兜底池充足
  return { state, st: state.strategy };
}

function ownFirst(st) {
  return Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
}

function enemyAdjacent(st, from) {
  // marchableFrom 已过滤关隘封锁与己方城；视图同口径。这里直接用 view 的 marchRoutes。
  const view = strategyViewState(state, cfg);
  const row = view.cities.find((c) => Number(c.id) === Number(from));
  return (row?.marchRoutes || []).map(Number).find((id) => st.cities[id] && st.cities[id].owner !== 'player');
}

function fastForward(state, days) {
  const day0 = Math.floor(Number(state.clock?.day) || 1);
  state.clock.day = day0 + days;
  return advanceInteriorTasks(state, cfg, { push() {} });
}

const state = {};   // 每个用例自带 world；这里只声明避免 lint 报未定义

test('M2·KINDS：12 类齐备且新 7 类带正确依赖属性', () => {
  const kinds = Object.keys(KINDS);
  assert.equal(kinds.length, 12, `应有 12 类，实际 ${kinds.length}：${kinds.join(',')}`);
  assert.equal(KINDS.study.cost, 600);
  assert.equal(KINDS.appease.cost, 450);
  assert.equal(KINDS.tuntian.cost, 500);
  assert.equal(KINDS.drill.cost, 550);
  assert.equal(KINDS.road.cost, 700);
  assert.equal(KINDS.scout.cost, 200);
  assert.equal(KINDS.sow.cost, 800);
  for (const k of ['road', 'scout', 'sow']) assert.equal(KINDS[k].targetEdge, true, `${k} 是边任务`);
  void state;
});

test('M2·屯田：农田 +2 且城库 +800 粮', () => {
  const { state: w, st } = oathWorld();
  const cid = ownFirst(st);
  st.cityEcon[cid].devAgri = 50;
  st.cityEcon[cid].store = 1000;
  const r = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'tuntian' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.task.reason, '玩家指派', 'GDD schema：来源');
  assert.equal(r.task.cancelable, true, 'GDD schema：可撤销');
  const done = fastForward(w, 51);
  assert.ok(done.completed.some((t) => t.kind === 'tuntian'), '屯田应完工');
  assert.ok(st.cityEcon[cid].devAgri > 50, '农田应 +2');
  assert.equal(st.cityEcon[cid].store, 1800, '城库 +800');
});

test('M2·练兵：完工得充能，出征扣充能并 stamp drillMorale，推演同源', () => {
  const { state: w, st } = oathWorld();
  const cid = ownFirst(st);
  const r = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'drill' });
  assert.equal(r.ok, true, JSON.stringify(r));
  fastForward(w, 51);
  assert.equal(st.cityEcon[cid].drillCharges, 1, '完工应得 1 充能');

  // 需要一支可出征的队伍：走视图拿驻城部队
  // 主军满兵压上（与 strategy.test.js 同一造法：测试世界初始驻军不带兵）
  const army0 = (w.armys || [])[0];
  assert.ok(army0, '世界应有主军');
  army0.cityId = cid;
  army0.marchId = 0;
  army0.soldiers = [2000, 0, 0];
  const view = strategyViewState(w, cfg);
  const armyRow = (view.armies || []).find((a) => Number(a.cityId) === cid && !a.marching
    && (a.soldiers || []).some((n) => n > 0));
  assert.ok(armyRow, '举义城应有驻军');
  // 目标：相邻敌城
  const row = view.cities.find((c) => Number(c.id) === cid);
  const target = (row?.marchRoutes || []).map((rt) => Number(rt.id))
    .find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  assert.ok(target, '应有相邻敌城');

  // 推演（未出征）：有充能 → 预演带 drillMorale=10
  const pv1 = previewAssault(w, cfg, { cityId: target, fromCityId: cid, armyId: armyRow.id });
  assert.equal(pv1.ok, true);
  // 出征：消耗充能并 stamp
  const atk = strategyAttack(w, cfg, { push() {} }, { cityId: target, armyId: armyRow.id, fromCityId: cid });
  assert.equal(atk.ok, true, JSON.stringify(atk));
  assert.equal(atk.drillMorale, 10, '出征应带练兵加成');
  assert.equal(st.cityEcon[cid].drillCharges, 0, '充能应被消耗');
  const army = (w.armys || []).find((a) => a.id === armyRow.id);
  assert.equal(army.drillMorale, 10, '队伍应被 stamp drillMorale');
  assert.equal(atk.marchDays <= 12, true);
});

test('M2·修路：完工后该边行军 −1 日（最低 1 日，双向生效）', () => {
  const { state: w, st } = oathWorld();
  const cid = ownFirst(st);
  const view = strategyViewState(w, cfg);
  const row = view.cities.find((c) => Number(c.id) === cid);
  const target = (row?.marchRoutes || []).map((rt) => Number(rt.id))[0];
  assert.ok(target, '应有相邻城');

  const before = marchPlan(w, cfg, cid, target, { generals: [] }).days;
  const r = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'road', targetCityId: target });
  assert.equal(r.ok, true, JSON.stringify(r));
  fastForward(w, 61);                         // 修路 4 旬（无官可派 5~6 旬）
  assert.equal(st.roadWorks?.[roadEdgeKey(cid, target)], 1, '完工应写驿道表');
  const after = marchPlan(w, cfg, cid, target, { generals: [] }).days;
  assert.equal(after, Math.max(1, before - 1), '行军 −1 日（最低 1）');
  // 反向同样生效
  assert.equal(marchPlan(w, cfg, target, cid, { generals: [] }).days, after, '双向生效');
  // 同一条边不能重复修
  const again = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'road', targetCityId: target });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'road_done');
});

test('M2·侦察/离间：目标必须是相邻敌城，完工分别写 intel 档与 unrest', () => {
  const { state: w, st } = oathWorld();
  const cid = ownFirst(st);
  const view = strategyViewState(w, cfg);
  const row = view.cities.find((c) => Number(c.id) === cid);
  const target = (row?.marchRoutes || []).map((rt) => Number(rt.id))
    .find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  assert.ok(target, '应有相邻敌城');

  // 侦察完工 → intel 档 +1（0 传闻 → 1 估算）
  const s1 = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'scout', targetCityId: target });
  assert.equal(s1.ok, true, JSON.stringify(s1));
  fastForward(w, 21);                         // 侦察 1 旬（无官可派 2 旬）
  assert.equal(st.intel?.[target], 1, '侦察完工：情报升到估算');
  // 视图下发 intelTier
  const v2 = strategyViewState(w, cfg);
  const enemyRow = v2.cities.find((c) => Number(c.id) === Number(target));
  assert.equal(enemyRow.intelTier, 1, '敌方城视图应带情报档');

  // 离间完工 → unrest +1 且守军 −3%
  const troopsBefore = Number(st.cities[target].troops) || 0;
  const s2 = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'sow', targetCityId: target });
  assert.equal(s2.ok, true, JSON.stringify(s2));
  fastForward(w, 31);                         // 离间 2 旬（无官可派 3 旬）
  assert.equal(Number(st.cities[target].unrest) || 0, 1, '离间应写离心度');
  assert.equal(st.cities[target].troops, Math.max(200, Math.round(troopsBefore * 0.97)), '守军 −3%');

  // 目标城非法：不相邻 / 己方城
  const bad1 = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'scout', targetCityId: 999999 });
  assert.equal(bad1.ok, false);
  assert.equal(bad1.reason, 'no_target');
  const view2 = strategyViewState(w, cfg);
  const row2 = view2.cities.find((c) => Number(c.id) === cid);
  const ownAdj = (row2?.marchRoutes || []).map((rt) => Number(rt.id))
    .find((id) => st.cities[id] && st.cities[id].owner === 'player');
  if (ownAdj) {
    const bad2 = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'sow', targetCityId: ownAdj });
    assert.equal(bad2.ok, false);
    assert.equal(bad2.reason, 'target_own_city');
  }
});

test('M2·兴学：完工后该城酒馆来访贤才位 +1', () => {
  const { state: w, st } = oathWorld();
  const cid = ownFirst(st);
  const r = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'study' });
  assert.equal(r.ok, true, JSON.stringify(r));
  fastForward(w, 51);                         // 兴学 3 旬（无官可派 5 旬）
  assert.ok((w.tavern.studyBonus?.[cid] || 0) >= 1, '完工应写 studyBonus');
  const guests = todaysGuests(w, Math.floor(Number(w.clock.day) || 1), cid);
  assert.ok(guests.length >= 4, `兴学城来访应有 4 位（3+1），实际 ${guests.length}`);
});

test('M2·招抚：完工 90 日内叛逃概率 ×0.7（经 loyaltyTick 判定口验证）', () => {
  const { state: w, st } = oathWorld();
  const cid = ownFirst(st);
  const r = strategyInvest(w, cfg, { push() {} }, { cityId: cid, kind: 'appease' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const done = fastForward(w, 31);            // 招抚 2 旬（无官可派 3 旬）
  assert.ok(done.completed.some((t) => t.kind === 'appease'), '招抚应完工');
  const day = Math.floor(Number(w.clock.day) || 1);
  assert.equal(st.cityEcon[cid].appeaseUntil, day + 90, '招抚期 90 日');
  assert.ok(st.cityEcon[cid].order > 0, '治安应 +5');
});
