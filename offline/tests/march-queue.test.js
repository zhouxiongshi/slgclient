/**
 * P2 行军系统回归：出征生成行军队列（扣粮+锁队）、到达日结算开打、
 * 队伍解锁、状态视图带行军数据与日内进度。不碰战斗内核断言（battle-core 有自己的测试）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  strategyAttack, strategyResolveMarches, ensureStrategy, strategyViewState,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();
const fresh = () => normalizeWorld(createWorld(cfg), cfg);

test('行军系统：出征生成行军队列+扣行军粮+锁队；到达日结算；状态视图带行军数据', () => {
  const s = fresh();
  const st = ensureStrategy(s);
  const view0 = strategyViewState(s, cfg);
  const targetId = view0.marchable[0];
  assert.ok(Number.isFinite(targetId), '本城必有可出征邻城');
  const army = s.armys.find((a) => (a.soldiers || []).some((n) => n > 0)
    && (a.generals || []).some((g) => g));
  assert.ok(army, '新档必有一支带将带兵的队伍');

  const grainBefore = Number(s.roleRes.grain) || 0;
  ensureCityEcon(s);
  const storeBefore = s.strategy.cityEcon?.[st.playerCity]?.store ?? 0;
  const r = strategyAttack(s, cfg, {}, { cityId: targetId, armyId: army.id, frac: 1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.marching, true, '出征改为先行军');
  assert.ok(r.grainCost > 0, '行军要扣粮');
  // ★ 城市经营：行军粮优先扣出发城城库（城库 2000 起步足够），池不动
  const storeAfter = s.strategy.cityEcon?.[st.playerCity]?.store ?? 0;
  assert.equal(storeBefore - storeAfter, r.grainCost, '行军粮优先扣城库');
  assert.ok((s.resLedger || []).some((e) => e.reason.includes('行军粮')), '行军粮入流水');
  assert.equal(army.marchId, r.marchId, '队伍被锁');
  assert.equal(st.marches.length, 1);
  assert.equal(st.marches[0].arriveDay - st.marches[0].departDay, 2, '相邻城 2 游戏日');

  // 行军中的队伍不能再出征（自动选队也应跳过它）
  const again = strategyAttack(s, cfg, {}, { cityId: targetId, armyId: army.id, frac: 1 });
  assert.equal(again.ok, false, '行军中的队伍不能再出征');

  // 状态视图：marches + dayFrac + msPerDay
  const v = strategyViewState(s, cfg);
  assert.equal(v.marches.length, 1);
  assert.equal(typeof v.dayFrac, 'number');
  assert.ok(v.msPerDay > 0);

  // 未到到达日不结算
  assert.equal(strategyResolveMarches(s, cfg, {}).length, 0);

  // 推进到到达日之后 → 结算开打（走真实内核，胜负都有战报）
  s.clock.day = r.arriveDay + 1;
  const res = strategyResolveMarches(s, cfg, {});
  assert.equal(res.length, 1, '到达即结算');
  assert.ok([0, 1, 2].includes(res[0].result), '战报结果为 败/平/胜');
  assert.equal(army.marchId, undefined, '结算后解锁');
  assert.equal(st.marches[0].resolved, true);

  // 幂等：同一批不重复结算
  assert.equal(strategyResolveMarches(s, cfg, {}).length, 0);
});
