/**
 * 武将升级、军工战法、物资去处。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { applyGeneralExp, expToAdvance, GENERAL_LEVEL_CAP } from '../server/domain/general-progress.js';
import { craftJungong, investDev, materialGuide, smeltStone } from '../server/domain/armory.js';
import { skillUpgradeCost } from '../server/domain/slots.js';
import { ensureStrategy } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });

function makeCtx(state) {
  return { state, cfg, options: {}, push() {}, save() {}, log() {}, schedule() {} };
}

test('经验按档升级，已有等级不降，10 级封顶', () => {
  const g = { level: 1, exp: 0 };
  assert.equal(expToAdvance(1), 40);
  assert.equal(applyGeneralExp(g, 39).to, 1);
  assert.equal(g.exp, 39);
  assert.equal(applyGeneralExp(g, 1).to, 2);
  assert.equal(g.exp, 0);
  const veteran = { level: 8, exp: 0 };
  applyGeneralExp(veteran, 0);
  assert.equal(veteran.level, 8);
  const piled = { level: 1, exp: 0 };
  applyGeneralExp(piled, 99999);
  assert.equal(piled.level, GENERAL_LEVEL_CAP);
  assert.equal(piled.exp, 0);
});

test('战法按等级平方花军工，等级不够不能升', () => {
  assert.equal(skillUpgradeCost(1), 20);
  assert.equal(skillUpgradeCost(4), 320);
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = makeCtx(state);
  const g = state.generals[0];
  const gold = state.roleRes.gold;
  state.roleRes.jungong = 500;
  const blocked = handleRequest(ctx, req('general.lvSkill', { gId: g.id, pos: 0 }));
  assert.equal(blocked.msg.ok, false);
  assert.equal(blocked.msg.reason, 'need_general_level');
  assert.equal(g.skills[0].lv, 1);
  assert.equal(state.roleRes.jungong, 500);
  g.level = 2;
  state.roleRes.jungong = 19;
  const poor = handleRequest(ctx, req('general.lvSkill', { gId: g.id, pos: 0 }));
  assert.equal(poor.msg.reason, 'not_enough_jungong');
  assert.equal(poor.msg.cost, 20);
  state.roleRes.jungong = 20;
  const up = handleRequest(ctx, req('general.lvSkill', { gId: g.id, pos: 0 }));
  assert.equal(up.msg.ok, true, up.msg.hint);
  assert.equal(g.skills[0].lv, 2);
  assert.equal(state.roleRes.jungong, 0);
  assert.equal(state.roleRes.gold, gold);
});

test('木铁造成军工，石粮金投入本城，满仓会标明', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  const id = Object.keys(state.strategy.cities)[0];
  state.strategy.cities[id].owner = 'player';
  ensureCityEcon(state);
  const before = state.strategy.cityEcon[id].devAgri;
  state.roleRes.grain = 8000;
  state.roleRes.wood = 10000;
  state.roleRes.iron = 10000;
  const made = craftJungong(state, null, { drain: true });
  assert.equal(made.ok, true);
  assert.equal(made.count, 100);
  assert.equal(state.roleRes.wood, 2000);
  assert.equal(state.roleRes.jungong, 100);
  state.roleRes.stone = 2600;
  const smelt = smeltStone(state, null, { drain: true });
  assert.equal(smelt.count, 3);
  assert.equal(state.roleRes.stone, 2000);
  const agri = investDev(state, null, { cityId: Number(id), field: 'agri', count: 1 });
  assert.equal(agri.ok, true, agri.hint);
  assert.equal(state.strategy.cityEcon[id].devAgri, before + 1);
  assert.equal(state.roleRes.grain, 5000);
  state.roleRes.wood = state.roleRes.depot_capacity;
  const guide = materialGuide(state);
  assert.equal(guide.resources.find((r) => r.key === 'wood').full, true);
  assert.equal(guide.resources.find((r) => r.key === 'jungong').full, false);
  assert.match(guide.rule, /军工/);
  assert.ok(guide.actions.some((a) => a.id === 'craftDrain'));
});
