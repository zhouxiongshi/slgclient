/**
 * P42（2026-11-22）府库可读性回归：库存/日产/用途/上限四件事分列展示，
 * 城内页与六府共用 materialGuide，按钮代价从 title 提升到可见文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { materialGuide } from '../server/domain/armory.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const cfg = loadConfig();

test('P42-① guide 自带用途三句话，资源/动作字段齐全且不改数值规则', () => {
  const g = materialGuide(createWorld(cfg));
  assert.ok(g.brief.includes('看库存与日产') && g.brief.includes('不进仓库上限'), g.brief);
  assert.deepEqual(g.resources.map((r) => r.key), ['wood', 'iron', 'stone', 'grain', 'gold', 'decree', 'jungong']);
  assert.ok(g.resources.every((r) => r.label && r.use));
  assert.equal(g.actions.length, 11);
  assert.ok(g.actions.every((a) => a.note), '每个动作都有可见代价说明');
});

test('P42-② 六府府库以表格区分库存/日产/用途/上限，代价不再藏在 title', () => {
  const p = read('server/panels-ui.js');
  const seg = p.slice(p.indexOf('function viewDepot'), p.indexOf('function viewEquip'));
  assert.ok(seg.includes('<th>资源</th><th>库存</th><th>日产</th><th>用途</th><th>上限</th><th>状态</th>'));
  assert.ok(seg.includes('物资去处 · 即时办理'));
  assert.ok(seg.includes("esc(a.note || '')"), '代价可见');
  assert.doesNotMatch(seg, /title="'\s*\+\s*esc\(a\.note/, '不再只靠 title');
  assert.ok(seg.includes('guide.brief'), '三句话说明上屏');
});

test('P42-③ 城内页府库直接消费 guide，不再自造资源行', () => {
  const sk = read('server/skills.js');
  const seg = sk.slice(sk.indexOf('function tabHome'), sk.indexOf('function tabArmy'));
  assert.ok(seg.includes("var guide = (rs[1].msg && rs[1].msg.guide) || {}"), '同一次响应取 guide');
  assert.ok(seg.includes('(guide.resources || [])'), '使用同源资源');
  assert.doesNotMatch(seg, /\[\['wood', '木', res\.wood_yield\]/, '旧的自造行已移除');
  assert.ok(seg.includes('esc(guide.brief'), '用途说明在城内页同样可见');
});
