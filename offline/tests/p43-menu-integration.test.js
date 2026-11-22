/**
 * P43（2026-11-22）菜单整合回归：六府入口并入沙盘顶部横向菜单，
 * 旧 dock 保留 DOM / z-index 契约但视觉收起，点击仍走同一条打开链路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

test('P43-① 沙盘横向菜单含六府全部分组入口，并保留天下日志与布局闸', () => {
  const sk = read('server/skills.js');
  const seg = sk.slice(sk.indexOf("dock.innerHTML = ''"), sk.indexOf("dock.querySelectorAll('button')"));
  assert.ok(seg.includes('<span class="gp">六府</span>'), '有独立分组标签');
  for (const id of ['general', 'strategy', 'interior', 'depot', 'equip', 'library', '__reports']) {
    assert.ok(seg.includes(`data-slgpanel="${id}"`), `缺少入口 ${id}`);
  }
  assert.ok(seg.includes('id="slgBtnLog"'), '天下日志仍在');
  assert.ok(sk.includes('max-width:calc(100% - 320px)'), '右侧让位闸不得放宽');
  assert.ok(sk.includes('flex-wrap:wrap'), '防溢出换行仍在');
});

test('P43-② 新入口转发旧 dock，不复制打开逻辑；旧 dock 视觉收起但保留 z-index', () => {
  const sk = read('server/skills.js');
  assert.ok(sk.includes('#slgPanelsDock [data-id="'), '仍走旧入口');
  assert.ok(sk.includes('legacy.click()'), '红点/一屏一窗逻辑复用');
  const p = read('server/panels-ui.js');
  assert.ok(p.includes('#slgPanelsDock{display:none!important;}'), '右侧 dock 不再重复占位');
  assert.match(p, /#slgPanelsDock\{[^}]*z-index:99999/, 'z-index 契约保留');
  assert.ok(p.includes('window.__slgPanels = {'), '功能后端保留');
});

test('P43-③ 当前事务浮窗回到右上角，不再为旧 dock 让 232px', () => {
  const sh = read('server/ui-shell.js');
  assert.ok(sh.includes('#slgIxAgenda{right:12px;top:56px'), '位置改为右上角');
  assert.doesNotMatch(sh, /#slgIxAgenda\{right:12px;top:232px/);
});

test('P43-④ 冒烟取证按新入口核对，不再要求隐藏 dock 有可见宽度', () => {
  const sm = read('electron/smoke.cjs');
  assert.ok(sm.includes("document.querySelectorAll('#slgDock [data-slgpanel]').length"), '取证统计横向入口');
  assert.ok(sm.includes("document.querySelector('#slgDock [data-slgpanel=\"__reports\"]')"), '战报按新入口取证');
});
