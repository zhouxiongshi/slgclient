/**
 * event-engine.js — 事件引擎（GDD §8.1 / §8.3）
 *
 * 每旬 tick 由 strategy 层调一次：
 *   const { selected, deferred } = selectEvents(events, ctx, state);
 *   for (const ev of selected) → 弹窗呈现（面板层消费 selected 的 text/choices）
 *   玩家选择后 → applyEffects(state, event, choiceId, api)
 *
 * 硬规则（GDD §8.3）：
 *  - 每旬按 priority 降序，最多触发 2 条（防止弹窗淹没）
 *  - exclusive 组内只出一条；同组未出的事件进入 1 旬冷却，下回合再判
 *  - once 事件触发过即永久排除
 *  - 本模块不掷随机数、不写状态，只经 ensureEventState 管理 events 域，
 *    效果落账全部走调用方注入的 api（描述=计算=战报同源）。
 */
import { evaluateEvent, parseEffect } from './event-dsl.js';

/** 事件运行期状态（存档域：state.events）。 */
export function ensureEventState(state) {
  if (!state.events) state.events = { fired: {}, cooldown: {} };
  if (!state.events.fired) state.events.fired = {};
  if (!state.events.cooldown) state.events.cooldown = {};
  return state.events;
}

/** 一旬过去了：冷却递减。 */
export function eventCooldownTick(state) {
  const es = ensureEventState(state);
  for (const id of Object.keys(es.cooldown)) {
    es.cooldown[id] -= 1;
    if (es.cooldown[id] <= 0) delete es.cooldown[id];
  }
}

/** exclusive 组 key：同一数组内容视作同组。 */
function exclusiveKey(e) {
  return e.exclusive && e.exclusive.length ? e.exclusive.slice().sort().join('|') : null;
}

/**
 * 事件筛选。events 是 conf/campaign/events.json 的数组（已过 schema 校验）。
 * 返回 { selected, deferred }；调用方应把 selected 呈现给玩家，
 * deferred 是被互斥挤掉/冷却中的候选（仅作观测，不弹窗）。
 */
export function selectEvents(events, ctx, state, opts = {}) {
  const es = ensureEventState(state);
  const maxPerTurn = opts.maxPerTurn || 2;

  // 1. 硬排除：once 已触发、冷却未到
  const pool = events.filter((e) => {
    if (e.once && es.fired[e.id]) return false;
    if (es.cooldown[e.id]) return false;
    return true;
  });

  // 2. 条件过滤（DSL 白名单求值；未知字段在这里直接抛错）
  const candidates = pool.filter((e) => evaluateEvent(e.when, ctx));

  // 3. priority 降序，同优先级按 id 字典序（确定性）
  candidates.sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 4. exclusive 分组：组内只取第一条，其余进 1 旬冷却
  const selected = [];
  const deferred = [];
  const seenGroups = new Set();
  for (const e of candidates) {
    const key = exclusiveKey(e);
    if (key) {
      if (seenGroups.has(key)) {
        deferred.push(e.id);
        es.cooldown[e.id] = 1;
        continue;
      }
      seenGroups.add(key);
    }
    if (selected.length >= maxPerTurn) {
      deferred.push(e.id);
      continue;
    }
    selected.push(e);
    if (e.once) es.fired[e.id] = ctx.turn;
  }
  return { selected, deferred };
}

/**
 * 效果落账。api 由调用方注入（strategy 接线时给真实实现，测试给 mock）：
 *   { setFlag(name), clearFlag(name), addGold(n), addMorale(n),
 *     addLoyalty(generalName, n), addAttitude(factionId, n), addFame(n) }
 * 返回实际应用的效果列表（写进事件记录/战报，与预览同源）。
 */
export function applyEffects(state, event, choiceId, api) {
  const es = ensureEventState(state);
  const choice = event.choices.find((c) => c.id === choiceId);
  if (!choice) throw new Error(`事件 ${event.id} 无选项 ${choiceId}`);
  const applied = [];
  for (const fx of choice.effects) {
    const p = parseEffect(fx);
    if (!p) throw new Error(`事件 ${event.id} 效果词非法: ${fx}`);
    switch (p.kind) {
      case 'flag': api.setFlag(p.name); applied.push({ kind: 'flag', name: p.name }); break;
      case 'flag-': api.clearFlag(p.name); applied.push({ kind: 'flag-', name: p.name }); break;
      case 'gold': api.addGold(p.delta); applied.push({ kind: 'gold', delta: p.delta }); break;
      case 'morale': api.addMorale(p.delta); applied.push({ kind: 'morale', delta: p.delta }); break;
      case 'loyalty': api.addLoyalty(p.target, p.delta); applied.push({ kind: 'loyalty', target: p.target, delta: p.delta }); break;
      case 'attitude': api.addAttitude(p.target, p.delta); applied.push({ kind: 'attitude', target: p.target, delta: p.delta }); break;
      case 'fame': api.addFame(p.delta); applied.push({ kind: 'fame', delta: p.delta }); break;
      case 'nothing': applied.push({ kind: 'nothing' }); break;
      default: throw new Error(`未实现的效果类型: ${p.kind}`);
    }
  }
  // 记录选择（结局判定/回放用）
  es.choices = es.choices || {};
  es.choices[event.id] = { choice: choiceId, turn: api.turn ? api.turn() : null, applied };
  return applied;
}
