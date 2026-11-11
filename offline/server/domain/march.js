/**
 * 行军校验（对齐 tmx 的「行军规则」）。
 *
 *   行军只允许沿既有路线的行军段推进；两节点之间若无路段则禁止通行，不允许越野直连。
 *   关隘是路线上的必经节点，只能经其前后两段通过；关隘标记「封锁」时其两段同时禁行。
 *
 * 数据来源：conf/campaign/strategy/detail.json 的 march（由 tools/build-strategy-tmx.js 从 tmx 生成）。
 * 城池用稳定整数 ID；关隘与行军段属于路网结构，随图版本走。
 *
 * 关键：tmx 把经过关隘的路线拆成「城→关」「关→城」两段，所以过一条经关隘的路
 * 要连走两段。校验因此必须按节点做最短路径，不能只看直接邻接。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DETAIL_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'detail.json');

let cache = null;

export function marchGraph() {
  if (cache) return cache;
  if (!existsSync(DETAIL_PATH)) return null;
  const detail = JSON.parse(readFileSync(DETAIL_PATH, 'utf8'));
  if (!detail.march || !Array.isArray(detail.march.edges)) return null;

  const edges = new Map();
  const adjacency = new Map();   // 节点名 → 边 id 列表
  const cityIdByName = new Map();
  const nameByCityId = new Map();
  for (const n of detail.march.nodes || []) {
    if (n.cityId) {
      cityIdByName.set(n.name, n.cityId);
      nameByCityId.set(n.cityId, n.name);
    }
    if (!adjacency.has(n.name)) adjacency.set(n.name, []);
  }
  for (const e of detail.march.edges) {
    edges.set(e.id, e);
    for (const name of [e.from, e.to]) {
      if (!adjacency.has(name)) adjacency.set(name, []);
      adjacency.get(name).push(e.id);
    }
  }
  cache = {
    rule: detail.march.rule || '',
    noOffroad: detail.march.noOffroad !== false,
    nodes: detail.march.nodes || [],
    edges,
    adjacency,
    cityIdByName,
    nameByCityId,
    gateStatus: { ...(detail.march.gateStatus || {}) },
  };
  return cache;
}

/** 关隘是否封锁。封锁后其前后两段都不可通行。 */
export function isGateBlocked(gateName) {
  const g = marchGraph();
  if (!g || !gateName) return false;
  return g.gateStatus[gateName] === '封锁';
}

export function setGateStatus(gateName, status) {
  const g = marchGraph();
  if (!g || !(gateName in g.gateStatus)) return false;
  g.gateStatus[gateName] = status === '封锁' ? '封锁' : '通行';
  return true;
}

/** 某条行军段当前能否通行。 */
export function edgePassable(edgeId) {
  const g = marchGraph();
  if (!g) return true;
  const e = g.edges.get(edgeId);
  if (!e) return false;
  if (e.gate && isGateBlocked(e.gate)) return false;
  return true;
}

/**
 * 两城之间能否行军。允许途经关隘节点，但不允许穿过第三座城
 * （跨城要分多段行军，不是一次出征）。
 * 返回 { ok, path, edges, via, reason }。
 */
export function canMarchBetween(fromCityId, toCityId) {
  const g = marchGraph();
  if (!g) return { ok: true };
  const a = Number(fromCityId);
  const b = Number(toCityId);
  if (!a || !b || a === b) return { ok: false, reason: 'same_city' };

  const start = g.nameByCityId.get(a);
  const goal = g.nameByCityId.get(b);
  if (!start || !goal) return { ok: false, reason: 'no_road' };

  // 起点出发的第一段；中间只允许经关隘节点
  const queue = [{ node: start, path: [start], edges: [] }];
  const seen = new Set([start]);
  let blockedGate = '';
  while (queue.length) {
    const cur = queue.shift();
    for (const edgeId of g.adjacency.get(cur.node) || []) {
      const e = g.edges.get(edgeId);
      if (!edgePassable(edgeId)) {
        if (e.gate) blockedGate = blockedGate || e.gate;
        continue;
      }
      const next = e.from === cur.node ? e.to : e.from;
      if (next === goal) {
        return {
          ok: true,
          path: [...cur.path, next],
          edges: [...cur.edges, edgeId],
          routeId: e.routeId,
          via: [...cur.path.slice(1)],
        };
      }
      // 只能穿关隘，不能穿别的城
      const isGate = next in g.gateStatus;
      if (!isGate || seen.has(next)) continue;
      seen.add(next);
      queue.push({ node: next, path: [...cur.path, next], edges: [...cur.edges, edgeId] });
    }
  }
  if (blockedGate) return { ok: false, reason: 'gate_blocked', gate: blockedGate };
  return { ok: false, reason: 'no_road' };
}

/** 从某城出发，一次出征可达的城（考虑关隘封锁）。 */
export function marchableNeighbors(cityId, allCities) {
  const g = marchGraph();
  if (!g) return allCities || [];
  const ids = allCities || [...g.nameByCityId.keys()];
  return ids.filter((id) => Number(id) !== Number(cityId) && canMarchBetween(cityId, id).ok);
}

/** 供测试或热更新使用：丢掉缓存，下次重新读 detail.json。 */
export function resetMarchCache() {
  cache = null;
}
