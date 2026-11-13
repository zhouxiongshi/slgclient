/**
 * 战略层（东汉十三州·城池模型图）的世界状态与执行层。
 *
 * 职责边界沿用 slg-ai 的契约：
 *   - 决策脑只产出 slg-ai-orders-v1 指令单，绝不直接改世界；
 *   - 本文件 applyOrders 是唯一执行口，所有改动可审计；
 *   - NPC 诸侯打玩家的城 → 换算成本地地图的一支来犯军（复用既有战报）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBuild, makeGeneral, makeFacilityList, nextId, mainCity } from '../world.js';
import { rngFor } from './strategy-rng.js';
/* ★ M2-3 全局参数表（GDD §9.2）：零依赖叶子，所有新数值一律从这里读 */
import { knobGet } from './knobs.js';
/* ★ M2-3 失败态与结局（GDD §3.4/§3.5）：零依赖叶子 */
import { failstates, evaluateEnding, makeStandInGeneral } from './failstate.js';
import { beginInteriorTask, cancelInteriorTask, interiorTaskView, roadEdgeKey } from './interior-task.js';
/* ★ U20 粮道（supply 只依赖 march，不反向 import 本文件） */
import { supplyMap, marchSupplyEstimate } from './supply.js';
/* 修 U08：招降成功率收敛到唯一公式，面板图鉴/预览/实际掷骰同源 */
import { captiveRecruitRate, captiveRateParts, CAPTIVE_COST } from './captive-rules.js';
import { canMarchBetween, marchableNeighbors, marchGraph } from './march.js';
/* ★ 验收 #22：地图标注分级（哪座城算要城只有这一处口径） */
import { cityLabelRank, labelPolicy } from './map-lod.js';
import { resolveBattle, battleSeedFor } from '../battle.js';
import { planCampaign, commitBrainGoal, noteBattleOutcome, noteCityLost } from './strategy-brain.js';
import { quoteMarch, openMonth, closeMonth, noteMove, noteCity, booksOf } from './strategy-log.js';
import { onTileCleared, chapterRules, noticeRecruit } from './campaign.js';
import { dayFraction, ensureTavern } from './tavern.js';
import { recordRes } from './economy.js';
import {
  ensureCityEcon, consumeMarchGrain, deliverGrain, cityEconTick, cityName,
  cityYield, armsApt, armsCounter, ARMS_NAMES, devLevel, cityDevTick,
} from './city-econ.js';
import { SKILLS, LEVEL_COUNT, skillById } from '../skills.js';
import { oathOf, oathPending, oathFactionOf, factionTraitOf, protagonistStat } from './oath.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAP_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json');
const FACTIONS_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'factions.json');

/** 战略层存档版本：2 起守军按城池等级分档（旧档读入时一次性重算）。 */
const STRATEGY_VERSION = 2;

let staticMap = null;
let factionsConf = null;

export function strategyMap() {
  if (!staticMap) staticMap = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  return staticMap;
}

export function factionConf() {
  if (!factionsConf) factionsConf = JSON.parse(readFileSync(FACTIONS_PATH, 'utf8'));
  return factionsConf;
}

export function strategyTurnDays() {
  return factionConf().turnDays ?? 10;
}

/**
 * 城池守军。旧公式 3000 + 兵源×20 让每座城都有 4000~5000 守军，
 * 玩家开头 800 兵怎么打都是全军覆没（试玩 P0-3 的死循环根因之一）。
 * 现在按城池等级分三档：小城是玩家第一场能赢的仗，州治仍然要攒够兵力。
 */
export function garrisonOf(c) {
  const lvl = Math.max(1, Math.min(3, Number(c.level) || 1));
  const src = Number(c.attrs?.兵源 ?? 50);
  const def = Number(c.attrs?.城防 ?? 50);
  const base = lvl >= 3 ? 2200 : lvl === 2 ? 1100 : 480;
  const perSrc = lvl >= 3 ? 12 : lvl === 2 ? 7 : 5;
  const perDef = lvl >= 3 ? 6 : 2;
  return Math.round(base + src * perSrc + def * perDef);
}

/** 旧档守军重算：只做一次，之后由攻城/易主逻辑维护。 */
function migrateGarrisons(state) {
  const st = state.strategy;
  if ((st.version ?? 1) >= STRATEGY_VERSION) return;
  for (const c of strategyMap().cities) {
    const row = st.cities[c.id];
    if (!row) continue;
    row.troops = garrisonOf(c);
  }
  st.version = STRATEGY_VERSION;
}

export function ensureStrategy(state) {
  const map = strategyMap();
  const conf = factionConf();
  if (state.strategy?.cities) {
    const st = state.strategy;
    // 地图换版迁移：删掉新版图中不存在的城，补上新增的城
    const live = new Set(map.cities.map((c) => c.id));
    for (const id of Object.keys(st.cities)) {
      if (!live.has(Number(id))) delete st.cities[id];
    }
    for (const c of map.cities) {
      if (!st.cities[c.id]) {
        st.cities[c.id] = {
          owner: conf.factions.some((f) => f.id === c.provinceId) ? c.provinceId : conf.neutral.id,
          troops: garrisonOf(c),
          grain: 2000 + Math.round((c.attrs?.农业 ?? 50) * 20),
          defense: Math.min(0.9, 0.25 + (c.attrs?.城防 ?? 50) / 200),
        };
      }
    }
    // 本城指向已删除的城（旧版城被移除）→ 重绑到配置的默认本城
    if (!st.playerCity || !live.has(st.playerCity)) {
      st.playerCity = 0;
      bindPlayerHome(state);
    }
    migrateGarrisons(state);
    if (!st.memory) st.memory = {};
    if (!st.chronicle) st.chronicle = [];
    if (!st.cityLogs) st.cityLogs = {};
    // ★ P7：旧档队伍没有 cityId（那时只有本城概念），一律并到本城
    for (const a of state.armys || []) if (!a.cityId) a.cityId = st.playerCity || 0;
    return st;
  }
  const factionByState = new Map(conf.factions.map((f) => [f.id, f]));
  const cities = {};
  for (const c of map.cities) {
    // 初版归属：州有诸侯则全州归他，否则归汉廷
    const owner = factionByState.get(c.provinceId)?.id || conf.neutral.id;
    cities[c.id] = {
      owner,
      troops: garrisonOf(c),
      grain: 2000 + Math.round((c.attrs?.农业 ?? 50) * 20),
      defense: Math.min(0.9, 0.25 + (c.attrs?.城防 ?? 50) / 200),
    };
  }
  state.strategy = {
    version: STRATEGY_VERSION,
    turn: 0,
    lastTurnDay: 0,
    events: [],
    cities,
    relations: {},
    memory: {},
    chronicle: [],
    cityLogs: {},
    resources: Object.fromEntries(conf.factions.map((f) => [f.id, { gold: 8000, grain: 12000 }])),
  };
  bindPlayerHome(state);
  return state.strategy;
}

/**
 * 玩家本城：factions.json 的 playerHome（按城名解析）。
 * ★ P4-①：新档未举义时只把 playerCity 锚在默认城上（给地图一个观察点），
 *   不夺城——玩家的地盘等他择主定都之后由 chooseOath 划拨。
 *   旧档（视为已举义）维持老行为：默认城归属改玩家。
 */
export function bindPlayerHome(state) {
  const st = state.strategy;
  const conf = factionConf();
  const homeName = conf.playerHome || '相';
  const home = strategyMap().cities.find((c) => c.name === homeName)
    || strategyMap().cities[0];
  if (!home) return null;
  st.playerCity = home.id;
  if (oathPending(state)) return home;
  st.cities[home.id].owner = 'player';
  return home;
}

/* -------------------------------------------------------------------------- */
/* 开局举义（P4-①）：择主 8 诸侯卡 + 择都 3 候选城                             */
/* -------------------------------------------------------------------------- */

/**
 * 某诸侯名下的候选都城三型（对应三战出生地逻辑）：
 *   沃野型 = 农业+商业最高；雄关型 = 城防最高；僻壤型 = 邻接敌军兵力最少。
 * 三型取不同的城；该诸侯城太少时允许不满 3 个。
 */
function candidateCities(state, f) {
  const st = state.strategy;
  const rows = strategyMap().cities
    .filter((c) => st.cities[c.id]?.owner === f.id)
    .map((c) => {
      let enemy = 0;
      for (const nid of neighborsOf(c.id)) {
        const row = st.cities[nid];
        if (row && row.owner !== f.id && row.owner !== 'player') enemy += row.troops || 0;
      }
      return {
        id: c.id, name: c.name, x: c.x, y: c.y, level: c.level || 1,
        res: (c.attrs?.农业 ?? 0) + (c.attrs?.商业 ?? 0),
        fort: c.attrs?.城防 ?? 0, enemy,
      };
    });
  const pick = (key, dir, taken) => {
    const sorted = [...rows].sort((a, b) => (dir === 'max' ? b[key] - a[key] : a[key] - b[key]));
    return sorted.find((r) => !taken.has(r.id)) || null;
  };
  const out = [];
  const taken = new Set();
  const add = (r, type, note) => {
    if (!r || taken.has(r.id)) return;
    taken.add(r.id);
    out.push({ id: r.id, name: r.name, x: r.x, y: r.y, level: r.level, type, note });
  };
  add(pick('res', 'max', taken), '沃野型', '田亩商埠俱全，钱粮自足');
  add(pick('fort', 'max', taken), '雄关型', '城高池深，据守从容');
  add(pick('enemy', 'min', taken), '僻壤型', '远隔强敌，积蓄待时');
  return out;
}

/** 举义页全量选项：8 张诸侯卡（势力色 + 特技 + 初始武将团 + 3 候选都）。 */
export function oathOptions(state) {
  const conf = factionConf();
  ensureStrategy(state);
  return {
    done: !oathPending(state),
    lords: conf.factions.map((f) => ({
      id: f.id, name: f.name, color: f.color, home: f.home,
      blurb: f.blurb || '',
      trait: { name: f.trait?.name || '', desc: f.trait?.desc || '' },
      generals: (f.startGenerals || []).slice(0, 3),
      cities: candidateCities(state, f),
    })),
  };
}

/**
 * 择主定都：选中的诸侯名下城池全部易帜归 player，都城即玩家本城，
 * 初始武将团 3 员入营，势力特技自此生效（oath.js 提供数值面）。
 */
export function chooseOath(state, cfg, ctx = {}, { lord, city } = {}) {
  if (!oathPending(state)) return { ok: false, code: 1, reason: 'already_done' };
  const conf = factionConf();
  const f = conf.factions.find((x) => x.id === lord);
  if (!f) return { ok: false, code: 2, reason: 'no_faction' };
  const st = ensureStrategy(state);
  const map = strategyMap();
  const cid = Number(city);
  const target = map.cities.find((c) => c.id === cid);
  const tstate = st.cities[cid];
  if (!target || !tstate || tstate.owner !== f.id) return { ok: false, code: 3, reason: 'bad_city' };

  let transferred = 0;
  for (const row of Object.values(st.cities)) {
    if (row.owner === f.id) { row.owner = 'player'; transferred += 1; }
  }
  st.playerCity = cid;
  /* ★ 修 bug-6/21：举义时给拿到的每座城各建一套设施（键 s<战略城id>），
     分城从此有设施可升；本地主城那份键仍是数字 id，两套编号互不覆盖。 */
  state.facilities = state.facilities || {};
  for (const [id, row] of Object.entries(st.cities || {})) {
    if (row.owner !== 'player') continue;
    const key = `s${id}`;
    if (!Array.isArray(state.facilities[key])) state.facilities[key] = makeFacilityList(cfg);
  }
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  state.oath = { done: true, lord: f.id, city: cid, day };

  // 初始武将团：按名字从配置解析（找不到的跳过），进主城、自带战法
  const byName = new Map();
  for (const gg of cfg?.generalByCfg?.values?.() || []) {
    if (gg?.name && !byName.has(gg.name)) byName.set(gg.name, gg.cfgId);
  }
  const ownedCfg = new Set((state.generals || []).map((g) => Number(g.cfgId)));
  const homeCity = state.citys?.[0]?.id || 1;
  const added = [];
  const newGenerals = [];
  for (const name of f.startGenerals || []) {
    const cfgId = Number(byName.get(name));
    if (!cfgId || ownedCfg.has(cfgId)) continue;
    const g = makeGeneral(cfg, nextId(state, 'generalId'), cfgId, homeCity, 5);
    state.generals.push(g);
    newGenerals.push(g);
    ownedCfg.add(cfgId);
    added.push(name);
    noticeRecruit(state, ctx, name);
  }
  // ★ P6 定都即迁营：玩家全部队伍与帐下武将移到新都，驻城武将/城内操作不再指向旧城
  for (const a of state.armys || []) {
    if (!a.marchId) a.cityId = cid;
  }
  for (const g of state.generals || []) g.cityId = cid;
  // 技能登记表增量更新（主角自带战法 19001 不在技能库配置里，不能全量重建）
  const reg = new Map((state.skills || []).map((s) => [Number(s.cfgId), s]));
  for (const g of newGenerals) {
    const s = g.skills?.[0];
    if (!s || !skillById(s.cfgId)) continue;
    const row = reg.get(Number(s.cfgId)) || { id: s.cfgId, cfgId: s.cfgId, generals: [] };
    if (!row.generals.includes(g.id)) row.generals.push(g.id);
    reg.set(Number(s.cfgId), row);
  }
  state.skills = [...reg.values()];
  if (state.tavern?.people) {
    // 同名武将在 general.json 里可能有多条 cfgId，按名字同步才不会漏
    const gotNames = new Set(added);
    for (const p of state.tavern.people) if (gotNames.has(p.name)) p.recruited = true;
  }

  recordEvent(state, `第 ${day} 日，主公举义于${target.name}，承${f.name}之业，${transferred} 城易帜，${added.length} 员上将入营。`);
  ctx.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【天下】${f.name}举义！定都${target.name}，麾下众将誓师北望。`,
    time: Date.now(),
  });
  return { ok: true, lord: f.id, lordName: f.name, city: target.name, cities: transferred, generals: added };
}

export function neighborsOf(cityId) {
  const set = new Set();
  for (const r of strategyMap().routes) {
    if (r.from === cityId) set.add(r.to);
    if (r.to === cityId) set.add(r.from);
  }
  return [...set];
}

/**
 * 可出征的邻城：同一条行军段直连，且关隘未封锁。
 * 换图后同一条路线会在关隘处拆段，隔着关隘的城不再算直邻。
 * ★ 修 bug-4：传 state 时过滤掉己方城 —— 旧实现把自家城也当「可出征目标」，
 *   城池概览会摆出「自弘农出兵攻打长安（我军）」这种必然失败的按钮。
 */
export function marchableFrom(cityId, state = null) {
  const graph = marchGraph();
  const all = strategyMap().cities.map((c) => c.id);
  const list = graph ? marchableNeighbors(cityId, all) : neighborsOf(cityId);
  if (!state) return list;
  const st = state.strategy;
  return list.filter((id) => Number(id) !== Number(cityId) && st?.cities?.[id]?.owner !== 'player');
}

export function strategySnapshot(state, factionId) {
  const map = strategyMap();
  const st = ensureStrategy(state);
  const mine = [];
  const seen = new Set();
  for (const c of map.cities) {
    if (st.cities[c.id]?.owner === factionId) mine.push(c.id);
  }
  const neighbors = new Map();
  for (const r of map.routes) {
    if (!neighbors.has(r.from)) neighbors.set(r.from, new Set());
    if (!neighbors.has(r.to)) neighbors.set(r.to, new Set());
    neighbors.get(r.from).add(r.to);
    neighbors.get(r.to).add(r.from);
  }
  const troops = mine.reduce((s, id) => s + (st.cities[id]?.troops || 0), 0);
  const res = st.resources[factionId] || { gold: 0, grain: 0 };
  const enemies = new Set();
  for (const [pair, rel] of Object.entries(st.relations || {})) {
    const [a, b] = pair.split('|');
    if (rel !== 'ally' && rel !== 'neutral') {
      if (a === factionId) enemies.add(b);
      if (b === factionId) enemies.add(a);
    }
  }
  const month = Math.max(1, st.turn || 1);
  const season = ['春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬', '冬', '冬'][(month - 1) % 12];
  let borderThreat = 0;
  for (const id of mine) {
    for (const nid of marchableFrom(id)) {
      const row = st.cities[nid];
      if (row && row.owner !== factionId) borderThreat += row.troops || 0;
    }
  }
  const lords = Object.fromEntries(factionConf().factions.map((f) => [f.id, f.name]));
  lords[factionConf().neutral.id] = factionConf().neutral.name;
  const facts = (st.events || []).slice(-8).map((e) => e.text).filter(Boolean);
  return {
    turn: st.turn,
    season,
    seed: state.seed ?? 20261110,
    faction: factionId,
    lords,
    own: {
      gold: res.gold, grain: res.grain, wood: 0, iron: 0,
      troops, cities: mine.length, mines: 0,
      heroes: [], front_pressure: troops > 0 ? Math.round((borderThreat / troops) * 100) / 100 : 0,
    },
    cities: map.cities.map((c) => ({
      id: String(c.id), name: c.name, province: c.provinceId || '',
      is_capital: !!c.provinceCapital, owner: st.cities[c.id]?.owner || 'han',
      troops: st.cities[c.id]?.troops || 0,
      defense: st.cities[c.id]?.defense || 0.4,
      arms: c.arms || '',
      confidence: 1,
    })),
    mines: [],
    neighbors: Object.fromEntries([...neighbors.entries()].map(([k, v]) => [String(k), [...v].map(String)])),
    known_facts: facts,
    visible_events: facts,
    movements: st.movements || [],
    relations: Object.fromEntries(factionConf().factions
      .filter((f) => f.id !== factionId)
      .map((f) => [f.id, enemies.has(f.id) ? 'enemy' : (st.relations?.[`${factionId}|${f.id}`] || 'neutral')])),
    threat: {},
  };
}

/** 月度回合：每个有脑的诸侯决策一次并执行。 */
export function strategyTick(state, cfg, ctx, now = Date.now()) {
  const conf = factionConf();
  const st = ensureStrategy(state);
  /* ★ M2-3：旬长走参数表（GDD §9.2 turnDays），存档 knobs 可覆盖 */
  const turnDays = knobGet(state, 'turnDays') ?? conf.turnDays ?? 10;
  if (state.clock.day - st.lastTurnDay < turnDays) return null;
  st.lastTurnDay = state.clock.day;
  st.turn += 1;
  openMonth(state);
  // ★ P2/P3 城市经营：旬灾害（蝗/瘟/丰收）+ 旬忠诚/俸禄/叛逃 + 30日人口增长
  cityEconTick(state, cfg, ctx);
  // ★ P6 俘虏：每旬思归/越狱演变
  captivesTick(state, ctx);
  // ★ P7 出仕：在野贤才按名声主动来投
  defectTick(state, cfg, ctx);

  const results = [];
  const mapTick = strategyMap();
  for (const f of conf.factions) {
    // ★ P4-①：被玩家举义兼并的诸侯（城池全部易帜）不再有脑活动，
    //   否则空壳势力月月决策、日志全是空转
    const hasLand = mapTick.cities.some((c) => st.cities[c.id]?.owner === f.id);
    if (!hasLand) continue;
    const tax = accrueFactionGrain(state, f.id);
    noteMove(state, {
      kind: '田赋', faction: f.id, who: f.name,
      grain: tax.grain, gold: tax.gold,
    });
    const snapshot = strategySnapshot(state, f.id);
    const sheet = state.brainRunner
      ? state.brainRunner(f, snapshot)
      : localBrain(f, snapshot, state);
    if (sheet?.goal) {
      commitBrainGoal(state, f.id, {
        type: sheet.goal.type,
        target: sheet.goal.target,
        lockedUntil: sheet.goal.locked_until,
        reason: Array.isArray(sheet.goal.reason) ? sheet.goal.reason[0] : sheet.goal.reason,
        from: sheet.goal.from || '',
        fromName: sheet.goal.fromName || '',
        targetName: sheet.goal.targetName || '',
      });
    }
    const applied = applyOrders(state, cfg, ctx, f, sheet);
    const res = st.resources[f.id];
    const mine = (st.draft?.moves || []).filter((m) => m.faction === f.id);
    const last = mine[mine.length - 1];
    if (last && res) { last.grainEnd = res.grain; last.goldEnd = res.gold; }
    results.push({ faction: f.id, sheet, orders: sheet.strategy_orders?.length || 0, ...applied });
  }
  closeMonth(state);
  return { turn: st.turn, results };
}

/* ---------------------------------------------------------------- 决策脑
 * 战役规划在 strategy-brain.js。这里只留同名入口，指令单协议不变。
 * 外部若注入 state.brainRunner，仍可整段替换。
 */
export function localBrain(faction, snapshot, state) {
  const conf = factionConf().factions.find((f) => f.id === faction.id) || faction;
  return planCampaign(conf, snapshot, state || {});
}

/* ---------------------------------------------------------------- 双账本
 * GDD §5.2 M2「切断写入」：田赋粮按城写入 cityEcon.store（粮留城），金全额上缴国库。
 * resources[faction].grain 降级为**只读汇总**（= 己方城库之和），
 * 唯一写入口是 refreshGrainSummary；NPC 支出只准走 spendFactionGrain / creditFactionGrain。
 * 玩家侧 roleRes.grain 有自己的日产体系，属 M3 迁移范围，本批不动。
 */
export function refreshGrainSummary(state, factionId) {
  const st = state.strategy;
  const res = st.resources[factionId];
  if (!res) return 0;
  let sum = 0;
  for (const [id, row] of Object.entries(st.cities)) {
    if (row.owner !== factionId) continue;
    sum += Math.max(0, Math.floor(Number(st.cityEcon?.[id]?.store) || 0));
  }
  res.grain = sum;
  return sum;
}

/** NPC 粮支出唯一口：从城库扣（优先 preferCity，跨城按存粮补足）。
 *  扣完刷新只读汇总。返回 { ok, spent:[{cityId,grain}], shortage }。 */
export function spendFactionGrain(state, factionId, amount, preferCityId = 0) {
  const st = state.strategy;
  ensureCityEcon(state);
  const prefer = Number(preferCityId) || 0;
  const own = Object.keys(st.cities)
    .filter((id) => st.cities[id].owner === factionId)
    .map((id) => ({ id: Number(id), store: Math.max(0, Math.floor(Number(st.cityEcon[id]?.store) || 0)) }))
    .sort((a, b) => (a.id === prefer ? -1 : b.id === prefer ? 1 : b.store - a.store));
  let remain = Math.max(0, Math.floor(Number(amount) || 0));
  const spent = [];
  for (const c of own) {
    if (remain <= 0) break;
    const take = Math.min(c.store, remain);
    if (take > 0) {
      st.cityEcon[c.id].store -= take;
      remain -= take;
      spent.push({ cityId: c.id, grain: take });
    }
  }
  refreshGrainSummary(state, factionId);
  return { ok: remain <= 0, spent, shortage: remain };
}

/** NPC 粮入账唯一口：写入城库（优先 preferCity，满仓 20000 截断），并刷新汇总。 */
export function creditFactionGrain(state, factionId, amount, preferCityId = 0) {
  const st = state.strategy;
  ensureCityEcon(state);
  const prefer = Number(preferCityId) || 0;
  const ids = Object.keys(st.cities).filter((id) => st.cities[id].owner === factionId);
  const target = ids.includes(String(prefer)) ? prefer
    : (ids.map(Number).sort((a, b) => (Number(st.cityEcon[b]?.store) || 0) - (Number(st.cityEcon[a]?.store) || 0))[0] || 0);
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (target && st.cityEcon[target]) {
    st.cityEcon[target].store = Math.min(20000, st.cityEcon[target].store + n);
  }
  refreshGrainSummary(state, factionId);
  return n;
}

/** 每旬按城征赋（双账本：粮留城库、金上缴国库）。
 *  返回 { grain, gold }：grain 是本旬按城**应收**合计（写入城库时满仓截断，应收照记），
 *  全国账 grain 由 refreshGrainSummary 汇总，只读。 */
export function accrueFactionGrain(state, factionId) {
  const st = state.strategy;
  ensureCityEcon(state);
  const res = st.resources[factionId] || (st.resources[factionId] = { gold: 8000, grain: 12000 });
  if (res.gold == null) res.gold = 8000;
  let grain = 0;
  let gold = 0;
  for (const c of strategyMap().cities) {
    if (st.cities[c.id]?.owner !== factionId) continue;
    const g = 140 + Math.round((c.attrs?.农业 ?? 40) * 3);
    const e = st.cityEcon[c.id];
    if (e) e.store = Math.min(20000, e.store + g);   // 粮留城库（GDD §5.2）
    grain += g;
    gold += 60 + Math.round((c.attrs?.商业 ?? 40) * 1.2);
  }
  res.gold += gold;
  refreshGrainSummary(state, factionId);
  return { grain, gold };
}

/* ---------------------------------------------------------------- 执行层 */
/** 天下大事记。保留整局 200 条（旧实现 50 条滚动截断，读档后本局早先的转折全没了）。 */
export function recordEvent(state, text) {
  const st = state.strategy;
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

export function applyOrders(state, cfg, ctx, faction, sheet) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const applied = { moved: [], captured: [], attacked_player: 0 };
  const r = rngFor(state.seed ?? 20261110, st.turn, `apply:${faction.id}`).random;

  const queued = [...(sheet.internal_orders || []), ...(sheet.strategy_orders || [])];
  const diploFirst = queued.filter((o) => o.type === '结盟' || o.type === '议和' || o.type === '背盟');
  const afterDiplo = queued.filter((o) => o.type !== '结盟' && o.type !== '议和' && o.type !== '背盟');

  for (const order of [...diploFirst, ...afterDiplo]) {
    if (order.type === '征兵') {
      const count = Math.max(0, Number(order.params?.count) || 0);
      /* ★ M2-3：征兵成本走参数表（GDD §9.2 conscriptGoldPer） */
      const cost = count * knobGet(state, 'conscriptGoldPer');
      if (count > 0) {
        const own = Object.keys(st.cities).filter((id) => st.cities[id].owner === faction.id);
        const want = order.params?.cityId != null ? String(order.params.cityId) : '';
        const home = (want && st.cities[want]?.owner === faction.id) ? want : own.slice().sort((a, b) => st.cities[a].troops - st.cities[b].troops)[0];
        /* 双账本：征兵粮从城库扣（优先征兵城），全国账只读汇总（GDD §5.2） */
        const spend = spendFactionGrain(state, faction.id, cost, home);
        if (spend.ok && home) {
          st.cities[home].troops += count;
          noteMove(state, {
            kind: '征兵', faction: faction.id, who: faction.name,
            cityId: Number(home), cityName: map.cities.find((c) => String(c.id) === String(home))?.name || '',
            count, grain: cost,
          });
          noteCity(state, home, {
            kind: '征兵',
            text: `${faction.name}于${map.cities.find((c) => String(c.id) === String(home))?.name || '此城'}征兵 ${count}，耗粮 ${cost}，守军增至 ${st.cities[home].troops}。`,
          });
        }
      }
    } else if (order.type === '屯田') {
      /* 双账本：屯田收成入城库（优先指令城），汇总账自动跟随 */
      creditFactionGrain(state, faction.id, 400, order.params?.cityId);
      noteMove(state, { kind: '屯田', faction: faction.id, who: faction.name, grain: -400 });
      if (order.expect) recordEvent(state, `${faction.name}${order.expect}`);
    } else if (order.type === '固守') {
      if (order.expect) recordEvent(state, `${faction.name}${order.expect}`);
      noteMove(state, {
        kind: '固守', faction: faction.id, who: faction.name,
        reason: order.expect || '',
        cityId: Number(order.params?.cityId) || 0,
        cityName: order.params?.cityName || '',
      });
      if (order.params?.cityId) {
        noteCity(state, order.params.cityId, {
          kind: '固守',
          text: `${faction.name}${order.expect || '按兵'}。`,
        });
      }
    } else if (order.type === '出征') {
      const targetId = Number(order.target);
      const target = map.cities.find((c) => c.id === targetId);
      const tstate = st.cities[targetId];
      if (!target || !tstate) continue;
      if (tstate.owner === faction.id) continue;
      if (isAllied(st, faction.id, tstate.owner)) continue;
      const hasFrom = order.params?.fromCity != null && order.params.fromCity !== '';
      let quote = null;
      if (hasFrom) {
        const fromCity = map.cities.find((c) => c.id === Number(order.params.fromCity));
        const purse = st.resources[faction.id] || { gold: 0, grain: 0 };
        quote = quoteMarch(order.params.fromCity, targetId, order.params.troops, fromCity?.arms, purse);
        if (!quote.ok) {
          noteMove(state, {
            kind: '出征', faction: faction.id, who: faction.name, result: '未发',
            fromName: fromCity?.name || '', toName: target.name, reason: quote.reason || '粮饷不足',
          });
          recordEvent(state, `${faction.name}欲出兵${target.name}，${quote.reason || '粮饷不足'}，未发兵。`);
          continue;
        }
        /* 双账本：出征粮饷从城库扣（优先出发城），金从国库扣（GDD §5.2） */
        const spendG = spendFactionGrain(state, faction.id, quote.totalGrain, order.params.fromCity);
        if (!spendG.ok) {
          noteMove(state, {
            kind: '出征', faction: faction.id, who: faction.name, result: '未发',
            fromName: fromCity?.name || '', toName: target.name, reason: '城库粮不足',
          });
          continue;
        }
        const resG = st.resources[faction.id];
        resG.gold = Math.max(0, (resG.gold || 0) - quote.totalGold);
      }
      const drawn = hasFrom ? drawMarchTroops(st, faction, order, targetId) : null;
      if (hasFrom && !drawn) {
        if (quote && quote.ok) {
          /* 兵力抽不出：粮退回出发城城库，金退回国库 */
          creditFactionGrain(state, faction.id, quote.totalGrain, order.params.fromCity);
          const resR = st.resources[faction.id];
          if (resR) resR.gold = (resR.gold || 0) + quote.totalGold;
        }
        continue;
      }
      const troops = drawn ? drawn.sent : Math.max(1, Number(order.params?.troops) || 0);
      if (!troops) continue;
      if (tstate.owner === state.role?.rid || tstate.owner === 'player') {
        // 打玩家的城：换算成本地地图来犯军，走既有战报
        spawnFactionAssault(state, cfg, ctx, faction, target, troops, drawn?.fromId);
        applied.attacked_player += 1;
        noteMarch(state, faction, order, target, tstate, quote, '来犯', 0, drawn);
        continue;
      }
      const defender = st.cities[targetId];
      const prevOwner = defender.owner;
      const prevTroops = defender.troops;
      const atk = troops * (0.86 + r() * 0.2);
      const def = defender.troops * (1 + defender.defense);
      if (atk > def) {
        defender.owner = faction.id;
        // 留下能守住的兵，不再把新城抽成全图最软的目标
        defender.troops = Math.max(420, Math.round(troops * 0.62));
        applied.captured.push(target.name);
        noteBattleOutcome(state, faction.id, { cityId: targetId, ok: true });
        noteCityLost(state, prevOwner, targetId, faction.id);
        noteMarch(state, faction, order, target, { troops: prevTroops }, quote, '克', defender.troops, drawn);
        const line = order.expect
          ? `${faction.name}${order.expect}，遂克${target.name}。`
          : `${faction.name}自${ownerNameOf(state, prevOwner)}手中攻陷${target.name}（${target.province}）`;
        recordEvent(state, line);
        ctx.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg: `【天下】${faction.name}自${ownerNameOf(state, prevOwner)}手中攻陷${target.name}。`, time: Date.now() });
      } else {
        defender.troops = Math.max(200, Math.round(defender.troops * 0.88));
        if (drawn) st.cities[drawn.fromId].troops += Math.round(drawn.sent * 0.72);
        noteBattleOutcome(state, faction.id, { cityId: targetId, ok: false });
        noteMarch(state, faction, order, target, { troops: prevTroops }, quote, '挫', defender.troops, drawn);
        const line = order.expect
          ? `${faction.name}${order.expect}，攻之不下，收兵。`
          : `${faction.name}攻${target.name}不利，折兵退走（守军尚存 ${defender.troops}）。`;
        recordEvent(state, line);
      }
    } else if (order.type === '结盟' || order.type === '议和') {
      const other = String(order.target);
      st.relations[`${faction.id}|${other}`] = 'ally';
      st.relations[`${other}|${faction.id}`] = 'ally';
      const versusName = order.params?.versus ? otherName(state, order.params.versus) : '';
      const versus = versusName ? `，以牵制${versusName}` : '';
      recordEvent(state, `${faction.name}与${otherName(state, other)}结好${versus}。`);
      noteMove(state, {
        kind: '结盟', faction: faction.id, who: faction.name,
        otherName: otherName(state, other), versusName,
      });
    } else if (order.type === '背盟') {
      const other = String(order.target);
      st.relations[`${faction.id}|${other}`] = 'enemy';
      st.relations[`${other}|${faction.id}`] = 'enemy';
      recordEvent(state, `${faction.name}背弃与${otherName(state, other)}的盟约。`);
    }
    // 其余类型首版忽略（驻守/侦察/挑拨/迁都…）：状态不变，可审计
  }
  return applied;
}

function noteMarch(state, faction, order, target, defender, quote, result, hold, drawn) {
  const q = quote || {};
  const fromId = drawn?.fromId || order.params?.fromCity;
  const fromName = order.params?.fromName || '';
  noteMove(state, {
    kind: '出征', faction: faction.id, who: faction.name, result,
    fromId: fromId ? Number(fromId) : 0, fromName,
    toId: target.id, toName: target.name,
    defender: defender?.troops || 0, hold: hold || 0,
    km: q.km || 0, li: q.li || 0, days: q.days || 0,
    grain: q.grain || 0, gold: q.gold || 0,
    horses: q.horses || 0, horseGrain: q.horseGrain || 0, horseGold: q.horseGold || 0,
    totalGrain: q.totalGrain || 0, totalGold: q.totalGold || 0,
    mode: q.mode || '步', dismounted: !!q.dismounted,
  });
  const pay = q.ok ? `路程 ${q.li} 里、${q.days} 日，耗粮 ${q.totalGrain}、金 ${q.totalGold}`
    + (q.horses ? `，战马 ${q.horses} 匹、马料 ${q.horseGrain}、马金 ${q.horseGold}` : (q.dismounted ? '，马匹粮饷不足改步卒' : ''))
    : '';
  if (fromId) {
    noteCity(state, fromId, {
      kind: '出征',
      text: result === '克'
        ? `${faction.name}自本城出兵 ${order.params?.troops || ''} 赴${target.name}，${pay}，城破，留兵 ${hold}。`
        : `${faction.name}自本城出兵${target.name}，${pay}，${result === '挫' ? '攻之不下，残兵退回。' : '兵临城下。'}`,
    });
  }
  noteCity(state, target.id, {
    kind: '出征',
    text: result === '克'
      ? `${faction.name}自${fromName || '邻城'}来攻。守军 ${defender?.troops || 0} 不敌，城归${faction.name}，留兵 ${hold}。${pay}`
      : `${faction.name}来攻，守军 ${defender?.troops || 0}，${result === '挫' ? '城未破。' : '战事转到本地。'}`,
  });
}

function isAllied(st, a, b) {
  if (!a || !b || a === b) return false;
  return st.relations?.[`${a}|${b}`] === 'ally' || st.relations?.[`${b}|${a}`] === 'ally';
}

/** 从出发城实扣兵力。走不到、兵不够则整条出征作废。 */
function drawMarchTroops(st, faction, order, targetId) {
  const fromId = String(order.params.fromCity);
  const row = st.cities[fromId];
  if (!row || row.owner !== faction.id) return null;
  if (!canMarchBetween(fromId, targetId).ok) return null;
  const reserve = Math.max(0, Number(order.params?.reserve) || 0);
  const want = Math.max(0, Number(order.params?.troops) || 0);
  const sent = Math.min(want, row.troops - reserve);
  if (sent < 400) return null;
  row.troops -= sent;
  return { sent, fromId };
}

function otherName(state, factionId) {
  return factionConf().factions.find((f) => f.id === factionId)?.name || factionId;
}

/** 归属方显示名：玩家 / 汉廷 / 诸侯。 */
function ownerNameOf(state, ownerId) {
  const conf = factionConf();
  if (ownerId === 'player') return state.role?.nickName || '我军';
  if (!ownerId || ownerId === conf.neutral.id) return conf.neutral.name;
  return otherName(state, ownerId);
}

/** 诸侯来犯玩家的城：在本地地图上出现一支来犯军，兵力按战略层折算。
 *  修 U12：同时写一条可见行军实体（side:'faction'），与玩家共用 marchDaysBy 时长口径；
 *  情报分级（精确/估算/传闻）由视图层按覆盖率标注，此处不伪造战果。 */
export function spawnFactionAssault(state, cfg, ctx, faction, targetCity, troops, fromId = 0) {
  const city = mainCity(state);
  if (!city) return;
  const st = ensureStrategy(state);
  if (!Array.isArray(st.marches)) st.marches = [];
  const departDay = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const srcId = Number(fromId) || Number(Object.entries(st.cities || {})
    .find(([, v]) => v.owner === faction.id)?.[0]) || 0;
  const km = srcId ? marchKmBetween(srcId, Number(targetCity?.id) || 0) : 120;
  const npcSpeed = 100;
  const marchDays = marchDaysBy(km, npcSpeed);
  const marchRow = {
    id: (st.marchSeq = (st.marchSeq || 0) + 1),
    side: 'faction', kind: 'assault', from: srcId, to: Number(targetCity?.id) || 0,
    departDay, arriveDay: departDay + marchDays,
    troops: Math.max(200, Math.min(2000, Math.round(troops / 6))),
    km, speed: npcSpeed, marchDays,
    factionId: faction.id, factionName: faction.name || '',
    intel: 'estimated',
  };
  st.marches.push(marchRow);
  const rules = cfg.campaignRules || {};
  const soldiers = Math.max(200, Math.min(2000, Math.round(troops / 6)));
  const at = { x: city.x + 2, y: city.y };
  const build = makeBuild(cfg, { rid: 2, x: at.x, y: at.y, type: 52, level: 1 });
  build.name = `${faction.name}军`;
  build.RNick = `${faction.name}军`;
  build.wood = 0; build.iron = 0; build.stone = 0; build.grain = 0;
  state.builds.push(build);
  const garrison = {
    id: nextId(state, 'garrisonId'),
    x: at.x, y: at.y, soldiers, name: build.name, cleared: false, drifted: false,
    faction: faction.id,
  };
  state.garrisons.push(garrison);
  ctx.push?.('roleBuild.push', build);
  ctx.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【天下】${faction.name}自${targetCity.name}方向来犯，兵力 ${soldiers}，已出现在 (${at.x},${at.y})。`,
    time: Date.now(),
  });
  return garrison;
}

/** 选出征队伍：优先指定 armyId，否则挑兵力最多的那支（界面只传城时也能打）。
 *  ★ P2：行军中的队伍自动跳过，不能一队两用。
 *  ★ P7：给了 cityId 就只在该城驻军中挑（分城出兵的前提）。 */
function pickArmy(state, armyId, cityId = 0) {
  const cid = Number(cityId) || 0;
  /* ★ P7：举义前队伍挂在「本地地图主城」(id=1)，与战略城编号不是一套；
     那时只有一座城，不必按城筛。举义后 chooseOath 会把 cityId 改成战略城 id，
     此时才按城取兵——分城出征靠的就是这一步。 */
  const useCity = cid > 0 && !oathPending(state);
  const list = useCity
    ? (state.armys || []).filter((a) => Number(a.cityId) === cid)
    : (state.armys || []);
  if (armyId) return list.find((a) => a.id === Number(armyId) && !a.marchId) || null;
  let best = null;
  let bestN = 0;
  for (const a of list) {
    if (a.marchId) continue;
    const n = (a.soldiers || []).reduce((s, v) => s + Math.max(0, Number(v) || 0), 0);
    if (n > bestN) { bestN = n; best = a; }
  }
  return best;
}

/** 守军将领：按城池等级取 npc_army 编成，装备新战法。
 *  ★ 单位数与城池等级挂钩（小城 1 将 / 郡城 2 将 / 州治 3 将）：
 *    旧实现一律 3 将，玩家开局只有主公 1 将，1v3 必然被集火打死，
 *    第一场仗怎么打都是败（试玩 P0-3）。 */
function defenseFor(cfg, cityId, target, tstate, level) {
  const tier = cfg.npcArmy.armys?.[level - 1] || cfg.npcArmy.armys?.[0];
  const layout = tier?.army?.[0] || { lvs: [1, 1, 1], cfgIds: [100002, 100003, 100004] };
  const unitCount = Math.max(1, Math.min(3, level >= 3 ? 3 : (level === 2 ? 2 : 1)));
  const slotTroops = Math.max(1, Math.ceil(tstate.troops / unitCount));
  const conf = factionConf();
  const name = tstate.owner === 'han'
    ? conf.neutral.name
    : (conf.factions.find((f) => f.id === tstate.owner)?.name || '守军');
  return {
    generals: layout.cfgIds.slice(0, unitCount).map((cfgId, k) => ({
      id: 950000 + Number(cityId) * 10 + k,
      cfgId,
      level: Math.max(1, Math.min(LEVEL_COUNT, level + 2)),
      curArms: (k % 3) + 1, star: 3, physical_power: 100, order: 0, exp: 0, cityId: 0,
      hasPrPoint: 0, usePrPoint: 0, attack_distance: 0,
      force_added: 0, strategy_added: 0, defense_added: 0,
      speed_added: 0, destroy_added: 0, star_lv: 0, parentId: 0,
      skills: [0, 1, 2].map((j) => {
        const sk = SKILLS[((level * 7 + k * 11 + j * 13) % SKILLS.length)];
        return { id: sk.cfgId, lv: Math.max(1, Math.min(LEVEL_COUNT, level + j)), cfgId: sk.cfgId };
      }),
      state: 0,
    })),
    soldiers: Array.from({ length: unitCount }, () => slotTroops),
    level,
    name,
    place: target?.name || tstate.name || '',
  };
}

/**
 * 一场战斗的完整落地：扣兵、给经验、写战报、推通道。
 * 战略攻城与本地清剿共用，保证「战报一定进存档」（试玩 P0-2）。
 */
function settleArmyBattle(state, cfg, ctx, { army, frac, x, y, defenseOverride, seed }) {
  const before = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army.soldiers?.[i]) || 0)));
  const f = Math.min(1, Math.max(0.05, Number(frac) || 1));
  const commit = before.map((v) => Math.max(0, Math.round(v * f)));
  if (commit.reduce((s, n) => s + n, 0) <= 0) return { ok: false, reason: 'no_troops' };
  // ★ P0 兵种克制（三战口径 ±15%，骑→盾→弓→骑）：以双方兵力最多的槽为主兵种，
  //   克制方压制被克方——体现为守军兵力折算（不污染内核输入回填）。
  const mainArms = (rows) => rows.indexOf(Math.max(...rows));
  const atkArms = mainArms(commit) + 1;
  const defRows = (defenseOverride?.soldiers || [0, 0, 0]).map((v) => Math.max(0, Number(v) || 0));
  const defArms = mainArms(defRows) + 1;
  const counter = armsCounter(atkArms, defArms);
  const defense2 = defenseOverride
    ? { ...defenseOverride, soldiers: defRows.map((v) => Math.round(v * (counter > 0 ? 0.87 : counter < 0 ? 1.15 : 1))) }
    : defenseOverride;
  const battleArmy = { ...army, soldiers: commit };
  const result = resolveBattle({ cfg, state, army: battleArmy, x, y, defenseOverride: defense2, seed });
  const remain = result.endAttackSoldiers;

  // 全歼的槽位留一成溃兵归营：单机不该出现「一次败仗把家底清零」的死循环
  const recovered = [0, 0, 0];
  if (result.report.result !== 2) {
    for (let i = 0; i < 3; i += 1) {
      if (commit[i] > 0 && remain[i] === 0) recovered[i] = Math.max(1, Math.ceil(commit[i] * 0.1));
    }
  }
  army.soldiers = [0, 1, 2].map((i) =>
    Math.max(0, before[i] - (commit[i] - remain[i]) + recovered[i]));

  for (const [gid, exp] of Object.entries(result.expByGeneral)) {
    const g = state.generals?.find((x2) => x2.id === Number(gid));
    if (g) g.exp += exp;
  }

  const aTotal = commit.reduce((s, n) => s + n, 0);
  const dTotal = (defenseOverride?.soldiers || []).reduce((s, n) => s + n, 0);
  const aLoss = aTotal - remain.reduce((s, n) => s + n, 0);
  const dLoss = dTotal - (result.endDefenseSoldiers || []).reduce((s, n) => s + n, 0);
  const place = defenseOverride?.place || `(${x},${y})`;
  const win = result.report.result === 2;
  const rec = recovered.reduce((s, n) => s + n, 0);
  let summary = win
    ? `攻陷${place}：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}。`
    : `攻${place}不利：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}`
      + (rec > 0 ? `，溃兵 ${rec} 归营。` : '。');
  const counterNote = counter > 0
    ? `我军${ARMS_NAMES[atkArms]}克制守军${ARMS_NAMES[defArms]}（战力+15%）。`
    : (counter < 0 ? `守军${ARMS_NAMES[defArms]}克制我军${ARMS_NAMES[atkArms]}（战力-15%）。` : '');
  // 额外字段：原客户端忽略，我们自己的战报面板读它做复盘
  result.report.summary = summary + counterNote;
  result.report.analysis = {
    aTotal, dTotal, aLoss, dLoss, recovered: rec, win,
    aBegin: commit, aRemain: remain,
    counter, atkArms, defArms, counterNote,
  };

  // ★ P3 战利品：胜则按歼敌数掠夺金粮（金=歼敌×0.5、粮=歼敌×1）
  let loot = null;
  if (win && dLoss > 0) {
    const day = Math.floor(Number(state.clock?.day) || 1);
    const lg = Math.round(dLoss * 0.5);
    const lgr = Math.round(dLoss * 1);
    const r = state.roleRes;
    r.gold = Math.min(r.depot_capacity || 1000000, (r.gold || 0) + lg);
    r.grain = Math.min(r.depot_capacity || 1000000, (r.grain || 0) + lgr);
    recordRes(state, 'gold', lg, '战利品', day);
    recordRes(state, 'grain', lgr, '战利品', day);
    loot = { gold: lg, grain: lgr };
  }

  state.warReports.unshift(result.report);
  if (state.warReports.length > 100) state.warReports.length = 100;

  /* ★ P6 招降链前置：胜仗可能俘获一名有名有姓的守将（确定性判定，同一场只掷一次）。
   *   概率 30%；已招募/已在押的不重复。入 state.captives，之后可在六府「武将」页招降。 */
  if (win) {
    const day = Math.floor(Number(state.clock?.day) || 1);
    state.captives = Array.isArray(state.captives) ? state.captives : [];
    const ownedCfg = new Set((state.generals || []).map((g) => Number(g.cfgId)));
    let defs = [];
    try { defs = JSON.parse(result.report.b_d_general || '[]'); } catch { /* 守军无名 */ }
    const cand = defs
      .map((row) => Number(row?.[1]))
      .filter((id) => id && id !== 880001 && !ownedCfg.has(id)
        && !state.captives.some((c) => c.cfgId === id));
    const roll = ((cand.join(',') || 'x').length * 31 + day * 7 + Math.floor(aTotal)) % 100;
    if (cand.length && roll < 30) {
      const cfgId = cand[day % cand.length];
      const name = cfg?.generalByCfg?.get(cfgId)?.name || `武将${cfgId}`;
      state.captives.push({ cfgId, name, from: place, loyal: 50, days: 0, day });
      summary += ` 阵前擒得敌将「${name}」！可在武将府招降。`;
      result.report.summary = summary + counterNote;
      result.report.analysis.captive = name;
      recordEvent(state, `${place}一战告捷，敌将「${name}」被俘，押入大营听候发落。`);
    }
  }

  ctx.push?.('army.push', army);
  for (const gid of army.generals || []) {
    const g = state.generals?.find((x2) => x2.id === gid);
    if (g) ctx.push?.('general.push', g);
  }
  ctx.push?.('warReport.push', result.report);
  ctx.push?.('roleRes.push', { ...state.roleRes });

  return {
    ok: true, result: result.report.result, report: result.report,
    summary, aTotal, dTotal, recovered: rec, win, loot,
  };
}

/**
 * ★ P7 行军由距离与队伍速度决定（率土之滨口径，而非固定 2 日）。
 *
 *   率土：行军时间 = 距离 × 30 ÷ 队伍速度；队伍速度取队内**最慢**武将。
 *   本作把「距离」换成路网里的真实里程（conf/.../map.json 每条 route 自带 km），
 *   速度换算为 60~160（五维 speed 0→60、10000→160），再折算成游戏日：
 *
 *       行军日 = ceil( 里程km ÷ (55 × 速度/100) )，夹在 1~12 日
 *
 *   于是：相邻 105km + 速度 134 → 1.4 → 2 日（与旧基线一致）；
 *        远路 337km + 速度 100 → 6.1 → 7 日；骑兵队（150）则 4 日。
 *   关键：**时长随距离变、像素距离也随距离变，屏幕上军标速度才恒定**。
 */
const MARCH_KM_BASE = 55;      // 速度 100 时每日推进的里程（km/日）
const MARCH_DAYS_MIN = 1;
/* ★ 修 bug-17：旧上限 12 日把长途抹平（900km 与 2000km 都是 12 日）。
   率土/三战里跨州远征本来就是十几到几十日，这里放宽到 40 日，
   并由 marchSupplyStops 给出「途中休整」提示，长线不再和邻城一个耗时。 */
const MARCH_DAYS_MAX = 40;
/* ★ M2-3：粮耗口径已并入全局参数表（knobs.grainPerSoldierDay，默认 0.1） */
/** 辎重队速度固定：车马慢，比最慢的步卒还慢一截。 */
const TRANSPORT_SPEED = 70;

/** 两城之间的行军里程（km）。优先取 route.km，缺失时按坐标距离估。 */
export function marchKmBetween(fromId, toId) {
  const map = strategyMap();
  const r = (map.routes || []).find((x) => (x.from === fromId && x.to === toId) || (x.from === toId && x.to === fromId));
  if (r && Number(r.km) > 0) return Number(r.km);
  const a = map.cities.find((c) => c.id === Number(fromId));
  const b = map.cities.find((c) => c.id === Number(toId));
  if (!a || !b) return 0;
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 1.2);
}

/** 武将速度（60~160）：五维 speed 与装备加成折算，缺配置按 6000 兜底。 */
function generalSpeed(cfg, g) {
  if (!g) return 100;
  const base = g.isProtagonist
    ? 7400
    : (Number(cfg?.generalByCfg?.get?.(Number(g.cfgId))?.speed) || 6000);
  return Math.max(20, Math.min(200, 60 + (base + (Number(g.speed_added) || 0)) * 0.01));
}

/** 队伍行军速度：取队内最慢武将（率土口径），空队按 100。 */
export function armySpeed(state, cfg, army) {
  let slowest = Infinity;
  for (const gid of army?.generals || []) {
    const g = (state.generals || []).find((x) => x.id === gid);
    if (!g) continue;
    slowest = Math.min(slowest, generalSpeed(cfg, g));
  }
  return Number.isFinite(slowest) ? Math.round(slowest * 10) / 10 : 100;
}

/** 里程 + 速度 → 行军日数（夹 1~12 日）。 */
export function marchDaysBy(km, speed) {
  const v = Math.max(20, Number(speed) || 100);
  const raw = Math.ceil((Number(km) || 0) / (MARCH_KM_BASE * (v / 100)));
  return Math.max(MARCH_DAYS_MIN, Math.min(MARCH_DAYS_MAX, raw));
}

/** 战术锁：同一出发城 + 目标城的行军日（含势力特技 marchDelta）。
 *  ★ M2 修路：驿道完工的边行军 −1 日（最低 1 日，双向生效；interior-task 完工写入 roadWorks）。 */
export function marchPlan(state, cfg, fromId, toId, army) {
  const km = marchKmBetween(fromId, toId);
  const speed = armySpeed(state, cfg, army);
  const base = marchDaysBy(km, speed);
  const roadCut = Number(state.strategy?.roadWorks?.[roadEdgeKey(fromId, toId)]) || 0;
  const days = Math.max(1, Math.min(MARCH_DAYS_MAX, base + factionTraitOf(state).marchDelta - roadCut));
  return { km, speed, days, roadCut };
}

/** 战略层城战（P2 行军版）：出兵不再瞬时开打，而是生成行军队列，
 *  扣行军粮、锁队，`strategyResolveMarches` 在到达日走真实内核结算。
 *  frac：出兵比例（1 全军 / 0.5 半军 / 0.34 三成）。
 *  ★ P7：fromCityId 指定出发城（任意己方城），缺省回落本城 —— 分城也能出征了。 */
export function strategyAttack(state, cfg, ctx, { cityId, armyId, frac = 1, fromCityId = 0 }) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const home = Number(fromCityId) || st.playerCity;
  const id = Number(cityId);
  const target = map.cities.find((c) => c.id === id);
  const tstate = st.cities[id];
  if (!target || !tstate) return { ok: false, code: 1, reason: 'no_city' };
  if (tstate.owner === 'player') return { ok: false, code: 2, reason: 'own_city' };
  // 出发城必须能用：己方城，或玩家本城（未举义时本城尚未易帜，沿用旧档语义）
  const fromState = st.cities[home];
  const fromOk = fromState && (fromState.owner === 'player' || home === st.playerCity);
  if (!fromOk) return { ok: false, code: 6, reason: 'not_own_city' };
  if (home === id) return { ok: false, code: 2, reason: 'own_city' };
  // 行军校验：只能沿既有行军段推进，关隘封锁则过不去
  const march = canMarchBetween(home, id);
  if (march && march.ok === false) {
    if (march.reason === 'gate_blocked') return { ok: false, code: 3, reason: 'gate_blocked', gate: march.gate };
    if (march.reason === 'no_road') return { ok: false, code: 3, reason: 'not_adjacent' };
    return { ok: false, code: 3, reason: 'not_adjacent' };
  }
  if (!neighborsOf(home).includes(id)) return { ok: false, code: 3, reason: 'not_adjacent' };
  // ★ P0-3：界面只传 cityId，旧实现固定取 armys[0]，而那支可能正好是空队
  const army = pickArmy(state, armyId, home);
  if (!army) return { ok: false, code: 4, reason: 'no_army' };
  if (!army.cityId) army.cityId = home;   // 旧队补驻城，后续驻城逻辑才有依据
  if ((army.generals || []).every((g) => !g)) {
    /* ★ M2-3 失败态出路（GDD §3.4 无将）：出征前无将不再卡死——自动生成代将
       （五维 50、无战法、不可培养、不触发宿命；在有名将可用的城里会被玩家换掉） */
    const standin = makeStandInGeneral(state, home);
    (state.generals || (state.generals = [])).push(standin);
    army.generals[0] = standin.id;
    recordEvent(state, `帐下无将，以代将${standin.name}权充先锋（五维 50、无战法）。`);
    ctx.push?.('general.push', standin);
  }
  if ((army.soldiers || []).every((n) => !(n > 0))) return { ok: false, code: 4, reason: 'no_troops' };
  // 行军粮：按**实际出战**兵力 × 0.1/程（bug-5：旧实现按整队算粮，界面又说按比例出兵）
  // 优先从出发城城库扣（前线囤粮，三国志14 补给线口径），城库不足吃全局池并 +25% 损耗
  const troopsTotal = (army.soldiers || []).reduce((s, v) => s + Math.max(0, Number(v) || 0), 0);
  const ratio = Math.max(0.01, Math.min(1, Number(frac) || 1));
  const deploy = Math.max(1, Math.round(troopsTotal * ratio));
  const grainCost = Math.ceil(deploy * knobGet(state, 'grainPerSoldierDay'));
  const pay = consumeMarchGrain(state, home, grainCost);
  if (!pay.enough) {
    return { ok: false, code: 5, reason: 'no_grain', need: grainCost };
  }

  if (!Array.isArray(st.marches)) st.marches = [];
  /* ★ M2 练兵：出发城有充能 → 本队攻击 +5%（battle.js 按 army.drillMorale 折算，
     previewAssault 用同一口径预演，推演与正式逐位一致；一支部队耗一充能） */
  const drillCharges = Number(st.cityEcon?.[home]?.drillCharges) || 0;
  const drillMorale = drillCharges > 0 ? 10 : 0;
  if (drillMorale > 0) {
    st.cityEcon[home].drillCharges = drillCharges - 1;
    army.drillMorale = drillMorale;
  }
  const departDay = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  // ★ P7：时长由里程与队伍速度算（势力特技 marchDelta 已并入 marchPlan）
  const plan = marchPlan(state, cfg, home, id, army);
  const marchDays = plan.days;
  const row = {
    id: (st.marchSeq = (st.marchSeq || 0) + 1),
    side: 'player', from: home, to: id,
    departDay, arriveDay: departDay + marchDays,
    armyId: army.id, frac: ratio, grainCost, troops: deploy,
    km: plan.km, speed: plan.speed, drillMorale,
  };
  st.marches.push(row);
  army.marchId = row.id;   // 锁队：到达前不能再出征/清剿
  const fromName = map.cities.find((c) => c.id === home)?.name || '本城';
  recordEvent(state, `大军自${fromName}开拔，出征${target.name}，`
    + `行程 ${Math.round(plan.km)} 里、速度 ${plan.speed}`
    + (plan.roadCut ? `（驿道 −${plan.roadCut} 日）` : '')
    + `，预计第 ${row.arriveDay} 日抵城下（耗粮 ${grainCost}）`
    + (drillMorale ? '，练兵加成 +5% 攻击' : '') + '。');
  ctx.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【天下】我军自${fromName}开拔，进军${target.name}，程 ${Math.round(plan.km)} 里，预计 ${marchDays} 日后抵达。`,
    time: Date.now(),
  });
  return {
    ok: true, marching: true, marchId: row.id, arriveDay: row.arriveDay,
    city: target.name, grainCost, marchDays, km: plan.km, speed: plan.speed, from: fromName,
    drillMorale,
    roadCut: plan.roadCut || 0,
    // ★ 出征面板：把「哪支队 / 实出多少 / 留守多少」原样回给界面，UI 不再自己猜
    armyId: army.id, troops: troopsTotal, deploy, frac: ratio,
    supplyStops: Math.max(0, Math.floor(marchDays / 10)),
  };
}

/** 行军到达结算：settleWorld 每次结算时调用；到达日的队伍走真实内核开打。 */
export function strategyResolveMarches(state, cfg, ctx) {
  const st = ensureStrategy(state);
  if (!Array.isArray(st.marches) || !st.marches.length) return [];
  const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const map = strategyMap();
  const results = [];
  for (const mm of st.marches) {
    /* 修 U12：诸侯行军只做「可见性 + 到达标记」。战斗已在 applyOrders 抽象结算，
       此处不能重复开打；到达后保留 resolved 行，供战报与情报回看。 */
    if (mm.side !== 'player') {
      if (!mm.resolved && today >= mm.arriveDay) mm.resolved = true;
      continue;
    }
    if (mm.resolved) continue;
    if (today < mm.arriveDay) continue;
    // ★ P3 运输队：抵达即粮入城库，不走战斗
    if (mm.kind === 'transport') {
      mm.resolved = true;
      const ok2 = deliverGrain(state, mm.to, mm.grain);
      const tName = map.cities.find((c) => c.id === mm.to)?.name || cityName(mm.to);
      recordEvent(state, ok2
        ? `运输队抵达${tName}，粮 ${mm.grain} 已入库。`
        : `运输队抵达${tName}，城池已非我所有，粮车折返。`);
      results.push({ kind: 'transport', cityId: mm.to, city: tName, grain: ok2 ? mm.grain : 0 });
      continue;
    }
    mm.resolved = true;
    const army = (state.armys || []).find((a) => a.id === mm.armyId);
    if (army) {
      delete army.marchId;
      delete army.drillMorale;   // ★ M2：一场战斗消耗一次练兵加成
    }
    const target = map.cities.find((c) => c.id === mm.to);
    const tstate = st.cities[mm.to];
    if (!target || !tstate) continue;
    if (tstate.owner === 'player') {
      if (army) army.cityId = mm.to;
      recordEvent(state, `${target.name}已入我军版图，班师。`);
      continue;
    }
    if (!army || (army.soldiers || []).every((n) => !(n > 0))) {
      recordEvent(state, `出征${target.name}的队伍中途溃散，无果而返。`);
      continue;
    }
    const level = Math.max(1, Math.min(3, target.level || 1));
    const defenseOverride = defenseFor(cfg, mm.to, target, tstate, level);
    const fought = settleArmyBattle(state, cfg, ctx, {
      army, frac: mm.frac, x: 8000 + mm.to, y: 100 + level, defenseOverride,
      /* ★ 验收 #10：种子按「到达日」算，战前推演能算出一模一样的种子 */
      seed: battleSeedFor(army.id, 8000 + mm.to, 100 + level, mm.arriveDay),
    });
    if (!fought.ok) continue;
    const win = fought.result === 2;
    if (win) {
      tstate.owner = 'player';
      tstate.troops = Math.max(200, Math.round(defenseOverride.soldiers.reduce((s, n) => s + n, 0) * 0.3));
      // ★ P2/P3 城破之殃：人口 -15%（兵源压力）；一次性掠夺入府库
      const econ = ensureCityEcon(state);
      const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
      let sackGold = 0;
      let sackGrain = 0;
      if (econ?.[mm.to]) {
        const e = econ[mm.to];
        sackGold = Math.round(e.pop * 0.15 * 0.08);
        sackGrain = Math.round(e.store * 0.5);
        e.pop = Math.round(e.pop * 0.85);
        e.store = Math.round(e.store * 0.5);
        /* ★ P7 战争系数：城破流民四散，民心/治安双降（三国志11/14 口径） */
        e.morale = Math.max(0, (e.morale ?? 60) - 15);
        e.order = Math.max(0, (e.order ?? 60) - 12);
        const r = state.roleRes;
        r.gold = Math.min(r.depot_capacity || 1000000, (r.gold || 0) + sackGold);
        r.grain = Math.min(r.depot_capacity || 1000000, (r.grain || 0) + sackGrain);
        recordRes(state, 'gold', sackGold, `破城掠夺·${target.name}`, day);
        recordRes(state, 'grain', sackGrain, `破城掠夺·${target.name}`, day);
      }
      recordEvent(state, `主公攻陷${target.name}（${target.province}），守军 ${fought.dTotal} 溃散，城入我军${sackGold ? `，掠夺金 ${sackGold} 粮 ${sackGrain}` : ''}。`);
      noteCity(state, mm.to, { kind: '出征', text: `主公攻陷${target.name}，守军 ${fought.dTotal} 溃散，城入我军。` });
      ctx.push?.('chat.push', {
        rid: 0, nickName: '系统', type: 0,
        msg: `【天下】我军攻陷${target.name}！此城已入版图。`,
        time: Date.now(),
      });
    } else if (fought.result === 0) {
      recordEvent(state, `攻${target.name}不利，败退（折损约 ${fought.aTotal - (fought.recovered || 0)}）。`);
    } else {
      recordEvent(state, `攻${target.name}相持不下，暂退。`);
    }
    // ★ P7 驻城归位：胜则进驻新占城，败/平则退回出发城。
    //   分城出征后队伍不再永远挂在旧城，玩家能在新城里继续操作。
    if (army) army.cityId = win ? mm.to : (Number(mm.from) || st.playerCity || 0);
    results.push({
      cityId: mm.to, city: target.name, result: fought.result,
      reportId: fought.report.id, summary: fought.summary,
      aTotal: fought.aTotal, dTotal: fought.dTotal, recovered: fought.recovered,
    });
  }
  // 已结算且过期 3 日的行军记录清掉（客户端留了渲染窗口）
  st.marches = st.marches.filter((mm) => !(mm.resolved && today - mm.arriveDay > 3));
  return results;
}

/**
 * ★ 出征面板：撤回在途队伍。
 *  - 攻击队：解锁队伍、退回出发城，行军粮只退一半（走出去的粮吃掉了）
 *  - 运输队：粮车折返，退八成入库（两成路上损耗）
 *  - 已到城下的不能再撤（当天就会结算），避免「撤回」抢在结算前洗掉战斗结果
 */
export function strategyRecallMarch(state, cfg, ctx, { marchId }) {
  const st = ensureStrategy(state);
  const id = Number(marchId);
  const mm = (st.marches || []).find((x) => x.id === id && x.side === 'player' && !x.resolved);
  if (!mm) return { ok: false, reason: 'no_march' };
  const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  if (today >= Number(mm.arriveDay)) return { ok: false, reason: 'already_arrived', arriveDay: mm.arriveDay };
  let refund = 0;
  const r = state.roleRes;
  if (mm.kind === 'transport') {
    refund = Math.round((Number(mm.grain) || 0) * 0.8);
    if (refund > 0) {
      r.grain = Math.min(r.depot_capacity || 1000000, (r.grain || 0) + refund);
      recordRes(state, 'grain', refund, `运输队折返·${cityName(mm.from)}`, today);
    }
  } else {
    const army = (state.armys || []).find((a) => a.id === mm.armyId);
    if (army) {
      delete army.marchId;
      delete army.drillMorale;   // ★ M2：撤回的队伍练兵加成随行军行一并作废
      army.cityId = Number(mm.from) || st.playerCity;
    }
    refund = Math.round((Number(mm.grainCost) || 0) * 0.5);
    if (refund > 0) {
      r.grain = Math.min(r.depot_capacity || 1000000, (r.grain || 0) + refund);
      recordRes(state, 'grain', refund, `撤军归营·${cityName(mm.from)}`, today);
    }
  }
  mm.resolved = true;
  mm.recalled = true;
  st.marches = st.marches.filter((x) => x !== mm);
  const fromName = cityName(mm.from);
  const toName = cityName(mm.to);
  recordEvent(state, mm.kind === 'transport'
    ? `运输队自${toName}道折返${fromName}，粮 ${refund} 回库。`
    : `大军自${toName}城下折返${fromName}，行军粮退回 ${refund}。`);
  return {
    ok: true, marchId: id, kind: mm.kind || 'attack',
    refund, from: fromName, to: toName,
  };
}

/** ★ 验收 #23：行军队列可重排（上移/下移）。
 *
 *  为什么这不是纯装饰：strategyResolveMarches 是按 st.marches 的数组顺序逐支结算的，
 *  同日抵达同一座城的两支队伍，先结算的那支面对的是原守军，后结算的那支面对的可能是
 *  已经易主的城（直接班师）。所以「谁先打」是真决策——想用弱队先消耗、强队补刀，
 *  或者反过来强队先破城，都必须能改顺序。 */
export function strategyReorderMarch(state, ctx, { marchId, dir } = {}) {
  const st = ensureStrategy(state);
  const list = Array.isArray(st.marches) ? st.marches : [];
  const id = Number(marchId);
  const i = list.findIndex((x) => x.id === id && x.side === 'player' && !x.resolved);
  if (i < 0) return { ok: false, reason: 'no_march' };
  const mm = list[i];
  const step = Number(dir) < 0 ? -1 : 1;
  const j = i + step;
  if (j < 0 || j >= list.length) return { ok: false, reason: 'edge', order: i + 1, total: list.length };
  /* 只与同侧、未结算的邻居交换：诸侯军的插队顺序由 AI 自己决定，玩家无权改。 */
  const other = list[j];
  if (!other || other.side !== 'player' || other.resolved) {
    return { ok: false, reason: 'blocked', order: i + 1, total: list.length };
  }
  list[i] = other;
  list[j] = mm;
  const a = cityName(other.from), b = cityName(other.to);
  recordEvent(state, `行军队列调整：${a}→${b} 一军${step < 0 ? '前移' : '后移'}至第 ${j + 1} 位。`);
  return { ok: true, marchId: id, order: j + 1, total: list.length };
}

/** 清剿来犯军：本地地图被遮住后，玩家在天下界面也能看到并处理威胁。 */export function clearThreat(state, cfg, ctx, { garrisonId, armyId }) {
  ensureStrategy(state);
  const g = (state.garrisons || []).find((x) => x.id === Number(garrisonId) && !x.cleared);
  if (!g) return { ok: false, reason: 'no_threat' };
  const army = pickArmy(state, armyId);
  if (!army) return { ok: false, reason: 'no_army' };
  if ((army.generals || []).every((v) => !v)) return { ok: false, reason: 'no_general' };
  if ((army.soldiers || []).every((n) => !(n > 0))) return { ok: false, reason: 'no_troops' };
  const troops = Math.max(1, Math.round(Number(g.soldiers) || 0));
  const slot = Math.max(1, Math.ceil(troops / 3));
  const level = 2;
  const defenseOverride = {
    ...defenseFor(cfg, 9000 + Number(g.id), { name: g.name }, { troops, owner: g.faction || 'han' }, level),
    name: g.name,
    place: g.name,
    soldiers: [slot, slot, slot],
  };
  const fought = settleArmyBattle(state, cfg, ctx, {
    army, frac: 1, x: g.x, y: g.y, defenseOverride,
  });
  if (!fought.ok) return { ok: false, reason: fought.reason };
  if (fought.result === 2) {
    onTileCleared(state, cfg, g.x, g.y);
    // 敌方来犯军在地图上的那格建筑一并撤掉
    const build = (state.builds || []).find((b) => b.x === g.x && b.y === g.y && b.rid !== state.role.rid);
    if (build) {
      state.builds = state.builds.filter((b) => b !== build);
      const [, tileLevel] = cfg.tileAt(g.x, g.y);
      ctx.push?.('roleBuild.push', {
        rid: 0, x: g.x, y: g.y, type: build.type, level: tileLevel || 1, curDurable: 0, maxDurable: 0,
      });
    }
    recordEvent(state, `清剿${g.name}，歼敌 ${fought.dTotal}。`);
  }
  return {
    ok: true, result: fought.result, reportId: fought.report.id, summary: fought.summary,
    name: g.name, aTotal: fought.aTotal, dTotal: fought.dTotal, recovered: fought.recovered,
  };
}

/** ★ P0 编队（三战口径）：三槽 = 盾步/弓兵/骑兵，换将与重分兵力一次完成。
 *  兵力只在该队现有兵内重分配（加兵走征兵）；行军中锁队。 */
export function strategyFormup(state, cfg, ctx, { armyId, generals, soldiers }) {
  const st = ensureStrategy(state);
  const army = (state.armys || []).find((a) => a.id === Number(armyId));
  if (!army) return { ok: false, reason: 'no_army' };
  if (army.marchId) return { ok: false, reason: 'marching' };
  const slots = [0, 1, 2].map((i) => Number(generals?.[i]) || 0);
  const seen = new Set();
  for (const gid of slots) {
    if (!gid) continue;
    const g = (state.generals || []).find((x) => x.id === gid);
    if (!g) return { ok: false, reason: 'no_general', generalId: gid };
    if (seen.has(gid)) return { ok: false, reason: 'dup_general', generalId: gid };
    seen.add(gid);
    const other = (state.armys || []).find((a) => a.id !== army.id && (a.generals || []).includes(gid));
    if (other) return { ok: false, reason: 'in_other_army', generalId: gid, armyId: other.id };
  }
  const troops = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(soldiers?.[i]) || 0)));
  const cur = (army.soldiers || []).map((v) => Math.max(0, Math.floor(Number(v) || 0)));
  if (troops.reduce((s, v) => s + v, 0) > cur.reduce((s, v) => s + v, 0)) {
    return { ok: false, reason: 'too_many_troops', have: cur.reduce((s, v) => s + v, 0) };
  }
  // 兵力从该队现有兵重分：差额部分视为留在营（cur - troops）
  army.generals = slots;
  army.soldiers = troops;
  army.con_times = [0, 0, 0];
  army.con_cnts = [0, 0, 0];
  const names = slots.map((gid) => {
    const g = (state.generals || []).find((x) => x.id === gid);
    return g ? (cfg?.generalByCfg?.get(g.cfgId)?.name || `武将${g.id}`) : '';
  });
  recordEvent(state, `整编队伍#${army.order}：${names.map((n, i) => n ? `${ARMS_NAMES[i + 1]}·${n}(${troops[i]})` : '').filter(Boolean).join('、') || '空编'}。`);
  ctx.push?.('army.push', army);
  return {
    ok: true, army: { id: army.id, order: army.order, generals: names, soldiers: troops },
    apt: slots.map((gid, i) => {
      const g = (state.generals || []).find((x) => x.id === gid);
      return g ? Math.round(armsApt(g, i + 1) * 100) : 0;
    }),
  };
}

/** ★ P3 运输队：把粮从府库运往指定己方城城库，走行军队列按时抵达。
 *  蝗灾前把粮运出去是经典避险操作（三国志11）。
 *  ★ P7：改为按里程与辎重速度算日数（不再固定 2 日），可指定出发城。 */
export function strategyTransport(state, cfg, ctx, { cityId, grain, fromCityId = 0 }) {
  const st = ensureStrategy(state);
  ensureCityEcon(state);
  const id = Number(cityId);
  const tstate = st.cities[id];
  if (!tstate || tstate.owner !== 'player') return { ok: false, reason: 'not_own_city' };
  const from = Number(fromCityId) || st.playerCity || 0;
  const fromState = st.cities[from];
  if (!fromState || fromState.owner !== 'player') return { ok: false, reason: 'not_own_city' };
  if (from === id) return { ok: false, reason: 'same_city' };
  const amount = Math.floor(Number(grain) || 0);
  if (amount <= 0) return { ok: false, reason: 'bad_amount' };
  const r = state.roleRes;
  if ((Number(r.grain) || 0) < amount) return { ok: false, reason: 'no_grain', have: Math.floor(r.grain || 0) };
  r.grain -= amount;
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  if (!Array.isArray(st.marches)) st.marches = [];
  const km = marchKmBetween(from, id);
  const days = marchDaysBy(km, TRANSPORT_SPEED);
  const row = {
    id: (st.marchSeq = (st.marchSeq || 0) + 1),
    side: 'player', kind: 'transport', from, to: id,
    departDay: day, arriveDay: day + days, grain: amount,
    km, speed: TRANSPORT_SPEED,
  };
  st.marches.push(row);
  recordRes(state, 'grain', -amount, `运往${cityName(id)}城库`, day);
  recordEvent(state, `运输队自${cityName(from)}启程，运粮 ${amount} 前往${cityName(id)}，`
    + `程 ${Math.round(km)} 里，第 ${row.arriveDay} 日抵达。`);
  ctx.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg: `【天下】运输队启程，运粮 ${amount} 前往${cityName(id)}。`, time: Date.now() });
  return { ok: true, marchId: row.id, arriveDay: row.arriveDay, city: cityName(id), grain: amount, km, days };
}

/** ★ P1 赏赐：金 +amount/100 忠诚（单次上限 +15，三国志11 口径）。 */
export function rewardGeneral(state, cfg, ctx, { generalId, amount }) {
  const g = (state.generals || []).find((x) => x.id === Number(generalId));
  if (!g) return { ok: false, reason: 'no_general' };
  const amt = Math.floor(Number(amount) || 0);
  if (amt < 50 || amt > 1500) return { ok: false, reason: 'bad_amount' };
  const r = state.roleRes;
  if ((Number(r.gold) || 0) < amt) return { ok: false, reason: 'no_gold' };
  r.gold -= amt;
  g.loyal = Math.min(100, Math.round(((g.loyal ?? 88) + Math.min(15, amt / 100)) * 10) / 10);
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  recordRes(state, 'gold', -amt, `赏赐·${cfg?.generalByCfg?.get(g.cfgId)?.name || `武将${g.id}`}`, day);
  ctx.push?.('general.push', g);
  return { ok: true, loyal: g.loyal, gold: Math.floor(r.gold) };
}

/** ★ P6 城池内政 → ★ U14 改成任务对象：开垦/招商/募兵/修城/赈灾。
 *  派单逻辑（成本、执行武将、工期、每旬增量、状态）全部在 interior-task.js 里唯一实现，
 *  本函数只做旧接口兼容：老 UI 与老调用方仍走 `invest`，返回里多了 task 字段与完工日。
 *  行为变化（刻意）：开发类不再即时生效，而是按执行武将能力 1~3 旬完工，
 *  每旬在事件簿留一条带归因的记录（「长安农田 +1.5（荀彧·9600）」）。 */
export function strategyInvest(state, cfg, ctx, { cityId, kind, targetCityId }) {
  const st = ensureStrategy(state);
  ensureCityEcon(state);
  const id = Number(cityId);
  const tstate = st.cities[id];
  if (!tstate || tstate.owner !== 'player') return { ok: false, reason: 'not_own_city' };
  const r = beginInteriorTask(state, cfg, ctx, { cityId: id, kind, targetCityId: Number(targetCityId) || 0 });
  if (!r.ok) return r;
  /* 城名权威来源是 map.json（cityName），interior-task 零依赖不自己读图，由这里回写一次 */
  if (r.task) r.task.city = cityName(id);
  const live = (st.interiorTasks || []).find((t) => t.id === (r.task && r.task.id));
  if (live) live.cityName = cityName(id);
  const e = st.cityEcon[id];
  const y = cityYield(state, id);
  return {
    ...r,
    kind, cityId: id, effectText: r.effectText,
    devAgri: e.devAgri, devTrade: e.devTrade, devArms: e.devArms ?? 0, devDef: e.devDef ?? 0,
    lvAgri: devLevel(e.devAgri), lvTrade: devLevel(e.devTrade),
    lvArms: devLevel(e.devArms), lvDef: devLevel(e.devDef),
    morale: Math.round(e.morale ?? 60), order: Math.round(e.order ?? 60),
    troops: tstate.troops,
    yieldGrain: y?.grain || 0, yieldGold: y?.gold || 0,
  };
}

/** ★ U14 撤销在施内政（已投入不退，已到账增量保留）。 */
export function cancelInvest(state, ctx, { taskId }) {
  const r = cancelInteriorTask(state, { taskId });
  if (r.ok && ctx?.push) {
    ctx.push('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【内政】${r.task.city}${r.task.label}任务已撤销（已投入 ${r.task.cost} 金不退）。`,
      time: Date.now(),
    });
  }
  return r;
}

/**
 * ★ 验收 #10 战前推演（只读）：算一遍「如果现在出兵，到达那天会打成什么样」。
 *
 * 为什么结果可信：
 *  - 走的是**同一个** resolveBattle + 同一套守军构造（defenseFor）+ 兵种克制折算；
 *  - 战斗种子 = battleSeedFor(队伍, 坐标, **到达日**)，正式结算在到达日用的也是这个种子；
 *  - 全流程在 state 的深拷贝上跑，不写存档、不推进 RNG、不产生战报。
 * 因此只要「守军没变、队伍没变」，预演结果与正式结算逐位一致（tests/preview.test.js 已锁）。
 *
 * 返回里带 `attribution`：赢在哪 / 输在哪的结构化一句，而不是只给个胜算数字。
 */
export function previewAssault(state, cfg, { cityId, fromCityId, armyId, frac } = {}) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const to = Number(cityId);
  const from = Number(fromCityId) || st.playerCity;
  const target = map.cities.find((c) => c.id === to);
  const tstate = st.cities[to];
  if (!target || !tstate) return { ok: false, reason: 'no_city' };
  if (tstate.owner === 'player') return { ok: false, reason: 'own_city' };
  const road = canMarchBetween(from, to);
  if (!road.ok) return { ok: false, reason: road.reason || 'no_road' };
  const army = pickArmy(state, armyId, from);
  if (!army) return { ok: false, reason: 'no_army' };
  const before = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army.soldiers?.[i]) || 0)));
  const f = Math.min(1, Math.max(0.05, Number(frac) || 1));
  const commit = before.map((v) => Math.max(0, Math.round(v * f)));
  const aTotal = commit.reduce((s2, n) => s2 + n, 0);
  if (aTotal <= 0) return { ok: false, reason: 'no_troops' };

  /* ★ 行军口径必须与 strategyAttack 完全一致：marchPlan 已含势力特技 marchDelta，
     种子又按 arriveDay 取，所以差一天就会打出不同战报（这里踩过坑）。 */
  const plan = marchPlan(state, cfg, from, to, army);
  const km = plan.km;
  const speed = plan.speed;
  const days = plan.days;
  const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const arriveDay = today + days;

  const level = Math.max(1, Math.min(3, target.level || 1));
  const defense = defenseFor(cfg, to, target, tstate, level);
  const mainArms = (rows) => rows.indexOf(Math.max(...rows));
  const atkArms = mainArms(commit) + 1;
  const defArms = mainArms(defense.soldiers.map((v) => Math.max(0, Number(v) || 0))) + 1;
  const counter = armsCounter(atkArms, defArms);
  const defense2 = {
    ...defense,
    soldiers: defense.soldiers.map((v) => Math.round(v * (counter > 0 ? 0.87 : counter < 0 ? 1.15 : 1))),
  };
  const dTotal = defense.soldiers.reduce((s2, n) => s2 + n, 0);

  const seed = battleSeedFor(army.id, 8000 + to, 100 + level, arriveDay);
  /* 深拷贝：预演绝不改真实存档（含队伍、战报、俘虏、资源） */
  const sandbox = structuredClone(state);
  /* ★ M2 练兵：与 strategyAttack 同一口径——出发城有充能就算 +5% 攻击，
     否则推演会漏掉练兵加成，预演与正式结算就对不上（张力守恒 #3 前提） */
  const drill = (Number(st.cityEcon?.[from]?.drillCharges) || 0) > 0 ? 10 : 0;
  const result = resolveBattle({
    cfg, state: sandbox, army: { ...army, soldiers: commit, drillMorale: drill },
    x: 8000 + to, y: 100 + level, defenseOverride: defense2, seed,
  });
  const remain = result.endAttackSoldiers || [0, 0, 0];
  const dRemain = result.endDefenseSoldiers || [0, 0, 0];
  const aLoss = aTotal - remain.reduce((s2, n) => s2 + n, 0);
  const dLoss = dTotal - dRemain.reduce((s2, n) => s2 + n, 0);
  const code = result.report.result;
  const win = code === 2;
  const hold = Math.max(1, Math.round((target.level || 1) * 8));
  const counterNote = counter > 0
    ? `我军${ARMS_NAMES[atkArms]}克制守军${ARMS_NAMES[defArms]}（守军兵力折算 −13%）`
    : (counter < 0 ? `守军${ARMS_NAMES[defArms]}克制我军${ARMS_NAMES[atkArms]}（守军兵力折算 +15%）` : '双方兵种无克制');
  const attribution = win
    ? `可下：兵力 ${aTotal} : 守军 ${dTotal}，预计折损 ${aLoss}、歼敌 ${dLoss}；${counterNote}。`
    : (code === 1
      ? `相持：兵力 ${aTotal} : 守军 ${dTotal}，双方都打不动（${counterNote}）。补兵或换阵再试。`
      : `难下：兵力 ${aTotal} : 守军 ${dTotal}，预计折损 ${aLoss}、仅歼敌 ${dLoss}；${counterNote}。建议先增兵或换将。`);
  return {
    ok: true,
    target: { id: to, name: target.name, level, owner: tstate.owner },
    from, km, speed, days, arriveDay, today,
    commit, aTotal, dTotal, aLoss, dLoss, remain, dRemain: dRemain.slice(),
    counter, atkArms, defArms, counterNote,
    seed, rounds: result.report.rounds || 0,
    code, win, draw: code === 1,
    report: result.report,
    summary: win
      ? `预计攻陷${target.name}：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}。`
      : `预计攻${target.name}不利：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}。`,
    attribution: attribution + `（守军 ${hold > 0 ? level : 1} 级编成；抵达第 ${arriveDay} 日）`,
    caveat: '预演基于此刻的守军与队伍；期间敌方增援、你的队伍被改派，结算会随之改变。',
  };
}

/** ★ P6 招降：押着的敌将，金 + 政治判定成功率；失败忠诚 -10，低于 0 越狱逃走。
 *  修 U11：只在判定成功后扣费（旧实现失败也先扣 300 金，无补偿且不可回放）。
 *  修 U21：掷骰走 rngFor(seed, turn, tag)，同 seed + 回合结果恒定。
 *  修 U08：成功率读 captive-rules.js 唯一公式，与面板构成条 / 决策预览同源。 */
export function recruitCaptive(state, cfg, ctx, { idx }) {
  const st = ensureStrategy(state);
  const i = Number(idx);
  state.captives = Array.isArray(state.captives) ? state.captives : [];
  const cap = state.captives[i];
  if (!cap) return { ok: false, reason: 'no_captive' };
  const cost = CAPTIVE_COST;
  const r = state.roleRes;
  if ((Number(r.gold) || 0) < cost) return { ok: false, reason: 'no_gold', cost };
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const rate = captiveRecruitRate(state, cap);
  const success = rngFor(state.seed ?? 20261110, st.turn ?? day, `captive:${i}:${cap.cfgId}`).random() < rate;
  if (!success) {
    cap.loyal = (cap.loyal ?? 50) - 10;
    ctx.push?.('roleRes.push', { ...state.roleRes });
    if (cap.loyal < 0) {
      state.captives.splice(i, 1);
      recordEvent(state, `敌将「${cap.name}」拒绝招降，趁夜越狱逃走。`);
      return { ok: false, reason: 'escaped', name: cap.name, rate: Math.round(rate * 100), gold: Math.floor(r.gold), charged: 0 };
    }
    return { ok: false, reason: 'refused', name: cap.name, loyal: cap.loyal, rate: Math.round(rate * 100), gold: Math.floor(r.gold), charged: 0 };
  }
  r.gold -= cost;
  recordRes(state, 'gold', -cost, `招降·${cap.name}`, day);
  state.captives.splice(i, 1);
  const g = makeGeneral(cfg, nextId(state, 'generalId'), cap.cfgId, st.playerCity || 1, 1);
  g.loyal = Math.min(100, 70 + Math.round(protagonistStat(state, '魅力') / 25));
  state.generals.push(g);
  noticeRecruit(state, ctx, cap.name);
  recordEvent(state, `敌将「${cap.name}」感主公之义，解甲来投，即日入营。`);
  ctx.push?.('general.push', g);
  ctx.push?.('roleRes.push', { ...state.roleRes });
  return { ok: true, general: { id: g.id, name: cap.name }, loyal: g.loyal, rate: Math.round(rate * 100), charged: cost };
}

/** 每旬押将演变：忠诚 -2（离乡思归），低于 30 有越狱风险（30%）。
 *  修 U21：越狱掷骰走确定性 rngFor，与战略层同一套种子纪律。 */
export function captivesTick(state, ctx) {
  state.captives = Array.isArray(state.captives) ? state.captives : [];
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  for (const [k, cap] of [...state.captives].entries()) {
    cap.days = (cap.days || 0) + 1;
    cap.loyal = (cap.loyal ?? 50) - 2;
    if (cap.loyal < 30
      && rngFor(state.seed ?? 20261110, day, `captive-escape:${k}:${cap.cfgId}`).random() < 0.3) {
      state.captives.splice(state.captives.indexOf(cap), 1);
      recordEvent(state, `敌将「${cap.name}」看守松懈，越狱而逃。`);
    }
  }
}

/**
 * ★ P7 出仕：在野贤才主动来投（三国志11/14 的「名声」机制）。
 *   名声 = 城池数×8 + 帐下武将×2 + 君主魅力/100；每旬掷一次，概率 3%~45%。
 *   优先投奔「籍贯正好在我方城里」的人——版图越大、名声越响，来投者越多，
 *   这条线补上了原先只有「酒馆来访 / 探索 / 招降」三条的缺口。
 *   修 U21：掷骰改走 rngFor(seed, turn, 'defect:tavern')，可回放。
 */
export function defectTick(state, cfg, ctx) {
  const st = ensureStrategy(state);
  const tavern = ensureTavern(state, cfg);
  if (!tavern?.people?.length) return null;
  const own = Object.entries(st.cities || {})
    .filter(([, v]) => v.owner === 'player').map(([id]) => Number(id));
  if (!own.length) return null;
  const fame = own.length * 8 + (state.generals || []).length * 2
    + protagonistStat(state, '魅力') / 100;
  const rate = Math.min(0.45, 0.03 + fame / 700);
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  if (rngFor(state.seed ?? 20261110, st.turn ?? day, 'defect:tavern').random() > rate) return null;
  const local = tavern.people.filter((p) => !p.recruited && own.includes(Number(p.birthCity)));
  const pool = local.length ? local : tavern.people.filter((p) => !p.recruited);
  if (!pool.length) return null;
  const pick = pool[(day * 13 + own.length * 7) % pool.length];
  const cityId = own.includes(Number(pick.birthCity)) ? Number(pick.birthCity) : (st.playerCity || own[0]);
  const g = makeGeneral(cfg, nextId(state, 'generalId'), pick.cfgId, cityId, 1);
  g.loyal = Math.min(100, 72 + Math.round(protagonistStat(state, '魅力') / 22));
  state.generals.push(g);
  pick.recruited = true;
  // 战法登记表增量更新（与原版技能面板共用一张表）
  const s = g.skills?.[0];
  if (s?.cfgId && skillById(s.cfgId)) {
    const row = (state.skills || []).find((x) => Number(x.cfgId) === Number(s.cfgId));
    if (row) { if (!row.generals.includes(g.id)) row.generals.push(g.id); }
    else state.skills = [...(state.skills || []), { id: s.cfgId, cfgId: s.cfgId, generals: [g.id] }];
  }
  noticeRecruit(state, ctx, pick.name || '');
  recordEvent(state, `${cityName(cityId)}名士「${pick.name}」闻主公之名，束身来投，即日入仕。`);
  ctx?.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【天下】${cityName(cityId)}名士「${pick.name}」慕义来投，帐下又添一员。`,
    time: Date.now(),
  });
  ctx?.push?.('general.push', g);
  return { cfgId: pick.cfgId, name: pick.name, cityId, city: cityName(cityId), fame: Math.round(fame), rate: Math.round(rate * 100) };
}

/** 供 /__slg/strategy/state 使用。cfg 可选：不给时武将只显示 #id。 */
export function strategyViewState(state, cfg = null) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const conf = factionConf();
  /* ★ 修 bug-18：人口曾有两套字段同时下发（地图静态 population / 经济层动态 pop），
     几个月后概览与内政页会显示两个不同的数。统一以经济层为准，只留一个来源。 */
  const econAll = ensureCityEcon(state) || {};
  /* ★ U20 粮道：整张图一次 BFS（逐城调用会变成 O(n²) 路网搜索，72 城下明显卡） */
  const SUP = supplyMap(state);
  // ★ P4-①：玩家城旗帜/命名继承所举义的诸侯（择曹操则玩家城就是曹旗蓝）
  const oathF = oathFactionOf(state);
  const nameOf = (id) => id === 'player'
    ? '我军'
    : (conf.factions.find((f) => f.id === id)?.name
      || (id === conf.neutral.id ? conf.neutral.name : id));
  const colorOf = (id) => id === 'player'
    ? (oathF?.color || '#c9a227')
    : (conf.factions.find((f) => f.id === id)?.color || conf.neutral.color);
  // ★ P1-6：本地地图被遮罩挡住，来犯军必须在天下界面可见、可清剿
  const threats = (state.garrisons || [])
    .filter((g) => !g.cleared)
    .map((g) => ({
      id: g.id, x: g.x, y: g.y, name: g.name,
      soldiers: Math.max(0, Math.round(Number(g.soldiers) || 0)),
      faction: g.faction || '', patrol: !!g.patrol,
    }));
  return {
    turn: st.turn,
    // ★ 界面上「第 0 月」很别扭：内部 turn 从 0 起算，对外统一给 month = turn + 1
    month: (st.turn || 0) + 1,
    turnDays: conf.turnDays ?? 10,
    day: state.clock?.day ?? 1,
    nextTurnDay: (st.lastTurnDay || 0) + (conf.turnDays ?? 10),
    campaign: {
      id: state.campaign?.id || 'chapter1',
      chapter: state.campaign?.chapter ?? 1,
      ending: state.campaign?.ending ?? null,
      endingDay: state.campaign?.endingDay ?? null,
      choice: state.campaign?.choice ?? null,
      day: state.clock?.day ?? 1,
    },
    threats,
    /* ★ 验收 #22：缩放档位阈值下发一次，客户端只做 rank ≤ 档位 的过滤 + 屏幕占位去重 */
    labelPolicy: labelPolicy(),
    armies: (state.armys || []).map((a) => ({
      id: a.id,
      order: a.order,
      cityId: Number(a.cityId) || st.playerCity || 0,
      marching: !!a.marchId,
      // ★ P7：队伍行军速度（队内最慢武将），客户端据此预算行军日
      speed: armySpeed(state, cfg, a),
      soldiers: [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(a.soldiers?.[i]) || 0))),
      armsNames: [ARMS_NAMES[1], ARMS_NAMES[2], ARMS_NAMES[3]],
      generals: (a.generals || []).map((gid, i) => {
        const g = (state.generals || []).find((x) => x.id === gid);
        if (!g) return null;
        return {
          id: g.id, name: cfg?.generalByCfg?.get(g.cfgId)?.name || `武将${g.id}`,
          arms: ARMS_NAMES[i + 1] || '',
          apt: Math.round(armsApt(g, i + 1) * 100),
          loyal: Math.round(g.loyal ?? 88),
        };
      }),
    })),
    cities: map.cities.map((c) => ({
      id: c.id, name: c.name, province: c.province, provinceId: c.provinceId,
      x: c.x, y: c.y, level: c.level, levelName: c.levelName || '', adminLevel: c.adminLevel || '',
      // 修 U06：map.json 的特产/主要兵种是顶层字段，attrs 里没有这两个键。
      // 旧写法恒为空，导致战略台与六府「城池性格」整列显示 —。保留 attrs 作旧档回落。
      terrain: c.terrain || '', specialty: c.specialty || c.attrs?.特产 || '',
      arms: c.arms || c.attrs?.主要兵种 || '',
      // ★ 修 bug-18：人口只有经济层一个来源（民心/灾害/征兵都会改它）
      population: econAll[c.id]?.pop ?? (c.population || 0),
      agri: c.attrs?.农业 ?? 0, commerce: c.attrs?.商业 ?? 0,
      cityDef: c.attrs?.城防 ?? 0,
      history: (c.history || '').slice(0, 160),
      owner: st.cities[c.id]?.owner || 'han',
      ownerName: nameOf(st.cities[c.id]?.owner || 'han'),
      color: colorOf(st.cities[c.id]?.owner || 'han'),
      troops: st.cities[c.id]?.troops || 0,
      /* ★ M2 侦察：敌方城情报档位（0 传闻 / 1 估算 / 2 精确），随视图下发供界面标注 */
      intelTier: st.cities[c.id]?.owner === 'player'
        ? undefined
        : (Number(st.intel?.[c.id]) || 0),
      /* ★ M2 离间：敌城守将离心度（离间计成累加），后续外交/叛变判定消费 */
      unrest: st.cities[c.id]?.owner === 'player' ? undefined : (Number(st.cities[c.id]?.unrest) || 0),
      /* ★ 验收 #22：地图标注分级（1 要城 / 2 中城 / 3 小城）。客户端按缩放档过滤，
         低倍只标本城与要城，避免 72 城城名糊成一片。口径见 domain/map-lod.js。 */
      labelRank: cityLabelRank(c, { isPlayer: st.cities[c.id]?.owner === 'player' }),
      // ★ P2/P3 城市经营摘要（仅玩家城给数值，其余城省流量）
      ...(st.cities[c.id]?.owner === 'player' ? (() => {
        const e = econAll[c.id];
        if (!e) return {};
        const y = cityYield(state, c.id);
        const mod = e.mod && Number(state.clock?.day) <= e.mod.until ? e.mod : null;
        // ★ P6 驻城武将：驻在本城的队伍（含武将与兵力），行军中的不算
        const stationed = (state.armys || [])
          .filter((a) => Number(a.cityId) === Number(c.id) && !a.marchId)
          .map((a) => ({
            armyId: a.id,
            soldiers: [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(a.soldiers?.[i]) || 0))),
            generals: (a.generals || []).filter(Boolean).map((gid) => {
              const g = (state.generals || []).find((x) => x.id === gid);
              return g ? { id: g.id, name: cfg?.generalByCfg?.get(g.cfgId)?.name || `武将${g.id}`, loyal: Math.round(g.loyal ?? 88) } : null;
            }).filter(Boolean),
          }));
        return {
          pop: e.pop, store: e.store,
          yieldGrain: y?.grain || 0, yieldGold: y?.gold || 0,
          disaster: e.disaster || null,
          modUntil: mod?.until || 0, modGrain: mod?.grain || 1,
          /* ★ P7 逐城治理面：民心/治安/四项开发度与等级，全部来自该城 attrs 与经营 */
          morale: y?.morale ?? 60, order: y?.order ?? 60,
          devAgri: y?.devAgri ?? 0, devTrade: y?.devTrade ?? 0,
          devArms: y?.devArms ?? 0, devDef: y?.devDef ?? 0,
          lvAgri: y?.lvAgri ?? 1, lvTrade: y?.lvTrade ?? 1,
          lvArms: y?.lvArms ?? 1, lvDef: y?.lvDef ?? 1,
          stationed,
          // ★ 修 bug-16：驻城部队兵力另给一份，和「城防守军 troops」分开显示
          troopSum: stationed.reduce((n, a) => n + (a.soldiers || []).reduce((x, v) => x + (Number(v) || 0), 0), 0),
          armsCount: stationed.length,
          // ★ 修 bug-12：逐城内政冷却（按项目），界面据此置灰并显示可再办日
          investDays: e.investDays || {}, lastInvestDay: e.lastInvestDay || 0,
          /* ★ M2 练兵充能 / 招抚期：界面显示「下次出征 +5%」与「叛逃风险 −30% 至第 N 日」 */
          drillCharges: Number(e.drillCharges) || 0,
          appeaseUntil: Number(e.appeaseUntil) || 0,
          /* ★ U14 该城在施/最近完工的内政任务状（进度、执行武将、每旬增量、预计完工） */
          interiorTasks: interiorTaskView(state, c.id),
          /* ★ U20 粮道：连通到都城的跳数与里程；断绝时给原因，界面必须显示断粮后果 */
          supply: (() => {
            const s = SUP.byCity[c.id] || { connected: false, hops: -1, km: -1, via: [] };
            return {
              connected: !!s.connected, hops: s.hops, km: s.km,
              via: (s.via || []).map((id) => cityName(id)),
              cut: !!e.supplyCut, days: Number(e.supplyDays) || 0,
              capital: SUP.capital,
            };
          })(),
          // ★ 修 bug-4：该城能打哪些邻城（关隘封锁已过滤，修 bug-4 后己方城也已剔除）
          marchable: marchableFrom(c.id, state),
          // 带里程，界面出兵前就能显示「程 208 里」
          marchRoutes: marchableFrom(c.id, state).map((nid) => ({
            id: nid, km: marchKmBetween(c.id, nid),
            name: map.cities.find((x) => x.id === nid)?.name || '',
          })),
          garrison: Math.max(0, Math.round(Number(st.cities[c.id]?.troops) || 0)),
        };
      })() : {}),
    })),
    /* ★ M2-3 失败态四出路与结局判定：判定 + 出路清单一并下发，界面不再自己猜 */
    fail: failstates(state),
    ending: evaluateEnding(state),
    playerCity: st.playerCity || 0,
    // ★ P4-①：举义状态随视图下发，客户端据此决定弹不弹举义页
    oath: {
      done: !oathPending(state),
      lord: oathF?.id || null, lordName: oathF?.name || '', color: oathF?.color || '',
      city: oathOf(state).city || 0,
    },
    // ★ P6 俘虏名册（招降入口）
    captives: (state.captives || []).map((c, i) => ({
      idx: i, cfgId: c.cfgId, name: c.name, from: c.from,
      loyal: c.loyal, days: c.days,
      // 修 U08：与 panels.js / 确认框共用 captive-rules.js 唯一公式
      rate: Math.round(captiveRecruitRate(state, c) * 100),
      rateParts: captiveRateParts(state, c),
    })),
    // 可出征的城（已按行军校验过滤：关隘封锁即不可走；己方城不再算目标）
    marchable: marchableFrom(st.playerCity || 0, state),
    // ★ P2：行军队列与日内进度（客户端据此画行军线与移动军标）
    // ★ P7：带 km/speed，客户端按「剩余里程 ÷ 剩余日」画，远近军标速度才一致
    // ★ 出征面板：带 armyId / 兵力 / 两端城名 / 剩余日，行军队列可直接操作撤回
    marches: (st.marches || []).map((mm) => {
      const a = (state.armys || []).find((x) => x.id === mm.armyId);
      const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
      return {
        id: mm.id, side: mm.side, kind: mm.kind || 'attack', from: mm.from, to: mm.to,
        fromName: map.cities.find((x) => x.id === Number(mm.from))?.name || cityName(mm.from),
        toName: map.cities.find((x) => x.id === Number(mm.to))?.name || cityName(mm.to),
        departDay: mm.departDay, arriveDay: mm.arriveDay, resolved: !!mm.resolved,
        recalled: !!mm.recalled,
        armyId: mm.armyId || 0, frac: mm.frac ?? 1,
        // ★ U12：诸侯军没有 armyId，兵力直接取行军行，别显示成 0
        troops: a
          ? (a.soldiers || []).reduce((s, v) => s + Math.max(0, Number(v) || 0), 0)
          : (Number(mm.troops) || 0),
        factionName: mm.factionName || '',
        intel: mm.intel || '',
        /* ★ M2 粮道 L2：军级补给状态随行军行下发（通畅/断绝/断绝天数），
           客户端只渲染，不再自己猜补给好不好 */
        supplyOk: mm.supplyOk !== false,
        supplyCutDays: Number(mm.supplyCutDays) || 0,
        supplyNode: Number(mm.supplyNode) || 0,
        km: mm.km || 0, speed: mm.speed || 0, grain: mm.grain || 0,
        grainCost: mm.grainCost || 0,
        remainDays: Math.max(0, Number(mm.arriveDay) - today),
        progress: Math.max(0, Math.min(1, (today - Number(mm.departDay))
          / Math.max(1, Number(mm.arriveDay) - Number(mm.departDay)))),
      };
    }),
    dayFrac: dayFraction(state, chapterRules().realMsPerDay),
    msPerDay: Math.max(1000, Math.round(chapterRules().realMsPerDay / (state.clock?.scale || 1))),
    gates: Object.entries((marchGraph() && marchGraph().gateStatus) || {})
      .map(([name, status]) => ({ name, status })),
    routes: map.routes.map((r) => ({ id: r.id, from: r.from, to: r.to, points: r.points, sea: r.sea })),
    factions: conf.factions.map((f) => ({ id: f.id, name: f.name, color: f.color })),
    neutral: { id: conf.neutral.id, name: conf.neutral.name, color: conf.neutral.color },
    events: [...st.events].slice(-40).reverse()
      .map((e) => ({ ...e, month: (e.turn || 0) + 1 })),
    chronicle: [...(st.chronicle || [])].reverse().slice(0, 36),
    cityLogs: st.cityLogs || {},
    plans: conf.factions.map((f) => {
      const g = st.memory?.[f.id]?.goal;
      if (!g) return null;
      return {
        id: f.id, name: f.name, color: f.color,
        type: g.type, target: g.target || '', targetName: g.targetName || '',
        from: g.from || '', fromName: g.fromName || '',
        reason: g.reason || '', lockedUntil: g.lockedUntil || 0,
      };
    }).filter(Boolean),
    books: (st.chronicle || []).slice(-6).reverse().map((m) => ({
      month: m.month,
      rows: booksOf(m.moves),
    })),
  };
}
