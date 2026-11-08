/**
 * 手工 portable Electron 打包（不引入 electron-builder 依赖）。
 * 关键：web/ 是原 web-desktop 构建产物的【逐字节副本】，
 *       pack 后会生成清单并逐个哈希比对，证明画面 100% 未被改动。
 */
import { cpSync, existsSync, mkdirSync, rmSync, renameSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLG = resolve(ROOT, '..');
// Electron dist：仓库内 node_modules（npm install 即得）优先，其次旧 standalone 布局，可用 SLG_ELECTRON_DIST 覆盖
const ELECTRON_DIST = process.env.SLG_ELECTRON_DIST
  || (existsSync(join(ROOT, 'node_modules', 'electron', 'dist'))
    ? join(ROOT, 'node_modules', 'electron', 'dist')
    : existsSync(join(SLG, 'standalone', 'node_modules', 'electron', 'dist'))
      ? join(SLG, 'standalone', 'node_modules', 'electron', 'dist')
      : join(ROOT, 'node_modules', 'electron', 'dist'));
// web 源：仓库布局优先（offline/web 即构建产物副本），其次旧 runtime 构建目录
const WEB_SRC = existsSync(join(ROOT, 'web', 'index.html'))
  ? join(ROOT, 'web')
  : resolve(SLG, 'runtime', 'client-src', 'build', 'web-desktop');
const OUT = resolve(ROOT, 'build', 'SLG-Offline-win32-x64');
const APP = join(OUT, 'resources', 'app');
const REPORTS = join(ROOT, 'reports');

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function manifest(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[relative(dir, p).replace(/\\/g, '/')] = { size: st.size, sha256: sha256(p) };
    }
  };
  walk(dir);
  return out;
}

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function main() {
  ensure(existsSync(join(ELECTRON_DIST, 'electron.exe')), `找不到 Electron dist: ${ELECTRON_DIST}`);
  ensure(existsSync(join(WEB_SRC, 'index.html')), `找不到原 web-desktop: ${WEB_SRC}`);
  mkdirSync(REPORTS, { recursive: true });

  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });

  // 1) Electron 运行时
  cpSync(ELECTRON_DIST, OUT, { recursive: true, force: true });
  const defaultApp = join(OUT, 'resources', 'default_app.asar');
  if (existsSync(defaultApp)) rmSync(defaultApp, { force: true });

  // 2) 应用代码（不含任何自定义 UI）
  for (const dir of ['server', 'kernel', 'conf', 'electron', 'tools']) {
    cpSync(join(ROOT, dir), join(APP, dir), { recursive: true, force: true });
  }
  mkdirSync(join(APP, 'tests'), { recursive: true });
  cpSync(join(ROOT, 'tests', 'client.js'), join(APP, 'tests', 'client.js'));

  // 3) 原画面：逐字节复制
  const webDst = join(APP, 'web');
  cpSync(WEB_SRC, webDst, { recursive: true, force: true });

  // 4) app 描述文件 + 主进程入口
  writeFileSync(join(APP, 'package.json'), JSON.stringify({
    name: 'slg-offline',
    productName: '三国策略 · 单机版',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'electron/main.cjs',
  }, null, 2), 'utf8');

  // 5) 可执行文件改名（保持 resources/app 相对关系）
  const fromExe = join(OUT, 'electron.exe');
  const toExe = join(OUT, 'SLG-Offline.exe');
  if (existsSync(fromExe)) renameSync(fromExe, toExe);

  // 6) 画面一致性清单
  const src = manifest(WEB_SRC);
  const dst = manifest(webDst);
  const srcKeys = Object.keys(src);
  const dstKeys = Object.keys(dst);
  const diff = [];
  for (const k of new Set([...srcKeys, ...dstKeys])) {
    if (!src[k] || !dst[k] || src[k].sha256 !== dst[k].sha256) diff.push(k);
  }
  const srcHash = createHash('sha256').update(srcKeys.map((k) => `${k}:${src[k].sha256}`).join('\n')).digest('hex');
  const result = {
    packedAt: new Date().toISOString(),
    out: OUT,
    exe: toExe,
    exeBytes: statSync(toExe).size,
    webDir: webDst,
    webFileCount: srcKeys.length,
    webBytes: srcKeys.reduce((s, k) => s + src[k].size, 0),
    webFingerprint: srcHash,
    byteIdentical: diff.length === 0,
    diff,
    electronDist: ELECTRON_DIST,
    webSource: WEB_SRC,
    containsCustomCanvasUI: false,
  };
  writeFileSync(join(REPORTS, 'pack.json'), JSON.stringify(result, null, 2), 'utf8');
  writeFileSync(join(REPORTS, 'web-manifest.json'), JSON.stringify(src, null, 2), 'utf8');
  ensure(result.byteIdentical, `原画面复制不一致：${diff.slice(0, 5).join(', ')}`);
  console.log('[slg-offline:pack]', JSON.stringify(result, null, 2));
}

main();
