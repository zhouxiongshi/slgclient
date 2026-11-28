/**
 * 编队资格的单一口径（P54）：一将一队、同城编队。
 *
 * 两个入口共用本文件：
 *   - WS `army.dispose`（城内征兵页逐槽选将）
 *   - HTTP `/__slg/strategy/action` → `strategyFormup`（六府整编弹窗）
 * 这里只判定与回填派生字段，不改兵力、不改城池归属、不搬武将驻地。
 */

const idOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/* ★ P76：武将占身唯一口径——研习中的武将不能编入出征队伍。 */
import { busyReasonOf } from './general-busy.js';

/**
 * 判断一名武将能否进入指定城的队伍。
 * `armyId` 是目标队伍；同队内换槽允许，跨队占用一律拒绝。
 * 空 generalId（清空槽位）由调用方自行处理，本函数直接放行。
 */
export function formationGeneralCheck(state, { generalId, cityId, armyId = 0, missingReason = 'no_general' } = {}) {
  const gid = idOf(generalId);
  const city = idOf(cityId);
  if (!gid) return { ok: true, general: null };

  const g = (state.generals || []).find((x) => idOf(x.id) === gid);
  if (!g) return { ok: false, reason: missingReason, generalId: gid };

  /* ★ P74：赴任途中的武将不在城里——g.cityId 还记着出发城，不拦就会「人还在路上
     却被编进出征队伍」，抵达时凭空多出一支。 */
  if (g.transit) return { ok: false, reason: 'in_transit', generalId: gid };

  /* ★ P76：占身闸——正研习战法的武将不能编入出征队伍（先解除研习再点将）。 */
  {
    const busy = busyReasonOf(state, gid);
    if (busy && busy !== 'marching') return { ok: false, reason: `busy_${busy}`, generalId: gid };
  }

  const fromCity = idOf(g.cityId);
  if (fromCity !== city) {
    return { ok: false, reason: 'general_other_city', generalId: gid, cityId: city, generalCityId: fromCity };
  }

  const occupied = (state.armys || []).find((a) => {
    if (idOf(a.id) === idOf(armyId)) return false;
    return (a.generals || []).some((id) => idOf(id) === gid);
  });
  if (occupied) {
    return { ok: false, reason: 'in_other_army', generalId: gid, armyId: occupied.id };
  }
  return { ok: true, general: g };
}

/**
 * 武将离开槽位（调防/撤将）时把该槽兵力与在途征兵退回驻城，绝不留「空槽带兵」。
 * ★ P55：调防旧实现只摘武将、不清兵/在途，留下 generals[i]=0 && soldiers[i]>0 的幽灵槽；
 *   这些兵会被计入战损却不上阵，还因 empty_slot 永远无法补兵。与 army.dispose 同口径。
 * 返回退回的兵数（含在途）。无驻城记录时退到玩家主城，绝不往空槽回填。
 */
export function releaseSlot(state, army, slot) {
  const i = Number(slot);
  const at = Number(army?.cityId) || 0;
  const back = Math.max(0, Math.floor(Number(army?.soldiers?.[i]) || 0))
    + Math.max(0, Math.floor(Number(army?.con_cnts?.[i]) || 0));
  const clear = (list) => Array.isArray(list)
    ? [0, 1, 2].map((k) => (k === i ? 0 : Math.max(0, Math.floor(Number(list[k]) || 0))))
    : [0, 0, 0];
  army.soldiers = clear(army.soldiers);
  army.con_cnts = clear(army.con_cnts);
  army.con_times = clear(army.con_times);
  army.conToken = Math.floor(Number(army.conToken) || 0) + 1; // 作废该槽在途定时器
  const st = state?.strategy || {};
  const city = st.cities?.[at]
    || st.cities?.[Number(st.playerCity)]
    || Object.values(st.cities || {}).find((c) => c && c.owner === 'player');
  if (back > 0 && city) {
    city.troops = Math.max(0, Math.floor(Number(city.troops) || 0) + back);
  }
  return back;
}

/**
 * ★ P56：解散整支队伍的唯一口径。
 * 与逐槽撤将共用 releaseSlot：每槽兵力/在途退回驻城并作废定时器，
 * 武将只解除队伍占用（驻地不变），队号回收，队伍对象从名册移除。
 * 行军中拒绝；找不到队伍直接拒绝，绝不新建空队。
 */
export function disbandArmy(state, ctx, { armyId } = {}) {
  const id = idOf(armyId);
  const army = (state?.armys || []).find((a) => idOf(a.id) === id);
  if (!army) return { ok: false, reason: 'no_army' };
  if (army.marchId) return { ok: false, reason: 'marching' };
  const generals = (army.generals || []).map((gid) => idOf(gid)).filter(Boolean);
  let returned = 0;
  for (let i = 0; i < 3; i += 1) returned += releaseSlot(state, army, i);
  const info = { id: army.id, cityId: idOf(army.cityId), order: idOf(army.order), returned };
  state.armys = state.armys.filter((a) => a !== army);
  syncGeneralOrders(state);
  ctx?.push?.('army.disband', info);
  for (const gid of generals) {
    const g = (state.generals || []).find((x) => idOf(x.id) === gid);
    if (g) ctx?.push?.('general.push', g);
  }
  return { ok: true, ...info, generals };
}

/**
 * ★ P57：同城 `(cityId, order)` 必须唯一。老档（含 P54 之前创建的存档）会出现
 * 同一座城两支 order=1：UI 按 order 建索引时后一支覆盖前一支，于是主公所在的
 * 真队伍整队消失，下拉里主公又因「在编」被禁用——玩家看到的就是「主公丢了、
 * 选不了、组不了队」。这里保留先建队伍的原编号，重复者顺延到首个空号并重算
 * `g.order`；不搬将、不动兵、不改驻地。
 */
export function normalizeArmyOrders(state) {
  const used = new Set();
  const changed = [];
  for (const a of state?.armys || []) {
    if (!a) continue;
    const city = idOf(a.cityId);
    let order = idOf(a.order) || 1;
    let key = `${city}:${order}`;
    if (used.has(key)) {
      let next = 1;
      while (used.has(`${city}:${next}`)) next += 1;
      order = next;
      key = `${city}:${order}`;
      changed.push({ armyId: idOf(a.id), from: idOf(a.order), to: order, cityId: city });
    }
    a.order = order;
    used.add(key);
  }
  if (changed.length) syncGeneralOrders(state);
  return changed;
}

/** `g.order` 是队伍编号的派生字段：任何编队落账后都从此重算，避免残留旧编号。 */
export function syncGeneralOrders(state) {
  for (const g of state.generals || []) g.order = 0;
  for (const a of state.armys || []) {
    const order = idOf(a.order);
    for (const gid of a.generals || []) {
      const g = (state.generals || []).find((x) => idOf(x.id) === idOf(gid));
      if (g) g.order = order;
    }
  }
}
