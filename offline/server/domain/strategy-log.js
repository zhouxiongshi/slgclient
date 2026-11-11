/**
 * 出征账与天下日志。
 *
 * 路程取行军段的公里与日程，汉里按该路「汉里 / 公里」折算。
 * 步卒耗口粮和军饷；兵种写着「骑」的城，按四成骑兵另计马料和马金。
 * 粮饷不够付骑兵时改为步卒；连步卒都付不起就不出征。
 * 决策脑只引用这里的报价，执行层按同一张账单扣款，日志照这张账单来写。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canMarchBetween, marchGraph } from './march.js';

const DETAIL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../conf/campaign/strategy/detail.json');

let routeById = null;
function routes() {
  if (routeById) return routeById;
  routeById = {};
  try {
    const detail = JSON.parse(readFileSync(DETAIL_PATH, 'utf8'));
    routeById = detail.routes || {};
  } catch {
    routeById = {};
  }
  return routeById;
}

/** 一次出征的路程。途经关隘的两段分别计入，不把整条路重复加一遍。 */
export function marchSpan(fromId, toId) {
  const hit = canMarchBetween(fromId, toId);
  if (!hit?.ok) return null;
  const g = marchGraph();
  let km = 0;
  let days = 0;
  let li = 0;
  const seenRoute = new Set();
  for (const id of hit.edges || []) {
    const e = g?.edges?.get(id);
    const edgeKm = Number(e?.km) || 0;
    km += edgeKm;
    days += Number(e?.days) || 0;
    const route = e?.routeId ? routes()[e.routeId] : null;
    if (route && !seenRoute.has(e.routeId) && Number(route.km) > 0 && Number(route.li) > 0) {
      seenRoute.add(e.routeId);
      li += Number(route.li) * (edgeKm > 0 ? Math.min(1, edgeKm / Number(route.km)) : 1);
    } else if (!route) {
      li += edgeKm * 2.4;
    }
  }
  if (!km) km = 80;
  if (!li) li = km * 2.4;
  if (!days) days = Math.max(1, Math.round(km / 35));
  return {
    km: Math.round(km * 10) / 10,
    li: Math.max(1, Math.round(li)),
    days: Math.max(1, Math.round(days)),
    via: hit.via || [],
  };
}

export function horseShare(arms) {
  return String(arms || '').includes('骑') ? 0.4 : 0;
}

function bill(troops, days, horses) {
  const foot = Math.max(0, troops - horses);
  const grain = Math.round(foot * days * 0.12 + horses * days * 0.1);
  const horseGrain = Math.round(horses * days * 0.28);
  const gold = Math.round(foot * days * 0.04 + horses * days * 0.05);
  const horseGold = Math.round(horses * days * 0.08);
  return {
    grain, horseGrain, gold, horseGold,
    totalGrain: grain + horseGrain,
    totalGold: gold + horseGold,
  };
}

/**
 * 给出征报价。purse 是扣除本月征兵之后还能动用的粮和金。
 * 留 400 粮、150 金作守城，不把家底一次运光。
 */
export function quoteMarch(fromId, toId, troops, arms, purse = {}) {
  const span = marchSpan(fromId, toId);
  if (!span) return { ok: false, reason: '无路' };
  const n = Math.max(0, Math.round(Number(troops) || 0));
  const haveG = Math.max(0, Number(purse.grain) || 0);
  const haveM = Math.max(0, Number(purse.gold) || 0);
  const reserveG = 400;
  const reserveM = 150;
  const want = Math.round(n * horseShare(arms));
  let horses = want;
  let cost = bill(n, span.days, horses);
  let mode = horses > 0 ? '骑' : '步';
  let dismounted = false;
  if (cost.totalGrain + reserveG > haveG || cost.totalGold + reserveM > haveM) {
    horses = 0;
    cost = bill(n, span.days, 0);
    mode = '步';
    dismounted = want > 0;
  }
  const ok = cost.totalGrain + reserveG <= haveG && cost.totalGold + reserveM <= haveM && n >= 400;
  return {
    ok,
    reason: ok ? '' : '粮饷不足',
    ...span,
    ...cost,
    horses,
    mode,
    dismounted,
    arms: String(arms || ''),
  };
}

export function ensureChronicle(state) {
  const st = state.strategy;
  if (!st.chronicle) st.chronicle = [];
  if (!st.cityLogs) st.cityLogs = {};
  if (!st.draft) st.draft = null;
  return st;
}

export function openMonth(state) {
  const st = ensureChronicle(state);
  st.draft = { turn: st.turn, moves: [] };
}

export function noteMove(state, move) {
  const st = ensureChronicle(state);
  if (!st.draft) st.draft = { turn: st.turn, moves: [] };
  st.draft.moves.push(move);
}

export function noteCity(state, cityId, entry) {
  if (!cityId) return;
  const st = ensureChronicle(state);
  const key = String(cityId);
  const list = st.cityLogs[key] || (st.cityLogs[key] = []);
  list.push({ turn: st.turn, month: (st.turn || 0) + 1, ...entry });
  while (list.length > 40) list.shift();
}

export function closeMonth(state) {
  const st = ensureChronicle(state);
  const draft = st.draft || { turn: st.turn, moves: [] };
  const month = (draft.turn || st.turn || 0);
  const text = composeMonth(month, draft.moves);
  st.chronicle.push({
    turn: draft.turn,
    month,
    text,
    moves: draft.moves,
  });
  while (st.chronicle.length > 48) st.chronicle.shift();
  st.draft = null;
  st.movements = draft.moves
    .filter((m) => m.kind === '出征' || m.kind === '结盟' || m.kind === '固守')
    .map((m) => ({
      kind: m.kind,
      faction: m.faction,
      who: m.who,
      fromName: m.fromName || '',
      toName: m.toName || '',
      result: m.result || '',
      otherName: m.otherName || '',
    }));
  return text;
}

function composeMonth(month, moves) {
  const attacks = moves.filter((m) => m.kind === '出征' && m.result === '克');
  const fails = moves.filter((m) => m.kind === '出征' && m.result === '挫');
  const refused = moves.filter((m) => m.kind === '出征' && m.result === '未发');
  const holds = moves.filter((m) => m.kind === '固守');
  const pacts = moves.filter((m) => m.kind === '结盟');
  const parts = [];

  if (attacks.length === 1) {
    parts.push(`只有${marchSentence(attacks[0])}。`);
  } else if (attacks.length > 1) {
    parts.push(`${attacks.map(marchSentence).join('。')}。`);
  }
  const raids = moves.filter((m) => m.kind === '出征' && m.result === '来犯');
  for (const f of fails) parts.push(`${f.who}从${f.fromName}出兵${f.toName}，${spanClause(f)}，攻之不下，粮饷已耗。`);
  for (const f of raids) parts.push(`${f.who}从${f.fromName}出兵${f.toName}，${spanClause(f)}，来犯玩家。`);
  for (const f of refused) parts.push(`${f.who}本欲出兵${f.toName || ''}，${f.reason || '粮饷不足'}，未发兵。`);
  for (const p of pacts) {
    const pin = p.versusName ? `，以牵制${p.versusName}` : '';
    parts.push(`${p.who}与${p.otherName}结好${pin}。`);
  }
  const specific = holds.filter((h) => h.reason && !String(h.reason).includes('四邻守军尚厚'));
  const allied = new Set(pacts.map((p) => p.who));
  const generic = holds.filter((h) => !specific.includes(h) && !allied.has(h.who));
  for (const h of specific) {
    const reason = String(h.reason || '').replace(/。$/, '');
    parts.push(`${h.who}${reason.startsWith('按兵') ? '' : '：'}${reason}。`);
  }
  if (!attacks.length && !fails.length && generic.length && !specific.length && !pacts.length) {
    parts.push('邻城守军还厚，各家征兵，不出征。');
  } else if (generic.length) {
    parts.push(`${generic.map((h) => h.who).join('、')}按兵征兵，不出征。`);
  }
  if (!parts.length) parts.push('本月无大事。');
  return `第 ${month} 月，${parts.join('')}`;
}

function spanClause(m) {
  const horse = m.horses > 0
    ? `，骑兵 ${m.horses} 骑，马料 ${m.horseGrain}、马金 ${m.horseGold}`
    : (m.dismounted ? '，战马粮饷不足，改为步卒' : '');
  return `路程 ${m.li || 0} 里、约 ${m.days || 0} 日，耗粮 ${m.totalGrain || m.grain || 0}、金 ${m.totalGold || m.gold || 0}${horse}`;
}

function marchSentence(m) {
  return `${m.who}从${m.fromName}出兵${m.toName}，${spanClause(m)}，因为守军 ${m.defender} 打得过，遂克，留兵 ${m.hold}`;
}

/** 财报：把一个月的流水按势力收成一张表。 */
export function booksOf(moves) {
  const rows = new Map();
  const row = (id, name) => {
    if (!rows.has(id)) {
      rows.set(id, {
        faction: id, name: name || id,
        grainIn: 0, goldIn: 0, grainRecruit: 0,
        grainMarch: 0, goldMarch: 0,
        horses: 0, horseGrain: 0, horseGold: 0,
        grainEnd: null, goldEnd: null,
      });
    }
    return rows.get(id);
  };
  for (const m of moves || []) {
    const r = row(m.faction, m.who);
    if (m.kind === '田赋') {
      r.grainIn += m.grain || 0;
      r.goldIn += m.gold || 0;
    } else if (m.kind === '征兵') {
      r.grainRecruit += m.grain || 0;
    } else if (m.kind === '出征' && m.result !== '未发') {
      r.grainMarch += (m.grain || 0);
      r.goldMarch += (m.gold || 0);
      r.horses += m.horses || 0;
      r.horseGrain += m.horseGrain || 0;
      r.horseGold += m.horseGold || 0;
    }
    if (m.grainEnd != null) r.grainEnd = m.grainEnd;
    if (m.goldEnd != null) r.goldEnd = m.goldEnd;
  }
  return [...rows.values()];
}
