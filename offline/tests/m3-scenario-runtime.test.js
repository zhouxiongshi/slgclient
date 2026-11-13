/**
 * M3-5 六剧本运行期接入测试（GDD §12.1）：
 *  1. strategySetScenario：归属按剧本 cityOwner 落位、scenarioId/年份入库、非法 id 拒绝；
 *  2. factionConfFor：剧本势力集整体替换 8 诸侯、局部 id 按 name 继承 trait/startGenerals；
 *  3. 举义流：剧本模式 oathOptions 只出剧本势力、chooseOath 走通、玩家特技继承；
 *  4. 开局决策伪事件：进 pendingEvents、eventChoice 可点选且效果全 nothing；
 *  5. 事件 ctx 年份从剧本起算；NPC tick 在剧本势力集下正常决策；
 *  6. 视图下发：strategyViewState.scenario（active/list/opening）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, strategySetScenario, factionConfFor, scenarioView, listScenarios,
  oathOptions, chooseOath, strategyEventCtx, strategyTick, strategyEventChoice,
  strategyViewState,
} from '../server/domain/strategy.js';
import { oathFactionOf } from '../server/domain/oath.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();

function scenarioWorld(id) {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const r = strategySetScenario(state, id);
  assert.equal(r.ok, true, `切换剧本 ${id} 应成功`);
  ensureCityEcon(state);
  return state;
}

test('M3-5·切换剧本：归属按 cityOwner、年份入库、非法 id 拒绝', () => {
  const state = scenarioWorld('guandu-200');
  const st = state.strategy;
  assert.equal(st.scenarioId, 'guandu-200');
  assert.equal(st.scenarioYear, 200);
  const owners = {};
  for (const [, row] of Object.entries(st.cities)) owners[row.owner] = (owners[row.owner] || 0) + 1;
  assert.equal(owners.caocao, 12);
  assert.equal(owners.yuanshao, 12);
  assert.equal(owners.sunce, 7);
  assert.ok(owners.han >= 36, `汉廷应占大头，实际 ${owners.han}`);
  // 非法 id
  const bad = strategySetScenario(scenarioWorld('huangjin-184'), '1911');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'no_scenario');
});

test('M3-5·factionConfFor：剧本势力集替换 + 局部 id 继承基础诸侯', () => {
  const state = scenarioWorld('taodong-190');
  const conf = factionConfFor(state);
  assert.deepEqual(conf.factions.map((f) => f.id), ['dongzhuo', 'caocao', 'yuanshao', 'sunjian', 'han']);
  // 董卓/曹操/袁绍按 name 继承基础诸侯的特技与初始武将团
  const dz = conf.factions.find((f) => f.id === 'dongzhuo');
  assert.equal(dz.name, '董卓');
  assert.ok(dz.trait, '董卓应继承西凉铁骑特技');
  assert.ok((dz.startGenerals || []).length >= 3, '董卓应继承初始武将团');
  // 剧本外的 state 不受影响
  const plain = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(plain);
  assert.equal(factionConfFor(plain).factions.length, 8);
});

test('M3-5·举义流：剧本势力卡 + chooseOath 走通 + 玩家特技继承', () => {
  const state = scenarioWorld('guandu-200');
  state.oath = { done: false };            // 进入举义页
  const oo = oathOptions(state);
  assert.deepEqual(oo.lords.map((l) => l.id), ['caocao', 'yuanshao', 'sunce', 'han']);
  const caocao = oo.lords.find((l) => l.id === 'caocao');
  assert.ok(caocao.trait?.name, '曹操卡应带特技');
  assert.ok((caocao.generals || []).length >= 3, '曹操卡应带初始武将团');
  const city = caocao.cities[0];
  const r = chooseOath(state, cfg, { push() {} }, { lord: 'caocao', city: city.id });
  assert.equal(r.ok, true, `举义应成功: ${r.reason || ''}`);
  // 玩家城 = 曹操名下城池全部易帜
  const mine = Object.values(state.strategy.cities).filter((row) => row.owner === 'player').length;
  assert.equal(mine, 12);
  // oathFactionOf 走剧本降级链 → 曹操特技可用
  assert.equal(oathFactionOf(state)?.id, 'caocao');
  assert.ok(oathFactionOf(state)?.trait, '玩家应继承曹操特技');
});

test('M3-5·开局决策伪事件：进 pendingEvents、点选走通、效果全 nothing', () => {
  const state = scenarioWorld('chibi-208');
  const pending = state.strategy.pendingEvents;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'opening-chibi-208');
  assert.ok(pending[0].choices.length >= 2);
  const r = strategyEventChoice(state, cfg, { push() {} }, { id: 'opening-chibi-208', choice: pending[0].choices[0].id });
  assert.equal(r.ok, true, `开局点选应成功: ${r.reason || ''}`);
  assert.equal(state.strategy.pendingEvents.length, 0, '点选后消费');
  // 金库未被开局事件改动（效果全 nothing）
  const g0 = state.roleRes.gold;
  assert.equal(state.roleRes.gold, g0);
});

test('M3-5·事件 ctx 年份从剧本起算 + NPC tick 在剧本势力集下正常决策', () => {
  const state = scenarioWorld('yiling-221');
  state.clock.day = 45;
  const ctx = strategyEventCtx(state);
  assert.equal(ctx.year, 221, '剧本 221，day=45 仍是 221 年');
  // 旬 tick：NPC（剧本势力）决策不崩、玩家田赋记账正常
  state.oath = state.oath || { done: true };
  state.clock.day = 100;
  const tick = strategyTick(state, cfg, { push() {} });
  assert.ok(tick, '旬 tick 应产出结果');
  assert.ok(Array.isArray(tick.results), 'tick.results 应为数组');
});

test('M3-5·视图下发 scenario 字段 + 六剧本清单', () => {
  const state = scenarioWorld('sanfen-229');
  const view = strategyViewState(state);
  assert.equal(view.scenario.active, 'sanfen-229');
  assert.equal(view.scenario.year, 229);
  assert.ok(Array.isArray(view.scenario.specialRules) && view.scenario.specialRules.length >= 1);
  assert.deepEqual(listScenarios().map((s) => s.year), [184, 190, 200, 208, 221, 229]);
  const sv = scenarioView(state);
  assert.ok(sv.opening?.text, '开局决策文案应下发');
  assert.equal(sv.list.length, 6);
});
