/**
 * 第六轮（用户裁决补闭环）：全局粮池见底 → 驻军欠饷逃兵。
 *
 * 旧版 applyDays 在粮不足时 `pay = min(grain, cost)` 只少扣粮、兵力一分不掉，
 * 形成「打不动也饿不死」的僵尸大军（400 旬探针：14998 兵冻结 150 旬）。
 * 修复只补逻辑、不动军粮 0.1 参数：连续欠饷满 3 旬起驻军每旬逃散 2%，
 * 粮足即止、兵力自然收敛到城产养得起的规模。行军军由 armySupplyTick
 * 的城库链管，不受全局池逃兵影响（避免双重惩罚）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { applyDays, countSoldiers } from '../server/domain/economy.js';

const cfg = loadConfig();

function arrearsWorld({ soldiers = 800, yieldPerDay = 10 } = {}) {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const ownId = Number(Object.keys(s.strategy.cities)[0]);
  s.strategy.cities[ownId].owner = 'player';
  s.strategy.playerCity = ownId;
  s.armys = [{ id: 1, cityId: ownId, soldiers: [soldiers, 0, 0], generals: [0, 0, 0] }];
  s.roleRes.grain = 0;
  s.roleRes.grain_yield = yieldPerDay;
  s.clock.day = 1;
  return s;
}

const ctxOf = (state) => {
  const msgs = [];
  return {
    state, cfg, msgs,
    push(kind, payload) { if (kind === 'chat.push') msgs.push(payload.msg); },
  };
};

test('欠饷前 2 旬只警告不逃兵，第 3 旬起每旬逃散 2%', () => {
  const s = arrearsWorld();
  const ctx = ctxOf(s);
  const r1 = applyDays(s, cfg, 10, {}, ctx);
  const r2 = applyDays(s, cfg, 10, {}, ctx);
  assert.equal(countSoldiers(s), 800);
  assert.equal(r1.arrearsDays, 10);
  assert.equal(r1.deserters, 0);
  assert.equal(r2.arrearsDays, 20);
  const r3 = applyDays(s, cfg, 10, {}, ctx);
  assert.equal(r3.arrearsDays, 30);
  assert.equal(r3.deserters, 16);           // ceil(800 × 2%)
  assert.equal(countSoldiers(s), 784);
  const r4 = applyDays(s, cfg, 10, {}, ctx);
  assert.equal(r4.deserters, 16);           // ceil(784 × 2%)
  assert.equal(countSoldiers(s), 768);
  assert.ok(ctx.msgs.some((m) => m.includes('连续 3 旬无粮')));
  assert.ok(ctx.msgs.some((m) => m.includes('驻军逃散 16 人')));
});

test('粮足后欠饷归零、逃兵停止（恢复出口）', () => {
  const s = arrearsWorld();
  applyDays(s, cfg, 30, {}, ctxOf(s));
  assert.equal(countSoldiers(s), 784);
  s.roleRes.grain_yield = 1000;
  const r = applyDays(s, cfg, 10, {}, ctxOf(s));
  assert.equal(r.arrearsDays, 0);
  assert.equal(r.deserters, 0);
  assert.equal(countSoldiers(s), 784);
  assert.equal(s.roleRes.grainArrearsDays, 0);
});

test('兵力自然收敛到粮产养得起的规模，不会逃到 0', () => {
  const s = arrearsWorld({ soldiers: 2000, yieldPerDay: 100 });
  for (let i = 0; i < 40; i++) applyDays(s, cfg, 10, {}, ctxOf(s));
  // 日产 100 粮 ≈ 1000 兵的军饷；收敛后欠饷归零、逃兵停止
  assert.equal(s.roleRes.grainArrearsDays, 0);
  assert.ok(countSoldiers(s) > 900 && countSoldiers(s) <= 1000,
    `应收敛到约 1000 兵，实际 ${countSoldiers(s)}`);
});

test('行军中的队伍不受全局池逃兵影响（双重惩罚闸）', () => {
  const s = arrearsWorld();
  s.armys.push({ id: 2, cityId: s.strategy.playerCity, marchId: 99, soldiers: [500, 0, 0], generals: [0, 0, 0] });
  applyDays(s, cfg, 30, {}, ctxOf(s));
  assert.equal(s.armys[1].soldiers[0], 500, '行军军的粮走城库补给链，不被全局池扣');
  assert.equal(s.armys[0].soldiers[0], 784, '驻城军照常逃散');
});

test('欠饷文案守单机口径：禁出现「服务端/服务器」', () => {
  const s = arrearsWorld();
  const ctx = ctxOf(s);
  applyDays(s, cfg, 40, {}, ctx);
  for (const m of ctx.msgs) {
    assert.ok(!/服务端|服务器/.test(m), `玩家可见文案不得出现服务端字样：${m}`);
  }
  assert.ok(ctx.msgs.some((m) => m.includes('粮足即止')));
});

test('欠饷天数进存档字段，读档后可继续累计', () => {
  const s = arrearsWorld();
  applyDays(s, cfg, 20, {}, ctxOf(s));
  assert.equal(s.roleRes.grainArrearsDays, 20);
  const reloaded = JSON.parse(JSON.stringify(s));
  const r = applyDays(reloaded, cfg, 10, {}, ctxOf(reloaded));
  assert.equal(r.arrearsBefore, 20);
  assert.equal(r.arrearsDays, 30);
  assert.equal(r.deserters, 16);
});
