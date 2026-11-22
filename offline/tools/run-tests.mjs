/**
 * 全量单测入口：固定「性能用例先跑 + 单文件串行」。
 *
 * 背景：`p10-preview-consistency.test.js` 的 50ms 硬闸测的是 previewAssault 的
 * 内在成本。多文件并发 runner 启动时会与其余测试文件的模块加载/JS 预热抢占 CPU，
 * 本机实测 7/21/41 次采样最小值都卡在 50.5~50.7ms；单独跑或放在队首串行则稳定
 * 21~32ms。这里不改预算、不改测试内容，只把测量环境固定下来：
 *   1. 性能用例单独开一个进程先跑完，避免测试 runner 预加载其余文件的模块噪声；
 *   2. 余下用例再以 --test-concurrency=1 串行跑，避免同机其它测试进程抢占采样窗口。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');
const PRIORITY = 'p10-preview-consistency.test.js';
const files = readdirSync(TESTS).filter((f) => f.endsWith('.test.js')).sort();
if (!files.includes(PRIORITY)) {
  console.error(`[run-tests] 缺少性能基准用例 ${PRIORITY}`);
  process.exit(1);
}
function run(list) {
  return spawnSync(process.execPath, [
    '--test', '--test-concurrency=1', '--test-timeout=60000', ...list,
  ], { cwd: ROOT, stdio: 'inherit' });
}

/* ① 先单独跑性能基准：独立进程，不预加载任何其它测试文件。 */
const perf = run([join(TESTS, PRIORITY)]);
if (perf.status !== 0) process.exit(perf.status == null ? 1 : perf.status);
/* ② 再跑其余用例，仍然单文件串行。 */
const rest = run(files.filter((f) => f !== PRIORITY).map((f) => join(TESTS, f)));
process.exit(rest.status == null ? 1 : rest.status);
