/** 战报渲染与不变量校验：稳定性测试与线上对账共用。 */
import type { BattleEvent, BattleResult, UnitInput } from './types.js';
export declare function toText(result: BattleResult, maxEvents?: number): string;
export interface InvariantReport {
    ok: boolean;
    problems: string[];
    checks: Record<string, number>;
}
/** 检查一场战斗的全部可验证不变量。任何一条失败都说明内核不稳定。 */
export declare function validateInvariants(result: BattleResult, units: readonly UnitInput[], roundLimit: number): InvariantReport;
/** 事件流结构摘要，用于跨语言 / 跨版本回归比对 */
export declare function eventSummary(events: readonly BattleEvent[]): Record<string, number>;
