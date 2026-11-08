/** 生成 TS 侧回归向量快照 golden/ts_vectors.json。 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_BATTLE_CONFIG,
  buildArmies,
  calcDamage,
  configFingerprint,
  counterFactor,
  crc32Utf8,
  eventSummary,
  levelValue,
  normalizeBonus,
  PythonRandom,
  runBattle,
  sumTermsBonus,
} from '../src/index.js';

const cfg = DEFAULT_BATTLE_CONFIG;
const units = buildArmies(cfg, 3, 10, 1200);
const battle = runBattle({ units, seed: 20261106, config: cfg, roundLimit: 8 });
const rng = new PythonRandom(20261106);

const vectors = {
  _说明: 'TS 内核回归快照。纯函数向量应与 golden/expected_vectors.json 精确一致；整场统计量应与 Python 参考一致。',
  config_fingerprint_ts: configFingerprint(cfg),
  config_fingerprint_python: 'f186e15d0c1f266b',
  level_value: { 'v(40,1)': levelValue(40, 1), 'v(40,5)': levelValue(40, 5), 'v(40,10)': levelValue(40, 10) },
  normalize_bonus: { '(25, op=0)': normalizeBonus(25, 0), '(0.25, op=1)': normalizeBonus(0.25, 1) },
  sum_terms_bonus: sumTermsBonus([
    { name: 'a', value: 10, op: 0 },
    { name: 'b', value: 20, op: 0 },
    { name: 'c', value: 0.15, op: 1 },
  ]),
  calc_damage: {
    '(100, 1.2, 0.25, min=1)': calcDamage(100, 1.2, 0.25, 1),
    '(1, 1.0, 0.0, min=5)': calcDamage(1, 1.0, 0.0, 5),
    '(0.4, 1.0, 0.0, min=7)': calcDamage(0.4, 1.0, 0.0, 7),
  },
  counter_factor_fallback: [0, 4, -1, 99].map((w) => counterFactor(cfg, 'normal', w).factor),
  crc32: { '曹植#1-1': crc32Utf8('曹植#1-1') },
  mt19937_first5: [rng.random(), rng.random(), rng.random(), rng.random(), rng.random()],
  battle_smoke: {
    seed: battle.seed,
    winner: battle.winner,
    rounds: battle.rounds,
    event_count: battle.events.length,
    damage_event_count: battle.events.filter((e) => e.kind === 'damage').length,
    survivors: battle.survivors,
    first_damage_calc: battle.events.find((e) => e.kind === 'damage')?.payload.calc,
    event_summary: eventSummary(battle.events),
    event_fingerprint: battle.event_fingerprint,
    rng_calls: battle.rng_calls,
  },
};

const out = resolve(process.cwd(), 'golden/ts_vectors.json');
writeFileSync(out, JSON.stringify(vectors, null, 2), 'utf8');
// 顺带确认 Python 参考指纹仍与包内声明一致
const expected = JSON.parse(readFileSync(resolve(process.cwd(), 'golden/expected_vectors.json'), 'utf8'));
console.log(`[make-golden] 已生成 ${out}`);
console.log(`[make-golden] winner=${battle.winner} rounds=${battle.rounds} events=${battle.events.length} (Python: ${expected.battle_smoke.winner}/${expected.battle_smoke.rounds}/${expected.battle_smoke.event_count})`);
