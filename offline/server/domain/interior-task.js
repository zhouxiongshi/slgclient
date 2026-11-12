/**
 * 内政任务状（U14）：把「开垦/招商/募兵/修城/赈灾」从瞬时结算改成**任务对象**。
 *
 * 设计依据：交互原型提示词 6.7 —— 内政必须是
 *   `{执行武将, 目标城, 开始回合, 预计完成, 每回合增量, 消耗, 状态}`
 * 有进度、有反馈、有归因（「长安开垦 +1.5（荀彧·政治 96）」），而不是点一下数字就变。
 *
 * 硬约束：
 *  - **零内部依赖**：不 import strategy / city-econ / panels，只读 state 与 cfg，写事件走 economy.js。
 *    这样 city-econ（每旬 tick 调用本模块）与 strategy（开局/派单调用本模块）都不会成环。
 *  - **总产出不变**：旧版一次 +3，现在拆成 N 旬累计 +3；好官缩短工期、不改变总量，
 *    避免"点了内政经济就通胀"的平衡漂移。
 *  - **确定性**：不掷骰、不用 Math.random；同一 state 重放得到同样的任务与进度。
 *  - **描述=计算同源**：面板文案、预计完工日、每旬增量全部出自本文件的 KINDS 与同一个 plan()。
 */

import { recordRes } from './economy.js';

/**
 * 事件簿追加（与 strategy.js 的 recordEvent 同形）。
 * 这里**不 import strategy**（否则 city-econ → interior-task → strategy 成环），
 * 直接写同一个 state.strategy.events 数组，上限 480 条保持一致。
 */
function recordEvent(state, text) {
  const st = state?.strategy;
  if (!st) return;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

/** 每旬天数（与 cityEconTick 的 10 日结算节奏一致）。 */
export const TICK_DAYS = 10;

/**
 * 任务模板。
 *  total  = 完工时累计加多少（开发度按点，troops 按兵）
 *  ticks  = 基准工期（几个旬）；officer 越好越少，见 planTicks()
 *  instant= 立即生效（赈灾是应急，等不起两旬）
 */
export const KINDS = {
  agri: {
    label: '开垦', cost: 300, field: 'devAgri', total: 3, ticks: 2, stat: 'strategy',
    note: '农田开发度', effectText: '农田开发度 +3',
  },
  trade: {
    label: '招商', cost: 300, field: 'devTrade', total: 3, ticks: 2, stat: 'strategy',
    note: '市集开发度', effectText: '市集开发度 +3',
  },
  barracks: {
    label: '募兵整编', cost: 350, field: 'devArms', total: 3, ticks: 2, stat: 'defense',
    morale: 1, note: '兵营开发度', effectText: '兵营开发度 +3、民心 +1',
  },
  defense: {
    label: '修城', cost: 400, field: 'devDef', total: 2, ticks: 2, stat: 'force',
    order: 2, troops: 150, note: '城防', effectText: '城防 +2、治安 +2、守军 +150',
  },
  relief: {
    label: '赈灾', cost: 500, field: null, total: 0, ticks: 0, stat: 'strategy', instant: true,
    note: '应急', effectText: '开仓赈济：减产解除，民心 +6、治安 +3（立即）',
  },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

/** 任务数组（挂在 state.strategy.interiorTasks，旧档自动补空数组）。 */
export function interiorTasks(state) {
  const st = state?.strategy;
  if (!st) return [];
  if (!Array.isArray(st.interiorTasks)) st.interiorTasks = [];
  return st.interiorTasks;
}

/** 武将属性（0~10000）。与 city-econ 的 postStat 同口径，但本模块不依赖它。 */
export function officerStat(cfg, g, key) {
  if (!g) return 0;
  const base = g.isProtagonist ? 7400 : Number(cfg?.generalByCfg?.get?.(Number(g.cfgId))?.[key]) || 6000;
  return base + (Number(g[`${key}_added`]) || 0);
}

/**
 * 该城当前可派的执行武将：驻城（非行军）队伍里属性最高者。
 * 无官可派也允许派单，只是工期变成基准的 1.5 倍——界面要写明原因，不能静默变慢。
 */
export function pickOfficer(state, cfg, cityId, key) {
  const cid = Number(cityId);
  const marching = new Set();
  for (const a of state.armys || []) {
    if (a.marchId) for (const gid of a.generals || []) if (gid) marching.add(Number(gid));
  }
  let best = null;
  let bestStat = -1;
  for (const a of state.armys || []) {
    if (Number(a.cityId) !== cid || a.marchId) continue;
    for (const gid of a.generals || []) {
      if (!gid || marching.has(Number(gid))) continue;
      const g = (state.generals || []).find((x) => Number(x.id) === Number(gid));
      if (!g) continue;
      const s = officerStat(cfg, g, key);
      if (s > bestStat) { best = g; bestStat = s; }
    }
  }
  if (!best) return null;
  const name = cfg?.generalByCfg?.get?.(Number(best.cfgId))?.name || `武将${best.id}`;
  return { id: best.id, name, stat: Math.round(bestStat) };
}

/**
 * 工期与每旬增量（唯一口径，面板与 tick 共用）。
 *  stat >= 8600（一流文官）→ 1 旬；>= 6800（合格）→ 基准 2 旬；否则 3 旬；无官 → 基准 ×1.5 = 3 旬。
 *  阈值只影响工期，不影响总产出——「官好办得快」而不是「官好给得多」，避免经济通胀。
 */
export function planTicks(kind, stat) {
  const K = KINDS[kind];
  if (!K || K.instant) return { ticks: 0, perTick: 0 };
  let ticks = K.ticks;
  if (!stat) ticks = Math.ceil(K.ticks * 1.5);
  else if (stat >= 8600) ticks = 1;
  else if (stat >= 6800) ticks = K.ticks;
  else ticks = K.ticks + 1;
  ticks = clamp(ticks, 1, 6);
  return { ticks, perTick: Math.round((K.total / ticks) * 100) / 100 };
}

/** 任务的展示形态（面板/聚合层/战报共用，避免三处各算一遍）。 */
export function taskView(state, t) {
  const day = Math.floor(Number(state?.clock?.day) || 1);
  const K = KINDS[t.kind] || {};
  const elapsed = Math.max(0, day - t.startDay);
  const doneTicks = Math.min(t.ticks, Math.floor(elapsed / TICK_DAYS));
  const pct = t.ticks > 0 ? Math.min(100, Math.round((doneTicks / t.ticks) * 100)) : 100;
  return {
    id: t.id, kind: t.kind, label: K.label || t.kind, cityId: t.cityId, city: t.cityName,
    officerId: t.officerId || 0, officer: t.officerName || '无专员',
    officerStat: t.officerStat || 0,
    startDay: t.startDay, endDay: t.startDay + t.ticks * TICK_DAYS,
    daysLeft: Math.max(0, t.startDay + t.ticks * TICK_DAYS - day),
    ticks: t.ticks, doneTicks, pct,
    perTick: t.perTick, total: t.total,
    progress: Math.round((Math.min(t.ticks, doneTicks) * t.perTick) * 100) / 100,
    status: t.status, cost: t.cost, effectText: K.effectText || '',
    note: t.reason || '',
  };
}

/** 某城任务的展示列表（进行中在前，已完工只留最近 3 条）。 */
export function interiorTaskView(state, cityId = 0) {
  const cid = Number(cityId) || 0;
  const all = interiorTasks(state).filter((t) => !cid || Number(t.cityId) === cid);
  const live = all.filter((t) => t.status === 'active').map((t) => taskView(state, t));
  const past = all.filter((t) => t.status !== 'active').slice(-3).reverse().map((t) => taskView(state, t));
  return [...live, ...past];
}

/** 把一项增量写进该城经营对象（带上限，与旧版一致：开发度 120，民心/治安 100）。 */
function applyGain(state, e, t, ratio) {
  const K = KINDS[t.kind];
  if (!K || !e) return;
  if (K.field) {
    const cap = K.field === 'morale' ? 100 : 120;
    e[K.field] = Math.round(Math.min(cap, Number(e[K.field] || 0) + (K.total / t.ticks) * ratio) * 10) / 10;
  }
  if (K.morale) e.morale = Math.round(Math.min(100, Number(e.morale ?? 60) + (K.morale / t.ticks) * ratio) * 10) / 10;
  if (K.order) e.order = Math.round(Math.min(100, Number(e.order ?? 60) + (K.order / t.ticks) * ratio) * 10) / 10;
  if (K.troops) {
    const row = state?.strategy?.cities?.[t.cityId];
    if (row) row.troops = Math.min(4000, Math.round(Number(row.troops || 0) + (K.troops / t.ticks) * ratio));
  }
}

/**
 * 派单（替代旧的瞬时 strategyInvest）。
 * 返回 { ok, task, ... } 或 { ok:false, reason }。
 * reason: not_own_city / no_econ / bad_kind / cooldown / no_gold / no_disaster / busy
 */
export function beginInteriorTask(state, cfg, ctx, { cityId, kind }) {
  const st = state?.strategy;
  const id = Number(cityId);
  const K = KINDS[kind];
  if (!st?.cities?.[id]) return { ok: false, reason: 'not_own_city' };
  if (st.cities[id].owner !== 'player') return { ok: false, reason: 'not_own_city' };
  const e = st.cityEcon?.[id];
  if (!e) return { ok: false, reason: 'no_econ' };
  if (!K) return { ok: false, reason: 'bad_kind' };
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));

  // ① 同一项目在施期不能重复下单（旧版是"每旬一次"，现在是"完工前不能再来一次"）
  const busy = interiorTasks(state).find(
    (t) => t.status === 'active' && Number(t.cityId) === id && t.kind === kind,
  );
  if (busy) {
    return { ok: false, reason: 'busy', kind, nextDay: busy.startDay + busy.ticks * TICK_DAYS, taskId: busy.id };
  }
  // ② 旧档兼容：旧字段 investDays 仍然尊重（升级存档时不会立刻白给一次）
  if (!e.investDays) e.investDays = {};
  const legacy = Object.keys(e.investDays).length === 0 ? Number(e.lastInvestDay) || 0 : 0;
  const last = Number(e.investDays[kind]) || legacy;
  if (last && day - last < TICK_DAYS) {
    return { ok: false, reason: 'cooldown', kind, nextDay: last + TICK_DAYS };
  }

  const gold = Number(state.roleRes?.gold) || 0;
  if (gold < K.cost) return { ok: false, reason: 'no_gold', cost: K.cost };
  if (kind === 'relief' && !e.mod && !e.disaster) return { ok: false, reason: 'no_disaster' };

  state.roleRes.gold = gold - K.cost;
  e.investDays[kind] = day;
  e.lastInvestDay = day;

  const officer = pickOfficer(state, cfg, id, K.stat);
  /* 城名：strategy 层创建后会补写权威名（cityName(id)）；这里只做兜底，避免跨模块取 map。 */
  const cityName = st.cities[id].name || `城${id}`;

  if (K.instant) {
    e.mod = null;
    e.morale = Math.min(100, Math.round((Number(e.morale ?? 60) + 6) * 10) / 10);
    e.order = Math.min(100, Math.round((Number(e.order ?? 60) + 3) * 10) / 10);
    const task = {
      id: 'it0',                               // 下面按 seq 重编号，保证同档重放得到同样的 id
      seq: (st.interiorSeq = (st.interiorSeq || 0) + 1),
      kind, cityId: id, cityName, startDay: day, ticks: 0, perTick: 0, total: 0,
      officerId: officer?.id || 0, officerName: officer?.name || '太守亲办', officerStat: officer?.stat || 0,
      cost: K.cost, status: 'done', doneDay: day,
    };
    task.id = `it${task.seq}`;
    interiorTasks(state).push(task);
    recordRes(state, 'gold', -K.cost, `${K.label}·${cityName}`, day);
    recordEvent(state, `${cityName}${K.label}：${K.effectText}（${task.officerName}）。`);
    ctx?.push?.('roleRes.push', { ...state.roleRes });
    return { ok: true, instant: true, task: taskView(state, task), effectText: K.effectText, gold: Math.floor(state.roleRes.gold) };
  }

  const { ticks, perTick } = planTicks(kind, officer?.stat || 0);
  const task = {
    id: `it${(st.interiorSeq = (st.interiorSeq || 0) + 1)}`,
    kind, cityId: id, cityName, startDay: day, ticks, perTick, total: K.total,
    officerId: officer?.id || 0, officerName: officer?.name || '无专员', officerStat: officer?.stat || 0,
    cost: K.cost, status: 'active', ticksDone: 0,
  };
  interiorTasks(state).push(task);
  recordRes(state, 'gold', -K.cost, `${K.label}·${cityName}（预付）`, day);
  ctx?.push?.('roleRes.push', { ...state.roleRes });
  return {
    ok: true, task: taskView(state, task), effectText: K.effectText,
    officer: task.officerName, ticks, perTick, endDay: task.startDay + ticks * TICK_DAYS,
    gold: Math.floor(state.roleRes.gold),
  };
}

/**
 * 每日推进（由 cityEconTick 每天调用；真正加产只在旬界）。
 * 返回 { completed: [...], ticked: [...] }，供聊天播报与回合报告引用。
 */
export function advanceInteriorTasks(state, cfg, ctx) {
  const list = interiorTasks(state);
  if (!list.length) return { completed: [], ticked: [] };
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const st = state.strategy;
  const completed = [];
  const ticked = [];
  for (const t of list) {
    if (t.status !== 'active') continue;
    const row = st?.cities?.[t.cityId];
    const e = st?.cityEcon?.[t.cityId];
    if (!row || row.owner !== 'player' || !e) {
      t.status = 'cancelled';
      t.reason = row ? '城已易手' : '城不存在';
      completed.push({ ...taskView(state, t), cancelled: true });
      continue;
    }
    const shouldTicks = Math.min(t.ticks, Math.floor((day - t.startDay) / TICK_DAYS));
    if (shouldTicks > (t.ticksDone || 0)) {
      const steps = shouldTicks - (t.ticksDone || 0);
      applyGain(state, e, t, steps);
      t.ticksDone = shouldTicks;
      const gain = Math.round(t.perTick * steps * 100) / 100;
      const K = KINDS[t.kind];
      const label = K?.note || K?.label || t.kind;
      ticked.push({ taskId: t.id, cityId: t.cityId, city: t.cityName, kind: t.kind, gain, label, tick: shouldTicks });
      recordEvent(state, `${t.cityName}${label} +${gain}（${t.officerName}${t.officerStat ? `·${t.officerStat}` : ''}）`);
    }
    if ((t.ticksDone || 0) >= t.ticks) {
      t.status = 'done';
      t.doneDay = day;
      const K = KINDS[t.kind];
      completed.push(taskView(state, t));
      ctx?.push?.('chat.push', {
        rid: 0, nickName: '系统', type: 0,
        msg: `【内政】${t.cityName}${K?.label || ''}完工：${K?.effectText || ''}　执行：${t.officerName}（${t.ticks} 旬）`,
        time: Date.now(),
      });
    }
  }
  return { completed, ticked };
}

/** 取消（已有投入不退，已到账的增量保留；理由必须回传给界面）。 */
export function cancelInteriorTask(state, { taskId }) {
  const t = interiorTasks(state).find((x) => x.id === String(taskId));
  if (!t) return { ok: false, reason: 'no_task' };
  if (t.status !== 'active') return { ok: false, reason: 'not_active', status: t.status };
  t.status = 'cancelled';
  t.reason = '主动撤销';
  recordEvent(state, `${t.cityName}${KINDS[t.kind]?.label || ''}任务撤销（已投入 ${t.cost} 金不退）。`);
  return { ok: true, task: taskView(state, t), refund: 0 };
}
