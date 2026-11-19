/**
 * 并行测试私有 GM 覆盖层。
 *
 * `npm test` 以 --test-concurrency=4 运行，多个测试文件同时读 conf/campaign/overrides.json；
 * 只要其中一个进程在写，另一个进程的 loadConfig 就可能读到半成品，表现为
 * 「编辑器保存不保留战法等级」「主公六维不等于配置值」这类偶发假红。
 *
 * 必须在任何 server/config.js / server/skills.js 静态导入之前 import 本文件：
 * ESM 按 import 声明顺序求值，本文件先跑就能让 gm/overrides.js 绑定私有副本。
 */
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.SLG_OVERRIDES_FILE) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const REAL = join(ROOT, 'conf', 'campaign', 'overrides.json');
  const PRIVATE_DIR = mkdtempSync(join(tmpdir(), 'slg-test-overrides-'));
  const PRIVATE = join(PRIVATE_DIR, 'overrides.json');
  if (existsSync(REAL)) copyFileSync(REAL, PRIVATE);
  else writeFileSync(PRIVATE, JSON.stringify({ generals: {} }, null, 2));
  process.env.SLG_OVERRIDES_FILE = PRIVATE;
}
