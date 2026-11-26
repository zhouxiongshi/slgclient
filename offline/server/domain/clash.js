/**
 * 行军相遇判定（P62）。
 *
 * 只做「谁和谁、在哪天、在哪会战」的事实判定与地图表现数据，**不在这里结算兵力**：
 *   - 城下会战（city）：两支敌对行军同指一城，抵达日相差 ≤ CLASH_CITY_WINDOW。
 *
 * 为什么只有城下一类：2026-11-25 用户明确要求撤掉「道中拦截」——
 * 途中相遇不开打、不扣兵，野外两军各走各的路。游戏里的仗只在城下打。
 *
 * 为什么不在这里扣兵：守军折算（defenseFor）已经把援军并进守方，如果会战再扣一次，
 * 同一支援军会被算两遍；来犯军的压力由围城推进与清剿承担。相遇的意义是
 * 「玩家在地图上看得见两军撞上了」，以及一条可回看的军情，而不是第二套结算。
 *
 * 零依赖叶子：只吃普通对象，便于单测与复用。
 */

/** 城下会战判定窗口（日）。差得更远就是「先到扎营、后到再打」，不算同一场会战。 */
export const CLASH_CITY_WINDOW = 2;

/** 不参与相遇判定的行军种类：运粮队不算战兵。 */
const SKIP_KINDS = new Set(['transport']);

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function labelOf(m) {
  if (!m) return '一军';
  if (m.side === 'player') return '我军';
  return m.factionName || m.label || '诸侯军';
}

function troopsOf(m) {
  const own = num(m.troops);
  if (own > 0) return own;
  const arr = Array.isArray(m.soldiers) ? m.soldiers : [];
  return arr.reduce((s, v) => s + Math.max(0, num(v)), 0);
}

function pairKey(kind, a, b, day) {
  const x = Math.min(num(a.id), num(b.id));
  const y = Math.max(num(a.id), num(b.id));
  return `${kind}:${x}:${y}:${day}`;
}

/**
 * 两支敌对行军是否在城下会战。返回 null 表示不遇上。
 * 顺序无关，但 a/b 保持入参顺序，调用方按 id 取「我方 / 对方」。
 */
export function clashOfPair(a, b, { cities = {}, today = 1 } = {}) {
  if (!a || !b || a === b) return null;
  if (a.side === b.side) return null;
  if (SKIP_KINDS.has(a.kind) || SKIP_KINDS.has(b.kind)) return null;
  const a0 = num(a.departDay), a1 = num(a.arriveDay);
  const b0 = num(b.departDay), b1 = num(b.arriveDay);
  if (!(a1 > a0) || !(b1 > b0)) return null;

  /* 同指一城，且抵达日相近，才算同一场会战 */
  if (num(a.to) === num(b.to) && num(a.to) > 0) {
    const gap = Math.abs(a1 - b1);
    if (gap <= CLASH_CITY_WINDOW) {
      const day = Math.max(1, Math.round(Math.max(a1, b1)));
      if (day < today - 1) return null;
      const city = cities[num(a.to)];
      const at = city
        ? { x: Math.round(num(city.x) * 10) / 10, y: Math.round(num(city.y) * 10) / 10 }
        : { x: 0, y: 0 };
      const cityName = city ? city.name : '';
      const under = /城$/.test(cityName) ? `${cityName}下` : `${cityName}城下`;
      return {
        key: pairKey('city', a, b, day),
        kind: 'city',
        day,
        at,
        cityId: num(a.to),
        aId: num(a.id), bId: num(b.id),
        aSide: a.side, bSide: b.side,
        aLabel: labelOf(a), bLabel: labelOf(b),
        aTroops: troopsOf(a), bTroops: troopsOf(b),
        text: `${labelOf(b)}亦抵${under}，两军会战`,
      };
    }
  }
  return null;
}

/** 全场扫描。只保留涉及玩家的那一对——诸侯互相路过不该占满玩家的地图与军情。 */
export function detectClashes({ marches = [], cities = {}, today = 1 } = {}) {
  const live = (Array.isArray(marches) ? marches : []).filter((m) => m
    && !m.resolved && !m.recalled && (m.side === 'player' || m.side === 'faction'));
  const out = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i], b = live[j];
      if (a.side === b.side) continue;
      if (a.side !== 'player' && b.side !== 'player') continue;
      const c = clashOfPair(a, b, { cities, today });
      if (c) out.push(c);
    }
  }
  return out.sort((x, y) => x.day - y.day || x.key.localeCompare(y.key));
}
