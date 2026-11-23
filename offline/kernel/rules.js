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
/** E0：base + grow*(level-1) 线性成长 */
export function heroAttr(hero, key) {
    const h = hero;
    return (h[`${key}_base`] ?? 0) + (h[`${key}_grow`] ?? 0) * (hero.level - 1);
}
/** E0：v(lv) = v1 × (1 + (lv-1)/span)，Lv10 恰好为 Lv1 的 2 倍 */
export function levelValue(v1, level, span = 9) {
    if (level <= 1)
        return v1;
    return v1 * (1.0 + (level - 1) / span);
}
/** E0：Op != 0 ? v : v/100 */
export function normalizeBonus(value, op = 0) {
    return op !== 0 ? value : value / 100.0;
}
/** E0：从 0 起逐项 add，全部修正项求和后只乘一次（不是分桶连乘） */
export function sumTermsBonus(terms) {
    let total = 0.0;
    for (const t of terms)
        total += normalizeBonus(t.value, t.op);
    return total;
}
/** ★ P47#8：所有加成项求和后，最终乘区上限 2×。
 *  十级同名战法可重复叠加（被动每回合刷新）时旧口径能到 6.75×，
 *  与 FIELD-CONTRACT 的平衡上限冲突。这里在唯一出口钳住，黄金向量最大 1.48× 不受影响。 */
export const MAX_DAMAGE_BONUS_MULTIPLIER = 2.0;
/** ★ P49：bonus 词条语义分类——旧口径「一锅端 sumTermsBonus」把减伤词条也
 *  当攻击加成，方向反了（审计 3.2/3.6/3.14 共 18 项）。
 *  damage_reduce        ：受到…伤害降低 / 伤害降低 → 挂承受者，按减伤结算。
 *  damage_taken_increase：受到…伤害提高 → 挂承受者，按易伤（受伤放大）结算。
 *  attack_bonus         ：其余词条维持旧口径，计入攻击方加成链。 */
export function classifyTerm(name) {
    const n = String(name || '');
    /* 只认「受到…」前缀：承受者受伤修正。不带前缀的「攻击伤害降低」等是
       攻方输出减益，维持旧口径（DEBUFF 负加成挂敌军，方向本来就对）。 */
    if (/受到.+伤害降低/.test(n))
        return 'damage_reduce';
    if (/受到.+伤害提高/.test(n))
        return 'damage_taken_increase';
    return 'attack_bonus';
}
/** ★ P49：率土式属性差乘区。修正 = clamp(1 + (攻方属性 − 守方抗性)/span, min, max)。
 *  物理攻 vs 守方防（defence），策略攻 vs 守方智（intel）；五维百分制下 span=100
 *  即满差 → ×2，对标率土 /300 满差口径。用户裁决：武将属性在战斗中的权重应更大。 */
export function attrDeltaFactor(cfg, effectType, attacker, defender) {
    const d = cfg.attr_delta ?? { span: 100, min: 0.5, max: 2.0 };
    const atkAttr = attributeFor(effectType, attacker.hero).value;
    const defKey = effectType === 'STRATEGY_DAMAGE' ? 'intel' : 'defence';
    const defAttr = heroAttr(defender.hero, defKey);
    const raw = 1.0 + (atkAttr - defAttr) / (d.span > 0 ? d.span : 100);
    const factor = Math.min(d.max, Math.max(d.min, raw));
    return {
        factor,
        atk_attr: atkAttr,
        def_attr: defAttr,
        note: `attr_delta: (atk ${atkAttr.toFixed(1)} − def_${defKey} ${defAttr.toFixed(1)})/` + d.span
            + ` → ×${factor.toFixed(3)} (clamp ${d.min}~${d.max})`,
    };
}
/** E0：三档相克系数，越界或档位缺失退化 1.0 */
export function counterFactor(cfg, attackType, weakness) {
    const order = ['normal', 'armor', 'chain'];
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
export function skillProbability(skill) {
    if (skill.level <= 1)
        return skill.probability_init;
    const t = Math.min(1.0, (skill.level - 1) / 9.0);
    return skill.probability_init + (skill.probability_max - skill.probability_init) * t;
}
/** E0 属性映射提示：谋略→智力和策略杀伤，其余→攻击力 */
export function attributeFor(effectType, hero) {
    if (effectType === 'STRATEGY_DAMAGE') {
        return { value: heroAttr(hero, 'intel'), note: 'intel_base+intel_grow (E0 field, E2 linear)' };
    }
    return { value: heroAttr(hero, 'attack'), note: 'attack_base+attack_grow (E0 field, E2 linear)' };
}
/** E2 占位实现：base = 属性 × 等级缩放后的伤害率 × 兵力系数。
 *  所有因子都可经配置替换；减伤用减法而非除法。 */
export function baseDamage(cfg, effect, attacker, defender) {
    // M4-7 回击：rate_pct 已是最终伤害率（按战法等级注入），不随武将等级二次成长。
    const rate = (effect.flat_rate ? effect.rate_pct : levelValue(effect.rate_pct, attacker.hero.level)) / 100.0;
    const { value: attr, note: attrNote } = attributeFor(effect.effect_type, attacker.hero);
    const defense = heroAttr(defender.hero, 'defence');
    // legacy 为参考实现原样（E2 占位，方向反了）；corrected 为后续微调推荐值。
    const mitigation = cfg.defense_model === 'corrected'
        ? defense / (defense + 200.0)
        : Math.max(0.0, 1.0 - defense / (defense + 200.0));
    const value0 = attr * rate * cfg.troop_factor * (1.0 - 0.5 * mitigation);
    /* ★ P49：武将属性差乘区（率土式），让统武智防真正参与伤害强弱 */
    const ad = attrDeltaFactor(cfg, effect.effect_type, attacker, defender);
    const value = Math.max(0.0, value0 * ad.factor);
    return {
        value,
        rate_pct_at_level: rate * 100.0,
        attribute: attr,
        attribute_note: attrNote,
        attr_delta_factor: ad.factor,
        attr_delta_note: ad.note,
        evidence: 'E2',
        note: 'BaseDamage 解析式包内不可知；见 cfg.unresolved',
    };
}
/** E0：严格按 IL 指令顺序求值，返回带中间量的可审计结果 */
export function calcDamage(baseDamageValue, counter, bonusTotal, minDamage) {
    const base = Number(baseDamageValue);
    const afterCounter = base * Number(counter);
    const onePlusBonus = Math.min(MAX_DAMAGE_BONUS_MULTIPLIER, 1.0 + Number(bonusTotal));
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
export const SKILL_PHASE_ORDER = {
    指挥: 0,
    被动: 1,
    主动: 2,
    追击: 3,
};
/** E0：speed 降序；同速按 unit_id 升序稳定排序保证确定性 */
export function actionOrder(units) {
    return units
        .filter((u) => u.alive)
        .slice()
        .sort((a, b) => {
        if (b.speed !== a.speed)
            return b.speed - a.speed;
        return a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0;
    });
}
export function hasControl(unit, state) {
    return unit.states.includes(state);
}
/** E0 术语：犹豫阻止主动战法；怯战阻止普通攻击 */
export function controlBlocks(unit, skill) {
    if (hasControl(unit, '犹豫') && skill.skill_class === '主动')
        return '犹豫';
    return null;
}
/** 被动战法按分类语义无条件生效（不消耗随机数）；其余三类走概率判定 */
export function rollTrigger(skill, rng) {
    if (skill.skill_class === '被动')
        return { fired: true, probability: 1.0 };
    const p = Math.min(1.0, Math.max(0.0, skillProbability(skill)));
    return { fired: rng.random() < p, probability: p };
}
/** E0 字段 available_round：0 表示不限 */
export function effectAvailable(effect, round) {
    if (effect.available_round && round > effect.available_round)
        return false;
    return true;
}
