/**
 * 边境威胁视图（单一权威源，★ 2026-11-20）。
 *
 * 六府战略页（panels.js panelState）与天下沙盘页（strategy.js strategyViewState）
 * 过去各写一份 garrison → threats 映射：沙盘那份带围城目标/剩余天数/目标民心，
 * 六府那份只留「兵力/来处」，导致 panels-ui.js 的 t.besieging / t.daysToSiege 分支
 * 恒为 false——敌人已经在围城、即将开城时，六府页完全不给预警。
 *
 * 抽成叶子模块避免成环：strategy → campaign → panels，panels 不能 import strategy。
 * 本模块只读 map.json 与传入的 state/st，不 import 两者中任何一个。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 来犯军出现后多少日不清剿即开始围城；多少日仍不破则粮尽自退。 */
export const SIEGE_GRACE_DAYS = 40;
export const SIEGE_MAX_DAYS = 180;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let CITY_NAMES = null;
function cityNameById(id) {
  if (!CITY_NAMES) {
    try {
      const m = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json'), 'utf8'));
      CITY_NAMES = new Map((m.cities || []).map((c) => [Number(c.id), c.name]));
    } catch { CITY_NAMES = new Map(); }
  }
  return CITY_NAMES.get(Number(id)) || '';
}

/**
 * @param {object} state 完整存档（读 garrisons）
 * @param {object} st    state.strategy（读 cities / cityEcon）
 * @param {number} today0 当日（日，至少 1）
 */
export function threatRows(state, st, today0) {
  return (state.garrisons || [])
    .filter((g) => !g.cleared)
    .map((g) => {
      const tid = Number(g.targetCity) || 0;
      const row = tid ? st.cities?.[tid] : null;
      const econ = tid ? st.cityEcon?.[tid] : null;
      const spawnDay = Math.max(1, Math.floor(Number(g.spawnDay) || today0));
      return {
        id: g.id, x: g.x, y: g.y, name: g.name,
        soldiers: Math.max(0, Math.round(Number(g.soldiers) || 0)),
        faction: g.faction || '', patrol: !!g.patrol,
        targetCity: tid,
        targetName: tid ? cityNameById(tid) : '',
        /* 距开始围城还有几天（已围则为 0，用 besieging 判断状态——不用负值当状态码）。 */
        daysToSiege: Math.max(0, Math.round(SIEGE_GRACE_DAYS - (today0 - spawnDay))),
        daysToWithdraw: Math.max(0, Math.round(SIEGE_MAX_DAYS - (today0 - spawnDay))),
        besieging: !!(row && row.besieged),
        targetMorale: econ ? Math.round(Number(econ.morale) || 0) : null,
      };
    });
}
