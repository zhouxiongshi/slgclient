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
  const first = selectEvents(evs, ctx, state);
  assert.equal(first.selected.length, 1, '首次应选中');
  assert.equal(ensureEventState(state).cooldown.a, 8, '应按配置写 8 旬冷却');

  const second = selectEvents(evs, ctx, state);
  assert.equal(second.selected.length, 0, '冷却期内不得重复触发');
});

test('未配 cooldown 的非 once 事件走默认 6 旬', () => {
  const state = wrap();
  const evs = [EV('b')];
  selectEvents(evs, ctx, state);
  assert.equal(ensureEventState(state).cooldown.b, 6, '默认冷却应为 6 旬');
});

test('once 事件不进冷却表（已 fired 永久排除）', () => {
  const state = wrap();
  const evs = [EV('c', { once: true })];
  selectEvents(evs, ctx, state);
  const es = ensureEventState(state);
  assert.equal(es.fired.c, 1, 'once 应记 fired');
  assert.equal(es.cooldown.c, undefined, 'once 不需要冷却');
  assert.equal(selectEvents(evs, ctx, state).selected.length, 0, 'once 不再触发');
});

test('冷却按旬递减，归零后可再次触发', () => {
  const state = wrap();
  const evs = [EV('d', { cooldown: 3 })];
  selectEvents(evs, ctx, state);
  eventCooldownTick(state);
  eventCooldownTick(state);
  assert.equal(ensureEventState(state).cooldown.d, 1, '还剩 1 旬');
  assert.equal(selectEvents(evs, ctx, state).selected.length, 0, '仍处冷却');
  eventCooldownTick(state);
  assert.equal(ensureEventState(state).cooldown.d, undefined, '冷却清空');
  assert.equal(selectEvents(evs, ctx, state).selected.length, 1, '冷却结束应可再触发');
});

test('长跑 60 旬：同一条事件触发次数不超过 旬数/冷却 + 1', () => {
  const state = wrap();
  const evs = [EV('e', { cooldown: 8 })];
  let fired = 0;
  for (let t = 1; t <= 60; t++) {
    ctx.turn = t;
    fired += selectEvents(evs, ctx, state).selected.length;
    eventCooldownTick(state);   // 每旬推进一次
  }
  assert.ok(fired <= Math.ceil(60 / 8) + 1, `60 旬最多应触发约 8 次，实测 ${fired}`);
  assert.ok(fired >= 5, `冷却不应把事件压到近乎不触发，实测 ${fired}`);
});
