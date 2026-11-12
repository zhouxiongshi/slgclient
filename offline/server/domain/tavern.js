/**
 * 未出仕的武将待在酒馆，而不是抽卡池。
 * ★ P6：在野武将有籍贯（确定性散列到 72 城之一），各城酒馆各自来访；
 *   探索人才（登庸）可主动出击。原档无 birthCity 的旧数据会在此处补齐。
 */

const PROTAGONIST_ID = 880001;

function mix(a, b) {
  let x = Math.imul(a >>> 0, 0x9e3779b1) ^ Math.imul((b >>> 0) || 1, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

const WINDOWS = [
  { from: 0, to: 0.35, when: '开城时分' },
  { from: 0.4, to: 0.62, when: '午后' },
  { from: 0.7, to: 0.92, when: '傍晚' },
];

/* 城池表只读 conf/campaign/strategy/map.json（防循环依赖，不引 strategy.js） */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let cityIds = null;
function allCityIds() {
  if (!cityIds) {
    try {
      const map = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json'), 'utf8'));
      cityIds = (map.cities || []).filter((c) => !c.pass).map((c) => Number(c.id));
    } catch { cityIds = [1]; }
    if (!cityIds.length) cityIds = [1];
  }
  return cityIds;
}

/** 城市 id → 中文名（探索/登庸文案用）。 */
export function cityNameOf(id) {
  try {
    const map = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json'), 'utf8'));
    const c = (map.cities || []).find((x) => Number(x.id) === Number(id));
    return c ? c.name : `城${id}`;
  } catch { return `城${id}`; }
}

export function ensureTavern(state, cfg) {
  const owned = new Set((state.generals || []).map((g) => g.cfgId));
  if (!state.tavern) state.tavern = { people: [], lastAnnouncedDay: 0 };
  const known = new Set(state.tavern.people.map((p) => p.cfgId));
  const ids = allCityIds();
  for (const g of cfg.generalByCfg.values()) {
    if (g.cfgId === PROTAGONIST_ID || known.has(g.cfgId)) continue;
    // ★ 籍贯：cfgId 散列到一座城（确定性，所有存档同一人在同一座城）
    const birthCity = ids[mix(g.cfgId, 0x6a09e667) % ids.length];
    state.tavern.people.push({
      cfgId: g.cfgId,
      name: g.name,
      birthCity,
      recruited: owned.has(g.cfgId),
    });
    known.add(g.cfgId);
  }
  // 旧档补籍贯
  for (const p of state.tavern.people) {
    if (!p.birthCity || !ids.includes(Number(p.birthCity))) {
      p.birthCity = ids[mix(p.cfgId, 0x6a09e667) % ids.length];
    }
  }
  return state.tavern;
}

export function dayFraction(state, realMsPerDay = 60000) {
  const scale = state.clock?.scale || 1;
  const ms = Math.max(1, Math.round(realMsPerDay / scale));
  return Math.max(0, Math.min(0.999, (state.clock?.accMs || 0) / ms));
}

/**
 * 某日某城的来访名单（每人占一段时辰）。
 * cityId 给定：优先该籍贯在野武将；本地无人来访则从全图在野池随机补足。
 */
export function todaysGuests(state, day = state.clock?.day || 1, cityId = null) {
  const tavern = state.tavern;
  const cid = cityId == null ? null : Number(cityId);
  const key = `${day || 1}:${cid ?? 'all'}`;
  if (!tavern.schedule || tavern.schedule.day !== day || tavern.schedule.key !== key) {
    const localPool = cid == null ? [] : tavern.people.filter((p) => !p.recruited && Number(p.birthCity) === cid);
    const globalPool = tavern.people.filter((p) => !p.recruited);
    const pick = (pool, salt) => pool
      .map((p) => ({ p, h: mix(p.cfgId, (day || 1) ^ salt) }))
      .sort((a, b) => a.h - b.h || a.p.cfgId - b.p.cfgId);
    const local = cid == null ? [] : pick(localPool, 0x243f6a88);
    const global = pick(globalPool.filter((p) => !local.some((l) => l.p.cfgId === p.cfgId)), 0x85a308d3);
    /* ★ M2 兴学：兴学宫完工的城，来访贤才位 +1（常设，至多 +2；interior-task 完工时写入） */
    const bonus = cid == null ? 0 : Math.min(2, (Number(tavern.studyBonus?.[cid]) || 0));
    const ranked = local.concat(global).slice(0, WINDOWS.length + bonus);
    tavern.schedule = {
      day,
      key,
      guests: ranked.map((row, i) => ({ cfgId: row.p.cfgId, ...WINDOWS[i] })),
    };
  }
  return tavern.schedule.guests.map((g) => {
    const p = tavern.people.find((row) => row.cfgId === g.cfgId);
    if (!p || p.recruited) return null;
    return { ...p, from: g.from, to: g.to, when: g.when };
  }).filter(Boolean);
}

export function guestsNow(state, realMsPerDay, cityId = null) {
  const frac = dayFraction(state, realMsPerDay);
  return todaysGuests(state, state.clock?.day || 1, cityId).filter((g) => frac >= g.from && frac < g.to);
}

/** 探索人才（登庸）：每城每日一次。候选按确定性散列选出，成功率由调用方按政治判定。 */
export function exploreTalent(state, cfg, cityId) {
  const tavern = ensureTavern(state, cfg);
  const day = state.clock?.day || 1;
  const cid = Number(cityId) || (state.strategy?.playerCity ?? 1);
  tavern.explores = tavern.explores || {};
  const key = `${day}:${cid}`;
  if (tavern.explores[key]) return { ok: false, reason: 'already_today' };
  tavern.explores[key] = true;
  const pool = tavern.people.filter((p) => !p.recruited && Number(p.birthCity) === cid);
  const universal = tavern.people.filter((p) => !p.recruited);
  const target = pool.length
    ? pool[Math.floor(mix(day, cid) % pool.length)]
    : universal[Math.floor(mix(day, cid ^ 0x9e3779b9) % universal.length)];
  if (!target) return { ok: false, reason: 'no_talent' };
  return { ok: true, target, key, cityId: cid };
}

export function announceTavern(state, ctx, realMsPerDay) {
  const day = state.clock?.day || 1;
  if (!state.tavern || state.tavern.lastAnnouncedDay === day) return;
  state.tavern.lastAnnouncedDay = day;
  const guests = todaysGuests(state, day);
  if (!guests.length) return;
  const text = guests.map((g) => `${g.name}（${g.when}）`).join('、');
  const cm = {
    rid: 0,
    nickName: '系统',
    type: 0,
    msg: `主城酒馆今日可见：${text}。各城酒馆另有本籍贤才来访，可派政治高的武将探索登庸。`,
    time: Date.now(),
  };
  state.chat = state.chat || [];
  state.chat.push(cm);
  if (state.chat.length > 200) state.chat.shift();
  ctx.push?.('chat.push', cm);
  void realMsPerDay;
}
