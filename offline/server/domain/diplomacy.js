/**
 * 外交系统（GDD §5.8）：只对 NPC，**全部可解释**。
 *
 * 态度值模型（每对势力一个 attitude ∈ [-100, 100]，描述=计算同源）：
 *   attitude = 基础(史实关系·占位哈希) + 履约×5 − 背约×10
 *            + 联姻×15 + 赠礼(按价值/200，封顶 30) − 边境摩擦×3
 *            + 共同敌人×10 − 你占了他的城×20 − 离间失手×15
 *
 * 硬规则（GDD 原文）：**没有理由链的外交回复一律视为 bug**。
 * 任何动作（无论成败）都返回 factors[]，拒绝文案把「差在哪」逐条说清。
 *
 * 硬约束：自包含叶子——自读 conf/campaign/strategy/{factions,map}.json，
 * 邻接自建（marchGraph 复用，只读），只 import strategy-rng（叶子）；strategy 单向 import 本模块。
 * 确定性：不掷 Math.random；离间判定走 rngFor(seed, day, tag)。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marchGraph } from './march.js';
import { rngFor } from './strategy-rng.js';
/* ★ M2 离间智力判定：loreStat 走 oath.js（只依赖 node:fs 的叶子，无环） */
import { loreStat } from './oath.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FACTIONS_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'factions.json');
const MAP_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json');

export const PLAYER_ID = 'player';

/** 动作定义表（GDD §5.8 门槛表——门槛/代价/失败后果唯一口径）。 */
export const ACTIONS = {
  truce: {
    label: '停战', gate: -30, cost: 1500,
    desc: '休兵 90 日：对方不再进犯你的城', fail: 'attitude −5',
  },
  pass: {
    label: '通行权', gate: 20, cost: 800,
    desc: '获得借道许可（供后续军事通行判定消费）', fail: '拒绝',
  },
  ally: {
    label: '结盟', gate: 55, cost: 0,
    desc: '互不侵犯；盟友身份可直接「请求攻击」', fail: '拒绝，且对方可能告知你的敌人',
  },
  marriage: {
    label: '联姻', gate: 40, cost: 3000,
    desc: '宗室聘礼（占位口径）：两家关系 +15', fail: '拒绝，attitude −10',
  },
  requestAttack: {
    label: '请求攻击', gate: 60, cost: 2000,
    desc: '付定金请对方出兵打指定敌对势力（盟友免门槛）', fail: '口头答应但可能不出兵（betray 标记）',
  },
  surrender: {
    label: '劝降', gate: 0, cost: 0,
    desc: '兵力比 ≥ 3:1 且态度 ≥ 0 时可劝其举城归附；拒绝则开战', fail: '拒绝则开战（war + attitude −10）',
  },
  sow: {
    label: '离间', gate: 0, cost: 800,
    desc: '需目标都城情报 ≥ 传闻以上；智力判定失败被识破 attitude −15', fail: '被识破，attitude −15',
  },
  gift: {
    label: '赠礼', gate: 0, cost: 0,
    desc: '按礼金价值改善态度（每 200 金 +1，封顶 +30）', fail: '—',
  },
};

/* ---------------- 数据存取 ---------------- */

let confCache = null;
function diploConf() {
  if (confCache) return confCache;
  const factions = existsSync(FACTIONS_PATH)
    ? JSON.parse(readFileSync(FACTIONS_PATH, 'utf8'))
    : { factions: [], neutral: { id: 'han', name: '汉廷' } };
  const map = existsSync(MAP_PATH) ? JSON.parse(readFileSync(MAP_PATH, 'utf8')) : { cities: [] };
  confCache = { factions: factions.factions || [], neutral: factions.neutral || { id: 'han', name: '汉廷' }, cities: map.cities || [] };
  return confCache;
}

/** 势力名（player/han 兜底）。 */
export function factionNameOf(id) {
  const conf = diploConf();
  if (id === PLAYER_ID) return '我军';
  if (id === conf.neutral.id) return conf.neutral.name;
  return conf.factions.find((f) => f.id === id)?.name || id;
}

/** NPC 势力清单（视图用）。 */
export function factionList() {
  return diploConf().factions.map((f) => ({ id: f.id, name: f.name, color: f.color, home: f.home, blurb: f.blurb }));
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

/** 成对档案（旧档自动补）。 */
function pairData(state, a, b) {
  const st = state?.strategy;
  if (!st) return null;
  if (!st.diplomacy || typeof st.diplomacy !== 'object' || !st.diplomacy.pairs) st.diplomacy = { pairs: {} };
  const key = pairKey(a, b);
  if (!st.diplomacy.pairs[key]) {
    st.diplomacy.pairs[key] = {
      fulfill: 0, betray: 0, marriage: false, gifts: 0,
      occupied: 0, war: false, truceUntil: 0, pass: false, ally: false, sowFail: 0,
    };
  }
  return st.diplomacy.pairs[key];
}

/** 城级邻接（缓存一次：直接路段 + 经同一关隘的两侧城互为邻）。 */
let adjCache = null;
function cityAdjacency() {
  if (adjCache) return adjCache;
  const g = marchGraph();
  adjCache = new Map();
  if (!g) return adjCache;
  const link = (a, b) => {
    if (!a || !b || a === b) return;
    if (!adjCache.has(a)) adjCache.set(a, new Set());
    adjCache.get(a).add(b);
    if (!adjCache.has(b)) adjCache.set(b, new Set());
    adjCache.get(b).add(a);
  };
  for (const e of g.edges.values()) {
    link(g.cityIdByName.get(e.from), g.cityIdByName.get(e.to));
  }
  for (const gateName of Object.keys(g.gateStatus || {})) {
    const cs = [];
    for (const edgeId of g.adjacency.get(gateName) || []) {
      const e = g.edges.get(edgeId);
      const other = e.from === gateName ? e.to : e.from;
      const c = g.cityIdByName.get(other);
      if (c) cs.push(c);
    }
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) link(cs[i], cs[j]);
  }
  return adjCache;
}

/** 边境摩擦：与对方接壤的城数（封顶 6，避免大势力天然 −180）。 */
function frictionOf(state, a, b) {
  const st = state?.strategy;
  const adj = cityAdjacency();
  if (!st?.cities || !adj.size) return 0;
  const mine = Object.keys(st.cities).filter((id) => st.cities[id].owner === a).map(Number);
  let n = 0;
  for (const id of mine) {
    for (const nb of adj.get(id) || []) {
      if (st.cities[nb]?.owner === b) { n += 1; break; }
    }
    if (n >= 6) break;
  }
  return n;
}

/** 基础史实关系（占位口径：id 稳定哈希 ∈ [-40, 40]，等史实关系表落地后替换这一处）。 */
function baseOf(a, b) {
  const key = pairKey(a, b);
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return (h % 81) - 40;
}

/** 与 a 交战中的势力集合（war 标记）。 */
function enemiesOf(state, a) {
  const st = state.strategy;
  const conf = diploConf();
  const out = new Set();
  for (const f of [PLAYER_ID, ...conf.factions.map((x) => x.id)]) {
    if (f === a) continue;
    if (pairData(state, a, f).war) out.add(f);
  }
  return out;
}

/**
 * 态度与理由链（唯一口径）。
 * 返回 { value, factors: [{ label, delta }] }——factors 就是拒绝理由链的原料。
 */
export function attitudeOf(state, a, b) {
  const p = pairData(state, a, b);
  const factors = [];
  const add = (label, delta) => { if (delta) factors.push({ label, delta }); };
  const base = baseOf(a, b);
  add('基础(史实关系)', base);
  add('履约', p.fulfill * 5);
  add('背约', -p.betray * 10);
  add('联姻', p.marriage ? 15 : 0);
  add('赠礼', Math.min(30, Math.round((p.gifts || 0) / 200)));
  add('边境摩擦', -frictionOf(state, a, b) * 3);
  // 共同敌人：双方都在打的第三方（对 a、b 的视角各查一次，取两侧都成立者）
  let common = 0;
  for (const x of enemiesOf(state, a)) if (enemiesOf(state, b).has(x)) common += 1;
  add('共同敌人', common * 10);
  add('占其城池', -p.occupied * 20);
  add('离间失手', -p.sowFail * 15);
  const value = Math.max(-100, Math.min(100, factors.reduce((s, f) => s + f.delta, 0)));
  return { value, factors };
}

/** 我军总兵力（劝降兵力比口径：己方全部城守军之和）。 */
function totalTroops(state, id) {
  const st = state.strategy;
  let n = 0;
  for (const row of Object.values(st.cities)) {
    if (row.owner === id) n += Number(row.troops) || 0;
  }
  return n;
}

/** 势力都城（离间目标/劝降主城展示用）。 */
function homeCityOf(state, factionId) {
  const conf = diploConf();
  const home = conf.factions.find((f) => f.id === factionId)?.home;
  if (home) return conf.cities.find((c) => c.name === home)?.id || 0;
  // 没配都城：取该势力最大城
  let best = 0;
  let bestTroops = -1;
  for (const [id, row] of Object.entries(state.strategy.cities)) {
    if (row.owner === factionId && (Number(row.troops) || 0) > bestTroops) { best = Number(id); bestTroops = row.troops; }
  }
  return best;
}

/* ---------------- 视图 ---------------- */

/** 外交视图（每势力：态度 + 理由链 + 各动作门槛预览）。 */
export function diplomacyView(state) {
  const st = state?.strategy;
  if (!st?.cities) return { factions: [], day: 0 };
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const myTroops = totalTroops(state, PLAYER_ID);
  const factions = factionList().map((f) => {
    const { value, factors } = attitudeOf(state, PLAYER_ID, f.id);
    const p = pairData(state, PLAYER_ID, f.id);
    const hisTroops = totalTroops(state, f.id);
    const home = homeCityOf(state, f.id);
    return {
      id: f.id, name: f.name, color: f.color, home: f.home, blurb: f.blurb,
      homeCity: home,
      attitude: value, factors,
      war: !!p.war, ally: !!p.ally, pass: !!p.pass, marriage: !!p.marriage,
      truceUntil: p.truceUntil || 0, occupied: p.occupied || 0,
      troops: hisTroops, troopsRatio: hisTroops > 0 ? Math.round((myTroops / hisTroops) * 10) / 10 : 0,
      intel: (st.intel?.[home] ?? 0),
      gates: Object.fromEntries(Object.entries(ACTIONS).map(([k, A]) => [k, {
        gate: A.gate, cost: A.cost, ok: canPass(state, k, f.id, { value, myTroops, hisTroops, intel: st.intel?.[home] ?? 0 }).ok,
      }])),
    };
  });
  return { factions, day, myTroops };
}

function canPass(state, action, factionId, ctx = null) {
  const C = ctx || (() => {
    const { value } = attitudeOf(state, PLAYER_ID, factionId);
    return { value, myTroops: totalTroops(state, PLAYER_ID), hisTroops: totalTroops(state, factionId), intel: 0 };
  })();
  const A = ACTIONS[action];
  if (!A) return { ok: false, reason: 'bad_action' };
  if (action === 'requestAttack') return { ok: C.value >= A.gate || pairData(state, PLAYER_ID, factionId).ally };
  if (action === 'surrender') return { ok: C.value >= 0 && C.myTroops >= C.hisTroops * 3 };
  if (action === 'sow') return { ok: true };
  if (action === 'gift') return { ok: true };
  return { ok: C.value >= A.gate };
}

/* ---------------- 动作（玩家 → NPC） ---------------- */

function reject(state, factionId, action, gate, att) {
  const name = factionNameOf(factionId);
  const A = ACTIONS[action];
  const line = att.factors.filter((f) => f.delta !== 0)
    .map((f) => `${f.label}（${f.delta > 0 ? '+' : ''}${f.delta}）`).join('；');
  return {
    ok: false, code: 'rejected', action, faction: factionId,
    factors: att.factors,
    text: `${name}拒绝${A.label}：${line}；当前态度 ${att.value}，未达 ${gate}。`,
  };
}

function recordEvent(state, text) {
  const st = state.strategy;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

function pay(state, cost, note) {
  const r = state.roleRes;
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  if ((Number(r.gold) || 0) < cost) return false;
  r.gold -= cost;
  // 走既有流水账（economy.recordRes 的形态），保持府库可审计
  if (!Array.isArray(state.resLogs)) state.resLogs = [];
  state.resLogs.push({ res: 'gold', delta: -cost, note, day });
  return true;
}

/**
 * 外交动作入口。无论成败都带 factors（理由链强制，GDD §5.8）。
 * 返回 { ok, text, ... } 或 { ok:false, code:'rejected'|..., text, factors }。
 */
export function diplomacyAct(state, cfg, ctx, { action, faction, target, gold }) {
  const st = state?.strategy;
  const fid = String(faction || '');
  if (!st?.cities) return { ok: false, reason: 'no_state' };
  if (fid === PLAYER_ID || !diploConf().factions.some((f) => f.id === fid)) return { ok: false, reason: 'no_faction' };
  const A = ACTIONS[action];
  if (!A) return { ok: false, reason: 'bad_action' };
  const att = attitudeOf(state, PLAYER_ID, fid);
  const p = pairData(state, PLAYER_ID, fid);
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));

  // 赠礼：无门槛，礼金自定（100~20000）
  if (action === 'gift') {
    const amt = Math.max(100, Math.min(20000, Math.floor(Number(gold) || 0)));
    if (!pay(state, amt, `外交赠礼·${factionNameOf(fid)}`)) {
      return { ok: false, code: 'no_gold', text: `库金不足，赠礼未成（需 ${amt} 金）。`, factors: att.factors };
    }
    p.gifts = (p.gifts || 0) + amt;
    const after = attitudeOf(state, PLAYER_ID, fid);
    recordEvent(state, `遣使赠礼于${factionNameOf(fid)}（${amt} 金），其使致谢而归。`);
    return { ok: true, text: `${factionNameOf(fid)}收下赠礼（${amt} 金）：态度 ${att.value} → ${after.value}。`, factors: after.factors, attitude: after.value };
  }

  // 离间：门槛不在态度，在情报与智力判定（失败后果 attitude −15）
  if (action === 'sow') {
    if (!pay(state, A.cost, `离间·${factionNameOf(fid)}`)) {
      return { ok: false, code: 'no_gold', text: `库金不足（需 ${A.cost} 金），离间未行。`, factors: att.factors };
    }
    const home = homeCityOf(state, fid);
    const intel = st.intel?.[home] ?? 0;
    if (intel < 1) {
      // 情报不足不扣费（先扣后退），给出明确指引——张力守恒：情报是硬前提
      state.roleRes.gold += A.cost;
      state.resLogs.pop();
      return { ok: false, code: 'no_intel', text: `${factionNameOf(fid)}都城尚无情报（需先侦察至「估算」档），细作不敢妄动，金已退还。`, factors: att.factors };
    }
    // 智力判定：我方最强谋士 vs 固定阈值，rngFor 确定性
    const bestIntellect = bestStatOf(state);
    const chance = Math.max(0.2, Math.min(0.8, 0.3 + (bestIntellect - 6000) / 10000));
    const rolled = rngFor(state.seed ?? 20261110, day, `diploSow:${fid}`).random();
    if (rolled >= chance) {
      p.sowFail = (p.sowFail || 0) + 1;
      const after = attitudeOf(state, PLAYER_ID, fid);
      recordEvent(state, `离间${factionNameOf(fid)}被识破，使者下狱（智力 ${bestIntellect}，成率 ${Math.round(chance * 100)}%）。`);
      return { ok: false, code: 'exposed', text: `离间被${factionNameOf(fid)}识破：态度 ${att.value} → ${after.value}（−15）。`, factors: after.factors, attitude: after.value };
    }
    const trow = st.cities[home];
    let cut = 0;
    if (trow) { cut = Math.round((Number(trow.troops) || 0) * 0.05); trow.troops = Math.max(200, (Number(trow.troops) || 0) - cut); }
    recordEvent(state, `细作散布流言于${factionNameOf(fid)}，其都城守军离心（−${cut}）。`);
    return { ok: true, text: `离间得手：${factionNameOf(fid)}都城守军 −${cut}（智力 ${bestIntellect}，成率 ${Math.round(chance * 100)}%）。`, factors: att.factors };
  }

  // 门槛判定（含拒绝对 attitude 的副作用）
  const myTroops = totalTroops(state, PLAYER_ID);
  const hisTroops = totalTroops(state, fid);
  if (action === 'requestAttack') {
    const gateOk = att.value >= A.gate || p.ally;
    if (!gateOk) return reject(state, fid, action, A.gate, att);
  } else if (action === 'surrender') {
    if (att.value < 0 || myTroops < hisTroops * 3) {
      const r = reject(state, fid, action, '兵力比 3:1 且态度 0', att);
      r.text = `${factionNameOf(fid)}拒绝归附：我军兵力 ${myTroops} 对其 ${hisTroops}（需 3:1）；${att.value < 0 ? `态度 ${att.value}，未达 0。` : '兵威不足，其主尚有底气。'}`;
      p.war = true;   // 拒绝则开战（GDD 门槛表）
      const after = attitudeOf(state, PLAYER_ID, fid);
      recordEvent(state, `劝降${factionNameOf(fid)}被拒，两方自此交恶。`);
      r.factors = after.factors;
      return r;
    }
  } else if (att.value < A.gate) {
    // 停战被拒：attitude −5（门槛表「失败后果」）
    if (action === 'truce') p.fulfill = Math.max(0, (p.fulfill || 0) - 1);
    if (action === 'marriage') p.betray = (p.betray || 0) + 1;   // 联姻被拒 attitude −10（走背约档）
    return reject(state, fid, action, A.gate, att);
  }

  // 代价
  if (A.cost > 0 && !pay(state, A.cost, `外交·${A.label}·${factionNameOf(fid)}`)) {
    return { ok: false, code: 'no_gold', text: `库金不足（需 ${A.cost} 金），${A.label}未成。`, factors: att.factors };
  }

  // 效果
  const line = `${factionNameOf(fid)}`;
  switch (action) {
    case 'truce':
      p.war = false;
      p.truceUntil = day + 90;
      p.fulfill = (p.fulfill || 0) + 1;
      recordEvent(state, `与${line}订立停战之约，休兵 90 日（至第 ${p.truceUntil} 日）。`);
      break;
    case 'pass':
      p.pass = true;
      p.fulfill = (p.fulfill || 0) + 1;
      recordEvent(state, `${line}许我军借道通行。`);
      break;
    case 'ally':
      p.ally = true;
      p.war = false;
      st.relations = st.relations || {};
      st.relations[pairKey(PLAYER_ID, fid)] = 'ally';   // NPC 脑的 isAllied 直接消费
      p.fulfill = (p.fulfill || 0) + 1;
      recordEvent(state, `与${line}缔结盟约，互不侵犯。`);
      break;
    case 'marriage':
      p.marriage = true;
      p.fulfill = (p.fulfill || 0) + 1;
      recordEvent(state, `两家联姻，${line}遣使道贺（态度 +15）。`);
      break;
    case 'requestAttack': {
      const targetId = String(target || '');
      if (!diploConf().factions.some((f) => f.id === targetId) && targetId !== 'han') {
        return { ok: false, reason: 'bad_target', text: '请指明要讨伐的势力。', factors: att.factors };
      }
      if (targetId === PLAYER_ID) return { ok: false, reason: 'bad_target', text: '不能请对方攻打我军。', factors: att.factors };
      p.fulfill = (p.fulfill || 0) + 1;
      st.diploPrompt = { faction: fid, target: targetId, until: day + 30, betray: att.value < 70 };
      recordEvent(state, `${line}应我军之请，允诺出兵讨伐${factionNameOf(targetId)}${att.value < 70 ? '（口头答应，未必尽力）' : ''}。`);
      break;
    }
    case 'surrender': {
      // 举城归附：兵力与城防保留（善待降城，民心不坠）
      let cities = 0;
      for (const row of Object.values(st.cities)) {
        if (row.owner === fid) { row.owner = PLAYER_ID; cities += 1; }
      }
      p.war = false;
      p.ally = true;
      st.relations = st.relations || {};
      st.relations[pairKey(PLAYER_ID, fid)] = 'ally';
      recordEvent(state, `${line}见我军兵威与恩义，举${cities}城归附！`);
      ctx?.push?.('chat.push', {
        rid: 0, nickName: '系统', type: 0,
        msg: `【天下】${line}举城归附我军（${cities} 城）！`,
        time: Date.now(),
      });
      break;
    }
    default:
      return { ok: false, reason: 'bad_action' };
  }
  const after = attitudeOf(state, PLAYER_ID, fid);
  return { ok: true, action, faction: fid, text: `${A.label}已成：态度 ${att.value} → ${after.value}。`, factors: after.factors, attitude: after.value };
}

/** 我方在城武将中某维最强值（智力判定用；loreStat 折算与 interior-task 同口径）。 */
function bestStatOf(state) {
  const marching = new Set();
  for (const a of state.armys || []) if (a.marchId) for (const gid of a.generals || []) if (gid) marching.add(Number(gid));
  let best = 0;
  for (const g of state.generals || []) {
    if (marching.has(Number(g.id))) continue;
    if (g.isProtagonist) { best = Math.max(best, 7400); continue; }
    best = Math.max(best, Math.round(Number(loreStat(Number(g.cfgId), '智力')) * 80) + (Number(g.strategy_added) || 0));
  }
  return best || 6000;
}

/* ---------------- 状态机钩子（strategy 单向调用） ---------------- */

/** 城池易手登记（攻城结算处调用）：占城 −20、开战；停战期毁约 → 背约。 */
export function noteCityCaptured(state, winnerId, loserId) {
  if (!state?.strategy || winnerId === loserId) return;
  if (loserId !== PLAYER_ID && loserId !== 'han' && !diploConf().factions.some((f) => f.id === loserId)) return;
  const p = pairData(state, winnerId, loserId);
  p.occupied = (p.occupied || 0) + 1;
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  // 停战期攻城 = 毁约（attitude −10，走背约档）
  if (p.truceUntil > day) { p.betray = (p.betray || 0) + 1; p.truceUntil = 0; }
  p.war = true;
}

/** NPC 脑出兵前问一句：与 target 是否在停战期（applyOrders 消费）。 */
export function truceActive(state, factionId, targetOwnerId) {
  if (!state?.strategy) return false;
  const p = state.strategy.diplomacy?.pairs?.[pairKey(factionId, targetOwnerId)];
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  return !!p && p.truceUntil > day;
}
