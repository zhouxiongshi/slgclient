/**
 * P8 出征面板与试玩 22 项缺陷的回归。
 *
 * 覆盖：
 *  1. 可出征列表不再含己方城（bug-4）
 *  2. 出兵按「实出兵力」扣粮，返回 deploy/troops/armyId（bug-5）
 *  3. 撤回在途队伍：解锁归城、退一半粮；运输队退八成；已到城下不可撤
 *  4. army.dispose 校验城归属 / 武将存在 / 行军锁（bug-1/2/3）
 *  5. army.conscript 行军锁（bug-2）
 *  6. city.upFacility 校验归属且失败带 msg（bug-7/9）
 *  7. 分城有自己的一套设施（bug-6/21）
 *  8. interior.collect 按城结算、失败带 msg（bug-8/11）
 *  9. 未知协议消息回 404（bug-22）
 * 10. 行军上限放宽到 40 日（bug-17）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyAttack, strategyViewState,
  strategyRecallMarch, strategyTransport, marchableFrom, marchDaysBy,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, options: {}, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    save() {}, log() {},
  };
}

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  const lord = oathOptions(state).lords.filter((l) => l.cities.length >= 2)[0];
  const r = chooseOath(state, cfg, { push() {} }, { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true, '举义应成功');
  const st = state.strategy;
  const own = Object.entries(st.cities)
    .filter(([, v]) => v.owner === 'player')
    .map(([id]) => Number(id));
  return { state, st, own };
}

/** 找一座「己方出发城 + 敌方邻城」，并把一支部队放到出发城。 */
function pickBattlefield(state, st, own) {
  for (const id of own) {
    const target = marchableFrom(id, state).find((n) => st.cities[n]?.owner !== 'player');
    if (!target) continue;
    const army = state.armys.find((a) => (a.soldiers || []).some((n) => n > 0));
    army.cityId = id;
    army.soldiers = [600, 200, 200];
    army.generals = [state.generals[0].id, 0, 0];
    return { from: id, target, army };
  }
  return null;
}

/* ---------------- 1. 可出征列表 ---------------- */

test('P8 可出征列表不含己方城（bug-4）', () => {
  const { state, st, own } = oathWorld();
  assert.ok(own.length >= 2, '举义至少拿到两座城');
  for (const id of own) {
    const raw = marchableFrom(id);
    const filtered = marchableFrom(id, state);
    assert.equal(raw.some((n) => own.includes(n)), true, '原始邻接里本来就有己方城');
    assert.equal(filtered.some((n) => own.includes(n)), false, '过滤后不应出现己方城');
    const view = strategyViewState(state, cfg).cities.find((c) => c.id === id);
    assert.equal((view.marchable || []).some((n) => own.includes(n)), false,
      `${view.name} 的可出征列表夹带己方城`);
  }
  void st;
});

/* ---------------- 2. 实出兵力与粮草 ---------------- */

test('P8 出兵按实出兵力扣粮，并回传队伍与人数（bug-5）', () => {
  const { state, st, own } = oathWorld();
  ensureCityEcon(state);            // 城库要先存在，否则扣粮会顺手建一份 2000 的城库
  const field = pickBattlefield(state, st, own);
  assert.ok(field, '应能找到可打的目标');
  const total = field.army.soldiers.reduce((s, v) => s + v, 0);
  const before = state.roleRes.grain + (state.strategy.cityEcon?.[field.from]?.store || 0);
  const r = strategyAttack(state, cfg, { push() {} }, {
    cityId: field.target, fromCityId: field.from, armyId: field.army.id, frac: 0.5,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.armyId, field.army.id, '回传实际出征队伍');
  assert.equal(r.troops, total, '回传队伍总兵力');
  assert.equal(r.deploy, Math.round(total * 0.5), '实出 = 队伍兵力 × 比例');
  assert.equal(r.grainCost, Math.ceil(r.deploy * 0.1), '粮草按实出人数算，不按整队');
  const after = state.roleRes.grain + (state.strategy.cityEcon?.[field.from]?.store || 0);
  assert.equal(before - after, r.grainCost, '扣除的粮与回报一致');
  assert.equal(st.marches[0].troops, r.deploy, '行军记录带实出兵力');
});

/* ---------------- 3. 撤回 ---------------- */

test('P8 撤回在途队伍：解锁归城、退一半粮、不可重复撤（出征面板）', () => {
  const { state, st, own } = oathWorld();
  const field = pickBattlefield(state, st, own);
  const r = strategyAttack(state, cfg, { push() {} }, {
    cityId: field.target, fromCityId: field.from, armyId: field.army.id, frac: 1,
  });
  assert.equal(r.ok, true);
  const marchId = r.marchId;
  assert.equal(field.army.marchId, marchId, '出征锁队');

  state.clock.day = r.arriveDay - 1;   // 途中
  const goldBefore = state.roleRes.grain;
  const back = strategyRecallMarch(state, cfg, { push() {} }, { marchId });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.refund, Math.round(r.grainCost * 0.5), '退一半行军粮');
  assert.equal(state.roleRes.grain, goldBefore + back.refund, '粮回府库');
  assert.equal(field.army.marchId, undefined, '队伍解锁');
  assert.equal(field.army.cityId, field.from, '队伍回到出发城');
  assert.equal(st.marches.some((m) => m.id === marchId), false, '队列里不再有这条行军');

  const again = strategyRecallMarch(state, cfg, { push() {} }, { marchId });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'no_march');
});

test('P8 已抵达城下的队伍不能撤回（避免抢结算）', () => {
  const { state, st, own } = oathWorld();
  const field = pickBattlefield(state, st, own);
  const r = strategyAttack(state, cfg, { push() {} }, {
    cityId: field.target, fromCityId: field.from, armyId: field.army.id, frac: 1,
  });
  assert.equal(r.ok, true);
  state.clock.day = r.arriveDay;
  const back = strategyRecallMarch(state, cfg, { push() {} }, { marchId: r.marchId });
  assert.equal(back.ok, false);
  assert.equal(back.reason, 'already_arrived');
  assert.ok(field.army.marchId, '队伍仍锁着，等结算');
});

test('P8 撤回运输队：粮车折返，八成回府库', () => {
  const { state, st, own } = oathWorld();
  const from = own[0];
  const to = own.find((id) => id !== from)
    || Number(Object.entries(st.cities).find(([, v]) => v.owner === 'player')[0]);
  assert.ok(to && to !== from, '需要两座己方城');
  state.roleRes.grain = 50000;
  const t = strategyTransport(state, cfg, { push() {} }, { cityId: to, fromCityId: from, grain: 1000 });
  assert.equal(t.ok, true, JSON.stringify(t));
  const before = state.roleRes.grain;
  const back = strategyRecallMarch(state, cfg, { push() {} }, { marchId: t.marchId });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.refund, 800, '退八成');
  assert.equal(state.roleRes.grain, before + 800);
  assert.equal(st.marches.some((m) => m.id === t.marchId), false);
});

/* ---------------- 4/5. 编队与征兵的校验 ---------------- */

test('P8 编队：拒绝敌方城 / 不存在的城 / 不存在的武将 / 行军中（bug-1/2/3）', () => {
  const { state, st, own } = oathWorld();
  const ctx = makeCtx(state);
  const enemy = Object.entries(st.cities).find(([, v]) => v.owner !== 'player');
  const enemyId = Number(enemy[0]);

  const rEnemy = handleRequest(ctx, req('army.dispose', { cityId: enemyId, order: 1, position: 0, generalId: state.generals[0].id }));
  assert.notEqual(rEnemy.code, 0, '敌方城不能编队');
  assert.equal(rEnemy.msg.reason, 'not_own_city');

  const rGhost = handleRequest(ctx, req('army.dispose', { cityId: 88888, order: 1, position: 0, generalId: state.generals[0].id }));
  assert.notEqual(rGhost.code, 0, '不存在的城不能编队');
  assert.equal(rGhost.msg.reason, 'not_own_city');

  const rBadGen = handleRequest(ctx, req('army.dispose', { cityId: own[0], order: 1, position: 0, generalId: 999999 }));
  assert.notEqual(rBadGen.code, 0, '不存在的武将不能入队');
  assert.equal(rBadGen.msg.reason, 'bad_general');

  // 行军中：先出征锁队，再试图改编
  const field = pickBattlefield(state, st, own);
  const atk = strategyAttack(state, cfg, { push() {} }, {
    cityId: field.target, fromCityId: field.from, armyId: field.army.id, frac: 1,
  });
  assert.equal(atk.ok, true);
  const rMarching = handleRequest(ctx, req('army.dispose', {
    cityId: field.from, order: field.army.order, position: 1, generalId: 0,
  }));
  assert.notEqual(rMarching.code, 0, '行军中的队伍不能改编');
  assert.equal(rMarching.msg.reason, 'marching');

  const rConscript = handleRequest(ctx, req('army.conscript', {
    armyId: field.army.id, cnts: [10, 0, 0],
  }));
  assert.notEqual(rConscript.code, 0, '行军中的队伍不能征兵');
  assert.equal(rConscript.msg.reason, 'marching');
});

/* ---------------- 6/7. 设施 ---------------- */

test('P8 设施：敌方城不能升级且失败带 msg；分城有自己的设施（bug-6/7/9/21）', () => {
  const { state, st, own } = oathWorld();
  const ctx = makeCtx(state);
  const enemyId = Number(Object.entries(st.cities).find(([, v]) => v.owner !== 'player')[0]);

  const bad = handleRequest(ctx, req('city.upFacility', { cityId: enemyId, fType: 19 }));
  assert.notEqual(bad.code, 0, '敌方城不能修设施');
  assert.equal(bad.msg.reason, 'not_own_city');

  const nonOwn = own.find((id) => id !== st.playerCity);
  assert.ok(nonOwn, '应有非首都的己方城');
  const street = handleRequest(ctx, req('city.facilities', { cityId: nonOwn }));
  assert.equal(street.code, 0);
  assert.ok(street.msg.facilities.length > 0, '分城也应有设施列表');

  state.roleRes.wood = 999999; state.roleRes.iron = 999999;
  state.roleRes.stone = 999999; state.roleRes.grain = 999999;
  const up = handleRequest(ctx, req('city.upFacility', { cityId: nonOwn, fType: 19 }));
  assert.equal(up.code, 0, JSON.stringify(up.msg));
  assert.ok(up.msg.facility.up_time > 0, '分城设施进入工期');

  const dup = handleRequest(ctx, req('city.upFacility', { cityId: nonOwn, fType: 19 }));
  assert.equal(dup.code, 12);
  assert.equal(dup.msg.reason, 'upgrading', '失败必须带可读原因');

  const noSuch = handleRequest(ctx, req('city.upFacility', { cityId: nonOwn, fType: 9999 }));
  assert.equal(noSuch.code, 12);
  assert.equal(noSuch.msg.reason, 'no_such_facility');
});

/* ---------------- 8. 征收 ---------------- */

test('P8 征收按城结算，两座城各收各的；超次带 msg（bug-8/11）', () => {
  const { state, st, own } = oathWorld();
  ensureCityEcon(state);
  const ctx = makeCtx(state);
  const [a, b] = own;
  assert.ok(a && b, '需要两座己方城');

  const g0 = state.roleRes.gold;
  const r1 = handleRequest(ctx, req('interior.collect', { cityId: a }));
  assert.equal(r1.code, 0, JSON.stringify(r1.msg));
  assert.ok(r1.msg.gold > 0, '征收应有金入账');
  assert.equal(state.roleRes.gold, g0 + r1.msg.gold);

  const r2 = handleRequest(ctx, req('interior.collect', { cityId: b }));
  assert.equal(r2.code, 0, '另一座城应能独立征收');
  assert.equal(state.roleRes.gold, g0 + r1.msg.gold + r2.msg.gold, '两城各收一份');

  const r3 = handleRequest(ctx, req('interior.collect', { cityId: a }));
  assert.equal(r3.code, 56, '同城冷却中');
  assert.equal(r3.msg.reason, 'cooldown', '失败要能说明是冷却');
  assert.ok(r3.msg.waitSec >= 0);

  const enemyId = Number(Object.entries(st.cities).find(([, v]) => v.owner !== 'player')[0]);
  const r4 = handleRequest(ctx, req('interior.collect', { cityId: enemyId }));
  assert.equal(r4.msg.reason, 'not_own_city', '敌方城不能征收');
});

/* ---------------- 9/10. 协议与行军上限 ---------------- */

test('P8 未知协议消息回 404（bug-22）', () => {
  const { state } = oathWorld();
  const ctx = makeCtx(state);
  const r = handleRequest(ctx, req('no.such.message', {}));
  assert.equal(r.code, 404);
  assert.equal(r.msg.reason, 'unknown_message');
});

test('P8 行军日数上限放宽到 40 日，长途不再和邻城同耗时（bug-17）', () => {
  assert.equal(marchDaysBy(99999, 20), 40);
  assert.ok(marchDaysBy(1200, 100) > marchDaysBy(110, 100) * 5, '跨州远征显著更久');
});
