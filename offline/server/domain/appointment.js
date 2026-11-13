/**
 * 委任对象化（GDD §5.6）：「我不用管，但我知道它在干什么」，不是「我不用玩」。
 *
 * - appointment = { id, officerId, cityId, goal, startTurn, status, blockedReason, lastTaskId, ... }
 * - 每旬自动生成一条**真实的内政任务**（走 interior-task.beginInteriorTask，不另写逻辑），
 *   所以委任产出与手动操作完全同源；归因事件照常写「谁让哪座城涨了多少」。
 * - 缺资源时 status='blocked'（缺金），报告里置顶，不静默跳过；金恢复后自动续办。
 * - 城丢失 → 委任自动结束，写一条「XX 失城，委任中止」。
 * - **不做一键结算整月**：那会让玩家失去归因，也让撤销失去意义。
 *
 * 硬约束：只 import interior-task（其本身只依赖 economy/oath/march 叶子），无环；
 * 确定性：不掷骰、不用 Math.random；同一 state 重放得到同样的委任决策。
 */

import { beginInteriorTask, interiorTasks, pickOfficer, KINDS } from './interior-task.js';

/** 委任目标 → 内政任务种类的轮转顺序（同源口径：goal 的产出 = 这些 KIND 的产出）。 */
export const GOALS = {
  develop: { label: '劝农商', kinds: ['agri', 'trade'], desc: '开垦/招商轮转，抬农田与市集开发度' },
  recruit: { label: '缮甲兵', kinds: ['barracks'], desc: '募兵整编，抬兵营开发度与征兵效率' },
  defend:  { label: '固城防', kinds: ['defense'], desc: '修筑城防，抬城防与守备' },
  transport: { label: '屯军粮', kinds: ['tuntian'], desc: '屯田积谷，抬农田并直接入城库' },
};

/** 委任数组（挂在 state.strategy.appointments，旧档自动补空数组）。 */
export function appointments(state) {
  const st = state?.strategy;
  if (!st) return [];
  if (!Array.isArray(st.appointments)) st.appointments = [];
  return st.appointments;
}

/** 委任展示形态（面板/视图共用）。 */
export function appointmentView(state, a) {
  const st = state.strategy;
  const G = GOALS[a.goal] || {};
  const last = a.lastTaskId
    ? interiorTasks(state).find((t) => t.id === a.lastTaskId)
    : null;
  return {
    id: a.id, cityId: a.cityId, city: st.cities?.[a.cityId]?.name || a.cityName || '',
    goal: a.goal, goalLabel: G.label || a.goal, goalDesc: G.desc || '',
    officerId: a.officerId || 0, officer: a.officerName || '',
    startTurn: a.startTurn, startDay: a.startDay,
    status: a.status, blockedReason: a.blockedReason || null,
    lastTaskId: a.lastTaskId || 0, lastKind: a.lastKind || '',
    lastTaskLabel: last ? (KINDS[last.kind]?.label || last.kind) : '',
    doneCount: a.doneCount || 0,
  };
}

/** 全部委任（blocked 置顶——GDD §5.6「缺资源置顶报告，不静默跳过」）。 */
export function appointmentListView(state) {
  const day = Math.floor(Number(state?.clock?.day) || 1);
  const all = appointments(state).filter((a) => a.status !== 'cancelled');
  const order = { blocked: 0, running: 1, done: 2 };
  return all
    .map((a) => ({ ...appointmentView(state, a), daysOn: Math.max(0, day - a.startDay) }))
    .sort((x, y) => (order[x.status] ?? 3) - (order[y.status] ?? 3) || x.id.localeCompare(y.id));
}

/**
 * 建委任。返回 { ok, appointment } 或 { ok:false, reason }。
 * reason: not_own_city / bad_goal / no_econ
 */
export function strategyAppoint(state, cfg, ctx, { cityId, goal }) {
  const st = state?.strategy;
  const id = Number(cityId);
  if (!st?.cities?.[id] || st.cities[id].owner !== 'player') return { ok: false, reason: 'not_own_city' };
  if (!GOALS[goal]) return { ok: false, reason: 'bad_goal' };
  if (!st.cityEcon?.[id]) return { ok: false, reason: 'no_econ' };
  // 同城同目标已有在办委任则拒绝（界面置灰即可，不静默覆盖）
  const dup = appointments(state).find((a) => a.cityId === id && a.goal === goal && a.status === 'running');
  if (dup) return { ok: false, reason: 'busy', appointment: appointmentView(state, dup) };

  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const officer = pickOfficer(state, cfg, id, 'strategy');
  const a = {
    id: `ap${(st.appointSeq = (st.appointSeq || 0) + 1)}`,
    officerId: officer?.id || 0, officerName: officer?.name || '',
    cityId: id, cityName: st.cities[id].name || `城${id}`,
    goal, startTurn: st.turn, startDay: day,
    status: 'running', blockedReason: null,
    lastTaskId: 0, lastKind: '', doneCount: 0,
  };
  appointments(state).push(a);
  const first = runOne(state, cfg, ctx, a);
  recordAppt(state, a, `委任${GOALS[goal].label}于${a.cityName}（${officer?.name || '太守亲办'}）：${GOALS[goal].desc}。`);
  if (!first.ok) recordAppt(state, a, firstReasonText(first.reason, KINDS[GOALS[goal].kinds[0]]?.cost));
  ctx?.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【内政】${a.cityName}委任「${GOALS[goal].label}」：${GOALS[goal].desc}。`,
    time: Date.now(),
  });
  return { ok: true, appointment: appointmentView(state, a), first };
}

function recordAppt(state, a, text) {
  const st = state.strategy;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

function firstReasonText(reason, cost) {
  if (reason === 'no_gold') return `委任受阻：库金不足（该项需 ${cost} 金），金到位后自动续办。`;
  if (reason === 'busy' || reason === 'cooldown') return '委任受理：同项任务在施，完工后自动续办。';
  return `委任受理：首项暂缓（${reason}）。`;
}

/** 给一个委任派下一单（真实走 beginInteriorTask，与手动操作同源同价同工期）。 */
function runOne(state, cfg, ctx, a) {
  const G = GOALS[a.goal];
  if (!G) return { ok: false, reason: 'bad_goal' };
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  // 轮转：先挑「目标种类里没有在施任务」的项；都忙就等（在施本身就是在干活）
  const active = new Set(
    interiorTasks(state).filter((t) => t.status === 'active' && Number(t.cityId) === a.cityId).map((t) => t.kind),
  );
  let kind = G.kinds.find((k) => !active.has(k));
  if (!kind) return { ok: false, reason: 'busy' };
  const r = beginInteriorTask(state, cfg, ctx, { cityId: a.cityId, kind });
  if (!r.ok) return r;
  a.lastTaskId = r.task.id;
  a.lastKind = kind;
  a.lastStartDay = day;
  return r;
}

/**
 * 每旬推进（由 cityEconTick 在旬界调用）。
 * 返回 { started, blocked, resumed, ended } 供回合报告引用。
 */
export function appointmentTick(state, cfg, ctx) {
  const list = appointments(state);
  if (!list.length) return { started: [], blocked: [], resumed: [], ended: [] };
  const st = state.strategy;
  const out = { started: [], blocked: [], resumed: [], ended: [] };
  for (const a of list) {
    if (a.status === 'done' || a.status === 'cancelled') continue;
    const row = st.cities?.[a.cityId];
    // 城丢失 → 委任自动结束（GDD §5.6 硬规则）
    if (!row || row.owner !== 'player') {
      a.status = 'done';
      a.blockedReason = '城失';
      recordAppt(state, a, `${a.cityName}失城，委任「${GOALS[a.goal]?.label || a.goal}」中止。`);
      out.ended.push(appointmentView(state, a));
      continue;
    }
    // blocked 自动续办：金到位后重试
    if (a.status === 'blocked') {
      const r = runOne(state, cfg, ctx, a);
      if (r.ok) {
        a.status = 'running';
        a.blockedReason = null;
        a.doneCount = (a.doneCount || 0) + 1;
        out.resumed.push(appointmentView(state, a));
        recordAppt(state, a, `${a.cityName}委任恢复：库金到位，续办${KINDS[r.task.kind]?.label || ''}。`);
      }
      continue;
    }
    const r = runOne(state, cfg, ctx, a);
    if (r.ok) {
      a.doneCount = (a.doneCount || 0) + 1;
      out.started.push(appointmentView(state, a));
    } else if (r.reason === 'no_gold') {
      a.status = 'blocked';
      a.blockedReason = '缺金';
      out.blocked.push(appointmentView(state, a));
      recordAppt(state, a, `${a.cityName}委任受阻：库金不足，暂停派单（在施任务不受影响）。`);
    }
    // busy / cooldown：上一单还在施，委任照常运行，不写报告（避免刷屏）
  }
  return out;
}

/** 取消委任（只停「以后自动派单」；在施任务不撤，已投入的照常推进——不静默吞钱）。 */
export function strategyCancelAppointment(state, ctx, { apptId }) {
  const a = appointments(state).find((x) => x.id === String(apptId));
  if (!a) return { ok: false, reason: 'no_appointment' };
  if (a.status !== 'running' && a.status !== 'blocked') return { ok: false, reason: 'not_active' };
  a.status = 'cancelled';
  a.blockedReason = null;
  recordAppt(state, a, `${a.cityName}委任「${GOALS[a.goal]?.label || a.goal}」取消（在施任务照常推进）。`);
  return { ok: true, appointment: appointmentView(state, a) };
}
