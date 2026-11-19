/**
 * 构建武将立绘 URL 映射（2026-11-19）。
 * 只读源码 assets/resources/generalpic/card_<cfgId>.png.meta 的 uuid，
 * 生成 server/portrait-map.json。冻结产物 offline/web/ 一个字节都不改：
 * 原版 PNG 已由 serveStatic 暴露为 /assets/resources/native/<uu>/<uuid>.png。
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, '..', 'assets', 'resources', 'generalpic');
const WEB = join(ROOT, 'web', 'assets', 'resources', 'native');
const OUT = join(ROOT, 'server', 'portrait-map.json');

const map = {};
for (const name of readdirSync(SRC)) {
  const m = /^card_(\d+)\.png\.meta$/.exec(name);
  if (!m) continue;
  const cfgId = Number(m[1]);
  if (!Number.isFinite(cfgId) || cfgId <= 0) continue;
  let uuid;
  try { uuid = JSON.parse(readFileSync(join(SRC, name), 'utf8')).uuid; } catch { continue; }
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) continue;
  const rel = `${uuid.slice(0, 2)}/${uuid}.png`;
  if (!existsSync(join(WEB, rel))) continue;
  map[String(cfgId)] = `/assets/resources/native/${rel}`;
}

const fallback = map['1'] || map['100001'] || Object.values(map)[0] || '';
writeFileSync(OUT, `${JSON.stringify({ version: 1, fallback, portraits: map }, null, 0)}\n`, 'utf8');
console.log(`[portrait-map] ${Object.keys(map).length} portraits -> ${OUT}`);
