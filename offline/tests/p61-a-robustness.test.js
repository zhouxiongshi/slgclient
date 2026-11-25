/**
 * P61-A（2026-11-25）评估修复第一批回归：
 *  B1 畸形存档不再启动崩溃；B2 州治表真正参与结局判定；
 *  B3 征收次数按游戏日重置；B4 集市兑换率由服务端核算；
 *  B6 事件倒计时/暂缓/关闭自动结案；B7 求援只认真实盟友。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld, repairArrayFields } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import {
  ensureStrategy, chooseOath, oathOptions,
  strategyEventDefer, strategySetEventAutoResolve, strategyEventTick,
} from '../server/domain/strategy.js';
import { evaluateEnding } from '../server/domain/failstate.js';
import { aiAidRequest } from '../server/domain/ai-roster.js';

const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
function fresh() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const lord = oathOptions(s).lords.find((l) => l.cities.length >= 2) || oathOptions(s).lords[0];
  const r = chooseOath(s, cfg, mkCtx(s), { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true);
  return s;
}

test('P61-B1 畸形存档：对象型数组字段被归一，normalizeWorld 不再抛 TypeError', () => {
  const bad = { role: {}, version: 3, generals: {}, builds: {}, armys: {}, citys: {}, pending: {}, warReports: {} };
  const broken = repairArrayFields(bad);
  assert.deepEqual(broken.sort(), ['armys', 'builds', 'citys', 'generals']);
  for (const k of ['generals', 'builds', 'armys', 'citys', 'pending', 'warReports']) {
    assert.ok(Array.isArray(bad[k]), `${k} 已是数组`);
  }
  const s = normalizeWorld(bad, cfg);
  assert.ok(s && Array.isArray(s.generals), '归一化成功');
});

test('P61-B2 州治判定：缺州治的 8 城不得误判统一，占齐州治才算天下归一', () => {
  const s = fresh();
  const map = cfg.map || null;
  const capitalIds = [1, 3, 4, 8, 12, 13, 49, 20, 33, 37, 44, 101, 66];
  const all = Object.keys(s.strategy.cities).map(Number);
  // 30 座非州治城，其余全归汉廷 → 旧 fallback 会误判统一
  const nonCap = all.filter((id) => !capitalIds.includes(id)).slice(0, 30);
  assert.equal(nonCap.length, 30);
  for (const id of all) s.strategy.cities[id].owner = 'han';
  for (const id of nonCap) s.strategy.cities[id].owner = 'player';
  delete s.strategyMapCache;
  assert.equal(evaluateEnding(s), null, '没有占齐州治，不能判统一');
  for (const id of capitalIds) if (s.strategy.cities[id]) s.strategy.cities[id].owner = 'player';
  assert.equal(evaluateEnding(s)?.type, 'unified', '占齐州治且主要势力出局才判统一');
  assert.ok(map === null || map);
});

test('P61-B3 征收：次数按游戏日重置，改真实日期不再凭空刷新', () => {
  const s = normalizeWorld(createWorld(cfg), cfg);
  const ctx = mkCtx(s);
  assert.equal(handleRequest(ctx, req('interior.collect')).code, 0);
  s.roleAttr.lastCollectTime = Date.now() - 31000;
  assert.equal(handleRequest(ctx, req('interior.collect')).code, 0);
  s.roleAttr.lastCollectTime = Date.now() - 31000;
  const third = handleRequest(ctx, req('interior.collect'));
  assert.equal(third.code, 0);
  assert.equal(third.msg.cur_times, 3);
  assert.equal(third.msg.next_day, 2);
  s.roleAttr.lastCollectTime = Date.now() - 31000;
  assert.equal(handleRequest(ctx, req('interior.collect')).code, 55, '同一游戏日仍超限');
  s.clock.day = 2;
  const next = handleRequest(ctx, req('interior.collect'));
  assert.equal(next.code, 0, '新游戏日恢复次数');
  assert.equal(next.msg.cur_times, 1);
});

test('P61-B4 集市：服务端按 transform_rate 核算产出，多对多与乱填产出被拒', () => {
  const s = normalizeWorld(createWorld(cfg), cfg);
  const ctx = mkCtx(s);
  assert.equal(handleRequest(ctx, req('interior.transform', { from: [500, 0, 0, 0] })).code, 58);
  s.roleRes.wood += 100000;
  handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 15 }));
  s.clock.day += cfg.facilityUpgradeDays(15, 1);
  handleRequest(ctx, req('interior.transform')); // 触发 tick 外的完成由测试外壳负责；下面直接给等级
  const market = s.facilities[1].find((f) => f.type === 15);
  market.level = Math.max(1, market.level);
  const rate = cfg.basic.city.transform_rate;
  const w0 = s.roleRes.wood;
  const g0 = s.roleRes.grain;
  const r = handleRequest(ctx, req('interior.transform', { from: [500, 0, 0, 0], to: [0, 0, 0, 500] }));
  assert.equal(r.code, 0);
  assert.equal(r.msg.rate, rate);
  assert.equal(s.roleRes.wood, w0 - 500);
  assert.equal(s.roleRes.grain, g0 + Math.floor(500 * rate / 100), '产出由服务端按兑换率算，不信客户端填的 500');
  const bad = handleRequest(ctx, req('interior.transform', {
    from: [10, 10, 0, 0], to: [0, 0, 5, 5],
  }));
  assert.equal(bad.code, 1, '多对多拒绝');
  assert.match(bad.msg.hint, /兑换率/);
});

test('P61-B6 事件：可暂缓、可关掉逾期自动结案，绝不替玩家落没点过的选择', () => {
  const s = fresh();
  const st = s.strategy;
  st.turn = 6;
  st.pendingEvents = [{ id: 'ev_test', title: '测试事件', sinceTurn: 1, choices: [{ id: 'a', label: '保守' }] }];
  const deferred = strategyEventDefer(s, mkCtx(s), { id: 'ev_test' });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.untilTurn, 10);
  assert.equal(st.pendingEvents[0].sinceTurn, 6);
  strategySetEventAutoResolve(s, mkCtx(s), { enabled: false });
  st.turn = 11; // 已逾期 5 旬
  const tick = strategyEventTick(s);
  assert.equal(tick.autoResolve, false);
  assert.equal(st.pendingEvents[0].id, 'ev_test', '关闭后事件仍待玩家决定');
  assert.equal(st.pendingEvents[0].sinceTurn, 11, '只顺延倒计时');
});

test('P61-B7 求援：高经济但非盟友不得被当作可派援军的对象', () => {
  const s = fresh();
  const st = s.strategy;
  const faction = { id: 'wu', name: '吴', persona: 'sunce' };
  const conf = {
    factions: [
      { id: 'wu', persona: 'sunce' },
      { id: 'wei', persona: 'caocao' },
      { id: 'shu', persona: 'liubei' },
    ],
    personas: {
      sunce: { defense: 0.8 },
      caocao: { defense: 0.8, economy: 0.95 },
      liubei: { defense: 0.8, economy: 0.9 },
    },
  };
  st.cities = { 1: { owner: 'wu', troops: 100 }, 2: { owner: 'wei', troops: 5000 }, 3: { owner: 'shu', troops: 5000 } };
  st.relations = { 'wu|wei': 'neutral', 'wu|shu': 'ally' };
  s.seed = 1;
  let aid = null;
  for (let turn = 1; turn <= 30 && !aid; turn += 1) {
    delete st.rosterAidCooldown;
    aid = aiAidRequest(s, conf, faction, turn, st);
  }
  assert.ok(aid, '前提：求援触发');
  assert.deepEqual(aid.friends, ['shu'], '只把真实盟友列为可驰援对象');
});
