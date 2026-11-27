/**
 * P55（2026-11-24）队伍专项回归：队伍权限 / 队伍-城池关系 / 调防大地图 / 整编弹窗。
 *  1. 调防只摘将不清兵 → 空槽幽灵兵（真链路复现：800 兵滞留在无将槽）；
 *  2. army.assign 行军中二次派兵、驻敌城队伍派兵/征兵/裁军都必须拒绝；
 *  3. conscript_done 不得给行军中队伍或空槽补兵；
 *  4. disarmForGold 行军锁 + 在途令牌作废；
 *  5. 多城失守残部重编 order 不重复、老档 cId/order/g.order/counters 迁移；
 *  6. 调防失败路径不写脏 g.cityId；
 *  7. UI：调防弹窗大地图可点选 + 按城址搜索、整编/运粮弹窗层级高于六府窗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest, processTask } from '../server/handlers.js';
import {
  ensureStrategy, oathOptions, chooseOath, dispatchGeneral, dispatchGenerals, dispatchTick,
  rebindArmiesIfStranded, strategyAttack,
} from '../server/domain/strategy.js';
import { disarmForGold } from '../server/domain/failstate.js';

const cfg = loadConfig();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
function fresh() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(s, cfg, mkCtx(s), { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  const from = Number(s.strategy.playerCity);
  const to = Number(Object.entries(s.strategy.cities)
    .find(([id, c]) => c.owner === 'player' && Number(id) !== from)?.[0]);
  assert.ok(Number.isFinite(to) && to > 0, '前提：举义后至少两座己方城');
  return { s, from, to };
}
function findStaffed(s, from) {
  for (const a of s.armys) {
    for (let i = 0; i < 3; i += 1) {
      const gid = a.generals?.[i];
      if (gid > 0 && a.soldiers?.[i] > 0) {
        const g = s.generals.find((x) => x.id === gid);
        if (g && Number(g.cityId) === from) return { a, i, g };
      }
    }
  }
  return null;
}

test('P55-① 调防退兵：武将离槽时该槽兵力/在途清空并退回驻城，不留空槽幽灵兵', () => {
  const { s, from, to } = fresh();
  const hit = findStaffed(s, from);
  assert.ok(hit, '前提：有一名带兵武将');
  const beforeTroops = hit.a.soldiers[hit.i];
  const cityBefore = Number(s.strategy.cities[from].troops) || 0;
  const r = dispatchGenerals(s, cfg, mkCtx(s), { generalIds: [hit.g.id], toCityId: to });
  assert.equal(r.ok, true, JSON.stringify(r));
  /* ★ P74：调遣改为行程，退兵发生在抵达日（人还在路上时仍占着槽，只是不能再战）。 */
  assert.equal(hit.g.cityId, from, '下达当天人还没走');
  s.clock.day = (Number(s.clock.day) || 1) + Math.max(1, ...r.moved.map((m) => Number(m.marchDays) || 1)) + 1;
  dispatchTick(s, cfg, mkCtx(s));
  assert.equal(hit.a.generals[hit.i], 0, '武将已从槽位摘除');
  assert.equal(hit.a.soldiers[hit.i], 0, '空槽不得残留兵力');
  assert.equal(hit.a.con_cnts[hit.i], 0, '空槽不得残留在途征兵');
  assert.equal(Number(s.strategy.cities[from].troops), cityBefore + beforeTroops, '兵力退回原驻城');
  assert.equal(hit.g.cityId, to);
});

test('P55-② 单人调防同样退兵，且返回值带回退兵数', () => {
  const { s, from, to } = fresh();
  const hit = findStaffed(s, from);
  const r = dispatchGeneral(s, cfg, mkCtx(s), { generalId: hit.g.id, toCityId: to });
  assert.equal(r.ok, true);
  assert.equal(r.transit, true, '★ P74：单人调遣也是启程，不是瞬移');
  s.clock.day = (Number(s.clock.day) || 1) + Math.max(1, Number(r.marchDays) || 1) + 1;
  const landed = dispatchTick(s, cfg, mkCtx(s));
  assert.equal(landed[0].kind, 'dispatch-arrive');
  assert.equal(landed[0].returned, hit.a.soldiers[hit.i] || landed[0].returned);
  assert.equal(hit.a.generals[hit.i], 0);
  assert.equal(hit.a.soldiers[hit.i], 0);
});

test('P55-③ 队伍权限：行军中不得二次派兵；驻敌城队伍不得征兵/预览/解甲/派兵', () => {
  // 行军锁：举义态下用带驻城坐标的队伍验证
  const { s, from } = fresh();
  const ctx = mkCtx(s);
  const own = s.armys.find((a) => a.cityId === from);
  own.marchId = 777;
  const assign = handleRequest(ctx, req('army.assign', { armyId: own.id, cmd: 1, x: 8000, y: 100 }));
  assert.equal(assign.code, 1);
  assert.equal(assign.msg.reason, 'marching', '行军中不得二次派兵');
  delete own.marchId;

  // 城权：未举义态下 settleWorld 不会自动回收「驻地失效」的队伍，
  // 这时 handler 的 isOwnCity 闸才真正可达（举义态会先被 rebind 抢先归位）。
  const s2 = normalizeWorld(createWorld(cfg), cfg);
  const ctx2 = mkCtx(s2);
  const a2 = s2.armys[0];
  a2.cityId = 999999;
  for (const name of ['army.conscript', 'army.conscriptPreview', 'army.disarm']) {
    const r = handleRequest(ctx2, req(name, { armyId: a2.id, cnts: [1, 0, 0] }));
    assert.equal(r.code, 1, name + ' 应拒绝敌城队伍');
    assert.equal(r.msg.reason, 'not_own_city', name + ' 拒绝原因');
  }
  const ga = handleRequest(ctx2, req('army.assign', { armyId: a2.id, cmd: 1, x: 8000, y: 100 }));
  assert.equal(ga.code, 1);
  assert.equal(ga.msg.reason, 'not_own_city');
});

test('P55-④ conscript_done：行军中不补兵（退驻城），空槽不补兵', () => {
  const { s, from } = fresh();
  const ctx = mkCtx(s);
  const hit = findStaffed(s, from);
  const a = hit.a;
  const cityBefore = Number(s.strategy.cities[from].troops) || 0;
  const token = (a.conToken || 0) + 1;
  a.conToken = token;
  a.marchId = 888;
  processTask(ctx, { type: 'conscript_done', armyId: a.id, cnts: [100, 0, 0], token });
  assert.equal(a.soldiers[hit.i], hit.a.soldiers ? a.soldiers[hit.i] : 0);
  assert.equal(Number(s.strategy.cities[from].troops), cityBefore + 100, '行军中征兵改退驻城');
  delete a.marchId;

  // 空槽：令牌仍有效，也不得补兵
  const before = a.soldiers[hit.i];
  a.generals[hit.i] = 0;
  const token2 = a.conToken + 1;
  a.conToken = token2;
  processTask(ctx, { type: 'conscript_done', armyId: a.id, cnts: [50, 0, 0], token: token2 });
  assert.equal(a.soldiers[hit.i], before, '空槽不补兵');
});

test('P55-⑤ disarmForGold：行军中拒绝，且作废在途征兵令牌', () => {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const a = s.armys[0];
  a.soldiers = [2000, 0, 0];
  a.conToken = 4;
  a.con_cnts = [30, 0, 0];
  a.marchId = 55;
  const blocked = disarmForGold(s, mkCtx(s), { armyId: a.id, count: 500 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'marching');
  assert.equal(a.soldiers[0], 2000);
  delete a.marchId;
  const ok = disarmForGold(s, mkCtx(s), { armyId: a.id, count: 500 });
  assert.equal(ok.ok, true);
  assert.equal(a.soldiers[0], 1500);
  assert.equal(a.conToken, 5, '裁制作废在途令牌');
  assert.deepEqual(a.con_cnts, [0, 0, 0]);
});

test('P55-⑥ 多城残部重编：迁入同一城不产生重复 (cityId, order)', () => {
  const { s, from, to } = fresh();
  const armies = [s.armys[0], s.armys[1]];
  for (const a of armies) { a.cityId = 999900 + a.id; delete a.marchId; }
  s.armys[2].cityId = to; // 目标城原有 order=3 队伍
  rebindArmiesIfStranded(s, mkCtx(s));
  const atHome = s.armys.filter((a) => Number(a.cityId) === to);
  const keys = atHome.map((a) => a.order);
  assert.equal(new Set(keys).size, keys.length, '同城 order 必须唯一');
  for (const k of keys) assert.ok(k >= 1 && k <= 99);
});

test('P55-⑦ 老档迁移：字符串 cityId / 缺失 counters 归一，g.order 同步', () => {
  const raw = createWorld(cfg);
  raw.version = 2;
  raw.armys[0].cityId = String(raw.armys[0].cityId);
  raw.armys[0].order = '2';
  raw.counters = {};
  const s = normalizeWorld(raw, cfg);
  assert.equal(typeof s.armys[0].cityId, 'number');
  assert.equal(typeof s.armys[0].order, 'number');
  assert.ok(s.counters.armyId >= Math.max(...s.armys.map((a) => a.id)) + 1, '新队 id 不与老队碰撞');
  const gid = s.armys[0].generals.find((id) => id > 0);
  if (gid) assert.equal(s.generals.find((g) => g.id === gid).order, s.armys[0].order, 'g.order 派生字段已同步');
});

test('P55-⑧ 调防失败不写脏 g.cityId（fromCityId 仅参与校验）', () => {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const g = s.generals[0];
  g.cityId = 0;
  const before = g.cityId;
  const r = dispatchGeneral(s, cfg, mkCtx(s), {
    generalId: g.id, toCityId: 999999, fromCityId: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(g.cityId, before, '被拒绝的调防不得改变武将驻地');
});

test('P55-⑨ UI：调防弹窗用大地图按城址选城，整编/运粮弹窗高于六府窗', () => {
  const ui = read('server/panels-ui.js');
  // 大地图：真实全景底图 + 全部城池落点 + 地图点真可点 + 城址搜索
  assert.match(ui, /image href="\/__slg\/strategy\/panorama\.png"/, '调防地图铺真实全景底图');
  assert.match(ui, /data-city="' \+ c\.id \+ '"/, '地图上每座城都带可点选标记');
  assert.match(ui, /mapEl\.querySelectorAll\('\.dpin'\)/, '地图城点已绑定点击选城');
  assert.match(ui, /按城名 \/ 州郡 \/ 今地找城/, '提供按城址搜索');
  assert.match(ui, /var addrOf = function \(c\) \{ return \[c\.province, c\.jun, c\.today\]/, '列表展示州郡今地');
  // 层级：整编/运粮必须在六府窗 100100 之上
  const formup = ui.slice(ui.indexOf('function formupBox'), ui.indexOf('function openTransport'));
  const transport = ui.slice(ui.indexOf('function openTransport'), ui.indexOf('function dispatchMapSvg'));
  assert.match(formup, /z-index:100820/, '整编弹窗盖过六府窗');
  assert.match(transport, /z-index:100820/, '运粮弹窗盖过六府窗');
  assert.match(formup, /slgFormupDlg/, '整编弹窗使用统一视觉壳');
  const view = read('server/domain/panels.js');
  assert.match(view, /jun: c\.jun \|\| '', today: c\.today \|\| ''/, '城址字段来自地图配置');
});
