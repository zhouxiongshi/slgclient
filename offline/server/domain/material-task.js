/**
 * 物资去处任务状（P41 / 2026-11-22）。
 *
 * 目的：把「造军工 / 修城防 / 投农业商业 / 粜粮」从点了立刻扣库存，改成
 *   「选一件事 → 派一位武将 → 按工期办理 → 到期执行原动作」。
 *
 * 硬约束：
 *  - **不改数值**：到期调用 armory.js / failstate.js 的原函数，reserve/cap/汇率一律不动；
 *  - **不提前扣物资**：委派时只记任务，完工时才执行原函数，失败不扣；
 *  - **幂等**：用 ticksDone 与 status 判据，同一天重复推进不会执行两次；
 *  - **零随机**：选人/排序/工期全部确定性，同档重放一致；
 *  - 不 import strategy / city-econ（避免成环），事件直接写 state.strategy.events。
 */

import { materialGuide, craftJungong, smeltStone, investDev } from './armory.js';
import { sellGrain } from './failstate.js';
import { officerStat, OFFICER_TICKS_TOP, OFFICER_TICKS_OK } from './interior-task.js';

export const MATERIAL_TICK_DAYS = 10;

/* 每个动作看重的属性与基准工期；与内政任务共用 0~100 属性口径和官员阈值。 */
const SPEC = {
  craft10: { stat: 'force', ticks: 1 },
  craftDrain: { stat: 'force', ticks: 2 },
  smelt10: { stat: 'force', ticks: 1 },
  smeltDrain: { stat: 'force', ticks: 2 },
  def1: { stat: 'force', ticks: 1 },
  defDrain: { stat: 'force', ticks: 2 },
  agri1: { stat: 'politics', ticks: 1 },
  agriDrain: { stat: 'politics', ticks: 2 },
  trade1: { stat: 'strategy', ticks: 1 },
  tradeDrain: { stat: 'strategy', ticks: 2 },
  sell: { stat: 'charm', ticks: 1 },
};

const STATUS_TEXT = { active: '办理中', done: '已完工', failed: '未办成', cancelled: '已撤销' };

/** 动作→属性键，UI 据此显示「本次按哪项属性算工期」。 */
export const MATERIAL_STAT_OF = Object.fromEntries(Object.entries(SPEC).map(([id, s]) => [id, s.stat]));
export const MATERIAL_STAT_LABEL = { force: '武力', politics: '政治', strategy: '谋略', charm: '魅力' };

const FAIL_TEXT = {
  nothing: '库存不足或已到上限，未扣物资',
  not_enough: '材料不够，未扣物资',
  not_own_city: '目标城已不属于我方，未扣物资',
  dev_capped: '该项开发度已满，未扣物资',
  bad_field: '任务内容已失效，未扣物资',
  no_grain: '粮仓已空，未扣物资',
  turn_cap: '本旬粜粮额度已用尽，未扣物资',
  unknown_action: '任务动作已失效，未扣物资',
};

const dayOf = (state) => Math.max(1, Math.floor(Number(state?.clock?.day) || 1));

function recordEvent(state, text) {
  const st = state?.strategy;
  if (!st) return;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

export function materialTasks(state) {
  const st = state?.strategy;
  if (!st) return [];
  if (!Array.isArray(st.materialTasks)) st.materialTasks = [];
  return st.materialTasks;
}

function cityNameOf(state, id) {
  const row = state?.strategy?.cities?.[Number(id)];
  return row?.name || (Number(id) ? `城${id}` : '本城');
}

/** 工期只受执行武将与基准影响，不改变任何产出量（与内政任务同一阈值）。 */
export function planMaterialTicks(actionId, stat) {
  const base = SPEC[actionId]?.ticks || 1;
  if (!stat) return Math.min(6, Math.ceil(base * 1.5));
  if (stat >= OFFICER_TICKS_TOP) return 1;
  if (stat >= OFFICER_TICKS_OK) return base;
  return Math.min(6, base + 1);
}

/** 可派武将：行军中排除，其余按本任务看重属性降序（同分按 id 保证重放一致）。 */
export function materialOfficers(state, cfg, actionId = '') {
  const statKey = SPEC[actionId]?.stat || 'force';
  const marching = new Set();
  const cityOf = new Map();
  for (const a of state?.armys || []) {
    for (const gid of a.generals || []) {
      if (!gid) continue;
      if (a.marchId) marching.add(Number(gid));
      else if (!cityOf.has(Number(gid))) cityOf.set(Number(gid), Number(a.cityId) || 0);
    }
  }
  return (state?.generals || [])
    .filter((g) => !marching.has(Number(g.id)))
    .map((g) => {
      const stats = Object.fromEntries(Object.keys(MATERIAL_STAT_LABEL).map((k) => [k, Math.round(officerStat(cfg, g, k))]));
      return {
        id: Number(g.id),
        name: cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || g.name || `武将${g.id}`,
        stats, stat: stats[statKey] || 0,
        cityId: Number(g.cityId) || cityOf.get(Number(g.id)) || 0,
      };
    })
    .map((g) => ({ ...g, cityName: cityNameOf(state, g.cityId) }))
    .sort((a, b) => (b.stat - a.stat) || (a.id - b.id));
}

export function materialTaskView(state) {
  const day = dayOf(state);
  const rows = materialTasks(state).filter((t) => t.status === 'active' || t.status === 'done' || t.status === 'failed');
  const live = rows.filter((t) => t.status === 'active');
  const past = rows.filter((t) => t.status !== 'active').slice(-3).reverse();
  return [...live, ...past].map((t) => {
    const doneTicks = Math.min(t.ticks, Math.floor(Math.max(0, day - t.startDay) / MATERIAL_TICK_DAYS));
    return {
      id: t.id, actionId: t.actionId, label: t.actionLabel,
      officerId: t.officerId || 0, officer: t.officerName || '太守亲办', officerStat: t.officerStat || 0,
      cityId: t.cityId || 0, city: cityNameOf(state, t.cityId || 0),
      startDay: t.startDay, endDay: t.startDay + t.ticks * MATERIAL_TICK_DAYS,
      daysLeft: Math.max(0, t.startDay + t.ticks * MATERIAL_TICK_DAYS - day),
      ticks: t.ticks, doneTicks, pct: t.ticks > 0 ? Math.min(100, Math.round(doneTicks / t.ticks * 100)) : 100,
      status: t.status, statusText: STATUS_TEXT[t.status] || t.status,
      note: t.resultText || t.reason || '',
    };
  });
}

function runAction(state, ctx, body) {
  if (body.action === 'craft') return craftJungong(state, ctx, { count: Number(body.count) || 0, drain: !!body.drain });
  if (body.action === 'smeltStone') return smeltStone(state, ctx, { count: Number(body.count) || 0, drain: !!body.drain });
  if (body.action === 'investDev') return investDev(state, ctx, {
    cityId: Number(body.cityId) || 0, field: String(body.field || ''),
    count: Number(body.count) || 0, drain: !!body.drain,
  });
  if (body.action === 'sellGrain') return sellGrain(state, ctx, { grain: Number(body.grain) || 0 });
  return { ok: false, reason: 'unknown_action' };
}

/**
 * 委派。只登记任务，不扣物资；同一 actionId+city 在办期间不能重复下单。
 */
export function beginMaterialTask(state, cfg, ctx, { actionId, officerId, cityId } = {}) {
  const aid = String(actionId || '');
  const action = materialGuide(state).actions.find((a) => a.id === aid);
  if (!action) return { ok: false, message: '没有这项物资任务' };
  const cid = Number(cityId) || Number(state?.strategy?.playerCity) || 0;
  const busy = materialTasks(state).find((t) => t.status === 'active' && t.actionId === aid && Number(t.cityId) === cid);
  if (busy) return { ok: false, message: `「${action.label}」已有一件在办，完工后再派` };
  const oid = Number(officerId) || 0;
  let officer = null;
  if (oid) {
    officer = (state?.generals || []).find((g) => Number(g.id) === oid) || null;
    if (!officer) return { ok: false, message: '找不到该武将' };
    const marching = (state.armys || []).some((a) => a.marchId && (a.generals || []).includes(oid));
    if (marching) return { ok: false, message: '该武将正在行军，不能同时督办物资' };
  }
  const statKey = SPEC[aid]?.stat || 'force';
  const stat = officer ? Math.round(officerStat(cfg, officer, statKey)) : 0;
  const ticks = planMaterialTicks(aid, stat);
  const seq = (state.strategy.materialSeq = (state.strategy.materialSeq || 0) + 1);
  const task = {
    id: `mt${seq}`, actionId: aid, actionLabel: action.label,
    body: { ...(action.body || {}), ...(action.needsCity ? { cityId: cid } : {}) },
    officerId: oid, officerName: officer?.name || '太守亲办', officerStat: stat,
    cityId: cid, startDay: dayOf(state), ticks, ticksDone: 0,
    status: 'active', reason: '玩家委派', cancelable: true,
  };
  materialTasks(state).push(task);
  const endDay = task.startDay + ticks * MATERIAL_TICK_DAYS;
  recordEvent(state, `${task.officerName}领办「${action.label}」，预计 ${ticks * MATERIAL_TICK_DAYS} 日后办结。`);
  return {
    ok: true,
    message: `已委派「${action.label}」给${task.officerName}，预计第 ${endDay} 日完工；物资完工时才扣除`,
    task: materialTaskView(state).find((v) => v.id === task.id),
  };
}

/** 每旬推进（由 strategyTick 在 cityEconTick 之后调用）。到期执行原动作，幂等。 */
export function advanceMaterialTasks(state, cfg, ctx) {
  const day = dayOf(state);
  const done = [];
  const failed = [];
  for (const t of materialTasks(state)) {
    if (t.status !== 'active') continue;
    const should = Math.min(t.ticks, Math.floor(Math.max(0, day - t.startDay) / MATERIAL_TICK_DAYS));
    if (should > (t.ticksDone || 0)) t.ticksDone = should;
    if ((t.ticksDone || 0) < t.ticks) continue;
    const r = runAction(state, ctx, t.body || {});
    if (r.ok) {
      t.status = 'done';
      t.doneDay = day;
      t.resultText = r.text || (r.gold != null ? `粜粮 ${r.grain}，得金 ${r.gold}` : '已办妥');
      done.push(t.id);
    } else {
      t.status = 'failed';
      t.doneDay = day;
      t.resultText = FAIL_TEXT[r.reason] || '办理时条件已变化，未扣物资';
      failed.push(t.id);
    }
    recordEvent(state, `物资任务「${t.actionLabel}」${t.status === 'done' ? '办结' : '未办成'}：${t.resultText}（${t.officerName}）。`);
  }
  return { done, failed };
}

/** 撤销只丢任务，不退还/扣除任何物资（委派时本就没扣）。 */
export function cancelMaterialTask(state, { taskId } = {}) {
  const t = materialTasks(state).find((x) => x.id === String(taskId));
  if (!t) return { ok: false, message: '找不到这项任务' };
  if (t.status !== 'active') return { ok: false, message: '这项任务已经结束' };
  t.status = 'cancelled';
  t.reason = '主动撤销';
  return { ok: true, message: `已撤销「${t.actionLabel}」，没有扣除物资` };
}
