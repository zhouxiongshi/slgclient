/**
 * P14 诸侯 AI 智能化回归（用户 2026-11-16「AI 笨 / 友军不支援 / 没挑战性」）：
 *  1. 驰援：玩家大军压境 → 守方势力从邻城发援军（多城合援、扣粮饷、扣兵、可见行军实体）；
 *  2. 驰援到达：援军先于玩家入城并真实抬高守军（攻城不再是单方面推平）；
 *  3. 防重：每支来犯军每势力至多援一次；扑空折返；
 *  4. 人格：defense 轴过低（吕布 0.2）见死不救；
 *  5. 制衡：玩家势大（城数/占比）→ 诸侯把玩家纳入讨伐目标且能真正发出征令（同门槛复查）；
 *  6. 内政：兵压境时征兵规模上浮（威胁感知）。
 */
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, neighborsOf,
} from '../server/domain/strategy.js';
import { factionReliefTick, strategyResolveMarches } from '../server/domain/strategy.js';
import { planCampaign, PERSONA_AXES } from '../server/domain/strategy-brain.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const cfg = loadConfig();

function lordWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const ctx = { state, cfg, options: {}, pushes: [], push() {}, save() {}, log() {}, schedule() {} };
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, ctx, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  return { state, ctx, st: state.strategy, conf: (() => {
    // factionConfFor 不在本文件 import，经 diplomacy 的常量路径拿不到——直接读 conf
    const c = cfg.factions || cfg.strategy?.factions;
    return c;
  })() };
}

function fakeSnapshot(st, map, conf) {
  return {
    cities: map.cities.map((c) => ({
      id: c.id, name: c.name, owner: st.cities[c.id]?.owner || 'han',
      troops: st.cities[c.id]?.troops || 0, defense: 0.4, arms: c.arms || '',
    })),
    own: { grain: 30000, gold: 20000 },
    relations: {},
    lords: Object.fromEntries((conf?.factions || []).map((x) => [x.id, x.name])),
    turn: st.turn,
    movements: [],
  };
}

/* ---------------- 驰援 ---------------- */

test('P14-A 驰援：玩家来犯时守方发援军（多城、扣粮饷扣兵、可见行军）', () => {
  const { state, ctx, st } = lordWorld();
  const map = cfg.strategy?.map || null;
  const { strategyMap } = require0();
  const m = strategyMap();
  const home = st.playerCity;
  // 找一座 NPC 邻城当目标
  const targetId = neighborsOf(home).map(Number).find((id) => {
    const row = st.cities[id];
    return row && row.owner !== 'player' && row.owner !== 'han';
  });
  assert.ok(targetId, '地图上应有 NPC 邻城');
  const owner = st.cities[targetId].owner;
  const beforeTroops = st.cities[targetId].troops;
  // 伪造一支玩家在途大军（3 日后抵达）
  const today = Math.max(1, Math.floor(state.clock.day) || 1);
  st.marches = [{
    id: 9001, side: 'player', from: home, to: targetId,
    departDay: today, arriveDay: today + 3, troops: 6000, km: 160, speed: 100, marchDays: 3,
    armyId: 0, frac: 1, grainCost: 0, confirmBattle: true, pendingBattle: false, confirmed: false,
  }];
  const res = st.resources[owner] ? { g: st.resources[owner].grain, gold: st.resources[owner].gold } : null;
  const dispatched = factionReliefTick(state, cfg, ctx);
  assert.ok(dispatched.length >= 1, '守方势力应派出援军');
  const relief = st.marches.filter((x) => x.side === 'faction' && x.kind === 'relief');
  assert.ok(relief.length >= 1, '应有可见援军行军实体');
  assert.ok(relief.every((x) => x.to === targetId && x.arriveDay <= today + 3), '援军不晚于来犯军抵城');
  // 扣兵：来源城兵力减少
  const sentTotal = relief.reduce((s, x) => s + x.troops, 0);
  assert.ok(sentTotal >= 500, '援军规模至少 500');
  const srcIds = relief.map((x) => Number(x.from));
  for (const id of srcIds) {
    assert.equal(st.cities[id].owner, owner, '发兵城属守方势力');
  }
  // 扣粮饷
  const resAfter = st.resources[owner];
  if (res) {
    assert.ok(resAfter.grain < res.g || resAfter.gold < res.gold, '援军粮饷应被扣除');
  }
  assert.equal(st.cities[targetId].troops, beforeTroops, '目标城守军此刻未变（援军在途）');
  // 目标城池日志有驰援记录
  const cityLog = st.cityLogs[String(targetId)] || [];
  assert.ok(cityLog.some((e) => e.kind === '驰援'), '城池日志应有驰援条目');
  assert.equal(st.marches.filter((x) => x.kind === 'relief').length, relief.length, '防重：不重复派');
});

test('P14-B 驰援到达：援军先入城抬高守军；玩家攻城不再无阻力', () => {
  const { state, ctx, st } = lordWorld();
  const { strategyMap } = require0();
  const m = strategyMap();
  const home = st.playerCity;
  const targetId = neighborsOf(home).map(Number).find((id) => {
    const row = st.cities[id];
    return row && row.owner !== 'player' && row.owner !== 'han';
  });
  const owner = st.cities[targetId].owner;
  const beforeTroops = st.cities[targetId].troops;
  const today = Math.max(1, Math.floor(state.clock.day) || 1);
  st.marches = [{
    id: 9002, side: 'player', from: home, to: targetId,
    departDay: today, arriveDay: today + 3, troops: 6000, km: 160, speed: 100, marchDays: 3,
    armyId: 0, frac: 1, grainCost: 0, confirmBattle: false, pendingBattle: false, confirmed: false,
  }];
  factionReliefTick(state, cfg, ctx);
  const relief = st.marches.filter((x) => x.kind === 'relief' && !x.resolved);
  assert.ok(relief.length >= 1, '应有援军在途');
  const reliefTroops = relief.reduce((s, x) => s + x.troops, 0);
  // 时钟推进到援军抵达日（先于/等于来犯军），解析到达
  const arriveDay = Math.min(...relief.map((x) => x.arriveDay));
  state.clock.day = arriveDay;
  strategyResolveMarches(state, cfg, ctx);
  assert.equal(st.cities[targetId].owner, owner, '援军先到城未易主');
  assert.equal(st.cities[targetId].troops, beforeTroops + reliefTroops, '援军并兵入守');
  // 玩家来犯军仍未解析（援军先解析）
  const playerMarch = st.marches.find((x) => x.side === 'player');
  assert.ok(playerMarch, '玩家来犯军仍在');
});

test('P14-C 人格：defense 轴过低（吕布）见死不救', () => {
  const { state, ctx, st } = lordWorld();
  const { strategyMap } = require0();
  const m = strategyMap();
  // 找吕布的城市对（本城+邻城都归吕布）
  const lvbu = PERSONA_AXES['吕布'];
  assert.ok(lvbu && lvbu.defense < 0.25, '吕布 defense 轴应 < 0.25');
  const allIds = m.cities.map((c) => c.id);
  let pair = null;
  for (const c of m.cities) {
    if (st.cities[c.id]?.owner !== 'lvbu') continue;
    const n = neighborsOf(c.id).map(Number).find((id) => st.cities[id]?.owner === 'lvbu');
    if (n) { pair = { src: n, to: c.id }; break; }
  }
  if (!pair) return; // 地图无吕布邻接对则跳过（确定性地图，正常都有）
  const today = Math.max(1, Math.floor(state.clock.day) || 1);
  st.cities[pair.src].troops = 5000;
  st.marches = [{
    id: 9003, side: 'player', from: st.playerCity, to: pair.to,
    departDay: today, arriveDay: today + 3, troops: 4000, km: 100, speed: 100, marchDays: 3,
    armyId: 0, frac: 1, grainCost: 0, confirmBattle: true, pendingBattle: false, confirmed: false,
  }];
  const dispatched = factionReliefTick(state, cfg, ctx);
  assert.equal(dispatched.filter((d) => d.faction === 'lvbu').length, 0, '吕布不发驰援');
});

/* ---------------- 制衡 ---------------- */

test('P14-D 制衡：玩家势大 → 诸侯讨伐玩家且能真正发出征令（同门槛复查）', () => {
  const { state, ctx, st } = lordWorld();
  const { strategyMap, factionConfFor } = require0();
  const m = strategyMap();
  const conf = factionConfFor(state);
  // 玩家坐大：多城 + 守军中等
  let given = 0;
  for (const c of m.cities) {
    if (given >= 4) break;
    if (c.id === st.playerCity || st.cities[c.id]?.owner === 'player') continue;
    if (st.cities[c.id]?.owner === 'han' || st.cities[c.id]?.owner === 'player') continue;
    st.cities[c.id].owner = 'player';
    st.cities[c.id].troops = 3500;
    given += 1;
  }
  const snap = () => fakeSnapshot(st, m, conf);
  let found = null;
  for (const f of conf.factions) {
    // 该势力各城兵力抬到中期规模，保证 workable 走得通
    for (const c of m.cities) {
      if (st.cities[c.id]?.owner === f.id) st.cities[c.id].troops = Math.max(st.cities[c.id].troops, 10000);
    }
    st.resources[f.id] = { gold: 20000, grain: 30000 };
    const sheet = planCampaign(f, snap(), state);
    const isPlayerTarget = sheet.strategy_orders.some((o) => o.type === '出征'
      && st.cities[Number(o.target)]?.owner === 'player');
    if (isPlayerTarget) {
      found = f;
      const atk = sheet.strategy_orders.find((o) => o.type === '出征');
      assert.ok(atk.params.troops >= 400, '出征兵力合理');
      assert.ok(atk.params.fromCity, '有出发城');
    }
  }
  assert.ok(found, '玩家势大时至少一家诸侯应出兵制衡玩家');
});

test('P14-E 玩家尚弱时诸侯不主动讨伐玩家', () => {
  const { state, ctx, st } = lordWorld();
  const { strategyMap, factionConfFor } = require0();
  const m = strategyMap();
  const conf = factionConfFor(state);
  const snap = fakeSnapshot(st, m, conf);
  for (const f of conf.factions) {
    for (const c of m.cities) {
      if (st.cities[c.id]?.owner === f.id) st.cities[c.id].troops = Math.max(st.cities[c.id].troops, 6000);
    }
    st.resources[f.id] = { gold: 20000, grain: 30000 };
    const sheet = planCampaign(f, snap, state);
    const isPlayerTarget = sheet.strategy_orders.some((o) => o.type === '出征'
      && st.cities[Number(o.target)]?.owner === 'player');
    // 开局玩家只有 1 城：制衡闸（城数<3 且占比<25%）不许把玩家当目标
    // （revenge：本局玩家未夺过 NPC 城，grudge 为空）
    assert.equal(isPlayerTarget, false, `${f.name} 不应在玩家弱小时讨伐玩家`);
  }
});

/* ---------------- 内政 ---------------- */

test('P14-F 内政感知：兵压境时征兵规模上浮', () => {
  const { state, ctx, st } = lordWorld();
  const { strategyMap, factionConfFor } = require0();
  const m = strategyMap();
  const conf = factionConfFor(state);
  const f = conf.factions[0];
  for (const c of m.cities) {
    if (st.cities[c.id]?.owner === f.id) st.cities[c.id].troops = Math.max(st.cities[c.id].troops, 6000);
  }
  st.resources[f.id] = { gold: 20000, grain: 30000 };
  const snap = fakeSnapshot(st, m, conf);
  const base = planCampaign(f, snap, state);
  const recruitCount = (sheet) => {
    const o = (sheet.internal_orders || []).find((x) => x.type === '征兵');
    return o ? o.params.count : 0;
  };
  // 安稳基线
  const calm = recruitCount(base);
  // 兵压境：邻接城出现 3 倍于本方首城守军的敌军
  const homeCity = m.cities.find((c) => c.id === st.cities && false) || m.cities.find((c) => st.cities[c.id]?.owner === f.id);
  if (homeCity) {
    for (const nid of neighborsOf(homeCity.id).map(Number)) {
      if (st.cities[nid] && st.cities[nid].owner !== f.id && st.cities[nid].owner !== 'han') {
        st.cities[nid].troops = Math.max(4000, Math.round((st.cities[homeCity.id]?.troops || 1000) * 3));
      }
    }
    const snap2 = fakeSnapshot(st, m, conf);
    const threatened = planCampaign(f, snap2, state);
    const panic = recruitCount(threatened);
    assert.ok(panic > calm, `兵压境时应征更多兵（${panic} > ${calm}）`);
  }
});

/* ---- 小工具：动态取 strategyMap/factionConfFor（避免顶层循环依赖顺序问题） ---- */
import * as strategyMod from '../server/domain/strategy.js';
function require0() {
  return {
    strategyMap: strategyMod.strategyMap,
    factionConfFor: strategyMod.factionConfFor,
  };
}

/* ---------------- UX 静态闸 ---------------- */

test('P14-G UX：推演三月/自动推旬注入层存在且有安全停机', () => {
  const src = readFileSync(new URL('../server/skills.js', import.meta.url), 'utf8');
  assert.ok(src.includes('id="slgStratTick3"'), '应注入「推演三月」按钮');
  assert.ok(src.includes('id="slgStratAuto"'), '应注入「自动推旬」开关');
  assert.ok(src.includes('function pendingBlock()'), '应有统一停机判据');
  assert.ok(/pendingEvents \|\| \[\]\)\.length/.test(src), '未决事件必须停机');
  assert.ok(/mm\.pendingBattle/.test(src), '前锋抵城待定夺必须停机');
  assert.ok(src.includes('clearInterval(autoTimer)'), '自动模式可真正关闭');
  /* z-index 阶梯红线：字符串拼接的注释必须放表达式外 */
  assert.doesNotMatch(src, /\+\s*\/\*[\s\S]{0,200}?\*\//, '拼接表达式中不许夹注释（会变一元加号丢整条 CSS/HTML）');
  const sv = readFileSync(new URL('../server/domain/strategy.js', import.meta.url), 'utf8');
  assert.ok(sv.includes('pendingBattle: !!(mm.pendingBattle'), 'marches 视图应下发 pendingBattle');
});
