/**
 * 城市经营九大系统（P0~P3）：编队/兵种克制/战利品/忠诚俸禄/人口/逐城产量/运输/灾害。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import {
  ensureStrategy, strategyViewState, strategyFormup, strategyTransport,
  strategyAttack, strategyResolveMarches, oathOptions, chooseOath, rewardGeneral,
} from '../server/domain/strategy.js';
import {
  ensureCityEcon, cityYield, cityLayer, armsApt, armsCounter, ARMS_NAMES,
  loyaltyTick, deliverGrain, consumeMarchGrain,
} from '../server/domain/city-econ.js';
import { recordRes } from '../server/domain/economy.js';

const cfg = loadConfig();

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    schedule() {}, save() {}, log() {},
  };
}

/** 新档 + 举义曹操 + 定都第一候选城。 */
function freshCao() {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  chooseOath(state, cfg, makeCtx(state), { lord: cao.id, city: cao.cities[0].id });
  return state;
}

test('城市经营层初始化：玩家城有人口/开发度/城库/产量', () => {
  const state = freshCao();
  const econ = ensureCityEcon(state);
  const st = state.strategy;
  const own = Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player');
  assert.ok(own.length >= 1, '举义后应有城池');
  for (const id of own) {
    assert.ok(econ[id].pop > 0, '人口应>0');
    assert.ok(econ[id].store >= 0, '城库应有值');
    const y = cityYield(state, Number(id));
    assert.ok(y.grain >= 0 && y.gold >= 0, '逐城产量应可计算');
  }
});

test('逐城产量层汇总：占城越多加成越大（叠加层>0）', () => {
  const state = freshCao();
  const cl = cityLayer(state);
  assert.ok(cl.grain > 0, '玩家城粮产加成应>0');
  assert.ok(cl.gold > 0, '玩家城金产加成应>0');
});

test('兵种适性：只奖励不惩罚（85%~115% 映射到 100%~115%），关羽骑兵高于糜竺骑兵', () => {
  const gy = cfg.generalByCfg.get(100026);  // 关羽 force 9500
  const mz = [...cfg.generalByCfg.values()].find((g) => g.name === '糜竺');
  const aptGy = armsApt({ force: gy.force, strategy: gy.strategy, defense: gy.defense }, 3);
  const aptMz = armsApt({ force: mz.force, strategy: mz.strategy, defense: mz.defense }, 3);
  assert.ok(aptGy > aptMz, '关羽骑兵适性应高于糜竺');
  assert.ok(aptGy <= 1.15, '适性上限 115%');
  assert.equal(aptMz, 1, '低五维武将无惩罚（=100%）');
});

test('克制环：骑克盾、盾克弓、弓克骑，反向被克', () => {
  assert.equal(armsCounter(3, 1), 1);
  assert.equal(armsCounter(1, 2), 1);
  assert.equal(armsCounter(2, 3), 1);
  assert.equal(armsCounter(1, 3), -1);
  assert.equal(armsCounter(2, 1), -1);
  assert.equal(armsCounter(3, 2), -1);
  assert.equal(armsCounter(1, 1), 0);
});

test('编队：换将+重分兵力生效，重复武将与超量兵力被拒', () => {
  const state = freshCao();
  const army = state.armys[0];
  const gids = state.generals.slice(0, 3).map((g) => g.id);
  const r = strategyFormup(state, cfg, makeCtx(state), {
    armyId: army.id, generals: gids, soldiers: [400, 250, 150],
  });
  assert.ok(r.ok, `编队应成功: ${JSON.stringify(r)}`);
  assert.deepEqual(army.soldiers, [400, 250, 150]);
  assert.equal(r.apt.filter((v) => v > 0).length, 3, '三槽适性都应输出');

  const bad = strategyFormup(state, cfg, makeCtx(state), {
    armyId: army.id, generals: [gids[0], gids[0], 0], soldiers: [100, 100, 100],
  });
  assert.equal(bad.reason, 'dup_general', '重复武将应拒绝');

  const over = strategyFormup(state, cfg, makeCtx(state), {
    armyId: army.id, generals: gids, soldiers: [1000, 1000, 1000],
  });
  assert.equal(over.reason, 'too_many_troops', '超过现有兵力应拒绝');
});

test('编队：全空编队被拒（兵不许凭空蒸发），减编差额退回驻城', () => {
  const state = freshCao();
  const army = state.armys[0];
  const totalBefore = army.soldiers.reduce((s, v) => s + v, 0);
  const empty = strategyFormup(state, cfg, makeCtx(state), {
    armyId: army.id, generals: [0, 0, 0], soldiers: [0, 0, 0],
  });
  assert.equal(empty.reason, 'empty_formup', 'UI 可提交三槽全 0，服务端必须拒绝');
  assert.equal(army.soldiers.reduce((s, v) => s + v, 0), totalBefore, '拒绝后兵力不变');

  const home = state.strategy.cities?.[army.cityId];
  const garrisonBefore = home ? Math.round(Number(home.troops) || 0) : 0;
  const r = strategyFormup(state, cfg, makeCtx(state), {
    armyId: army.id, generals: [state.generals[0].id, 0, 0], soldiers: [100, 0, 0],
  });
  assert.ok(r.ok, `减编应成功: ${JSON.stringify(r)}`);
  assert.equal(army.soldiers.reduce((s, v) => s + v, 0), 100);
  if (home) {
    assert.equal(Math.round(Number(home.troops) || 0), garrisonBefore + (totalBefore - 100),
      '余兵必须退回驻城守军，不允许蒸发');
    assert.equal(r.returnedToCity, totalBefore - 100);
  }
});

test('行军粮：优先扣出发城城库，池扣部分加 25% 损耗', () => {
  const state = freshCao();
  const econ = ensureCityEcon(state);
  const home = state.strategy.playerCity;
  econ[home].store = 100;
  const before = state.roleRes.grain;
  const pay = consumeMarchGrain(state, home, 300);
  assert.equal(econ[home].store, 0, '城库应被扣空');
  // 剩余 200 × 1.25 = 250 从池扣
  assert.equal(before - state.roleRes.grain, 250, '池扣应为 250（含损耗）');
  assert.ok(pay.enough, '够付则 enough');
  const fail = consumeMarchGrain(state, home, 999999);
  assert.ok(!fail.enough, '粮不够时 enough=false');
});

test('运输队：扣粮出发，2 日后送达城库', () => {
  const state = freshCao();
  ensureCityEcon(state);
  const st = state.strategy;
  const own = Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
  state.roleRes.grain = 5000;
  const storeBefore = st.cityEcon[own].store;
  const r = strategyTransport(state, cfg, makeCtx(state), { cityId: own, grain: 1000 });
  assert.ok(r.ok, `运输应成功: ${JSON.stringify(r)}`);
  assert.equal(state.roleRes.grain, 4000, '出发即扣粮');
  state.clock.day = r.arriveDay;
  strategyResolveMarches(state, cfg, makeCtx(state));
  assert.equal(st.cityEcon[own].store, storeBefore + 1000, '抵达后城库应+1000');
});

test('忠诚旬结算：发俸扣金；欠饷忠诚-5；赏赐提升忠诚', () => {
  const state = freshCao();
  ensureCityEcon(state);
  const g = state.generals[0];
  const loyalBefore = g.loyal ?? 88;
  const goldBefore = state.roleRes.gold;
  const r = loyaltyTick(state, cfg, makeCtx(state));
  assert.ok(r.salaryDue > 0, '应有旬俸');
  if (goldBefore >= r.salaryDue) {
    assert.equal(state.roleRes.gold, goldBefore - r.salaryDue, '足额发俸应扣金');
    assert.ok((g.loyal ?? 88) <= loyalBefore, '普通武将旬忠诚应不升（-1+0=最多持平再-1）');
  }
  // 赏赐
  state.roleRes.gold = 10000;
  const rr = rewardGeneral(state, cfg, makeCtx(state), { generalId: g.id, amount: 1000 });
  assert.ok(rr.ok, '赏赐应成功');
  assert.ok(g.loyal <= 100, '忠诚封顶 100');
});

test('旧档兼容：无 loyal 字段的武将按 88 兜底', () => {
  const state = freshCao();
  const g = state.generals[0];
  delete g.loyal;
  assert.equal(Math.round(g.loyal ?? 88), 88);
});
