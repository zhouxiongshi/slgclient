/**
 * 俘虏处置的名望 / 恶名口径（零依赖叶子，2026-11-16）。
 *
 * 背景：旧实现只有 `state.role.infamy` 一处写入，外交、来投、结局全都不读，
 * 放归 / 处斩因此没有实际后果，与 GDD §7.3「三维人事操作表」和 PRD R-21.5
 * 承诺的「释放 / 处斩分别影响名望」不符。本模块把这条后果定成单一权威，
 * 让「描述 = 计算 = 外交理由链 = 来投公式」四者同源。
 *
 * 纪律：
 *  - 零依赖叶子：不 import 任何模块，不能被上层反向依赖。
 *  - 数值全部来自 GDD 原文，不自创：
 *      · 释放俘虏 → 义理 +、敌方势力 attitude −5（GDD §7.3）
 *      · 处斩 → 所有势力 attitude −15、董卓除外（GDD §7.3 / §5.9）
 *      · 名望量级取事件系统既有 +1~+4 的中位 +2（events.json）
 *  - 态度落账仍走 diplomacy.js 的 adjustAttitudeByEvent（唯一权威口），
 *    本模块只提供常量与计算，不重复实现态度公式。
 */

/** 放归一次的名望增量（点）。 */
export const FAME_PER_RELEASE = 2;

/** 处斩一次记的恶名声数（笔）。 */
export const INFAMY_PER_EXECUTE = 1;

/** 放归对该俘虏原属势力的态度影响（GDD §7.3：敌方势力 attitude −5）。 */
export const ATTITUDE_ON_RELEASE = -5;

/** 处斩对「所有势力」的态度影响，董卓除外（GDD §7.3 / §5.9）。 */
export const ATTITUDE_ON_EXECUTE = -15;

/** 董卓势力 id（GDD §7.3 明示「处斩 attitude −15，董卓除外」）。 */
export const EXEMPT_FACTION_ON_EXECUTE = 'sili';

/** 名望对「在野慕名来投」的贡献上限（点），防止靠放归刷名望把来投率拉满。 */
export const FAME_DEFECT_CAP = 40;

/**
 * 名望 → 来投率增量。沿 `defectTick` 既有口径 rate = min(0.45, 0.03 + fame/700)，
 * 名望每 1 点贡献 1/700 的来投率，封顶 FAME_DEFECT_CAP 点。
 * @param {number} fame 当前名望（state.strategy.fame）
 * @returns {number} 加成后的来投率小数（0~1）
 */
export function defectRateWithFame(baseRate, fame) {
  const effective = Math.max(0, Math.min(FAME_DEFECT_CAP, Number(fame) || 0));
  return Math.min(0.45, (Number(baseRate) || 0) + effective / 700);
}
