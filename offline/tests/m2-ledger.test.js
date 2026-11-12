/**
 * M2-2 双账本切断写入（GDD §5.2 M2 第 2 步）。
 *
 * 口径：田赋粮按城写入 cityEcon.store（粮留城，满仓 20000 截断），金全额上缴国库；
 * resources[faction].grain 降级为**只读汇总**（= 己方城库之和）；
 * NPC 支出只准走 spendFactionGrain（从城库扣），玩家侧 roleRes 属 M3 迁移范围。
 *
 * 这层锁的是「切断写入」本身：全国粮账不再有独立写入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath,
  accrueFactionGrain, spendFactionGrain, creditFactionGrain, refreshGrainSummary,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();
const CAP = 20000;

/** 举义后的世界：玩家有城有都城，诸侯各自有地盘。 */
function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  return { state, st: state.strategy };
}

/** 任找一个拥有城池的诸侯（非玩家、非汉廷）。 */
function findFactionWithCity(st) {
  const ids = new Set(Object.values(st.cities)
    .map((v) => v.owner)
    .filter((o) => o && o !== 'player' && o !== 'han'));
  return [...ids][0] || '';
}

function sumStores(st, fid) {
  let n = 0;
  for (const [id, row] of Object.entries(st.cities)) {
    if (row.owner !== fid) continue;
    n += Math.max(0, Math.floor(Number(st.cityEcon?.[id]?.store) || 0));
  }
  return n;
}

function ownCityIds(st, fid) {
  return Object.keys(st.cities)
    .filter((id) => st.cities[id].owner === fid)
    .map(Number);
}

test('双账本·田赋：粮按城写入城库、金上缴国库、全国账变成只读汇总', () => {
  const { state, st } = oathWorld();
  const fid = findFactionWithCity(st);
  assert.ok(fid, '应有诸侯拥有城池');
  const res = st.resources[fid] || (st.resources[fid] = { gold: 8000, grain: 0 });
  res.grain = 0;                       // 显式清零，证明田赋不再往全国账写粮
  const beforeStores = sumStores(st, fid);
  const beforeGold = res.gold ?? 0;

  const tax = accrueFactionGrain(state, fid);

  assert.ok(tax.grain > 0, '田赋应有粮');
  assert.ok(tax.gold > 0, '田赋应有金');
  assert.equal(res.grain, sumStores(st, fid), '全国账 = 己方城库之和（只读汇总）');
  assert.equal(res.grain, refreshGrainSummary(state, fid), '汇总可复算');
  assert.ok(res.gold > beforeGold, '金全额上缴国库');
  assert.equal(sumStores(st, fid) - beforeStores, tax.grain, '粮确实进了城库（初始 2000/城，远未满仓）');
});

test('双账本·支出：spendFactionGrain 从城库扣并回写汇总，缺口如实返回', () => {
  const { state, st } = oathWorld();
  const fid = findFactionWithCity(st);
  accrueFactionGrain(state, fid);                 // 先发田赋，城库有粮
  const res = st.resources[fid];
  const home = ownCityIds(st, fid)[0];
  const before = res.grain;
  assert.ok(before > 0, '汇总应有粮');

  const spend = spendFactionGrain(state, fid, 500, home);
  assert.equal(spend.ok, true, '城库足够时应扣足');
  assert.equal(res.grain, before - 500, '只读汇总随支出同步');
  const spentTotal = spend.spent.reduce((n, s) => n + s.grain, 0);
  assert.equal(spentTotal, 500, '城库实扣 500');
  assert.ok(
    spend.spent[0].cityId === home || spend.spent.length > 1,
    '优先扣指定城；指定城不够则跨城补足',
  );

  const total = sumStores(st, fid);
  const fail = spendFactionGrain(state, fid, total + 9999, 0);
  assert.equal(fail.ok, false, '不够就是不够');
  assert.equal(fail.shortage, 9999, '缺口如实返回');
  assert.equal(res.grain, 0, '扣空后汇总归零');
});

test('双账本·入账：creditFactionGrain 写城库并刷新汇总（满仓截断）', () => {
  const { state, st } = oathWorld();
  const fid = findFactionWithCity(st);
  const cid = ownCityIds(st, fid)[0];
  const e = st.cityEcon[cid];
  e.store = CAP - 100;
  const beforeSum = sumStores(st, fid);
  const n = creditFactionGrain(state, fid, 500, cid);
  assert.equal(n, 500, '应收照记');
  assert.equal(e.store, CAP, '满仓截断在城库');
  assert.equal(st.resources[fid].grain, beforeSum + 100, '只收进 100，汇总如实跟随');
});
