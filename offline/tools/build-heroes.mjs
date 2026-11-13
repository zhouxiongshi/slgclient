/**
 * build-heroes.mjs — M3 武将数据层生成器（GDD §7.1 / §7.5）
 *
 * 从外部资料库 three-kingdoms/characters.csv（936 位、34 列）确定性选 240 位，
 * 分三层（60 核心 / 100 重要 / 80 在野），映射 GDD §7.1 字段表，
 * 输出 conf/campaign/heroes-240.json（入仓，运行期读取）。
 *
 * 选择规则（确定性，可复核）：
 *   核心 60 = 宿命 24 组成员（强制）+ 其余按五维均值降序补足
 *             （种子另含 hero-skills.json 51 位与 OVERRIDES 补充条目）
 *   重要 100 = 排除核心后，按 [类型优先级, -均值] 排序取前 100
 *   在野 80  = 再取 80（含隐逸/后妃等次要类型）
 *
 * 校验（失败即构建失败，退出码 1）：
 *   V1 五维均在 1..100        V2 宿命 24 组成员全部入选
 *   V3 层计数 60/100/80       V4 born<died（双方齐备时）
 *   V5 核心层每人 traits≥1    V6 输出 heroes 数组长度恰 240
 *
 * 用法：node tools/build-heroes.mjs [--src <characters.csv 路径>] [--check]
 *   --check 仅校验已生成的 conf/campaign/heroes-240.json，不重新生成。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'conf/campaign/heroes-240.json');
const DEFAULT_SRC = resolve(ROOT, '../../../three-kingdoms/characters.csv');

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const hasFlag = (name) => args.includes(name);

/* ------------------------------------------------------------------ */
/* 资料库缺项补充条目： characters.csv 无此人，五维取演义/正史共识。       */
/* 每条必须带 source；这是唯一允许手工新增人物的地方。                    */
/* ------------------------------------------------------------------ */
const OVERRIDES = [
  { name: '太史慈', zi: '子义', born: 166, died: 206, faction: '孙吴', era: '讨董群雄', type: '名将',
    five: [82, 91, 66, 50, 78], hometown: '东莱黄',
    traits: ['北海解围', '神亭酣斗'],
    src: 'sgz.wu.4 太史慈传', level: '史实' },
  { name: '黄盖', zi: '公覆', born: null, died: 210, faction: '孙吴', era: '讨董群雄', type: '名将',
    five: [78, 79, 70, 55, 68], hometown: '零陵泉陵',
    traits: ['苦肉计', '赤壁火船'],
    src: 'sgz.wu.10 程黄韩蒋传', level: '史实' },
  { name: '孙尚香', zi: '－', born: null, died: 222, faction: '孙吴', era: '三国鼎立', type: '后妃',
    five: [40, 68, 55, 40, 82], hometown: '吴郡富春',
    traits: ['弓马姝丽', '截江夺斗'],
    src: '汉晋春秋/演义', level: '史实+文学增饰' },
  { name: '甄洛', zi: '－', born: 183, died: 221, faction: '曹魏·司马氏', era: '官渡赤壁', type: '后妃',
    five: [30, 35, 62, 58, 88], hometown: '中山无极',
    traits: ['洛神赋咏', '郭后谗死'],
    src: 'sgz.weishu.5 注/魏书', level: '史实+文学增饰' },
  { name: '祝融', zi: '－', born: null, died: null, faction: '南中·外族', era: '三国鼎立', type: '虚构·将领',
    five: [55, 78, 40, 30, 60], hometown: '南中',
    traits: ['飞刀擒将'],
    src: '演义·第九十回', level: '虚构/传说' },
  { name: '蔡文姬', zi: '昭姬', born: 174, died: 239, faction: '东汉·汉廷', era: '黄巾之乱', type: '名士',
    five: [20, 25, 82, 55, 85], hometown: '陈留圉',
    traits: ['文姬归汉', '默书四百篇'],
    src: '后汉书·列女传', level: '史实' },
  { name: '黄月英', zi: '－', born: null, died: null, faction: '蜀汉', era: '三国鼎立', type: '名士',
    five: [30, 30, 85, 72, 65], hometown: '荆州襄阳',
    traits: ['木牛流马助'],
    src: '襄阳记/演义', level: '虚构/传说' },
];

/* ------------------------------------------------------------------ */
/* 势力归类 → 相性锚点（conf/relations.json xiangxing.anchors）。        */
/* 未覆盖的归类落 1（群雄锚），与 relations.json 注记一致。               */
/* ------------------------------------------------------------------ */
const ANCHOR_BY_FACTION = {
  '曹魏·司马氏': 3, '西晋·归晋后': 3,
  '蜀汉': 4,
  '孙吴': 5,
  '董卓·凉州': 2,
  // 东汉·汉廷 / 袁绍·河北 / 黄巾·黑山 / 南中·外族 / 方外·隐逸·文士 / 其余 → 1
};
const XIANGXING_SPREAD = 12;
const XIANGXING_RING = 149;

/* 类型优先级：越靠前越值得进「重要」层（GDD §12 准入：能否回答为什么在这座城）。 */
const TYPE_ORDER = {
  名将: 0, 军阀: 1, 名臣: 2, 谋士: 3, 文臣: 4, 将领: 5, 宗室: 6, 部族首领: 7,
  君主: 0, 名士: 4, 后妃: 9, '虚构·将领': 8,
};
const CAVALRY_HOME_RE = /(凉|并|幽|朔|扶风|安定|武威|天水|西平|陇西|辽东|上郡)/;
const NAVY_HOME_RE = /(吴郡|会稽|庐江|江夏|丹阳|豫章|九江|吴县|钱唐)/;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 相性：锚点 + 名字散列 ±spread，环形 1..149（复用 relations.json 规则）。 */
function xiangxingFor(name, faction) {
  const anchor = ANCHOR_BY_FACTION[faction] || 1;
  const raw = anchor + (fnv1a(name) % (2 * XIANGXING_SPREAD + 1)) - XIANGXING_SPREAD;
  return ((raw - 1) % XIANGXING_RING + XIANGXING_RING) % XIANGXING_RING + 1;
}

function clamp100(v) { return Math.max(1, Math.min(100, v)); }

/** 适性派生：确定性规则，界面须标注「本作设定」。 */
function aptitudeFor(r) {
  const [tong, wu, zhi] = r.five;
  const home = r.hometown || '';
  const navyFaction = /孙吴/.test(r.faction || '');
  const shield = tong >= 85 ? 1.15 : tong >= 70 ? 1.0 : 0.9;
  const spear = wu >= 85 ? 1.1 : wu >= 70 ? 1.0 : 0.9;
  const bow = (zhi >= 80 && wu >= 70) ? 1.1 : wu >= 75 ? 1.0 : 0.9;
  let cavalry = CAVALRY_HOME_RE.test(home) ? 1.2 : wu >= 90 ? 1.1 : 0.85;
  let navy = navyFaction ? 1.15 : NAVY_HOME_RE.test(home) ? 1.1 : 0.7;
  return { shield, spear, bow, cavalry, navy };
}

/** traits：关键词事件列取前 2 条，每条截 10 字（口吻层由 tone 另管）。 */
function traitsFor(p) {
  const raw = p.traits ? p.traits.slice()
    : (p.row?.['关键词事件'] || '').split(/[、，,;；]/).map((s) => s.trim()).filter(Boolean);
  return raw.slice(0, 2).map((s) => (s.length > 10 ? s.slice(0, 10) : s));
}

function fiveOf(r) {
  const pick = (k) => {
    const v = parseInt(String(r[k] ?? '').trim(), 10);
    return Number.isFinite(v) ? v : 50;
  };
  return [pick('统率'), pick('武力'), pick('智力'), pick('政治'), pick('魅力')].map(clamp100);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const head = splitCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    const row = {};
    head.forEach((k, i) => { row[k] = cells[i] ?? ''; });
    return row;
  });
}
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function loadCsv(srcPath) {
  // 去 BOM：utf8-sig 文件首列 header 会带 \uFEFF 前缀，导致「姓名」列读空。
  const text = readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  return rows.map((r, idx) => ({
    row: r, idx,
    name: (r['姓名'] || '').trim(),
    zi: (r['字'] || '').trim(),
    born: intOrNull(r['生年']), died: intOrNull(r['卒年']),
    faction: (r['势力归类'] || '').trim(),
    era: (r['活跃分期'] || '').trim(),
    type: (r['人物类型'] || '').trim(),
    hometown: (r['籍贯古称'] || '').trim(),
    src: (r['出处'] || '').trim(),
    level: (r['史实层级'] || '').trim(),
    five: fiveOf(r),
  }));
}

function intOrNull(v) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function loadOverrides() {
  return OVERRIDES.map((o, i) => ({
    row: null, idx: -1 - i,
    name: o.name, zi: o.zi, born: o.born, died: o.died,
    faction: o.faction, era: o.era, type: o.type, hometown: o.hometown,
    src: o.src, level: o.level, five: o.five.map(clamp100),
    traits: o.traits || [],
    override: true,
  }));
}

const mean = (five) => five.reduce((a, b) => a + b, 0) / five.length;

/* ------------------------------------------------------------------ */
/* 选层                                                                 */
/* ------------------------------------------------------------------ */
/** 核心层补足候选门槛（GDD §12 准入：能否回答他为什么在 190-280 出现）：
 *  卒年 ≤281（八王之乱前）且非部族首领。 */
function coreEligible(p) {
  if (p.type === '部族首领') return false;
  if (p.died != null && p.died > 281) return false;
  return true;
}

function selectLayers(pool, fateMembers, skillHeroNames) {
  const seedNames = new Set([...fateMembers, ...skillHeroNames]);
  const inPool = (n) => pool.find((p) => p.name === n);

  // 核心 60：宿命成员强制 → 优先种子高光（专属战法武将等）→ 再按均值补足。
  const core = [];
  for (const n of fateMembers) { const p = inPool(n); if (p) core.push(p); }
  const seeds = pool.filter((p) => seedNames.has(p.name)).sort(cmpByMean);
  for (const p of seeds) {
    if (core.length >= 60) break;
    if (!core.includes(p)) core.push(p);
  }
  const rest = pool
    .filter((p) => !core.includes(p) && mean(p.five) >= 72 && coreEligible(p))
    .sort(cmpByMean);
  for (const p of rest) {
    if (core.length >= 60) break;
    if (!core.includes(p)) core.push(p);
  }
  for (const p of rest) {
    if (core.length >= 60) break;
    if (!core.includes(p)) core.push(p);
  }

  // 重要 100：类型优先级 + 均值。
  const taken = new Set(core);
  const important = pool
    .filter((p) => !taken.has(p))
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 10) - (TYPE_ORDER[b.type] ?? 10) || cmpByMean(a, b))
    .slice(0, 100);

  // 在野 80。
  const taken2 = new Set([...core, ...important]);
  const minor = pool.filter((p) => !taken2.has(p)).sort(cmpByMean).slice(0, 80);

  return { core, important, minor };
}
function cmpByMean(a, b) {
  const d = mean(b.five) - mean(a.five);
  return d !== 0 ? d : a.idx - b.idx; // 同均值按资料库行号，保证确定性
}

/* ------------------------------------------------------------------ */
/* 组装                                                                  */
/* ------------------------------------------------------------------ */
function assemble(layer, heroes, fateGroups, skillHeroes, cfgIdOf, extraTable) {
  return heroes.map((p) => {
    // 一人可属多个宿命组（如曹操 5 组、赵云 3 组）：fate 记首个组 id，bonds 全量铺边。
    const myGroups = fateGroups.filter((g) => g.members.includes(p.name));
    const fateGroup = myGroups[0] || null;
    const bonds = [];
    for (const g of myGroups) {
      for (const m of g.members) {
        if (m !== p.name) bonds.push({ type: 'fate', target: m, groupId: g.id });
      }
    }
    for (const b of existingBonds) {
      if (b.a === p.name && byName.has(b.b)) bonds.push({ type: b.type, target: b.b });
      if (b.b === p.name && byName.has(b.a)) bonds.push({ type: b.type, target: b.a });
    }
    const skill = skillHeroes[p.name];
    /* ★ M3-8（GDD §9 战法 80 条 + §7 武将装配）：core 层武将从单条专属扩到 2~3 条——
       第 1 条仍是 hero-skills.json 专属映射；第 2/3 条从 library-skills-extra 新池
       按五维倾向确定性选取（谋士配谋略/治疗、武将配兵刃；高维配指挥/被动光环）。
       禁随机：只走 fnv1a(名字) 稳定散列，重跑产物逐位一致。 */
    let skills = skill ? [skill] : [];
    if (layer === 'core' && extraTable) {
      const fiveSum = p.five.reduce((a, b) => a + b, 0);
      const wu = p.five[1], zhi = p.five[2];
      // 第 2 条：按智力/武力倾向从伤害+治疗池选
      const prefer = zhi >= wu
        ? ['STRATEGY_DAMAGE', 'HEAL']
        : ['PHYSICAL_DAMAGE', 'HEAL'];
      const pool2 = extraTable.skills.filter((s) =>
        s.kernel.effects.some((e) => prefer.includes(e.effect_type)) && !skills.includes(s.cfgId));
      if (pool2.length) {
        const pick2 = pool2[fnv1a(p.name) % pool2.length];
        skills.push(pick2.cfgId);
      }
      // 第 3 条：五维总和高（≥340）的 core 配指挥/被动光环；无专属映射的 core 无论如何凑满 2 条
      const pool3 = extraTable.skills.filter((s) =>
        ['指挥', '被动'].includes(s.kernel.skill_class) && !skills.includes(s.cfgId));
      if ((fiveSum >= 340 || skills.length < 2) && pool3.length) {
        const pick3 = pool3[fnv1a(`${p.name}|cmd`) % pool3.length];
        skills.push(pick3.cfgId);
      }
    }
    if (!skills.length) skills = [];
    return {
      id: cfgIdOf(p),
      name: p.name,
      zi: p.zi || '－',
      layer,                              // core | important | minor
      five: { tong: p.five[0], wu: p.five[1], zhi: p.five[2], zheng: p.five[3], mei: p.five[4] },
      traits: traitsFor(p),
      skills,
      aptitude: aptitudeFor(p),
      yili: clamp100(Math.round(p.five[3] * 0.6 + p.five[4] * 0.4)),
      xiangxing: xiangxingFor(p.name, p.faction),
      enyi: 0,
      bonds,
      fate: fateGroup ? fateGroup.id : null,
      born: p.born, died: p.died,
      faction: p.faction,
      era: p.era,
      hometown: p.hometown,
      type: p.type,
      source: {
        ref: p.src || '－',
        level: p.level || '－',
        dbRow: p.row ? p.idx + 2 : null,
        override: !!p.override,
        /* M4-1 溯源口径（GDD §10.8）：史实→高，虚构/传说→低，其余→中 */
        confidence: p.level === '史实' ? '高' : p.level === '虚构/传说' ? '低' : '中',
      },
    };
  });
}

/* ------------------------------------------------------------------ */
let existingBonds = [];
let byName = new Map();

function build(srcPath) {
  const fateGroups = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/fate-groups.json'), 'utf8')).groups;
  const skillHeroes = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/hero-skills.json'), 'utf8'));
  /* ★ M3-8 新战法池（conf/library-skills-extra.json，910100~910128） */
  const extraTable = JSON.parse(readFileSync(resolve(ROOT, 'conf/library-skills-extra.json'), 'utf8'));
  const relations = JSON.parse(readFileSync(resolve(ROOT, 'conf/relations.json'), 'utf8'));
  const generalCfg = JSON.parse(readFileSync(resolve(ROOT, 'conf/json/general/general.json'), 'utf8'));

  // 包内已有的武将复用原 cfgId（运行期 MakeHero 走同一条配置通道）。
  const cfgIds = new Map();
  for (const g of generalCfg.list || []) {
    if (!cfgIds.has(g.name)) cfgIds.set(g.name, g.cfgId);
  }
  existingBonds = relations.bonds || [];

  const pool = [...loadCsv(srcPath), ...loadOverrides()];
  byName = new Map(pool.map((p) => [p.name, p]));

  const fateMembers = [...new Set(fateGroups.flatMap((g) => g.members))].filter((n) => byName.has(n));
  const skillHeroNames = Object.keys(skillHeroes).filter((n) => byName.has(n));

  const { core, important, minor } = selectLayers(pool, fateMembers, skillHeroNames);

  let nextCfgId = 240001;
  const cfgIdOf = (p) => cfgIds.get(p.name) ?? nextCfgId++;

  const heroes = [
    ...assemble('core', core, fateGroups, skillHeroes, cfgIdOf, extraTable),
    ...assemble('important', important, fateGroups, skillHeroes, cfgIdOf, null),
    ...assemble('minor', minor, fateGroups, skillHeroes, cfgIdOf, null),
  ];

  const meta = {
    version: 1,
    generator: 'tools/build-heroes.mjs',
    source: { csv: srcPath, rows: pool.length - OVERRIDES.length, overrides: OVERRIDES.length },
    selection: 'core=宿命成员强制+均值降序(60) / important=类型优先级+均值(100) / minor=均值(80)',
    counts: { core: core.length, important: important.length, minor: minor.length, total: heroes.length },
    rules: {
      yili: '政×0.6+魅×0.4（relations.json 规则）',
      xiangxing: '势力锚点+名字FNV散列±12，环形1..149',
      aptitude: '兵种适性按五维/籍贯/势力派生，界面须标「本作设定」',
      skills: 'core=专属(hero-skills.json)+新池倾向2条(五维≥340再配指挥/被动)；important/minor=专属1条',
    },
  };
  return { version: 1, meta, heroes };
}

/* ------------------------------------------------------------------ */
/* 校验（GDD：校验失败即构建失败）                                         */
/* ------------------------------------------------------------------ */
function validate(doc, fateGroups) {
  const errs = [];
  const H = doc.heroes;
  const fives = Object.values(doc.meta.counts);
  // V6
  if (H.length !== 240) errs.push(`V6 总数 ${H.length} ≠ 240`);
  // V3
  if (doc.meta.counts.core !== 60) errs.push(`V3 core ${doc.meta.counts.core} ≠ 60`);
  if (doc.meta.counts.important !== 100) errs.push(`V3 important ${doc.meta.counts.important} ≠ 100`);
  if (doc.meta.counts.minor !== 80) errs.push(`V3 minor ${doc.meta.counts.minor} ≠ 80`);
  // V1 五维范围 + id 唯一
  const ids = new Set();
  for (const h of H) {
    for (const [k, v] of Object.entries(h.five)) {
      if (!Number.isInteger(v) || v < 1 || v > 100) errs.push(`V1 ${h.name}.${k}=${v} 越界`);
    }
    if (ids.has(h.id)) errs.push(`id 重复: ${h.id}(${h.name})`);
    ids.add(h.id);
  }
  // V2 宿命成员
  const names = new Set(H.map((h) => h.name));
  for (const g of fateGroups) {
    for (const m of g.members) {
      if (!names.has(m)) errs.push(`V2 宿命组 ${g.id} 成员缺员: ${m}`);
    }
  }
  // V4 生卒
  for (const h of H) {
    if (h.born != null && h.died != null && h.died <= h.born) errs.push(`V4 ${h.name} 生卒异常 ${h.born}/${h.died}`);
  }
  // V5 核心层 traits
  for (const h of H) {
    if (h.layer === 'core' && h.traits.length === 0) errs.push(`V5 核心层缺 traits: ${h.name}`);
  }
  return errs;
}

/* ------------------------------------------------------------------ */
if (hasFlag('--check')) {
  const doc = JSON.parse(readFileSync(OUT, 'utf8'));
  const fateGroups = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/fate-groups.json'), 'utf8')).groups;
  const errs = validate(doc, fateGroups);
  if (errs.length) { console.error('校验失败:\n' + errs.join('\n')); process.exit(1); }
  console.log(`check ok: ${doc.heroes.length} 位（${JSON.stringify(doc.meta.counts)}）`);
} else {
  const srcPath = argOf('--src') || DEFAULT_SRC;
  const doc = build(srcPath);
  const fateGroups = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/fate-groups.json'), 'utf8')).groups;
  const errs = validate(doc, fateGroups);
  if (errs.length) {
    console.error('校验失败（未写出）:\n' + errs.join('\n'));
    process.exit(1);
  }
  writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', 'utf8');
  const layers = {};
  for (const h of doc.heroes) layers[h.layer] = (layers[h.layer] || 0) + 1;
  console.log(`写出 ${OUT}`);
  console.log(`240 位分层: ${JSON.stringify(layers)}；overrides ${OVERRIDES.length} 位：${OVERRIDES.map((o) => o.name).join('/')}`);
  console.log(`宿命成员入选: ${doc.heroes.filter((h) => h.fate).length} 位带 fate 组`);
}
