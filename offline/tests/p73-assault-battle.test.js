/**
 * P73 回归锁：诸侯来犯**抵达即打一场真实守城战**。
 *
 * 对应玩家实测（2026-11-27）：「公孙瓒的部队走到昌邑就消失了，军情有记录，
 * 但没有任何战斗痕迹，也没跳战斗界面」。
 *
 * 旧链路的三个断点，每一条都在这里被钉住：
 *   1) 出兵时写了一份没有 anim、没有结算的假战报（「此战已写入战报」）→ 战报点开是空的；
 *   2) 抵达分支只把行军标记 resolved，从来不打仗 → 部队到城下凭空消失；
 *   3) 真正的伤害来自 40 日后的围城倒计时，与「抵达」脱节 → 玩家看到的和结算的不是一回事。
 *
 * 新口径：抵达当日走与出征同一个内核（resolveBattle），产出**我军视角**、
 * 带 anim 的战报（客户端据此自动打开战报窗并回放，多场排队）。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyMap,
  spawnFactionAssault, assaultBattleTick, applyOrders, factionConf,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, pushes, options: {},
    push(n, m) { pushes.push({ n, m }); },
    schedule() {}, save() {}, log() {},
  };
}

function world() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const ctx = makeCtx(state);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  assert.equal(chooseOath(state, cfg, ctx, { lord: cao.id, city: cao.cities[0].id }).ok, true);
  state.clock.day = 1;
  const cityId = Number(Object.keys(state.strategy.cities)
    .find((id) => state.strategy.cities[id].owner === 'player'));
  const target = strategyMap().cities.find((c) => c.id === cityId);
  return { state, ctx, cityId, target };
}

const assault = (state, ctx, target, troops, faction = { id: 'youzhou', name: '公孙瓒' }) =>
  spawnFactionAssault(state, cfg, ctx, faction, target, troops);

test('P73-① 抵达当日开打：产出带回放的战报，来犯军就地了结', () => {
  const { state, ctx, cityId, target } = world();
  state.strategy.cities[cityId].troops = 600;
  const g = assault(state, ctx, target, 900);
  assert.ok(g, '应生成来犯军');
  assert.ok(Number(g.arriveDay) > 1, '来犯军必须有抵达日');

  const before = state.warReports.length;
  state.clock.day = Number(g.arriveDay) - 1;
  assert.equal(assaultBattleTick(state, cfg, ctx).length, 0, '未抵达不得开战');
  assert.equal(state.warReports.length, before, '未抵达不得产生战报');

  state.clock.day = Number(g.arriveDay);
  const out = assaultBattleTick(state, cfg, ctx);
  assert.equal(out.length, 1, '抵达当日必须打一仗');

  const rep = state.warReports[0];
  assert.equal(rep.defense, true, '守城战必须标记 defense');
  assert.ok(rep.anim && (rep.anim.rounds || []).length > 0, '战报必须带可回放的动作流');
  assert.equal(rep.anim.defense, true, '回放要按守城战排版');
  assert.match(String(rep.anim.a.name), /守军/, '回放里我军是守方');
  assert.ok(['0', '1', '2'].includes(String(rep.result)), 'result 必须是 0/1/2');

  assert.equal(g.cleared, true, '打完来犯军必须撤营');
  assert.equal(g.battleResolved, true, '同一支军不得二次结算');

  const owner = state.strategy.cities[cityId].owner;
  if (String(rep.result) === '2') assert.equal(owner, 'player', '我军胜则城池不能丢');
  else if (String(rep.result) === '0') assert.notEqual(owner, 'player', '我军负则城池应易帜');
});

test('P73-② 战报是「我军视角」：我军=守方、敌军=攻城方，兵力口径不颠倒', () => {
  const { state, ctx, cityId, target } = world();
  state.strategy.cities[cityId].troops = 800;
  const g = assault(state, ctx, target, 700);
  state.clock.day = Number(g.arriveDay);
  assaultBattleTick(state, cfg, ctx);
  const rep = state.warReports[0];
  /* 我军是守方，兵力应远大于来犯的 700（城里还有驻军）；若换边没做对，
     aTotal 会变成攻方的 700。 */
  assert.ok(rep.analysis.aTotal >= 700, `我军兵力口径异常：${rep.analysis.aTotal}`);
  assert.equal(rep.analysis.dTotal >= 700, true, `敌军兵力异常：${rep.analysis.dTotal}`);
  assert.equal(rep.analysis.defense, true);
  assert.ok(rep.analysis.aRemain.length >= 1 && rep.analysis.dRemain.length >= 1, '双方余兵都要有');
  assert.ok(Array.isArray(rep.analysis.woundedTo), '伤兵去向要写进战报');
});

test('P73-③ 出兵不再伪造战报：空战报是「没有任何战斗痕迹」的直接来源', () => {
  const { state, ctx, target } = world();
  const before = state.warReports.length;
  assault(state, ctx, target, 800);
  assert.equal(state.warReports.length, before, '出兵时不得写战报');
  assert.ok(!(state.warReports || []).some((r) => /此战已写入战报/.test(String(r.summary || ''))),
    '不得再出现「此战已写入战报」这类假战报');
});

test('P73-④ 驻城部队参战：城里 13k 大军不能看着城破', () => {
  const { state, ctx, cityId, target } = world();
  state.strategy.cities[cityId].troops = 100;
  const army = (state.armys || []).find((a) => !a.marchId);
  assert.ok(army, '开局应有可用部队');
  const gens = (state.generals || []).filter((x) => !x.isProtagonist).slice(0, 3).map((x) => x.id);
  army.cityId = cityId;
  delete army.marchId;
  army.soldiers = [1200, 1200, 1200];
  army.generals = gens;
  const g = assault(state, ctx, target, 500);
  state.clock.day = Number(g.arriveDay);
  assaultBattleTick(state, cfg, ctx);
  const rep = state.warReports[0];
  assert.ok(rep.analysis.aTotal >= 3700,
    `驻城部队必须并进守军（城 100 + 部 3600），实际我军 ${rep.analysis.aTotal}`);
});

test('P73-⑤ 旧档营地（无抵达日）也会补打一场，不会永远静默', () => {
  const { state, ctx, cityId, target } = world();
  state.strategy.cities[cityId].troops = 500;
  const g = assault(state, ctx, target, 600);
  /* 模拟修复前的存档：有兵力/目标/出现日，但没有 arriveDay、没有战斗记录 */
  delete g.arriveDay;
  delete g.battleResolved;
  g.cleared = false;
  state.clock.day = Number(g.spawnDay) + 3;
  const out = assaultBattleTick(state, cfg, ctx);
  assert.equal(out.length, 1, '旧档营地必须补打');
  assert.equal(g.cleared, true);
  assert.ok(state.warReports[0].anim, '旧档补打同样要有回放');
});

test('P73-⑥ 同日多支来犯各自成局；重复 tick 不会重复结算', () => {
  const { state, ctx, cityId, target } = world();
  state.strategy.cities[cityId].troops = 3000;
  const a = assault(state, ctx, target, 800, { id: 'youzhou', name: '公孙瓒' });
  const b = assault(state, ctx, target, 700, { id: 'xuzhou', name: '刘备' });
  assert.ok(a && b, '两支来犯军都要生成');
  const day = Math.max(Number(a.arriveDay), Number(b.arriveDay));
  state.clock.day = day;
  const first = assaultBattleTick(state, cfg, ctx);
  const second = assaultBattleTick(state, cfg, ctx);
  assert.equal(first.length, 2, '同日两支来犯应各打一场（客户端负责排队播）');
  assert.equal(second.length, 0, '第二遍不得重复结算');
  assert.equal((state.warReports || []).filter((r) => r.defense).length, 2);
});

test('P73-⑦ 来犯军兵力不再 ÷6：显示的就是这一仗真正参战的兵', () => {
  const { state, ctx, target } = world();
  const g = assault(state, ctx, target, 2400);
  assert.equal(Number(g.soldiers), 2400,
    `来犯军兵力应与抽调数一致，实际 ${g.soldiers}`);
  const march = (state.strategy.marches || []).find((m) => m.factionId === 'youzhou');
  assert.ok(march, '必须有可见行军');
  assert.equal(Number(march.troops), 2400, '行军牌上的兵力也要一致');
});

test('P73-⑧ 旬界来犯不判归属：城不许在 applyOrders 里静默易帜', () => {
  const { state, ctx, cityId, target } = world();
  state.strategy.cities[cityId].troops = 100;
  const faction = factionConf().factions[0];
  const before = state.strategy.cities[cityId].owner;
  applyOrders(state, cfg, ctx, faction, {
    protocol: 'slg-ai-orders-v1', turn: 1, faction: faction.id,
    internal_orders: [],
    strategy_orders: [{
      id: 'S1', type: '出征', target: String(cityId), params: { troops: 4000 },
    }],
  });
  assert.equal(state.strategy.cities[cityId].owner, before,
    '来犯只生成本地地图的军，归属只能由守城战的结果决定');
  assert.ok(state.garrisons.some((g) => Number(g.targetCity) === cityId),
    '必须留下可见的来犯军，等抵达日开打');
  /* 这一条是给 applyOrders 里那个 continue 上锁：一旦有人把空战报块删掉顺手
     带走 continue，就会穿透到战略层占城逻辑，城在旬界无声易主。 */
});
