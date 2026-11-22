/**
 * P41（2026-11-22）内政岗位一键委任回归：
 *  只填空缺、职业适任、在编/已任不参与、同分可重放，UI 不暴露内部资源键。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { panelAction, panelState } from '../server/domain/panels.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cfg = loadConfig();

function seeded() {
  const s = createWorld(cfg);
  panelState(s, cfg); // 初始化 interior.posts
  s.generals.push(...[
    [10, 100023], [11, 100017], [12, 100161], [13, 100001], [14, 100161],
  ].map(([id, cfgId]) => ({ id, cfgId, name: `测试武将${id}`, loyal: 70 + id, level: 1, skills: [] })));
  return s;
}

test('P41-① 一键委任只填空缺且一人一岗，军师与在编武将不参与', () => {
  const s = seeded();
  s.interior.posts.agri = 10;           // 已有任命不可覆盖
  s.armys = s.armys || [];
  s.armys.push({ id: 99, generals: [12], cityId: s.strategy?.playerCity || 0 });
  const r = panelAction(s, cfg, { type: 'appointAll' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.interior.posts.agri, 10, '已有任命必须保留');
  const filled = Object.values(s.interior.posts).map(Number).filter(Boolean);
  assert.equal(new Set(filled).size, filled.length, '一人不得兼两岗');
  assert.ok(!filled.includes(11), '军师不任内政岗');
  assert.ok(!filled.includes(12), '在编武将不参与');
  assert.ok(r.message.startsWith('一键委任完成'), r.message);
  assert.doesNotMatch(r.message, /grain|gold|iron|stone|wood|strategist|warrior/i, '回话不得夹内部键');
});

test('P41-② 重复调用不再改动，空缺无合适人选时如实说明', () => {
  const s = seeded();
  const first = panelAction(s, cfg, { type: 'appointAll' });
  const snapshot = JSON.stringify(s.interior.posts);
  const second = panelAction(s, cfg, { type: 'appointAll' });
  assert.equal(JSON.stringify(s.interior.posts), snapshot, '第二次不得改任何岗位');
  assert.equal(second.ok, true);
  assert.ok(second.message.includes('现有任命未改动'), second.message);
  assert.ok(second.message.includes('暂无可任武将'), '缺人的岗位要说明');

  const empty = createWorld(cfg);
  panelState(empty, cfg);
  const r0 = panelAction(empty, cfg, { type: 'appointAll' });
  assert.equal(r0.ok, true);
  assert.ok(r0.message.includes('暂无可任武将'), r0.message);
});

test('P41-③ 一键委任入口与规则展示都在运行时 UI 中', () => {
  const p = readFileSync(resolve(ROOT, 'server/panels-ui.js'), 'utf8');
  assert.ok(p.includes('data-act="appointAll"'), '必须有按钮');
  assert.ok(p.includes("if (act === 'appointAll') return post({ type: 'appointAll' })"), '必须有分发');
  assert.ok(p.includes('一键委任只补空缺'), '规则必须写在界面上');
  const d = readFileSync(resolve(ROOT, 'server/domain/panels.js'), 'utf8');
  assert.ok(d.includes("if (type === 'appointAll')"), '规则必须在领域层，不在 UI 复算');
  assert.ok(d.includes('CAREER_FIT[careerOf(x).career]?.civilPost'), '与手动委任同源职业闸');
});
