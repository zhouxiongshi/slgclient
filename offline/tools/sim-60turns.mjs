/**
 * 平衡验证脚本（GDD §9.5「把调参变成可重复实验」）。
 *
 *   node tools/sim-60turns.mjs [--seed N] [--turns 60] [--json out.json] [--quiet]
 *
 * 输入：固定种子的举义世界（确定性：同一输入两次运行结果完全一致，见 runSim 的双跑断言）。
 * 输出：每旬 { turn, day, cities, gold, grain, troops, battles, events }。
 * 用途：
 *   1. 校验经济曲线（数值改动后空跑重算，偏差肉眼可查）；
 *   2. 校验「可持续养兵 ≈ 势力粮产/旬」换算律（README 数值锚）；
 *   3. 回归：平衡改动跑一遍，输出与上一版 diff。
 *
 * 本脚本只读世界推进函数（strategyTick / strategyResolveMarches / cityEconTick 的真实路径），
 * 不复制任何结算逻辑——脚本算的就是游戏算的。
 */
import { createWorld, normalizeWorld } from '../server/world.js';
import { loadConfig } from '../server/config.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  ensureStrategy, oathOptions, chooseOath, strategyTick, strategyResolveMarches,
} from '../server/domain/strategy.js';
import { cityEconTick } from '../server/domain/city-econ.js';

function ctxOf(pushes) {
  return { push: (t, m) => { if (pushes) pushes.push({ t, m }); } };
}

function ownedStats(state) {
  const st = state.strategy;
  let cities = 0;
  let troops = 0;
  let grain = 0;
  for (const [id, row] of Object.entries(st.cities)) {
    if (row.owner !== 'player') continue;
    cities += 1;
    troops += Math.max(0, Math.round(Number(row.troops) || 0));
    grain += Math.max(0, Math.floor(Number(st.cityEcon?.[id]?.store) || 0));
  }
  return { cities, troops, grain, gold: Math.floor(Number(state.roleRes?.gold) || 0) };
}

/** 跑一局：举义 → 按「游戏日走到」的真实路径推进 turns 旬，逐旬记指标。 */
export function runSim({ seed = 20261113, turns = 60, pushes = false } = {}) {
  const cfg = loadConfig();
  const state = normalizeWorld(createWorld(cfg), cfg);
  state.seed = seed;
  ensureStrategy(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const oath = chooseOath(state, cfg, ctxOf(pushes), { lord: lords[0].id, city: lords[0].cities[0].id });
  if (!oath.ok) throw new Error(`sim: 举义失败 ${JSON.stringify(oath)}`);

  const series = [];
  const ctx = ctxOf(pushes ? [] : null);
  const chat = [];
  const fullCtx = { push: (t, m) => { chat.push(m?.msg || ''); } };
  let turn = 0;
  let guard = 0;
  const st0 = state.strategy;
  while (turn < turns && guard < turns * 40) {
    guard += 1;
    const before = st0.turn;
    state.clock.day = Math.max(1, Math.floor(Number(state.clock.day) || 1)) + 1;
    strategyResolveMarches(state, cfg, fullCtx);
    cityEconTick(state, cfg, fullCtx);
    const tick = strategyTick(state, cfg, fullCtx);
    if (tick && st0.turn > before) {
      turn = st0.turn;
      series.push({ turn, day: Math.floor(Number(state.clock.day) || 1), ...ownedStats(state), battles: chat.length });
    }
  }
  if (series.length < turns) {
    throw new Error(`sim: ${guard} 日只推到 ${series.length}/${turns} 旬，旬长口径可能变了`);
  }
  return { seed, turns, series, chat, chatLen: chat.length };
}

/** 确定性断言：同一输入两次运行逐旬一致 + NPC 决策聊天逐字一致（GDD §9.5）。 */
export function simHash(result) {
  return createHash('md5').update(JSON.stringify({ s: result.series, c: result.chat })).digest('hex');
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) : dflt;
  };
  const seed = opt('seed', 20261113);
  const turns = opt('turns', 60);
  const jsonPath = (() => {
    const i = args.indexOf('--json');
    return i >= 0 ? args[i + 1] : '';
  })();

  const a = runSim({ seed, turns });
  const b = runSim({ seed, turns });
  const ha = simHash(a);
  const hb = simHash(b);
  console.log(`[sim-60turns] seed=${seed} turns=${a.series.length}`);
  const head = a.series[0];
  const tail = a.series[a.series.length - 1];
  console.log(`[sim-60turns] 首旬: 城 ${head.cities} 兵 ${head.troops} 金 ${head.gold} 粮 ${head.grain}`);
  console.log(`[sim-60turns] 末旬: 城 ${tail.cities} 兵 ${tail.troops} 金 ${tail.gold} 粮 ${tail.grain}`);
  console.log(`[sim-60turns] 确定性: ${ha === hb ? '通过（两次运行逐旬一致）' : '失败！两跑不一致'}`);
  if (ha !== hb) process.exitCode = 1;
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ seed, turns, hash: ha, series: a.series }, null, 2));
    console.log(`[sim-60turns] 已写 ${jsonPath}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('sim-60turns.mjs')) main();
