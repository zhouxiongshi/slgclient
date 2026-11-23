#!/usr/bin/env node
/**
 * 全武将初始战法构建器（确定性；只在开发侧跑，运行时不依赖外部构建库）。
 *
 * 背景：改之前 conf/campaign/hero-skills.json 只有 61 个武将，且都是塞进
 * 910000 系列「演示战法」——赵云/张辽/黄忠共用同一条，其余 360+ 武将
 * skills[0] 恒为 null。客户端图鉴的 skillCfgId 也读同一份表，所以玩家看到的是
 * 「大部分武将没有自带战法，有的一堆人共用一条」。
 *
 * 本脚本做的事：
 *   1) 以 battle-kit/skill-library 的官网 W0 战法表为唯一效果源
 *      （source/raw/stzb_skill_extra.json，648 条；stable 去重 642 条），
 *      用 adapted/full_mapping_stzb.json 的「效果 → 内核字段」映射把每条战法
 *      翻译成游戏内核真正能结算的 6 类 effect（伤害/谋略/治疗/控制/增益/减益）。
 *   2) 按「效果签名」去重，挑出一组代表战法：覆盖主动/指挥/被动/追击 ×
 *      物理/谋略/治疗/控制/增益 × 单体/群体/全体，数量设上限，避免客户端
 *      一次性加载几百个 JsonAsset 拖慢首屏（PF-01c 800ms 预算）。
 *   3) 给游戏里**每一个**武将（general.json + heroes-240.json + 主角）指定一条
 *      初始战法：官网表里有「拆解/传承出处」关联的优先按该关联的效果签名走；
 *      没有关联的按五维定位（武力/谋略/防御/速度）派生，派生项在审计表里
 *      显式标 evidence=derived，绝不冒充「该武将的自带战法」。
 *   4) 输出三份文件（都落在 conf/，运行时只读这里）：
 *        conf/innate-skills.json            新增战法定义（ui + kernel + provenance）
 *        conf/campaign/hero-skills.json    全量「武将名 → 战法 cfgId」
 *        conf/campaign/innate-skill-audit.json  逐人对照与证据等级
 *
 * 版权口径（见 battle-kit/skill-library/docs/05）：
 *   战法名沿用官网公开名录（项目 conf/campaign/skill-source.json 已存 796 个原名），
 *   但**描述文案全部按本游戏现有的模板重写**，不复制官网 desc 原文；
 *   数值是内核 20 档位钳位后的工程近似值，不是官网原文数值。
 *   每份输出都带 license 字段，标明「仅本地学习/内部对照，对外发布须换皮」。
 *
 * 用法：node tools/build-innate-skills.mjs [--dry]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = resolve(ROOT, '..', '..', '..', 'battle-kit', 'skill-library');
const DRY = process.argv.includes('--dry');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
/* 新战法名不能和包内现有 81 条撞名：客户端技能详情按名字展示，
   两条「击势」会让玩家分不清自己带的是哪一条。 */
const EXISTING_NAMES = new Set();
/* 同名已有战法的 cfgId：原版 skills.json 里本就有「中宫追玺」「侵掠如火」这类
   同名战法，覆盖表命中时直接复用，绝不新建第二条同名战法。 */
const EXISTING_CFG = new Map();
for (const f of ['conf/skills.json', 'conf/library-skills.json', 'conf/library-skills-extra.json']) {
  try {
    for (const s of readJson(join(ROOT, f)).skills || []) {
      EXISTING_NAMES.add(s.name);
      if (!EXISTING_CFG.has(s.name)) EXISTING_CFG.set(s.name, Number(s.cfgId));
    }
  } catch { /* 可选文件 */ }
}
try {
  const pg = readJson(join(ROOT, 'conf', 'campaign', 'protagonist-skill.json'));
  EXISTING_NAMES.add(pg.name);
  if (!EXISTING_CFG.has(pg.name)) EXISTING_CFG.set(pg.name, Number(pg.cfgId));
} catch { /* 可选文件 */ }
/* ★ P47#7：第三方原始快照不随包发行（未授权），干净 clone 无法重生成。
   这里给出明确的一次性导入说明，而不是抛一个 ENOENT 让人误以为仓库坏了。
   证据链：conf/innate-skills.json 顶部 source/sourceSha256 + provenance.json 同条登记。 */
const SOURCE_FILES = {
  official: join(KIT, 'source', 'raw', 'stzb_skill_extra.json'),
  mapping: join(KIT, 'adapted', 'full_mapping_stzb.json'),
};
for (const [name, file] of Object.entries(SOURCE_FILES)) {
  if (!existsSync(file)) {
    console.error(`[build-innate-skills] 缺少${name}原始快照：${file}`);
    console.error('本工具是一次性导入（第三方未授权素材不随包发行）。'
      + '现有 conf/innate-skills.json 为唯一权威产物，逐条 provenance/sourceSha256 已固化；'
      + '需要重生成时请在有授权快照的开发机上执行，不要修改产物冒充可复现。');
    process.exit(2);
  }
}
const officialRaw = readJson(SOURCE_FILES.official);
const mapping = readJson(SOURCE_FILES.mapping);
const generalDoc = readJson(join(ROOT, 'conf', 'json', 'general', 'general.json'));
const heroesDoc = readJson(join(ROOT, 'conf', 'campaign', 'heroes-240.json'));
const protagonist = readJson(join(ROOT, 'conf', 'campaign', 'protagonist.json'));

const LICENSE = '参考用：战法名来自率土之滨官网公开名录，描述与数值为本游戏重写/内核档位近似；仅本地学习与内部对照，对外发布须换皮';
const MAX_SKILLS = 96;                 // 新增战法上限：客户端 loadDir 会为每个战法拉一个 JsonAsset
const CFG_BASE = 920000;               // 与现有 10001/19001/910000 三段不冲突
const QUALITY = { S: 5, A: 4, B: 3, C: 2, D: 1 };
const TRIGGER = { 主动: 1, 被动: 2, 追击: 3, 指挥: 4 };
const DIR = { 主动: 'zhudong', 被动: 'beidong', 追击: 'zhuiji', 指挥: 'zhihui' };
const CLASS_NAME = { 1: '主动', 2: '被动', 3: '追击', 4: '指挥' };
const TARGET = {
  自己: 1, 我军单体: 2, '我军1-2个目标': 3, '我军1-3个目标': 4, 我军全体: 5,
  敌军单体: 6, '敌军1-2个目标': 7, '敌军1-3个目标': 8, 敌军全体: 9,
};
const TARGET_TEXT = {
  1: '自身', 2: '我军单体', 3: '我军群体', 4: '我军群体', 5: '我军全体',
  6: '敌军单体', 7: '敌军群体', 8: '敌军群体', 9: '敌军全体',
};
/* 内核 target_type 是逐槽的：一条战法可以第一槽打敌军、第二槽给自身加 buff。
   描述必须按槽取目标，否则会出现「使敌军全体攻击属性提高」这种反义文案。 */
const KTARGET_TEXT = {
  self: '自身', self_and_ally_single: '自身与友军', ally_single: '我军单体',
  ally_group: '我军群体', ally_all: '我军全体', enemy_single: '敌军单体',
  enemy_group: '敌军群体', enemy_all: '敌军全体',
};
const ktText = (t) => KTARGET_TEXT[String(t || '')] || '敌军单体';
const ARMS_OF = { 步: [1, 4, 7], 弓: [2, 5, 8], 骑: [3, 6, 9] };
const ALL_ARMS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/* 官网武将名 → 本游戏武将名（包内名录用字不同，不是编造，是同一人的异写） */
const ALIAS = {
  十常侍: '十常士', 关妹: '关银屏', 鬼吕: '吕布', 汉吕布: '吕布',
  大营: '', 群吕姬: '吕玲绮', 蜀关羽: '关羽', 魏许褚: '许褚', 魏典韦: '典韦',
  魏曹仁: '曹仁', 魏夏侯渊: '夏侯渊', 魏程昱: '程昱', 魏荀攸: '荀攸',
};

const sha = (x) => createHash('sha256').update(x).digest('hex').slice(0, 16);
const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const uniq = (a) => [...new Set(a.filter(Boolean))];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 官网 disassembleHero 形如「【魏·庞德·骑】」→ 庞德 */
function heroOf(cell) {
  if (!cell) return '';
  const m = String(cell).match(/【([^】]+)】/);
  if (!m) return '';
  const parts = m[1].split('·');
  const name = (parts.length >= 2 ? parts[1] : parts[0]).trim();
  return ALIAS[name] ?? name;
}
function armsOf(cell) {
  const s = String(cell || '');
  const out = [];
  for (const [k, v] of Object.entries(ARMS_OF)) if (s.includes(k)) out.push(...v);
  return uniq(out).sort((a, b) => a - b);
}
function targetOf(cell) {
  const s = String(cell || '').trim();
  if (TARGET[s]) return TARGET[s];
  if (/自己|自身/.test(s)) return 1;
  if (/敌军全体/.test(s)) return 9;
  if (/敌军群体|敌军1-3|敌军1-2/.test(s)) return 8;
  if (/敌军/.test(s)) return 6;
  if (/我军全体|友军全体/.test(s)) return 5;
  if (/我军群体|我军1-3|我军1-2|友军群体/.test(s)) return 4;
  if (/友军|我军/.test(s)) return 2;
  return 6;
}
function limitOf(t) {
  if (t === 1 || t === 2 || t === 6) return 1;
  if (t === 3 || t === 7) return 2;
  return 3;
}

/* ---------------------------------------------------------------- 1. 源表索引 */
const officialById = new Map();
for (const row of officialRaw) {
  const id = Number(row.id);
  if (!Number.isFinite(id) || officialById.has(id)) continue;  // 官网 6 条重复 id，稳定取首条
  officialById.set(id, row);
}
const mappedById = new Map(mapping.map((x) => [Number(x.skill_id) - 1120000 + 200000, x]));
const KTARGET = {
  1: 'self', 2: 'ally_single', 3: 'ally_group', 4: 'ally_group', 5: 'ally_all',
  6: 'enemy_single', 7: 'enemy_group', 8: 'enemy_group', 9: 'enemy_all',
};
/* 反查：ui.target 是客户端详情面板显示的目标类型，必须跟主结算槽一致。
   官网 targetType 有「自己 」却带伤害描述的情况（反击/反计类），直接用它会
   出现「目标：自己」配「对敌军单体造成兵刃伤害」的自相矛盾。 */
const KTARGET_REV = {
  self: 1, self_and_ally_single: 2, ally_single: 2, ally_group: 4, ally_all: 5,
  enemy_single: 6, enemy_group: 8, enemy_all: 9,
};
const CONTROL_WORDS = ['混乱', '暴走', '犹豫', '怯战', '动摇', '恐慌', '燃烧', '妖术', '挑衅', '围困'];
const cleanTag = (s) => String(s || '').replace(/[（(][^）)]*[）)]/g, '').trim();
const pickNum = (text, re) => { const m = String(text || '').match(re); return m ? Number(m[1]) : 0; };

/**
 * 官网战法 → 本游戏可结算的效果槽。
 *
 * 为什么不直接用 adapted/full_mapping_stzb.json 的 effects：
 *   资料库 docs/04 第 5 条明确写「自动映射是近似，不是数值还原，条件/DOT/冲突
 *   规则均无法机械还原」。实测照搬会把「步步为营（自身减伤）」翻成「对敌军
 *   造成兵刃伤害」、把「急救」写成「使敌军急救提高」——名字与效果相反、文案
 *   出现病句。所以效果骨架改从官网自己的 `effect` 标签 + `desc(level1)` 句式取，
 *   这两项是 W0 一手数据；full_mapping 只留作来源指纹与对照。
 *
 * 只生成内核真正结算的 6 类效果；洞察/规避/援护/分兵等状态词内核无对应通道，
 * 一律不生成槽（仍写进「特性」供玩家阅读），避免战报里出现永远不生效的技能。
 * 数值取 desc(level1) 为游戏 Lv1，官网满级恰为 2 倍 → 游戏 Lv10 = 2×Lv1。
 */
function slotsOf(row) {
  const tags = uniq(String(row.effect || '').split(';')).map(cleanTag).filter(Boolean);
  const d1 = String(row['desc(level1)'] || '');
  const t = targetOf(row.targetType);
  const enemyT = t >= 6 ? t : 6;
  const allyT = t >= 1 && t <= 5 ? t : 5;
  const out = [];
  const push = (o) => { if (out.length < 2) out.push(o); };
  const slot = (o) => ({
    attack_type: 'normal', control_state: null, bonus_terms: [],
    include: ['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE', 'HEAL'].includes(o.effect_type) ? 1 : 2,
    ...o,
  });

  /* ① 主槽：伤害 / 治疗，按描述里的「伤害率 / 恢复率」取 Lv1 值 */
  const dmg = pickNum(d1, /伤害率\s*([\d.]+)\s*%/);
  const heal = pickNum(d1, /恢复率\s*([\d.]+)\s*%/);
  /* 伤害类型只看「伤害率」之前那一段动词短语。
     早先全文匹配 /策略攻击/ 会把银龙冲阵判成谋略——原文是「发动2次攻击（伤害率75%），
     并使…受到攻击和策略攻击时的伤害提高」，那个「策略攻击」是易伤修饰，不是伤害类型。
     定军扬威、赵云、黄忠全被这条误判成法师。 */
  const dmgAt = d1.search(/伤害率\s*[\d.]+/);
  const verbPhrase = dmgAt > 0 ? d1.slice(Math.max(0, dmgAt - 40), dmgAt) : d1.slice(0, 60);
  const strat = /策略攻击|谋略攻击|谋略伤害/.test(verbPhrase) && dmg > 0;
  if (dmg > 0 && !(/恢复率/.test(d1) && !/造成|发动|攻击/.test(d1))) {
    push(slot({
      effect_type: strat ? 'STRATEGY_DAMAGE' : 'PHYSICAL_DAMAGE',
      v10: r2(dmg * 2), target_type: KTARGET[enemyT],
      label: strat ? '对%s造成谋略伤害（伤害率%n%%）' : '对%s造成兵刃伤害（伤害率%n%%）',
    }));
  } else if (heal > 0) {
    push(slot({ effect_type: 'HEAL', v10: r2(heal * 2), target_type: KTARGET[allyT], label: '为%s恢复兵力（恢复率%n%%）' }));
  }

  /* ② 附加槽：控制 → 敌方；增益 → 我方；敌方属性削弱 → 敌方 */
  const ctrl = tags.find((x) => CONTROL_WORDS.includes(x));
  /* 「受到…提高」是给敌方上的易伤，不是给我军的增益；「处于…状态…」是条件
     触发，内核无对应通道。两类都排除，否则会写出「使我军全体受到策略攻击
     伤害提高」「使敌军单体处于怯战状态受伤害降低」这种方向反了/读不通的文案。 */
  const up = tags.find((x) => /提高$/.test(x) && !/受到|处于/.test(x));
  const reduceTaken = tags.find((x) => /^受到.+降低$/.test(x) && !/处于/.test(x));
  const down = tags.find((x) => /降低$/.test(x) && !/^受到/.test(x) && !/处于/.test(x));
  const pctUp = pickNum(d1, /提高\s*([\d.]+)\s*%?/) || pickNum(d1, /下降\s*([\d.]+)\s*%/) || 20;
  const pctDown = pickNum(d1, /降低\s*([\d.]+)\s*%?/) || pctUp;
  const ctrlP = pickNum(d1, /([\d.]+)\s*%\s*的?几率/) || 40;

  if (ctrl) {
    push(slot({
      effect_type: 'CONTROL', v10: r2(ctrlP * 2), target_type: KTARGET[enemyT],
      control_state: ctrl, label: `使%s陷入${ctrl}（几率%n%%）`,
      bonus_terms: [{ name: ctrl, value: r2(ctrlP), op: 0 }],
    }));
  } else if (reduceTaken) {
    push(slot({
      effect_type: 'BUFF', v10: r2(pctUp * 2), target_type: KTARGET[allyT],
      label: '使%s受到的伤害降低（%n%%）',
      bonus_terms: [{ name: reduceTaken, value: r2(pctUp), op: 0 }],
    }));
  } else if (down && out.length === 0) {
    push(slot({
      effect_type: 'DEBUFF', v10: r2(pctDown * 2), target_type: KTARGET[enemyT],
      label: `使%s${down.replace(/降低$/, '')}降低（%n%%）`,
      bonus_terms: [{ name: down, value: r2(pctDown), op: 0 }],
    }));
  } else if (up) {
    push(slot({
      effect_type: 'BUFF', v10: r2(pctUp * 2), target_type: KTARGET[allyT],
      label: `使%s${up.replace(/提高$/, '')}提高（%n%%）`,
      bonus_terms: [{ name: up, value: r2(pctUp), op: 0 }],
    }));
  }
  return out;
}

/** 效果签名：触发 × 结算槽组合 × 目标大类。
 *  不把原始 effect 标签拼进签名——95 种标签会炸出 482 组，代表战法只能覆盖
 *  其中 96 组，反而漏掉主要效果类型。槽组合才是玩家能感知的「效果」。 */
function signatureOf(row, slots) {
  const kinds = slots.map((s) => s.effect_type).join('+');
  const t = targetOf(row.targetType);
  const band = t === 1 || t === 2 || t === 6 ? 'single' : (t === 5 || t === 9 ? 'all' : 'group');
  /* 只按「类型+目标范围」分组时，所有「属性提高」类会挤成一格（BUFF 只剩 4 组），
     424 位武将只能分摊到 40 条战法。把具体的属性名/控制状态并进签名，
     既保留「同效果去重」的本意，又让不同属性的增益各自成组。 */
  const detail = slots
    .map((s) => s.bonus_terms?.[0]?.name || s.control_state || '')
    .filter(Boolean).join(',');
  return `${row.type}|${kinds}|${band}|${detail}`;
}

const allSkills = [];
for (const [id, row] of officialById) {
  const slots = slotsOf(row);
  if (!slots.length) continue;
  const links = uniq([1, 2, 3].map((i) => heroOf(row[`disassembleHero${i}`])));
  allSkills.push({ id, row, slots, links, quality: QUALITY[String(row.zfQuality || 'D').toUpperCase()] || 1, sig: signatureOf(row, slots) });
}

/* ------------------------------------------- 1.5 已核实的「武将→自带战法」覆盖表 */
/* 为什么需要这张表：W0 官方战法表只有 disassembleHero（拆解出处），没有「某武将的
   自带战法」字段。只靠效果签名近似匹配，会把「苦肉计」发给 14 个不相干的人、把
   「奋疾先登」判给赵云 —— 名实不符比没有战法更伤体验。
   所以：有公开来源可核对的武将，锁定其本人专属战法；其余武将一律用「可拆解的
   通用战法」（谁都能学，不存在冒名），绝不把他人的专属战法名分给别人。 */
const OV_PATH = join(ROOT, 'conf', 'campaign', 'innate-skill-overrides.json');
const OV = existsSync(OV_PATH) ? readJson(OV_PATH) : { heroes: {} };
const bySkillName = new Map();
for (const s of allSkills) if (!bySkillName.has(s.row.name)) bySkillName.set(s.row.name, s);
/* 专属战法判据：无拆解出处（dismantling 空）且 disassembleHero 全空 —— 即「不可
   拆解获得」，就是武将自带。 */
const isOwnSkill = (s) => !s.links.length && !String(s.row.dismantling || '').trim();
const overrideOf = new Map();
const ovProblems = [];
for (const [hero, spec] of Object.entries(OV.heroes || {})) {
  const src = bySkillName.get(spec.skill);
  if (!src) { ovProblems.push(`${hero}: 战法「${spec.skill}」不在 W0 官方战法表`); continue; }
  if (!isOwnSkill(src)) ovProblems.push(`${hero}: 「${spec.skill}」有拆解出处，不是自带战法`);
  /* 包内已有同名战法（原版就收录了「中宫追玺」「侵掠如火」这类）→ 复用其 cfgId，
     不新建第二条同名战法，否则客户端技能列表会出现两个一样的名字。 */
  overrideOf.set(hero, { src, reuse: EXISTING_CFG.get(spec.skill) || null });
}

/* ------------------------------------------------- 2. 选代表战法（效果去重 + 限量） */
const groups = new Map();
for (const s of allSkills) {
  if (!groups.has(s.sig)) groups.set(s.sig, []);
  groups.get(s.sig).push(s);
}
const ranked = [...groups.entries()].map(([sig, list]) => {
  list.sort((a, b) => (b.quality - a.quality) || (b.links.length - a.links.length) || (a.id - b.id));
  const best = list.find((x) => !EXISTING_NAMES.has(x.row.name)) || list[0];
  return { sig, best, size: list.length };
}).sort((a, b) => (b.size - a.size) || (b.best.quality - a.best.quality) || (a.best.id - b.best.id));

/* 通用池：只收「可拆解的通用战法」。真人专属战法不进来，避免被派给不相干的人。 */
const genericRanked = ranked.filter((g) => !isOwnSkill(g.best));
/* 分层抽样：先保证 6 类主效果各有代表，再按组大小补满上限。
   只按组大小取会让 BUFF 类（498 个 effect）吃掉全部名额，派生出来的
   武将清一色加属性，等于没做。 */
const byMainSig = new Map();
for (const g of genericRanked) {
  const k = g.best.slots[0]?.effect_type || 'BUFF';
  if (!byMainSig.has(k)) byMainSig.set(k, []);
  byMainSig.get(k).push(g);
}
const mainKinds = [...byMainSig.keys()].sort();
const perKind = Math.max(4, Math.floor(MAX_SKILLS / mainKinds.length));
const chosen = [];
const usedSig = new Set();
const chosenIds = new Set();
const CHOSEN_CAP = MAX_SKILLS + overrideOf.size;
/* 不作为「初始战法」候选的战法名：贬义/投降/幼弱指向，或语义强烈绑定某一特定人物。
   这些战法仍在包内（玩家可以学到），只是不会被配到不相干武将的初始槽上——
   把「望风而降」塞给司马懿、「未笄难言」塞给任何一位名将，都是明显的名实不符。 */
const NAME_UNSUITABLE = new Set([
  '望风而降', '僭号天子', '僭越', '伪帝', '伪刺', '愚勇', '莽撞', '二夫之勇',
  '勇而无算', '统军畏慎', '迟智难酬', '疮痍累身', '缚父临危', '未笄难言',
  '猜忌', '妒后', '众叛亲离', '据凉通叛', '叛羌急袭', '羌帅衅敌', '疲兵沮意',
]);
/* 入选一条通用代表：撞名（包内已有同名战法）一律跳过——客户端按名字展示，
   两条「乱阵」会让玩家分不清；宁可这一组没有代表，也不制造重名。 */
const pushGeneric = (src) => {
  if (chosen.length >= CHOSEN_CAP) return false;
  if (chosenIds.has(src.id)) return false;
  if (EXISTING_NAMES.has(src.row.name)) return false;
  if (NAME_UNSUITABLE.has(src.row.name)) return false;
  if (usedSig.has(src.sig)) return false;
  chosen.push(src); chosenIds.add(src.id); usedSig.add(src.sig);
  return true;
};
/* ① 已核实的专属战法先占位：它们名字各自唯一，即使效果签名相同也要各留一条 */
for (const o of overrideOf.values()) {
  if (o.reuse) continue;                 // 复用包内已有战法，不新建
  if (chosenIds.has(o.src.id)) continue;
  chosen.push(o.src); chosenIds.add(o.src.id); usedSig.add(o.src.sig);
}
/* ② 通用战法按分层抽样补满：每类先保证有代表，再按组大小补 */
for (const k of mainKinds) {
  for (const g of byMainSig.get(k).slice(0, perKind)) pushGeneric(g.best);
}
for (const g of genericRanked) pushGeneric(g.best);
/* 代表战法 → 同签名源战法 id 全集（同签名的都算「本效果参考过」） */
const repSources = new Map(chosen.map((s) => [s.id, groups.get(s.sig).map((x) => x.id)]));

/* ---------------------------------------------------------- 3. 组装游戏战法定义 */
function makeSkill(src, idx) {
  const { id, row, slots } = src;
  const cfgId = CFG_BASE + idx;
  const trigger = TRIGGER[row.type] || 1;
  /* 目标以主结算槽为准，不用官网 targetType 原值（见 KTARGET_REV 注释） */
  const target = KTARGET_REV[slots[0]?.target_type] || targetOf(row.targetType);
  const limit = limitOf(target);
  const arms = armsOf(row.soldierType);
  const probRaw = String(row.probability || '').match(/([\d.]+)\s*%/);
  let prob = probRaw ? Number(probRaw[1]) : (trigger === 1 || trigger === 3 ? 35 : 100);
  prob = Math.max(5, Math.min(100, prob));
  const distance = Math.max(1, Math.min(5, Number(row.distance) || 4));

  const desParts = slots.map((s) => s.label.replace('%s', ktText(s.target_type)));
  const tags = uniq(String(row.effect || '').split(';')).map(cleanTag).filter(Boolean).slice(0, 4);
  const offensive = ['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE', 'CONTROL', 'DEBUFF'].includes(slots[0]?.effect_type);
  const rangeNote = trigger === 3 ? '目标：普攻目标'
    : (offensive ? `有效距离 ${distance} · ${limit === 1 ? '单体' : limit + ' 人'}` : '无距离限制');
  const des = desParts.join('，') + `。特性：${tags.join('、') || CLASS_NAME[trigger]}。${rangeNote}`;

  const levels = Array.from({ length: 10 }, (_, i) => ({
    probability: prob,
    /* 官网 desc(level1) 与 desc 恰为 1:2，本游戏 10 级线性：v(lv)=v1*(1+(lv-1)/9) */
    effect_value: slots.map((s) => r2(s.v10 / 2 * (1 + i / 9))),
    effect_round: slots.map(() => 0),
  }));

  const ui = {
    cfgId, name: row.name, des, trigger, target, limit,
    arms: arms.length ? arms : ALL_ARMS,
    include_effect: slots.map((s) => s.include),
    levels,
    range: trigger === 3 || !offensive ? 9 : distance,
    rangeNote,
  };
  const kernel = {
    cfgId, name: row.name, skill_class: row.type,
    prepare: /准备/.test(String(row.desc || '')) ? 1 : 0,
    probability_init: prob / 100, probability_max: prob / 100,
    detail_id: cfgId * 10 + 1,
    effects: slots.map((s, i) => ({
      detail_id: cfgId * 10 + i + 1,
      effect_type: s.effect_type,
      rate_pct: r2(s.v10 / 2),
      target_type: s.target_type,
      attack_type: s.attack_type,
      available_round: 0,
      control_state: s.control_state,
      control_probability: 0,
      /* ★ P49：历史折半（b.value / 2）废止——bonus 词条值恢复为描述值，
         34 条 920 系共 68 项差异归零；旧口径见 SDD §17.33。 */
      bonus_terms: s.bonus_terms.map((b) => ({ ...b, value: r2(b.value) })),
    })),
  };
  return {
    cfgId, name: row.name, trigger, dir: DIR[row.type] || 'zhudong', ui, kernel,
    isOwn: isOwnSkill(src),
    provenance: {
      pairing: 'stzb-w0', source: 'battle-kit/skill-library/source/raw/stzb_skill_extra.json',
      sourceId: id, sourceName: row.name, quality: row.zfQuality,
      effectTags: tags, signature: src.sig,
      referenceIds: repSources.get(id) || [id],
      rateSource: 'adapted/full_mapping_stzb.json（20 档位钳位近似，非官网原文数值）',
      license: LICENSE, evidence_level: 'W0',
    },
  };
}
const skills = chosen.map(makeSkill);
const bySig = new Map(chosen.map((s, i) => [s.sig, skills[i]]));
const idToSkill = new Map(chosen.map((s, i) => [s.id, skills[i]]));

/* ------------------------------------------------------------- 4. 全量武将名单 */
/* 五维统一折算到 0~100：general.json 是 0~10000，heroes-240 是 0~100，
   不归一化会把两张表混着比，定位必然判错。 */
const fiveSum = (v) => (v.force || 0) + (v.strategy || 0) + (v.defense || 0) + (v.speed || 0);
function roleOf(v) {
  const { force = 0, strategy = 0, defense = 0, speed = 0 } = v;
  /* 相等时优先判输出：吕布 100010 的 force 与 defense 都是 10000，
     早先写成 defense>=force 会把他判成纯辅助。 */
  if (strategy > force && strategy > defense && strategy > speed) return 'STRATEGY_DAMAGE';
  if (force >= defense && force >= speed) return 'PHYSICAL_DAMAGE';
  if (defense > speed) return 'BUFF';
  return 'CONTROL';
}
const heroes = new Map();   // name → { cfgIds, role, star, sources }
const addHero = (name, cfgId, five, star, source) => {
  let cur = heroes.get(name);
  if (!cur) { cur = { cfgIds: [], entries: [], sources: [] }; heroes.set(name, cur); }
  if (!cur.cfgIds.includes(cfgId)) cur.cfgIds.push(cfgId);
  if (!cur.sources.includes(source)) cur.sources.push(source);
  cur.entries.push({ five, star });
};
for (const g of generalDoc.list || []) {
  addHero(g.name, g.cfgId, {
    force: (Number(g.force) || 0) / 100, strategy: (Number(g.strategy) || 0) / 100,
    defense: (Number(g.defense) || 0) / 100, speed: (Number(g.speed) || 0) / 100,
  }, Number(g.star) || 3, 'general.json');
}
for (const h of heroesDoc.heroes || []) {
  const f = h.five || {};
  addHero(h.name, Number(h.id), {
    force: Number(f.wu) || 0, strategy: Number(f.zhi) || 0,
    defense: Number(f.tong) || 0, speed: (Number(f.zheng) || 0) * 0.8,
  }, h.layer === 'core' ? 5 : (h.layer === 'important' ? 4 : 3), 'heroes-240.json');
}
for (const cur of heroes.values()) {
  /* 同名多版本（4星/5星）取星级最高、同星取五维和最高的一条。
     早先按「首次遇到的条目」定位，吕布被一条低星条目判成辅助，派生全错。 */
  const best = cur.entries.slice().sort((a, b) => (b.star - a.star) || (fiveSum(b.five) - fiveSum(a.five)))[0];
  cur.role = roleOf(best.five);
  cur.star = best.star;
  /* 保留五维：增益型武将（防御主导）里还分「猛将」与「军师」，
     给许褚（统 45/武 99）配「谋略属性提高」是明显的名实不符。 */
  cur.attrs = best.five;
  delete cur.entries;
}
const heroNames = [...heroes.keys()].sort();

/* 官网「拆解/传承出处」→ 本游戏武将（W0 可验证关联，不是自带战法，审计里写清） */
const linkByName = new Map();
for (const s of allSkills) for (const n of s.links) {
  if (!heroes.has(n)) continue;
  if (!linkByName.has(n)) linkByName.set(n, []);
  linkByName.get(n).push(s);
}
for (const [, list] of linkByName) list.sort((a, b) => (b.quality - a.quality) || (a.id - b.id));

/* 按主效果类型索引「通用」战法，供派生选择。真人专属战法不进这个索引——
   它们只会由 overrideOf 精确点给本人，否则就会重演「苦肉计发给 14 个人」。 */
const byMain = new Map();
for (const s of skills) {
  if (s.isOwn) continue;
  const k = s.kernel.effects[0]?.effect_type || 'BUFF';
  if (!byMain.has(k)) byMain.set(k, []);
  byMain.get(k).push(s);
}
const fallbackPool = skills.filter((s) => !s.isOwn);
const dedupeSkills = (list) => {
  const seen = new Set();
  return list.filter((s) => (seen.has(s.cfgId) ? false : (seen.add(s.cfgId), true)));
};
/* 最少使用优先：424 位武将铺到 83 条代表上，避免一堆名将共用一条被动。 */
const useCount = new Map();
function pickFrom(pool, name) {
  const safe = pool && pool.length ? pool : fallbackPool;
  const min = Math.min(...safe.map((s) => useCount.get(s.cfgId) || 0));
  const cands = safe.filter((s) => (useCount.get(s.cfgId) || 0) === min);
  const s = cands[hash32(name) % cands.length];
  useCount.set(s.cfgId, (useCount.get(s.cfgId) || 0) + 1);
  return s;
}

/* 每人一条：效果类型由五维定位决定，官网 W0 关联只作「优先候选 + 溯源」。
   早先直接按「拆解出处」选，结果赵云/吕布/诸葛亮/夏侯惇全被带到同一条
   「使自身攻击伤害提高」上——拆解战法多是被动，不是武将的输出定位。 */
const heroSkills = {};
const audit = [];
const skillBySourceId = new Map(skills.map((s) => [s.provenance.sourceId, s]));
for (const name of heroNames) {
  const meta = heroes.get(name);

  /* ① 已核实的本人专属战法（自带战法），证据 = W0 表 + 官网出处 */
  const ov = overrideOf.get(name);
  if (ov) {
    if (ov.reuse) {
      /* 包内已有同名战法，直接复用 */
      heroSkills[name] = ov.reuse;
      audit.push({
        name, cfgIds: meta.cfgIds, role: meta.role, star: meta.star,
        innateCfgId: ov.reuse, innateName: ov.src.row.name,
        match: 'stzb-innate-reuse', evidence: 'W0+A2',
        sourceIds: [ov.src.id], sourceName: ov.src.row.name,
        note: `自带战法；包内已有同名战法 cfgId ${ov.reuse}，直接复用不新建。来源：${OV.heroes[name].source}`,
      });
      continue;
    }
    const skill = skillBySourceId.get(ov.src.id);
    heroSkills[name] = skill.cfgId;
    audit.push({
      name, cfgIds: meta.cfgIds, role: meta.role, star: meta.star,
      innateCfgId: skill.cfgId, innateName: skill.name,
      match: 'stzb-innate', evidence: 'W0+A2',
      sourceIds: [ov.src.id], sourceName: skill.name,
      note: `自带战法（W0 表中不可拆解），对应来源：${OV.heroes[name].source}`,
    });
    continue;
  }

  /* ② 其余武将：从「通用战法」池按五维定位匹配。通用战法人人可学，不存在冒名，
     但也不谎称是本人自带战法——audit 与 UI 都按「通用」表述。 */
  const linked = linkByName.get(name) || [];
  const attrs = meta.attrs || {};
  /* 增益型（防御主导）内部再分两族：
     · 猛将（武力 ≥ 谋略）：只配攻/防/减伤/援护类增益；
     · 军师（谋略 > 武力）：才配谋略类增益。
     不细分的话，许褚（统 45/武 99）会拿到「运筹帷幄（谋略属性提高）」。 */
  const mindHero = (Number(attrs.strategy) || 0) > (Number(attrs.force) || 0);
  const buffPoolAll = dedupeSkills([
    ...(byMain.get('BUFF') || []), ...(byMain.get('HEAL') || []), ...(byMain.get('DEBUFF') || []),
  ]).filter((s) => {
    const bn = s.kernel.effects?.[0]?.bonus_terms?.[0]?.name || '';
    return /谋略/.test(bn) ? mindHero : true;
  });
  const rolePool = meta.role === 'BUFF' ? buffPoolAll : (byMain.get(meta.role) || fallbackPool);
  const w0Reps = [];
  for (const src of linked.slice(0, 8)) {
    const rep = bySig.get(src.sig);
    /* 只认通用战法的代表：专属战法不参与派发 */
    if (rep && !rep.isOwn && rep.kernel.effects[0]?.effect_type === meta.role) w0Reps.push({ rep, src });
  }
  const pool = dedupeSkills([...w0Reps.map((x) => x.rep), ...rolePool]);
  const skill = pickFrom(pool, name);
  const hit = w0Reps.find((x) => x.rep.cfgId === skill.cfgId);
  const match = hit ? 'w0-source' : (linked.length ? 'w0-linked-role' : 'derived-by-role');
  const evidence = hit ? 'W0' : (linked.length ? 'W0/按定位' : 'A2/派生');
  const sourceIds = hit ? [hit.src.id] : skill.provenance.referenceIds.slice(0, 3);
  const sourceName = hit ? hit.src.row.name : (linked[0]?.row.name || skill.name);
  heroSkills[name] = skill.cfgId;
  audit.push({
    name, cfgIds: meta.cfgIds, role: meta.role, star: meta.star,
    innateCfgId: skill.cfgId, innateName: skill.name,
    match, evidence, sourceIds, sourceName,
    note: match === 'derived-by-role'
      ? '官网表无该武将的战法出处，按五维定位匹配「通用战法」；不是该武将的自带战法'
      : (hit ? '该武将在官网战法表有拆解/传承出处，选取的是可拆解的通用战法，效果类型与五维定位一致'
        : '该武将官网有战法出处，但效果范式与定位不符，按定位选同族通用战法'),
  });
}
/* 主角：原创指挥战法「坐镇中军」，是平行工作产物，保留不覆盖 */
heroSkills[protagonist.general.name] = 19001;
audit.push({
  name: protagonist.general.name, cfgIds: [protagonist.general.cfgId], role: 'BUFF', star: 4,
  innateCfgId: 19001, innateName: '坐镇中军', match: 'authored-protagonist', evidence: 'A2/原创',
  sourceIds: [], sourceName: 'M4-7 原创，不属官网名录',
  note: '主角是穿越者原创角色，createSkillAssets 与 world.js 都硬编码 19001，保持同源',
});

/* ------------------------------------------------------------------- 4b. 自检 */
/* 不自检就落盘，等于把「描述占位符与结算槽对不上」这种错误直接发给玩家：
   UI 会印出 %n%，内核却按槽数取值。以下任何一条不过就拒绝生成。 */
const existingIds = new Set();
for (const f of ['conf/skills.json', 'conf/library-skills.json', 'conf/library-skills-extra.json']) {
  try { for (const s of readJson(join(ROOT, f)).skills || []) existingIds.add(Number(s.cfgId)); } catch { /* 文件不存在不算错 */ }
}
try { existingIds.add(Number(readJson(join(ROOT, 'conf', 'campaign', 'protagonist-skill.json')).cfgId)); } catch { /* 无 */ }
const problems = [];
const newIds = new Set();
const newNames = new Set();
for (const s of skills) {
  if (existingIds.has(Number(s.cfgId)) || newIds.has(Number(s.cfgId))) problems.push(`cfgId 冲突 ${s.cfgId}`);
  if (EXISTING_NAMES.has(s.name) || newNames.has(s.name)) problems.push(`战法名冲突 ${s.name}`);
  newIds.add(Number(s.cfgId));
  newNames.add(s.name);
  const placeholders = (s.ui.des.match(/%n%/g) || []).length;
  const slots = s.ui.levels[0].effect_value.length;
  if (placeholders !== slots) problems.push(`${s.cfgId} ${s.name}: 描述占位 ${placeholders} != 结算槽 ${slots}`);
  if (s.ui.levels.length !== 10) problems.push(`${s.cfgId} ${s.name}: 等级数 ${s.ui.levels.length} != 10`);
  if (s.kernel.effects.length !== slots) problems.push(`${s.cfgId} ${s.name}: kernel 槽 ${s.kernel.effects.length} != ${slots}`);
  if (Number(KTARGET_REV[s.kernel.effects[0]?.target_type] || 0) !== Number(s.ui.target)) {
    problems.push(`${s.cfgId} ${s.name}: ui.target ${s.ui.target} 与主槽 ${s.kernel.effects[0]?.target_type} 不一致`);
  }
  for (let i = 0; i < slots; i += 1) {
    const l1 = s.ui.levels[0].effect_value[i];
    const l10 = s.ui.levels[9].effect_value[i];
    if (Math.abs(l10 - l1 * 2) > 0.05) problems.push(`${s.cfgId} ${s.name}: 第${i + 1}槽 Lv10 ${l10} != 2×Lv1 ${l1}`);
  }
}
for (const [n, id] of Object.entries(heroSkills)) {
  if (!newIds.has(Number(id)) && !existingIds.has(Number(id))) problems.push(`武将 ${n} 指向不存在的战法 ${id}`);
}

/* ★ 名实一致闸：真人专属战法只许给本人。
   这条是玩家最容易一眼看穿的错误（「苦肉计」发给丁夫人、「奋疾先登」判给赵云），
   靠人工复查管不住 424 位武将，必须机器卡。 */
const ownByCfgId = new Map(skills.filter((s) => s.isOwn).map((s) => [Number(s.cfgId), s.name]));
const ownerOfOwn = new Map();
for (const [hero, o] of overrideOf) ownerOfOwn.set(Number(o.src.id), hero);
const cfgToSource = new Map(skills.map((s) => [Number(s.cfgId), Number(s.provenance.sourceId)]));
for (const [hero, id] of Object.entries(heroSkills)) {
  const ownName = ownByCfgId.get(Number(id));
  if (!ownName) continue;                      // 通用战法，谁都能学，不检
  const owner = ownerOfOwn.get(cfgToSource.get(Number(id)));
  if (owner && owner !== hero) problems.push(`专属战法串号：${hero} 拿到了 ${owner} 的「${ownName}」`);
  if (!owner) problems.push(`专属战法「${ownName}」没有登记归属，却发给了 ${hero}`);
}
for (const p of ovProblems) problems.push(`覆盖表：${p}`);
/* 覆盖表允许收录本作暂时没有的武将（如「十常侍」），只提示不判失败 */
const ovCovered = audit.filter((a) => a.match === 'stzb-innate' || a.match === 'stzb-innate-reuse').length;
if (ovCovered < overrideOf.size) {
  console.log(`  提示：覆盖表 ${overrideOf.size} 条，本局名单命中 ${ovCovered} 条（其余为本作暂未收录的武将）`);
}
if (problems.length) {
  console.error(problems.slice(0, 25).join('\n'));
  throw new Error(`自检失败，共 ${problems.length} 项，未写盘`);
}
const kindDist = {};
for (const s of skills) {
  const k = s.kernel.effects[0]?.effect_type || 'BUFF';
  kindDist[k] = (kindDist[k] || 0) + 1;
}

/* -------------------------------------------------------------------- 5. 落盘 */
const sourceSha = sha(JSON.stringify(officialRaw)) + ':' + sha(JSON.stringify(mapping));
const outSkill = {
  version: 1, generatedBy: 'tools/build-innate-skills.mjs',
  source: 'battle-kit/skill-library (率土之滨官网 W0 战法表 + adapted/full_mapping_stzb.json)',
  sourceSha256: sourceSha, levelCount: 10, count: skills.length,
  license: LICENSE, skills,
};
const outAudit = {
  version: 1, generatedBy: 'tools/build-innate-skills.mjs',
  sourceSha256: sourceSha, license: LICENSE,
  totals: {
    officialSkills: officialById.size,
    translatable: allSkills.length,
    signatures: groups.size,
    representatives: skills.length,
    heroes: audit.length,
    w0Linked: audit.filter((a) => a.match.startsWith('w0')).length,
    derived: audit.filter((a) => a.match === 'derived-by-role').length,
    authored: audit.filter((a) => a.match === 'authored-protagonist').length,
  },
  caveat: '官网战法表只给出「拆解/传承出处」，没有「武将自带战法」逐人对照表；本表匹配的是效果范式，不对史实归属作断言。',
  heroes: audit,
};

if (!DRY) {
  writeFileSync(join(ROOT, 'conf', 'innate-skills.json'), JSON.stringify(outSkill, null, 1) + '\n', 'utf8');
  writeFileSync(join(ROOT, 'conf', 'campaign', 'hero-skills.json'), JSON.stringify(heroSkills, null, 2) + '\n', 'utf8');
  writeFileSync(join(ROOT, 'conf', 'campaign', 'innate-skill-audit.json'), JSON.stringify(outAudit, null, 1) + '\n', 'utf8');
}
console.log(JSON.stringify({
  dry: DRY, sourceSha, ...outAudit.totals, kindDist, selfCheck: 'PASS',
  coverage: `${audit.length}/${heroNames.length + 1}`,
  sample: audit.filter((a) => ['赵云', '吕布', '诸葛亮', '夏侯惇', '黄盖', '主公', '司马懿'].includes(a.name))
    .map((a) => ({ name: a.name, role: a.role, innate: a.innateName, cfg: a.innateCfgId, match: a.match, des: skills.find((s) => s.cfgId === a.innateCfgId)?.ui.des.slice(0, 110) })),
}, null, 1));
