/* ★ 验收：Electron `console-message` 的新旧签名归一化（electron/console-level.cjs）
 *
 * 背景（真实踩过的坑）：Electron 35+ 把 console-message 的回调从
 * `(event, level: number, message)` 改成「单个事件对象」。沿用旧写法时 level 恒为
 * undefined，`level >= 2` 永远为假 —— 我们连续两个版本报的「控制台 error 0 条」
 * 是个永远成立的假结论，检测从未生效。这组用例锁四件事：
 *   1) 两种签名都能解析出 level/message；
 *   2) 字符串 level 能正确映射成 0..3，且未知值不会误报成 error；
 *   3) error 一定被判为错误，warning 也判为错误（沿用旧阈值 >= 2）；
 *   4) 三个 Electron 入口不许再写回旧的三参处理器（防退化）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { consoleSeverity, consolePayload, isConsoleError } = require('../electron/console-level.cjs');

test('consoleSeverity：Electron 35+ 的字符串 level 映射到 0..3', () => {
  assert.equal(consoleSeverity('error'), 3);
  assert.equal(consoleSeverity('warning'), 2);
  assert.equal(consoleSeverity('warn'), 2);
  assert.equal(consoleSeverity('info'), 1);
  assert.equal(consoleSeverity('debug'), 0);
  assert.equal(consoleSeverity('verbose'), 0);
  /* 大小写不敏感：页面里也有人写 'Error' */
  assert.equal(consoleSeverity('Error'), 3);
});

test('consoleSeverity：老版本的数字 level 原样保留并夹到 0..3', () => {
  assert.equal(consoleSeverity(0), 0);
  assert.equal(consoleSeverity(1), 1);
  assert.equal(consoleSeverity(2), 2);
  assert.equal(consoleSeverity(3), 3);
  assert.equal(consoleSeverity(9), 3, '越界值应夹紧，不许漏出 3 以上');
  assert.equal(consoleSeverity(-1), 0);
});

test('consoleSeverity：拿不到 level 时按 info 处理，不许当成 error', () => {
  /* 这条是防回归的关键：如果未知值返回 3，冒烟会把每条普通日志都算成错误 */
  assert.equal(consoleSeverity(undefined), 1);
  assert.equal(consoleSeverity(null), 1);
  assert.equal(consoleSeverity(''), 1);
  assert.equal(consoleSeverity('something-new-in-electron-50'), 1);
});

test('consolePayload：Electron 35+ 的单参事件对象', () => {
  const d = consolePayload([{ level: 'error', message: 'boom', lineNumber: 12, sourceId: 'a.js' }]);
  assert.equal(d.level, 'error');
  assert.equal(d.message, 'boom');
});

test('consolePayload：老版本的三参签名 (event, level, message)', () => {
  const d = consolePayload([{ preventDefault() {} }, 2, 'hello']);
  assert.equal(d.level, 2);
  assert.equal(d.message, 'hello');
});

test('isConsoleError：error/warning 算错误，info/debug 不算，可配忽略规则', () => {
  assert.equal(isConsoleError([{ level: 'error', message: 'x' }]).message, 'x');
  assert.equal(isConsoleError([{ level: 'warning', message: 'w' }]).level, 'warning');
  assert.equal(isConsoleError([{ level: 'info', message: 'i' }]), null);
  assert.equal(isConsoleError([{ level: 'debug', message: 'd' }]), null);
  assert.equal(isConsoleError([{ level: 3, message: 'old' }]).message, 'old');
  /* 开发态 CSP 提示不是游戏错误 */
  assert.equal(isConsoleError(
    [{ level: 'warning', message: 'Electron Security Warning (Insecure Content-Security-Policy)' }],
    { ignore: /Electron Security Warning/i }), null);
});

test('不变量：三个 Electron 入口都走同一份归一化，且没有残留旧的三参处理器', () => {
  const files = ['../electron/smoke.cjs', '../electron/ui-audit.cjs', '../electron/main.cjs'];
  for (const rel of files) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(src, /require\('\.\/console-level\.cjs'\)/,
      `${rel} 必须从 console-level.cjs 取归一化函数`);
    assert.match(src, /consolePayload\(/,
      `${rel} 的 console-message 处理器必须用 consolePayload 解析参数`);
    /* 旧签名的特征写法，出现即说明有人把 bug 写回去了 */
    assert.doesNotMatch(src, /on\('console-message',\s*\([^)]*level[^)]*message[^)]*\)\s*=>/,
      `${rel} 残留了 (event, level, message) 式处理器 —— 在 Electron 35+ 下 level 恒为 undefined`);
    assert.doesNotMatch(src, /if\s*\(\s*level\s*>=\s*2\s*\)/,
      `${rel} 残留了直接比较 level 的判断 —— 旧签名下这段永不成立`);
  }
});
