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
