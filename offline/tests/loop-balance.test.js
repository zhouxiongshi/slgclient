/**
 * 闭环收口：超时不占城、槽位上限、行军粮按日、有城后的金产与俸饷、旬粮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { judgeBattle, ROUT_RATIO } from '../server/battle.js';
import { strategyFormup, SLOT_CAP, marchGrainCost, ensureStrategy } from '../server/domain/strategy.js';
import { applyDays } from '../server/domain/economy.js';
import { playerGoldYield, playerGrainYield, ensureCityEcon } from '../server/domain/city-econ.js';
import { panelState } from '../server/domain/panels.js';
import { chapterRules } from '../server/domain/campaign.js';
import { grainForTurn } from '../server/domain/supply.js';

const cfg = loadConfig();

test('超时未决：双方都还在一成以上时，兵力多的一方不占城', () => {
  assert.equal(ROUT_RATIO, 0.1);
  assert.equal(judgeBattle({ winner: null, aStart: 1950, dStart: 1900, aLeft: 1400, dLeft: 1200 }), 1);
  assert.equal(judgeBattle({ winner: null, aStart: 6000, dStart: 1900, aLeft: 5200, dLeft: 180 }), 2);
  assert.equal(judgeBattle({ winner: null, aStart: 800, dStart: 1900, aLeft: 70, dLeft: 1500 }), 0);
  assert.equal(judgeBattle({ winner: 1, aStart: 100, dStart: 100, aLeft: 100, dLeft: 100 }), 2);
});

test('编队单槽不得超过 5000，多余的兵退回驻城', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  const army = state.armys[0];
  const homeId = state.strategy.playerCity;
  army.cityId = homeId;
  army.soldiers = [8000, 0, 0];
  /* ★ P54：编队同城判定看 g.cityId；该用例只测带兵上限，先把 fixture 的驻城对齐。 */
  if (state.generals[0]) state.generals[0].cityId = homeId;
  army.generals = [state.generals[0]?.id || 0, 0, 0];
  delete army.marchId;
  const before = Number(state.strategy.cities[homeId].troops) || 0;
  const bad = strategyFormup(state, cfg, { push() {} }, {
    armyId: army.id, generals: army.generals, soldiers: [5001, 0, 0],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'over_cap');
  assert.equal(bad.cap, SLOT_CAP);
  const ok = strategyFormup(state, cfg, { push() {} }, {
    armyId: army.id, generals: army.generals, soldiers: [5000, 0, 0],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.returnedToCity, 3000);
  assert.equal(state.strategy.cities[homeId].troops, before + 3000);
});

test('行军粮按日计；冬季河路加耗；在途部队一旬吃 1 粮/兵', () => {
  const state = { clock: { day: 1 } };
  assert.equal(marchGrainCost(state, 1000, 6, ''), 600);
  assert.equal(marchGrainCost(state, 1000, 1, '大河'), 100);
  state.clock.day = 301;
  assert.equal(marchGrainCost(state, 1000, 10, '大河'), 1300);
  assert.equal(grainForTurn(state, 1000), 1000);
});

test('有城之后金产不再叠每天 1000，入账再扣三成五俸饷；政令改为旬预算', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  const id = Object.keys(state.strategy.cities)[0];
  state.strategy.cities[id].owner = 'player';
  ensureCityEcon(state);
  const gold = playerGoldYield(state, 1000, 0);
  assert.equal(Object.values(state.strategy.cities).some((r) => r.owner === 'player'), true);
  assert.ok(gold > 0 && gold < 400, `城商税应远小于 1000/日，实际 ${gold}`);
  state.roleRes.gold = 0;
  state.roleRes.gold_yield = 100;
  state.roleRes.decree = 0;
  applyDays(state, cfg, 1, { decreePerDay: chapterRules().decreePerDay, upkeepPerSoldier: 0 });
  assert.equal(chapterRules().decreePerDay, 2, '旧章节参数保留兼容，但运行期不再按日发文');
  assert.equal(state.roleRes.gold, 65);
  assert.equal(state.roleRes.decree, 0, 'P61-B：政令旬内不回，跨旬才补 8，上限 12');
  const grain = playerGrainYield(state, 1000, 0, 0);
  assert.ok(grain > 0 && grain < 400, `有城之后粮产不应再叠每天 1000，实际 ${grain}`);
});

test('武将战法页写出填好数字的效果，不留空、不留占位符', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const own = panelState(state, cfg).generals[0].slots.find((s) => s.skill);
  assert.ok(own, '主公应有自带战法');
  assert.equal(own.skill.name, '坐镇中军');
  assert.ok(own.skill.des && own.skill.des.length > 6, own.skill.des);
  assert.equal(own.skill.des.includes('%n%'), false, own.skill.des);
  assert.equal(own.skill.upgradeCost, 20);
  assert.equal(own.skill.maxed, false);
  assert.equal(own.skill.nextDes.includes('%n%'), false);
  state.generals[0].skills[0] = { cfgId: 920000, lv: 3 };
  const inn = panelState(state, cfg).generals[0].slots[0].skill;
  assert.equal(inn.name, '辕门射戟');
  assert.equal(inn.des.includes('%n%'), false, inn.des);
  assert.ok(inn.des.includes('85.56'), inn.des);
});
