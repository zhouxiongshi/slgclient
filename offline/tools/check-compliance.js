#!/usr/bin/env node
/**
 * M4-1 数据溯源合规扫描（GDD §10.8 / 验收 G5、G6）。
 *
 * 与 compliance-report.js（素材台账 + 禁入物）互补：本工具管「数据条目级溯源」——
 *   1) conf/ 内每条史实/设计数据必须带 source + confidence（口径：高/中/低）；
 *   2) 术语表每条必须带数值来源；
 *   3) 地图必须登记「示意图、非标准行政地图」声明，且 UI 真实渲染（skills.js 注入源）；
 *   4) 汇总未授权第三方资产数（读 provenance 台账）供发行决策。
 *
 * 输出 reports/data-provenance.json；--json 打印摘要；发现缺口 exit 1（未通过不得发布）。
 * 本工具只读 conf/ 与源码，不写任何 conf。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 测试可用 COMPLIANCE_ROOT 指向临时目录（只放最小 conf 结构），生产用仓库根。 */
const ROOT = process.env.COMPLIANCE_ROOT
  ? resolve(process.env.COMPLIANCE_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const CONF = join(ROOT, 'conf');
const OUT = join(ROOT, 'reports', 'data-provenance.json');
const CONFIDENCE = new Set(['高', '中', '低']);
const LEVELS = new Set(['史实', '虚构/传说']);

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const files = [];
let totalEntries = 0;

/** 登记一个数据文件并核对每条目：ok 由 checker 返回 {id?, problem?} 数组。 */
function scanFile(rel, count, checker) {
  const abs = join(CONF, rel);
  if (!existsSync(abs)) {
    files.push({ file: rel, exists: false, count: 0, missing: [{ id: '-', problem: '文件缺失' }] });
    return;
  }
  const json = readJson(abs);
  const entries = count(json);
  const missing = [];
  for (const [id, problem] of checker(json, entries)) missing.push({ id: String(id), problem });
  files.push({ file: rel, exists: true, count: entries.length, missing });
  totalEntries += entries.length;
}

/* ---------------- 1) 事件 150 条：source{id, confidence} ---------------- */
for (const rel of ['campaign/events.json', 'campaign/events-extra.json']) {
  scanFile(rel, (j) => j.events, (j, entries) => {
    const out = [];
    for (const e of entries) {
      const s = e.source || {};
      if (!s.id || typeof s.id !== 'string' || !s.id.trim()) out.push([e.id, 'source.id 缺失或为空']);
      else if (!CONFIDENCE.has(s.confidence)) out.push([e.id, `source.confidence 非法（${JSON.stringify(s.confidence)}）`]);
    }
    return out;
  });
}

/* ---------------- 2) 宿命 24 组：source{id, confidence} ---------------- */
scanFile('campaign/fate-groups.json', (j) => j.groups, (j, entries) => {
  const out = [];
  for (const g of entries) {
    const s = g.source || {};
    if (!s.id || typeof s.id !== 'string' || !s.id.trim()) out.push([g.id, 'source.id 缺失或为空']);
    else if (!CONFIDENCE.has(s.confidence)) out.push([g.id, `source.confidence 非法（${JSON.stringify(s.confidence)}）`]);
  }
  return out;
});

/* ---------------- 3) 武将 240 位：source{ref, level, confidence} ---------------- */
scanFile('campaign/heroes-240.json', (j) => j.heroes, (j, entries) => {
  const out = [];
  for (const h of entries) {
    const s = h.source || {};
    if (!s.ref || typeof s.ref !== 'string' || !s.ref.trim() || s.ref === '－') out.push([h.name, 'source.ref 缺失']);
    else if (!LEVELS.has(s.level)) out.push([h.name, `source.level 非法（${JSON.stringify(s.level)}）`]);
    else if (!CONFIDENCE.has(s.confidence)) out.push([h.name, `source.confidence 非法（${JSON.stringify(s.confidence)}）`]);
    else if (s.confidence === '高' && s.level !== '史实') out.push([h.name, 'confidence=高 但 level 非史实（口径矛盾）']);
  }
  return out;
});

/* ---------------- 4) 六剧本：顶层 source + confidence + reviewed ---------------- */
const scDir = join(CONF, 'campaign', 'strategy', 'scenarios');
if (existsSync(scDir)) {
  const names = readdirSync(scDir).filter((f) => f.endsWith('.json'));
  const missing = [];
  let count = 0;
  for (const name of names) {
    const sc = readJson(join(scDir, name));
    count += 1;
    if (!sc.source || !String(sc.source).trim()) missing.push([name, 'source 缺失']);
    if (!CONFIDENCE.has(sc.confidence)) missing.push([name, `confidence 非法（${JSON.stringify(sc.confidence)}）`]);
    if (sc.reviewed !== false) missing.push([name, 'reviewed 必须显式 false（人工签核闸）']);
  }
  files.push({ file: 'campaign/strategy/scenarios/*.json', exists: true, count, missing });
  totalEntries += count;
} else {
  files.push({ file: 'campaign/strategy/scenarios/*.json', exists: false, count: 0, missing: [{ id: '-', problem: '目录缺失' }] });
}

/* ---------------- 5) 术语表：每条带数值来源 ---------------- */
scanFile('interaction/terms.json', (j) => j.terms, (j, entries) => {
  const out = [];
  for (const t of entries) {
    const src = t['数值来源'];
    if (!Array.isArray(src) || src.length === 0) out.push([t.id, '数值来源缺失或为空']);
  }
  return out;
});

/* ---------------- 6) 地图示意图声明 + UI 真实渲染 ---------------- */
const mapDeclPath = join(CONF, 'compliance', 'map-declaration.json');
const mapDecl = existsSync(mapDeclPath) ? readJson(mapDeclPath) : null;
const uiSource = readFileSync(join(ROOT, 'server', 'skills.js'), 'utf8');
const mapProblems = [];
if (!mapDecl) mapProblems.push('conf/compliance/map-declaration.json 缺失');
else {
  if (mapDecl.type !== 'schematic_projection') mapProblems.push('type 必须为 schematic_projection');
  if (!mapDecl.statement || !String(mapDecl.statement).includes('非标准行政地图')) {
    mapProblems.push('statement 必须含「非标准行政地图」');
  }
  if (!uiSource.includes('非标准行政地图')) mapProblems.push('server/skills.js 未渲染示意图声明（UI 声明缺失）');
}

/* ---------------- 7) 未授权第三方资产（读台账，仅汇总） ---------------- */
let unlicensed = [];
const provPath = join(CONF, 'compliance', 'provenance.json');
if (existsSync(provPath)) {
  const prov = readJson(provPath);
  unlicensed = (prov.assets || [])
    .filter((a) => a.status === 'derived_unlicensed')
    .map((a) => ({ path: a.path, kind: a.kind, action: a.action }));
}

/* ---------------- 汇总与输出 ---------------- */
const missingTotal = files.reduce((n, f) => n + f.missing.length, 0);
const ok = missingTotal === 0 && mapProblems.length === 0 && files.every((f) => f.exists);
const report = {
  generatedAt: new Date().toISOString(),
  ok,
  totals: { files: files.length, entries: totalEntries, missing: missingTotal, mapProblems: mapProblems.length, unlicensed: unlicensed.length },
  files,
  map: { declaration: mapDecl?.statement || null, problems: mapProblems },
  unlicensed,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok, totals: report.totals }));
} else {
  console.log(`数据溯源：${report.totals.files} 个文件 / ${totalEntries} 条，缺口 ${missingTotal}`);
  console.log(`地图声明：${mapProblems.length ? mapProblems.join('；') : '已登记且 UI 已渲染'}`);
  console.log(`未授权第三方资产：${unlicensed.length} 项（发行前须换皮/授权，详见 provenance 台账）`);
  for (const f of files) {
    if (f.missing.length) for (const m of f.missing.slice(0, 10)) console.log(`  ✗ ${f.file} #${m.id}: ${m.problem}`);
    if (f.missing.length > 10) console.log(`  … 另 ${f.missing.length - 10} 条`);
  }
  console.log(`报告：${OUT}`);
}
process.exit(ok ? 0 : 1);
