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
  { key: 'Space', name: '下一旬', probe: /e\.key === ' '|e\.code === 'Space'/ },
  { key: 'Ctrl+Z', name: '撤销', probe: /ctrlKey[^\n]*key\('undo'\)|key\('undo'\)[^\n]*undoLast/ },
  { key: 'Tab', name: '切换透镜', probe: /e\.key === 'Tab'[\s\S]{0,140}cycleLens/ },
  { key: 'K', name: '锁定提示框', probe: /key\('pin'\)/ },
  { key: 'Esc', name: '逐级关闭', probe: /e\.key === 'Escape'/ },
  { key: 'F', name: '搜索城池/武将', probe: /key\('find'\)[\s\S]{0,90}focusFind/ },
  { key: '1–3', name: '切换我方槽位（出征窗队伍）', probe: /pickArmy\(Number\(e\.key\)\)/ },
  { key: '←/→', name: '推演台上一/下一回合', probe: /e\.key === 'ArrowLeft'[\s\S]{0,90}cycleArmy/ },
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

test('UX-03c GDD §10.4 全部 8 条键位必须实现', () => {
  const rows = SPEC.map((s) => ({ key: s.key, name: s.name, implemented: s.probe.test(allSrc) }));
  const gaps = rows.filter((r) => !r.implemented).map((r) => `${r.key}=${r.name}`);
  /* P2-03 修复后这里不再是「缺口清单」，而是硬断言：缺一个就红。
     旧的「只报告不失败」写法会让缺口长期躺在报告里没人管。 */
  assert.deepEqual(gaps, [], `GDD §10.4 键位缺失：${gaps.join('、')}`);
});

test('UX-03d 数字键语义冲突已按上下文消解（出征窗 1–3 选队伍，否则 1–6 选透镜）', () => {
  /* GDD §10.4：Tab 循环六透镜、1–3 切我方槽位。
     实现：出征窗开着时 1–3 选队伍；没开时 1–6 直选透镜（更快的原路径保留）。
     顺序必须是「先 pickArmy 后透镜」，否则出征窗里的 1–3 会被透镜吃掉。 */
  const pickFirst = /pickArmy\(Number\(e\.key\)\)[\s\S]{0,200}"?\/\^\[1-6\]\$\/\.test\(e\.key\)/
    .test(allSrc)
    || /pickArmy\(Number\(e\.key\)\)[\s\S]{0,200}\/\^\[1-6\]\$\/\.test\(e\.key\)/.test(allSrc);
  assert.equal(pickFirst, true, '1–3 必须先把按键交给出征窗，再落到透镜直选');
  /* 槽位来自 skills.js 渲染的队伍行 */
  assert.match(skillsSrc, /data-army-index/, '队伍行必须带 data-army-index，否则 1–3 无槽位可选');
  assert.match(skillsSrc, /data-army-selected/, '选中行必须带 data-army-selected，否则 ←/→ 不知道该从哪挪');
});
