/**
 * P28 · 事件卡陈旧态回归
 *
 * 实机 2026-11-21：事件在旧旬触发，推演时按「逾期保守结案」清掉；交互层仍拿着
 * 20 秒前的只读投影弹卡，玩家点选后看到「事件点选未生效：no_pending」。
 * 本测试钉住三件事：
 *   1. 推演成功后交互层立即重取状态，不靠 20 秒轮询兜底；
 *   2. 点选前校验该事件仍在最新 pendingEvents，过期则换卡；
 *   3. 即使 GET/POST 之间刚好结案，也中文降级，绝不把英文 reason 弹给玩家。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, strategyEventChoice, strategyEventTick } from '../server/domain/strategy.js';
import { interactionState } from '../server/domain/interaction.js';

const UI_SRC = readFileSync(new URL('../server/interaction-ui.js', import.meta.url), 'utf8');
const cfg = loadConfig();

function segment(a, b) {
  const i = UI_SRC.indexOf(a);
  assert.ok(i >= 0, `缺少锚点：${a}`);
  const j = b ? UI_SRC.indexOf(b, i) : UI_SRC.length;
  assert.ok(j > i, `缺少结束锚点：${b}`);
  return UI_SRC.slice(i, j);
}

test('P28·推演成功后立即刷新交互态，不等 20 秒轮询', () => {
  const wrap = segment('function wrapFetch()', '/* ---------------- 6. 6.4');
  assert.match(wrap, /\/__slg\\\/strategy\\\/tick/, '必须识别推演请求');
  assert.match(wrap, /isTick && r\.ok\)\s*loadState\(\)/, '推演成功后应立刻重取交互数据');
});

test('P28·事件点选前重校验，过期事件不 POST', () => {
  const click = segment('function buildEventCards(d)', '/* ---------------- 5. 6.2');
  const preflight = click.indexOf('fetchJSON(API)');
  const post = click.indexOf("act: 'eventChoice'");
  assert.ok(preflight >= 0 && post > preflight, '点选前必须先取最新 pendingEvents');
  assert.match(click, /String\(e\.id\) === String\(want\.id\)/, '事件 id 必须按字符串口径比对，避免类型漂移');
  assert.match(click, /已在本旬结案或已被新局势替换/, '过期事件要给玩家中文说明');
});

test('P28·并发结案时中文降级，不暴露英文错误码', () => {
  const click = segment("var b = e.target.closest('[data-evt-choice]')", '/* 非模态卡');
  assert.match(click, /res\.reason === 'no_pending'/, '必须识别并发结案');
  assert.match(click, /eventReasonText\(res\.reason\)/, '拒绝原因必须翻译后展示');
  assert.ok(!click.includes("'事件点选未生效：' + (res.reason"), '旧英文 reason 直出不得回退');
  const reasonFn = segment('function eventReasonText(reason)', 'function buildEventCards(d)');
  assert.match(reasonFn, /该事件已结案/, 'no_pending 要有可读中文文案');
  assert.ok(!/return reason\b/.test(reasonFn), '不能原样返回内部英文码');
});

test('P28·逾期结案后旧事件 id 立即不在只读投影中，旧点击得到 no_pending', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  const st = state.strategy;
  const oldId = 'evt.cond.prisoner.recruit';
  st.turn = 15;
  state.clock.day = 275;
  st.pendingEvents = [{
    id: oldId, title: '阶下之囚', layer: '条件', sinceTurn: 11,
    text: ['阵前俘获之将羁押已久。'],
    choices: [
      { id: 'respect', label: '以礼相待', preview: '' },
      { id: 'execute', label: '明正典刑', preview: '' },
    ],
  }];
  assert.equal(interactionState(state, cfg).pendingEvents[0].id, oldId, '结案前投影应有旧事件');

  strategyEventTick(state);
  assert.equal(st.pendingEvents.some((e) => e.id === oldId), false, '逾期事件应被清掉');
  assert.equal(interactionState(state, cfg).pendingEvents.some((e) => e.id === oldId), false,
    '只读投影不得继续弹已结案事件');

  const staleClick = strategyEventChoice(state, cfg, {}, { id: oldId, choice: 'respect' });
  assert.equal(staleClick.ok, false);
  assert.equal(staleClick.reason, 'no_pending', '服务端仍须保守拒绝陈旧点击');
});
