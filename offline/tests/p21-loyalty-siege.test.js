/**
 * 2026-11-20 自迭代第二轮回归锁：忠诚可持续 / 围城可破城 / 编制上限 / 迁都 / 里程碑。
 *
 * 每一条都对应一个**实测复现过**的缺陷（挂机 150 旬的探针），不是想象出来的边界：
 *   · 主角（id 1000, isProtagonist）在第 62 旬因忠诚过低叛逃离队 —— 整局叙事断裂；
 *   · 未委任武将每旬 -1 无下限，48 旬后跌破 40，之后 10%/旬 出走；
 *   · 5 个岗位是全图上限，第 6 名武将起注定流失 —— 「招人」变成惩罚；
 *   · 「名士来投」名声含帐下人数，人越多来投越快 → 挂机 150 旬帐下 19 人、1 座城；
 *   · 围城损耗写死 2%/旬且 120 日撤围 → 最多掉 15% 守军，`fallen` 是死代码；
 *   · 都城被攻破后 st.playerCity 仍指向敌城，capitalLost 永久为真；
 *   · 480 条事件里大半是「某某晋为中郎将」，玩家自己的战事被挤出；
 *   · 18 城之后没有任何新目标。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyMap,
  spawnFactionAssault, assaultEscalationTick, rebindCapitalIfLost, rebindArmiesIfStranded,
  stageGoalTick, STAGE_GOALS, UNIFY_CITIES, generalCapacity,
  recordEvent, defectTick, strategyAttack,
} from '../server/domain/strategy.js';
import {
  ensureCityEcon, loyaltyTick, LOYAL_BASELINE, generalCapacity as capOf, salaryDueOf,
} from '../server/domain/city-econ.js';
import { nextStageGoal } from '../server/domain/stage-goals.js';

const cfg = loadConfig();

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, pushes, options: {},
    push(n, m) { pushes.push({ n, m }); },
    schedule() {}, save() {}, log() {},
  };
}

function freshState() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const ctx = makeCtx(state);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  const r = chooseOath(state, cfg, ctx, { lord: cao.id, city: cao.cities[0].id });
  assert.equal(r.ok, true, '举义应成功');
  return { state, ctx };
}

/* ---------------------------------------------------------------- 忠诚 */

test('主角不参与忠诚系统：既不衰减也不叛逃', () => {
  const { state, ctx } = freshState();
  const prot = state.generals.find((g) => g.isProtagonist);
  assert.ok(prot, '开局应有主角');
  prot.loyal = 30;                       // 人为压到叛逃线以下
  state.roleRes.gold = 1e6;              // 排除欠饷干扰
  for (let i = 0; i < 40; i++) {
    state.clock.day = (i + 1) * 10;
    loyaltyTick(state, cfg, ctx);
  }
  assert.ok(state.generals.some((g) => g.id === prot.id), '主角永远不能被移除');
  assert.equal(Number(prot.loyal), 30, '主角忠诚不因旬结算变化（不是雇员）');
});

test('未委任武将回落到基线 70 后不再继续下降（旧的 -1/旬 无下限）', () => {
  const { state, ctx } = freshState();
  const g = state.generals.find((x) => !x.isProtagonist);
  g.loyal = 88;
  state.roleRes.gold = 1e6;
  for (let i = 0; i < 80; i++) {
    state.clock.day = (i + 1) * 10;
    /* 每旬把民心和库房按住，专测「纯闲置」这一条：不这样的话民心崩的额外 -1
       会把人一路压到 45，测的就不是闲置回落了。 */
    for (const e of Object.values(state.strategy.cityEcon)) e.morale = 70;
    loyaltyTick(state, cfg, ctx);
  }
  assert.equal(Number(g.loyal), LOYAL_BASELINE, `闲置应停在基线 ${LOYAL_BASELINE}，实测 ${g.loyal}`);
  assert.ok(state.generals.some((x) => x.id === g.id), '不应因闲置被清退');
});

test('民心崩的额外惩罚有下限 45，不会把闲置武将一路压到 0', () => {
  const { state, ctx } = freshState();
  const g = state.generals.find((x) => !x.isProtagonist);
  g.loyal = 88;
  state.roleRes.gold = 1e6;
  for (let i = 0; i < 80; i++) {
    state.clock.day = (i + 1) * 10;
    for (const e of Object.values(state.strategy.cityEcon)) e.morale = 10;   // 全境民心崩
    loyaltyTick(state, cfg, ctx);
  }
  assert.equal(Number(g.loyal), 45, `民心崩应停在 45（3% 出走风险区），实测 ${g.loyal}`);
  assert.ok(Number(g.loyal) > 0, '不允许压到 0');
});

test('欠饷惩罚跳过主角：普通武将 -5，主角不动', () => {
  const { state, ctx } = freshState();
  const prot = state.generals.find((g) => g.isProtagonist);
  const normal = state.generals.find((g) => !g.isProtagonist);
  prot.loyal = 90;
  normal.loyal = 90;
  state.roleRes.gold = 0;                // 必然欠饷
  loyaltyTick(state, cfg, ctx);
  assert.equal(Number(prot.loyal), 90, '主角不吃欠饷罚');
  assert.ok(Number(normal.loyal) <= 85, `普通武将应被扣忠诚，实测 ${normal.loyal}`);
});

test('离心预警只播一次，且在跌破 55 时触发', () => {
  const { state, ctx } = freshState();
  const g = state.generals.find((x) => !x.isProtagonist);
  g.loyal = 50;
  state.roleRes.gold = 1e6;
  loyaltyTick(state, cfg, ctx);
  const warned = (state.strategy.events || []).filter((e) => e.text.includes('离心之意'));
  assert.equal(warned.length, 1, '首次跌破应有一条预警');
  loyaltyTick(state, cfg, ctx);
  const again = (state.strategy.events || []).filter((e) => e.text.includes('离心之意'));
  assert.equal(again.length, 1, '同一个人不应反复预警');
});

/* ---------------------------------------------------------------- 编制 */

test('帐下编制 = 4 + 城数×2 + 里程碑加成', () => {
  const { state } = freshState();
  const cities = Object.values(state.strategy.cities).filter((c) => c.owner === 'player').length;
  assert.equal(generalCapacity(state), Math.max(4, 4 + cities * 2));
  assert.equal(capOf(state), generalCapacity(state), 'panels 用的口径与结算一致');
  state.strategy.bonusSeats = 3;
  assert.equal(generalCapacity(state), 4 + cities * 2 + 3, '里程碑加成要算进去');
});

test('编制已满时不再有「名士来投」（旧版名声含人数，越招越快）', () => {
  const { state, ctx } = freshState();
  // 把人塞满
  const cap = generalCapacity(state);
  while (state.generals.length < cap) {
    state.generals.push({ id: 900000 + state.generals.length, cfgId: 100001, level: 1, loyal: 80, skills: [] });
  }
  let got = null;
  for (let i = 0; i < 40 && !got; i++) {
    state.strategy.turn = i + 1;
    state.clock.day = (i + 1) * 10;
    got = defectTick(state, cfg, ctx);
  }
  assert.equal(got, null, '编制满时不应再来投');
  assert.equal(state.generals.length, cap, '人数不得超过编制');
});

/* ---------------------------------------------------------------- 围城 */

test('围城会真的破城：民心崩到 20 以内则城内开门', () => {
  const { state, ctx } = freshState();
  const map = strategyMap();
  const [targetId] = Object.entries(state.strategy.cities).find(([, c]) => c.owner === 'player');
  const target = map.cities.find((c) => c.id === Number(targetId));
  const g = spawnFactionAssault(state, cfg, ctx, { id: 'jizhou', name: '袁绍' }, target, 6000);
  assert.ok(g, '应能生成来犯军');
  assert.equal(g.targetCity, Number(targetId), '来犯军要记住目标城');

  let fell = null;
  for (let d = 10; d <= 200 && !fell; d += 10) {
    state.clock.day = d;
    const out = assaultEscalationTick(state, cfg, ctx);
    if (out.some((o) => o.kind === 'fallen')) fell = out.find((o) => o.kind === 'fallen');
  }
  assert.ok(fell, `围城放着不管应丢城（旧版 2%/旬 + 120 日撤围永远破不了）`);
  assert.equal(state.strategy.cities[targetId].owner, 'jizhou');
  assert.equal(g.cleared, true, '破城后来犯军下场');
});

test('围城优先围「出发时的目标城」，而不是坐标最近的另一座城', () => {
  const { state, ctx } = freshState();
  const map = strategyMap();
  const own = Object.entries(state.strategy.cities).filter(([, c]) => c.owner === 'player');
  const targetId = Number(own[own.length - 1][0]);
  const target = map.cities.find((c) => c.id === targetId);
  const g = spawnFactionAssault(state, cfg, ctx, { id: 'jizhou', name: '袁绍' }, target, 3000);
  assert.equal(g.targetCity, targetId);
  state.clock.day = 60;                  // 过宽限期
  assaultEscalationTick(state, cfg, ctx);
  assert.equal(state.strategy.cities[targetId].besieged, true, '被围的必须是目标城');
  const others = Object.entries(state.strategy.cities)
    .filter(([id, c]) => Number(id) !== targetId && c.owner === 'player' && c.besieged);
  assert.equal(others.length, 0, '不该顺手围到别的城');
});

test('来犯军到 180 日粮尽自退（不会在地图上无限堆积）', () => {
  const { state, ctx } = freshState();
  const map = strategyMap();
  const [targetId] = Object.entries(state.strategy.cities).find(([, c]) => c.owner === 'player');
  const target = map.cities.find((c) => c.id === Number(targetId));
  const g = spawnFactionAssault(state, cfg, ctx, { id: 'jizhou', name: '袁绍' }, target, 6000);
  // 把守军与民心撑住，模拟「玩家守住了」
  state.strategy.cities[targetId].troops = 999999;
  state.strategy.cityEcon[targetId].morale = 100;
  let withdrew = false;
  for (let d = 10; d <= 200 && !withdrew; d += 10) {
    state.clock.day = d;
    state.strategy.cityEcon[targetId].morale = 100;   // 每旬回满，专测撤围
    state.strategy.cities[targetId].troops = 999999;
    withdrew = assaultEscalationTick(state, cfg, ctx).some((o) => o.kind === 'withdraw');
  }
  assert.equal(withdrew, true, '180 日应粮尽自退');
  assert.equal(g.cleared, true);
});

/* ---------------------------------------------------------------- 迁都 */

test('都城被打下来后自动迁都，playerCity 不会一直指着敌城', () => {
  const { state, ctx } = freshState();
  const st = state.strategy;
  const capId = st.playerCity;
  const other = Object.entries(st.cities).find(([id, c]) => c.owner === 'player' && Number(id) !== capId);
  assert.ok(other, '至少还有一座己方城');
  st.cities[capId].owner = 'jizhou';                 // 模拟都城被攻破
  const r = rebindCapitalIfLost(state, ctx);
  assert.ok(r, '应发生迁都');
  assert.notEqual(st.playerCity, capId, 'playerCity 必须换城');
  assert.equal(st.cities[st.playerCity].owner, 'player', '新都城必须是自己的');
  assert.ok((st.events || []).some((e) => e.text.includes('行在移驻')), '迁都要有事件留痕');
});

test('无城可迁时不乱改 playerCity（亡国交给 failstate）', () => {
  const { state, ctx } = freshState();
  const st = state.strategy;
  const capId = st.playerCity;
  for (const id of Object.keys(st.cities)) st.cities[id].owner = 'jizhou';
  const r = rebindCapitalIfLost(state, ctx);
  assert.equal(r, null);
  assert.equal(st.playerCity, capId, '没有己方城时保持原值');
});

/* ---------------------------------------------------------------- 里程碑 */

test('阶段目标达成发实际收益（金 / 名望 / 编制），不只播一行字', () => {
  const { state, ctx } = freshState();
  const ids = Object.keys(state.strategy.cities).map(Number);
  const goal = STAGE_GOALS[0];
  for (const id of ids) state.strategy.cities[id].owner = 'player';
  for (const id of ids.slice(goal.at)) state.strategy.cities[id].owner = 'han';
  state.roleRes.gold = 10000;
  state.clock.day = 100;
  const hit = stageGoalTick(state, cfg, ctx);
  assert.deepEqual(hit.map((h) => h.id), [goal.id]);
  assert.equal(state.roleRes.gold, 10000 + goal.gold, '里程碑应发金');
  assert.equal(Number(state.strategy.fame), goal.fame, '里程碑应加名望');
});

test('一统线达成记 sandboxEnding（不硬中断，可继续经营）', () => {
  const { state, ctx } = freshState();
  const ids = Object.keys(state.strategy.cities).map(Number);
  for (const id of ids) state.strategy.cities[id].owner = 'player';
  state.clock.day = 500;
  stageGoalTick(state, cfg, ctx);
  const e = state.strategy.sandboxEnding;
  assert.ok(e, `占 ${ids.length} 城应触发一统（阈值 ${UNIFY_CITIES}）`);
  assert.equal(e.id, 'unify');
  assert.equal(e.cities, ids.length);
  // 再跑一次不重复触发
  const again = stageGoalTick(state, cfg, ctx);
  assert.equal(again.length, 0, '终局只结算一次');
});

test('nextStageGoal 给出「还差几城」，全达成后指向一统线', () => {
  const g1 = nextStageGoal(5, {});
  assert.equal(g1.id, STAGE_GOALS[0].id);
  assert.equal(g1.need, STAGE_GOALS[0].at - 5);
  const all = Object.fromEntries(STAGE_GOALS.map((s) => [s.id, 1]));
  /* 用相对阈值取「还差 2 城」，避免把旧的一统线数值写死在测试里。 */
  const g2 = nextStageGoal(UNIFY_CITIES - 2, all);
  assert.equal(g2.id, 'unify');
  assert.equal(g2.need, 2);
});

/* ---------------------------------------------------------------- 事件流 */

test('NPC 背景音走 quiet 通道，不挤占玩家事件流', () => {
  const { state } = freshState();
  const before = (state.strategy.events || []).length;
  recordEvent(state, '某诸侯麾下某人治政有功，晋为亭长（功勋官阶 1）。', { quiet: true });
  assert.equal((state.strategy.events || []).length, before, 'quiet 不得写 events');
  assert.ok((state.strategy.dynamics || []).some((e) => e.text.includes('晋为亭长')), 'quiet 应写 dynamics');
  recordEvent(state, '我军取陈留。');
  assert.equal((state.strategy.events || []).length, before + 1, '普通事件照常进 events');
});

/* ---------------------------------------------------------------- 口径 */

test('旬俸合计与 loyaltyTick 的 salaryDue 同源', () => {
  const { state, ctx } = freshState();
  state.roleRes.gold = 1e6;
  const before = salaryDueOf(state);
  const r = loyaltyTick(state, cfg, ctx);
  assert.equal(r.salaryDue, before, '面板显示的旬俸必须等于实际扣款');
});


/* ---------------------------------------------------------------- 部队驻地
 *
 * ★ 2026-11-20 实测缺陷：`army.cityId` 只在「行军抵达」的四个分支里赋值，
 *   城被攻破时没人管。玩家部队驻陈留 → 陈留被围城打破 → playerCity 迁走，
 *   但 army.cityId 仍是那座敌城 → 之后每次出征都在 fromOk 处返回
 *   `{code:6, reason:'not_own_city'}`。实测主动出征 150 旬，95 次请求全部 code 6，
 *   玩家一次都没能出兵，而地图上还有 4 座城、帐下 10 名武将 —— 永久软锁。
 */

test('驻地失守：部队退回己方城，武将 cityId 同步', () => {
  const { state, ctx } = freshState();
  const army = state.armys.find((a) => (a.generals || []).some((g) => g));
  assert.ok(army, '开局应有一支带将部队');
  const lost = Number(army.cityId);
  assert.equal(state.strategy.cities[lost].owner, 'player');
  // 造出「驻地已被敌方攻破」的状态
  state.strategy.cities[lost].owner = 'yuan';
  const moved = rebindArmiesIfStranded(state, ctx);
  assert.ok(moved.some((m) => m.armyId === army.id), '悬空部队应被回收');
  assert.notEqual(Number(army.cityId), lost, '驻地不能继续指向敌城');
  assert.equal(state.strategy.cities[army.cityId].owner, 'player', '新驻地必须是己方城');
  const gid = army.generals.find((g) => g);
  const g = state.generals.find((x) => x.id === gid);
  assert.equal(Number(g.cityId), Number(army.cityId), '武将驻地必须跟随部队');
});

test('驻地有效时不动：正常驻扎的部队不应被搬走', () => {
  const { state, ctx } = freshState();
  const army = state.armys.find((a) => (a.generals || []).some((g) => g));
  const before = Number(army.cityId);
  const moved = rebindArmiesIfStranded(state, ctx);
  assert.equal(moved.length, 0, '无悬空部队时不应产生任何搬迁');
  assert.equal(Number(army.cityId), before);
});

test('行军中不回收：有 marchId 的队伍跳过（抵达分支自会归位）', () => {
  const { state, ctx } = freshState();
  const army = state.armys.find((a) => (a.generals || []).some((g) => g));
  const lost = Number(army.cityId);
  state.strategy.cities[lost].owner = 'yuan';
  army.marchId = 999;
  const moved = rebindArmiesIfStranded(state, ctx);
  assert.equal(moved.some((m) => m.armyId === army.id), false, '行军中不得硬改驻地');
  assert.equal(Number(army.cityId), lost, '行军中的 cityId 保持不动');
});

test('无己方城时不乱动（亡国交 failstate）', () => {
  const { state, ctx } = freshState();
  for (const c of Object.values(state.strategy.cities)) c.owner = 'yuan';
  const before = state.armys.map((a) => a.cityId);
  const moved = rebindArmiesIfStranded(state, ctx);
  assert.equal(moved.length, 0);
  assert.deepEqual(state.armys.map((a) => a.cityId), before);
});

test('回收后可以再次出征（软锁解除）', () => {
  const { state, ctx } = freshState();
  const army = state.armys.find((a) => (a.generals || []).some((g) => g));
  const lost = Number(army.cityId);
  // 先确认软锁：驻地被占后出发校验必失败
  state.strategy.cities[lost].owner = 'yuan';
  const blocked = strategyAttack(state, cfg, ctx, { cityId: 1, armyId: army.id, frac: 1, fromCityId: lost });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'not_own_city');
  // 回收后从新驻地出发：不再卡在 not_own_city
  rebindArmiesIfStranded(state, ctx);
  const home = Number(army.cityId);
  assert.equal(state.strategy.cities[home].owner, 'player');
  const again = strategyAttack(state, cfg, ctx, { cityId: 1, armyId: army.id, frac: 1, fromCityId: home });
  assert.notEqual(again.reason, 'not_own_city', '回收后不应再因驻地无效被拒');
});
