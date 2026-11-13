/**
 * 一键布局与美观审计：真实启动 Electron，5 档分辨率 × 4 个界面状态 + 字号三档。
 *
 *   node tools/layout-audit.js
 *   node tools/layout-audit.js --packaged
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
  console.error(`[slg-offline:layout] 找不到 Electron：${exe}`);
  process.exit(2);
}

const reportsDir = join(ROOT, 'reports');
mkdirSync(reportsDir, { recursive: true });

const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WORKBUDDY_CLIENT_USER_AGENT']) delete env[key];
env.SLG_LAYOUT = '1';
env.SLG_SMOKE_EXIT = '1';
env.SLG_SMOKE_TAG = tag;
env.SLG_SMOKE_REPORT_DIR = reportsDir;

const args = packaged ? [] : [ROOT];
const child = spawn(exe, args, { env, cwd: ROOT, stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`[slg-offline:layout] 启动失败：${err.message}`);
  process.exitCode = 2;
});

child.on('exit', (code) => {
  const reportPath = join(reportsDir, `layout-${tag}.json`);
  if (!existsSync(reportPath)) {
    console.error(`[slg-offline:layout] 未生成报告（退出码 ${code}）`);
    process.exitCode = 1;
    return;
  }
  const r = JSON.parse(readFileSync(reportPath, 'utf8'));
  console.log('');
  console.log('[slg-offline:layout] ── 布局 ──');
  for (const v of r.viewports || []) {
    const states = Object.entries(v.states || {}).map(([k, s]) => {
      const off = (s.offscreen || []).length;
      const clip = (s.clipped || []).length;
      const wins = (s.mainWins || []).length;
      return `${k}:${off ? `溢出${off}` : 'ok'}/裁切${clip}/窗${wins}`;
    });
    console.log(`  ${v.req.w}×${v.req.h}  ${states.join('  ')}`);
  }
  console.log('[slg-offline:layout] ── 字号三档 ──');
  for (const f of r.fontTiers || []) {
    console.log(`  ${f.viewport.join('×')} ${f.tier}% → 裁切 ${f.clippedCount} 处`);
  }
  console.log('[slg-offline:layout] ── 美观 ──');
  for (const v of (r.aesthetics && r.aesthetics.verdicts) || []) {
    console.log(`  ${v.ok ? '✓' : '⚠'} ${v.id} ${v.name}：${v.detail}`);
  }
  console.log(`[slg-offline:layout] ${tag}: passed=${r.passed} 硬问题=${(r.issues || []).filter((i) => i.kind === 'offscreen' || i.kind === 'multi-window').length}`
    + ` pageErrors=${(r.pageErrors || []).length} consoleErrors=${(r.consoleErrors || []).length}`);
  console.log(`[slg-offline:layout] 报告 ${reportPath}`);
  if (r.fatal) console.log(`[slg-offline:layout] fatal：${r.fatal}`);
  if (!r.passed) process.exitCode = 1;
});
