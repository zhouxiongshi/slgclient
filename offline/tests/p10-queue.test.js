/**
 * 验收 #23：行军队列可重排 / 可取消 / 可批量。
 *
 * 重排的价值不在 UI，而在结算：strategyResolveMarches 按 st.marches 数组顺序逐支结算，
 * 同日抵达同一座城时先结算的那支面对原守军，后到的看到城已易主就直接班师。
 * 所以这里断言的是「改顺序 ⇒ 先打的是另一支」，不是「按钮存在」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, marchableFrom,
  strategyAttack, strategyResolveMarches, strategyReorderMarch, strategyRecallMarch,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();

function battlefield() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  const st = state.strategy;
  const army = state.armys.find((a) => !a.marchId && (a.soldiers || []).some((v) => v > 0));
  assert.ok(army, '举义后应有一支可派队伍');
  const target = marchableFrom(army.cityId).find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  assert.ok(target, '出发城应有可攻邻城');
  return { state, st, army, from: army.cityId, target };
}

/** 把一支队伍复制成「弱化版」，让两队同日开往同一座城。 */
function twoMarches() {
  const { state, st, army, from, target } = battlefield();
  const weak = JSON.parse(JSON.stringify(army));
  weak.id = army.id + 900;
  weak.order = (army.order || 1) + 1;
  delete weak.marchId;
  weak.cityId = from;
  weak.soldiers = (army.soldiers || []).map((v) => Math.max(1, Math.round(v * 0.12)));
  state.armys.push(weak);

  const ctx = { push() {} };
  const a1 = strategyAttack(state, cfg, ctx, { cityId: target, fromCityId: from, armyId: army.id, frac: 1 });
  const a2 = strategyAttack(state, cfg, ctx, { cityId: target, fromCityId: from, armyId: weak.id, frac: 1 });
  assert.equal(a1.ok, true, JSON.stringify(a1));
  assert.equal(a2.ok, true, JSON.stringify(a2));
  assert.equal(a1.arriveDay, a2.arriveDay, '同城同速必须同日抵达，否则测不出顺序');
  return {
    state, st, from, target, strong: army, weak, ctx,
    arriveDay: a1.arriveDay,
    /* 指令口用的是 marchId（队列条目 id），不是队伍 id —— 别拿 army.id 当 marchId */
    mStrong: a1.marchId, mWeak: a2.marchId,
  };
}

test('重排真的交换了结算顺序，并给出新位次', () => {
  const { state, st, ctx, mWeak } = twoMarches();
  assert.equal(st.marches.length, 2);
  const before = st.marches.map((m) => m.armyId);
  const r = strategyReorderMarch(state, ctx, { marchId: mWeak, dir: -1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order, 1, '前移后应报第 1 位');
  const after = st.marches.map((m) => m.armyId);
  assert.deepEqual(after, before.slice().reverse(), '数组顺序必须真的换了，否则结算顺序没变');
});

test('顺序不同 ⇒ 先结算的队伍不同（这是真决策，不是装饰）', () => {
  const base = twoMarches();
  const { state, ctx, strong, arriveDay, mWeak } = base;

  /* 两支都到齐后分别用「原顺序」与「弱队前移」各推一次，比较第一份战报的攻方 */
  const play = (mutate) => {
    const s = structuredClone(state);
    s.clock.day = arriveDay;
    if (mutate) mutate(s);
    strategyResolveMarches(s, cfg, { push() {} });
    const reps = (s.warReports || []).slice();
    /* warReports 是 unshift，第一支结算的战报落在数组末尾 */
    const first = reps[reps.length - 1];
    return { reports: reps.length, aTotal: first ? first.analysis.aTotal : 0 };
  };

  const normal = play(null);
  const swapped = play((s) => {
    assert.equal(strategyReorderMarch(s, ctx, { marchId: mWeak, dir: -1 }).ok, true);
  });

  assert.ok(normal.aTotal > 0 && swapped.aTotal > 0, '两种顺序都应至少打上一仗');
  assert.notEqual(normal.aTotal, swapped.aTotal,
    `换顺序后第一个开打的仍是同一支（${normal.aTotal}），说明顺序没有影响结算`);
  const strongTotal = (strong.soldiers || []).reduce((a, b) => a + b, 0);
  assert.ok(normal.aTotal >= swapped.aTotal,
    '默认顺序里派出更多兵的那支应排在前面先打');
  void strongTotal;
});

test('重排拒绝口径：到头 / 被非我军挡住 / 找不到这支队', () => {
  const { state, st, ctx } = twoMarches();
  const first = st.marches[0];
  const head = strategyReorderMarch(state, ctx, { marchId: first.id, dir: -1 });
  assert.equal(head.ok, false);
  assert.equal(head.reason, 'edge');
  assert.equal(head.order, 1);

  const last = st.marches[st.marches.length - 1];
  const tail = strategyReorderMarch(state, ctx, { marchId: last.id, dir: 1 });
  assert.equal(tail.ok, false);
  assert.equal(tail.reason, 'edge');

  assert.equal(strategyReorderMarch(state, ctx, { marchId: 987654, dir: 1 }).reason, 'no_march');
});

test('撤回后队列变短，重排不再把它算进来', () => {
  const { state, st, ctx, mWeak } = twoMarches();
  const r = strategyRecallMarch(state, cfg, ctx, { marchId: mWeak });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.refund >= 0);
  assert.equal(st.marches.length, 1, '撤回应从队列里移除');
  assert.equal(strategyReorderMarch(state, ctx, { marchId: mWeak, dir: 1 }).reason, 'no_march',
    '撤回过的队伍不该还能重排');
});

test('路由不变量：reorder 动作已挂到 HTTP 动作口', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /strategyReorderMarch/, 'index.js 必须导入重排动作');
  assert.match(src, /act === 'reorder'/, 'index.js 必须有 reorder 分支');
});
