/**
 * 一键 UI 全路径审计：真实启动 Electron，把每个面板/页签都点一遍。
 *
 *   node tools/ui-audit.js              # 源码目录态
 *   node tools/ui-audit.js --packaged   # 打包产物态（需先 npm run pack）
 *
 * 与 smoke.js 共享同一套启动约束：必须清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，
 * 否则 Electron 会退化成纯 Node 进程。
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
  console.error(`[slg-offline:audit] 找不到 Electron：${exe}`);
  console.error(packaged ? '请先执行 npm run pack' : '可用 SLG_ELECTRON 指定 Electron 可执行文件');
  process.exit(2);
}

const reportsDir = join(ROOT, 'reports');
mkdirSync(reportsDir, { recursive: true });

const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WORKBUDDY_CLIENT_USER_AGENT']) delete env[key];
env.SLG_AUDIT = '1';
env.SLG_SMOKE_EXIT = '1';
env.SLG_SMOKE_TAG = tag;
env.SLG_SMOKE_REPORT_DIR = reportsDir;

const args = packaged ? [] : [ROOT];
const child = spawn(exe, args, { env, cwd: ROOT, stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`[slg-offline:audit] 启动失败：${err.message}`);
  process.exitCode = 2;
});

child.on('exit', (code) => {
  const reportPath = join(reportsDir, `ui-audit-${tag}.json`);
  if (existsSync(reportPath)) {
    const r = JSON.parse(readFileSync(reportPath, 'utf8'));
    console.log(`[slg-offline:audit] ${tag}: passed=${r.passed} paths=${r.counts?.paths} failed=${JSON.stringify(r.failed)}`);
    console.log(`[slg-offline:audit] 报告 ${reportPath}`);
    if (!r.passed) process.exitCode = 1;
  }
  if (code && !process.exitCode) process.exitCode = code;
});
