import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BattleEngine,
  DEFAULT_BATTLE_CONFIG,
  buildArmies,
  configFingerprint,
  runBattle,
  runDemo,
  toText,
  validateInvariants,
} from '../src/index.js';
import type { BattleConfig } from '../src/index.js';

const cfg: BattleConfig = DEFAULT_BATTLE_CONFIG;

function battle(seed = 20261106, roundLimit = 8) {
  const units = buildArmies(cfg, 3, 10, 1200);
  return { units, result: runBattle({ units, seed, config: cfg, roundLimit }) };
}

test('同 seed + 同输入 + 同配置 → 事件流与结果完全一致', () => {
  const { units } = battle();
  const a = runBattle({ units, seed: 20261106, config: cfg, roundLimit: 8 });
  const b = runBattle({ units, seed: 20261106, config: cfg, roundLimit: 8 });
  assert.equal(a.event_fingerprint, b.event_fingerprint);
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  assert.equal(a.winner, b.winner);
  assert.equal(a.rounds, b.rounds);
  assert.equal(a.rng_calls, b.rng_calls);
  assert.deepEqual(a.final_troops, b.final_troops);
});

test('调用方传入的单位对象不会被修改（输入不可变）', () => {
  const { units } = battle();
  const before = JSON.stringify(units);
  runBattle({ units, seed: 7, config: cfg, roundLimit: 8 });
  assert.equal(JSON.stringify(units), before);
});

test('配置对象在引擎构造后被外部修改，不影响已建引擎的结果', () => {
  const mutable = JSON.parse(JSON.stringify(cfg)) as BattleConfig;
  const units = buildArmies(mutable, 2, 5, 500);
  const expected = runBattle({ units, seed: 42, config: cfg, roundLimit: 4 });
  const engine = new BattleEngine({ units, seed: 42, config: mutable, roundLimit: 4 });
  mutable.min_damage = 999999;
  mutable.damage_rates_pct[0] = 999999;
  const got = engine.run(units);
  assert.equal(got.config_fingerprint, expected.config_fingerprint);
  assert.equal(JSON.stringify(got.events), JSON.stringify(expected.events));
});

test('单场战斗满足全部不变量（兵力守恒、伤害有界、状态一致）', () => {
  const { units, result } = battle();
  const report = validateInvariants(result, units, 8);
  assert.equal(report.ok, true, report.problems.join('\n'));
  assert.ok(report.checks.damage_events > 0);
  assert.ok(report.checks.damage_applied_total > 0);
});

test('roundLimit 生效：任意上限都不会越界', () => {
  for (const limit of [1, 2, 3, 5, 8, 12]) {
    const units = buildArmies(cfg, 3, 10, 5000);
    const r = runBattle({ units, seed: 123, config: cfg, roundLimit: limit });
    assert.ok(r.rounds <= limit, `roundLimit=${limit} 实际=${r.rounds}`);
    assert.equal(validateInvariants(r, units, limit).ok, true);
  }
});

test('双方都有存活单位时判平局（winner=null）', () => {
  const units = buildArmies(cfg, 2, 1, 1000000);
  const r = runBattle({ units, seed: 1, config: cfg, roundLimit: 1 });
  assert.equal(r.winner, null);
  assert.equal(Object.values(r.survivors).filter((v) => v.length > 0).length, 2);
});

test('一方全灭时立即结束并给出唯一胜方', () => {
  const { result } = battle(20261106, 8);
  assert.equal(result.winner, 1);
  assert.equal(result.rounds, 6);
  assert.equal(result.survivors['2'].length, 0);
  assert.ok(result.survivors['1'].length > 0);
});

test('不同 seed 会产生不同事件流（随机确实生效）', () => {
  const fps = new Set<string>();
  for (let seed = 1; seed <= 20; seed += 1) fps.add(battle(seed).result.event_fingerprint);
  assert.ok(fps.size >= 15, `20 个 seed 只产生 ${fps.size} 种事件流`);
});

test('非法输入被明确拒绝，而不是悄悄算出错误结果', () => {
  assert.throws(() => runBattle({ units: [], seed: 1, config: cfg }), /为空/);
  const dup = buildArmies(cfg, 1, 1, 100);
  dup[1] = { ...dup[1], unit_id: dup[0].unit_id };
  assert.throws(() => runBattle({ units: dup, seed: 1, config: cfg }), /重复/);
  const bad = buildArmies(cfg, 1, 1, 100);
  bad[0].troops = 0;
  assert.throws(() => runBattle({ units: bad, seed: 1, config: cfg }), /正数/);
  const badCfg = { ...cfg, min_damage: -1 };
  assert.throws(() => runBattle({ units: buildArmies(cfg, 1, 1, 100), seed: 1, config: badCfg }), /min_damage/);
});

test('配置指纹稳定且可区分不同配置', () => {
  const a = configFingerprint(cfg);
  const b = configFingerprint({ ...cfg, min_damage: cfg.min_damage + 1 });
  assert.equal(a, configFingerprint(cfg));
  assert.notEqual(a, b);
});

test('战报文本可读且包含关键结算信息', () => {
  const { result } = battle();
  const text = toText(result);
  assert.match(text, /战斗战报/);
  assert.match(text, /伤害=/);
  assert.match(text, /回合数=6/);
  assert.ok(text.length > 1000);
});

test('runDemo 便捷入口可一行跑通', () => {
  const r = runDemo({ seed: 20261106, perSide: 3, level: 10, troops: 1200, roundLimit: 8 });
  assert.equal(r.winner, 1);
  assert.equal(r.events.length, 175);
});
