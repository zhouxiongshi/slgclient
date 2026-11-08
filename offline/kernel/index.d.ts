/** 战斗内核公共入口。Cocos / 浏览器直接引用编译后的 build/src/index.js。 */
export * from './types.js';
export * from './hash.js';
export * from './rng.js';
export * from './config.js';
export * from './rules.js';
export * from './engine.js';
export * from './scenario.js';
export * from './report.js';
export { DEFAULT_BATTLE_CONFIG } from './default-config.js';
import type { BattleConfig, BattleResult } from './types.js';
export interface DemoOptions {
    seed?: number;
    perSide?: number;
    level?: number;
    troops?: number;
    roundLimit?: number;
    config?: BattleConfig;
}
/** 一行跑通一场演示战斗，供游戏层 / 控制台快速验证 */
export declare function runDemo(options?: DemoOptions): BattleResult;
