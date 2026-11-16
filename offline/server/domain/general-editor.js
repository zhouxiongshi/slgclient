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
  defense: { min: 1, max: 100, label: '统御防御' },
  speed: { min: 1, max: 100, label: '速度' },
  destroy: { min: 1, max: 100, label: '攻城' },
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
        destroy: Number(g.destroy) || 0,
      },
      grows: {
        force_grow: Number(g.force_grow) || 0, strategy_grow: Number(g.strategy_grow) || 0,
        defense_grow: Number(g.defense_grow) || 0, speed_grow: Number(g.speed_grow) || 0,
        destroy_grow: Number(g.destroy_grow) || 0,
      },
      skillCfgId: Number(ov?.skillCfgId ?? g.skillCfgId ?? 0),
      overridden: !!ov,
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
      if (Array.isArray(g.skills)) { /* 已置三空槽 */ }
    }
    g.skills[0] = skillCfgId ? { id: skillCfgId, lv: 1, cfgId: skillCfgId } : null;
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
  const stateSynced = syncStateSkill(state, cfgId, row.skillCfgId || 0);
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
  const stateSynced = syncStateSkill(state, cfgId, row?.skillCfgId || 0);
  return { ok: true, cfgId, stateSynced, row: editorRowOf(cfg, cfgId) };
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
