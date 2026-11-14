/**
 * 系统性验收：长时多势力模拟 + 全业务场景 + 灭国闭环 + 日志排查。
 *
 *   node tools/system-audit.mjs [--turns 60] [--seed 20261114] [--json out.json]
 *
 * 时间口径（GDD §9.2）：世界时钟 60 秒/游戏日、旬长 10 日。真实挂机 30 分钟 = 30 日 = 3 旬；
 * 为使「一方灭掉一方」可观测，本脚本按 30 分钟 ×20 加速 = 600 日 = 60 旬推进
 * （与 tools/sim-60turns.mjs 同口径）。所有推进只调真实领域函数，不复制任何结算逻辑。
 *
 * 输出：reports/system-audit.json（逐旬指标 / 全场景清单 / 不变量 / 灭国链 / 日志结论）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, normalizeWorld } from '../server/world.js';
import { loadConfig } from '../server/config.js';
import { createHash } from 'node:crypto';
import {
  ensureStrategy, oathOptions, chooseOath, strategyTick, strategyResolveMarches, localBrain,
  strategyAttack, strategyConfirmBattle, strategyRetreatBattle, strategyDigestDone,
  strategyRecallMarch, strategyReorderMarch, strategyFormup, strategyTransport,
  strategyInvest, cancelInvest, rewardGeneral, recruitCaptive, strategyEventChoice,
  strategyEventTick, strategySetScenario, strategyViewState, previewAssault,
  factionConfFor, clearThreat, strategyFateView, marchableFrom,
} from '../server/domain/strategy.js';
import { cityEconTick } from '../server/domain/city-econ.js';
import { canMarchBetween } from '../server/domain/march.js';
import { strategyAppoint, strategyCancelAppointment } from '../server/domain/appointment.js';
import { diplomacyAct } from '../server/domain/diplomacy.js';
import {
  disarmForGold, sellGrain, emergencyConscript, relocateCapital, evaluateEnding,
} from '../server/domain/failstate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'reports', 'system-audit.json');

/* ---------------------------------------------------------------- 工具 */
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function deepNumericScan(obj, path = '', out = [], depth = 0) {
  if (depth > 9 || !obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = `${path}.${k}`;
    if (typeof v === 'number' && !Number.isFinite(v)) out.push(`${p}=${v}`);
    else if (typeof v === 'string' && /NaN|Infinity|undefined/.test(v) && v.length < 120) out.push(`${p}="${v}"`);
    else if (v && typeof v === 'object' && depth < 8) deepNumericScan(v, p, out, depth + 1);
  }
  return out;
}

/** 每旬不变量：数值有限、归属合法、资源非负、队列有界、旬历自洽。 */
function checkInvariants(state, cfg, tag) {
  const st = state.strategy;
  const problems = [];
  const conf = factionConfFor(state);
  const legal = new Set([...conf.factions.map((f) => f.id), 'player', conf.neutral?.id, 'han', state.role?.rid]);
  for (const [id, row] of Object.entries(st.cities || {})) {
    if (!legal.has(row.owner)) problems.push(`${tag}: 城 ${id} owner 非法=${row.owner}`);
    if (!finite(row.troops) || row.troops < 0) problems.push(`${tag}: 城 ${id} 兵=${row.troops}`);
  }
  for (const [id, res] of Object.entries(st.resources || {})) {
    for (const k of ['gold', 'grain']) {
      if (!finite(res[k])) problems.push(`${tag}: ${id}.${k}=${res[k]}`);
    }
  }
  for (const [id, e] of Object.entries(st.cityEcon || {})) {
    for (const k of ['store', 'pop', 'loyalty']) {
      if (e[k] !== undefined && (!finite(e[k]) || e[k] < 0)) problems.push(`${tag}: econ ${id}.${k}=${e[k]}`);
    }
  }
  if (!finite(state.roleRes?.gold) || !finite(state.roleRes?.grain)) problems.push(`${tag}: roleRes 非有限`);
  if ((st.pendingEvents || []).length > 8) problems.push(`${tag}: pendingEvents 堆积 ${st.pendingEvents.length}`);
  if ((st.marches || []).length > 40) problems.push(`${tag}: marches 堆积 ${st.marches.length}`);
  if (!finite(st.turn) || st.turn < 0) problems.push(`${tag}: turn=${st.turn}`);
  const bad = deepNumericScan({ cities: st.cities, resources: st.resources, econ: st.cityEcon, marches: st.marches, pending: st.pendingEvents }, 'st', [], 0);
  for (const b of bad.slice(0, 12)) problems.push(`${tag}: ${b}`);
  return problems;
}

function factionCityCounts(state) {
  const out = {};
  for (const row of Object.values(state.strategy.cities || {})) out[row.owner] = (out[row.owner] || 0) + 1;
  return out;
}

/* ---------------------------------------------------------------- 世界 */
export function runAudit({ seed = 20261114, turns = 60 } = {}) {
  const cfg = loadConfig();
  const state = normalizeWorld(createWorld(cfg), cfg);
  state.seed = seed;
  ensureStrategy(state);

  const logs = [];                    // ctx.push 全量（含 chat.push 消息）
  const ctx = { push: (t, m) => { logs.push({ t, m }); } };
  const consoleErrors = [];
  const origErr = console.error;
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
  const errors = [];                  // 场景抛出的未捕获异常
  const invariants = [];
  const scenarios = [];               // 场景清单：{name, turn, ok, note}
  const conquest = { events: [], eliminated: null, atTurn: 0, postTurns: 0 };

  /** 场景执行器：业务拒绝是正常（记 rejected），抛异常才是 bug（记 errors）。 */
  function attempt(name, turn, fn) {
    try {
      const r = fn();
      const ok = r?.ok !== false;
      scenarios.push({ name, turn, ok, rejected: !ok,
        note: typeof r === 'object' ? JSON.stringify(r).slice(0, 160) : String(r ?? '') });
      return ok ? r : null;
    } catch (e) {
      errors.push({ name, turn, error: e.stack || e.message });
      scenarios.push({ name, turn, ok: false, rejected: false, note: `THREW ${e.message}` });
      return null;
    }
  }

  // 举义（玩家入场）
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const oath = chooseOath(state, cfg, ctx, { lord: lords[0].id, city: lords[0].cities[0].id });
  if (!oath.ok) throw new Error(`audit: 举义失败 ${JSON.stringify(oath)}`);

  const st = state.strategy;
  const series = [];
  let guard = 0;
  let phase = 'main';                // main → conquest → post
  let targetFaction = '';
  let conqueror = '';
  const conf = factionConfFor(state);

  /* 灭国阶段：包装 brainRunner——征服者每旬只发一条真实「出征」指令（其余势力仍走 localBrain）。
     目标城守军调至 1 并补足征服者粮饷（GM 构造，走 applyOrders 的真实结算路径）。 */
  function enableConquest() {
    const counts = factionCityCounts(state);
    const alive = conf.factions.filter((f) => (counts[f.id] || 0) > 0 && f.id !== 'player');
    const sorted = alive.slice().sort((a, b) => (counts[a.id] || 0) - (counts[b.id] || 0));
    const victim = sorted[0];
    if (!victim) return false;
    // 选与 victim 接壤、城最多的势力做征服者
    const victimCityIds = Object.keys(st.cities).filter((id) => st.cities[id].owner === victim.id).map(Number);
    const cands = alive.filter((f) => f.id !== victim.id)
      .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
    if (!cands.length || !victimCityIds.length) return false;
    targetFaction = victim.id;
    conqueror = cands[0].id;
    for (const id of victimCityIds) st.cities[id].troops = 1;
    const res = st.resources[conqueror] || (st.resources[conqueror] = { gold: 0, grain: 0 });
    res.gold = Math.max(res.gold || 0, 200000);
    state.brainRunner = (faction, snapshot) => {
      if (faction.id !== conqueror) return { strategy_orders: [] };
      const mine = Object.keys(st.cities).filter((id) => st.cities[id].owner === conqueror).map(Number);
      const foes = Object.keys(st.cities).filter((id) => st.cities[id].owner === targetFaction).map(Number);
      if (!mine.length || !foes.length) return { strategy_orders: [] };
      // 只发真实接壤且兵力足的一对；无接壤对时交回空单（由下方接手逻辑换征服者）
      let pair = null;
      for (const from of mine) {
        for (const to of foes) {
          if (canMarchBetween(from, to).ok && st.cities[from].troops > 900) { pair = { from, to }; break; }
        }
        if (pair) break;
      }
      if (!pair) return { strategy_orders: [] };
      st.resources[conqueror].gold = Math.max(st.resources[conqueror].gold || 0, 200000);
      for (const id of Object.keys(st.cityEcon || {})) {
        if (st.cities[id]?.owner === conqueror) st.cityEcon[id].store = Math.max(st.cityEcon[id].store || 0, 200000);
      }
      return { strategy_orders: [{ type: '出征', target: pair.to, expect: '', params: { fromCity: pair.from, troops: 1500, reserve: 0 } }] };
    };
    // strategyTick 用 brainRunner 整段替换 localBrain；非目标势力显式回落到 localBrain。
    const forced = state.brainRunner;
    state.brainRunner = (faction, snapshot) => (faction.id === conqueror
      ? forced(faction, snapshot)
      : localBrain(faction, snapshot, state));
    conquest.events.push({ turn: st.turn, event: '灭国阶段启动', victim: victim.name, conqueror: factionConfFor(state).factions.find((f) => f.id === conqueror)?.name || conqueror, cities: victimCityIds.length });
    return true;
  }

  const dayLoop = (turnNo) => {
    const before = st.turn;
    state.clock.day = Math.max(1, Math.floor(Number(state.clock.day) || 1)) + 1;
    strategyResolveMarches(state, cfg, ctx);
    cityEconTick(state, cfg, ctx);
    strategyTick(state, cfg, ctx);
    return st.turn > before;
  };

  const scenarioAt = (turnNo) => {
    const ownIds = Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player').map(Number);
    const others = Object.keys(st.cities).filter((id) => st.cities[id].owner !== 'player').map(Number);
    const home0 = ownIds[0];
    // 出征三元组：己方城（须驻有带兵队伍）+ 与之接壤的敌城 + 该城队伍
    const launch = (() => {
      for (const h of ownIds) {
        const a = (state.armys || []).find((x) => Number(x.cityId) === Number(h)
          && (x.soldiers || []).some((n) => Number(n) > 0));
        if (!a) continue;
        const t = others.find((id) => (marchableFrom(h) || []).map(Number).includes(id));
        if (t) return { from: h, to: t, army: a };
      }
      return null;
    })();
    const home = launch?.from ?? home0;
    const army = launch?.army ?? (state.armys || [])[0];
    const target = launch?.to ?? others[0];
    switch (turnNo % 16) {
      case 1: attempt('内政·开垦', turnNo, () => strategyInvest(state, cfg, ctx, { cityId: home, kind: 'agri' })); break;
      case 2: attempt('内政·运输粮', turnNo, () => strategyTransport(state, cfg, ctx, { cityId: home, grain: 100, fromCityId: ownIds[1] || home })); break;
      case 3: attempt('内政·委任', turnNo, () => strategyAppoint(state, cfg, ctx, { cityId: home, goal: 'develop' })); break;
      case 4: attempt('内政·赏赐', turnNo, () => rewardGeneral(state, cfg, ctx, { generalId: state.generals?.[0]?.id || 0, amount: 100 })); break;
      case 5: attempt('内政·编队', turnNo, () => strategyFormup(state, cfg, ctx, {
        armyId: army?.id || 0, generals: army?.generals || [0, 0, 0], soldiers: army?.soldiers || [0, 0, 0],
      })); break;
      case 6: attempt('征战·战前推演', turnNo, () => ({ ok: !!previewAssault(state, cfg, { cityId: target, fromCityId: home, armyId: army?.id || 0, frac: 1 }) })); break;
      case 7: attempt('征战·出征', turnNo, () => strategyAttack(state, cfg, ctx, { cityId: target, armyId: army?.id || 0, frac: 0.8, fromCityId: home, confirmBattle: true })); break;
      case 8: break; // 遭遇确认改到每旬处理（下方）
      case 9: attempt('征战·召回行军', turnNo, () => { const m = (st.marches || [])[0]; return m ? strategyRecallMarch(state, cfg, ctx, { marchId: m.id }) : { ok: true, note: 'no-march' }; }); break;
      case 10: attempt('征战·队列重排', turnNo, () => strategyReorderMarch(state, ctx, { marchId: (st.marches || [])[0]?.id || 0, dir: 1 })); break;
      case 11: { const f = factionConfFor(state).factions.find(x => x.id !== 'player'); attempt('外交·赠礼', turnNo, () => diplomacyAct(state, cfg, ctx, { action: 'gift', faction: f?.id || '', target: '', gold: 100 })); break; }
      case 12: { const fs = factionConfFor(state).factions.filter(x => x.id !== 'player'); attempt('外交·离间', turnNo, () => diplomacyAct(state, cfg, ctx, { action: 'sow', faction: fs[0]?.id || '', target: fs[1]?.id || '', gold: 0 })); break; }
      case 13: attempt('失败态·卖粮', turnNo, () => sellGrain(state, ctx, { grain: 50 })); break;
      case 14: attempt('失败态·紧急征兵', turnNo, () => emergencyConscript(state, ctx, { cityId: home, count: 100, mercenary: false })); break;
      case 15: attempt('结局评估', turnNo, () => ({ ok: !!evaluateEnding(state) })); break;
      default: break;
    }
    // 每旬都处理「遭遇」待决（P11 出征六门）：多数确认开战、每 3 次临阵撤军；攻克后消化新城
    for (const m of [...(st.marches || [])].filter((x) => x.pendingBattle)) {
      const confirmed = scenarios.filter((x) => x.name === '征战·确认开战').length;
      const retreat = confirmed > 0 && confirmed % 3 === 0;
      attempt(retreat ? '征战·临阵撤军' : '征战·确认开战', turnNo, () => (retreat
        ? strategyRetreatBattle(state, cfg, ctx, { marchId: m.id })
        : strategyConfirmBattle(state, cfg, ctx, { marchId: m.id })));
    }
    for (const c of [...(st.digest || [])]) {
      attempt('征战·消化新城', turnNo, () => strategyDigestDone(state, { cityId: Number(c.cityId ?? c) }));
    }
    // 每旬都消费事件抉择（事件卡必答，不消费会堆积）
    for (const e of [...(st.pendingEvents || [])]) {
      attempt('事件·抉择', turnNo, () => strategyEventChoice(state, cfg, ctx, { id: e.id, choice: e.choices?.[0]?.id || '' }));
    }
  };

  while (guard < (turns + 140) * 40 && series.length < turns + 90) {
    guard += 1;
    const rolled = dayLoop(series.length);
    if (!rolled) continue;
    const turnNo = st.turn;
    const counts = factionCityCounts(state);
    const row = { turn: turnNo, day: Math.floor(Number(state.clock.day) || 1), phase, counts: { ...counts },
      player: { cities: counts.player || 0, gold: Math.floor(state.roleRes?.gold || 0), grain: Math.floor(state.roleRes?.grain || 0) },
      events: (st.pendingEvents || []).length, marches: (st.marches || []).length,
      chat: logs.length, errors: errors.length };
    series.push(row);
    invariants.push(...checkInvariants(state, cfg, `T${turnNo}`));

    if (phase === 'main') {
      scenarioAt(turnNo);
      if (series.length >= turns) {
        // 60 旬主模拟结束 → 进入灭国阶段
        const ok = enableConquest();
        phase = ok ? 'conquest' : 'post';
        if (ok) conquest.events.push({ turn: turnNo, event: `目标 ${targetFaction} 城数 ${counts[targetFaction] || 0}，征服者 ${conqueror}` });
      }
    } else if (phase === 'conquest') {
      // 无接壤对时由接壤势力接手（真实战争地理约束，不是硬改归属）
      const foes = Object.keys(st.cities).filter((id) => st.cities[id].owner === targetFaction).map(Number);
      const reachable = (fid) => Object.keys(st.cities).some((from) => st.cities[from].owner === fid
        && foes.some((to) => canMarchBetween(Number(from), to).ok));
      if (foes.length && !reachable(conqueror)) {
        const alt = Object.keys(counts).find((id) => id !== targetFaction && id !== 'player'
          && conf.factions.some((f) => f.id === id) && reachable(id));
        if (alt) {
          conqueror = alt;
          conquest.events.push({ turn: turnNo, event: `征服者接手：${conqueror}（原势力与残城不接壤）` });
        }
      }
      // 保证接手方有兵可派（GM 补给，指令仍走 applyOrders 真实结算）
      for (const id of Object.keys(st.cities)) {
        if (st.cities[id].owner === conqueror && st.cities[id].troops < 3000) st.cities[id].troops = 3000;
      }
      const left = counts[targetFaction] || 0;
      if (left === 0) {
        conquest.eliminated = targetFaction;
        conquest.atTurn = turnNo;
        conquest.events.push({ turn: turnNo, event: `${targetFaction} 城池归零，灭国达成`, conqueror });
        // 存档回读一致性
        attempt('存档·JSON 回读', turnNo, () => {
          const cloned = normalizeWorld(JSON.parse(JSON.stringify(state)), cfg);
          const a = factionCityCounts(state), b = factionCityCounts(cloned);
          const same = JSON.stringify(a) === JSON.stringify(b) && cloned.strategy.turn === st.turn;
          return { ok: same, note: same ? '城池归属/旬历一致' : `不一致 ${JSON.stringify(a)} vs ${JSON.stringify(b)}` };
        });
        phase = 'post';
      } else if (turnNo - conquest.events[0].turn > 80) {
        conquest.events.push({ turn: turnNo, event: `灭国超时，目标仍余 ${left} 城（视为未闭环）` });
        phase = 'post';
      }
    } else {
      conquest.postTurns += 1;
      if (conquest.postTurns >= 10) break;
    }
  }

  /* 补充动作批次：主循环按旬轮换未覆盖到的动作，在这里集中走一遍真实入口。 */
  const T = st.turn;
  attempt('内政·撤销施政', T, () => cancelInvest(state, ctx, { taskId: String((st.interiorTasks || [])[0]?.id || '') }));
  attempt('内政·撤销委任', T, () => strategyCancelAppointment(state, ctx, { apptId: String((st.appointments || [])[0]?.id || '') }));
  attempt('征战·清剿来犯', T, () => clearThreat(state, cfg, ctx, { garrisonId: (state.garrisons || [])[0]?.id || 0, armyId: (state.armys || [])[0]?.id || 0 }));
  attempt('征战·消化新城', T, () => strategyDigestDone(state, { cityId: Object.keys(st.cities)[0] }));
  attempt('俘虏·招降', T, () => recruitCaptive(state, cfg, ctx, { idx: 0 }));
  attempt('失败态·裁军换金', T, () => disarmForGold(state, ctx, { armyId: (state.armys || [])[0]?.id || 0, count: 10 }));
  attempt('失败态·迁都', T, () => relocateCapital(state, ctx, { cityId: Object.keys(st.cities).find((id) => st.cities[id].owner === 'player') || 0 }));
  attempt('宿命·组合视图', T, () => ({ ok: !!strategyFateView(state, cfg) }));
  attempt('事件·旬 tick', T, () => { strategyEventTick(state); return { ok: true }; });
  attempt('视图·战略聚合', T, () => ({ ok: !!strategyViewState(state, cfg) }));
  const realFaction = conf.factions.find((f) => f.id !== 'player')?.id || 'yanzhou';
  const realTarget = conf.factions.filter((f) => f.id !== 'player' && f.id !== realFaction)[0]?.id || 'liubei';
  for (const act of ['requestAttack', 'truce', 'marriage', 'surrender']) {
    attempt(`外交·${act}`, T, () => diplomacyAct(state, cfg, ctx, { action: act, faction: realFaction, target: realTarget, gold: 100 }));
  }
  /* 六剧本切换会重建归属，用独立世界跑，避免污染灭国链。 */
  for (const sid of ['huangjin-184', 'taodong-190', 'guandu-200', 'chibi-208', 'yiling-221', 'sanfen-229']) {
    attempt(`剧本·${sid}`, T, () => {
      const w = normalizeWorld(createWorld(cfg), cfg);
      w.seed = seed;
      ensureStrategy(w);
      const r = strategySetScenario(w, sid);
      const p = checkInvariants(w, cfg, sid);
      return { ok: r?.ok !== false && p.length === 0, note: p.length ? p.join(';') : JSON.stringify(r).slice(0, 100) };
    });
  }

  console.error = origErr;

  /* 日志扫描：ctx.push 的 chat 消息 + console.error + 场景异常 */
  const chatLines = logs.filter((x) => x.t === 'chat.push').map((x) => String(x.m?.msg || ''));
  const suspicious = chatLines.filter((l) => /undefined|NaN|Infinity|\[object Object\]|error|Error|报错|异常/.test(l));
  const report = {
    generatedAt: new Date().toISOString(), seed, turns,
    pace: '真实 30 分钟 = 30 游戏日 = 3 旬；按 ×20 加速等价 600 日 = 60 旬（与 sim-60turns 同口径）',
    deterministic: null,
    summary: {
      turnsRun: series.length, phases: [...new Set(series.map((s) => s.phase))],
      scenarios: scenarios.length, scenarioFailed: scenarios.filter((s) => !s.ok).length,
      scenarioRejected: scenarios.filter((s) => s.rejected).length,
      scenarioErrors: scenarios.filter((s) => !s.ok && !s.rejected).length,
      errors: errors.length, invariants: invariants.length,
      suspiciousLogs: suspicious.length, consoleErrors: consoleErrors.length,
      chatLines: chatLines.length,
    },
    conquest, series, scenarios, errors, invariants: invariants.slice(0, 60),
    suspiciousLogs: suspicious.slice(0, 30), consoleErrors: consoleErrors.slice(0, 30),
    balanceNote: '武将平衡审查见 tools/hero-balance.mjs → reports/hero-balance.json',
  };
  return report;
}

/* ---------------------------------------------------------------- main */
function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
  const seed = opt('seed', 20261114), turns = opt('turns', 60);
  // 注入 localBrain 引用（runAudit 内 enableConquest 的回落用顶层导入）
  const a = runAudit({ seed, turns });
  const b = runAudit({ seed, turns });
  const hash = (r) => createHash('md5').update(JSON.stringify({ series: r.series, scenarios: r.scenarios, conquest: r.conquest })).digest('hex');
  a.deterministic = hash(a) === hash(b);
  a.summary.deterministic = a.deterministic;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(a, null, 2) + '\n');
  console.log(`[system-audit] 旬数 ${a.summary.turnsRun} / 场景 ${a.summary.scenarios}（失败 ${a.summary.scenarioFailed}）`);
  console.log(`[system-audit] 异常 ${a.summary.errors} / 不变量 ${a.summary.invariants} / 可疑日志 ${a.summary.suspiciousLogs} / console.error ${a.summary.consoleErrors}`);
  console.log(`[system-audit] 灭国: ${a.conquest.eliminated || '未达成'} @T${a.conquest.atTurn}，灭国后 ${a.conquest.postTurns} 旬`);
  console.log(`[system-audit] 确定性: ${a.deterministic ? '通过' : '失败'}`);
  console.log(`[system-audit] 报告: ${OUT}`);
  if (a.summary.errors || a.summary.invariants || !a.deterministic) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('system-audit.mjs')) main();
