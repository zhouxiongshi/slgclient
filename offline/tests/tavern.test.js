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
  /* 全武将初始战法表（920000+）启用时新武将会自带 1 条；不启用时为 0。
     这里守「初始战法不超过 1 条」，不再把白板假设写死。 */
  assert.ok(drawn.msg.generals[0].skills.filter(Boolean).length <= 1);
  assert.notEqual(drawn.msg.generals[0].cfgId, 880001);
  const again = handleRequest(ctx, req('general.drawGeneral', { drawTimes: 10 }));
  assert.equal(again.msg.generals.length, 0);
});

test('学习格 5 级开，觉醒格要 10 级且自带 10 级，天赋默认关', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = makeCtx(state);
  const g = state.generals[0];
  const learn = cfg ? 10001 : 10001;
  assert.equal(slotBlock(g, 0, 'remove'), 'innate_locked');
  assert.equal(slotBlock(g, 1, 'replace'), 'slot_locked');
  g.level = 5;
  /* ★ P12：协议层 upSkill 现在与六府装配同一条校验——战法必须先在战法库解锁。
     10001 是开局预置解锁（panels.js「开局旧藏」），所以用未解锁的 10003 验证闸门。 */
  assert.equal(handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: 10003, pos: 1 })).msg.reason, 'not_unlocked');
  state.skillbook.unlocked['10003'] = { level: 1, source: '战功研习' };
  assert.equal(handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: learn, pos: 1 })).msg.ok, true);
  assert.equal(g.skills[1].cfgId, learn);
  /* ★ P12：10002 也要先解锁（开局只预置 10001 / 910000），否则未解锁闸会先挡住觉醒槽判定 */
  state.skillbook.unlocked['10002'] = { level: 1, source: '战功研习' };
  assert.equal(handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: 10002, pos: 2 })).msg.reason, 'slot_locked');
  g.level = 9;
  g.skills[0].lv = 10;
  assert.equal(handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: 10002, pos: 2 })).msg.reason, 'slot_locked');
  g.level = 10;
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
