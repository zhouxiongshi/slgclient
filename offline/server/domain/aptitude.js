/**
 * 兵种适性 —— 唯一权威数值源（M4-13）。
 *
 * 背景：过去「适性 X%」只是界面上的一个数字，由 city-econ.js 的 armsApt()
 * 算出来给 panels / strategy 展示，战斗内核的 Hero 里根本没有适性字段，
 * battle.js 的 makeHero() 也从没读过它 —— 也就是说这条规则在战斗中不生效。
 * M4-13 把它抽成零依赖叶子模块，展示层与战斗结算共同引用同一个函数，
 * 保证「界面看到的 X%」就是「战斗里乘上去的系数」（U08 描述=计算同源）。
 *
 * 口径（沿用 M4-10 三国志11 百分制基线，不另造 S/A/B/C）：
 *   盾(1) 看统率/防御、弓(2) 看智力/策略、骑(3) 看武力，
 *   0~100 线性映射到 85%~115%，下限锁 100%（只奖励不惩罚，
 *   保住既有首战平衡基线；要改成双向惩罚须同步 empire.test.js）。
 *
 * 零依赖：不得 import strategy / panels / battle / city-econ，避免任何环。
 */
export const ARMS_STAT = { 1: 'defense', 2: 'strategy', 3: 'force' };

/** 兵种适性系数（1.00~1.15）。armsIdx 为兵种 id 1/2/3（4~9 归入最近的主兵种）。 */
export function armsApt(g, armsIdx) {
  const idx = Number(armsIdx) || 1;
  const key = ARMS_STAT[idx] || ({ 4: 'defense', 5: 'strategy', 6: 'force', 7: 'defense', 8: 'strategy', 9: 'force' })[idx] || 'defense';
  const v = Number(g?.[key]) || 0;
  return Math.max(1, Math.min(1.15, 0.85 + 0.3 * (v / 100)));
}

/** 该武将在三个主兵种里的适性（展示用，与战斗同源）。 */
export function aptTriple(g) {
  return [1, 2, 3].map((i) => Math.round(armsApt(g, i) * 100));
}

/** 最擅长的兵种 id 与百分比，用于「换兵种可提升」提示。 */
export function bestArms(g) {
  let best = 1;
  let value = 0;
  for (const i of [1, 2, 3]) {
    const v = armsApt(g, i);
    if (v > value) { value = v; best = i; }
  }
  return { arms: best, pct: Math.round(value * 100) };
}
