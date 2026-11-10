/**
 * 战略大地图身份契约：稳定 ID 永不改变、永不复用。
 * 城名只是称呼——改名、挪位、增删城，AI 记忆的锚不跟着抖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reconcileRegistry, buildStrategyMap, emptyRegistry } from '../server/domain/strategy-map.js';

const ROOT = resolve(import.meta.dirname, '..');
const map = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json'), 'utf8'));
const registry = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'strategy', 'id-registry.json'), 'utf8'));

test('东汉十三州模型图完整入册：73 城 / 13 州 / 118 条道路，ID 唯一', () => {
  assert.equal(map.cities.length, 73);
  assert.equal(map.routes.length, 118);
  const ids = map.cities.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, '存在重复 ID');
  const states = new Set(map.cities.map((c) => c.province));
  assert.equal(states.size, 13);
  const citiesById = new Map(map.cities.map((c) => [c.id, c]));
  for (const r of map.routes) {
    assert.ok(citiesById.has(r.from), `道路 ${r.id} 起点悬空`);
    assert.ok(citiesById.has(r.to), `道路 ${r.id} 终点悬空`);
  }
  assert.ok(registry.nextId > 67, 'nextId 必须越过已分配号段');
});

test('十三州各有州治', () => {
  const byProvince = new Map();
  for (const c of map.cities) {
    if (c.provinceCapital) byProvince.set(c.province, c.name);
  }
  assert.equal(byProvince.size, 13);
  assert.equal(byProvince.get('司隶'), '长安');
  assert.equal(byProvince.get('扬州'), '南昌');
  assert.equal(byProvince.get('益州'), '成都');
});

test('改名不掉 ID：ref 命中优先，记忆锚不动', () => {
  const incoming = map.cities.map((c) => ({ ...c, name: c.id === 1 ? '西京长安' : c.name }));
  const { registry: reg2, renamed } = reconcileRegistry(registry, incoming);
  assert.equal(renamed.length, 1);
  assert.deepEqual(renamed[0], { id: 1, from: '长安', to: '西京长安' });
  assert.equal(reg2.entries['1'].name, '西京长安');
  assert.equal(reg2.entries['1'].ref, 'C0069');
});

test('删城留墓碑，ID 不复用；再加新城拿新号', () => {
  const withoutChangan = map.cities.filter((c) => c.id !== 1);
  const { registry: reg2, removed } = reconcileRegistry(registry, withoutChangan);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 1);
  assert.equal(reg2.entries['1'].removed, true);

  const incoming = [...withoutChangan.map((c) => ({ ref: c.ref, name: c.name })), { ref: 'C9999', name: '新野' }];
  const { registry: reg3, added } = reconcileRegistry(reg2, incoming);
  assert.equal(added.length, 1);
  const fresh = added[0];
  assert.notEqual(fresh.id, 1, '墓碑 ID 被复用');
  assert.equal(fresh.id, reg3.nextId - 1);
});

test('换版迁移：旧城留墓碑 ID 不复用，新城续号；视图与策略层同步', () => {
  // 54 版的许（id=23）已不在这张图里
  assert.equal(map.cities.some((c) => c.name === '许'), false, '许 应已移除');
  const reg23 = registry.entries['23'];
  assert.ok(reg23, '许 在注册表留痕');
  assert.ok(reg23.removed === true || reg23.name === '许');
  // 新城从 68 起续号，不占用墓碑号
  const maxId = Math.max(...map.cities.map((c) => c.id));
  assert.equal(registry.nextId - 1, maxId, 'nextId 应紧贴最大已分配号');
  assert.ok(maxId >= 68);
});

test('换城名又换 ref：凭别名认领孤儿，不另立新人', () => {
  const incoming = map.cities.map((c) => (
    c.ref === 'C0001' ? { ref: 'C0000', name: '洛阳', alias: ['雒阳'] } : { ref: c.ref, name: c.name, alias: c.alias }
  ));
  const { registry: reg2, renamed, added } = reconcileRegistry(registry, incoming);
  assert.equal(added.length, 0, '孤儿认领失败会误判为新城');
  assert.equal(renamed.filter((r) => r.id === 2).length, 1);
  assert.equal(reg2.entries['2'].ref, 'C0000');
  assert.equal(reg2.entries['2'].name, '洛阳');
});

test('道路端点在城名与 ref 都变化后仍解析（先 ref 后名）', () => {
  const renamed = map.cities.map((c) => (
    c.ref === 'C0001' ? { ...c, name: '洛阳' } : c
  ));
  const { map: map2, report } = buildStrategyMap(renamed, map.routes.map((r) => ({
    id: r.id, a_id: map.cities.find((c) => c.id === r.from)?.ref,
    b_id: map.cities.find((c) => c.id === r.to)?.ref,
    a: '', b: '', kind: r.kind, km: r.km, cost_days: r.costDays,
    difficulty: r.difficulty, sea: r.sea, cross_river: r.crossRiver,
  })), registry);
  assert.equal(report.warnings.length, 0);
  assert.equal(map2.routes.length, map.routes.length);
  const before = map.routes[0];
  const after = map2.routes.find((r) => r.id === before.id);
  assert.ok(before && after, '道路应保留');
  assert.deepEqual({ from: after.from, to: after.to }, { from: before.from, to: before.to });
});

test('挪位置不影响身份：只有 x/y 变化时零增删零改名', () => {
  const moved = map.cities.map((c) => ({ ...c, x: c.x + 7, y: c.y - 3 }));
  const { added, renamed, removed } = reconcileRegistry(registry, moved);
  assert.deepEqual({ added: added.length, renamed: renamed.length, removed: removed.length }, { added: 0, renamed: 0, removed: 0 });
});
