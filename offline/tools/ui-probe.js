/**
 * UX 取证：真实启动 Electron，走一遍「征兵 / 战前推演 / 战报」三条最容易出问题的路，
 * 留 DOM 文本 + 控制台错误 + 截图。复现玩家报障用。
 *
 *   node tools/ui-probe.js
 *
 * 与 smoke/perf 同一套启动纪律：清 ELECTRON_RUN_AS_NODE、隔离 userData。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLG = resolve(ROOT, '..');
const tag = process.env.SLG_SMOKE_TAG || 'original';

const electronCandidates = [
  process.env.SLG_ELECTRON,
  join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(SLG, 'standalone', 'node_modules', 'electron', 'dist', 'electron.exe'),
].filter(Boolean);
const exe = electronCandidates.find((p) => existsSync(p)) || electronCandidates[0];
if (!existsSync(exe)) {
  console.error(`[slg-offline:probe] 找不到 Electron：${exe}`);
  process.exit(2);
}

const reportsDir = join(ROOT, 'reports');
mkdirSync(reportsDir, { recursive: true });

const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WORKBUDDY_CLIENT_USER_AGENT']) delete env[key];
env.SLG_DIAG = '1';
env.SLG_SMOKE_EXIT = '1';
env.SLG_SMOKE_TAG = tag;
env.SLG_SMOKE_REPORT_DIR = reportsDir;

const child = spawn(exe, [ROOT], { env, cwd: ROOT, stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`[slg-offline:probe] 启动失败：${err.message}`);
  process.exitCode = 2;
});
child.on('exit', (code) => {
  const p = join(reportsDir, `ui-probe-${tag}.json`);
  if (!existsSync(p)) {
    console.error(`[slg-offline:probe] 未生成报告（退出码 ${code}）：${p}`);
    process.exitCode = 1;
    return;
  }
  const r = JSON.parse(readFileSync(p, 'utf8'));
  const s = r.scenarios || {};
  console.log('');
  console.log('[slg-offline:probe] ── 取证结果 ──');
  for (const key of ['levy', 'preview', 'battle', 'reports', 'ui']) {
    const v = s[key];
    if (!v) { console.log(`  ? ${key}：无结果`); continue; }
    console.log(`  ${v.ok ? '✓' : '✗'} ${key}${v.reason ? '（' + v.reason + '）' : ''}`
      + (v.error ? ' 错误：' + String(v.error).slice(0, 200) : ''));
  }
  if (r.consoleErrors?.length) {
    console.log('[slg-offline:probe] 控制台错误：');
    r.consoleErrors.slice(0, 12).forEach((e) => console.log('   ' + String(e).slice(0, 300)));
  }
  if (r.pageErrors?.length) {
    console.log('[slg-offline:probe] 页内错误：');
    r.pageErrors.slice(0, 12).forEach((e) => console.log('   ' + JSON.stringify(e).slice(0, 300)));
  }
  console.log(`[slg-offline:probe] 报告 ${p}`);
});
