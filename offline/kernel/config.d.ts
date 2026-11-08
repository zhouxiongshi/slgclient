/**
 * 配置数据层：对应 battle-kit/kernel/config.py 的 ConfigStore。
 *
 * 数值全部来自 config/battle_config.json（从 battle-kit 原样复制），
 * 内核不硬编码任何平衡数值。加载期校验与 Python 版 validate() 对齐。
 */
import type { BattleConfig } from './types.js';
export declare function validateConfig(cfg: BattleConfig): void;
/** 配置指纹：排除 provenance / unresolved 后对规范化 JSON 取 16 位哈希。
 *  与 Python 的 sha256[:16] 口径不同（算法不同），只用于 TS 侧自身回归；
 *  与 battle-kit 的一致性由「配置文件字节级相同 + Python 指纹复核」保证。 */
export declare function configFingerprint(cfg: BattleConfig): string;
/** 深拷贝并校验，避免调用方后续修改配置导致同一 seed 结果漂移 */
export declare function parseConfig(raw: unknown): BattleConfig;
/** 不依赖 structuredClone（Cocos 的 JS 引擎未必提供）的深拷贝 */
export declare function structuredCloneSafe<T>(value: T): T;
export declare function termCategories(cfg: BattleConfig): Record<string, number>;
