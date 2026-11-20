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
  /* ★ 2026-11-20：原为 30 城「霸业」，但实测「会打 + 会管理」的玩家
     400 旬峰值只有 24 城（再往上军粮养不起：1 兵 1 旬 1 粮），
     30 城是永远够不到的台阶。改为 22 城，作为终局前最后一级。 */
  { id: 'overlord', at: 22, title: '封王', hint: '22 城。州郡尽归节制，只差最后几座坚城。',
    gold: 24000, fame: 8, seats: 4 },
];

/** 沙盘终局线：全图 72 城的 1/3。
 *  ★ 2026-11-20：原为 45 城（62.5%），实测任何玩法都够不到（主动 400 旬峰值 24 城）。
 *  24 城是「会打 + 会管理」玩家在 400 旬内确实能摸到的线。
 *  这是**沙盘终局**不是全图统一：达成记 sandboxEnding，不硬中断，可继续经营。 */
export const UNIFY_CITIES = 24;
export const SANDBOX_ENDING = { id: 'unify', title: '定鼎', hint: '二十四城在手，天下格局已定。可继续经营，完成真正的四海归一。' };

/** 下一个未达成的阶段目标（纯展示用；已全达成返回终点线）。 */
export function nextStageGoal(owned, stages = {}) {
  const n = Math.max(0, Number(owned) || 0);
  for (const s of STAGE_GOALS) {
    if (!stages[s.id] && n < s.at) return { ...s, need: s.at - n };
  }
  for (const s of STAGE_GOALS) if (!stages[s.id]) return { ...s, need: Math.max(0, s.at - n) };
  return { id: 'unify', at: UNIFY_CITIES, title: SANDBOX_ENDING.title, hint: SANDBOX_ENDING.hint, need: Math.max(0, UNIFY_CITIES - n) };
}
