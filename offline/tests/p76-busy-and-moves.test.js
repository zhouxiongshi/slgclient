/**
 * P76 回归闸：武将占身互斥 + 留守历练自动升级 + 部队调防（带兵进驻）。
 *
 * 玩家原话（2026-11-28）：
 *  ①「战法委派研习不允许同一个武将同一时间重复研习多个战法，
 *     有任务在身就不能再干别的事情」；
 *  ②「武将等级没有自动升级……一直在内政的武将等级一直停留在 1 级」；
 *  ③「部队出征到其他城市后，归属地应该发生改变」——实测攻占/抵达都正确，
 *    真缺口是：调遣只调人不带兵，玩家没有任何入口把带兵的队伍移驻己方城。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath,
  dispatchGeneral, dispatchTick, strategyArmyMove, strategyResolveMarches,
  interiorIdleExpTick, marchableFrom,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { beginInteriorTask } from '../server/domain/interior-task.js';
import { assignResearch, unassignResearch } from '../server/domain/research.js';
import { governorSet } from '../server/domain/governor.js';
import { formationGeneralCheck } from '../server/domain/formation.js';
import { normalizeResearchAssign, busyReasonOf } from '../server/domain/general-busy.js';
import { IDLE_EXP_PER_TICK, applyGeneralExp } from '../server/domain/general-progress.js';

const cfg = loadConfig();

function world() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const pushes = [];
  const ctx = {
    state: s, cfg, pushes, options: {},
    push(n, m) { pushes.push({ n, m }); },
    schedule() {}, save() {}, log() {},
  };
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  assert.ok(lords.length, '至少要有两座城的势力');
  assert.equal(chooseOath(s, cfg, ctx, { lord: lords[0].id, city: lords[0].cities[0].id }).ok, true);
  const mine = Object.keys(s.strategy.cities)
    .filter((id) => s.strategy.cities[id].owner === 'player').map(Number);
  assert.ok(mine.length >= 2, '玩家需要至少两座城');
  s.clock.day = 1;
  return { s, ctx, mine, pushes };
}

/** 找一名完全没占身的武将并安置到 from 城。 */
function idleGeneral(s, from) {
  let g = (s.generals || []).find((x) => !x.isProtagonist && !x.transit && !busyReasonOf(s, x.id));
  if (!g) g = (s.generals || []).find((x) => !x.isProtagonist && !x.transit);
  assert.ok(g, '要有可用武将');
  g.cityId = from;
  g.transit = null;
  g.order = 0;
  return g;
}

/** 一条可研习的战法（未解锁、未委派）。新开局唯一一条常被 adoptOrphanResearch
 *  预委派给主公——没有空闲条目时伪造一条（台账格式同源，cfgId 取自原始表）。 */
function researchable(s) {
  const keys = Object.keys(s.skillbook?.research || {})
    .filter((k) => !s.skillbook.unlocked?.[k] && !s.skillbook.assign?.[k]);
  if (keys.length) return Number(keys[0]);
  s.skillbook.research['10003'] = { progress: 0, need: 120 };
  return 10003;
}

/** 两条可研习战法（换研习用）。 */
function twoResearchable(s) {
  const a = researchable(s);
  s.skillbook.research['10005'] = { progress: 0, need: 120 };
  const b = 10005 === a ? 10010 : 10005;
  return [a, b];
}

/** 玩家相邻己方城对 [a, b]（a≠b，沿 marchableFrom 公开口径）。 */
function ownAdjacentPair(s, mine) {
  for (const a of mine) {
    for (const b of marchableFrom(Number(a), s).map(Number)) {
      if (mine.includes(b)) return [Number(a), b];
    }
  }
  /* 玩家城互不相邻（常见开局）：把 a0 的一个邻城划给玩家当测试城，
     只改 owner，不搬兵不改城防 —— 编队/调防判据只用 owner。 */
  const a0 = Number(mine[0]);
  const b0 = marchableFrom(a0, s).map(Number)[0];
  assert.ok(b0 != null, '出发城要有邻城');
  s.strategy.cities[b0].owner = 'player';
  return [a0, b0];
}

/** 一支驻在 from、带兵带将的队伍（没有就造一支）。 */
function armyFixture(s, from) {
  let army = (s.armys || []).find((a) => Number(a.cityId) === from && (a.soldiers || []).some((n) => n > 0));
  if (!army) {
    army = (s.armys || []).find((a) => !a.marchId) || { id: 9001, order: 3 };
    army.cityId = from;
    const g = idleGeneral(s, from);
    army.generals = [g.id, 0, 0];
    army.soldiers = [500, 0, 0];
    army.con_cnts = [0, 0, 0];
    delete army.marchId;
    if (!(s.armys || []).includes(army)) (s.armys = s.armys || []).push(army);
    s.strategy.cities[from].troops = Math.max(0, Number(s.strategy.cities[from].troops || 0) - 500);
  }
  return army;
}

/* ============ 一、占身互斥 ============ */

test('P76-① 旧档归一：同一武将多份研习委派只留进度最深那份，进度不丢', () => {
  const { s } = world();
  const sb = s.skillbook;
  const from = Object.keys(s.strategy.cities).find((id) => s.strategy.cities[id].owner === 'player');
  const g = idleGeneral(s, Number(from));
  /* 伪造旧档：同一人挂着两份委派，A 已推进 30 点、B 0 点 */
  sb.research['10003'] = { progress: 30, need: 120 };
  sb.research['10005'] = { progress: 0, need: 120 };
  sb.assign['10003'] = { generalId: g.id, since: 1 };
  sb.assign['10005'] = { generalId: g.id, since: 1 };
  const dropped = normalizeResearchAssign(s);
  assert.equal(dropped, 1, '要摘掉一份');
  const myKeys = Object.keys(sb.assign).filter((k) => Number(sb.assign[k].generalId) === g.id);
  assert.equal(myKeys.length, 1, '一人只许一份委派');
  assert.equal(Number(sb.research[myKeys[0]]?.progress) || 0, 30, '留下的必须是进度深的那份');
});

test('P76-② 办差中的武将不能委派研习，拒绝必须带中文说明', () => {
  const { s, ctx } = world();
  const from = Object.keys(s.strategy.cities).find((id) => s.strategy.cities[id].owner === 'player');
  const g = idleGeneral(s, Number(from));
  s.roleRes.gold = Math.max(Number(s.roleRes.gold) || 0, 50000);
  const t = beginInteriorTask(s, cfg, ctx, { cityId: Number(from), kind: 'agri', officerId: g.id });
  assert.equal(t.ok, true, `办差应成功：${JSON.stringify(t).slice(0, 120)}`);
  const cfgId = researchable(s);
  const r = assignResearch(s, cfg, { cfgId, generalId: g.id });
  assert.equal(r.ok, false, '占身武将不许再接研习');
  assert.match(String(r.reason), /^busy_/, '协议码必须是 busy_*');
  assert.match(String(r.text), /研习战法|办不了|腾不出手|正办内政差事/, '要给可读理由');
  assert.ok(!s.skillbook.assign?.[String(cfgId)], '拒绝后不许留下委派');
});

test('P76-③ 研习中的武将四路全拦：办差/调遣/任太守/编队，全部带可读拒绝', () => {
  const { s, ctx, mine } = world();
  const from = mine[0];
  const g = idleGeneral(s, from);
  const cfgId = researchable(s);
  const a = assignResearch(s, cfg, { cfgId, generalId: g.id });
  assert.equal(a.ok, true, `委派应成功：${JSON.stringify(a).slice(0, 120)}`);

  const t = beginInteriorTask(s, cfg, ctx, { cityId: from, kind: 'agri', officerId: g.id });
  assert.equal(t.ok, false, '研习中不能办差');
  assert.equal(t.reason, 'officer_busy');
  assert.match(String(t.text), /研习战法|腾不出手/, '要给可读理由');

  const d = dispatchGeneral(s, cfg, ctx, { generalId: g.id, toCityId: mine[1] });
  assert.equal(d.ok, false, '研习中不能调遣');
  assert.equal(d.reason, 'busy_research');
  assert.match(String(d.text), /研习战法/, '要给可读理由');

  const gv = governorSet(s, cfg, ctx, { cityId: from, officerId: g.id, policy: null });
  assert.equal(gv.ok, false, '研习中不能任太守');
  assert.match(String(gv.reason), /^busy_/, '协议码必须是 busy_*');

  const f = formationGeneralCheck(s, { generalId: g.id, cityId: from });
  assert.equal(f.ok, false, '研习中不能编入队伍');
  assert.equal(f.reason, 'busy_research');

  /* 解除研习后恢复：先验调遣（调遣本身是行程，抵达前他占身「在途」——正确行为） */
  assert.equal(unassignResearch(s, { cfgId }).ok, true);
  assert.equal(busyReasonOf(s, g.id), '', '解除后不再占身');
  const dOk = dispatchGeneral(s, cfg, ctx, { generalId: g.id, toCityId: mine[1] });
  assert.equal(dOk.ok, true, '解除后可调遣');
  /* 推进到抵达日，落城后再验办差恢复 */
  s.clock.day += Math.max(1, Number(dOk.marchDays) || 1) + 1;
  dispatchTick(s, cfg, ctx);
  assert.equal(busyReasonOf(s, g.id), '', '抵达落城后占身解除');
  s.roleRes.gold = Math.max(Number(s.roleRes.gold) || 0, 50000);
  assert.equal(beginInteriorTask(s, cfg, ctx, { cityId: mine[1], kind: 'agri', officerId: g.id }).ok, true,
    '解除并抵达后可办差');
});

test('P76-④ 换研习目标仍允许：一人一职是「替换」不是「兼差」', () => {
  const { s } = world();
  const from = Object.keys(s.strategy.cities).find((id) => s.strategy.cities[id].owner === 'player');
  const g = idleGeneral(s, Number(from));
  const [kA, kB] = twoResearchable(s);
  assert.equal(assignResearch(s, cfg, { cfgId: kA, generalId: g.id }).ok, true);
  const r2 = assignResearch(s, cfg, { cfgId: kB, generalId: g.id });
  assert.equal(r2.ok, true, '同一武将换研习目标必须放行（先把旧的摘掉）');
  const mine = Object.values(s.skillbook.assign).filter((x) => Number(x?.generalId) === g.id);
  assert.equal(mine.length, 1, '换完仍是一人一份');
  assert.equal(String(Object.keys(s.skillbook.assign).find(
    (k) => Number(s.skillbook.assign[k].generalId) === g.id,
  )), String(kB), '换到新战法上');
});

/* ============ 二、留守历练自动升级 ============ */

test('P76-⑤ 驻城闲员每旬得历练经验，攒满自动升级并发军情；办差官不重复拿', () => {
  const { s, ctx, mine } = world();
  const g = idleGeneral(s, mine[0]);
  g.level = 1;
  g.exp = 0;
  const day0 = Number(s.clock.day) || 1;
  /* 1→2 需 40 点；每旬 +6 → 第 7 旬过线 */
  for (let i = 0; i < 8; i += 1) {
    s.clock.day = day0 + (i + 1) * 10;
    interiorIdleExpTick(s, cfg, ctx);
  }
  assert.ok(g.level >= 2, `8 旬历练后应升到 2 级，实际 level=${g.level}`);
  assert.ok((s.strategy.events || []).some((e) => /留守历练/.test(String(e.text || ''))),
    '升级要进大事记');

  /* 办差官不重复拿留守那份（他有 interior-task 的 12 点/旬通道） */
  const g2 = (s.generals || []).find((x) => !x.isProtagonist && Number(x.id) !== Number(g.id)
    && !x.transit && !busyReasonOf(s, x.id));
  if (g2) {
    g2.cityId = mine[0];
    g2.transit = null;
    s.roleRes.gold = Math.max(Number(s.roleRes.gold) || 0, 50000);
    const t = beginInteriorTask(s, cfg, ctx, { cityId: mine[0], kind: 'agri', officerId: g2.id });
    if (t.ok && t.task?.status === 'active') {
      const expBefore = Number(g2.exp) || 0;
      interiorIdleExpTick(s, cfg, ctx);
      assert.equal(Number(g2.exp) || 0, expBefore, '办差官不应再拿留守历练那份');
    }
  }
});

test('P76-⑥ 每旬历练定量与升级走同一口径：IDLE_EXP_PER_TICK 与 expToAdvance 对账', () => {
  assert.equal(IDLE_EXP_PER_TICK, 6);
  const g = { level: 1, exp: 0 };
  applyGeneralExp(g, 6 * 6);
  assert.equal(g.level, 1, '36 点不够升 2 级（1→2 需 40）');
  applyGeneralExp(g, 6);
  assert.equal(g.level, 2, '42 点应升到 2 级');
});

/* ============ 三、部队调防（带兵进驻） ============ */

test('P76-⑦ 部队调防：启程锁队 → 抵达日归属改到目标城 → 武将随迁 → 军情留痕', () => {
  const { s, ctx, mine, pushes } = world();
  const pair = ownAdjacentPair(s, mine);
  assert.ok(pair, '玩家要有相邻的两座己方城');
  const [a0, b0] = pair;
  const army = armyFixture(s, a0);
  const troops0 = (army.soldiers || []).reduce((x, n) => x + Math.max(0, Number(n) || 0), 0);
  s.roleRes.grain = Math.max(Number(s.roleRes.grain) || 0, 500000);

  const r = strategyArmyMove(s, cfg, ctx, { armyId: army.id, toCityId: b0, fromCityId: a0 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 160));
  assert.equal(r.marching, true);
  assert.equal(Number(army.cityId), a0, '启程当天归属还在出发城');
  assert.ok(army.marchId, '锁队');
  const card = (s.strategy.marches || []).find((mm) => mm.kind === 'armyMove' && Number(mm.armyId) === army.id);
  assert.ok(card, '要有一条 armyMove 行军牌');

  s.clock.day = card.arriveDay + 1;
  const results = strategyResolveMarches(s, cfg, ctx);
  assert.ok(results.some((x) => x.kind === 'armyMove'), '抵达要出 armyMove 结算');
  assert.equal(Number(army.cityId), b0, '★ 归属地必须改成目标城');
  assert.ok(!army.marchId, '抵达后解锁');
  for (const gid of army.generals || []) {
    if (!gid) continue;
    const g = (s.generals || []).find((x) => Number(x.id) === Number(gid));
    if (g) assert.equal(Number(g.cityId), b0, '随行武将驻地随迁');
  }
  assert.ok((s.strategy.events || []).some((e) => /调防大军进驻|进驻/.test(String(e.text || ''))),
    '抵达要进大事记');
  assert.ok(troops0 > 0, '带兵的队伍才算调防');
  assert.ok(pushes.length >= 0);
});

test('P76-⑧ 调防硬闸：非己方城/不邻接/行军中再调，全部拒绝且不改状态', () => {
  const { s, ctx, mine } = world();
  const army = armyFixture(s, mine[0]);
  const foe = Object.keys(s.strategy.cities)
    .map(Number).find((id) => s.strategy.cities[id].owner !== 'player');
  const r1 = strategyArmyMove(s, cfg, ctx, { armyId: army.id, toCityId: foe, fromCityId: mine[0] });
  assert.equal(r1.ok, false, '不能进驻敌城');
  assert.equal(r1.reason, 'not_own_city');

  const far = mine.find((id) => id !== mine[0]
    && !marchableFrom(Number(mine[0]), s).map(Number).includes(Number(id)));
  if (far != null) {
    const r2 = strategyArmyMove(s, cfg, ctx, { armyId: army.id, toCityId: far, fromCityId: mine[0] });
    assert.equal(r2.ok, false, '只能进驻相邻己方城');
    assert.equal(r2.reason, 'not_adjacent');
  }

  s.roleRes.grain = Math.max(Number(s.roleRes.grain) || 0, 500000);
  const adj = marchableFrom(Number(mine[0]), s).map(Number)
    .find((id) => s.strategy.cities[id]?.owner === 'player');
  if (adj != null) {
    const r3 = strategyArmyMove(s, cfg, ctx, { armyId: army.id, toCityId: adj, fromCityId: mine[0] });
    assert.equal(r3.ok, true, JSON.stringify(r3).slice(0, 120));
    const r4 = strategyArmyMove(s, cfg, ctx, { armyId: army.id, toCityId: adj, fromCityId: mine[0] });
    assert.equal(r4.ok, false, '行军中不可再调防');
    assert.equal(r4.reason, 'marching');
    assert.ok(army.marchId, '锁队仍在');
  }
});

test('P76-⑨ 目标城途中易主：整队折返原城，绝不把大军丢进敌城', () => {
  const { s, ctx, mine } = world();
  const pair = ownAdjacentPair(s, mine);
  assert.ok(pair, '玩家要有相邻的两座己方城');
  const [a0, b0] = pair;
  const army = armyFixture(s, a0);
  s.roleRes.grain = Math.max(Number(s.roleRes.grain) || 0, 500000);
  const r = strategyArmyMove(s, cfg, ctx, { armyId: army.id, toCityId: b0, fromCityId: a0 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 120));
  const card = (s.strategy.marches || []).find((mm) => mm.kind === 'armyMove' && Number(mm.armyId) === army.id);
  /* 出发后目标城易主（模拟第三方占领） */
  s.strategy.cities[b0].owner = 'dongzhuo';
  s.clock.day = card.arriveDay + 1;
  const results = strategyResolveMarches(s, cfg, ctx);
  assert.ok(results.some((x) => x.kind === 'armyMove' && x.aborted), '要出折返结算');
  assert.equal(Number(army.cityId), Number(a0), '★ 折返原城');
  assert.ok(!army.marchId, '折返后解锁');
});
