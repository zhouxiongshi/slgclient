/**
 * P61-B（2026-11-25）资源稀缺三闸回归：
 *  政令旬预算 8/旬上限 12；金币沉淀税免税额 3 旬毛产；石料超量堆腐。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { applyDays } from '../server/domain/economy.js';
import { ensureStrategy } from '../server/domain/strategy.js';

const cfg = loadConfig();
function mkCtx() {
  return { push() {}, save() {}, log() {}, schedule() {} };
}

test('P61-B① 政令：不再每日回满，每跨一旬 +8、上限 12', () => {
  const s = createWorld(cfg);
  const ctx = mkCtx();
  assert.equal(s.roleRes.decree, 12, '开局按旬预算上限');
  s.roleRes.decree = 0;
  s.clock.day = 5;
  applyDays(s, cfg, 1, {}, ctx);
  assert.equal(s.roleRes.decree, 0, '旬内不再回政令');
  s.clock.day = 11;
  applyDays(s, cfg, 6, {}, ctx); // day 5→11 跨过第 1 旬
  assert.equal(s.roleRes.decree, 8);
  s.clock.day = 21;
  applyDays(s, cfg, 10, {}, ctx);
  assert.equal(s.roleRes.decree, 12, '跨两旬攒到上限即止');
  const text = readFileSync(new URL('../server/domain/economy.js', import.meta.url), 'utf8');
  assert.match(text, /decreePerTurn = 8/);
  assert.match(text, /Math\.min\(12,/);
});

test('P61-B② 金币沉淀税：免税额收紧到 3 旬毛产', () => {
  const s = createWorld(cfg);
  ensureStrategy(s);
  s.strategy.cities = { 1: { owner: 'player', troops: 0 } }; // 沉淀税只对有城玩家生效
  s.roleRes.gold = 100000;
  s.roleRes.gold_yield = 1000;
  s.clock.day = 11;
  const out = applyDays(s, cfg, 10, {}, mkCtx());
  assert.ok(out.hoardTaxPaid > 0);
  // 结算先扣 35% 城防俸饷，再按（存量 - 3 旬毛产）× 4% × 旬数收税
  const afterMaintain = 100000 + 10000 - Math.round(10000 * 0.35);
  const expected = Math.floor((afterMaintain - 30000) * 0.04); // 3 旬 × 1000/日 × 10 日 = 30000
  assert.equal(out.hoardTaxPaid, expected);
});

test('P61-B③ 石料堆腐：超过 8 旬毛产的部分按旬损耗，并进府库流水', () => {
  const s = createWorld(cfg);
  s.roleRes.stone = 100000;
  s.roleRes.stone_yield = 1000;
  s.clock.day = 11;
  s.resLedger = [];
  const out = applyDays(s, cfg, 10, {}, mkCtx());
  assert.ok(out.stoneRotPaid > 0, '超量石料被回收');
  assert.ok(s.roleRes.stone < 110000, '不再撞仓容后仍线性累积');
  const rows = s.resLedger.filter((x) => x.reason === '石料堆腐');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, -out.stoneRotPaid);
});
