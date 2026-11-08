/**
 * 资源 / 设施 / 建筑逻辑验收 —— 与原 Go 服务端逐条对齐：
 *
 *  1. 设施等级配置（facility_*.json）加载：升级消耗 / 工期 / 加成
 *  2. city.upFacility：按 need 扣资源、有工期、maxLevel、升级中拒绝
 *  3. 设施加成进入产量：磨坊 → 粮食产量、仓库 → 仓库容量
 *  4. interior.collect：按日重置 / 次数上限(55) / CD(56) / 金币=税收产量
 *  5. interior.transform：无集市拒绝(58) / from→to 跨资源兑换 / 透支拒绝(1)
 *  6. nationMap.build：领地上建要塞，扣政令+资源，有工期
 *  7. nationMap.upBuild / delBuild：只有要塞可操作(53/54)，到点被动完成
 *  8. 资源按游戏日产出（基础+设施+领地）、政令恢复、仓库封顶
 *  9. 旧存档 normalizeWorld 兼容
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';

const cfg = loadConfig();

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, options: {}, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    save() {},
    log() {},
  };
}
const req = (name, msg = {}) => ({ seq: 1, name, msg });
const nowSec = () => Math.floor(Date.now() / 1000);
/** 推时间：任意一次请求都会触发被动结算 */
const tick = (ctx) => handleRequest(ctx, req('role.myRoleRes'));

test('设施等级配置来自 facility_*.json（消耗/工期/加成与原版一致）', () => {
  assert.deepEqual(cfg.facilityNeed(0, 1), { decree: 0, grain: 1000, wood: 1000, iron: 1000, stone: 1000 });
  assert.equal(cfg.facilityTime(0, 1), 10);
  assert.equal(cfg.facilityTime(19, 1), 10);
  assert.ok(cfg.facilityMaxLevel(19) > 0);
  assert.deepEqual(cfg.facilityAdditions(19), [19]);       // 磨坊 → 粮食产量
  assert.deepEqual(cfg.facilityAdditions(25), [23]);       // 仓库 → 仓库容量
  const fort = cfg.buildCustomCfg(56, 1);                   // 要塞
  assert.equal(fort.need.decree, 2);
  assert.equal(fort.time, 100);
});

test('city.upFacility 按真实 need 扣资源并进入工期，升级中拒绝重复升级', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const res = state.roleRes;
  const before = { wood: res.wood, iron: res.iron, stone: res.stone, grain: res.grain };
  const r1 = handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 19 }));
  assert.equal(r1.code, 0);
  const need = cfg.facilityNeed(19, 1);
  assert.equal(res.wood, before.wood - need.wood);
  assert.equal(res.iron, before.iron - need.iron);
  assert.equal(res.stone, before.stone - need.stone);
  assert.equal(res.grain, before.grain - need.grain);
  const f = state.facilities[1].find((x) => x.type === 19);
  assert.equal(f.level, 0);            // 升级中，等级未变
  assert.ok(f.up_time > 0);            // 进入工期
  assert.equal(handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 19 })).code, 12);
});

test('设施到点被动完成，产量加成生效（磨坊→粮食、仓库→容量）', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 19 })); // 磨坊
  handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 25 })); // 仓库
  const f19 = state.facilities[1].find((x) => x.type === 19);
  const f25 = state.facilities[1].find((x) => x.type === 25);
  const grain0 = state.roleRes.grain_yield;
  const cap0 = state.roleRes.depot_capacity;
  f19.up_time = nowSec() - 3600;       // 时间旅行：工期已过
  f25.up_time = nowSec() - 3600;
  tick(ctx);
  assert.equal(f19.level, 1);
  assert.equal(f25.level, 1);
  assert.equal(f19.up_time, 0);
  assert.equal(state.roleRes.grain_yield, grain0 + 1000);   // 磨坊 lv1 = +1000 粮/小时
  assert.equal(state.roleRes.depot_capacity, cap0 + 10000); // 仓库 lv1 = +10000 容量
});

test('city.upFacility 资源不足返回 16，满级返回 12', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  state.roleRes.wood = 0;
  assert.equal(handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 19 })).code, 16);
  state.roleRes.wood = 100000;
  const f = state.facilities[1].find((x) => x.type === 19);
  f.level = cfg.facilityMaxLevel(19);
  assert.equal(handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 19 })).code, 12);
});

test('interior.collect：CD(56) / 次数上限(55) / 金币=税收产量 / 跨日重置', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const gold0 = state.roleRes.gold;
  const c1 = handleRequest(ctx, req('interior.collect'));
  assert.equal(c1.code, 0);
  assert.equal(state.roleRes.gold, gold0 + state.roleRes.gold_yield);
  assert.equal(handleRequest(ctx, req('interior.collect')).code, 56); // CD 内
  state.roleAttr.lastCollectTime = Date.now() - 31000;
  const c3 = handleRequest(ctx, req('interior.collect'));
  assert.equal(c3.code, 0);
  assert.equal(c3.msg.cur_times, 2);
  state.roleAttr.lastCollectTime = Date.now() - 31000;
  const c4 = handleRequest(ctx, req('interior.collect')); // 第 3 次：到达上限
  assert.equal(c4.code, 0);
  assert.equal(c4.msg.cur_times, 3);
  assert.ok(c4.msg.next_time > Date.now());                          // 未来时间
  assert.ok(c4.msg.next_time <= Date.now() + 24 * 3600 * 1000 + 1000);
  assert.notEqual(new Date(c4.msg.next_time).toDateString(), new Date().toDateString()); // 次日
  const goldNow = state.roleRes.gold;
  state.roleAttr.lastCollectTime = Date.now() - 31000;
  assert.equal(handleRequest(ctx, req('interior.collect')).code, 55); // 超限拒绝
  assert.equal(state.roleRes.gold, goldNow);                          // 不再加金币
  state.roleAttr.lastCollectTime = 0;                                 // 跨日重置
  state.roleAttr.collectTimes = 0;
  assert.equal(handleRequest(ctx, req('interior.collect')).code, 0);
});

test('interior.transform：无集市拒绝(58)，有集市按 from/to 跨资源兑换，透支拒绝(1)', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  assert.equal(handleRequest(ctx, req('interior.transform', { from: [100, 0, 0, 0] })).code, 58);
  state.roleRes.wood += 100000;
  handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 15 })); // 集市
  const market = state.facilities[1].find((x) => x.type === 15);
  market.up_time = nowSec() - 3600;
  tick(ctx);
  assert.ok(market.level >= 1);
  const w0 = state.roleRes.wood;
  const g0 = state.roleRes.grain;
  const r = handleRequest(ctx, req('interior.transform', { from: [500, 0, 0, 0], to: [0, 0, 0, 500] }));
  assert.equal(r.code, 0);
  assert.equal(state.roleRes.wood, w0 - 500);
  assert.equal(state.roleRes.grain, g0 + 500);
  assert.equal(handleRequest(ctx, req('interior.transform', { from: [99999999, 0, 0, 0] })).code, 1);
});

test('nationMap.build：在自己领地建要塞，扣政令+资源，有工期，到点完成', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const b = state.builds[0];
  const originalLevel = b.level;
  assert.ok((b.wood || 0) + (b.grain || 0) > 0);   // 领地有产量，可建造
  const res = state.roleRes;
  const before = { wood: res.wood, decree: res.decree };
  const r = handleRequest(ctx, req('nationMap.build', { x: b.x, y: b.y, type: 56 }));
  assert.equal(r.code, 0);
  const fort = cfg.buildCustomCfg(56, 1);
  assert.equal(res.decree, before.decree - fort.need.decree);
  assert.equal(res.wood, before.wood - fort.need.wood);
  assert.equal(b.type, 56);
  // ★ 修复：建造中不再把 level 降为 0（客户端 npc.levels 只有 1~10，
  //   level=0 会让地形详情面板越界崩溃），改用 building 标记工期。
  assert.equal(b.level, originalLevel);
  assert.equal(b.building, true);
  assert.equal(b.op_level, 1);
  assert.ok(b.end_time > nowSec());
  // 到点被动完成
  b.end_time = nowSec() - 1;
  tick(ctx);
  assert.equal(b.level, 1);
  assert.equal(b.building, false);
  assert.equal(b.op_level, 1);
  assert.equal(b.end_time, 0);
  assert.equal(b.maxDurable, fort.durable);
});

test('nationMap.upBuild/delBuild：只有要塞可操作(53/54)，升级扣 lv2 need，拆除恢复资源地', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const b = state.builds[0];
  handleRequest(ctx, req('nationMap.build', { x: b.x, y: b.y, type: 56 }));
  b.end_time = nowSec() - 1;
  tick(ctx);
  const other = state.builds.find((x) => x !== b && x.type !== 56);
  assert.equal(handleRequest(ctx, req('nationMap.upBuild', { x: other.x, y: other.y })).code, 53);
  // 升级 1→2：扣 need(56,2)
  const res = state.roleRes;
  const before = { wood: res.wood, iron: res.iron };
  const r = handleRequest(ctx, req('nationMap.upBuild', { x: b.x, y: b.y }));
  assert.equal(r.code, 0);
  const need2 = cfg.buildCustomCfg(56, 2).need;
  assert.equal(res.wood, before.wood - need2.wood);
  assert.equal(res.iron, before.iron - need2.iron);
  assert.equal(b.level, 1);
  assert.equal(b.op_level, 2);
  b.end_time = nowSec() - 1;
  tick(ctx);
  assert.equal(b.level, 2);
  // 拆除 → 到点恢复为地图资源地
  const tile = cfg.tileAt(b.x, b.y)[0];
  assert.equal(handleRequest(ctx, req('nationMap.delBuild', { x: b.x, y: b.y })).code, 0);
  assert.equal(b.op_level, 0);
  b.end_time = nowSec() - 1;
  tick(ctx);
  assert.equal(b.type, tile);
  assert.equal(b.level, cfg.tileAt(b.x, b.y)[1] || 1);
  assert.ok((b.wood || 0) + (b.grain || 0) > 0);   // 产量字段恢复
});

test('nationMap.build：资源不足返回 16，要塞达到上限返回 49', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  state.roleRes.wood = 0;
  const b = state.builds[0];
  assert.equal(handleRequest(ctx, req('nationMap.build', { x: b.x, y: b.y, type: 56 })).code, 16);
  state.roleRes.wood = 100000;
  const limit = cfg.basic.build.fortress_limit;
  for (let i = 0; i < limit; i += 1) {
    state.builds.push({ rid: 1, x: -10 - i, y: -10 - i, type: 56, level: 1, op_level: 1, wood: 0, iron: 0, stone: 0, grain: 0 });
  }
  assert.equal(handleRequest(ctx, req('nationMap.build', { x: b.x, y: b.y, type: 56 })).code, 49);
});

test('资源按游戏日产出、政令恢复、仓库封顶', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  tick(ctx);
  const expectedWoodYield = (cfg.basic.role.wood_yield ?? 1000)
    + state.builds.reduce((s, b) => s + (b.wood || 0), 0);
  assert.equal(state.roleRes.wood_yield, expectedWoodYield);
  // 2 个游戏日（1 倍速下 1 日 = 60 秒），不再按真实小时
  state.clock.lastRealMs = Date.now() - 2 * 60 * 1000;
  state.clock.accMs = 0;
  const w0 = state.roleRes.wood;
  const d0 = state.roleRes.decree = 0;
  tick(ctx);
  assert.ok(state.roleRes.wood >= w0 + expectedWoodYield * 2 - 1);
  assert.equal(state.roleRes.decree, Math.min(cfg.basic.role.decree_limit, d0 + 60));
  // 爆仓封顶
  const cap = state.roleRes.depot_capacity;
  state.roleRes.wood = cap;
  state.clock.lastRealMs = Date.now() - 60 * 1000;
  state.clock.accMs = 0;
  tick(ctx);
  assert.equal(state.roleRes.wood, cap);
});

test('旧存档 normalizeWorld：补产量字段 / 修正 op_level', () => {
  const old = {
    version: 1, role: { rid: 1 }, roleRes: {}, citys: [], generals: [], armys: [],
    builds: [{ rid: 1, x: 5, y: 5, type: 52, level: 1, op_level: 0, curDurable: 10000, maxDurable: 10000 }],
    facilities: {}, counters: {}, pending: [],
  };
  normalizeWorld(old, cfg);
  const b = old.builds[0];
  assert.equal(b.wood, 100);       // map_build.json 土地Lv.1
  assert.equal(b.grain, 100);
  assert.equal(b.op_level, 1);     // 旧档 op_level=0 视为空闲
});
