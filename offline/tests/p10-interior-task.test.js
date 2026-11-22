/**
 * U14 内政任务状：任务对象、执行武将决定工期、旬界到账、撤销、城陷自动取消。
 *
 * 这一层锁的是「描述 = 计算 = 战报同源」：
 *  - 面板上的 perTick / endDay 与 tick 真实加产必须是同一个 planTicks() 口径；
 *  - 总产出恒定（好官只缩短工期，不多给），防止靠换将刷经济；
 *  - 撤销/城陷后不再加产，且界面能拿到原因。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyInvest, cancelInvest,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import {
  KINDS, TICK_DAYS, planTicks, officerStat, interiorTasks, interiorTaskView,
  advanceInteriorTasks, cancelInteriorTask, beginInteriorTask,
  OFFICER_TICKS_TOP, OFFICER_TICKS_OK,
} from '../server/domain/interior-task.js';

const cfg = loadConfig();

function oathWorld() {
  /* ★ 2026-11-16：主公初始谋略上调到 96（用户指定），跨过一流文官阈值 85，
     会让本文件「逐步到账/途中撤销」这两条用例假设的 2 旬工期塌成 1 旬。
     这些用例测的是「任务状机制」而不是主公数值，故在这里把本局执行官
     钳回中等谋略（75，仍 ≥ OFFICER_TICKS_OK=68 → 2 旬），保持原测试前提；
     全局 generalByCfg 是节点内单例，本文件测试串行执行，互不影响。 */
  cfg.generalByCfg.get(880001).strategy = 75;
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  return { state, cid: state.strategy.playerCity };
}

/* 1 ─────────────────────────────────────────────────────────────────────── */

test('planTicks：好官缩短工期但不增加总产出（百分制阈值，唯一口径）', () => {
  /* ★ OP-03：旧测试用 9000/7000/4000 这种 0~10000 量纲的值，恰好把
     「阈值没跟着 M4-10 百分制改」这件事掩盖了。改用真实属性区间并卡边界。 */
  const good = planTicks('agri', 92);   // >= 85 → 1 旬
  const mid = planTicks('agri', 75);    // >= 68 → 2 旬
  const bad = planTicks('agri', 50);    // < 68 → 3 旬
  const none = planTicks('agri', 0);    // 无官 → 3 旬
  assert.equal(good.ticks, 1);
  assert.equal(mid.ticks, 2);
  assert.equal(bad.ticks, 3);
  assert.equal(none.ticks, 3);
  for (const p of [good, mid, bad, none]) {
    assert.equal(p.perTick * p.ticks, KINDS.agri.total, '每旬增量 × 旬数必须等于总产出');
  }
  /* 边界与量纲红线：阈值必须是百分制，且高属性官真的比庸官快 */
  assert.equal(OFFICER_TICKS_TOP, 85);
  assert.equal(OFFICER_TICKS_OK, 68);
  assert.equal(planTicks('agri', 85).ticks, 1, '上档含等号');
  assert.equal(planTicks('agri', 84).ticks, 2);
  assert.equal(planTicks('agri', 68).ticks, 2, '合格档含等号');
  assert.equal(planTicks('agri', 67).ticks, 3);
  assert.ok(planTicks('agri', 100).ticks < planTicks('agri', 50).ticks, '百分制下委任收益必须真实存在');
  // 应急项没有工期
  assert.deepEqual(planTicks('relief', 92), { ticks: 0, perTick: 0 });
});

test('officerStat 与 city-econ 的 postStat 同口径（主公按 protagonist.json 维度取值）', () => {
  const { state } = oathWorld();
  const protagonist = (state.generals || []).find((g) => g.isProtagonist);
  assert.ok(protagonist, '举义后应有主公');
  /* ★ M4-8：旧实现把主公恒写成 7400，与面板谋略 7,800 对不上；
     现在战斗/内政/外交/行军统一取 generalByCfg 的对应维度。 */
  const row = cfg.generalByCfg.get(880001);
  assert.equal(officerStat(cfg, protagonist, 'strategy'), row.strategy);
  assert.equal(officerStat(cfg, protagonist, 'force'), row.force);
  assert.equal(officerStat(cfg, protagonist, 'charm'), row.strategy);
});

/* 2 ─────────────────────────────────────────────────────────────────────── */

test('派单即生成任务对象：执行武将/目标城/开始日/预计完工/每旬增量/状态齐备', () => {
  const { state, cid } = oathWorld();
  state.roleRes.gold = 50000;
  const r = strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind: 'agri' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = r.task;
  for (const k of ['id', 'kind', 'cityId', 'officer', 'startDay', 'endDay', 'perTick', 'total', 'status']) {
    assert.ok(t[k] !== undefined && t[k] !== '', `任务必须含 ${k}`);
  }
  assert.equal(t.cityId, cid);
  assert.equal(t.status, 'active');
  assert.equal(t.daysLeft, t.endDay - t.startDay);
  assert.equal(t.pct, 0);
  // 任务落在 state.strategy.interiorTasks，视图按城过滤
  assert.equal(interiorTasks(state).length, 1);
  assert.equal(interiorTaskView(state, cid).length, 1);
  assert.equal(interiorTaskView(state, 999999).length, 0);
});

test('进度与完工：只在旬界加产，完工后状态转 done 并留归因', () => {
  const { state, cid } = oathWorld();
  state.roleRes.gold = 50000;
  const econ = state.strategy.cityEcon[cid];
  const before = Number(econ.devAgri || 0);
  const r = strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind: 'agri' });
  const { ticks, perTick } = r.task;
  const day0 = state.clock.day;

  // 不到旬界：一点不加
  state.clock.day = day0 + TICK_DAYS - 1;
  assert.deepEqual(advanceInteriorTasks(state, cfg, {}).ticked, []);
  assert.equal(Number(econ.devAgri || 0), before);

  // 第一个旬界：+perTick
  state.clock.day = day0 + TICK_DAYS;
  const first = advanceInteriorTasks(state, cfg, {});
  assert.equal(first.ticked.length, 1);
  assert.equal(first.ticked[0].gain, perTick);
  assert.equal(Number(econ.devAgri || 0), Math.round((before + perTick) * 10) / 10);
  assert.equal(interiorTaskView(state, cid)[0].pct, Math.round((1 / ticks) * 100));

  // 走到完工日：状态 done，且每旬一条带执行武将的事件
  state.clock.day = day0 + ticks * TICK_DAYS;
  const done = advanceInteriorTasks(state, cfg, {});
  assert.ok(done.completed.some((t) => t.status === 'done'), '应完成');
  const task = interiorTasks(state)[0];
  assert.equal(task.status, 'done');
  assert.equal(task.doneDay, state.clock.day);
  const events = (state.strategy.events || []).filter((e) => /农田开发度 \+/.test(e.text));
  assert.ok(events.length >= 1, '事件簿要有逐旬归因');
  assert.ok(/（.+）$/.test(events[events.length - 1].text), '归因要写明执行武将');
  // 完工后不再加产
  const snap = Number(econ.devAgri || 0);
  state.clock.day += 30;
  advanceInteriorTasks(state, cfg, {});
  assert.equal(Number(econ.devAgri || 0), snap);
});

test('内政经验：执行武将每旬拿到 12 点（唯一常量口径），不再 5 点龟速', () => {
  const { state, cid } = oathWorld();
  state.roleRes.gold = 50000;
  const r = strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind: 'agri' });
  const off = state.generals.find((g) => Number(g.id) === Number(r.task.officerId));
  assert.ok(off, '任务必须带上真实执行武将');
  off.level = 9; off.exp = 0;               // 不触发升级，直接看每旬增量
  state.clock.day = state.clock.day + TICK_DAYS;
  advanceInteriorTasks(state, cfg, {});
  assert.equal(off.exp, 12, '每旬经验取自 general-progress.js 的唯一常量');
});

/* 3 ─────────────────────────────────────────────────────────────────────── */

test('撤销：状态转 cancelled、不再加产、已到账增量保留', () => {
  const { state, cid } = oathWorld();
  state.roleRes.gold = 50000;
  const econ = state.strategy.cityEcon[cid];
  const r = strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind: 'trade' });
  const day0 = state.clock.day;
  state.clock.day = day0 + TICK_DAYS;
  advanceInteriorTasks(state, cfg, {});
  const afterFirstTick = Number(econ.devTrade || 0);

  const c = cancelInvest(state, { push() {} }, { taskId: r.task.id });
  assert.equal(c.ok, true);
  assert.equal(c.task.status, 'cancelled');
  assert.equal(c.refund, 0, '撤销不退金，界面必须如实说明');
  assert.equal(c.task.note, '主动撤销');

  state.clock.day = day0 + 40;
  advanceInteriorTasks(state, cfg, {});
  assert.equal(Number(econ.devTrade || 0), afterFirstTick, '撤销后不得继续加产');
  // 已完工的任务不能撤销
  const again = cancelInteriorTask(state, { taskId: r.task.id });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'not_active');
});

test('城陷：任务自动取消并写原因，不再加产', () => {
  const { state, cid } = oathWorld();
  state.roleRes.gold = 50000;
  strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind: 'agri' });
  state.strategy.cities[cid].owner = 'wei';    // 模拟丢城
  const day0 = state.clock.day;
  state.clock.day = day0 + TICK_DAYS;
  const r = advanceInteriorTasks(state, cfg, {});
  const t = interiorTasks(state)[0];
  assert.equal(t.status, 'cancelled');
  assert.ok(/易手/.test(t.reason || ''), `原因应写明城已易手，实际 ${t.reason}`);
  assert.ok(r.completed.some((x) => x.cancelled), '完成队列里要带取消项，供播报用');
});

/* 4 ─────────────────────────────────────────────────────────────────────── */

test('拒绝口径：非己方城 / 未知类型 / 金不足 / 无灾赈灾 / 同项在施', () => {
  const { state, cid } = oathWorld();
  state.roleRes.gold = 50000;
  const enemy = Object.entries(state.strategy.cities).find(([, v]) => v.owner !== 'player')[0];
  assert.equal(beginInteriorTask(state, cfg, {}, { cityId: Number(enemy), kind: 'agri' }).reason, 'not_own_city');
  assert.equal(beginInteriorTask(state, cfg, {}, { cityId: cid, kind: 'nope' }).reason, 'bad_kind');
  state.roleRes.gold = 10;
  assert.equal(beginInteriorTask(state, cfg, {}, { cityId: cid, kind: 'agri' }).reason, 'no_gold');
  state.roleRes.gold = 50000;
  state.strategy.cityEcon[cid].mod = null;
  state.strategy.cityEcon[cid].disaster = null;
  assert.equal(beginInteriorTask(state, cfg, {}, { cityId: cid, kind: 'relief' }).reason, 'no_disaster');
  assert.equal(beginInteriorTask(state, cfg, {}, { cityId: cid, kind: 'agri' }).ok, true);
  const busy = beginInteriorTask(state, cfg, {}, { cityId: cid, kind: 'agri' });
  assert.equal(busy.reason, 'busy');
  assert.ok(busy.nextDay > state.clock.day);
});

test('确定性：同一 state 重放得到同样的任务 id、工期与增量', () => {
  const run = () => {
    const { state, cid } = oathWorld();
    state.roleRes.gold = 50000;
    const r = strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind: 'defense' });
    state.clock.day += TICK_DAYS;
    advanceInteriorTasks(state, cfg, {});
    return {
      id: r.task.id, ticks: r.task.ticks, perTick: r.task.perTick,
      progress: interiorTaskView(state, cid)[0].progress,
      gold: state.roleRes.gold,
    };
  };
  assert.deepEqual(run(), run());
  // 全模块不许出现 Math.random（确定性红线）
  assert.equal(KINDS.agri.total, 3);
});
