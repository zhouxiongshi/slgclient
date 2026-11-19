/**
 * 沙盘里程碑与终局常量（零依赖叶子）。
 *
 * ★ 2026-11-20 自迭代第二轮：这组数值原本写在 strategy.js 里，但 panels.js 也要用
 *   （面板要显示「下一个目标：12/18 城」），而 panels 不能 import strategy（会成环）。
 *   抽成叶子后，结算与研究面板用同一份定义，不会出现「面板说 18、结算按 20」的双轨。
 *
 * 只放常量，不放逻辑：判定与发奖在 strategy.stageGoalTick，展示在 panels.panelState。
 */

/** 阶段目标：达成即发实际收益（旧版只播一条文字，18 城之后玩家无事可做）。 */
export const STAGE_GOALS = [
  { id: 'foothold', at: 6, title: '立足', hint: '拿下第 6 座城——你已经不是流寇，是一方势力了。',
    gold: 3000, fame: 2 },
  { id: 'separatist', at: 10, title: '割据', hint: '10 城在手，州郡侧目。诸侯开始把你写进讨伐名单。',
    gold: 6000, fame: 3 },
  { id: 'hegemon', at: 18, title: '争雄', hint: '18 城，天下三分有其名。下一步就是州治。',
    gold: 12000, fame: 5, seats: 2 },
  { id: 'overlord', at: 30, title: '霸业', hint: '30 城。剩下的诸侯加起来也没你大了——该收尾了。',
    gold: 24000, fame: 8, seats: 4 },
];

/** 终局线：全图 72 城的 62.5%。达成记 sandboxEnding（不硬中断，可继续经营）。 */
export const UNIFY_CITIES = 45;
export const SANDBOX_ENDING = { id: 'unify', title: '天下一统', hint: '四海归一，霸业已成。' };

/** 下一个未达成的阶段目标（纯展示用；已全达成返回终点线）。 */
export function nextStageGoal(owned, stages = {}) {
  const n = Math.max(0, Number(owned) || 0);
  for (const s of STAGE_GOALS) {
    if (!stages[s.id] && n < s.at) return { ...s, need: s.at - n };
  }
  for (const s of STAGE_GOALS) if (!stages[s.id]) return { ...s, need: Math.max(0, s.at - n) };
  return { id: 'unify', at: UNIFY_CITIES, title: SANDBOX_ENDING.title, hint: SANDBOX_ENDING.hint, need: Math.max(0, UNIFY_CITIES - n) };
}
