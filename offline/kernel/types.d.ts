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
export type TargetType = 'self' | 'ally_single' | 'ally_all' | 'enemy_single' | 'enemy_all'
/** M4-7 主角战法：自身 + 一名友军（按阵列顺序取第一个非自身存活友军） */
 | 'self_and_ally_single';
export type Phase = 'battle_start' | 'round_start' | 'prepare_ready' | 'action' | 'after_attack' | 'round_end';
/** 加减伤修正项。op=0 => 按百分数登记需 /100；op!=0 => 原值 */
export interface BonusTerm {
    name: string;
    value: number;
    op: number;
    evidence?: Evidence;
    source?: string;
}
/**
 * M4-7 指挥/被动类扩展机制（可选）。
 * 旧战法不携带该字段，事件流与黄金向量逐字节不变；数值一律由游戏层
 * kernelSkillAt 从 ui.levels[lv-1].effect_value 注入，保证描述=计算同源。
 */
export interface EffectMechanics {
    /** 洞察：免疫控制状态的施加，N 个回合后失效（回合末递减） */
    insight_rounds?: number;
    /** 回击：自身受到伤害时按 chance 概率对攻击者造成一次伤害 */
    counter?: {
        /** 0~1，当前战法等级对应的回击概率 */
        chance: number;
        /** 伤害率（百分数），固定值，不随武将等级二次成长 */
        rate_pct: number;
        damage_type: 'PHYSICAL_DAMAGE' | 'STRATEGY_DAMAGE';
    };
    /** 自身受到伤害降低比例（0~1） */
    damage_taken_reduce?: number;
}
export interface Effect {
    detail_id: number;
    effect_type: EffectType;
    /** 伤害率 / 恢复率（百分数） */
    rate_pct: number;
    /** true = rate_pct 为最终伤害率，不再按武将等级做 levelValue 缩放（回击用） */
    flat_rate?: boolean;
    /** 指挥/被动扩展机制；由 BUFF 槽在 battle_start 授予 */
    mechanics?: EffectMechanics;
    target_type: TargetType;
    attack_type: AttackType;
    /** 0 = 不限 */
    available_round: number;
    /**
     * 战法有效距离（战位口径）。缺省 = 9（无远弗届，旧战法与旧战报行为不变）。
     * 战位距离：同阵营 |pos 差|；跨阵营 pos 相加 + 1（前锋→前锋 1，大营→大营 5）。
     */
    range?: number;
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
    /**
     * 战位：0 = 前锋，1 = 中军，2 = 大营（clamp 0~4）。
     * 缺省从 unit_id 末位数字推导（如 a0/d2），推不出则 0 —— 保证旧战报可复现。
     */
    pos?: number;
    /**
     * 普攻攻击距离（战位口径，1~9）。缺省 = 9 即不受限（旧用例行为不变）。
     * 给了 1~5 才生效：距离不足者本回合无法普攻，只能靠战法输出。
     */
    attack_range?: number;
}
/** 由 BUFF 槽授予的常驻反应：洞察 / 回击 / 减伤。rounds=0 表示整场有效。 */
export interface Reaction {
    kind: 'insight' | 'counter' | 'damage_reduce';
    skill_id: number;
    skill_name: string;
    /** 剩余回合；0 = 整场战斗有效 */
    rounds: number;
    /** counter = 回击概率；damage_reduce = 减伤比例 */
    value: number;
    /** counter 专用 */
    rate_pct?: number;
    damage_type?: 'PHYSICAL_DAMAGE' | 'STRATEGY_DAMAGE';
}
/** 引擎内部状态（深拷贝自 UnitInput，调用方对象不会被修改） */
export interface UnitState {
    unit_id: string;
    side: number;
    hero: Hero;
    troops: number;
    max_troops: number;
    speed: number;
    /** 战位 0/1/2（见 UnitInput.pos） */
    pos: number;
    /** 普攻攻击距离，缺省 9 */
    attack_range: number;
    states: ControlState[];
    buffs: BonusTerm[];
    /** M4-7：洞察 / 回击 / 减伤，旧战法恒为空数组 */
    reactions: Reaction[];
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
