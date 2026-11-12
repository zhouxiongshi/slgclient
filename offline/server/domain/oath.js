/**
 * 开局举义（P4-①）：数据层小助手。
 *
 * 刻意只依赖 node:fs —— panels.js / campaign.js / strategy.js / handlers.js 都要引用，
 * 任何一个已有的 domain 模块当依赖都会把循环依赖带进来
 * （panels.js 反被 world.js 引用，strategy.js 又引 campaign.js，链路已经打满）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FACTIONS_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'factions.json');
const MAP_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json');

let cached = null;
let cachedMap = null;

/** factions.json 全量（带举义卡字段：blurb/trait/startGenerals）。 */
export function factionsConf() {
  if (!cached) cached = JSON.parse(readFileSync(FACTIONS_PATH, 'utf8'));
  return cached;
}

export function factionById(id) {
  return factionsConf().factions.find((f) => f.id === id) || null;
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
  return o.done ? factionById(o.lord) : null;
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
