/**
 * 演示剧本构造器 —— 与 battle-kit/kernel/scenario.py 对齐。
 *
 * 名字、战法名、伤害率、效果术语全部取自包内配置，不编造新数值；
 * 属性与概率来自配置的 E2 槽位。后续换皮只需替换配置里的名录与数值。
 */
import type { BattleConfig, UnitInput } from './types.js';
/** 构建两支阵容；所有可证部分来自 cfg，未解部分显式标 E2 */
export declare function buildArmies(cfg: BattleConfig, perSide?: number, level?: number, troops?: number): UnitInput[];
