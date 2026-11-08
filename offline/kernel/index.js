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
import { DEFAULT_BATTLE_CONFIG } from './default-config.js';
import { buildArmies } from './scenario.js';
import { runBattle } from './engine.js';
/** 一行跑通一场演示战斗，供游戏层 / 控制台快速验证 */
export function runDemo(options = {}) {
    const cfg = options.config ?? DEFAULT_BATTLE_CONFIG;
    const units = buildArmies(cfg, options.perSide ?? 3, options.level ?? 10, options.troops ?? 10000);
    return runBattle({
        units,
        seed: options.seed ?? 20261106,
        config: cfg,
        roundLimit: options.roundLimit,
    });
}
