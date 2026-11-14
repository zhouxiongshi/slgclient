#!/usr/bin/env node
/**
 * 点名武将属性回落（确定性、幂等、可审计）。
 *
 * 玩家反馈：主角 / 夏侯惇 / 黄盖「属性值比其他武将高出太多」。
 * 先量过再动手（gameStatOf 口径，全表 505 条）：
 *   主公 880001 五维和 32200（全表 163/505）、成长和 180（同星 p3）
 *   夏侯惇 100449 36100（55/505）、100079 35900（64/505）
 *   黄盖 100162 33500（120/505）、100587 32300（158/505）、100439 30800（222/505）
 * 也就是说这三人并非全表最高，真正的结构问题有两个：
 *   ① 三人都堆在同星级上四分位，且 *_grow 偏高（夏侯惇 4 星 359 是同星 p94），
 *      等级一拉开就跟同星武将明显脱节——玩家感受到的是「越练越离谱」；
 *   ② 同名多版本倒挂：黄盖 4 星 100162（33500）比 5 星 100587（32300）还高，
 *      夏侯惇 4 星（35900）几乎追平 5 星（36100），稀有度失去意义。
 *
 * 修法不是把三个数字随手改小，而是：
 *   - 以「同星级中位数 × 0.92」为上限，等比缩放五维（保留各人的人设比例），
 *     成长率同样取 min(现值, 同星中位 × 0.92)，只降不升；
 *   - 同名多版本按 (星级降序, 原值降序) 强制单调，低星档 ≤ 前一档 × 0.94；
 *   - 主角单独从 protagonist.json 取数（M4-8 之后战斗/内政/外交/行军都读它，
 *     改一处即四处同源，不需要再去改领域模块）；
 *   - 基线分位存进审计文件，重复运行不会一次比一次低。
 *
 * 输出：conf/campaign/hero-stat-audit.json（改动前后逐字段对照 + 全表分位）
 * 用法：node tools/normalize-hero-stats.mjs [--dry]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const GENERAL = join(ROOT, 'conf', 'json', 'general', 'general.json');
const PROTAG = join(ROOT, 'conf', 'campaign', 'protagonist.json');
const AUDIT = join(ROOT, 'conf', 'campaign', 'hero-stat-audit.json');

const DIMS = ['force', 'strategy', 'defense', 'speed', 'destroy'];
const GROWS = DIMS.map((k) => `${k}_grow`);
const TARGET_NAMES = ['夏侯惇', '黄盖'];
const sum = (o, ks) => ks.reduce((s, k) => s + (Number(o[k]) || 0), 0);
const q = (arr, p) => {
  const v = arr.slice().sort((a, b) => a - b);
  return v[Math.max(0, Math.min(v.length - 1, Math.floor((v.length - 1) * p)))] ?? 0;
};

const generalDoc = readJson(GENERAL);
const protagDoc = readJson(PROTAG);
const rows = generalDoc.list || [];

/* 基线分位：第一次运行取当前全表，之后复用审计文件里的值，保证幂等 */
let baseline = null;
try { baseline = readJson(AUDIT).baselineQuantiles; } catch { /* 首次运行 */ }
if (!baseline) {
  baseline = {};
  for (const star of [3, 4, 5]) {
    const peers = rows.filter((g) => Number(g.star) === star);
    baseline[star] = {
      n: peers.length,
      baseP50: q(peers.map((g) => sum(g, DIMS)), 0.5),
      baseP75: q(peers.map((g) => sum(g, DIMS)), 0.75),
      baseP90: q(peers.map((g) => sum(g, DIMS)), 0.9),
      growP50: q(peers.map((g) => sum(g, GROWS)), 0.5),
      growP90: q(peers.map((g) => sum(g, GROWS)), 0.9),
    };
  }
}
const capOf = (star) => ({
  base: Math.round((baseline[star].baseP50 * 0.92) / 100) * 100,
  grow: Math.round(baseline[star].growP50 * 0.92),
});

/** 等比缩放五维 / 成长到目标总和，保留各维相对比例（不抹平人设）。 */
function scale(row, keys, target) {
  const before = sum(row, keys);
  if (!(before > 0)) return;
  const k = target / before;
  if (k >= 1) return;
  for (const key of keys) row[key] = Math.max(10, Math.round((Number(row[key]) || 0) * k / 10) * 10);
  /* 取整会有尾差，把差额补到最大那一维，保证总和精确落在目标 */
  const diff = target - sum(row, keys);
  if (diff !== 0) {
    const big = keys.slice().sort((a, b) => (Number(row[b]) || 0) - (Number(row[a]) || 0))[0];
    row[big] = Math.max(10, (Number(row[big]) || 0) + diff);
  }
}

const changes = [];
const touched = rows.filter((g) => TARGET_NAMES.includes(g.name));
/* 主角：protagonist.json 是唯一口径，与 general.json 分开处理 */
const protagonist = protagDoc.general;

function normalizeOne(row, label, ceiling) {
  const before = { base: sum(row, DIMS), grow: sum(row, GROWS) };
  const wantBase = Math.min(before.base, ceiling.base);
  const wantGrow = Math.min(before.grow, ceiling.grow);
  scale(row, DIMS, wantBase);
  scale(row, GROWS, wantGrow);
  changes.push({
    label, star: Number(row.star) || 4,
    before, after: { base: sum(row, DIMS), grow: sum(row, GROWS) },
    ceiling, dimsBefore: null,
  });
  return row;
}

/* 先各自回落到同星级上限，再跨版本强制单调 */
for (const row of touched) normalizeOne(row, `${row.name} ${row.cfgId}`, capOf(Number(row.star) || 4));
normalizeOne(protagonist, `主公 ${protagonist.cfgId}`, capOf(Number(protagonist.star) || 4));

const monotonic = [];
for (const name of TARGET_NAMES) {
  const group = touched.filter((g) => g.name === name)
    .sort((a, b) => (Number(b.star) - Number(a.star)) || (sum(b, DIMS) - sum(a, DIMS)));
  let prev = null;
  for (const row of group) {
    const ceiling = prev ? Math.round(prev * 0.94 / 100) * 100 : Infinity;
    if (sum(row, DIMS) > ceiling) scale(row, DIMS, ceiling);
    monotonic.push({ name, cfgId: row.cfgId, star: Number(row.star), base: sum(row, DIMS), grow: sum(row, GROWS), ceiling: Number.isFinite(ceiling) ? ceiling : null });
    prev = sum(row, DIMS);
  }
}
/* 同步 changes 里的 after（单调压缩可能又降了一档） */
for (const c of changes) {
  const hit = monotonic.find((m) => c.label.endsWith(String(m.cfgId)));
  if (hit) c.after.base = hit.base;
}

const audit = {
  version: 1, generatedBy: 'tools/normalize-hero-stats.mjs',
  baselineQuantiles: baseline,
  rule: '同星级五维和中位 × 0.92 为上限，等比缩放；成长率只降不升；同名多版本按星级单调（低星 ≤ 前一档 × 0.94）',
  note: '主角只改 conf/campaign/protagonist.json；M4-8 之后战斗/内政/外交/行军统一由 gameStatOf 读它，无需改领域模块。',
  changes, monotonic,
  quantilesAfter: (() => {
    const out = {};
    for (const star of [3, 4, 5]) {
      const peers = rows.filter((g) => Number(g.star) === star);
      out[star] = {
        n: peers.length,
        baseP50: q(peers.map((g) => sum(g, DIMS)), 0.5),
        baseP90: q(peers.map((g) => sum(g, DIMS)), 0.9),
      };
    }
    return out;
  })(),
};

/* 按原字节格式打补丁：general.json 是 TAB+CRLF 且末尾无换行，
   protagonist.json 是 2 空格+CRLF。整份 JSON.stringify 会把 500 行全部重排，
   diff 爆炸，还会和并行改动撞车。只替换目标条目里的数值字段。 */
function patchBlock(text, cfgId, fields) {
  const m = new RegExp('"cfgId"\\s*:\\s*' + cfgId + '\\b').exec(text);
  if (!m) throw new Error(`找不到 cfgId ${cfgId}`);
  const start = m.index;
  let end = text.length;
  for (const marker of ['\r\n  }', '\r\n\t\t}', '\r\n    }', '\n  }', '\n\t\t}', '\n    }']) {
    const i = text.indexOf(marker, start);
    if (i >= 0 && i < end) end = i;
  }
  let block = text.slice(start, end);
  for (const [k, v] of Object.entries(fields)) {
    const re = new RegExp('("' + k + '"\\s*:\\s*)-?\\d+', 'g');
    if (!new RegExp('"' + k + '"\\s*:\\s*-?\\d+').test(block)) throw new Error(`cfgId ${cfgId} 缺字段 ${k}`);
    block = block.replace(re, (_x, p1) => p1 + v);
  }
  return text.slice(0, start) + block + text.slice(end);
}
const fieldsOf = (row) => Object.fromEntries([...DIMS, ...GROWS].map((k) => [k, row[k]]));
if (!DRY) {
  let gt = readFileSync(GENERAL, 'utf8');
  for (const row of touched) gt = patchBlock(gt, row.cfgId, fieldsOf(row));
  writeFileSync(GENERAL, gt, 'utf8');
  let pt = readFileSync(PROTAG, 'utf8');
  pt = patchBlock(pt, protagonist.cfgId, fieldsOf(protagonist));
  writeFileSync(PROTAG, pt, 'utf8');
  writeFileSync(AUDIT, JSON.stringify(audit, null, 1) + '\n', 'utf8');
}
console.log(JSON.stringify({
  dry: DRY, baseline, caps: { 3: capOf(3), 4: capOf(4), 5: capOf(5) },
  changes: changes.map((c) => `${c.label}: 五维和 ${c.before.base}→${c.after.base}，成长和 ${c.before.grow}→${c.after.grow}`),
  monotonic,
}, null, 1));
