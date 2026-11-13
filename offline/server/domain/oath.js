/**
 * 开局举义（P4-①）：数据层小助手。
 *
 * 刻意只依赖 node:fs —— panels.js / campaign.js / strategy.js / handlers.js 都要引用，
 * 任何一个已有的 domain 模块当依赖都会把循环依赖带进来
 * （panels.js 反被 world.js 引用，strategy.js 又引 campaign.js，链路已经打满）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FACTIONS_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'factions.json');
const MAP_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json');
const SCENARIOS_DIR = resolve(ROOT, 'conf', 'campaign', 'strategy', 'scenarios');

let cached = null;
let cachedMap = null;
let cachedScenarios = null;

/** factions.json 全量（带举义卡字段：blurb/trait/startGenerals）。 */
export function factionsConf() {
  if (!cached) cached = JSON.parse(readFileSync(FACTIONS_PATH, 'utf8'));
  return cached;
}

export function factionById(id) {
  return factionsConf().factions.find((f) => f.id === id) || null;
}

/* ★ M3-5 剧本降级（GDD §12.1）：剧本势力 id 不在基础 8 诸侯里，
 *  按 name 从基础诸侯继承 trait/startGenerals。只读文件，不引 strategy.js（防循环）。 */
function scenarioFactionById(state, id) {
  const sid = state?.strategy?.scenarioId || state?.scenarioId;
  if (!sid) return null;
  try {
    if (!cachedScenarios) {
      cachedScenarios = new Map();
      for (const fn of readdirSync(SCENARIOS_DIR).filter((n) => n.endsWith('.json'))) {
        const sc = JSON.parse(readFileSync(resolve(SCENARIOS_DIR, fn), 'utf8'));
        cachedScenarios.set(sc.id, sc);
      }
    }
    const f = cachedScenarios.get(sid)?.factions?.find((x) => x.id === id);
    if (!f) return null;
    const b = factionsConf().factions.find((x) => x.name === f.name);
    return { ...f, trait: f.trait || b?.trait || null, startGenerals: f.startGenerals || b?.startGenerals || [] };
  } catch { return null; }
}

/** 战略图上按 id 查城（给 panels 显示定都城名用，不引 strategy.js 防循环）。 */
export function strategyCity(id) {
  if (!cachedMap) cachedMap = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const cid = Number(id);
  return (cachedMap.cities || []).find((c) => c.id === cid) || null;
}

/**
 * 举义状态：新档由 createWorld 写入 { done:false }；
 * 改造前的旧档没有这个字段，视为「已举义」直接进游戏，绝不再弹页。
 */
export function oathOf(state) {
  return (state && state.oath) || { done: true };
}

export function oathPending(state) {
  return oathOf(state).done === false;
}

/** 玩家举义后继承的诸侯势力卡（未举义或择了不存在的 id → null）。 */
export function oathFactionOf(state) {
  const o = oathOf(state);
  if (!o.done) return null;
  return factionById(o.lord) || scenarioFactionById(state, o.lord) || null;
}

/**
 * 势力特技的数值面。展示文案在 factions.json 的 trait.name/desc，
 * 这里只归一化参与计算的四个旋钮，越界一律夹回安全区间。
 */
export function factionTraitOf(state) {
  const t = oathFactionOf(state)?.trait || {};
  const yields = {};
  for (const [k, v] of Object.entries(t.yields || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n) yields[k] = n;
  }
  return {
    yields,
    upkeepPct: Number.isFinite(Number(t.upkeepPct)) ? Number(t.upkeepPct) : 0,
    recruitPct: Number.isFinite(Number(t.recruitPct)) ? Number(t.recruitPct) : 0,
    marchDelta: Math.max(-2, Math.min(2, Number(t.marchDelta) || 0)),
  };
}

/* ---------------- P6：人物志五维（招募/登庸/招降的成功率判定用） ---------------- */

let cachedLore = null;
const LORE_PATH = resolve(ROOT, 'conf', 'panels', 'generals-lore.json');

let loreByCfg = null;
function loreMap() {
  if (!loreByCfg) {
    if (!cachedLore) {
      try { cachedLore = JSON.parse(readFileSync(LORE_PATH, 'utf8')); }
      catch { cachedLore = { list: [] }; }
    }
    loreByCfg = new Map((cachedLore.list || []).map((r) => [Number(r.cfgId), r]));
  }
  return loreByCfg;
}

/** 历史五维（统率/武力/智力/政治/魅力）：缺史载按 50 兜底。 */
export function loreStat(cfgId, dim) {
  const row = loreMap().get(Number(cfgId));
  const v = Number(row?.historyStats?.[dim]);
  return Number.isFinite(v) ? v : 50;
}

/** 主角（880001）的五维口径，和 panels.postBonusPct 同源。 */
export function protagonistStat(state, dim) {
  const hero = (state.generals || []).find((g) => Number(g.cfgId) === 880001);
  return loreStat(hero?.cfgId ?? 880001, dim);
}
