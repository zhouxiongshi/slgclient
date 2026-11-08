/**
 * 序章之后能落地的部分：选稿、宿命链、身故、覆盖层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { lineFor, nodeDraft } from '../server/domain/story.js';
import { transitionFate, actorName, chainDef } from '../server/domain/fate.js';
import { noteIfGeneralDown } from '../server/command.js';
import { sanitizeOverrides, applyTileOverlay } from '../server/gm/overrides.js';
import { chapterRules } from '../server/domain/campaign.js';

const cfg = loadConfig();

test('偏离段决定用哪一稿，旧史稿仍写 184', () => {
  const drafts = {
    canon: '你落在 184 年春。',
    shift: '路子偏了。',
    rewrite: '不必再按旧章。',
  };
  assert.equal(lineFor('canon', drafts), drafts.canon);
  assert.equal(lineFor('shift', drafts), drafts.shift);
  assert.equal(lineFor('rewrite', drafts), drafts.rewrite);
  assert.equal(nodeDraft('shift'), 'shift');
});

test('关羽在册时写关羽，招募后写陆昭，断链写无名部曲', () => {
  const state = { fates: {} };
  assert.equal(chainDef().nodes.length, 4);
  assert.equal(actorName(state), '关羽');
  assert.equal(transitionFate(state, 'recruit').state, 'standin');
  assert.equal(actorName(state), '陆昭');
  assert.equal(transitionFate(state, 'recruit').ok, false);
  assert.equal(transitionFate(state, 'die').state, 'broken');
  assert.equal(actorName(state), '无名部曲');
});

test('屯长兵力归零才记两本轨迹，记过一次就不再记', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const army = state.armys[0];
  state.campaign.spearmanId = 4242;
  army.generals[1] = 4242;
  army.soldiers[1] = 0;
  const row = noteIfGeneralDown(state, { push() {} }, army);
  assert.equal(row.official, '史无此人');
  assert.match(row.played, /兵尽/);
  assert.equal(noteIfGeneralDown(state, { push() {} }, army), null);
  assert.equal(state.chronicle.length, 1);
});

test('覆盖层只接收允许的字段，空规则不改军饷', () => {
  const clean = sanitizeOverrides({
    tiles: [{ x: 3, y: 4, grain: 50, extra: 'no' }],
    rules: { upkeepPerSoldier: 0.4, nope: 1 },
    story: { lend: '  乡人开口  ' },
    password: 'secret',
  });
  assert.equal(clean.tiles[0].grain, 50);
  assert.equal(clean.tiles[0].extra, undefined);
  assert.equal(clean.rules.nope, undefined);
  assert.equal(clean.password, undefined);
  assert.equal(clean.story.lend, '乡人开口');
  assert.equal(chapterRules().upkeepPerSoldier, 0.4);

  const state = createWorld(cfg);
  const home = state.builds[0];
  applyTileOverlay(state, [{ x: home.x, y: home.y, grain: 321 }]);
  assert.equal(home.grain, 321);
});

test('七幕骨架在，目前只有序章可玩', () => {
  const acts = JSON.parse(readFileSync(new URL('../conf/campaign/acts.json', import.meta.url), 'utf8'));
  assert.equal(acts.length, 8);
  assert.deepEqual(acts.filter((a) => a.playable).map((a) => a.id), ['prologue']);
});
