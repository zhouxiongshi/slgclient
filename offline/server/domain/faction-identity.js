/**
 * 势力身份口径（2026-11-18）—— 玩家「主公/举义势力/自建势力」显示名与外交身份的唯一权威。
 *
 * 背景（用户报告的前后矛盾）：举义选曹操时，strategy.js:418 把曹操城 owner 全改成 'player'，
 * 玩家扛曹旗、用曹将、承曹特技；但「曹操」仍留在 factions.json 且可单独外交 → 自相矛盾。
 * 底层 owner='player' 保持不变（避免全仓重构与存档迁移），只在显示层归一 + 外交去重。
 *
 * 三态（确定性、零环叶子，只读 state）：
 *  ① 已建国：state.founded = { name, color, day, fromLord } → 显示国号，外交中玩家=独立势力，
 *     原举义势力重新成为可外交的独立对象（已脱离）。
 *  ② 已举义未建国：显示所举义势力名（如「曹操」）；外交列表排除该势力（不能对自己外交）；
 *     主公（880001）只是该势力麾下一名武将，不再是一个独立「主公势力」。
 *  ③ 旧档/未举义：显示「我军」，不排除任何势力。
 */

import { oathOf, oathFactionOf, oathPending } from './oath.js';

/** 自立门槛：占领城池数（局内达成条件解锁）。*/
export const FOUND_MIN_CITIES = 6;
export const DEFAULT_NATION_COLOR = '#c9a227';

/** 玩家占领城池数（owner==='player'，排除未举义占位）。 */
export function playerCityCount(state) {
  const cities = Object.values(state?.strategy?.cities || {});
  return cities.filter((c) => c && c.owner === 'player').length;
}

/** 是否已自建势力。 */
export function isFounded(state) {
  const f = state?.founded;
  return !!(f && f.name);
}

/** 局内是否可自立：已举义、未建国、占城达到门槛。 */
export function foundStatus(state) {
  if (isFounded(state)) return { ok: false, reason: 'already_founded' };
  if (oathPending(state)) return { ok: false, reason: 'oath_pending', need: FOUND_MIN_CITIES };
  const cities = playerCityCount(state);
  if (cities < FOUND_MIN_CITIES) {
    return { ok: false, reason: 'not_enough_cities', cities, need: FOUND_MIN_CITIES };
  }
  return { ok: true, cities, need: FOUND_MIN_CITIES };
}

/**
 * 玩家势力显示身份。
 * @returns { name, color, lordId, lordName, founded, kind:'founded'|'oath'|'player' }
 */
export function playerIdentity(state, conf = null) {
  if (isFounded(state)) {
    const f = state.founded;
    return {
      name: f.name, color: f.color || DEFAULT_NATION_COLOR,
      lordId: f.fromLord || null, lordName: '', founded: true, kind: 'founded',
    };
  }
  const oathF = oathFactionOf(state);
  if (oathF) {
    return {
      name: oathF.name, color: oathF.color || DEFAULT_NATION_COLOR,
      lordId: oathF.id, lordName: oathF.name, founded: false, kind: 'oath',
    };
  }
  return { name: '我军', color: DEFAULT_NATION_COLOR, lordId: null, lordName: '', founded: false, kind: 'player' };
}

/**
 * 外交列表要排除的势力 id 集合（不能对自己外交）。
 * 已举义未建国 → 排除所举义势力；建国后 → 不排除（原势力已独立）。
 */
export function diplomacyExcluded(state) {
  if (isFounded(state)) return [];
  if (oathPending(state)) return [];
  const oathF = oathFactionOf(state);
  return oathF ? [oathF.id] : [];
}

/** 某势力 id 是否就是玩家自己（用于外交动作拒绝）。 */
export function isSelfFaction(state, fid) {
  return diplomacyExcluded(state).includes(String(fid));
}

/** 自立：校验国号并把 state.founded 落盘（handlers 只做薄封装）。 */
export function foundNation(state, name, color = DEFAULT_NATION_COLOR) {
  const status = foundStatus(state);
  if (!status.ok) return { ok: false, reason: status.reason, cities: status.cities, need: status.need };
  const nationName = String(name || '').trim().slice(0, 12);
  if (!nationName) return { ok: false, reason: 'empty_name' };
  const o = oathOf(state);
  state.founded = {
    name: nationName, color: String(color || DEFAULT_NATION_COLOR).slice(0, 32),
    day: Math.max(1, Math.floor(Number(state.clock?.day) || 1)),
    fromLord: o.lord || null,
  };
  return { ok: true, founded: { ...state.founded } };
}
