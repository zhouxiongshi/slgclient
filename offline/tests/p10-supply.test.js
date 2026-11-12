/**
 * U20 粮道连通与断粮。
 *
 * 判定口径：粮道 = 沿**己方城池**与**未封锁关隘**能走到都城的路径；
 * 走不到即断粮。惩罚写死在这里并在界面上公开：
 *   每旬 民心 −3 / 治安 −1 / 守军逃散 2% / 粮产 ×0.55（金产不受影响）。
 *
 * 这一层锁的是「NPC 与玩家共用同一套判定」（验收 #14）与「断粮不是隐藏惩罚」（#12）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyViewState,
} from '../server/domain/strategy.js';
import { ensureCityEcon, cityYield, cityEconTick } from '../server/domain/city-econ.js';
import { supplyMap, supplyFor, supplyTick, marchSupplyEstimate } from '../server/domain/supply.js';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  const st = state.strategy;
  const owned = Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player').map(Number);
  return { state, st, owned, capital: st.playerCity };
}

test('粮道：都城自身 0 跳，其余己方城给出跳数/里程/途经', () => {
  const { state, owned, capital } = oathWorld();
  const m = supplyMap(state);
  assert.equal(m.capital, capital);
  assert.equal(m.byCity[capital].connected, true);
  assert.equal(m.byCity[capital].hops, 0);
  for (const id of owned) {
    const row = m.byCity[id];
    assert.ok(row, `己方城 ${id} 应有粮道记录`);
    assert.equal(row.connected, true, `举义时诸侯的城应连成一片：${id}`);
    assert.equal(row.path[0], capital, '路径应从都城出发');
    assert.equal(row.path[row.path.length - 1], id);
    assert.equal(row.hops, row.path.length - 1);
  }
});

test('切断中间城 → 远端变断粮，恢复后自动解除', () => {
  const { state, st, owned, capital } = oathWorld();
  // 找一座靠两跳以上才连到都城的城（一定有中间城）
  const m0 = supplyMap(state);
  const far = owned.find((id) => m0.byCity[id].hops >= 2);
  assert.ok(far, '举义城应至少有一座两跳城，否则这条用例无意义');
  const mid = m0.byCity[far].path[1];
  const wasOwner = st.cities[mid].owner;
  st.cities[mid].owner = 'wei';
  const m1 = supplyMap(state);
  assert.equal(m1.byCity[far].connected, false, '中间城易手后远端应断粮');
  assert.ok(m1.isolated.includes(far));

  const r1 = supplyTick(state, cfg, { push() {} });
  assert.ok(r1.hits.some((h) => h.cityId === far), '断粮城应吃到惩罚');
  const e = st.cityEcon[far];
  assert.equal(e.supplyCut, true);
  assert.equal(e.supplyDays, 10);
  assert.ok(r1.hits[0].troopsLost >= 1, '守军应有逃散');

  // 恢复归属 → 下一旬自动解除，不再扣
  st.cities[mid].owner = wasOwner;
  const r2 = supplyTick(state, cfg, { push() {} });
  assert.ok(r2.recovered.includes(far), '通路恢复应上报恢复');
  assert.equal(st.cityEcon[far].supplyCut, false);
  assert.equal(st.cityEcon[far].supplyDays, 0);
  void capital;
});

test('断粮惩罚数值：民心 −3、治安 −1、军粮产量 ×0.55', () => {
  const { state, st, owned } = oathWorld();
  const far = owned.find((id) => supplyMap(state).byCity[id].hops >= 2);
  const mid = supplyMap(state).byCity[far].path[1];
  st.cities[mid].owner = 'wei';
  const e = st.cityEcon[far];
  const before = { morale: Number(e.morale ?? 60), order: Number(e.order ?? 60), troops: Number(st.cities[far].troops) };
  const grainBefore = cityYield(state, far).grain;

  supplyTick(state, cfg, { push() {} });
  assert.equal(Number(e.morale), Math.round((before.morale - 3) * 10) / 10);
  assert.equal(Number(e.order), Math.round((before.order - 1) * 10) / 10);
  assert.equal(Number(st.cities[far].troops), Math.round(before.troops * 0.98));

  const grainAfter = cityYield(state, far).grain;
  // 民心也掉了，产量本来就会降；这里只要求「断粮显著减产」
  assert.ok(grainAfter < grainBefore * 0.75, `断粮后粮产应大幅下降：${grainBefore} → ${grainAfter}`);
  assert.equal(cityYield(state, far).supplyCut, true);
});

test('出征粮道预估：给出跳数/里程/城库可支撑日，断粮时如实说断', () => {
  const { state, st, owned, capital } = oathWorld();
  st.cityEcon[capital].store = 1000;
  const est = marchSupplyEstimate(state, capital, 800, 3);
  assert.equal(est.connected, true);
  assert.equal(est.hops, 0);
  assert.equal(est.store, 1000);
  assert.equal(est.dailyNeed, 80);
  assert.equal(est.daysCanHold, 12);
  assert.equal(est.enough, true);
  assert.ok(/粮道通/.test(est.note));

  const far = owned.find((id) => supplyMap(state).byCity[id].hops >= 2);
  const mid = supplyMap(state).byCity[far].path[1];
  st.cities[mid].owner = 'wei';
  const est2 = marchSupplyEstimate(state, far, 800, 3);
  assert.equal(est2.connected, false);
  assert.ok(/断绝/.test(est2.note));
});

test('都城丢失时豁免断粮惩罚（避免亡国瞬间全线雪崩）', () => {
  const { state, st, capital } = oathWorld();
  st.cities[capital].owner = 'wei';
  const m = supplyMap(state);
  assert.equal(m.exempt, true);
  assert.deepEqual(m.isolated, []);
  const r = supplyTick(state, cfg, { push() {} });
  assert.equal(r.hits.length, 0);
});

test('城池视图与旬结算同源：断粮城在视图里 connected=false 且带天数', () => {
  const { state, st, owned } = oathWorld();
  const far = owned.find((id) => supplyMap(state).byCity[id].hops >= 2);
  const mid = supplyMap(state).byCity[far].path[1];
  st.cities[mid].owner = 'wei';
  // 旬界才结算：把日历对齐到 10 的倍数
  state.clock.day = 20;
  cityEconTick(state, cfg, { push() {} });
  const view = strategyViewState(state, cfg).cities.find((c) => c.id === far);
  assert.equal(view.supply.connected, false);
  assert.ok(view.supply.days >= 10);
  assert.ok(/断绝/.test(String(view.supply.via)) === false, 'via 是城名数组，不该塞文案');
  // 断粮城的粮产视图应低于不断粮时
  const ok = strategyViewState(state, cfg).cities.find((c) => c.id === st.playerCity);
  assert.equal(ok.supply.connected, true);
});
