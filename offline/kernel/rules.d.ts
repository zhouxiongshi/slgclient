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
import type { AttackType, BattleConfig, BonusTerm, CalcDamageResult, ControlState, Effect, EffectType, Hero, Skill, SkillClass, UnitState } from './types.js';
import type { Rng } from './rng.js';
export type AttrKey = 'attack' | 'defence' | 'intel' | 'speed' | 'destroy';
/** E0：base + grow*(level-1) 线性成长 */
export declare function heroAttr(hero: Hero, key: AttrKey): number;
/** E0：v(lv) = v1 × (1 + (lv-1)/span)，Lv10 恰好为 Lv1 的 2 倍 */
export declare function levelValue(v1: number, level: number, span?: number): number;
/** E0：Op != 0 ? v : v/100 */
export declare function normalizeBonus(value: number, op?: number): number;
/** E0：从 0 起逐项 add，全部修正项求和后只乘一次（不是分桶连乘） */
export declare function sumTermsBonus(terms: readonly BonusTerm[]): number;
/** E0：三档相克系数，越界或档位缺失退化 1.0 */
export declare function counterFactor(cfg: BattleConfig, attackType: AttackType | string, weakness: number): {
    factor: number;
    note: string;
};
/** 战法发动概率：E0 字段名 probability_init/max，线性插值属 E2 */
export declare function skillProbability(skill: Skill): number;
/** E0 属性映射提示：谋略→智力和策略杀伤，其余→攻击力 */
export declare function attributeFor(effectType: EffectType, hero: Hero): {
    value: number;
    note: string;
};
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
export declare function baseDamage(cfg: BattleConfig, effect: Effect, attacker: UnitState, defender: UnitState): BaseDamageResult;
/** E0：严格按 IL 指令顺序求值，返回带中间量的可审计结果 */
export declare function calcDamage(baseDamageValue: number, counter: number, bonusTotal: number, minDamage: number): CalcDamageResult;
export declare const SKILL_PHASE_ORDER: Record<SkillClass, number>;
/** E0：speed 降序；同速按 unit_id 升序稳定排序保证确定性 */
export declare function actionOrder(units: readonly UnitState[]): UnitState[];
export declare function hasControl(unit: UnitState, state: ControlState): boolean;
/** E0 术语：犹豫阻止主动战法；怯战阻止普通攻击 */
export declare function controlBlocks(unit: UnitState, skill: Skill): ControlState | null;
/** 被动战法按分类语义无条件生效（不消耗随机数）；其余三类走概率判定 */
export declare function rollTrigger(skill: Skill, rng: Rng): {
    fired: boolean;
    probability: number;
};
/** E0 字段 available_round：0 表示不限 */
export declare function effectAvailable(effect: Effect, round: number): boolean;
