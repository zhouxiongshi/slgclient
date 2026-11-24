/**
 * P51（2026-11-24）武将页体验回归：
 *  1. 武将列表与详情各自独立滚动，换人只重置详情；
 *  2. 批量调防 UI（勾选 / 全选 / 目标城 / 一次提交）；
 *  3. 批量调防领域：全体校验、局部跳过有中文原因、全体不可调时一人不动；
 *  4. 单人调防回归——与批量共用同一份校验与落账口径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath, dispatchGeneral, dispatchGenerals } from '../server/domain/strategy.js';

const cfg = loadConfig();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function ctx() { return { push() {} }; }

function freshState() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(s, cfg, ctx(), { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  s.clock.day = 10;
  const from = Number(s.strategy.playerCity);   // 举义把所有武将迁到新都
  const to = Number(Object.entries(s.strategy.cities)
    .find(([id, c]) => c.owner === 'player' && Number(id) !== from)?.[0]);
  assert.ok(Number.isFinite(to) && to > 0, '前提：举义后至少两座己方城');
  return { s, from, to };
}

test('P51-① 列表与详情独立滚动：两栏各有滚动容器并切断滚动链', () => {
  const ui = read('server/panels-ui.js');
  assert.match(ui, /\.body\.gen-body\{display:flex;flex-direction:column;overflow:hidden/,
    '武将页正文自己不滚，避免把左右两栏绑在同一条滚动链上');
  assert.match(ui, /\.gen-body \.cols\{flex:1;min-height:0;overflow:hidden;align-items:stretch/);
  assert.match(ui, /\.gen-body \.genlist\{height:100%;max-height:none;overscroll-behavior:contain/);
  assert.match(ui, /\.gen-body \.cols>\.right\{height:100%;overflow-y:auto;overscroll-behavior:contain/);
  assert.match(ui, /body\.className = 'body' \+ \(ui\.tab === 'general' \? ' gen-body' : ''\)/);
  assert.match(ui, /if \(lg0\) genScroll\.list = lg0\.scrollTop/);
  assert.match(ui, /if \(rt1\) rt1\.scrollTop = sameHero \? genScroll\.detail : 0/,
    '换武将后详情从头看，列表位置不动');
});

test('P51-② 批量调防入口：勾选、全选、目标城、一次提交都在左栏', () => {
  const ui = read('server/panels-ui.js');
  assert.match(ui, /class="genpick" type="checkbox" data-act="genpick"/);
  assert.match(ui, /data-act="genpickAll"/);
  assert.match(ui, /data-act="genpickClear"/);
  assert.match(ui, /<select data-act="dispatchTo">/);
  assert.match(ui, /data-act="dispatchBatch"/);
  assert.match(ui, /action: 'dispatchGenerals', generalIds: ui\.genPick\.slice\(\)/);
  assert.match(ui, /请先勾选要调遣的武将/, '空选给中文提示');
  assert.match(ui, /驻' \+ esc\(g\.cityName/, '左栏显示驻地，便于批量挑人');
});

test('P51-③ 批量调防：多名武将一次改驻地，返回中文汇总', () => {
  const { s, from, to } = freshState();
  const gs = s.generals.filter((g) => !g.isProtagonist && Number(g.cityId) === from).slice(0, 2);
  assert.ok(gs.length >= 2, '前提：出发城有两名以上武将');
  const r = dispatchGenerals(s, cfg, ctx(), { generalIds: gs.map((g) => g.id), toCityId: to });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.moved.length, 2);
  assert.equal(r.skipped.length, 0);
  for (const g of gs) assert.equal(g.cityId, to, '批量后每人驻地都改到目标城');
  assert.match(r.text, /2 员武将调往/);
  assert.doesNotMatch(r.text, /same_city|no_general|marching/, '玩家文案不夹协议码');
});

test('P51-④ 混合勾选：不可调者跳过并写明原因，其余照常调', () => {
  const { s, from, to } = freshState();
  const gs = s.generals.filter((g) => !g.isProtagonist && Number(g.cityId) === from).slice(0, 2);
  assert.ok(gs.length >= 2);
  gs[0].cityId = to;                       // 已在此城
  const r = dispatchGenerals(s, cfg, ctx(), { generalIds: gs.map((g) => g.id), toCityId: to });
  assert.equal(r.ok, true);
  assert.equal(r.moved.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, 'same_city');
  assert.equal(gs[1].cityId, to);
  assert.match(r.text, /已在此城/, '跳过原因写进中文汇总');
});

test('P51-⑤ 行军中不可调，也不影响同批其他人', () => {
  const { s, from, to } = freshState();
  const gs = s.generals.filter((g) => !g.isProtagonist && Number(g.cityId) === from).slice(0, 2);
  assert.ok(gs.length >= 2);
  (s.armys ||= []).push({ id: 90071, marchId: 31, generals: [gs[0].id], cityId: from });
  const r = dispatchGenerals(s, cfg, ctx(), { generalIds: gs.map((g) => g.id), toCityId: to });
  assert.equal(r.ok, true);
  assert.equal(r.skipped[0].reason, 'marching');
  assert.equal(gs[0].cityId, from, '行军者原地不动');
  assert.equal(gs[1].cityId, to);
  assert.match(r.text, /行军中不可调/);
});

test('P51-⑥ 全体不可调时一人不动；空选 / 非己方城明确拒绝', () => {
  const { s, from, to } = freshState();
  const g = s.generals.find((x) => !x.isProtagonist && Number(x.cityId) === from);
  g.cityId = to;
  const all = dispatchGenerals(s, cfg, ctx(), { generalIds: [g.id], toCityId: to });
  assert.equal(all.ok, false);
  assert.equal(all.reason, 'all_skipped');
  assert.equal(all.moved.length, 0);
  assert.match(all.text, /没有武将可调/);
  const empty = dispatchGenerals(s, cfg, ctx(), { generalIds: [], toCityId: to });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no_general');
  assert.match(empty.text, /请先勾选/);
  const badCity = dispatchGenerals(s, cfg, ctx(), { generalIds: [g.id], toCityId: 999999 });
  assert.equal(badCity.ok, false);
  assert.equal(badCity.reason, 'not_own_city');
  assert.match(badCity.text, /己方城池/);
});

test('P51-⑦ 单人调防回归：与批量共用校验，返回结构不变', () => {
  const { s, from, to } = freshState();
  const g = s.generals.find((x) => !x.isProtagonist && Number(x.cityId) === from);
  const r = dispatchGeneral(s, cfg, ctx(), { generalId: g.id, toCityId: to });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.generalId, g.id);
  assert.equal(r.from, from);
  assert.equal(r.to, to);
  assert.ok(r.toName && r.fromName);
  assert.equal(g.cityId, to);
  const same = dispatchGeneral(s, cfg, ctx(), { generalId: g.id, toCityId: to });
  assert.equal(same.ok, false);
  assert.equal(same.reason, 'same_city');
});

test('P51-⑧ 协议端点已接线，批量动作不绕过领域层', () => {
  const idx = read('server/index.js');
  assert.match(idx, /dispatchGeneral, dispatchGenerals/);
  assert.match(idx, /act === 'dispatchGenerals'/);
  assert.match(idx, /generalIds: body\?\.generalIds/);
});
