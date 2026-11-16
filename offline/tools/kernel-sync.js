#!/usr/bin/env node
/**
 * 内核同步脚本（P12 · 收口 SDD DEV-26）。
 *
 * 历史：battle-core/src/*.ts（TS 源）→ `npm run build` → battle-core/build/src/*.js
 *      → 人工拷贝到 offline/kernel/*.js（服务端唯一运行时内核）。
 *      「靠文档约定 + check-release 出厂源码清单兜底」——本脚本把这条链自动化。
 *
 * 用法（在 offline/ 目录）：
 *   node tools/kernel-sync.js            构建 + 校验：不同步则列出差异并退出码 1
 *   node tools/kernel-sync.js --write    构建 + 校验 + 把差异文件写进 offline/kernel/
 *   node tools/kernel-sync.js --no-build 跳过 tsc（只比对既有 build/src 产物，CI 复查用）
 *
 * 纪律：
 *  - offline/kernel/ 是**派生物**，禁止手改；要改行为只能改 battle-core/src/ 再跑本脚本；
 *  - 同步后必须重跑 `npm test`（含内核一致性用例）与全套取证；
 *  - web/ 与协议层与本脚本无关。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OFFLINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = resolve(OFFLINE, '../battle-core');
const SRC_BUILD = join(CORE, 'build', 'src');
const DEST = join(OFFLINE, 'kernel');

const write = process.argv.includes('--write');
const noBuild = process.argv.includes('--no-build');
const jsonOut = process.argv.includes('--json');

function fail(msg) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`[kernel-sync] ${msg}`);
  process.exit(1);
}

if (!existsSync(join(CORE, 'package.json'))) fail(`找不到 battle-core：${CORE}`);
if (!noBuild) {
  /* Windows 下 npm.cmd 是 cmd shim，shell:false 会静默失败（status 非 0 且无输出），
     必须走 shell；POSIX 下 npm 是 sh 脚本，同样安全。 */
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: CORE, stdio: jsonOut ? 'ignore' : 'inherit', shell: true,
  });
  if (r.status !== 0) fail('tsc 构建失败：先修 battle-core/src 的编译错误再同步');
}
if (!existsSync(SRC_BUILD)) fail(`构建产物不存在：${SRC_BUILD}（先 npm run build）`);

/* 源码比产物新 → build 已过期，比对结果是假的，必须拦下 */
let newestSrc = 0;
for (const f of readdirSync(join(CORE, 'src'))) {
  newestSrc = Math.max(newestSrc, statSync(join(CORE, 'src', f)).mtimeMs);
}
let newestBuild = 0;
for (const f of readdirSync(SRC_BUILD)) {
  newestBuild = Math.max(newestBuild, statSync(join(SRC_BUILD, f)).mtimeMs);
}
if (newestSrc > newestBuild) fail('battle-core/src 比 build/src 新：tsc 产物已过期，请去掉 --no-build 重跑');

const changed = [];
const missing = [];
let same = 0;
for (const f of readdirSync(SRC_BUILD).sort()) {
  const from = join(SRC_BUILD, f);
  const to = join(DEST, f);
  if (!existsSync(to)) { missing.push(f); continue; }
  const a = readFileSync(from);
  const b = readFileSync(to);
  if (!a.equals(b)) changed.push(f);
  else same += 1;
}
const extra = existsSync(DEST)
  ? readdirSync(DEST).filter((f) => !existsSync(join(SRC_BUILD, f)))
  : [];

if (!write) {
  const ok = changed.length === 0 && missing.length === 0;
  if (jsonOut) {
    console.log(JSON.stringify({ ok, same, changed, missing, extra, dest: DEST }));
  } else {
    console.log(`[kernel-sync] 一致 ${same} 个文件；差异 ${changed.length}；缺失 ${missing.length}；多余 ${extra.length}`);
    for (const f of changed) console.log(`  差异: ${f}`);
    for (const f of missing) console.log(`  缺失: ${f}`);
    for (const f of extra) console.log(`  多余（kernel 有、build 无）: ${f}`);
    if (!ok) {
      console.log('[kernel-sync] 运行 `node tools/kernel-sync.js --write` 同步，然后重跑 npm test 与全套取证。');
      process.exit(1);
    }
    console.log('[kernel-sync] OK：offline/kernel 与 battle-core/build/src 逐字节一致。');
  }
  process.exit(0);
}

if (!existsSync(DEST)) mkdirSync(DEST, { recursive: true });
const written = [...changed, ...missing];
for (const f of written) copyFileSync(join(SRC_BUILD, f), join(DEST, f));
console.log(`[kernel-sync] 已同步 ${written.length} 个文件到 offline/kernel/：${written.join(', ') || '（无）'}`);
console.log('[kernel-sync] 下一步：重跑 npm test + 打包 + 全套取证（kernel 是运行时权威产物）。');
if (extra.length) console.log(`[kernel-sync] 提醒：kernel 里多出 ${extra.length} 个 build 没有的文件，请人工确认是否该删。`);
