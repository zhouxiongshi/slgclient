/**
 * 一键运行时冒烟：真实启动 Electron + 原 web-desktop。
 *
 *   node tools/smoke.js              # 源码目录态
 *   node tools/smoke.js --packaged   # 打包产物态（需先 npm run pack）
 *
 * 关键点：必须清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，
 * 否则 Electron 会退化成纯 Node 进程（app / BrowserWindow 全部 undefined）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLG = resolve(ROOT, '..');
const packaged = process.argv.includes('--packaged');
const tag = packaged ? 'packaged' : 'original';

// Electron 候选：环境变量 → 仓库内 node_modules → 旧 standalone 布局
const electronCandidates = [
  process.env.SLG_ELECTRON,
  join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(SLG, 'standalone', 'node_modules', 'electron', 'dist', 'electron.exe'),
].filter(Boolean);
const exe = packaged
  ? join(ROOT, 'build', 'SLG-Offline-win32-x64', 'SLG-Offline.exe')
  : electronCandidates.find((p) => existsSync(p)) || electronCandidates[0];

if (!existsSync(exe)) {
  console.error(`[slg-offline:smoke] 找不到 Electron：${exe}`);
  console.error(packaged ? '请先执行 npm run pack' : '可用 SLG_ELECTRON 指定 Electron 可执行文件');
  process.exit(2);
}

const reportsDir = join(ROOT, 'reports');
mkdirSync(reportsDir, { recursive: true });

const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WORKBUDDY_CLIENT_USER_AGENT']) delete env[key];
env.SLG_SMOKE = '1';
env.SLG_SMOKE_EXIT = '1';
env.SLG_SMOKE_TAG = tag;
env.SLG_SMOKE_REPORT_DIR = reportsDir;

const args = packaged ? [] : [ROOT];
const child = spawn(exe, args, { env, cwd: ROOT, stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`[slg-offline:smoke] 启动失败：${err.message}`);
  process.exitCode = 2;
});

child.on('exit', (code) => {
  const reportPath = join(reportsDir, `smoke-${tag}.json`);
  if (existsSync(reportPath)) {
    const r = JSON.parse(readFileSync(reportPath, 'utf8'));
    console.log(`[slg-offline:smoke] ${tag}: passed=${r.passed} checks=${r.checks.length} failed=${JSON.stringify(r.failed)}`);
    console.log(`[slg-offline:smoke] 报告 ${reportPath}`);
    if (!r.passed) process.exitCode = 1;
  }
  if (code && !process.exitCode) process.exitCode = code;
});
