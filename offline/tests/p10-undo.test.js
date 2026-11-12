/**
 * M0-4（GDD §14.2-3 / 验收 B1~B4）：撤销栈策略与清栈信号。
 *
 * 锁三件容易回退的事：
 *   1) 撤销策略由服务端权威下发（undo.depth / clearOnBattle / clearOnLoad），
 *      前端不复算 —— 出现第二个「撤销深度」定义就是 bug；
 *   2) 清栈信号 battleCount 必须与 state.battleLog.length 同源；
 *   3) 注入层不许再硬编码 slice(0, 5)，必须读服务端 depth。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { interactionState } from '../server/domain/interaction.js';

const cfg = loadConfig();

function world() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  return state;
}

test('撤销策略：服务端下发 depth=5 与两个清栈开关（GDD §9.2 undoDepth）', () => {
  const d = interactionState(world(), cfg);
  assert.ok(d.undo, '交互态必须包含 undo 策略');
  assert.equal(d.undo.depth, 5, 'undoDepth 默认 5（参数表 §9.2）');
  assert.equal(d.undo.clearOnBattle, true, '战斗结算后清栈（验收 B2）');
  assert.equal(d.undo.clearOnLoad, true, '读档后清栈（验收 B3）');
  assert.equal(typeof d.undo.turn, 'number', 'turn 是清栈检测信号');
});

test('撤销信号：battleCount 与 state.battleLog.length 同源', () => {
  const state = world();
  const before = interactionState(state, cfg).undo.battleCount;
  assert.equal(before, state.battleLog.length);
  /* 模拟一场战斗结算入档 */
  state.battleLog.push({ id: 9999, result: 2, summary: '测试战报' });
  const after = interactionState(state, cfg).undo.battleCount;
  assert.equal(after, before + 1, 'battleCount 必须随 battleLog 增长（前端据此清栈）');
});

test('不变量：注入层撤销深度读服务端字段，不许硬编码 slice(0, 5)', () => {
  const src = readFileSync(new URL('../server/interaction-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /S\.undo\.slice\(0,\s*5\s*\)/,
    'interaction-ui.js 硬编码撤销深度 5 —— 应读 S.data.undo.depth');
  assert.match(src, /S\.data\.undo\.depth|data\.undo && .*\.depth|\.undo\.depth/,
    'interaction-ui.js 必须按服务端 depth 截断撤销栈');
  assert.match(src, /clearOnBattle/, '前端必须实现战斗后清栈（B2）');
  assert.match(src, /clearOnLoad/, '前端必须实现读档后清栈（B3）');
});
