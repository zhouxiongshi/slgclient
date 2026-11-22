/**
 * P37（2026-11-22）诸侯主动性回归：
 *  1. 汉廷空城不再按有主城高门槛筛掉，开局多数诸侯有扩张目标；
 *  2. 玩家进攻汉廷城也会触发邻近诸侯确定性驰援，战场过程能看到 AI 支援；
 *  3. 驰援规模随 difficultyAi 缩放，默认 1.0 不改变协议与内核。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import {
  ensureStrategy, strategySnapshot, localBrain, factionConf, factionReliefTick,
} from '../server/domain/strategy.js';
import { knobSet, knobGet } from '../server/domain/knobs.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cfg = loadConfig();
const conf = factionConf();

function fresh() {
  const state = createWorld(cfg);
  ensureStrategy(state);
  return state;
}

test('P37-① 开局多数诸侯主动盯上汉廷空城（旧口径只有董卓一家）', () => {
  const state = fresh();
  const plans = conf.factions.map((f) => localBrain(f, strategySnapshot(state, f.id), state));
  const hanTargets = plans.filter((p) => p.goal.type === '吞并' && p.goal.targetName);
  assert.ok(hanTargets.length >= 6,
    `至少 6/8 家应主动扩张，实际 ${hanTargets.length}：${JSON.stringify(plans.map((p) => p.goal))}`);
  /* 汉城目标必须来自真实可达城，不能凭空造 id */
  for (const p of hanTargets) {
    assert.ok(p.strategy_orders.some((o) => o.type === '出征' && String(o.target) === p.goal.target),
      `${p.faction} 目标城应落在可执行出征单里`);
  }
});

test('P37-② 玩家打汉廷城也有邻郡诸侯驰援（含行军实体与资源扣减）', () => {
  const state = fresh();
  const st = state.strategy;
  const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const target = 18;                     // 汉廷城，邻城 1 属董卓（sili）
  const src = 1;
  const before = st.cities[src].troops;
  st.marches = [{
    id: 1, side: 'player', kind: 'assault', from: 7, to: target,
    departDay: today, arriveDay: today + 3, troops: 5000,
  }];
  const out = factionReliefTick(state, cfg, { push() {} });
  assert.ok(out.some((x) => x.faction === 'sili' && x.to === target),
    `汉廷城应触发确定性争夺者驰援，实际 ${JSON.stringify(out)}`);
  assert.ok(st.marches.some((m) => m.kind === 'relief' && m.factionId === 'sili' && Number(m.to) === target),
    '援军必须是玩家可见的行军实体');
  assert.ok(st.cities[src].troops < before, '出发城必须真实扣兵');
});

test('P37-③ difficultyAi 接入扩张门槛，默认仍为 1.0', () => {
  const state = fresh();
  assert.equal(knobGet(state, 'difficultyAi'), 1);
  knobSet(state, 'difficultyAi', 1.4);
  assert.equal(knobGet(state, 'difficultyAi'), 1.4);
  const src = readFileSync(resolve(ROOT, 'server/domain/strategy-brain.js'), 'utf8');
  assert.match(src, /knobGet\(state, 'difficultyAi'\)/, '决策脑必须消费难度旋钮');
  assert.doesNotMatch(src, /difficultyDiplo.*战斗|attackerOddsMul/, '难度不得落到伤害公式');
});
