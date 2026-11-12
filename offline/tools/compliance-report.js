/**
 * 合规台账核查（U26）。
 *
 * 做三件事，全部可复跑：
 *  1. **覆盖性**：台账（conf/compliance/provenance.json）登记的路径必须存在；
 *     同时把仓库里「疑似第三方派生」的数据文件扫一遍，凡未登记的列为缺口。
 *  2. **禁入物**：按台账 forbidden_artifacts 扫 .dll/.pdb/.il/.exe 与
 *     「完整原始版 / export/ / 反汇编 / decompiled」路径片段，命中即失败
 *     （battle-core 的 README 已写明 610 类结构与 IL 不得随包分发）。
 *  3. **发行包**：build/SLG-Offline-win32-x64 存在时，同样扫一遍打包产物
 *     resources/app，确认 app.asar / app 目录里没有夹带禁入物。
 *
 * 用法：node tools/compliance-report.js [--json]
 * 退出码：0 = 台账完整且无禁入物；1 = 有缺口或禁入物。
 */
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const MANIFEST = join(ROOT, 'conf', 'compliance', 'provenance.json');
const OUT_DIR = join(ROOT, 'reports');

/** 疑似第三方派生：这些目录/后缀在仓库里出现就要求登记。 */
const DERIVED_GLOBS = [
  'offline/conf/skills.json',
  'offline/conf/library-skills.json',
  'offline/conf/skills-range.json',
  'offline/conf/relations.json',
  'offline/conf/interaction/terms.json',
  'offline/conf/panels/generals-lore.json',
  'offline/conf/campaign/strategy/map.json',
  'offline/conf/campaign/skill-source.json',
  'battle-core/config/battle_config.json',
];
/** 目录型登记项（数量按文件数算，不逐个列出）。 */
const DERIVED_DIRS = ['offline/web'];

function walk(dir, out = [], depth = 0) {
  if (!existsSync(dir) || depth > 12) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'build' || name === 'reports') continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
  return out;
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  // 统一去掉尾部斜杠，避免 "offline/web/" 与 "offline/web" 对不上
  const norm = (x) => String(x).replace(/[\\/]+$/, '');
  const declared = new Set(manifest.assets.map((a) => norm(a.path)));
  const problems = [];
  const warnings = [];

  /* ---------- 1. 台账覆盖性 ---------- */
  for (const a of manifest.assets) {
    const p = join(REPO, a.path);
    if (!existsSync(p)) problems.push({ kind: 'missing_asset', path: a.path, detail: '台账登记的文件不存在（改名或删除后要同步台账）' });
  }
  for (const rel of DERIVED_GLOBS) {
    if (existsSync(join(REPO, rel)) && !declared.has(norm(rel))) {
      problems.push({ kind: 'undeclared', path: rel, detail: '疑似第三方派生数据未登记到合规台账' });
    }
  }
  for (const rel of DERIVED_DIRS) {
    if (existsSync(join(REPO, rel)) && !declared.has(norm(rel))) {
      problems.push({ kind: 'undeclared', path: rel, detail: '目录型派生资产未登记（如原构建产物）' });
    }
  }
  const unlicensed = manifest.assets.filter((a) => a.status === 'derived_unlicensed');
  if (unlicensed.length) {
    warnings.push({
      kind: 'unlicensed',
      count: unlicensed.length,
      paths: unlicensed.map((a) => a.path),
      detail: '以下资产属未授权第三方派生，商业发行前必须换皮或取得授权',
    });
  }

  /* ---------- 2. 仓库禁入物 ---------- */
  const forbiddenExt = new Set(manifest.forbidden_artifacts.extensions.map((e) => e.toLowerCase()));
  const forbiddenPatterns = manifest.forbidden_artifacts.path_patterns;
  const hits = [];
  for (const p of walk(REPO)) {
    const rel = relative(REPO, p).replace(/\\/g, '/');
    if (rel.startsWith('battle-core/node_modules/')) continue;
    const ext = extname(p).toLowerCase();
    if (forbiddenExt.has(ext)) {
      // .exe 只允许出现在 electron 打包脚本产出的 build 目录（已排除 build），仓库内出现即登记
      hits.push({ path: rel, why: `扩展名 ${ext}` });
      continue;
    }
    if (forbiddenPatterns.some((pat) => rel.includes(pat))) {
      hits.push({ path: rel, why: `路径含「${forbiddenPatterns.find((pat) => rel.includes(pat))}」` });
    }
  }
  for (const h of hits) problems.push({ kind: 'forbidden_artifact', ...h });

  /* ---------- 3. 发行包 ---------- */
  const packagedApp = join(ROOT, 'build', 'SLG-Offline-win32-x64', 'resources', 'app');
  let packaged = { scanned: false, files: 0, hits: [] };
  if (existsSync(packagedApp)) {
    const files = walk(packagedApp);
    packaged.scanned = true;
    packaged.files = files.length;
    for (const p of files) {
      const rel = relative(packagedApp, p).replace(/\\/g, '/');
      const ext = extname(p).toLowerCase();
      if (forbiddenExt.has(ext) || forbiddenPatterns.some((pat) => rel.includes(pat))) {
        packaged.hits.push({ path: rel, why: ext || '路径命中' });
      }
    }
    for (const h of packaged.hits) problems.push({ kind: 'forbidden_in_package', ...h });
  }

  const report = {
    generated_at: new Date().toISOString(),
    manifest: MANIFEST,
    asset_count: manifest.assets.length,
    unlicensed: unlicensed.map((a) => ({ path: a.path, kind: a.kind, action: a.action_before_release })),
    problems,
    warnings,
    packaged,
    ok: problems.length === 0,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'compliance.json'), JSON.stringify(report, null, 2), 'utf8');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`合规台账：${manifest.assets.length} 项，其中未授权派生 ${unlicensed.length} 项（发行前须换皮/授权）`);
    console.log(`问题 ${problems.length} 项，提示 ${warnings.length} 项`);
    for (const p of problems) console.log(`  ✗ [${p.kind}] ${p.path}${p.why ? `（${p.why}）` : ''} ${p.detail || ''}`);
    if (packaged.scanned) console.log(`发行包扫描：${packaged.files} 文件，禁入物 ${packaged.hits.length}`);
    console.log(`报告：${join(OUT_DIR, 'compliance.json')}`);
  }
  if (problems.length) process.exitCode = 1;
}

main();
