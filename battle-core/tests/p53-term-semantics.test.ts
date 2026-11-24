import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_NEGATIVE_STATES,
  ATTACK_BLOCK_STATES,
  SKILL_BLOCK_STATES,
  attrBonusKey,
  baseDamage,
  classifyTerm,
  controlBlocks,
  rollTrigger,
  DEFAULT_BATTLE_CONFIG,
} from '../src/index.js';
import type { ControlState, Effect, Skill, UnitState } from '../src/index.js';

const cfg = DEFAULT_BATTLE_CONFIG;

function mkHero(partial: Record<string, number> = {}) {
  return {
    heroid: 1, name: '测试', level: 1, hero_type: 'normal' as const,
    attack_base: 100, defence_base: 50, intel_base: 90, speed_base: 80, destroy_base: 70,
    attack_grow: 2, defence_grow: 1.5, intel_grow: 2, speed_grow: 1, destroy_grow: 1,
    skills: [], ...partial,
  };
}

function mkUnit(id: string, states: ControlState[] = []): UnitState {
  return {
    unit_id: id, side: 1, hero: mkHero() as UnitState['hero'],
    troops: 1000, max_troops: 1000, speed: 80,
    pos: 0, attack_range: 9,
    states, buffs: [], reactions: [], alive: true,
  };
}

const effect = (partial: Partial<Effect> = {}): Effect => ({
  detail_id: 1, effect_type: 'PHYSICAL_DAMAGE', rate_pct: 100,
  target_type: 'enemy_single', attack_type: 'normal', available_round: 0,
  control_state: null, control_probability: 0, bonus_terms: [], ...partial,
});

const skill = (partial: Partial<Skill> = {}): Skill => ({
  skill_id: 1, name: '测试战法', skill_class: '主动', level: 1,
  probability_init: 0.5, probability_max: 0.5, prepare: 0, effects: [], ...partial,
});

const fixedRng = (value: number) => ({ calls: 0, random: () => value });

test('P53-① 九种负面状态全部纳入行动受阻与净化集合', () => {
  assert.equal(ALL_NEGATIVE_STATES.size, 9);
  for (const st of ['犹豫', '混乱', '暴走', '怯战', '动摇', '恐慌', '挑衅', '妖术', '燃烧']) {
    assert.ok(ALL_NEGATIVE_STATES.has(st), `${st} 应在负面状态集合`);
  }
  assert.equal(SKILL_BLOCK_STATES.length, 8, '除怯战外均阻断主动战法');
  assert.deepEqual([...ATTACK_BLOCK_STATES], ['怯战', '暴走']);
  const active = skill();
  assert.equal(controlBlocks(mkUnit('u', ['动摇']), active), '动摇');
  assert.equal(controlBlocks(mkUnit('u', ['妖术']), active), '妖术');
  assert.equal(controlBlocks(mkUnit('u', ['怯战']), active), null, '怯战只阻普攻，不阻主动');
  assert.equal(controlBlocks(mkUnit('u', ['动摇']), skill({ skill_class: '被动' })), null);
});

test('P53-② classifyTerm 分桶：净化/属性/发动率/条件易伤各自归位', () => {
  assert.equal(classifyTerm('镇静'), 'purge');
  assert.equal(classifyTerm('净化'), 'purge');
  assert.equal(classifyTerm('攻击属性提高'), 'attr_bonus');
  assert.equal(classifyTerm('谋略属性提高'), 'attr_bonus');
  assert.equal(classifyTerm('发动率提高'), 'probability_bonus');
  assert.equal(classifyTerm('处于怯战状态受伤害提高'), 'damage_taken_increase');
  assert.equal(classifyTerm('受到伤害降低'), 'damage_reduce');
  assert.equal(classifyTerm('普通攻击伤害提高'), 'attack_bonus', '通用输出加成维持旧口径');
  assert.equal(attrBonusKey('攻击属性提高'), 'attack');
  assert.equal(attrBonusKey('谋略属性提高'), 'intel');
  assert.equal(attrBonusKey('防御属性提高'), 'defence');
  assert.equal(attrBonusKey('速度属性提高'), null, '速度不参与伤害解析');
});

test('P53-③ 属性提高落在属性上，不再当伤害加成', () => {
  const plain = mkUnit('a');
  const boosted = mkUnit('a');
  boosted.reactions.push({
    kind: 'attr_bonus', skill_id: 1, skill_name: '虎踞锋芒',
    rounds: 0, value: 0.2, term_name: '攻击属性提高',
  });
  const e = effect({ rate_pct: 100 });
  const d = mkUnit('d');
  const before = baseDamage(cfg, e, plain, d);
  const after = baseDamage(cfg, e, boosted, d);
  assert.ok(after.value > before.value, '攻击属性提高应抬伤害');
  assert.equal(before.attribute, 100);
  assert.equal(after.attribute, 120, '20% 属性提高 → 属性 120');
  /* 策略伤害不吃攻击属性词条 */
  const se = effect({ effect_type: 'STRATEGY_DAMAGE', rate_pct: 100 });
  const sb = baseDamage(cfg, se, plain, d);
  const sa = baseDamage(cfg, se, boosted, d);
  assert.equal(sa.attribute, sb.attribute, '攻击属性词条不影响策略伤害');
});

test('P53-④ 发动率提高只影响触发，不混进伤害加成', () => {
  const s = skill({ probability_init: 0.3, probability_max: 0.3 });
  const plain = rollTrigger(s, fixedRng(0.4));
  const boosted = rollTrigger(s, fixedRng(0.4), 0.2);
  assert.equal(plain.fired, false);
  assert.equal(boosted.fired, true, '30%+20%=50% > 40%');
  assert.equal(boosted.probability, 0.5);
  const passive = skill({ skill_class: '被动', probability_init: 0.3 });
  assert.equal(rollTrigger(passive, fixedRng(0.99), 0).fired, true, '被动仍必发');
});

test('P53-⑤ 回合末清除统一覆盖九种状态（黄金向量未受影响）', () => {
  /* 场景无控制状态，改动前后事件流一致；这里只验证集合定义不漏项。 */
  assert.ok(SKILL_BLOCK_STATES.includes('燃烧'));
  assert.ok(ATTACK_BLOCK_STATES.includes('怯战'));
  assert.ok(ALL_NEGATIVE_STATES.has('挑衅'));
});
