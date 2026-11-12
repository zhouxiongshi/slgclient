/**
 * 战略层：五十四城入世、八家诸侯按月决策、指令单执行、玩家被打时落到本地地图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import {
  strategyMap, factionConf, ensureStrategy,
  strategyTick, applyOrders, strategyViewState, localBrain, neighborsOf,
  strategyResolveMarches,
} from '../server/domain/strategy.js';
import { rewindDays } from '../server/clock.js';

const cfg = loadConfig();
const map = strategyMap();
const conf = factionConf();
const rules = { realMsPerDay: 60000, maxDaysPerSettle: 40, decreePerDay: 30 };

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, options: {}, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    schedule() {}, save() {}, log() {},
  };
}
const req = (name, msg = {}) => ({ seq: 1, name, msg });
const tick = (ctx) => handleRequest(ctx, req('role.myRoleRes'));
const cityByName = (name) => map.cities.find((c) => c.name === name);

test('东汉十三州模型图按州入世：八家诸侯归州，其余归汉廷，玩家本城绑定', () => {
  const state = createWorld(cfg);
  const st = ensureStrategy(state);
  assert.equal(Object.keys(st.cities).length, map.cities.length);
  const withBrain = new Set(conf.factions.map((f) => f.id));
  for (const c of map.cities) {
    if (c.name === conf.playerHome) continue;
    const owner = st.cities[c.id].owner;
    if (withBrain.has(c.provinceId)) assert.equal(owner, c.provinceId, `${c.name} 应归本州诸侯`);
    else assert.equal(owner, 'han', `${c.name} 无主州应归汉廷`);
  }
  assert.equal(st.cities[cityByName('长安').id].owner, 'sili');
  assert.equal(st.cities[cityByName('番禺').id].owner, 'han');
  const home = cityByName(conf.playerHome);
  assert.ok(home, `本城 ${conf.playerHome} 应在图中`);
  assert.equal(st.playerCity, home.id, '玩家本城应绑定');
  assert.equal(st.cities[home.id].owner, 'player', '本城归属玩家');
  assert.ok(neighborsOf(home.id).length >= 1, '本城应有邻接城可攻');
});

test('本地决策脑确定性：同 seed 同快照，指令单一致', () => {
  const faction = conf.factions[0];
  const snapshot = {
    turn: 3, season: '秋', seed: 20261110, faction: faction.id,
    own: { gold: 8000, grain: 12000, wood: 0, iron: 0, troops: 8000, cities: 4, mines: 0, heroes: [], front_pressure: 0 },
    cities: map.cities.map((c) => ({
      id: String(c.id), name: c.name, province: c.provinceId || '',
      is_capital: !!c.provinceCapital, owner: c.provinceId === faction.id ? faction.id : 'han',
      troops: 3000, defense: 0.4, confidence: 1,
    })),
    mines: [],
    neighbors: Object.fromEntries(map.routes.map((r) => [String(r.from), [String(r.to)]])),
    known_facts: [], visible_events: [], relations: {}, threat: {},
  };
  const a = localBrain(faction, snapshot, { seed: 20261110 });
  const b = localBrain(faction, snapshot, { seed: 20261110 });
  assert.deepEqual(a, b, '同种子必须得到同一份指令单');
  assert.ok(a.internal_orders.length >= 1, '至少一条内政令');
  assert.equal(a.protocol, 'slg-ai-orders-v1');
});

test('执行层：攻下弱守城、结盟改关系、事件进聊天', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const st = ensureStrategy(state);
  const faction = conf.factions[0];
  const weak = map.cities.find((c) => !conf.factions.some((f) => f.id === c.provinceId));
  st.cities[weak.id].troops = 100;
  st.cities[weak.id].defense = 0.1;
  applyOrders(state, cfg, ctx, faction, {
    protocol: 'slg-ai-orders-v1', turn: 1, faction: faction.id,
    internal_orders: [],
    strategy_orders: [
      { id: 'S1', type: '出征', target: String(weak.id), params: { troops: 5000 } },
      { id: 'S2', type: '结盟', target: conf.factions[1].id, params: {} },
    ],
  });
  assert.equal(st.cities[weak.id].owner, faction.id, '弱守城应易主');
  assert.equal(st.relations[`${faction.id}|${conf.factions[1].id}`], 'ally');
  assert.ok(st.events.some((e) => e.text.includes(`攻陷${weak.name}`)));
  assert.ok(ctx.pushes.some((p) => p.name === 'chat.push' && p.msg.msg.includes('攻陷')));
});

test('月度回合：十日一转，转日推进并留档', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  rewindDays(state, 5, rules);
  tick(ctx);
  assert.equal(state.clock.day, 6);
  assert.equal(state.strategy.turn, 0, '不满一月不应转');

  rewindDays(state, 4, rules);
  tick(ctx);
  assert.equal(state.clock.day, 10);
  assert.equal(state.strategy.turn, 1, '第 10 日应转第一月');
  assert.equal(state.strategy.lastTurnDay, 10);

  rewindDays(state, 3, rules);
  tick(ctx);
  assert.equal(state.strategy.turn, 1, '第 13 日不应再转');
});

test('诸侯打玩家的城：本地地图出现来犯军并推送', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const st = ensureStrategy(state);
  const faction = conf.factions[0];
  const playerCity = map.cities.find((c) => !conf.factions.some((f) => f.id === c.provinceId));
  st.cities[playerCity.id].owner = 'player';
  st.cities[playerCity.id].troops = 100;
  applyOrders(state, cfg, ctx, faction, {
    protocol: 'slg-ai-orders-v1', turn: 1, faction: faction.id,
    internal_orders: [],
    strategy_orders: [{ id: 'S1', type: '出征', target: String(playerCity.id), params: { troops: 2000 } }],
  });
  const assault = state.garrisons.find((g) => g.faction === faction.id);
  assert.ok(assault, '本地地图应出现来犯军');
  assert.equal(assault.name, `${faction.name}军`);
  assert.ok(ctx.pushes.some((p) => p.name === 'chat.push' && p.msg.msg.includes('来犯')));
  assert.equal(st.cities[playerCity.id].owner, 'player', '战略层归属不变，输赢由本地战报定');
});

test('策略状态接口：视图含城、路、势力、事件', () => {
  const state = createWorld(cfg);
  const view = strategyViewState(state);
  assert.equal(view.cities.length, 72);
  assert.equal(view.routes.length, 117);
  assert.equal(view.factions.length, 8);
  assert.ok(view.cities.every((c) => c.color && c.ownerName));
  assert.ok(view.routes.every((r) => Array.isArray(r.points) && r.points.length >= 2));
  assert.ok(view.playerCity > 0, '视图应带玩家本城');
});

test('城战：本城出兵打邻接城，胜则易主且动画随战报', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const st = ensureStrategy(state);
  const homeId = st.playerCity;
  // 主军满兵压上
  state.armys[0].soldiers = [2000, 0, 0];
  const targetId = require0(homeId);
  function require0(hid) {
    const adj = neighborsOf(hid);
    const t = adj.find((id) => st.cities[id].owner !== 'player');
    assert.ok(t, '本城应有可攻邻城');
    return t;
  }
  const target = strategyMap().cities.find((c) => c.id === targetId);
  st.cities[targetId].troops = 10;
  st.cities[targetId].defense = 0.1;
  const rsp = handleRequest(ctx, req('strategy.attack', { cityId: targetId, armyId: state.armys[0].id }));
  assert.equal(rsp.msg.ok, true, `城战应成功：${JSON.stringify(rsp.msg)}`);
  assert.equal(rsp.msg.marching, true, '出征先生成行军队列');
  // ★ P2：行军到到达日再结算
  state.clock.day = rsp.msg.arriveDay + 1;
  const fought = strategyResolveMarches(state, cfg, ctx);
  assert.equal(fought.length, 1);
  assert.equal(fought[0].result, 2, '2000 兵打 10 兵守军应胜');
  assert.equal(st.cities[targetId].owner, 'player', '胜利后城池易主');
  assert.equal(fought[0].city, target.name);
  const pushedReport = ctx.pushes.find((p) => p.name === 'warReport.push');
  assert.ok(pushedReport, '应推送战报');
  assert.equal(pushedReport.msg.anim.place, target.name, '动画应带城名');
  assert.ok(ctx.pushes.some((p) => p.name === 'chat.push' && p.msg.msg.includes('攻陷')));

  // 非邻接城拒绝
  const far = strategyMap().cities.find((c) => c.id !== homeId
    && !neighborsOf(homeId).includes(c.id) && st.cities[c.id].owner !== 'player');
  const rsp2 = handleRequest(ctx, req('strategy.attack', { cityId: far.id, armyId: state.armys[0].id }));
  assert.equal(rsp2.msg.ok, false);
});

test('城战：非本城守军打不动自己的城', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const st = ensureStrategy(state);
  const rsp = handleRequest(ctx, req('strategy.attack', { cityId: st.playerCity, armyId: state.armys[0].id }));
  assert.equal(rsp.msg.ok, false);
});
