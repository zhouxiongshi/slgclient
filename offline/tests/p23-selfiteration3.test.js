/**
 * 2026-11-20 自迭代第三轮回归锁：外交入口可达 / 事件降噪 / 一统线可达。
 *
 * 三条都来自长局实测，不是想象出来的边界：
 *   · 外交功能齐全（出征窗第 5 页签），但玩家找不到——400 旬劝降探针用了一整局都没点开；
 *   · 未决事件挂 4 旬后自动结案，一次事件写三行日志（触发/抉择/逾期），
 *     150 旬 224 行事件日志里 148 行是这种噪音；
 *   · 一统线 45 城实测任何玩法都够不到（会打+会管理 400 旬峰值 24 城），
 *     且劝降只看城守军、不算在编部队，2 万大军的兵力比判定恒不满足。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, stageGoalTick,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { diplomacyView, diplomacyAct } from '../server/domain/diplomacy.js';
import { UNIFY_CITIES, SANDBOX_ENDING } from '../server/domain/stage-goals.js';

const cfg = loadConfig();

function fresh() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state); ensureCityEcon(state);
  const ctx = { state, cfg, pushes: [], options: {}, push() {}, schedule() {}, save() {}, log() {} };
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  assert.equal(chooseOath(state, cfg, ctx, { lord: cao.id, city: cao.cities[0].id }).ok, true);
  return { state, ctx };
}

/* ---------------------------------------------------------------- 外交入口 */

test('战略页有外交直达按钮，落到既有出征窗的 diplo 页签', () => {
  const src = readFileSync(new URL('../server/panels-ui.js', import.meta.url), 'utf8');
  assert.match(src, /data-act="diplomacy"/, '战略页必须给出外交入口');
  assert.match(src, /__slgWarWindow\(\{ tab: 'diplo' \}\)/, '必须复用既有外交页签，不新建视图');
  const skills = readFileSync(new URL('../server/skills.js', import.meta.url), 'utf8');
  assert.match(skills, /\['diplo', '外交'\]/, '出征窗必须仍有外交页签');
});

test('劝降兵力比计入在编部队（旧口径只算城守军，2 万兵等于不存在）', () => {
  const { state } = fresh();
  const before = diplomacyView(state).myTroops;
  const army = state.armys[0];
  const old = Number(army.soldiers[0]) || 0;
  army.soldiers = [3000, 0, 0];
  const after = diplomacyView(state).myTroops;
  assert.equal(after - before, 3000 - old, '在编兵力的增量必须计入我军总兵力');
});

test('兵力够 5:1、态度够、对方仅余残局时劝降称臣（旧 3:1 全境吞并捷径已堵）', () => {
  const { state, ctx } = fresh();
  const f = diplomacyView(state).factions.find((x) => x.troops > 0);
  assert.ok(f, '应有一个有兵力的 NPC 势力');
  const army = state.armys[0];
  army.soldiers = [Math.ceil(f.troops * 6), 0, 0];
  state.roleRes.gold = 1e6;
  // 缩成 1 城残局；赠礼仍留理由链，态度再补到 60 以上
  const owned = Object.keys(state.strategy.cities)
    .filter((id) => state.strategy.cities[id].owner === f.id);
  for (const id of owned) if (id !== String(f.homeCity)) state.strategy.cities[id].owner = 'han';
  diplomacyAct(state, cfg, ctx, { action: 'gift', faction: f.id, gold: 20000 });
  const key = ['player', f.id].sort().join('|');
  const p = state.strategy.diplomacy.pairs[key];
  p.eventAdj = 100;
  p.war = false;
  const again = diplomacyView(state).factions.find((x) => x.id === f.id);
  assert.ok(again.gates.surrender.ok, '新门槛齐备才可劝降');
  const r = diplomacyAct(state, cfg, ctx, { action: 'surrender', faction: f.id });
  assert.equal(r.ok, true, r.text);
  assert.ok(Array.isArray(r.factors), '理由链不能因为成功就消失');
});

/* ---------------------------------------------------------------- 一统线 */

test('一统线设为实测可达的 24 城，终局只结算一次且不硬中断', () => {
  assert.equal(UNIFY_CITIES, 24);
  const { state, ctx } = fresh();
  const ids = Object.keys(state.strategy.cities).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) state.strategy.cities[ids[i]].owner = i < UNIFY_CITIES ? 'player' : 'han';
  const hit = stageGoalTick(state, cfg, ctx);
  assert.ok(hit.some((h) => h.id === SANDBOX_ENDING.id));
  assert.equal(state.strategy.sandboxEnding.cities, UNIFY_CITIES);
  assert.equal(stageGoalTick(state, cfg, ctx).length, 0, '终局不能重复结算');
  assert.ok(state.strategy.cities[ids[UNIFY_CITIES]], '达成后仍可继续经营，不硬中断');
});
