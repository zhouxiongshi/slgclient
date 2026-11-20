/**
 * 第五轮自迭代：军级补给「有粮 ≠ 够吃」。
 * 旧版 supplyLineForArmy 只要 cityEcon.store>0 就判通畅，实测补给节点仅 1 粮、
 * 部队需 1000 粮/旬时仍 supplyOk=true，连续 6 旬零逃兵（只扣 6 粮）——与模块
 * 开头「断粮第 3 旬起逃兵 2%」的文案承诺矛盾。补给节点收紧为 store >= 一旬口粮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, chooseOath, oathOptions } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { supplyLineForArmy, armySupplyTick, grainForTurn, supplyMap } from '../server/domain/supply.js';
import { canMarchBetween, marchGraph } from '../server/domain/march.js';
import { panelState } from '../server/domain/panels.js';
import { strategyViewState, previewAssault, marchGrainCost } from '../server/domain/strategy.js';

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

test('L5·补给量不足：节点只有 1 粮、需 1000 粮/旬 → 判为断绝', () => {
  const { state, st } = oathWorld();
  const from = playerCityIds(st)[0];
  for (const id of playerCityIds(st)) st.cityEcon[id].store = 0;
  st.cityEcon[from].store = 1;
  const march = { side: 'player', from, to: 999999, troops: 1000, resolved: false, kind: 'assault' };
  assert.equal(grainForTurn(state, march.troops), 1000);
  const line = supplyLineForArmy(state, 'player', march);
  assert.equal(line.connected, false, '1 粮不够 1000 粮/旬，不能再算通畅');
  assert.equal(line.reason, 'no_supply_node');
  assert.equal(line.need, 1000);
});

test('L5·逃兵链：节点粮长期不足时第 1 旬警告、第 3 旬起逃兵 2%', () => {
  const { state, st } = oathWorld();
  const from = playerCityIds(st)[0];
  for (const id of playerCityIds(st)) st.cityEcon[id].store = 0;
  st.cityEcon[from].store = 1;
  const march = { side: 'player', from, to: 999999, troops: 1000, resolved: false, kind: 'assault', supplyCutDays: 0 };
  st.marches = [march];
  armySupplyTick(state, {});
  assert.equal(march.supplyOk, false);
  assert.equal(march.supplyCutDays, 10);
  assert.equal(march.troops, 1000, '第 1 旬只有警告');
  armySupplyTick(state, {});
  assert.equal(march.troops, 1000, '第 2 旬仍无逃兵');
  armySupplyTick(state, {});
  assert.equal(march.supplyCutDays, 30);
  assert.equal(march.troops, 980, '第 3 旬起逃兵 2%');
});

test('L5·BFS：锚点不够粮时跳过它找更远的够粮己方城', () => {
  const { state, st } = oathWorld();
  const owned = playerCityIds(st);
  const from = owned[0];
  for (const id of owned) st.cityEcon[id].store = 0;
  st.cityEcon[from].store = 1;
  const other = owned.find((id) => id !== from);
  st.cityEcon[other].store = 5000;
  const line = supplyLineForArmy(state, 'player', { side: 'player', from, to: 999999, troops: 1000 });
  assert.equal(line.connected, true);
  assert.equal(line.nodeId, other, '补给节点应是够粮城，不是只有 1 粮的锚点');
  assert.ok(line.hops >= 1);
});

test('L5·UI 静态闸：整编 / 运粮 / 文案 / 回合口径 / 前端复算 不回退', () => {
  const read = (p) => readFileSync(new URL('../server/' + p, import.meta.url), 'utf8');
  const pu = read('panels-ui.js');
  const ix = read('interaction-ui.js');
  const sk = read('skills.js');
  assert.ok(!pu.includes('data-act="transport" data-city='), '运粮按钮必须带 data-id（旧版死按钮）');
  assert.ok(pu.includes('data-act="transport" data-id='));
  assert.ok(!pu.includes('三公 7700'), '带兵上限文案已改为「基础+官阶+等级」公式');
  assert.ok(pu.includes('满级三公 9500'));
  assert.ok(pu.includes('var generals = [0, 1, 2].map(function (slot)'), '整编下拉必须 0-based');
  assert.ok(pu.includes('(slot + 1) +'), '整编兵力输入必须与下拉同下标');
  assert.ok(!ix.includes('(d.turn || 0)'), '回合口径 turn 0 必须兜底第 1 回合');
  assert.ok(!sk.includes('Math.ceil(deploy * 0.1)'), '出征粮耗禁止前端复算');
  assert.ok(sk.includes('slgWarGrain'), '粮耗必须定点回填服务端权威值');
});

test('L5·六府边境威胁：与沙盘同源，围城预警字段不再丢失', () => {
  const { state, st } = oathWorld();
  const targetId = Object.keys(st.cities).map(Number).find((id) => st.cities[id].owner !== 'player');
  assert.ok(targetId, '应存在敌城');
  state.clock.day = 60;
  state.garrisons = [{
    id: 'g1', name: '来犯军', soldiers: 5000, faction: '董卓',
    cleared: false, targetCity: targetId, spawnDay: 1,
  }];
  st.cities[targetId].besieged = true;
  ensureCityEcon(state);
  st.cityEcon[targetId].morale = 18;

  const panelThreats = panelState(state, cfg).strategy.threats;
  const sandThreats = strategyViewState(state, cfg).threats;
  assert.equal(panelThreats.length, 1);
  assert.equal(panelThreats[0].besieging, true, '六府页必须能看到「正在围城」');
  assert.equal(panelThreats[0].targetCity, targetId);
  assert.equal(panelThreats[0].targetMorale, 18);
  assert.equal(panelThreats[0].daysToSiege, 0, '已围城时不显示负天数');
  assert.deepEqual(panelThreats, sandThreats, '六府与沙盘必须共用同一份威胁映射');
});

test('L5·出征预览粮耗：服务端下发权威 grainCost，含行程天数', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  assert.equal(chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id }).ok, true);
  const st = state.strategy;
  const owned = Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player').map(Number);
  const from = owned[0];
  const row = strategyViewState(state, cfg).cities.find((c) => Number(c.id) === from);
  const target = (row?.marchRoutes || []).map((rt) => Number(rt.id))
    .find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  assert.ok(target, '应存在可达敌城');
  const army = (state.armys || [])[0];
  army.cityId = from;
  army.marchId = 0;
  army.soldiers = [1600, 800, 0];
  state.clock.day = 5;

  const p = previewAssault(state, cfg, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  assert.equal(p.ok, true);
  assert.ok(p.days >= 1);
  assert.equal(p.grainCost, marchGrainCost(state, p.deploy, p.days, st.cities[target]?.terrain || ''),
    '预览粮耗必须与正式出征共用同一个权威公式');
  if (p.days > 1) {
    assert.ok(p.grainCost > Math.ceil(p.deploy * 0.1), '粮耗必须含行程天数，不能只算单日');
  }
});

test('L5·粮道里程：取路网真实 km，不再「跳数×100」假数据', () => {
  const { state, st } = oathWorld();
  const map = supplyMap(state);
  const g = marchGraph();
  assert.ok(g, 'detail.json 路网图应可读');
  let checked = 0;
  for (const [idStr, s] of Object.entries(map.byCity)) {
    if (!s.connected || Number(idStr) === st.playerCity) continue;
    // 沿 path 逐段累加真实里程（行军规则不许穿第三座城，跨城粮道必须逐段走）
    let real = 0;
    for (let i = 0; i < s.path.length - 1; i++) {
      const seg = canMarchBetween(s.path[i], s.path[i + 1]);
      for (const eid of seg.edges || []) real += Number(g.edges.get(eid)?.km) || 0;
    }
    assert.ok(Math.abs(s.km - real) <= 1, `城${idStr} 粮道km=${s.km} 应接近路网真实 ${real}`);
    if (s.hops === 1 && Math.round(real) !== 100) {
      assert.notEqual(s.km, 100, '一跳粮道不应恒是「100 里」兜底值');
    }
    checked++;
  }
  assert.ok(checked > 0, '至少核对一座连通城');
});

test('L5·回归：节点粮充足时仍就地取粮、零逃兵', () => {
  const { state, st } = oathWorld();
  const from = playerCityIds(st)[0];
  st.cityEcon[from].store = 3000;
  const march = { side: 'player', from, to: 999999, troops: 1000, resolved: false, kind: 'assault', supplyCutDays: 0 };
  st.marches = [march];
  const line = supplyLineForArmy(state, 'player', march);
  assert.equal(line.connected, true);
  assert.equal(line.nodeId, from);
  assert.equal(line.need, 1000);
  armySupplyTick(state, {});
  assert.equal(march.supplyOk, true);
  assert.equal(st.cityEcon[from].store, 2000, '就地实扣 1000');
  assert.equal(march.troops, 1000, '无逃兵');
});
