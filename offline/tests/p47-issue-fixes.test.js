/**
 * P47：全流程问题清单（25 条）修复回归。
 * 每条对应 D:\WorkBuddy\slg\slgclient-全流程测试与问题清单.md 的编号。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath } from '../server/domain/strategy.js';
import { ensureCityEcon, loyaltyTick } from '../server/domain/city-econ.js';
import { emergencyConscript, failureCheck } from '../server/domain/failstate.js';
import { levyView } from '../server/domain/levy.js';
import { calcDamage, MAX_DAMAGE_BONUS_MULTIPLIER } from '../kernel/rules.js';
import { readFileSync } from 'node:fs';
import {
  panelAction, canAppoint,
} from '../server/domain/panels.js';

const cfg = loadConfig();

function freshState() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const ctx = { pushes: [], push() {}, schedule() {}, save() {}, log() {} };
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  assert.equal(chooseOath(state, cfg, ctx, { lord: cao.id, city: cao.cities[0].id }).ok, true);
  return { state, ctx, cfg };
}

test('#1 忠诚不被敌城民心污染：扬州三座 0 民心敌城不影响我军武将', () => {
  const { state, ctx } = freshState();
  const st = state.strategy;
  const lowEnemy = Object.entries(st.cityEcon)
    .filter(([id, e]) => Number(e.morale) < 30 && st.cities[id]?.owner !== 'player');
  assert.ok(lowEnemy.length >= 1, '前提：开局应存在低民心敌城（修复前会污染全图）');
  for (const e of Object.values(st.cityEcon)) {
    if (st.cities[e.id]?.owner === 'player' || st.cities[String(e.id)]?.owner === 'player') e.morale = 70;
    else if (e.morale < 30) e.morale = 0;
  }
  // 显式按 id 把玩家城民心按住（cityEcon 的 key 是城 id）
  for (const [id, row] of Object.entries(st.cities)) {
    if (row.owner === 'player' && st.cityEcon[id]) st.cityEcon[id].morale = 70;
  }
  const g = state.generals.find((x) => !x.isProtagonist);
  g.loyal = 85;
  state.roleRes.gold = 1e6;
  // 委任在岗：旧口径每旬 +0.6；即使不委任也应回落到 70 而非被敌城拖到 45
  for (let i = 0; i < 40; i += 1) {
    state.clock.day = (i + 1) * 10;
    loyaltyTick(state, cfg, ctx);
  }
  assert.ok(Number(g.loyal) >= 70, `敌城民心不应拖累我军忠诚，实测 ${g.loyal}`);
});

test('#2 紧急征兵有门禁：无城/资源不足/兵源耗尽不再凭空增兵', () => {
  const { state } = freshState();
  const st = state.strategy;
  const cid = Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
  const noCity = emergencyConscript(state, { push() {} }, { cityId: 0, count: 1000 });
  assert.equal(noCity.ok, false, '无城必须拒绝');
  assert.equal(noCity.reason, 'not_own_city');

  state.roleRes.gold = 0;
  const broke = emergencyConscript(state, { push() {} }, { cityId: cid, count: 1000 });
  assert.equal(broke.ok, false, '没金必须拒绝');
  assert.equal(broke.reason, 'no_gold');

  state.roleRes.gold = 1e6;
  const levyHouseBalanceAtStart = levyView(state, cid).houseBalance;
  const before = st.cities[cid].troops;
  const ok = emergencyConscript(state, { push() {} }, { cityId: cid, count: 1000 });
  assert.equal(ok.ok, true, `有城有钱有兵源应成功：${JSON.stringify(ok)}`);
  assert.ok(ok.count <= 1000, '单次硬闸 1000');
  assert.equal(st.cities[cid].troops, before + ok.count);
  const again = emergencyConscript(state, { push() {} }, { cityId: cid, count: 1000 });
  /* 紧急征兵刻意允许「本旬已正常征过兵」时兜底再征，但不能抽空适龄壮丁：
     两次合计不得超过该城 houseBalance（人口台账已落账）。 */
  assert.ok(!again.ok || (ok.count + again.count) <= levyHouseBalanceAtStart,
    `两次强征合计 ${ok.count + again.count} 超过原始壮丁 ${levyHouseBalanceAtStart}`);
});

test('#3 四态失败态统一可展示：破产/兵尽/无将/都城失陷+全境失陷都有出路', () => {
  const { state } = freshState();
  const st = state.strategy;
  const cid = Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
  const other = Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player' && Number(id) !== cid));
  assert.ok(other, '前提：至少两座己方城');

  // 破产 + 兵尽 + 无将 + 都城失陷 同帧存在
  state.roleRes.gold = 0;
  state.roleRes.grain = 0;
  st.cities[cid].troops = 50;
  st.playerCity = 999999; // 都城已不存在 → capitalLost
  for (const a of state.armys) a.generals = [0, 0, 0];

  const fc = failureCheck(state);
  const kinds = fc.active.map((r) => r.kind);
  assert.ok(kinds.includes('bankrupt'), `缺破产态: ${kinds}`);
  assert.ok(kinds.includes('no_army'), `缺兵尽态: ${kinds}`);
  assert.ok(kinds.includes('no_generals'), `缺无将态: ${kinds}`);
  assert.ok(kinds.includes('capital_lost'), `缺都城失陷态: ${kinds}`);
  for (const k of ['disarm', 'sellGrain', 'emergencyConscript', 'relocate']) {
    assert.ok(fc.actions.some((a) => a.kind === k), `缺出路 ${k}`);
  }

  // 全境失陷：所有城改敌属，fatal=true 且给重开引导（UI 层读 fatal）
  for (const id of Object.keys(st.cities)) st.cities[id].owner = 'wei';
  const dead = failureCheck(state);
  assert.equal(dead.fatal, true, '零城必须标记 fatal');
  assert.ok(dead.active.some((r) => r.kind === 'all_cities_lost'));
});

test('#8 战法加成乘区统一钳到 2×，重复叠加不再膨胀到 6.75×', () => {
  assert.equal(MAX_DAMAGE_BONUS_MULTIPLIER, 2);
  const base = 1000;
  const normal = calcDamage(base, 1, 0.5, 1);
  assert.equal(normal.one_plus_bonus, 1.5);
  const stacked = calcDamage(base, 1, 5.75, 1);
  assert.equal(stacked.one_plus_bonus, 2, '5.75 加成只能吃 2×');
  assert.equal(stacked.bonus_total, 5.75, '原始加成仍写入审计字段，不伪造来源');
  assert.equal(stacked.final, 2000);
});

test('#12 手动委任与一键委任同闸：一人一岗、在编不得兼内政', () => {
  const { state, cfg } = freshState();
  const g = state.generals.find((x) => !x.isProtagonist && canAppoint(state, x, null, cfg).ok);
  assert.ok(g, '前提：应有一名可任文职的武将');
  // 手工清掉在编占用，专测岗位重复
  for (const a of state.armys) a.generals = (a.generals || []).map((id) => (id === g.id ? 0 : id));
  const r1 = panelAction(state, cfg, { type: 'appoint', post: 'agri', target: g.id });
  assert.equal(r1.ok, true, `首次委任应成功：${JSON.stringify(r1)}`);
  const r2 = panelAction(state, cfg, { type: 'appoint', post: 'commerce', target: g.id });
  assert.equal(r2.ok, false, '第二岗必须拒绝');
  assert.ok(!state.interior.posts.commerce, '第二岗不应被写入');
  assert.equal(canAppoint(state, g, 'commerce', cfg).ok, false);
});

test('#13 战报红点回写领域层：markReportsSeen 真的发 war.read', () => {
  const ui = readFileSync('server/panels-ui.js', 'utf8');
  const i = ui.indexOf('function markReportsSeen');
  const body = ui.slice(i, i + 900);
  assert.ok(body.includes("__slgSend('war.read'"), '点开战报必须发 war.read，不能只藏红点');
});

test('#25 太守派单文案按旬，不承诺精确完工日', () => {
  const src = readFileSync('server/domain/governor.js', 'utf8');
  assert.ok(src.includes('自动续办'), '缺金文案要说明自动续办，不静默跳过');
  assert.doesNotMatch(src, /预计第 \$\{endDay\} 日完工/, '不写死精确到日的完工承诺');
});
