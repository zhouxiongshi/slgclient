#!/usr/bin/env node
/**
 * 技能概率与输出平衡（2026-11-17）—— 用户反馈「所有技能释放概率都是 70%、
 * 输出相差太大」。本工具是唯一平衡口径，可重复运行（幂等）。
 *
 * 度量：期望输出指数 = casts × 概率(Lv10) × 伤害率(Lv10) × 目标数
 *   casts：指挥 1；被动 8；主动/追击 8；准备 floor(8/(prepare+1))
 *   目标数：enemy_single/self=1；enemy_group/enemy_all=3
 *
 * 规则（同类 SLG 的通用范式：发动率与伤害率反相关）：
 *   1) 伤害型主动/追击：概率按「伤害率越高、概率越低」反推，
 *      p10 = clamp(700 / (casts × rate × targets), 0.32, 0.50)，p1 = clamp(p10-0.08, 0.30, 0.45)；
 *      非伤害主动/追击用 p10=0.40 / p1=0.32。
 *   2) 指挥 / 被动：概率恒 100%（不成长）。
 *   3) 控制率上限 100%（旧数据有 200%，引擎不 clamp 会必中）。
 *   4) 输出指数低于 300 或高于 2000 的伤害技能，按同一系数缩放所有伤害槽（保持等级成长关系）。
 *
 * 用法：
 *   node tools/skill-balance.mjs            # 只报告
 *   node tools/skill-balance.mjs --apply    # 写回 conf（同步 ui 与 kernel）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const FILES = [
  'conf/skills.json',
  'conf/campaign/protagonist-skill.json',
  'conf/library-skills.json',
  'conf/library-skills-extra.json',
  'conf/innate-skills.json',
];
const DMG = new Set(['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE', 'HEAL']);
const idxTargetLow = 300;
const idxTargetHigh = 2000;
const idxMid = 700;

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function skillList(j) {
  return Array.isArray(j.skills) ? j.skills : [j];
}

function castsOf(s) {
  const c = s.kernel.skill_class;
  if (c === '指挥') return 1;
  if (c === '被动') return 8;
  const prep = Number(s.kernel.prepare) || 0;
  return prep > 0 ? Math.floor(8 / (prep + 1)) : 8;
}
function targetsOf(s) {
  const k = s.kernel;
  const t = k.target_type || k.effects?.[0]?.target_type || 'enemy_single';
  return /group|all/i.test(String(t)) ? 3 : 1;
}
function damageSlots(s) {
  const k = s.kernel;
  if (Array.isArray(k.effects)) {
    const out = [];
    k.effects.forEach((e, i) => { if (DMG.has(e.effect_type)) out.push(i); });
    return out;
  }
  return DMG.has(k.effect_type) ? [0] : [];
}
function rateLv(s, lvIdx) {
  const lv = s.ui.levels[lvIdx];
  return damageSlots(s).reduce((a, i) => a + (Number(lv.effect_value[i]) || 0), 0);
}

function planProb(s) {
  const k = s.kernel;
  const cls = k.skill_class;
  if (cls === '指挥' || cls === '被动') return { p1: 1, p10: 1, why: '必发动' };
  const rate = rateLv(s, s.ui.levels.length - 1);
  if (!(rate > 0)) return { p1: 0.32, p10: 0.40, why: '非伤害主动' };
  const raw = idxMid / (castsOf(s) * rate * targetsOf(s));
  const p10 = clamp(raw, 0.32, 0.50);
  const p1 = clamp(p10 - 0.08, 0.30, 0.45);
  return { p1, p10, why: '伤害反推' };
}

function applyProb(s, p1, p10) {
  const n = s.ui.levels.length;
  const cls = s.kernel.skill_class;
  /* 指挥 / 被动：恒 100%，不做成长（与 FIELD-CONTRACT「指挥必发动」一致）。 */
  if (cls === '指挥' || cls === '被动') {
    s.ui.levels.forEach((l) => { l.probability = 100; });
    s.kernel.probability_init = 1;
    s.kernel.probability_max = 1;
    return;
  }
  const target1 = Math.round(p1 * 100);
  const target10 = Math.round(p10 * 100);
  /* 线性插值，只保证「末级 > 首级」，不强制逐级 +1（逐级 +1 会累积出 101%）。 */
  s.ui.levels.forEach((l, i) => {
    l.probability = Math.round(target1 + (target10 - target1) * (n > 1 ? i / (n - 1) : 1));
  });
  if (s.ui.levels[n - 1].probability <= s.ui.levels[0].probability) {
    s.ui.levels[n - 1].probability = s.ui.levels[0].probability + 1;
  }
  s.kernel.probability_init = s.ui.levels[0].probability / 100;
  s.kernel.probability_max = s.ui.levels[n - 1].probability / 100;
}

function applyRateScale(s, f) {
  if (!(f > 0) || Math.abs(f - 1) < 1e-6) return;
  const slots = damageSlots(s);
  s.ui.levels.forEach((l) => {
    slots.forEach((i) => { l.effect_value[i] = round2((Number(l.effect_value[i]) || 0) * f); });
  });
  const k = s.kernel;
  if (Array.isArray(k.effects)) {
    slots.forEach((i) => {
      if (k.effects[i] && Number.isFinite(Number(k.effects[i].rate_pct))) {
        k.effects[i].rate_pct = round2(Number(k.effects[i].rate_pct) * f);
      }
    });
  } else {
    if (Number.isFinite(Number(k.rate_pct_lv1))) k.rate_pct_lv1 = round2(k.rate_pct_lv1 * f);
    if (Number.isFinite(Number(k.rate_pct_lv10))) k.rate_pct_lv10 = round2(k.rate_pct_lv10 * f);
  }
}
/**
 * 控制槽：effect_value 就是「控制命中率 %」（server/skills.js 运行时 /100 传给内核），
 * 受两条硬约束：① Lv10 ≤ 100（>100 等于必中，旧数据有 200）；
 * ② Lv10 = Lv1 × 2（m3 等级成长闸），旧数据有「80→80 无成长」的坏样本。
 * 处理顺序：先按比例压到 Lv10=100 保住等级关系，再把不成倍数的按 Lv10 折半重建阶梯。
 */
function applyControlCap(s) {
  const k = s.kernel;
  const slots = k.effects ? k.effects.map((e, i) => (e.effect_type === 'CONTROL' ? i : -1)).filter((i) => i >= 0)
    : (k.effect_type === 'CONTROL' ? [0] : []);
  const n = s.ui.levels.length;
  const at = (i, lv) => Number(s.ui.levels[lv].effect_value[i]) || 0;
  slots.forEach((i) => {
    let top = at(i, n - 1);
    if (!(top > 0)) return;
    if (top > 100) {
      const f = 100 / top;
      s.ui.levels.forEach((l) => { l.effect_value[i] = round2(l.effect_value[i] * f); });
      top = at(i, n - 1);
    }
    if (Math.abs(top - at(i, 0) * 2) > 0.02) {
      const lv1 = round2(top / 2);
      s.ui.levels.forEach((l, idx) => {
        l.effect_value[i] = round2(lv1 + (top - lv1) * (n > 1 ? idx / (n - 1) : 1));
      });
      s.ui.levels[n - 1].effect_value[i] = top;
      s.ui.levels[0].effect_value[i] = lv1;
    }
  });
  if (Array.isArray(k.effects)) {
    slots.forEach((i) => { if (Number(k.effects[i].control_probability) > 1) k.effects[i].control_probability = 1; });
  } else if (Number(k.control_probability) > 1) {
    k.control_probability = 1;
  }
}

/* 写回时保留原文件的排版风格（单行压缩 / N 空格缩进），避免整文件重排把 diff 变成几万行噪音。 */
function detectIndent(raw) {
  if (!raw.trimEnd().includes('\n')) return 0;
  const m = raw.match(/\n([ \t]+)"/);
  return m ? m[1] : 1;
}
function serialize(raw, doc, indent) {
  const body = indent === 0 ? JSON.stringify(doc) : JSON.stringify(doc, null, indent);
  return raw.endsWith('\n') ? `${body}\n` : body;
}

const report = [];
let changed = 0;
for (const rel of FILES) {
  const p = join(ROOT, rel);
  const raw = readFileSync(p, 'utf8');
  const indent = detectIndent(raw);
  const doc = JSON.parse(raw);
  for (const s of skillList(doc)) {
    const beforeP = s.ui.levels.map((l) => l.probability).join(',');
    const beforeRate = rateLv(s, s.ui.levels.length - 1);
    const prob = planProb(s);
    if (APPLY) {
      applyProb(s, prob.p1, prob.p10);
      applyControlCap(s);
      const rate = rateLv(s, s.ui.levels.length - 1);
      const casts = castsOf(s);
      const p10 = s.ui.levels.at(-1).probability / 100;
      const targets = targetsOf(s);
      let idx = casts * p10 * rate * targets;
      /* 指挥只发动 1 次、多为功能型，不强求输出指数；其余按区间缩放伤害率。 */
      if (s.kernel.skill_class !== '指挥' && rate > 0 && (idx < idxTargetLow || idx > idxTargetHigh)) {
        const want = clamp(idx, idxTargetLow, idxTargetHigh);
        applyRateScale(s, want / idx);
        idx = casts * p10 * rateLv(s, s.ui.levels.length - 1) * targets;
      }
      const afterP = s.ui.levels.map((l) => l.probability).join(',');
      if (beforeP !== afterP) changed += 1;
    }
    const rate = rateLv(s, s.ui.levels.length - 1);
    const p10 = s.ui.levels.at(-1).probability / 100;
    report.push({
      file: rel, name: s.name, cls: s.kernel.skill_class,
      p1: s.ui.levels[0].probability, p10: s.ui.levels.at(-1).probability,
      rateBefore: round2(beforeRate), rate: round2(rate), casts: castsOf(s),
      targets: targetsOf(s), idx: Math.round(castsOf(s) * p10 * rate * targetsOf(s)),
    });
  }
  if (APPLY) writeFileSync(p, serialize(raw, doc, indent));
}

const dmg = report.filter((r) => r.rate > 0).sort((a, b) => a.idx - b.idx);
const idxs = dmg.map((r) => r.idx);
const q = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(arr.length * t))] || 0;
console.log(`[skill-balance] 技能 ${report.length} 条，有伤害 ${dmg.length} 条${APPLY ? `，改写 ${changed} 条概率` : '（只报告）'}`);
console.log(`[skill-balance] 输出指数 min/p25/median/p75/max = ${[q(idxs, 0), q(idxs, 0.25), q(idxs, 0.5), q(idxs, 0.75), idxs.at(-1) || 0].join(' / ')}`);
const dist = {};
for (const r of report) dist[r.p10] = (dist[r.p10] || 0) + 1;
console.log('[skill-balance] Lv10 概率分布：', Object.entries(dist).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}%=${v}`).join(' '));
if (!APPLY) {
  console.log('[skill-balance] 最低 8 条：');
  for (const r of dmg.slice(0, 8)) console.log(`  ${r.name} ${r.cls} p${r.p10}% rate${r.rate} idx${r.idx}`);
  console.log('[skill-balance] 最高 8 条：');
  for (const r of dmg.slice(-8)) console.log(`  ${r.name} ${r.cls} p${r.p10}% rate${r.rate} idx${r.idx}`);
}
