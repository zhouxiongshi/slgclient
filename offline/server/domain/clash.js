/**
 * 行军相遇判定（P62）。
 *
 * 只做「谁和谁、在哪天、在哪相遇」的事实判定与地图表现数据，**不在这里结算兵力**：
 *   - 城下会战（city）：敌方援军与玩家军同指一城，抵达日相差 ≤ CLASH_CITY_WINDOW；
 *   - 途中遭遇（road）：两军走同一段路相向而行，行进时间窗交叠。
 *
 * 为什么不在这里扣兵：守军折算（defenseFor）已经把援军并进守方，如果相遇再扣一次，
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

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 一条路线的点序列，统一成「从 from 走向 to」。缺 points 时退化成两端直线。 */
export function pathFor(routes, from, to, cities = {}) {
  const f = Number(from), t = Number(to);
  const straight = () => {
    const a = cities[f], b = cities[t];
    if (a && b) return [[num(a.x), num(a.y)], [num(b.x), num(b.y)]];
    return null;
  };
  const list = Array.isArray(routes) ? routes : [];
  const rt = list.find((r) => (Number(r.from) === f && Number(r.to) === t)
    || (Number(r.from) === t && Number(r.to) === f));
  if (!rt || !Array.isArray(rt.points) || rt.points.length < 2) return straight();
  const pts = rt.points.map((p) => [num(p[0]), num(p[1])]);
  /* points 的书写方向不一定等于 from→to，用端点距离判定，别信字段顺序 */
  const cf = cities[f], ct = cities[t];
  if (cf && ct) {
    const headToFrom = dist(pts[0], [num(cf.x), num(cf.y)]) + dist(pts[pts.length - 1], [num(ct.x), num(ct.y)]);
    const tailToFrom = dist(pts[pts.length - 1], [num(cf.x), num(cf.y)]) + dist(pts[0], [num(ct.x), num(ct.y)]);
    if (tailToFrom + 1 < headToFrom) pts.reverse();
  }
  return pts;
}

/** 折线上按比例 u∈[0,1] 取点（按弧长，不按顶点数）。 */
export function pointAt(pts, u) {
  if (!Array.isArray(pts) || !pts.length) return null;
  if (pts.length === 1) return [pts[0][0], pts[0][1]];
  const k = Math.min(1, Math.max(0, num(u)));
  let total = 0;
  const segs = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const L = dist(pts[i], pts[i + 1]);
    segs.push(L);
    total += L;
  }
  if (total <= 0.0001) return [pts[0][0], pts[0][1]];
  let walked = total * k;
  for (let i = 0; i < segs.length; i += 1) {
    const L = segs[i];
    if (walked <= L || i === segs.length - 1) {
      const r = L > 0.0001 ? Math.min(1, walked / L) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r];
    }
    walked -= L;
  }
  return [pts[pts.length - 1][0], pts[pts.length - 1][1]];
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
 * 两支敌对行军是否相遇。返回 null 表示不相遇。
 * 顺序无关，但 a/b 保持入参顺序，调用方按 id 取「我方 / 对方」。
 */
export function clashOfPair(a, b, { cities = {}, routes = [], today = 1 } = {}) {
  if (!a || !b || a === b) return null;
  if (a.side === b.side) return null;
  if (SKIP_KINDS.has(a.kind) || SKIP_KINDS.has(b.kind)) return null;
  const a0 = num(a.departDay), a1 = num(a.arriveDay);
  const b0 = num(b.departDay), b1 = num(b.arriveDay);
  if (!(a1 > a0) || !(b1 > b0)) return null;
  /* 一支已经过去三天以上且没有交叠，谈不上相遇 */
  const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
  if (lo > hi + CLASH_CITY_WINDOW) return null;

  /* ---------- 途中遭遇：同一条路相向而行 ---------- */
  if (num(a.from) === num(b.to) && num(a.to) === num(b.from)) {
    const A = a1 - a0, B = b1 - b0;
    /* 归一化路程：a 走了 (t-a0)/A，b 走了 (t-b0)/B；同一位置意味着两者比例相加为 1 */
    const t = (1 + a0 / A + b0 / B) / (1 / A + 1 / B);
    if (t >= lo - 0.001 && t <= hi + 0.001) {
      const u = Math.min(1, Math.max(0, (t - a0) / A));
      const pts = pathFor(routes, a.from, a.to, cities);
      const at = pointAt(pts, u) || { x: 0, y: 0 };
      const day = Math.max(1, Math.round(t));
      if (day < today - 1) return null;
      return {
        key: pairKey('road', a, b, day),
        kind: 'road',
        day,
        at: { x: Math.round(at[0] * 10) / 10, y: Math.round(at[1] * 10) / 10 },
        roadFrom: num(a.from), roadTo: num(a.to),
        cityId: num(a.to),
        aId: num(a.id), bId: num(b.id),
        aSide: a.side, bSide: b.side,
        aLabel: labelOf(a), bLabel: labelOf(b),
        aTroops: troopsOf(a), bTroops: troopsOf(b),
        text: `${labelOf(b)}迎面而来，两军于${nameOf(cities, a.from)}—${nameOf(cities, a.to)}道中相遇`,
      };
    }
  }

  /* ---------- 城下会战：同指一城，抵达日相近 ---------- */
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

function nameOf(cities, id) {
  const c = cities[num(id)];
  return c ? c.name : '';
}

/** 全场扫描。只保留涉及玩家的那一对——诸侯互相路过不该占满玩家的地图与军情。 */
export function detectClashes({ marches = [], cities = {}, routes = [], today = 1 } = {}) {
  const live = (Array.isArray(marches) ? marches : []).filter((m) => m
    && !m.resolved && !m.recalled && (m.side === 'player' || m.side === 'faction'));
  const out = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i], b = live[j];
      if (a.side === b.side) continue;
      if (a.side !== 'player' && b.side !== 'player') continue;
      const c = clashOfPair(a, b, { cities, routes, today });
      if (c) out.push(c);
    }
  }
  return out.sort((x, y) => x.day - y.day || x.key.localeCompare(y.key));
}
