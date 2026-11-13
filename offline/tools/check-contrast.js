#!/usr/bin/env node
/**
 * M4-3 WCAG 对比度检测（GDD §10.7：正文 ≥4.5:1，大字号 ≥3:1）。
 *
 * 色彩对登记在 PAIRS（token 名 / 前景 / 背景 / 用途档位）。前景支持 #hex 与 rgba()——
 * 半透明前景先按 alpha 合成到底色再算。输出 reports/contrast.json；不达标 exit 1。
 *
 * 用途档位口径：
 *   body  正文/说明文字（≥11px）—— ≥4.5:1
 *   large 标题/大数字（≥14px bold 或 ≥18px）—— ≥3:1
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'reports', 'contrast.json');

/* 注入 UI 全部配色走同一套古铜/墨绿体系。背景取各面板最浅实底（合成后），从严判定。 */
const BG_PANEL = 'rgba(22,30,20,0.98)';   // 六府窗/抽屉/弹层最浅底
const BG_OVERLAY = 'rgba(14,15,11,0.88)'; // 战略 overlay 图例/信息条底（合成到黑底更浅的近似）

function parseColor(str) {
  const s = String(str).trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return { r: parseInt(f.slice(0, 2), 16), g: parseInt(f.slice(2, 4), 16), b: parseInt(f.slice(4, 6), 16), a: 1 };
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r, g, b, a };
  }
  throw new Error(`无法解析颜色：${s}`);
}

/** 前景带 alpha 时合成到已知底色上（先底后前景，两次 over）。 */
function composite(fg, mid, bg) {
  const out = {};
  for (const k of ['r', 'g', 'b']) {
    out[k] = Math.round(fg.a * fg[k] + (1 - fg.a) * mid[k]);
  }
  const fin = {};
  for (const k of ['r', 'g', 'b']) {
    fin[k] = Math.round(out.a !== undefined ? out[k] : (1 - bg.a) * out[k] + bg.a * bg[k]);
  }
  return fin;
}

function over(top, bottom) {
  const out = {};
  for (const k of ['r', 'g', 'b']) out[k] = Math.round(top.a * top[k] + (1 - top.a) * bottom[k]);
  return { ...out, a: 1 };
}

function luminance({ r, g, b }) {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* 半透明面板底 → 合成到游戏底层（近似深色场景 #0d0f0a）。 */
const SCENE = parseColor('#0d0f0a');
const bgPanel = over(parseColor(BG_PANEL), SCENE);
const bgOverlay = over(parseColor(BG_OVERLAY), SCENE);

/* 前景带 alpha 的（如文字阴影不用管，全部实色）；统一 over 合成。 */
const PAIRS = [
  { token: '正文 primary',   fg: '#e8e0cc', bg: bgPanel,   tier: 'body',  min: 4.5 },
  { token: '标题 heading',   fg: '#f0e2b8', bg: bgPanel,   tier: 'large', min: 3 },
  { token: '次级 muted',     fg: '#a9a48f', bg: bgPanel,   tier: 'body',  min: 4.5 },
  { token: '金强调 term',    fg: '#e3c46a', bg: bgPanel,   tier: 'body',  min: 4.5 },
  { token: '来源绿 src',     fg: '#9cae8c', bg: bgPanel,   tier: 'body',  min: 4.5 },
  { token: '暖警示 alert',   fg: '#ffb27a', bg: bgOverlay, tier: 'body',  min: 4.5 },
  { token: '正文 on-overlay', fg: '#e2d6ba', bg: bgOverlay, tier: 'body', min: 4.5 },
  { token: '成功绿 ok',      fg: '#a9d8ae', bg: bgPanel,   tier: 'body',  min: 4.5 },
  { token: '失败红 fail',    fg: '#f0a49c', bg: bgPanel,   tier: 'body',  min: 4.5 },
];

const results = [];
let fail = 0;
for (const p of PAIRS) {
  const fg = parseColor(p.fg);
  const ratio = contrast(fg.a < 1 ? over(fg, p.bg) : fg, p.bg);
  const ok = ratio >= p.min;
  if (!ok) fail += 1;
  results.push({ token: p.token, fg: p.fg, tier: p.tier, min: p.min, ratio: Number(ratio.toFixed(2)), ok });
}

const report = { generatedAt: new Date().toISOString(), ok: fail === 0, checked: results.length, failed: fail, results };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.token.padEnd(14)} ${String(r.ratio).padStart(5)}:1 （要求 ≥${r.min}，${r.tier}）`);
}
console.log(`对比度：${results.length} 对，不达标 ${fail}；报告：${OUT}`);
process.exit(fail ? 1 : 0);
