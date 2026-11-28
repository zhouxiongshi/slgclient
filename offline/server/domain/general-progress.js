/**
 * 武将等级。经验来自内政历练与出征参战/折损，攒满一档就升级。
 *
 * 上限 10：内核五维按 (100 − 基础) / 9 配到第 10 级封顶，再往上会破表。
 * 学习槽 5 级开；觉醒槽 10 级，并且自带战法要到 10 级。
 * 已有等级只升不降。旧档里积着的经验，读档时一次性结算。
 */

import { grantMerit, MERIT_GAIN } from './official-rank.js';

export const GENERAL_LEVEL_CAP = 10;
/* ★ P61-S12：玩家显式「进阶」后才开放的 11~15 级。AI 与旧档仍按 10 级封顶，
   避免既有成长曲线/事件指纹被动漂移；进阶不再抬五维上限，只给每级 2% 战斗加成。 */
export const ADVANCED_LEVEL_CAP = 15;
export const ADVANCED_BONUS_PER_LEVEL = 0.02;
export const ADVANCE_COST_GOLD = 1200;
/* ★ 2026-11-22：成长入口统一在这里定量，UI/战报只读不重算。
   内政由 5 点/旬提到 12 点/旬；出征增加参战底数，低折损仗也有成长。 */
export const INTERIOR_EXP_PER_TICK = 12;
/* ★ P76：留守历练。没差事、没仗打的驻城武将每旬也有这份经验——
   不然「一直在内政的武将」永远 1 级。办差官另有上面这份更快的通道。 */
export const IDLE_EXP_PER_TICK = 6;
export const BATTLE_EXP_PER_LOSS = 0.8;
export const BATTLE_EXP_PARTICIPATION = 20;

/** 从当前等级升到下一级需要的经验。1→2 为 40，9→10 为 360。 */
export function expToAdvance(level) {
  const lv = Math.max(1, Math.trunc(Number(level) || 1));
  if (lv >= GENERAL_LEVEL_CAP) return 600 + (lv - GENERAL_LEVEL_CAP) * 200;
  return 40 * lv;
}

/** 进阶等级带来的战斗加成（派生层，不改史载五维原表）。 */
export function advancedBonus(level) {
  return Math.max(0, Math.min(ADVANCED_LEVEL_CAP, Math.trunc(Number(level) || 1)) - GENERAL_LEVEL_CAP)
    * ADVANCED_BONUS_PER_LEVEL;
}

/**
 * 把新增经验并进武将，按档升级。add 为 0 时只结算已有经验（读档用）。
 * 返回 { from, to, exp, need }。满级后经验清零，不再堆积。
 */
export function applyGeneralExp(g, add = 0) {
  const from = Math.max(1, Math.trunc(Number(g.level) || 1));
  let lv = from;
  const cap = g.advanced ? ADVANCED_LEVEL_CAP : GENERAL_LEVEL_CAP;
  let exp = Math.max(0, Math.trunc(Number(g.exp) || 0)) + Math.max(0, Math.trunc(Number(add) || 0));
  while (lv < cap) {
    const need = expToAdvance(lv);
    if (exp < need) break;
    exp -= need;
    lv += 1;
  }
  if (lv >= cap) exp = 0;
  g.level = lv;
  g.exp = exp;
  return { from, to: lv, exp, need: lv >= cap ? 0 : expToAdvance(lv) };
}

/** 给界面用的进度。数字都在这里算，客户端只展示。 */
export function generalProgress(g) {
  const level = Math.max(1, Math.trunc(Number(g?.level) || 1));
  const exp = Math.max(0, Math.trunc(Number(g?.exp) || 0));
  const advanced = !!g?.advanced;
  const cap = advanced ? ADVANCED_LEVEL_CAP : GENERAL_LEVEL_CAP;
  const capped = level >= cap;
  const need = capped ? 0 : expToAdvance(level);
  let next = advanced ? '已至 15 级，进阶成长到头' : '已满 10 级，可花费 1200 金进阶，解锁 11~15 级';
  if (level < 5) next = '到 5 级开放学习槽';
  else if (level < GENERAL_LEVEL_CAP) next = '到 10 级，并且自带战法 10 级，开放觉醒槽';
  return { level, exp, need, capped, next, advanced, cap, tag: advanced ? '进阶' : '常规' };
}

/**
 * 一场战斗的经验 + 功勋入账。返回 { ups, promos }：
 *  - ups：等级真正提升的武将；
 *  - promos：官阶真正晋升的武将。
 * 功勋按折损兵力换算（与经验同基准），胜仗额外按 MERIT_GAIN.battle 给一笔，
 * 这样「立功→升官→统帅/政治更强」对玩家与 AI 同一条口径。
 */
export function grantBattleExp(state, cfg, expByGeneral, opts = {}) {
  const ups = [];
  const promos = [];
  for (const [gid, raw] of Object.entries(expByGeneral || {})) {
    const add = Math.max(0, Math.trunc(Number(raw) || 0));
    const g = (state.generals || []).find((x) => x.id === Number(gid));
    if (!g) continue;
    if (add > 0) {
      const r = applyGeneralExp(g, add);
      if (r.to > r.from) {
        const name = cfg?.generalByCfg?.get?.(g.cfgId)?.name || g.name || `武将${g.cfgId}`;
        ups.push({ id: g.id, name, from: r.from, to: r.to });
      }
    }
    /* 功勋：折损兵力的零头 + 胜仗一笔；只增不减，官阶由功勋唯一决定。 */
    const meritAdd = (add > 0 ? Math.max(1, Math.round(add / 8)) : 0)
      + (opts.win ? MERIT_GAIN.battle : 0) + (opts.upset ? MERIT_GAIN.upset : 0);
    if (meritAdd > 0) {
      const mr = grantMerit(g, meritAdd);
      if (mr.promoted) {
        const name = cfg?.generalByCfg?.get?.(g.cfgId)?.name || g.name || `武将${g.cfgId}`;
        promos.push({ id: g.id, name, rank: mr.rank, merit: mr.merit });
      }
    }
  }
  grantBattleExp.lastPromos = promos;
  return ups;
}

/** 上一次 grantBattleExp 的晋升列表（供 handlers 写战报一句，不改旧返回签名）。 */
export function takeBattlePromos() {
  const p = grantBattleExp.lastPromos || [];
  grantBattleExp.lastPromos = [];
  return p;
}

export function levelUpSentence(ups) {
  if (!ups?.length) return '';
  return ` ${ups.map((u) => `${u.name}升到 ${u.to} 级`).join('，')}。五维按成长率上涨。`;
}
