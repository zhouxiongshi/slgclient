/**
 * 一键「真实鼠标」试玩：启动 Electron，按真实坐标把整条游戏流程点一遍。
 *
 *   node tools/mouse-playtest.js               # 源码目录态
 *   node tools/mouse-playtest.js --packaged    # 打包产物态
 *
 * 与 ui-audit 的区别：ui-audit 用 element.click()，本工具用
 * webContents.sendInputEvent 派发 mouseMove/mousePressed/mouseReleased，
 * 并在点击前用 elementFromPoint 校验目标没被其它窗口遮挡。
 */
import { spawn } from 'node:child_process';
import { assertPortsFree } from './lib/port-guard.js';
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
  console.error(`[slg-offline:mouse] 找不到 Electron：${exe}`);
  process.exit(2);
}
const reportsDir = join(ROOT, 'reports');
mkdirSync(reportsDir, { recursive: true });

const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WORKBUDDY_CLIENT_USER_AGENT']) delete env[key];
env.SLG_MOUSE = '1';
env.SLG_SMOKE_EXIT = '1';
env.SLG_SMOKE_TAG = tag;
env.SLG_SMOKE_REPORT_DIR = reportsDir;

const args = packaged ? [] : [ROOT];
/* 上一轮残留进程会让本次探测静默失败（报告是上一次的旧文件），先清端口 */
assertPortsFree([8088, 8004], 'slg-offline:mouse-playtest');

const child = spawn(exe, args, { env, cwd: ROOT, stdio: 'inherit' });
child.on('error', (err) => { console.error(`[slg-offline:mouse] 启动失败：${err.message}`); process.exitCode = 2; });
child.on('exit', (code) => {
  const p = join(reportsDir, `mouse-playtest-${tag}.json`);
  if (existsSync(p)) {
    const r = JSON.parse(readFileSync(p, 'utf8'));
    console.log(`[slg-offline:mouse] ${tag}: passed=${r.passed} steps=${r.counts?.steps} failed=${JSON.stringify(r.failed)}`);
    console.log(`[slg-offline:mouse] 报告 ${p}`);
    if (!r.passed) process.exitCode = 1;
  }
  if (code && !process.exitCode) process.exitCode = code;
});
