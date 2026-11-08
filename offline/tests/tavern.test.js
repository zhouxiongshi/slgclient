/**
 * 酒馆招募、战法格、以及 battle-kit 里实际能复刻的战法目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { createSkillAssets } from '../server/skills.js';
import { slotBlock, unlockTalent } from '../server/domain/slots.js';
import { guestsNow } from '../server/domain/tavern.js';

const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });

function makeCtx(state) {
  return {
    state, cfg, options: {},
    push() {},
    save() {},
    log() {},
    schedule() {},
  };
}

test('开局只有穿越者，酒馆每天 3 人且开城时分只能遇到其中 1 个', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = makeCtx(state);
  assert.equal(state.generals.length, 1);
  assert.equal(state.generals[0].isProtagonist, true);
  assert.equal(state.generals[0].skills[0].cfgId, 19001);
  assert.equal(state.generals[0].skills.length, 3);
  assert.equal(cfg.generalByCfg.get(880001).name, '主公');

  const now = guestsNow(state, 60000);
  assert.equal(now.length, 1);
  const drawn = handleRequest(ctx, req('general.drawGeneral', { drawTimes: 10 }));
  assert.equal(drawn.msg.generals.length, 1);
  assert.equal(drawn.msg.generals[0].level, 1);
  assert.equal(drawn.msg.generals[0].skills.filter(Boolean).length, 0);
  assert.notEqual(drawn.msg.generals[0].cfgId, 880001);
  const again = handleRequest(ctx, req('general.drawGeneral', { drawTimes: 10 }));
  assert.equal(again.msg.generals.length, 0);
});

test('学习格 5 级开，觉醒格要 20 级且自带 10 级，天赋默认关', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = makeCtx(state);
  const g = state.generals[0];
  const learn = cfg ? 10001 : 10001;
  assert.equal(slotBlock(g, 0, 'remove'), 'innate_locked');
  assert.equal(slotBlock(g, 1, 'replace'), 'slot_locked');
  g.level = 5;
  assert.equal(handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: learn, pos: 1 })).msg.ok, true);
  assert.equal(g.skills[1].cfgId, learn);
  assert.equal(handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: 10002, pos: 2 })).msg.reason, 'slot_locked');
  g.level = 20;
  g.skills[0].lv = 10;
  assert.equal(handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: 10002, pos: 2 })).msg.ok, true);
  unlockTalent(g);
  assert.equal(g.talentUnlocked, true);
  assert.equal(g.skills.length, 3);
  assert.equal(g.talent, null);
});

test('战法目录只复刻名字和原文片段，不填类型、特性和武将对应', () => {
  const book = JSON.parse(readFileSync(new URL('../conf/campaign/skill-source.json', import.meta.url), 'utf8'));
  assert.equal(book.nameCount, 796);
  assert.ok(book.missing.includes('skill_init'));
  for (const s of book.skills) {
    assert.equal(s.skillType, null);
    assert.equal(s.description, null);
    assert.equal(s.trait, null);
    for (const frag of s.fragments) assert.ok(frag.text.includes(s.name));
  }
});

test('客户端武将表运行时带上主公，磁盘文件不改', () => {
  const web = resolve(import.meta.dirname, '..', 'web');
  const assets = createSkillAssets(web);
  const uuid = '2bb9964d-0938-48d1-b4a5-f2cabf1c1c2b';
  const body = assets.intercept(`/assets/resources/import/${uuid.slice(0, 2)}/${uuid}.json`).body;
  const packed = JSON.parse(body);
  const list = packed[5][0][2].list;
  assert.ok(list.some((g) => g.name === '主公' && g.cfgId === 880001));
  const disk = JSON.parse(readFileSync(new URL(`../web/assets/resources/import/${uuid.slice(0, 2)}/${uuid}.json`, import.meta.url), 'utf8'));
  assert.equal(disk[5][0][2].list.some((g) => g.cfgId === 880001), false);
});
