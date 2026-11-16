/**
 * ★ P13 招募三项修复（用户 2026-11-16 实测反馈）+ 人口扩容平衡。
 *
 *  1. 指名招募：玩家点选谁就招谁（旧实现招「此刻在店」第一个，点 A 来 B）。
 *  2. 武将可以拒绝：掷骰与「探索登庸」同源（relation.talentRecruitRate），
 *     失败不扣金、三顾好感 +1（再访 +12%）；不再「每回合第一次 100% 成功」。
 *  3. 时辰语义：已离店 / 未到店 / 今日不在本城，各有可读原因（不再是含混的「过时」）。
 *  4. 人口扩容：初始人口阶梯 ×3~7（map.json），上限 10 万 → 100 万；城库随人口缩放。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { ensureTavern, todaysGuests } from '../server/domain/tavern.js';
import { talentRecruitRate } from '../server/domain/relation.js';
import { rngFor } from '../server/domain/strategy-rng.js';
import { storeCapOf, ensureCityEcon } from '../server/domain/city-econ.js';

const ROOT = resolve(import.meta.dirname, '..');
const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });
const COST = cfg.basic.general?.draw_general_cost ?? 30;

function makeCtx(state) {
  return { state, cfg, options: {}, push() {}, save() {}, log() {}, schedule() {} };
}

function freshWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureTavern(state, cfg);
  return state;
}

/** realMsPerDay=60000（chapter1.json）：直接拨 clock.accMs 控制日内时辰。 */
function setDayFraction(state, frac) {
  state.clock = state.clock || {};
  state.clock.scale = 1;
  state.clock.accMs = Math.floor(60000 * frac);
}

/** 扫确定性种子：hit=必中 / miss=必失（与招降测试同一套种子纪律）。 */
function scanSeeds(state, cityId, cfgId, favorN = 0) {
  const rate = talentRecruitRate(state, cfg, { cfgId }).rate / 100;
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const tag = `draw:${cityId || 'all'}:${cfgId}:${favorN}`;
  let hit = 0;
  let miss = 0;
  for (let s = 1; s < 40000 && (!hit || !miss); s += 1) {
    const seed = s * 7919;
    const v = rngFor(seed, day, tag).random();
    if (!hit && v < rate) hit = seed;
    if (!miss && v >= rate) miss = seed;
  }
  assert.ok(hit && miss, '应能找到命中与落败两种确定性分支');
  return { hit, miss, rate };
}

test('P13 指名招募：点选谁就招谁，成功才扣金', () => {
  const state = freshWorld();
  const ctx = makeCtx(state);
  const cityId = state.strategy?.playerCity || 1;
  setDayFraction(state, 0.5);                       // 午后窗口（0.40~0.62）
  const nowGuest = todaysGuests(state, undefined, cityId)
    .find((g) => 0.5 >= g.from && 0.5 < g.to);
  assert.ok(nowGuest, '午后窗口应有在店客人');
  const { hit } = scanSeeds(state, cityId, nowGuest.cfgId);
  state.seed = hit;
  const gold0 = state.roleRes.gold;
  const rsp = handleRequest(ctx, req('general.drawGeneral', { drawTimes: 1, cityId, cfgId: nowGuest.cfgId }));
  assert.equal(rsp.code, 0);
  assert.equal(rsp.msg.generals.length, 1, '应招到人');
  assert.equal(rsp.msg.generals[0].cfgId, nowGuest.cfgId, '招到的必须是点选的那一位');
  assert.equal(state.roleRes.gold, gold0 - COST, '成功才扣招募金');
  assert.ok(state.generals.some((g) => g.cfgId === nowGuest.cfgId), '武将应入营');
  const row = state.tavern.people.find((p) => p.cfgId === nowGuest.cfgId);
  assert.ok(row?.recruited, '酒馆名册应标记已入仕');
});

test('P13 武将可以拒绝：失败不扣金、三顾好感 +1、再访更易', () => {
  const state = freshWorld();
  const ctx = makeCtx(state);
  const cityId = state.strategy?.playerCity || 1;
  setDayFraction(state, 0.5);
  const nowGuest = todaysGuests(state, undefined, cityId)
    .find((g) => 0.5 >= g.from && 0.5 < g.to);
  assert.ok(nowGuest);
  const { miss, rate } = scanSeeds(state, cityId, nowGuest.cfgId);
  state.seed = miss;
  const gold0 = state.roleRes.gold;
  const rsp = handleRequest(ctx, req('general.drawGeneral', { drawTimes: 1, cityId, cfgId: nowGuest.cfgId }));
  assert.equal(rsp.code, 0);
  assert.equal(rsp.msg.generals.length, 0, '被拒不应入营');
  assert.equal(rsp.msg.reason, 'refused');
  assert.equal(rsp.msg.name, nowGuest.name);
  assert.equal(rsp.msg.favor, 1, '首次被拒好感 +1');
  assert.equal(rsp.msg.charged, 0, '失败不扣金');
  assert.equal(state.roleRes.gold, gold0, '府库分文未动');
  assert.equal(state.tavern.favor[nowGuest.cfgId], 1, '好感落账');
  const rate2 = talentRecruitRate(state, cfg, { cfgId: nowGuest.cfgId }).rate;
  assert.ok(rate2 > rate * 100, `三顾之后成功率应上升（${rate * 100} → ${rate2}）`);
});

test('P13 时辰语义：已离店 / 未到店 / 今日不在本城，各有可读原因', () => {
  const state = freshWorld();
  const ctx = makeCtx(state);
  const cityId = state.strategy?.playerCity || 1;
  setDayFraction(state, 0.5);                       // 午后：开城客已走、傍晚客未到
  const today = todaysGuests(state, undefined, cityId);
  const passed = today.find((g) => 0.5 >= g.to);
  const upcoming = today.find((g) => 0.5 < g.from);
  assert.ok(passed && upcoming, '应同时有已过时辰与未到时辰的客人');
  assert.equal(handleRequest(ctx, req('general.drawGeneral', { drawTimes: 1, cityId, cfgId: passed.cfgId })).msg.reason,
    'guest_left', '已过时辰应报「已离店」');
  const up = handleRequest(ctx, req('general.drawGeneral', { drawTimes: 1, cityId, cfgId: upcoming.cfgId }));
  assert.equal(up.msg.reason, 'not_arrived', '未到时辰应报「未到店」');
  assert.equal(up.msg.when, upcoming.when, '应告知几点到店');
  assert.equal(handleRequest(ctx, req('general.drawGeneral', { drawTimes: 1, cityId, cfgId: 999999 })).msg.reason,
    'not_today', '不在今日名单应报「今日不在本城」');
});

test('P13 旧口径（不指名）也会被拒：refused 汇总回传且不扣金', () => {
  const state = freshWorld();
  const ctx = makeCtx(state);
  const cityId = state.strategy?.playerCity || 1;
  setDayFraction(state, 0.5);
  const nowGuest = todaysGuests(state, undefined, cityId)
    .find((g) => 0.5 >= g.from && 0.5 < g.to);
  assert.ok(nowGuest);
  const { miss } = scanSeeds(state, cityId, nowGuest.cfgId);
  state.seed = miss;
  const gold0 = state.roleRes.gold;
  const rsp = handleRequest(ctx, req('general.drawGeneral', { drawTimes: 10 }));
  assert.equal(rsp.code, 0);
  assert.deepEqual(rsp.msg.generals, []);
  assert.equal(rsp.msg.reason, 'refused');
  assert.ok(Array.isArray(rsp.msg.refused) && rsp.msg.refused.length >= 1, '应回传被拒名单');
  assert.equal(state.roleRes.gold, gold0, '全员被拒不扣金');
});

test('P13 UI 静态闸：招募必须带 cfgId 指名，拒绝文案就位', () => {
  const src = readFileSync(resolve(ROOT, 'server', 'skills.js'), 'utf8');
  assert.match(src, /general\.drawGeneral', \{ drawTimes: 1, cityId: c\.id, cfgId: g\.cfgId \}/,
    '城内酒馆招募必须指名 cfgId');
  assert.match(src, /general\.drawGeneral', \{ drawTimes: 1, cfgId: g\.cfgId \}/,
    '主城酒馆页招募必须指名 cfgId');
  assert.ok(src.includes('婉拒了主公的延揽'), '拒绝文案必须友好');
  /* ★ 2026-11-17：过时辰等 5 类失败改为服务端拟人 line，前端不得再出现机械播报与英文 reason。 */
  assert.ok(src.includes('m2.line'), '招募失败必须消费服务端拟人台词');
  assert.ok(!src.includes('已离店，明日请早'), '不得再出现「已离店，明日请早」机械文案');
  assert.ok(!src.includes('此刻不在座上'), '不得再把未到/不在本城混为一句');
  assert.ok(!src.includes("'招募未成：' + (reason"), '不得把英文 reason 直接拼进提示');
});

test('P13 人口扩容：无 0 人口城、大城 ≥15 万、上限 100 万、城库随人口', () => {
  const map = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json'), 'utf8'));
  const pops = map.cities.filter((c) => !c.pass).map((c) => Number(c.population) || 0);
  assert.equal(pops.length, 72);
  assert.ok(Math.min(...pops) >= 30000, '最小人口应 ≥3 万（边陲城显式化）');
  assert.ok(Math.max(...pops) >= 150000 && Math.max(...pops) <= 310000, '最大人口应在 15~31 万（×3 档）');

  const state = freshWorld();
  ensureCityEcon(state);
  const vals = Object.values(state.strategy.cityEcon).map((e) => e.pop);
  assert.ok(Math.max(...vals) > 100000, '运行时人口应突破旧 10 万上限');

  assert.equal(storeCapOf({ pop: 20000 }), 20000, '小城城库下限 2 万（与旧值一致）');
  assert.equal(storeCapOf({ pop: 204000 }), 24480, '大城城库随人口放大');
  assert.equal(storeCapOf({ pop: 2000000 }), 240000, '城库上限 24 万（对应人口 200 万）');
});
