/**
 * 征兵领域口径（2026-11-18）—— 玩家 `army.conscript` 的 need 计算、兵种差异化、
 * 一键征满分配、带兵上限校验，统一收敛到本零环叶子，供 handlers 变薄调用。
 *
 * 纪律：
 *  - 纯函数、确定性、无随机；只吃 cfg / cnts / officer，不碰 state 写入。
 *  - 不改 conf/json/basic.json 原表（史载/原版逐字不动），兵种系数在派生层。
 *  - 带兵上限唯一源 official-rank.slotCapOf（等级+官阶），不在此另立公式。
 */

import { slotCapOf } from './official-rank.js';

/** 三兵种：0 盾步 / 1 弓兵 / 2 骑兵（与 army.soldiers/cnts 槽位、aptitude 适性同源）。 */
export const ARMS_NAMES = ['盾步', '弓兵', '骑兵'];

/**
 * 兵种资源消耗系数（★ 2026-11-18 用户诉求：不同兵种资源消耗要区分）。
 * 以 basic.json conscript 单价为基准乘以下表，盾步为基准 1.0。
 *  - 弓兵：铁耗 +20%、木耗 +10（弓弩）；
 *  - 骑兵：铁耗 +60%、粮耗 +50%、金耗 ×2（战马与草料最贵）。
 * 资源键与 basic.json 一致；未列的键按 1.0。石耗在调用方按派生规则（铁的一半）算后再乘系数。
 */
export const ARMS_COST_MUL = [
  { wood: 1, iron: 1, stone: 1, grain: 1, gold: 1 },        // 盾步
  { wood: 1.1, iron: 1.2, stone: 1, grain: 1, gold: 1.1 },  // 弓兵
  { wood: 1, iron: 1.6, stone: 1.2, grain: 1.5, gold: 2 },  // 骑兵
];

const RES = ['wood', 'iron', 'stone', 'grain', 'gold'];

/** 由 basic.json conscript 取基准单价；石耗派生 = max(5, ⌊铁/2⌋)（原表 cost_stone=0 不改）。 */
export function baseUnitCost(conscriptCfg = {}) {
  const iron = conscriptCfg.cost_iron ?? 10;
  const stone = Number(conscriptCfg.cost_stone) > 0
    ? Number(conscriptCfg.cost_stone)
    : Math.max(5, Math.floor(iron / 2));
  return {
    wood: conscriptCfg.cost_wood ?? 10,
    iron,
    stone,
    grain: conscriptCfg.cost_grain ?? 10,
    gold: conscriptCfg.cost_gold ?? 1,
  };
}

/** 四舍五入到整数（每兵成本最终按整兵整资源结算）。 */
function r(n) { return Math.max(0, Math.round(Number(n) || 0)); }

/**
 * 按三槽兵力算总消耗。返回 { need:{wood,iron,stone,grain,gold}, perSlot:[{...},...], total }。
 * perSlot[i] 是该槽「单兵」成本（已乘兵种系数并取整），用于 UI 明细；
 * need 是三槽合计（再乘势力特技 recruitPct）。
 */
export function conscriptNeed(cnts, conscriptCfg = {}, trait = {}) {
  const base = baseUnitCost(conscriptCfg);
  const triple = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(cnts?.[i]) || 0)));
  const perSlot = ARMS_COST_MUL.map((mul) => Object.fromEntries(
    RES.map((k) => [k, r(base[k] * (mul[k] ?? 1))]),
  ));
  const raw = Object.fromEntries(RES.map((k) => [k,
    triple.reduce((s, n, i) => s + n * perSlot[i][k], 0),
  ]));
  const pct = Number(trait?.recruitPct) || 0;
  const need = Object.fromEntries(RES.map((k) => [k,
    pct ? Math.max(1, Math.round(raw[k] * (1 + pct / 100))) : raw[k],
  ]));
  return { need, perSlot, total: triple.reduce((s, n) => s + n, 0) };
}

/**
 * 校验每槽兵力不超「该槽武将等级+官阶」带兵上限。
 * @param cnts 本次要征的三槽数量
 * @param army 队伍（soldiers 现有兵力、con_cnts 在途兵力、generals 武将 id）
 * @param generalById (id)=>officer 对象（含 level/merit）
 * @returns { ok, slot?, cap?, have?, caps:[...] }
 */
export function checkSlotCaps(cnts, army, generalById) {
  const caps = [0, 1, 2].map((i) => {
    const gid = (army?.generals || [])[i];
    const officer = gid ? generalById(gid) : null;
    return officer ? slotCapOf(officer) : slotCapOf(null);
  });
  for (let i = 0; i < 3; i += 1) {
    const add = Math.max(0, Math.floor(Number(cnts?.[i]) || 0));
    const have = Math.max(0, Math.floor(Number(army?.soldiers?.[i]) || 0))
      + Math.max(0, Math.floor(Number(army?.con_cnts?.[i]) || 0));
    if (have + add > caps[i]) {
      return { ok: false, slot: i, cap: caps[i], have, add, caps };
    }
  }
  return { ok: true, caps };
}

/**
 * 一键征满分配：把 want 总量平分给「有将、非行军」的槽位，受每槽剩余可征额度约束。
 * 平分后有余额（不能整除）按槽序依次 +1，尽量用满 want。
 * @returns {cnts:[...], assigned} —— cnts 为三槽应征数量
 */
export function splitEven(want, army, generalById, opts = {}) {
  const marching = !!opts.marching;
  const eligible = [0, 1, 2].filter((i) => {
    const gid = (army?.generals || [])[i];
    return gid && generalById(gid) && !marching;
  });
  const cnts = [0, 0, 0];
  if (!eligible.length || marching || want <= 0) return { cnts, assigned: 0 };
  const room = eligible.map((i) => {
    const gid = army.generals[i];
    const officer = generalById(gid);
    const cap = officer ? slotCapOf(officer) : slotCapOf(null);
    const have = Math.max(0, Math.floor(Number(army?.soldiers?.[i]) || 0))
      + Math.max(0, Math.floor(Number(army?.con_cnts?.[i]) || 0));
    return Math.max(0, cap - have);
  });
  let remain = Math.max(0, Math.floor(Number(want) || 0));
  const totalRoom = room.reduce((s, n) => s + n, 0);
  remain = Math.min(remain, totalRoom);
  // 逐轮平分：每轮给还有余额的槽各 +1，直到用尽（want 大时轮数 = 单槽最大 room，可能上万，
  // 故改用「先整除平分、再按余数补齐」的 O(3) 写法）。
  const base = Math.floor(remain / eligible.length);
  eligible.forEach((slot, k) => {
    cnts[slot] = Math.min(room[k], base);
  });
  let left = remain - cnts.reduce((s, n) => s + n, 0);
  for (let k = 0; k < eligible.length && left > 0; k += 1) {
    const slot = eligible[k];
    const can = room[k] - cnts[slot];
    const add = Math.min(can, left);
    cnts[slot] += add;
    left -= add;
  }
  return { cnts, assigned: cnts.reduce((s, n) => s + n, 0) };
}

/**
 * 解甲归田（★ 2026-11-18 用户诉求：征兵满了没法解甲归田）：
 * 从指定队伍的三槽遣散兵力，兵退回驻城 troops（归田），并返还 30% 兵值金
 * （兵值按 2 金/兵，与 failstate.disarmForGold 同口径）。拒绝行军中队伍。
 * 纯计算：返回 { ok, disbanded:[...], refund, perSlotCity }，由 handlers 写回 state。
 * @param disband 三槽要遣散数量（按兵种槽位）
 * @param cityTroops 驻城当前兵力（用于钳制退回后不超上限，null=不钳）
 */
export function planDisarm(disband, army, cityTroops = null, opts = {}) {
  if (opts.marching) return { ok: false, reason: 'marching' };
  const soldiers = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army?.soldiers?.[i]) || 0)));
  const amounts = [0, 1, 2].map((i) => {
    const want = Math.max(0, Math.floor(Number(disband?.[i]) || 0));
    return Math.min(want, soldiers[i]);
  });
  const disbanded = amounts.reduce((s, n) => s + n, 0);
  if (disbanded <= 0) return { ok: false, reason: 'no_troops' };
  const refund = Math.round(disbanded * 2 * 0.3); // 30% 兵值金
  return {
    ok: true,
    disbanded,
    amounts,
    refund,
    remaining: soldiers.map((n, i) => n - amounts[i]),
    returnToCity: disbanded,
  };
}
