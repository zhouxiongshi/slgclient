/**
 * ★ M4-11 武将编辑器（domain 层）：所有武将属性与自带战法的编辑入口。
 *
 * 写入策略（与 GM 覆盖层同一范式，见 gm/overrides.js）：
 *   - 一律写 conf/campaign/overrides.json 的 `generals` 段（cfgId → 覆盖字段），
 *     **不碰** conf/json/general/general.json、conf/campaign/heroes-240.json、
 *     conf/campaign/protagonist.json 任何原表——数据溯源红线不破。
 *   - 生效三路（同源）：① `config.js loadConfig` 应用覆盖到 generalByCfg
 *     （面板/战斗/内政/外交/行军的唯一权威，应用前原行存 cfg.generalOriginal）；
 *     ② 保存时对当前存档 state.generals 直接应用（立即生效，无需重启）；
 *     ③ `world.js innateOf` 读覆盖的自带战法（新开局生效）。
 *   - 属性量纲：M4-10 百分制，五维 1~100（缺值兜底 50 的口径不变）、
 *     成长率 1~100、统御 cost 1~45、星级 1~5；越界一律钳到边界。
 *   - 自带战法 skillCfgId：0 = 清空（白板），其余必须在运行时战法表内
 *     （skills.js SKILL_BY_ID，覆盖 skills/innate/library 五表合并全集）。
 */
import { loadOverrides, saveOverrides, overridesMtime } from '../gm/overrides.js';
import { SKILL_BY_ID } from '../skills.js';

/** 可编辑属性字段的钳位区间（与页面 UI 共用同一份口径）。 */
export const EDIT_RANGES = {
  force: { min: 1, max: 100, label: '武力' },
  strategy: { min: 1, max: 100, label: '谋略' },
  defense: { min: 1, max: 100, label: '统帅' },
  speed: { min: 1, max: 100, label: '速度' },
  destroy: { min: 1, max: 100, label: '攻城' },
  politics: { min: 1, max: 100, label: '政治' },
  force_grow: { min: 1, max: 100, label: '武力成长' },
  strategy_grow: { min: 1, max: 100, label: '谋略成长' },
  defense_grow: { min: 1, max: 100, label: '防御成长' },
  speed_grow: { min: 1, max: 100, label: '速度成长' },
  destroy_grow: { min: 1, max: 100, label: '攻城成长' },
  cost: { min: 1, max: 45, label: '统御上限' },
  star: { min: 1, max: 5, label: '星级' },
};
export const EDIT_KEYS = Object.keys(EDIT_RANGES);

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v))));

/** 一条武将覆盖的净化：只保留可编辑字段、越界钳位、非法战法归 0。 */
export function sanitizeGeneralEdit(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of EDIT_KEYS) {
    const n = Number(src[key]);
    if (Number.isFinite(n)) out[key] = clampNum(n, EDIT_RANGES[key].min, EDIT_RANGES[key].max);
  }
  if (src.skillCfgId !== undefined) {
    const n = Number(src.skillCfgId);
    out.skillCfgId = Number.isFinite(n) && SKILL_BY_ID.has(Math.round(n)) ? Math.round(n) : 0;
  }
  return Object.keys(out).length ? out : null;
}

/** 全武将摘要（编辑器列表）：generalByCfg 全表 + 覆盖标记 + 自带战法。 */
export function editorList(cfg) {
  const gen = loadOverrides().generals || {};
  const rows = [];
  for (const g of cfg.generalByCfg.values()) {
    const ov = gen[String(g.cfgId)];
    rows.push({
      cfgId: Number(g.cfgId),
      name: g.name || `武将${g.cfgId}`,
      star: Number(g.star) || 0,
      cost: Number(g.cost) || 0,
      stats: {
        force: Number(g.force) || 0, strategy: Number(g.strategy) || 0,
        defense: Number(g.defense) || 0, speed: Number(g.speed) || 0,
        destroy: Number(g.destroy) || 0, politics: Number(g.politics) || 0,
      },
      grows: {
        force_grow: Number(g.force_grow) || 0, strategy_grow: Number(g.strategy_grow) || 0,
        defense_grow: Number(g.defense_grow) || 0, speed_grow: Number(g.speed_grow) || 0,
        destroy_grow: Number(g.destroy_grow) || 0,
      },
      skillCfgId: Number(ov?.skillCfgId ?? g.skillCfgId ?? 0),
      overridden: !!ov,
      custom: !!ov?.__custom__,
      isProtagonist: Number(g.cfgId) === 880001,
    });
  }
  rows.sort((a, b) => (b.star - a.star) || (b.cfgId - a.cfgId));
  return { ok: true, total: rows.length, rows, ranges: EDIT_RANGES };
}

/** 把一条覆盖立即应用到 cfg.generalByCfg（唯一权威，所有消费点同源生效）。 */
function applyToConfig(cfg, cfgId, patch) {
  const row = cfg.generalByCfg.get(Number(cfgId));
  if (!row) return false;
  if (!cfg.generalOriginal) cfg.generalOriginal = new Map();
  if (!cfg.generalOriginal.has(Number(cfgId))) {
    cfg.generalOriginal.set(Number(cfgId), { ...row });
  }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'skillCfgId') row.skillCfgId = v;
    else row[k] = v;
  }
  return true;
}

/** 从 cfg.generalOriginal 恢复单条（reset 用）。 */
function restoreFromOriginal(cfg, cfgId) {
  const row = cfg.generalByCfg.get(Number(cfgId));
  const orig = cfg.generalOriginal?.get(Number(cfgId));
  if (!row || !orig) return false;
  for (const k of [...EDIT_KEYS, 'skillCfgId']) {
    if (orig[k] !== undefined) row[k] = orig[k];
    else delete row[k];
  }
  return true;
}

/** 当前存档里 cfgId 对应武将的自带战法槽（skills[0]）同步。 */
function syncStateSkill(state, cfgId, skillCfgId) {
  if (!state || !Array.isArray(state.generals)) return 0;
  let n = 0;
  for (const g of state.generals) {
    if (Number(g.cfgId) !== Number(cfgId)) continue;
    if (!Array.isArray(g.skills) || g.skills.length < 3) {
      g.skills = [null, null, null];
    }
    /* ★ 修复：改武将属性/重置时不再把自带战法等级清零。
       若槽里的 skillCfgId 未变 → 保留原 lv（用户可能已练到高等级）；
       只有换技能或空槽才新建，等级从 1 起。 */
    const prev = g.skills[0];
    if (skillCfgId && Number(prev?.cfgId) === Number(skillCfgId)) {
      g.skills[0] = { id: skillCfgId, lv: Number(prev.lv) || 1, cfgId: skillCfgId };
    } else {
      g.skills[0] = skillCfgId ? { id: skillCfgId, lv: 1, cfgId: skillCfgId } : null;
    }
    n += 1;
  }
  return n;
}

/**
 * 保存一条编辑：写 overrides.generals + 立即应用配置与存档。
 * 返回 { ok, row, stateSynced }。
 */
export function editorSave(cfg, state, input) {
  const cfgId = Number(input?.cfgId);
  if (!Number.isFinite(cfgId) || !cfg.generalByCfg.has(cfgId)) {
    return { ok: false, message: `未知武将 cfgId=${input?.cfgId}` };
  }
  const patch = sanitizeGeneralEdit(input);
  const ov = loadOverrides();
  const generals = { ...(ov.generals || {}) };
  if (patch) generals[String(cfgId)] = { ...(generals[String(cfgId)] || {}), ...patch };
  else delete generals[String(cfgId)];
  saveOverrides({ ...ov, generals });

  applyToConfig(cfg, cfgId, patch || {});
  const row = cfg.generalByCfg.get(cfgId);
  /* ★ 只有当编辑真正涉及 skillCfgId 或 cfg 行明确配置了它时才同步存档槽；
     否则（如主角 19001 由运行时注入、cfg 行无此字段）保留存档现状，
     避免改一个武力属性就把主角战法清空。 */
  const wantSync = Object.prototype.hasOwnProperty.call(patch, 'skillCfgId')
    || row?.skillCfgId != null;
  const stateSynced = wantSync ? syncStateSkill(state, cfgId, row.skillCfgId || 0) : 0;
  return { ok: true, cfgId, stateSynced, row: editorRowOf(cfg, cfgId) };
}

/** 清除一条覆盖并恢复原值。 */
export function editorReset(cfg, state, input) {
  const cfgId = Number(input?.cfgId);
  if (!Number.isFinite(cfgId)) return { ok: false, message: '缺少 cfgId' };
  const ov = loadOverrides();
  const generals = { ...(ov.generals || {}) };
  if (!generals[String(cfgId)]) return { ok: true, cfgId, stateSynced: 0, row: editorRowOf(cfg, cfgId) };
  delete generals[String(cfgId)];
  saveOverrides({ ...ov, generals });
  restoreFromOriginal(cfg, cfgId);
  const row = cfg.generalByCfg.get(cfgId);
  const stateSynced = row?.skillCfgId != null ? syncStateSkill(state, cfgId, row.skillCfgId) : 0;
  return { ok: true, cfgId, stateSynced, row: editorRowOf(cfg, cfgId) };
}

/**
 * ★ 2026-11-17 新增武将（用户：「技能和属性要提供新增和编辑功能……我要自己来修改
 *   和创建」）。初始口径：只写 overrides.generals + 注入 generalByCfg（config.js
 *   loadConfig 同一逻辑注入，新开局/酒馆客池自动出现），**不改当前存档 state**。
 *   cfgId 从 890001 起自动分配，避开原表 100001~100593、主角 880001、240 段。
 */
export const CUSTOM_GENERAL_ID_FROM = 890001;

export function editorCreate(cfg, input) {
  const name = String(input?.name || '').trim().slice(0, 12);
  if (!name) return { ok: false, message: '武将名不能为空（1~12 字）' };
  const patch = sanitizeGeneralEdit(input) || {};
  const ov = loadOverrides();
  const generals = { ...(ov.generals || {}) };
  let cfgId = CUSTOM_GENERAL_ID_FROM;
  while (cfg.generalByCfg.has(cfgId) || generals[String(cfgId)]) cfgId += 1;

  const armsN = Math.round(Number(input?.arms));
  const row = {
    name,
    country: String(input?.country || '').trim().slice(0, 6) || '',
    arms: [Number.isFinite(armsN) && armsN >= 1 && armsN <= 9 ? armsN : 1],
    star: patch.star ?? 3,
    cost: patch.cost ?? 15,
    force: patch.force ?? 50,
    strategy: patch.strategy ?? 50,
    defense: patch.defense ?? 50,
    speed: patch.speed ?? 50,
    destroy: patch.destroy ?? 50,
    politics: patch.politics ?? patch.strategy ?? 50,
    force_grow: patch.force_grow ?? 30,
    strategy_grow: patch.strategy_grow ?? 30,
    defense_grow: patch.defense_grow ?? 30,
    speed_grow: patch.speed_grow ?? 30,
    destroy_grow: patch.destroy_grow ?? 30,
    skillCfgId: patch.skillCfgId ?? 0,
    __custom__: true,
  };
  generals[String(cfgId)] = row;
  saveOverrides({ ...ov, generals });

  /* 注入唯一权威 generalByCfg：编辑器列表、酒馆客池、新开局 makeGeneral 立即可见。 */
  cfg.generalByCfg.set(cfgId, { cfgId, ...row });
  return { ok: true, cfgId, row: { ...row, cfgId }, message: `已创建武将「${name}」(#${cfgId})，新开局与酒馆客池生效` };
}

/** 删除一条自定义武将（只能删 __custom__ 的；初始口径，已入存档的武将保留）。 */
export function editorDeleteCustom(cfg, input) {
  const cfgId = Number(input?.cfgId);
  if (!Number.isFinite(cfgId)) return { ok: false, message: '缺少 cfgId' };
  const ov = loadOverrides();
  const row = ov.generals?.[String(cfgId)];
  if (!row || !row.__custom__) return { ok: false, message: '只能删除编辑器新建的自定义武将' };
  const generals = { ...(ov.generals || {}) };
  delete generals[String(cfgId)];
  saveOverrides({ ...ov, generals });
  cfg.generalByCfg.delete(cfgId);
  return { ok: true, cfgId, message: `已删除「${row.name}」(#${cfgId})——新开局不再出现；已招募到存档里的该武将保留` };
}

/** 单条详情（编辑器表单回显）。 */
export function editorRowOf(cfg, cfgId) {
  const row = cfg.generalByCfg.get(Number(cfgId));
  if (!row) return null;
  return {
    cfgId: Number(row.cfgId), name: row.name || `武将${row.cfgId}`,
    star: Number(row.star) || 0, cost: Number(row.cost) || 0,
    force: Number(row.force) || 0, strategy: Number(row.strategy) || 0,
    defense: Number(row.defense) || 0, speed: Number(row.speed) || 0,
    destroy: Number(row.destroy) || 0,
    force_grow: Number(row.force_grow) || 0, strategy_grow: Number(row.strategy_grow) || 0,
    defense_grow: Number(row.defense_grow) || 0, speed_grow: Number(row.speed_grow) || 0,
    destroy_grow: Number(row.destroy_grow) || 0,
    skillCfgId: Number(row.skillCfgId) || 0,
    isProtagonist: Number(row.cfgId) === 880001,
    overridden: !!cfg.generalOriginal?.has(Number(row.cfgId)),
  };
}

/** overrides 里的 generals 段是否最近被外部改动（mtime 探测，诊断用）。 */
export function overridesFreshStamp() { return overridesMtime(); }
