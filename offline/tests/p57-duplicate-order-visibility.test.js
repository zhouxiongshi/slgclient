/**
 * P57（2026-11-24 用户截图）：同城重复 order 让主公所在真队伍被同号队伍覆盖。
 * 表现：征兵页第 1 军显示别人的武将，主公在下拉里被标「在编」且无法选择/组队。
 * 修复：读档与每次世界推进前拆开重复 (cityId, order)，不动兵与驻地。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest, settleWorld } from '../server/handlers.js';
import { normalizeArmyOrders } from '../server/domain/formation.js';

const cfg = loadConfig();
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
const fresh = () => normalizeWorld(createWorld(cfg), cfg);
const heroOf = (s) => s.generals.find((g) => g.isProtagonist || Number(g.cfgId) === 880001);
function duplicateOrder(s) {
  const heroArmy = s.armys[0];
  const other = s.armys[1];
  other.cityId = heroArmy.cityId;
  other.order = heroArmy.order;         // 与主公队伍同城同号：UI 索引会互相覆盖
  other.generals = [0, 0, 0];
  other.soldiers = [0, 0, 0];
  return other;
}

test('P57-① 领域归一：同城重复 order 顺延到空号，兵与驻地不变', () => {
  const s = fresh();
  const heroArmy = s.armys[0];
  const other = duplicateOrder(s);
  const city = other.cityId;
  const changed = normalizeArmyOrders(s);
  assert.equal(changed.length, 1);
  assert.equal(other.order, 2, '重复队顺延到首个空号（本例 2）');
  assert.equal(other.cityId, city, '不搬驻地');
  assert.equal(heroArmy.order, 1, '先建的队伍保留原编号');
  assert.equal(heroArmy.generals[0], heroOf(s).id, '主公仍在原队');
  assert.equal(heroOf(s).order, 1, '派生 order 同步');
});

test('P57-② 读档修复：征兵页按 order 取到的第 1 军就是主公所在队伍', () => {
  const raw = createWorld(cfg);
  const heroArmy = raw.armys[0];
  raw.armys[1].cityId = heroArmy.cityId;
  raw.armys[1].order = heroArmy.order;
  raw.armys[1].generals = [0, 1001, 0];
  raw.generals.push({ id: 1001, cfgId: 100001, level: 1, cityId: heroArmy.cityId, skills: [] });
  const s = normalizeWorld(raw, cfg);
  const ctx = mkCtx(s);
  const r = handleRequest(ctx, { seq: 1, name: 'army.myList', msg: { cityId: heroArmy.cityId } });
  assert.equal(r.code, 0);
  const first = r.msg.armys.find((a) => a.order === 1);
  assert.equal(first.generals[0], heroOf(s).id, '第 1 军必须显示主公，不再被覆盖');
  assert.equal(r.msg.armys.find((a) => a.order === 2).generals[1], 1001, '重号队伍完整保留');
  assert.equal(first.soldiers[0], 800, '兵力不丢');
});

test('P57-③ 无需重启：世界推进前也拆重复队号，主公立刻可见', () => {
  const s = fresh();
  const heroArmy = s.armys[0];
  duplicateOrder(s);
  const ctx = mkCtx(s);
  settleWorld(ctx);
  const r = handleRequest(ctx, { seq: 1, name: 'army.myList', msg: { cityId: heroArmy.cityId } });
  assert.equal(r.msg.armys.find((a) => a.order === 1).generals[0], heroOf(s).id);
  assert.equal(new Set(r.msg.armys.map((a) => `${a.cityId}:${a.order}`)).size, r.msg.armys.length,
    '同城队号唯一');
});
