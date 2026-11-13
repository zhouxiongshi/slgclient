/**
 * M3-6 事件弹窗 UI 测试：
 *  1. interaction.js 聚合：pendingEvents 只读投影（shape/choices/默认空数组）；
 *  2. interaction-ui.js 静态纪律：buildEventCards 存在、点选走 eventChoice、
 *     按钮带 data-ix-allow（不被成本词预览二次拦截）、loadState 挂钩、禁 Math.random；
 *  3. 服务端 strategyEventChoice：对伪事件（opening-*）点选后 pending 消费且选择入档。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interactionState } from '../server/domain/interaction.js';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, strategySetScenario, strategyEventChoice } from '../server/domain/strategy.js';

const cfg = loadConfig();
const UI_SRC = readFileSync(new URL('../server/interaction-ui.js', import.meta.url), 'utf8');

function baseWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  return state;
}

test('M3-6·interaction 聚合：pendingEvents 只读投影', () => {
  const state = baseWorld();
  state.strategy.pendingEvents = [
    {
      id: 'e1', title: '苍天已死', layer: 'node', speaker: '唐周',
      text: ['黄巾起事。', '朝野震动。'],
      choices: [
        { id: 'c1', label: '募兵讨贼', preview: '金 -300' },
        { id: 'c2', label: '按兵不动', preview: '' },
      ],
    },
  ];
  const d = interactionState(state, cfg);
  assert.equal(d.pendingEvents.length, 1);
  const e = d.pendingEvents[0];
  assert.equal(e.id, 'e1');
  assert.deepEqual(e.text, ['黄巾起事。', '朝野震动。']);
  assert.deepEqual(e.choices.map((c) => c.id), ['c1', 'c2']);
  assert.equal(e.choices[0].preview, '金 -300');
  // 字符串 text 也归一成数组；缺 choices 归一空数组
  state.strategy.pendingEvents = [{ id: 'e2', title: 'x', text: '单行', choices: null }];
  const d2 = interactionState(state, cfg);
  assert.deepEqual(d2.pendingEvents[0].text, ['单行']);
  assert.deepEqual(d2.pendingEvents[0].choices, []);
  // 无事件时是空数组（前端按长度判断）
  state.strategy.pendingEvents = [];
  assert.deepEqual(interactionState(state, cfg).pendingEvents, []);
});

test('M3-6·interaction-ui 静态纪律：事件卡实现要点', () => {
  assert.ok(UI_SRC.includes('function buildEventCards'), '应有 buildEventCards');
  assert.ok(UI_SRC.includes("act: 'eventChoice'"), '点选应 POST eventChoice');
  assert.ok(/data-evt-choice[\s\S]{0,120}data-ix-allow/.test(UI_SRC), '事件按钮应带 data-ix-allow（两层弹窗协议）');
  assert.ok(/buildEventCards\(d\);/.test(UI_SRC), 'loadState 应挂钩 buildEventCards');
  assert.ok(UI_SRC.includes("slgIx-modal slgIxEvent"), '事件卡应复用 slgIx-modal 层级体系');
  const codeOnly = UI_SRC.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.ok(!/Math\.random/.test(codeOnly), '面板层禁 Math.random（注释除外）');
});

test('M3-6·伪事件点选：opening 决策消费且选择入档', () => {
  const state = baseWorld();
  const r0 = strategySetScenario(state, 'guandu-200');
  assert.equal(r0.ok, true);
  const st = state.strategy;
  assert.equal(st.pendingEvents[0]?.id, 'opening-guandu-200');
  const r = strategyEventChoice(state, cfg, { push() {} }, { id: 'opening-guandu-200', choice: 'c1' });
  assert.equal(r.ok, true, `点选应成功: ${r.reason || ''}`);
  assert.equal(st.pendingEvents.length, 0, '点选后消费');
  assert.equal(st.eventSys.choices['opening-guandu-200'].choice, 'c1', '选择写存档供结局回放');
});
