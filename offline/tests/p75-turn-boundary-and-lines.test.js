/**
 * P75 回归闸：闭环支线端到端 + 旬界相位不漂移。
 *
 * 玩家报障（2026-11-27）：「继续流程检查，每条支线功能都需要测试」；
 * 更早的报障：「人口增长上回提到过，现在还是没修复」。
 *
 * 实测真因不是 `popTick` 的增长率，而是**旬界用了两套相位**：
 *   - `strategyTick` 判 `day - lastTurnDay >= turnDays`（相对）；
 *   - `cityEconTick` 内部各旬结算判 `day % 10 === 0`（绝对）。
 * 玩家存档 `lastTurnDay = 1846`，于是 strategyTick 落在 1859/1869/1889（%10=9），
 * 旬结算一次都没命中——40 天里人口 216793 一动不动，俸禄/忠诚/断粮/太守/开发
 * 全部静默失效。这解释了「人口增长还是没修复」。
 *
 * 现口径：`cityEconTick(state, cfg, ctx, { isTurn: true, turnDays })` 由
 * strategyTick 显式声明旬界；直接调用时才回落 `day % turnDays`。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyTick, dispatchGeneral, dispatchTick,
} from '../server/domain/strategy.js';
import { ensureCityEcon, loyaltyTick, cityEconTick, salaryDueOf } from '../server/domain/city-econ.js';
import { beginInteriorTask, advanceInteriorTasks, KINDS } from '../server/domain/interior-task.js';
import { disbandArmy } from '../server/domain/formation.js';
import { handleRequest } from '../server/handlers.js';

const cfg = loadConfig();
const ctx = (s) => ({ state: s, cfg, push() {}, schedule() {}, save() {}, log() {} });

function world() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  assert.equal(chooseOath(s, cfg, ctx(s), { lord: lords[0].id, city: lords[0].cities[0].id }).ok, true);
  const cid = Number(Object.keys(s.strategy.cities).find((id) => s.strategy.cities[id].owner === 'player'));
  return { s, cid };
}

/* ---------- ① 旬界相位：lastTurnDay 不是 10 的倍数也必须结算 ---------- */
test('P75-① 旬界判据不随 lastTurnDay 相位漂移（人口必须真的涨）', () => {
  const { s, cid } = world();
  const e = s.strategy.cityEcon[cid];
  e.pop = 10000;
  /* 关键：把相位故意错开到 %10 !== 0，这正是玩家存档 1846 的真实情形 */
  s.clock.day = 1847;
  s.strategy.lastTurnDay = 1846;
  const pop0 = e.pop;
  for (let i = 0; i < 30; i += 1) {
    s.clock.day += 1;
    strategyTick(s, cfg, ctx(s));
  }
  assert.ok(e.pop > pop0,
    `旬结算必须触发：人口 ${pop0} → ${e.pop}。旧实现 day%10 与 lastTurnDay 相位错开，整旬漏算。`);
  assert.ok(s.strategy.lastTurnDay > 1846, 'lastTurnDay 必须前进');
});

/* ---------- ② 相位为 9 时，俸禄与忠诚也必须结算 ---------- */
test('P75-② 相位 %10=9 时俸禄照扣、忠诚照算（不许整旬静默）', () => {
  const { s } = world();
  s.clock.day = 1859;
  s.strategy.lastTurnDay = 1849;          // 1859 - 1849 = 10 → 本次就是旬界
  assert.equal(1859 % 10, 9, '构造相位 9');
  const due = salaryDueOf(s);
  assert.ok(due > 0, '应有俸禄');
  s.roleRes.gold = 0;
  const before = (s.generals || []).filter((g) => !g.isProtagonist).map((g) => Number(g.loyal) || 0);
  const avg0 = before.reduce((a, b) => a + b, 0) / (before.length || 1);
  strategyTick(s, cfg, ctx(s));
  const after = (s.generals || []).filter((g) => !g.isProtagonist).map((g) => Number(g.loyal) || 0);
  const avg1 = after.reduce((a, b) => a + b, 0) / (after.length || 1);
  assert.ok(avg1 < avg0, `府库空虚必须扣忠诚：${avg0.toFixed(2)} → ${avg1.toFixed(2)}`);
});

/* ---------- ③ 欠饷必须在大事记留痕（事后可查） ---------- */
test('P75-③ 欠饷写进大事记，不是只闪一条提示', () => {
  const { s } = world();
  s.clock.day = 1860;
  s.roleRes.gold = 0;
  const r = loyaltyTick(s, cfg, ctx(s));
  assert.equal(r.salaryPaid, 0);
  const logged = (s.strategy.events || []).some((e) => /欠饷|府库空虚/.test(String(e.text || '')));
  assert.ok(logged, '大事记里必须有欠饷记录，否则玩家事后查不出忠诚为什么掉');
  assert.equal(Number(s.strategy.lastArrearDay), 1860, '同一天只记一次，避免连旬刷屏');
});

/* ---------- ④ 劝课生息真的加人口（完工日一次性结算） ---------- */
test('P75-④ 劝课生息完工必须真加人口，且过程日志不写「+0」', () => {
  const { s, cid } = world();
  const e = s.strategy.cityEcon[cid];
  e.pop = 20000;
  s.roleRes.gold = Math.max(Number(s.roleRes.gold) || 0, 5000);
  const pop0 = e.pop;
  const r = beginInteriorTask(s, cfg, ctx(s), { cityId: cid, kind: 'populate' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const start = Number(s.clock.day) || 1;
  /* 逐旬推进到完工 */
  const notes = [];
  for (let i = 0; i < 40; i += 1) {
    s.clock.day = start + i + 1;
    const out = advanceInteriorTasks(s, cfg, ctx(s));
    for (const t of out.ticked || []) notes.push(t);
  }
  assert.ok(e.pop > pop0,
    `劝课生息必须真加人口（${pop0} → ${e.pop}）；旧实现 popGain 定义了却只在完工分支生效，过程全 +0`);
  const zeroLog = (s.strategy.events || []).some((x) => /户口 \+0/.test(String(x.text || '')));
  assert.ok(!zeroLog, '过程日志不许写「户口 +0」，看着像毫无效果');
});

/* ---------- ⑤ 编队→解散闭环：兵回城、队伍消失 ---------- */
test('P75-⑤ 新建队伍→解散→兵回驻城（部队清空后仍能重建，不阻塞）', () => {
  const { s, cid } = world();
  const row = s.strategy.cities[cid];
  row.troops = 2000;
  /* 新开局武将驻地未必正好在首城：取一名武将放到本城，模拟玩家把闲置武将调回（真实场景） */
  const g = (s.generals || []).find((x) => !x.isLord) || (s.generals || [])[0];
  assert.ok(g, '应有武将');
  g.cityId = cid;
  g.transit = null;
  g.order = 0;
  for (const a of s.armys || []) {
    (a.generals || []).forEach((gid, i) => { if (Number(gid) === Number(g.id)) a.generals[i] = 0; });
  }
  /* 走真实入口：新建队伍（order 1~3 是新建许可区） */
  handleRequest(ctx(s), { name: 'army.dispose', msg: { cityId: cid, order: 1, position: 0, generalId: g.id } });
  const army = (s.armys || []).find((a) => Number(a.cityId) === cid && Number(a.order) === 1);
  assert.ok(army, '必须能新建队伍');
  army.soldiers = [300, 300, 300];
  const t0 = Number(row.troops) || 0;
  const d = disbandArmy(s, ctx(s), { armyId: army.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.ok(!(s.armys || []).some((a) => a.id === army.id), '队伍必须从名册移除');
  assert.ok((Number(row.troops) || 0) >= t0, `900 兵必须退回驻城：${t0} → ${row.troops}`);
});

/* ---------- ⑥ 阶段目标：阈值推进 + 达成发奖（stageGoalTick 唯一入口） ---------- */
test('P75-⑥ 阶段目标随城数推进，达成当旬发奖且只发一次', async () => {
  const { STAGE_GOALS, nextStageGoal } = await import('../server/domain/stage-goals.js');
  /* 纯展示口径：6 城前指向「立足」，10 城后指向「割据」 */
  assert.equal(nextStageGoal(3).id, 'foothold');
  assert.equal(nextStageGoal(3).need, 3);
  assert.equal(nextStageGoal(7).id, 'separatist');
  assert.equal(nextStageGoal(7).need, 3);

  /* 结算口径：把玩家推到刚好 6 城，stageGoalTick 应发「立足」奖励并记 stages */
  const { s, cid } = world();
  const playerCities = Object.keys(s.strategy.cities).filter((id) => s.strategy.cities[id].owner === 'player');
  assert.ok(playerCities.length >= 1);
  /* 先清空已达成记录，再补齐到阈值（模拟玩家一路打到 6 城） */
  s.strategy.stages = {};
  const need = STAGE_GOALS[0].at;
  const free = Object.keys(s.strategy.cities)
    .filter((id) => s.strategy.cities[id].owner !== 'player')
    .slice(0, Math.max(0, need - playerCities.length));
  for (const id of free) s.strategy.cities[id].owner = 'player';
  const owned = Object.values(s.strategy.cities).filter((c) => c.owner === 'player').length;
  assert.equal(owned, need, `应凑到 ${need} 城，实为 ${owned}`);

  const gold0 = Number(s.roleRes.gold) || 0;
  const { stageGoalTick } = await import('../server/domain/strategy.js');
  stageGoalTick(s, cfg, ctx(s));
  assert.ok(s.strategy.stages?.foothold, '达成后必须记 stages（记录达成日）');
  assert.ok((Number(s.roleRes.gold) || 0) >= gold0, '奖励金不得为负');

  /* 幂等：同一目标不许重复发奖 */
  const gold1 = Number(s.roleRes.gold) || 0;
  stageGoalTick(s, cfg, ctx(s));
  assert.equal(Number(s.roleRes.gold) || 0, gold1, '同一阶段目标不得重复发奖');

  /* 下一个目标必须前移 */
  assert.equal(nextStageGoal(owned, s.strategy.stages).id, 'separatist');
  void cid;
});
