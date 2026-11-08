/**
 * 演示剧本构造器 —— 与 battle-kit/kernel/scenario.py 对齐。
 *
 * 名字、战法名、伤害率、效果术语全部取自包内配置，不编造新数值；
 * 属性与概率来自配置的 E2 槽位。后续换皮只需替换配置里的名录与数值。
 */
import { crc32Utf8 } from './hash.js';
import { heroAttr } from './rules.js';
function pick(seq, key, salt = '') {
    if (seq.length === 0)
        throw new Error(`稳定选样的候选列表为空：${key}`);
    return seq[crc32Utf8(salt + key) % seq.length];
}
/** 伤害率必须来自包内真实样本，不生成新数值 */
function realRate(cfg, key) {
    return pick(cfg.damage_rates_pct, key, 'rate');
}
/** 取包内真实术语名；prefer 用于保证增益/减益语义一致 */
function term(cfg, category, value = 10.0, prefer) {
    let names = cfg.effect_terms.filter((t) => t.category === category).map((t) => t.term);
    if (prefer) {
        const narrowed = names.filter((n) => n.includes(prefer));
        if (narrowed.length > 0)
            names = narrowed;
    }
    const name = names.length > 0 ? pick(names, category + (prefer ?? ''), 'term') : category;
    return {
        name,
        value,
        op: 0,
        evidence: 'E2',
        source: 'term-vocabulary E0 / value E2',
    };
}
function makeEffect(partial) {
    return {
        rate_pct: 0,
        target_type: 'enemy_single',
        attack_type: 'normal',
        available_round: 0,
        condition: '',
        control_state: null,
        control_probability: 0,
        bonus_terms: [],
        evidence: 'E2',
        note: '',
        ...partial,
    };
}
function makeSkill(partial) {
    return {
        level: 1,
        prepare: 0,
        probability_init: 0.35,
        probability_max: 0.35,
        main_detail: 0,
        effects: [],
        ...partial,
    };
}
/** 构建两支阵容；所有可证部分来自 cfg，未解部分显式标 E2 */
export function buildArmies(cfg, perSide = 3, level = 10, troops = 10000) {
    const a = cfg.demo_attributes;
    const units = [];
    const types = ['normal', 'armor', 'chain'];
    for (const side of [1, 2]) {
        for (let i = 0; i < perSide; i += 1) {
            const tag = `S${side}U${i}`;
            const heroName = pick(cfg.hero_names, tag, 'hero');
            const atkType = types[i % types.length];
            const active = makeSkill({
                skill_id: 1000 + side * 10 + i,
                name: pick(cfg.skill_names, tag, 'active'),
                skill_class: '主动',
                level,
                probability_init: cfg.probability_default,
                probability_max: cfg.probability_default,
                evidence: 'E2',
                effects: [
                    makeEffect({
                        detail_id: 2000 + side * 10 + i,
                        effect_type: 'PHYSICAL_DAMAGE',
                        rate_pct: realRate(cfg, tag + 'dmg'),
                        attack_type: atkType,
                        bonus_terms: [term(cfg, '按来源增减伤', 10.0, '提高')],
                        evidence: 'E0',
                        note: 'rate_pct 与术语名为包内 E0 样本',
                    }),
                    makeEffect({
                        detail_id: 3000 + side * 10 + i,
                        effect_type: 'CONTROL',
                        control_state: '犹豫',
                        control_probability: 0.25,
                        evidence: 'E2',
                    }),
                ],
            });
            const command = makeSkill({
                skill_id: 4000 + side * 10 + i,
                name: pick(cfg.skill_names, tag, 'command'),
                skill_class: '指挥',
                level,
                evidence: 'E2',
                effects: [
                    makeEffect({
                        detail_id: 5000 + side * 10 + i,
                        effect_type: 'BUFF',
                        bonus_terms: [term(cfg, '按来源增减伤', 8.0, '提高')],
                        target_type: 'self',
                        evidence: 'E2',
                    }),
                ],
            });
            const passive = makeSkill({
                skill_id: 8000 + side * 10 + i,
                name: pick(cfg.skill_names, tag, 'passive'),
                skill_class: '被动',
                level,
                evidence: 'E2',
                effects: [
                    makeEffect({
                        detail_id: 9000 + side * 10 + i,
                        effect_type: 'BUFF',
                        bonus_terms: [term(cfg, '按来源增减伤', 6.0, '提高')],
                        target_type: 'self',
                        evidence: 'E2',
                    }),
                ],
            });
            const chase = makeSkill({
                skill_id: 6000 + side * 10 + i,
                name: pick(cfg.skill_names, tag, 'chase'),
                skill_class: '追击',
                level,
                probability_init: 0.3,
                probability_max: 0.3,
                evidence: 'E2',
                effects: [
                    makeEffect({
                        detail_id: 7000 + side * 10 + i,
                        effect_type: 'STRATEGY_DAMAGE',
                        rate_pct: realRate(cfg, tag + 'int'),
                        attack_type: atkType,
                        evidence: 'E0',
                    }),
                ],
            });
            const hero = {
                heroid: 100000 + side * 100 + i,
                name: heroName,
                level,
                hero_type: atkType,
                hit_range: 3,
                country: '',
                quality: 5,
                skill_init: active.skill_id,
                attack_base: a.attack_base,
                defence_base: a.defence_base,
                intel_base: a.intel_base,
                speed_base: a.speed_base,
                destroy_base: a.destroy_base,
                attack_grow: a.attack_grow,
                defence_grow: a.defence_grow,
                intel_grow: a.intel_grow,
                speed_grow: a.speed_grow,
                destroy_grow: a.destroy_grow,
                skills: [command, passive, active, chase],
            };
            units.push({
                unit_id: `${heroName}#${side}-${i}`,
                side,
                hero,
                troops,
                max_troops: troops,
                speed: heroAttr(hero, 'speed') + (2 - i) * 3,
            });
        }
    }
    return units;
}
