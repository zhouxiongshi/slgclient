/**
 * P36（2026-11-22）武将成长提速回归：
 *  1. 内政经验常量 12 点/旬；
 *  2. 出征经验 = 参战底数 20 + 折损×0.8，低折损仗也有成长；
 *  3. 经验仍只经 grantBattleExp / applyGeneralExp 入账，不改阈值与 10 级上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { resolveBattle } from '../server/battle.js';
import {
  GENERAL_LEVEL_CAP, INTERIOR_EXP_PER_TICK,
  BATTLE_EXP_PER_LOSS, BATTLE_EXP_PARTICIPATION,
} from '../server/domain/general-progress.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const cfg = loadConfig();

test('P36-① 成长常量集中定义，阈值与等级上限不动', () => {
  assert.equal(INTERIOR_EXP_PER_TICK, 12);
  assert.equal(BATTLE_EXP_PER_LOSS, 0.8);
  assert.equal(BATTLE_EXP_PARTICIPATION, 20);
  assert.equal(GENERAL_LEVEL_CAP, 10);
  const src = read('server/domain/general-progress.js');
  assert.match(src, /return 40 \* lv/, 'expToAdvance 仍为 40×等级，不改全局曲线');
});

test('P36-② 出征经验含参战底数：极低折损也能学到东西', () => {
  const w = normalizeWorld(createWorld(cfg), cfg);
  const army = w.armys[0];
  army.soldiers = [2400, 0, 0];
  army.generals = [w.generals[0].id, 0, 0];
  const r = resolveBattle({ cfg, state: w, army, x: 100, y: 101, seed: 424242 });
  const gid = String(w.generals[0].id);
  assert.ok(r.expByGeneral && Number(r.expByGeneral[gid]) >= BATTLE_EXP_PARTICIPATION,
    `参战武将至少拿到底数 20，实际 ${JSON.stringify(r.expByGeneral)}`);
  assert.ok(Object.keys(r.expByGeneral).length >= 1);
});

test('P36-③ 内政与战斗都只调用唯一经验入口，不在 UI 或经济层另发经验', () => {
  const interior = read('server/domain/interior-task.js');
  assert.match(interior, /applyGeneralExp\(off, INTERIOR_EXP_PER_TICK \* steps\)/);
  assert.doesNotMatch(interior, /applyGeneralExp\(off, 5 \* steps\)/, '旧 5 点口径不得回退');
  const battle = read('server/battle.js');
  assert.match(battle, /BATTLE_EXP_PARTICIPATION \+ Math\.round\(loss \* BATTLE_EXP_PER_LOSS\)/);
  assert.doesNotMatch(battle, /attackRemain\[slot\]\) \* 0\.5/, '旧折损口径不得回退');
  const ui = read('server/panels-ui.js') + read('server/skills.js');
  assert.doesNotMatch(ui, /applyGeneralExp/, '玩家界面禁止直接发经验');
});
