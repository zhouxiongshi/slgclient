/**
 * 配置数据层：对应 battle-kit/kernel/config.py 的 ConfigStore。
 *
 * 数值全部来自 config/battle_config.json（从 battle-kit 原样复制），
 * 内核不硬编码任何平衡数值。加载期校验与 Python 版 validate() 对齐。
 */

import type { BattleConfig } from './types.js';
import { hash16, stableStringify } from './hash.js';

export function validateConfig(cfg: BattleConfig): void {
  if (!cfg || typeof cfg !== 'object') throw new Error('配置为空');
  if (!Array.isArray(cfg.damage_rates_pct) || cfg.damage_rates_pct.length === 0) {
    throw new Error('damage_rates.csv 为空');
  }
  if (!cfg.hero_names?.length || !cfg.skill_names?.length) {
    throw new Error('名录为空');
  }
  if (!cfg.il_methods?.includes('CalcDamageByTerms')) {
    throw new Error('IL 证据缺失');
  }
  const doubles = cfg.level_pairs.filter((p) => p.exactly_double);
  if (doubles.length === 0 || !doubles.every((p) => Math.abs(p.ratio - 2.0) < 1e-9)) {
    throw new Error('等级缩放 E0 结论（58/58 ×2）不成立，配置可能被改动');
  }
  if (!cfg.tcfg_schemas?.Tcfg_hero?.includes('attack_base')) {
    throw new Error('Tcfg_hero 字段 schema 缺失');
  }
  // 移植版额外校验：防止脏配置把战斗算成 NaN / 负数
  if (!(cfg.min_damage >= 0)) throw new Error('min_damage 必须 >= 0');
  if (!(cfg.round_limit > 0)) throw new Error('round_limit 必须 > 0');
  if (!(cfg.troop_factor > 0)) throw new Error('troop_factor 必须 > 0');
  if (!cfg.damage_rates_pct.every((v) => Number.isFinite(v) && v >= 0)) {
    throw new Error('伤害率样本包含非法数值');
  }
  for (const tier of Object.values(cfg.counter_tiers)) {
    if (!Number.isFinite(tier) || tier < 0) throw new Error('相克档位包含非法数值');
  }
}

/** 配置指纹：排除 provenance / unresolved 后对规范化 JSON 取 16 位哈希。
 *  与 Python 的 sha256[:16] 口径不同（算法不同），只用于 TS 侧自身回归；
 *  与 battle-kit 的一致性由「配置文件字节级相同 + Python 指纹复核」保证。 */
export function configFingerprint(cfg: BattleConfig): string {
  const slim: Record<string, unknown> = { ...cfg };
  delete slim.provenance;
  delete slim.unresolved;
  return hash16(stableStringify(slim));
}

/** 深拷贝并校验，避免调用方后续修改配置导致同一 seed 结果漂移 */
export function parseConfig(raw: unknown): BattleConfig {
  if (!raw || typeof raw !== 'object') throw new Error('配置不是对象');
  const cfg = structuredCloneSafe(raw) as BattleConfig;
  validateConfig(cfg);
  return cfg;
}

/** 不依赖 structuredClone（Cocos 的 JS 引擎未必提供）的深拷贝 */
export function structuredCloneSafe<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => structuredCloneSafe(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = structuredCloneSafe((value as Record<string, unknown>)[k]);
  }
  return out as T;
}

export function termCategories(cfg: BattleConfig): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of cfg.effect_terms) {
    out[t.category] = (out[t.category] ?? 0) + 1;
  }
  return out;
}
