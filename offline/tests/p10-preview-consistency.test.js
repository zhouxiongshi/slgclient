/**
 * M2-1（GDD §6.7 约束 4 / 验收 A1）：100 组参数下预演与正式结算 hash 一致。
 *
 * GDD 原文：「测试里跑 100 组随机编队，hash(预演) === hash(正式)，不通过则禁止发版」。
 * 实现口径（工程红线：测试也禁 Math.random，用确定性参数扫描代替随机编队）：
 *   - 到达日 ×10（种子源）、出兵比例 ×10、兵力结构 ×5 → 100 组互不相同；
 *   - 每组走完整正式路径（strategyAttack → strategyResolveMarches → warReports[0]），
 *     与 previewAssault 逐位对比：结果 / 我军折损 / 歼敌 / 回合数；
 *   - 每组之间用快照恢复场景（守军/队伍/战报），保证组间互不污染。
 * 另附性能断言：单次推演 ≤50ms（GDD §6.7 约束 3）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, marchableFrom,
  previewAssault, strategyAttack, strategyResolveMarches,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();

function battlefield() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  const st = state.strategy;
  const army = state.armys.find((a) => !a.marchId && (a.soldiers || []).some((v) => v > 0));
  assert.ok(army, '举义后应有一支可派队伍');
  const target = marchableFrom(army.cityId).find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  assert.ok(target, '出发城应有可攻邻城');
  return { state, st, army, from: army.cityId, target };
}

test('A1 · 100 组参数：预演与正式结算逐位一致', () => {
  const { state, st, army, from, target } = battlefield();
  const ctx = { push() {} };
  const snapArmy = JSON.stringify(army);
  const snapCity = JSON.stringify(st.cities[target]);
  const snapEcon = JSON.stringify(st.cityEcon);
  let checked = 0;

  for (let i = 0; i < 100; i += 1) {
    /* 组间重置：守军/队伍/队列/战报/城库回到快照（种子只依赖 队伍/坐标/到达日，不受影响） */
    Object.assign(army, JSON.parse(snapArmy));
    st.cities[target] = JSON.parse(snapCity);
    st.cityEcon = JSON.parse(snapEcon);   /* 出征扣行军粮，不恢复会 no_grain */
    st.marches = [];
    state.warReports = [];
    state.battleLog = [];

    const frac = 0.5 + (i % 10) * 0.05;                       // 0.50 ~ 0.95
    const day = 1 + (i % 40);                                 // 40 个不同到达日 → 40 个种子
    army.soldiers = [800 + (i % 5) * 150, 400 + (i % 4) * 120, (i % 3) * 200];
    state.clock.day = day;

    const p = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac });
    assert.equal(p.ok, true, `#${i} 预演失败 ${JSON.stringify(p)}`);

    const atk = strategyAttack(state, cfg, ctx, { cityId: target, fromCityId: from, armyId: army.id, frac });
    assert.equal(atk.ok, true, `#${i} 出征失败 ${JSON.stringify(atk)}`);
    state.clock.day = atk.arriveDay;
    strategyResolveMarches(state, cfg, ctx);

    const report = (state.warReports || [])[0];
    assert.ok(report, `#${i} 应产生正式战报`);
    assert.equal(report.result, p.code, `#${i} 胜负不一致：预演 ${p.code} vs 正式 ${report.result}`);
    assert.equal(report.analysis?.aLoss, p.aLoss, `#${i} 我军折损不一致`);
    assert.equal(report.analysis?.dLoss, p.dLoss, `#${i} 歼敌不一致`);
    assert.equal((state.battleLog || [])[0]?.rounds, p.rounds, `#${i} 回合数不一致`);
    checked += 1;
  }
  assert.equal(checked, 100);
});

test('性能 · 单次推演 ≤50ms（GDD §6.7 约束 3，3v3/8 回合）', () => {
  /* ★ 修 flaky：原来只测一次，check-release 一边跑全量单测、一边校验 Electron
     报告时，偶发 GC / CPU 抢占会把这一枪打出 >50ms 的假红，整条发布闸跟着失败。
     GDD 约束的是「稳态单次推演」，所以 5 次独立采样取中位数；每次都用新战场
     并各自预热，既避免模块懒加载，也避免任何状态累积。真退化时中位数照样超标。 */
  const samples = [];
  let p;
  for (let i = 0; i < 5; i += 1) {
    const bf = battlefield();
    bf.army.soldiers = [1200, 500, 0];
    const opts = { cityId: bf.target, fromCityId: bf.from, armyId: bf.army.id, frac: 1 };
    previewAssault(bf.state, cfg, opts); // 预热：首跑含懒加载，不计入
    const t0 = process.hrtime.bigint();
    p = previewAssault(bf.state, cfg, opts);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert.equal(p.ok, true);
  samples.sort((a, b) => a - b);
  const median = samples[2];
  const worst = samples[samples.length - 1];
  assert.ok(median <= 50,
    `单次推演中位数 ${median.toFixed(1)}ms 超预算（≤50ms；5 次采样最差 ${worst.toFixed(1)}ms）`);
});
