/**
 * 战斗内核数据模型 —— 与 battle-kit/kernel/model.py 对齐的 TypeScript 版。
 *
 * 约束：src/ 下所有模块零运行时依赖，不得 import Node 内置模块、DOM 或
 * 任何游戏引擎 API（cc / Unity / Godot），保证同一份代码可运行在
 * Node（测试）、浏览器与 Cocos Creator（游戏）中。
 */
export type Evidence = 'E0' | 'E1' | 'E2' | 'E3';
/** 四类战法，直接用包内分类词（后续换皮时统一改名） */
export type SkillClass = '指挥' | '主动' | '被动' | '追击';
export type EffectType = 'PHYSICAL_DAMAGE' | 'STRATEGY_DAMAGE' | 'HEAL' | 'CONTROL' | 'BUFF' | 'DEBUFF';
/** 兵种 / 攻击类型，对应 GetCounterFactor 的三档 */
export type AttackType = 'normal' | 'armor' | 'chain';
export type ControlState = '犹豫' | '混乱' | '暴走' | '怯战';
export type TargetType = 'self' | 'ally_single' | 'ally_all' | 'enemy_single' | 'enemy_all';
export type Phase = 'battle_start' | 'round_start' | 'prepare_ready' | 'action' | 'after_attack' | 'round_end';
/** 加减伤修正项。op=0 => 按百分数登记需 /100；op!=0 => 原值 */
export interface BonusTerm {
    name: string;
    value: number;
    op: number;
    evidence?: Evidence;
    source?: string;
}
export interface Effect {
    detail_id: number;
    effect_type: EffectType;
    /** 伤害率 / 恢复率（百分数） */
    rate_pct: number;
    target_type: TargetType;
    attack_type: AttackType;
    /** 0 = 不限 */
    available_round: number;
    condition?: string;
    control_state?: ControlState | null;
    control_probability: number;
    bonus_terms: BonusTerm[];
    evidence?: Evidence;
    note?: string;
}
export interface Skill {
    skill_id: number;
    name: string;
    skill_class: SkillClass;
    skill_quality?: number;
    level: number;
    /** 准备回合数 */
    prepare: number;
    probability_init: number;
    probability_max: number;
    main_detail?: number;
    effects: Effect[];
    evidence?: Evidence;
}
/** 武将：base + grow 双列线性成长 */
export interface Hero {
    heroid: number;
    name: string;
    level: number;
    hero_type: AttackType;
    hit_range?: number;
    country?: string;
    quality?: number;
    skill_init?: number;
    attack_base: number;
    defence_base: number;
    intel_base: number;
    speed_base: number;
    destroy_base: number;
    attack_grow: number;
    defence_grow: number;
    intel_grow: number;
    speed_grow: number;
    destroy_grow: number;
    skills: Skill[];
}
export interface UnitInput {
    unit_id: string;
    side: number;
    hero: Hero;
    troops: number;
    max_troops: number;
    speed?: number;
}
/** 引擎内部状态（深拷贝自 UnitInput，调用方对象不会被修改） */
export interface UnitState {
    unit_id: string;
    side: number;
    hero: Hero;
    troops: number;
    max_troops: number;
    speed: number;
    states: ControlState[];
    buffs: BonusTerm[];
    alive: boolean;
}
export interface BattleEvent {
    round: number;
    phase: Phase;
    actor: string;
    kind: string;
    payload: Record<string, unknown>;
    evidence: string;
}
/** 伤害结算中间量，字段名与 Python calc_damage 对齐以便逐项比对 */
export interface CalcDamageResult {
    base: number;
    counter: number;
    bonus_total: number;
    after_counter: number;
    one_plus_bonus: number;
    raw: number;
    floored: number;
    min_damage: number;
    final: number;
    evidence: string;
    il: string;
}
export interface BattleResult {
    seed: number;
    config_fingerprint: string;
    winner: number | null;
    rounds: number;
    events: BattleEvent[];
    survivors: Record<string, string[]>;
    warnings: string[];
    /** 移植版附加：便于稳定性验证与对账 */
    final_troops: Record<string, number>;
    total_troops_by_side: Record<string, number>;
    rng_calls: number;
    event_fingerprint: string;
}
export interface BattleOptions {
    units: UnitInput[];
    seed: number;
    config: BattleConfig;
    roundLimit?: number;
}
/** 直接对应 battle-kit/kernel/config/battle_config.json */
export interface BattleConfig {
    damage_rates_pct: number[];
    level_pairs: Array<{
        lv1: number;
        lv10: number;
        ratio: number;
        exactly_double: boolean;
    }>;
    effect_terms: Array<{
        term: string;
        category: string;
    }>;
    hero_names: string[];
    skill_names: string[];
    tcfg_schemas: Record<string, string[]>;
    il_methods: string[];
    min_damage: number;
    round_limit: number;
    counter_tiers: Record<string, number>;
    base_damage_policy: string;
    troop_factor: number;
    probability_default: number;
    demo_attributes: Record<string, number>;
    provenance: Record<string, unknown>;
    unresolved: string[];
    /**
     * 减伤模型开关（移植版新增，缺省 = legacy）。
     * legacy    : 与 battle-kit 参考实现逐位一致（其 E2 占位式方向反了，防御越高伤害越高）。
     * corrected : 减伤随防御单调增加，符合直觉；后续数值微调时建议切换。
     */
    defense_model?: 'legacy' | 'corrected';
}
