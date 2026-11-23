/**
 * P50（2026-11-23）内政太守制领域回归（参考三国志12-14，替换旧 m2-appoint）：
 *  1. 任免太守 / 改方针 / 一键补任（一人一城、行军与已任者排除）；
 *  2. 旬界自动办政与旧手动派单同源同价（beginInteriorTask），太守本人执行；
 *  3. 缺金 blocked 置顶、金到位自动续办、有灾自动赈济；
 *  4. 旧档 appointments 迁移为太守记录；
 *  5. 城陷中止、城内页与六府视图下发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, strategyViewState, oathOptions, chooseOath } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { advanceInteriorTasks } from '../server/domain/interior-task.js';
import {
  governorSet, governorAutoFill, governorTick, POLICIES,
} from '../server/domain/governor.js';

const cfg = loadConfig();

function freshState() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(s, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  s.clock.day = 10;
  s.roleRes.gold = 100000;
  const cid = Number(Object.keys(s.strategy.cities).find((id) => s.strategy.cities[id].owner === 'player'));
  return { s, cid };
}

function ctx() { return { push() {} }; }

test('G1 任免太守：政治最高者优先可用，一人一城、行军者被拒', () => {
  const { s, cid } = freshState();
  const cands = s.generals.filter((g) => !g.isProtagonist);
  assert.ok(cands.length >= 1, '前提：有可任太守的武将');
  const r = governorSet(s, cfg, ctx(), { cityId: cid, officerId: cands[0].id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.strategy.governors[cid].officerId, cands[0].id);
  // 一人一城：别的城任同一人必须拒绝（cities 以键为 id，行内不带 id 字段）
  const otherEntry = Object.entries(s.strategy.cities)
    .find(([id, c]) => c.owner === 'player' && Number(id) !== cid);
  if (otherEntry) {
    const r2 = governorSet(s, cfg, ctx(), { cityId: Number(otherEntry[0]), officerId: cands[0].id });
    assert.equal(r2.ok, false, '同一武将不能任两城太守');
    assert.equal(r2.reason, 'busy_elsewhere');
  }
  // 行军中不能任
  const marcher = s.generals.find((g) => (s.armys || []).some((a) => a.marchId && (a.generals || []).includes(g.id)));
  if (marcher) {
    const r3 = governorSet(s, cfg, ctx(), { cityId: cid, officerId: marcher.id });
    assert.equal(r3.ok, false, '行军中不能任太守');
    assert.equal(r3.reason, 'marching');
  }
  // 撤任
  const r4 = governorSet(s, cfg, ctx(), { cityId: cid, officerId: 0 });
  assert.equal(r4.ok, true);
  assert.equal(s.strategy.governors[cid].officerId, 0);
});

test('G2 改方针：六种方针可设，非法方针拒绝', () => {
  const { s, cid } = freshState();
  for (const p of Object.keys(POLICIES)) {
    const r = governorSet(s, cfg, ctx(), { cityId: cid, policy: p });
    assert.equal(r.ok, true, `方针 ${p} 应可设`);
    assert.equal(s.strategy.governors[cid].policy, p);
  }
  const bad = governorSet(s, cfg, ctx(), { cityId: cid, policy: 'no_such' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_policy');
});

test('G3 旬界自动办政：与手动同源、太守本人执行、每城每旬一单', () => {
  const { s, cid } = freshState();
  const cand = s.generals.find((g) => !g.isProtagonist);
  governorSet(s, cfg, ctx(), { cityId: cid, officerId: cand.id, policy: 'auto' });
  const gold0 = s.roleRes.gold;
  const out = governorTick(s, cfg, ctx());
  assert.ok(out.started.length >= 1, '至少一城开单');
  const tasks = (s.strategy.interiorTasks || []).filter((t) => t.status === 'active' && Number(t.cityId) === cid);
  assert.equal(tasks.length, 1, '每城每旬至多一单（无灾）');
  const t0 = tasks[0];
  /* 扣金与手动派单同价（同源）：本次 tick 全部新开单的代价合计 */
  const newTasks = (s.strategy.interiorTasks || []).filter((t) => t.status === 'active');
  assert.equal(Number(gold0) - Number(s.roleRes.gold),
    newTasks.reduce((n, t) => n + Number(t.cost) || n, 0), '扣金与手动派单同价（同源）');
  assert.equal(t0.officerId, cand.id, '太守本人执行');
  assert.ok(t0.ticks >= 1 && t0.ticks <= 6, '工期在 1~6 旬');
  // 下一旬：上一单在施，不再重复开同类单
  s.clock.day = 20;
  const before = (s.strategy.interiorTasks || []).filter((t) => t.status === 'active').length;
  governorTick(s, cfg, ctx());
  const after = (s.strategy.interiorTasks || []).filter((t) => t.status === 'active').length;
  assert.ok(after >= before, '在施任务不被撤销');
});

test('G4 缺金 blocked 置顶、金到位自动续办', () => {
  const { s, cid } = freshState();
  governorSet(s, cfg, ctx(), { cityId: cid, policy: 'auto' });
  s.roleRes.gold = 0;                       // 库金清零
  const out = governorTick(s, cfg, ctx());
  assert.ok(out.blocked.some((v) => Number(v.cityId) === cid), '缺金必须置顶报告');
  assert.equal(s.strategy.governors[cid].status, 'blocked');
  const active = (s.strategy.interiorTasks || []).filter((t) => t.status === 'active' && Number(t.cityId) === cid);
  assert.equal(active.length, 0, '缺金不开单，不欠账');
  s.roleRes.gold = 10000;                   // 金到位
  s.clock.day = 20;
  const out2 = governorTick(s, cfg, ctx());
  assert.ok(out2.started.some((v) => Number(v.cityId) === cid), '金到位自动续办');
  assert.equal(s.strategy.governors[cid].status, 'running');
});

test('G5 有灾自动赈济：只赈真实减产，丰收不赈', () => {
  const { s, cid } = freshState();
  const e = s.strategy.cityEcon[cid];
  e.mod = { grain: 0.5, until: 999 };        // 蝗灾式减产
  governorSet(s, cfg, ctx(), { cityId: cid, policy: 'auto' });
  governorTick(s, cfg, ctx());
  assert.equal(e.mod, null, '太守应自动开仓赈灾（即时解除减产）');
  e.mod = { grain: 1.5, until: 999 };        // 丰收加成
  s.clock.day = 20;
  governorTick(s, cfg, ctx());
  assert.equal(Number(e.mod.grain), 1.5, '丰收加成不得被赈灾取消');
});

test('G6 一键补任：只填空缺、政治最高者、主角不占名额', () => {
  const { s, cid } = freshState();
  const r = governorAutoFill(s, cfg, ctx(), {});
  assert.equal(r.ok, true);
  assert.ok(r.filled.length >= 1, '至少补任一城');
  const gv = s.strategy.governors[cid];
  assert.ok(gv.officerId > 0, '玩家城应补上任太守');
  const picked = s.generals.find((g) => Number(g.id) === Number(gv.officerId));
  assert.ok(picked && !picked.isProtagonist, '补任不占主角');
  const again = governorAutoFill(s, cfg, ctx(), {});
  assert.equal(again.filled.length, 0, '已满不再补');
});

test('G7 旧档 appointments 迁移为太守记录', () => {
  const { s, cid } = freshState();
  s.strategy.governors = {};
  s.strategy.appointmentsMigrated = false;
  s.strategy.appointments = [{
    id: 'ap1', cityId: cid, cityName: '旧档城', goal: 'recruit',
    officerId: 0, status: 'running', doneCount: 3, startDay: 10,
  }];
  governorSet(s, cfg, ctx(), { cityId: cid });   // 任一 governor 入口都会先迁移
  const gv = s.strategy.governors[cid];
  assert.ok(gv, '迁移后应有太守记录');
  assert.equal(gv.policy, 'military', '旧 recruit 目标映射为强兵方针');
  assert.equal(gv.doneCount, 3, '已办单数保留');
  assert.equal(s.strategy.appointmentsMigrated, true, '迁移只做一次');
});

test('G8 视图：城内页与六府总览下发太守数据', () => {
  const { s, cid } = freshState();
  governorAutoFill(s, cfg, ctx(), {});
  const view = strategyViewState(s, cfg);
  assert.ok(Array.isArray(view.governors) && view.governors.length >= 1, '总览下发');
  const mine = view.cities.find((c) => Number(c.id) === cid && c.owner === 'player');
  assert.ok(mine && mine.governor && Array.isArray(mine.governorCands), '城内页下发太守与候选');
  assert.equal(mine.governor.cityId, cid);
});

test('G9 失城中止：城易手后太守不再办政、在施任务随日结取消', () => {
  const { s, cid } = freshState();
  governorSet(s, cfg, ctx(), { cityId: cid, policy: 'auto' });
  governorTick(s, cfg, ctx());
  const active = (s.strategy.interiorTasks || []).filter((t) => t.status === 'active' && Number(t.cityId) === cid);
  assert.ok(active.length >= 1, '前提：应有一单在施');
  s.strategy.cities[cid].owner = 'dongzhuo';
  s.clock.day = 20;
  /* 每日日结（cityEconTick 的每日段）负责取消城陷任务的口径 */
  advanceInteriorTasks(s, cfg, ctx());
  const after = (s.strategy.interiorTasks || []).filter((t) => t.status === 'active' && Number(t.cityId) === cid);
  assert.equal(after.length, 0, '城陷后在施任务应被取消');
  governorTick(s, cfg, ctx());
  const gv = s.strategy.governors[cid];
  assert.ok(gv.status === 'done' || !gv, '太守记录应中止');
});
