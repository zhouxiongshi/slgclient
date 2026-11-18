/**
 * P17 回归：2026-11-18 征兵/队伍四项改造
 *  ① 兵种差异化消耗（盾步/弓/骑单价不同）
 *  ② 带兵上限 = 5000 + 官阶×300 + (等级−1)×200（等级+官职双因子）
 *  ③ 一键征满平分到有将各槽（受上限约束）
 *  ④ 解甲归田（三槽遣散退回驻城+返金）+ 剔除武将后空槽不留幽灵兵
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyFormup,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import {
  conscriptNeed, checkSlotCaps, splitEven, planDisarm, ARMS_COST_MUL,
} from '../server/domain/conscript.js';
import {
  slotCapOf, slotCapForRank, meritForRank,
} from '../server/domain/official-rank.js';

const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function makeCtx(state) {
  const scheduled = [];
  return { state, cfg, options: {}, pushes: [], push() {}, save() {}, log() {},
    schedule(at, task) { scheduled.push({ at, task }); }, scheduled };
}
function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  ensureCityEcon(state, cfg);
  const lord = oathOptions(state).lords.filter((l) => l.cities.length >= 2)[0];
  chooseOath(state, cfg, { push() {} }, { lord: lord.id, city: lord.cities[0].id });
  for (const k of ['gold', 'grain', 'wood', 'iron', 'stone']) state.roleRes[k] = 1_000_000;
  const cid = Number(Object.keys(state.strategy.cities).find((id) => state.strategy.cities[id].owner === 'player'));
  const army = state.armys[0];
  army.cityId = cid;
  army.generals = [state.generals[0].id, state.generals[1]?.id || 0, state.generals[2]?.id || 0];
  return { state, st: state.strategy, cid, army };
}

/* ---------------- ① 兵种差异化消耗 ---------------- */

test('P17-① 三兵种单兵成本不同：骑兵铁/粮/金最贵，盾步为基准', () => {
  const { need, perSlot, total } = conscriptNeed([100, 100, 100], cfg.basic.conscript, {});
  assert.equal(total, 300);
  assert.equal(perSlot.length, 3);
  assert.ok(perSlot[2].iron > perSlot[0].iron, '骑兵铁耗 > 盾步');
  assert.ok(perSlot[2].grain > perSlot[0].grain, '骑兵粮耗 > 盾步');
  assert.ok(perSlot[2].gold > perSlot[0].gold, '骑兵金耗 > 盾步');
  assert.ok(perSlot[1].iron >= perSlot[0].iron, '弓兵铁耗 >= 盾步');
  assert.ok(ARMS_COST_MUL[0].iron === 1, '盾步为基准');
  // need 是三槽合计，必大于单一兵种 300 兵的消耗（因为骑/弓更贵）
  assert.ok(need.iron > 100 * perSlot[0].iron);
});

test('P17-① 石耗派生保留：原表 cost_stone=0 时石/兵 = max(5,⌊铁/2⌋)', () => {
  const { perSlot } = conscriptNeed([1, 1, 1], { cost_iron: 10, cost_stone: 0 }, {});
  assert.equal(perSlot[0].stone, 5);
  assert.ok(perSlot[2].stone >= perSlot[0].stone, '骑兵石耗不低于盾步');
});

/* ---------------- ② 带兵上限双因子 ---------------- */

test('P17-② 带兵上限 = 5000 + 官阶×300 + (等级−1)×200', () => {
  assert.equal(slotCapOf({ level: 1, merit: 0 }), 5000, 'Lv1 白身 = 5000');
  assert.equal(slotCapOf({ level: 10, merit: 0 }), 6800, 'Lv10 白身 = 6800');
  assert.equal(slotCapOf({ level: 10, merit: meritForRank(9) }), 9500, 'Lv10 三公 = 9500');
  assert.equal(slotCapOf({ level: 5, merit: meritForRank(4) }), 7000, 'Lv5 四阶 = 5000+1200+800=7000');
  assert.equal(slotCapOf({}), 5000, '空对象兼容旧口径');
  assert.equal(slotCapForRank(9), 7700, '兼容口径不含等级');
});

test('P17-② 征兵超带兵上限被拒（over_cap），灰心不影响现有兵力', () => {
  const { state, army } = oathWorld();
  const g = state.generals[0];
  g.level = 1; g.merit = 0; // 上限 5000
  army.soldiers = [4900, 0, 0];
  army.con_cnts = [0, 0, 0];
  const ctx = makeCtx(state);
  const before = { ...state.roleRes };
  const rsp = handleRequest(ctx, req('army.conscript', { armyId: army.id, cnts: [200, 0, 0] }));
  assert.equal(rsp.code !== 0, true, '4900+200 超 5000 应被拒');
  assert.equal(rsp.msg.reason, 'over_cap');
  assert.equal(rsp.msg.cap, 5000);
  assert.equal(state.roleRes.gold, before.gold, '被拒不扣资源');
  assert.equal(army.soldiers[0], 4900, '被拒不改兵力');
});

/* ---------------- ③ 一键征满平分 ---------------- */

test('P17-③ splitEven 把总量平分给有将槽、空槽不参与', () => {
  const army = { generals: [1, 2, 0], soldiers: [0, 0, 0], con_cnts: [0, 0, 0] };
  const byId = (id) => ({ id, level: 1, merit: 0 });
  const r = splitEven(900, army, byId, { marching: false });
  assert.deepEqual(r.cnts, [450, 450, 0], '两有将槽各 450，空槽 0');
  assert.equal(r.assigned, 900);
});

test('P17-③ splitEven 受每槽上限约束，余额补到还有空间的槽', () => {
  const army = { generals: [1, 2, 0], soldiers: [4800, 0, 0], con_cnts: [0, 0, 0] };
  // Lv1 白身上限 5000：槽0 只剩 200，槽1 有 5000 → want 900 先均分 450，槽0 只能放 200，
  // 余下 250 补到槽1 → 200/700
  const byId = (id) => ({ id, level: 1, merit: 0 });
  const r = splitEven(900, army, byId, {});
  assert.equal(r.cnts[0], 200, '槽0 只能再征 200');
  assert.equal(r.cnts[1], 700, '余额补到槽1');
  assert.equal(r.assigned, 900);
});

test('P17-③ 协议层 fill=true 由服务端平分（UI 只发总量）', () => {
  const { state, army } = oathWorld();
  state.generals.forEach((g) => { g.level = 1; g.merit = 0; });
  army.soldiers = [0, 0, 0];
  army.con_cnts = [0, 0, 0];
  // 三槽都有将（oathWorld 已配 [g0,g1,g2]）
  const ctx = makeCtx(state);
  const rsp = handleRequest(ctx, req('army.conscript', { armyId: army.id, fill: true, amount: 900 }));
  assert.equal(rsp.code, 0, JSON.stringify(rsp.msg));
  assert.deepEqual(rsp.msg.cnts, [300, 300, 300], '三槽各 300');
  assert.deepEqual(army.con_cnts, [300, 300, 300]);
});

/* ---------------- ④ 解甲归田 + 剔除武将退兵 ---------------- */

test('P17-④ planDisarm 三槽遣散退回驻城+返 30% 兵值金', () => {
  const army = { soldiers: [100, 200, 300], con_cnts: [0, 0, 0] };
  const p = planDisarm([50, 200, 100], army, 1000, {});
  assert.equal(p.ok, true);
  assert.equal(p.disbanded, 350);
  assert.deepEqual(p.amounts, [50, 200, 100]);
  assert.equal(p.refund, Math.round(350 * 2 * 0.3));
  assert.deepEqual(p.remaining, [50, 0, 200]);
});

test('P17-④ 协议 army.disarm：兵力退回驻城、返金、写兵种流水', () => {
  const { state, st, cid, army } = oathWorld();
  army.soldiers = [100, 200, 0];
  army.con_cnts = [0, 0, 0];
  const city = st.cities[cid];
  city.troops = 500;
  const gold0 = state.roleRes.gold;
  const ctx = makeCtx(state);
  const rsp = handleRequest(ctx, req('army.disarm', { armyId: army.id, counts: [100, 200, 0] }));
  assert.equal(rsp.code, 0, JSON.stringify(rsp.msg));
  assert.equal(rsp.msg.disbanded, 300);
  assert.deepEqual(army.soldiers, [0, 0, 0]);
  assert.equal(city.troops, 800, '300 兵退回驻城');
  assert.equal(state.roleRes.gold, gold0 + Math.round(300 * 2 * 0.3));
});

test('P17-④ 剔除武将（generalId=0）后空槽兵力退回驻城、不再显示幽灵兵', () => {
  const { state, st, cid, army } = oathWorld();
  army.soldiers = [1234, 0, 0];
  army.con_cnts = [0, 0, 0];
  const city = st.cities[cid];
  city.troops = 100;
  const ctx = makeCtx(state);
  const rsp = handleRequest(ctx, req('army.dispose', {
    cityId: cid, order: army.order, position: 0, generalId: 0,
  }));
  assert.equal(rsp.code, 0, JSON.stringify(rsp.msg));
  assert.equal(army.generals[0], 0, '武将已剔除');
  assert.equal(army.soldiers[0], 0, '空槽兵力清零，不再显示原兵力');
  assert.equal(city.troops, 1334, '兵力退回驻城');
});

test('P17-④ 跨队摘将：被摘原槽兵力也退回驻城（不留有兵无将）', () => {
  const { state, st, cid, army } = oathWorld();
  const gid = army.generals[0];
  army.soldiers = [700, 0, 0];
  army.con_cnts = [0, 0, 0];
  st.cities[cid].troops = 0;
  // 把 g0 从槽0 移到槽1（同队），槽0 应退兵
  const ctx = makeCtx(state);
  const rsp = handleRequest(ctx, req('army.dispose', {
    cityId: cid, order: army.order, position: 1, generalId: gid,
  }));
  assert.equal(rsp.code, 0, JSON.stringify(rsp.msg));
  assert.equal(army.generals[0], 0);
  assert.equal(army.generals[1], gid);
  assert.equal(army.soldiers[0], 0, '被摘槽0兵力清零');
  assert.equal(st.cities[cid].troops, 700, '退回驻城');
});
