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
import type { BattleConfig, BattleOptions, BattleResult, UnitInput } from './types.js';
export declare class BattleEngine {
    readonly cfg: BattleConfig;
    readonly seed: number;
    readonly roundLimit: number;
    readonly config_fingerprint: string;
    private readonly rng;
    private units;
    private events;
    private prepare;
    private round;
    constructor(options: BattleOptions);
    private emit;
    private enemies;
    private effectTargets;
    private applyEffect;
    private cast;
    private normalAttackEffect;
    run(inputs: readonly UnitInput[]): BattleResult;
}
export declare function runBattle(options: BattleOptions): BattleResult;
