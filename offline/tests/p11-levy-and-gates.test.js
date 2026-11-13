/**
 * P11 回归：兵役制 + 登录门禁 + 出征六门闭环。
 *
 * 用户 2026-11-13 明确指出的四条兵役规则与「出征流程不完整」，在这里逐条锁死：
 *   妇孺老弱免征 / 一户一丁 / 一旬一征（不许反复征）/ 先发展人口。
 *   GDD §3.2 门 4→5→6：遭遇挂起 → 确认才结算 → 占城有消化待办。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyAttack, strategyResolveMarches,
  strategyConfirmBattle, strategyRetreatBattle, strategyDigestDone,
  strategyInvest, strategyViewState, marchableFrom,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { levyView, checkLevy, commitLevy, HOUSEHOLD_SIZE, POP_PER_SOLDIER } from '../server/domain/levy.js';
import { advanceInteriorTasks } from '../server/domain/interior-task.js';

const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function makeCtx(state) {
  return { state, cfg, options: {}, pushes: [], push() {}, save() {}, log() {}, schedule() {} };
}
function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lord = oathOptions(state).lords.filter((l) => l.cities.length >= 2)[0];
  chooseOath(state, cfg, { push() {} }, { lord: lord.id, city: lord.cities[0].id });
  state.roleRes.gold = 1_000_000;
  state.roleRes.grain = 1_000_000;
  state.roleRes.wood = 1_000_000;
  state.roleRes.iron = 1_000_000;
  state.roleRes.stone = 1_000_000;
  return { state, st: state.strategy };
}
function ownFirst(st) {
  return Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
}

/* ---------------- 兵役台账 ---------------- */

test('P11 兵源：妇孺老弱户不参与征兵，一户只出一丁', () => {
  const { state, st } = oathWorld();
  const cid = ownFirst(st);
  st.cityEcon[cid].pop = 20000;
  st.cityEcon[cid].levied = 0;
  st.cityEcon[cid].lastLevyTurn = -1;
  const v = levyView(state, cid);
  assert.equal(v.households, 20000 / HOUSEHOLD_SIZE);
  assert.ok(v.adultMales < v.households, '适龄壮丁户必须少于总户数');
  assert.equal(v.exempt, v.households - v.adultMales, '免征户要显式算出来并下发');
  assert.ok(v.quota > 0 && v.quota <= v.houseBalance, '可征不得超过未征壮丁户');
  assert.equal(v.popCostPerSoldier, POP_PER_SOLDIER);
});

test('P11 兵源：超额被拒且失败不扣资源；一旬只征一次', () => {
  const { state, st } = oathWorld();
  const cid = ownFirst(st);
  st.cityEcon[cid].pop = 20000;
  st.cityEcon[cid].levied = 0;
  st.cityEcon[cid].lastLevyTurn = -1;
  const army = state.armys[0];
  army.cityId = cid;
  army.generals = [state.generals[0].id, 0, 0];
  const ctx = makeCtx(state);
  const v0 = levyView(state, cid);
  const wood0 = state.roleRes.wood;

  const over = handleRequest(ctx, req('army.conscript', { armyId: army.id, cnts: [v0.quota + 500, 0, 0] }));
  assert.notEqual(over.code, 0, '超本旬可征额必须拒绝');
  assert.equal(over.msg.reason, 'over_quota');
  assert.equal(state.roleRes.wood, wood0, '失败不扣任何资源（旧实现先扣后查）');

  const ok = handleRequest(ctx, req('army.conscript', { armyId: army.id, cnts: [Math.max(1, v0.quota), 0, 0] }));
  assert.equal(ok.code, 0, JSON.stringify(ok.msg));
  assert.equal(ok.msg.levy.levied, Math.max(1, v0.quota), '已征户累计');

  const again = handleRequest(ctx, req('army.conscript', { armyId: army.id, cnts: [10, 0, 0] }));
  assert.notEqual(again.code, 0, '同旬反复征兵必须被拦住');
  assert.equal(again.msg.reason, 'levy_cooldown');
  assert.equal(state.strategy.cityEcon[cid].levyCount, 1, '台账只记一次');
});

test('P11 兵源：人口下降后需先发展人口，劝课生息完工把兵源养回来', () => {
  const { state, st } = oathWorld();
  const cid = ownFirst(st);
  const e = st.cityEcon[cid];
  e.pop = 1000;
  e.levied = 0;
  e.lastLevyTurn = -1;
  const before = levyView(state, cid);
  assert.ok(before.quota > 0);
  /* 模拟长年穷兵黩武：所有有丁之户都征过了 */
  e.levied = Math.floor(e.pop / HOUSEHOLD_SIZE * 0.62);
  e.lastLevyTurn = -1;   // 只验「户已征尽」，不受旬冷却干扰
  const drained = levyView(state, cid);
  assert.equal(drained.canLevy, false);
  assert.equal(drained.reason, 'levy_exhausted');
  void before;
  void commitLevy;

  /* 办「劝课生息」：完工 +8% 人口，新户带来新丁 */
  state.roleRes.gold = 100000;
  const r = strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind: 'populate' });
  assert.equal(r.ok, true, JSON.stringify(r));
  state.clock.day = (Number(state.clock.day) || 1) + 60;
  advanceInteriorTasks(state, cfg, { push() {} });
  const after = levyView(state, cid);
  assert.ok(after.pop > drained.pop, '人口应增长');
  assert.ok(after.houseBalance > 0, '新户应带来新的可征壮丁');
});

test('P11 兵源：checkLevy 在未举义旧档下降级，不锁死老存档', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const r = checkLevy(state, 1, 500, { strict: false });
  assert.equal(r.ok, true);
});

/* ---------------- 出征六门 ---------------- */

function battlefield() {
  const { state, st } = oathWorld();
  const own = Object.entries(st.cities).filter(([, v]) => v.owner === 'player').map(([id]) => Number(id));
  for (const from of own) {
    const to = marchableFrom(from, state).find((n) => st.cities[n]?.owner !== 'player');
    if (!to) continue;
    const army = state.armys[0];
    army.cityId = from;
    army.soldiers = [1200, 0, 0];
    army.generals = [state.generals[0].id, 0, 0];
    return { state, st, from, to, army };
  }
  return null;
}

test('P11 门 4/5：抵达先挂遭遇，确认后才开打', () => {
  const f = battlefield();
  assert.ok(f, '需要一组可打的出发城/目标城');
  const { state, st, from, to, army } = f;
  const ctx = makeCtx(state);
  const atk = strategyAttack(state, cfg, ctx, {
    cityId: to, fromCityId: from, armyId: army.id, frac: 1, confirmBattle: true,
  });
  assert.equal(atk.ok, true, JSON.stringify(atk));
  state.clock.day = atk.arriveDay;
  const reports0 = state.warReports.length;
  strategyResolveMarches(state, cfg, ctx);
  const view = strategyViewState(state, cfg);
  assert.equal(view.pendingBattles.length, 1, '抵达应进入遭遇待决');
  assert.equal(state.warReports.length, reports0, '未确认前不许写战报');
  assert.equal(army.marchId, atk.marchId, '待决期间队伍仍锁定');

  const done = strategyConfirmBattle(state, cfg, ctx, { marchId: atk.marchId });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(state.warReports.length, reports0 + 1, '确认后写战报');
  assert.equal(strategyViewState(state, cfg).pendingBattles.length, 0);
  void st;
});

test('P11 门 4 另一路：临阵收兵退一半粮、队伍归城；门 6 消化待办可清除', () => {
  const f = battlefield();
  const { state, st, from, to, army } = f;
  const ctx = makeCtx(state);
  const atk = strategyAttack(state, cfg, ctx, {
    cityId: to, fromCityId: from, armyId: army.id, frac: 1, confirmBattle: true,
  });
  state.clock.day = atk.arriveDay;
  strategyResolveMarches(state, cfg, ctx);
  const ret = strategyRetreatBattle(state, cfg, ctx, { marchId: atk.marchId });
  assert.equal(ret.ok, true);
  assert.equal(ret.refund, Math.floor(atk.grainCost / 2));
  assert.ok(!army.marchId, '收兵后解锁队伍');
  assert.equal(Number(army.cityId), Number(from));

  st.digest = [{ cityId: to, name: '测试城', day: 3, reportId: 1 }];
  const d = strategyDigestDone(state, { cityId: to });
  assert.equal(d.cleared, 1);
  assert.equal((st.digest || []).length, 0);
});

test('P11 兼容：不传 confirmBattle 的老调用方仍自动结算', () => {
  const f = battlefield();
  const { state, from, to, army } = f;
  const ctx = makeCtx(state);
  const atk = strategyAttack(state, cfg, ctx, { cityId: to, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(atk.ok, true);
  state.clock.day = atk.arriveDay;
  const reports0 = state.warReports.length;
  strategyResolveMarches(state, cfg, ctx);
  assert.equal(state.warReports.length, reports0 + 1, '协议层老行为不变');
});
