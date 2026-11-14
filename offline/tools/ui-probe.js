/**
 * UX 取证：真实启动 Electron，走一遍「征兵 / 战前推演 / 战报」三条最容易出问题的路，
 * 留 DOM 文本 + 控制台错误 + 截图。复现玩家报障用。
 *
 *   node tools/ui-probe.js
 *
 * 与 smoke/perf 同一套启动纪律：清 ELECTRON_RUN_AS_NODE、隔离 userData。
 */
import { spawn } from 'node:child_process';
import { assertPortsFree } from './lib/port-guard.js';
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

/* 上一轮残留进程会让本次探测静默失败（报告是上一次的旧文件），先清端口 */
assertPortsFree([8088, 8004], 'slg-offline:ui-probe');

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
  for (const key of ['levy', 'preview', 'battle', 'reports', 'ui', 'scroll']) {
    const v = s[key];
    if (!v) { console.log(`  ? ${key}：无结果`); continue; }
    console.log(`  ${v.ok ? '✓' : '✗'} ${key}${v.reason ? '（' + v.reason + '）' : ''}`
      + (v.error ? ' 错误：' + String(v.error).slice(0, 200) : ''));
    /* 滚动类结果逐条打印「升级前后位置」，否则「✓」看不出量到了什么 */
    (v.cases || []).forEach((c) => {
      if (c.skipped) { console.log(`      · ${c.where}：跳过（${c.skipped}）`); return; }
      console.log(`      · ${c.where}：升级前 ${c.before}px → 升级后 ${c.after}px`
        + `（Δ ${c.delta}px${c.kept ? '，位置保持' : '，跳了'}）`
        + `　卡片节点${c.cardNodeReplaced ? '已重建（走整页重绘，靠还原兜住）' : '复用（只重画内容，未重绘页面）'}`
        + (c.bodyScrollable != null ? `　可滚动高度 ${c.bodyScrollable}px` : '')
        + (c.activeTab ? `　当前页签「${c.activeTab}」` : '')
        + (c.oldCardConnected === false ? '　旧卡片已摘除' : '')
        + (c.toast ? `　toast「${c.toast}」` : '')
        + (c.pageAlive === false ? '　页面已关闭' : ''));
    });
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
