/**
 * P61-C（2026-11-25）外交修复回归：
 *  S8 基础关系查表、未收录势力明说「素无往来」；
 *  S4 劝降 5:1 + 态度 60 + 残局 + 未交战，成功只取都城、余城保留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, chooseOath, oathOptions,
} from '../server/domain/strategy.js';
import {
  attitudeOf, diplomacyAct, diplomacyView, PLAYER_ID,
} from '../server/domain/diplomacy.js';

const cfg = loadConfig();
function mkCtx() {
  const pushes = [];
  return { push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {}, pushes };
}
function fresh() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const lord = oathOptions(s).lords.find((l) => l.cities.length >= 2) || oathOptions(s).lords[0];
  const r = chooseOath(s, cfg, mkCtx(), { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true);
  return s;
}
function pairKey(a, b) { return [a, b].sort().join('|'); }

test('P61-S8 基础关系查真实配置：董曹讨伐 -30，未收录势力为素无往来 0', () => {
  const s = fresh();
  const dong = attitudeOf(s, 'sili', 'yanzhou');
  const cao = attitudeOf(s, 'yanzhou', 'sili');
  assert.ok(dong.factors.some((f) => f.label === '基础(史实关系)' && f.delta === -30));
  assert.ok(cao.factors.some((f) => f.label === '基础(史实关系)' && f.delta === -30),
    '同一对势力双向同值（董卓-曹操讨伐关系）');
  const labels = attitudeOf(s, 'sili', 'youzhou').factors.map((f) => f.label);
  assert.ok(labels.includes('基础(素无往来)'), '未收录关系不能伪装成史实');
});

test('P61-S4 劝降：兵力 3:1、态度不足、对方城多、交战中一律拒绝', () => {
  const s = fresh();
  const ctx = mkCtx();
  const f = diplomacyView(s).factions.find((x) => x.troops > 0);
  assert.ok(f);
  const p = s.strategy.diplomacy.pairs[pairKey(PLAYER_ID, f.id)]
    || (s.strategy.diplomacy.pairs[pairKey(PLAYER_ID, f.id)] = {});
  p.eventAdj = 60;
  s.armys[0].soldiers = [Math.ceil(f.troops * 4), 0, 0];
  const few = diplomacyView(s).factions.find((x) => x.id === f.id);
  assert.equal(few.gates.surrender.ok, false, '4:1 不够 5:1');
  const r = diplomacyAct(s, cfg, ctx, { action: 'surrender', faction: f.id });
  assert.equal(r.ok, false);
  assert.match(r.text, /未达 60|5:1|城/);
});

test('P61-S4 劝降成功只献都城，余城仍在、vassal 留复国基础', () => {
  const s = fresh();
  const ctx = mkCtx();
  const view = diplomacyView(s).factions.find((x) => x.troops > 0);
  const fid = view.id;
  const owned = Object.keys(s.strategy.cities).filter((id) => s.strategy.cities[id].owner === fid);
  assert.ok(owned.length > 0);
  // 缩成 2 城残局：只留都城与另一城
  const keep = new Set([String(view.homeCity), owned.find((id) => id !== String(view.homeCity))].filter(Boolean));
  for (const id of owned) if (!keep.has(id)) s.strategy.cities[id].owner = 'han';
  const troops = Math.max(1000, Object.values(s.strategy.cities)
    .filter((r) => r.owner === fid).reduce((n, r) => n + (Number(r.troops) || 0), 0));
  s.armys[0].soldiers = [Math.ceil(troops * 6), 0, 0];
  const key = pairKey(PLAYER_ID, fid);
  const p = s.strategy.diplomacy.pairs[key] || (s.strategy.diplomacy.pairs[key] = {});
  p.eventAdj = 100; // 覆盖史实基础项 -30 后仍有 70 ≥ 60
  p.war = false;
  const before = diplomacyView(s).factions.find((x) => x.id === fid);
  assert.equal(before.gates.surrender.ok, true, JSON.stringify(before.factors));
  const result = diplomacyAct(s, cfg, ctx, { action: 'surrender', faction: fid });
  assert.equal(result.ok, true, result.text);
  const after = Object.keys(s.strategy.cities).filter((id) => s.strategy.cities[id].owner === fid);
  assert.ok(after.length >= 1, '余城保留，不是举境全失');
  assert.equal(s.strategy.cities[String(view.homeCity)]?.owner, PLAYER_ID, '都城归附');
  assert.equal(s.strategy.diplomacy.pairs[key].vassal, true);
  assert.ok(Array.isArray(result.factors), '理由链保留');
});
