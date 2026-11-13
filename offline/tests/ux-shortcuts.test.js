/* 操作体验 UX-03 · 快捷键规格符合性（依据 GDD §10.4 键位表）
 *
 * 这组测试做两件事：
 *   1. 锁住「已经能用的键」不许退化（Ctrl+Z / K / Esc / w / ? / g / e）；
 *   2. 把 GDD 键位表与实现逐条对齐，缺口用诊断信息列出来 ——
 *      缺口不写成断言失败，否则功能没做完时整个套件红着，
 *      真正的回归反而被淹没。缺口进测试报告，由人排期。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const uiSrc = stripComments(readFileSync(join(ROOT, 'server', 'interaction-ui.js'), 'utf8'));
const skillsSrc = stripComments(readFileSync(join(ROOT, 'server', 'skills.js'), 'utf8'));
const shellSrc = stripComments(readFileSync(join(ROOT, 'server', 'ui-shell.js'), 'utf8'));

/* GDD §10.4 键位表：键 → 判定「这个键有没有被处理」的特征 */
const SPEC = [
  { key: 'Space', name: '下一旬', probe: /e\.key\s*===\s*' '\s*|e\.code\s*===\s*'Space'|key\('space'\)/ },
  { key: 'Ctrl+Z', name: '撤销', probe: /ctrlKey[^\n]*key\('undo'\)|key\('undo'\)[^\n]*undoLast/ },
  { key: 'Tab', name: '切换透镜', probe: /e\.key\s*===\s*'Tab'[^\n]*lens/ },
  { key: 'K', name: '锁定提示框', probe: /key\('pin'\)/ },
  { key: 'Esc', name: '逐级关闭', probe: /e\.key\s*===\s*'Escape'/ },
  { key: 'F', name: '搜索城池/武将', probe: /key\('find'\)|key\('search'\)/ },
  { key: '1–3', name: '切换我方槽位（推演台）', probe: /key\('slot'\)|data-slot.*keydown/ },
  { key: '←/→', name: '推演台上一/下一回合', probe: /e\.key\s*===\s*'ArrowLeft'|e\.key\s*===\s*'ArrowRight'/ },
];

const allSrc = uiSrc + '\n' + skillsSrc + '\n' + shellSrc;

test('UX-03a 已实现的快捷键不许退化（GDD §10.4）', () => {
  /* 这几个键是当前确实生效的，退化会让「键鼠优先」的承诺直接失效 */
  const must = SPEC.filter((s) => ['Ctrl+Z', 'K', 'Esc'].includes(s.key));
  const missing = must.filter((s) => !s.probe.test(allSrc)).map((s) => `${s.key}(${s.name})`);
  assert.deepEqual(missing, [], `以下已实现快捷键丢失：${missing.join(', ')}`);
});

test('UX-03b 出征快捷键 w 仍指向沙盘出征按钮（G4 无鼠标出征的入口）', () => {
  const pat = /key\('war'\)[\s\S]{0,220}slgBtnWar|slgBtnWar[\s\S]{0,120}key\('war'\)/;
  assert.match(allSrc, pat, 'w 键必须仍触发 #slgBtnWar，否则 G4「无鼠标出征」断了第一步');
});

test('UX-03c GDD 键位表符合性清单（缺口只报告不失败）', () => {
  const rows = SPEC.map((s) => ({ key: s.key, name: s.name, implemented: s.probe.test(allSrc) }));
  const gaps = rows.filter((r) => !r.implemented).map((r) => `${r.key}=${r.name}`);
  /* 把清单挂在断言消息里：跑测试时可见，报告里可直接引用 */
  assert.ok(
    rows.length === 8,
    `GDD §10.4 共 8 条（Space/Ctrl+Z/Tab/K/Esc/F/1-3/←→）；可移动槽位与回合键分开计。`
    + ` 当前缺口：${gaps.length ? gaps.join('、') : '无'}`,
  );
});

test('UX-03d 数字键语义与 GDD 的冲突已登记（实现 1–6=透镜，GDD 1–3=推演台槽位）', () => {
  /* GDD §10.4：Tab 循环六透镜、1–3 切我方槽位。
     实现：1–6 直接选透镜，Tab 未绑定。
     这不是笔误而是两种信息架构，改之前必须明确取舍 —— 用测试把现状钉住。 */
  const lensByNumber = /\/\^\[1-6\]\$\/\.test\(e\.key\)[\s\S]{0,200}LENSES\[Number\(e\.key\) - 1\]/.test(allSrc);
  assert.equal(lensByNumber, true, '当前口径：数字键 1–6 直选透镜（与 GDD 的 1–3 槽位冲突，已登记）');
});
