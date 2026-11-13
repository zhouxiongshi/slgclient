/**
 * M2-5 张力守恒四条（GDD §6.7.1）。
 *
 * 锁四件事：
 *  1. 推演只对「已知量」精确：情报 0/1 档给区间线，精确档不给；文案声明「推演不产生情报」；
 *  2. 敌将变招：counterVariantFor 同 (seed, arriveDay) 恒同预案、三预案齐备、
 *     推演下发「若敌方变招则…」两条对照线；
 *  3. 确认即锁：strategyAttack 落 march 行 lockedSeed，且等于同参 battleSeedFor
 *     （推演与正式逐位一致由 p10-preview-consistency 锁，这里锁「锁定字段存在」）；
 *  4. 变招真实影响战局：不同预案的推演线折损不同（不是装饰字段）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyAttack, previewAssault,
  counterVariantFor, COUNTER_VARIANTS, strategyViewState,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();

function battlefield() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  const st = state.strategy;
  const owned = Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player').map(Number);
  const from = owned[0];
  const view = strategyViewState(state, cfg);
  const row = view.cities.find((c) => Number(c.id) === from);
  const target = (row?.marchRoutes || []).map((rt) => Number(rt.id))
    .find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  const army = (state.armys || [])[0];
  army.cityId = from;
  army.marchId = 0;
  army.soldiers = [1600, 800, 0];
  state.clock.day = 5;
  return { state, st, army, from, target };
}

test('M2-5·变招：同 (seed, arriveDay) 恒同预案；三预案齐备', () => {
  const { state, target } = battlefield();
  const v1 = counterVariantFor(state, target, 12);
  const v2 = counterVariantFor(state, target, 12);
  assert.equal(v1.id, v2.id, '同一抵达日恒同预案（确定性可回放）');
  assert.equal(COUNTER_VARIANTS.length, 3);
  const muls = new Set(COUNTER_VARIANTS.map((v) => v.defMul));
  assert.ok(muls.size >= 2, '预案折算不应全相同（变招要有真实差异）');
  // 40 天窗口内至少出现两种预案（rng 均匀分布，40 样本全同概率 (1/3)^39 ≈ 0）
  const seen = new Set();
  for (let d = 1; d <= 40; d++) seen.add(counterVariantFor(state, target, d).id);
  assert.ok(seen.size >= 2, `40 天窗口应出现 ≥2 种预案，实际 ${seen.size}`);
});

test('M2-5·情报区间：未侦察给区间线，精确档不给；推演不产生情报', () => {
  const { state, st, army, from, target } = battlefield();
  // 情报 0：区间线应有两条（最坏/最好），文案声明未侦察
  const p0 = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(p0.ok, true);
  assert.equal(p0.intelTier, 0);
  assert.equal(p0.spreadLines.length, 2, '未侦察应输出最坏/最好两条线');
  assert.ok(p0.intelNote.includes('未侦察'));
  // 区间线应真的不同（不是装饰）：最坏与最好的折损/胜负至少一项不同
  const [worst, best] = p0.spreadLines;
  assert.ok(worst.aLoss !== best.aLoss || worst.win !== best.win, '区间两条线必须可区分');
  // 推演不得改情报档（#4 推演不产生情报）
  assert.equal(st.intel?.[target] ?? 0, 0, '推演不得写 st.intel');
  // 侦察到精确档：不再给区间
  if (!st.intel) st.intel = {};
  st.intel[target] = 2;
  const p2 = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(p2.intelTier, 2);
  assert.equal(p2.spreadLines.length, 0, '精确档不给区间（已知量才精确）');
  assert.ok(p2.intelNote.includes('精确'));
});

test('M2-5·变招对照线：推演下发「若敌方变招则…」，且预案真实影响战局', () => {
  const { state, army, from, target } = battlefield();
  const p = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(p.ok, true);
  assert.ok(p.variant && p.variant.name, '推演应标明当前敌方预案');
  assert.equal(p.variantLines.length, 2, '应给出另外两套预案的对照线');
  /* 变招真实影响战局：对照线必须与主线在「上场守军」上就不同。
     口径说明：只比折损/歼敌不够稳——攻方被打光时，守军多 12% 也未必改变
     双方伤亡（伤害由攻方输出决定），三条线会出现完全相同的数字。
     dStart（该预案真正上场的守军总数）才是变招进入计算链的直接证据。 */
  const differs = p.variantLines.some((v) => v.dStart !== p.dStart
    || v.aLoss !== p.aLoss || v.dLoss !== p.dLoss || v.code !== p.code);
  assert.ok(differs, '变招对照线必须与主线有数值差异（不是装饰字段）');
  assert.ok(p.dStart > 0 && p.dStart <= p.dTotal, '主线应给出实际参战守军，且不超过守军总数');
});

test('M2-5·确认即锁：出征落 lockedSeed 且与推演种子同参一致', () => {
  const { state, st, army, from, target } = battlefield();
  const p = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(p.ok, true);
  const atk = strategyAttack(state, cfg, { push() {} }, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(atk.ok, true);
  const mm = st.marches[0];
  assert.ok(mm.lockedSeed, 'march 行应有 lockedSeed（确认即锁的落点）');
  assert.equal(mm.lockedSeed, p.seed, '今天出发的推演种子 = 锁定种子（推演可预知锁定结果）');
});
