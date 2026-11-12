/**
 * 实机试玩（2026-11-10）抓出的 P0/P1 修复验收。
 *
 *  P0-1 世界时钟由服务端推进，「推演一月」原子推进 10 天
 *  P0-2 战报写进存档，重进还能复盘
 *  P0-3 征兵按四种资源逐项扣、有 ETA、战败留溃兵；首战有可胜路径
 *  P0-4 章节结算后不再按日写 fired
 *  P1-1/P1-2 征兵账目与兵种槽 NaN
 *  P1-3 招贤失败给原因
 *  P1-4 编队越界不再造第 4 支空队
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld, makeGeneral, nextId, makeArmy } from '../server/world.js';
import { handleRequest, processTask, settleWorld, advanceToNextTurn } from '../server/handlers.js';
import {
  ensureStrategy, strategyMap, neighborsOf, garrisonOf, strategyResolveMarches,
} from '../server/domain/strategy.js';
import { ensureTavern } from '../server/domain/tavern.js';

const cfg = loadConfig();
const map = strategyMap();
const req = (name, msg = {}) => ({ seq: 1, name, msg });
const DAY = 60000;

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, options: {}, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    save() {}, log() {}, schedule() {},
  };
}

function homeOf(state) {
  const st = ensureStrategy(state);
  return map.cities.find((c) => c.id === st.playerCity);
}

function neighborCity(state, name) {
  const home = homeOf(state);
  const list = neighborsOf(home.id).map((id) => map.cities.find((c) => c.id === id));
  return name ? list.find((c) => c.name === name) : list[0];
}

/* ---------------- P0-1 ---------------- */

test('P0-1 世界时钟：不发任何请求，时间也会自己往前跑', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const before = state.clock.day;
  // 模拟「3 个游戏日没人操作」：把上次结算时刻拨回 3 天
  state.clock.lastRealMs = Date.now() - DAY * 3;
  const r = settleWorld(ctx);
  assert.equal(r.days, 3, '一次结算补 3 天');
  assert.equal(state.clock.day, before + 3, '游戏日自己前进，不再依赖客户端请求');
  // 立刻再结算一次：没有新时间就不该再跳日
  const r2 = settleWorld(ctx);
  assert.equal(r2.days, 0);
  assert.equal(state.clock.day, before + 3);
});

test('P0-1 推演一月：原子推进到下一个回合日并跑一次诸侯决策', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const st = ensureStrategy(state);
  assert.equal(state.clock.day, 1);
  const r = advanceToNextTurn(ctx);
  assert.equal(r.skipped, false, '必须真的推演出一个回合');
  assert.equal(r.turn, 1);
  assert.equal(state.clock.day, st.lastTurnDay, '时钟被推到本回合日');
  assert.ok(r.advanced >= 1, `应推进 ${r.advanced} 天`);
  // 同一天再点：没有新回合，但必须给出还差几天而不是静默
  const r2 = advanceToNextTurn(ctx);
  assert.equal(typeof r2.need, 'number');
  assert.ok(r2.need >= 1);
});

/* ---------------- P0-2 ---------------- */

test('P0-2 城战战报写入存档，war.report 能读回来', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const target = neighborCity(state, '陈');
  state.armys[0].soldiers = [1200, 0, 0];
  const rsp = handleRequest(ctx, req('strategy.attack', { cityId: target.id, armyId: state.armys[0].id }));
  assert.equal(rsp.code, 0);
  // ★ P2：出征改为先行军 2 日，推进到到达日结算
  assert.equal(rsp.msg.marching, true, '出征应先生成行军队列');
  state.clock.day = rsp.msg.arriveDay + 1;
  const fought = strategyResolveMarches(state, cfg, ctx);
  assert.equal(fought.length, 1, '到达即开打');
  assert.equal(state.warReports.length, 1, '战报必须落存档，而不是只推给当前连接');
  const list = handleRequest(ctx, req('war.report', {})).msg.list;
  assert.equal(list.length, 1);
  assert.ok(list[0].summary && list[0].analysis, '战报要能说清胜负与双方兵力');
  assert.equal(typeof list[0].rounds, 'string');
});

/* ---------------- P0-3 ---------------- */

test('P0-3 征兵按四种资源逐项扣款，资源不足直接拒绝', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const army = state.armys[0];
  const before = { ...state.roleRes };
  const rsp = handleRequest(ctx, req('army.conscript', { armyId: army.id, cnts: [100, 0, 0] }));
  assert.equal(rsp.code, 0);
  assert.equal(state.roleRes.wood, before.wood - 1000, '木 -10/兵');
  assert.equal(state.roleRes.iron, before.iron - 1000, '铁 -10/兵');
  assert.equal(state.roleRes.grain, before.grain - 1000, '粮 -10/兵');
  assert.equal(state.roleRes.gold, before.gold - 100, '金 -1/兵');
  assert.ok(rsp.msg.etaSec >= 2 && rsp.msg.etaSec <= 30, `工期要有上限，实际 ${rsp.msg.etaSec}`);

  // 资源不足：不能再用 Math.max(0,…) 白嫖
  state.roleRes.wood = 10;
  const poor = handleRequest(ctx, req('army.conscript', { armyId: army.id, cnts: [100, 0, 0] }));
  assert.equal(poor.code, 16, '资源不足返回原版 code 16');
  assert.equal(state.roleRes.wood, 10, '失败时不扣任何资源');
});

test('P0-3 征兵到账不会写出 null / NaN，三个兵种槽恒为合法整数', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const army = state.armys[0];
  army.soldiers = [100];            // 旧存档形态：只有 1 个元素
  handleRequest(ctx, req('army.conscript', { armyId: army.id, cnts: [100, 0, 0] }));
  processTask(ctx, { type: 'conscript_done', armyId: army.id, cnts: [100, 0, 0] });
  assert.equal(army.soldiers.length, 3);
  assert.ok(army.soldiers.every((n) => Number.isInteger(n) && n >= 0), JSON.stringify(army.soldiers));
  assert.ok(!/null/.test(JSON.stringify(army.soldiers)), '存档里不能出现 null');
});

test('P0-3 战败不会把家底清零：溃兵归营', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  // 挑一个相邻、守军明显多于我军的城（换图后邻接关系会变，按实际路网选）
  const home = homeOf(state);
  const target = neighborsOf(home.id)
    .map((id) => map.cities.find((c) => c.id === id))
    .filter((c) => c && garrisonOf(c) >= 900)
    .sort((a, b) => garrisonOf(b) - garrisonOf(a))[0];
  assert.ok(target, '玩家本城应有守军足够的邻城可打');
  state.armys[0].soldiers = [400, 0, 0];
  const rsp = handleRequest(ctx, req('strategy.attack', { cityId: target.id, armyId: state.armys[0].id }));
  assert.equal(rsp.msg.ok, true);
  // ★ P2：行军到到达日再结算
  state.clock.day = rsp.msg.arriveDay + 1;
  const fought = strategyResolveMarches(state, cfg, ctx);
  assert.equal(fought.length, 1);
  assert.equal(fought[0].result, 0, `这一仗打不下来（打 ${target.name}，守军 ${garrisonOf(target)}）`);
  const left = state.armys[0].soldiers.reduce((s, n) => s + n, 0);
  assert.ok(left > 0, `战败后应有溃兵归营，实际 ${left}`);
  assert.equal(state.armys[0].soldiers.length, 3);
});

test('P0-3 首战可胜：两将 1200 兵能打下 1 级小城', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const home = homeOf(state);
  const target = neighborsOf(home.id)
    .map((id) => map.cities.find((c) => c.id === id))
    .filter((c) => c && garrisonOf(c) < 1200)
    .sort((a, b) => garrisonOf(a) - garrisonOf(b))[0];
  assert.ok(target, '应有一个守军不足 1200 的邻城可打');
  assert.ok(garrisonOf(target) < 1200, '1 级城守军应落在玩家开局能挑战的区间');
  // 酒馆招一个将，编入第二槽（模拟真实动线）
  const g = makeGeneral(cfg, nextId(state, 'generalId'), [...cfg.generalByCfg.keys()][5], 1, 3);
  state.generals.push(g);
  const asg = handleRequest(ctx, req('army.dispose', {
    cityId: 1, order: 1, position: 1, generalId: g.id,
  }));
  assert.equal(asg.code, 0);
  state.armys[0].soldiers = [800, 400, 0];
  const rsp = handleRequest(ctx, req('strategy.attack', { cityId: target.id, armyId: state.armys[0].id }));
  assert.equal(rsp.msg.ok, true);
  // ★ P2：行军到到达日再结算
  state.clock.day = rsp.msg.arriveDay + 1;
  const fought = strategyResolveMarches(state, cfg, ctx);
  assert.equal(fought.length, 1);
  assert.equal(fought[0].result, 2, `两将夹击应能拿下小城：${fought[0].summary}`);
  assert.equal(ensureStrategy(state).cities[target.id].owner, 'player');
});

/* ---------------- P0-4 ---------------- */

test('P0-4 章节结束后不再按日写 campaign.fired', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  state.campaign.ending = 'held';
  state.clock.day = 200;
  const keys = Object.keys(state.campaign.fired).length;
  state.clock.lastRealMs = Date.now() - DAY * 5;
  settleWorld(ctx);
  assert.equal(state.clock.day, 205);
  assert.equal(Object.keys(state.campaign.fired).length, keys, '结局后不应再按日增长');
});

test('P0-4 旧档的膨胀 fired 在读档时被剪枝', () => {
  const state = createWorld(cfg);
  const fired = {};
  for (let d = 1; d <= 260; d += 1) fired[String(d)] = true;
  state.campaign.fired = fired;
  normalizeWorld(state, cfg);
  const left = Object.keys(state.campaign.fired);
  assert.ok(left.length <= 80, `剪枝后应 ≤80，实际 ${left.length}`);
  assert.ok(left.includes('1'), '第 1 天必须保留（否则开篇文本会重播）');
});

/* ---------------- P1 ---------------- */

test('P1-3 招贤失败给出可读原因，而不是静默空数组', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  ensureTavern(state, cfg);
  state.roleRes.gold = 0;
  // 把当日在店的客人都标记为已招募 → 制造 no_guest
  for (const p of state.tavern.people) p.recruited = true;
  state.tavern.schedule = null;
  const rsp = handleRequest(ctx, req('general.drawGeneral', { drawTimes: 1 }));
  assert.equal(rsp.code, 0);
  assert.deepEqual(rsp.msg.generals, []);
  assert.ok(['no_guest', 'not_enough_gold'].includes(rsp.msg.reason), JSON.stringify(rsp.msg));
});

test('P1-4 编队越界被拒绝，不会凭空多出第 4 支队伍', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const before = state.armys.length;
  const r = handleRequest(ctx, req('army.dispose', { cityId: 1, order: 0, position: 0, generalId: 1000 }));
  assert.equal(r.code, 1);
  assert.equal(state.armys.length, before);
  const r2 = handleRequest(ctx, req('army.dispose', { cityId: 1, order: 4, position: 0, generalId: 1000 }));
  assert.equal(r2.code, 1);
  assert.equal(state.armys.length, before);
});

test('P1-2 旧存档 [100,null,null] 读档后归零为合法整数', () => {
  const state = createWorld(cfg);
  state.armys = [makeArmy(2000, 1, 1, [1000, 0, 0], [100, null, null])];
  normalizeWorld(state, cfg);
  assert.deepEqual(state.armys[0].soldiers, [100, 0, 0]);
  assert.ok(!/null/.test(JSON.stringify(state.armys[0].soldiers)));
});

test('P1-6 来犯军在天下视图可见，并能出兵清剿', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const city = state.citys[0];
  state.garrisons.push({
    id: 77, x: city.x + 2, y: city.y, soldiers: 300, name: '董卓军', cleared: false, faction: 'sili',
  });
  state.armys[0].soldiers = [1200, 0, 0];
  const view = handleRequest(ctx, req('role.myRoleRes', {})); // 走一次结算
  assert.equal(view.code, 0);
  const clear = handleRequest(ctx, req('strategy.clearThreat', { garrisonId: 77 }));
  assert.equal(clear.code, 0, JSON.stringify(clear.msg));
  assert.equal(clear.msg.ok, true);
  assert.ok(clear.msg.summary, '清剿也要有战报摘要');
  assert.equal(state.garrisons.find((x) => x.id === 77).cleared, true);
  assert.ok(state.warReports.length >= 1, '清剿同样落存档');
});
