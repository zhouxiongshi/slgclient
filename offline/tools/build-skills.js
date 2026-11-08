/**
 * 重建【真实原文驱动】的战法表。
 *
 * 数据来源（全部为 battle-kit 导出的原游戏真实数据）：
 *   - data/damage_rates.csv      —— 83 条原游戏技能描述片段（含真实伤害率与 lv1→lv10 成长）
 *   - data/skill_names.csv       —— 796 个原游戏真实技能名
 *   - data/damage_effect_terms.csv —— 188 个真实效果术语
 *   - 02-技能与效果字典.md        —— E0 四类骨架 / 概率占位口径 / 等级线性插值
 *
 * 忠实性约定：
 *   - des        ← 描述片段原文（仅去掉 @ 高亮记号与截断补全，正文不动）
 *   - lv1/lv10   ← 片段内 `伤害率@A%@ {0} @B%@` 的真实成长对；无 {0} 的为固定值
 *   - name       ← 真实技能名录；其中 轻骑冲阵/异士/混战 来自片段内嵌名
 *   - 名字↔效果 的原始配对在 battle-kit 中无数据（Tcfg_skill 仅存字段名），
 *     按语义就近配对，逐条在 provenance.pairing 中如实标注 'reconstructed'
 *   - 发动概率原始值未解包，按 02 字典口径用占位值（35%→70% 线性，被动 100%）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = resolve(ROOT, '..', '..', 'battle-kit');
const OUT = join(ROOT, 'conf', 'skills.json');

function parseCsv(p) {
  const s = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const kitRows = parseCsv(join(KIT, 'data', 'damage_rates.csv')).slice(1);
const kitNames = parseCsv(join(KIT, 'data', 'skill_names.csv')).slice(1).map((r) => r[0]);
const NAME_SET = new Set(kitNames);
/** 片段内嵌的真实战法名（不在 796 名录，但确为原游戏文本） */
const FRAGMENT_NAMES = new Set(['轻骑冲阵', '异士', '混战']);
const LEGACY = new Set(['突击', '百战精兵', '重斩', '锋矢']);

/** 校验 (lv1→lv10) 是真实成长对：存在片段同时含 lv1 与 lv10；固定值：存在该值的片段 */
function assertRealRate(lv1, lv10, tag) {
  const has1 = kitRows.some((r) => Number(r[2]) === lv1);
  if (!has1) throw new Error(`${tag}: 伤害率 ${lv1} 不在真实片段中`);
  if (lv10 !== lv1) {
    const paired = kitRows.some((r) => Number(r[2]) === lv1 && (r[3] || '').includes(String(lv10)));
    if (!paired) throw new Error(`${tag}: ${lv1}→${lv10} 不是片段中的真实成长对`);
  }
}

const LEVELS = 10;
const CLASS_BY_TRIGGER = { 1: '主动', 2: '被动', 3: '追击', 4: '指挥' };
const TRIGGER_DIR = { 1: 'zhudong', 2: 'beidong', 3: 'zuiji', 4: 'zhihui' };
const ARMS_ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const round = (n) => Math.round(n * 100) / 100;

/**
 * 真实效果条目。lv1/lv10 与 des 全部摘自 damage_rates.csv 原文。
 * src = 片段来源 (file_id/index)，pairing = 名字↔效果配对方式。
 */
const REAL_EFFECTS = [
  // —— 主动 · 群体兵刃（片段：「对敌军群体发动一次攻击（伤害率@A%@ {0} @B%@）」）——
  { name: '击势', trigger: 1, target: 9, effect: 'PHYSICAL_DAMAGE', lv1: 50, lv10: 100, des: '对敌军群体发动一次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  { name: '兵贵神速', trigger: 1, target: 9, effect: 'PHYSICAL_DAMAGE', lv1: 60, lv10: 120, des: '对敌军群体发动一次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  { name: '万箭齐发', trigger: 1, target: 9, effect: 'PHYSICAL_DAMAGE', lv1: 75, lv10: 150, des: '对敌军群体发动一次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  { name: '三军齐出', trigger: 1, target: 9, effect: 'PHYSICAL_DAMAGE', lv1: 80, lv10: 160, des: '对敌军群体发动一次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  { name: '侵掠如火', trigger: 1, target: 9, effect: 'PHYSICAL_DAMAGE', lv1: 90, lv10: 180, des: '对敌军群体发动一次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  { name: '先声夺人', trigger: 1, target: 9, effect: 'PHYSICAL_DAMAGE', lv1: 95, lv10: 190, des: '对敌军群体发动一次进攻（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  { name: '全军突击', trigger: 1, target: 9, effect: 'PHYSICAL_DAMAGE', lv1: 100, lv10: 200, des: '对敌军群体发动一次进攻（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  // —— 主动 · 单体兵刃 ——
  { name: '一骑当千', trigger: 1, target: 6, effect: 'PHYSICAL_DAMAGE', lv1: 140, lv10: 280, des: '对敌军单体发动1次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  { name: '万军取首', trigger: 1, target: 6, effect: 'PHYSICAL_DAMAGE', lv1: 150, lv10: 300, des: '对敌军单体发动1次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  // —— 主动 · 群体策略 ——
  { name: '三术奇谋', trigger: 1, target: 9, effect: 'STRATEGY_DAMAGE', lv1: 120, lv10: 240, des: '对敌军群体发动一次策略攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain' },
  { name: '凤仪施计', trigger: 1, target: 9, effect: 'STRATEGY_DAMAGE', lv1: 120, lv10: 240, des: '对敌军群体发动一次策略攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain' },
  // —— 主动 · 距离内策略 ——
  { name: '决绝', trigger: 1, target: 8, effect: 'STRATEGY_DAMAGE', lv1: 75, lv10: 150, des: '对有效距离以内的敌军发动一次策略攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain' },
  { name: '乱矢蓄川', trigger: 1, target: 8, effect: 'STRATEGY_DAMAGE', lv1: 90, lv10: 180, des: '对有效距离以内的敌军发动一次策略攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain' },
  // —— 主动 · 无视兵种相克 ——
  { name: '乘间击隙', trigger: 1, target: 6, effect: 'PHYSICAL_DAMAGE', lv1: 60, lv10: 120, des: '发动1次无视兵种相克的攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'armor' },
  { name: '亡命一搏', trigger: 1, target: 6, effect: 'PHYSICAL_DAMAGE', lv1: 70, lv10: 140, des: '发动1次无视兵种相克的攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'armor' },
  // —— 主动 · 攻击或策略（二选一）——
  { name: '兵无常势', trigger: 1, target: 9, effect: 'STRATEGY_DAMAGE', lv1: 90, lv10: 180, des: '发动一次攻击（伤害率%n%%）或策略攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain' },
  // —— 主动 · 控制（动摇/恐慌/妖术，真实状态名）——
  { name: '乱击', trigger: 1, target: 6, effect: 'CONTROL', lv1: 80, lv10: 80, des: '使攻击目标随机陷入动摇（伤害率%n%%）、恐慌（伤害率%n%%）、妖术（伤害率%n%%）状态中的一种，持续1回合', src: '0x2fbbc99d/2271', attack: 'chain', control: '混乱', fixed: true },
  { name: '中级扰乱', trigger: 1, target: 6, effect: 'CONTROL', lv1: 17.5, lv10: 35, des: '有几率引发一次动摇效果（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain', control: '动摇' },
  { name: '乱阵', trigger: 1, target: 6, effect: 'CONTROL', lv1: 30, lv10: 60, des: '有几率引发一次动摇效果（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain', control: '动摇' },
  // —— 主动 · 准备回合（真实机制文本：「1回合准备」）——
  { name: '一雷惊蛰', trigger: 1, target: 6, effect: 'PHYSICAL_DAMAGE', lv1: 7, lv10: 7, des: '1回合准备，对随机敌军发动攻击，每次目标独立判定，每次伤害率都递增%n%%', src: '0xc4f8c96f', attack: 'normal', prepare: 1, fixed: true },
  // —— 追击 · 再次策略攻击 ——
  { name: '乘胜追击', trigger: 3, target: 6, effect: 'STRATEGY_DAMAGE', lv1: 59.5, lv10: 119, des: '对目标再次发动策略攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain' },
  { name: '中宫追玺', trigger: 3, target: 6, effect: 'STRATEGY_DAMAGE', lv1: 65, lv10: 130, des: '对目标再次发动策略攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'chain' },
  { name: '先驱突击', trigger: 3, target: 6, effect: 'PHYSICAL_DAMAGE', lv1: 40, lv10: 80, des: '陈到对其发动1次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  { name: '伏波扬砂', trigger: 3, target: 6, effect: 'PHYSICAL_DAMAGE', lv1: 60, lv10: 120, des: '陈到对其发动1次攻击（伤害率%n%%）', src: '0x766c483a/5635', attack: 'normal' },
  // —— 被动 ——
  { name: '反击', trigger: 2, target: 1, effect: 'BUFF', lv1: 75, lv10: 75, des: '受到普通攻击时能进行反击（伤害率%n%%）', src: '0x24b22708/1755', fixed: true },
  { name: '健卒不殆', trigger: 2, target: 1, effect: 'BUFF', lv1: 40, lv10: 40, des: '行动时对附近的敌军造成伤害（伤害率%n%%）', src: '0xc4f8c96f', fixed: true },
  { name: '混战', trigger: 2, target: 1, effect: 'BUFF', lv1: 50, lv10: 50, des: '行动时对附近的敌军造成伤害（伤害率%n%%）', src: '0xc4f8c96f', fixed: true },
  { name: '众叛亲离', trigger: 2, target: 9, effect: 'CONTROL', lv1: 40, lv10: 80, des: '使目标陷入动摇状态，每回合产生逃兵（伤害率%n%%）', src: '0x766c483a/5635', control: '动摇' },
  // —— 指挥 ——
  { name: '轻骑冲阵', trigger: 4, target: 1, effect: 'BUFF', lv1: 40, lv10: 40, des: '前2回合优先行动，行动时对附近的敌军造成伤害（伤害率%n%%）', src: '0xc4f8c96f', fixed: true },
  { name: '异士', trigger: 4, target: 6, effect: 'PHYSICAL_DAMAGE', lv1: 25, lv10: 25, des: '当兵力少于战斗初始兵力时，对距离1的敌军发动一次攻击（伤害率%n%%）', src: '0xc4f8c96f', fixed: true },
  { name: '义勇军', trigger: 4, target: 1, effect: 'BUFF', lv1: 32.5, lv10: 32.5, des: '进入分兵状态（伤害率%n%%）；可进行2次普通攻击', src: '0x86739953', fixed: true },
];

const skills = REAL_EFFECTS.map((e, i) => {
  if (!NAME_SET.has(e.name) && !FRAGMENT_NAMES.has(e.name)) throw new Error(`${e.name} 不在真实技能名录`);
  if (LEGACY.has(e.name)) throw new Error(`${e.name} 是旧占位技能名`);
  assertRealRate(e.lv1, e.lv10, e.name);

  const cfgId = 10001 + i;
  const fixed = !!e.fixed;
  const passive = e.trigger === 2;
  // 概率：被动无条件生效（02 字典）；其余用占位 35%→70%（原始概率未解包，如实标注）
  const p1 = passive ? 100 : 35;
  const p10 = passive ? 100 : 70;

  const phCount = (e.des.match(/%n%/g) || []).length;
  const singleIe = e.effect === 'CONTROL' ? 1 : e.effect === 'BUFF' ? 2 : e.effect === 'DEBUFF' ? 3 : 1;
  const values = (lv) => {
    if (fixed) return Array.from({ length: phCount }, () => e.lv1);
    const t = (lv - 1) / (LEVELS - 1);
    return Array.from({ length: phCount }, () => round(e.lv1 + (e.lv10 - e.lv1) * t));
  };
  const levels = [];
  for (let lv = 1; lv <= LEVELS; lv += 1) {
    levels.push({
      probability: Math.round(p1 + (p10 - p1) * (lv - 1) / (LEVELS - 1)),
      effect_value: values(lv),
      effect_round: Array.from({ length: phCount }, () => (e.control ? Math.min(3, 1 + Math.floor((lv - 1) / 4)) : 0)),
    });
  }

  const singleIe2 = singleIe;
  const ui = {
    cfgId,
    name: e.name,
    des: e.des,
    trigger: e.trigger,
    target: e.target,
    limit: 3,
    arms: ARMS_ALL,
    include_effect: Array.from({ length: phCount }, () => singleIe2),
    levels,
  };

  const bonus_terms = e.effect === 'BUFF'
    ? [{ name: '普通攻击伤害提高', value: e.lv1 / 100, op: 1 }]
    : [];
  const kernel = {
    cfgId,
    name: e.name,
    skill_class: CLASS_BY_TRIGGER[e.trigger],
    effect_type: e.effect,
    rate_pct_lv1: e.lv1,
    rate_pct_lv10: e.lv10,
    probability_init: p1 / 100,
    probability_max: p10 / 100,
    prepare: e.prepare ?? 0,
    target_type: e.target === 1 ? 'self' : e.target <= 5 ? 'ally' : (e.target === 6 ? 'enemy_single' : 'enemy_all'),
    attack_type: e.attack ?? 'normal',
    control_state: e.control ?? null,
    control_probability: e.control ? (fixed ? 1 : 0.35) : 0,
    bonus_terms,
    detail_id: 900000 + i,
  };

  return {
    cfgId, name: e.name, trigger: e.trigger, dir: TRIGGER_DIR[e.trigger], ui, kernel,
    provenance: {
      descSource: `battle-kit/data/damage_rates.csv 片段 ${e.src}（原文）`,
      nameSource: NAME_SET.has(e.name) ? 'battle-kit/data/skill_names.csv（真实名录）' : '片段内嵌真实战法名',
      rateSource: fixed ? '片段固定值（无 {0} 成长标记）' : '片段内 lv1→lv10 真实成长对',
      pairing: 'reconstructed', // 原始配对数据未随包提供，按语义就近配对
      probability: '原始概率未解包，按 02-技能与效果字典.md §1 占位口径',
    },
  };
});

const table = {
  version: 3,
  generatedBy: 'offline/tools/build-skills.js',
  source: 'battle-kit/data/{damage_rates.csv, skill_names.csv, damage_effect_terms.csv}（原游戏真实数据）',
  sourceSha256: createHash('sha256').update(readFileSync(join(KIT, 'data', 'damage_rates.csv'))).digest('hex'),
  fidelity: {
    descriptionText: 'original',   // 描述为原文
    ratesAndScaling: 'original',   // 伤害率与 lv1→lv10 成长为原文数值
    names: 'original',             // 名称为真实名录
    nameEffectPairing: 'reconstructed', // 原始配对未随包提供
    probability: 'placeholder',    // 原始概率未解包
  },
  levelCount: LEVELS,
  count: skills.length,
  oldSystemRemoved: true,
  skills,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(table, null, 2), 'utf8');

// 自检：字段约束 + 数据真实性
const errors = [];
const seen = new Set();
for (const s of skills) {
  const ui = s.ui;
  if (seen.has(ui.name)) errors.push(`重复战法名 ${ui.name}`);
  seen.add(ui.name);
  if (!(ui.trigger >= 1 && ui.trigger <= 4)) errors.push(`${ui.cfgId} trigger 越界`);
  if (!(ui.target >= 1 && ui.target <= 9)) errors.push(`${ui.cfgId} target 越界`);
  if (ui.levels.length !== LEVELS) errors.push(`${ui.cfgId} levels 数量`);
  if ((ui.des.match(/%n%/g) || []).length !== ui.levels[0].effect_value.length) errors.push(`${ui.cfgId} 占位符与 effect_value 数量不符`);
  for (const ie of ui.include_effect) if (!(ie >= 1 && ie <= 6)) errors.push(`${ui.cfgId} include_effect 越界`);
  const first = ui.levels[0], last = ui.levels.at(-1);
  if (first.probability > last.probability) errors.push(`${ui.cfgId} 概率倒退`);
  if (!s.provenance.rateSource.startsWith('片段固定值') && first.effect_value.some((v, k) => v >= last.effect_value[k])) errors.push(`${ui.cfgId} 效果值不成长`);
  if (!NAME_SET.has(s.name) && !FRAGMENT_NAMES.has(s.name)) errors.push(`${ui.cfgId} 名字不在真实名录`);
}
for (const t of [1, 2, 3, 4]) {
  if (!skills.some((s) => s.trigger === t)) errors.push(`缺少 ${CLASS_BY_TRIGGER[t]} 类战法`);
}
if (errors.length) {
  console.error('[build-skills] 自检失败:', errors.slice(0, 10));
  process.exit(1);
}
console.log(JSON.stringify({
  out: OUT,
  count: skills.length,
  classes: Object.fromEntries([1, 2, 3, 4].map((t) => [CLASS_BY_TRIGGER[t], skills.filter((s) => s.trigger === t).length])),
  sample: {
    name: skills[0].name, des: skills[0].ui.des,
    lv1: skills[0].ui.levels[0].effect_value, lv10: skills[0].ui.levels.at(-1).effect_value,
    provenance: skills[0].provenance,
  },
}, null, 2));
