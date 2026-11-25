/**
 * 日产与军饷。读产量和兵力，改资源数字。
 * 不刷怪，不发武将，不加蝴蝶进度。
 */

import { knobGet } from './knobs.js';

const STOCK = ['wood', 'iron', 'stone', 'grain', 'gold'];

/* ★ 2026-11-20 欠饷逃兵（用户裁决补闭环）：全局粮池见底时旧实现 `pay = min(grain, cost)`
   只少扣粮、兵力一分不掉，形成「打不动也饿不死」的僵尸大军（400 旬探针里 14998 兵冻结
   150 旬）。这里只补逻辑、不改军粮 0.1 参数：连续欠饷满 3 旬后驻军每旬逃散 2%，与行军
   断粮同口径。粮足即止、兵力自然收敛到城产养得起的规模。 */
const ARREARS_START_DAYS = 30;   // 连续欠饷满 3 旬才开始逃散（给玩家缓冲）
const ARREARS_TICK_DAYS = 10;    // 之后每旬逃散一次
const ARREARS_DESERT_RATE = 0.02;

/** 事件簿追加（与 strategy.recordEvent 同形状）。本模块不 import strategy，防止成环。 */
function recordArrearsEvent(state, text) {
  const st = state?.strategy;
  if (!st) return;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

function arrearsNotice(state, ctx, text) {
  recordArrearsEvent(state, text);
  ctx?.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg: `【军饷】${text}`, time: Date.now() });
}

/** 驻城军逃散：按槽位比例扣，跳过行军中的队伍（那部分由 armySupplyTick 的城库链管）。 */
function desertGarrison(state) {
  let lost = 0;
  for (const a of state.armys || []) {
    if (a.marchId || !Array.isArray(a.soldiers)) continue;
    a.soldiers = a.soldiers.map((v) => {
      const n = Math.max(0, Number(v) || 0);
      if (n <= 0) return 0;
      const next = Math.floor(n * (1 - ARREARS_DESERT_RATE));
      lost += n - next;
      return next;
    });
  }
  return lost;
}

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

export function applyDays(state, cfg, days, rules, ctx) {
  if (days <= 0) return {
    days: 0, upkeepPaid: 0, soldiers: countSoldiers(state),
    arrearsDays: Math.max(0, Math.floor(Number(state.roleRes?.grainArrearsDays) || 0)), deserters: 0,
  };
  const r = state.roleRes;
  const cap = r.depot_capacity || 1000000;
  /* ★ P61-B-S3① 政令旬预算：旧制每日 +2、上限 20，实测 72 旬恒 20，等于没有约束。
     现在每跨一旬发 8 点、最多存 12 点，要塞（2~3 点）与审计（2 点）才成为真取舍。 */
  const limit = Math.min(12, cfg.basic.role?.decree_limit ?? 20);
  const decreePerTurn = 8;
  const turnDaysForBudget = Math.max(1, Number(knobGet(state, 'turnDays')) || 10);
  /* 序章沿用章节军饷。玩家已有城之后改按参数表：每兵每天 0.1 粮，和城产对得上。 */
  const ownsCity = Object.values(state.strategy?.cities || {}).some((row) => row?.owner === 'player');
  const perSoldier = ownsCity
    ? (Number(knobGet(state, 'grainPerSoldierDay')) || 0.1)
    : (rules.upkeepPerSoldier ?? 0);
  const upkeepMul = 1 + (Number(rules.upkeepPct) || 0) / 100;
  let cost = Math.floor(countSoldiers(state) * perSoldier * upkeepMul);
  let arrearsDays = Math.max(0, Math.floor(Number(r.grainArrearsDays) || 0));
  const arrearsBefore = arrearsDays;
  let deserters = 0;
  let warnFirst = false;
  let desertFirst = false;
  let desertPeriodic = false;
  let recovered = false;
  const endDay = Math.floor(Number(state.clock?.day) || 1);
  const startDay = Math.max(1, endDay - Math.max(0, days) + 1);
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
  let goldYielded = 0;
  for (let i = 0; i < days; i += 1) {
    for (const k of STOCK) {
      const base = Math.floor(r[`${k}_yield`] || 0);
      const gain = base > 0 ? Math.floor(base * (1 + (Number(resBonus[k]) || 0) / 100)) : base;
      if (k === 'gold' && gain > 0) {
        goldYielded += Math.max(0, Math.min(gain, cap - (r.gold || 0)));
      }
      r[k] = Math.min(cap, (r[k] || 0) + gain);
    }
    const pay = Math.min(r.grain || 0, cost);
    r.grain -= pay;
    upkeepPaid += pay;
    if (pay < cost) {
      if (arrearsDays === 0) warnFirst = true;
      arrearsDays += 1;
      /* 连续欠饷满 3 旬起，每旬逃散 2%。逃兵后重算 cost——兵少了需求同步下降，
         自然收敛到「城产粮养得起的规模」，不会无限逃到 0，也不会永远卡在僵尸大军。 */
      if (arrearsDays >= ARREARS_START_DAYS
          && (arrearsDays - ARREARS_START_DAYS) % ARREARS_TICK_DAYS === 0) {
        const lost = desertGarrison(state);
        if (lost > 0) {
          deserters += lost;
          if (arrearsDays === ARREARS_START_DAYS) desertFirst = true;
          else if ((arrearsDays - ARREARS_START_DAYS) % (ARREARS_TICK_DAYS * 10) === 0) desertPeriodic = true;
          cost = Math.floor(countSoldiers(state) * perSoldier * upkeepMul);
        }
      }
    } else if (arrearsDays > 0) {
      recovered = true;
      arrearsDays = 0;
    }
    const sal = Math.min(r.gold || 0, salaryPerDay);
    r.gold -= sal;
    salaryPaid += sal;
  }
  const turn0 = Math.floor((startDay - 1) / turnDaysForBudget);
  const turn1 = Math.floor((endDay - 1) / turnDaysForBudget);
  const crossedTurns = Math.max(0, turn1 - turn0);
  if (crossedTurns > 0) {
    const decreeBefore = Math.max(0, Math.floor(Number(r.decree) || 0));
    r.decree = Math.min(limit, decreeBefore + decreePerTurn * crossedTurns);
    if (r.decree > decreeBefore) recordRes(state, 'decree', r.decree - decreeBefore, '旬预算', endDay);
  }
  /* 本作设计 固定支出闸：有城之后，城防与俸饷约占金产的 35%（落在 30%–45%）。 */
  let maintainPaid = 0;
  if (ownsCity && goldYielded > 0) {
    const due = Math.round(goldYielded * 0.35);
    maintainPaid = Math.min(r.gold || 0, due);
    r.gold -= maintainPaid;
  }
  /* ★ OP-01 国库沉淀税（本作设计 固定支出闸的金侧补充，2026-11-15 产品决策）：
     真链路挂机 60 旬现金 12,371 → 172,501（≈2,690 金/旬，几乎线性、只进不出），
     扩张后可达 ≈14,600 金/旬，是 NPC 田赋 600~800 的约 20 倍。根因不是产量超标，
     而是金侧缺少随存量增长的支出。对「超出 10 旬周转金」的沉淀部分按旬收税，
     让存量从无限线性增长变为向稳态收敛：
       - 免税额 = 10 × 每旬金毛产，自动随规模缩放，不惩罚开局也不惩罚扩张；
       - 税率走参数表 `goldHoardTaxPct`，GM 设 0 即关闭阀门；
       - 只影响存量，不动产量、原表、战斗数值；每笔都进府库流水（P1 可解释）。 */
  let hoardTaxPaid = 0;
  const taxPct = Number(knobGet(state, 'goldHoardTaxPct')) || 0;
  if (ownsCity && goldYielded > 0 && taxPct > 0) {
    const turnDays = Math.max(1, Number(knobGet(state, 'turnDays')) || 10);
    const perTurnYield = (goldYielded / days) * turnDays;
    /* ★ P61-B-S3②：免税额 10 旬 → 3 旬。旧值让 17.5 万金平台值仍是单城投资的数百倍，
       钱不再构成取舍；收紧后沉淀税真正随存量回收（GM 设 0 仍可关闭）。 */
    const exempt = Math.floor(perTurnYield * 3);
    const excess = Math.max(0, (Number(r.gold) || 0) - exempt);
    hoardTaxPaid = Math.min(Number(r.gold) || 0,
      Math.floor(excess * (taxPct / 100) * (days / turnDays)));
    r.gold -= hoardTaxPaid;
  }
  /* ★ P61-B-S3③ 石料露天堆腐：石没有随存量增长的回收口，72 旬实测撞 20 万仓容。
     超出「8 旬石毛产（至少 2 万）」的部分每旬堆腐 20%，形成温和的存量税，
     鼓励转城防/折军工，而不是把石头堆到仓容上限。 */
  let stoneRotPaid = 0;
  const stoneExempt = Math.max(20000, Math.floor((Number(r.stone_yield) || 0) * 8));
  const stoneExcess = Math.max(0, Math.floor(Number(r.stone) || 0) - stoneExempt);
  if (stoneExcess > 0) {
    stoneRotPaid = Math.min(stoneExcess, Math.floor(stoneExcess * 0.2 * (days / turnDaysForBudget)));
    r.stone -= stoneRotPaid;
  }
  // 流水：按整段结算记净变化。gold 拆成「属地日产」与各项支出，
  //   之和恒等于实际净变化（满仓截断也如实入账）；其余资源记一笔净差。
  for (const k of STOCK) {
    let delta = (Number(r[k]) || 0) - before[k];
    if (k === 'gold') delta += salaryPaid + maintainPaid + hoardTaxPaid;
    if (k === 'stone') delta += stoneRotPaid;
    if (delta) recordRes(state, k, delta, '属地日产', startDay);
  }
  if (upkeepPaid) recordRes(state, 'grain', -upkeepPaid, '军饷', startDay + days - 1);
  if (salaryPaid) recordRes(state, 'gold', -salaryPaid, '委任俸禄', startDay + days - 1);
  if (maintainPaid) recordRes(state, 'gold', -maintainPaid, '城防俸饷', startDay + days - 1);
  if (hoardTaxPaid) recordRes(state, 'gold', -hoardTaxPaid, '国库沉淀税', startDay + days - 1);
  if (stoneRotPaid) recordRes(state, 'stone', -stoneRotPaid, '石料堆腐', startDay + days - 1);
  r.grainArrearsDays = arrearsDays;
  if (warnFirst) {
    arrearsNotice(state, ctx, '国库粮尽，军饷欠付。连续 3 旬无粮，驻军将逃散；请减兵、运粮或扩城。');
  }
  if (desertFirst) {
    arrearsNotice(state, ctx, `军饷欠付满 3 旬，驻军逃散 ${deserters} 人。粮足即止。`);
  } else if (desertPeriodic) {
    arrearsNotice(state, ctx, `军饷欠付已 ${Math.floor(arrearsDays / 10)} 旬，驻军再逃散 ${deserters} 人。`);
  }
  if (recovered) arrearsNotice(state, ctx, '粮仓复足，军饷恢复正常，逃散已止。');
  return {
    days, upkeepPaid, salaryPaid, maintainPaid, hoardTaxPaid, stoneRotPaid,
    soldiers: countSoldiers(state), arrearsDays, arrearsBefore, deserters,
  };
}

/** 曲辕犁：磨坊（加成类型 19）的产量额外 +20%。其他设施不加。 */
export function facilityBonus(state, additionType, rules) {
  const bp = rules?.blueprint;
  if (!bp) return 0;
  if (additionType !== bp.facilityAddition) return 0;
  if (!state.campaign?.blueprints?.includes(bp.id)) return 0;
  return bp.bonus || 0;
}
