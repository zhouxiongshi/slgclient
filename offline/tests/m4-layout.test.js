/**
 * M4-3 布局矩阵与对比度测试（GDD §10.1 五档断点 / §10.7 对比度）：
 *   1) 对比度工具：9 对全部 ≥ WCAG 门槛（正文 4.5 / 大字 3），exit 0；
 *   2) 抽屉五档断点：360/380/420/460/480 随分辨率分档（GDD §10.1 表）；
 *   3) 战略 dock 防溢出结构：flex-wrap + 右侧让位 max-width；
 *   4) 字号三档制与断点解耦（用户缩放 × 布局断点两层并存）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url)); // offline/

const UI_SRC = readFileSync(new URL('../server/interaction-ui.js', import.meta.url), 'utf8');
const SKILLS_SRC = readFileSync(new URL('../server/skills.js', import.meta.url), 'utf8');

test('M4-3·对比度：9 对全部达标 exit 0', () => {
  const r = spawnSync(process.execPath, [HERE + 'tools/check-contrast.js'], { cwd: HERE, encoding: 'utf8' });
  assert.equal(r.status, 0, `check-contrast 应 exit 0：${r.stdout}\n${r.stderr}`);
  const j = JSON.parse(readFileSync(HERE + 'reports/contrast.json', 'utf8'));
  assert.equal(j.checked, 9);
  assert.equal(j.failed, 0);
  const min = Math.min(...j.results.map((x) => x.ratio));
  assert.ok(min >= 4.5, `最低对比度 ${min}:1 必须覆盖最严档（正文 4.5）`);
});

test('M4-3·抽屉五档断点（GDD §10.1）：360/380/420/460/480', () => {
  assert.match(UI_SRC, /@media \(max-width:1279px\)\{#slgIxDrawer\{width:360px\}\}/);
  assert.match(UI_SRC, /@media \(max-width:1365px\)\{#slgIxDrawer\{width:380px\}\}/);
  assert.match(UI_SRC, /@media \(min-width:1920px\)\{#slgIxDrawer\{width:420px\}\}/);
  assert.match(UI_SRC, /@media \(min-width:2560px\)\{#slgIxDrawer\{width:460px\}\}/);
  assert.match(UI_SRC, /@media \(min-width:3440px\)\{#slgIxDrawer\{width:480px\}\}/);
});

test('M4-3·战略 dock 防溢出：wrap + 让位', () => {
  assert.match(SKILLS_SRC, /slgDock[\s\S]{0,200}flex-wrap:wrap/, 'dock 按钮必须可换行');
  /* 让位量会随右侧入口宽度变（六府 dock 收起折叠后只需 ~130px），
     所以断言「右侧至少留出 300px」而不是钉死 780px 这个旧魔数。 */
  const m = /max-width:calc\(100% - (\d+)px\)/.exec(SKILLS_SRC);
  assert.ok(m, 'dock 必须声明 max-width:calc(100% - Npx) 给右侧入口让位');
  assert.ok(Number(m[1]) >= 300, `让位宽度 ${m[1]}px 太小，右侧六府入口会被压住`);
});

test('M4-3·字号三档制与布局断点解耦并存', () => {
  assert.match(UI_SRC, /var FONT_TIERS = \[85, 100, 120\]/, '用户字号缩放层（M4-2）');
  assert.match(UI_SRC, /@media \(min-width:1920px\)/, '布局断点层（本批）');
});
