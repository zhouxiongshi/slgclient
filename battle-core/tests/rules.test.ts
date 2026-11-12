import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_BATTLE_CONFIG,
  actionOrder,
  baseDamage,
  calcDamage,
  configFingerprint,
  controlBlocks,
  counterFactor,
  crc32Utf8,
  effectAvailable,
  heroAttr,
  levelValue,
  normalizeBonus,
  PythonRandom,
  sumTermsBonus,
  validateConfig,
} from '../src/index.js';
import type { BattleConfig, Effect, Skill, UnitState } from '../src/index.js';

const root = resolve(process.cwd());
const vectors = JSON.parse(readFileSync(resolve(root, 'golden/expected_vectors.json'), 'utf8')) as Record<string, any>;

const cfg: BattleConfig = DEFAULT_BATTLE_CONFIG;

function mkEffect(partial: Partial<Effect> = {}): Effect {
  return {
    detail_id: 1,
    effect_type: 'PHYSICAL_DAMAGE',
    rate_pct: 100,
    target_type: 'enemy_single',
    attack_type: 'normal',
    available_round: 0,
    control_state: null,
    control_probability: 0,
    bonus_terms: [],
    ...partial,
  };
}

function mkHero(partial: Record<string, number> = {}) {
  return {
    heroid: 1, name: '测试', level: 1, hero_type: 'normal' as const,
    attack_base: 100, defence_base: 50, intel_base: 90, speed_base: 80, destroy_base: 70,
    attack_grow: 2, defence_grow: 1.5, intel_grow: 2, speed_grow: 1, destroy_grow: 1,
    skills: [], ...partial,
  };
}

function mkUnit(id: string, speed: number, states: UnitState['states'] = []): UnitState {
  return {
    unit_id: id, side: 1, hero: mkHero() as UnitState['hero'],
    troops: 1000, max_troops: 1000, speed,
    pos: 0, attack_range: 9,
    states, buffs: [], alive: true,
  };
}

test('配置完整性：数值表规模与 battle-kit 一致', () => {
  assert.equal(cfg.damage_rates_pct.length, 83);
  assert.equal(cfg.level_pairs.length, 58);
  assert.equal(cfg.effect_terms.length, 188);
  assert.equal(cfg.hero_names.length, 232);
  assert.equal(cfg.skill_names.length, 796);
  assert.equal(Object.keys(cfg.tcfg_schemas).length, 7);
  assert.equal(cfg.il_methods.length, 9);
  assert.equal(cfg.level_pairs.filter((p) => p.exactly_double).length, 58);
  assert.doesNotThrow(() => validateConfig(cfg));
  assert.match(configFingerprint(cfg), /^[0-9a-f]{16}$/);
});

test('level_value 精确匹配黄金向量', () => {
  const g = vectors.level_value;
  assert.equal(levelValue(40, 1), g['v(40,1)']);
  assert.equal(levelValue(40, 5), g['v(40,5)']);
  assert.equal(levelValue(40, 10), g['v(40,10)']);
  assert.equal(levelValue(40, 0), 40, '等级 <=1 按 Lv1');
});

test('normalize_bonus / sum_terms_bonus 精确匹配黄金向量', () => {
  const n = vectors.normalize_bonus;
  assert.equal(normalizeBonus(25, 0), n['(25, op=0)']);
  assert.equal(normalizeBonus(0.25, 1), n['(0.25, op=1)']);
  const s = vectors.sum_terms_bonus;
  const total = sumTermsBonus([
    { name: 'a', value: 10, op: 0 },
    { name: 'b', value: 20, op: 0 },
    { name: 'c', value: 0.15, op: 1 },
  ]);
  assert.equal(total, s['[10%, 20%, 0.15(op=1)]']);
  assert.equal(sumTermsBonus([]), 0);
});

test('calc_damage 三组向量逐字段精确匹配', () => {
  const cases: Array<[number, number, number, number, string]> = [
    [100, 1.2, 0.25, 1, '(100, 1.2, 0.25, min=1)'],
    [1, 1.0, 0.0, 5, '(1, 1.0, 0.0, min=5)'],
    [0.4, 1.0, 0.0, 7, '(0.4, 1.0, 0.0, min=7)'],
  ];
  for (const [base, counter, bonus, min, key] of cases) {
    const got = calcDamage(base, counter, bonus, min);
    const exp = vectors.calc_damage[key];
    for (const field of ['base', 'counter', 'bonus_total', 'after_counter', 'one_plus_bonus', 'raw', 'floored', 'min_damage', 'final']) {
      assert.equal(got[field as keyof typeof got], exp[field], `${key}.${field}`);
    }
  }
});

function defenseProbe(targetDefense: number, model?: 'legacy' | 'corrected') {
  const attacker = mkUnit('atk', 100);
  const defender = mkUnit('def', 50);
  defender.hero.defence_base = targetDefense;
  const effect = mkEffect({ rate_pct: 100 });
  const config = model ? ({ ...cfg, defense_model: model } as BattleConfig) : cfg;
  return calcDamage(baseDamage(config, effect, attacker, defender).value, 1, 0, config.min_damage);
}

test('原 slg 的 AbsInt 缺陷不存在：结算式带保底、不会被防御反转成负数', () => {
  // 即便 base 极小或 bonus 极负，final 也不会小于 min_damage，更不会变负
  for (const bonus of [-0.5, 0, 0.5, 5]) {
    const d = calcDamage(0.01, 1.0, bonus, cfg.min_damage);
    assert.equal(d.final, cfg.min_damage);
    assert.ok(d.final >= 0);
  }
  assert.equal(calcDamage(100, 1.2, 0.25, 1).final, 150);
});

test('数值缺陷登记：legacy 模式的 E2 减伤式方向反了（保持与参考实现一致）', () => {
  const weak = defenseProbe(10);
  const strong = defenseProbe(500);
  // 如实记录继承缺陷：防御 500 的受伤反而高于防御 10
  assert.ok(strong.base > weak.base, 'legacy 减伤方向反了，这是 battle-kit E2 占位式的已知缺陷');
});

test('corrected 模式修复减伤方向：防御越高伤害越低，且仍有保底', () => {
  const weak = defenseProbe(10, 'corrected');
  const strong = defenseProbe(500, 'corrected');
  assert.ok(strong.base < weak.base, '高防御必须降低基础伤害');
  assert.ok(strong.final <= weak.final, '高防御绝不能造成更高伤害');
  assert.ok(strong.final >= cfg.min_damage, '仍有保底伤害');
  // 防御单调性
  const series = [10, 50, 100, 200, 500, 1000].map((d) => defenseProbe(d, 'corrected').base);
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i] <= series[i - 1], `防御序列应单调不增：${series.join(',')}`);
  }
});

test('counter_factor 越界退化为 1.0', () => {
  const fb = vectors.counter_factor_fallback;
  for (const w of [0, 4, -1, 99]) {
    assert.equal(counterFactor(cfg, 'normal', w).factor, fb[`weakness=${w}`]);
  }
  assert.equal(counterFactor(cfg, 'unknown_type', 1).factor, 1.0);
});

test('action_order：speed 降序，同速按 unit_id 升序', () => {
  const input = vectors.action_order['输入'] as Array<[string, number]>;
  const units = input.map(([id, speed]) => mkUnit(id, speed));
  assert.deepEqual(actionOrder(units).map((u) => u.unit_id), vectors.action_order['输出']);
  assert.deepEqual(actionOrder([...units, { ...mkUnit('dead', 999), alive: false }]).map((u) => u.unit_id), vectors.action_order['输出']);
});

test('control_blocks：犹豫只阻止主动战法', () => {
  const unit = mkUnit('u', 100, ['犹豫']);
  const active: Skill = { skill_id: 1, name: 'a', skill_class: '主动', level: 1, prepare: 0, probability_init: 1, probability_max: 1, effects: [] };
  const passive: Skill = { ...active, skill_class: '被动' };
  assert.equal(controlBlocks(unit, active), '犹豫');
  assert.equal(controlBlocks(unit, passive), null);
  assert.equal(controlBlocks(mkUnit('u2', 100), active), null);
});

test('effect_available：available_round 生效', () => {
  assert.equal(effectAvailable(mkEffect({ available_round: 0 }), 99), true);
  assert.equal(effectAvailable(mkEffect({ available_round: 3 }), 3), true);
  assert.equal(effectAvailable(mkEffect({ available_round: 3 }), 4), false);
});

test('heroAttr 线性成长', () => {
  const h = mkHero({ level: 10, attack_base: 90, attack_grow: 2.2 });
  assert.equal(heroAttr(h as UnitState['hero'], 'attack'), 90 + 2.2 * 9);
});

test('crc32 与 Python zlib.crc32 对齐', () => {
  assert.equal(crc32Utf8('曹植#1-1'), 358507899);
  assert.equal(crc32Utf8(''), 0);
});

test('MT19937 与 Python random.Random 逐位一致', () => {
  const r = new PythonRandom(20261106);
  const expected = [0.6487056318546132, 0.0883413190661606, 0.23508019751039444, 0.6175329674012319, 0.3250700787145119];
  assert.deepEqual(expected.map(() => r.random()), expected);
  assert.equal(r.calls, 5);
  // 不同 seed 必须产生不同序列
  assert.notEqual(new PythonRandom(1).random(), new PythonRandom(2).random());
});
