/**
 * 确定性战斗引擎 —— 与 battle-kit/kernel/engine.py 逐流程对齐的 TS 移植。
 *
 * 设计约束：
 *  - 数值不硬编码，全部经 BattleConfig 注入；
 *  - 规则层不读 UI / 网络 / 渲染；
 *  - 同输入 + 同配置 + 同 seed → 同事件流（可回放）；
 *  - 每次结算产出可审计事件，携带证据等级；
 *  - 输入深拷贝，调用方对象不被修改。
 *
 * 移植版额外补充（不改变战斗语义）：兵力对账字段、指纹、rng 调用计数、
 * 配置校验与非法数值防护。
 */
import { configFingerprint, structuredCloneSafe, validateConfig } from './config.js';
import { crc32Utf8, hash16, stableStringify } from './hash.js';
import { PythonRandom } from './rng.js';
import { actionOrder, attributeFor, baseDamage, calcDamage, controlBlocks, counterFactor, effectAvailable, hasControl, heroAttr, levelValue, rollTrigger, SKILL_PHASE_ORDER, sumTermsBonus, } from './rules.js';
function cloneUnits(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
        throw new Error('战斗单位列表为空');
    }
    const seen = new Set();
    return inputs.map((raw) => {
        const u = structuredCloneSafe(raw);
        if (seen.has(u.unit_id))
            throw new Error(`unit_id 重复：${u.unit_id}`);
        seen.add(u.unit_id);
        if (!(u.troops > 0) || !(u.max_troops > 0)) {
            throw new Error(`${u.unit_id} 兵力必须为正数`);
        }
        if (u.troops > u.max_troops)
            throw new Error(`${u.unit_id} 当前兵力超过上限`);
        let speed = u.speed ?? 0;
        if (!(speed > 0))
            speed = heroAttr(u.hero, 'speed') || 100.0;
        // 战位：显式给值优先；否则从 unit_id 末位推导（a0/d2），推不出当 0。
        // 旧战报无 pos 字段时靠这条回落，保证历史用例逐字节可复现。
        const derivedPos = Math.max(0, Number(String(u.unit_id).slice(1)) || 0);
        const pos = Number.isFinite(u.pos) ? Math.max(0, Math.min(4, Math.trunc(u.pos))) : derivedPos;
        // 普攻攻击距离：缺省 9 = 不受限，旧用例行为不变。
        const attack_range = Number.isFinite(u.attack_range)
            ? Math.max(1, Math.min(9, Math.trunc(u.attack_range)))
            : 9;
        return {
            unit_id: u.unit_id,
            side: u.side,
            hero: u.hero,
            troops: u.troops,
            max_troops: u.max_troops,
            speed,
            pos,
            attack_range,
            states: [],
            buffs: [],
            reactions: [],
            alive: true,
        };
    });
}
function pythonRound2(x) {
    // 仅用于战报展示字段，不参与结算
    return Math.round((x + Number.EPSILON) * 100) / 100;
}
export class BattleEngine {
    constructor(options) {
        this.units = [];
        this.events = [];
        this.prepare = [];
        this.round = 0;
        // 配置在构造时快照，外部之后修改配置不会影响本场战斗的可复现性
        this.cfg = structuredCloneSafe(options.config);
        validateConfig(this.cfg);
        this.seed = Math.trunc(options.seed) || 0;
        this.roundLimit = options.roundLimit ?? this.cfg.round_limit;
        if (!(this.roundLimit > 0))
            throw new Error('roundLimit 必须 > 0');
        this.config_fingerprint = configFingerprint(this.cfg);
        this.rng = new PythonRandom(this.seed);
    }
    emit(phase, actor, kind, payload, evidence = '') {
        this.events.push({ round: this.round, phase, actor, kind, payload, evidence });
    }
    enemies(side) {
        return this.units.filter((u) => u.side !== side && u.alive);
    }
    /** 敌我战位距离：跨阵营 pos 相加 +1（前锋→前锋 1，大营→大营 5）；同阵营取 |pos 差|。 */
    slotDist(a, b) {
        if (a.side === b.side)
            return Math.abs((a.pos || 0) - (b.pos || 0));
        return (a.pos || 0) + (b.pos || 0) + 1;
    }
    /**
     * 普攻/追击目标：战位距离最近、且在攻击距离内的存活敌军。
     * 超出 attack_range 返回 null —— 大营里的短手武将打不出普攻，站位与配将才有取舍。
     *
     * 同距并列时的取值口径（必须与 Python 参考实现一致，否则黄金向量会漂）：
     *  - 'id'    ：普攻取 unit_id 字典序最小者（确定性、与旧实现一致）；
     *  - 'order' ：追击取敌方阵列首位（= 旧实现 effectTargets 的 enemies.slice(0,1)）。
     */
    nearestFoe(unit, maxDist, tie = 'id') {
        const limit = Number.isFinite(maxDist) ? maxDist : unit.attack_range ?? 9;
        const foes = this.enemies(unit.side).filter((u) => this.slotDist(unit, u) <= limit);
        if (!foes.length)
            return null;
        if (tie === 'order') {
            // 稳定排序：仅按距离，不改变同距者的原始阵列表序
            const sorted = foes.slice().sort((a, b) => this.slotDist(unit, a) - this.slotDist(unit, b));
            return sorted[0];
        }
        return foes
            .slice()
            .sort((a, b) => this.slotDist(unit, a) - this.slotDist(unit, b) || (a.unit_id < b.unit_id ? -1 : 1))[0];
    }
    effectTargets(effect, unit) {
        const enemies = this.units.filter((u) => u.side !== unit.side && u.alive);
        const allies = this.units.filter((u) => u.side === unit.side && u.alive);
        const tt = effect.target_type;
        // 射程：effect.range 缺省 9 = 无远弗届（旧战法数据兼容）。先按射程过滤，再截取前 N 个。
        const range = Number.isFinite(effect.range) ? effect.range : 9;
        const inRange = (u) => this.slotDist(unit, u) <= range;
        const pickN = (list, n) => (n ? list.slice(0, n) : list);
        if (tt === 'self')
            return unit.alive ? [unit] : [];
        // M4-7 主角战法：自身 + 一名友军。友军按阵列顺序取第一个非自身存活者，确定性。
        if (tt === 'self_and_ally_single') {
            if (!unit.alive)
                return [];
            const other = allies.find((u) => u !== unit && u.alive && inRange(u));
            return other ? [unit, other] : [unit];
        }
        if (tt.startsWith('ally')) {
            const pool = allies.filter(inRange);
            if (tt.endsWith('single') || tt.endsWith('_one'))
                return pool.slice(0, 1);
            if (tt.endsWith('_12'))
                return pickN(pool, 2);
            if (tt.endsWith('_13'))
                return pickN(pool, 3);
            return pool;
        }
        if (tt.startsWith('enemy')) {
            const pool = enemies.filter(inRange);
            if (tt.endsWith('single') || tt.endsWith('_one'))
                return pool.slice(0, 1);
            if (tt.endsWith('_12'))
                return pickN(pool, 2);
            if (tt.endsWith('_13'))
                return pickN(pool, 3);
            return pool;
        }
        return enemies.slice(0, 1);
    }
    /**
     * @param skill 发动该效果的战法（用于把 mechanics 记到 reaction 上）；普攻不传。
     * @param opts.noReaction 回击造成的伤害不再触发回击，避免双方互击无限递归。
     */
    applyEffect(effect, attacker, target, skillName, phase, skill, opts) {
        if (!effectAvailable(effect, this.round))
            return;
        const t = effect.effect_type;
        if (t === 'PHYSICAL_DAMAGE' || t === 'STRATEGY_DAMAGE') {
            const bd = baseDamage(this.cfg, effect, attacker, target);
            // E0 控制流 + E2 系数：weakness 由兵种给出，真实系数未解
            const weakness = 1;
            const cf = counterFactor(this.cfg, effect.attack_type, weakness);
            const bonuses = [...effect.bonus_terms, ...attacker.buffs];
            const bonusTotal = sumTermsBonus(bonuses);
            const calc = calcDamage(bd.value, cf.factor, bonusTotal, this.cfg.min_damage);
            /* M4-7：「自身受到伤害降低」只作用在承受者身上，不进攻击方加成链。
               减伤求和后 clamp 到 90%，避免叠加出无敌导致战斗永无终结。 */
            const reduce = Math.min(0.9, Math.max(0, target.reactions
                .filter((r) => r.kind === 'damage_reduce')
                .reduce((s, r) => s + r.value, 0)));
            const mitigated = reduce > 0
                ? Math.max(0, Math.trunc(calc.final * (1 - reduce)))
                : calc.final;
            const troopsBefore = target.troops;
            target.troops = Math.max(0, target.troops - mitigated);
            const troopsAfter = target.troops;
            this.emit(phase, attacker.unit_id, 'damage', {
                target: target.unit_id,
                skill: skillName,
                effect_type: t,
                rate_pct_at_level: pythonRound2(bd.rate_pct_at_level),
                base_evidence: bd.evidence,
                counter_note: cf.note,
                calc,
                // 移植版新增：兵力对账（不改变结算语义）
                troops_before: troopsBefore,
                troops_after: troopsAfter,
                applied: troopsBefore - troopsAfter,
                /* M4-7 审计字段只在真的发生时写入：旧战法的事件必须逐字节不变，
                   否则黄金向量 / event_fingerprint 会整体漂移。 */
                ...(reduce > 0 ? { damage_reduce: reduce, before_mitigation: calc.final } : {}),
                ...(effect.note === 'counter' ? { counter: true } : {}),
            }, 'E0');
            if (target.troops <= 0 && target.alive) {
                target.alive = false;
                this.emit(phase, 'system', 'unit_down', { unit: target.unit_id }, 'E0');
            }
            /* M4-7 回击：受到攻击（普攻/战法伤害）时按当前战法等级概率反击一次。
               与 CONTROL 一致，无论概率多少都消耗一次随机数，保证同种子可回放。
               回击伤害携带 noReaction，不会再触发对方的回击。 */
            if (!opts?.noReaction && target.alive && attacker.alive && attacker !== target) {
                for (const reaction of target.reactions.filter((r) => r.kind === 'counter')) {
                    const chance = Math.min(1, Math.max(0, reaction.value));
                    const fired = this.rng.random() < chance;
                    if (!fired) {
                        this.emit(phase, target.unit_id, 'counter_miss', {
                            skill: reaction.skill_name, target: attacker.unit_id, probability: chance,
                        }, 'E2');
                        continue;
                    }
                    this.emit(phase, target.unit_id, 'skill_trigger', {
                        skill: reaction.skill_name,
                        class: '指挥',
                        probability: chance,
                        counter: true,
                    }, 'E2');
                    const counterEffect = {
                        detail_id: -2,
                        effect_type: reaction.damage_type ?? 'STRATEGY_DAMAGE',
                        rate_pct: reaction.rate_pct ?? 0,
                        flat_rate: true, // 87% 是最终伤害率，不随武将等级二次成长
                        target_type: 'enemy_single',
                        attack_type: 'normal',
                        available_round: 0,
                        control_probability: 0,
                        bonus_terms: [],
                        evidence: 'E2',
                        note: 'counter',
                    };
                    this.applyEffect(counterEffect, target, attacker, reaction.skill_name, phase, undefined, { noReaction: true });
                }
            }
            return;
        }
        if (t === 'HEAL') {
            const rate = levelValue(effect.rate_pct, attacker.hero.level) / 100.0;
            const amount = Math.trunc(attributeFor('STRATEGY_DAMAGE', attacker.hero).value * rate);
            const before = target.troops;
            target.troops = Math.min(target.max_troops, target.troops + amount);
            this.emit(phase, attacker.unit_id, 'heal', {
                target: target.unit_id,
                amount,
                applied: target.troops - before,
                troops_before: before,
                troops_after: target.troops,
            }, 'E2');
            return;
        }
        if (t === 'CONTROL') {
            const p = effect.control_probability;
            // 与 Python 一致：无论 p 是否为 1 都消耗一次随机数
            const ok = this.rng.random() < p;
            // M4-7 洞察：免疫控制状态的施加（回合末自动过期，见 run 的 round_end）
            if (ok && target.reactions.some((r) => r.kind === 'insight')) {
                this.emit(phase, attacker.unit_id, 'control_immune', {
                    target: target.unit_id, state: effect.control_state, by: '洞察', probability: p,
                }, 'E2');
                return;
            }
            if (ok && effect.control_state && !hasControl(target, effect.control_state)) {
                target.states.push(effect.control_state);
                this.emit(phase, attacker.unit_id, 'control', {
                    target: target.unit_id,
                    state: effect.control_state,
                    probability: p,
                }, 'E2');
            }
            return;
        }
        if (t === 'BUFF' || t === 'DEBUFF') {
            const sign = t === 'BUFF' ? 1.0 : -1.0;
            for (const term of effect.bonus_terms) {
                target.buffs.push({
                    name: term.name,
                    value: term.value * sign,
                    op: term.op,
                    evidence: 'E2',
                    source: 'effect',
                });
            }
            /* M4-7：mechanics 不进 buffs（内核对攻击方 buffs 无差别求和，减伤/回击词
               混进去会变成攻击加成，描述与计算就分家了），单独记在 reactions 上。 */
            const m = t === 'BUFF' ? effect.mechanics : undefined;
            const mechanics = [];
            if (m) {
                const sid = skill?.skill_id ?? effect.detail_id;
                const grant = (r) => {
                    // 同源战法重复授予（如被动每回合触发）只刷新，不堆叠
                    target.reactions = target.reactions.filter((x) => !(x.skill_id === sid && x.kind === r.kind));
                    target.reactions.push(r);
                };
                const insightRounds = Math.max(0, Math.trunc(Number(m.insight_rounds) || 0));
                const counter = m.counter;
                const reduce = Math.min(0.9, Math.max(0, Number(m.damage_taken_reduce) || 0));
                if (insightRounds > 0) {
                    grant({ kind: 'insight', skill_id: sid, skill_name: skillName, rounds: insightRounds, value: 0 });
                    mechanics.push('洞察');
                }
                if (counter) {
                    grant({
                        kind: 'counter', skill_id: sid, skill_name: skillName, rounds: 0,
                        value: Math.min(1, Math.max(0, Number(counter.chance) || 0)),
                        rate_pct: Number(counter.rate_pct) || 0,
                        damage_type: counter.damage_type,
                    });
                    mechanics.push('回击');
                }
                if (reduce > 0) {
                    grant({ kind: 'damage_reduce', skill_id: sid, skill_name: skillName, rounds: 0, value: reduce });
                    mechanics.push('受到伤害降低');
                }
                this.emit(phase, attacker.unit_id, 'reaction', {
                    target: target.unit_id, skill: skillName, mechanics,
                    insight_rounds: insightRounds,
                    counter_chance: counter ? Math.min(1, Math.max(0, Number(counter.chance) || 0)) : 0,
                    damage_reduce: reduce,
                }, 'E2');
            }
            this.emit(phase, attacker.unit_id, 'buff', {
                target: target.unit_id,
                terms: effect.bonus_terms.map((x) => x.name),
                ...(mechanics.length ? { mechanics } : {}),
            }, 'E2');
        }
    }
    cast(unit, skill, phase) {
        const blocked = controlBlocks(unit, skill);
        if (blocked) {
            this.emit(phase, unit.unit_id, 'skill_blocked', { skill: skill.name, state: blocked }, 'E0');
            return;
        }
        if (skill.prepare > 0 && phase !== 'prepare_ready') {
            /* ★ M3-8 修复：引导战法不得每回合重复判定/重复 push（旧实现会无限准备，
               readyRound 到期后 cast('prepare_ready') 又走本分支 → 永不释放）。
               引导期间本条跳过发动判定；到期由主循环 prepare_ready 释放。 */
            const already = this.prepare.some((x) => x.unit === unit && x.skill === skill);
            if (!already) {
                this.prepare.push({ readyRound: this.round + skill.prepare, unit, skill });
                this.emit(phase, unit.unit_id, 'skill_prepare', {
                    skill: skill.name,
                    ready_round: this.round + skill.prepare,
                }, 'E0');
            }
            return;
        }
        /* ★ M3-8：prepare_ready 释放必发（发动率在引导开始那次判定已消耗），
           旧实现在释放时再掷一次概率，会让已判定的引导二次掷骰。 */
        const { fired, probability } = phase === 'prepare_ready'
            ? { fired: true, probability: 1 }
            : rollTrigger(skill, this.rng);
        if (!fired) {
            this.emit(phase, unit.unit_id, 'skill_miss', { skill: skill.name, probability }, 'E2');
            return;
        }
        this.emit(phase, unit.unit_id, 'skill_trigger', {
            skill: skill.name,
            class: skill.skill_class,
            probability,
        }, 'E2');
        for (const effect of skill.effects) {
            // 追击战法（三战口径）：目标 = 该武将的普攻目标（战位最近敌军），不吃射程表
            const targets = skill.skill_class === '追击' && String(effect.target_type).startsWith('enemy')
                ? [this.nearestFoe(unit, undefined, 'order')].filter((x) => Boolean(x))
                : this.effectTargets(effect, unit);
            for (const target of targets) {
                if (target.alive)
                    this.applyEffect(effect, unit, target, skill.name, phase, skill);
            }
        }
    }
    normalAttackEffect(unit) {
        const rates = this.cfg.damage_rates_pct;
        const rate = rates[crc32Utf8(unit.unit_id) % rates.length];
        return {
            detail_id: -1,
            effect_type: 'PHYSICAL_DAMAGE',
            rate_pct: rate,
            target_type: 'enemy_single',
            attack_type: unit.hero.hero_type,
            available_round: 0,
            control_probability: 0,
            bonus_terms: [],
            evidence: 'E0',
            note: 'rate_pct 取自包内 83 个真实伤害率样本',
        };
    }
    run(inputs) {
        this.units = cloneUnits(inputs);
        this.events = [];
        this.prepare = [];
        this.round = 0;
        const warnings = [...this.cfg.unresolved];
        const sides = [...new Set(this.units.map((u) => u.side))].sort((a, b) => a - b);
        // 战斗开始：指挥战法
        for (const u of actionOrder(this.units)) {
            const command = u.hero.skills
                .filter((s) => s.skill_class === '指挥')
                .sort((a, b) => a.skill_id - b.skill_id);
            for (const skill of command)
                this.cast(u, skill, 'battle_start');
        }
        for (let r = 1; r <= this.roundLimit; r += 1) {
            this.round = r;
            // 回合开始：被动战法 / 准备到期
            for (const u of actionOrder(this.units)) {
                for (const skill of u.hero.skills.filter((s) => s.skill_class === '被动')) {
                    this.cast(u, skill, 'round_start');
                }
            }
            const ready = this.prepare.filter((x) => x.readyRound === r);
            this.prepare = this.prepare.filter((x) => x.readyRound > r);
            for (const item of ready) {
                if (item.unit.alive)
                    this.cast(item.unit, item.skill, 'prepare_ready');
            }
            // 行动阶段：按速度降序
            for (const u of actionOrder(this.units)) {
                if (!u.alive)
                    continue;
                const foes = this.enemies(u.side);
                if (foes.length === 0)
                    break;
                // 普攻目标 = 攻击距离内最近的敌军（前锋顶前，溃败后依次补位）。
                // 超出攻击距离则本回合无普攻（战法仍可越排释放），避免短手武将站大营白打。
                const target = this.nearestFoe(u);
                if (target && !hasControl(u, '怯战')) {
                    this.applyEffect(this.normalAttackEffect(u), u, target, '普通攻击', 'action');
                }
                const active = u.hero.skills
                    .filter((s) => s.skill_class === '主动')
                    .sort((a, b) => SKILL_PHASE_ORDER[a.skill_class] - SKILL_PHASE_ORDER[b.skill_class] || a.skill_id - b.skill_id);
                for (const skill of active) {
                    if (u.alive && this.enemies(u.side).length > 0)
                        this.cast(u, skill, 'action');
                }
                for (const skill of u.hero.skills.filter((s) => s.skill_class === '追击')) {
                    if (u.alive && this.enemies(u.side).length > 0)
                        this.cast(u, skill, 'after_attack');
                }
            }
            // 回合结束：清除单回合控制状态 + 递减有期限的反应（洞察 3 回合口径）
            for (const u of this.units) {
                for (const st of [...u.states]) {
                    if (st === '犹豫' || st === '怯战') {
                        u.states.splice(u.states.indexOf(st), 1);
                        this.emit('round_end', u.unit_id, 'state_clear', { state: st }, 'E2');
                    }
                }
                for (const r of [...u.reactions]) {
                    if (r.rounds <= 0)
                        continue; // 0 = 整场有效
                    r.rounds -= 1;
                    if (r.rounds <= 0) {
                        u.reactions.splice(u.reactions.indexOf(r), 1);
                        this.emit('round_end', u.unit_id, 'reaction_expire', {
                            kind: r.kind, skill: r.skill_name,
                        }, 'E2');
                    }
                }
            }
            const aliveBySide = sides.map((s) => this.units.filter((u) => u.side === s && u.alive).length);
            if (aliveBySide.some((n) => n === 0))
                break;
        }
        const survivors = {};
        const totalTroopsBySide = {};
        const finalTroops = {};
        for (const s of sides) {
            survivors[String(s)] = this.units.filter((u) => u.side === s && u.alive).map((u) => u.unit_id);
            totalTroopsBySide[String(s)] = this.units
                .filter((u) => u.side === s)
                .reduce((sum, u) => sum + u.troops, 0);
        }
        for (const u of this.units)
            finalTroops[u.unit_id] = u.troops;
        const aliveSides = sides.filter((s) => survivors[String(s)].length > 0);
        let winner = aliveSides.length === 1 ? aliveSides[0] : null;
        if (aliveSides.length !== 1)
            winner = null;
        return {
            seed: this.seed,
            config_fingerprint: this.config_fingerprint,
            winner,
            rounds: this.round,
            events: this.events,
            survivors,
            warnings,
            final_troops: finalTroops,
            total_troops_by_side: totalTroopsBySide,
            rng_calls: this.rng.calls,
            event_fingerprint: hash16(stableStringify(this.events)),
        };
    }
}
export function runBattle(options) {
    return new BattleEngine(options).run(options.units);
}
