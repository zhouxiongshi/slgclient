/**
 * 序章：游戏日入账、军饷闸门、黄巾节拍、借粮、偏离不过改写线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { chapterRules, onTileCleared, noticeRecruit } from '../server/domain/campaign.js';
import { projectGrain } from '../server/domain/economy.js';
import { recordDeath } from '../server/domain/chronicle.js';
import { rewindDays } from '../server/clock.js';

const cfg = loadConfig();
const rules = chapterRules();

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, options: {}, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    schedule() {},
    save() {},
    log() {},
  };
}
const req = (name, msg = {}) => ({ seq: 1, name, msg });
const tick = (ctx) => handleRequest(ctx, req('role.myRoleRes'));

test('40 日演算：1000 兵有余，5000 兵中途见底，不征兵不顶仓', () => {
  const cap = 1000000;
  const u = rules.upkeepPerSoldier;
  const small = projectGrain({
    grain: 10000, yieldPerDay: 2000, soldiers: 1000, upkeepPerSoldier: u, days: 40, cap,
  });
  assert.ok(small[39] > 0);
  assert.ok(small[39] < cap / 2);

  const large = projectGrain({
    grain: 10000, yieldPerDay: 1000, soldiers: 5000, upkeepPerSoldier: u, days: 40, cap,
  });
  assert.ok(large[2] > 0, '第 3 日不应已经没粮');
  assert.ok(large.some((g, i) => i >= 3 && g === 0), '5000 兵应在 40 日内见底');

  const idle = projectGrain({
    grain: 10000, yieldPerDay: 1000, soldiers: 0, upkeepPerSoldier: u, days: 40, cap,
  });
  assert.ok(idle[39] > 10000);
  assert.ok(idle[39] < cap);
});

test('游戏日往前走时入账军饷，并把序章第 1 日写进聊天', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  for (const army of state.armys) army.soldiers = [0, 0, 0];
  state.armys[0].soldiers = [1000, 0, 0];
  const grain0 = state.roleRes.grain;
  rewindDays(state, 1, rules);
  tick(ctx);
  assert.equal(state.clock.day, 2);
  assert.ok(state.roleRes.grain < grain0 + state.roleRes.grain_yield);
  assert.ok(state.chat.some((c) => c.msg.includes('184')));
  assert.equal(state.drift.band, 'canon');
});

test('跳到第 5 日刷出黄巾格，不打则第 12 日丢掉一块田', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const before = state.builds.filter((b) => b.rid === state.role.rid).length;
  rewindDays(state, 4, rules);
  tick(ctx);
  assert.equal(state.clock.day, 5);
  assert.equal(state.garrisons.length, 1);
  assert.equal(state.garrisons[0].name, '黄巾游骑');
  assert.equal(state.builds.some((b) => b.name === '黄巾游骑' && b.rid === 2), true);

  rewindDays(state, 7, rules);
  tick(ctx);
  assert.equal(state.clock.day, 12);
  const after = state.builds.filter((b) => b.rid === state.role.rid && b.type >= 52 && b.type <= 55).length;
  assert.equal(after, before - 1);
});

test('借粮会扣粮、发屯长、压低第二波；不选则到点按拒援', () => {
  const lend = createWorld(cfg);
  const ctxL = makeCtx(lend);
  assert.equal(handleRequest(ctxL, req('campaign.choose', { option: 'lend' })).code, 0);
  rewindDays(lend, 19, rules);
  tick(ctxL);
  assert.equal(lend.clock.day, 20);
  assert.equal(lend.campaign.choice, 'lend');
  assert.equal(lend.campaign.waveFactor, rules.wave2.lendFactor);
  assert.ok(lend.campaign.spearmanId > 0);
  assert.equal(lend.drift.score, rules.lendDrift);
  assert.equal(lend.drift.band, 'canon');
  const spear = lend.generals.find((g) => g.id === lend.campaign.spearmanId);
  assert.ok(spear);
  assert.equal(ctxL.pushes.some((p) => p.name === 'campaign.pending'), false, '已决定就不再推弹窗');

  rewindDays(lend, 8, rules);
  tick(ctxL);
  const wave = lend.garrisons.find((g) => g.name === '黄巾再至');
  assert.ok(wave);
  assert.equal(wave.soldiers, Math.round(rules.wave2.soldiers * rules.wave2.lendFactor));

  const refuse = createWorld(cfg);
  const ctxR = makeCtx(refuse);
  rewindDays(refuse, 27, rules);
  tick(ctxR);
  assert.equal(refuse.clock.day, 28);
  assert.equal(refuse.campaign.choice, 'refuse');
  assert.equal(refuse.campaign.spearmanId, 0);
  const waveR = refuse.garrisons.find((g) => g.name === '黄巾再至');
  assert.equal(waveR.soldiers, Math.round(rules.wave2.soldiers * rules.wave2.refuseFactor));
  assert.notEqual(wave.soldiers, waveR.soldiers);
  assert.ok(refuse.chat.some((c) => c.msg.includes('拒援')), '超时应写明按拒援记');
});

test('第 20 日推弹窗，点选借粮立即生效', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  rewindDays(state, 19, rules);
  tick(ctx);
  assert.equal(state.clock.day, 20);
  assert.equal(state.campaign.choice, null);
  const pending = ctx.pushes.find((p) => p.name === 'campaign.pending');
  assert.ok(pending, '第 20 日应推送弹窗');
  assert.ok(pending.msg.text.includes(String(rules.lendGrain)));
  assert.ok(pending.msg.lend && pending.msg.refuse);

  assert.equal(handleRequest(ctx, req('campaign.choose', { option: 'refuse' })).msg.ok, true);
  assert.equal(state.campaign.choice, 'refuse');
  assert.equal(state.campaign.waveFactor, rules.wave2.refuseFactor);
  assert.equal(state.campaign.spearmanId, 0);
  assert.ok(state.chat.some((c) => c.msg.includes('天机')));
});

test('序章后黄巾流寇按周期出现，太久不打会掠田', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const city = state.citys[0];
  for (let i = 0; i < 5; i += 1) {
    state.builds.push({
      rid: state.role.rid, x: city.x + 4 + i, y: city.y, type: 52, level: 3,
      wood: 0, iron: 0, stone: 0, grain: 100, op_level: 3,
      curDurable: 10000, maxDurable: 10000,
    });
  }
  rewindDays(state, 39, rules);
  tick(ctx);
  assert.equal(state.campaign.ending, 'held');

  rewindDays(state, 6, rules);
  tick(ctx);
  assert.equal(state.clock.day, 46);
  const patrol = state.garrisons.find((g) => g.patrol && !g.cleared);
  assert.ok(patrol, '第 46 日应刷出流寇');
  assert.equal(patrol.name, rules.patrol.name);
  assert.equal(patrol.soldiers, rules.patrol.baseSoldiers + 6 * rules.patrol.growthPerDay);

  const before = state.builds.filter((b) => b.rid === state.role.rid && b.type >= 52 && b.type <= 55).length;
  rewindDays(state, 9, rules);
  tick(ctx);
  const after = state.builds.filter((b) => b.rid === state.role.rid && b.type >= 52 && b.type <= 55).length;
  assert.equal(after, before - 1, '流寇超期应掠走一块田');

  const drift0 = state.drift.score;
  const g2 = onTileCleared(state, cfg, patrol.x, patrol.y);
  assert.ok(g2);
  assert.equal(state.drift.score, drift0 + rules.patrol.clearDrift, '清剿流寇的偏离奖励应低于波次');
});

test('第 40 日守住则磨坊吃到曲辕犁，偏离仍停在旧史', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const city = state.citys[0];
  for (let i = 0; i < 4; i += 1) {
    state.builds.push({
      rid: state.role.rid, x: city.x + 4 + i, y: city.y, type: 52, level: 3,
      wood: 0, iron: 0, stone: 0, grain: 100, op_level: 3,
      curDurable: 10000, maxDurable: 10000,
    });
  }
  rewindDays(state, 39, rules);
  tick(ctx);
  assert.equal(state.clock.day, 40);
  assert.equal(state.campaign.ending, 'held');
  assert.ok(state.campaign.blueprints.includes('quyuanli'));
  assert.ok(state.drift.score < 30);

  tick(ctx);
  const mill = state.facilities[1].find((f) => f.type === 19);
  const before = state.roleRes.grain_yield;
  mill.level = 1;
  mill.up_time = 0;
  tick(ctx);
  assert.equal(state.roleRes.grain_yield, before + Math.floor(1000 * (1 + rules.blueprint.bonus)));
});

test('招募关羽，宿命链走到替身且只走一次', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const row = noticeRecruit(state, ctx, '关羽');
  assert.ok(row && row.ok);
  assert.equal(state.fates.guanyu, 'standin');
  assert.ok(state.chat.some((c) => c.msg.includes('陆昭')));
  assert.equal(noticeRecruit(state, ctx, '关羽'), null);
  assert.equal(state.fates.guanyu, 'standin');
});

test('身故留下正史与本局两本轨迹', () => {
  const state = createWorld(cfg);
  state.clock.day = 12;
  state.drift.band = 'canon';
  const row = recordDeath(state, {
    generalId: 1,
    cfgId: 0,
    name: '屯长',
    official: rules.spearman.official,
    played: '第 12 日死在坞堡外。他守的是村子，不是名将谱。',
  });
  assert.equal(row.official, '史无此人');
  assert.match(row.played, /第 12 日/);
  assert.equal(state.chronicle.length, 1);
});

test('v2 存档补上时钟和序章字段', () => {
  const old = {
    version: 2, role: { rid: 1 }, roleRes: {}, citys: [], generals: [], armys: [],
    builds: [], facilities: {}, counters: {}, pending: [],
  };
  normalizeWorld(old, cfg);
  assert.equal(old.version, 3);
  assert.equal(old.clock.day, 1);
  assert.equal(old.drift.band, 'canon');
  assert.equal(old.campaign.id, 'chapter1');
});

test('邻格行军至少 3 秒，4 倍速把游戏日压到 15 秒', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const city = state.citys[0];
  const army = state.armys[0];
  handleRequest(ctx, req('army.assign', { armyId: army.id, cmd: 1, x: city.x + 1, y: city.y }));
  assert.ok(army.end >= army.start + 3);
  assert.ok(army.end <= army.start + 4);

  handleRequest(ctx, req('campaign.speed', { scale: 4 }));
  assert.equal(state.clock.scale, 4);
  rewindDays(state, 1, rules);
  const day = state.clock.day;
  tick(ctx);
  assert.equal(state.clock.day, day + 1);
});
