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

/** 放归：不消耗资源，也不加恶名。 */
export function releaseCaptive(state, { idx } = {}) {
  const r = takeCaptive(state, idx);
  if (!r.ok) return r;
  return { ok: true, action: 'released', name: r.cap.name };
}

/** 处斩：不留后患，但会记一笔恶名（供外交/结局读取，缺字段时安全跳过）。 */
export function executeCaptive(state, { idx } = {}) {
  const r = takeCaptive(state, idx);
  if (!r.ok) return r;
  if (state.role && typeof state.role === 'object') {
    state.role.infamy = (Number(state.role.infamy) || 0) + 1;
  }
  return { ok: true, action: 'executed', name: r.cap.name, infamy: state.role?.infamy ?? 0 };
}
