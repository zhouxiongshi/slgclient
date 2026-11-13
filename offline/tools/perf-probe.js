/**
 * 一键性能探针：真实启动 Electron + 原 web-desktop，量 GDD §11.5 六项预算。
 *
 *   node tools/perf-probe.js              # 源码目录态
 *   node tools/perf-probe.js --packaged   # 打包产物态（需先 pack）
 *
 * 与 smoke/ui-audit 同一套启动纪律：清 ELECTRON_RUN_AS_NODE、隔离 userData、
 * 读 reports/perf-<tag>.json 汇总。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLG = resolve(ROOT, '..');
const packaged = process.argv.includes('--packaged');
const tag = packaged ? 'packaged' : 'original';

const electronCandidates = [
  process.env.SLG_ELECTRON,
  join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(SLG, 'standalone', 'node_modules', 'electron', 'dist', 'electron.exe'),
].filter(Boolean);
const exe = packaged
  ? join(ROOT, 'build', 'SLG-Offline-win32-x64', 'SLG-Offline.exe')
  : electronCandidates.find((p) => existsSync(p)) || electronCandidates[0];

if (!existsSync(exe)) {
  console.error(`[slg-offline:perf] 找不到 Electron：${exe}`);
  console.error(packaged ? '请先执行 npm run pack' : '可用 SLG_ELECTRON 指定 Electron 可执行文件');
  process.exit(2);
}

const reportsDir = join(ROOT, 'reports');
mkdirSync(reportsDir, { recursive: true });

const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WORKBUDDY_CLIENT_USER_AGENT']) delete env[key];
env.SLG_PERF = '1';
env.SLG_SMOKE_EXIT = '1';
env.SLG_SMOKE_TAG = tag;
env.SLG_SMOKE_REPORT_DIR = reportsDir;

const args = packaged ? [] : [ROOT];
const child = spawn(exe, args, { env, cwd: ROOT, stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`[slg-offline:perf] 启动失败：${err.message}`);
  process.exitCode = 2;
});

child.on('exit', (code) => {
  const reportPath = join(reportsDir, `perf-${tag}.json`);
  if (!existsSync(reportPath)) {
    console.error(`[slg-offline:perf] 未生成报告（退出码 ${code}）：${reportPath}`);
    process.exitCode = 1;
    return;
  }
  const r = JSON.parse(readFileSync(reportPath, 'utf8'));
  console.log('');
  console.log('[slg-offline:perf] ── GDD §11.5 预算实测 ──');
  for (const it of r.items) {
    const info = it.budget == null;
    const mark = info ? '·' : it.ok === true ? '✓' : it.ok === false ? '✗' : '?';
    console.log(`  ${mark} ${it.id} ${it.name}：${it.value == null ? '未测到' : it.value + it.unit}`
      + (info ? '（仅记录）' : `（预算 ${it.budget}${it.unit}）`) + (it.note ? ' · ' + it.note : ''));
  }
  console.log(`[slg-offline:perf] ${tag}: passed=${r.passed} over=[${(r.overBudget || []).join(',')}]`
    + ` pageErrors=${(r.pageErrors || []).length} consoleErrors=${(r.consoleErrors || []).length}`);
  console.log(`[slg-offline:perf] 报告 ${reportPath}`);
  if (r.fatal) console.log(`[slg-offline:perf] fatal：${r.fatal}`);
  if (!r.passed) process.exitCode = 1;
});
