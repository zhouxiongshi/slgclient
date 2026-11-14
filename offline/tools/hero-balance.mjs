/**
 * 武将属性平衡审查（系统性验收 M4-4）。
 *
 *   node tools/hero-balance.mjs [--json out.json]
 *
 * 只读审查，不改数据。核对：
 *   1) 五维值域/分布（按 layer）、越界与离群；
 *   2) 派生字段一致性（义理 = 政×0.6+魅×0.4、相性 1..149、适性值域、生卒年）；
 *   3) 层级定位与虚构人物属性→designNotes（layer 是剧情权重档，不是强度档；
 *      五维来自史实原表，改数值会破坏 CSV 忠实性与数据溯源，只能改口径）；
 *   4) 战法装配（cfgId 有效性、数量、与五维倾向是否错配）；
 *   5) 宿命组引用有效性、组合加成上限；
 *   6) 与 three-kingdoms/characters.csv 原表的忠实性。
 * 输出 reports/hero-balance.json，issues 按 severity 分级（high/medium/low）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'reports', 'hero-balance.json');
const CSV = 'D:/WorkBuddy/three-kingdoms/characters.csv';

const heroes = JSON.parse(readFileSync(join(ROOT, 'conf/campaign/heroes-240.json'), 'utf8')).heroes;
const fates = JSON.parse(readFileSync(join(ROOT, 'conf/campaign/fate-groups.json'), 'utf8')).groups;
const skills = [...JSON.parse(readFileSync(join(ROOT, 'conf/skills.json'), 'utf8')).skills,
  ...JSON.parse(readFileSync(join(ROOT, 'conf/library-skills.json'), 'utf8')).skills,
  ...JSON.parse(readFileSync(join(ROOT, 'conf/library-skills-extra.json'), 'utf8')).skills];
const skillById = new Map(skills.map((s) => [s.cfgId, s]));
const heroByName = new Map(heroes.map((h) => [h.name, h]));
const sum = (h) => Object.values(h.five).reduce((s, v) => s + v, 0);
const issues = [];
const add = (severity, kind, subject, detail) => issues.push({ severity, kind, subject, detail });
/* 设计备注与数据缺陷必须分开：M4-4 曾把「core 低维 / minor 高维 / 虚构人物高属性」
   记成 31 条 high/medium bug，但 layer 是剧情权重（谁在剧本里出场），不是强度档，
   五维又逐位忠实于 three-kingdoms/characters.csv。把它们当 bug 会诱导后人去改史实
   数值，直接破坏 M4-1 的数据溯源红线。这里保留全部明细，只是不再混进 issues。 */
const designNotes = [];
const note = (kind, subject, detail) => designNotes.push({ kind, subject, detail });

/* ---------------- 1) 五维分布 ---------------- */
const DIMS = ['tong', 'wu', 'zhi', 'zheng', 'mei'];
const byLayer = {};
for (const layer of ['core', 'important', 'minor']) {
  const rows = heroes.filter((h) => h.layer === layer);
  const dims = {};
  for (const d of DIMS) {
    const vals = rows.map((h) => h.five[d]);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    dims[d] = {
      min: Math.min(...vals), max: Math.max(...vals),
      mean: Number(mean.toFixed(1)),
      std: Number(Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length).toFixed(1)),
    };
  }
  const sums = rows.map(sum);
  byLayer[layer] = { count: rows.length, dims, sumMean: Number((sums.reduce((s, v) => s + v, 0) / sums.length).toFixed(1)), sumMin: Math.min(...sums), sumMax: Math.max(...sums), skillsMean: Number((rows.reduce((s, h) => s + (h.skills || []).length, 0) / rows.length).toFixed(2)) };
}
for (const h of heroes) {
  for (const d of DIMS) {
    if (!Number.isFinite(h.five[d]) || h.five[d] < 1 || h.five[d] > 100) {
      add('high', '五维越界', h.name, `${d}=${h.five[d]} 超出 1..100`);
    }
  }
  if (typeof h.yili !== 'number' || h.yili !== Math.round(h.five.zheng * 0.6 + h.five.mei * 0.4)) {
    add('medium', '派生不一致', h.name, `义理=${h.yili}，期望 ${Math.round(h.five.zheng * 0.6 + h.five.mei * 0.4)}`);
  }
  if (!Number.isInteger(h.xiangxing) || h.xiangxing < 1 || h.xiangxing > 149) {
    add('high', '相性越界', h.name, `相性=${h.xiangxing}，应为 1..149 整数`);
  }
  if (h.born && h.died && Number(h.died) < Number(h.born)) add('high', '生卒年倒挂', h.name, `${h.born}→${h.died}`);
  for (const [k, v] of Object.entries(h.aptitude || {})) {
    if (!Number.isFinite(v) || v < 0.4 || v > 1.5) add('medium', '适性越界', h.name, `${k}=${v}`);
  }
}

/* ---------------- 2) 层级定位 ---------------- */
const coreMean = byLayer.core.sumMean;
const coreRows = heroes.filter((h) => h.layer === 'core').sort((a, b) => sum(a) - sum(b));
for (const h of coreRows.slice(0, 8)) {
  if (sum(h) < coreMean - 55) note('core 低维', h.name, `五维和 ${sum(h)}，core 均值 ${coreMean}；类型 ${h.type}；${h.source.level}`);
}
const minorTop = heroes.filter((h) => h.layer === 'minor' && sum(h) >= coreMean + 20)
  .sort((a, b) => sum(b) - sum(a));
for (const h of minorTop.slice(0, 12)) {
  note('minor 高维', h.name, `五维和 ${sum(h)} ≥ core 均值+20（${coreMean}），却在 minor 层、战法 ${(h.skills || []).length} 条`);
}
const importantTop = heroes.filter((h) => h.layer === 'important' && sum(h) >= coreMean + 20)
  .sort((a, b) => sum(b) - sum(a));
for (const h of importantTop.slice(0, 8)) {
  note('important 高维', h.name, `五维和 ${sum(h)}，战法 ${(h.skills || []).length} 条`);
}

/* ---------------- 3) 虚构/传说人物 ---------------- */
const fiction = heroes.filter((h) => h.source?.level !== '史实' || /虚构|虚拟|无名|近现代/.test(h.type || ''));
for (const h of fiction) {
  const top = Math.max(...Object.values(h.five));
  if (top >= 95 || sum(h) >= 380) {
    note('虚构人物高属性', h.name, `${h.type}（${h.source.level}，${h.layer} 层），五维和 ${sum(h)}、单维峰值 ${top}`);
  }
  /* 真正可自动判定的硬缺陷：非史实人物必须标低置信，否则「本作设定」会被
     玩家误读成史实。属性高低本身不是 bug，标注缺失才是。 */
  if (h.source?.confidence !== '低') {
    add('high', '虚构人物未标注低置信', h.name,
      `source.confidence=${h.source?.confidence}，应为「低」（数据溯源 M4-1）`);
  }
}
for (const h of heroes) {
  if (!['core', 'important', 'minor'].includes(h.layer)) {
    add('high', '层级越界', h.name, `layer=${h.layer}，应为剧情权重三档之一`);
  }
}

/* ---------------- 4) 战法装配 ---------------- */
function kindOf(cfgId) {
  const s = skillById.get(cfgId);
  if (!s) return null;
  const k = s.kernel || s;
  const fx = Array.isArray(k.effects) && k.effects.length ? k.effects : [k];
  const types = new Set(fx.map((e) => e.effect_type));
  return { physical: types.has('PHYSICAL_DAMAGE'), strategy: types.has('STRATEGY_DAMAGE'), heal: types.has('HEAL'), buff: types.has('BUFF'), cls: k.skill_class };
}
let invalidSkillRefs = 0, mismatch = 0, zeroSkillHighStat = 0;
for (const h of heroes) {
  for (const id of h.skills || []) if (!skillById.has(id)) { invalidSkillRefs += 1; add('high', '战法引用无效', h.name, `cfgId=${id}`); }
  const kinds = (h.skills || []).map(kindOf).filter(Boolean);
  const hasPhysical = kinds.some((k) => k.physical), hasStrategy = kinds.some((k) => k.strategy);
  if (h.layer === 'core') {
    if (h.five.wu >= 90 && !hasPhysical) { mismatch += 1; add('medium', '战法错配', h.name, `武力 ${h.five.wu} 无兵刃战法`); }
    if (h.five.zhi >= 90 && !hasStrategy) { mismatch += 1; add('medium', '战法错配', h.name, `智力 ${h.five.zhi} 无谋略战法`); }
  }
  if (!(h.skills || []).length && sum(h) >= coreMean) {
    zeroSkillHighStat += 1;
  }
}
if (zeroSkillHighStat > 0) add('high', '高维零战法', `${zeroSkillHighStat} 位`, `五维和 ≥ core 均值（${coreMean}）却 0 条战法，装配只按 layer 不看五维`);

/* ---------------- 5) 宿命 ---------------- */
const fateIssues = [];
for (const g of fates) {
  for (const m of g.members || []) if (!heroByName.has(m.name ?? m)) fateIssues.push(`${g.id}: 成员 ${m.name ?? m} 不在 240`);
  if (!g.source?.id || !g.source?.confidence) fateIssues.push(`${g.id}: source 不完整`);
}
for (const f of fateIssues) add('medium', '宿命引用', '-', f);
const bonded = heroes.filter((h) => (h.bonds || []).length);
const multi = heroes.filter((h) => (h.fate ? 1 : 0) && (h.bonds || []).filter((b) => b.type === 'fate').length > 2);

/* ---------------- 6) CSV 忠实性 ---------------- */
let csvChecked = 0, csvMismatch = 0;
if (existsSync(CSV)) {
  const lines = readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const head = (lines[0] || '').split(',').map((x) => x.replace(/^"|"$/g, ''));
  const idx = (n) => head.indexOf(n);
  const rows = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(',').map((x) => x.replace(/^"|"$/g, ''));
    rows.set(c[idx('姓名')], c);
  }
  const cols = { tong: '统率', wu: '武力', zhi: '智力', zheng: '政治', mei: '魅力' };
  for (const h of heroes) {
    const c = rows.get(h.name);
    if (!c || h.source?.override) continue;
    csvChecked += 1;
    let bad = false;
    for (const [k, cn] of Object.entries(cols)) {
      if (idx(cn) >= 0 && Number(c[idx(cn)]) !== h.five[k]) bad = true;
    }
    if (bad) { csvMismatch += 1; if (csvMismatch <= 8) add('high', 'CSV 五维不一致', h.name, `包内 ${JSON.stringify(h.five)} vs 原表`); }
  }
}

/* ---------------- 汇总 ---------------- */
const report = {
  generatedAt: new Date().toISOString(),
  totals: { heroes: heroes.length, fates: fates.length, skills: skills.length,
    issues: issues.length, high: issues.filter((i) => i.severity === 'high').length,
    medium: issues.filter((i) => i.severity === 'medium').length,
    designNotes: designNotes.length,
    invalidSkillRefs, mismatch, zeroSkillHighStat,
    csvChecked, csvMismatch, bonded: bonded.length, multiFate: multi.length },
  byLayer,
  fiction: fiction.map((h) => ({ name: h.name, layer: h.layer, type: h.type, sum: sum(h), five: h.five })),
  top10: heroes.slice().sort((a, b) => sum(b) - sum(a)).slice(0, 10)
    .map((h) => ({ name: h.name, layer: h.layer, sum: sum(h), skills: (h.skills || []).length })),
  issues,
  designNotes,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(`[hero-balance] 240 位 / ${fates.length} 宿命组 / ${skills.length} 战法`);
console.log(`[hero-balance] 数据缺陷 ${issues.length}（high ${report.totals.high} / medium ${report.totals.medium}）；设计备注 ${designNotes.length} 条（layer 为剧情权重档）`);
console.log(`[hero-balance] 高维零战法 ${zeroSkillHighStat} 位、战法错配 ${mismatch} 处、CSV 核对 ${csvChecked} 位（不一致 ${csvMismatch}）`);
console.log(`[hero-balance] 报告: ${OUT}`);
