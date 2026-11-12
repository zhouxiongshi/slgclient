/**
 * 验收 #10：战前推演可无限回退，且只读预演结果与正式结算一致。
 *
 * 三条硬断言：
 *  1. 预演不改存档（深拷贝跑），可以反复点；
 *  2. 预演的胜负 / 折损 / 歼敌 / 回合数与「真的出兵并等到抵达」完全一致；
 *  3. 换队伍、换出兵比例会得出不同预演 —— 说明它不是把结果写死的假卡片。
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

test('预演是只读的：连点十次，存档逐字节不变', () => {
  const { state, army, from, target } = battlefield();
  const before = JSON.stringify(state);
  for (let i = 0; i < 10; i += 1) {
    const p = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
    assert.equal(p.ok, true, JSON.stringify(p));
  }
  assert.equal(JSON.stringify(state), before, '预演不得改动存档（队伍/战报/资源/日历都要原样）');
});

test('预演 == 正式结算：胜负、折损、歼敌、回合数逐项一致', () => {
  const { state, st, army, from, target } = battlefield();
  const p = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(p.ok, true, JSON.stringify(p));

  // 真的出兵并推到抵达日
  const atk = strategyAttack(state, cfg, { push() {} }, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(atk.ok, true, JSON.stringify(atk));
  assert.equal(atk.marchId > 0, true);
  state.clock.day = atk.arriveDay;                 // 抵达当日结算
  strategyResolveMarches(state, cfg, { push() {} });

  const report = (state.warReports || [])[0];
  assert.ok(report, '应产生一份战报');
  const code = report.result;
  assert.equal(code, p.code, `预演结果 ${p.code} 应与实际 ${code} 一致`);
  assert.equal(report.analysis?.win, p.win, '胜负判定一致');
  assert.equal(p.aLoss, report.analysis?.aLoss, '我军折损一致');
  assert.equal(p.dLoss, report.analysis?.dLoss, '歼敌一致');
  assert.equal(p.rounds, report.rounds, '回合数一致');
  assert.equal(st.cities[target].owner, p.win ? 'player' : st.cities[target].owner, '胜负应与城池归属变化对应');
});

test('预演会随兵力比例变化（不是写死的假卡片）', () => {
  const { state, army, from, target } = battlefield();
  const full = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  const small = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 0.25 });
  assert.equal(full.ok, true);
  assert.equal(small.ok, true);
  assert.ok(small.aTotal < full.aTotal, '出兵少，投入兵力就小');
  assert.ok(small.aLoss !== full.aLoss || small.code !== full.code, '少派兵应打出不同结果');
});

test('预演带归因与情报边界：给出为什么、并说明预演失效条件', () => {
  const { state, army, from, target } = battlefield();
  const p = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.ok(p.attribution && p.attribution.length > 10, '必须有结构化归因');
  assert.ok(/折损|相持|可下|难下/.test(p.attribution));
  assert.ok(p.caveat && /守军|增援/.test(p.caveat), '必须写明预演的失效条件');
  assert.equal(typeof p.arriveDay, 'number');
  assert.ok(p.arriveDay >= p.today);
  assert.ok(p.days >= 1);
  assert.ok(p.km > 0);
});

test('预演拒绝口径：己方城 / 无路 / 无兵 / 没这座城', () => {
  const { state, st, army, from, target } = battlefield();
  assert.equal(previewAssault(state, cfg, { cityId: st.playerCity, fromCityId: from }).reason, 'own_city');
  assert.equal(previewAssault(state, cfg, { cityId: 999999, fromCityId: from }).reason, 'no_city');
  const farAway = Object.keys(st.cities).map(Number).find((id) => !marchableFrom(from).includes(id) && st.cities[id].owner !== 'player');
  if (farAway) {
    assert.equal(previewAssault(state, cfg, { cityId: farAway, fromCityId: from }).reason, 'no_road');
  }
  const empty = state.armys.find((a) => (a.soldiers || []).every((v) => !(v > 0)));
  if (empty) {
    empty.cityId = from;
    assert.equal(previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: empty.id }).reason,
      'no_troops', '零兵力队伍应被拒绝');
  }
  void army;
});

test('路由不变量：preview 动作已挂到 HTTP 动作口，且明确跳过 save()', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /previewAssault,/, 'index.js 必须从 domain/strategy.js 导入 previewAssault');
  assert.match(src, /act === 'preview'/, 'index.js 必须有 preview 分支');
  assert.match(src, /if \(result\.ok && act !== 'preview'\) save\(\);/, 'preview 必须跳过落盘，否则反复推演会反复写存档');
});
