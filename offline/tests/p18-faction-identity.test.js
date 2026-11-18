/**
 * P18 回归：2026-11-18 主公身份模型（用户报告的「举义曹操后还能和曹操外交」矛盾）
 *  ① 举义势力=玩家自己：显示名归一、外交列表去重、外交动作拒绝
 *  ② 自建势力：局内达条件解锁、输入国号、建国后独立
 *  ③ 建国后原举义势力重回外交列表（已脱离）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { ensureStrategy, oathOptions, chooseOath, strategyViewState } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { diplomacyView, diplomacyAct } from '../server/domain/diplomacy.js';
import {
  playerIdentity, diplomacyExcluded, isSelfFaction, foundStatus, foundNation,
  playerCityCount, FOUND_MIN_CITIES,
} from '../server/domain/faction-identity.js';

const cfg = loadConfig();
const ctx = () => ({ push() {}, save() {}, log() {}, schedule() {}, state: null, cfg, options: {} });
function oathWorld(lordId = 'yanzhou') {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  ensureCityEcon(state, cfg);
  // 显式选曹操（基础模式 id=yanzhou）
  const lord = oathOptions(state).lords.find((l) => l.id === lordId)
    || oathOptions(state).lords[0];
  chooseOath(state, cfg, ctx(), { lord: lord.id, city: lord.cities[0].id });
  return { state, st: state.strategy, lordId: lord.id };
}

/* ---------------- ① 举义势力去重 ---------------- */

test('P18-① 举义曹操后玩家显示名为曹操，曹操势力从外交列表去重', () => {
  const { state, lordId } = oathWorld('yanzhou');
  const id = playerIdentity(state, cfg);
  assert.equal(id.kind, 'oath');
  assert.equal(id.lordId, lordId);
  // 显示名 = 所举义势力名（曹操）
  const config = JSON.parse(readFileSync(new URL('../conf/campaign/strategy/factions.json', import.meta.url), 'utf8'));
  const cao = config.factions.find((f) => f.id === lordId);
  assert.equal(id.name, cao.name, '玩家势力显示名 = 曹操');
  assert.ok(diplomacyExcluded(state).includes(lordId), '曹操势力被排除');
  assert.equal(isSelfFaction(state, lordId), true);
  const view = strategyViewState(state, cfg);
  assert.equal(view.oath.identity.name, cao.name, '视图下发归一显示名');
  const dip = diplomacyView(state);
  assert.equal(dip.factions.some((f) => f.id === lordId), false, '外交列表不含曹操');
});

test('P18-① 不能对自己的举义势力外交（防绕过 UI）', () => {
  const { state, lordId } = oathWorld('yanzhou');
  const r = diplomacyAct(state, cfg, ctx(), { action: 'gift', faction: lordId, gold: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'self_faction');
});

/* ---------------- ② 自建势力 ---------------- */

test('P18-② 自立门槛：城池不足时拒绝，达标后可建国并输入国号', () => {
  const { state, st } = oathWorld('yanzhou');
  // 默认举义后城池 < 6
  const before = foundStatus(state);
  assert.equal(before.ok, false);
  assert.equal(before.reason, 'not_enough_cities');
  // 把玩家城池补到门槛
  let filled = playerCityCount(state);
  for (const cid of Object.keys(st.cities)) {
    if (filled >= FOUND_MIN_CITIES) break;
    if (st.cities[cid].owner !== 'player') { st.cities[cid].owner = 'player'; filled += 1; }
  }
  assert.equal(foundStatus(state).ok, true, '达标后可自立');
  const r = foundNation(state, '  大魏  ');
  assert.equal(r.ok, true);
  assert.equal(state.founded.name, '大魏', '国号 trim 后落盘');
  const id = playerIdentity(state, cfg);
  assert.equal(id.kind, 'founded');
  assert.equal(id.name, '大魏');
  assert.equal(id.founded, true);
});

test('P18-② 协议 nation.foundStatus / nation.found', () => {
  const { state, st } = oathWorld('yanzhou');
  const c = ctx(); c.state = state;
  const s = handleRequest(c, { seq: 1, name: 'nation.foundStatus', msg: {} });
  assert.equal(s.code, 0);
  assert.equal(s.msg.reason, 'not_enough_cities');
  let filled = playerCityCount(state);
  for (const cid of Object.keys(st.cities)) {
    if (filled >= FOUND_MIN_CITIES) break;
    if (st.cities[cid].owner !== 'player') { st.cities[cid].owner = 'player'; filled += 1; }
  }
  const f = handleRequest(c, { seq: 2, name: 'nation.found', msg: { name: '吴' } });
  assert.equal(f.code, 0, JSON.stringify(f.msg));
  assert.equal(f.msg.founded.name, '吴');
  assert.equal(f.msg.identity.name, '吴');
  // 再建拒绝
  const again = handleRequest(c, { seq: 3, name: 'nation.found', msg: { name: '蜀' } });
  assert.equal(again.code !== 0, true);
  assert.equal(again.msg.reason, 'already_founded');
});

/* ---------------- ③ 建国后原势力重回外交 ---------------- */

test('P18-③ 建国后原举义势力重回外交列表、不再排除', () => {
  const { state, st, lordId } = oathWorld('yanzhou');
  let filled = playerCityCount(state);
  for (const cid of Object.keys(st.cities)) {
    if (filled >= FOUND_MIN_CITIES) break;
    if (st.cities[cid].owner !== 'player') { st.cities[cid].owner = 'player'; filled += 1; }
  }
  foundNation(state, '新魏');
  assert.deepEqual(diplomacyExcluded(state), [], '建国后不排除任何势力');
  const dip = diplomacyView(state);
  assert.equal(dip.factions.some((f) => f.id === lordId), true, '原举义势力重新可外交');
});

test('P18-③ 未举义旧档显示我军、不排除任何势力', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  const id = playerIdentity(state, cfg);
  assert.equal(id.kind, 'player');
  assert.equal(id.name, '我军');
  assert.deepEqual(diplomacyExcluded(state), []);
});
