/**
 * 机器人试玩：按玩家真实操作顺序把《穿越·汉末》离线版跑一轮，
 * 逐步记录返回值、异常与数据矛盾。
 *
 * 目的不是"跑通就算过"，而是把每一步的返回摊开，找不自洽的地方：
 *   - handler 抛异常（服务端 onMessage 会静默吞成 code:0，这里直接暴露）
 *   - code 非 0
 *   - 数值异常（负资源、NaN、超上限、重复 id）
 *   - 状态不闭环（出征不锁队、到达不开打、存档丢字段）
 *
 * 用法：node tools/playtest.js [--json 输出路径]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest, settleWorld } from '../server/handlers.js';
import {
  ensureStrategy, strategyViewState, oathOptions, chooseOath,
  strategyAttack, strategyTransport, strategyInvest, strategyResolveMarches,
} from '../server/domain/strategy.js';
import { ensureCityEcon, cityYield } from '../server/domain/city-econ.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();

const state = normalizeWorld(createWorld(cfg), cfg);
const steps = [];
const issues = [];
let saveCount = 0;

const ctx = {
  cfg,
  get state() { return state; },
  options: { travelMs: 3000, saveDir: null },
  save() { saveCount += 1; },
  log() {},
  push() {},
  schedule(at, task) { (state.pending ||= []).push({ at, task }); },
};

/** 发一条协议，记录耗时/返回/异常 */
function send(name, msg = {}, note = '') {
  const t0 = performance.now();
  let out = null;
  let err = null;
  try {
    out = handleRequest(ctx, { name, msg });
  } catch (e) {
    err = e;
  }
  const ms = +(performance.now() - t0).toFixed(2);
  const rec = {
    step: steps.length + 1, name, msg, note, ms,
    code: out?.code ?? null,
    msgKeys: out?.msg && typeof out.msg === 'object' ? Object.keys(out.msg).slice(0, 12) : null,
    error: err ? (err.stack || err.message).split('\n').slice(0, 3).join(' | ') : null,
  };
  steps.push(rec);
  if (err) {
    issues.push({ kind: 'exception', step: rec.step, name, note, detail: rec.error });
  } else if (out?.code !== 0) {
    issues.push({ kind: 'nonzero', step: rec.step, name, note, detail: `code=${out.code} msg=${j(out.msg).slice(0, 200)}` });
  }
  return out;
}

/** JSON.stringify 对 undefined 返回 undefined，直接 .slice 会炸 */
const j = (v) => { const t = JSON.stringify(v); return t === undefined ? String(v) : t; };

function issue(kind, where, detail) {
  issues.push({ kind, step: steps.length, name: where, detail });
}

function snapshot() {
  return {
    day: state.clock?.day ?? 1,
    res: { ...state.roleRes },
    generals: (state.generals || []).length,
    armys: (state.armys || []).length,
    cities: (state.citys || []).length,
    strategyCities: Object.keys(state.strategy?.cities || {}).length,
    playerCity: state.strategy?.playerCity ?? 0,
  };
}

/* ============================================================
 * 第 0 幕：登录 → 建角 → 进服
 * ============================================================ */
send('account.serverList', {}, '账号：拉服务器列表');
send('account.login', { username: 'playtest', password: 'pt-123456' }, '账号：登录（明文口令）');
send('role.roleList', {}, '角色：角色列表');
send('role.create', { nickName: '试玩君主', sex: 1, headId: 1 }, '角色：建角');
send('role.enterServer', {}, '角色：进服');
send('role.myProperty', {}, '角色：总资产');
send('role.myRoleRes', {}, '角色：资源');
send('role.myCity', {}, '角色：城池');
send('role.myRoleBuild', {}, '角色：建筑');
send('role.posTagList', {}, '角色：坐标标记');

const res0 = { ...state.roleRes };
for (const k of ['grain', 'gold', 'wood', 'iron', 'stone', 'decree']) {
  if (Number(res0[k]) < 0) issue('bad_data', '初始资源', `${k}=${res0[k]} 为负`);
}

/* ============================================================
 * 第 1 幕：序章（借粮/拒借）
 * ============================================================ */
const camp0 = send('campaign.status', {}, '序章：状态');
send('world.meta', {}, '世界：元信息');
send('campaign.choose', { option: 'lend' }, '序章：选择「借粮」');
const camp1 = send('campaign.status', {}, '序章：选择后状态');
if (camp1?.msg && camp0?.msg && camp1.msg.choice === camp0.msg.choice) {
  issue('state_stuck', '序章选择', `选择前后 choice 都是 ${camp0.msg.choice}，选择可能没生效`);
}

/* ============================================================
 * 第 2 幕：举义（择主 + 择城）
 * ============================================================ */
const opts = oathOptions(state);
if (!opts?.lords?.length) {
  issue('dead_end', '举义', 'oathOptions 没有可投靠的诸侯，新档无法进入沙盘');
} else {
  const lord = opts.lords[0];
  const cityOpt = lord.cities?.[0];
  if (!cityOpt) issue('dead_end', '举义', `诸侯 ${lord.name} 没有可选城`);
  else {
    const r = chooseOath(state, cfg, ctx, { lord: lord.id, city: cityOpt.id });
    steps.push({ step: steps.length + 1, name: 'chooseOath', msg: { lord: lord.id, city: cityOpt.id }, note: '举义：择主择城', code: r.ok ? 0 : 1, msgKeys: Object.keys(r) });
    if (!r.ok) issues.push({ kind: 'nonzero', step: steps.length, name: 'chooseOath', detail: JSON.stringify(r) });
  }
}

const st = ensureStrategy(state);
const view = strategyViewState(state, cfg);
if (!view?.cities?.length) issue('bad_data', '沙盘', 'strategyViewState 返回空城池列表');
const ownCities = (view?.cities || []).filter((c) => c.owner === 'player');
if (ownCities.length === 0) issue('dead_end', '沙盘', '举义后玩家一座城都没有');

/* ============================================================
 * 第 3 幕：城池面板 + 内政
 * ============================================================ */
const homeId = state.strategy.playerCity;
send('city.facilities', { cityId: homeId }, '城池：设施列表');
send('role.myRoleRes', {}, '城池：府库资源');
send('interior.openCollect', { cityId: homeId }, '内政：开征收');
send('interior.collect', { cityId: homeId }, '内政：征收');
send('interior.transform', { cityId: homeId, to: 1 }, '内政：转换');

const fac = send('city.facilities', { cityId: homeId }, '城池：设施复核');
const facList = fac?.msg?.facilities || fac?.msg?.facs || [];
if (Array.isArray(facList) && facList.length === 0) {
  issue('bad_data', '城池设施', '本城设施列表为空，无法升级内政');
}

/* 内政任务：开垦 / 招商 / 募兵 / 修城 / 赈灾，各连点两次验冷却 */
for (const kind of ['agri', 'trade', 'barracks', 'defense', 'relief']) {
  const a = strategyInvest(state, cfg, ctx, { cityId: homeId, kind });
  const b = strategyInvest(state, cfg, ctx, { cityId: homeId, kind });
  steps.push({
    step: steps.length + 1, name: `invest:${kind}`, code: a.ok ? 0 : 1,
    note: '内政任务（连点两次验冷却）',
    msgKeys: [j(a).slice(0, 160), j(b).slice(0, 160)],
  });
  if (!a.ok) issues.push({ kind: 'nonzero', step: steps.length, name: `invest:${kind} 首次`, detail: JSON.stringify(a) });
  if (b.ok) issues.push({ kind: 'logic', step: steps.length, name: `invest:${kind} 冷却`, detail: '同一城同一旬内连续两次成功，旬冷却未生效' });
}

/* ============================================================
 * 第 4 幕：武将 / 酒馆
 * ============================================================ */
send('general.myGenerals', {}, '武将：名册');
send('tavern.guests', {}, '酒馆：在野列表');
send('general.explore', { cityId: homeId }, '酒馆：探索人才');
send('general.explore', { cityId: homeId }, '酒馆：再探（验成本/冷却）');
send('skill.list', {}, '战法：列表');
send('general.drawGeneral', { times: 1 }, '武将：招贤一次');
send('general.convert', { generalId: state.generals?.[0]?.id ?? 1 }, '武将：转换');

/* ============================================================
 * 第 5 幕：军队 —— 编队 / 征兵
 * ============================================================ */
const armies = send('army.myList', { cityId: homeId }, '军队：列表');
const armyList = armies?.msg?.armys || armies?.msg?.army || [];
if (!Array.isArray(armyList) || armyList.length === 0) {
  issue('bad_data', '军队列表', 'army.myList 没有返回任何队伍');
}
const gens = state.generals || [];
const army0 = (state.armys || [])[0];
if (army0 && gens[0]) {
  send('army.dispose', { cityId: homeId, order: 1, position: 0, generalId: gens[0].id }, '军队：编队槽 1-前锋');
  if (gens[1]) send('army.dispose', { cityId: homeId, order: 1, position: 1, generalId: gens[1].id }, '军队：编队槽 1-中军');
}
const cons1 = send('army.conscript', { cityId: homeId, order: 1, num: 500 }, '军队：征兵 500');
if (cons1?.msg && (cons1.msg.reason || cons1.msg.etaSec === undefined)) {
  issue('logic', '征兵', `返回缺少工期字段：${j(cons1.msg).slice(0, 200)}`);
}
send('army.conscript', { cityId: homeId, order: 1, num: 999999 }, '军队：超额征兵（越界入参）');
send('army.myOne', { cityId: homeId, order: 1 }, '军队：单队详情');
send('army.assign', { cityId: homeId, order: 1, generalId: gens[0]?.id ?? 1 }, '军队：指派');

/* ============================================================
 * 第 6 幕：出征 → 行军 → 战报
 * ============================================================ */
const targetId = view?.marchable?.[0];
if (!Number.isFinite(targetId)) {
  issue('dead_end', '出征', '本城 marchable 为空，无邻城可攻');
} else {
  const grainBefore = Number(state.roleRes.grain) || 0;
  const atk = strategyAttack(state, cfg, ctx, { cityId: targetId, fromCityId: homeId, frac: 0.5 });
  steps.push({ step: steps.length + 1, name: 'strategy.attack', code: atk.ok ? 0 : 1, note: '出征（半军）', msgKeys: [j(atk).slice(0, 200)] });
  if (!atk.ok) {
    issues.push({ kind: 'nonzero', step: steps.length, name: 'strategy.attack', detail: JSON.stringify(atk) });
  } else {
    const m = (state.strategy.marches || []).at(-1);
    if (!m) issue('logic', '出征', '出征成功但没有生成行军队列');
    else {
      const locked = (state.armys || []).filter((a) => a.marchId === m.id);
      if (locked.length !== 1) issue('logic', '出征', `应有 1 支队伍被锁，实际 ${locked.length}`);
      const grainAfter = Number(state.roleRes.grain) || 0;
      const store = state.strategy.cityEcon?.[homeId]?.store ?? 0;
      steps.push({
        step: steps.length + 1, name: 'march-check', code: 0, note: '行军记录核对',
        msgKeys: [`from=${m.from} to=${m.to} depart=${m.departDay} arrive=${m.arriveDay} km=${m.km} speed=${m.speed}`, `粮 ${grainBefore}→${grainAfter}，城库 ${store}`],
      });
      // 未到日不结算
      const early = strategyResolveMarches(state, cfg, ctx);
      if (early.length !== 0) issue('logic', '行军', `未到到达日就结算了 ${early.length} 条`);
      // 推进到到达日
      state.clock.day = m.arriveDay;
      const resolved = strategyResolveMarches(state, cfg, ctx);
      steps.push({ step: steps.length + 1, name: 'march-arrive', code: 0, note: `推进到第 ${m.arriveDay} 日`, msgKeys: [j(resolved).slice(0, 240)] });
      if (resolved.length !== 1) issue('logic', '行军到达', `到达日应结算 1 条，实际 ${resolved.length}`);
      const stillLocked = (state.armys || []).filter((a) => a.marchId === m.id);
      if (stillLocked.length) issue('logic', '行军到达', '结算后队伍仍被锁住');
      const reports = state.warReports || [];
      if (reports.length === 0) issue('logic', '战斗', '打完了但没有生成战报');
    }
  }
}

/* ============================================================
 * 第 7 幕：运输 / 赏赐 / 招降
 * ============================================================ */
strategyTransport(state, cfg, ctx, { cityId: homeId, grain: 100 });
strategyTransport(state, cfg, ctx, { cityId: homeId, grain: 99999999 });
const cap = state.captives?.[0];
if (cap) {
  steps.push({ step: steps.length + 1, name: 'recruitCaptive', code: 0, note: '招降（有俘虏）', msgKeys: [] });
}

/* ============================================================
 * 第 8 幕：世界地图 / 外交
 * ============================================================ */
send('nationMap.scan', { x: 100, y: 100, w: 20, h: 20 }, '地图：扫描区块');
send('nationMap.scanBlock', { x: 100, y: 100, w: 10, h: 10 }, '地图：扫描地块');
send('nationMap.build', { x: 101, y: 101, type: 52 }, '地图：占地建田');
send('nationMap.upBuild', { x: 101, y: 101 }, '地图：升级地块');
send('union.list', {}, '同盟：列表');
send('chat.login', {}, '聊天：登录');
send('chat.chat', { type: 0, msg: '试玩' }, '聊天：发言');

/* ============================================================
 * 第 9 幕：跨回合推进（10 日 / 回合）
 * ============================================================ */
const dayBefore = state.clock.day;
for (let i = 0; i < 6; i += 1) {
  state.clock.day = (state.clock.day || 1) + 10;
  settleWorld(ctx);
}
steps.push({ step: steps.length + 1, name: 'settleWorld', code: 0, note: `推进 ${state.clock.day - dayBefore} 日`, msgKeys: [`day=${state.clock.day}`] });

const res1 = { ...state.roleRes };
for (const [k, v] of Object.entries(res1)) {
  if (typeof v === 'number' && !Number.isFinite(v)) issue('bad_data', '资源', `${k}=${v} 不是有限数`);
  if (typeof v === 'number' && v < 0) issue('bad_data', '资源', `${k}=${v} 出现负数`);
}

/* ============================================================
 * 第 10 幕：数据一致性
 * ============================================================ */
const seenIds = new Set();
for (const c of state.citys || []) {
  const id = c.cityId ?? c.id;
  if (seenIds.has(id)) issue('bad_data', '城池 id', `重复 cityId=${id}`);
  seenIds.add(id);
}
const genSeen = new Set();
for (const g of state.generals || []) {
  if (genSeen.has(g.id)) issue('bad_data', '武将 id', `重复 generalId=${g.id}`);
  genSeen.add(g.id);
}
for (const a of state.armys || []) {
  const slots = new Map();
  for (const gid of a.generals || []) {
    if (!gid) continue;
    if (slots.has(gid)) issue('bad_data', '编队', `第 ${a.order} 军把武将 ${gid} 排进两个槽`);
    slots.set(gid, 1);
  }
  const total = (a.soldiers || []).reduce((s, n) => s + (Number(n) || 0), 0);
  if (total < 0) issue('bad_data', '兵力', `第 ${a.order} 军兵力为负`);
}
// 存档往返
const dump = JSON.stringify(state);
const round = JSON.parse(dump);
if (JSON.stringify(round) !== dump) issue('bad_data', '存档', 'JSON 往返不相等（存在不可序列化字段）');

/* ============================================================
 * 汇总
 * ============================================================ */
const finalView = strategyViewState(state, cfg);
const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    steps: steps.length,
    exceptions: issues.filter((i) => i.kind === 'exception').length,
    nonZero: issues.filter((i) => i.kind === 'nonzero').length,
    logic: issues.filter((i) => i.kind === 'logic').length,
    deadEnd: issues.filter((i) => i.kind === 'dead_end').length,
    badData: issues.filter((i) => i.kind === 'bad_data').length,
    saves: saveCount,
  },
  snapshot: { start: snapshot(), end: {
    day: state.clock?.day,
    res: { ...state.roleRes },
    ownCities: (finalView?.cities || []).filter((c) => c.owner === 'player').length,
    allCities: (finalView?.cities || []).length,
    armies: (state.armys || []).length,
    warReports: (state.warReports || []).length,
    generals: (state.generals || []).length,
  } },
  issues,
  steps,
};

const outPath = process.argv.includes('--json')
  ? resolve(process.argv[process.argv.indexOf('--json') + 1])
  : resolve(HERE, '..', 'reports', `playtest-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

console.log(`[playtest] 步数 ${report.summary.steps}  异常 ${report.summary.exceptions}  非零 ${report.summary.nonZero}  逻辑 ${report.summary.logic}  死路 ${report.summary.deadEnd}  脏数据 ${report.summary.badData}`);
console.log(`[playtest] 报告 ${outPath}`);
for (const i of issues) console.log(`  [${i.kind}] ${i.name} :: ${String(i.detail).slice(0, 220)}`);
