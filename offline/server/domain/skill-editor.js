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
import { LEVEL_COUNT, upsertRuntimeSkill, removeRuntimeSkill, applyRangeNote } from '../skills.js';

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

/** 取战法的效果槽数组（E2 effects 优先，E0 退化为 [kernel]），与 kernelSkillAt 同口径。 */
function effectSlotsOf(skill) {
  const k = skill?.kernel || {};
  return Array.isArray(k.effects) && k.effects.length ? k.effects : [k];
}
/**
 * 编辑器只暴露「一个可编辑效果」，与 skillList 展示口径一致：优先首个伤害/治疗槽，
 * 否则首个控制槽，再否则首槽。返回索引，供增量编辑只改这一个槽、保留其余槽。
 */
function editableSlotIdx(effs) {
  const dmg = effs.findIndex((e) => ['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE', 'HEAL'].includes(e.effect_type));
  if (dmg >= 0) return dmg;
  const ctl = effs.findIndex((e) => e.effect_type === 'CONTROL');
  return ctl >= 0 ? ctl : 0;
}

/**
 * 把编辑器表单输入净化成一整条战法（kernel + ui 十级 + 溯源）。
 * 返回 { ok, skill?, message?, cfgId? }。校验失败给出可读原因，不落盘。
 */
export function buildCustomSkill(input, existingIds, allSkills) {
  const name = String(input?.name || '').trim().slice(0, 10);
  if (!name) return { ok: false, message: '战法名不能为空（1~10 字）' };
  const cls = SKILL_CLASSES.includes(input?.skillClass) ? input.skillClass : null;
  if (!cls) return { ok: false, message: '类别必须是 指挥/被动/主动/追击' };
  const effKey = input?.effectType && SKILL_EFFECTS[input.effectType] ? input.effectType : null;
  if (!effKey) return { ok: false, message: '效果必须是 兵刃伤害/谋略伤害/治疗/控制' };
  const tt = input?.targetType && SKILL_TARGETS[input.targetType] ? input.targetType : null;
  if (!tt) return { ok: false, message: '目标必须从下拉里选' };
  /* ★ 重名防线：新建战法若与现有战法同名，会在装载/upsert 时按 name 命中并整条覆盖
     原表战法（原 10001 凭空消失）。编辑既有条目（cfgId>0）沿用同名是允许的。
     这里只在「新建」时拦重名，编辑时由 baseSkillOf 按 cfgId 精确还原，不靠 name。 */
  if (!(Number(input?.cfgId) > 0) && Array.isArray(allSkills)) {
    const dup = allSkills.find((s) => s.name === name);
    if (dup) return { ok: false, message: `已有同名战法「${name}」(#${dup.cfgId})，请换一个名字` };
  }

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

/**
 * ★ 编辑已有战法的增量 patch（修复「编辑却丢字段」）：
 *   以原战法为基底深拷贝，只覆盖表单真正可编辑的字段，完整保留原表的
 *   多效果槽 / prepare / mechanics / bonus_terms / trigger / dir / detail_id /
 *   range 描述。校验数值仍复用 buildCustomSkill 的平衡闸（把校验产物当"数值来源"）。
 *   - 发动率：整条 ui.levels[].probability + kernel.probability_init/max 一起覆盖；
 *   - 值：只改「可编辑主槽」对应的 effect_value[slot]（伤害/治疗比率 或 控制命中率），
 *     kernel 侧同步 rate_pct_lv1/lv10（伤害槽）或 control_probability/control_state（控制槽）；
 *   - 名称：改名时 ui/kernel 的 name 一起改（不触碰 cfgId/detail_id）。
 */
export function patchExistingSkill(base, built) {
  const skill = JSON.parse(JSON.stringify(base));
  const fresh = built.skill;
  const slot = editableSlotIdx(effectSlotsOf(base));
  const v1 = fresh.ui.levels[0].effect_value[0];
  const v10 = fresh.ui.levels[fresh.ui.levels.length - 1].effect_value[0];

  skill.name = fresh.name;
  if (skill.ui) skill.ui.name = fresh.name;
  if (skill.kernel) skill.kernel.name = fresh.name;

  /* 发动率整条覆盖（战法级字段，指挥/被动恒 100）。 */
  for (let i = 0; i < skill.ui.levels.length; i += 1) {
    skill.ui.levels[i].probability = fresh.ui.levels[i].probability;
  }
  skill.kernel.probability_init = fresh.kernel.probability_init;
  skill.kernel.probability_max = fresh.kernel.probability_max;

  /* 只改主槽的 effect_value，其余槽（控制/mechanics）逐字保留。 */
  for (let i = 0; i < skill.ui.levels.length; i += 1) {
    const row = skill.ui.levels[i];
    if (!Array.isArray(row.effect_value)) row.effect_value = [];
    row.effect_value[slot] = fresh.ui.levels[i].effect_value[0];
  }
  const effs = effectSlotsOf(skill);
  const target = effs[slot];
  if (target && target.effect_type === 'CONTROL') {
    target.control_probability = v1 / 100;
    target.control_state = fresh.kernel.control_state || target.control_state;
  } else if (target) {
    if (target.effect_type === 'PHYSICAL_DAMAGE' || target.effect_type === 'STRATEGY_DAMAGE' || target.effect_type === 'HEAL') {
      target.rate_pct = v1;
    }
    skill.kernel.rate_pct_lv1 = v1;
    skill.kernel.rate_pct_lv10 = v10;
  }
  /* provenance 标注：被用户改过，但保留原溯源（说明改动来自编辑器）。 */
  skill.provenance = { ...(skill.provenance || {}), editedBy: '初始数据编辑器（增量编辑，保留原结构）' };
  return skill;
}

/** 全量列表（编辑器页签）：运行时表 + 自建标记 + 关键数值。allSkills = skills.js 的 SKILLS。 */
export function skillList(allSkills) {
  const custom = customSkillIds();
  const rows = (allSkills || []).map((s) => {
    const n = s.ui.levels.length;
    const effs = effectSlotsOf(s);
    const slot = editableSlotIdx(effs);
    const et = effs[slot]?.effect_type || '';
    const isCtl = et === 'CONTROL';
    const rateAt = (lv) => {
      // 控制槽命中率在 ui.effect_value[slot]（kernelSkillAt 用 now/100 消费），
      // 老代码只认伤害槽 → 控制战法显示 0→0，表单预填 0 被 clamp 成 1%，命中率被清空。
      const ev = Number(lv.effect_value?.[slot]);
      if (Number.isFinite(ev) && ev > 0) return ev;
      if (isCtl && effs[slot]?.control_probability) return Math.round(effs[slot].control_probability * 100);
      return 0;
    };
    return {
      cfgId: Number(s.cfgId),
      name: s.name,
      cls: s.kernel.skill_class,
      effect: et,
      p1: s.ui.levels[0].probability,
      p10: s.ui.levels[n - 1].probability,
      rate1: rateAt(s.ui.levels[0]),
      rate10: rateAt(s.ui.levels[n - 1]),
      controlState: isCtl ? (effs[slot].control_state || '混乱') : '',
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
  const built = buildCustomSkill(input, ids, allSkills);
  if (!built.ok) return built;
  /* ★ 编辑既有战法走增量 patch：以运行时表里的原条目为基底，只改表单字段，
     多效果槽 / prepare / mechanics / bonus_terms 等高级结构逐字保留。
     新建战法（isNew）才用 buildCustomSkill 的整条构造。 */
  let toSave = built.skill;
  if (!built.isNew) {
    const base = (allSkills || []).find((s) => Number(s.cfgId) === built.cfgId);
    if (base) toSave = patchExistingSkill(base, built);
  }
  const doc = loadCustomDoc();
  const i = doc.skills.findIndex((s) => Number(s.cfgId) === built.cfgId);
  if (i >= 0) doc.skills[i] = toSave;
  else doc.skills.push(toSave);
  saveCustomDoc(doc);
  upsertRuntimeSkill(toSave);
  return {
    ok: true, cfgId: built.cfgId, isNew: built.isNew, name: toSave.name,
    message: built.isNew
      ? `已创建战法「${toSave.name}」(#${built.cfgId})`
      : `已编辑战法「${toSave.name}」(#${built.cfgId})，原有机制/多效果已保留`,
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
  /* 先按 cfgId 从五表精确还原（不再用同名兜底——重名时同名兜底会把
     "自建战法"错认成原表条目，导致 removeRuntimeSkill 不执行、自建残留内存表）。 */
  const base = baseSkillOf(cfgId);
  if (base) {
    /* 还原的是未经过 applyRangeNote 的原始对象，需重新套一次射程/有效距离描述，
       与模块加载时（skills.js 末尾 for SKILLS applyRangeNote）保持同源。 */
    const restored = applyRangeNote(JSON.parse(JSON.stringify(base)));
    upsertRuntimeSkill(restored);
    return { ok: true, cfgId, restored: restored.name, message: `已还原为原表「${restored.name}」` };
  }
  removeRuntimeSkill(cfgId);
  return { ok: true, cfgId, removed: custom.name, message: `已删除自建战法「${custom.name}」` };
}

/** 从五张原表按 cfgId 精确找被覆盖前的原条目（不再同名兜底，避免误伤）。 */
function baseSkillOf(cfgId) {
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
      const hit = list.find((s) => Number(s.cfgId) === cfgId);
      if (hit) return hit;
    } catch { /* 单表损坏跳过 */ }
  }
  return null;
}
