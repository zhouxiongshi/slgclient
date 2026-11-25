/**
 * P61-D（2026-11-25）伪选择修复回归：
 *  S1 太守方针有真实产出差异与互斥工程；S2 战局按 3 旬槽锁定，换出发日不能刷必胜。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, chooseOath, oathOptions, previewAssault, strategyViewState,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { policyEffect, POLICY_EFFECTS } from '../server/domain/policy-effects.js';
import {
  POLICIES, governorTick, governorView, governorListView,
} from '../server/domain/governor.js';
import { cityLayer } from '../server/domain/city-econ.js';
import { seedSlotDay } from '../server/domain/strategy.js';

const cfg = loadConfig();
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
function fresh() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const lord = oathOptions(s).lords.find((l) => l.cities.length >= 2) || oathOptions(s).lords[0];
  const r = chooseOath(s, cfg, mkCtx(s), { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true);
  governorListView(s, cfg); // 举义后确保每座己方城都有太守记录
  return s;
}
function ownIds(s) {
  return Object.keys(s.strategy.cities).filter((id) => s.strategy.cities[id].owner === 'player');
}

test('P61-S1 方针有真实产出配比：重农 vs 重商第 10 旬差距 ≥20%', () => {
  const s = fresh();
  const ids = ownIds(s);
  assert.equal(ids.length >= 2, true);
  for (const id of ids) s.strategy.governors[id].policy = 'agri';
  const agri = cityLayer(s);
  for (const id of ids) s.strategy.governors[id].policy = 'trade';
  const trade = cityLayer(s);
  assert.ok(agri.grain > trade.grain * 1.2, `粮差不足：${agri.grain} vs ${trade.grain}`);
  assert.ok(trade.gold > agri.gold * 1.2, `金差不足：${trade.gold} vs ${agri.gold}`);
  const def = policyEffect('defense');
  assert.equal(def.yields.gold, 0.5, '固防商税减半');
  assert.ok(def.forbid.includes('trade'), '固防不许开市集');
});

test('P61-S1 六方针互斥写入唯一口径与玩家可见文案', () => {
  const src = readFileSync(new URL('../server/domain/governor.js', import.meta.url), 'utf8');
  assert.match(src, /P\.forbid\.includes\(kind\)/, '旬界按方针互斥派单');
  const s = fresh();
  const id = ownIds(s)[0];
  s.strategy.governors[id].policy = 'agri';
  const v = governorView(s, cfg, id);
  assert.match(v.policyEffect, /粮产 \+25%/);
  assert.ok(v.forbid.length > 0, '玩家能看到停工项');
  assert.ok(POLICIES.agri.forbid.includes('barracks'));
  assert.equal(POLICY_EFFECTS.auto.forbid.length, 0);
  // 互斥不导致崩溃：旬界仍可正常派单/结算
  const out = governorTick(s, cfg, mkCtx(s));
  assert.ok(Array.isArray(out.started));
});

test('P61-S2 战局槽：3 旬内换出发日不给新种子，跨槽才变', () => {
  assert.equal(seedSlotDay(5), seedSlotDay(8));
  assert.notEqual(seedSlotDay(5), seedSlotDay(35));
  const s = fresh();
  const own = ownIds(s).map(Number);
  const from = own[0];
  const view = strategyViewState(s, cfg);
  const routes = view.cities.find((c) => Number(c.id) === from)?.marchRoutes || [];
  const target = routes.map((rt) => Number(rt.id))
    .find((id) => s.strategy.cities[id] && s.strategy.cities[id].owner !== 'player');
  assert.ok(target, '前提：有可出征的相邻目标');
  const army = s.armys[0];
  army.cityId = from;
  army.marchId = 0;
  army.soldiers = [4000, 2000, 0];
  const args = { cityId: target, fromCityId: from, armyId: army.id, frac: 1 };
  s.clock.day = 1;
  const a = previewAssault(s, cfg, args);
  s.clock.day = 5;
  const b = previewAssault(s, cfg, args);
  s.clock.day = 35;
  const c = previewAssault(s, cfg, args);
  assert.equal(a.ok && b.ok && c.ok, true);
  assert.equal(a.seed, b.seed, '同槽内换出发日，种子不变');
  assert.equal(a.variant.id, b.variant.id, '同槽内变招不变');
  assert.notEqual(a.seed, c.seed, '跨槽才换战局');
  assert.ok(Array.isArray(a.riskNotes) && a.riskNotes.length >= 3);
});
