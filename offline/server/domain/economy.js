/**
 * 日产与军饷。读产量和兵力，改资源数字。
 * 不刷怪，不发武将，不加蝴蝶进度。
 */

const STOCK = ['wood', 'iron', 'stone', 'grain', 'gold'];

export function countSoldiers(state) {
  let n = 0;
  for (const army of state.armys || []) {
    for (const c of army.soldiers || []) n += Math.max(0, Number(c) || 0);
  }
  return n;
}

/** 纯演算，给 40 日断言用，不碰存档。 */
export function projectGrain({ grain, yieldPerDay, soldiers, upkeepPerSoldier, days, cap }) {
  const series = [];
  let g = grain;
  const cost = Math.floor(soldiers * upkeepPerSoldier);
  for (let i = 0; i < days; i += 1) {
    g = Math.min(cap, g + yieldPerDay);
    g = Math.max(0, g - cost);
    series.push(g);
  }
  return series;
}

/**
 * 收支流水（P0-3）：每笔资源变动记一条 {day,res,delta,reason}，滚动保留 240 条。
 * 玩家在府库面板看「钱花哪了」的唯一事实来源；delta 为 0 不记。
 */
export function recordRes(state, res, delta, reason, day) {
  const d = Math.round(Number(delta) || 0);
  if (!d) return;
  if (!Array.isArray(state.resLedger)) state.resLedger = [];
  state.resLedger.push({
    day: Math.floor(Number(day ?? state.clock?.day) || 1),
    res: String(res), delta: d, reason: String(reason || ''),
  });
  if (state.resLedger.length > 240) state.resLedger.splice(0, state.resLedger.length - 240);
}

export function applyDays(state, cfg, days, rules) {
  if (days <= 0) return { days: 0, upkeepPaid: 0, soldiers: countSoldiers(state) };
  const r = state.roleRes;
  const cap = r.depot_capacity || 1000000;
  const limit = cfg.basic.role?.decree_limit ?? 20;
  const decreePerDay = rules.decreePerDay ?? 30;
  const cost = Math.floor(
    countSoldiers(state) * (rules.upkeepPerSoldier ?? 0)
    * (1 + (Number(rules.upkeepPct) || 0) / 100),
  );
  const startDay = Math.floor(Number(state.clock?.day) || 1);
  // ★ P1：委任岗位真实生效——resBonus[k] 为该资源产量加成百分比（panels.js 计算，红线 ≤30%）
  const resBonus = rules.resBonus || {};
  /* 修 U17：俸禄只由 city-econ.loyaltyTick 的「逐将旬俸」结算一次。
     旧实现在此另按在岗人数每日再扣一份（filledPosts × 30），与旬俸并行扣费，
     造成双轨重复支出、欠饷与忠诚判定失真。保留 filledPosts 供流水/面板展示口径，
     但这里不再产生第二笔支出（salaryPaid 恒 0，流水仍如实记 0）。 */
  const filledPosts = Object.values(state.interior?.posts || {}).filter((v) => Number(v) > 0).length;
  const salaryPerDay = 0;
  const before = {};
  for (const k of STOCK) before[k] = Number(r[k]) || 0;
  let upkeepPaid = 0;
  let salaryPaid = 0;
  for (let i = 0; i < days; i += 1) {
    for (const k of STOCK) {
      const base = Math.floor(r[`${k}_yield`] || 0);
      const gain = base > 0 ? Math.floor(base * (1 + (Number(resBonus[k]) || 0) / 100)) : base;
      r[k] = Math.min(cap, (r[k] || 0) + gain);
    }
    const pay = Math.min(r.grain || 0, cost);
    r.grain -= pay;
    upkeepPaid += pay;
    const sal = Math.min(r.gold || 0, salaryPerDay);
    r.gold -= sal;
    salaryPaid += sal;
    r.decree = Math.min(limit, (r.decree || 0) + decreePerDay);
  }
  // 流水：按整段结算记净变化。gold 拆成「属地日产」与「委任俸禄」两笔，
  //   两笔之和恒等于实际净变化（满仓截断也如实入账）；其余资源记一笔净差。
  for (const k of STOCK) {
    let delta = (Number(r[k]) || 0) - before[k];
    if (k === 'gold') delta += salaryPaid;   // 先把俸禄从净差里摘出来
    if (delta) recordRes(state, k, delta, '属地日产', startDay);
  }
  if (upkeepPaid) recordRes(state, 'grain', -upkeepPaid, '军饷', startDay + days - 1);
  if (salaryPaid) recordRes(state, 'gold', -salaryPaid, '委任俸禄', startDay + days - 1);
  return { days, upkeepPaid, salaryPaid, soldiers: countSoldiers(state) };
}

/** 曲辕犁：磨坊（加成类型 19）的产量额外 +20%。其他设施不加。 */
export function facilityBonus(state, additionType, rules) {
  const bp = rules?.blueprint;
  if (!bp) return 0;
  if (additionType !== bp.facilityAddition) return 0;
  if (!state.campaign?.blueprints?.includes(bp.id)) return 0;
  return bp.bonus || 0;
}
