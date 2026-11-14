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
    /** 敌我战位距离：跨阵营 pos 相加 +1（前锋→前锋 1，大营→大营 5）；同阵营取 |pos 差|。 */
    private slotDist;
    /**
     * 普攻/追击目标：战位距离最近、且在攻击距离内的存活敌军。
     * 超出 attack_range 返回 null —— 大营里的短手武将打不出普攻，站位与配将才有取舍。
     *
     * 同距并列时的取值口径（必须与 Python 参考实现一致，否则黄金向量会漂）：
     *  - 'id'    ：普攻取 unit_id 字典序最小者（确定性、与旧实现一致）；
     *  - 'order' ：追击取敌方阵列首位（= 旧实现 effectTargets 的 enemies.slice(0,1)）。
     */
    private nearestFoe;
    private effectTargets;
    /**
     * @param skill 发动该效果的战法（用于把 mechanics 记到 reaction 上）；普攻不传。
     * @param opts.noReaction 回击造成的伤害不再触发回击，避免双方互击无限递归。
     */
    private applyEffect;
    private cast;
    private normalAttackEffect;
    run(inputs: readonly UnitInput[]): BattleResult;
}
export declare function runBattle(options: BattleOptions): BattleResult;
