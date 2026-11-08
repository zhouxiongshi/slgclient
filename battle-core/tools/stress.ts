/**
 * 战斗内核稳定性压测：大量随机对局 + 不变量校验 + 确定性复跑。
 * 输出 reports/stress.json。任一不变量失败即以非零退出码结束。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  DEFAULT_BATTLE_CONFIG,
  buildArmies,
  runBattle,
  validateInvariants,
  eventSummary,
} from '../src/index.js';
import type { BattleResult } from '../src/index.js';

const TOTAL = Number(process.env.STRESS_TOTAL ?? 10000);
const CHECK_DETERMINISM_EVERY = 50;
const cfg = DEFAULT_BATTLE_CONFIG;

const failures: string[] = [];
const determinismFailures: string[] = [];
const winnerCounts: Record<string, number> = {};
const roundCounts: Record<string, number> = {};
const kindTotals: Record<string, number> = {};
let totalEvents = 0;
let maxEvents = 0;
let minEvents = Number.MAX_SAFE_INTEGER;
let maxRounds = 0;
let totalDamageApplied = 0;

const started = performance.now();

for (let i = 0; i < TOTAL; i += 1) {
  const seed = (Math.imul(i + 1, 2654435761) ^ (i << 7)) >>> 0;
  const perSide = 1 + (i % 5);
  const level = 1 + ((i * 7) % 10);
  const troops = 100 + ((Math.imul(i + 3, 7919) >>> 0) % 50000);
  const roundLimit = 1 + ((i * 3) % 12);
  let r: BattleResult;

  try {
    const units = buildArmies(cfg, perSide, level, troops);
    r = runBattle({ units, seed, config: cfg, roundLimit });
    const report = validateInvariants(r, units, roundLimit);
    if (!report.ok) failures.push(`seed=${seed}: ${report.problems.join('; ')}`);
    totalDamageApplied += report.checks.damage_applied_total;

    if (i % CHECK_DETERMINISM_EVERY === 0) {
      const again = runBattle({ units, seed, config: cfg, roundLimit });
      if (again.event_fingerprint !== r.event_fingerprint) {
        determinismFailures.push(`seed=${seed} 复跑事件流不一致`);
      }
    }
  } catch (err) {
    failures.push(`seed=${seed} 抛出异常: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  const w = String(r.winner);
  winnerCounts[w] = (winnerCounts[w] ?? 0) + 1;
  roundCounts[String(r.rounds)] = (roundCounts[String(r.rounds)] ?? 0) + 1;
  totalEvents += r.events.length;
  maxEvents = Math.max(maxEvents, r.events.length);
  minEvents = Math.min(minEvents, r.events.length);
  maxRounds = Math.max(maxRounds, r.rounds);
  for (const [k, v] of Object.entries(eventSummary(r.events))) {
    kindTotals[k] = (kindTotals[k] ?? 0) + v;
  }
}

const elapsedMs = Math.round(performance.now() - started);
const report = {
  generated_at: new Date().toISOString(),
  total_battles: TOTAL,
  elapsed_ms: elapsedMs,
  battles_per_second: Math.round((TOTAL / elapsedMs) * 1000),
  invariant_failures: failures.length,
  determinism_failures: determinismFailures.length,
  determinism_samples: Math.ceil(TOTAL / CHECK_DETERMINISM_EVERY),
  total_events: totalEvents,
  avg_events: Math.round(totalEvents / TOTAL),
  min_events: minEvents,
  max_events: maxEvents,
  max_rounds: maxRounds,
  total_damage_applied: totalDamageApplied,
  winner_distribution: winnerCounts,
  rounds_distribution: roundCounts,
  event_kind_totals: kindTotals,
  failure_samples: [...failures, ...determinismFailures].slice(0, 20),
  passed: failures.length === 0 && determinismFailures.length === 0,
};

const outDir = resolve(process.cwd(), 'reports');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'stress.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
