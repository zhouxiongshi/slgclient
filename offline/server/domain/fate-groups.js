/**
 * fate-groups.js — 宿命 24 组域模块（GDD §7.5）
 *
 * 零依赖叶子：只读 conf/campaign/fate-groups.json，回答三件事——
 *   1. 某武将身上挂着哪些宿命（fatesOfHero）
 *   2. 哪些宿命当前生效 / 已断链（evaluateFates，成员存活性由查询回调给出）
 *   3. 相性环形距离（xiangxingGap，复用 relations.json 的环形 1..149 口径）
 *
 * 本模块不写状态、不改数值、不掷随机数：加成是否落到战斗/内政，
 * 由调用方把 evaluateFates 的结果换算进去（描述=计算=战报同源）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONF = resolve(HERE, '../../conf/campaign/fate-groups.json');

export const XIANGXING_RING = 149;

let _cache = null;
export function loadFateGroups() {
  if (!_cache) {
    const doc = JSON.parse(readFileSync(CONF, 'utf8'));
    const errs = validateFateGroups(doc.groups);
    if (errs.length) throw new Error(`fate-groups.json 校验失败:\n${errs.join('\n')}`);
    _cache = doc.groups;
  }
  return _cache;
}

/** 结构校验：组 id 唯一、成员 ≥2 且组内不重名。供测试与构建期复用。 */
export function validateFateGroups(groups) {
  const errs = [];
  const ids = new Set();
  for (const g of groups || []) {
    if (!g.id) errs.push('缺 id');
    else if (ids.has(g.id)) errs.push(`组 id 重复: ${g.id}`);
    else ids.add(g.id);
    const members = g.members || [];
    if (members.length < 2) errs.push(`组 ${g.id} 成员不足 2 人`);
    if (new Set(members).size !== members.length) errs.push(`组 ${g.id} 成员重名`);
    if (!g.effect) errs.push(`组 ${g.id} 缺 effect`);
    if (!g.breakEffect) errs.push(`组 ${g.id} 缺 breakEffect（宿命必须可断）`);
    if (!g.source?.id) errs.push(`组 ${g.id} 缺 source.id（史实依据）`);
    if (!g.source?.confidence) errs.push(`组 ${g.id} 缺 source.confidence`);
  }
  return errs;
}

export function groupById(id) {
  return loadFateGroups().find((g) => g.id === id) || null;
}

/** 某武将参与的宿命组（供武将卡展示与 bonds 渲染）。 */
export function fatesOfHero(name) {
  return loadFateGroups().filter((g) => g.members.includes(name));
}

/**
 * 相性环形距离：1..149 环，距离越小越契合（GDD §7.3 登庸成功率构成条）。
 * 返回 0..74（环的一半）。
 */
export function xiangxingGap(a, b) {
  const d = Math.abs(((a || 1) - (b || 1)) % XIANGXING_RING);
  return Math.min(d, XIANGXING_RING - d);
}

/**
 * 宿命评估：遍历 24 组，按成员存活性分档。
 *
 * @param {Function} heroAlive (name) => boolean  成员是否存活且在本局（死亡/未出生均算否）
 * @param {Object} [opts]
 * @param {Function} [opts.heroInCourt] (name) => boolean  是否已在任一势力麾下（触发类宿命用）
 * @returns {{ active: Array, dormant: Array, broken: Array }}
 *   active  — 全员存活且全部出仕（宿命可生效的状态）
 *   dormant — 全员存活但未齐出仕（组合加成待激活）
 *   broken  — 有成员死亡（按 breakEffect 记录代价与死者）
 */
export function evaluateFates(heroAlive, opts = {}) {
  const inCourt = opts.heroInCourt || (() => true);
  const active = [], dormant = [], broken = [];
  for (const g of loadFateGroups()) {
    const dead = g.members.filter((m) => !heroAlive(m));
    if (dead.length > 0) {
      broken.push({ id: g.id, title: g.title, members: g.members, cause: dead, breakEffect: g.breakEffect });
      continue;
    }
    if (g.members.every(inCourt)) active.push({ id: g.id, title: g.title, members: g.members, effect: g.effect });
    else dormant.push({ id: g.id, title: g.title, members: g.members, effect: g.effect });
  }
  return { active, dormant, broken };
}

/** 登庸成功率构成条用的相性分项（GDD §7.3：gap 越小越高，最高 +25%）。 */
export function xiangxingBonus(myXx, targetXx) {
  const gap = xiangxingGap(myXx, targetXx);
  if (gap <= 10) return 25;
  if (gap <= 25) return 18;
  if (gap <= 45) return 10;
  return 0;
}
