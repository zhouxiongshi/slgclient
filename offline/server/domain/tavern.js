/**
 * 未出仕的武将待在酒馆，而不是抽卡池。
 * 原 general.json 和 battle-kit 都没有籍贯，所以暂都出现在玩家主城酒馆。
 * 每天只来 3 人，而且每人只占当天的一段时辰。
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

export function ensureTavern(state, cfg) {
  const owned = new Set((state.generals || []).map((g) => g.cfgId));
  if (!state.tavern) state.tavern = { people: [], lastAnnouncedDay: 0 };
  const known = new Set(state.tavern.people.map((p) => p.cfgId));
  for (const g of cfg.generalByCfg.values()) {
    if (g.cfgId === PROTAGONIST_ID || known.has(g.cfgId)) continue;
    state.tavern.people.push({
      cfgId: g.cfgId,
      name: g.name,
      birthCity: null,
      recruited: owned.has(g.cfgId),
    });
    known.add(g.cfgId);
  }
  return state.tavern;
}

export function dayFraction(state, realMsPerDay = 60000) {
  const scale = state.clock?.scale || 1;
  const ms = Math.max(1, Math.round(realMsPerDay / scale));
  return Math.max(0, Math.min(0.999, (state.clock?.accMs || 0) / ms));
}

export function todaysGuests(state, day = state.clock?.day || 1) {
  const tavern = state.tavern;
  if (!tavern.schedule || tavern.schedule.day !== day) {
    const pool = tavern.people.filter((p) => !p.recruited);
    const ranked = pool
      .map((p) => ({ p, h: mix(p.cfgId, day || 1) }))
      .sort((a, b) => a.h - b.h || a.p.cfgId - b.p.cfgId)
      .slice(0, WINDOWS.length);
    tavern.schedule = {
      day,
      guests: ranked.map((row, i) => ({ cfgId: row.p.cfgId, ...WINDOWS[i] })),
    };
  }
  return tavern.schedule.guests.map((g) => {
    const p = tavern.people.find((row) => row.cfgId === g.cfgId);
    if (!p || p.recruited) return null;
    return { ...p, from: g.from, to: g.to, when: g.when };
  }).filter(Boolean);
}

export function guestsNow(state, realMsPerDay) {
  const frac = dayFraction(state, realMsPerDay);
  return todaysGuests(state).filter((g) => frac >= g.from && frac < g.to);
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
    msg: `主城酒馆今日可见：${text}。原表没有籍贯，人先都在主城。过了时辰就见不到。`,
    time: Date.now(),
  };
  state.chat = state.chat || [];
  state.chat.push(cm);
  if (state.chat.length > 200) state.chat.shift();
  ctx.push?.('chat.push', cm);
  void realMsPerDay;
}
