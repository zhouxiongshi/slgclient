/**
 * P16 诸侯 AI 人事层回归（用户 2026-11-16 审计六问）：
 *  1. AI 自动给武将学战法；2. AI 武将升级；3. AI 自动招募武将；
 *  4. AI 俘虏流程（擒/招降/释放）；5. AI 挖墙脚；6. AI 打不过向盟友求援。
 *
 * 全部断言「行为真实发生且确定性」，不是只看字段存在。覆盖层：
 *  - 名册播种：开局每个势力有 3 名可查真名、原版客户端可见的武将；
 *  - defenseFor：level≥2 城由名册真实武将（含等级/战法）驻守，1 级城仍走 hash（守 P0-3）；
 *  - 学战法/升级/招募/招降/挖角/求援：逐个函数级断言 + 战略旬一体化模拟；
 *  - 确定性：同种子同旬双跑事件一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyTick, factionConf, applyOrders,
} from '../server/domain/strategy.js';
import { knobSet } from '../server/domain/knobs.js';
import { ensureTavern } from '../server/domain/tavern.js';
import {
  ensureRosters, rosterDefenders, aiRosterLearnTick, aiRosterGrantExp,
  aiRecruitTick, aiPoachTick, aiAidRequest, aiCaptureTick, aiCaptiveTick, makeOfficer,
} from '../server/domain/ai-roster.js';
import { PERSONA_AXES } from '../server/domain/strategy-brain.js';

const cfg = loadConfig();
const FACTIONS = factionConf().factions;
const rosterConf = { personas: PERSONA_AXES, factions: FACTIONS };

function freshWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureTavern(state, cfg);
  ensureStrategy(state, cfg);
  const ctx = { state, cfg, options: {}, pushes: [], push() {}, save() {}, log() {}, schedule() {} };
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const picked = lords[0];
  if (picked) chooseOath(state, cfg, ctx, { lord: picked.id, city: picked.cities[0].id });
  return { state, ctx, st: state.strategy };
}

/* ---------------- 1. 名册播种 ---------------- */

test('P16-1 名册：开局每势力 3 名真武将，原版客户端可见，旧档缺字段可补', () => {
  const { state } = freshWorld();
  const factions = (FACTIONS || []).map((f) => f.id);
  const st = state.strategy;
  for (const fid of factions) {
    const r = st.rosters?.[fid];
    assert.ok(r, `${fid} 应有名册`);
    assert.equal(r.generals.length, 3, `${fid} 开国三名将`);
    for (const g of r.generals) {
      assert.ok(cfg.generalByCfg.get(g.cfgId)?.name, `${g.cfgId} 可在武将表查到真名`);
      assert.ok(cfg.clientGeneralIds.has(g.cfgId), `${g.cfgId} 原版客户端可见（战报 UI 不会 null）`);
      assert.ok(g.level >= 1 && g.level <= 10, '等级在 1~10');
      assert.ok(g.loyal >= 0 && g.loyal <= 100, '忠诚在 0~100');
    }
  }
  // 旧档兼容：删掉 rosters 再 ensure 能补回空壳而不抛
  delete st.rosters;
  assert.doesNotThrow(() => ensureStrategy(state, cfg));
  assert.ok(state.strategy.rosters, '旧档 ensure 后有名册域');
});

test('P16-2 defenseFor：2 级城由名册武将驻守，1 级城保留 hash 守军（守 P0-3）', () => {
  const { state } = freshWorld();
  const st = state.strategy;
  const fid = Object.keys(st.rosters).find((k) => st.rosters[k].generals.length >= 2);
  const r = st.rosters[fid];
  r.generals[0].level = 6;
  r.generals[0].skills = [{ id: 10001, lv: 5 }];
  const defs2 = rosterDefenders(state, cfg, fid, 44, 2, []);
  assert.ok(defs2.length >= 1, '2 级城应有名册守将');
  assert.equal(defs2[0].level, 6, '守将用名册真实等级');
  assert.equal(defs2[0].skills[0].id, 10001, '守将用名册真实战法');
  // 1 级城：rosterDefenders 仍有数据，但 defenseFor 层 gate 由集成测试守（见 P0-3）
});

/* ---------------- 2~3. 学战法 / 升级 / 招募 ---------------- */

test('P16-3 学战法：≥5 级武将有金时按人格概率习得白名单战法', () => {
  const { state } = freshWorld();
  const f = (FACTIONS || [])[0];
  const fid = f.id;
  state.strategy.resources[fid].gold = 99999;
  state.strategy.rosters[fid].generals[0].level = 9;
  state.strategy.rosters[fid].generals[0].skills = [];
  let learned = 0;
  for (let turn = 1; turn <= 12; turn += 1) {
    const notes = aiRosterLearnTick(state, rosterConf, cfg, f, turn);
    learned += notes.filter((n) => n.kind === '学战法').length;
  }
  assert.ok(learned >= 1, '12 旬内高经济势力应至少习得一条战法');
  const g = state.strategy.rosters[fid].generals[0];
  for (const s of g.skills) assert.ok(Number.isFinite(s.id) && s.id > 0, '学的战法是合法 cfgId');
});

test('P16-4 升级：经验入账走 applyGeneralExp，同口径不越过 10 级', () => {
  const { state } = freshWorld();
  const fid = Object.keys(state.strategy.rosters)[0];
  const g = state.strategy.rosters[fid].generals[0];
  g.level = 1; g.exp = 0;
  const ups = aiRosterGrantExp(state, cfg, fid, { [g.cfgId]: 500 });
  assert.equal(ups.length, 1, '应升级');
  assert.ok(g.level >= 5 && g.level <= 10, '经验足够连升且封顶 10');
  const before = g.level;
  aiRosterGrantExp(state, cfg, fid, { [g.cfgId]: 999999 });
  assert.equal(g.level, 10, '满级仍为 10，不破表');
  assert.ok(g.level >= before);
});

test('P16-5 招募：在野池被登庸后标记 recruited，名册增加且不超上限', () => {
  const { state } = freshWorld();
  const f = (FACTIONS || []).find((x) => (PERSONA_AXES[x.persona]?.economy ?? 0) >= 0.6) || FACTIONS[0];
  const fid = f.id;
  state.strategy.resources[fid].gold = 99999;
  const r = state.strategy.rosters[fid];
  let got = 0;
  for (let turn = 1; turn <= 40; turn += 1) {
    const rec = aiRecruitTick(state, rosterConf, cfg, f, turn);
    if (rec?.kind === '登庸') got += 1;
  }
  assert.ok(got >= 1, '40 旬内应至少登庸一人');
  assert.ok(r.generals.length <= 8, '名册不超上限 8');
  const taken = state.tavern.people.filter((p) => p.recruited);
  assert.ok(taken.length >= 1, '被登庸者标记 recruited，玩家不会重复招到');
});

/* ---------------- 4. 俘虏 ---------------- */

test('P16-6 俘虏：攻城按歼敌比擒将 → 招降入名册 / 满 8 旬释放', () => {
  const { state } = freshWorld();
  const winnerF = FACTIONS[0];
  const victimF = FACTIONS[1];
  const wId = winnerF.id, vId = victimF.id;
  const victim = state.strategy.rosters[vId];
  const start = victim.generals.length;
  const caps = aiCaptureTick(state, cfg, wId, vId, 44, 0.95, 20);
  assert.equal(caps.length, 1, '高歼敌比应俘一人');
  assert.equal(victim.generals.length, start - 1, '被俘者离开原势力名册');
  assert.equal(state.strategy.rosters[wId].captives.length, 1, '胜方俘虏名册 +1');
  // 处置：要么招降入册、要么满 8 旬释放，两条出口最终清空
  let resolved = 0;
  for (let turn = 21; turn <= 40; turn += 1) {
    const notes = aiCaptiveTick(state, rosterConf, cfg, winnerF, turn);
    resolved += notes.filter((n) => n.kind === '招降' || n.kind === '释俘').length;
  }
  assert.equal(state.strategy.rosters[wId].captives.length, 0, '俘虏最终全部处置');
  assert.ok(resolved >= 1, '至少有一条处置记录');
});

/* ---------------- 5. 挖墙脚 ---------------- */

test('P16-7 挖墙脚：高经济势力可挖走低忠诚的玩家/他势力武将', () => {
  const { state } = freshWorld();
  const f = FACTIONS.find((x) => (PERSONA_AXES[x.persona]?.economy ?? 0) >= 0.6) || FACTIONS[0];
  const fid = f.id;
  // 造一个低忠诚玩家武将来当靶子
  const lowLoyal = { id: 990001, cfgId: 100020, level: 4, loyal: 12, skills: [] };
  state.generals.push(lowLoyal);
  state.strategy.resources[fid].gold = 99999;
  let poached = 0;
  for (let turn = 1; turn <= 40; turn += 1) {
    const r = aiPoachTick(state, rosterConf, cfg, f, turn);
    if (r?.kind === '挖角') { poached += 1; break; }
  }
  assert.ok(poached >= 1, '40 旬内应挖走一名低忠诚武将');
  assert.ok(!state.generals.includes(lowLoyal), '被挖武将离开玩家名册');
  assert.ok(state.strategy.rosters[fid].generals.some((g) => g.cfgId === 100020), '被挖武将进入 AI 名册');
});

/* ---------------- 6. 求援 ---------------- */

test('P16-8 求援：弱势力（≤2城/低兵/高defense人格）向盟友发求援，且有 6 旬冷却', () => {
  const { state } = freshWorld();
  const st = state.strategy;
  const f = FACTIONS.find((x) => (PERSONA_AXES[x.persona]?.defense ?? 0) >= 0.6) || FACTIONS[0];
  // 构造残兵弱方：只留 1 城且 500 兵
  const own = Object.keys(st.cities).filter((id) => st.cities[id].owner === f.id);
  for (const id of own.slice(1)) st.cities[id].owner = 'han';
  st.cities[own[0]].troops = 500;
  // 找一个盟友
  st.relations[`${f.id}|${FACTIONS[1].id}`] = 'ally';
  let asked = null;
  for (let turn = 1; turn <= 20 && !asked; turn += 1) {
    asked = aiAidRequest(state, rosterConf, f, turn, st);
  }
  assert.ok(asked, '20 旬内弱方应发出求援');
  assert.ok(asked.friends.length >= 1, '求援对象至少一人');
  // 冷却：紧接着同势力求援应被拒
  assert.equal(aiAidRequest(state, rosterConf, f, asked ? (st.rosterAidCooldown[f.id] + 1) : 1, st), null, '6 旬冷却生效');
});

/* ---------------- 7. 确定性 & 旬一体化 ---------------- */

test('P16-9 确定性：同种子同甸名册成长逐字段一致', () => {
  const mk = () => {
    const w = freshWorld();
    const f = FACTIONS[0];
    w.state.strategy.resources[f.id].gold = 99999;
    for (let t = 1; t <= 8; t += 1) {
      aiRosterLearnTick(w.state, rosterConf, cfg, f, t);
      aiRecruitTick(w.state, rosterConf, cfg, f, t);
      aiCaptiveTick(w.state, rosterConf, cfg, f, t);
    }
    return JSON.stringify(w.state.strategy.rosters[f.id]);
  };
  assert.equal(mk(), mk(), '同种子双跑名册逐字段一致');
});

test('P16-10 difficultyAi 旋钮接线：高难度 AI 征兵更多（默认 1.0 不改变原样）', () => {
  const run = (aiMul) => {
    const { state, st } = freshWorld();
    // 找一个真实持有城的 AI faction（举义主公的城已归 player）
    const owners = Object.values(st.cities).map((r) => r.owner).filter((o) => o && o !== 'player');
    const fid = owners[0];
    const f = FACTIONS.find((x) => x.id === fid) || { id: fid, name: fid };
    const own = Object.keys(st.cities).filter((id) => st.cities[id].owner === fid);
    assert.ok(own.length, 'AI 应有一座城');
    const home = own[0];
    st.cities[home].troops = 100;
    // 保证粮足够：直接给该势力城库充足粮
    const econ = st.cityEcon?.[home];
    if (econ) econ.store = 999999;
    if (!st.resources[f.id]) st.resources[f.id] = {};
    st.resources[f.id].grain = 999999;
    knobSet(state, 'difficultyAi', aiMul);
    const before = st.cities[home].troops;
    applyOrders(state, cfg, { push() {}, save() {}, log() {}, schedule() {}, pushes: [] }, f, {
      internal_orders: [{ type: '征兵', params: { count: 100, cityId: Number(home) } }],
      strategy_orders: [],
    });
    return st.cities[home].troops - before;
  };
  const normal = run(1.0);
  const hard = run(1.4);
  assert.equal(normal, 100, '默认 1.0：征兵量 = 指令原值（不改变原样）');
  assert.equal(hard, 140, 'difficultyAi=1.4：AI 征兵 100→140，旋钮真正生效');
});
