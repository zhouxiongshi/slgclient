/**
 * 术语覆盖率核查（GDD §14.2-5 / §10.5）。
 *
 * 三向检查：
 *   1. 词表自体：schema 字段齐全、id 唯一、关联词条不悬挂、简述非空。
 *   2. 注入层文案扫描：UI 源码里出现「术语名称」的行，若同时出现「未收录的
 *      专有名词」则报警——专有名词判定：来自 GDD 核心名词表（本文件内置），
 *      这些名词一旦在 UI 出现就必须有词条，否则玩家会撞到未解释名词。
 *   3. 词条被引用检查：核心名词里被 UI 实际使用的，必须都已有词条（覆盖率 100%）。
 *
 * 输出 reports/terms.json；有问题退出码 1（可接 CI / check-release）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERMS_PATH = path.join(ROOT, 'conf', 'interaction', 'terms.json');
const UI_FILES = ['server/skills.js', 'server/panels-ui.js', 'server/interaction-ui.js'];
const REPORT_DIR = path.join(ROOT, 'reports');

/* GDD 明确要求「出现即必须有词条」的核心名词（§10.5：不允许任何未解释名词）。
   这里列的是「玩家会看到」的名词；新增机制名词先加词条再上 UI。 */
const CORE_NOUNS = [
  '五维', '相性', '义理', '忠诚', '欠饷', '叛逃', '恩义', '传闻', '宿命',
  '亲爱', '厌恶', '姻亲', '宿敌', '同乡', '代将', '举义',
  '战法', '战位', '发动率', '兵种克制', '士气', '溃败', '水战', '火攻',
  '编队', '出征', '行军', '粮道', '断粮', '运输', '城库', '国库', '双账本',
  '跨城调运', '可持续养兵', '固定支出', '反通胀三闸',
  '开垦', '招商', '募兵', '修城', '赈灾', '兴学', '招抚', '屯田', '练兵', '修路', '侦察', '离间',
  '内政任务', '委任', '建言', '置信度', '无事可做检测',
  '外交态度', '停战', '通行权', '结盟', '联姻', '理由链',
  '威权', '信义', '仁望', '江表威望', '威慑',
  '推演', '情报区间', '临阵变招', '确认锁种子', '转折点',
  '破产', '兵尽', '无将', '迁都', '结局', '史实节点', '互斥', '出戏防线',
  '寿命判定', '履历', '证据', '确定性', '战报', '情报覆盖', '透镜', '旬',
  '旬', '人口', '民心', '治安', '灾害', '预警', '归因', '征兵', '兵役',
  '在野', '出仕', '名声', '招降', '俘虏', '成功率',
  '守城', '攻城', '蚁附', '风向预报', '追击',
  '快捷键', '队列', '军师', '桃园', '隆中对',
];

const problems = [];
const warnings = [];

/* ---------- 1. 词表自体 ---------- */
let doc;
try {
  doc = JSON.parse(readFileSync(TERMS_PATH, 'utf8'));
} catch (e) {
  console.error('[check-terms] 词表解析失败:', e.message);
  process.exit(1);
}
const terms = Array.isArray(doc.terms) ? doc.terms : [];
if (terms.length < 120) problems.push(`词条数 ${terms.length} < 120（GDD §10.5 目标）`);

const ids = new Set();
for (const t of terms) {
  if (ids.has(t.id)) problems.push(`词条 id 重复: ${t.id}`);
  ids.add(t.id);
  for (const f of ['id', '名称', '分类', '简述', '数值来源', '关联词条', '证据级别', 'source_id', 'confidence']) {
    if (t[f] == null || (Array.isArray(t[f]) && t[f].length === 0 && f !== '数值来源')) {
      problems.push(`词条 ${t.id} 缺字段 ${f}`);
    }
  }
  if (!t.简述 || String(t.简述).length < 10) problems.push(`词条 ${t.id} 简述过短`);
}
for (const t of terms) {
  for (const r of t.关联词条 || []) {
    if (!ids.has(r)) problems.push(`词条 ${t.id} 关联词条悬挂: ${r}`);
  }
}

/* ---------- 2/3. UI 文案扫描 ---------- */
/* 名称匹配口径：词条名称可带修饰（如「确定性内核」「粮道／兵站」）。
   UI 名词算「有词条」当且仅当：① 有名称完全相等的词条；② 该名称是某词条
   名称按「／」分段后的一段；③ 某词条名称包含该名词（「军师建言」⊃ 军师）。 */
const nameIndex = new Map(terms.map((t) => [t.名称, t]));
function findTerm(noun) {
  if (nameIndex.has(noun)) return nameIndex.get(noun);
  for (const t of terms) {
    if (String(t.名称).split('／').includes(noun)) return t;
  }
  for (const t of terms) {
    if (String(t.名称).includes(noun)) return t;
  }
  return null;
}
const usedNames = new Set();
const scanned = {};
for (const rel of UI_FILES) {
  const abs = path.join(ROOT, rel);
  let src = '';
  try { src = readFileSync(abs, 'utf8'); } catch { warnings.push(`文件缺失: ${rel}`); continue; }
  scanned[rel] = { bytes: src.length, hits: 0, unknown: [] };
  for (const noun of CORE_NOUNS) {
    if (src.includes(noun)) {
      usedNames.add(noun);
      scanned[rel].hits += 1;
      if (!findTerm(noun)) {
        problems.push(`UI「${rel}」使用了名词「${noun}」但词表无词条（玩家会撞到未解释名词）`);
      }
    }
  }
}

const coverage = usedNames.size
  ? [...usedNames].filter((n) => findTerm(n)).length / usedNames.size
  : 0;

mkdirSync(REPORT_DIR, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  terms: terms.length,
  coreNouns: CORE_NOUNS.length,
  usedInUI: usedNames.size,
  coverage: Math.round(coverage * 100) + '%',
  problems, warnings, scanned,
};
writeFileSync(path.join(REPORT_DIR, 'terms.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(`[check-terms] 词条 ${terms.length} / 核心名词 ${CORE_NOUNS.length} / UI 使用 ${usedNames.size} / 覆盖率 ${report.coverage}`);
for (const p of problems.slice(0, 40)) console.error('  ✗ ' + p);
if (problems.length > 40) console.error(`  … 共 ${problems.length} 项`);
if (problems.length) process.exit(1);
console.log('[check-terms] 通过');
