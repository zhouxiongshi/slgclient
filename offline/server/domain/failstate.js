/**
 * 失败态与结局判定（GDD §3.4 / §3.5 第二轮补丁）。
 *
 * 恢复感原则（写死）：任何失败态都必须给「至少一条能活下来的路」，哪怕很贵。
 * 玩家可以输，但不能「卡住」。所以本模块一半是判定，另一半是出路动作。
 *
 * 零依赖叶子：只读 state，不 import strategy/city-econ（它们引用本模块做旬结算时不成环）。
 * 写资源流水复用 economy.recordRes 的形状（自带 recordRes 副本，理由同 supply.js）。
 */

const CAP = 20000;
const GRAIN_GOLD_RATE = 0.5;      // 卖粮市价：1 粮 = 0.5 金（GDD §9.1 资源锚的中位换算）
const SELL_CAP_PER_TURN = 2000;   // 每旬卖粮上限（防止套利刷钱）
const DISARM_REFUND = 0.3;        // 裁军返还：兵值金 ×30%（GDD §3.4）
const MERC_COST_MUL = 3;          // 雇佣兵：紧急征兵成本 ×3（GDD §3.4「贵 3 倍」）

function recordRes(state, res, delta, reason, day) {
  const d = Math.round(Number(delta) || 0);
  if (!d) return;
  if (!Array.isArray(state.resLedger)) state.resLedger = [];
  state.resLedger.push({ day: Math.floor(Number(day ?? state.clock?.day) || 1), res: String(res), delta: d, reason: String(reason || '') });
  if (state.resLedger.length > 240) state.resLedger.splice(0, state.resLedger.length - 240);
}

function recordEvent(state, text) {
  const st = state?.strategy;
  if (!st) return;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

function ownedCities(st) {
  return Object.keys(st?.cities || {}).filter((id) => st.cities[id].owner === 'player');
}

/* -------------------------------------------------------------- 判定层 */

/**
 * 四种失败态的当前判定（纯读，旬结算与视图共用）。
 * 返回 { bankrupt, troopsStarved:[cityId], noGeneral, capitalLost, actions:[...] }。
 * actions：每个失败态至少一条出路（文案给界面，动成本模块的 do* 函数）。
 */
export function failstates(state) {
  const st = state?.strategy;
  if (!st) return { bankrupt: false, troopsStarved: [], noGeneral: false, capitalLost: false, actions: [] };
  const r = state.roleRes || {};
  const owned = ownedCities(st);
  // 破产：金 ≤ 0 且粮 < 500（GDD §3.4；本作金被钳在 ≥0，所以 0 即破产线）
  const bankrupt = (Number(r.gold) || 0) <= 0 && (Number(r.grain) || 0) < 500;
  // 兵尽：城守军 < 200 且无在途增援（GDD §3.4，逐城列出，返回数字 id）
  const troopsStarved = owned.filter((id) => (Number(st.cities[id].troops) || 0) < 200).map(Number);
  // 无将：全部队伍都没有可用武将（出征前 GDD 判定；这里给全局视图）
  const noGeneral = (state.armys || []).length > 0
    && (state.armys || []).every((a) => (a.generals || []).every((g) => !g));
  // 都城失陷：都城已不是玩家的（supply.js 的 exempt 语义与此一致：亡国流程不再叠加断粮罚）
  const capitalLost = !!st.playerCity && st.cities[st.playerCity]?.owner !== 'player';
  const actions = [];
  if (bankrupt) actions.push({ kind: 'disarm', label: '裁军（返还 30% 兵值金）' }, { kind: 'sellGrain', label: '卖粮换金' });
  if (troopsStarved.length) actions.push({ kind: 'emergencyConscript', label: '紧急征兵（民心 −10）' }, { kind: 'mercenary', label: '雇雇佣兵（贵 3 倍）' });
  if (noGeneral) actions.push({ kind: 'standIn', label: '自动生成代将' });
  if (capitalLost) actions.push({ kind: 'relocate', label: '迁都（保留 50% 资源）' });
  return { bankrupt, troopsStarved, noGeneral, capitalLost, actions };
}

/* -------------------------------------------------------------- 出路动作 */

/** 裁军：从指定队伍遣散 count 兵，返还 30% 兵值金（兵值按征兵价 2 金/兵折算）。 */
export function disarmForGold(state, ctx, { armyId, count }) {
  const army = (state.armys || []).find((a) => a.id === Number(armyId));
  if (!army) return { ok: false, reason: 'no_army' };
  const n = Math.max(0, Math.min(Math.floor(Number(count) || 0), Math.floor(Number(army.soldiers?.[0]) || 0)));
  if (n <= 0) return { ok: false, reason: 'no_troops' };
  const refund = Math.round(n * 2 * DISARM_REFUND);
  army.soldiers[0] -= n;
  const r = state.roleRes;
  r.gold = (r.gold || 0) + refund;
  const day = Math.floor(Number(state.clock?.day) || 1);
  recordRes(state, 'gold', refund, `裁军返还·${n} 兵`, day);
  recordEvent(state, `裁军 ${n} 兵，返还兵值金 ${refund}（30%）。`);
  ctx?.push?.('roleRes.push', { ...state.roleRes });
  return { ok: true, disbanded: n, refund, soldiers: army.soldiers[0] };
}

/** 卖粮：粮 → 金（1 粮 = 0.5 金），每旬上限 2000 粮，防套利。 */
export function sellGrain(state, ctx, { grain }) {
  const r = state.roleRes;
  const day = Math.floor(Number(state.clock?.day) || 1);
  const turnKey = `t${state.strategy?.turn ?? 0}`;
  if (!state.market) state.market = {};
  if (state.market.sellTurn !== turnKey) {
    state.market.sellTurn = turnKey;
    state.market.sold = 0;
  }
  const room = Math.max(0, SELL_CAP_PER_TURN - (state.market.sold || 0));
  const n = Math.max(0, Math.min(Math.floor(Number(grain) || 0), Math.floor(r.grain || 0), room));
  if (n <= 0) return { ok: false, reason: room <= 0 ? 'turn_cap' : 'no_grain', room };
  const gold = Math.floor(n * GRAIN_GOLD_RATE);
  r.grain -= n;
  r.gold = (r.gold || 0) + gold;
  state.market.sold = (state.market.sold || 0) + n;
  recordRes(state, 'grain', -n, '卖粮', day);
  recordRes(state, 'gold', gold, `卖粮·${n} 粮`, day);
  recordEvent(state, `卖粮 ${n}，得金 ${gold}（本旬还可在卖 ${Math.max(0, SELL_CAP_PER_TURN - state.market.sold)}）。`);
  ctx?.push?.('roleRes.push', { ...state.roleRes });
  return { ok: true, grain: n, gold, roomLeft: Math.max(0, SELL_CAP_PER_TURN - state.market.sold) };
}

/** 紧急征兵 / 雇雇佣兵（GDD §3.4 兵尽出路）：不计兵源上限，民心 −10；雇佣兵再贵 3 倍。 */
export function emergencyConscript(state, ctx, { cityId, count, mercenary = false }) {
  const st = state?.strategy;
  const id = Number(cityId);
  const row = st?.cities?.[id];
  if (!row || row.owner !== 'player') return { ok: false, reason: 'not_own_city' };
  const n = Math.max(1, Math.floor(Number(count) || 0));
  const goldPer = 2 * (mercenary ? MERC_COST_MUL : 1);
  const cost = n * goldPer;
  const r = state.roleRes;
  if ((Number(r.gold) || 0) < cost) return { ok: false, reason: 'no_gold', cost };
  const day = Math.floor(Number(state.clock?.day) || 1);
  const econ = st.cityEcon?.[id];
  r.gold -= cost;
  recordRes(state, 'gold', -cost, mercenary ? `雇佣兵·${n}` : `紧急征兵·${n}`, day);
  row.troops = (Number(row.troops) || 0) + n;
  if (econ) econ.morale = Math.max(0, (econ.morale ?? 60) - 10);   // 强征伤民心
  recordEvent(state, `${mercenary ? '雇雇佣兵' : '紧急征兵'} ${n} 入驻城防（耗金 ${cost}，民心 −10）。`);
  ctx?.push?.('roleRes.push', { ...state.roleRes });
  return { ok: true, count: n, cost, troops: row.troops, mercenary: !!mercenary };
}

/** 代将（GDD §3.4 兜底，不是玩法）：五维 50、无战法、不可培养、不触发宿命。
 *  返回的武将直接塞进队伍空槽；在有名将可用的城里玩家会主动换掉它。 */
export function makeStandInGeneral(state, cityId) {
  const st = state?.strategy;
  const cid = Number(cityId) || st?.playerCity || 1;
  const id = (state.standInSeq = (state.standInSeq || 0) + 1);
  const g = {
    id: 900000 + id,                       // 代将专用号段，与常规武将不混
    cfgId: 0,
    name: `代将${id}`,
    isStandIn: true,                       // battle.js makeHero 按此给五维 50
    level: 1, star: 1, exp: 0,
    cityId: cid,
    loyal: 100,                            // 代将无叛逃语义
    skills: [],
  };
  return g;
}

/** 迁都（GDD §3.4 都城失陷出路）：迁往任一己方城，保留 50% 资源。 */
export function relocateCapital(state, ctx, { cityId }) {
  const st = state?.strategy;
  const id = Number(cityId);
  const row = st?.cities?.[id];
  if (!row || row.owner !== 'player') return { ok: false, reason: 'not_own_city' };
  if (Number(st.playerCity) === id) return { ok: false, reason: 'already_capital' };
  const r = state.roleRes;
  const before = { gold: Math.floor(Number(r.gold) || 0), grain: Math.floor(Number(r.grain) || 0) };
  r.gold = Math.floor(before.gold * 0.5);
  r.grain = Math.floor(before.grain * 0.5);
  const oldCity = st.playerCity;
  st.playerCity = id;
  const day = Math.floor(Number(state.clock?.day) || 1);
  recordRes(state, 'gold', r.gold - before.gold, '迁都折损（保留 50%）', day);
  recordRes(state, 'grain', r.grain - before.grain, '迁都折损（保留 50%）', day);
  recordEvent(state, `迁都：${oldCity || '旧都'}失陷，朝廷移驾${id}，资源保留五成。`);
  ctx?.push?.('roleRes.push', { ...state.roleRes });
  return { ok: true, from: oldCity || 0, to: id, gold: r.gold, grain: r.grain };
}

/* -------------------------------------------------------------- 结局判定 */

const KEY_DECISION_KINDS = ['举义', '攻陷', '迁都', '背盟', '结盟', '裁军', '招抚'];

/**
 * 结局判定（GDD §3.5）。返回 null 表示游戏继续；
 * 统一 / 败亡 / 偏安（脚手架：剧本阶段目标未定义时恒 null）。
 * 共同要求：结局必须回放「你做过的 5 个关键决定」——从大事记里取关键类。
 */
export function evaluateEnding(state) {
  const st = state?.strategy;
  if (!st || st.oathPending === true) return null;
  const owned = ownedCities(st);
  const factionsWithLand = new Set(Object.values(st.cities)
    .map((v) => v.owner)
    .filter((o) => o && o !== 'player' && o !== 'han'));

  const decisions = (st.events || [])
    .filter((e) => KEY_DECISION_KINDS.some((k) => (e.text || '').includes(k)))
    .slice(-5)
    .map((e) => e.text);

  if (owned.length === 0) {
    return {
      type: 'fallen', title: '败亡',
      text: '所有城池失陷，朝廷再无可迁之都。这不是「Game Over」，是一段履历的终点。',
      decisions,
    };
  }
  // 统一：占领全部州治 + 主要势力全部出局
  const capitals = state.strategyMapCache?.capitals || null;   // 兜底：视图层注入
  let unified = false;
  if (Array.isArray(capitals) && capitals.length > 0) {
    unified = capitals.every((id) => st.cities[id]?.owner === 'player') && factionsWithLand.size === 0;
  } else {
    unified = factionsWithLand.size === 0 && owned.length >= 8;  // 无州治表时的近似口径
  }
  if (unified) {
    return {
      type: 'unified', title: '天下归一',
      text: '占领全部州治，主要势力尽灭。附天下图、势力年表与关键人物结局。',
      decisions,
    };
  }
  // 偏安：剧本阶段目标（如「保有荆益 10 年」）——剧本系统落地前恒 null，留脚手架
  if (st.scenarioGoal && st.scenarioGoal.untilDay
    && st.turn >= st.scenarioGoal.turns
    && (st.scenarioGoal.cities || []).every((id) => st.cities[id]?.owner === 'player')) {
    return {
      type: 'partial', title: '偏安',
      text: '达成剧本阶段目标。一页史评，以及未完成的事。',
      decisions,
    };
  }
  return null;
}
