/**
 * 城市经营层（P2/P3）：逐城产量、人口、城库存粮、灾害、忠诚与俸禄。
 * 零依赖（不 import strategy/panels），只读 map/detail 与 state，避免任何环。
 * 借鉴：三国志14（逐城开发/人口）、三国志11（俸禄-忠诚-灾害/运输队避险）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRes } from './economy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAP_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json');

let CITY_MAP = null;
function cityMap() {
  if (!CITY_MAP) {
    const m = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
    CITY_MAP = new Map(m.cities.map((c) => [Number(c.id), c]));
  }
  return CITY_MAP;
}

export function cityName(id) {
  return cityMap().get(Number(id))?.name || `城${id}`;
}

/** 特产 → 资源日加成（文字特产字段做一次关键词映射）。 */
const SPECIALTY_MAP = [
  { key: '铁', res: 'iron', add: 80 },
  { key: '木', res: 'wood', add: 80 },
  { key: '粟', res: 'grain', add: 120 },
  { key: '盐', res: 'gold', add: 100 },
  { key: '茶', res: 'gold', add: 80 },
  { key: '马', res: 'gold', add: 60 },
  { key: '玉', res: 'gold', add: 60 },
];

/** 确保城市经济数据存在（新档/旧档首次进入时初始化）。 */
export function ensureCityEcon(state) {
  const st = state.strategy;
  if (!st) return null;
  if (!st.cityEcon) st.cityEcon = {};
  const map = cityMap();
  for (const [id, c] of map) {
    if (!st.cityEcon[id]) {
      st.cityEcon[id] = {
        pop: Math.min(100000, c.population || 30000),
        devAgri: c.attrs?.农业 ?? 50,
        devTrade: c.attrs?.商业 ?? 50,
        store: 2000,
        mod: null,          // {grain: 0.5|1.5, until: day}
        disaster: null,     // 最近一次灾害 {type, day, name}
      };
    }
  }
  for (const id of Object.keys(st.cityEcon)) {
    if (!map.has(Number(id))) delete st.cityEcon[id];
  }
  return st.cityEcon;
}

/** 单城日产加成层（叠加在基础产量之上）。devAgri/50+1 系数：长安农业 87 → 粮 +52/日。 */
export function cityYield(state, cityId) {
  const econ = ensureCityEcon(state);
  const e = econ?.[Number(cityId)];
  const c = cityMap().get(Number(cityId));
  if (!e || !c) return null;
  let grainMod = 1;
  if (e.mod && Number(state.clock?.day) <= e.mod.until) grainMod = e.mod.grain;
  const besieged = state.strategy?.cities?.[Number(cityId)]?.besieged ? 0.5 : 1;
  const grain = Math.round(30 * (e.devAgri / 50) * grainMod * besieged);
  const gold = Math.round(20 * (e.devTrade / 50) * besieged);
  const extra = {};
  for (const sp of SPECIALTY_MAP) {
    if ((c.specialty || '').includes(sp.key)) extra[sp.res] = (extra[sp.res] || 0) + sp.add;
  }
  if (grainMod !== 1 && extra.grain) extra.grain = Math.round(extra.grain * grainMod);
  return { cityId: Number(cityId), grain, gold, extra, grainMod, besieged, pop: e.pop, store: e.store, devAgri: e.devAgri, devTrade: e.devTrade, specialty: c.specialty || '', disaster: e.disaster };
}

/** 玩家名下全部城的加成层汇总（handlers.totalYield 叠加用）。 */
export function cityLayer(state) {
  const st = state.strategy;
  const out = { wood: 0, iron: 0, stone: 0, grain: 0, gold: 0 };
  if (!st) return out;
  for (const [id, row] of Object.entries(st.cities || {})) {
    if (row.owner !== 'player') continue;
    const y = cityYield(state, id);
    if (!y) continue;
    out.grain += y.grain;
    out.gold += y.gold;
    for (const [k, v] of Object.entries(y.extra)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

/** 每 30 日：人口自然增长（+4%，上限 10 万）+ 各城自动屯粮入库（3×日产，上限 2 万）。 */
export function popTick(state, ctx) {
  const econ = ensureCityEcon(state);
  if (!econ) return;
  for (const [id, row] of Object.entries(state.strategy?.cities || {})) {
    if (row.owner !== 'player') continue;
    const e = econ[id];
    if (!e) continue;
    e.pop = Math.min(100000, Math.round(e.pop * 1.04));
    const y = cityYield(state, id);
    e.store = Math.min(20000, e.store + 3 * (y?.grain || 0));
  }
}

/** 每 10 日（旬）：灾害掷骰。政务官在岗 → 概率 ×0.8（呼应职业体系）。 */
export function disasterTick(state, cfg, ctx) {
  const econ = ensureCityEcon(state);
  const st = state.strategy;
  if (!econ || !st) return [];
  const day = Math.floor(Number(state.clock?.day) || 1);
  const hasCivic = Object.values(state.interior?.posts || {}).some((v) => Number(v) > 0);
  const fired = [];
  for (const [id, row] of Object.entries(st.cities || {})) {
    if (row.owner !== 'player') continue;
    const e = econ[id];
    const c = cityMap().get(Number(id));
    if (!e || !c) continue;
    const risk = (c.attrs?.灾害风险 ?? 50) / 100 + 0.5;   // 0.5~1.5
    const roll = Math.random();
    const civic = hasCivic ? 0.8 : 1;
    if (roll < 0.03 * risk * civic) {
      e.store = Math.round(e.store * 0.6);
      e.mod = { grain: 0.5, until: day + 10 };
      e.disaster = { type: 'locust', name: '蝗灾', day };
      fired.push({ cityId: Number(id), name: cityName(id), type: '蝗灾', text: `${cityName(id)}爆发蝗灾：城内存粮蚀耗四成，未来十日粮产减半。` });
    } else if (roll < 0.03 * risk * civic + 0.02 * risk * civic) {
      if (Array.isArray(row.troops)) row.troops = row.troops.map((v) => Math.max(0, Math.round(Number(v) * 0.9)));
      e.pop = Math.round(e.pop * 0.95);
      e.disaster = { type: 'plague', name: '瘟疫', day };
      fired.push({ cityId: Number(id), name: cityName(id), type: '瘟疫', text: `${cityName(id)}流行瘟疫：守军折损一成，人口折损半成。` });
    } else if (roll < 0.03 * risk * civic + 0.02 * risk * civic + 0.04 * civic) {
      e.mod = { grain: 1.5, until: day + 10 };
      e.disaster = { type: 'bumper', name: '丰收', day };
      fired.push({ cityId: Number(id), name: cityName(id), type: '丰收', text: `${cityName(id)}今岁大丰收：未来十日粮产加五成。` });
    }
  }
  return fired;
}

/** 每 10 日（旬）：忠诚自然变化 + 旬俸 + 叛逃判定。三国志11 口径。 */
export function loyaltyTick(state, cfg, ctx) {
  const day = Math.floor(Number(state.clock?.day) || 1);
  const posts = state.interior?.posts || {};
  const postedIds = new Set(Object.values(posts).map(Number).filter((v) => v > 0));
  let salaryDue = 0;
  for (const g of state.generals || []) {
    if (postedIds.has(Number(g.id))) g.loyal = Math.min(100, (g.loyal ?? 88) + 0.5);
    else g.loyal = Math.max(0, (g.loyal ?? 88) - 1);
    salaryDue += 20 * (Number(g.star) || 3);
  }
  const r = state.roleRes;
  const salaryPaid = Math.min(r.gold || 0, salaryDue);
  r.gold = (r.gold || 0) - salaryPaid;
  if (salaryDue > 0) {
    if (salaryPaid < salaryDue) {
      for (const g of state.generals || []) g.loyal = Math.max(0, g.loyal - 5);
      recordRes(state, 'gold', -salaryPaid, '欠饷（俸禄不足，全军忠诚-5）', day);
      ctx?.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg: '【朝堂】府库空虚，武将俸禄发放不足，军心浮动（忠诚-5）。', time: Date.now() });
    } else {
      recordRes(state, 'gold', -salaryPaid, '武将旬俸', day);
    }
  }
  // 叛逃
  const defected = [];
  for (const g of [...(state.generals || [])]) {
    const p = (g.loyal ?? 88) < 40 ? 0.10 : ((g.loyal ?? 88) < 70 ? 0.03 : 0);
    if (p > 0 && Math.random() < p) defected.push(g);
  }
  for (const g of defected) {
    const cfgRow = cfg.generalByCfg?.get(Number(g.cfgId));
    const name = cfgRow?.name || `武将${g.cfgId}`;
    for (const army of state.armys || []) {
      const idx = (army.generals || []).indexOf(Number(g.id));
      if (idx >= 0) army.generals[idx] = 0;
    }
    if (Array.isArray(state.tavern?.people)) {
      for (const p2 of state.tavern.people) if (p2.name === name) p2.recruited = false;
    }
    state.generals = state.generals.filter((x) => x.id !== g.id);
    if (Array.isArray(state.skills)) {
      for (const s of state.skills) s.generals = (s.generals || []).filter((gid) => gid !== g.id);
    }
    ctx?.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg: `【朝堂】${name}因忠诚度过低（${Math.floor(g.loyal)}）出走，已离开我军。`, time: Date.now() });
  }
  return { salaryDue, salaryPaid, defected: defected.map((g) => cfg.generalByCfg?.get(Number(g.cfgId))?.name || `武将${g.cfgId}`) };
}

/** 统一入口：strategyTick 按日历调用。 */
export function cityEconTick(state, cfg, ctx) {
  const day = Math.floor(Number(state.clock?.day) || 1);
  ensureCityEcon(state);
  const fired = day % 10 === 0 ? disasterTick(state, cfg, ctx) : [];
  const loyalty = day % 10 === 0 ? loyaltyTick(state, cfg, ctx) : null;
  if (day % 30 === 0) popTick(state, ctx);
  return { fired, loyalty };
}

/** 出发行军粮：优先从出发城城库扣，不足部分吃全局池并加 25% 损耗。 */
export function consumeMarchGrain(state, cityId, need) {
  ensureCityEcon(state);
  const e = state.strategy?.cityEcon?.[Number(cityId)];
  const r = state.roleRes;
  const day = Math.floor(Number(state.clock?.day) || 1);
  let fromStore = 0;
  let fromPool = 0;
  if (e && e.store > 0) {
    fromStore = Math.min(e.store, need);
    e.store -= fromStore;
  }
  const remain = need - fromStore;
  if (remain > 0) {
    fromPool = Math.min(r.grain || 0, Math.ceil(remain * 1.25));
    r.grain = Math.max(0, (r.grain || 0) - fromPool);
    recordRes(state, 'grain', -fromPool, '行军粮（池，+25%损耗）', day);
  }
  if (fromStore) recordRes(state, 'grain', -fromStore, `行军粮（${cityName(cityId)}城库）`, day);
  return { fromStore, fromPool, enough: fromStore + fromPool >= need };
}

/** 运输队送达：粮入目标城库。 */
export function deliverGrain(state, cityId, grain) {
  ensureCityEcon(state);
  const e = state.strategy?.cityEcon?.[Number(cityId)];
  if (!e) return false;
  e.store = Math.min(20000, e.store + Math.max(0, Math.floor(grain)));
  return true;
}

/** 兵种适性：主属性/10000 → 100%~115%（只奖励不惩罚，保住既有首战平衡基线）。
 *  五维 ≥5000 起有加成，顶级武将（9500+）在强项兵种上 +14%。盾→defense、弓→strategy、骑→force。 */
const ARMS_STAT = { 1: 'defense', 2: 'strategy', 3: 'force' };
export function armsApt(g, armsIdx) {
  const stat = ARMS_STAT[armsIdx] || 'defense';
  const v = Number(g?.[stat]) || 0;
  return Math.max(1, Math.min(1.15, 0.85 + 0.3 * (v / 10000)));
}

/** 克制环：骑(3)→盾(1)→弓(2)→骑(3)，克制 ±15%（三战口径）。 */
export const ARMS_NAMES = { 1: '盾步', 2: '弓兵', 3: '骑兵' };
export function armsCounter(a, b) {
  if ((Number(a) === 3 && Number(b) === 1) || (Number(a) === 1 && Number(b) === 2) || (Number(a) === 2 && Number(b) === 3)) return 1;
  if ((Number(b) === 3 && Number(a) === 1) || (Number(b) === 1 && Number(a) === 2) || (Number(b) === 2 && Number(a) === 3)) return -1;
  return 0;
}
