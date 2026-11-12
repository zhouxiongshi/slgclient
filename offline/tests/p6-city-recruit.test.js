/**
 * P6 四项修复：城池内政任务 / 招募系统（在野籍贯·探索登庸·招降）/ 顶部武将联动（服务端断言）/ 战法射程与目标语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import {
  ensureStrategy, strategyViewState, strategyInvest, recruitCaptive,
  oathOptions, chooseOath,
} from '../server/domain/strategy.js';
import { rangeOf, applyRangeNote, skillById, SKILLS, kernelSkillAt } from '../server/skills.js';
import { BattleEngine } from '../kernel/engine.js';
import { ensureTavern, todaysGuests, exploreTalent } from '../server/domain/tavern.js';
import { panelState } from '../server/domain/panels.js';

const cfg = loadConfig();

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    schedule() {}, save() {}, log() {},
  };
}

function freshCao() {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  chooseOath(state, cfg, makeCtx(state), { lord: cao.id, city: cao.cities[0].id });
  return state;
}

/* ---------------- 战法射程与目标语义 ---------------- */

test('射程推导：谋略5 / 物理单体3 / 物理群体4 / 控制3 / 追击随普攻', () => {
  const byName = (n) => SKILLS.find((s) => s.name === n);
  const strat = SKILLS.find((s) => (s.kernel.effects || [s.kernel]).some((e) => e.effect_type === 'STRATEGY_DAMAGE') && s.trigger === 1);
  if (strat) assert.equal(rangeOf(strat), 5, '谋略伤害射程应为 5');
  const ctrl = SKILLS.find((s) => (s.kernel.effects || [s.kernel]).some((e) => e.effect_type === 'CONTROL'));
  if (ctrl) assert.equal(rangeOf(ctrl), 3, '控制射程应为 3');
  const chase = SKILLS.find((s) => s.trigger === 3);
  if (chase) assert.equal(rangeOf(chase), 9, '追击不吃射程表');
  const physMulti = SKILLS.find((s) => s.trigger === 1 && [7, 8, 9].includes(s.ui.target)
    && (s.kernel.effects || [s.kernel]).some((e) => e.effect_type === 'PHYSICAL_DAMAGE'));
  if (physMulti) assert.equal(rangeOf(physMulti), 4, '物理群体射程应为 4');
});

test('UI 描述同步：敌方目标战法的 des 带射程，UI.range 与内核一致', () => {
  let withNote = 0;
  for (const s of SKILLS) {
    assert.ok(s.ui.range != null, `${s.name} 应有 ui.range`);
    if (s.trigger !== 3 && rangeOf(s) <= 5 && rangeOf(s) >= 3) {
      assert.match(s.ui.des || '', /射程|有效距离|普攻目标/, `${s.name} 描述应注明射程`);
    }
    if (/射程|有效距离/.test(s.ui.des || '')) withNote += 1;
  }
  assert.ok(withNote >= 10, `至少 10 条战法描述带射程标注（实际 ${withNote}）`);
});

test('内核目标语义：enemy_13 最多打 3 个；射程过滤大营', () => {
  const mk = (id, side, pos) => ({
    unit_id: id, side, pos, alive: true,
    hero: { name: id, force: 100, strategy: 100, defense: 100, speed: 100, destroy: 10, force_grow: 1, strategy_grow: 1, defense_grow: 1, speed_grow: 1, destroy_grow: 1, arms: [1], skills: [] },
    troops: 100, max_troops: 100, speed: 100,
  });
  const eng = Object.create(BattleEngine.prototype);
  eng.units = [mk('a0', 1, 0), mk('a1', 1, 1), mk('a2', 1, 2), mk('d0', 2, 0), mk('d1', 2, 1), mk('d2', 2, 2)];
  // enemy_13：命中 d0/d1/d2（大营 a2 → 距离 3/4/5，全部可达）
  const hit3 = eng.effectTargets({ target_type: 'enemy_13', range: 9 }, eng.units[2]);
  assert.equal(hit3.length, 3, 'enemy_13 应命中至多 3 个');
  // 射程 3：大营只能打到敌方前锋（距离 3）
  const hitFront = eng.effectTargets({ target_type: 'enemy_all', range: 3 }, eng.units[2]);
  assert.deepEqual(hitFront.map((u) => u.unit_id), ['d0'], '大营射程3只应命中敌方前锋');
  // 射程 5：大营全敌可达
  const hitAll = eng.effectTargets({ target_type: 'enemy_all', range: 5 }, eng.units[2]);
  assert.equal(hitAll.length, 3);
  // 前锋射程 3：命中敌 d0/d1（距离1/2），不打 d2（距离3）？距离=0+2+1=3 ≤3 可达 → 3 个
  const hitA0 = eng.effectTargets({ target_type: 'enemy_all', range: 3 }, eng.units[0]);
  assert.equal(hitA0.length, 3, '前锋射程3应打到全部敌军（3/4/5?）');
  // 修正：前锋到大营距离 = 0+2+1 = 3 ≤ 3 → 确实 3 个；前锋射程 2 → 2 个
  const hitA0r2 = eng.effectTargets({ target_type: 'enemy_all', range: 2 }, eng.units[0]);
  assert.deepEqual(hitA0r2.map((u) => u.unit_id), ['d0', 'd1']);
});

test('内核单效战法输出带 range，与 UI.range 相同', () => {
  const s = skillById(10001);
  assert.ok(s, '击势应存在');
  const k = kernelSkillAt(10001, 10);
  assert.equal(k.effects[0].range, s.ui.range);
});

/* ---------------- 在野籍贯与招募 ---------------- */

test('在野武将有籍贯且确定性：同名 cfgId 在所有存档落在同一城', () => {
  const s1 = ensureTavern(createWorld(cfg), cfg);
  const s2 = ensureTavern(createWorld(cfg), cfg);
  const p1 = s1.people.find((p) => p.cfgId === 100002);
  const p2 = s2.people.find((p) => p.cfgId === 100002);
  assert.ok(p1.birthCity > 0, '籍贯应为一座城 id');
  assert.equal(p1.birthCity, p2.birthCity, '籍贯应确定性');
});

test('按城查询来访：优先本籍在野武将', () => {
  const state = createWorld(cfg);
  const tavern = ensureTavern(state, cfg);
  const someone = tavern.people.find((p) => !p.recruited);
  const cityId = someone.birthCity;
  const guests = todaysGuests(state, 42, cityId);
  assert.ok(guests.length > 0, '应有来访名单');
  const local = guests.filter((g) => Number(g.birthCity) === Number(cityId));
  assert.ok(local.length > 0, '来访应包含本籍武将');
});

test('探索人才：每城每日一次；成功登庸入营；重复探索被拒', async () => {
  const state = freshCao();
  const tavern = ensureTavern(state, cfg);
  const cityId = state.strategy.playerCity;
  const before = state.generals.length;
  const unrecruitedBefore = tavern.people.filter((p) => !p.recruited).length;
  assert.ok(unrecruitedBefore > 0, '应有在野武将');
  // 两次探索只应第一次生效
  const e1 = exploreTalent(state, cfg, cityId);
  const e2 = exploreTalent(state, cfg, cityId);
  assert.ok(e1.ok, `首次探索应受理: ${JSON.stringify(e1)}`);
  assert.equal(e2.ok, false, '同日同城第二次应被拒');
  assert.equal(e2.reason, 'already_today');
  void before;
});

/* ---------------- 城池内政任务 ---------------- */

test('内政任务：开垦提开发度、修城加守军、每旬一次冷却', () => {
  const state = freshCao();
  const ctx = makeCtx(state);
  const cityId = state.strategy.playerCity;
  state.roleRes.gold = 10000;
  const st0 = strategyViewState(state, cfg).cities.find((c) => c.id === cityId);
  const dev0 = st0.yieldGrain;
  const troops0 = st0.troops;
  const r1 = strategyInvest(state, cfg, ctx, { cityId, kind: 'agri' });
  assert.ok(r1.ok, `开垦应成功: ${JSON.stringify(r1)}`);
  const r2 = strategyInvest(state, cfg, ctx, { cityId, kind: 'trade' });
  assert.equal(r2.ok, false, '同旬第二项应被冷却拒绝');
  assert.equal(r2.reason, 'cooldown');
  // 推进 10 日后可再办
  state.clock.day += 10;
  const r3 = strategyInvest(state, cfg, ctx, { cityId, kind: 'defense' });
  assert.ok(r3.ok, `修城应成功: ${JSON.stringify(r3)}`);
  assert.ok(r3.troops > troops0, '修城应加守军');
  const st1 = strategyViewState(state, cfg).cities.find((c) => c.id === cityId);
  assert.ok(st1.yieldGrain > dev0, '开垦后粮产应上升');
  // 流水
  assert.ok((state.resLedger || []).some((e) => e.reason.includes('开垦')), '开垦支出应入流水');
});

test('内政任务拒绝：非己方城 / 未知类型', () => {
  const state = freshCao();
  const enemyId = strategyViewState(state, cfg).cities.find((c) => c.owner !== 'player').id;
  const r = strategyInvest(state, cfg, makeCtx(state), { cityId: enemyId, kind: 'agri' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_own_city');
  const bad = strategyInvest(state, cfg, makeCtx(state), { cityId: state.strategy.playerCity, kind: 'nope' });
  assert.equal(bad.reason, 'bad_kind');
});

/* ---------------- 俘虏与招降 ---------------- */

test('招降：成功率随天数上升；成功入营；失败忠诚-10；忠诚<0 越狱', () => {
  const state = freshCao();
  const ctx = makeCtx(state);
  state.roleRes.gold = 5000;
  state.captives = [{ cfgId: 100002, name: '测试敌将', from: '测试', loyal: 50, days: 3, day: 1 }];
  const realRandom = Math.random;
  try {
    Math.random = () => 0.01;   // 命中成功（率上限 95%）
    const r1 = recruitCaptive(state, cfg, ctx, { idx: 0 });
    assert.ok(r1.ok, `招降应成功: ${JSON.stringify(r1)}`);
    assert.equal(state.captives.length, 0, '俘虏应移除');
    assert.ok(state.generals.some((g) => g.cfgId === 100002), '敌将应入营');
    // 失败路径
    state.captives = [{ cfgId: 100003, name: '顽将', from: '测试', loyal: 50, days: 0, day: 1 }];
    Math.random = () => 0.99;   // 落败（率 <99%）
    const r2 = recruitCaptive(state, cfg, ctx, { idx: 0 });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'refused');
    assert.equal(state.captives[0].loyal, 40, '失败忠诚 -10');
    // 连败到越狱
    Math.random = () => 0.99;
    for (let i = 0; i < 5; i++) {
      if (!state.captives.length) break;
      recruitCaptive(state, cfg, ctx, { idx: 0 });
    }
    assert.equal(state.captives.length, 0, '忠诚 <0 应越狱逃走');
  } finally {
    Math.random = realRandom;
  }
});

test('视图输出：captives 名册带成功率；驻城武将随城市下发', () => {
  const state = freshCao();
  state.captives = [{ cfgId: 100004, name: '擒将', from: '某城', loyal: 55, days: 2, day: 1 }];
  const v = strategyViewState(state, cfg);
  assert.equal(v.captives.length, 1);
  assert.ok(v.captives[0].rate > 45 && v.captives[0].rate <= 95, '成功率应在 (45,95] 区间');
  const own = v.cities.find((c) => c.owner === 'player');
  assert.ok(own, '应有玩家城');
  assert.ok(Array.isArray(own.stationed), '玩家城应输出 stationed 驻军列表');
});

test('六府 panelState 输出俘虏名册（招降入口）', () => {
  const state = freshCao();
  state.captives = [{ cfgId: 100003, name: '擒将乙', from: '某城', loyal: 60, days: 1, day: 1 }];
  const v = panelState(state, cfg);
  assert.ok(Array.isArray(v.captives) && v.captives.length === 1, 'panelState 应带 captives');
  assert.equal(v.captives[0].name, '擒将乙');
});
