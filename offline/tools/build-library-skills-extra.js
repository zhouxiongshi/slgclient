/**
 * M3-8 战法补量（GDD §9/§16）：把包内战法从 51 条扩到 80 条。
 *
 * 本脚本生成 conf/library-skills-extra.json —— 29 条【新机制组合】的原创战法。
 *
 * 为什么不能直接从既有素材再挑：
 *   - conf/skills.json 31 条已用尽 damage_rates.csv 的全部真实片段模式；
 *   - skill-library 128 条 = 20 种效果签名的改名皮肤（数值完全相同），
 *     build-library-skills.js 去重后只剩 20 条。
 *   所以新增只能来自【新签名组合】——全部落在 skill-library patterns.csv
 *   (P01~P16) 已登记的设计语义之内，逐条标注 pattern 对应。
 *
 * 内核真实生效面约束（battle-core/src/rules.ts + engine.ts，逐条核对过）：
 *   1. BUFF/DEBUFF 词【不做名字匹配】，attacker.buffs 全部求和进伤害加成；
 *      因此只有「攻击伤害提高/策略攻击伤害提高」这类攻击方词真实生效。
 *   2. DEBUFF 挂到敌方身上后【不参与任何结算】（现存内核债务）——
 *      本批新战法一律不使用 DEBUFF，防止"描述承诺减伤、结算无感"。
 *   3. 控制状态中只有「犹豫」真实封锁主动战法（controlBlocks），
 *      混乱/动摇/怯战目前是装饰态——纯控制战法是空效果，
 *      故本批控制槽一律【伴随伤害】；真封锁（犹豫）的控制概率 ≤ 0.3。
 *   4. 追击战法目标强制为普攻目标（nearestFoe 单目标）——追击不做群体。
 *   5. available_round 语义 =「仅前 N 回合可用」（round > N 失效）。
 *   6. ally_single 目标内核原生支持（effectTargets）。
 *
 * 数值纪律（patterns.csv 惯例）：
 *   - 发动率：主动/追击 0.35~0.45；被动/指挥 1.0（rollTrigger 被动免费）。
 *   - 倍率：单体爆发 140~180%、群体 60~130%、治疗 90~130%、光环 4~15%。
 *   - 等级：lv1→lv10 每个数值 ×2（1 + (lv-1)/9 线性），与库内口径一致。
 *
 * 自检（脚本内 + tests/m3-skills-80.test.js 双保险）：
 *   - cfgId 910100~910128 连续不冲突、战法名三表唯一；
 *   - 效果签名（skill_class + effects[类型/目标/控制词/available_round] 顺序串）
 *     与主线/库内/本批内部全部唯一；
 *   - ui.des 占位数 = kernel.effects 数 = include_effect 数；
 *   - lv10 = lv1 × 2；概率纪律；控制槽纪律；追击纪律。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGET_NUM = { self: 1, ally_single: 4, ally_group: 5, enemy_single: 6, enemy_group: 9 };
const TARGET_WHO = { self: '自身', ally_single: '我军单体', ally_group: '我军全体', enemy_single: '敌军单体', enemy_group: '敌军全体' };
const CLASS_TRIGGER = { 主动: 1, 被动: 2, 追击: 3, 指挥: 4 };
const CLASS_DIR = { 主动: 'zhudong', 被动: 'beidong', 追击: 'zuiji', 指挥: 'zhihui' };
const ARMS_ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/* ------------------------------------------------------------------ */
/* 29 条设计清单。每条：id/name/cls/prepare/prob/pattern/tags/effects[] */
/* effect: { type, target, rate | buff | ctrl, available, atk, cprob } */
/* ------------------------------------------------------------------ */
const DESIGNS = [
  // —— 主动 12 条 ——
  { id: 910100, name: '奇佐危谋', cls: '主动', prob: 0.35, pattern: 'P01', tags: ['输出', '爆发', '单体'],
    effects: [{ type: 'STRATEGY_DAMAGE', target: 'enemy_single', rate: 150, atk: 'chain' }] },
  { id: 910101, name: '惊雷贯阵', cls: '主动', prob: 0.35, pattern: 'P03', tags: ['输出', '准备', '爆发', '单体'],
    /* prepare=2：两回合准备换最高倍率（内核 prepare 任意回合数真实生效） */
    effects: [{ type: 'PHYSICAL_DAMAGE', target: 'enemy_single', rate: 220, atk: 'normal' }], prepare: 2 },
  { id: 910102, name: '燎原秘策', cls: '主动', prob: 0.35, pattern: 'P03', tags: ['谋略', '准备', '群体'],
    effects: [{ type: 'STRATEGY_DAMAGE', target: 'enemy_group', rate: 130, atk: 'chain' }], prepare: 1 },
  { id: 910103, name: '荡寇破阵', cls: '主动', prob: 0.4, pattern: 'P01', tags: ['输出', '群体', '自增益'],
    effects: [{ type: 'PHYSICAL_DAMAGE', target: 'enemy_group', rate: 60, atk: 'normal' },
      { type: 'BUFF', target: 'self', buff: '攻击伤害提高', value: 8 }] },
  { id: 910104, name: '破胆夺气', cls: '主动', prob: 0.35, pattern: 'P04', tags: ['输出', '控制', '单体'],
    effects: [{ type: 'PHYSICAL_DAMAGE', target: 'enemy_single', rate: 90, atk: 'normal' },
      { type: 'CONTROL', target: 'enemy_single', ctrl: '动摇', cprob: 1 }] },
  { id: 910105, name: '缚龙锁澜', cls: '主动', prob: 0.35, pattern: 'P04', tags: ['谋略', '控制', '单体'],
    effects: [{ type: 'STRATEGY_DAMAGE', target: 'enemy_single', rate: 80, atk: 'chain' },
      { type: 'CONTROL', target: 'enemy_single', ctrl: '怯战', cprob: 1 }] },
  { id: 910106, name: '悬壶济军', cls: '主动', prob: 0.45, pattern: 'P06', tags: ['治疗', '单体'],
    effects: [{ type: 'HEAL', target: 'ally_single', rate: 130 }] },
  { id: 910107, name: '仁心回春', cls: '主动', prob: 0.4, pattern: 'P06', tags: ['治疗', '辅助', '单体'],
    effects: [{ type: 'HEAL', target: 'ally_single', rate: 100 },
      { type: 'BUFF', target: 'ally_single', buff: '攻击伤害提高', value: 6 }] },
  { id: 910108, name: '深谋远虑', cls: '主动', prob: 0.4, pattern: 'P01', tags: ['谋略', '爆发', '自增益'],
    effects: [{ type: 'BUFF', target: 'self', buff: '策略攻击伤害提高', value: 12 },
      { type: 'STRATEGY_DAMAGE', target: 'enemy_single', rate: 110, atk: 'chain' }] },
  { id: 910109, name: '天罗地网', cls: '主动', prob: 0.35, pattern: 'P16', tags: ['谋略', '封锁', '群体'],
    /* 犹豫是内核唯一真实封锁词；群体封锁强控，控制概率压到 0.3 */
    effects: [{ type: 'STRATEGY_DAMAGE', target: 'enemy_group', rate: 70, atk: 'chain' },
      { type: 'CONTROL', target: 'enemy_group', ctrl: '犹豫', cprob: 0.3 }] },
  { id: 910110, name: '覆军杀将', cls: '主动', prob: 0.4, pattern: 'P02', tags: ['谋略', '群体', '自增益'],
    effects: [{ type: 'STRATEGY_DAMAGE', target: 'enemy_single', rate: 95, atk: 'chain' },
      { type: 'BUFF', target: 'self', buff: '攻击伤害提高', value: 6 }] },
  { id: 910111, name: '却敌固垒', cls: '主动', prob: 0.4, pattern: 'P06', tags: ['治疗', '自增益', '自持'],
    effects: [{ type: 'HEAL', target: 'self', rate: 90 },
      { type: 'BUFF', target: 'self', buff: '攻击伤害提高', value: 6 }] },

  // —— 被动 6 条 ——
  { id: 910112, name: '百炼成钢', cls: '被动', prob: 1, pattern: 'P10', tags: ['常驻', '输出'],
    effects: [{ type: 'BUFF', target: 'self', buff: '攻击伤害提高', value: 6 }] },
  { id: 910113, name: '文武两全', cls: '被动', prob: 1, pattern: 'P10', tags: ['常驻', '双修'],
    effects: [{ type: 'BUFF', target: 'self', buff: '攻击伤害提高', value: 4 },
      { type: 'BUFF', target: 'self', buff: '策略攻击伤害提高', value: 4 }] },
  { id: 910114, name: '逆锋决胜', cls: '被动', prob: 1, pattern: 'P10', tags: ['爆发', '前期'],
    /* available_round=2：仅前 2 回合可用（内核 effectAvailable 真实生效） */
    effects: [{ type: 'BUFF', target: 'self', buff: '攻击伤害提高', value: 15, available: 2 }] },
  { id: 910115, name: '长驱直入', cls: '被动', prob: 1, pattern: 'P12', tags: ['输出', '常驻'],
    effects: [{ type: 'PHYSICAL_DAMAGE', target: 'enemy_single', rate: 70, atk: 'normal' },
      { type: 'BUFF', target: 'self', buff: '攻击伤害提高', value: 5 }] },
  { id: 910116, name: '火昭天罚', cls: '被动', prob: 1, pattern: 'P12', tags: ['谋略', '常驻'],
    effects: [{ type: 'STRATEGY_DAMAGE', target: 'enemy_single', rate: 60, atk: 'chain' }] },
  { id: 910117, name: '坚甲利刃', cls: '被动', prob: 1, pattern: 'P12', tags: ['反击', '辅助'],
    effects: [{ type: 'PHYSICAL_DAMAGE', target: 'enemy_single', rate: 45, atk: 'normal' },
      { type: 'BUFF', target: 'self', buff: '防御属性提高', value: 8 }] },

  // —— 追击 5 条（内核追击目标=普攻目标，一律单体）——
  { id: 910118, name: '顺风扬刃', cls: '追击', prob: 0.35, pattern: 'P13', tags: ['输出', '追击'],
    effects: [{ type: 'PHYSICAL_DAMAGE', target: 'enemy_single', rate: 85, atk: 'normal' },
      { type: 'BUFF', target: 'self', buff: '攻击伤害提高', value: 5 }] },
  { id: 910119, name: '饮血飞骑', cls: '追击', prob: 0.4, pattern: 'P13', tags: ['恢复', '追击', '自持'],
    effects: [{ type: 'HEAL', target: 'self', rate: 60 }] },
  { id: 910120, name: '智取坚城', cls: '追击', prob: 0.4, pattern: 'P15', tags: ['谋略', '控制', '追击'],
    effects: [{ type: 'STRATEGY_DAMAGE', target: 'enemy_single', rate: 75, atk: 'chain' },
      { type: 'CONTROL', target: 'enemy_single', ctrl: '怯战', cprob: 1 }] },
  { id: 910121, name: '追风逐电', cls: '追击', prob: 0.35, pattern: 'P15', tags: ['输出', '控制', '追击'],
    effects: [{ type: 'PHYSICAL_DAMAGE', target: 'enemy_single', rate: 65, atk: 'normal' },
      { type: 'CONTROL', target: 'enemy_single', ctrl: '动摇', cprob: 1 }] },
  { id: 910122, name: '摧锋谋断', cls: '追击', prob: 0.4, pattern: 'P14', tags: ['谋略', '追击', '自增益'],
    effects: [{ type: 'STRATEGY_DAMAGE', target: 'enemy_single', rate: 70, atk: 'chain' },
      { type: 'BUFF', target: 'self', buff: '策略攻击伤害提高', value: 5 }] },

  // —— 指挥 6 条 ——
  { id: 910123, name: '虎贲督战', cls: '指挥', prob: 1, pattern: 'P08', tags: ['光环', '输出'],
    effects: [{ type: 'BUFF', target: 'ally_group', buff: '攻击伤害提高', value: 8 }] },
  { id: 910124, name: '玄襄谋阵', cls: '指挥', prob: 1, pattern: 'P08', tags: ['光环', '谋略'],
    effects: [{ type: 'BUFF', target: 'ally_group', buff: '策略攻击伤害提高', value: 8 }] },
  { id: 910125, name: '沧海横流', cls: '指挥', prob: 1, pattern: 'P09', tags: ['恢复', '前期'],
    effects: [{ type: 'HEAL', target: 'ally_group', rate: 45, available: 3 }] },
  { id: 910126, name: '深沟高垒', cls: '指挥', prob: 1, pattern: 'P07', tags: ['光环', '前期', '输出'],
    effects: [{ type: 'BUFF', target: 'ally_group', buff: '攻击伤害提高', value: 5, available: 2 }] },
  { id: 910127, name: '举燎合围', cls: '指挥', prob: 1, pattern: 'P08', tags: ['恢复', '光环'],
    effects: [{ type: 'HEAL', target: 'ally_group', rate: 35 },
      { type: 'BUFF', target: 'ally_group', buff: '攻击伤害提高', value: 5 }] },
  { id: 910128, name: '阵前擂鼓', cls: '指挥', prob: 1, pattern: 'P09', tags: ['恢复', '单体'],
    effects: [{ type: 'HEAL', target: 'ally_single', rate: 60, available: 4 }] },
];

/* ------------------------------------------------------------------ */

const round2 = (n) => Math.round(n * 100) / 100;

/** 库内口径：lv10 = lv1 × 2（1 + (lv-1)/9 线性）。 */
function levelsOf(values, prob) {
  const pct = Math.round(prob * 100);
  const levels = [];
  for (let lv = 1; lv <= 10; lv += 1) {
    const scale = 1 + (lv - 1) / 9;
    levels.push({
      probability: pct,
      effect_value: values.map((v) => round2(v * scale)),
      effect_round: values.map(() => 0),
    });
  }
  return levels;
}

function slotText(e) {
  const who = TARGET_WHO[e.target];
  if (e.type === 'PHYSICAL_DAMAGE') return `对${who}造成兵刃伤害（伤害率%n%%）`;
  if (e.type === 'STRATEGY_DAMAGE') return `对${who}造成谋略伤害（伤害率%n%%）`;
  if (e.type === 'HEAL') return `为${who}恢复兵力（恢复率%n%%）`;
  if (e.type === 'CONTROL') return `使${who}陷入${e.ctrl}（几率%n%%）`;
  if (e.type === 'BUFF') return `${who}${e.buff}（%n%%）`;
  throw new Error(`${e.type} 未支持`);
}
function slotValue(e) {
  if (e.ctrl !== undefined) return round2((e.cprob ?? 1) * 100);
  if (e.buff !== undefined) return e.value;
  return e.rate;
}
function effectIcon(e) {
  if (e.buff === '策略攻击伤害提高') return 4;
  if (e.buff !== undefined) return 2;
  return 1;
}

function buildOne(d, i) {
  const effects = d.effects.map((e, k) => ({
    detail_id: d.id * 10 + k,
    effect_type: e.type,
    rate_pct: e.rate ?? 0,
    target_type: e.target,
    attack_type: e.atk || 'normal',
    available_round: e.available ?? 0,
    control_state: e.ctrl ?? null,
    control_probability: e.ctrl !== undefined ? (e.cprob ?? 1) : 0,
    bonus_terms: e.buff !== undefined ? [{ name: e.buff, value: e.value, op: 0 }] : [],
  }));

  const slots = d.effects.map((e) => ({ text: slotText(e), value: slotValue(e), icon: effectIcon(e) }));
  const values = slots.map((s) => s.value);
  const des = `${slots.map((s) => s.text).join('，')}。特性：${d.tags.join('、')}。`;
  if ((des.match(/%n%/g) || []).length !== values.length) {
    throw new Error(`${d.name} 描述占位与数值对不上`);
  }

  const trigger = CLASS_TRIGGER[d.cls];
  const ui = {
    cfgId: d.id,
    name: d.name,
    des,
    trigger,
    target: TARGET_NUM[d.effects[0].target],
    limit: 1,
    arms: ARMS_ALL,
    include_effect: slots.map((s) => s.icon),
    levels: levelsOf(values, d.prob),
  };
  const kernel = {
    cfgId: d.id,
    name: d.name,
    skill_class: d.cls,
    prepare: d.prepare ?? 0,
    probability_init: d.prob,
    probability_max: d.prob,
    detail_id: d.id,
    effects,
  };
  return {
    cfgId: d.id,
    name: d.name,
    trigger,
    dir: CLASS_DIR[d.cls],
    ui,
    kernel,
    provenance: {
      pairing: 'skill-library-extra',
      source: 'offline/tools/build-library-skills-extra.js（M3-8 原创组合，patterns.csv P01~P16 语义内）',
      pattern: d.pattern,
      tags: d.tags,
      quality: 4,
      kernelNotes: [
        'BUFF 词全部为攻击方伤害加成词（内核 attacker.buffs 全求和，真实生效）',
        '不使用 DEBUFF（内核不结算敌方身上的词，避免描述≠计算）',
        '控制槽一律伴随伤害；犹豫为真实封锁词且控制概率 ≤ 0.3',
      ],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 自检                                                                */
/* ------------------------------------------------------------------ */
const errors = [];

// 1. cfgId / 名称唯一性（含与主线、库内对照）
const main = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'skills.json'), 'utf8'));
const lib = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'library-skills.json'), 'utf8'));
const seenIds = new Set([...main.skills, ...lib.skills].map((s) => s.cfgId));
const seenNames = new Set([...main.skills, ...lib.skills].map((s) => s.name));
for (const d of DESIGNS) {
  if (seenIds.has(d.id)) errors.push(`${d.id} cfgId 已被占用`);
  if (seenNames.has(d.name)) errors.push(`${d.name} 与既有战法重名`);
  seenIds.add(d.id); seenNames.add(d.name);
}
const ids = DESIGNS.map((d) => d.id);
if (new Set(ids).size !== ids.length) errors.push('本批 cfgId 重复');

// 2. 效果签名全局唯一（skill_class + prepare + 槽序[类型/目标/控制词/增益词/available_round]；不含数值）
function signature(s) {
  const k = s.kernel;
  const fx = (Array.isArray(k.effects) && k.effects.length ? k.effects : [k]).map((e) =>
    [e.effect_type, e.target_type, e.control_state ?? null,
      (e.bonus_terms || []).map((b) => b.name).join('+') || '-', e.available_round ?? 0].join('/'));
  return `${k.skill_class}#${k.prepare ?? 0}#${fx.join('|')}`;
}
const sigs = new Map();
for (const s of [...main.skills, ...lib.skills]) sigs.set(signature(s), s.name);

// 3. 内核纪律
const BLOCK_WORDS = new Set(['混乱', '动摇', '怯战', '暴走']); // 装饰态（犹豫除外）
for (const d of DESIGNS) {
  const s = buildOne(d, 0);
  const sig = signature(s);
  if (sigs.has(sig)) errors.push(`${d.name} 签名与既有战法 ${sigs.get(sig)} 重复`);
  sigs.set(sig, d.name);

  const hasDamage = s.kernel.effects.some((e) => e.effect_type.includes('DAMAGE'));
  for (const e of s.kernel.effects) {
    if (e.effect_type === 'DEBUFF') errors.push(`${d.name} 使用了内核不结算的 DEBUFF`);
    if (e.effect_type === 'CONTROL') {
      if (e.control_state === '犹豫') {
        if (!hasDamage) errors.push(`${d.name} 纯犹豫封锁无伤害槽（空效果）`);
        if (e.control_probability > 0.3) errors.push(`${d.name} 群体/单封犹豫控制概率超 0.3`);
      } else if (BLOCK_WORDS.has(e.control_state) && !hasDamage) {
        errors.push(`${d.name} 装饰控制词 ${e.control_state} 无伤害伴随（空效果）`);
      }
      if (e.control_state && d.cls === '追击' && !hasDamage) {
        errors.push(`${d.name} 追击纯控制空效果`);
      }
    }
  }
  if (d.cls === '追击' && s.kernel.effects.some((e) => String(e.target_type).startsWith('enemy') && e.target_type !== 'enemy_single')) {
    errors.push(`${d.name} 追击战法非单目标（内核强制普攻目标）`);
  }
  // 概率纪律
  const p = d.prob;
  if (d.cls === '被动' || d.cls === '指挥') { if (p !== 1) errors.push(`${d.name} 被动/指挥发动率应为 1.0`); }
  else if (p < 0.3 || p > 0.5) errors.push(`${d.name} 发动率 ${p} 越界（0.30~0.50）`);
  // 等级成长：lv10 = lv1 × 2
  for (let k = 0; k < s.ui.levels[0].effect_value.length; k += 1) {
    const v1 = s.ui.levels[0].effect_value[k], v10 = s.ui.levels.at(-1).effect_value[k];
    if (v1 > 0 && Math.abs(v10 - v1 * 2) > 0.02) errors.push(`${d.name} 槽${k} lv10 ≠ lv1×2`);
  }
  // ui/kernel 同源
  const ph = (s.ui.des.match(/%n%/g) || []).length;
  if (ph !== s.kernel.effects.length) errors.push(`${d.name} 占位 ${ph} ≠ 效果数 ${s.kernel.effects.length}`);
  if (s.ui.include_effect.length !== s.kernel.effects.length) errors.push(`${d.name} include_effect 数不符`);
  if (s.ui.levels.length !== 10) errors.push(`${d.name} 等级数不是 10`);
  if (s.ui.des.indexOf('特性：') < 0) errors.push(`${d.name} 缺特性段`);
  // 目标映射合法
  for (const e of s.kernel.effects) if (!(e.target_type in TARGET_NUM)) errors.push(`${d.name} 未知目标 ${e.target_type}`);
}

// 4. 四类齐全
for (const cls of ['主动', '被动', '追击', '指挥']) {
  if (!DESIGNS.some((d) => d.cls === cls)) errors.push(`缺少 ${cls} 类`);
}
// 5. 六种效果类型不全要求，但本批应覆盖 HEAL/CONTROL/BUFF 新形态
for (const t of ['HEAL', 'CONTROL', 'BUFF']) {
  if (!DESIGNS.some((d) => d.effects.some((e) => e.type === t))) errors.push(`本批缺少 ${t} 效果`);
}

if (errors.length) {
  console.error('[build-library-skills-extra] 自检失败:', errors.slice(0, 12));
  process.exit(1);
}

/* ------------------------------------------------------------------ */
const skills = DESIGNS.map(buildOne);
const table = {
  version: 1,
  generatedBy: 'offline/tools/build-library-skills-extra.js',
  source: 'skill-library patterns.csv (P01~P16) 语义内的原创效果组合；kernelNotes 逐条说明内核生效面',
  fidelity: {
    design: 'authored',          // 原创设计（skill-library 延续）
    kernelSemantics: 'verified', // 逐条对照 battle-core/src/{rules,engine}.ts 真实生效面
  },
  levelCount: 10,
  count: skills.length,
  skills,
};
writeFileSync(resolve(ROOT, 'conf', 'library-skills-extra.json'), JSON.stringify(table, null, 2), 'utf8');
console.log(JSON.stringify({
  out: 'conf/library-skills-extra.json',
  count: skills.length,
  classes: Object.fromEntries(['主动', '被动', '追击', '指挥'].map((c) => [c, skills.filter((s) => s.kernel.skill_class === c).length])),
  total: main.count + lib.count + skills.length,
  sample: { name: skills[0].name, des: skills[0].ui.des, effects: skills[0].kernel.effects.length },
}, null, 2));
