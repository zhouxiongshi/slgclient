import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BATTLE_CONFIG,
  buildArmies,
  runBattle,
  validateInvariants,
} from '../src/index.js';

const cfg = DEFAULT_BATTLE_CONFIG;

test('随机 500 场：不变量全部成立，且抽样复跑结果完全一致', () => {
  const winners = new Set<string>();
  let totalEvents = 0;
  const started = Date.now();

  for (let i = 0; i < 500; i += 1) {
    const seed = (i * 2654435761) >>> 0;
    const perSide = 1 + (i % 4);
    const level = 1 + (i % 10);
    const troops = 200 + ((i * 7919) % 20000);
    const roundLimit = 1 + (i % 10);
    const units = buildArmies(cfg, perSide, level, troops);
    const r = runBattle({ units, seed, config: cfg, roundLimit });

    const report = validateInvariants(r, units, roundLimit);
    assert.equal(report.ok, true, `seed=${seed} perSide=${perSide} level=${level} troops=${troops}: ${report.problems.join('; ')}`);

    winners.add(String(r.winner));
    totalEvents += r.events.length;

    if (i % 25 === 0) {
      const again = runBattle({ units, seed, config: cfg, roundLimit });
      assert.equal(again.event_fingerprint, r.event_fingerprint, `seed=${seed} 复跑不一致`);
    }
  }

  assert.ok(winners.size >= 2, '结果应覆盖胜/负/平多种情况');
  assert.ok(totalEvents > 0);
  assert.ok(Date.now() - started < 60000, '500 场耗时应可控');
});

test('极端边界：1v1 / 1 回合 / 最小兵力 / 高等级 / 大兵力', () => {
  const cases = [
    { perSide: 1, level: 1, troops: 1, roundLimit: 1, seed: 0 },
    { perSide: 1, level: 10, troops: 1, roundLimit: 20, seed: -1 },
    { perSide: 5, level: 10, troops: 1000000, roundLimit: 1, seed: 999 },
    { perSide: 4, level: 1, troops: 100, roundLimit: 30, seed: 2147483647 },
  ];
  for (const c of cases) {
    const units = buildArmies(cfg, c.perSide, c.level, c.troops);
    const r = runBattle({ units, seed: c.seed, config: cfg, roundLimit: c.roundLimit });
    const report = validateInvariants(r, units, c.roundLimit);
    assert.equal(report.ok, true, `${JSON.stringify(c)}: ${report.problems.join('; ')}`);
    assert.ok(r.events.every((e) => Number.isFinite(e.round)));
  }
});
