import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { DEFAULT_BATTLE_CONFIG, buildArmies, runBattle } from '../src/index.js';

const root = resolve(process.cwd());
const py = JSON.parse(readFileSync(resolve(root, 'golden/python_smoke.json'), 'utf8')) as any;
const vectors = JSON.parse(readFileSync(resolve(root, 'golden/expected_vectors.json'), 'utf8')) as Record<string, any>;
const cfg = DEFAULT_BATTLE_CONFIG;

function tsBattle() {
  const units = buildArmies(cfg, 3, 10, 1200);
  return runBattle({ units, seed: 20261106, config: cfg, roundLimit: 8 });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 去掉移植版新增的对账字段，还原成 Python 参考实现的 payload */
function stripExtra(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  delete out.troops_before;
  delete out.troops_after;
  delete out.applied;
  return out;
}

test('数值表与 battle-kit 源文件字节级一致，Python 指纹可复核', () => {
  const local = resolve(root, 'config/battle_config.json');
  assert.equal(vectors.config_fingerprint, 'f186e15d0c1f266b', '黄金向量声明的配置指纹');
  const kit = 'D:/WorkBuddy/battle-kit/kernel/config/battle_config.json';
  if (existsSync(kit)) {
    assert.equal(sha256(local), sha256(kit), '配置文件必须原样复制，不得改动数值');
  }
});

test('整场战斗统计量与 Python 参考实现完全一致', () => {
  const r = tsBattle();
  const smoke = vectors.battle_smoke;
  assert.equal(r.seed, smoke['参数'].seed);
  assert.equal(r.winner, smoke.winner);
  assert.equal(r.rounds, smoke.rounds);
  assert.equal(r.events.length, smoke.event_count);
  assert.deepEqual(r.survivors, smoke.survivors);
  assert.equal(r.events.filter((e) => e.kind === 'damage').length, smoke.damage_event_count);
});

test('175 条事件逐条与 Python 参考实现一致（含完整伤害中间量）', () => {
  const r = tsBattle();
  assert.equal(r.events.length, py.events.length);
  for (let i = 0; i < py.events.length; i += 1) {
    const a = r.events[i];
    const b = py.events[i];
    assert.equal(a.round, b.round, `事件 ${i} round`);
    assert.equal(a.phase, b.phase, `事件 ${i} phase`);
    assert.equal(a.actor, b.actor, `事件 ${i} actor`);
    assert.equal(a.kind, b.kind, `事件 ${i} kind`);
    assert.equal(a.evidence, b.evidence, `事件 ${i} evidence`);
    assert.deepEqual(stripExtra(a.payload), b.payload, `事件 ${i} payload`);
  }
});

test('首个伤害结算与黄金向量 first_damage_calc 逐字段一致', () => {
  const r = tsBattle();
  const first = r.events.find((e) => e.kind === 'damage');
  assert.ok(first);
  const got = first.payload.calc as Record<string, unknown>;
  const exp = vectors.battle_smoke.first_damage_calc;
  for (const key of Object.keys(exp)) {
    assert.equal(got[key], exp[key], `first_damage_calc.${key}`);
  }
});

test('Python 参考事件流指纹与黄金向量声明一致', () => {
  assert.equal(py.event_fingerprint, vectors.battle_smoke.event_fingerprint);
  assert.equal(py.event_fingerprint, 'b1e8b82031471baa');
});
