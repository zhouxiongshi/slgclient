/**
 * 战法研习委派（P63）。
 *
 * 设计纪律（与三国志「委任武将研究战法」同样的问题）：
 *  - 玩家不必每旬手动投残卷：委派一名武将后，每旬由该武将的谋略 / 政治自动推进研习；
 *  - 一名武将同时只能研习一条战法，一条战法同时只由一名武将研习；
 *  - 进度仍消耗兵书残卷（与手动研习同一份库存），智谋越高每旬省卷越多、推进越快；
 *  - 零依赖叶子：不 import panels / strategy / world，挂到回合结算由调用方接线，
 *    避免 panels.js ↔ strategy.js 的既有环。
 *
 * 无随机：进度是确定的整数，同存档同武将逐旬一致。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
/* ★ P71：研习回执里的战法名必须与战法库/学习槽/战斗同源。skills.js 只依赖 node 内置
   模块，import 它不会引入 panels.js ↔ strategy.js 的环；SKILL_BY_ID 仍只做「这条战法
   是否可研习」的存在性判断（原始三表），不改变 19001 不可研习的既有行为。 */
import { skillById } from '../skills.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
/* 与 panels.js 同源：战法名走 conf/skills.json，研习 need 走 conf/panels/skill-recipes.json。
   刻意只读这两张表，不 import panels.js（它 import 了会成环的 strategy 侧）。 */
const SKILLS = (() => {
  const out = [...(load('conf/skills.json').skills || [])];
  for (const p of ['conf/library-skills.json', 'conf/library-skills-extra.json']) {
    try { out.push(...(load(p).skills || [])); } catch { /* 可选表 */ }
  }
  return out;
})();
const SKILL_BY_ID = new Map(SKILLS.map((s) => [Number(s.cfgId), s]));
const RECIPE_BY_ID = new Map((load('conf/panels/skill-recipes.json').recipes || [])
  .map((r) => [Number(r.cfgId), r]));
/** 展示名统一取运行时表（已过镜像/成长/一致性/玩家覆盖）；原始 conf 仅作兜底。 */
function displayName(cfgId, conf) {
  const rt = skillById(Number(cfgId));
  return rt?.ui?.name ?? rt?.name ?? conf?.ui?.name ?? conf?.name ?? '战法';
}

const NEED_DEFAULT = 100;
const PER_XUN_BASE = 8;          // 每旬基础研习点

function int(v, d = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : d;
}

function generalOf(state, cfg, gid) {
  const g = (state.generals || []).find((x) => int(x.id) === int(gid));
  if (!g) return null;
  const conf = cfg?.generalByCfg?.get?.(Number(g.cfgId)) || {};
  const name = g.isProtagonist ? (state.role?.nickName || '主公')
    : (conf.name || `武将${g.cfgId}`);
  return {
    raw: g, name,
    strategy: Math.max(0, Math.min(100, int(conf.strategy, 50) + int(g.strategy_added))),
    politics: Math.max(0, Math.min(100, int(conf.politics, 50) + int(g.politics_added))),
  };
}

function scrollCount(state) {
  return (state.items || []).filter((i) => i.kind === 'scroll' && !i.ownerGeneralId)
    .reduce((n, i) => n + (Number(i.count) || 0), 0);
}

function takeScrolls(state, n) {
  let left = n;
  for (const i of state.items || []) {
    if (left <= 0) break;
    if (i.kind !== 'scroll' || i.ownerGeneralId) continue;
    const use = Math.min(left, Math.max(0, int(i.count)));
    i.count -= use; left -= use;
  }
  state.items = (state.items || []).filter((i) => Number(i.count) !== 0);
  return n - left;
}

/** 一个武将每旬能推进多少研习点、耗多少卷。谋略主导速度，政治主导省卷。 */
export function researchPace(g) {
  const strategy = Math.max(0, Math.min(100, int(g?.strategy, 50)));
  const politics = Math.max(0, Math.min(100, int(g?.politics, 50)));
  const points = PER_XUN_BASE + Math.floor(strategy / 12);     // 8~16 点/旬
  const scrolls = Math.max(2, 5 - Math.floor(politics / 34)); // 高政治 2~3 卷，低政治 5 卷
  return { points, scrolls, strategy, politics };
}

/** 旧档迁移：开局预置的「研习中」若没有委派，就永远卡着不动。
 *  这是零依赖的字段兜底（不消耗残卷），由 ensurePanels 调；指派主公督研第一条，
 *  之后每旬由 strategyTick 自然推进。玩家也可以随时改派。 */
export function adoptOrphanResearch(state, cfg) {
  const sb = state?.skillbook;
  if (!sb) return null;
  const research = sb.research || {};
  const assign = sb.assign || (sb.assign = {});
  const keys = Object.keys(research).filter((k) => !sb.unlocked?.[k] && !assign[k]);
  if (!keys.length) return null;
  const hero = (state.generals || []).find((g) => g.isProtagonist) || state.generals?.[0];
  if (!hero) return null;
  const key = keys[0];
  assign[key] = { generalId: hero.id, since: int(state.clock?.day, 1), source: '旧档接管' };
  return { cfgId: int(key, -1), generalId: hero.id };
}

/** 委派一名武将研习某战法。字段落在 state.skillbook.assign（零依赖）。 */
export function assignResearch(state, cfg, { cfgId, generalId } = {}) {
  const id = int(cfgId, -1);
  const gid = int(generalId, -1);
  if (!state?.skillbook) return { ok: false, reason: 'no_skillbook' };
  const g = generalOf(state, cfg, gid);
  if (!g) return { ok: false, reason: 'no_general' };
  const conf = SKILL_BY_ID.get(id);
  if (!conf) return { ok: false, reason: 'no_skill' };
  if (state.skillbook.unlocked?.[String(id)]) return { ok: false, reason: 'already_unlocked' };
  const assign = state.skillbook.assign || (state.skillbook.assign = {});
  /* 这名武将若已派去别的战法，先摘掉（一人一职，不静默双份进度）。 */
  for (const [key, row] of Object.entries(assign)) {
    if (int(row?.generalId) === gid) delete assign[key];
  }
  assign[String(id)] = { generalId: gid, since: int(state.clock?.day, 1) };
  const pace = researchPace(g);
  return {
    ok: true, cfgId: id, generalId: gid, name: g.name,
    points: pace.points, scrolls: pace.scrolls,
    text: `已委派${g.name}研习「${displayName(id, conf)}」：每旬约 ${pace.points} 点、耗 ${pace.scrolls} 卷`,
  };
}

/** 取消委派（不退还已耗残卷，进度保留，与手动研习一致）。 */
export function unassignResearch(state, { cfgId } = {}) {
  const id = int(cfgId, -1);
  const row = state?.skillbook?.assign?.[String(id)];
  if (!row) return { ok: false, reason: 'not_assigned' };
  delete state.skillbook.assign[String(id)];
  return { ok: true, cfgId: id, text: '已撤回研习委派，进度保留' };
}

/** 推进一条委派。卷尽时仍靠武将自行推敲，进度会动，只是更慢。 */
function advanceAssigned(state, cfg, key, row, ctx) {
  const assign = state.skillbook.assign;
  const cfgId = int(key, -1);
  if (state.skillbook.unlocked?.[key]) { delete assign[key]; return null; }
  const g = generalOf(state, cfg, row?.generalId);
  if (!g) { delete assign[key]; return null; }
  const pace = researchPace(g);
  const have = scrollCount(state);
  let gain;
  let costNote;
  if (have <= 0) {
    gain = Math.max(4, Math.round(pace.points * 0.45));
    costNote = '残卷用尽，武将自行推敲';
  } else {
    const used = takeScrolls(state, Math.min(have, pace.scrolls));
    const ratio = used / Math.max(1, pace.scrolls);
    gain = Math.max(1, Math.round(pace.points * ratio));
    costNote = `耗 ${used} 卷`;
  }
  const rec = RECIPE_BY_ID.get(cfgId);
  const need = int(rec?.sources?.find?.((x) => x.type === 'research')?.progressNeed, NEED_DEFAULT);
  const cur = state.skillbook.research?.[key] || { progress: 0, need };
  cur.need = need;
  cur.progress = int(cur.progress) + gain;
  if (!state.skillbook.research) state.skillbook.research = {};
  state.skillbook.research[key] = cur;
  const conf = SKILL_BY_ID.get(cfgId);
  const title = displayName(cfgId, conf);
  if (cur.progress >= need) {
    delete state.skillbook.research[key];
    delete assign[key];
    state.skillbook.unlocked[key] = { level: 1, source: '委派研习' };
    const text = `「${title}」研习完成，已解锁（${g.name}）`;
    ctx?.push?.('research.unlocked', { cfgId, generalId: g.raw.id });
    return { cfgId, unlocked: true, text, progress: need, need };
  }
  const text = `${g.name}研习「${title}」：+${gain} 点（${cur.progress}/${need}），${costNote}`;
  return { cfgId, unlocked: false, text, progress: cur.progress, need };
}

/** 每旬推进所有委派。返回本旬发生的事。 */
export function researchTick(state, cfg, ctx = {}) {
  if (!state?.skillbook) return [];
  const assign = state.skillbook.assign;
  if (!assign || !Object.keys(assign).length) return [];
  const events = [];
  for (const [key, row] of Object.entries(assign)) {
    const ev = advanceAssigned(state, cfg, key, row, ctx);
    if (ev) events.push(ev);
  }
  return events;
}

/** 玩家当场研习一条。没委派就用这次选的武将。 */
export function studyOnce(state, cfg, { cfgId, generalId } = {}) {
  if (!state?.skillbook) return { ok: false, text: '战法库还没准备好' };
  const key = String(int(cfgId, -1));
  if (state.skillbook.unlocked?.[key]) return { ok: false, text: '该战法已解锁' };
  if (!state.skillbook.assign?.[key]) {
    const assigned = assignResearch(state, cfg, { cfgId, generalId });
    if (!assigned.ok) return { ok: false, text: assigned.reason === 'no_general' ? '先选一名武将' : '这条战法不能研习' };
  }
  const row = state.skillbook.assign?.[key];
  const ev = row ? advanceAssigned(state, cfg, key, row, {}) : null;
  if (!ev) return { ok: false, text: '这一次没有推进' };
  return { ok: true, ...ev };
}

/** 面板下发：可委派武将的速度（唯一口径，UI 只读不自己算）。 */
export function researchCandidatesView(state, cfg) {
  return (state.generals || []).map((raw) => {
    const g = generalOf(state, cfg, raw.id);
    const pace = researchPace(g);
    const conf = cfg?.generalByCfg?.get?.(Number(raw.cfgId)) || {};
    return {
      id: raw.id, name: g.name,
      strategy: g.strategy, politics: g.politics,
      points: pace.points, scrolls: pace.scrolls,
      inArmy: (state.armys || []).some((a) => (a.generals || []).some((gid) => Number(gid) === Number(raw.id))),
    };
  });
}

/** 面板下发：当前委派摘要（谁在研习哪条、每旬速度与差额）。 */
export function researchView(state, cfg) {
  const out = [];
  for (const [key, row] of Object.entries(state?.skillbook?.assign || {})) {
    const cfgId = int(key, -1);
    const g = generalOf(state, cfg, row?.generalId);
    if (!g) continue;
    const pace = researchPace(g);
    const r = state.skillbook.research?.[key] || { progress: 0, need: NEED_DEFAULT };
    const conf = SKILL_BY_ID.get(cfgId);
    out.push({
      cfgId, name: displayName(cfgId, conf),
      generalId: g.raw.id, generalName: g.name,
      points: pace.points, scrolls: pace.scrolls,
      progress: int(r.progress), need: int(r.need) || NEED_DEFAULT,
      remainScrolls: scrollCount(state),
    });
  }
  return out;
}
