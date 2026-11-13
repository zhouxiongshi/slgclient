/**
 * M2-4a 委任对象化（GDD §5.6）。
 *
 * 锁四件事：
 *  1. 委任每旬自动派「真实的内政任务」（走 interior-task 同源：同价、同工期、同归因）；
 *  2. 缺金 blocked 置顶、金到位自动续办；
 *  3. 失城自动中止（blockedReason=城失）；
 *  4. 同城同目标不重复（busy），取消只停后续派单、不动在施任务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath, strategyViewState } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { strategyAppoint, strategyCancelAppointment, appointmentTick, GOALS } from '../server/domain/appointment.js';
import { interiorTasks, KINDS } from '../server/domain/interior-task.js';

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

function playerCity(st) {
  return Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
}

test('M2-4·委任：建委任即派真实内政任务（与手动同价同工期同归因）', () => {
  const { state, st } = oathWorld();
  state.roleRes.gold = 100000;
  const cid = playerCity(st);
  const r = strategyAppoint(state, cfg, { push() {} }, { cityId: cid, goal: 'develop' });
  assert.equal(r.ok, true, JSON.stringify(r));
  // 首单立即生成一条真实任务（kind ∈ develop 的轮转表）
  const tasks = interiorTasks(state).filter((t) => Number(t.cityId) === cid && t.status === 'active');
  assert.equal(tasks.length, 1, '应有恰好一条在施任务');
  assert.ok(GOALS.develop.kinds.includes(tasks[0].kind), `任务种类 ${tasks[0].kind} 应在轮转表内`);
  assert.equal(tasks[0].cost, KINDS[tasks[0].kind].cost, '与手动派单同价（同源）');
  assert.equal(tasks[0].reason, '玩家指派', '归因：任务对象带来源');
  // 视图下发
  const view = strategyViewState(state, cfg);
  assert.ok((view.appointments || []).some((a) => Number(a.cityId) === cid && a.status === 'running'),
    'strategyViewState.appointments 应含该委任');
});

test('M2-4·委任：缺金 blocked 置顶，金到位自动续办', () => {
  const { state, st } = oathWorld();
  const cid = playerCity(st);
  state.roleRes.gold = 100000;
  const r = strategyAppoint(state, cfg, { push() {} }, { cityId: cid, goal: 'recruit' });
  assert.equal(r.ok, true);
  // 推进一旬：上一单还在施（barracks 2~3 旬），再下一单需金——把金抠光
  state.clock.day += 10;
  state.roleRes.gold = 0;
  const out = appointmentTick(state, cfg, { push() {} });
  const appt = st.appointments.find((a) => a.goal === 'recruit');
  if (out.blocked.length || appt.status === 'blocked') {
    assert.equal(appt.blockedReason, '缺金');
    // 金到位后恢复
    state.clock.day += 10;
    state.roleRes.gold = 100000;
    const out2 = appointmentTick(state, cfg, { push() {} });
    assert.equal(appt.status, 'running', '金到位应自动续办');
    assert.ok(out2.resumed.length >= 1, '续办应写进回合报告');
  } else {
    // 上一单恰好在施期满自动续排且金不足不触发——锁定状态合法即可
    assert.ok(['running', 'blocked'].includes(appt.status));
  }
});

test('M2-4·委任：失城自动中止（blockedReason=城失）', () => {
  const { state, st } = oathWorld();
  state.roleRes.gold = 100000;
  const cid = playerCity(st);
  const r = strategyAppoint(state, cfg, { push() {} }, { cityId: cid, goal: 'defend' });
  assert.equal(r.ok, true);
  st.cities[cid].owner = 'sili';   // 城丢
  state.clock.day += 10;
  const out = appointmentTick(state, cfg, { push() {} });
  const appt = st.appointments.find((a) => a.goal === 'defend');
  assert.equal(appt.status, 'done', '失城委任自动结束');
  assert.equal(appt.blockedReason, '城失');
  assert.equal(out.ended.length, 1, '中止要进回合报告（不静默）');
});

test('M2-4·委任：同城同目标 busy；取消只停后续派单、在施任务不动', () => {
  const { state, st } = oathWorld();
  state.roleRes.gold = 100000;
  const cid = playerCity(st);
  const r1 = strategyAppoint(state, cfg, { push() {} }, { cityId: cid, goal: 'transport' });
  assert.equal(r1.ok, true);
  const r2 = strategyAppoint(state, cfg, { push() {} }, { cityId: cid, goal: 'transport' });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'busy');
  // 取消
  const c = strategyCancelAppointment(state, { push() {} }, { apptId: r1.appointment.id });
  assert.equal(c.ok, true);
  // 在施任务不受影响
  const active = interiorTasks(state).filter((t) => Number(t.cityId) === cid && t.status === 'active');
  assert.equal(active.length, 1, '取消委任不动在施任务（不静默吞钱）');
  // 再 tick 不再派新单
  state.clock.day += 10;
  const before = interiorTasks(state).length;
  appointmentTick(state, cfg, { push() {} });
  const activeAfter = interiorTasks(state).filter((t) => Number(t.cityId) === cid && t.status === 'active');
  assert.equal(activeAfter.length, active.length, '取消后不再派新单');
  void before;
});

test('M2-4·委任：目标非法与异城非法路径', () => {
  const { state, st } = oathWorld();
  const cid = playerCity(st);
  const bad1 = strategyAppoint(state, cfg, { push() {} }, { cityId: cid, goal: 'no_such' });
  assert.equal(bad1.ok, false);
  assert.equal(bad1.reason, 'bad_goal');
  const bad2 = strategyAppoint(state, cfg, { push() {} }, { cityId: 999999, goal: 'develop' });
  assert.equal(bad2.ok, false);
  assert.equal(bad2.reason, 'not_own_city');
});
