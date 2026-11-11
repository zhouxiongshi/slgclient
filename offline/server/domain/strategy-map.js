/**
 * 战略大地图（霜寒定九州·五十四城版）的规范化层。
 *
 * 身份原则（集成契约）：
 *   - 每座城在游戏内有稳定数字 ID，一经分配永不改变、永不复用；
 *   - 城名只是显示称呼，改名不影响 AI 记忆与关系；
 *   - 资料库的「城池ID」（C####/X###）是首要对账键，城名是次要对账键；
 *   - 从地图删掉的城在注册表里留墓碑，ID 不回收；
 *   - 道路在导入时解析成稳定 ID 端点，之后只认 ID。
 */

export const emptyRegistry = () => ({ version: 1, nextId: 1, entries: {} });

/**
 * 把一批导入城池对账进注册表。
 * 对账顺序：城池ID 精确命中 → 城名认领孤儿（城被改名或换了 ref 的情况）→ 新分配。
 * @returns {{registry, added:[], renamed:[], removed:[]}}
 */
export function reconcileRegistry(registryIn, incomingCities) {
  const registry = structuredClone(registryIn || emptyRegistry());
  if (!Number.isFinite(registry.nextId)) registry.nextId = 1;
  if (!registry.entries) registry.entries = {};
  const entries = registry.entries;

  const incomingRefs = new Set(incomingCities.map((c) => c.ref).filter(Boolean));
  const byRef = new Map();     // ref → 内部 ID
  const orphans = new Map();   // 城名 → 内部 ID（本次导入中没有该 ref 的存续条目）
  for (const [id, e] of Object.entries(entries)) {
    if (e.removed) continue;
    if (e.ref && incomingRefs.has(e.ref)) byRef.set(e.ref, id);
    else orphans.set(e.name, id);
  }

  const added = [];
  const renamed = [];
  const claimed = new Set();
  const nameHit = (c, key) => c.name === key || (Array.isArray(c.alias) && c.alias.includes(key));

  for (const c of incomingCities) {
    let id = null;
    if (c.ref && byRef.has(c.ref)) {
      id = byRef.get(c.ref);
    } else {
      for (const [key, orphanId] of orphans) {
        if (nameHit(c, key) && !claimed.has(orphanId)) {
          id = orphanId;
          orphans.delete(key);
          break;
        }
      }
    }
    if (id == null) {
      id = String(registry.nextId);
      registry.nextId += 1;
      entries[id] = { ref: c.ref || null, name: c.name, removed: false };
      added.push({ id: Number(id), name: c.name, ref: c.ref || null });
    } else {
      const prev = entries[id];
      if (prev.name !== c.name) renamed.push({ id: Number(id), from: prev.name, to: c.name });
      entries[id] = { ref: c.ref || prev.ref || null, name: c.name, removed: false };
    }
    claimed.add(id);
  }

  const removed = [];
  for (const [id, e] of Object.entries(entries)) {
    if (e.removed || claimed.has(id) || byRef.get(e.ref) === id) continue;
    if (byRef.has(e.ref)) continue;
    e.removed = true;
    removed.push({ id: Number(id), name: e.name });
  }

  return { registry, added, renamed, removed };
}

/**
 * 从 54 城数据构建规范化地图。
 * @param incomingCities [{ref, name, ...业务字段}]
 * @param routesRaw 资料库道路（端点 a_id/b_id 优先，a/b 城名兜底）
 * @param registry  现有注册表；缺省时全新分配
 */
export function buildStrategyMap(incomingCities, routesRaw, registryIn) {
  const { registry, added, renamed, removed } = reconcileRegistry(registryIn, incomingCities);

  const refToId = new Map();
  const nameToId = new Map();
  for (const [id, e] of Object.entries(registry.entries)) {
    if (e.removed) continue;
    if (e.ref) refToId.set(e.ref, Number(id));
    nameToId.set(e.name, Number(id));
  }

  const warnings = [];
  const cities = [];
  for (const c of incomingCities) {
    const id = refToId.get(c.ref) ?? nameToId.get(c.name);
    if (id == null) {
      warnings.push(`城市 ${c.name}(${c.ref || '无ID'}) 未入册，已跳过`);
      continue;
    }
    cities.push({ id, ...c });
  }

  const routes = [];
  for (const r of routesRaw) {
    const from = refToId.get(r.a_id) ?? nameToId.get(r.a);
    const to = refToId.get(r.b_id) ?? nameToId.get(r.b);
    if (from == null || to == null) {
      warnings.push(`道路 ${r.id} 端点无法解析：${r.a}→${r.b}`);
      continue;
    }
    routes.push({
      id: r.id, from, to,
      kind: r.kind || '', km: r.km ?? null, costDays: r.cost_days ?? null,
      difficulty: r.difficulty ?? 0, sea: !!r.sea, crossRiver: !!r.cross_river,
      points: (r.display_points || []).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
    });
  }

  return { registry, map: { cities, routes }, report: { added, renamed, removed, warnings } };
}

