/**
 * P72 内政三事回归闸：
 *  ① 民心/治安悬浮说明（术语文案 + 内政页显式锚点）；
 *  ② 太守只任本城官员（领域硬闸 + 下拉默认非主公）；
 *  ③ 兵源恢复：阵亡复员归农 + 人口低位保底，杜绝全灭后永久「各户壮丁已尽」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath } from '../server/domain/strategy.js';
import { ensureCityEcon, popTick } from '../server/domain/city-econ.js';
import {
  MIN_CITY_POP, commitLevy, levyView, releaseFallenLevy,
} from '../server/domain/levy.js';
import { routeWounded, splitCasualties } from '../server/domain/casualties.js';
import { governorSet, governorCandidates } from '../server/domain/governor.js';

const cfg = loadConfig();
const ROOT = new URL('../', import.meta.url);
const ctx = () => ({ push() {} });

function fresh() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  assert.equal(chooseOath(s, cfg, ctx(), { lord: lords[0].id, city: lords[0].cities[0].id }).ok, true);
  const cid = Number(Object.keys(s.strategy.cities).find((id) => s.strategy.cities[id].owner === 'player'));
  return { s, cid, e: s.strategy.cityEcon[cid] };
}

test('P72-A 阵亡复员归农：名额按出发城退回，负伤不释放，历史累计不回退', () => {
  const { s, cid, e } = fresh();
  e.pop = 20000; e.levied = 500; e.levyTotal = 500; e.lastLevyTurn = -1;
  const total0 = e.levyTotal;

  /* 只有负伤：兵仍在役，名额不能释放 */
  routeWounded(s, { wounded: [120, 0, 0], killed: [0, 0, 0], fromCityId: cid, mapCities: [] });
  assert.equal(e.levied, 500, '负伤者退回城仍算在役');

  /* 有阵亡：即便全军尽殁（wounded 全 0）也必须释放——这正是用户报告的死局 */
  const cases = splitCasualties({ lossBySlot: [600, 0, 0] });
  assert.ok(cases.totalKilled > 0);
  assert.equal(cases.totalWounded + cases.totalKilled, 600);
  routeWounded(s, { wounded: cases.wounded, killed: cases.killed, fromCityId: cid, mapCities: [] });
  assert.equal(e.levied, 500 - cases.totalKilled, '阵亡名额回到本城');
  assert.equal(e.levyTotal, total0, '历史累计只增不回退');

  /* 超额释放只能夹到 0，不产生负数 */
  const beforeCap = e.levied;
  const cap = releaseFallenLevy(s, cid, 99999);
  assert.equal(cap.released, beforeCap);
  assert.equal(e.levied, 0);
});

test('P72-B 全灭后能恢复：低位人口不再被 round 抹平，保底户数即可征', () => {
  const { s, cid, e } = fresh();
  e.pop = 5; e.levied = 240; e.lastLevyTurn = -1;
  const cases = splitCasualties({ lossBySlot: [400, 0, 0] });
  routeWounded(s, { wounded: cases.wounded, killed: cases.killed, fromCityId: cid, mapCities: [] });
  assert.equal(e.levied, 0);
  assert.equal(levyView(s, cid).reason, 'levy_exhausted', 'pop=5 时仍无丁，但必须能长起来');

  const before = e.pop;
  popTick(s, ctx());
  assert.ok(e.pop > before, '低位人口每旬至少 +1，禁止 round 抹平');

  /* 长到保底户数（城市自己会涨，不需要玩家干预） */
  for (let i = 0; i < 60 && levyView(s, cid).quota <= 0; i += 1) popTick(s, ctx());
  e.lastLevyTurn = -1;
  const v = levyView(s, cid);
  assert.ok(e.pop > 5, '人口必须已从 5 口长起来');
  assert.ok(v.quota >= 1, `恢复后本旬可征应 ≥1，实际 ${v.quota}`);
  assert.notEqual(v.reason, 'levy_exhausted');
});

test('P72-G 死档解套：在役户超出现有适龄户时归一化，人口涨回来即可再征', () => {
  const { s, cid, e } = fresh();
  e.pop = 5; e.levied = 1200; e.levyTotal = 1200; e.lastLevyTurn = -1;
  const v = levyView(s, cid);
  assert.equal(v.levied, 0, '历史死档的超额在役户必须归一化');
  assert.equal(e.levyTotal, 1200, '历史累计不回退');
  for (let i = 0; i < 60 && levyView(s, cid).quota <= 0; i += 1) popTick(s, ctx());
  e.lastLevyTurn = -1;
  assert.ok(levyView(s, cid).quota >= 1, '无需再打一仗，人口增长即可解套');
});

test('P72-C 征兵人口下限：抽空后留 8 户，任何季节仍有可征丁', () => {
  const { s, cid, e } = fresh();
  e.pop = 100; e.levied = 0; e.lastLevyTurn = -1;
  const r = commitLevy(s, cid, 1000);
  assert.equal(r.popAfter, MIN_CITY_POP, '征兵不得把城压到 1 户');
  /* 这里只验人口保底：名额已全部在役，清掉台账再看户数是否撑得起一丁 */
  e.levied = 0; e.lastLevyTurn = -1;
  assert.ok(levyView(s, cid).quota >= 1, '保底户数下旬可征至少 1');
});

test('P72-D 太守只任本城：领域硬拒绝，他城武将不出现在候选', () => {
  const { s, cid } = fresh();
  const other = s.generals.find((g) => !g.isProtagonist);
  assert.ok(other && Number(other.cityId) !== cid, '前提：候选在他城');
  const r = governorSet(s, cfg, ctx(), { cityId: cid, officerId: other.id });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_local_city');
  assert.ok(!governorCandidates(s, cfg, cid).some((g) => g.id === other.id), '候选只含本城官员');
  other.cityId = cid;
  assert.ok(governorCandidates(s, cfg, cid).some((g) => g.id === other.id), '调城后可任');
  assert.equal(governorSet(s, cfg, ctx(), { cityId: cid, officerId: other.id }).ok, true);
});

test('P72-E 民心/治安说明：术语含作用与提升方式，内政页有显式锚点', () => {
  const terms = JSON.parse(readFileSync(new URL('conf/interaction/terms.json', ROOT), 'utf8'));
  assert.equal(terms.terms.length, 135, '不新增词条，沿用既有术语框');
  const minxin = terms.terms.find((t) => t.id === 'minxin');
  const zhian = terms.terms.find((t) => t.id === 'zhian');
  assert.match(minxin.简述, /×0\.85~1\.10/, '民心作用：粮金产量');
  assert.match(minxin.简述, /人口每旬/, '民心作用：人口增长');
  assert.match(minxin.简述, /赈灾 \+6/, '民心提升方式');
  assert.match(minxin.简述, /劝课生息 \+2/, '民心提升方式');
  assert.match(zhian.简述, /×0\.7/, '治安作用：灾害概率');
  assert.match(zhian.简述, /修城 \+2/, '治安提升方式');
  assert.match(zhian.简述, /赈灾 \+3/, '治安提升方式');
  assert.doesNotMatch(zhian.简述, /招抚/, '旧任务口径「招抚 +5」已失效，不得写进说明');

  const src = readFileSync(new URL('server/skills.js', ROOT), 'utf8');
  assert.match(src, /kvTerm\('民心'/, '治理卡民心标签挂锚点');
  assert.match(src, /kvTerm\('治安'/, '治理卡治安标签挂锚点');
  assert.match(src, /pill\('民心'[^)]*'minxin'\)/, '城池头民心 pill 挂锚点');
});

test('P72-F 太守下拉默认：现任优先、无现任选非主公，空态禁用', () => {
  const src = readFileSync(new URL('server/skills.js', ROOT), 'utf8');
  assert.match(src, /Number\(gv\.officerId\)/, '默认读现任太守');
  assert.match(src, /gvCands\.find\(function \(g\) \{ return !g\.isProtagonist; \}\)/, '无现任时默认非主公');
  assert.match(src, /option value="' \+ g\.id \+ '"' \+ on/, 'option 带 selected 标记');
  assert.match(src, /btnAppoint\.disabled = true/, '本城无官员时任命按钮禁用');
  assert.doesNotMatch(src, /value="0">请选择/, '不得插入空选项——否则鼠标试玩会误触撤任');
});
