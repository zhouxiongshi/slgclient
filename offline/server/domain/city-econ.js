/**
 * 城市经营层（P2/P3）：逐城产量、人口、城库存粮、灾害、忠诚与俸禄。
 * 零依赖（不 import strategy/panels），只读 map/detail 与 state，避免任何环。
 * （逐城开发/人口）、（俸禄-忠诚-灾害/运输队避险）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRes } from './economy.js';
/* ★ M4-8：战斗/内政/外交/行军共用同一份武将属性基线，禁止各自硬编码主角数值 */
import { gameStatOf } from './general-stat.js';
/* 修 U21：灾害/叛逃改用确定性随机，同 seed + 回合可回放（strategy-rng 零内部依赖） */
import { rngFor } from './strategy-rng.js';
/* ★ U14 内政任务状：city-econ → interior-task 单向依赖（interior-task 不 import 回来，无环） */
import { advanceInteriorTasks } from './interior-task.js';
/* ★ U20 粮道连通与断粮：单向依赖 march（supply 不 import city-econ，无环）
 *   ★ M2 L2：军级补给线（supplyLineForArmy / armySupplyTick）与城级同模块同入口 */
import { supplyTick, armySupplyTick } from './supply.js';
/* ★ P50 太守制（2026-11-23，对齐成熟 SLG 内政惯例）：旬界太守自动办政，替换旧长驻委任
   （appointment.js 已删）；走 interior-task 同源，产出与旧手动/委任完全一致。 */
import { governorTick } from './governor.js';
/* ★ P61-S1：方针真实改变产量配比；policy-effects 是零依赖叶子，不成环 */
import { policyEffect } from './policy-effects.js';
import { knobGet } from './knobs.js';
/* ★ 2026-11-20：春征秋收惩罚的季节判定复用 levy 的唯一口径（零依赖叶子，无环）。 */
/* ★ P74：低位人口按「户」保底，户均人口必须与兵役口径同一常量，不许另写 5。 */
import { seasonOf, HOUSEHOLD_SIZE } from './levy.js';

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
        /* ★ P13 人口扩容（用户 2026-11-16）：初始人口阶梯 ×3~7（map.json），上限 10 万 → 100 万。 */
        pop: Math.min(1000000, c.population || 30000),
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

/** 开发度 → 等级 1~5（分档：0-23 / 24-47 / 48-71 / 72-95 / 96+）。 */
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
  /* ★ 2026-11-20 修：春征超过兵源上限 50% 的城，当年秋季粮产按 farmConflict 承诺扣减。
     惩罚落账在 handlers 春征处（farmPenaltyYear/Pct），这里只在秋季兑现；跨年自动失效。 */
  const curYear = Math.floor((Math.max(1, Math.floor(Number(state.clock?.day) || 1)) - 1) / 360);
  const autumnPenalty = (seasonOf(state) === '秋'
    && Number(e.farmPenaltyYear) === curYear && Number(e.farmPenaltyPct) > 0)
    ? 1 - Math.min(90, Number(e.farmPenaltyPct)) / 100 : 1;
  /* ★ 2026-11-19 城产平衡：旧系数（粮 30 / 金 20）下单城满开发只有 40 金/旬，
     5 座城合计 274 金/旬，而武将旬俸就要 380——占城是纯负收益，扩张越多亏越多。
     实测（探针 p3/p6）：纯城产口径净亏 202 金/旬。
     这里把金产 20→60、粮产 30→38，使 5 城金产约 820/旬、粮产约 3300/旬，
     在扣掉 35% 城防俸饷与武将俸禄后仍为正循环（约 +150 金/旬）。
     只改派生系数，不动原表、不动战斗数值。 */
  /* ★ P61-S1：太守方针改的是资源分配，不只是施工顺序。重农粮 +25% 金 −15%，
     固防商税减半石 +25%……不同路线第 10 旬就有可测差距。NPC 城无太守记录，恒 auto。 */
  const pol = policyEffect(state.strategy?.governors?.[cityId]?.policy);
  const yieldOf = (key) => Number(pol.yields?.[key]) || 1;
  const grain = Math.round(38 * (e.devAgri / 50) * grainMod * besieged * moraleMod * cut * autumnPenalty * yieldOf('grain'));
  const gold = Math.round(60 * (e.devTrade / 50) * besieged * moraleMod * yieldOf('gold'));
  const extra = {};
  for (const sp of SPECIALTY_MAP) {
    if ((c.specialty || '').includes(sp.key)) extra[sp.res] = (extra[sp.res] || 0) + sp.add;
  }
  /* ★ 2026-11-18 经济闭环：石头此前在逐城层零产出（特产表无石、cityYield 只出粮金），
     全靠采石场/领地石矿，且和「城防开发度」没有任何关系。
     这里给一座城一份派生石产：城等级 + 城防开发度越高，采石越多；玩家投石修城防
     → 石产上升 → 再投石/修墙，形成闭环。不改原表（派生层计算），与木/铁特产同等量级偏低。 */
  const lv = Math.max(1, Math.min(3, Math.trunc(Number(c.level) || 1)));
  const stoneBase = Math.round(12 + lv * 8 + (Number(e.devDef ?? 50) / 50) * 16);
  extra.stone = ((extra.stone || 0) + stoneBase) * yieldOf('stone');
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

function ownedCityCount(state) {
  return Object.values(state.strategy?.cities || {}).filter((row) => row?.owner === 'player').length;
}

/**
 * 府库日产。还没有城时沿用配置里的基础产量（序章坞堡）。
 * 已有城之后，每天固定 1000 不再叠上城产，木铁石粮金都要靠城和设施，才能花到征兵和升级上。
 */
export function playerStockYield(state, key, base, facility = 0, build = 0) {
  const cl = cityLayer(state);
  const diff = Number(knobGet(state, 'difficultyRes')) || 1;
  const local = Math.max(0, Math.floor(Number(facility) || 0)) + Math.max(0, Math.floor(Number(build) || 0));
  const city = Math.round((Number(cl[key]) || 0) * diff);
  if (ownedCityCount(state) > 0) return city + local;
  return Math.round(((Number(base) || 0) + local) * diff);
}

export function playerGrainYield(state, baseGrain, facilityGrain, buildGrain) {
  return playerStockYield(state, 'grain', baseGrain, facilityGrain, buildGrain);
}

export function playerGoldYield(state, baseGold, facilityGold) {
  return playerStockYield(state, 'gold', baseGold, facilityGold, 0);
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

/** 城库存粮上限随人口缩放（★ P13）：大城屯大粮，行军大军不再被 2 万仓宽卡死。
 *  2 万起底（小城与旧值一致），人口 ×0.12 线性放大，24 万封顶（对应人口 200 万）。 */
export function storeCapOf(e) {
  const pop = Math.max(0, Math.floor(Number(e?.pop) || 0));
  return Math.max(20000, Math.min(240000, Math.round(pop * 0.12)));
}

/** 每 30 日：人口自然增长（民心驱动）+ 各城自动屯粮入库（3×日产，上限随人口）。 */
export function popTick(state, ctx) {
  const econ = ensureCityEcon(state);
  if (!econ) return;
  for (const [id, row] of Object.entries(state.strategy?.cities || {})) {
    if (row.owner !== 'player') continue;
    const e = econ[id];
    if (!e) continue;
    /* 每 10 日结一次。默认 3%×(1+民心/100)，民心 60 时大约每旬 +4.8%。
       沙盘一天约 2 秒，坐一分钟就能看见人丁，不再像按年才涨一次。 */
    const rate = knobGet(state, 'popGrowthYear') * (1 + (Number(e.morale ?? 60) / 100));
    const popBefore = Math.max(0, Math.floor(Number(e.pop) || 0));
    /* ★ P72：低位保底 +1，避免 round 把 5~6 口的增长抹成 0、兵源永久卡死。
       ★ P74：保底改成「按户」——1 户 5 口，只 +1 口等于 5 旬才多 1 户、
       8 旬才多 1 个壮丁，玩家体感就是「城在等死」。现在 1000 口以下每旬至少 +1 户，
       受创的小城约 20~30 旬能重新拉出一支能打的队伍。 */
    const floorStep = popBefore < 1000 ? HOUSEHOLD_SIZE : 1;
    e.pop = Math.min(1000000, Math.max(popBefore + floorStep, Math.round(popBefore * (1 + rate))));   // ★ P13 上限 10 万 → 100 万
    const y = cityYield(state, id);
    e.store = Math.min(storeCapOf(e), e.store + 3 * (y?.grain || 0));
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
      /* 城池守军权威类型是数字（strategy.cities[id].troops = garrisonOf(c)），
         旧写 Array.isArray 恒 false，文案说「守军折损一成」却从未生效。 */
      if (Number.isFinite(Number(row.troops))) {
        row.troops = Math.max(0, Math.round((Number(row.troops) || 0) * 0.9));
      }
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

/** 岗位 → 逐城开发度（口径：委任官员按属性逐旬推动对应开发）。
 *  官员驻在哪座城，就推动哪座城——所以「派谁去边城」本身是内政决策。 */
const POST_DEV = {
  agri: { field: 'devAgri', stat: 'strategy', label: '农田', gain: 1.3 },
  commerce: { field: 'devTrade', stat: 'strategy', label: '市集', gain: 1.3 },
  military: { field: 'devArms', stat: 'defense', label: '兵营', gain: 1.1 },
  defense: { field: 'devDef', stat: 'force', label: '城防', gain: 1.0 },
  personnel: { field: 'morale', stat: 'strategy', label: '民心', gain: 0.8 },
};

/** 官员属性（英文五维 + 装备加成），0~100（M4-10 百分制）。
 *  ★ M4-8：主公不再恒取 7400，改为读 protagonist.json 的对应维度，与战斗同源。 */
function postStat(cfg, g, key) {
  return gameStatOf(cfg, g, key, 60) + (Number(g[`${key}_added`]) || 0);
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
    const gain = Math.max(0.1, conf.gain * (0.5 + stat / 100) * soft * half);
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

/* ★ 2026-11-20 玩法修复（自迭代第一轮）：忠诚不是「倒计时」，是「可管理的状态」。
 *
 *   旧实现：只要没被委任到 5 个岗位之一，就每旬 -1 忠诚、无下限。
 *   岗位全图固定 5 个，而「名士来投」「招降敌将」会持续加人 →
 *   第 6 名武将起就是一颗定时炸弹：约 48 旬跌到 40 以下，之后每旬 10% 叛逃。
 *   实测：开局 4 将挂机 150 旬，主角（id 1000）在 T62 因忠诚过低叛逃离队，
 *   整局叙事断裂且不可恢复；同期 T15/T30 各来投 1 人，来的人反而加速崩盘。
 *   也就是说「招到新武将」= 惩罚，激励方向完全反了。
 *
 *   新口径（FIELD-CONTRACT 同名段落）：
 *     · 主角不参与忠诚系统：不衰减、不叛逃（叙事锚点，掉了无法恢复）；
 *     · 委任岗位：+0.6/旬（上限 100）；
 *     · 未委任：向「基线 70」缓慢回落 -0.3/旬，已低于基线则 +0.2 缓慢回血
 *       —— 闲置不会把人耗死，但也不会白送到 100；
 *     · 欠饷 -5 / 民心崩（仅玩家城 morale < 30）额外 -1：这是真压力，靠玩家解决；
 *     · 叛逃只在 loyal < 40（10%）与 40~55（3%）时掷骰；
 *     · 首次跌破 55 给一条「离心」预警，玩家还有赏赐/委任两条路可救。
 */
export const LOYAL_BASELINE = 70;
const LOYAL_UNPOSTED_DECAY = 0.3;
const LOYAL_UNPOSTED_RECOVER = 0.2;
const LOYAL_POSTED_GAIN = 0.6;
const LOYAL_WARN_LINE = 55;
/* 民心崩的额外惩罚有下限：只把人压到 45（进入 3% 出走风险区），
   不会一路压到 0。否则「闲置 + 民心低」= 慢性清队，仍然是无解的死循环。 */
const LOYAL_CRISIS_FLOOR = 45;

/** ★ P47#1 忠诚唯一读写口径：新增 / 招降 / 旬结算 / 赏赐都从这里走，
 *  避免「俘虏对象 loyal:50 直接塞进武将数组」把玩家养了几十旬的高忠诚覆盖掉。
 *  旧档缺字段按 88 兜底（与 world.makeGeneral 初始值一致）。 */
export function loyaltyOf(g) {
  const n = Number(g?.loyal);
  return Number.isFinite(n) ? n : 88;
}
export function setLoyalty(g, value) {
  if (!g) return 0;
  const n = Number(value);
  g.loyal = Math.round((Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 88) * 10) / 10;
  return g.loyal;
}

/** ★ 2026-11-20：帐下人数上限 = 4 + 己方城数 × 2（下限 4）。
 *  旧版没有上限，而「名士来投」的名声公式里含「帐下武将数 × 2」——人多 → 名声高 →
 *  来投更快 → 人更多。实测挂机 150 旬，只剩 1 座城的玩家帐下有 19 名武将，
 *  旬俸 1140 金而单城旬入约 200，直接进入「欠饷 → 忠诚崩 → 出走」的死亡螺旋。
 *  上限把这条正反馈掐掉，同时让「扩城」变成养人的硬前提。
 *  招降（花钱）不受此限——钱可以买到编制外的人，这是刻意留的口子。
 *  放在 city-econ（零依赖叶子）而不是 strategy：panels 需要它但不能 import strategy（会成环）。 */
export function generalCapacity(state) {
  const cities = Object.values(state?.strategy?.cities || {})
    .filter((c) => c && c.owner === 'player').length;
  /* 里程碑奖励的编制加成（strategy.stageGoalTick 写 strategy.bonusSeats） */
  const bonus = Math.max(0, Math.round(Number(state?.strategy?.bonusSeats) || 0));
  return Math.max(4, 4 + cities * 2 + bonus);
}

/** 当前旬俸合计（金/旬）。UI 与忠诚结算共用同一口径，避免双轨。 */
export function salaryDueOf(state) {
  return (state?.generals || []).reduce((n, g) => n + 20 * (Number(g.star) || 3), 0);
}

/** 本地事件写入（city-econ 是零依赖叶子，不能 import strategy 的 recordEvent，否则成环）。
 *  形状与 strategy.recordEvent 完全一致，上限同 480，保证 UI 与存档口径单源。 */
function pushEvent(state, text) {
  const st = state?.strategy;
  if (!st) return;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn ?? 0, text: String(text || ''), day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

/** 每 10 日（旬）：忠诚自然变化 + 旬俸 + 叛逃判定。口径见上方块注释。 */
export function loyaltyTick(state, cfg, ctx) {
  const day = Math.floor(Number(state.clock?.day) || 1);
  const posts = state.interior?.posts || {};
  const postedIds = new Set(Object.values(posts).map(Number).filter((v) => v > 0));
  /* ★ P50 太守制：太守视为「委任在岗」，与六府岗位同享 +0.6/旬（FIELD-CONTRACT §太守制）。 */
  for (const gv of Object.values(state.strategy?.governors || {})) {
    const oid = Number(gv?.officerId) || 0;
    if (oid > 0) postedIds.add(oid);
  }
  /* 民心崩：★ P47#1 只统计「玩家自己」的城。
     旧写法遍历全图 72 城，扬州 52/53/55 三座敌城民心原生为 0，
     于是玩家武将每旬无条件 -1，80 旬后 85 → 45，完美复现「高忠诚内政后
     一补员就掉到 50」。敌城民心好坏与我军军心无关，这里必须按归属过滤。 */
  const moraleCrisis = Object.entries(state.strategy?.cityEcon || {})
    .some(([id, e]) => e && state.strategy?.cities?.[id]?.owner === 'player' && Number(e.morale) < 30);
  let salaryDue = 0;
  for (const g of state.generals || []) {
    salaryDue += 20 * (Number(g.star) || 3);
    if (g.isProtagonist) continue;                  // 主角恒定，不进入忠诚/叛逃链路
    const loyal = loyaltyOf(g);
    let next;
    if (postedIds.has(Number(g.id))) next = Math.min(100, loyal + LOYAL_POSTED_GAIN);
    else if (loyal > LOYAL_BASELINE) next = Math.max(LOYAL_BASELINE, loyal - LOYAL_UNPOSTED_DECAY);
    else next = Math.min(LOYAL_BASELINE, loyal + LOYAL_UNPOSTED_RECOVER);
    if (moraleCrisis) next = Math.max(LOYAL_CRISIS_FLOOR, next - 1);
    setLoyalty(g, next);
  }
  const r = state.roleRes;
  const salaryPaid = Math.min(r.gold || 0, salaryDue);
  r.gold = (r.gold || 0) - salaryPaid;
  if (salaryDue > 0) {
    if (salaryPaid < salaryDue) {
      for (const g of state.generals || []) {
        if (g.isProtagonist) continue;              // 欠饷罚不到主角身上（他不是雇员）
        setLoyalty(g, loyaltyOf(g) - 5);
      }
      recordRes(state, 'gold', -salaryPaid, '欠饷（俸禄不足，全军忠诚-5）', day);
      ctx?.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg: '【朝堂】府库空虚，武将俸禄发放不足，军心浮动（忠诚-5）。', time: Date.now() });
    } else {
      recordRes(state, 'gold', -salaryPaid, '武将旬俸', day);
    }
  }
  /* 离心预警：首次跌破预警线时给一次明确提示，玩家还有「赏赐 / 委任」两条低成本补救路。 */
  if (!state.loyalWarned || typeof state.loyalWarned !== 'object') state.loyalWarned = {};
  for (const g of state.generals || []) {
    if (g.isProtagonist) continue;
    const key = String(g.id);
    if (Number(g.loyal) < LOYAL_WARN_LINE && !state.loyalWarned[key]) {
      state.loyalWarned[key] = day;
      const nmW = cfg.generalByCfg?.get(Number(g.cfgId))?.name || `武将${g.cfgId}`;
      pushEvent(state, `${nmW} 忠诚降至 ${Math.floor(Number(g.loyal))}，已现离心之意——委任岗位或赏赐可挽回。`);
      ctx?.push?.('chat.push', {
        rid: 0, nickName: '系统', type: 0,
        msg: `【朝堂】${nmW} 忠诚仅 ${Math.floor(Number(g.loyal))}，心怀去意。可在武将页「赏赐」，或委任内政岗位稳住。`,
        time: Date.now(),
      });
    }
  }
  // 叛逃（主角永不叛逃）
  const defected = [];
  for (const g of [...(state.generals || [])]) {
    if (g.isProtagonist) continue;
    const loyal = Number(g.loyal ?? 88);
    const p = loyal < 40 ? 0.10 : (loyal < LOYAL_WARN_LINE ? 0.03 : 0);
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
  /* ★ P50 太守制：旬界太守按方针自动办政（blocked 置顶报告），产出与手动同源 */
  const govs = day % 10 === 0 ? governorTick(state, cfg, ctx) : { started: [], blocked: [], resumed: [], ended: [] };
  const dev = day % 10 === 0 ? cityDevTick(state, cfg, ctx) : { gains: [], upsets: [] };
  const fired = day % 10 === 0 ? disasterTick(state, cfg, ctx) : [];
  const loyalty = day % 10 === 0 ? loyaltyTick(state, cfg, ctx) : null;
  if (day % 10 === 0) popTick(state, ctx);
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
  return { fired, loyalty, dev, tasks, supply, armySupply, govs };
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
  const cid = Number(cityId);
  /* 运输在路上可能耗时数日：到达时城池已被攻陷就不能入库，
     否则等于给敌方送粮。调用方已有「粮车折返」分支，这里补上归属闸让它真正生效。 */
  const owner = state.strategy?.cities?.[cid]?.owner;
  if (owner && owner !== 'player') return false;
  const e = state.strategy?.cityEcon?.[cid];
  if (!e) return false;
  e.store = Math.min(storeCapOf(e), e.store + Math.max(0, Math.floor(grain)));
  return true;
}

/* ★ M4-13：兵种适性抽到零依赖叶子 domain/aptitude.js，展示层与战斗结算同源。
   battle.js 直接引用它（不经本文件），避免 city-econ 的传递依赖形成环。
   这里 re-export 保持 panels / strategy / 既有单测的 import 路径不变。 */
export { armsApt, aptTriple, bestArms } from './aptitude.js';

/** 克制环：骑(3)→盾(1)→弓(2)→骑(3)，克制 ±15%（三战口径）。 */
export const ARMS_NAMES = { 1: '盾步', 2: '弓兵', 3: '骑兵' };
export function armsCounter(a, b) {
  if ((Number(a) === 3 && Number(b) === 1) || (Number(a) === 1 && Number(b) === 2) || (Number(a) === 2 && Number(b) === 3)) return 1;
  if ((Number(b) === 3 && Number(a) === 1) || (Number(b) === 1 && Number(a) === 2) || (Number(b) === 2 && Number(a) === 3)) return -1;
  return 0;
}
