/**
 * 第七轮（用户实机反馈）：战斗画面守军恒 0、掉兵看不见、打斗缺动态。
 *
 * 根因：createStage 创建后立刻 play()→reset()，而旧 reset 用战后 `remain`
 * 当初态；败方 remain=0 时守军从第一帧就是空阵，后续事件扣减再也看不出来。
 * 修复把初态收敛到 makeUnitState（战前 troops 起画），并让每次 hit 同步刷新
 * 双方总数、本击折损与像素方阵密度。本测试锁住数据层与注入层口径，不改结算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildBattleAnim } from '../server/battle.js';
import { loadConfig } from '../server/config.js';
import { createSkillAssets } from '../server/skills.js';

const ROOT = resolve(import.meta.dirname, '..');
const cfg = loadConfig();

function kernelOf() {
  return {
    rounds: 2,
    winner: 1,
    final_troops: { a0: 780, d0: 0, d1: 0, d2: 0 },
    total_troops_by_side: { '1': 780, '2': 0 },
    events: [
      { round: 1, actor: 'd0', kind: 'damage', payload: { skill: '普攻', target: 'a0', applied: 400 } },
      { round: 1, actor: 'a0', kind: 'damage', payload: { skill: '普攻', target: 'd0', applied: 2200 } },
      { round: 2, actor: 'a0', kind: 'damage', payload: { skill: '普攻', target: 'd1', applied: 2200 } },
    ],
  };
}

function stateOf() {
  return {
    role: { nickName: '主公' },
    garrisons: [{ x: 3, y: 4, name: '黄巾游骑', cleared: false }],
    battleLog: [],
  };
}

test('回放脚本：守军战前有兵、战后余兵为 0，逐击折损落到具体单位', () => {
  const anim = buildBattleAnim({
    kernel: kernelOf(),
    attackers: [{ slot: 0, g: { cfgId: 880001 } }],
    defense: {
      generals: [{ cfgId: 100002 }, { cfgId: 100003 }],
      soldiers: [1000, 1000],
    },
    army: { soldiers: [800, 0, 0] },
    beginSoldiers: [800, 0, 0],
    state: stateOf(), cfg, x: 3, y: 4, resultCode: 2,
    attackRemain: [780, 0, 0], defenseRemain: [0, 0],
  });

  assert.equal(anim.d.total, 2000, '守军战前总兵力不得为 0');
  assert.deepEqual(anim.d.units.map((u) => u.troops), [1000, 1000]);
  assert.deepEqual(anim.d.units.map((u) => u.remain), [0, 0], '败方战后余兵为 0 是结算事实');
  const hits = anim.rounds.flatMap((rd) => rd.acts.filter((a) => a.t === 'hit'));
  assert.equal(hits.length, 3);
  assert.ok(hits.every((h) => h.loss > 0), '每次命中都要带非零折损数，供画面显示');
  assert.ok(hits.some((h) => h.to.s === 'd' && h.toName === anim.d.units[0].name), '守军单位必须能被命中');
});

test('注入层：首帧与重播都按战前兵力起画，绝不把 remain 当初态', () => {
  if (!existsSync(resolve(ROOT, 'web', 'index.html'))) return;
  const js = createSkillAssets(resolve(ROOT, 'web')).intercept('/assets/main/index.js').body;

  assert.ok(!/cur:\s*Math\.max\(0,\s*u\.remain\)/.test(js), '残留 remain 初态会让守军第一帧就 0 兵');
  assert.match(js, /function makeUnitState\(side, u, i\)[\s\S]*?troops:\s*troops,\s*cur:\s*troops/);
  assert.equal((js.match(/makeUnitState\(side, u, i\)/g) || []).length >= 3, true,
    'buildUnits / reset 必须共用同一个初态函数');
  assert.match(js, /state\.units\[side \+ \(u\.slot == null \? i : u\.slot\)\] = makeUnitState\(side, u, i\)/);

  assert.match(js, /state\.sideHitLoss\[to\.side\] = loss/, '每次命中必须记本击折损');
  assert.match(js, /to\.lastLoss = loss; to\.lastLossT = now/, '受击武将必须保留本击折损');
  assert.match(js, /damage\(to, loss\)/, '命中必须真的逐击扣当前兵力');
  assert.match(js, /drawSideTotals\(g, rect, now\)/, '画面必须展示双方当前/战前兵力总览');
  assert.match(js, /Math\.ceil\(ratio \* \(big \? 96 : 48\)\)/, '像素方阵必须随剩余兵力同比变化');
  assert.match(js, /'　−' \+ fmt\(state\.sideHitLoss\[side\]\)/, '总览要显示本击折损');
});
