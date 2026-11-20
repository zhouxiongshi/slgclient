/**
 * 2026-11-19 十项严重 bug + 0 兵力战斗画面的回归锁。
 * 每条断言都对应一个可复现根因，防止后续「顺手优化」再次回退。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { kernelEventsToRounds } from '../server/battle.js';
import { createSkillAssets, kernelSkillAt } from '../server/skills.js';
import { rosterDefenders } from '../server/domain/ai-roster.js';
import {
  ensureStrategy, listScenarios, strategySetScenario, strategyViewState, strategyAttack,
  strategyTransport, strategyResolveMarches, oathOptions, chooseOath,
} from '../server/domain/strategy.js';
import { ensureCityEcon, deliverGrain, disasterTick } from '../server/domain/city-econ.js';

const cfg = loadConfig();
const ROOT = resolve(import.meta.dirname, '..');

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, pushes, options: {},
    push(name, msg) { pushes.push({ name, msg }); },
    schedule() {}, save() {}, log() {},
  };
}

function freshCao() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  const r = chooseOath(state, cfg, makeCtx(state), { lord: cao.id, city: cao.cities[0].id });
  assert.equal(r.ok, true);
  return state;
}

function attackTargetFrom(state, home) {
  const row = strategyViewState(state, cfg).cities.find((c) => Number(c.id) === Number(home));
  const target = (row?.marchRoutes || []).map((rt) => Number(rt.id))
    .find((id) => state.strategy.cities[id] && state.strategy.cities[id].owner !== 'player');
  assert.ok(target, `城 ${home} 应有可达敌城`);
  return target;
}

function readyArmy(state, home) {
  const army = state.armys[0];
  army.cityId = home;
  army.generals[0] = army.generals[0] || state.generals[0].id;
  delete army.marchId;
  return army;
}

test('BUG-01 战斗画面：开局用战前兵力，事件流扣减后才收敛到战后余兵', () => {
  const assets = createSkillAssets(resolve(ROOT, 'web'));
  const js = assets.intercept('/assets/main/index.js').body;
  assert.match(js, /troops: troops, cur: troops, dead: false/, '开局当前兵力必须取战前兵力');
  assert.ok(js.includes('dead: false'), '开局不得把败方预标记阵亡');
  assert.ok(js.includes('var remain = Math.max(0, Math.round(Number(u.remain) || 0))'), '结尾必须用战后余兵校准');
  assert.ok(!js.includes('cur: Math.max(0, u.remain)'), '旧 reset 错误口径不得回退');
});

test('BUG-02 内核零 damage 事件：兜底回合与 mkHit 同形，不再抛 TypeError', () => {
  const rounds = kernelEventsToRounds({ rounds: 2, events: [] }, { a0: 1000, d0: 2000 }, {});
  assert.equal(rounds.length, 1);
  const hit = rounds[0].b[0];
  assert.deepEqual(hit.a_bs, []);
  assert.deepEqual(hit.a_as, []);
  assert.deepEqual(hit.d_as, []);
});

test('BUG-03 战报 side 隔离：守军普攻/战法不得计入我军歼敌', () => {
  const idMap = { a0: 1000, d0: 910001 };
  const skillLookup = {
    d0: new Map([['守势', { cfgId: 10001, lv: 1, i_e: [], e_v: [], e_r: [], class: '被动' }]]),
  };
  const events = [
    { round: 1, actor: 'a0', kind: 'damage', payload: { skill: '普通攻击', target: 'd0', applied: 1000 } },
    { round: 1, actor: 'd0', kind: 'damage', payload: { skill: '普通攻击', target: 'a0', applied: 600 } },
    { round: 1, actor: 'd0', kind: 'skill_trigger', payload: { skill: '守势' } },
    { round: 1, actor: 'd0', kind: 'damage', payload: { skill: '守势', target: 'a0', applied: 400 } },
  ];
  const rounds = kernelEventsToRounds({ rounds: 1, events }, idMap, skillLookup);
  const hits = rounds[0].b;
  assert.equal(hits.filter((h) => h.a_id === 1000).length, 1, '只有我军攻击才生成攻方 hit');
  assert.equal(hits.find((h) => h.a_id === 1000).d_loss, 1000, 'd_loss 只含我军造成的守军损失');
  const defenseHit = hits.find((h) => h.a_id === 910001);
  assert.ok(defenseHit, '守方战法仍要保留守方动作');
  assert.equal(defenseHit.d_loss, 0, '守方伤害不得伪装成我军歼敌');
  assert.equal(defenseHit.d_as[0].kill[0], 400, '守方伤害记在 d_as.kill');
});

test('BUG-04 E0 控制战法：命中率随等级成长且不超 100%', () => {
  for (const id of [10018, 10019, 10028]) {
    const low = kernelSkillAt(id, 1).effects[0].control_probability;
    const high = kernelSkillAt(id, 10).effects[0].control_probability;
    assert.ok(low > 0, `${id} Lv1 命中率不应为 0`);
    assert.ok(high > low, `${id} Lv10 命中率应高于 Lv1（${low} → ${high}）`);
    assert.ok(high <= 1, `${id} 命中率不得超过 100%`);
  }
  const chain = kernelSkillAt(10017, 10).effects[0].control_probability;
  assert.ok(chain <= 1 && chain >= kernelSkillAt(10017, 1).effects[0].control_probability);
});

test('BUG-05 AI 名册守将：战法槽含 null 时过滤而不是崩溃', () => {
  const cfgId = Number([...cfg.generalByCfg.keys()][0]);
  const state = {
    strategy: {
      rosters: {
        wei: { generals: [{ cfgId, level: 5, exp: 0, skills: [{ id: 10001, lv: 1 }, null, null] }] },
      },
    },
  };
  const defenders = rosterDefenders(state, cfg, 'wei', 1, 3);
  assert.equal(defenders.length, 1);
  assert.deepEqual(defenders[0].skills, [{ id: 10001, lv: 1, cfgId: 10001 }]);
});

test('BUG-06 切剧本同步清掉 armys.marchId，队伍不再永久锁死', () => {
  const state = createWorld(cfg);
  for (const a of state.armys) a.marchId = 999;
  const sid = listScenarios()[0].id;
  const r = strategySetScenario(state, sid);
  assert.equal(r.ok, true);
  assert.ok(state.armys.every((a) => !a.marchId), '切剧本后不得残留行军锁');
});

test('BUG-07 缺粮出征失败不得压兵或退兵回城', () => {
  const state = freshCao();
  const home = Number(state.strategy.playerCity);
  const target = attackTargetFrom(state, home);
  const army = readyArmy(state, home);
  army.soldiers = [999999, 0, 0];
  const fromState = state.strategy.cities[home];
  const troopsBefore = fromState.troops;
  ensureCityEcon(state)[home].store = 0;
  state.roleRes.grain = 0;
  const r = strategyAttack(state, cfg, makeCtx(state), { cityId: target, armyId: army.id, fromCityId: home, confirmBattle: true });
  assert.equal(r.reason, 'no_grain');
  assert.deepEqual(army.soldiers, [999999, 0, 0], '失败出征不得改写兵力');
  assert.equal(fromState.troops, troopsBefore, '失败出征不得回补守军');
});

test('BUG-08 举义后都城失守不得继续从该城出征', () => {
  const state = freshCao();
  const home = Number(state.strategy.playerCity);
  const target = attackTargetFrom(state, home);
  const army = readyArmy(state, home);
  army.soldiers = [3000, 0, 0];
  state.roleRes.grain = 100000;
  state.strategy.cities[home].owner = 'wei';
  const r = strategyAttack(state, cfg, makeCtx(state), { cityId: target, armyId: army.id, fromCityId: home });
  assert.equal(r.code, 6, `失守都城必须拒绝出征：${JSON.stringify(r)}`);

  const okState = freshCao();
  const okHome = Number(okState.strategy.playerCity);
  const okTarget = attackTargetFrom(okState, okHome);
  const okArmy = readyArmy(okState, okHome);
  okArmy.soldiers = [3000, 0, 0];
  okState.roleRes.grain = 100000;
  const ok = strategyAttack(okState, cfg, makeCtx(okState), { cityId: okTarget, armyId: okArmy.id, fromCityId: okHome });
  assert.equal(ok.ok, true, '正常己方都城仍可出征');
});

test('BUG-09 运输途中城池失守：粮车折返而不是资敌', () => {
  const state = freshCao();
  const st = state.strategy;
  const own = Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
  state.roleRes.grain = 5000;
  const r = strategyTransport(state, cfg, makeCtx(state), { cityId: own, grain: 1000 });
  assert.equal(r.ok, true);
  const storeBefore = st.cityEcon[own].store;
  st.cities[own].owner = 'wei';
  state.clock.day = r.arriveDay;
  strategyResolveMarches(state, cfg, makeCtx(state));
  assert.equal(st.cityEcon[own].store, storeBefore, '失守城不得入粮');
  assert.ok(st.events.some((e) => e.text.includes('粮车折返')), '应写粮车折返事件');
  assert.equal(deliverGrain(state, own, 500), false, '直接送达也要被归属闸拒绝');
});

test('BUG-10 丢城后该城设施加成停止计入（仍保留己方城设施）', () => {
  const state = freshCao();
  const st = state.strategy;
  const localId = Number(state.citys[0]?.cityId) || 0;
  const cid = Number(Object.keys(st.cities).find((id) =>
    st.cities[id].owner === 'player' && Number(id) !== localId));
  assert.ok(cid, '应有一座可对照的分城');

  const key = `s${cid}`;
  state.facilities[key] = JSON.parse(JSON.stringify(state.facilities[localId] || []));
  const mill = state.facilities[key].find((f) => Number(f.type) === 19) || { type: 19, level: 0, up_time: 0 };
  if (!state.facilities[key].includes(mill)) state.facilities[key].push(mill);
  mill.level = 1;
  mill.up_time = 0;
  const ctx = makeCtx(state);
  const req = () => handleRequest(ctx, { seq: 1, name: 'role.myRoleRes', msg: {} });
  req();
  const withCity = state.roleRes.grain_yield;
  st.cities[cid].owner = 'wei';
  req();
  const withoutCity = state.roleRes.grain_yield;
  assert.ok(withCity - withoutCity >= 1000, `失守城设施加成应停止（${withCity} → ${withoutCity}）`);
});

test('BUG-11 瘟疫真的让数字守军折损一成（旧 Array.isArray 恒 false）', () => {
  const base = freshCao();
  const cid = Number(Object.keys(base.strategy.cities).find((id) => base.strategy.cities[id].owner === 'player'));
  for (const id of Object.keys(base.strategy.cities)) {
    if (Number(id) !== cid) base.strategy.cities[id].owner = 'wei';
  }
  base.strategy.cities[cid].troops = 1000;
  base.strategy.cityEcon[cid].order = 0;
  base.strategy.cityEcon[cid].pop = 1000;
  base.interior = { posts: {} };

  let hit = false;
  for (let day = 1; day <= 400 && !hit; day += 1) {
    const state = JSON.parse(JSON.stringify(base));
    state.clock.day = day;
    const before = state.strategy.cities[cid].troops;
    const fired = disasterTick(state, cfg, { push() {} });
    if (fired.some((f) => f.type === '瘟疫')) {
      hit = true;
      assert.equal(state.strategy.cities[cid].troops, Math.round(before * 0.9), '守军应折损一成');
      assert.equal(typeof state.strategy.cities[cid].troops, 'number', '守军必须保持数字类型');
    }
  }
  assert.ok(hit, '400 日内应至少出现一次瘟疫');
});
