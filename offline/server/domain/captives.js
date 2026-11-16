/**
 * 俘虏链路统一入口（M4-13）—— 零依赖叶子（只依赖 strategy-rng）。
 *
 * 修复的问题：
 *  1) 占领有两条路径，只有战略层 settleArmyBattle 写 state.captives；
 *     玩家常规 WS 路径 army.assign → battle_arrive → handlers.processTask
 *     占的是地图格，从头到尾不落俘虏，玩家自然觉得「抓了人却没招降」。
 *  2) 旧判定 `roll = (cand.join(',').length*31 + day*7 + floor(aTotal)) % 100`
 *     与战果毫无关系（字符串长度 + 日历天数），30% 闸门还经常空手。
 *  3) 只有招降，没有释放 / 处斩，俘虏只能等越狱。
 *
 * 现在：战报里的有名守将 → 按歼敌比确定性判定 → 入押；
 * 释放 / 处斩 / 招降三个出口共用同一份名册。
 */
import { rngFor } from './strategy-rng.js';
import {
  FAME_PER_RELEASE, INFAMY_PER_EXECUTE,
  ATTITUDE_ON_RELEASE, ATTITUDE_ON_EXECUTE, EXEMPT_FACTION_ON_EXECUTE,
} from './captive-reputation.js';

function soldiersOf(report, key) {
  try {
    const a = JSON.parse(report?.[key] || '{}')?.soldiers;
    return Array.isArray(a) ? a.reduce((s, n) => s + Math.max(0, Number(n) || 0), 0) : 0;
  } catch { return 0; }
}

/** 胜仗后从战报守将名单里确定性俘虏若干人，返回新增的俘虏对象数组。 */
export function captureFromBattle(state, cfg, { report, place = '', day = 1, seed = 20261110 } = {}) {
  state.captives = Array.isArray(state.captives) ? state.captives : [];
  const owned = new Set((state.generals || []).map((g) => Number(g.cfgId)));
  const held = new Set(state.captives.map((c) => Number(c.cfgId)));
  let defs = [];
  try { defs = JSON.parse(report?.b_d_general || '[]'); } catch { defs = []; }

  const cand = [];
  for (const row of defs) {
    const id = Number(row?.[1]);
    if (!id || id === 880001 || owned.has(id) || held.has(id) || cand.includes(id)) continue;
    /* 只俘「有名有姓、能在武将表里查到」的守将，代将/系统占位不入押 */
    if (cfg?.generalByCfg?.get(id)) cand.push(id);
  }
  if (!cand.length) return [];

  /* 歼敌比越高越容易擒将：全歼必俘，惨胜也有六成机会。
     种子只依赖 (世界 seed, 到达日, 战场, 候选名单)，同参可回放。 */
  const dStart = soldiersOf(report, 'b_d_army');
  const dLeft = soldiersOf(report, 'e_d_army');
  const ratio = dStart > 0 ? Math.max(0, Math.min(1, (dStart - dLeft) / dStart)) : 1;
  const chance = 0.6 + 0.4 * ratio;
  const roll = rngFor(seed, Math.max(1, Math.floor(Number(day) || 1)),
    `capture:${place}:${cand.join(',')}`).random();
  if (roll >= chance) return [];
  const maxPick = ratio >= 0.75 ? 2 : 1;
  const added = [];
  for (const cfgId of cand.slice(0, Math.min(maxPick, cand.length))) {
    const name = cfg.generalByCfg.get(cfgId)?.name || `武将${cfgId}`;
    const cap = { cfgId, name, from: place, loyal: 50, days: 0, day: Math.floor(Number(day) || 1) };
    state.captives.push(cap);
    added.push(cap);
  }
  return added;
}

function takeCaptive(state, idx) {
  state.captives = Array.isArray(state.captives) ? state.captives : [];
  const i = Number(idx);
  const cap = state.captives[i];
  if (!cap) return { ok: false, reason: 'no_captive' };
  state.captives.splice(i, 1);
  return { ok: true, cap };
}

/** 放归：不花钱，记名望 +2，并对所有 NPC 势力落 attitude −5（GDD §7.3）。
 *  态度落账走 diplomacy 的唯一权威口，理由链里显示为「事件」档，可追溯。 */
export function releaseCaptive(state, { idx, diplomacyApi = null } = {}) {
  const r = takeCaptive(state, idx);
  if (!r.ok) return r;
  const st = state?.strategy;
  if (st && typeof st === 'object') st.fame = (Number(st.fame) || 0) + FAME_PER_RELEASE;
  const attitude = diplomacyApi?.adjustAttitude?.(ATTITUDE_ON_RELEASE) ?? null;
  return {
    ok: true, action: 'released', name: r.cap.name,
    fame: st?.fame ?? 0, fameDelta: FAME_PER_RELEASE,
    attitudeDelta: ATTITUDE_ON_RELEASE, attitude,
  };
}

/** 处斩：记恶名 +1、名望 −1，对所有 NPC 势力 attitude −15，董卓除外（GDD §7.3 / §5.9）。 */
export function executeCaptive(state, { idx, diplomacyApi = null } = {}) {
  const r = takeCaptive(state, idx);
  if (!r.ok) return r;
  if (state.role && typeof state.role === 'object') {
    state.role.infamy = (Number(state.role.infamy) || 0) + INFAMY_PER_EXECUTE;
  }
  const st = state?.strategy;
  if (st && typeof st === 'object') st.fame = (Number(st.fame) || 0) - FAME_PER_RELEASE;
  const attitude = diplomacyApi?.adjustAttitude?.(ATTITUDE_ON_EXECUTE, EXEMPT_FACTION_ON_EXECUTE) ?? null;
  return {
    ok: true, action: 'executed', name: r.cap.name,
    infamy: state.role?.infamy ?? 0, infamyDelta: INFAMY_PER_EXECUTE,
    fame: st?.fame ?? 0, fameDelta: -FAME_PER_RELEASE,
    attitudeDelta: ATTITUDE_ON_EXECUTE, attitude,
  };
}
