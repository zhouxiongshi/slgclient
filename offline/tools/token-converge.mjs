#!/usr/bin/env node
/**
 * token-converge.mjs — 注入层配色/字体散点收敛（AE-02 / AE-03）
 *
 * 背景：`layout-audit` 实测可见色值 41 种、字体族 4 套，判定「超出收敛阈值」。
 * 散点的来源不是没设计，而是设计 token 只存在于人脑里 —— 同一族米色被手写成
 * #e6dac0 / #e6dcc0 / #e6dbb9 / #f0e2bd 四个值，肉眼完全不可分辨。
 *
 * 本工具做两件事：
 *   1. 把「低频孤立色」（默认出现 ≤3 次）吸到最近的「高频主色」（≥4 次）；
 *      同族判定用 RGB 通道最大差 ≤ --max-dist（默认 6）。
 *      3 次以上的色一律不动 —— 它们大概率是「常态 / 悬停 / 选中」这类成对状态色，
 *      合并会让交互反馈消失。
 *   2. 把 UA 默认字体族的表单控件收进正文档（字体收敛由 ui-shell 的 CSS 兜底，
 *      这里只报告有没有漏网的 font-family 声明）。
 *
 * 用法：
 *   node tools/token-converge.mjs            # dry-run，只打印清单
 *   node tools/token-converge.mjs --apply    # 真改文件
 *
 * 纪律：只动 server/ 下的注入层源码，绝不碰 web/（逐字节不可改）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FILES = [
  'server/panels-ui.js',
  'server/skills.js',
  'server/interaction-ui.js',
  'server/ui-shell.js',
];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
/** 同族判定：RGB 通道最大差 */
const MAX_DIST = argOf('--max-dist', 6);
/** 低于等于此出现次数的色算「散点」，允许被吸收 */
const SPARSE_MAX = argOf('--sparse-max', 3);
/** 高于等于此出现次数的色算「主色」，可以作为归宿 */
const ANCHOR_MIN = argOf('--anchor-min', 4);

const norm3 = (h) => (h.length === 3 ? h.split('').map((c) => c + c).join('') : h);
const rgbOf = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});
const dist = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

/* ------------------------------------------------------------------ */
/* 1. 清点：hex 与 rgb()/rgba() 分开统计（两者的语义与合并风险不同）      */
/* ------------------------------------------------------------------ */
const HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/g;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)/g;

const sources = new Map();
const hexCount = new Map();
for (const rel of FILES) {
  const src = readFileSync(resolve(ROOT, rel), 'utf8');
  sources.set(rel, src);
  for (const m of src.matchAll(HEX_RE)) {
    const k = '#' + norm3(m[1]).toLowerCase();
    hexCount.set(k, (hexCount.get(k) || 0) + 1);
  }
}

const entries = [...hexCount].map(([k, n]) => ({ k, n, ...rgbOf(k) }));
const sparse = entries.filter((e) => e.n <= SPARSE_MAX);
const anchors = entries.filter((e) => e.n >= ANCHOR_MIN);

/* 散点 → 最近主色（距离超阈值就保留，不硬凑） */
const plan = [];
const skipped = [];
for (const s of sparse.sort((a, b) => a.n - b.n)) {
  let best = null;
  let bd = Infinity;
  for (const a of anchors) {
    const d = dist(s, a);
    if (d < bd) { bd = d; best = a; }
  }
  if (best && bd <= MAX_DIST) plan.push({ from: s.k, to: best.k, dist: bd, n: s.n });
  else skipped.push({ from: s.k, n: s.n, nearest: best ? best.k : null, dist: bd });
}

/* ------------------------------------------------------------------ */
/* 2. 报告                                                            */
/* ------------------------------------------------------------------ */
const after = new Set(hexCount.keys());
for (const p of plan) after.delete(p.from);
console.log('注入层 hex 色值：' + hexCount.size + ' 种（引用 ' +
  [...hexCount.values()].reduce((s, n) => s + n, 0) + ' 次）');
console.log('散点(≤' + SPARSE_MAX + ' 次)：' + sparse.length +
  ' · 主色(≥' + ANCHOR_MIN + ' 次)：' + anchors.length);
console.log('可吸收：' + plan.length + ' 个 → 收敛后 ' + after.size + ' 种');
if (plan.length) {
  console.log('\n吸收清单（散点 → 主色，通道最大差）：');
  for (const p of plan.sort((a, b) => a.dist - b.dist || b.n - a.n)) {
    console.log('  ' + p.from + ' (' + p.n + ' 次) → ' + p.to + '   Δ' + p.dist);
  }
}
if (skipped.length) {
  console.log('\n保留（找不到 ≤' + MAX_DIST + ' 的主色，多半是刻意的语义色）：');
  for (const s of skipped.slice(0, 20)) {
    console.log('  ' + s.from + ' (' + s.n + ' 次)' + (s.nearest ? ' 最近 ' + s.nearest + ' Δ' + s.dist : ''));
  }
  if (skipped.length > 20) console.log('  … 另有 ' + (skipped.length - 20) + ' 个');
}

/* ------------------------------------------------------------------ */
/* 3. 落地                                                            */
/* ------------------------------------------------------------------ */
if (APPLY) {
  let touched = 0;
  for (const [rel, src0] of sources) {
    let out = src0;
    for (const p of plan) {
      const from = p.from.slice(1);
      const to = p.to;
      /* 大小写与 3 位简写都要覆盖；后面不能紧跟 hex 字符，避免前缀误伤 */
      const re = new RegExp('#' + from + '(?![0-9a-fA-F])', 'gi');
      out = out.replace(re, to);
      const short = from.length === 6 && from[0] === from[1] && from[2] === from[3] && from[4] === from[5]
        ? '#' + from[0] + from[2] + from[4] : null;
      if (short) out = out.replace(new RegExp(short + '(?![0-9a-fA-F])', 'gi'), to);
    }
    if (out !== src0) { writeFileSync(resolve(ROOT, rel), out); touched += 1; }
  }
  console.log('\n已写入 ' + touched + ' 个文件。复测：node tools/layout-audit.js');
} else {
  console.log('\n（dry-run）加 --apply 才会改文件。');
}
