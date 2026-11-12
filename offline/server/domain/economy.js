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
  const cost = Math.floor(countSoldiers(state) * (rules.upkeepPerSoldier ?? 0));
  const startDay = Math.floor(Number(state.clock?.day) || 1);
  const before = {};
  for (const k of STOCK) before[k] = Number(r[k]) || 0;
  let upkeepPaid = 0;
  for (let i = 0; i < days; i += 1) {
    for (const k of STOCK) {
      const gain = Math.floor(r[`${k}_yield`] || 0);
      r[k] = Math.min(cap, (r[k] || 0) + gain);
    }
    const pay = Math.min(r.grain || 0, cost);
    r.grain -= pay;
    upkeepPaid += pay;
    r.decree = Math.min(limit, (r.decree || 0) + decreePerDay);
  }
  // 流水：按整段结算记净变化；满仓被截断也如实记录（delta < 理论日产）
  for (const k of STOCK) {
    const delta = (Number(r[k]) || 0) - before[k];
    if (delta) recordRes(state, k, delta, '属地日产', startDay);
  }
  if (upkeepPaid) recordRes(state, 'grain', -upkeepPaid, '军饷', startDay + days - 1);
  return { days, upkeepPaid, soldiers: countSoldiers(state) };
}

/** 曲辕犁：磨坊（加成类型 19）的产量额外 +20%。其他设施不加。 */
export function facilityBonus(state, additionType, rules) {
  const bp = rules?.blueprint;
  if (!bp) return 0;
  if (additionType !== bp.facilityAddition) return 0;
  if (!state.campaign?.blueprints?.includes(bp.id)) return 0;
  return bp.bonus || 0;
}
