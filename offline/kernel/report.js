/** 战报渲染与不变量校验：稳定性测试与线上对账共用。 */
function fmt(n) {
    return typeof n === 'number' ? String(Math.round(n * 100) / 100) : String(n);
}
export function toText(result, maxEvents = 250) {
    const lines = [
        `战斗战报  seed=${result.seed}  config=${result.config_fingerprint}`,
        `结果：${result.winner === null ? '平局' : `阵营 ${result.winner} 胜`}  回合数=${result.rounds}  事件数=${result.events.length}`,
        '-'.repeat(78),
    ];
    for (const e of result.events.slice(0, maxEvents)) {
        const p = e.payload;
        if (e.kind === 'damage') {
            const d = p.calc;
            lines.push(`[R${String(e.round).padStart(2, '0')} ${e.phase.padEnd(8)}] ${e.actor} -> ${p.target} ` +
                `${p.skill} ${p.effect_type} 伤害=${d.final} ` +
                `(base=${fmt(d.base)} x 相克=${d.counter} x (1+${fmt(d.bonus_total)}) -> ${fmt(d.raw)}, ` +
                `floor=${d.floored}, min=${d.min_damage})`);
        }
        else if (e.kind === 'skill_trigger') {
            lines.push(`[R${String(e.round).padStart(2, '0')} ${e.phase.padEnd(8)}] ${e.actor} 发动 ${p.skill} (${p.class}) p=${fmt(p.probability)}`);
        }
        else if (e.kind === 'heal') {
            lines.push(`[R${String(e.round).padStart(2, '0')} ${e.phase.padEnd(8)}] ${e.actor} 治疗 ${p.target} +${p.amount}`);
        }
        else if (e.kind === 'control') {
            lines.push(`[R${String(e.round).padStart(2, '0')} ${e.phase.padEnd(8)}] ${e.actor} 施加 ${p.state} -> ${p.target}`);
        }
        else {
            lines.push(`[R${String(e.round).padStart(2, '0')} ${e.phase.padEnd(8)}] ${e.actor} ${e.kind} ${JSON.stringify(p).slice(0, 110)}`);
        }
    }
    if (result.events.length > maxEvents)
        lines.push(`... 另有 ${result.events.length - maxEvents} 条事件`);
    lines.push('-'.repeat(78));
    lines.push(`证据等级：伤害结算式 E0；BaseDamage / 相克系数 / 概率 E2（可经配置替换）`);
    for (const w of result.warnings)
        lines.push(`警告：${w}`);
    return lines.join('\n');
}
/** 检查一场战斗的全部可验证不变量。任何一条失败都说明内核不稳定。 */
export function validateInvariants(result, units, roundLimit) {
    const problems = [];
    const checks = {
        events: result.events.length,
        damage_events: 0,
        heal_events: 0,
        damage_applied_total: 0,
        heal_applied_total: 0,
    };
    if (!(result.rounds >= 0 && result.rounds <= roundLimit)) {
        problems.push(`回合数越界：${result.rounds} / ${roundLimit}`);
    }
    if (!Number.isFinite(result.rng_calls) || result.rng_calls < 0) {
        problems.push('rng_calls 非法');
    }
    const initialTotal = units.reduce((s, u) => s + u.troops, 0);
    const maxByUnit = new Map(units.map((u) => [u.unit_id, u.max_troops]));
    for (const [idx, e] of result.events.entries()) {
        if (!(e.round >= 0 && e.round <= roundLimit))
            problems.push(`事件 ${idx} round 越界`);
        if (e.payload && typeof e.payload === 'object') {
            for (const [k, v] of Object.entries(e.payload)) {
                if (typeof v === 'number' && !Number.isFinite(v))
                    problems.push(`事件 ${idx} 字段 ${k} 非有限数`);
            }
        }
        if (e.kind === 'damage') {
            checks.damage_events += 1;
            const calc = e.payload.calc;
            const before = e.payload.troops_before;
            const after = e.payload.troops_after;
            const applied = e.payload.applied;
            if (!calc) {
                problems.push(`事件 ${idx} 缺少 calc`);
                continue;
            }
            for (const key of ['base', 'counter', 'bonus_total', 'after_counter', 'one_plus_bonus', 'raw', 'floored', 'min_damage', 'final']) {
                if (!Number.isFinite(calc[key]))
                    problems.push(`事件 ${idx} calc.${key} 非有限数`);
            }
            if (!(calc.final >= calc.min_damage))
                problems.push(`事件 ${idx} final < min_damage`);
            if (!(calc.final >= 0))
                problems.push(`事件 ${idx} final 为负`);
            if (!(before >= 0 && after >= 0))
                problems.push(`事件 ${idx} 兵力为负`);
            if (Math.abs(before - after - applied) > 1e-9)
                problems.push(`事件 ${idx} 兵力对账不一致`);
            if (!(applied >= 0 && applied <= before))
                problems.push(`事件 ${idx} applied 越界`);
            if (after > (maxByUnit.get(String(e.payload.target)) ?? Infinity)) {
                problems.push(`事件 ${idx} 兵力超过上限`);
            }
            checks.damage_applied_total += applied;
        }
        else if (e.kind === 'heal') {
            checks.heal_events += 1;
            const applied = e.payload.applied;
            if (!(applied >= 0))
                problems.push(`事件 ${idx} 治疗量为负`);
            if (e.payload.troops_after > (maxByUnit.get(String(e.payload.target)) ?? Infinity)) {
                problems.push(`事件 ${idx} 治疗超过兵力上限`);
            }
            checks.heal_applied_total += applied;
        }
    }
    // 兵力守恒：初始总和 - 最终总和 = 累计伤害 - 累计治疗
    const finalTotal = Object.values(result.final_troops).reduce((s, v) => s + v, 0);
    const expected = initialTotal - (checks.damage_applied_total - checks.heal_applied_total);
    if (Math.abs(finalTotal - expected) > 1e-9) {
        problems.push(`兵力守恒失败：最终=${finalTotal} 期望=${expected}`);
    }
    for (const u of units) {
        const v = result.final_troops[u.unit_id];
        if (!Number.isFinite(v) || v < 0 || v > u.max_troops) {
            problems.push(`${u.unit_id} 最终兵力非法：${v}`);
        }
    }
    const aliveSides = Object.values(result.survivors).filter((v) => v.length > 0);
    if (aliveSides.length === 1 && result.winner === null)
        problems.push('一方存活却判平局');
    if (aliveSides.length !== 1 && result.winner !== null)
        problems.push('存活阵营数与 winner 不一致');
    return { ok: problems.length === 0, problems, checks };
}
/** 事件流结构摘要，用于跨语言 / 跨版本回归比对 */
export function eventSummary(events) {
    const out = {};
    for (const e of events)
        out[e.kind] = (out[e.kind] ?? 0) + 1;
    return out;
}
