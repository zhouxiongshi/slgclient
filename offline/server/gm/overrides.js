/**
 * 覆盖层。只读写 conf/campaign/overrides.json，不碰 conf/json/。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../conf/campaign/overrides.json');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 系数允许区间。GM 页与这里共用同一份口径（页面里有一份同样数值的副本），
 * 超出区间一律夹到边界，避免手填 0 或 1e9 把一局玩废。
 */
export const RULE_RANGES = {
  upkeepPerSoldier: { min: 0, max: 100, label: '每兵每日军饷' },
  lendGrain: { min: 0, max: 100000, label: '借粮扣多少' },
  realMsPerDay: { min: 1000, max: 3600000, label: '一游戏日的真实毫秒' },
  blueprintBonus: { min: 0, max: 10, label: '曲辕犁加成' },
};

const clampRule = (key, n) => {
  const r = RULE_RANGES[key];
  if (!r) return n;
  return Math.min(r.max, Math.max(r.min, n));
};

export function emptyOverrides() {
  return { tiles: [], facilities: [], city: null, rules: {}, story: {} };
}

export function sanitizeOverrides(input) {
  const src = input && typeof input === 'object' ? input : {};
  const tiles = (Array.isArray(src.tiles) ? src.tiles : []).slice(0, 200).map((t) => ({
    x: num(t.x) ?? 0,
    y: num(t.y) ?? 0,
    type: num(t.type),
    level: num(t.level),
    wood: num(t.wood),
    iron: num(t.iron),
    stone: num(t.stone),
    grain: num(t.grain),
  }));
  const facilities = (Array.isArray(src.facilities) ? src.facilities : []).slice(0, 40).map((f) => ({
    type: num(f.type) ?? 0,
    level: num(f.level) ?? 0,
  }));
  const city = src.city && typeof src.city === 'object'
    ? {
      x: num(src.city.x) == null ? null : Math.min(200, Math.max(0, num(src.city.x))),
      y: num(src.city.y) == null ? null : Math.min(200, Math.max(0, num(src.city.y))),
      name: String(src.city.name || '').slice(0, 16),
    }
    : null;
  const rules = {};
  for (const key of ['upkeepPerSoldier', 'lendGrain', 'realMsPerDay', 'blueprintBonus']) {
    const n = num(src.rules?.[key]);
    if (n != null) rules[key] = clampRule(key, n);
  }
  const story = {};
  for (const key of ['lend', 'refuse']) {
    const text = src.story?.[key];
    if (typeof text === 'string' && text.trim()) story[key] = text.trim().slice(0, 200);
  }
  return { tiles, facilities, city, rules, story };
}

let cache = null;
let stamp = -1;

export function loadOverrides() {
  const m = overridesMtime();
  if (cache && stamp === m) return cache;
  try {
    cache = sanitizeOverrides(JSON.parse(readFileSync(FILE, 'utf8')));
  } catch {
    cache = emptyOverrides();
  }
  stamp = m;
  return cache;
}

export function overridesMtime() {
  try { return statSync(FILE).mtimeMs; } catch { return 0; }
}

export function saveOverrides(input) {
  const clean = sanitizeOverrides(input);
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2));
  renameSync(tmp, FILE);
  cache = clean;
  stamp = overridesMtime();
  return clean;
}

export function applyTileOverlay(state, tiles = loadOverrides().tiles) {
  for (const t of tiles || []) {
    const b = (state.builds || []).find((row) => row.x === t.x && row.y === t.y && row.rid === state.role?.rid);
    if (!b) continue;
    if (t.type != null) b.type = t.type;
    if (t.level != null) b.level = t.level;
    if (t.wood != null) b.wood = t.wood;
    if (t.iron != null) b.iron = t.iron;
    if (t.stone != null) b.stone = t.stone;
    if (t.grain != null) b.grain = t.grain;
  }
  return state;
}
