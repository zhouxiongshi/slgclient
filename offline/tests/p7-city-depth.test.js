/**
 * P7 城市纵深与战法距离：分城出征、里程驱动行军、普攻攻击距离、
 * 逐城民心/治安/开发度、委任成长、赈灾、出仕。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyAttack, strategyViewState,
  strategyInvest, marchableFrom, marchKmBetween, marchDaysBy, armySpeed,
  defectTick,
} from '../server/domain/strategy.js';
import {
  ensureCityEcon, cityYield, cityDevTick, devLevel, cityName,
} from '../server/domain/city-econ.js';
import { BattleEngine } from '../kernel/engine.js';
import { rangeOf, attackDistanceOf, SKILLS } from '../server/skills.js';

const cfg = loadConfig();

/** 举义后的世界：返回 state 与玩家名下城列表。 */
function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const lord = lords[0];
  const r = chooseOath(state, cfg, { push() {} }, { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true, '举义应成功');
  const st = state.strategy;
  const own = Object.entries(st.cities)
    .filter(([, v]) => v.owner === 'player')
    .map(([id]) => ({ id: Number(id), name: cityName(Number(id)) }));
  return { state, st, own };
}

/* -------------------------------------------------------------------------- */
/* 1. 分城出征（Bug A）                                                        */
/* -------------------------------------------------------------------------- */

test('P7 分城出征：非首都城也能作为出发地，且邻接校验按出发城算', () => {
  const { state, st, own } = oathWorld();
  // 找一座「非首都 + 有可攻邻城」的己方城
  let from = null;
  let target = 0;
  for (const c of own) {
    if (c.id === st.playerCity) continue;
    const t = marchableFrom(c.id).find((id) => st.cities[id] && st.cities[id].owner !== 'player');
    if (t) { from = c; target = t; break; }
  }
  assert.ok(from, '应存在非首都且可出征的己方城');
  // 把主军挪到该城，避免用首都的队伍蒙混过关
  const army = state.armys[0];
  army.cityId = from.id;
  army.soldiers = [600, 0, 0];
  army.generals = [state.generals[0].id, 0, 0];
  const r = strategyAttack(state, cfg, { push() {} }, { cityId: target, fromCityId: from.id, frac: 1 });
  assert.equal(r.ok, true, `分城出兵应成功：${JSON.stringify(r)}`);
  assert.equal(st.marches[0].from, from.id, '行军记录应记出发城');
  assert.ok(st.marches[0].km > 0, '行军记录带里程');
  assert.equal(r.from, from.name);
});

test('P7 分城出征：出发城不是自己的城必须拒绝', () => {
  const { state, st } = oathWorld();
  const enemies = Object.entries(state.strategy.cities)
    .filter(([, v]) => v.owner !== 'player');
  assert.ok(enemies.length >= 2, '应有敌方城');
  // 目标与出发城都取敌方：先过「目标不是自己的城」，再撞「出发城不是你的城」
  const target = Number(enemies[0][0]);
  const from = Number(enemies[1][0]);
  const r = strategyAttack(state, cfg, { push() {} }, { cityId: target, fromCityId: from, frac: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_own_city', `实际 ${r.reason}`);
  void st;
});

/* -------------------------------------------------------------------------- */
/* 2. 里程驱动行军                                                             */
/* -------------------------------------------------------------------------- */

test('P7 行军按里程与队速算：越远越慢、越快越早，日数夹在 1~12', () => {
  assert.equal(marchDaysBy(55, 100), 1, '55 里 + 速度 100 = 1 日');
  assert.equal(marchDaysBy(110, 100), 2);
  assert.ok(marchDaysBy(330, 100) > marchDaysBy(110, 100), '越远日数越多');
  assert.ok(marchDaysBy(330, 150) < marchDaysBy(330, 100), '骑兵比步卒快');
  assert.equal(marchDaysBy(99999, 20), 12, '上限 12 日');
  assert.equal(marchDaysBy(1, 200), 1, '下限 1 日');
});

test('P7 队伍速度取队内最慢武将，且路网自带里程', () => {
  const { state, own } = oathWorld();
  const army = state.armys[0];
  const s1 = armySpeed(state, cfg, army);
  assert.ok(s1 >= 60 && s1 <= 160, `队速应在 60~160，实际 ${s1}`);
  // 塞一个速度极低的武将进队，队速应下降
  const slow = state.generals[0];
  army.generals = [slow.id, 0, 0];
  const before = armySpeed(state, cfg, army);
  slow.speed_added = -10000;      // 极端：五维速度归零
  const after = armySpeed(state, cfg, army);
  assert.ok(after < before, '慢将拖累全队');
  assert.ok(after >= 20, '速度下限 20，不会归零');
  const km = marchKmBetween(own[0].id, own[1].id);
  assert.ok(km > 0, '同属一州的城之间应有里程');
});

/* -------------------------------------------------------------------------- */
/* 3. 战法射程配置化 + 普攻攻击距离                                            */
/* -------------------------------------------------------------------------- */

test('P7 战法射程：单体比群体近，攻击距离按兵种给（盾3/弓4/骑3）', () => {
  const single = SKILLS.find((s) => String(s.ui?.target) === '6' && s.trigger !== 3);
  const group = SKILLS.find((s) => String(s.ui?.target) === '9' && s.trigger !== 3);
  if (single && group) {
    assert.ok(rangeOf(single) <= rangeOf(group), '单体射程不应超过群体');
  }
  assert.equal(attackDistanceOf({ curArms: 1 }), 3, '盾兵攻距 3');
  assert.equal(attackDistanceOf({ curArms: 2 }), 4, '弓兵攻距 4');
  assert.equal(attackDistanceOf({ curArms: 3 }), 3, '骑兵攻距 3');
  assert.equal(attackDistanceOf({ curArms: 1, attack_distance: 5 }), 5, '武将自带配置优先');
});

test('P7 普攻有距离：大营里的短手武将打不到敌方大营，只能靠战法', () => {
  const mk = (id, side, pos, ar) => ({
    unit_id: id, side, pos, alive: true, attack_range: ar,
    hero: {
      name: id, force: 100, strategy: 100, defense: 100, speed: 100, destroy: 10,
      force_grow: 1, strategy_grow: 1, defense_grow: 1, speed_grow: 1, destroy_grow: 1,
      arms: [1], skills: [],
    },
    troops: 100, max_troops: 100, speed: 100,
  });
  const eng = Object.create(BattleEngine.prototype);
  eng.units = [
    mk('a0', 1, 0, 3), mk('a1', 1, 1, 3), mk('a2', 1, 2, 3),
    mk('d0', 2, 0, 3), mk('d1', 2, 1, 3), mk('d2', 2, 2, 3),
  ];
  const a2 = eng.units[2];
  // 满编 3v3：大营里有敌前锋可打（距离 3），所以先单独验证「只剩敌大营」的情形
  eng.units = [mk('a2', 1, 2, 3), mk('d2', 2, 2, 3)];
  assert.equal(eng.nearestFoe(eng.units[0], 3), null, '超距不应有普攻目标');
  eng.units = [
    mk('a0', 1, 0, 3), mk('a1', 1, 1, 3), mk('a2', 1, 2, 3),
    mk('d0', 2, 0, 3), mk('d1', 2, 1, 3), mk('d2', 2, 2, 3),
  ];
  const first = eng.nearestFoe(a2, 3);
  assert.ok(first, '前排还在时，大营也能打到敌前锋');
  assert.equal(first.unit_id, 'd0', '优先打最近的敌前锋');
  // 把攻击距离放到 5 就能打到敌大营——距离是唯一变量
  eng.units = [mk('a2', 1, 2, 5), mk('d2', 2, 2, 3)];
  const far = eng.nearestFoe(eng.units[0], 5);
  assert.ok(far, '攻距 5 应能打到敌大营');
  // 大营 → 敌前锋 距离 3，攻距 3 刚好够
  eng.units = [mk('a2', 1, 2, 3), mk('d0', 2, 0, 3)];
  const hit = eng.nearestFoe(eng.units[0], 3);
  assert.ok(hit, '攻距 3 应能打到敌前锋');
  assert.equal(hit.unit_id, 'd0');
  // 只剩敌大营时打空
  eng.units = [mk('a2', 1, 2, 3), mk('d2', 2, 2, 3)];
  assert.equal(eng.nearestFoe(eng.units[0], 3), null);
});

/* -------------------------------------------------------------------------- */
/* 4. 逐城民心/治安/开发度                                                     */
/* -------------------------------------------------------------------------- */

test('P7 城市有性格：12 维属性进经济，民心影响产量，开发度分 5 级', () => {
  const { state, st } = oathWorld();
  const econ = ensureCityEcon(state);
  const cid = st.playerCity;
  const e = econ[cid];
  assert.ok(e.morale != null && e.order != null, '逐城民心/治安应初始化');
  assert.ok(e.devArms != null && e.devDef != null, '兵营/城防开发度应初始化');
  const hi = cityYield(state, cid).grain;
  e.morale = 0;
  const lo = cityYield(state, cid).grain;
  e.morale = 100;
  const hi2 = cityYield(state, cid).grain;
  assert.ok(lo < hi && hi <= hi2, `民心应影响产量：民心0=${lo} / 60=${hi} / 100=${hi2}`);
  assert.equal(devLevel(0), 1);
  assert.equal(devLevel(24), 2);
  assert.equal(devLevel(96), 5);
  assert.equal(devLevel(200), 5);
});

test('P7 委任官员按属性推动「官员驻城」的开发度', () => {
  const { state, st } = oathWorld();
  const econ = ensureCityEcon(state);
  const cid = st.playerCity;
  const g = state.generals[0];
  g.cityId = cid;
  state.interior.posts = { agri: g.id, commerce: 0, military: 0, defense: 0, personnel: 0 };
  const before = econ[cid].devAgri;
  const r = cityDevTick(state, cfg, { push() {} });
  assert.equal(r.gains.length, 1, '只有农政一职在岗');
  assert.equal(r.gains[0].field, 'devAgri');
  assert.ok(econ[cid].devAgri > before, '开发度应增长');
});

test('P7 委任收益递减：开发度 100 以上涨得慢', () => {
  const { state, st } = oathWorld();
  const econ = ensureCityEcon(state);
  const cid = st.playerCity;
  const g = state.generals[0];
  g.cityId = cid;
  state.interior.posts = { agri: g.id, commerce: 0, military: 0, defense: 0, personnel: 0 };
  econ[cid].devAgri = 20;
  const low = cityDevTick(state, cfg, { push() {} }).gains[0].gain;
  econ[cid].devAgri = 110;
  const high = cityDevTick(state, cfg, { push() {} }).gains[0].gain;
  assert.ok(high < low, `高开发度应递减：20→${low} / 110→${high}`);
});

/* -------------------------------------------------------------------------- */
/* 5. 内政任务与赈灾                                                           */
/* -------------------------------------------------------------------------- */

test('P7 内政任务：募兵提兵营、赈灾解减产并涨民心', () => {
  const { state, st } = oathWorld();
  const econ = ensureCityEcon(state);
  const cid = st.playerCity;
  state.roleRes.gold = 50000;
  const r1 = strategyInvest(state, cfg, {}, { cityId: cid, kind: 'barracks' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.ok(r1.devArms > 0 && r1.lvArms >= 1);
  // 同旬再办 → 冷却
  const r2 = strategyInvest(state, cfg, {}, { cityId: cid, kind: 'agri' });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'cooldown');
  // 推 10 天后赈灾
  state.clock.day += 10;
  econ[cid].mod = { grain: 0.5, until: state.clock.day + 10 };
  econ[cid].disaster = { type: 'locust', name: '蝗灾', day: state.clock.day };
  const moraleBefore = econ[cid].morale;
  const r3 = strategyInvest(state, cfg, {}, { cityId: cid, kind: 'relief' });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(econ[cid].mod, null, '赈灾应解除减产');
  assert.ok(econ[cid].morale > moraleBefore, '赈灾应涨民心');
});

test('P7 无灾时赈灾被拒绝', () => {
  const { state, st } = oathWorld();
  const econ = ensureCityEcon(state);
  const cid = st.playerCity;
  state.roleRes.gold = 50000;
  econ[cid].mod = null;
  econ[cid].disaster = null;
  const r = strategyInvest(state, cfg, {}, { cityId: cid, kind: 'relief' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_disaster');
});

/* -------------------------------------------------------------------------- */
/* 6. 出仕（在野主动来投）                                                     */
/* -------------------------------------------------------------------------- */

test('P7 出仕：名声足够时有在野贤才主动来投，并落到籍贯城', () => {
  const { state, st } = oathWorld();
  const n0 = state.generals.length;
  const oldRandom = Math.random;
  Math.random = () => 0;                    // 强制掷骰通过，保证用例确定
  let out = null;
  try {
    out = defectTick(state, cfg, { push() {} });
  } finally {
    Math.random = oldRandom;
  }
  assert.ok(out, '应有人来投');
  assert.equal(state.generals.length, n0 + 1, '帐下应多一人');
  assert.ok(state.generals.some((g) => g.cfgId === out.cfgId), '新将入营');
  const p = state.tavern.people.find((x) => x.cfgId === out.cfgId);
  assert.equal(p.recruited, true, '在野池应标记已出仕');
  const cityIds = Object.entries(st.cities).filter(([, v]) => v.owner === 'player').map(([id]) => Number(id));
  assert.ok(cityIds.includes(out.cityId), '投奔地应是我方城');
});

/* -------------------------------------------------------------------------- */
/* 7. 视图下发                                                                */
/* -------------------------------------------------------------------------- */

test('P7 视图下发：玩家城带民心/治安/四项等级/可出征里程', () => {
  const { state, st } = oathWorld();
  const v = strategyViewState(state, cfg);
  const mine = v.cities.filter((c) => c.owner === 'player');
  assert.ok(mine.length > 0);
  for (const c of mine) {
    assert.equal(typeof c.morale, 'number', `${c.name} 应有民心`);
    assert.equal(typeof c.order, 'number');
    assert.ok(c.lvAgri >= 1 && c.lvAgri <= 5);
    assert.ok(Array.isArray(c.marchRoutes), '应带可出征里程');
  }
  const armies = v.armies.filter((a) => a.cityId > 0);
  assert.ok(armies.length > 0, '队伍应带驻城');
  assert.ok(armies.every((a) => a.speed >= 60), '队伍应带速度');
  void st;
});
