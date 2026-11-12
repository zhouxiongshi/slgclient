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

import type {
  BattleConfig,
  BattleEvent,
  BattleOptions,
  BattleResult,
  Effect,
  EffectType,
  Phase,
  Skill,
  UnitInput,
  UnitState,
} from './types.js';
import { configFingerprint, structuredCloneSafe, validateConfig } from './config.js';
import { crc32Utf8, hash16, stableStringify } from './hash.js';
import { PythonRandom } from './rng.js';
import {
  actionOrder,
  attributeFor,
  baseDamage,
  calcDamage,
  controlBlocks,
  counterFactor,
  effectAvailable,
  hasControl,
  heroAttr,
  levelValue,
  rollTrigger,
  SKILL_PHASE_ORDER,
  sumTermsBonus,
} from './rules.js';

interface PreparedCast {
  readyRound: number;
  unit: UnitState;
  skill: Skill;
}

function cloneUnits(inputs: readonly UnitInput[]): UnitState[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('战斗单位列表为空');
  }
  const seen = new Set<string>();
  return inputs.map((raw) => {
    const u = structuredCloneSafe(raw);
    if (seen.has(u.unit_id)) throw new Error(`unit_id 重复：${u.unit_id}`);
    seen.add(u.unit_id);
    if (!(u.troops > 0) || !(u.max_troops > 0)) {
      throw new Error(`${u.unit_id} 兵力必须为正数`);
    }
    if (u.troops > u.max_troops) throw new Error(`${u.unit_id} 当前兵力超过上限`);
    let speed = u.speed ?? 0;
    if (!(speed > 0)) speed = heroAttr(u.hero, 'speed') || 100.0;
    // 战位：显式给值优先；否则从 unit_id 末位推导（a0/d2），推不出当 0。
    // 旧战报无 pos 字段时靠这条回落，保证历史用例逐字节可复现。
    const derivedPos = Math.max(0, Number(String(u.unit_id).slice(1)) || 0);
    const pos = Number.isFinite(u.pos) ? Math.max(0, Math.min(4, Math.trunc(u.pos as number))) : derivedPos;
    // 普攻攻击距离：缺省 9 = 不受限，旧用例行为不变。
    const attack_range = Number.isFinite(u.attack_range)
      ? Math.max(1, Math.min(9, Math.trunc(u.attack_range as number)))
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
      alive: true,
    } as UnitState;
  });
}

function pythonRound2(x: number): number {
  // 仅用于战报展示字段，不参与结算
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export class BattleEngine {
  public readonly cfg: BattleConfig;
  public readonly seed: number;
  public readonly roundLimit: number;
  public readonly config_fingerprint: string;

  private readonly rng: PythonRandom;
  private units: UnitState[] = [];
  private events: BattleEvent[] = [];
  private prepare: PreparedCast[] = [];
  private round = 0;

  constructor(options: BattleOptions) {
    // 配置在构造时快照，外部之后修改配置不会影响本场战斗的可复现性
    this.cfg = structuredCloneSafe(options.config);
    validateConfig(this.cfg);
    this.seed = Math.trunc(options.seed) || 0;
    this.roundLimit = options.roundLimit ?? this.cfg.round_limit;
    if (!(this.roundLimit > 0)) throw new Error('roundLimit 必须 > 0');
    this.config_fingerprint = configFingerprint(this.cfg);
    this.rng = new PythonRandom(this.seed);
  }

  private emit(phase: Phase, actor: string, kind: string, payload: Record<string, unknown>, evidence = ''): void {
    this.events.push({ round: this.round, phase, actor, kind, payload, evidence });
  }

  private enemies(side: number): UnitState[] {
    return this.units.filter((u) => u.side !== side && u.alive);
  }

  /** 敌我战位距离：跨阵营 pos 相加 +1（前锋→前锋 1，大营→大营 5）；同阵营取 |pos 差|。 */
  private slotDist(a: UnitState, b: UnitState): number {
    if (a.side === b.side) return Math.abs((a.pos || 0) - (b.pos || 0));
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
  private nearestFoe(unit: UnitState, maxDist?: number, tie: 'id' | 'order' = 'id'): UnitState | null {
    const limit = Number.isFinite(maxDist) ? (maxDist as number) : unit.attack_range ?? 9;
    const foes = this.enemies(unit.side).filter((u) => this.slotDist(unit, u) <= limit);
    if (!foes.length) return null;
    if (tie === 'order') {
      // 稳定排序：仅按距离，不改变同距者的原始阵列表序
      const sorted = foes.slice().sort((a, b) => this.slotDist(unit, a) - this.slotDist(unit, b));
      return sorted[0];
    }
    return foes
      .slice()
      .sort((a, b) => this.slotDist(unit, a) - this.slotDist(unit, b) || (a.unit_id < b.unit_id ? -1 : 1))[0];
  }

  private effectTargets(effect: Effect, unit: UnitState): UnitState[] {
    const enemies = this.units.filter((u) => u.side !== unit.side && u.alive);
    const allies = this.units.filter((u) => u.side === unit.side && u.alive);
    const tt = effect.target_type;
    // 射程：effect.range 缺省 9 = 无远弗届（旧战法数据兼容）。先按射程过滤，再截取前 N 个。
    const range = Number.isFinite(effect.range) ? (effect.range as number) : 9;
    const inRange = (u: UnitState): boolean => this.slotDist(unit, u) <= range;
    const pickN = (list: UnitState[], n: number): UnitState[] => (n ? list.slice(0, n) : list);
    if (tt === 'self') return unit.alive ? [unit] : [];
    if (tt.startsWith('ally')) {
      const pool = allies.filter(inRange);
      if (tt.endsWith('single') || tt.endsWith('_one')) return pool.slice(0, 1);
      if (tt.endsWith('_12')) return pickN(pool, 2);
      if (tt.endsWith('_13')) return pickN(pool, 3);
      return pool;
    }
    if (tt.startsWith('enemy')) {
      const pool = enemies.filter(inRange);
      if (tt.endsWith('single') || tt.endsWith('_one')) return pool.slice(0, 1);
      if (tt.endsWith('_12')) return pickN(pool, 2);
      if (tt.endsWith('_13')) return pickN(pool, 3);
      return pool;
    }
    return enemies.slice(0, 1);
  }

  private applyEffect(effect: Effect, attacker: UnitState, target: UnitState, skillName: string, phase: Phase): void {
    if (!effectAvailable(effect, this.round)) return;

    const t = effect.effect_type;
    if (t === 'PHYSICAL_DAMAGE' || t === 'STRATEGY_DAMAGE') {
      const bd = baseDamage(this.cfg, effect, attacker, target);
      // E0 控制流 + E2 系数：weakness 由兵种给出，真实系数未解
      const weakness = 1;
      const cf = counterFactor(this.cfg, effect.attack_type, weakness);
      const bonuses = [...effect.bonus_terms, ...attacker.buffs];
      const bonusTotal = sumTermsBonus(bonuses);
      const calc = calcDamage(bd.value, cf.factor, bonusTotal, this.cfg.min_damage);

      const troopsBefore = target.troops;
      target.troops = Math.max(0, target.troops - calc.final);
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
      }, 'E0');

      if (target.troops <= 0 && target.alive) {
        target.alive = false;
        this.emit(phase, 'system', 'unit_down', { unit: target.unit_id }, 'E0');
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
      this.emit(phase, attacker.unit_id, 'buff', {
        target: target.unit_id,
        terms: effect.bonus_terms.map((x) => x.name),
      }, 'E2');
    }
  }

  private cast(unit: UnitState, skill: Skill, phase: Phase): void {
    const blocked = controlBlocks(unit, skill);
    if (blocked) {
      this.emit(phase, unit.unit_id, 'skill_blocked', { skill: skill.name, state: blocked }, 'E0');
      return;
    }
    if (skill.prepare > 0) {
      this.prepare.push({ readyRound: this.round + skill.prepare, unit, skill });
      this.emit(phase, unit.unit_id, 'skill_prepare', {
        skill: skill.name,
        ready_round: this.round + skill.prepare,
      }, 'E0');
      return;
    }
    const { fired, probability } = rollTrigger(skill, this.rng);
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
      const targets =
        skill.skill_class === '追击' && String(effect.target_type).startsWith('enemy')
          ? [this.nearestFoe(unit, undefined, 'order')].filter((x): x is UnitState => Boolean(x))
          : this.effectTargets(effect, unit);
      for (const target of targets) {
        if (target.alive) this.applyEffect(effect, unit, target, skill.name, phase);
      }
    }
  }

  private normalAttackEffect(unit: UnitState): Effect {
    const rates = this.cfg.damage_rates_pct;
    const rate = rates[crc32Utf8(unit.unit_id) % rates.length];
    return {
      detail_id: -1,
      effect_type: 'PHYSICAL_DAMAGE' as EffectType,
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

  run(inputs: readonly UnitInput[]): BattleResult {
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
      for (const skill of command) this.cast(u, skill, 'battle_start');
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
        if (item.unit.alive) this.cast(item.unit, item.skill, 'prepare_ready');
      }

      // 行动阶段：按速度降序
      for (const u of actionOrder(this.units)) {
        if (!u.alive) continue;
        const foes = this.enemies(u.side);
        if (foes.length === 0) break;
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
          if (u.alive && this.enemies(u.side).length > 0) this.cast(u, skill, 'action');
        }
        for (const skill of u.hero.skills.filter((s) => s.skill_class === '追击')) {
          if (u.alive && this.enemies(u.side).length > 0) this.cast(u, skill, 'after_attack');
        }
      }

      // 回合结束：清除单回合控制状态
      for (const u of this.units) {
        for (const st of [...u.states]) {
          if (st === '犹豫' || st === '怯战') {
            u.states.splice(u.states.indexOf(st), 1);
            this.emit('round_end', u.unit_id, 'state_clear', { state: st }, 'E2');
          }
        }
      }

      const aliveBySide = sides.map((s) => this.units.filter((u) => u.side === s && u.alive).length);
      if (aliveBySide.some((n) => n === 0)) break;
    }

    const survivors: Record<string, string[]> = {};
    const totalTroopsBySide: Record<string, number> = {};
    const finalTroops: Record<string, number> = {};
    for (const s of sides) {
      survivors[String(s)] = this.units.filter((u) => u.side === s && u.alive).map((u) => u.unit_id);
      totalTroopsBySide[String(s)] = this.units
        .filter((u) => u.side === s)
        .reduce((sum, u) => sum + u.troops, 0);
    }
    for (const u of this.units) finalTroops[u.unit_id] = u.troops;

    const aliveSides = sides.filter((s) => survivors[String(s)].length > 0);
    let winner: number | null = aliveSides.length === 1 ? aliveSides[0] : null;
    if (aliveSides.length !== 1) winner = null;

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

export function runBattle(options: BattleOptions): BattleResult {
  return new BattleEngine(options).run(options.units);
}
