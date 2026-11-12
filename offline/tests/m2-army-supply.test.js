/**
 * M2-2 粮道 L2：军级补给线（GDD §5.3）。
 *
 * 口径：补给节点 = 己方城（cityEcon.store > 0）；部队锚点 = 行军行出发城；
 * 通畅每旬就地取粮 0.1 粮/兵 扣补给节点城库；断绝第 1 旬警告（带两个应对），
 * 第 3 旬起逃兵 2%/旬。玩家与 NPC 共用 supplyLineForArmy / armySupplyTick（§9.4 同函数）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { supplyLineForArmy, armySupplyTick } from '../server/domain/supply.js';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  return { state, st: state.strategy };
}

function playerCityIds(st) {
  return Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player').map(Number);
}

test('L2·通畅：出发城有粮即自给，锚点本身就是补给节点', () => {
  const { state, st } = oathWorld();
  const from = playerCityIds(st)[0];
  st.cityEcon[from].store = 3000;
  const march = { side: 'player', from, to: 999999, troops: 1000 };
  const line = supplyLineForArmy(state, 'player', march);
  assert.equal(line.connected, true, '出发城有存粮即通畅');
  assert.equal(line.nodeId, from, '补给节点就是出发城');
  assert.equal(line.need, 100, '0.1 粮/兵：1000 兵每旬 100 粮');
});

test('L2·BFS：出发城空库时沿己方城图找最近的存粮节点', () => {
  const { state, st } = oathWorld();
  const owned = playerCityIds(st);
  const from = owned[0];
  // 全部己方城清空，只留一座存粮城 → BFS 必须找到它
  for (const id of owned) st.cityEcon[id].store = 0;
  const other = owned.find((id) => id !== from);
  st.cityEcon[other].store = 5000;
  const march = { side: 'player', from, to: owned[1] || from, troops: 500 };
  const line = supplyLineForArmy(state, 'player', march);
  assert.equal(line.connected, true, '己方图上存在存粮节点即通畅');
  assert.equal(line.nodeId, other, '找到的补给节点应是那座存粮城');
  assert.ok(line.hops >= 1, '至少隔一跳');
});

test('L2·断绝：出发城失守即断，armySupplyTick 第 3 旬开始逃兵', () => {
  const { state, st } = oathWorld();
  const from = playerCityIds(st)[0];
  st.cities[from].owner = 'wei';               // 出发城失守
  const march = { side: 'player', from, to: playerCityIds(st)[1] || from, troops: 1000, departDay: 1, arriveDay: 99 };
  st.marches = [march];
  const ctx = { push() {} };

  const r1 = armySupplyTick(state, ctx);
  assert.equal(r1.cut.length, 1, '第 1 旬上报断绝');
  assert.equal(march.supplyCutDays, 10);
  assert.equal(march.troops, 1000, '第 1 旬还没有逃兵');

  armySupplyTick(state, ctx);                  // 第 2 旬
  assert.equal(march.supplyCutDays, 20);
  assert.equal(march.troops, 1000, '第 2 旬仍无逃兵');

  armySupplyTick(state, ctx);                  // 第 3 旬
  assert.equal(march.supplyCutDays, 30);
  assert.equal(march.troops, 980, '第 3 旬起逃兵 2%');
  assert.ok(r1.cut[0].days === 10);
});

test('L2·取粮：通畅时每旬从补给节点城库扣 0.1/兵', () => {
  const { state, st } = oathWorld();
  const from = playerCityIds(st)[0];
  st.cityEcon[from].store = 3000;
  const march = { side: 'player', from, to: playerCityIds(st)[1] || from, troops: 1000, departDay: 1, arriveDay: 99 };
  st.marches = [march];
  const r = armySupplyTick(state, { push() {} });
  assert.equal(r.fed.length, 1, '通畅应上报取粮');
  assert.equal(r.fed[0].need, 100);
  assert.equal(st.cityEcon[from].store, 2900, '节点城库实扣 100');
  assert.equal(march.supplyOk, true);
});

test('L2·同入口：NPC 行军走同一判定与同一惩罚（§9.4）', () => {
  const { state, st } = oathWorld();
  // 找一座诸侯城当出发城
  const fid = Object.values(st.cities).map((v) => v.owner).find((o) => o && o !== 'player' && o !== 'han');
  const from = Number(Object.keys(st.cities).find((id) => st.cities[id].owner === fid));
  // 诸侯全部城库清空 → 无任何补给节点
  for (const [id, row] of Object.entries(st.cities)) {
    if (row.owner === fid) st.cityEcon[id].store = 0;
  }
  const march = {
    side: 'faction', factionId: fid, factionName: '测试诸侯',
    from, to: playerCityIds(st)[0], troops: 1000, departDay: 1, arriveDay: 99,
  };
  st.marches = [march];
  const r1 = armySupplyTick(state, { push() {} });
  assert.equal(r1.cut.length, 1, 'NPC 部队同样判断补给');
  for (let i = 0; i < 2; i += 1) armySupplyTick(state, { push() {} });
  assert.equal(march.troops, 980, 'NPC 断粮同样逃兵 2%（同惩罚）');
});

test('L2·运输队豁免：运输队本身是补给动作，不吃补给判定', () => {
  const { state, st } = oathWorld();
  const from = playerCityIds(st)[0];
  st.cities[from].owner = 'wei';
  const march = { side: 'player', kind: 'transport', from, to: playerCityIds(st)[1] || from, troops: 0, grain: 800, departDay: 1, arriveDay: 99 };
  st.marches = [march];
  const r = armySupplyTick(state, { push() {} });
  assert.equal(r.cut.length, 0, '运输队不判断补给');
  assert.equal(march.supplyCutDays, undefined);
});
