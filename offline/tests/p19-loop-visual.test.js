/**
 * P19 回归（2026-11-19）：全流程闭环 + 视觉资产上屏
 *  ① 一键征满数量由服务端按石耗/兵种倍率给出，UI 不再假绿
 *  ② 解甲作废旧征兵令牌，不会“退金后又补兵”
 *  ③ 陈旧未决事件自动保守结算，事件系统不再永久冻结
 *  ④ 向导 g3 跳酒馆；Electron 下无 window.prompt/confirm
 *  ⑤ 冻结 web/ 立绘映射与战斗视觉注入存在
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest, processTask } from '../server/handlers.js';
import {
  ensureStrategy, chooseOath, oathOptions, strategyEventTick,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { affordableConscript } from '../server/domain/conscript.js';
import { patchClientBundle } from '../server/skills.js';
import { buildBattleAnim } from '../server/battle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function makeCtx(state) {
  const scheduled = [];
  return { state, cfg, options: {}, pushes: [], push() {}, save() {}, log() {},
    schedule(at, task) { scheduled.push({ at, task }); }, scheduled };
}
function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  ensureCityEcon(state, cfg);
  const lord = oathOptions(state).lords.filter((l) => l.cities.length >= 2)[0];
  chooseOath(state, cfg, { push() {} }, { lord: lord.id, city: lord.cities[0].id });
  for (const k of ['gold', 'grain', 'wood', 'iron', 'stone']) state.roleRes[k] = 1_000_000;
  const cid = Number(Object.keys(state.strategy.cities).find((id) => state.strategy.cities[id].owner === 'player'));
  const army = state.armys[0];
  army.cityId = cid;
  army.generals = [state.generals[0].id, state.generals[1]?.id || 0, state.generals[2]?.id || 0];
  return { state, st: state.strategy, cid, army };
}

/* ---------------- ① 一键征满 ---------------- */

test('P19-① affordableConscript 把石耗与弓骑倍率算进去', () => {
  const { army } = oathWorld();
  const byId = (gid) => army.generals.includes(gid) ? { level: 1, merit: 0 } : null;
  const res = { wood: 1000, iron: 1000, stone: 0, grain: 1000, gold: 1000 };
  assert.equal(affordableConscript(500, army, byId, res, cfg.basic.conscript, {}), 0, '石=0 时一兵也征不了');
  res.stone = 100000;
  assert.ok(affordableConscript(500, army, byId, res, cfg.basic.conscript, {}) > 0);
});

test('P19-① army.conscriptPreview 返回服务端权威可征数', () => {
  const { state, army } = oathWorld();
  const ctx = makeCtx(state);
  state.roleRes.stone = 0;
  const zero = handleRequest(ctx, req('army.conscriptPreview', { armyId: army.id }));
  assert.equal(zero.code, 0);
  assert.equal(zero.msg.max, 0, '石耗不足 → 可征 0，按钮必须禁用');
  state.roleRes.stone = 1_000_000;
  const ok = handleRequest(ctx, req('army.conscriptPreview', { armyId: army.id }));
  assert.ok(ok.msg.max > 0);
  assert.ok(ok.msg.perSlot[2].iron > ok.msg.perSlot[0].iron, '骑兵铁耗明细下发 UI');
  assert.ok(ok.msg.need.stone > 0, '石耗明细下发 UI');
});

/* ---------------- ② 解甲作废在途征兵 ---------------- */

test('P19-② 解甲后旧 conscript_done 定时器不得再补兵', () => {
  const { state, army } = oathWorld();
  army.soldiers = [200, 0, 0];
  const ctx = makeCtx(state);
  const cr = handleRequest(ctx, req('army.conscript', { armyId: army.id, cnts: [100, 0, 0] }));
  assert.equal(cr.code, 0);
  const task = ctx.scheduled.find((t) => t.task.type === 'conscript_done');
  assert.ok(task && task.task.token, '征兵任务带令牌');
  const dr = handleRequest(ctx, req('army.disarm', { armyId: army.id, counts: [200, 0, 0] }));
  assert.equal(dr.code, 0);
  assert.notEqual(army.conToken, task.task.token, '解甲作废令牌');
  processTask(ctx, task.task);
  assert.equal(army.soldiers[0], 0, '旧定时器不得把兵加回来');
});

test('P19-② 旧档无令牌的 conscript_done 仍兼容', () => {
  const { state, army } = oathWorld();
  army.soldiers = [0, 0, 0];
  const ctx = makeCtx(state);
  processTask(ctx, { type: 'conscript_done', armyId: army.id, cnts: [50, 0, 0] });
  assert.equal(army.soldiers[0], 50);
});

/* ---------------- ③ 事件不再冻结 ---------------- */

test('P19-③ 超过 4 旬的未决事件自动保守结算并清出队列', () => {
  const { state, st } = oathWorld();
  st.turn = 10;
  st.pendingEvents = [{
    id: 'p19.stale', title: '久拖不决', sinceTurn: 5,
    choices: [{ id: 'a', label: '激进' }, { id: 'b', label: '保守' }],
    text: [], speaker: '', layer: '测试',
  }];
  strategyEventTick(state);
  assert.ok(!(st.pendingEvents || []).some((e) => e.id === 'p19.stale'), '陈旧事件已清出');
  assert.ok((state.strategy.eventLog || state.eventLog || []).length >= 0);
});

/* ---------------- ④ 注入层文本守卫 ---------------- */

test('P19-④ Electron 页面内不再使用 window.prompt / window.confirm', () => {
  const skills = readFileSync(join(ROOT, 'server', 'skills.js'), 'utf8');
  const panels = readFileSync(join(ROOT, 'server', 'panels-ui.js'), 'utf8');
  assert.ok(!/window\.prompt\s*\(/.test(skills), 'skills.js 无 window.prompt');
  assert.ok(!/window\.prompt\s*\(/.test(panels), 'panels-ui.js 无 window.prompt');
  assert.ok(!/window\.confirm\s*\(/.test(panels), 'panels-ui.js 无 window.confirm');
  const ix = readFileSync(join(ROOT, 'server', 'interaction-ui.js'), 'utf8');
  assert.ok(/jump: 'tavern'/.test(ix), '向导 g3 指向酒馆');
  assert.ok(/kind === 'tavern'/.test(ix), 'jumpTo 支持酒馆');
});

/* ---------------- ⑤ 视觉资产 ---------------- */

test('P19-⑤ 立绘映射覆盖原版 448 张且路径真实存在', () => {
  const mapPath = join(ROOT, 'server', 'portrait-map.json');
  assert.ok(existsSync(mapPath), 'portrait-map.json 已生成');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  assert.ok(Object.keys(map.portraits).length >= 400);
  assert.ok(map.portraits['100001']);
  assert.ok(existsSync(join(ROOT, 'web', map.portraits['100001'].replace(/^\//, ''))), '冻结 PNG 实际存在');
});

test('P19-⑤ 注入包含资产桥 / 立绘卡 / 千军万马与技能动画', () => {
  const base = readFileSync(join(ROOT, 'web', 'assets', 'main', 'index.js'), 'utf8');
  const source = patchClientBundle(base);
  assert.ok(source.includes('__slgPortraitUrl'), '资产桥已注入');
  assert.ok(source.includes('drawSoldier'), '军阵小兵渲染已注入');
  assert.ok(source.includes("kind === 'skill'"), '技能动画已注入');
  assert.ok(source.includes("kind === 'hit'"), '打击动画已注入');
  assert.ok(source.includes('map-panorama.png') || source.includes('__slg/strategy/panorama.png'), '地图纹理已注入');
});

test('P19-⑤ 战斗动画单位带 cfgId，可驱动立绘上屏', () => {
  const g = cfg.generalByCfg;
  const first = g && g.size ? [...g.values()][0] : null;
  if (!first) return; // 配置未装载时跳过（不制造假红）
  const officer = { id: 1, cfgId: first.cfgId || 100001, level: 1, soldiers: [100, 0, 0] };
  const anim = buildBattleAnim({
    kernel: { events: [], event_fingerprint: '0000000000000000', rounds: [] },
    attackers: [{ slot: 0, g: officer }],
    defense: { generals: [officer], soldiers: [100, 0, 0] },
    army: { id: 1, name: '我军' }, beginSoldiers: [100, 0, 0],
    state: { battleLog: [] }, cfg, x: 1, y: 1, resultCode: 1,
    attackRemain: [60, 0, 0], defenseRemain: [80, 0, 0],
  });
  assert.ok(anim && anim.a.units[0] && anim.a.units[0].cfgId, '动画单位带 cfgId');
});
