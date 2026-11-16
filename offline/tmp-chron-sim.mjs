import { loadConfig } from './server/config.js';
import { createWorld, normalizeWorld } from './server/world.js';
import { ensureStrategy, strategyViewState, oathOptions, chooseOath } from './server/domain/strategy.js';
import { settleWorld, advanceToNextTurn } from './server/handlers.js';
import { ensureCityEcon } from './server/domain/city-econ.js';

const cfg = loadConfig();
const state = normalizeWorld(createWorld(cfg), cfg);
ensureStrategy(state); ensureCityEcon(state);
const ctx = { state, cfg, options: {}, pushes: [], push(n, m) { this.pushes.push({ n, m }); }, save() {}, log() {}, schedule() {} };
const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
const r = chooseOath(state, cfg, ctx, { lord: lords[0].id, city: lords[0].cities[0].id });
if (!r.ok) { console.log('oath failed', r); process.exit(1); }
const DAY = 60000; // realMsPerDay per chapterRules? use whatever; just advance turns
let now = Date.now();
for (let i = 0; i < 14; i++) {
  state.clock.lastRealMs = now - 10 * 60 * 1000; // force 10 "days" per settle
  settleWorld(ctx, now);
  now += 60 * 1000;
}
const st = state.strategy;
console.log('turn =', st.turn, '| chronicle entries =', (st.chronicle || []).length);
for (const c of (st.chronicle || []).slice(-8)) {
  console.log('----', 'month', c.month, 'turn', c.turn);
  console.log(c.text);
}
// 扫畸形
const all = JSON.stringify(st.chronicle || []);
for (const bad of ['undefined', 'null', 'NaN', '。。', ' . ', '《undefined']) {
  if (all.includes(bad)) console.log('!! FOUND BAD TOKEN:', bad);
}
console.log('cityLogs cities:', Object.keys(st.cityLogs || {}).length);

// 城池日志样例
let shown = 0;
for (const [cid, list] of Object.entries(st.cityLogs || {})) {
  const c = (cfg.cities || []).find?.((x) => x.id === Number(cid)) || null;
  for (const e of list.slice(-2)) {
    console.log('city', cid, (c && c.name) || '?', '|', JSON.stringify(e).slice(0, 160));
    if (++shown > 10) break;
  }
  if (shown > 10) break;
}
// 财报
const { booksOf } = await import('./server/domain/strategy-log.js');
for (const c of (st.chronicle || []).slice(-2)) {
  console.log('== books month', c.month);
  for (const row of booksOf(c.moves)) console.log(JSON.stringify(row));
}
// events 通道 vs chronicle
console.log('events len:', (st.events || []).length, 'movements:', JSON.stringify(st.movements || []).slice(0, 200));
