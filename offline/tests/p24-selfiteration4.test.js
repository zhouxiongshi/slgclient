/**
 * 2026-11-20 自迭代第四轮回归锁：来投率封顶 / 招降重复武将 / 春征秋收惩罚落账。
 *
 * 三条都由长局探针或定向探针实测反推，非想象边界：
 *   · 占 5/24 城、放归多少俘虏，慕名来投率都钉死 8.71%——FAME_DEFECT_CAP 误截断版图名望；
 *   · 招降俘虏不标记酒馆 recruited，次日敌将仍在店可被二次登庸，招出重复武将；
 *   · 「春征超 50% → 秋收田赋 −15%」只弹 toast、从不落账，秋天田赋一分不少。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath, recruitCaptive } from '../server/domain/strategy.js';
import { ensureCityEcon, cityYield } from '../server/domain/city-econ.js';
import { ensureTavern } from '../server/domain/tavern.js';
import { defectRate, defectRateWithFame, FAME_DEFECT_CAP } from '../server/domain/captive-reputation.js';
import { farmConflictOf, levyView, seasonOf } from '../server/domain/levy.js';

const cfg = loadConfig();

function fresh() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state); ensureCityEcon(state); ensureTavern(state, cfg);
  const ctx = { state, cfg, pushes: [], options: {}, push() {}, schedule() {}, save() {}, log() {} };
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  assert.equal(chooseOath(state, cfg, ctx, { lord: cao.id, city: cao.cities[0].id }).ok, true);
  return { state, ctx };
}

/* ---------------------------------------------------------------- 来投率 */
test('版图/实力名望不封顶：扩张与放归名望对来投率都有正反馈', () => {
  const base = (c, g) => c * 8 + Math.min(10, g * 2) + 0.75;
  const r1 = defectRate(0.03, base(1, 4), 0);
  const r5 = defectRate(0.03, base(5, 10), 0);
  const r24 = defectRate(0.03, base(24, 40), 0);
  assert.ok(r1 < r5 && r5 < r24, `扩张必须抬升来投率：${r1} < ${r5} < ${r24}`);
  assert.ok(r24 <= 0.45, '整体仍有 45% 上限');
  const noFame = defectRate(0.03, base(5, 10), 0);
  const someFame = defectRate(0.03, base(5, 10), 40);
  const maxFame = defectRate(0.03, base(5, 10), 10000);
  assert.ok(someFame > noFame, '放归名望仍要加分');
  assert.equal(maxFame, someFame, '放归名望仍封顶 FAME_DEFECT_CAP，防止刷仁德拉满');
});

test('旧 defectRateWithFame 签名保持兼容（仅放归名望）', () => {
  assert.ok(defectRateWithFame(0.03, 0) < defectRateWithFame(0.03, 20));
  assert.equal(defectRateWithFame(0.03, 10000), defectRateWithFame(0.03, FAME_DEFECT_CAP));
});

/* ---------------------------------------------------------------- 招降去重 */
test('招降俘虏同步标记酒馆 recruited，不能二次登庸出重复武将', () => {
  const { state, ctx } = fresh();
  const owned = new Set(state.generals.map((g) => Number(g.cfgId)));
  const p = (state.tavern.people || []).find(
    (x) => !x.recruited && !owned.has(Number(x.cfgId)) && cfg.generalByCfg.get(Number(x.cfgId)),
  );
  assert.ok(p, '应有一个在野武将可被俘');
  const capCfgId = Number(p.cfgId);
  state.captives = [{ cfgId: capCfgId, name: cfg.generalByCfg.get(capCfgId).name, days: 12, loyal: 50, day: 1 }];
  state.roleRes.gold = 100000;

  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    ok = recruitCaptive(state, cfg, ctx, { idx: 0 }).ok;
    if (!ok) state.captives[0].days += 5;
  }
  assert.equal(ok, true, '招降应成功');
  assert.equal(state.generals.filter((g) => Number(g.cfgId) === capCfgId).length, 1);
  const p2 = state.tavern.people.find((x) => Number(x.cfgId) === capCfgId);
  assert.equal(p2.recruited, true, '招降后必须在酒馆名册标记为已招募');
  assert.equal(state.tavern.people.filter((x) => !x.recruited && Number(x.cfgId) === capCfgId).length,
    0, '不得再出现在可登庸池');
});

/* ---------------------------------------------------------------- 春征秋收 */
test('春征超 50%：当年秋季粮产 −15%，春季与跨年不减产', () => {
  const { state } = fresh();
  const cid = Number(state.strategy.playerCity)
    || Number(Object.keys(state.strategy.cities).find((k) => state.strategy.cities[k].owner === 'player'));
  state.clock.day = 1;
  const lv = levyView(state, cid, { rate: cfg.basic?.conscriptRate ?? 0.06 });
  const conflict = farmConflictOf(state, cid, Math.ceil(lv.seasonalCap * 0.8),
    { rate: cfg.basic?.conscriptRate ?? 0.06 });
  assert.ok(conflict && conflict.penaltyPct === 15);

  // 落账（与 handlers 春征处一致）
  const year = Math.floor((state.clock.day - 1) / 360);
  const e = state.strategy.cityEcon[cid];
  e.farmPenaltyYear = year;
  e.farmPenaltyPct = conflict.penaltyPct;

  state.clock.day = 200; // 秋
  assert.equal(seasonOf(state), '秋');
  const withPenalty = cityYield(state, cid).grain;
  const saved = e.farmPenaltyYear;
  e.farmPenaltyYear = -999; // 跨年失效
  const noPenalty = cityYield(state, cid).grain;
  e.farmPenaltyYear = saved;
  assert.ok(withPenalty < noPenalty, '秋季必须真减产');
  assert.ok(Math.abs(withPenalty / noPenalty - 0.85) < 0.02, '减产幅度约 15%');

  state.clock.day = 1; // 春
  const springWith = cityYield(state, cid).grain;
  e.farmPenaltyYear = -999;
  const springNo = cityYield(state, cid).grain;
  e.farmPenaltyYear = saved;
  assert.equal(springWith, springNo, '春季不减产');
});

test('春征未超 50% 不产生秋收惩罚', () => {
  const { state } = fresh();
  const cid = Number(state.strategy.playerCity)
    || Number(Object.keys(state.strategy.cities).find((k) => state.strategy.cities[k].owner === 'player'));
  state.clock.day = 1;
  const lv = levyView(state, cid, { rate: cfg.basic?.conscriptRate ?? 0.06 });
  assert.equal(farmConflictOf(state, cid, Math.floor(lv.seasonalCap * 0.4),
    { rate: cfg.basic?.conscriptRate ?? 0.06 }), null);
});
