/**
 * ★ 2026-11-17 初始数据编辑器 · 战法新增/编辑（用户：「技能和属性要提供新增和编辑
 *   功能。不是存档编辑，是初始编辑……我要自己来修改和创建」）。
 *
 * 写入策略（与武将编辑器 general-editor.js 同范式）：
 *   - 唯一写入口是 conf/campaign/custom-skills.json 覆盖层；conf/skills.json 等
 *     五张原表逐字不动（数据溯源红线不破）。
 *   - skills.js 在五表装载之后最后合并本覆盖层：同 cfgId / 同名 → 覆盖，否则新增。
 *     所以「编辑既有战法」和「创建新战法」走同一条路。
 *   - 保存后 upsertRuntimeSkill 立即同步进运行时表（UI JsonAsset 与 kernel 同源）。
 *
 * 校验口径 = tests/skill-balance.test.js 平衡闸（用户 2026-11-17「技能输出要平衡，
 * 不能相差太大」），编辑器在入口就把不合规的数值拦下，而不是等测试报红：
 *   - 指挥/被动：发动率恒 100%；输出指数（casts×p×rate×targets）≤ 2000；
 *   - 主动/追击（有伤害）：Lv10 发动率 32~50、Lv1 30~45 且逐级成长；
 *     输出指数 300~2000；群体时每目标收益 ≥ 200（→ 指数下限 600）；
 *   - 控制：命中率 Lv10 = Lv1×2 且 ≤ 100（→ Lv1 ≤ 50）；
 *   - kernel.probability_init/max 与 ui.levels 首末级同源（/100 精确换算）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL_COUNT, upsertRuntimeSkill, removeRuntimeSkill } from '../skills.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CUSTOM_PATH = join(ROOT, 'conf', 'campaign', 'custom-skills.json');
/** 新战法 cfgId 段与 detail_id 段：避开 10001~19xxx（原表/主公）、91000x（补量库）。 */
const NEW_ID_FROM = 29001;
const DETAIL_ID_FROM = 9200001;

export const SKILL_CLASSES = ['指挥', '被动', '主动', '追击'];
export const SKILL_EFFECTS = {
  PHYSICAL_DAMAGE: '兵刃伤害',
  STRATEGY_DAMAGE: '谋略伤害',
  HEAL: '治疗',
  CONTROL: '控制',
};
export const SKILL_TARGETS = {
  enemy_single: '敌军单体',
  enemy_all: '敌军全体',
  ally_group: '我方全体',
  self: '自身',
};
export const CONTROL_STATES = ['混乱', '动摇', '犹豫'];

/** 与前端下拉同一份口径（含区间提示），GET /editor/skills 时下发。 */
export const SKILL_FORM_META = {
  classes: SKILL_CLASSES,
  effects: SKILL_EFFECTS,
  targets: SKILL_TARGETS,
  controlStates: CONTROL_STATES,
  rateRange: { min: 5, max: 300 },
  probRange: { min: 1, max: 100 },
  controlHitMaxLv1: 50,
  idRange: { from: NEW_ID_FROM },
};

function loadCustomDoc() {
  if (!existsSync(CUSTOM_PATH)) return { version: 1, skills: [] };
  try {
    const doc = JSON.parse(readFileSync(CUSTOM_PATH, 'utf8'));
    if (!Array.isArray(doc.skills)) return { version: 1, skills: [] };
    return doc;
  } catch {
    return { version: 1, skills: [] };
  }
}

function saveCustomDoc(doc) {
  writeFileSync(CUSTOM_PATH, `${JSON.stringify(doc, null, 2)}\n`);
}

/** 自定义战法 cfgId 集合（供列表打「自建」标、reset 判断走删除还是还原）。 */
export function customSkillIds() {
  return new Set(loadCustomDoc().skills.map((s) => Number(s.cfgId)));
}

function round2(v) { return Math.round(Number(v) * 100) / 100; }
function lerp(a, b, t) { return round2(a + (b - a) * t); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
/** 整数概率插值：末级 > 首级时保证逐级成长；恒定（指挥/被动 100%）时不强推。 */
function probSeries(p1, p10) {
  const out = [];
  for (let i = 0; i < LEVEL_COUNT; i += 1) out.push(Math.round(lerp(p1, p10, i / (LEVEL_COUNT - 1))));
  if (p10 > p1 && out[LEVEL_COUNT - 1] <= out[0]) out[LEVEL_COUNT - 1] = Math.min(p10, out[0] + 1);
  return out;
}
function valueSeries(v1, v10) {
  const out = [];
  for (let i = 0; i < LEVEL_COUNT; i += 1) out.push(lerp(v1, v10, i / (LEVEL_COUNT - 1)));
  return out;
}

function castCountOf(cls) { return cls === '指挥' ? 1 : 8; }
function targetCountOf(tt) { return /group|all/i.test(String(tt)) ? 3 : 1; }

/**
 * 把编辑器表单输入净化成一整条战法（kernel + ui 十级 + 溯源）。
 * 返回 { ok, skill?, message?, cfgId? }。校验失败给出可读原因，不落盘。
 */
export function buildCustomSkill(input, existingIds) {
  const name = String(input?.name || '').trim().slice(0, 10);
  if (!name) return { ok: false, message: '战法名不能为空（1~10 字）' };
  const cls = SKILL_CLASSES.includes(input?.skillClass) ? input.skillClass : null;
  if (!cls) return { ok: false, message: '类别必须是 指挥/被动/主动/追击' };
  const effKey = input?.effectType && SKILL_EFFECTS[input.effectType] ? input.effectType : null;
  if (!effKey) return { ok: false, message: '效果必须是 兵刃伤害/谋略伤害/治疗/控制' };
  const tt = input?.targetType && SKILL_TARGETS[input.targetType] ? input.targetType : null;
  if (!tt) return { ok: false, message: '目标必须从下拉里选' };

  const isCmd = cls === '指挥' || cls === '被动';
  const casts = castCountOf(cls);
  const targets = targetCountOf(tt);

  /* 发动率：指挥/被动恒 100；主动/追击按平衡闸区间钳。 */
  let p1 = Math.round(Number(input?.probLv1));
  let p10 = Math.round(Number(input?.probLv10));
  if (isCmd) { p1 = 100; p10 = 100; }
  else {
    if (!Number.isFinite(p1) || !Number.isFinite(p10)) return { ok: false, message: '发动率 Lv1/Lv10 必须是数字' };
    p1 = clamp(p1, 30, 45);
    p10 = clamp(p10, 32, 50);
    if (p10 <= p1) p10 = Math.min(50, p1 + 1);
  }

  /* 效果数值：控制走命中率（Lv10=Lv1×2、≤100），伤害/治疗走比率。 */
  const isCtl = effKey === 'CONTROL';
  let ctlState = null;
  let v1 = 0;
  let v10 = 0;
  if (isCtl) {
    ctlState = CONTROL_STATES.includes(input?.controlState) ? input.controlState : CONTROL_STATES[0];
    v1 = clamp(Math.round(Number(input?.valueLv1) || 0), 1, SKILL_FORM_META.controlHitMaxLv1);
    v10 = v1 * 2;
  } else {
    v1 = clamp(Math.round(Number(input?.valueLv1) || 0), SKILL_FORM_META.rateRange.min, SKILL_FORM_META.rateRange.max);
    v10 = clamp(Math.round(Number(input?.valueLv10) || 0), v1, SKILL_FORM_META.rateRange.max);
    if (v10 < v1) v10 = v1;
  }

  /* cfgId：编辑既有 → 用传入的；新增 → 29001 起找空位。（先于数值闸：编辑语义先定。） */
  let cfgId = Math.round(Number(input?.cfgId) || 0);
  const ids = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  if (cfgId > 0) {
    if (!ids.has(cfgId)) return { ok: false, message: `未知战法 cfgId=${cfgId}（只能编辑已存在的战法，或留空新增）` };
  } else {
    cfgId = NEW_ID_FROM;
    while (ids.has(cfgId)) cfgId += 1;
  }

  /* 输出指数闸（与 skill-balance.test.js 同口径）。伤害/治疗按目标数与类别验界。 */
  if (!isCtl) {
    const idx = Math.round(casts * (p10 / 100) * v10 * targets);
    if (isCmd) {
      if (idx > 2000) {
        return { ok: false, message: `${cls}战法输出指数 ${idx} 超 2000（必发动技不能顶成必胜），请调低 ${SKILL_EFFECTS[effKey]}率 Lv10` };
      }
    } else {
      const lo = targets >= 3 ? 600 : 300;
      if (idx < lo) {
        return { ok: false, message: `输出指数 ${idx} 低于下限 ${lo}——${SKILL_EFFECTS[effKey]}率 Lv10 至少 ${Math.ceil(lo / (casts * (p10 / 100) * targets))}` };
      }
      if (idx > 2000) {
        return { ok: false, message: `输出指数 ${idx} 超过 2000——${SKILL_EFFECTS[effKey]}率 Lv10 至多 ${Math.floor(2000 / (casts * (p10 / 100) * targets))}` };
      }
    }
  }

  /* detail_id 段避让已完成校验。 */
  const probs = probSeries(p1, p10);
  const values = valueSeries(v1, v10);
  const isHeal = effKey === 'HEAL';
  const uiTarget = tt === 'enemy_single' ? 6 : tt === 'ally_group' ? 5 : tt === 'self' ? 5 : 9;
  const des = isCtl
    ? `对${SKILL_TARGETS[tt]}施以${ctlState}（命中率 %n%%），持续 1 回合`
    : isHeal
      ? `恢复${SKILL_TARGETS[tt]}兵力（治疗率 %n%%）`
      : `对${SKILL_TARGETS[tt]}发动${SKILL_EFFECTS[effKey]}（伤害率 %n%%）`;
  const trigger = cls === '指挥' ? 4 : cls === '被动' ? 2 : cls === '追击' ? 3 : 1;
  const dir = { 指挥: 'zhihui', 被动: 'beidong', 主动: 'zhudong', 追击: 'zuiji' }[cls];

  const skill = {
    cfgId,
    name,
    trigger,
    dir,
    ui: {
      cfgId,
      name,
      des,
      trigger,
      target: uiTarget,
      limit: 3,
      arms: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      include_effect: [1],
      levels: probs.map((p, i) => ({
        probability: p,
        effect_value: [values[i]],
        effect_round: [0],
      })),
    },
    kernel: {
      cfgId,
      name,
      skill_class: cls,
      effect_type: effKey,
      rate_pct_lv1: isCtl ? 0 : v1,
      rate_pct_lv10: isCtl ? 0 : v10,
      probability_init: p1 / 100,
      probability_max: p10 / 100,
      prepare: 0,
      target_type: tt,
      attack_type: 'normal',
      control_state: isCtl ? ctlState : null,
      control_probability: isCtl ? v1 / 100 : 0,
      bonus_terms: [],
      detail_id: DETAIL_ID_FROM + (cfgId - NEW_ID_FROM),
      /* effects 数组形态（E2 路径）：控制槽 effect_value=命中率，与 91000x 补量库同构。 */
      effects: [{
        detail_id: DETAIL_ID_FROM + (cfgId - NEW_ID_FROM),
        effect_type: effKey,
        rate_pct: isCtl ? 0 : v1,
        target_type: tt,
        attack_type: 'normal',
        available_round: 0,
        control_state: isCtl ? ctlState : null,
        control_probability: isCtl ? v1 / 100 : 0,
        bonus_terms: [],
      }],
    },
    provenance: {
      descSource: '初始数据编辑器（用户自建，本作设定）',
      nameSource: '初始数据编辑器（用户自建）',
      rateSource: '编辑器表单输入，按 skill-balance 平衡闸口径校验',
      pairing: 'authored',
      probability: '编辑器表单输入（指挥/被动恒 100%，主动/追击 32~50）',
    },
  };
  return { ok: true, skill, cfgId, isNew: !(input?.cfgId > 0) };
}

/** 全量列表（编辑器页签）：运行时表 + 自建标记 + 关键数值。allSkills = skills.js 的 SKILLS。 */
export function skillList(allSkills) {
  const custom = customSkillIds();
  const rows = (allSkills || []).map((s) => {
    const n = s.ui.levels.length;
    const effs = Array.isArray(s.kernel.effects) ? s.kernel.effects : [s.kernel];
    const dmg = effs.map((e) => (['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE', 'HEAL'].includes(e.effect_type) ? 1 : 0));
    const dmgIdx = dmg.indexOf(1);
    return {
      cfgId: Number(s.cfgId),
      name: s.name,
      cls: s.kernel.skill_class,
      effect: dmgIdx >= 0 ? effs[dmgIdx].effect_type : (effs[0]?.effect_type || ''),
      p1: s.ui.levels[0].probability,
      p10: s.ui.levels[n - 1].probability,
      rate1: dmgIdx >= 0 ? (Number(s.ui.levels[0].effect_value[dmgIdx]) || 0) : 0,
      rate10: dmgIdx >= 0 ? (Number(s.ui.levels[n - 1].effect_value[dmgIdx]) || 0) : 0,
      target: s.kernel.target_type || effs[0]?.target_type || '',
      custom: custom.has(Number(s.cfgId)),
    };
  });
  return { ok: true, total: rows.length, rows, meta: SKILL_FORM_META };
}

/**
 * 保存（新增或覆盖）一条战法：写覆盖层 + 同步运行时。
 * allSkills 由调用方传（skills.js 的 SKILLS 引用），用于 cfgId 去重与编辑校验。
 */
export function saveSkill(allSkills, input) {
  const ids = new Set((allSkills || []).map((s) => Number(s.cfgId)));
  const built = buildCustomSkill(input, ids);
  if (!built.ok) return built;
  const doc = loadCustomDoc();
  const i = doc.skills.findIndex((s) => Number(s.cfgId) === built.cfgId);
  if (i >= 0) doc.skills[i] = built.skill;
  else doc.skills.push(built.skill);
  saveCustomDoc(doc);
  upsertRuntimeSkill(built.skill);
  return {
    ok: true, cfgId: built.cfgId, isNew: built.isNew, name: built.skill.name,
    message: built.isNew ? `已创建战法「${built.skill.name}」(#${built.cfgId})` : `已覆盖战法「${built.skill.name}」(#${built.cfgId})`,
  };
}

/**
 * 重置一条战法：
 *   - 自建战法（custom 里有、五表原本没有）→ 从覆盖层删除；
 *   - 覆盖既有战法 → 从覆盖层删除并还原五表原值（重新扫盘取原条目）。
 */
export function resetSkill(allSkills, input) {
  const cfgId = Math.round(Number(input?.cfgId) || 0);
  if (!cfgId) return { ok: false, message: '缺少 cfgId' };
  const doc = loadCustomDoc();
  const i = doc.skills.findIndex((s) => Number(s.cfgId) === cfgId);
  if (i < 0) return { ok: false, message: `#${cfgId} 不在自定义覆盖层里` };
  const custom = doc.skills[i];
  doc.skills.splice(i, 1);
  saveCustomDoc(doc);
  const base = baseSkillOf(cfgId, custom.name);
  if (base) {
    upsertRuntimeSkill(base);
    return { ok: true, cfgId, restored: base.name, message: `已还原为原表「${base.name}」` };
  }
  removeRuntimeSkill(cfgId);
  return { ok: true, cfgId, removed: custom.name, message: `已删除自建战法「${custom.name}」` };
}

/** 从五张原表找被覆盖前的原条目（cfgId 优先，同名兜底）。 */
function baseSkillOf(cfgId, name) {
  const files = [
    join(ROOT, 'conf', 'skills.json'),
    join(ROOT, 'conf', 'campaign', 'protagonist-skill.json'),
    join(ROOT, 'conf', 'library-skills.json'),
    join(ROOT, 'conf', 'library-skills-extra.json'),
    join(ROOT, 'conf', 'innate-skills.json'),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const d = JSON.parse(readFileSync(f, 'utf8'));
      const list = Array.isArray(d.skills) ? d.skills : (d.cfgId ? [d] : []);
      const hit = list.find((s) => Number(s.cfgId) === cfgId)
        || (name ? list.find((s) => s.name === name) : null);
      if (hit) return hit;
    } catch { /* 单表损坏跳过 */ }
  }
  return null;
}
