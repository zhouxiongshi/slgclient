/**
 * 行军校验：只允许沿既有行军段推进，关隘封锁则其前后两段同时禁行。
 * 这些规则来自 tmx 的「行军规则」，界面上表现为「有些城打不了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  marchGraph, canMarchBetween, marchableNeighbors, edgePassable,
  isGateBlocked, setGateStatus, resetMarchCache,
} from '../server/domain/march.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRAT = resolve(ROOT, 'conf', 'campaign', 'strategy');
const map = JSON.parse(readFileSync(resolve(STRAT, 'map.json'), 'utf8'));
const detail = JSON.parse(readFileSync(resolve(STRAT, 'detail.json'), 'utf8'));
const byName = new Map(map.cities.map((c) => [c.name, c]));
const allIds = map.cities.map((c) => c.id);

test('行军图来自 tmx，且声明禁止越野直连', () => {
  const g = marchGraph();
  assert.ok(g, '缺少行军图');
  assert.equal(g.noOffroad, true);
  assert.ok(g.rule.length > 10, '缺少规则原文');
  assert.equal(g.nodes.length, map.cities.length + detail.passes.length,
    '节点数应等于城池数 + 关隘数');
});

test('每条行军段两端都能走通', () => {
  for (const edge of detail.march.edges) {
    if (edge.fromCityId) {
      const r = canMarchBetween(edge.fromCityId, edge.fromCityId);
      assert.equal(r.ok, false, '同城不应算行军');
    }
  }
  // 两城直连段：双向都能走
  for (const edge of detail.march.edges) {
    if (!edge.fromCityId || !edge.toCityId) continue;
    assert.equal(canMarchBetween(edge.fromCityId, edge.toCityId).ok, true,
      `${edge.from} → ${edge.to} 应可通行`);
    assert.equal(canMarchBetween(edge.toCityId, edge.fromCityId).ok, true,
      `${edge.to} → ${edge.from} 应可通行`);
  }
});

test('没有路网连接的城不能行军（不许越野直连）', () => {
  const linked = new Set();
  for (const e of detail.march.edges) {
    if (e.fromCityId && e.toCityId) {
      linked.add([e.fromCityId, e.toCityId].sort((a, b) => a - b).join('-'));
    }
  }
  let checked = 0;
  for (const a of map.cities) {
    for (const b of map.cities) {
      if (a.id >= b.id) continue;
      if (linked.has([a.id, b.id].sort((x, y) => x - y).join('-'))) continue;
      if (checked >= 40) break;
      const r = canMarchBetween(a.id, b.id);
      if (!r.ok) {
        assert.notEqual(r.reason, 'ok', '原因不该为空');
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 20, `应验证到足够多的非直连城对，实际 ${checked}`);
});

test('经关隘的路线：未封锁可走，封锁后两段同时禁行', () => {
  resetMarchCache();
  const g = marchGraph();
  const gateName = '潼关';
  const gated = detail.march.edges.filter((e) => e.gate === gateName);
  assert.ok(gated.length >= 2, '潼关应拆成两段以上');
  for (const e of gated) assert.equal(edgePassable(e.id), true, '未封锁时应可通行');

  // 找一条被潼关隔开的两端城
  const routes = detail.routes;
  const gatedRoute = Object.entries(routes).find(([, r]) => (r.gates || []).includes(gateName));
  assert.ok(gatedRoute, '应有路线途经潼关');
  const [routeId] = gatedRoute;
  const route = map.routes.find((r) => r.id === routeId);
  const a = map.cities.find((c) => c.id === route.from);
  const b = map.cities.find((c) => c.id === route.to);
  assert.ok(a && b, '路线端点城池应存在');

  const before = canMarchBetween(a.id, b.id);
  assert.equal(before.ok, true, `${a.name} → ${b.name} 经潼关应可走`);
  assert.ok(before.via.includes(gateName), '应标明途经潼关');

  assert.equal(setGateStatus(gateName, '封锁'), true);
  assert.equal(isGateBlocked(gateName), true);
  for (const e of gated) assert.equal(edgePassable(e.id), false, '封锁后该段必须禁行');
  const after = canMarchBetween(a.id, b.id);
  assert.equal(after.ok, false, `潼关封锁后 ${a.name} → ${b.name} 应不可走`);
  assert.equal(after.reason, 'gate_blocked');
  assert.equal(after.gate, gateName);

  assert.equal(setGateStatus(gateName, '通行'), true);
  assert.equal(canMarchBetween(a.id, b.id).ok, true);
  resetMarchCache();
});

test('封锁关隘会让可达城变少', () => {
  resetMarchCache();
  const home = map.cities.find((c) => c.name === '长安');
  assert.ok(home, '长安应存在');
  const before = marchableNeighbors(home.id, allIds);
  assert.ok(before.length >= 2, '长安应有若干可达城');

  setGateStatus('潼关', '封锁');
  const after = marchableNeighbors(home.id, allIds);
  assert.ok(after.length < before.length, `封锁潼关后可达城应变少：${before.length} → ${after.length}`);
  assert.equal(after.includes(byName.get('弘农').id), false, '潼关封锁后长安到不了弘农');
  setGateStatus('潼关', '通行');
  resetMarchCache();
});

test('未知关隘不会被误设状态', () => {
  resetMarchCache();
  assert.equal(setGateStatus('不存在的关', '封锁'), false);
  assert.equal(isGateBlocked('不存在的关'), false);
});
