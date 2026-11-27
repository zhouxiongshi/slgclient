/**
 * 战斗伤亡拆分与伤兵回撤（P67）。
 *
 * 口径（玩家可见）：
 *  - 一场仗打完，折损不是全部「没了」：一部分阵亡，一部分只是负伤；
 *  - 负伤者退出战斗序列，**不会留在原队**，而是自行退往周边己方城与出生城；
 *  - 周边城按战场位置取最近的一座己方城，出生城按该支部队的出发城取。
 *
 * 为什么是纯模块：战斗内核只回答「剩多少人」，伤兵去向属于战略层口径；
 * 这里不读配置、不碰内核，攻城/清剿/推演共用同一套拆分，避免三处各算一套。
 */

/** 负伤占折损的比例。阵亡 = 折损 − 负伤。 */
export const WOUNDED_RATE = 0.4;
/** 负伤者中回出生城的比例，其余退回周边最近己方城；没有第二座城时全给唯一可去的那座。 */
export const HOME_SHARE = 0.4;

const SLOT_SHARES = [0.4, 0.35, 0.25];

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 按槽位拆出「阵亡 / 负伤」。
 * 入参 lossBySlot 不能由 remain 反推未上阵槽位，因此直接传逐槽折损。
 */
export function splitCasualties({ lossBySlot = [], rate = WOUNDED_RATE } = {}) {
  const losses = [0, 1, 2].map((i) => Math.max(0, Math.floor(num(lossBySlot[i]))));
  const r = Math.max(0, Math.min(1, num(rate, WOUNDED_RATE)));
  const wounded = losses.map((n) => Math.floor(n * r));
  const killed = losses.map((n, i) => Math.max(0, n - wounded[i]));
  let totalW = wounded.reduce((s, n) => s + n, 0);
  const totalLoss = losses.reduce((s, n) => s + n, 0);
  /* 小数全被截断时至少留 1 名伤兵：玩家看见「折损 N、无一阵亡也无一伤」说不通。 */
  if (totalLoss > 0 && totalW === 0) {
    const biggest = losses.indexOf(Math.max(...losses));
    wounded[biggest] = 1;
    killed[biggest] = Math.max(0, losses[biggest] - 1);
    totalW = 1;
  }
  return {
    loss: losses,
    wounded,
    killed,
    woundedBySlot: wounded,
    killedBySlot: killed,
    totalLoss,
    totalWounded: totalW,
    totalKilled: totalLoss - totalW,
  };
}

/** 把援军兵力摊到三个兵种槽，保持盾/弓/骑的常用编成权重。 */
export function splitTroopsToSlots(total) {
  const n = Math.max(0, Math.round(num(total)));
  const out = SLOT_SHARES.map((share) => Math.round(n * share));
  let diff = n - out.reduce((s, v) => s + v, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % 3) {
    const step = diff > 0 ? 1 : -1;
    if (out[i] + step >= 0) { out[i] += step; diff -= step; }
    if (i === 2 && diff !== 0 && out.every((v) => v <= 0)) break;
  }
  return out;
}

/**
 * 伤兵入城：写入战略层城池驻军，并回一份可写进战报/军情的去向清单。
 * 只认 owner==='player' 的城，敌城与中立城不收容伤兵。
 */
export function routeWounded(state, {
  wounded = [], fromCityId = 0, battleCityId = 0, mapCities = [], strategyCities = null,
  playerCityFallback = false,
} = {}) {
  const st = state?.strategy || {};
  const rows = strategyCities || st.cities || {};
  const total = [0, 1, 2].reduce((s, i) => s + Math.max(0, Math.floor(num(wounded[i]))), 0);
  const out = [];
  if (total <= 0) return out;
  /* 举义前还没有 owner==='player' 的城，但 st.playerCity 就是玩家的出生城；
     举义后不再承认这个兜底，免得都城失守后伤兵仍往旧都跑。 */
  const isMine = (id) => Number(id) > 0 && (rows[Number(id)]?.owner === 'player'
    || (playerCityFallback && Number(id) === Number(st.playerCity)));
  const home = isMine(fromCityId) ? Number(fromCityId) : 0;
  const battle = (mapCities || []).find((c) => Number(c?.id) === Number(battleCityId)) || null;
  const nearList = (mapCities || [])
    .filter((c) => isMine(c?.id) && Number(c.id) !== home)
    .map((c) => ({
      id: Number(c.id),
      name: c.name || String(c.id),
      dist: battle && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y))
        ? Math.hypot(Number(c.x) - Number(battle.x), Number(c.y) - Number(battle.y))
        : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.dist - b.dist || a.id - b.id);
  const near = nearList[0]?.id || 0;
  const shares = [];
  if (home && near) {
    const nearCount = total - Math.floor(total * HOME_SHARE);
    shares.push({ id: home, count: total - nearCount });
    shares.push({ id: near, count: nearCount });
  } else if (home) {
    shares.push({ id: home, count: total });
  } else if (near) {
    shares.push({ id: near, count: total });
  }
  for (const s of shares) {
    if (!(s.count > 0)) continue;
    const row = rows[s.id];
    if (!row) continue;
    row.troops = Math.max(0, Math.round(num(row.troops)) + s.count);
    const name = s.id === home
      ? ((mapCities || []).find((c) => Number(c?.id) === s.id)?.name || '出生城')
      : (nearList.find((c) => c.id === s.id)?.name || '周边城');
    out.push({ cityId: s.id, name, count: s.count });
  }
  return out;
}
