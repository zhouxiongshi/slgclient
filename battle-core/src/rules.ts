/**
 * 规则层：逐条对应 battle-kit/kernel/rules.py。
 *
 * 全部为纯函数，不读 UI / 网络 / 渲染，也不修改入参。
 * 伤害结算尾段保持原语义：
 *   raw   = (float)base × counter × (1 + ΣBonus)
 *   final = Max(int(Floor(raw)), mMinDamage)
 * 这条结构本身就避免了原 slg 服务端 AbsInt(force-defense) 的
 * 「防御越高反而秒杀」缺陷。
 */

import type {
  AttackType,
  BattleConfig,
  BonusTerm,
  CalcDamageResult,
  ControlState,
  Effect,
  EffectType,
  Hero,
  Skill,
  SkillClass,
  UnitState,
} from './types.js';
import type { Rng } from './rng.js';

export type AttrKey = 'attack' | 'defence' | 'intel' | 'speed' | 'destroy';

/** E0：base + grow*(level-1) 线性成长 */
export function heroAttr(hero: Hero, key: AttrKey): number {
  const h = hero as unknown as Record<string, number>;
  return (h[`${key}_base`] ?? 0) + (h[`${key}_grow`] ?? 0) * (hero.level - 1);
}

/** E0：v(lv) = v1 × (1 + (lv-1)/span)，Lv10 恰好为 Lv1 的 2 倍 */
export function levelValue(v1: number, level: number, span = 9): number {
  if (level <= 1) return v1;
  return v1 * (1.0 + (level - 1) / span);
}

/** E0：Op != 0 ? v : v/100 */
export function normalizeBonus(value: number, op = 0): number {
  return op !== 0 ? value : value / 100.0;
}

/** E0：从 0 起逐项 add，全部修正项求和后只乘一次（不是分桶连乘） */
export function sumTermsBonus(terms: readonly BonusTerm[]): number {
  let total = 0.0;
  for (const t of terms) total += normalizeBonus(t.value, t.op);
  return total;
}

/** E0：三档相克系数，越界或档位缺失退化 1.0 */
export function counterFactor(
  cfg: BattleConfig,
  attackType: AttackType | string,
  weakness: number,
): { factor: number; note: string } {
  const order = ['normal', 'armor', 'chain'] as const;
  const key = String(attackType);
  const idx = weakness - 1;
  if (idx < 0 || idx >= order.length || !(key in cfg.counter_tiers)) {
    return { factor: 1.0, note: 'out_of_range_or_missing -> 1.0 (E0 fallback)' };
  }
  const tier = cfg.counter_tiers[order[idx]];
  if (tier === undefined || !Number.isFinite(tier)) {
    return { factor: 1.0, note: 'out_of_range_or_missing -> 1.0 (E0 fallback)' };
  }
  return { factor: tier, note: `${key}/${order[idx]} (coefficient E2)` };
}

/** 战法发动概率：E0 字段名 probability_init/max，线性插值属 E2 */
export function skillProbability(skill: Skill): number {
  if (skill.level <= 1) return skill.probability_init;
  const t = Math.min(1.0, (skill.level - 1) / 9.0);
  return skill.probability_init + (skill.probability_max - skill.probability_init) * t;
}

/** E0 属性映射提示：谋略→智力和策略杀伤，其余→攻击力 */
export function attributeFor(effectType: EffectType, hero: Hero): { value: number; note: string } {
  if (effectType === 'STRATEGY_DAMAGE') {
    return { value: heroAttr(hero, 'intel'), note: 'intel_base+intel_grow (E0 field, E2 linear)' };
  }
  return { value: heroAttr(hero, 'attack'), note: 'attack_base+attack_grow (E0 field, E2 linear)' };
}

export interface BaseDamageResult {
  value: number;
  rate_pct_at_level: number;
  attribute: number;
  attribute_note: string;
  evidence: string;
  note: string;
}

/** E2 占位实现：base = 属性 × 等级缩放后的伤害率 × 兵力系数。
 *  所有因子都可经配置替换；减伤用减法而非除法。 */
export function baseDamage(
  cfg: BattleConfig,
  effect: Effect,
  attacker: UnitState,
  defender: UnitState,
): BaseDamageResult {
  const rate = levelValue(effect.rate_pct, attacker.hero.level) / 100.0;
  const { value: attr, note: attrNote } = attributeFor(effect.effect_type, attacker.hero);
  const defense = heroAttr(defender.hero, 'defence');
  // legacy 为参考实现原样（E2 占位，方向反了）；corrected 为后续微调推荐值。
  const mitigation = cfg.defense_model === 'corrected'
    ? defense / (defense + 200.0)
    : Math.max(0.0, 1.0 - defense / (defense + 200.0));
  const value = attr * rate * cfg.troop_factor * (1.0 - 0.5 * mitigation);
  return {
    value: Math.max(0.0, value),
    rate_pct_at_level: rate * 100.0,
    attribute: attr,
    attribute_note: attrNote,
    evidence: 'E2',
    note: 'BaseDamage 解析式包内不可知；见 cfg.unresolved',
  };
}

/** E0：严格按 IL 指令顺序求值，返回带中间量的可审计结果 */
export function calcDamage(
  baseDamageValue: number,
  counter: number,
  bonusTotal: number,
  minDamage: number,
): CalcDamageResult {
  const base = Number(baseDamageValue);
  const afterCounter = base * Number(counter);
  const onePlusBonus = 1.0 + Number(bonusTotal);
  const raw = afterCounter * onePlusBonus;
  const floored = Math.floor(raw);
  const final = Math.max(floored, Math.trunc(minDamage));
  return {
    base,
    counter: Number(counter),
    bonus_total: Number(bonusTotal),
    after_counter: afterCounter,
    one_plus_bonus: onePlusBonus,
    raw,
    floored,
    min_damage: Math.trunc(minDamage),
    final,
    evidence: 'E0',
    il: 'Game.Map.dll::CalcDamageByTerms',
  };
}

export const SKILL_PHASE_ORDER: Record<SkillClass, number> = {
  指挥: 0,
  被动: 1,
  主动: 2,
  追击: 3,
};

/** E0：speed 降序；同速按 unit_id 升序稳定排序保证确定性 */
export function actionOrder(units: readonly UnitState[]): UnitState[] {
  return units
    .filter((u) => u.alive)
    .slice()
    .sort((a, b) => {
      if (b.speed !== a.speed) return b.speed - a.speed;
      return a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0;
    });
}

export function hasControl(unit: UnitState, state: ControlState): boolean {
  return unit.states.includes(state);
}

/** E0 术语：犹豫阻止主动战法；怯战阻止普通攻击 */
export function controlBlocks(unit: UnitState, skill: Skill): ControlState | null {
  if (hasControl(unit, '犹豫') && skill.skill_class === '主动') return '犹豫';
  return null;
}

/** 被动战法按分类语义无条件生效（不消耗随机数）；其余三类走概率判定 */
export function rollTrigger(skill: Skill, rng: Rng): { fired: boolean; probability: number } {
  if (skill.skill_class === '被动') return { fired: true, probability: 1.0 };
  const p = Math.min(1.0, Math.max(0.0, skillProbability(skill)));
  return { fired: rng.random() < p, probability: p };
}

/** E0 字段 available_round：0 表示不限 */
export function effectAvailable(effect: Effect, round: number): boolean {
  if (effect.available_round && round > effect.available_round) return false;
  return true;
}
