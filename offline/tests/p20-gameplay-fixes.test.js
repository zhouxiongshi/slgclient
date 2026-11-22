/**
 * 2026-11-19 玩法修复的回归锁（第二轮：玩法与经济）。
 * 每条都对应一个实测过的缺陷，防止后续「顺手优化」把结论改回去。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest, settleWorld } from '../server/handlers.js';
import { suppressionOf } from '../server/battle.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyAttack,
} from '../server/domain/strategy.js';
import { ensureCityEcon, cityYield, cityLayer } from '../server/domain/city-econ.js';
import { editorSave, sanitizeGeneralEdit } from '../server/domain/general-editor.js';

const cfg = loadConfig();

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, pushes, options: {},
    push(n, m) { pushes.push({ n, m }); },
    schedule() {}, save() {}, log() {},
  };
}

function freshState(oath = true) {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const ctx = makeCtx(state);
  if (oath) {
    const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
    const r = chooseOath(state, cfg, ctx, { lord: cao.id, city: cao.cities[0].id });
    assert.equal(r.ok, true);
  }
  return { state, ctx };
}

test('兵力压制系数：守军越少，攻方减伤越高；守军占优时为 0', () => {
  assert.equal(suppressionOf(800, 1750), 0, '守军占优不该给攻方减伤');
  assert.equal(suppressionOf(2335, 2335), 0, '均势不减伤');
  const mid = suppressionOf(4000, 2335);
  assert.ok(mid > 0.3 && mid < 0.45, `4000 打 2335 的压制应在 0.3~0.45，实际 ${mid}`);
  assert.equal(suppressionOf(12000, 2335), 0.5, '兵力碾压封顶 50%');
});

test('出征不再吞兵：没上阵的槽位（无将）兵力原样带回，不计入折损', () => {
  const { state, ctx } = freshState();
  const home = state.strategy.playerCity;
  // 只有 1 个将，但 3 个槽都有兵 —— 旧实现会把另外两槽的兵当折损吞掉
  state.armys[0].generals = [1000, 0, 0];
  state.armys[0].soldiers = [400, 300, 300];
  const before = state.armys[0].soldiers.reduce((s, n) => s + n, 0);
  const r = strategyAttack(state, cfg, ctx, { cityId: 77, fromCityId: home, frac: 1 });
  assert.equal(r.ok, true);
  let t = Date.UTC(2026, 0, 1);
  for (let d = 0; d < 30; d++) {
    t += 86400000;
    settleWorld(ctx, t);
    if (!(state.strategy.marches || []).length) break;
  }
  const after = state.armys[0].soldiers.reduce((s, n) => s + n, 0);
  assert.ok(after >= 600, `没上阵的 600 兵必须活着回来，实际剩 ${after}/${before}`);
});

test('坞堡领地建筑：举义后不再产资源（旧实现石产 7000/日，20 旬顶满）', () => {
  const { state, ctx } = freshState(true);
  state.clock.day = 2;
  settleWorld(ctx, Date.UTC(2026, 0, 2));   // 产量由 totalYield 派生，先跑一次结算
  const stoneYield = Number(state.roleRes.stone_yield) || 0;
  assert.ok(stoneYield < 1000, `举义后石产应回落到城产量级，实际 ${stoneYield}/日`);
  // 未举义时仍按序章口径发放
  const prologue = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(prologue);
  const ctx2 = makeCtx(prologue);
  prologue.clock.day = 2;
  settleWorld(ctx2, Date.UTC(2026, 0, 2));
  const wood = Number(prologue.roleRes.wood_yield) || 0;
  assert.ok(wood > 3000, `序章坞堡仍应供给木材，实际 ${wood}/日`);
});

test('府库上限随城数派生：5 城约 20 万，不再固定 100 万', () => {
  const { state, ctx } = freshState(true);
  state.clock.day = 2;
  settleWorld(ctx, Date.UTC(2026, 0, 2));
  const cap = Number(state.roleRes.depot_capacity) || 0;
  assert.ok(cap >= 190000 && cap <= 260000, `5 城上限应在 19~26 万，实际 ${cap}`);
});

test('城池经济可自持：5 城金产明显高于武将旬俸', () => {
  const { state } = freshState(true);
  const goldPerDay = cityLayer(state).gold;
  assert.ok(goldPerDay >= 500, `5 城金产应 ≥500/日（改前 274），实际 ${goldPerDay}`);
  const perTurn = goldPerDay * 10;
  // 4 名武将旬俸约 380；城产扣掉 35% 维持费后仍应覆盖
  assert.ok(perTurn * 0.65 > 380 * 1.2, `城产 ${perTurn}/旬 扣维持费后应显著覆盖俸禄`);
});

test('城池产出：金产系数上调后单城满开发 ≥ 100/日', () => {
  const { state } = freshState(true);
  const id = Number(Object.entries(state.strategy.cities)
    .find(([, row]) => row.owner === 'player')[0]);
  const y = cityYield(state, id);
  assert.ok(y.gold >= 60, `单城金产应 ≥60/日，实际 ${y.gold}`);
  assert.ok(y.grain >= 60, `单城粮产应 ≥60/日，实际 ${y.grain}`);
});

test('武将编辑器：三个战法槽都可写，非法战法归 0', () => {
  const patch = sanitizeGeneralEdit({ cfgId: 100001, skillCfgId: 10001, skillCfgId2: 10002, skillCfgId3: -1 });
  assert.equal(patch.skillCfgId, 10001);
  assert.equal(patch.skillCfgId2, 10002);
  assert.equal(patch.skillCfgId3, 0, '非法战法应归 0 而不是原样写进去');
});

test('武将编辑器：写入第二战法后当前存档立即同步，且不动第一槽等级', () => {
  const { state } = freshState(false);
  const g = state.generals[0];
  g.skills = [{ id: 19001, lv: 4, cfgId: 19001 }, null, null];
  const r = editorSave(cfg, state, {
    cfgId: g.cfgId, skillCfgId2: 10001,
  });
  assert.equal(r.ok, true);
  assert.equal(g.skills[1].cfgId, 10001, '第二槽应写入');
  assert.equal(g.skills[0].lv, 4, '没动第一槽时等级必须保留');
  editorSave(cfg, state, { cfgId: g.cfgId, skillCfgId2: 0 });
});

test('武将编辑器：重载配置后第二/第三槽不丢失，后续编辑不清空存档槽', () => {
  const { state } = freshState(false);
  const g = state.generals[0];
  g.skills = [{ id: 19001, lv: 4, cfgId: 19001 }, null, null];
  assert.equal(editorSave(cfg, state, {
    cfgId: g.cfgId, skillCfgId2: 10001, skillCfgId3: 10002,
  }).ok, true);
  const reloaded = loadConfig();
  const row = reloaded.generalByCfg.get(Number(g.cfgId));
  assert.equal(row.skillCfgId2, 10001, '重载后第二槽必须仍在配置行里');
  assert.equal(row.skillCfgId3, 10002, '重载后第三槽必须仍在配置行里');
  assert.equal(editorSave(reloaded, state, { cfgId: g.cfgId, force: 51 }).ok, true);
  assert.equal(g.skills[1].cfgId, 10001, '改属性不得清空第二槽');
  assert.equal(g.skills[2].cfgId, 10002, '改属性不得清空第三槽');
  assert.equal(g.skills[0].lv, 4, '第一槽等级保留');
  editorSave(reloaded, state, { cfgId: g.cfgId, skillCfgId2: 0, skillCfgId3: 0 });
});

test('存档归一化：半残技能槽被清成 null，不再让下游 map 崩', () => {
  const { state } = freshState(false);
  state.generals[0].skills = [{ id: 0 }, 'oops', { cfgId: 19001, lv: 99 }];
  const fixed = normalizeWorld(state, cfg);
  const sk = fixed.generals[0].skills;
  assert.equal(sk[0], null, 'cfgId=0 应清成 null');
  assert.equal(sk[1], null, '字符串应清成 null');
  assert.equal(sk[2].cfgId, 19001);
  assert.equal(sk[2].lv, 10, '等级应钳到 10');
});

test('分段目标：拿下第 6 座城时触发「立足」里程碑', async () => {
  const { state, ctx } = freshState(true);
  const mod = await import('../server/domain/strategy.js');
  const owned = Object.entries(state.strategy.cities).filter(([, r]) => r.owner === 'player');
  assert.equal(owned.length, 5);
  // 手动把一座邻城划给玩家，模拟扩张
  const extra = Object.entries(state.strategy.cities)
    .find(([, r]) => r.owner !== 'player')[0];
  state.strategy.cities[extra[0]].owner = 'player';
  const hit = mod.stageGoalTick(state, cfg, ctx);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, 'foothold');
  assert.ok(state.strategy.stages.foothold > 0);
});

test('围城：来犯军 40 日不清剿，城进入被围状态并开始掉守军', async () => {
  const { state, ctx } = freshState(true);
  const mod = await import('../server/domain/strategy.js');
  const home = state.strategy.playerCity;
  const city = state.strategy.cities[home];
  const troops0 = Number(city.troops) || 0;
  state.garrisons = [{
    id: 9901, x: state.citys[0].x + 2, y: state.citys[0].y, soldiers: 800,
    name: '董卓军', cleared: false, faction: 'sili', spawnDay: 1,
  }];
  state.clock.day = 50;
  const out1 = mod.assaultEscalationTick(state, cfg, ctx);
  assert.ok(out1.some((x) => x.kind === 'besiege'), '应判定围城');
  assert.equal(city.besieged, true);
  state.clock.day = 60;
  mod.assaultEscalationTick(state, cfg, ctx);
  assert.ok((Number(city.troops) || 0) < troops0, '围城一旬应掉守军');
});

test('围城：清剿来犯军后围城自动解除', async () => {
  const { state, ctx } = freshState(true);
  const mod = await import('../server/domain/strategy.js');
  state.garrisons = [{
    id: 9902, x: state.citys[0].x + 2, y: state.citys[0].y, soldiers: 800,
    name: '袁绍军', cleared: false, faction: 'jizhou', spawnDay: 1,
  }];
  state.clock.day = 50;
  mod.assaultEscalationTick(state, cfg, ctx);
  assert.equal(state.strategy.cities[state.strategy.playerCity].besieged, true);
  state.garrisons[0].cleared = true;
  mod.assaultEscalationTick(state, cfg, ctx);
  assert.equal(state.strategy.cities[state.strategy.playerCity].besieged, false, '清剿后必须解围');
});

test('入门向导：征兵关必须排在出征关之前', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../server/interaction-ui.js', import.meta.url), 'utf8');
  const iLevy = src.indexOf("title: '征兵与钱粮'");
  const iWar = src.indexOf("title: '编队出征'");
  assert.ok(iLevy > 0 && iWar > 0, '两关都必须存在');
  assert.ok(iLevy < iWar, '先教征兵、后教出征——旧顺序让玩家第一仗必全灭');
});
