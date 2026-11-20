/**
 * 2026-11-20 回归锁：事件冷却必须生效。
 *
 * 实测缺陷：`events.json` 里给条件事件配了 `cooldown: 8`，但 `selectEvents()`
 * 只在 exclusive 挤掉时写 1 旬冷却，配置里的 cooldown 从来没被读过。
 * 于是条件长期成立的事件（流民就食 / 金盈库满 / 仓廪充盈）每 4~5 旬重新触发，
 * 150 旬同一条事件刷 33 次、连播三行（触发 + 抉择 + 逾期），
 * 占满 418 条事件流的 96 条——玩家自己的战事被背景事件挤出视野。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { selectEvents, eventCooldownTick, ensureEventState } from '../server/domain/event-engine.js';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyEventTick,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const gameCfg = loadConfig();

const ctx = { turn: 1, resource: { grain: 9999, gold: 9999 } };

function wrap() {
  return { events: { fired: {}, cooldown: {} } };
}

const EV = (id, extra = {}) => ({
  id, title: id, priority: 50, when: {}, choices: [], ...extra,
});

test('选中即写冷却：配置的 cooldown 被真正读取', () => {
  const state = wrap();
  const evs = [EV('a', { cooldown: 8 })];
  const first = selectEvents(evs, ctx, state, { gap: 0 });
  assert.equal(first.selected.length, 1, '首次应选中');
  assert.equal(ensureEventState(state).cooldown.a, 8, '应按配置写 8 旬冷却');

  const second = selectEvents(evs, ctx, state, { gap: 0 });
  assert.equal(second.selected.length, 0, '冷却期内不得重复触发');
});

test('未配 cooldown 的非 once 事件走默认 6 旬', () => {
  const state = wrap();
  const evs = [EV('b')];
  selectEvents(evs, ctx, state, { gap: 0 });
  assert.equal(ensureEventState(state).cooldown.b, 6, '默认冷却应为 6 旬');
});

test('once 事件不进冷却表（已 fired 永久排除）', () => {
  const state = wrap();
  const evs = [EV('c', { once: true })];
  selectEvents(evs, ctx, state, { gap: 0 });
  const es = ensureEventState(state);
  assert.equal(es.fired.c, 1, 'once 应记 fired');
  assert.equal(es.cooldown.c, undefined, 'once 不需要冷却');
  assert.equal(selectEvents(evs, ctx, state, { gap: 0 }).selected.length, 0, 'once 不再触发');
});

test('冷却按旬递减，归零后可再次触发', () => {
  const state = wrap();
  const evs = [EV('d', { cooldown: 3 })];
  selectEvents(evs, ctx, state, { gap: 0 });
  eventCooldownTick(state);
  eventCooldownTick(state);
  assert.equal(ensureEventState(state).cooldown.d, 1, '还剩 1 旬');
  assert.equal(selectEvents(evs, ctx, state, { gap: 0 }).selected.length, 0, '仍处冷却');
  eventCooldownTick(state);
  assert.equal(ensureEventState(state).cooldown.d, undefined, '冷却清空');
  assert.equal(selectEvents(evs, ctx, state, { gap: 0 }).selected.length, 1, '冷却结束应可再触发');
});

test('长跑 60 旬：同一条事件触发次数不超过 旬数/冷却 + 1', () => {
  const state = wrap();
  const evs = [EV('e', { cooldown: 8 })];
  let fired = 0;
  for (let t = 1; t <= 60; t++) {
    ctx.turn = t;
    fired += selectEvents(evs, ctx, state, { gap: 0 }).selected.length;
    eventCooldownTick(state);   // 每旬推进一次
  }
  assert.ok(fired <= Math.ceil(60 / 8) + 1, `60 旬最多应触发约 8 次，实测 ${fired}`);
  assert.ok(fired >= 5, `冷却不应把事件压到近乎不触发，实测 ${fired}`);
});


/* ---------------------------------------------------------------- 全局间隔
 * ★ 2026-11-20：单条冷却只管「同一条别刷屏」，9 条常驻条件事件仍可轮流每旬
 *   塞满 2 个弹窗（实测 150 旬 224 次）。gap 是条件事件之间的全局节流；
 *   史实节点（once）不受限——剧情该来就得来。
 */
test('条件事件全局间隔：4 旬内不重复触发，第 5 旬恢复', () => {
  const state = wrap();
  /* 单条冷却设为 1 旬，隔离出全局间隔的效果；上次触发记在第 -3 旬，
     这样从 t=1 起算正好满 4 旬。 */
  const evs = [EV('g1', { cooldown: 1 }), EV('g2', { cooldown: 1 })];
  ensureEventState(state).lastConditionTurn = -3;
  const hit = [];
  for (let t = 1; t <= 6; t++) {
    ctx.turn = t;
    hit.push(selectEvents(evs, ctx, state).selected.length);
    eventCooldownTick(state);
  }
  assert.deepEqual(hit, [2, 0, 0, 0, 2, 0], `条件事件应每 4 旬一轮，实测 ${hit}`);
});

test('史实节点（once）不受全局间隔影响', () => {
  const state = wrap();
  const cond = EV('cond');
  const story = EV('story', { once: true, priority: 99 });
  assert.equal(selectEvents([cond], ctx, state).selected.length, 1, '条件事件先触发');
  ctx.turn = 2;   // 间隔期内
  const r = selectEvents([story], ctx, state);
  assert.equal(r.selected.length, 1, 'once 节点不能被杂事压住');
  assert.equal(ensureEventState(state).fired.story, 2);
});

test('被间隔挡住的事件不写单条冷却（否则越挡越久）', () => {
  const state = wrap();
  const evs = [EV('h')];
  ctx.turn = 1;
  selectEvents(evs, ctx, state);
  ctx.turn = 2;
  const r = selectEvents(evs, ctx, state);
  assert.equal(r.selected.length, 0);
  assert.equal(ensureEventState(state).cooldown.h, undefined, '被全局间隔挡住不应额外写单条冷却');
  ctx.turn = 5;
  assert.equal(selectEvents(evs, ctx, state).selected.length, 1, '间隔一到即可触发');
});


/* ---------------------------------------------------------------- 逾期日志
 * ★ 2026-11-20：未决事件挂满 4 旬后自动保守结案。旧实现调用 strategyEventChoice
 *   写「事件·抉择」，再写「事件·逾期」——一条没被玩家点过的事件占三行日志
 *   （触发/抉择/逾期），实测 150 旬 224 行事件日志里 148 行是这种噪音。
 */
test('逾期结案只留一条日志，且写明所取选项', () => {
  const state = normalizeWorld(createWorld(gameCfg), gameCfg);
  ensureStrategy(state); ensureCityEcon(state);
  const ctx = { state, cfg: gameCfg, pushes: [], options: {}, push() {}, schedule() {}, save() {}, log() {} };
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  assert.equal(chooseOath(state, gameCfg, ctx, { lord: cao.id, city: cao.cities[0].id }).ok, true);
  state.strategy.turn = 5;
  state.strategy.pendingEvents = [{
    id: 'test.stale', title: '测试逾期', sinceTurn: 1,
    choices: [{ id: 'safe', label: '保守之策' }],
  }];
  const before = (state.strategy.events || []).length;
  strategyEventTick(state);
  const added = (state.strategy.events || []).slice(before).map((e) => e.text);
  assert.equal(added.filter((x) => x.includes('事件·抉择')).length, 0, '逾期不应再叠一行抉择日志');
  assert.ok(added.some((x) => x.includes('事件·逾期') && x.includes('保守之策')), '逾期行应写明所取选项');
  assert.equal(state.strategy.pendingEvents.some((e) => e.id === 'test.stale'), false, '逾期后旧事件必须清出队列');
});
