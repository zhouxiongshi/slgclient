/**
 * 战略图层：tmx 的六层贴图与对象组必须和 map.json 的稳定 ID 对得上。
 * 城池与道路坐标一旦错位，游戏里点城就会点到隔壁，所以这里逐条核。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRAT = resolve(ROOT, 'conf', 'campaign', 'strategy');
const map = JSON.parse(readFileSync(resolve(STRAT, 'map.json'), 'utf8'));
const detail = JSON.parse(readFileSync(resolve(STRAT, 'detail.json'), 'utf8'));

test('分层资源齐全：底图 / 州名 / 路网 / 城池 / 关隘 / 城名 六层', () => {
  const keys = ['base', 'zhou', 'road', 'city', 'pass', 'name'];
  for (const k of keys) {
    assert.ok(detail.layers[k], `缺少图层：${k}`);
    const p = resolve(STRAT, detail.layers[k]);
    assert.ok(existsSync(p), `图层文件不存在：${detail.layers[k]}`);
    assert.ok(readFileSync(p).length > 8 * 1024, `图层 ${k} 太小，疑似空图`);
  }
  assert.equal(Object.keys(detail.layers).length, keys.length, '图层数量不对');
});

test('六层同系：画布 2400×1350，底图足够大', () => {
  assert.equal(detail.canvas.w, 2400);
  assert.equal(detail.canvas.h, 1350);
  const base = readFileSync(resolve(STRAT, detail.layers.base));
  assert.ok(base.length > 1 * 1024 * 1024, '底图太小，疑似空图');
});

test('城池史料按稳定 ID 落盘：72 城全覆盖，州郡/今地/模型/史略不缺', () => {
  assert.equal(Object.keys(detail.cities).length, map.cities.length);
  for (const c of map.cities) {
    const d = detail.cities[c.id];
    assert.ok(d, `城池 ${c.name}(${c.id}) 无史料`);
    assert.equal(d.ref, c.ref, `${c.name} 的 ref 与注册表不一致`);
    assert.ok(d.history && d.history.length > 4, `${c.name} 缺史略`);
    assert.ok(d.jun, `${c.name} 缺所属郡国`);
    assert.equal(typeof d.w, 'number');
    assert.equal(typeof d.h, 'number');
  }
});

test('城池标注坐标与城池点位同系，不越画布', () => {
  for (const c of map.cities) {
    const d = detail.cities[c.id];
    assert.ok(d.w > 0 && d.h > 0, `${c.name} 缺插画尺寸`);
    assert.ok(c.x >= 0 && c.x <= 2400 && c.y >= 0 && c.y <= 1350, `${c.name} 点位越界`);
  }
});

test('路线等级按稳定路线 ID 对齐：四级齐全，里程与日程为正', () => {
  assert.equal(Object.keys(detail.routes).length, map.routes.length);
  const tiers = new Set();
  for (const r of map.routes) {
    const d = detail.routes[r.id];
    assert.ok(d, `路线 ${r.id} 无等级`);
    assert.ok(d.rank >= 1 && d.rank <= 4, `${r.id} 等级越界`);
    tiers.add(d.tier);
    assert.ok(d.km > 0 && d.days > 0, `${r.id} 里程或日程非法`);
  }
  assert.deepEqual([...tiers].sort(), ['官道', '水道', '郡道', '驰道'].sort());
});

test('关隘八处、州名十三条，且都带史地说明', () => {
  assert.equal(detail.passes.length, 8);
  assert.equal(detail.zhou.length, 13);
  for (const p of detail.passes) {
    assert.ok(p.name && p.guard, `关隘 ${p.name} 缺扼守说明`);
    assert.ok(p.x >= 0 && p.x <= 2400 && p.y >= 0 && p.y <= 1350, `${p.name} 坐标越界`);
    assert.ok(p.kind, `${p.name} 缺形制`);
  }
  const zhouNames = detail.zhou.map((z) => z.name);
  assert.equal(new Set(zhouNames).size, 13, '州名有重复');
  for (const name of zhouNames) {
    assert.ok(map.cities.some((c) => c.province === name), `州名 ${name} 在战略图里没有城池`);
  }
});

test('关隘必须真的落在所属路线上，且路线端点一致', () => {
  const routeById = new Map(map.routes.map((r) => [r.id, r]));
  const nameOf = new Map(map.cities.map((c) => [c.id, c.name]));
  const distToPath = (pt, pts) => {
    let best = Infinity;
    for (let i = 1; i < pts.length; i += 1) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      const dx = x2 - x1, dy = y2 - y1;
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - x1) * dx + (pt.y - y1) * dy) / l2));
      best = Math.min(best, Math.hypot(pt.x - (x1 + t * dx), pt.y - (y1 + t * dy)));
    }
    return best;
  };
  for (const p of detail.passes) {
    assert.ok(p.roadId, `${p.name} 没有挂到路线上`);
    const r = routeById.get(p.roadId);
    assert.ok(r, `${p.name} 的路线 ${p.roadId} 不存在`);
    const dev = distToPath({ x: p.x, y: p.y }, r.points);
    assert.ok(dev < 12, `${p.name} 偏离路线 ${r.id} 达 ${dev.toFixed(1)}px`);
    const ends = new Set([nameOf.get(r.from), nameOf.get(r.to)]);
    for (const e of p.ends) assert.ok(ends.has(e), `${p.name} 端点 ${e} 不在路线 ${r.id} 上`);
  }
});

test('路线关隘标记与关隘表互相对应', () => {
  const gated = new Map();
  for (const [id, r] of Object.entries(detail.routes)) {
    for (const g of r.gates || []) gated.set(g, (gated.get(g) || []).concat(id));
  }
  assert.ok(gated.size > 0, '没有任何路线标记关隘');
  for (const p of detail.passes) {
    assert.ok(gated.has(p.name), `关隘 ${p.name} 没有被任何路线标记为必经`);
    assert.ok(gated.get(p.name).includes(p.roadId), `关隘 ${p.name} 的路线标记不一致`);
  }
});

test('行军图只走既有路线：节点＝城池＋关隘，边端点不悬空', () => {
  const m = detail.march;
  assert.ok(m, '缺少行军图');
  assert.equal(m.noOffroad, true, '必须禁止越野直连');
  assert.equal(m.connected, true, '路网应连通');

  const cityNames = new Set(map.cities.map((c) => c.name));
  const gateNames = new Set(detail.passes.map((p) => p.name));
  for (const n of m.nodes) {
    const known = cityNames.has(n.name) || gateNames.has(n.name);
    assert.ok(known, `行军节点 ${n.name} 既非城池也非关隘`);
    assert.equal(n.gate, gateNames.has(n.name), `${n.name} 的关隘标记不对`);
    if (cityNames.has(n.name)) assert.ok(n.cityId > 0, `${n.name} 没有绑稳定城池 ID`);
  }

  const nodeSet = new Set(m.nodes.map((n) => n.name));
  for (const e of m.edges) {
    assert.ok(nodeSet.has(e.from), `边 ${e.id} 起点 ${e.from} 不在节点表`);
    assert.ok(nodeSet.has(e.to), `边 ${e.id} 终点 ${e.to} 不在节点表`);
    assert.ok(e.routeId, `边 ${e.id} 没挂路线`);
  }
});

test('每条路线都有行军段，关隘两侧被拆开', () => {
  const byRoute = new Map();
  for (const e of detail.march.edges) {
    byRoute.set(e.routeId, (byRoute.get(e.routeId) || 0) + 1);
  }
  for (const r of map.routes) {
    assert.ok(byRoute.has(r.id), `路线 ${r.id} 没有行军段`);
  }
  // 一条路线上有 n 个关隘，就被拆成 n+1 段
  for (const [routeId, r] of Object.entries(detail.routes)) {
    const gates = (r.gates || []).length;
    assert.equal(byRoute.get(routeId), gates + 1,
      `路线 ${routeId} 有 ${gates} 个关隘，应拆成 ${gates + 1} 段，实际 ${byRoute.get(routeId)} 段`);
  }
});

test('关隘状态齐全，15 条关隘边都能对上关名', () => {
  const names = detail.passes.map((p) => p.name).sort();
  assert.deepEqual(Object.keys(detail.march.gateStatus).sort(), names, '关隘状态表与关隘清单不一致');
  for (const st of Object.values(detail.march.gateStatus)) {
    assert.ok(['通行', '封锁'].includes(st), `未知关隘状态：${st}`);
  }
  const gatedEdges = detail.march.edges.filter((e) => e.gate);
  assert.equal(gatedEdges.length, 15, '关隘边数量不对');
  for (const e of gatedEdges) {
    assert.ok(names.includes(e.gate), `边 ${e.id} 的关名 ${e.gate} 不在关隘表`);
  }
});

test('城池所属州与州名表一致，州治确实在该州', () => {
  for (const z of detail.zhou) {
    if (!z.capital) continue;
    const cap = map.cities.find((c) => c.name === z.capital);
    assert.ok(cap, `州治 ${z.capital} 不存在`);
    assert.equal(cap.province, z.name, `${z.capital} 不属 ${z.name}`);
  }
});
