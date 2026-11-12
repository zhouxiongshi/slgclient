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

// ── 战位与射程（P7 语义回填到 TS 基准内核，防止 rebuild 丢失）───────────────
function templateHero() {
  return JSON.parse(JSON.stringify(buildArmies(cfg, 1, 10, 10000)[0].hero));
}

function mk(id: string, side: number, pos: number, attackRange: number, skills: unknown[] = []) {
  return {
    unit_id: id,
    side,
    hero: { ...templateHero(), skills },
    troops: 90000,
    max_troops: 90000,
    speed: 100 + (4 - pos) * 10,
    pos,
    attack_range: attackRange,
  };
}

test('战位距离：普攻打战位最近者（大营在后排时不会越过前锋）', () => {
  const units = [
    mk('a0', 1, 0, 9),
    mk('d0', 2, 2, 9),
    mk('d1', 2, 1, 9),
    mk('d2', 2, 0, 9),
  ];
  const r = runBattle({ units, seed: 1, config: cfg, roundLimit: 1 });
  const hits = r.events.filter((e) => e.kind === 'damage' && e.actor === 'a0');
  assert.equal(hits.length, 1);
  assert.equal((hits[0].payload as any).target, 'd2', '前锋 pos=0 应被优先攻击');
});

test('普攻攻击距离：大营短手武将打不到人（本回合无普攻，靠战法输出）', () => {
  const units = [
    mk('a0', 1, 2, 1), // 大营 + 攻距 1：对任意敌军距离 ≥ 3
    mk('d0', 2, 0, 9),
  ];
  const r = runBattle({ units, seed: 1, config: cfg, roundLimit: 1 });
  assert.equal(r.events.filter((e) => e.actor === 'a0' && e.kind === 'damage').length, 0);
});

test('战法射程：effect.range 之外的敌军不吃伤害，range 缺省则不受限', () => {
  const makeSkill = (range?: number) => ({
    skill_id: 1,
    name: '测试战法',
    skill_class: '主动',
    level: 1,
    prepare: 0,
    probability_init: 100,
    probability_max: 100,
    effects: [
      {
        detail_id: 1,
        effect_type: 'PHYSICAL_DAMAGE',
        rate_pct: 100,
        target_type: 'enemy_single',
        attack_type: 'normal',
        available_round: 0,
        control_probability: 0,
        bonus_terms: [],
        ...(range === undefined ? {} : { range }),
      },
    ],
  });
  const run = (range?: number) => {
    const units = [mk('a0', 1, 0, 9, [makeSkill(range)]), mk('d0', 2, 2, 9)];
    const r = runBattle({ units: units as any, seed: 3, config: cfg, roundLimit: 1 });
    // 只看战法伤害，排除同回合的普攻
    return r.events.filter(
      (e) => e.actor === 'a0' && e.kind === 'damage' && (e.payload as any).skill === '测试战法',
    );
  };
  // 距离 = 0(pos) + 2(pos) + 1 = 3
  assert.equal(run(1).length, 0, 'range=1 打不到 pos=2 的敌军');
  assert.equal(run(3).length, 1, 'range=3 恰好够到');
  assert.equal(run(undefined).length, 1, 'range 缺省 = 无远弗届');
});

test('缺省 pos/attack_range 时事件流与旧实现完全一致（黄金向量口径不变）', () => {
  const units = buildArmies(cfg, 3, 10, 1200);
  const legacy = units.map((u) => {
    const { pos, attack_range, ...rest } = u as any;
    return rest;
  });
  const a = runBattle({ units: legacy, seed: 20261106, config: cfg, roundLimit: 8 });
  const b = runBattle({ units, seed: 20261106, config: cfg, roundLimit: 8 });
  assert.equal(a.event_fingerprint, b.event_fingerprint);
  assert.equal(a.events.length, 175);
});
