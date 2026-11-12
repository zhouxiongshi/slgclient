/**
 * 城市经营层（P2/P3）：逐城产量、人口、城库存粮、灾害、忠诚与俸禄。
 * 零依赖（不 import strategy/panels），只读 map/detail 与 state，避免任何环。
 * 借鉴：三国志14（逐城开发/人口）、三国志11（俸禄-忠诚-灾害/运输队避险）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRes } from './economy.js';
/* 修 U21：灾害/叛逃改用确定性随机，同 seed + 回合可回放（strategy-rng 零内部依赖） */
import { rngFor } from './strategy-rng.js';
/* ★ U14 内政任务状：city-econ → interior-task 单向依赖（interior-task 不 import 回来，无环） */
import { advanceInteriorTasks } from './interior-task.js';
/* ★ U20 粮道连通与断粮：单向依赖 march（supply 不 import city-econ，无环）
 *   ★ M2 L2：军级补给线（supplyLineForArmy / armySupplyTick）与城级同模块同入口 */
import { supplyTick, armySupplyTick } from './supply.js';

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

/** 确保城市经济数据存在（新档/旧档首次进入时初始化）。
 *  ★ P7：12 维城属性不再是摆设——民心/治安/兵源/城防全部接进逐城经济，
 *    每座城的「性格」由 attrs 决定，玩家经营后逐城变化。
 */
export function ensureCityEcon(state) {
  const st = state.strategy;
  if (!st) return null;
  if (!st.cityEcon) st.cityEcon = {};
  const map = cityMap();
  for (const [id, c] of map) {
    const attr = c.attrs || {};
    if (!st.cityEcon[id]) {
      st.cityEcon[id] = {
        pop: Math.min(100000, c.population || 30000),
        devAgri: attr.农业 ?? 50,
        devTrade: attr.商业 ?? 50,
        devArms: attr.兵源 ?? 50,
        devDef: attr.城防 ?? 50,
        morale: attr.民心 ?? 60,          // 民心：影响人口增长与征兵意愿
        order: attr.治安 ?? 60,           // 治安：影响灾害概率与守军恢复
        store: 2000,
        mod: null,          // {grain: 0.5|1.5, until: day}
        disaster: null,     // 最近一次灾害 {type, day, name}
      };
    } else {
      // 旧档兜底：只补缺，不改已有值
      const e = st.cityEcon[id];
      if (e.devArms == null) e.devArms = attr.兵源 ?? 50;
      if (e.devDef == null) e.devDef = attr.城防 ?? 50;
      if (e.morale == null) e.morale = attr.民心 ?? 60;
      if (e.order == null) e.order = attr.治安 ?? 60;
    }
  }
  for (const id of Object.keys(st.cityEcon)) {
    if (!map.has(Number(id))) delete st.cityEcon[id];
  }
  return st.cityEcon;
}

/** 开发度 → 等级 1~5（三国志14 分档：0-23 / 24-47 / 48-71 / 72-95 / 96+）。 */
export function devLevel(dev) {
  return Math.max(1, Math.min(5, Math.floor((Number(dev) || 0) / 24) + 1));
}

/** 征兵工期系数：兵营等级越高越快（LV1 1.0 → LV5 0.76），民心低则征不动。 */
export function conscriptFactor(state, cityId) {
  const econ = ensureCityEcon(state);
  const e = econ?.[Number(cityId)];
  if (!e) return 1;
  const arms = devLevel(e.devArms);
  const morale = Number(e.morale ?? 60);
  const f = (1 - (arms - 1) * 0.06) * (0.9 + (100 - morale) / 200);
  return Math.max(0.7, Math.min(1.3, Math.round(f * 100) / 100));
}

/** 单城日产加成层（叠加在基础产量之上）。devAgri/50+1 系数：长安农业 87 → 粮 +52/日。
 *  ★ P7：民心也进产量（低民心怠耕），开发度按等级参与。 */
export function cityYield(state, cityId) {
  const econ = ensureCityEcon(state);
  const e = econ?.[Number(cityId)];
  const c = cityMap().get(Number(cityId));
  if (!e || !c) return null;
  let grainMod = 1;
  if (e.mod && Number(state.clock?.day) <= e.mod.until) grainMod = e.mod.grain;
  const besieged = state.strategy?.cities?.[Number(cityId)]?.besieged ? 0.5 : 1;
  // 民心 0~100 → 产量 ×0.85~1.10；民心越低越怠耕
  const moraleMod = 0.85 + (Number(e.morale ?? 60) / 400);
  /* ★ U20 断粮：陆上粮道断了，粮产 ×0.55（金产不受影响——商路走的是另一条线） */
  const cut = e.supplyCut ? 0.55 : 1;
  const grain = Math.round(30 * (e.devAgri / 50) * grainMod * besieged * moraleMod * cut);
  const gold = Math.round(20 * (e.devTrade / 50) * besieged * moraleMod);
  const extra = {};
  for (const sp of SPECIALTY_MAP) {
    if ((c.specialty || '').includes(sp.key)) extra[sp.res] = (extra[sp.res] || 0) + sp.add;
  }
  if (grainMod !== 1 && extra.grain) extra.grain = Math.round(extra.grain * grainMod);
  return {
    cityId: Number(cityId), grain, gold, extra, grainMod, besieged,
    pop: e.pop, store: e.store,
    devAgri: e.devAgri, devTrade: e.devTrade, devArms: e.devArms ?? 0, devDef: e.devDef ?? 0,
    lvAgri: devLevel(e.devAgri), lvTrade: devLevel(e.devTrade),
    lvArms: devLevel(e.devArms), lvDef: devLevel(e.devDef),
    morale: Math.round(e.morale ?? 60), order: Math.round(e.order ?? 60),
    moraleMod, specialty: c.specialty || '', disaster: e.disaster,
    supplyCut: !!e.supplyCut, supplyDays: Number(e.supplyDays) || 0,
  };
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

/** 每 30 日：人口自然增长（民心驱动）+ 各城自动屯粮入库（3×日产，上限 2 万）。 */
export function popTick(state, ctx) {
  const econ = ensureCityEcon(state);
  if (!econ) return;
  for (const [id, row] of Object.entries(state.strategy?.cities || {})) {
    if (row.owner !== 'player') continue;
    const e = econ[id];
    if (!e) continue;
    // 民心 0~100 → 增长 2%~6%（民心高则流民来附，民心低则逃亡）
    const rate = 0.02 + (Number(e.morale ?? 60) / 100) * 0.04;
    e.pop = Math.min(100000, Math.round(e.pop * (1 + rate)));
    const y = cityYield(state, id);
    e.store = Math.min(20000, e.store + 3 * (y?.grain || 0));
  }
}

/** 每 10 日（旬）：灾害掷骰。政务官在岗 → 概率 ×0.8；治安越高越少灾（P7）。 */
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
    /* 修 U07/U21：风险值按史实地理写入 map.json（原先 72 城全 null → 恒取 50，
       全图灾害概率一致）；掷骰改走确定性 rngFor，同 seed + 日 + 城 结果可回放。 */
    const riskVal = Number(c.attrs?.灾害风险 ?? c.disasterRisk ?? 50);
    const risk = riskVal / 100 + 0.5;   // 0.5~1.5
    const roll = rngFor(state.seed ?? 20261110, day, `disaster:${id}`).random();
    const civic = hasCivic ? 0.8 : 1;
    // ★ P7 治安：治安 100 时灾害概率 ×0.7，治安 0 时 ×1.0
    const orderK = 1 - (Number(e.order ?? 60) / 100) * 0.3;
    if (roll < 0.03 * risk * civic * orderK) {
      e.store = Math.round(e.store * 0.6);
      e.mod = { grain: 0.5, until: day + 10 };
      e.disaster = { type: 'locust', name: '蝗灾', day };
      e.morale = Math.max(0, (e.morale ?? 60) - 5);       // 灾害伤民心
      fired.push({ cityId: Number(id), name: cityName(id), type: '蝗灾', text: `${cityName(id)}爆发蝗灾：城内存粮蚀耗四成，未来十日粮产减半，民心 -5。` });
    } else if (roll < (0.03 + 0.02) * risk * civic * orderK) {
      if (Array.isArray(row.troops)) row.troops = row.troops.map((v) => Math.max(0, Math.round(Number(v) * 0.9)));
      e.pop = Math.round(e.pop * 0.95);
      e.disaster = { type: 'plague', name: '瘟疫', day };
      e.morale = Math.max(0, (e.morale ?? 60) - 3);
      fired.push({ cityId: Number(id), name: cityName(id), type: '瘟疫', text: `${cityName(id)}流行瘟疫：守军折损一成，人口折损半成，民心 -3。` });
    } else if (roll < (0.03 + 0.02 + 0.04) * civic * orderK) {
      e.mod = { grain: 1.5, until: day + 10 };
      e.disaster = { type: 'bumper', name: '丰收', day };
      e.morale = Math.min(100, (e.morale ?? 60) + 3);
      fired.push({ cityId: Number(id), name: cityName(id), type: '丰收', text: `${cityName(id)}今岁大丰收：未来十日粮产加五成，民心 +3。` });
    }
  }
  return fired;
}

/** 岗位 → 逐城开发度（三国志14 口径：委任官员按属性逐旬推动对应开发）。
 *  官员驻在哪座城，就推动哪座城——所以「派谁去边城」本身是内政决策。 */
const POST_DEV = {
  agri: { field: 'devAgri', stat: 'strategy', label: '农田', gain: 1.3 },
  commerce: { field: 'devTrade', stat: 'strategy', label: '市集', gain: 1.3 },
  military: { field: 'devArms', stat: 'defense', label: '兵营', gain: 1.1 },
  defense: { field: 'devDef', stat: 'force', label: '城防', gain: 1.0 },
  personnel: { field: 'morale', stat: 'strategy', label: '民心', gain: 0.8 },
};

/** 官员属性（英文五维 + 装备加成），0~10000。主公取 protagonist 基线。 */
function postStat(cfg, g, key) {
  const base = g.isProtagonist
    ? 7400
    : (Number(cfg?.generalByCfg?.get?.(Number(g.cfgId))?.[key]) || 6000);
  return base + (Number(g[`${key}_added`]) || 0);
}

/**
 * ★ P7 每旬：五项官职按属性推动「官员驻城」的开发度，并结算民心/治安的自然演变。
 *  - 开发度上限 120（超过 100 后收益递减，防止后期滚雪球）
 *  - 出征中的官员（所在队伍行军）内政收益减半——posts.json 的 visibleRule
 *  - 民心向该城基线回归；围城、城库缺粮都会掉民心；民心低则治安下滑
 */
export function cityDevTick(state, cfg, ctx) {
  const econ = ensureCityEcon(state);
  const st = state.strategy;
  if (!econ || !st) return { gains: [], upsets: [] };
  const posts = state.interior?.posts || {};
  const marching = new Set();
  for (const a of state.armys || []) {
    if (a.marchId) for (const gid of a.generals || []) if (gid) marching.add(Number(gid));
  }
  const gains = [];
  for (const [postId, conf] of Object.entries(POST_DEV)) {
    const gid = Number(posts[postId]) || 0;
    if (!gid) continue;
    const g = (state.generals || []).find((x) => x.id === gid);
    if (!g) continue;
    const cid = Number(g.cityId) || st.playerCity;
    const e = econ[cid];
    if (!e || st.cities[cid]?.owner !== 'player') continue;
    const stat = postStat(cfg, g, conf.stat);
    const cur = Number(e[conf.field]) ?? 0;
    const soft = cur >= 100 ? 0.3 : (cur >= 80 ? 0.6 : 1);   // 越高越难涨
    const half = marching.has(gid) ? 0.5 : 1;
    const gain = Math.max(0.1, conf.gain * (0.5 + stat / 10000) * soft * half);
    const next = Math.min(conf.field === 'morale' ? 100 : 120, cur + gain);
    e[conf.field] = Math.round(next * 10) / 10;
    gains.push({
      postId, label: conf.label, cityId: cid, city: cityName(cid),
      field: conf.field, gain: Math.round((next - cur) * 10) / 10,
      level: devLevel(e[conf.field]),
    });
  }
  // 民心/治安自然演变
  const upsets = [];
  for (const [id, row] of Object.entries(st.cities || {})) {
    if (row.owner !== 'player') continue;
    const e = econ[id];
    const c = cityMap().get(Number(id));
    if (!e || !c) continue;
    const base = Number(c.attrs?.民心 ?? 60);
    let dm = 0;
    if (row.besieged) dm -= 3;                  // 被围：民心崩
    if (e.store < 500) dm -= 2;                 // 城库见底：饿肚子
    if (e.morale > base + 10) dm -= 0.5;        // 高出基线自然回落
    else if (e.morale < base) dm += 0.5;        // 低于基线缓慢恢复
    const prevM = e.morale;
    e.morale = Math.max(0, Math.min(100, Math.round((e.morale + dm) * 10) / 10));
    // 治安：民心高则升，民心过低则流寇横行
    let doo = e.morale < 40 ? -1 : (e.morale > 70 ? 0.5 : 0);
    const prevO = e.order;
    e.order = Math.max(0, Math.min(100, Math.round((e.order + doo) * 10) / 10));
    if (Math.abs(e.morale - prevM) >= 1 || Math.abs(e.order - prevO) >= 1) {
      upsets.push({
        cityId: Number(id), city: cityName(id),
        morale: Math.round(e.morale), order: Math.round(e.order),
        dMorale: Math.round((e.morale - prevM) * 10) / 10,
        dOrder: Math.round((e.order - prevO) * 10) / 10,
      });
    }
  }
  return { gains, upsets };
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
  const econAll = state.strategy?.cityEcon || {};
  const day0 = day;
  for (const g of [...(state.generals || [])]) {
    const loyal = g.loyal ?? 88;
    let p = loyal < 40 ? 0.10 : (loyal < 70 ? 0.03 : 0);
    /* ★ M2 招抚（GDD §5.4）：驻城有活跃招抚（90 日内）时叛逃概率 −30% */
    const eApp = econAll[Number(g.cityId)];
    if (p > 0 && eApp && (Number(eApp.appeaseUntil) || 0) > day0) p *= 0.7;
    // 修 U21：叛逃掷骰走确定性 rngFor，同 seed + 日 + 武将结果恒定。
    if (p > 0 && rngFor(state.seed ?? 20261110, day, `defect:${g.id}`).random() < p) defected.push(g);
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
  /* ★ U14 内政任务状每日推进：旬界到账、完工写归因事件（无任务时是一次空循环，开销可忽略） */
  const tasks = advanceInteriorTasks(state, cfg, ctx);
  // ★ P7：旬结算先跑委任开发（官员推动驻城成长），再掷灾害
  /* ★ U20 粮道：旬界先判连通性（断粮城本旬就吃惩罚），再跑委任开发 */
  const supply = day % 10 === 0 ? supplyTick(state, cfg, ctx) : { isolated: [], recovered: [], hits: [] };
  /* ★ M2 粮道 L2：军级补给结算（通畅扣节点粮 / 断绝警告与逃兵），NPC 与玩家同入口 */
  const armySupply = day % 10 === 0 ? armySupplyTick(state, ctx) : { fed: [], cut: [] };
  const dev = day % 10 === 0 ? cityDevTick(state, cfg, ctx) : { gains: [], upsets: [] };
  const fired = day % 10 === 0 ? disasterTick(state, cfg, ctx) : [];
  const loyalty = day % 10 === 0 ? loyaltyTick(state, cfg, ctx) : null;
  if (day % 30 === 0) popTick(state, ctx);
  // 开发有实感时才播报（每旬每城最多一条），避免日志被 +0.3 刷屏
  const notable = dev.gains.filter((g) => g.gain >= 1);
  if (notable.length && ctx?.push) {
    const text = notable.map((g) => `${g.city}${g.label} +${g.gain}（Lv${g.level}）`).join('　');
    ctx.push('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【内政】委任见效：${text}`,
      time: Date.now(),
    });
  }
  return { fired, loyalty, dev, tasks, supply, armySupply };
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
