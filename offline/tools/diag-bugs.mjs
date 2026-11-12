/**
 * 诊断：针对试玩中暴露的可疑点逐条取证（不入库，只打印事实）。
 */
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest, settleWorld } from '../server/handlers.js';
import {
  ensureStrategy, strategyViewState, oathOptions, chooseOath,
  strategyAttack, marchableFrom, strategyTransport, strategyInvest,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();
const j = (v) => { const s = JSON.stringify(v); return s === undefined ? String(v) : s; };
const head = (t) => console.log(`\n===== ${t} =====`);

function fresh() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = { cfg, get state() { return state; }, options: {}, save() {}, log() {}, push() {}, schedule() {} };
  return { state, ctx };
}

function oath(state, ctx) {
  const opts = oathOptions(state);
  const lord = opts.lords[0];
  chooseOath(state, cfg, ctx, { lord: lord.id, city: lord.cities[0].id });
  return state.strategy.playerCity;
}

/* ---------- 1. 设施：非主城的设施列表与升级 ---------- */
head('1 设施归属');
{
  const { state, ctx } = fresh();
  const home = oath(state, ctx);
  console.log('本地 citys:', state.citys.map((c) => c.cityId));
  console.log('state.facilities 的键:', Object.keys(state.facilities || {}));
  const f10 = handleRequest(ctx, { name: 'city.facilities', msg: { cityId: home } });
  console.log(`facilities(${home}) 数量 =`, (f10.msg.facilities || []).length);
  const f1 = handleRequest(ctx, { name: 'city.facilities', msg: { cityId: 1 } });
  console.log('facilities(1) 数量 =', (f1.msg.facilities || []).length);
  // 非主城升级一次后，列表是否出现
  handleRequest(ctx, { name: 'city.upFacility', msg: { cityId: home, fType: 19 } });
  const f10b = handleRequest(ctx, { name: 'city.facilities', msg: { cityId: home } });
  console.log(`upFacility(${home}) 后列表数量 =`, (f10b.msg.facilities || []).length);
  // 对敌方城能不能读/升级
  const enemy = Object.entries(state.strategy.cities).find(([, v]) => v.owner !== 'player');
  const fe = handleRequest(ctx, { name: 'city.facilities', msg: { cityId: Number(enemy[0]) } });
  console.log('敌方城 facilities code =', fe.code, '数量 =', (fe.msg.facilities || []).length);
  const ue = handleRequest(ctx, { name: 'city.upFacility', msg: { cityId: Number(enemy[0]), fType: 19 } });
  console.log('敌方城 upFacility code =', ue.code, '（0 表示成功）');
}

/* ---------- 2. 同一设施连升 / 工期 ---------- */
head('2 设施工期与并发升级');
{
  const { state, ctx } = fresh();
  const home = oath(state, ctx);
  const a = handleRequest(ctx, { name: 'city.upFacility', msg: { cityId: 1, fType: 19 } });
  const b = handleRequest(ctx, { name: 'city.upFacility', msg: { cityId: 1, fType: 19 } });
  console.log('第一次 code =', a.code, '第二次 code =', b.code, '（第二次应为非 0，正在升级中）');
  console.log('up_time =', state.facilities[1]?.find((f) => f.type === 19)?.up_time);
  void home;
}

/* ---------- 3. marchable 是否含己方城 ---------- */
head('3 可出征城与己方城交集');
{
  const { state, ctx } = fresh();
  const home = oath(state, ctx);
  const v = strategyViewState(state, cfg);
  const own = v.cities.filter((c) => c.owner === 'player').map((c) => c.id);
  console.log('playerCity =', home, 'own =', own);
  console.log('本城 marchable =', v.marchable, '交集 =', v.marchable.filter((i) => own.includes(i)));
  // 分城的 marchable 与本城是否不同
  const others = v.cities.filter((c) => c.owner === 'player' && c.id !== home && (c.marchable || []).length);
  for (const c of others.slice(0, 3)) {
    const diff = (c.marchable || []).filter((i) => !(v.marchable || []).includes(i));
    console.log(`城 ${c.id}(${c.name}) marchable=${j(c.marchable)} 不在本城列表里的=${j(diff)}`);
    // 复刻 UI 判定：canAttack = !isHome && s.marchable.includes(target)
    for (const t of diff.slice(0, 2)) {
      const uiSays = (v.marchable || []).includes(t) || [];
      console.log(`  UI 判定：从本城列表看目标 ${t} 可出征? ${uiSays}`,
        `→ 但 c.marchable 说 ${(c.marchable || []).includes(t)}`);
    }
  }
}

/* ---------- 4. 分城出征：服务端 vs UI ---------- */
head('4 分城出征实际可用性');
{
  const { state, ctx } = fresh();
  const home = oath(state, ctx);
  const v = strategyViewState(state, cfg);
  const ownCities = v.cities.filter((c) => c.owner === 'player');
  const other = ownCities.find((c) => c.id !== home);
  if (!other) console.log('没有第二座己方城');
  else {
    const targets = (other.marchable || []).filter((id) => !(v.marchable || []).includes(id));
    console.log(`分城 ${other.name}(${other.id}) 独有目标 = ${j(targets)}`);
    for (const t of targets.slice(0, 2)) {
      const r = strategyAttack(state, cfg, ctx, { cityId: t, fromCityId: other.id, frac: 0.5 });
      console.log(`  strategyAttack(from=${other.id} to=${t}) =`, j(r).slice(0, 200));
      console.log(`  ↑ 后端允许，但 UI 会显示「行军受阻」：marchOk = s.marchable.includes(${t}) = ${(v.marchable || []).includes(t)}`);
    }
  }
}

/* ---------- 5. 重复 settleWorld 是否重复结算 ---------- */
head('5 世界结算幂等性');
{
  const { state, ctx } = fresh();
  oath(state, ctx);
  const before = { ...state.roleRes };
  settleWorld(ctx);
  const once = { ...state.roleRes };
  settleWorld(ctx);
  settleWorld(ctx);
  const thrice = { ...state.roleRes };
  console.log('初始粮', Math.round(before.grain), '→1次', Math.round(once.grain), '→3次', Math.round(thrice.grain));
  console.log('重复结算增量', Math.round(thrice.grain - once.grain), '（同一时刻重复调用不应再加）');
}

/* ---------- 6. 资源越界与负入参 ---------- */
head('6 入参边界');
{
  const { state, ctx } = fresh();
  oath(state, ctx);
  const cases = [
    ['army.conscript', { armyId: 2000, cnts: [-100, 0, 0] }],
    ['army.conscript', { armyId: 2000, cnts: [1e9, 0, 0] }],
    ['army.conscript', { armyId: 99999, cnts: [10, 0, 0] }],
    ['army.dispose', { cityId: 1, order: 1, position: 9, generalId: 1000 }],
    ['army.dispose', { cityId: 1, order: 1, position: 0, generalId: 999999 }],
    ['city.upFacility', { cityId: 1, fType: 9999 }],
    ['strategy.attack', { cityId: 99999 }],
    ['interior.collect', {}],
  ];
  for (const [name, msg] of cases) {
    const r = handleRequest(ctx, { name, msg });
    console.log(`${name} ${j(msg)} → code=${r.code} msg=${j(r.msg).slice(0, 150)}`);
  }
  console.log('征后资源', j(state.roleRes).slice(0, 260));
}

/* ---------- 7. 运输目的城校验 ---------- */
head('7 运输');
{
  const { state, ctx } = fresh();
  const home = oath(state, ctx);
  const enemy = Object.entries(state.strategy.cities).find(([, v]) => v.owner !== 'player');
  for (const cid of [home, Number(enemy[0]), 99999]) {
    const r = strategyTransport(state, cfg, ctx, { cityId: cid, grain: 100 });
    console.log(`transport → ${cid} : ${j(r).slice(0, 160)}`);
  }
}

/* ---------- 8. 内政冷却语义 ---------- */
head('8 内政冷却');
{
  const { state, ctx } = fresh();
  const home = oath(state, ctx);
  const econ = ensureCityEcon(state);
  console.log('本城 econ 初始', j(econ[home]).slice(0, 240));
  const r1 = strategyInvest(state, cfg, ctx, { cityId: home, kind: 'agri' });
  const r2 = strategyInvest(state, cfg, ctx, { cityId: home, kind: 'trade' });
  const r3 = strategyInvest(state, cfg, ctx, { cityId: home, kind: 'relief' });
  console.log('agri', j(r1).slice(0, 100), '| trade', j(r2).slice(0, 100), '| relief', j(r3).slice(0, 100));
  console.log('→ 三种不同任务共用同一冷却字段 lastInvestDay =', econ[home].lastInvestDay);
}

/* ---------- 9. 战报与行军数据结构 ---------- */
head('9 战报');
{
  const { state, ctx } = fresh();
  const home = oath(state, ctx);
  const v = strategyViewState(state, cfg);
  const t = (v.marchable || []).find((id) => state.strategy.cities[id]?.owner !== 'player');
  const army = state.armys.find((a) => (a.soldiers || []).some((n) => n > 0));
  const atk = strategyAttack(state, cfg, ctx, { cityId: t, armyId: army?.id, fromCityId: home, frac: 1 });
  console.log('出征 =', j(atk).slice(0, 220));
  if (atk.ok) {
    state.clock.day = atk.arriveDay;
    const { strategyResolveMarches } = await import('../server/domain/strategy.js');
    const res = strategyResolveMarches(state, cfg, ctx);
    console.log('到达结算 =', j(res).slice(0, 400));
    const rep = handleRequest(ctx, { name: 'war.report', msg: {} });
    console.log('war.report code =', rep.code, 'keys =', Object.keys(rep.msg || {}), '摘要', j(rep.msg).slice(0, 300));
    console.log('队伍兵力', j(state.armys.map((a) => a.soldiers)));
    console.log('目标城归属', state.strategy.cities[t]?.owner);
  }
}

/* ---------- 10. 存档字段完备性 ---------- */
head('10 存档');
{
  const { state, ctx } = fresh();
  oath(state, ctx);
  const keys = Object.keys(state).sort();
  console.log('state 顶层字段', keys.length, keys.join(','));
  const missing = ['strategy', 'cityEcon', 'interior', 'captives', 'roleRes'].filter((k) => !(k in state));
  console.log('缺失字段', j(missing));
  console.log('account 里存了什么', j(state.account).slice(0, 200));
}
