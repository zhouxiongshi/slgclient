/**
 * 战略层（东汉十三州·城池模型图）的世界状态与执行层。
 *
 * 职责边界沿用 slg-ai 的契约：
 *   - 决策脑只产出 slg-ai-orders-v1 指令单，绝不直接改世界；
 *   - 本文件 applyOrders 是唯一执行口，所有改动可审计；
 *   - NPC 诸侯打玩家的城 → 换算成本地地图的一支来犯军（复用既有战报）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBuild, makeGeneral, makeFacilityList, nextId, mainCity } from '../world.js';
import { rngFor } from './strategy-rng.js';
/* ★ M2-3 全局参数表（本作设计）：零依赖叶子，所有新数值一律从这里读 */
import { knobGet, knobSet } from './knobs.js';
/* ★ M4-8：行军速度与战斗/内政/外交共用同一份武将属性基线 */
import { gameStatOf } from './general-stat.js';
/* ★ M2-3 失败态与结局（本作设计）：零依赖叶子 */
import { failstates, failureCheck, evaluateEnding, makeStandInGeneral } from './failstate.js';
import { beginInteriorTask, cancelInteriorTask, interiorTaskView } from './interior-task.js';
/* ★ U20 粮道（supply 只依赖 march，不反向 import 本文件） */
import { supplyMap, marchSupplyEstimate } from './supply.js';
/* 修 U08：招降成功率收敛到唯一公式，面板图鉴/预览/实际掷骰同源 */
import { captiveRecruitRate, captiveRateParts, CAPTIVE_COST } from './captive-rules.js';
/* ★ 2026-11-16：名望（放归累积）进入在野来投率，让名望字段有真实消费点 */
import { defectRate, FAME_DEFECT_CAP } from './captive-reputation.js';
import { canMarchBetween, marchableNeighbors, marchGraph } from './march.js';
/* ★ 验收 #22：地图标注分级（哪座城算要城只有这一处口径） */
import { cityLabelRank, labelPolicy } from './map-lod.js';
/* ★ P62：行军相遇（城下会战 / 道中遭遇）的唯一判定口径，只产出表现数据 */
import { detectClashes } from './clash.js';
/* ★ P11 兵役制：城池视图与战略动作只从 levy.js 取兵源数字，禁止另算一份 */
import { levyView, checkLevy, commitLevy } from './levy.js';
import { resolveBattle, battleSeedFor, wallMaxOf, wallDefMul, WALL } from '../battle.js';
import { repairCostOf } from './city-wall.js';
import { planCampaign, commitBrainGoal, noteBattleOutcome, noteCityLost, PERSONA_AXES } from './strategy-brain.js';
import { loadConfig } from '../config.js';
import { quoteMarch, openMonth, closeMonth, noteMove, noteCity, booksOf } from './strategy-log.js';
import { onTileCleared, chapterRules, noticeRecruit } from './campaign.js';
import { dayFraction, ensureTavern } from './tavern.js';
import { recordRes } from './economy.js';
import {
  grantBattleExp, levelUpSentence, takeBattlePromos,
  ADVANCE_COST_GOLD, ADVANCED_LEVEL_CAP,
} from './general-progress.js';
import {
  ensureCityEcon, consumeMarchGrain, deliverGrain, cityEconTick, cityName,
  cityYield, armsApt, armsCounter, ARMS_NAMES, devLevel, cityDevTick, storeCapOf,
  loyaltyOf, setLoyalty, LOYAL_BASELINE,
} from './city-econ.js';
import { SKILLS, LEVEL_COUNT, skillById } from '../skills.js';
/* ★ 2026-11-20：边境威胁视图抽为零环叶子，六府与沙盘共用同一份映射/常量 */
import { threatRows, SIEGE_GRACE_DAYS, SIEGE_MAX_DAYS } from './threat-view.js';
export { SIEGE_GRACE_DAYS, SIEGE_MAX_DAYS };
/* ★ M4-13：守将按城池确定性分配，不再复用 npc_army 写死的 6 个 cfgId */
import { garrisonCfgIds, garrisonLabel } from './garrison.js';
/* ★ P16：诸侯势力持久武将名册（学战法/升级/招募/俘虏/挖角/求援），零环叶子 */
import {
  ensureRosters, rosterDefenders, aiRosterLearnTick, aiRosterGrantExp, aiRosterCultivateTick,
  aiRecruitTick, aiPoachTick, aiAidRequest, aiCaptureTick, aiCaptiveTick,
} from './ai-roster.js';
/* ★ 2026-11-16：功勋晋官的单一口径（零依赖叶子） */
import { grantMerit, slotCapOf } from './official-rank.js';
/* ★ M4-13：俘虏生成 / 释放 / 处斩统一入口，两条占领路径共用 */
import { captureFromBattle } from './captives.js';
/* ★ 修「推演返回一串代码」：推演的语义（人话）由这一处统一生成，
   前端只排版；战报/回放共用同一批战法说明。 */
import { skillProfile, previewNarrative } from './battle-narrative.js';
import { oathOf, oathPending, oathFactionOf, factionTraitOf, protagonistStat } from './oath.js';
import { playerIdentity, isFounded, foundStatus } from './faction-identity.js';
/* ★ P50 太守制（2026-11-23）：旧长驻委任（appointment.js）已删，视图只下发太守总览。
   外交模块保持原接线。 */
/* ★ P50 太守制：视图下发太守总览（城内页/六府共用） */
import { governorListView, governorView, governorCandidates } from './governor.js';
/* ★ P54：编队资格与派将共用一份判据（城内征兵 / 六府整编两个入口同口径）。 */
import { formationGeneralCheck, syncGeneralOrders, releaseSlot } from './formation.js';
import { diplomacyView, diplomacyAct, noteCityCaptured, truceActive, PLAYER_ID, adjustAttitudeByEvent } from './diplomacy.js';
/* ★ M3-4 事件系统接线（本作设计）：引擎是零依赖叶子，ctx 由本层适配 */
import { eventCooldownTick, selectEvents, applyEffects } from './event-engine.js';
/* ★ M3-4 宿命 24 组落战斗（本作设计）：同队 ≥2 人组合生效 */
import { loadFateGroups, fatesOfHero } from './fate-groups.js';
/* 委任/外交动作经本模块转发给 index.js（保持 index 只 import strategy 一个入口） */
export { diplomacyAct };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** ★ P56：主公不在常规武将配置表，所有玩家可见事件/整编记录统一走这个名字口径。 */
function generalDisplayName(state, cfg, g) {
  if (!g) return '';
  if (g.isProtagonist || Number(g.cfgId) === 880001) return state?.role?.nickName || '主公';
  return cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || g.name || `武将${g.cfgId}`;
}
const MAP_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json');
const FACTIONS_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'factions.json');
const SCENARIOS_DIR = resolve(ROOT, 'conf', 'campaign', 'strategy', 'scenarios');

/* ★ M3-5 六剧本运行期接入（本作设计）：剧本 = 归属 + 势力集 + 开局决策。
 *  剧本 JSON 自包含（tools/build-scenarios.mjs 产出），此处只做加载与降级——
 *  局部势力 id 缺 trait/startGenerals 时按 name 从基础 8 诸侯继承。 */
let scenarioCache = null;
function scenarioIndex() {
  if (!scenarioCache) {
    scenarioCache = new Map();
    for (const fn of readdirSync(SCENARIOS_DIR).filter((n) => n.endsWith('.json'))) {
      const sc = JSON.parse(readFileSync(resolve(SCENARIOS_DIR, fn), 'utf8'));
      scenarioCache.set(sc.id, sc);
    }
  }
  return scenarioCache;
}

/** 全部剧本清单（举义页/设置页的剧本选择卡）。 */
export function listScenarios() {
  return [...scenarioIndex().values()]
    .sort((a, b) => a.year - b.year)
    .map((s) => ({ id: s.id, name: s.name, year: s.year, playerOptions: s.playerOptions || {}, playerDefault: s.playerDefault || [] }));
}

/** 单个剧本（含 specialRules / source / confidence），不存在返回 null。 */
export function scenarioConf(id) {
  return scenarioIndex().get(String(id || '')) || null;
}

/** 剧本势力集：局部 id 缺字段时按 name 从基础诸侯继承（汉廷/huangjin 无则保持空）。 */
function scenarioFactionsEnriched(sc) {
  const base = factionConf().factions;
  return sc.factions.map((f) => {
    const b = base.find((x) => x.name === f.name);
    return {
      ...f,
      trait: f.trait || b?.trait || null,
      startGenerals: f.startGenerals || b?.startGenerals || [],
    };
  });
}

/** 剧本视图：当前激活 + 可选清单 + 开局决策文案（举义页/设置页消费）。 */
export function scenarioView(state) {
  const sid = state?.strategy?.scenarioId || state?.scenarioId || null;
  const sc = sid ? scenarioConf(sid) : null;
  return {
    active: sid,
    name: sc?.name || null,
    year: sc?.year || null,
    specialRules: sc?.specialRules || [],
    source: sc?.source || null,
    confidence: sc?.confidence ?? null,
    opening: sc?.opening || null,
    list: listScenarios(),
  };
}

/** 切换剧本（新游戏语义）：整体重建战略层归属，举义状态清零待重选。 */
export function strategySetScenario(state, sid) {
  const sc = scenarioConf(sid);
  if (!sc) return { ok: false, code: 1, reason: 'no_scenario', available: listScenarios().map((s) => s.id) };
  state.scenarioId = sc.id;
  delete state.strategy;
  delete state.oath;
  ensureStrategy(state);
  /* 行军队列随 strategy 一起清空，但锁队标记挂在 armys 上；
     不清会造成切剧本后队伍永久 pending / 选不中（marchId 指向已消失的队列）。 */
  for (const a of state.armys || []) delete a.marchId;
  return { ok: true, scenario: scenarioView(state) };
}

/** 势力配置（剧本优先）：激活剧本时用剧本的势力集整体替换 8 诸侯。
 *  state.scenarioId（未建档）/ state.strategy.scenarioId（已建档）都算激活。 */
export function factionConfFor(state) {
  const base = factionConf();
  const sid = state?.strategy?.scenarioId || state?.scenarioId;
  if (!sid) return base;
  const sc = scenarioConf(sid);
  if (!sc) return base;
  const factions = scenarioFactionsEnriched(sc);
  return {
    ...base,
    factions,
    neutral: factions.find((f) => f.id === base.neutral.id) || base.neutral,
  };
}

/** 战略层存档版本：2 起守军按城池等级分档（旧档读入时一次性重算）。 */
const STRATEGY_VERSION = 2;

let staticMap = null;
let factionsConf = null;
let cfgCache = null;
function cachedLoadConfig() {
  if (!cfgCache) {
    // 静态 import 会在模块加载时取到 loadConfig 函数引用，调用才真正读盘（惰性）
    cfgCache = loadConfig();
  }
  return cfgCache;
}

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

export function ensureStrategy(state, cfgArg = null) {
  const map = strategyMap();
  const conf = factionConf();
  /* ★ P16：名册在任何路径都 ensure（旧档缺字段补空、开局播种）。
     cfg 可能没传（多数老调用点），用惰性缓存的 loadConfig 兜底；config.js 只依赖叶子无环。 */
  const rosterCfg = cfgArg || state.__cfg || cachedLoadConfig();
  const rosterConf = { ...conf, personas: PERSONA_AXES };
  if (state.strategy?.cities) {
    ensureRosters(state, rosterConf, rosterCfg);
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
    /* ★ 2026-11-20：势力动态独立通道（NPC 官阶/学艺/登庸），不占玩家军情流。 */
    if (!Array.isArray(st.dynamics)) st.dynamics = [];
    // ★ P7：旧档队伍没有 cityId（那时只有本城概念），一律并到本城
    for (const a of state.armys || []) if (!a.cityId) a.cityId = st.playerCity || 0;
    /* ★ M3-4 事件系统/宿命/事件效果的存档域（旧档补字段） */
    if (!st.eventSys) st.eventSys = { fired: {}, cooldown: {} };
    if (!Array.isArray(st.pendingEvents)) st.pendingEvents = [];
    if (!st.flags) st.flags = {};
    if (!Array.isArray(st.everOwned)) st.everOwned = [];
    if (!Array.isArray(st.battleHistory)) st.battleHistory = [];
    /* ★ P62：相遇军情（沙盘对撞表现与「军情」回看都读这一份） */
    if (!Array.isArray(st.clashes)) st.clashes = [];
    return st;
  }
  /* ★ M3-5：剧本归属（本作设计）——state.scenarioId 在建档前设置时，
   * 初始 72 城直接按剧本 cityOwner 落位，年份基准也从剧本起算。 */
  const scConf = factionConfFor(state);
  const scInit = state.scenarioId ? scenarioConf(state.scenarioId) : null;
  const factionByState = new Map(scConf.factions.map((f) => [f.id, f]));
  const cities = {};
  for (const c of map.cities) {
    // 初版归属：剧本优先 → 州有诸侯则全州归他 → 归汉廷
    const owner = scInit
      ? (scInit.cityOwner?.[String(c.id)] || conf.neutral.id)
      : (factionByState.get(c.provinceId)?.id || conf.neutral.id);
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
    /* ★ 2026-11-20：势力动态（背景音）与玩家事件流分离，见 recordEvent(opts.quiet)。 */
    dynamics: [],
    scenarioId: scInit?.id || null,
    scenarioYear: scInit?.year || null,
    /* ★ M3-4 事件系统存档域（event-engine 落这里，与 chronicle 数组 st.events 分开） */
    eventSys: { fired: {}, cooldown: {} },
    pendingEvents: [],
    flags: {},
    everOwned: [],
    battleHistory: [],
    fame: 0,
    cities,
    relations: {},
    memory: {},
    chronicle: [],
    cityLogs: {},
    resources: Object.fromEntries(scConf.factions.map((f) => [f.id, { gold: 8000, grain: 12000 }])),
  };
  /* ★ M3-5：剧本开局决策（预设开局）→ 伪事件进 pendingEvents，
   *  与事件弹窗同一管线呈现；效果词全 nothing，只记录玩家选择。 */
  if (scInit?.opening) {
    state.strategy.pendingEvents.push({
      id: `opening-${scInit.id}`,
      title: `${scInit.name}·开局`,
      layer: '史实节点',
      priority: 100,
      speaker: '',
      text: [scInit.opening.text || ''],
      choices: (scInit.opening.choices || []).map((label, i) => ({ id: `c${i + 1}`, label, preview: '' })),
    });
    state.strategy.flags = state.strategy.flags || {};
    state.strategy.flags[`opening:${scInit.id}`] = true;
  }
  bindPlayerHome(state);
  /* ★ P16：新档建好后再播种名册（此时 st.turn=0，ensureRosters 内部据此播种） */
  ensureRosters(state, rosterConf, rosterCfg);
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
  const conf = factionConfFor(state);
  const homeName = conf.playerHome || '相';
  const home = strategyMap().cities.find((c) => c.name === homeName)
    || strategyMap().cities[0];
  if (!home) return null;
  st.playerCity = home.id;
  /* ★ M3-5：剧本新档未举义时不夺城（剧本城归属是史实布局，玩家从举义页拿地）；
   *  基础模式维持老行为：无举义记录视为已举义，默认城归属改玩家。 */
  const scenarioPending = !state.oath && Boolean(state.scenarioId || st.scenarioId);
  if (scenarioPending || oathPending(state)) return home;
  st.cities[home.id].owner = 'player';
  /* ★ M3-4：everOwned 记账（事件条件 cityLost 的口径来源） */
  if (Array.isArray(st.everOwned) && !st.everOwned.includes(home.id)) st.everOwned.push(home.id);
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
  const conf = factionConfFor(state);
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
    /* ★ P61-S5：难度四档随开局名录下发，选择后写 knobs */
    difficulties: difficultyList().map((d) => ({
      id: d.id, label: d.label, desc: d.desc, targetWinRate: d.targetWinRate,
    })),
  };
}

/**
 * 择主定都：选中的诸侯名下城池全部易帜归 player，都城即玩家本城，
 * 初始武将团 3 员入营，势力特技自此生效（oath.js 提供数值面）。
 */
/** ★ P61-S5：四档难度定义（只读配置）；未知名回落到常规档。 */
let difficultyLevels = null;
export function difficultyList() {
  if (difficultyLevels) return difficultyLevels;
  try {
    const doc = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'difficulties.json'), 'utf8'));
    difficultyLevels = Array.isArray(doc.levels) ? doc.levels : [];
  } catch {
    difficultyLevels = [];
  }
  return difficultyLevels;
}

export function applyDifficulty(state, id) {
  const levels = difficultyList();
  const row = levels.find((x) => x.id === id) || levels.find((x) => x.id === 'normal');
  if (!row) return { ok: false, reason: 'no_difficulty' };
  state.difficulty = row.id;
  const applied = {};
  for (const [name, value] of Object.entries(row.knobs || {})) {
    applied[name] = knobSet(state, name, value).value;
  }
  return { ok: true, id: row.id, label: row.label, knobs: applied };
}

export function chooseOath(state, cfg, ctx = {}, { lord, city, difficulty } = {}) {
  if (!oathPending(state)) return { ok: false, code: 1, reason: 'already_done' };
  const conf = factionConfFor(state);
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
  /* ★ M3-4：everOwned 记账（举义划拨的城进 cityLost 口径） */
  const gainedIds = Object.entries(st.cities)
    .filter(([, row]) => row.owner === 'player')
    .map(([id]) => Number(id));
  st.everOwned = [...new Set([...(st.everOwned || []), ...gainedIds])];
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
  /* ★ P61-S5：举义时锁定难度，三个旋钮一次性写入存档，之后可在设置里重选。 */
  const diff = applyDifficulty(state, difficulty || state.difficulty);
  return {
    ok: true, lord: f.id, lordName: f.name, city: target.name,
    cities: transferred, generals: added, difficulty: diff.id, difficultyLabel: diff.label,
  };
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
  const lords = Object.fromEntries(factionConfFor(state).factions.map((f) => [f.id, f.name]));
  lords[factionConfFor(state).neutral.id] = factionConfFor(state).neutral.name;
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
    relations: Object.fromEntries(factionConfFor(state).factions
      .filter((f) => f.id !== factionId)
      .map((f) => [f.id, enemies.has(f.id) ? 'enemy' : (st.relations?.[`${factionId}|${f.id}`] || 'neutral')])),
    threat: {},
  };
}

/** 月度回合：每个有脑的诸侯决策一次并执行。 */
export function strategyTick(state, cfg, ctx, now = Date.now()) {
  const conf = factionConfFor(state);
  const st = ensureStrategy(state);
  /* ★ M2-3：旬长走参数表（参数表 turnDays），存档 knobs 可覆盖 */
  const turnDays = knobGet(state, 'turnDays') ?? conf.turnDays ?? 10;
  if (state.clock.day - st.lastTurnDay < turnDays) return null;
  st.lastTurnDay = state.clock.day;
  st.turn += 1;
  openMonth(state);
  // ★ P2/P3 城市经营：旬灾害（蝗/瘟/丰收）+ 旬忠诚/俸禄/叛逃 + 30日人口增长
  cityEconTick(state, cfg, ctx);
  /* ★ P50：物资任务层已删，物资去处回归 armory 即时动作；旬结算里不再有 advanceMaterialTasks。 */
  /* ★ 2026-11-17 城防：城墙每旬自然修复（被围不修）——否则打过一次就永久残破，
     城防属性从此失去意义。 */
  repairCityWalls(state);
  // ★ P6 俘虏：每旬思归/越狱演变
  captivesTick(state, ctx);
  // ★ P7 出仕：在野贤才按名声主动来投
  defectTick(state, cfg, ctx);
  /* ★ M3-4 事件系统（本作设计）：每旬冷却递减 → 条件筛 → pendingEvents 队列（弹窗层消费） */
  const evTick = strategyEventTick(state);
  if (evTick) st.lastEventTick = evTick;

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
      /* ★ P15 讨伐冷却记账：目标确为玩家城 → 记 lastPlayerAtk，playerOption 歇 6 旬 */
      const gm = st.memory?.[f.id]?.goal;
      if (gm && gm.type === '削弱' && st.cities[Number(gm.target)]?.owner === 'player') {
        st.memory[f.id].lastPlayerAtk = st.turn;
      }
    }
    /* ★ M2-4 外交（本作设计 请求攻击）：玩家付定金后，把一单真实出征塞进该势力
       本旬指令单（走 applyOrders 既有结算口，可审计）。目标=对方邻接的、
       目标势力最弱的城；attitude < 70 视为口头答应（betray），不保证出兵质量。 */
    const prompt = st.diploPrompt;
    const nowDay = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
    if (prompt && prompt.faction === f.id) {
      if ((Number(prompt.until) || 0) < nowDay) {
        delete st.diploPrompt;
      } else {
        const ownCities = Object.keys(st.cities).filter((cid) => st.cities[cid].owner === f.id);
        const foeCities = Object.keys(st.cities)
          .filter((cid) => st.cities[cid].owner === prompt.target)
          .map(Number)
          .sort((a, b) => st.cities[a].troops - st.cities[b].troops);
        let picked = null;
        for (const foe of foeCities) {
          const fromCity = ownCities.find((cid) => canMarchBetween(Number(cid), foe).ok);
          if (fromCity) { picked = { from: Number(fromCity), to: foe }; break; }
        }
        if (picked) {
          sheet.strategy_orders = Array.isArray(sheet.strategy_orders) ? sheet.strategy_orders : [];
          sheet.strategy_orders.push({
            type: '出征', target: picked.to, expect: '应盟约之请',
            params: { fromCity: picked.from, troops: Math.min(2200, Math.round(st.cities[picked.from].troops * 0.6)), reserve: 300 },
          });
        }
      }
    }
    const applied = applyOrders(state, cfg, ctx, f, sheet);
    /* ★ P16：名册人事层（学战法/招募/俘虏/挖角/求援），每旬每势力一次，
       与指令单执行同源同种子；战斗经验另由 aiRosterGrantExp 在战果处入账。 */
    const rosterNotes = aiRosterTurn(state, cfg, ctx, f, conf, st.turn);
    const res = st.resources[f.id];
    const mine = (st.draft?.moves || []).filter((m) => m.faction === f.id);
    const last = mine[mine.length - 1];
    if (last && res) { last.grainEnd = res.grain; last.goldEnd = res.gold; }
    results.push({ faction: f.id, sheet, orders: sheet.strategy_orders?.length || 0, ...applied, rosterNotes });
  }
  closeMonth(state);
  return { turn: st.turn, results };
}

/* ---------------------------------------------------------------- 决策脑
 * 战役规划在 strategy-brain.js。这里只留同名入口，指令单协议不变。
 * 外部若注入 state.brainRunner，仍可整段替换。
 */
export function localBrain(faction, snapshot, state) {
  const conf = factionConfFor(state).factions.find((f) => f.id === faction.id) || faction;
  return planCampaign(conf, snapshot, state || {});
}

/* ---------------------------------------------------------------- P16 名册人事层
 * 每个有地势力每旬：学战法 → 登庸在野 → 俘虏招降/释放 → 挖角 → 弱方求援。
 * 全部确定性（rngFor(seed, turn, tag)），记入天下日志/军情，玩家可见可审计。
 */
function aiRosterTurn(state, cfg, ctx, faction, conf, turn) {
  const rosterConf = { ...conf, personas: PERSONA_AXES };
  const notes = [];
  /* ★ 2026-11-16：先按旬练兵治政累积功勋、晋官、长经验——诸侯不再原地踏步。 */
  for (const n of aiRosterCultivateTick(state, rosterConf, cfg, faction, turn)) {
    if (n.kind === '升官') {
      recordEvent(state, `${faction.name}麾下${n.name}治政有功，晋为${n.rankName}（功勋官阶 ${n.rank}）。`, { quiet: true });
    }
    notes.push(n);
  }
  for (const n of aiRosterLearnTick(state, rosterConf, cfg, faction, turn)) {
    recordEvent(state, `${faction.name}麾下${nameOfCfg(state, cfg, n.cfgId)}习得新战法（${skillById(n.skillId)?.name || n.skillId}）。`, { quiet: true });
    notes.push(n);
  }
  const rec = aiRecruitTick(state, rosterConf, cfg, faction, turn);
  if (rec) {
    if (rec.kind === '登庸') {
      recordEvent(state, `${faction.name}遣使登庸在野贤才${rec.name}，礼金入帐，已列入帐下。`, { quiet: true });
      noteMove(state, { kind: '登庸', faction: faction.id, who: faction.name, cfgId: rec.cfgId, name: rec.name });
    } else {
      recordEvent(state, `${faction.name}欲招${rec.name}，对方未允。`, { quiet: true });
    }
    notes.push(rec);
  }
  for (const n of aiCaptiveTick(state, rosterConf, cfg, faction, turn)) {
    if (n.kind === '招降') recordEvent(state, `${faction.name}招降俘虏${n.name}，编入名册。`, { quiet: true });
    else if (n.kind === '释俘') recordEvent(state, `${faction.name}释放俘虏${n.name}归乡。`, { quiet: true });
    notes.push(n);
  }
  const poach = aiPoachTick(state, rosterConf, cfg, faction, turn);
  if (poach) {
    if (poach.kind === '挖角') {
      const to = poach.from === 'player' ? '我军' : (nameOfFaction(state, poach.from));
      /* 玩家自己的将被挖走是大事，必须进事件流；NPC 之间互相挖角只是背景音。 */
      recordEvent(state, `【挖角】${faction.name}以厚礼招揽${to}的${poach.name}，已易旗。`, { quiet: poach.from !== 'player' });
      noteMove(state, { kind: '挖角', faction: faction.id, who: faction.name, cfgId: poach.cfgId, name: poach.name, from: poach.from });
      ctx?.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg: `【人事】${faction.name}挖走了${to}的${poach.name}。`, time: Date.now() });
    } else {
      recordEvent(state, `${faction.name}欲挖${nameOfCfg(state, cfg, poach.cfgId)}，未果，对方反生戒心。`, { quiet: true });
    }
    notes.push(poach);
  }
  const aid = aiAidRequest(state, rosterConf, faction, turn, state.strategy);
  if (aid) {
    recordEvent(state, `【求援】${aid.who}仅余 ${aid.cities} 城 ${aid.troops} 兵，遣使向${aid.friends.map((x) => nameOfFaction(state, x)).join('、')}求援。`);
    noteMove(state, { kind: '求援', faction: faction.id, who: faction.name, friends: aid.friends, cities: aid.cities, troops: aid.troops });
    // 盟友派援：用既有驰援行军管线（dispatchRelief），目标=求援方最弱的城
    const weakest = aid.citiesRows?.length
      ? aid.citiesRows.slice().sort((a, b) => (state.strategy.cities[a].troops || 0) - (state.strategy.cities[b].troops || 0))[0]
      : Object.keys(state.strategy.cities).filter((id) => state.strategy.cities[id].owner === faction.id)
        .sort((a, b) => (state.strategy.cities[a].troops || 0) - (state.strategy.cities[b].troops || 0))[0];
    for (const fid of aid.friends) {
      const ally = conf.factions.find((f) => f.id === fid);
      if (!ally || weakest == null) continue;
      const fakeIncoming = { troops: 2600, arriveDay: (Math.floor(state.clock?.day) || 1) + 4 };
      dispatchRelief(state, ctx, ally, Number(weakest), fakeIncoming,
        strategyMap().cities.find((c) => c.id === Number(weakest)), state.strategy.cities[weakest],
        Math.max(1, Math.floor(state.clock?.day) || 1));
    }
    notes.push(aid);
  }
  return notes;
}

function nameOfCfg(state, cfg, cfgId) {
  return cfg?.generalByCfg?.get?.(Number(cfgId))?.name || `武将${cfgId}`;
}
function nameOfFaction(state, fid) {
  if (fid === 'player') return '玩家';
  const f = factionConfFor(state).factions.find((x) => x.id === fid);
  return f?.name || fid;
}

/* ---------------------------------------------------------------- 双账本
 * M2「切断写入」：田赋粮按城写入 cityEcon.store（粮留城），金全额上缴国库。
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
    st.cityEcon[target].store = Math.min(storeCapOf(st.cityEcon[target]), st.cityEcon[target].store + n);
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
    if (e) e.store = Math.min(storeCapOf(e), e.store + g);   // 粮留城库（本作设计；★ P13 上限随人口）
    grain += g;
    gold += 60 + Math.round((c.attrs?.商业 ?? 40) * 1.2);
  }
  res.gold += gold;
  refreshGrainSummary(state, factionId);
  return { grain, gold };
}

/* ---------------------------------------------------------------- 执行层 */
/** 天下大事记。保留整局 200 条（旧实现 50 条滚动截断，读档后本局早先的转折全没了）。 */
/** 事件书写。默认进玩家事件流（st.events，上限 480 条）。
 *  ★ 2026-11-20：加 quiet 通道。诸侯麾下的官阶晋升 / 习得战法 / 积功升级
 *  属于「世界在动」的背景音，不该占据玩家的军情流——实测 150 旬 480 条事件里
 *  大部分是「某某晋为中郎将」，玩家自己的战事被挤掉了。现在这类写 st.dynamics
 *  （上限 120 条，战略页单独一栏「势力动态」展示），玩家事件流只留与我有关的。 */
export function recordEvent(state, text, opts) {
  const st = state.strategy;
  if (opts && opts.quiet) {
    if (!Array.isArray(st.dynamics)) st.dynamics = [];
    st.dynamics.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
    while (st.dynamics.length > 120) st.dynamics.shift();
    return;
  }
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
      /* ★ 2026-11-18：difficultyAi 旋钮此前只有定义、无消费点（存档调难度时 AI 强度不变）。
         接入唯一明确的 AI 强度轴：征兵量随难度倍率缩放（默认 1.0 = 原样，
         高难度 AI 多征兵、低难度少征兵），成本随之，不改原表。 */
      const aiMul = Number(knobGet(state, 'difficultyAi')) || 1;
      const count = Math.max(0, Math.round((Number(order.params?.count) || 0) * aiMul));
      /* ★ M2-3：征兵成本走参数表（参数表 conscriptGoldPer） */
      const cost = count * knobGet(state, 'conscriptGoldPer');
      if (count > 0) {
        const own = Object.keys(st.cities).filter((id) => st.cities[id].owner === faction.id);
        const want = order.params?.cityId != null ? String(order.params.cityId) : '';
        const home = (want && st.cities[want]?.owner === faction.id) ? want : own.slice().sort((a, b) => st.cities[a].troops - st.cities[b].troops)[0];
        /* 双账本：征兵粮从城库扣（优先征兵城），全国账只读汇总（本作设计） */
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
      if (order.expect) recordEvent(state, `${faction.name}${order.expect}`, { quiet: true });
    } else if (order.type === '固守') {
      if (order.expect) recordEvent(state, `${faction.name}${order.expect}`, { quiet: true });
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
          recordEvent(state, `${faction.name}欲出兵${target.name}，${quote.reason || '粮饷不足'}，未发兵。`, { quiet: true });
          continue;
        }
        /* 双账本：出征粮饷从城库扣（优先出发城），金从国库扣（本作设计） */
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
        /* ★ M2-4 外交（本作设计）：停战期内 NPC 守约不进犯——履约是态度公式的一部分 */
        if (truceActive(state, faction.id, 'player')) {
          noteMove(state, { kind: '停战', faction: faction.id, who: faction.name, result: '守约', toName: target.name });
          recordEvent(state, `${faction.name}与我有停战之约，按兵不进${target.name}。`);
          continue;
        }
        // 打玩家的城：换算成本地地图来犯军，走既有战报
        const spawned = spawnFactionAssault(state, cfg, ctx, faction, target, troops, drawn?.fromId);
        if (!spawned) {
          /* 场上已有 2 支该势力来犯军，不再生成——把抽出来的兵退回出发城，不白扣。 */
          if (drawn?.fromId && st.cities[drawn.fromId]) {
            const row = st.cities[drawn.fromId];
            row.troops = Math.max(0, (Number(row.troops) || 0) + troops);
          }
          continue;
        }
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
        /* ★ M2-4 外交：NPC 占城登记（归属变更前取旧主） */
        noteCityCaptured(state, faction.id, prevOwner);
        defender.owner = faction.id;
        // 留下能守住的兵，不再把新城抽成全图最软的目标
        defender.troops = Math.max(420, Math.round(troops * 0.62));
        applied.captured.push(target.name);
        noteBattleOutcome(state, faction.id, { cityId: targetId, ok: true });
        noteCityLost(state, prevOwner, targetId, faction.id);
        noteMarch(state, faction, order, target, { troops: prevTroops }, quote, '克', defender.troops, drawn);
        /* ★ P16：攻城胜方名册武将获得经验（升级走 applyGeneralExp 同源口径） */
        const atkRoster = state.strategy?.rosters?.[faction.id]?.generals || [];
        if (atkRoster.length) {
          const winRatio = prevTroops > 0 ? Math.max(0, Math.min(1, (prevTroops - defender.troops) / prevTroops)) : 0.5;
          const expEach = 60 + Math.round(winRatio * 90);
          const expMap = Object.fromEntries(atkRoster.map((g) => [g.cfgId, expEach]));
          const ups = aiRosterGrantExp(state, cfg, faction.id, expMap);
          for (const u of ups) recordEvent(state, `${faction.name}麾下${u.name}积功升至 ${u.to} 级。`, { quiet: true });
          /* ★ 2026-11-16：攻城算大功，名册武将记功勋并按功晋官（守土/治政见 cultivateTick）。 */
          const meritEach = 16 + Math.round(winRatio * 20);
          for (const g of atkRoster) {
            const before = g.rank || 0;
            const mr = grantMerit(g, meritEach);
            if (mr.promoted) {
              const name = cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || `武将${g.cfgId}`;
              recordEvent(state, `${faction.name}麾下${name}积功封为${mr.rank >= 7 ? '将军' : '校尉'}（功勋 ${mr.merit}）。`, { quiet: true });
            }
          }
        }
        const line = order.expect
          ? `${faction.name}${order.expect}，遂克${target.name}。`
          : `${faction.name}自${ownerNameOf(state, prevOwner)}手中攻陷${target.name}（${target.province}）`;
        recordEvent(state, line);
        /* ★ P16：击破守军后按歼敌比俘虏对方名册武将（玩家不在此列，走既有 b_d_general 路径） */
        if (prevOwner !== 'player' && prevOwner !== 'han') {
          const ratio = prevTroops > 0 ? Math.max(0, Math.min(1, (prevTroops - defender.troops) / prevTroops)) : 0.8;
          const caps = aiCaptureTick(state, cfg, faction.id, prevOwner, targetId, ratio, state.clock?.day || 1);
          for (const c of caps) {
            recordEvent(state, `${faction.name}于${target.name}俘获${ownerNameOf(state, prevOwner)}将「${nameOfCfg(state, cfg, c.cfgId)}」。`);
          }
        }
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
  return factionConfFor(state).factions.find((f) => f.id === factionId)?.name || factionId;
}

/** 归属方显示名：玩家 / 汉廷 / 诸侯。 */
function ownerNameOf(state, ownerId) {
  const conf = factionConfFor(state);
  if (ownerId === 'player') return playerIdentity(state, conf).name;
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
  /* 同势力在场上限 2 支来犯军：多了只会糊地图，不会增加压力。 */
  const onField = (state.garrisons || [])
    .filter((g) => g.faction === faction.id && !g.cleared).length;
  if (onField >= 2) return null;
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
    /* ★ 2026-11-20：记住「本来要打哪座城」。旧版围城用 nearestPlayerCity 现算，
       而营地摆在 target.x+2，两城相邻时经常围到另一座城上——战报说打定陶、
       实际围的是陈留，玩家完全看不懂。现在以出发时的目标为准，查不到才回落近邻。 */
    targetCity: Number(targetCity?.id) || 0,
    /* ★ 2026-11-19：记录出现日，围城倒计时从这里算起。 */
    spawnDay: departDay,
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

/* ---------------------------------------------------------------- 分段目标
 * ★ 2026-11-19 玩法修复：八幕剧本只有序章可玩（acts.json 其余 playable=false），
 *   进沙盘后玩家只剩「统一全国」这一个远期目标，中间 60 旬没有任何锚点。
 *   这里补三个沙盘里程碑（不写剧情，只给目标与结算），让中局有节奏。
 */
/* ★ 2026-11-20：常量搬到零依赖叶子 domain/stage-goals.js（panels 也要用）。
   注意：`export ... from` 只转出、不建立本地绑定，本文件内部要用必须同时 import。 */
import {
  STAGE_GOALS, UNIFY_CITIES, SANDBOX_ENDING,
  GRAND_UNIFY_CITIES, GRAND_ENDING, nextStageGoal,
} from './stage-goals.js';
export { STAGE_GOALS, UNIFY_CITIES, SANDBOX_ENDING, nextStageGoal };

export function stageGoalTick(state, cfg, ctx) {
  const st = ensureStrategy(state);
  if (!st.stages || typeof st.stages !== 'object') st.stages = {};
  const owned = Object.values(st.cities || {}).filter((r) => r && r.owner === 'player').length;
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const hit = [];
  for (const s of STAGE_GOALS) {
    if (owned < s.at || st.stages[s.id]) continue;
    st.stages[s.id] = day;
    /* ★ 2026-11-20：里程碑不再只是一行字。达成即发实际收益，
       玩家能感到「扩城是有回报的」，而不是只收到一条播报。 */
    const gains = [];
    if (s.gold) {
      state.roleRes.gold = Math.round((Number(state.roleRes.gold) || 0) + s.gold);
      gains.push(`金 +${s.gold}`);
    }
    if (s.fame) {
      st.fame = Math.min(FAME_DEFECT_CAP * 2, Math.round((Number(st.fame) || 0) + s.fame));
      gains.push(`名望 +${s.fame}`);
    }
    if (s.seats) {
      st.bonusSeats = Math.round(Number(st.bonusSeats) || 0) + s.seats;
      gains.push(`帐下编制 +${s.seats}`);
    }
    const gainTxt = gains.length ? `（${gains.join('，')}）` : '';
    recordEvent(state, `【${s.title}】${s.hint}${gainTxt}`);
    ctx.push?.('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【里程碑·${s.title}】${s.hint}${gainTxt}`,
      time: Date.now(),
    });
    ctx.push?.('roleRes.push', { ...state.roleRes });
    hit.push({ id: s.id, title: s.title, at: s.at, gains });
  }
  /* 沙盘终局：一统即结算，不硬性中断（玩家可以继续经营或退出看总览）。 */
  if (owned >= UNIFY_CITIES && !st.sandboxEnding) {
    st.sandboxEnding = {
      id: SANDBOX_ENDING.id, title: SANDBOX_ENDING.title,
      day, turn: st.turn ?? 0, cities: owned,
      generals: (state.generals || []).length,
      battles: Array.isArray(st.battleHistory) ? st.battleHistory.length : 0,
    };
    recordEvent(state, `【${SANDBOX_ENDING.title}】${SANDBOX_ENDING.hint}第 ${day} 日，${owned} 城尽入我手。`);
    ctx.push?.('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【${SANDBOX_ENDING.title}】${SANDBOX_ENDING.hint}（第 ${day} 日 · ${owned} 城 · 帐下 ${(state.generals || []).length} 人）`,
      time: Date.now(),
    });
    hit.push({ id: 'unify', title: SANDBOX_ENDING.title, at: owned });
  }
  /* ★ P61-S6：真正的终局——30 城写唯一真源 grandEnding、生成史评并冻结回合。
     24 城的「称帝」只是阶段里程碑，不再冒充结局。 */
  if (owned >= GRAND_UNIFY_CITIES && !st.grandEnding) {
    const decisions = (st.events || [])
      .filter((e) => ['举义', '攻陷', '迁都', '背盟', '结盟', '裁军', '招抚'].some((k) => (e.text || '').includes(k)))
      .slice(-5).map((e) => e.text);
    st.grandEnding = {
      id: GRAND_ENDING.id, title: GRAND_ENDING.title,
      day, turn: st.turn ?? 0, cities: owned,
      generals: (state.generals || []).length,
      battles: Array.isArray(st.battleHistory) ? st.battleHistory.length : 0,
      fame: Math.round(Number(st.fame) || 0),
      decisions,
      history: `第 ${day} 日，${owned} 城入版图，群雄尽退。帐下 ${(state.generals || []).length} 人，历经 ${st.battleHistory?.length || 0} 战，名望 ${Math.round(Number(st.fame) || 0)}。`,
    };
    st.endGameFrozen = true;
    recordEvent(state, `【${GRAND_ENDING.title}】${st.grandEnding.history}`);
    ctx.push?.('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【终局·${GRAND_ENDING.title}】${GRAND_ENDING.hint}`,
      time: Date.now(),
    });
    hit.push({ id: GRAND_ENDING.id, title: GRAND_ENDING.title, at: owned });
  }
  return hit;
}

/** ★ P61-S6：玩家在终局史评页显式选择「继续沙盘」才解除冻结，不自动续局。 */
export function strategyContinueSandbox(state, ctx) {
  const st = ensureStrategy(state);
  if (!st.grandEnding) return { ok: false, reason: 'no_ending' };
  st.endGameFrozen = false;
  st.sandboxResumed = true;
  recordEvent(state, '【终局·续局】主公决意继续经营沙盘，史评既定，岁月再启。');
  ctx?.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0, msg: '已解除回合冻结，可继续经营（史评保留）。', time: Date.now(),
  });
  return { ok: true, title: st.grandEnding.title };
}

/* ---------------------------------------------------------------- 围城压力
 * ★ 2026-11-19 玩法修复（用户：「修复所有问题」）。
 *   旧实现里诸侯来犯只是在家门口摆一支「XX军」野战军（spawnFactionAssault），
 *   玩家完全不理它也没有任何后果——实测挂机 60 旬，5 座城一座不失，
 *   世界对玩家零压力。现在给来犯军加一条围城倒计时：
 *     · 出现后 40 日内不动它：城进入 besieged（产出减半，cityYield 已消费该字段）；
 *     · 围城每旬：守军按围攻兵力占比逃散、民心 −5、治安 −1；
 *     · 守军归零 或 民心 ≤ 20（城内开门）：城破，归该势力；
 *     · 玩家把野战军清剿掉：围城立即解除（不夺城，只惩罚不作为）。
 *   全程只读 state.garrisons / strategy.cities，不新建实体、不改协议。
 *
 * ★ 2026-11-20 自迭代第二轮：上一版围城是「死机制」。
 *   损耗写死 2%/旬，但 120 日就粮尽自退 → 围城最多 8 旬，累计只掉 15% 守军，
 *   而守军 1800 → 城永远破不了，`fallen` 分支是死代码。
 *   实测 80 旬内 AI 对玩家出兵 2 次（刘备），两次都只是「围一下就走」。
 *   现在改成三条并行压力，并且撤围时间放宽到 180 日：
 *     · 兵力：p = clamp(3% + 6% × 围攻方兵力占比, 3%, 9%)/旬，兵多破得快；
 *     · 民心：−5/旬，民心 ≤ 20 直接开城（民心崩比杀光守军更早到，符合史实直觉）；
 *     · 治安：−1/旬，治安崩会连带流寇事件。
 *   于是「放着不管」≈ 100~140 日丢城，玩家有明确的解围窗口。
 */
/* 常量与威胁映射已迁至 threat-view.js（本文件顶部 import 并 re-export），
   见 17.22 / FIELD-CONTRACT：六府与沙盘必须同源，否则六府页看不到围城预警。 */
export const SIEGE_GATE_OPEN_MORALE = 20;

function playerCityRows(st) {
  return Object.entries(st.cities || {})
    .filter(([, row]) => row && row.owner === 'player')
    .map(([id, row]) => ({ id: Number(id), row }));
}

/** 找离某点最近的玩家城（用战略地图坐标；查不到按 id 最小兜底）。 */
function nearestPlayerCity(st, x, y) {
  const rows = playerCityRows(st);
  if (!rows.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const r of rows) {
    const c = strategyMap().cities.find((c2) => c2.id === r.id);
    const d = c ? (Number(c.x) - Number(x)) ** 2 + (Number(c.y) - Number(y)) ** 2 : Infinity;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/** 来犯军围城推进：settleWorld 每旬调用一次（幂等，可重复调）。 */
export function assaultEscalationTick(state, cfg, ctx) {
  const st = ensureStrategy(state);
  const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const out = [];
  const aliveFactions = new Set();
  for (const g of state.garrisons || []) {
    if (!g.faction || g.cleared) continue;
    aliveFactions.add(String(g.faction));
    if (!Number.isFinite(Number(g.spawnDay))) g.spawnDay = today;
    /* 围城 SIEGE_MAX_DAYS 日仍未破：客军粮尽自退。否则不打不走的来犯军会在地图上无限堆积
       （实测 130 旬留下 19 支），既糊画面也让「清剿」失去意义。
       ★ 2026-11-20：120 → 180 日。旧值下围城只剩 8 旬，配合 2%/旬 损耗
       连一座 1800 守军的城都推不动，`fallen` 成了死代码。 */
    if (today - Number(g.spawnDay) >= SIEGE_MAX_DAYS) {
      g.cleared = true;
      const nm0 = strategyMap().cities.find((c) => c.id === (Number(g.targetCity) || nearestPlayerCity(st, g.x, g.y)?.id))?.name || '城下';
      recordEvent(state, `${g.name || '敌军'}围${nm0}日久，粮尽自退。`);
      out.push({ kind: 'withdraw', faction: g.faction });
      continue;
    }
    if (today - Number(g.spawnDay) < SIEGE_GRACE_DAYS) continue;
    /* 优先用出发时记下的目标城（见 spawnFactionAssault.targetCity），查不到才用近邻兜底。 */
    const aimed = Number(g.targetCity) || 0;
    const hit = (aimed && st.cities[aimed]?.owner === 'player') ? { id: aimed, row: st.cities[aimed] } : nearestPlayerCity(st, g.x, g.y);
    if (!hit) continue;
    const city = st.cities[hit.id];
    if (!city || city.owner !== 'player') continue;
    const nm = strategyMap().cities.find((c) => c.id === hit.id)?.name || cityName(hit.id);
    if (!city.besieged) {
      city.besieged = true;
      city.besiegedBy = g.faction;
      city.besiegeSince = today;
      recordEvent(state, `${g.name || '敌军'}围了${nm}：粮道商路受阻，产出减半。出兵清剿即可解围。`);
      ctx.push?.('chat.push', {
        rid: 0, nickName: '系统', type: 0,
        msg: `【军情】${g.name || '敌军'}围困${nm}，请速派兵清剿或运粮固守。`,
        time: Date.now(),
      });
      out.push({ kind: 'besiege', cityId: hit.id, city: nm, faction: g.faction });
    }
    /* ★ P40：围城损耗每 10 游戏日只扣一次。
       旧判据 `today % 10 === 0` 只在「每旬调一次」时成立；真实 settleWorld 由
       index.js 每 500ms 调用，同一天会连扣 120 次（民心 −480、守军瞬间归零），
       这是挂机探针里城池莫名速崩的根因。改用每支来犯军自己的旬步数作幂等键：
       同一步内重复调用不再重复扣，跨步才推进一次。 */
    const drainStep = Math.floor(Math.max(0, today - Number(g.spawnDay)) / 10);
    const lastStep = Math.max(0, Math.floor(Number(g.lastSiegeDrainStep) || 0));
    if (drainStep > lastStep) {
      g.lastSiegeDrainStep = drainStep;
      const defenders = Math.max(0, Number(city.troops) || 0);
      const attackers = Math.max(1, Number(g.soldiers) || 0);
      /* 围攻方兵力占比：兵越多逃散越快，3%~9%/旬封顶（不会一旬秒城） */
      const share = attackers / Math.max(1, attackers + defenders);
      const lossPct = Math.max(0.03, Math.min(0.09, 0.03 + 0.06 * share));
      city.troops = Math.max(0, Math.round(defenders * (1 - lossPct)));
      const e = st.cityEcon?.[hit.id];
      if (e) {
        /* 民心 -4/旬（cityDevTick 对被围城另有 -3，实际约 -7/旬）→ 70 起步约 7 旬开城，
           50 起步约 4~5 旬。给玩家 4~7 回合的解围窗口，够反应也不至于毫无压力。 */
        e.morale = Math.max(0, (Number(e.morale) || 0) - 4);
        e.order = Math.max(0, (Number(e.order) || 0) - 1);
      }
    }
    /* 城破两条线：守军打光（饿殍/战殁），或民心崩到 20 以下（城内开门）。
       玩家都城失守由 ensureStrategy/failstate 既有链路兜底。 */
    const econ2 = st.cityEcon?.[hit.id];
    const gateOpen = econ2 && Number(econ2.morale) <= SIEGE_GATE_OPEN_MORALE;
    if ((Number(city.troops) || 0) <= 0 || gateOpen) {
      const prevOwner = city.owner;
      city.owner = g.faction;
      city.besieged = false;
      delete city.besiegedBy;
      delete city.besiegeSince;
      city.troops = Math.max(300, Math.round((Number(g.soldiers) || 0) * 0.6));
      g.cleared = true;
      noteCityCaptured(state, g.faction, prevOwner);
      noteCityLost(state, prevOwner, hit.id, g.faction);
      recordEvent(state, gateOpen && (Number(city.troops) || 0) > 0
        ? `${nm}被围既久，民心溃散，城内开门降于${g.name || '敌军'}。`
        : `${nm}守军耗尽，城陷于${g.name || '敌军'}。`);
      ctx.push?.('chat.push', {
        rid: 0, nickName: '系统', type: 0,
        msg: `【天下】${nm}失守，落入${g.name || '敌军'}之手。`,
        time: Date.now(),
      });
      out.push({ kind: 'fallen', cityId: hit.id, city: nm, faction: g.faction });
    }
  }
  /* 围城解除：围攻方已无存活野战军（被玩家清剿或已破城） */
  for (const [cid, row] of Object.entries(st.cities || {})) {
    if (!row || !row.besieged) continue;
    const still = row.besiegedBy && aliveFactions.has(String(row.besiegedBy));
    if (still) continue;
    row.besieged = false;
    delete row.besiegedBy;
    delete row.besiegeSince;
    /* ★ 2026-11-20：解围给一次民心回补（+8），否则被围过的城要几十旬才缓过来，
       玩家「出兵解围」的正反馈太弱。 */
    const eR = st.cityEcon?.[cid];
    if (eR) eR.morale = Math.min(100, Math.round(((Number(eR.morale) || 0) + 8) * 10) / 10);
    const nmR = strategyMap().cities.find((c) => String(c.id) === String(cid))?.name || cityName(Number(cid));
    recordEvent(state, `${nmR}之围已解，城中人心稍定（民心 +8）。`);
    out.push({ kind: 'relieved', cityId: Number(cid) });
  }
  /* 城破可能带走都城：统一在函数末尾兜一次，任何路径丢城都不会留下悬空的 playerCity。 */
  rebindCapitalIfLost(state, ctx);
  /* 城破也可能带走「部队驻地」：同一次兜底里回收，见 rebindArmiesIfStranded。 */
  rebindArmiesIfStranded(state, ctx);
  return out;
}

/** ★ 2026-11-20：部队驻地失效时回收残部。
 *
 *  根因：`army.cityId` 只在「行军抵达」的四个分支里被赋值（strategyResolveMarches），
 *  城被攻破时没有任何代码管它。于是出现这样一条死路——
 *    玩家部队驻陈留 → 陈留被围城打破 → playerCity 迁走（rebindCapitalIfLost 生效），
 *    但 army.cityId 仍然等于 7（敌城）→ 之后每一次 strategyAttack 都在
 *    `fromOk` 检查处返回 `{code:6, reason:'not_own_city'}`。
 *  实测：主动出征 150 旬，95 次出征请求全部 code 6，玩家一次都没能出兵，
 *  而地图上明明还有 4 座城、帐下 10 名武将 —— 这是**永久软锁**，不是数值问题。
 *
 *  处理：把驻地已不属于己方的部队退回「都城（若在）或守军最多的己方城」，
 *  同步武将 cityId（否则内政/委任仍指向敌城），并给一条提示。
 *  行军中（marchId 存在）的队伍跳过——抵达分支自会归位，硬改会打断行军。
 */
export function rebindArmiesIfStranded(state, ctx) {
  const st = state?.strategy;
  if (!st || !Array.isArray(state.armys) || !state.armys.length) return [];
  const own = Object.entries(st.cities || {})
    .filter(([, c]) => c && c.owner === 'player')
    .map(([id, c]) => ({ id: Number(id), troops: Number(c.troops) || 0 }));
  if (!own.length) return [];
  const home = own.find((c) => c.id === Number(st.playerCity))
    || own.slice().sort((a, b) => b.troops - a.troops)[0];
  const moved = [];
  /* ★ P55：多城失守时多支残部会涌进同一座 home 城。旧实现只改 cityId 不重排 order，
     于是一城之内出现 1,1,2,2…… 重复编号，army.dispose/myOne 的 find 永远只命中第一支，
     其余队伍在 UI 里彻底不可编辑。这里迁入后按该城现占用情况分配未用编号。 */
  const taken = new Set(
    state.armys.filter((a) => !a.marchId && Number(a.cityId) === home.id)
      .map((a) => Number(a.order)),
  );
  const freeOrder = () => {
    for (let o = 1; o <= 99; o += 1) if (!taken.has(o)) { taken.add(o); return o; }
    return 99;
  };
  for (const a of state.armys) {
    if (a.marchId) continue;
    const cid = Number(a.cityId) || 0;
    if (cid && st.cities[cid] && st.cities[cid].owner === 'player') continue;
    const hadSomething = (a.generals || []).some((g) => g) || (a.soldiers || []).some((n) => n > 0);
    a.cityId = home.id;
    a.order = freeOrder();
    syncGeneralsCity(state, a, home.id);
    moved.push({ armyId: a.id, from: cid, had: hadSomething });
  }
  if (moved.length) syncGeneralOrders(state);
  const real = moved.filter((m) => m.had);
  if (real.length) {
    const nm = strategyMap().cities.find((c) => c.id === home.id)?.name || cityName(home.id);
    recordEvent(state, `驻地失守，残部退守${nm}重新集结（部队已可再次出征）。`);
    ctx?.push?.('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【军情】驻地失守，残部已退守${nm}集结。请在此补兵后再图进取。`,
      time: Date.now(),
    });
  }
  return moved;
}

/** ★ 2026-11-20：都城失陷后自动迁都。
 *  旧实现里 st.playerCity 只在「城墙编号不存在」时才重绑，城被敌人打下来时不管。
 *  实测挂机 150 旬：陈留（都城）第 121 旬被袁绍攻破，之后 playerCity 一直指着敌方城池，
 *  failstate.capitalLost 从此恒为 true，而 makeGeneral 会把新武将塞进「本城」——
 *  也就是塞进敌国城里。玩家看到的是「招来的武将不见了」。
 *  这里改成：都城一丢，立刻迁到「守军最多的己方城」，并明确播报。
 *  没有己方城时不迁（亡国流程交给 failstate / 章节结局）。 */
export function rebindCapitalIfLost(state, ctx) {
  const st = state?.strategy;
  if (!st || !st.playerCity) return null;
  if (st.cities[st.playerCity]?.owner === 'player') return null;
  const own = Object.entries(st.cities || {})
    .filter(([, c]) => c && c.owner === 'player')
    .sort((a, b) => (Number(b[1].troops) || 0) - (Number(a[1].troops) || 0));
  if (!own.length) return null;
  const fromId = st.playerCity;
  st.playerCity = Number(own[0][0]);
  const toName = strategyMap().cities.find((c) => c.id === st.playerCity)?.name || cityName(st.playerCity);
  const fromName = strategyMap().cities.find((c) => c.id === Number(fromId))?.name || cityName(Number(fromId));
  recordEvent(state, `都城${fromName}失守，行在移驻${toName}——诸事仍可照常。`);
  ctx?.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【朝堂】都城${fromName}失守，已迁行在于${toName}。请重整旗鼓，或从外交上先稳住一方。`,
    time: Date.now(),
  });
  return { from: Number(fromId), to: st.playerCity, city: toName };
}

/* ---------------------------------------------------------------- 驰援
 * ★ P14 友军驰援（用户 2026-11-16）：玩家大军压境时，守城势力（及盟友）从邻城
 * 出援军回防——援军入城并进战略层兵力，会真实抬高 defenseFor 的守军折算；
 * 行军实体 side:'faction' 玩家可见，可在遭遇/推演里看到援军动向并应对。
 * 人格轴决定谁肯救：defense 过低（吕布）见死不救。 */

const RELIEF_MIN_SEND = 350;

/** ★ 2026-11-22：汉廷城也被邻近诸侯争夺——玩家打"空城"时不再一路无人过问。
 *  争夺者按种子+抵达日确定性挑选，复用同一条 dispatchRelief 驰援管线。 */
function reliefResponders(state, st, owner, targetId, incoming) {
  if (!owner || owner === 'player') return [];
  const conf = factionConfFor(state);
  if (owner !== 'han') {
    const out = [owner];
    for (const f of conf.factions) {
      if (f.id !== owner && isAllied(st, f.id, owner)) out.push(f.id);
    }
    return out;
  }
  const adj = marchableNeighbors(targetId, Object.keys(st.cities).map(Number)).map(Number);
  const candidates = [...new Set(adj
    .map((id) => st.cities[id]?.owner)
    .filter((id) => id && id !== 'player' && id !== 'han'))];
  if (!candidates.length) return [];
  const roll = rngFor(state.seed ?? 20261110, incoming?.arriveDay || 1,
    `contest:${targetId}:${incoming?.id || 0}`).random();
  const pick = candidates[Math.min(candidates.length - 1, Math.floor(roll * candidates.length))];
  return conf.factions.some((f) => f.id === pick) ? [pick] : [];
}

/** 每个结算日扫描来犯军：有玩家大军在途、且目标城是某诸侯（或其盟友）的城，
 *  就让该势力从邻城派一次援军。每支来犯军每势力至多援一次（mm.reliefBy）。 */
export function factionReliefTick(state, cfg, ctx) {
  const st = ensureStrategy(state);
  if (!Array.isArray(st.marches) || !st.marches.length) return [];
  const map = strategyMap();
  const conf = factionConfFor(state);
  const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const dispatched = [];
  for (const mm of st.marches) {
    if (mm.side !== 'player' || mm.resolved) continue;
    if (mm.kind === 'transport' || mm.kind === 'relief') continue;
    const targetId = Number(mm.to);
    const tstate = st.cities[targetId];
    if (!tstate) continue;
    const target = map.cities.find((c) => c.id === targetId);
    if (!target) continue;
    const daysLeft = mm.arriveDay - today;
    if (daysLeft < 1) continue;
    mm.reliefBy = mm.reliefBy || {};
    for (const fid of reliefResponders(state, st, tstate.owner, targetId, mm)) {
      if (mm.reliefBy[fid]) continue;
      const faction = conf.factions.find((f) => f.id === fid);
      if (!faction) continue;
      const done = dispatchRelief(state, ctx, faction, targetId, mm, target, tstate, today);
      if (done) {
        mm.reliefBy[fid] = true;
        dispatched.push({ faction: fid, to: targetId, troops: done });
      }
    }
  }
  return dispatched;
}

function dispatchRelief(state, ctx, faction, targetId, incoming, target, tstate, today) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const axes = PERSONA_AXES[faction.persona || faction.name] || PERSONA_AXES.曹操;
  if (axes.defense < 0.25) return 0;   // 好战无谋者见死不救（吕布）
  // 已有本势力未抵达的援军在途，不重复派
  if ((st.marches || []).some((x) => x.side === 'faction' && x.kind === 'relief'
    && x.factionId === faction.id && Number(x.to) === Number(targetId) && !x.resolved)) return 0;
  // 兵源：本势力所有可达邻城（★ P14 多城合援，单城援军太薄挡不住大军）
  const adj = marchableNeighbors(targetId, Object.keys(st.cities).map(Number)).map(Number);
  const sources = [];
  for (const id of adj) {
    if (!canMarchBetween(id, targetId).ok) continue;
    const row = st.cities[id];
    if (!row || row.owner !== faction.id) continue;
    const troops = Math.round(Number(row.troops) || 0);
    if (troops >= RELIEF_MIN_SEND + 240) {
      sources.push({ id, troops, arms: map.cities.find((c) => c.id === id)?.arms || '' });
    }
  }
  sources.sort((a, b) => b.troops - a.troops || a.id - b.id);
  if (!sources.length) return 0;
  // 每城拟发：压得动来犯军，又不把出发城抽空；至多两城合援
  const aiMul = Math.max(0.8, Math.min(1.4, Number(knobGet(state, 'difficultyAi')) || 1));
  const wantEach = Math.max(RELIEF_MIN_SEND, Math.round((Number(incoming.troops) || 0)
    * (0.55 + axes.defense * 0.45) / Math.min(2, sources.length) * aiMul));
  let totalSend = 0;
  for (const src of sources.slice(0, 2)) {
    const reserve = Math.max(320, Math.round(src.troops * (0.30 + axes.defense * 0.10)));
    const send = Math.min(Math.max(0, src.troops - reserve), wantEach);
    if (send < RELIEF_MIN_SEND) continue;
    const purse = st.resources[faction.id] || {};
    const quote = quoteMarch(src.id, targetId, send, src.arms, { grain: purse.grain || 0, gold: purse.gold || 0 });
    if (!quote.ok) continue;
    const spendG = spendFactionGrain(state, faction.id, quote.totalGrain, String(src.id));
    if (!spendG.ok) continue;
    const resG = st.resources[faction.id];
    resG.gold = Math.max(0, (resG.gold || 0) - quote.totalGold);
    st.cities[src.id].troops = Math.max(0, src.troops - send);
    /* 轻骑驰援：比常规行军快三成，且紧急军情下保证不晚于来犯军抵城 */
    const npcSpeed = 130;
    const km = marchKmBetween(src.id, targetId);
    const marchDays = Math.max(1, Math.min(marchDaysBy(km, npcSpeed), Math.max(1, incoming.arriveDay - today)));
    if (!Array.isArray(st.marches)) st.marches = [];
    st.marches.push({
      id: (st.marchSeq = (st.marchSeq || 0) + 1),
      side: 'faction', kind: 'relief', from: src.id, to: Number(targetId),
      departDay: today, arriveDay: today + marchDays,
      troops: send, km, speed: npcSpeed, marchDays,
      factionId: faction.id, factionName: faction.name || '',
      intel: 'precise',
    });
    totalSend += send;
    const srcName = map.cities.find((c) => c.id === src.id)?.name || '';
    recordEvent(state, `${faction.name}见${target.name}被围，自${srcName}发援军 ${send}，约 ${marchDays} 日抵城。`);
    noteMove(state, {
      kind: '驰援', faction: faction.id, who: faction.name, result: '在途',
      fromId: src.id, fromName: srcName, toId: target.id, toName: target.name,
      troops: send, li: quote.li || 0, days: quote.days || 0,
      totalGrain: quote.totalGrain || 0, totalGold: quote.totalGold || 0,
    });
    noteCity(state, targetId, {
      kind: '驰援',
      text: `${faction.name}自${srcName}发援军 ${send} 赴本城，约 ${marchDays} 日抵。`,
    });
    ctx.push?.('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【军情】${faction.name}自${srcName}出援军 ${send} 赴${target.name}，约 ${marchDays} 日抵达。`,
      time: Date.now(),
    });
  }
  return totalSend;
}

/** 驰援到达：城还在本方手里就并兵入守（真实抬高守军折算）；城已易主则扑空折返。 */
function resolveReliefArrival(state, ctx, mm, map) {
  const st = ensureStrategy(state);
  const targetId = Number(mm.to);
  const tstate = st.cities[targetId];
  const target = map.cities.find((c) => c.id === targetId);
  if (!tstate || !target) return;
  const send = Math.max(0, Math.round(Number(mm.troops) || 0));
  const toName = target.name;
  const who = mm.factionName || otherName(state, mm.factionId);
  if (tstate.owner === mm.factionId || isAllied(st, tstate.owner, mm.factionId)) {
    tstate.troops = Math.max(200, Math.round((Number(tstate.troops) || 0) + send));
    recordEvent(state, `${who}的援军 ${send} 人入${toName}城，守军增至 ${tstate.troops}。`);
    noteCity(state, targetId, { kind: '驰援', text: `${who}援军 ${send} 入城，守军增至 ${tstate.troops}。` });
    ctx.push?.('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【军情】${who}援军抵达${toName}，守军增至 ${tstate.troops}。`,
      time: Date.now(),
    });
  } else {
    const back = st.cities[Number(mm.from)];
    const ret = Math.round(send * 0.7);
    if (back && back.owner === mm.factionId) {
      back.troops = Math.max(200, Math.round((Number(back.troops) || 0) + ret));
      recordEvent(state, `${who}驰援${toName}扑空，残部 ${ret} 退回。`);
    } else {
      recordEvent(state, `${who}驰援${toName}扑空，援军溃散。`);
    }
    noteCity(state, targetId, { kind: '驰援', text: `${who}驰援扑空（城已易主）。` });
  }
}

/* ---------------------------------------------------------------- 相遇
 * ★ P62：把「两军撞上了」做成地图上看得见的事，而不是只在面板里写一行字。
 *
 * 判定在 domain/clash.js（零依赖纯函数）：城下会战 = 援军与玩家军同指一城、
 * 抵达日相近；道中遭遇 = 两军走同一段路相向而行、时间窗交叠。
 * 这里只负责两件事：新相遇记一条军情（按「日 + 双方 id」去重，不会每次请求刷屏）、
 * 留最近 20 条供军情页回看。
 *
 * 刻意不扣兵、不改战果：援军抵达后已并进守军折算（defenseFor），来犯军的压力由
 * 围城推进承担；相遇如果再扣一次，同一支部队就被算了两次。
 */
export function clashTick(state, cfg, ctx) {
  const st = ensureStrategy(state);
  if (!Array.isArray(st.marches) || st.marches.length < 2) return [];
  const map = strategyMap();
  const cities = {};
  for (const c of map.cities) cities[c.id] = c;
  const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const list = detectClashes({ marches: st.marches, cities, routes: map.routes, today });
  if (!list.length) return [];
  if (!Array.isArray(st.clashes)) st.clashes = [];
  const seen = new Set(st.clashes.map((c) => c.key));
  const fresh = list.filter((c) => !seen.has(c.key));
  if (!fresh.length) return [];
  st.clashes = [...st.clashes, ...fresh].slice(-20);
  for (const c of fresh) {
    recordEvent(state, `${c.text}（第 ${c.day} 日）`);
    ctx?.push?.('march.clash', c);
  }
  return fresh;
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

/** 守军将领：按城池 id + 势力 + 等级确定性分配（M4-13）。
 *  ★ 单位数与城池等级挂钩（小城 1 将 / 郡城 2 将 / 州治 3 将）：
 *    旧实现一律 3 将，玩家开局只有主公 1 将，1v3 必然被集火打死，
 *    第一场仗怎么打都是败（试玩 P0-3）。
 *  ★ M4-13：旧代码写死 `npc_army.armys[level-1].army[0].cfgIds.slice(0,unitCount)`，
 *    而那份配置全表只有 100002~100006 六个值、7/8 个等级完全相同，导致
 *    1 级城永远只有「十常士」一个守将，换任何城都是同一批人。
 *    现在改由 domain/garrison.js 从全表 505 位按城池哈希取将，
 *    npc_army.json 只保留兵力/等级语义。同一座城反复攻打守将恒定
 *    （推演与正式结算必须一致），不同城不会撞名。 */
function defenseFor(cfg, cityId, target, tstate, level, state = null) {
  const conf = factionConf();
  const faction = conf.factions.find((f) => f.id === tstate.owner);
  const name = tstate.owner === 'han' ? conf.neutral.name : (faction?.name || '守军');
  const exclude = [
    ...(state?.generals || []).map((g) => Number(g.cfgId)),
    ...(state?.captives || []).map((c) => Number(c.cfgId)),
  ];
  /* ★ P16：名册优先——有持久武将就用他们的真实等级/战法（学战法、升级才有意义）；
     名册为空（旧档/汉廷）仍走原 hash 生成，保持 M4-13 确定性与战报 UI 白名单。 */
  /* ★ 平衡契约（P0-3「首战可胜」）：1 级城守军必须维持原 hash 强度——名册里是
     张飞/夏侯惇这类顶级武将，2 级顶替 3 级 hash 弱将会让新手第一仗打不动。
     故名册只在 level≥2 的城市顶替，1 级城仍走原 hash（成长后的名册武将在中后期登场）。 */
  const rosterGens = level >= 2
    ? rosterDefenders(state, cfg, tstate.owner, cityId, level, exclude) : [];
  const cfgIds = garrisonCfgIds(cfg, {
    cityId, owner: tstate.owner, level, exclude,
    preferNames: faction?.startGenerals || [],
  });
  const useRoster = rosterGens.length > 0 && rosterGens.length === Math.max(1, Math.min(3, level >= 3 ? 3 : (level === 2 ? 2 : 1)));
  const unitCount = useRoster ? rosterGens.length : cfgIds.length;
  const slotTroops = Math.max(1, Math.ceil(tstate.troops / unitCount));
  return {
    generals: useRoster ? rosterGens : cfgIds.map((cfgId, k) => ({
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
 * 取某城的城墙状态 —— 城防与攻城属性的落地载体（2026-11-17）。
 * 纯读：旧档没有 wallHp 时按「完整城墙」返回，口径与升级前一致（守军 1.5× 城防）。
 * 上限由「等级 + 城防属性」派生（battle.js wallMaxOf 是唯一口径）。
 */
export function cityWall(state, cityId) {
  const id = Number(cityId);
  const row = state.strategy?.cities?.[id];
  if (!row) return null;
  const target = strategyMap().cities.find((c) => c.id === id);
  const max = wallMaxOf(target, target?.level ?? 1);
  const raw = Number(row.wallHp);
  const hp = Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.round(raw))) : max;
  return { hp, max };
}

/**
 * 攻城战结束后把城墙损耗写回城池。破城 → 城墙归零、城防属性下滑
 * （`defense` 是 AI 估算战力与面板展示的口径，破城后该城明显更好打）。
 */
export function applySiegeResult(state, cityId, siege) {
  const id = Number(cityId);
  const row = state.strategy?.cities?.[id];
  if (!row || !siege) return null;
  row.wallMax = Math.max(1, Number(siege.max) || Number(row.wallMax) || 1);
  row.wallHp = Math.max(0, Math.min(row.wallMax, Math.round(Number(siege.hpAfter) || 0)));
  /* 城防设施只毁一次：`wallRubble` 记「城墙已成瓦砾」，修复到一半以上才复位。
     否则每旬修回 2% 立刻再破一次，defense 会无下限往下掉。 */
  if (siege.breached) {
    if (!row.wallRubble) {
      row.defense = Math.max(0.1, Math.round(((Number(row.defense) || 0.4) - 0.12) * 100) / 100);
      recordEvent(state, `${cityName(id)}城墙崩塌，城防设施残破，守势大损。`);
    }
    row.wallRubble = true;
  }
  return { hp: row.wallHp, max: row.wallMax, breached: !!siege.breached };
}

/** 视图用：某城的城墙四件套（上限/当前/百分比/是否已破），纯读不写档。 */
function wallFieldsOf(state, city) {
  const row = state.strategy?.cities?.[city.id];
  const max = wallMaxOf(city, city?.level ?? 1);
  const raw = Number(row?.wallHp);
  const hp = Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.round(raw))) : max;
  return {
    wallHp: hp,
    wallMax: max,
    wallPct: Math.round((hp / max) * 100),
    wallBreached: hp <= 0,
  };
}

/**
 * 每旬城墙修复（被围不修）：让「打一半撤走」不白费，也避免城防永久归零。
 * ★ 2026-11-18 经济闭环：玩家城修复要花石头（WALL.stonePerHp 石/点），石头不足
 *   按比例少修，不再凭空 +2%；NPC 城仍自然修复（否则 NPC 城破一次就永久残废，
 *   且 NPC 不该消耗玩家府库）。花费走 recordRes 流水，玩家可见。
 */
export function repairCityWalls(state) {
  const st = state.strategy;
  if (!st?.cities) return 0;
  let fixed = 0;
  for (const c of strategyMap().cities) {
    const row = st.cities[c.id];
    if (!row) continue;
    const wall = cityWall(state, c.id);
    if (!wall || row.besieged) continue;
    if (wall.hp >= wall.max) continue;
    let add = Math.max(1, Math.round(wall.max * WALL.repairPerTurn));
    if (row.owner === 'player') {
      const have = Math.max(0, Math.floor(Number(state.roleRes?.stone) || 0));
      const fullCost = repairCostOf(add);
      if (have < fullCost) {
        // 石头不够 → 按比例少修（每次至少修 0，攒够再修），不透支府库
        add = Math.floor(have / WALL.stonePerHp);
        if (add <= 0) continue;
      }
      const cost = repairCostOf(add);
      state.roleRes.stone = have - cost;
      recordRes(state, 'stone', -cost, `修葺城墙·${c.name || c.id}`, Math.floor(Number(state.clock?.day) || 1));
    }
    row.wallHp = Math.min(wall.max, wall.hp + add);
    /* 城墙修回一半以上才重新算「有城防」，破城毁设施的判定随之复位。 */
    if (row.wallRubble && row.wallHp >= wall.max * 0.5) delete row.wallRubble;
    fixed += 1;
  }
  return fixed;
}

/* ★ M2-5 张力守恒 #2（本作设计）：敌将有「临阵变招」——同一编队，抵达日不同
   敌方应对可能不同。变招由 rngFor(seed, arriveDay, 'counter') 决定，三套预案；
   推演会展示「若敌方变招则…」。注意这是确定性表，不是每旬换：同一抵达日恒同预案。 */
/** ★ P61-S2：战局槽——同一目标 3 旬（30 游戏日）共用一个种子与敌方预案。
 *  旧口径按 arriveDay 逐日取种，玩家换一天出发就能免费重试到全胜分支，
 *  把「战前判断」变成「解方程」。现在出发日只能在槽内微调行程，不能刷结果。 */
export function seedSlotDay(day) {
  const d = Math.max(1, Math.floor(Number(day) || 1));
  return Math.floor((d - 1) / 30) * 30 + 1;
}

export const COUNTER_VARIANTS = [
  { id: 'hold', name: '坚守不出', defMul: 1.12, note: '守军据城死守，兵力折算 +12%' },
  { id: 'rush', name: '出城逆袭', defMul: 0.88, note: '守军弃垒求战，兵力折算 −12%' },
  { id: 'phalanx', name: '奇正相持', defMul: 1.0, note: '守军稳守常规阵，兵力折算不变' },
];

/** 该城在 arriveDay 抵达时的敌方预案（玩家与 NPC 战斗同函数，确定性可回放）。 */
export function counterVariantFor(state, cityId, arriveDay) {
  const r = rngFor(state?.seed ?? 20261110, Math.max(1, Math.floor(Number(arriveDay) || 1)), `counter:${cityId}`).random();
  return COUNTER_VARIANTS[Math.floor(r * COUNTER_VARIANTS.length) % COUNTER_VARIANTS.length];
}

/**
 * ★ P61-S11：败仗代价（保留「不会卡死」底线）。
 * 只扣一座出发城的部分存量仓储/府金，并让一名参战武将负伤两旬；
 * 不清零、不夺城、不阵亡，避免单机存档被一次败仗摧毁。
 */
function applyDefeatCost(state, cfg, { army, aLoss, aTotal, day }) {
  if (!(aLoss > 0) || !(aTotal > 0) || aLoss / aTotal < 0.25) return null;
  const st = ensureStrategy(state);
  const cityId = Number(army?.cityId) || Number(st.playerCity) || 0;
  const e = ensureCityEcon(state)?.[cityId];
  let storeLost = 0;
  if (e && st.cities?.[cityId]?.owner === 'player') {
    const before = Math.max(0, Math.round(Number(e.store) || 0));
    storeLost = Math.min(before, Math.round(before * 0.12));
    e.store = before - storeLost;
  }
  const r = state.roleRes || (state.roleRes = {});
  const goldBefore = Math.max(0, Math.round(Number(r.gold) || 0));
  const goldLost = Math.min(goldBefore, Math.round(goldBefore * 0.03));
  if (goldLost > 0) {
    r.gold = goldBefore - goldLost;
    recordRes(state, 'gold', -goldLost, '败军损耗', day);
  }
  let injuredName = '';
  if (aLoss / aTotal >= 0.35) {
    const g = (army?.generals || []).map((id) => (state.generals || []).find((x) => x.id === id))
      .find((x) => x && !(Number(x.injuredUntil) > day));
    if (g) {
      g.injuredUntil = day + 20;
      injuredName = cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || g.name || `武将${g.cfgId}`;
    }
  }
  if (!storeLost && !goldLost && !injuredName) return null;
  return { cityId, storeLost, goldLost, injuredName, recoverDay: day + 20 };
}

/**
 * 一场战斗的完整落地：扣兵、给经验、写战报、推通道。
 * 战略攻城与本地清剿共用，保证「战报一定进存档」（试玩 P0-2）。
 */
function settleArmyBattle(state, cfg, ctx, {
  army, frac, x, y, defenseOverride, seed, defMul = 1, siege = false, siegeWall = null,
}) {
  const before = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army.soldiers?.[i]) || 0)));
  const f = Math.min(1, Math.max(0.05, Number(frac) || 1));
  const commit = before.map((v) => Math.max(0, Math.round(v * f)));
  if (commit.reduce((s, n) => s + n, 0) <= 0) return { ok: false, reason: 'no_troops' };
  // ★ P0 兵种克制（三战口径 ±15%，骑→盾→弓→骑）：以双方兵力最多的槽为主兵种，
  //   克制方压制被克方——体现为守军兵力折算（不污染内核输入回填）。
  //   ★ M2-5 张力守恒 #2：敌方预案 defMul（坚守 1.12 / 逆袭 0.88 / 常规 1.0）
  //   与克制折算**在同一处**相乘——战报基线保持 raw 守军数，与推演口径逐位一致。
  const mainArms = (rows) => rows.indexOf(Math.max(...rows));
  const atkArms = mainArms(commit) + 1;
  const defRows = (defenseOverride?.soldiers || [0, 0, 0]).map((v) => Math.max(0, Number(v) || 0));
  const defArms = mainArms(defRows) + 1;
  const counter = armsCounter(atkArms, defArms);
  /* ★ M3-4 宿命组合加成（本作设计）：队内 ≥2 名同组武将 → 守军兵力折算 ×0.95/组。
     与 M2-5 defMul 在同一处相乘，dLoss 基线保持 raw 守军数（推演同调此函数）。 */
  const fate = fateComboDefMul(state, cfg, army);
  const defense2 = defenseOverride
    ? { ...defenseOverride, soldiers: defRows.map((v) => Math.round(v * defMul * fate.mul * (counter > 0 ? 0.87 : counter < 0 ? 1.15 : 1))) }
    : defenseOverride;
  const battleArmy = { ...army, soldiers: commit };
  const result = resolveBattle({
    cfg, state, army: battleArmy, x, y, defenseOverride: defense2, seed, siege, siegeWall,
  });
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

  const aTotal = commit.reduce((s, n) => s + n, 0);
  const dTotal = (defenseOverride?.soldiers || []).reduce((s, n) => s + n, 0);
  const aLoss = aTotal - remain.reduce((s, n) => s + n, 0);
  /* ★ 修「战报写歼敌 −166」：这里原来拿「未折算的守军总数」当分母，
     而真正参战的是 defense2.soldiers（已叠兵种克制 ×0.87/1.15、敌方预案、宿命组合）。
     守军被折算小时，残兵 > 原数 → 歼敌为负。真打与推演必须同一分母，
     所以取实际参战守军作基线，并夹住不为负。 */
  const dStart = (defense2?.soldiers || defenseOverride?.soldiers || [])
    .reduce((s, n) => s + Math.max(0, Number(n) || 0), 0) || dTotal;
  const dLoss = Math.max(0, dStart - (result.endDefenseSoldiers || []).reduce((s, n) => s + n, 0));
  const place = defenseOverride?.place || `(${x},${y})`;
  const win = result.report.result === 2;
  const rec = recovered.reduce((s, n) => s + n, 0);
  const draw = result.report.result === 1;
  /* ★ P61-S11：败仗代价与「下一旬怎么恢复」都必须写进同一份战报。 */
  const defeatCost = (!win && !draw)
    ? applyDefeatCost(state, cfg, {
      army, aLoss, aTotal, day: Math.max(1, Math.floor(Number(state.clock?.day) || 1)),
    })
    : null;
  let summary = win
    ? `攻陷${place}：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}。`
    : draw
      ? `攻${place}未决：双方收兵。我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}。守军未溃，城池未下。`
      : `攻${place}不利：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}`
        + (rec > 0 ? `，溃兵 ${rec} 归营。` : '。')
        /* ★ 2026-11-19 玩法修复：战败后必须告诉玩家下一步怎么做。
           旧版只报数字，玩家 800 兵撞 1750 守军全灭后不知道原因。 */
        + (dTotal > aTotal * 1.2 ? `守军兵力占优（${dTotal} 对 ${aTotal}），下次出征前先在城内征兵补足。` : '')
        + (defeatCost ? ` 败军代价：${cityName(defeatCost.cityId)}仓粮损 ${defeatCost.storeLost}、府金损 ${defeatCost.goldLost}`
          + (defeatCost.injuredName ? `，${defeatCost.injuredName}负伤需至第 ${defeatCost.recoverDay} 日复原` : '')
          + '。' : '');
  const counterNote = counter > 0
    ? `我军${ARMS_NAMES[atkArms]}克制守军${ARMS_NAMES[defArms]}（战力+15%）。`
    : (counter < 0 ? `守军${ARMS_NAMES[defArms]}克制我军${ARMS_NAMES[atkArms]}（战力-15%）。` : '');
  const fateNote = fate.notes.length ? `${fate.notes.join('；')}。` : '';
  /* ★ 2026-11-17 城防：把攻城值打出的城墙损耗写进战报（否则玩家看不到攻城属性的作用）。 */
  const sw = result.siege;
  const wallNote = sw
    ? (sw.breached
      ? `城墙已破（${sw.ratioBefore}% → 0%），守军溃散。`
      : `城墙 ${sw.ratioBefore}% → ${sw.ratioAfter}%（本阵攻城值打掉 ${sw.damage} 点耐久）。`)
    : '';
  // 额外字段：原客户端忽略，我们自己的战报面板读它做复盘
  result.report.summary = summary + wallNote + counterNote + fateNote;
  result.report.siege = sw || null;
  const expLine = levelUpSentence(grantBattleExp(state, cfg, result.expByGeneral, { win }));
  const promos = takeBattlePromos();
  const promoLine = promos.length
    ? ` ${promos.map((p) => `${p.name}积功升为${p.rank >= 7 ? '将军' : '校尉'}`).join('，')}。`
    : '';
  if (expLine || promoLine) {
    summary += expLine + promoLine;
    result.report.summary += expLine + promoLine;
  }
  result.report.analysis = {
    aTotal, dTotal, aLoss, dLoss, recovered: rec, win,
    aBegin: commit, aRemain: remain,
    /* ★ 缺 dRemain 会让战报详情显示「守军 1982 → 0」（reduce 空数组恒为 0），
       而实际歼敌只有 72 —— 同一屏里两个数字互相打脸。这里按真实余兵下发。 */
    dRemain: result.endDefenseSoldiers || [0, 0, 0],
    counter, atkArms, defArms, counterNote,
    fateMul: fate.mul, fateNotes: fate.notes,
    defeatCost,
  };
  /* ★ M3-4 事件条件 battleWon/battleLost 的台账（近 N 旬胜负窗） */
  const strat = state.strategy || ensureStrategy(state);
  strat.battleHistory = strat.battleHistory || [];
  strat.battleHistory.push({ turn: strat.turn || 0, win, place });
  if (strat.battleHistory.length > 60) strat.battleHistory.splice(0, strat.battleHistory.length - 60);

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

  /* ★ M4-13：俘虏判定收敛到 domain/captives.js，与地图格占领路径同源。
     旧实现用「候选字符串长度×31 + 天数×7 + 兵力」当骰子、再过 30% 闸门，
     既与战果无关，又常常一场胜仗一个人也抓不到。现在按歼敌比确定性判定。 */
  if (win) {
    const day = Math.floor(Number(state.clock?.day) || 1);
    const added = captureFromBattle(state, cfg, {
      report: result.report, place, day, seed: state.seed ?? 20261110,
    });
    if (added.length) {
      const names = added.map((c) => c.name).join('、');
      summary += ` 阵前擒得敌将「${names}」！可在武将府招降，也可释放或处斩。`;
      /* ★ P59：抓俘后重写摘要时补回城墙与宿命两段。
         旧写法只拼 counterNote，一场「破城 + 抓俘」的胜仗会把
         「城墙 100% → 0%」整句吞掉，玩家看不到攻城值起了什么作用。 */
      result.report.summary = summary + wallNote + counterNote + fateNote;
      result.report.analysis.captive = names;
      for (const c of added) {
        recordEvent(state, `${place}一战告捷，敌将「${c.name}」被俘，押入大营听候发落。`);
      }
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
    summary, aTotal, dTotal, recovered: rec, win, loot, siege: sw || null,
  };
}

/**
 * ★ P7 行军由距离与队伍速度决定（本作口径，而非固定 2 日）。
 *
 *   本作：行军时间 = 距离 × 30 ÷ 队伍速度；队伍速度取队内**最慢**武将。
 *   本作把「距离」换成路网里的真实里程（conf/.../map.json 每条 route 自带 km），
 *   速度换算为 60~160（M4-10 百分制：speed 0→60、100→160），再折算成游戏日：
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
   本作里跨州远征本来就是十几到几十日，这里放宽到 40 日，
   并由 marchSupplyStops 给出「途中休整」提示，长线不再和邻城一个耗时。 */
const MARCH_DAYS_MAX = 40;
/* ★ M2-3：粮耗口径已并入全局参数表（knobs.grainPerSoldierDay，默认 0.1/兵/日） */
/** 单槽带兵上限的基准（白身）。实际每槽上限 = SLOT_CAP + 官阶×300，见 official-rank.slotCapOf；
 *  超过的兵留在城里，不能编进一队。SLOT_CAP 保留为契约/测试的基准常量。 */
export const SLOT_CAP = 5000;
/** 辎重队速度固定：车马慢，比最慢的步卒还慢一截。 */

/** 出征粮 = 实出兵力 × 每日口粮 × 行军日。冬季走河路再乘 crossRiverWinterCost。 */
export function marchGrainCost(state, deploy, days, terrain = '') {
  const per = Number(knobGet(state, 'grainPerSoldierDay')) || 0.1;
  const span = Math.max(1, Math.floor(Number(days) || 1));
  let cost = Math.ceil(Math.max(1, Number(deploy) || 0) * per * span);
  const month = ((Math.floor(((Number(state.clock?.day) || 1) - 1) / 30) % 12) + 1);
  if (month >= 10 && /河|江|渡/.test(String(terrain || ''))) {
    cost = Math.ceil(cost * (Number(knobGet(state, 'crossRiverWinterCost')) || 1));
  }
  return cost;
}

/**
 * 玩家行军抵达前的截击。只对邻接的诸侯（不含汉室、不含此行目标）掷一次。
 * 命中扣约一成二兵力；余部仍攻城。兵力掉到 200 以下则退回，不再攻城。
 */
function tryFieldIntercept(state, mm, army) {
  const st = ensureStrategy(state);
  const rate = (Number(knobGet(state, 'interceptPerEdge')) || 0) / 100;
  if (!(rate > 0) || !army) return { hit: false };
  const passive = new Set(['player', 'han', 'neutral', '']);
  const hostile = neighborsOf(mm.from).filter((id) => {
    if (id === mm.to) return false;
    const owner = st.cities?.[id]?.owner || '';
    return owner && !passive.has(owner);
  });
  if (!hostile.length) return { hit: false };
  const p = Math.min(0.4, rate * hostile.length);
  const roll = rngFor(state.seed ?? 20261110, mm.arriveDay || 1, `intercept:${mm.id}`).random();
  if (roll >= p) return { hit: false };
  const slots = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army.soldiers?.[i]) || 0)));
  const total = slots.reduce((s, n) => s + n, 0);
  if (total <= 0) return { hit: false };
  const loss = Math.max(1, Math.round(total * 0.12));
  let left = loss;
  for (const i of [0, 1, 2].slice().sort((a, b) => slots[b] - slots[a])) {
    if (left <= 0) break;
    const cut = Math.min(slots[i], left);
    slots[i] -= cut;
    left -= cut;
  }
  army.soldiers = slots;
  const remain = slots.reduce((s, n) => s + n, 0);
  const where = cityName(hostile[0]);
  const abort = remain < 200;
  return {
    hit: true,
    loss,
    abort,
    text: abort
      ? `途经${where}方向遭截击，折损 ${loss}，前军溃散，未能抵城。`
      : `途经${where}方向遭截击，折损 ${loss}，余部仍抵城下。`,
  };
}
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

/** 武将速度（60~160）：五维 speed（0~100）与装备加成折算，缺配置按 60 兜底。
 *  ★ M4-10 百分制：speed 60 即基准 120，100 即 160，与面板同源。 */
function generalSpeed(cfg, g) {
  if (!g) return 100;
  const base = gameStatOf(cfg, g, 'speed', 60);
  return Math.max(20, Math.min(200, 60 + (base + (Number(g.speed_added) || 0))));
}

/** 队伍行军速度：取队内最慢武将（本作口径），空队按 100。 */
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

/** 同一出发城 + 目标城的行军日（含势力特技 marchDelta）。 */
export function marchPlan(state, cfg, fromId, toId, army) {
  const km = marchKmBetween(fromId, toId);
  const speed = armySpeed(state, cfg, army);
  const base = marchDaysBy(km, speed);
  const days = Math.max(1, Math.min(MARCH_DAYS_MAX, base + factionTraitOf(state).marchDelta));
  return { km, speed, days };
}

/** 战略层城战（P2 行军版）：出兵不再瞬时开打，而是生成行军队列，
 *  扣行军粮、锁队，`strategyResolveMarches` 在到达日走真实内核结算。
 *  frac：出兵比例（1 全军 / 0.5 半军 / 0.34 三成）。
 *  ★ P7：fromCityId 指定出发城（任意己方城），缺省回落本城 —— 分城也能出征了。 */
export function strategyAttack(state, cfg, ctx, { cityId, armyId, frac = 1, fromCityId = 0, confirmBattle = false }) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const home = Number(fromCityId) || st.playerCity;
  const id = Number(cityId);
  const target = map.cities.find((c) => c.id === id);
  const tstate = st.cities[id];
  if (!target || !tstate) return { ok: false, code: 1, reason: 'no_city' };
  if (tstate.owner === 'player') return { ok: false, code: 2, reason: 'own_city' };
  // 出发城必须归我：己方城，或未举义时那座尚未易帜的指定起点城。
  // 举义后都城失守时 playerCity 仍指向旧城，绝不能再当成「无条件可用出发城」。
  const fromState = st.cities[home];
  const fromOk = fromState && (fromState.owner === 'player' || (home === st.playerCity && oathPending(state)));
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
    /* ★ M2-3 失败态出路（本作设计 无将）：出征前无将不再卡死——自动生成代将
       （五维 50、无战法、不可培养、不触发宿命；在有名将可用的城里会被玩家换掉） */
    const standin = makeStandInGeneral(state, home);
    (state.generals || (state.generals = [])).push(standin);
    army.generals[0] = standin.id;
    /* ★ P55：order 是队伍编号的派生字段，新增代将后必须同步重算。 */
    syncGeneralOrders(state);
    recordEvent(state, `帐下无将，以代将${standin.name}权充先锋（五维 50、无战法）。`);
    ctx.push?.('general.push', standin);
  }
  if ((army.soldiers || []).every((n) => !(n > 0))) return { ok: false, code: 4, reason: 'no_troops' };
  /* ★ 2026-11-16：单槽超出「该槽武将官阶带兵上限」的兵退回出发城，不能整槽拉出去。 */
  let overflow = 0;
  /* ★ 失败动作不得改状态：钳兵与退兵先算在局部，粮检通过后才写回 army/城库。
     旧实现先改 army.soldiers 与 fromState.troops，再因缺粮返回 no_grain，
     玩家一次失败出征就被永久压兵，属于可复现的存档污染。 */
  const clampSoldiers = [0, 1, 2].map((i) => {
    const n = Math.max(0, Math.floor(Number(army.soldiers?.[i]) || 0));
    const gid = (army.generals || [])[i];
    const g = gid ? (state.generals || []).find((x) => x.id === gid) : null;
    const cap = g ? slotCapOf(g) : SLOT_CAP;
    if (n > cap) { overflow += n - cap; return cap; }
    return n;
  });
  // 行军粮：实出兵力 × 每日口粮 × 行军日（本作设计：1 兵 1 旬吃 1 粮，路程按日计）
  // 优先从出发城城库扣，城库不足吃全局池并 +25% 损耗
  const troopsTotal = clampSoldiers.reduce((s, v) => s + Math.max(0, Number(v) || 0), 0);
  const ratio = Math.max(0.01, Math.min(1, Number(frac) || 1));
  const deploy = Math.max(1, Math.round(troopsTotal * ratio));
  const plan = marchPlan(state, cfg, home, id, { ...army, cityId: home, soldiers: clampSoldiers });
  const grainCost = marchGrainCost(state, deploy, plan.days, target.terrain);
  const pay = consumeMarchGrain(state, home, grainCost);
  if (!pay.enough) {
    return { ok: false, code: 5, reason: 'no_grain', need: grainCost };
  }
  army.soldiers = clampSoldiers;
  if (overflow > 0 && fromState) {
    fromState.troops = Math.max(0, Math.round(Number(fromState.troops) || 0) + overflow);
  }

  if (!Array.isArray(st.marches)) st.marches = [];
  const departDay = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const marchDays = plan.days;
  const row = {
    id: (st.marchSeq = (st.marchSeq || 0) + 1),
    side: 'player', from: home, to: id,
    departDay, arriveDay: departDay + marchDays,
    armyId: army.id, frac: ratio, grainCost, troops: deploy,
    km: plan.km, speed: plan.speed,
    /* ★ P11 / 本作设计 门 3→4→5「遭遇 → 推演 → 确认 → 结算」：
       玩家从出征面板发的兵默认在抵达时先挂在「遭遇」待决，不自动开打。
       协议层老调用方不传此标志，行为保持不变（测试与 NPC 不受影响）。 */
    confirmBattle: !!confirmBattle, pendingBattle: false, confirmed: false,
    /* ★ M2-5 张力守恒 #3「确认即锁」：出征瞬间锁定种子——推演多少次都行，
       确认后不再重来；要重来只能撤军（有代价）。结算只读 lockedSeed。 */
    lockedSeed: battleSeedFor(army.id, 8000 + id, 100 + Math.max(1, Math.min(3, target.level || 1)), seedSlotDay(departDay + marchDays)),
  };
  st.marches.push(row);
  army.marchId = row.id;   // 锁队：到达前不能再出征/清剿
  const fromName = map.cities.find((c) => c.id === home)?.name || '本城';
  recordEvent(state, `大军自${fromName}开拔，出征${target.name}，`
    + `行程 ${Math.round(plan.km)} 里、速度 ${plan.speed}`
    + `，预计第 ${row.arriveDay} 日抵城下（耗粮 ${grainCost}）。`);
  ctx.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【天下】我军自${fromName}开拔，进军${target.name}，程 ${Math.round(plan.km)} 里，预计 ${marchDays} 日后抵达。`,
    time: Date.now(),
  });
  return {
    ok: true, marching: true, marchId: row.id, arriveDay: row.arriveDay,
    city: target.name, grainCost, marchDays, km: plan.km, speed: plan.speed, from: fromName,
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
  /* ★ P14 驰援：faction 侧先解析——同日抵达时援军先并兵入守，玩家面对的是
     援军已入城的守军（否则驰援永远扑空，形同虚设）。 */
  const ordered = [...st.marches].sort((a, b) => (a.side === 'player' ? 1 : 0) - (b.side === 'player' ? 1 : 0));
  for (const mm of ordered) {
    /* 修 U12：诸侯行军只做「可见性 + 到达标记」。战斗已在 applyOrders 抽象结算，
       此处不能重复开打；到达后保留 resolved 行，供战报与情报回看。 */
    if (mm.side !== 'player') {
      if (!mm.resolved && today >= mm.arriveDay) {
        mm.resolved = true;
        /* ★ P14 驰援：援军到达即并兵入守（或扑空折返） */
        if (mm.kind === 'relief') resolveReliefArrival(state, ctx, mm, map);
      }
      continue;
    }
    if (mm.resolved) continue;
    if (today < mm.arriveDay) continue;
    /* ★ P11 门 4「遭遇」：玩家主动开启的确认制出征，抵达先挂起等玩家决策。
       队伍仍锁在行军中（marchId 不清），此处不结算、不写战报、不改归属。 */
    if (mm.confirmBattle && !mm.confirmed && mm.kind !== 'transport') {
      if (!mm.pendingBattle) {
        mm.pendingBattle = true;
        mm.pendingSinceDay = today;
        const nm = map.cities.find((c) => c.id === mm.to)?.name || cityName(mm.to);
        recordEvent(state, `前锋抵${nm}城下，两军对阵，请主公定夺（推演 / 开战 / 撤军）。`);
      } else if (today - (mm.pendingSinceDay ?? mm.arriveDay) > 30) {
        /* ★ M4-13：久候无令则自动班师。旧版 pending 行永不 resolved，
           army.marchId 一直不清，玩家若没发现「③ 遭遇」页签，这支兵就永久锁死。 */
        strategyRetreatBattle(state, cfg, ctx, { marchId: mm.id });
      }
      continue;
    }
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
      delete army.drillMorale;
    }
    const target = map.cities.find((c) => c.id === mm.to);
    const tstate = st.cities[mm.to];
    if (!target || !tstate) continue;
    if (tstate.owner === 'player') {
      if (army) { army.cityId = mm.to; syncGeneralsCity(state, army, mm.to); }
      recordEvent(state, `${target.name}已入我军版图，班师。`);
      continue;
    }
    if (!army || (army.soldiers || []).every((n) => !(n > 0))) {
      recordEvent(state, `出征${target.name}的队伍中途溃散，无果而返。`);
      continue;
    }
    const ambush = tryFieldIntercept(state, mm, army);
    if (ambush.hit) {
      recordEvent(state, ambush.text);
      if (ambush.abort || (army.soldiers || []).every((n) => !(n > 0))) {
        results.push({ kind: 'intercept', abort: true, loss: ambush.loss, cityId: mm.to });
        continue;
      }
    }
    const level = Math.max(1, Math.min(3, target.level || 1));
    /* ★ M2-5 张力守恒 #2：实际战斗的守军折算按该抵达日的敌方预案（与推演同口径）。
       defMul 传给 settleArmyBattle 统一相乘，dLoss 基线保持 raw 守军数。 */
    /* ★ P61-D2：预案与 lockedSeed 同按 3 旬槽取，避免换出发日刷「守军逆袭」预案。 */
    const variant = counterVariantFor(state, mm.to, seedSlotDay(mm.arriveDay));
    const defenseOverride = defenseFor(cfg, mm.to, target, tstate, level, state);
    defenseOverride.terrain = target.terrain || '';
    /* ★ 2026-11-17 城防：把该城当前的城墙耐久带进战斗——攻方攻城值（destroy）
       在这一战里把它打低；城墙越残，守军防御加成越少，下一波越好打。 */
    const wall = cityWall(state, mm.to);
    const fought = settleArmyBattle(state, cfg, ctx, {
      army, frac: mm.frac, x: 8000 + mm.to, y: 100 + level, defenseOverride, defMul: variant.defMul,
      siege: true,
      siegeWall: wall,
      /* ★ 验收 #10：种子按「到达日」算，战前推演能算出一模一样的种子。
         ★ 张力守恒 #3：优先用出征时锁定的 lockedSeed（确认即锁）。 */
      seed: mm.lockedSeed ?? battleSeedFor(army.id, 8000 + mm.to, 100 + level, seedSlotDay(mm.arriveDay)),
    });
    if (!fought.ok) continue;
    if (fought.siege) applySiegeResult(state, mm.to, fought.siege);
    const win = fought.result === 2;
    if (win) {
      /* ★ M2-4 外交：占城登记（本作设计「你占了他的城×20」+ 开战/停战期毁约判定）。
         必须在归属变更**前**取旧主。 */
      noteCityCaptured(state, PLAYER_ID, tstate.owner);
      tstate.owner = 'player';
      /* ★ M3-4：everOwned 记账（克城后 cityLost 口径才成立） */
      if (!st.everOwned.includes(mm.to)) st.everOwned.push(mm.to);
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
        /* ★ P7 战争系数：城破流民四散，民心/治安双降（城破口径） */
        e.morale = Math.max(0, (e.morale ?? 60) - 15);
        e.order = Math.max(0, (e.order ?? 60) - 12);
        const r = state.roleRes;
        r.gold = Math.min(r.depot_capacity || 1000000, (r.gold || 0) + sackGold);
        r.grain = Math.min(r.depot_capacity || 1000000, (r.grain || 0) + sackGrain);
        recordRes(state, 'gold', sackGold, `破城掠夺·${target.name}`, day);
        recordRes(state, 'grain', sackGrain, `破城掠夺·${target.name}`, day);
      }
      /* ★ P11 门 6「消化」：占城不是终点，给一条可点的新城治理待办 */
      if (!Array.isArray(st.digest)) st.digest = [];
      if (!st.digest.some((d) => Number(d.cityId) === Number(mm.to))) {
        st.digest.push({ cityId: mm.to, name: target.name, day, reportId: fought.report.id });
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
      /* ★ P47#8 配套：相持/平局也要交代折损与歼敌。
         旧文案只有「相持不下，暂退」，玩家与战报链都看不到这一战是否真打过；
         和败退分支一样写明实际损失（同源 fought.report.analysis，不另算数值）。 */
      const an = fought.report?.analysis || {};
      const aLoss = Math.max(0, Number(an.aLoss) || 0);
      const dLoss = Math.max(0, Number(an.dLoss) || 0);
      recordEvent(state, `攻${target.name}相持不下，暂退（折损 ${aLoss}、歼敌 ${dLoss}）。`);
    }
    // ★ P7 驻城归位：胜则进驻新占城，败/平则退回出发城。
    //   分城出征后队伍不再永远挂在旧城，玩家能在新城里继续操作。
    if (army) {
      army.cityId = win ? mm.to : (Number(mm.from) || st.playerCity || 0);
      syncGeneralsCity(state, army, army.cityId);
    }
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

/* ---------------------------------------------------------------------------
 * ★ P11 / 本作设计 门 4→5→6：遭遇待决 / 确认开战 / 临阵撤军 / 新城消化
 * ------------------------------------------------------------------------- */

/** 门 5：玩家在「遭遇」页点确认，才真正走结算（与自动结算同一条 resolveMarches）。 */
export function strategyConfirmBattle(state, cfg, ctx, { marchId }) {
  const st = ensureStrategy(state);
  const mm = (st.marches || []).find((x) => x.id === Number(marchId)
    && x.side === 'player' && x.pendingBattle && !x.resolved);
  if (!mm) return { ok: false, reason: 'no_pending_battle' };
  mm.confirmed = true;
  mm.pendingBattle = false;
  const results = strategyResolveMarches(state, cfg, ctx);
  const r = results.find((x) => Number(x.cityId) === Number(mm.to)) || null;
  return {
    ok: true, marchId: mm.id, cityId: mm.to, city: r?.city || cityName(mm.to),
    result: r?.result ?? null, reportId: r?.reportId ?? null, summary: r?.summary || '',
  };
}

/** 门 4 的另一条出路：不打了，全军退回出发城，行军粮退一半。 */
export function strategyRetreatBattle(state, cfg, ctx, { marchId }) {
  const st = ensureStrategy(state);
  const mm = (st.marches || []).find((x) => x.id === Number(marchId)
    && x.side === 'player' && x.pendingBattle && !x.resolved);
  if (!mm) return { ok: false, reason: 'no_pending_battle' };
  mm.resolved = true;
  mm.recalled = true;
  mm.pendingBattle = false;
  const army = (state.armys || []).find((a) => a.id === mm.armyId);
  if (army) {
    delete army.marchId;
    delete army.drillMorale;
    army.cityId = Number(mm.from) || st.playerCity || 0;
    syncGeneralsCity(state, army, army.cityId);
  }
  const refund = Math.floor((Number(mm.grainCost) || 0) / 2);
  const e = st.cityEcon?.[mm.from];
  if (e && refund > 0) e.store = Math.min(storeCapOf(e), (Number(e.store) || 0) + refund);
  recordEvent(state, `临阵收兵：攻${cityName(mm.to)}之役作罢，部队退回${cityName(mm.from)}，退还军粮 ${refund}。`);
  return { ok: true, refund, cityId: mm.to };
}

/** 门 6：占城后的「消化」待办处理完就清掉（界面按钮直达新城内政页）。 */
export function strategyDigestDone(state, { cityId }) {
  const st = ensureStrategy(state);
  const id = Number(cityId);
  if (!Array.isArray(st.digest)) st.digest = [];
  const before = st.digest.length;
  st.digest = st.digest.filter((d) => Number(d.cityId) !== id);
  return { ok: true, cleared: before - st.digest.length, cityId: id };
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
      delete army.drillMorale;
      army.cityId = Number(mm.from) || st.playerCity;
      syncGeneralsCity(state, army, army.cityId);
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
    ...defenseFor(cfg, 9000 + Number(g.id), { name: g.name }, { troops, owner: g.faction || 'han' }, level, state),
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
  const cityId = Number(army.cityId) || st.playerCity || 0;
  const seen = new Set();
  for (const gid of slots) {
    if (!gid) continue;
    if (seen.has(gid)) return { ok: false, reason: 'dup_general', generalId: gid };
    seen.add(gid);
    /* ★ P54：同城、一人一队——与 army.dispose 共用 formationGeneralCheck，
       不再出现"人在 A 城、队伍在 B 城"或同一武将挂两支队伍。 */
    const check = formationGeneralCheck(state, { generalId: gid, cityId, armyId: army.id });
    if (!check.ok) return check;
  }
  const troops = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(soldiers?.[i]) || 0)));
  /* ★ 2026-11-16：每槽带兵上限随该槽武将官阶浮动（白身 5000 → 三公 7700）；
     空槽无将统辖，仍按基础 5000，不能借空槽超编。 */
  const caps = slots.map((gid) => {
    const g = gid ? (state.generals || []).find((x) => x.id === gid) : null;
    return g ? slotCapOf(g) : SLOT_CAP;
  });
  const over = troops.findIndex((n, i) => n > caps[i]);
  if (over >= 0) return { ok: false, reason: 'over_cap', slot: over, cap: caps[over], caps, have: troops[over] };
  const cur = (army.soldiers || []).map((v) => Math.max(0, Math.floor(Number(v) || 0)));
  const totalCur = cur.reduce((s, v) => s + v, 0);
  const totalNew = troops.reduce((s, v) => s + v, 0);
  if (totalNew > totalCur) {
    return { ok: false, reason: 'too_many_troops', have: totalCur };
  }
  /* 系统性验收（M4-4）发现的真缺陷：UI（panels-ui formupBox）允许三槽全填 0，
     旧实现直接把 army.soldiers 清零、差额无任何入账——兵凭空蒸发。
     修正：① 全空编队拒绝；② 差额按注释「留在营」退回驻城守军，找不到驻城就留回首槽。 */
  if (totalNew === 0) return { ok: false, reason: 'empty_formup' };
  const diff = totalCur - totalNew;
  const home = st.cities?.[army.cityId];
  let returnedToCity = 0;
  if (diff > 0) {
    /* ★ P55：找不到驻城记录时退到玩家主城，绝不再塞回槽位制造空槽兵/越过带兵上限。 */
    const fallback = st.cities?.[Number(st.playerCity)]
      || Object.values(st.cities || {}).find((c) => c && c.owner === 'player');
    const target = home || fallback;
    if (target) {
      target.troops = Math.max(0, Math.round(Number(target.troops) || 0) + diff);
      returnedToCity = diff;
    } else {
      return { ok: false, reason: 'no_home_city' };
    }
  }
  army.generals = slots;
  army.soldiers = troops;
  army.con_times = [0, 0, 0];
  army.con_cnts = [0, 0, 0];
  syncGeneralOrders(state);   // ★ P54：g.order 是派生字段，换将后必须随队伍重算
  const names = slots.map((gid) => {
    const g = (state.generals || []).find((x) => x.id === gid);
    return g ? generalDisplayName(state, cfg, g) : '';
  });
  recordEvent(state, `整编队伍#${army.order}：${names.map((n, i) => n ? `${ARMS_NAMES[i + 1]}·${n}(${troops[i]})` : '').filter(Boolean).join('、') || '空编'}。${returnedToCity ? `余兵 ${returnedToCity} 退回驻城。` : ''}`);
  ctx.push?.('army.push', army);
  return {
    ok: true, army: { id: army.id, order: army.order, generals: names, soldiers: troops },
    returnedToCity,
    apt: slots.map((gid, i) => {
      const g = (state.generals || []).find((x) => x.id === gid);
      return g ? Math.round(armsApt(g, i + 1) * 100) : 0;
    }),
  };
}

/** 队伍驻地变化时对齐队内武将 cityId（旧实现只搬队伍不搬人，导致归属永久错位）。 */
function syncGeneralsCity(state, army, cityId) {
  const cid = Number(cityId) || 0;
  if (!army || !cid) return;
  for (const gid of army.generals || []) {
    const g = (state.generals || []).find((x) => x.id === Number(gid));
    if (g) g.cityId = cid;
  }
}

/**
 * ★ 2026-11-17 武将调防：把一名武将从一个城调到另一个己方城。
 * 用户反馈「新招募的武将都是闲置的，没法派遣到其他城池」——旧版有 g.cityId 字段，
 * 却没有任何调城入口，且出征只搬队伍不搬武将，导致「人在哪座城」停在招募那一刻。
 * 本函数是唯一调城口：只改 g.cityId（不改城池归属、不改兵力），并从原队伍摘除；
 * 行军中不可调（与 strategyFormup 同规则）。瞬发，不另算行程。
 */
/* 调防的唯一校验口径：单人与批量共用，reason 只走协议，玩家文案由调用方给中文。 */
function dispatchCheck(state, st, g, to, fromFallback = 0) {
  if (!g) return { ok: false, reason: 'no_general' };
  const from = Number(g.cityId) || fromFallback || st.playerCity || 0;
  if (!to) return { ok: false, reason: 'no_city' };
  if (to === from) return { ok: false, reason: 'same_city', cityId: to, from };
  const tstate = st.cities?.[to];
  if (!tstate) return { ok: false, reason: 'no_city' };
  if (tstate.owner !== 'player') return { ok: false, reason: 'not_own_city' };
  /* 行军中不可调：队伍在途时武将随军，与整编口径一致。 */
  if ((state.armys || []).some((a) => a.marchId && (a.generals || []).includes(Number(g.id)))) {
    return { ok: false, reason: 'marching', generalId: Number(g.id) };
  }
  return { ok: true, from };
}

/* 调防的唯一落账口径：从原队伍摘除并回填 order（与 army.dispose 同口径）。
   ★ P55：旧实现只摘武将不处理该槽兵力/在途，留下「空槽带兵」幽灵队——
   兵会计入战损却不上阵，又因 empty_slot 永远补不回来。这里统一走 releaseSlot
   把该槽兵力与在途退回原驻城，绝不留空槽兵。 */
function applyDispatch(state, ctx, g, to, from) {
  const gid = Number(g.id);
  let returned = 0;
  for (const a of state.armys || []) {
    const slot = (a.generals || []).findIndex((id) => Number(id) === gid);
    if (slot < 0) continue;
    returned += releaseSlot(state, a, slot);
    a.generals[slot] = 0;
    ctx.push?.('army.push', a);
  }
  g.cityId = to;
  g.order = 0;
  ctx.push?.('general.push', g);
  return { generalId: gid, from, to, returned, fromName: cityName(from), toName: cityName(to) };
}

export function dispatchGeneral(state, cfg, ctx, { generalId, toCityId, fromCityId = 0 } = {}) {
  const st = ensureStrategy(state);
  const gid = Number(generalId) || 0;
  const to = Number(toCityId) || 0;
  const g = (state.generals || []).find((x) => x.id === gid);
  if (!g) return { ok: false, reason: 'no_general' };
  /* ★ P55：旧调用方显式给的出发城只在武将未记驻地时作局部兜底参与校验，
     绝不在这里写 g.cityId——校验失败的路径此前会留下「被拒绝却改了驻地」的脏档。 */
  const check = dispatchCheck(state, st, g, to, Number(fromCityId) || 0);
  if (!check.ok) return check;
  const out = applyDispatch(state, ctx, g, to, check.from);
  const gname = generalDisplayName(state, cfg, g);
  recordEvent(state, `${gname}自${cityName(check.from)}调往${cityName(to)}。`);
  return { ok: true, ...out };
}

/**
 * ★ P51 批量调防：一次把多名武将调往同一座己方城。
 * 先整体校验再统一落账——出现任何不可调者只跳过该人并写明原因，
 * 已选中的其余武将照常调；全体不可调时一人不动，避免"部分成功却看不出谁没走"。
 */
export function dispatchGenerals(state, cfg, ctx, { generalIds, toCityId } = {}) {
  const st = ensureStrategy(state);
  const to = Number(toCityId) || 0;
  const ids = Array.isArray(generalIds)
    ? [...new Set(generalIds.map((v) => Number(v)).filter((v) => v > 0))] : [];
  if (!ids.length) return { ok: false, reason: 'no_general', text: '请先勾选要调遣的武将' };
  const tstate = st.cities?.[to];
  if (!tstate || tstate.owner !== 'player') {
    return { ok: false, reason: 'not_own_city', text: '只能调往己方城池' };
  }
  const explain = {
    no_general: '武将已不在营中', same_city: '已在此城',
    marching: '行军中不可调', no_city: '目标城不存在', not_own_city: '目标城不属我方',
  };
  const moved = [];
  const skipped = [];
  for (const gid of ids) {
    const g = (state.generals || []).find((x) => x.id === gid);
    const check = dispatchCheck(state, st, g, to);
    if (!check.ok) {
      skipped.push({ generalId: gid, name: generalDisplayName(state, cfg, g) || `武将${gid}`, reason: check.reason });
      continue;
    }
    moved.push({ g, check });
  }
  if (!moved.length) {
    const why = skipped.map((s) => `${s.name}（${explain[s.reason] || '不可调'}）`).join('、');
    return { ok: false, reason: 'all_skipped', moved: [], skipped, to,
      text: `没有武将可调：${why}` };
  }
  const rows = [];
  for (const m of moved) rows.push(applyDispatch(state, ctx, m.g, to, m.check.from));
  const names = rows.map((r) => {
    const g = (state.generals || []).find((x) => x.id === r.generalId);
    return generalDisplayName(state, cfg, g) || `武将${r.generalId}`;
  });
  let text = `${names.length} 员武将调往${cityName(to)}：${names.join('、')}。`;
  if (skipped.length) {
    text += ` 未调 ${skipped.map((s) => `${s.name}（${explain[s.reason] || '不可调'}）`).join('、')}。`;
  }
  recordEvent(state, text);
  return { ok: true, moved: rows, skipped, to, toName: cityName(to), text };
}

/** ★ P3 运输队：把粮从府库运往指定己方城城库，走行军队列按时抵达。
 *  蝗灾前把粮运出去是经典避险操作。
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

/** ★ P1 赏赐：金 +amount/100 忠诚（单次上限 +15）。 */
export function rewardGeneral(state, cfg, ctx, { generalId, amount }) {
  const g = (state.generals || []).find((x) => x.id === Number(generalId));
  if (!g) return { ok: false, reason: 'no_general' };
  const amt = Math.floor(Number(amount) || 0);
  if (amt < 50 || amt > 1500) return { ok: false, reason: 'bad_amount' };
  const r = state.roleRes;
  if ((Number(r.gold) || 0) < amt) return { ok: false, reason: 'no_gold' };
  r.gold -= amt;
  setLoyalty(g, loyaltyOf(g) + Math.min(15, amt / 100));
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  recordRes(state, 'gold', -amt, `赏赐·${cfg?.generalByCfg?.get(g.cfgId)?.name || `武将${g.id}`}`, day);
  ctx.push?.('general.push', g);
  return { ok: true, loyal: g.loyal, gold: Math.floor(r.gold) };
}

/** ★ P61-S12：满 10 级武将显式进阶（唯一入口）。只解锁 11~15 级成长，
 *  不回改五维原表；每级 2% 战斗加成在派生层生效。 */
export function advanceGeneral(state, cfg, ctx, { generalId } = {}) {
  const g = (state.generals || []).find((x) => x.id === Number(generalId));
  if (!g) return { ok: false, reason: 'no_general' };
  if (g.advanced) return { ok: false, reason: 'already_advanced' };
  if ((Number(g.level) || 1) < 10) return { ok: false, reason: 'level_low' };
  const r = state.roleRes || (state.roleRes = {});
  if ((Number(r.gold) || 0) < ADVANCE_COST_GOLD) return { ok: false, reason: 'no_gold' };
  r.gold -= ADVANCE_COST_GOLD;
  g.advanced = true;
  const name = cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || g.name || `武将${g.id}`;
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  recordRes(state, 'gold', -ADVANCE_COST_GOLD, `进阶·${name}`, day);
  recordEvent(state, `${name}进阶：解锁 11~${ADVANCED_LEVEL_CAP} 级成长，每级战斗加成 2%。`);
  ctx?.push?.('general.push', g);
  return { ok: true, id: g.id, cap: ADVANCED_LEVEL_CAP, gold: Math.floor(r.gold) };
}

/** ★ P6 城池内政 → ★ U14 改成任务对象：开垦/招商/募兵/修城/赈灾。
 *  派单逻辑（成本、执行武将、工期、每旬增量、状态）全部在 interior-task.js 里唯一实现，
 *  本函数只做旧接口兼容：老 UI 与老调用方仍走 `invest`，返回里多了 task 字段与完工日。
 *  行为变化（刻意）：开发类不再即时生效，而是按执行武将能力 1~3 旬完工，
 *  每旬在事件簿留一条带归因的记录（「长安农田 +1.5（荀彧·9600）」）。 */
export function strategyInvest(state, cfg, ctx, { cityId, kind }) {
  const st = ensureStrategy(state);
  ensureCityEcon(state);
  const id = Number(cityId);
  const tstate = st.cities[id];
  if (!tstate || tstate.owner !== 'player') return { ok: false, reason: 'not_own_city' };
  const r = beginInteriorTask(state, cfg, ctx, { cityId: id, kind });
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
  /* ★ 行军口径必须与 strategyAttack 完全一致：marchPlan 已含势力特技 marchDelta，
     种子又按 arriveDay 取，所以差一天就会打出不同战报（这里踩过坑）。 */
  const plan = marchPlan(state, cfg, from, to, army);
  const km = plan.km;
  const speed = plan.speed;
  const days = plan.days;
  const today = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const arriveDay = today + days;
  /* ★ P61-S2：种子与敌将预案按 3 旬槽取，不再按具体抵达日逐日刷新。
     arriveDay 仍是真实到达日（粮耗/行军显示用），只有战局算进槽位。 */
  const seedDay = seedSlotDay(arriveDay);
  /* 截击与正式抵达用同一 marchId / 到达日：先扣再乘出兵比例。只改影子队伍，不动存档。 */
  const shadow = { soldiers: before.slice() };
  tryFieldIntercept(state, { id: (st.marchSeq || 0) + 1, from, to, arriveDay }, shadow);
  const commit = shadow.soldiers.map((v) => Math.max(0, Math.round(v * f)));
  const aTotal = commit.reduce((s2, n) => s2 + n, 0);
  if (aTotal <= 0) return { ok: false, reason: 'no_troops' };

  const level = Math.max(1, Math.min(3, target.level || 1));
  /* ★ M4-13：推演与正式结算必须传同一个 state —— 守将排除名单同源，
     否则两边会从守将池里取到不同的人，折损对不上（本轮真实踩到 600 vs 594）。 */
  const defense = defenseFor(cfg, to, target, tstate, level, state);
  defense.terrain = target.terrain || '';
  const mainArms = (rows) => rows.indexOf(Math.max(...rows));
  const atkArms = mainArms(commit) + 1;
  const defArms = mainArms(defense.soldiers.map((v) => Math.max(0, Number(v) || 0))) + 1;
  const counter = armsCounter(atkArms, defArms);
  /* ★ M2-5 张力守恒 #1/#4（本作设计）：推演只对「已知量」精确——
     情报档位决定守军估算幅度：0 传闻 ±40% / 1 估算 ±15% / 2 精确 ±0%。
     未侦察的守军保持区间，推演不产生情报（禁止反复试错反推真值）。 */
  const intelTier = Math.max(0, Math.min(2, Number(st.intel?.[to]) || 0));
  const intelSpread = intelTier >= 2 ? 0 : intelTier === 1 ? 0.15 : 0.4;
  /* ★ #2 敌将变招：抵达日决定预案，推演给出「若敌方变招则…」两条对照线 */
  const variant = counterVariantFor(state, to, seedDay);
  const armsMul = counter > 0 ? 0.87 : counter < 0 ? 1.15 : 1;
  /* ★ M3-4 宿命组合加成：与 settleArmyBattle 同调 fateComboDefMul（描述=计算=战报同源） */
  const fate = fateComboDefMul(state, cfg, army);
  const mkDef = (spreadMul, defMul) => ({
    ...defense,
    soldiers: defense.soldiers.map((v) => Math.round(v * armsMul * spreadMul * defMul * fate.mul)),
  });
  const dTotal = defense.soldiers.reduce((s2, n) => s2 + n, 0);

  const seed = battleSeedFor(army.id, 8000 + to, 100 + level, seedDay);
  /* ★ 张力守恒 #3「确认即锁」：正式战斗的种子在 strategyAttack 出征时已写进
     march 行（lockedSeed）；推演用同一 arriveDay 推同一 seed，所以
     「今天出发」的推演与正式结算逐位一致——变招只发生在抵达日变化时。 */
  /* ★ 2026-11-17 城防：推演必须带同一份城墙状态，否则「城墙加成为 1.5 还是 1.2」
     会让预演与正式结算差一档（P10 逐位一致契约）。 */
  const forecastWall = cityWall(state, to);
  const runB = (def2) => resolveBattle({
    cfg, state: structuredClone(state), army: { ...army, soldiers: commit },
    x: 8000 + to, y: 100 + level, defenseOverride: def2, seed,
    siege: true,
    siegeWall: forecastWall,
    /* 推演不需要回放动作流（战报才有），跳过可省一大半耗时 */
    withAnim: false,
  });
  /* ★ 修：旧实现用「未折算的守军总数」当分母，而沙盒里打的是按
     兵种克制 / 变招 / 宿命折算过的守军。守军被折算得比原数少时，
     残余 > 总数 → 歼敌变成负数（实测战报写「歼敌 -166」）。 */
  const readB = (r2, label, def2) => {
    const remain2 = r2.endAttackSoldiers || [0, 0, 0];
    const dRemain2 = r2.endDefenseSoldiers || [0, 0, 0];
    const dStart = (def2?.soldiers || []).reduce((s2, n) => s2 + Math.max(0, Number(n) || 0), 0) || dTotal;
    return {
      label,
      code: r2.report?.result ?? 0,
      win: r2.report?.result === 2,
      aLoss: Math.max(0, aTotal - remain2.reduce((s2, n) => s2 + n, 0)),
      dLoss: Math.max(0, dStart - dRemain2.reduce((s2, n) => s2 + n, 0)),
      /* 该预案下真正上场的守军总数：让「变招」这条对照线可核，
         而不是只给一个看起来差不多的歼敌数（见 m2-tension 的判定口径）。 */
      dStart,
    };
  };
  const mainDef = mkDef(1, variant.defMul);
  const result = runB(mainDef);
  /* ★ P61-S2：只给一条当前情报档允许的推演线。变招/士气/地形改为风险提示，
     不再枚举全部变招与最好/最坏结果——否则玩家换出发日就能解出全胜分支。 */
  const riskNotes = [
    `敌军预案「${variant.name}」：${variant.note}。守军可能因变招在 0.88~1.12 倍间浮动。`,
    '兵种克制、城墙与士气以正式战报为准；推演不列出所有分支，请按最坏情形留余量。',
    intelSpread > 0
      ? `情报仅 ±${Math.round(intelSpread * 100)}%：先侦察可收窄守军区间。`
      : '情报精确：守军按已知量推演。',
    '同一目标 3 旬内战局槽锁定，换出发日不会再换战报；如需重来只能撤军（有代价）。',
  ];
  const remain = result.endAttackSoldiers || [0, 0, 0];
  const dRemain = result.endDefenseSoldiers || [0, 0, 0];
  const aLoss = Math.max(0, aTotal - remain.reduce((s2, n) => s2 + n, 0));
  /* ★ 同一处根因的第二次修正：主案的歼敌基线也必须是「实际参战守军」。
     这里曾经写 dTotal（raw 守军），而真正上场的是 mainDef.soldiers
     （已叠兵种克制 / 敌方变招 / 宿命组合）。基线偏大就会出现
     「歼敌 310」而真打只有「歼敌 72」，玩家会觉得推演在骗人。 */
  const dStartMain = (mainDef.soldiers || []).reduce((s2, n) => s2 + Math.max(0, Number(n) || 0), 0) || dTotal;
  const dLoss = Math.max(0, dStartMain - dRemain.reduce((s2, n) => s2 + n, 0));
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

  /* ★ 双方参战阵容（含战法说明）：推演面板要能回答「对面凭什么赢我」，
     战报也要能解释「健卒不殆到底做了什么」。说明全部来自 battle-narrative 的唯一模板。 */
  const profileList = (g) => (g?.skills || [])
    .map((s) => (s && s.cfgId ? skillProfile(s.cfgId, s.lv || 1) : null))
    .filter(Boolean)
    .map((p) => ({ name: p.name, effect: p.effect, cls: p.cls, trigger: p.trigger }));
  const genName = (g) => generalDisplayName(state, cfg, g);
  const myGenerals = (army.generals || [])
    .map((gid) => (state.generals || []).find((g) => g.id === gid))
    .filter(Boolean)
    .map((g) => ({ name: genName(g), star: g.star || 0, skills: profileList(g) }));
  const theirGenerals = (defense.generals || []).map((g) => ({
    name: genName(g), star: g.star || 0, skills: profileList(g),
  }));

  const payload = {
    ok: true,
    target: { id: to, name: target.name, level, owner: tstate.owner, ownerName: tstate.ownerName || '' },
    from, km, speed, days, arriveDay, today,
    /* ★ 2026-11-20：出征粮耗由服务端唯一公式下发，界面只显示不计算。
       旧版 skills.js 自己写 Math.ceil(deploy*0.1) 漏乘行程天数，实测 20 日行程
       显示 1000、实扣 20000（低估 20 倍）。 */
    grainCost: marchGrainCost(state, aTotal, days, target.terrain),
    commit, deploy: aTotal, aTotal, dTotal, dStart: dStartMain, aLoss, dLoss, remain, dRemain: dRemain.slice(),
    counter, atkArms, defArms, counterNote,
    /* ★ M3-4 宿命组合：预览面板显示同队加成（与正式结算同一函数） */
    fateMul: fate.mul, fateNotes: fate.notes,
    /* ★ 修：rounds 必须是「回合数」，不能是 report.rounds（那是 JSON 字符串）。
       旧实现让界面打印出 `战报码 0 [{"b":[{"a_id":...` —— 玩家说的「一串代码」。 */
    seed,
    rounds: Number(result.kernel?.rounds) || 0,
    code, win, draw: code === 1,
    forces: { mine: myGenerals, theirs: theirGenerals },
    /* ★ M2-5 张力守恒四条的下发位（本作设计） */
    intelTier, intelSpread,
    intelNote: intelTier >= 2
      ? '情报·精确：守军按已知量推演'
      : (intelTier === 1 ? '情报·估算：守军按 ±15% 区间推演' : '未侦察：守军为 ±40% 传闻估算，先侦察可收窄区间'),
    variant: { id: variant.id, name: variant.name, note: variant.note },
    seedDay, riskNotes,
    /* ★ 2026-11-17 城防：推演必须告诉玩家「城墙还剩多少、这一波能打掉多少」，
       否则攻城属性与城防属性在界面上依然是两个看不见的数字。 */
    wall: forecastWall ? {
      hp: forecastWall.hp,
      max: forecastWall.max,
      pct: Math.round((forecastWall.hp / Math.max(1, forecastWall.max)) * 100),
      defMul: Math.round(wallDefMul(state, forecastWall) * 100) / 100,
      forecast: result.siege
        ? { hpAfter: result.siege.hpAfter, damage: result.siege.damage, breached: result.siege.breached }
        : null,
    } : null,
    lockNote: '确认出征即锁定战局（种子已锁）；推演不限次数，确认后要重来只能撤军（有代价）。',
    summary: win
      ? `预计攻陷${target.name}：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}。`
      : `预计攻${target.name}不利：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}。`,
    attribution: attribution + `（守军 ${hold > 0 ? level : 1} 级编成；抵达第 ${arriveDay} 日）`,
    caveat: '预演基于此刻的守军与队伍；期间敌方增援、你的队伍被改派，结算会随之改变。'
      + (intelTier < 2 ? ' 守军数值为情报估算，推演不产生情报。' : ''),
  };
  /* 人话版一起下发：前端不会自己拼语句，界面才可能一致 */
  payload.narrative = previewNarrative(payload);
  return payload;
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
  /* ★ 2026-11-22：失败提示的中文文案与判定同源下发，reason 仍保留给协议/测试，
     但玩家界面一律读 text，不得把 refused / escaped / no_gold 这类内部码直出。 */
  if (!cap) return { ok: false, reason: 'no_captive', text: '该俘虏已不在营中，请刷新名单后再试。' };
  const cost = CAPTIVE_COST;
  const r = state.roleRes;
  if ((Number(r.gold) || 0) < cost) {
    return { ok: false, reason: 'no_gold', cost, text: `招降需要 ${cost} 金，当前府库不足；未扣费。` };
  }
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  const rate = captiveRecruitRate(state, cap);
  const ratePct = Math.round(rate * 100);
  const success = rngFor(state.seed ?? 20261110, st.turn ?? day, `captive:${i}:${cap.cfgId}`).random() < rate;
  if (!success) {
    cap.loyal = (cap.loyal ?? 50) - 10;
    ctx.push?.('roleRes.push', { ...state.roleRes });
    if (cap.loyal < 0) {
      state.captives.splice(i, 1);
      recordEvent(state, `敌将「${cap.name}」拒绝招降，趁夜越狱逃走。`);
      return { ok: false, reason: 'escaped', name: cap.name, rate: ratePct, gold: Math.floor(r.gold), charged: 0,
        text: `「${cap.name}」宁死不降，趁夜越狱逃走（本次把握 ${ratePct}%）；未扣金。` };
    }
    return { ok: false, reason: 'refused', name: cap.name, loyal: cap.loyal, rate: ratePct, gold: Math.floor(r.gold), charged: 0,
      text: `「${cap.name}」拒绝归降，忠诚降至 ${cap.loyal}（本次把握 ${ratePct}%）；未扣金。` };
  }
  r.gold -= cost;
  recordRes(state, 'gold', -cost, `招降·${cap.name}`, day);
  state.captives.splice(i, 1);
  const g = makeGeneral(cfg, nextId(state, 'generalId'), cap.cfgId, st.playerCity || 1, 1);
  /* ★ P47#1：新附武将忠诚走统一口径（0~100、一位小数），
     不再直接把俘虏对象 `loyal: 50` 原样塞进 state.generals。 */
  setLoyalty(g, LOYAL_BASELINE + Math.round(protagonistStat(state, '魅力') / 25));
  state.generals.push(g);
  /* ★ 2026-11-20 修：招降与酒馆/来投走同一份名册口径——
     不标记 recruited，敌将次日仍出现在酒馆可被二次登庸，招出同名同 cfgId 的重复武将。 */
  for (const p of (state.tavern?.people || [])) {
    if (Number(p.cfgId) === Number(cap.cfgId)) p.recruited = true;
  }
  /* 战法登记表增量更新（与 defectTick / 原版技能面板共用一张表） */
  const s0 = g.skills?.[0];
  if (s0?.cfgId && skillById(s0.cfgId)) {
    const row = (state.skills || []).find((x) => Number(x.cfgId) === Number(s0.cfgId));
    if (row) { if (!row.generals.includes(g.id)) row.generals.push(g.id); }
    else state.skills = [...(state.skills || []), { id: s0.cfgId, cfgId: s0.cfgId, generals: [g.id] }];
  }
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

/* ★ 2026-11-20：generalCapacity 权威实现搬到 city-econ（零依赖叶子，panels 也要用），
   这里转出一次，保持既有 import 路径有效。 */
export { generalCapacity } from './city-econ.js';
import { generalCapacity as capacityOf } from './city-econ.js';

/**
 * ★ P7 出仕：在野贤才主动来投（「名声」机制）。
 *   名声 = 城池数×8 + 帐下武将×2（封顶 10）+ 君主魅力/100；每旬掷一次，概率 3%~45%。
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
  /* ★ 2026-11-20：编制满则不再来投（见 generalCapacity 头注）。 */
  if ((state.generals || []).length >= capacityOf(state)) return null;
  const baseFame = own.length * 8 + Math.min(10, (state.generals || []).length * 2)
    + protagonistStat(state, '魅力') / 100;
  /* ★ 2026-11-20 修：版图/实力名望（不封顶）与放归名望（封顶 FAME_DEFECT_CAP）分开算，
     否则占 5 城就把总名望顶到 40 上限，之后扩张与放归对来投率再无影响。 */
  const rate = defectRate(0.03, baseFame, Number(st.fame) || 0);
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  if (rngFor(state.seed ?? 20261110, st.turn ?? day, 'defect:tavern').random() > rate) return null;
  const local = tavern.people.filter((p) => !p.recruited && own.includes(Number(p.birthCity)));
  const pool = local.length ? local : tavern.people.filter((p) => !p.recruited);
  if (!pool.length) return null;
  const pick = pool[(day * 13 + own.length * 7) % pool.length];
  const cityId = own.includes(Number(pick.birthCity)) ? Number(pick.birthCity) : (st.playerCity || own[0]);
  const g = makeGeneral(cfg, nextId(state, 'generalId'), pick.cfgId, cityId, 1);
  setLoyalty(g, 72 + Math.round(protagonistStat(state, '魅力') / 22));
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
  const fameForView = baseFame + Math.min(FAME_DEFECT_CAP, Number(st.fame) || 0);
  return { cfgId: pick.cfgId, name: pick.name, cityId, city: cityName(cityId), fame: Math.round(fameForView), rate: Math.round(rate * 100) };
}

/* ================================================================ M3-4 接线
 * 事件系统（本作设计）与宿命组合（本作设计）的运行期接线。
 * 引擎/DSL 是零依赖叶子；本段只做三件事：
 *   1. ctx 适配器：把 strategy 存档翻译成事件条件查询（全注入，引擎不知 state 形状）；
 *   2. 每旬 tick：冷却递减 → 条件筛 → pendingEvents 队列（弹窗层消费，玩家点选后落账）；
 *   3. 宿命组合加成：出征队内 ≥2 名同组武将 → 守军兵力折算 ×0.95/组（上限 2 组），
 *      推演（previewAssault）与正式结算（settleArmyBattle）同调同一函数——描述=计算=战报同源。
 * ================================================================ */

const EVENTS_PATH = resolve(ROOT, 'conf', 'campaign', 'events.json');
const EVENTS_EXTRA_PATH = resolve(ROOT, 'conf', 'campaign', 'events-extra.json');
let eventsCache = null;

/** 事件数据（conf/campaign/events.json）。构建期 check-events.mjs 已校验，这里直接读。 */
export function campaignEvents() {
  if (!eventsCache) {
    const doc = JSON.parse(readFileSync(EVENTS_PATH, 'utf8'));
    /* ★ M3-7 补量：第二批与第一批合并（id 全局唯一，tools/check-events.mjs 分文件校验） */
    const extra = JSON.parse(readFileSync(EVENTS_EXTRA_PATH, 'utf8'));
    eventsCache = [...(Array.isArray(doc) ? doc : (doc.events || [])),
      ...(Array.isArray(extra) ? extra : (extra.events || []))];
  }
  return eventsCache;
}

const SEASONS = ['春', '夏', '秋', '冬'];

/** 事件 ctx 适配器：玩家视角（字段白名单 14 项全注入）。 */
export function strategyEventCtx(state) {
  const st = ensureStrategy(state);
  const conf = factionConfFor(state);
  const cfgMap = cfgGeneralNames(state);
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  /* ★ M3-5：剧本模式下年份从剧本起算（如 190 剧本 day=1 → year=190） */
  const year = (st.scenarioYear || 184) + Math.floor((day - 1) / 360);           // 1 年 = 36 旬 = 360 日
  const dayOfYear = (day - 1) % 360;
  const season = SEASONS[Math.floor(dayOfYear / 90)] || '春';
  const turn = st.turn || 0;
  const owned = () => Object.entries(st.cities)
    .filter(([, row]) => row.owner === 'player')
    .map(([id]) => Number(id));
  const lost = () => (st.everOwned || []).filter((id) => st.cities[id]?.owner !== 'player');
  const generalNameOf = (g) => cfgMap.get(Number(g?.cfgId)) || '';
  const recruitedNames = () => new Set((state.generals || []).map(generalNameOf).filter(Boolean));
  return {
    turn,
    year,
    season,
    faction: 'player',
    cityOwned: owned,
    cityLost: lost,
    resource: (kind) => {
      /* ★ BUG审计P1-2/P1-3：事件资源口径对齐真实数据源。
       * grain 取玩家 roleRes（旧代码误取 refreshGrainSummary(state,'player')，
       * 而 st.resources 无 player 键 → 恒 0 → 粮价事件恒真/死支）。
       * 四个原本无数据源的字段接上真实域：min_loyalty←名册忠诚最小值、
       * prisoners←俘虏数、besieged_cities←玩家被围城数（字段有契约、待围城写入）、
       * supply_cut_armies←玩家在途断粮部队数。 */
      const r = state.roleRes || {};
      if (kind === 'gold') return Math.round(Number(r.gold) || 0);
      if (kind === 'grain') return Math.round(Number(r.grain) || 0);
      if (kind === 'min_loyalty') {
        const gs = (state.generals || []).filter((g) => g && !g.isStandIn);
        return gs.length ? Math.min(...gs.map((g) => Number(g.loyal) || 0)) : 100;
      }
      if (kind === 'prisoners') return Array.isArray(state.captives) ? state.captives.length : 0;
      if (kind === 'besieged_cities') {
        return Object.entries(st.cities || {})
          .filter(([id, row]) => row && row.owner === 'player' && row.besieged
            && st.cityEcon?.[Number(id)]) .length;
      }
      if (kind === 'supply_cut_armies') {
        return (st.marches || []).filter((mm) => mm && mm.side === 'player'
          && !mm.resolved && (Number(mm.supplyCutDays) || 0) > 0).length;
      }
      return Math.round(Number(r[kind]) || 0);
    },
    flag: (name) => !!(st.flags && st.flags[name]),
    relation: (a, b) => {
      // 关系口径：heroes-240 宿命组——两人同组即「有旧」（80），无组返回 null（不满足）
      const ga = fatesOfHero(a);
      return ga.some((g) => g.members.includes(b)) ? 80 : null;
    },
    generalAlive: (name) => !(st.deadGenerals || []).includes(name),
    generalInTeam: (name) => recruitedNames().has(name),
    battleLostCount: (withinTurn = 4) => (st.battleHistory || [])
      .filter((b) => !b.win && turn - b.turn < withinTurn).length,
    battleWonCount: (withinTurn = 4) => (st.battleHistory || [])
      .filter((b) => b.win && turn - b.turn < withinTurn).length,
    conf,
  };
}

/** cfgId → 武将名（一次性缓存；heroes-240 入包后新武将也在表里）。 */
let nameMapCache = null;
function cfgGeneralNames(state) {
  if (!nameMapCache) {
    nameMapCache = new Map();
    try {
      const g = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'json', 'general', 'general.json'), 'utf8'));
      for (const item of g.list || []) nameMapCache.set(Number(item.cfgId), item.name);
      const heroes = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'heroes-240.json'), 'utf8'));
      for (const h of heroes.heroes || []) if (!nameMapCache.has(Number(h.id))) nameMapCache.set(Number(h.id), h.name);
    } catch { /* 表缺失时武将名查询退化为空 */ }
  }
  return nameMapCache;
}

/** 每旬事件 tick：冷却递减 → 陈旧事件保守结算 → 筛选 → pendingEvents。未决事件不堆叠（先处理旧的）。 */
export function strategyEventTick(state) {
  const st = ensureStrategy(state);
  eventCooldownTick({ events: st.eventSys });
  /* ★ 2026-11-19 P1-4：玩家收起/忘记一条事件后，旧实现让 pendingEvents 永久非空，
     之后任何新事件都不再生成，剧情彻底停摆。超过 4 旬自动按保守项（最后一个选项）
     结算并落账，事件系统继续向前。 */
  const turnNow = Math.max(1, Number(st.turn) || 1);
  const stale = (st.pendingEvents || []).filter((e) => turnNow - (Number(e.sinceTurn) || turnNow) >= 4);
  /* ★ P61-B6：玩家可关掉自动结案。关闭后逾期事件只顺延倒计时，绝不替玩家做没点过的选择。 */
  if (stale.length && st.eventAutoResolve === false) {
    for (const e of stale) e.sinceTurn = turnNow;
    return { pending: st.pendingEvents.length, deferred: stale.length, autoResolve: false };
  }
  if (stale.length) {
    for (const e of stale) {
      const last = (e.choices || []).length ? e.choices[e.choices.length - 1] : null;
      if (last) {
        /* quiet：只留一条「逾期…按「X」结案」；不再叠「事件·抉择」行。 */
        try { strategyEventChoice(state, {}, null, { id: e.id, choice: last.id, quiet: true }); }
        catch { st.pendingEvents = (st.pendingEvents || []).filter((x) => x.id !== e.id); }
      } else {
        st.pendingEvents = (st.pendingEvents || []).filter((x) => x.id !== e.id);
      }
      recordEvent(state, `【事件·逾期】「${e.title}」久未决，按保守之策「${last?.label || '默认'}」结案。`);
    }
  }
  if ((st.pendingEvents || []).length) return { pending: st.pendingEvents.length, deferred: 0 };
  const events = campaignEvents();
  if (!events.length) return null;
  const ctx = strategyEventCtx(state);
  /* ★ M3-7 剧本前史过滤：yearMin 是下限语义，剧本起点之前的史实节点不得重演
   *  （190 剧本 day=1 → ctx.year=190，否则 184 黄巾会立即触发）。 */
  const y0 = st.scenarioYear || 184;
  const pool = (y0 > 184) ? events.filter((e) => (e.when?.yearMin ?? 184) >= y0) : events;
  /* ★ P61-S7/B5：每旬事件上限从参数表读，不再写死 2。条件事件另受降噪间隔约束。 */
  const { selected, deferred } = selectEvents(pool, ctx, {
    events: st.eventSys,
    maxPerTurn: Math.max(1, Math.round(Number(knobGet(state, 'eventPerTurnMax')) || 2)),
  });
  st.pendingEvents = selected.map((e) => ({
    id: e.id, title: e.title, layer: e.layer, priority: e.priority,
    sinceTurn: turnNow,
    speaker: e.speaker || '', text: e.text || [],
    choices: (e.choices || []).map((c) => ({ id: c.id, label: c.label, preview: c.preview || '' })),
  }));
  for (const e of selected) recordEvent(state, `【事件】${e.title}`);
  return { pending: st.pendingEvents.length, deferred: deferred.length };
}

/**
 * 把事件效果词翻译成玩家能读懂的一句话。
 * 旧版把 flag / attitude:sili 这类内部枚举直接写进日志和 toast，玩家看到的是
 * 「立flag」「attitude +15」；这里统一成「立下约定」「对曹操态度 +15」。
 * 只做展示映射，不参与任何结算；结算仍由 applyEffects 唯一落账。
 */
function describeEventEffects(applied, state) {
  const signed = (v) => `${Number(v) > 0 ? '+' : ''}${Math.round(Number(v) || 0)}`;
  return (applied || []).filter((a) => a?.kind !== 'nothing').map((a) => {
    switch (a.kind) {
      case 'flag': return `立下约定【${a.name}】`;
      case 'flag-': return `解除约定【${a.name}】`;
      case 'gold': return `金 ${signed(a.delta)}`;
      case 'morale': return `民心 ${signed(a.delta)}`;
      case 'loyalty': return `${a.target || '军中'}忠诚 ${signed(a.delta)}`;
      case 'attitude': return `对${otherName(state, a.target)}态度 ${signed(a.delta)}`;
      case 'fame': return `名望 ${signed(a.delta)}`;
      case 'city': return `${cityName(a.cityId)}归${a.owner === 'player' ? '我军' : (otherName(state, a.owner))}`;
      case 'troops': return a.text || `${cityName(a.resolvedCity || 0)}驻军 ${signed(a.delta)}`;
      case 'join': return `${a.target}来投`;
      default: return `局势变化 ${signed(a.delta)}`;
    }
  }).join('、');
}

/** ★ P61-B6：事件手动暂缓一旬（只重置倒计时，不落任何效果）。 */
export function strategyEventDefer(state, ctx, { id } = {}) {
  const st = ensureStrategy(state);
  const ev = (st.pendingEvents || []).find((e) => e.id === id);
  if (!ev) return { ok: false, reason: 'no_pending' };
  const turnNow = Math.max(1, Number(st.turn) || 1);
  ev.sinceTurn = turnNow;
  ev.deferred = (Number(ev.deferred) || 0) + 1;
  ctx?.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【事件·暂缓】「${ev.title}」倒计时重新计起，四旬后再提醒。`,
    time: Date.now(),
  });
  return { ok: true, id, untilTurn: turnNow + 4 };
}

/** ★ P61-B6：设置「逾期是否自动按保守项结案」，关掉后只顺延、不替玩家选择。 */
export function strategySetEventAutoResolve(state, ctx, { enabled } = {}) {
  const st = ensureStrategy(state);
  st.eventAutoResolve = enabled !== false;
  const turnNow = Math.max(1, Number(st.turn) || 1);
  for (const e of (st.pendingEvents || [])) e.sinceTurn = turnNow;
  return { ok: true, autoResolve: st.eventAutoResolve };
}

/**
 * ★ P61-S7：事件硬效果的三个落账口。只在玩家当前仍持有相关城池时生效，
 * 局势已经变了就返回 null —— 叙事不能覆盖玩家真实打出来的结果。
 */
function eventSetCityOwner(state, cityId, owner) {
  const st = ensureStrategy(state);
  const row = st.cities?.[Number(cityId)];
  if (!row || row.owner === owner) return null;
  if (owner !== 'player' && owner !== 'neutral'
    && !factionConfFor(state).factions.some((f) => f.id === owner)) return null;
  const before = row.owner;
  noteCityCaptured(state, PLAYER_ID, before);
  row.owner = owner;
  if (owner === 'player') {
    if (!st.everOwned.includes(Number(cityId))) st.everOwned.push(Number(cityId));
    row.troops = Math.max(500, Math.round(Number(row.troops) || 500));
  } else {
    row.troops = 0;
  }
  const e = ensureCityEcon(state)?.[Number(cityId)];
  if (e) e.morale = Math.max(0, (Number(e.morale) || 60) - 8);
  recordEvent(state, `【事件·局势】${cityName(cityId)}易主：${before === 'player' ? '我军' : before} → ${owner === 'player' ? '我军' : owner}。`);
  return { text: `${cityName(cityId)}易主` };
}

function eventAddTroops(state, where, delta) {
  const st = ensureStrategy(state);
  const owned = Object.entries(st.cities || {}).filter(([, row]) => row.owner === 'player');
  let cityId = Number(where);
  if (where === 'capital') cityId = Number(st.playerCity) || 0;
  if (where === 'frontline') {
    const allIds = Object.keys(st.cities || {}).map(Number);
    const front = owned.find(([id]) => marchableNeighbors(Number(id), allIds)
      .some((n) => st.cities?.[n] && st.cities[n].owner !== 'player'));
    cityId = Number(front?.[0]) || 0;
  }
  const row = st.cities?.[cityId];
  if (!row || row.owner !== 'player') return null;
  const before = Math.max(0, Math.round(Number(row.troops) || 0));
  row.troops = Math.max(0, before + Math.trunc(delta));
  return { resolvedCity: cityId, text: `${cityName(cityId)}驻军 ${before} → ${row.troops}` };
}

function eventJoinGeneral(state, name, where) {
  const st = ensureStrategy(state);
  const cityId = where === 'capital' ? Number(st.playerCity) || 0 : Number(where);
  if (!st.cities?.[cityId] || st.cities[cityId].owner !== 'player') return null;
  const names = cfgGeneralNames(state);
  let cfgId = [...names.entries()].find(([, n]) => n === name)?.[0];
  if (!cfgId) return null;
  const exists = (state.generals || []).find((g) => Number(g.cfgId) === Number(cfgId));
  if (exists) {
    if (Number(exists.cityId) === Number(cityId)) return null;
    exists.cityId = Number(cityId);
    return { text: `${name}赴${cityName(cityId)}报到` };
  }
  const g = makeGeneral(loadConfig(), nextId(state, 'generalId'), Number(cfgId), Number(cityId), 1);
  g.loyal = 85;
  state.generals.push(g);
  return { text: `${name}来投（${cityName(cityId)}）` };
}

/** 玩家点选事件（index.js 路由 strategy/action eventChoice）。效果词白名单落账。 */
export function strategyEventChoice(state, cfg, ctx, { id, choice, quiet } = {}) {
  const st = ensureStrategy(state);
  const idx = (st.pendingEvents || []).findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, reason: 'no_pending' };
  const ev = campaignEvents().find((e) => e.id === id)
    /* ★ M3-5：剧本开局伪事件不在 events.json 里，从 pendingEvents 现场合成（效果全 nothing） */
    || (st.pendingEvents || []).filter((p) => p.id === id).map((p) => ({
      id: p.id,
      title: p.title,
      choices: (p.choices || []).map((c) => ({ id: c.id, effects: ['nothing'] })),
    }))[0];
  if (!ev) return { ok: false, reason: 'unknown_event' };
  const clampInt = (n) => Math.round(Number(n) || 0);
  const api = {
    setFlag: (name) => { st.flags = st.flags || {}; st.flags[name] = true; },
    clearFlag: (name) => { st.flags = st.flags || {}; delete st.flags[name]; },
    addGold: (delta) => {
      const r = state.roleRes;
      r.gold = Math.max(0, Math.round((Number(r.gold) || 0) + clampInt(delta)));
      recordRes(state, 'gold', clampInt(delta), `事件·${ev.title}`, Math.floor(Number(state.clock?.day) || 1));
    },
    addMorale: (delta) => {
      // 民心：★ BUG审计P1-4：仅玩家城各 ±（城池经营口径 0..100），旧代码漏 owner 过滤误改全地图
      const econ = ensureCityEcon(state);
      const d = clampInt(delta);
      for (const [key, e] of Object.entries(econ || {})) {
        if (st.cities?.[Number(key)]?.owner !== 'player') continue;
        if (e && typeof e.morale === 'number') e.morale = Math.max(0, Math.min(100, e.morale + d));
      }
    },
    addLoyalty: (target, delta) => {
      const gs = state.generals || [];
      const d = clampInt(delta);
      let list = gs;
      if (target === '最低者' && gs.length) {
        const min = Math.min(...gs.map((g) => Number(g.loyal) || 0));
        list = gs.filter((g) => (Number(g.loyal) || 0) === min);
      } else if (target !== '全军') {
        list = gs.filter((g) => cfgGeneralNames(state).get(Number(g.cfgId)) === target);
        if (!list.length) return;
      }
      for (const g of list) g.loyal = Math.max(0, Math.min(100, (Number(g.loyal) || 0) + d));
    },
    addAttitude: (factionId, delta) => { adjustAttitudeByEvent(state, String(factionId), clampInt(delta)); },
    addFame: (delta) => { st.fame = (st.fame || 0) + clampInt(delta); },
    setCityOwner: (cityId, owner) => eventSetCityOwner(state, cityId, owner),
    addTroops: (where, delta) => eventAddTroops(state, where, delta),
    joinGeneral: (name, cityId) => eventJoinGeneral(state, name, cityId),
    turn: () => st.turn || 0,
  };
  let applied;
  try {
    applied = applyEffects({ events: st.eventSys }, ev, choice, api);
  } catch (err) {
    return { ok: false, reason: 'bad_choice', detail: String(err && err.message || err) };
  }
  const appliedText = describeEventEffects(applied, state);
  /* ★ 2026-11-20：逾期兜底走 quiet——效果照落、流水照记，但不再写一行「事件·抉择」。
     否则一次未决事件产生「触发 / 抉择 / 逾期」三行，实测占事件日志的 2/3。 */
  if (!quiet) recordEvent(state, `【事件·抉择】${ev.title}：${(ev.choices || []).find((c) => c.id === choice)?.label || choice}`
    + (appliedText ? `（${appliedText}）` : ''));
  ctx?.push?.('chat.push', {
    rid: 0, nickName: '系统', type: 0,
    msg: `【${ev.layer}】${ev.title}——${(ev.choices || []).find((c) => c.id === choice)?.label || choice}`,
    time: Date.now(),
  });
  st.pendingEvents.splice(idx, 1);
  /* appliedText 与日志同源下发，交互层直接显示，不再自己解析英文 kind。 */
  return { ok: true, id, choice, applied, appliedText, title: ev.title };
}

/**
 * 宿命组合加成（本作设计）：出征队内 ≥2 名同组宿命武将 → 该组生效，
 * 守军兵力折算 ×0.95/组（上限 2 组 ≈ ×0.9025）。
 * 只看队内成员（不查全局生死——单机战略层尚无武将死亡结算，口径写进注释防后来者加戏）。
 */
export function fateComboDefMul(state, cfg, army) {
  const names = (army?.generals || []).map((gid) => {
    const g = state.generals?.find((x) => x.id === gid);
    return g ? (cfg?.generalByCfg?.get(Number(g.cfgId))?.name
      || cfgGeneralNames(state).get(Number(g.cfgId))) : null;
  }).filter(Boolean);
  if (names.length < 2) return { mul: 1, notes: [] };
  const present = new Set(names);
  const notes = [];
  let mul = 1;
  for (const g of loadFateGroups()) {
    const inArmy = g.members.filter((m) => present.has(m));
    if (inArmy.length >= 2 && notes.length < 2) {
      mul *= 0.95;
      notes.push(`宿命「${g.title}」同队（守军折算 ×0.95）`);
    }
  }
  /* ★ P61-S12：战法标签组合。控制 / 爆发 / 续航三类凑齐两类，
     守军折算再 ×0.96——搭配本身有收益，但远小于兵力与宿命，不会变成唯一解。 */
  const tags = new Set();
  for (const gid of (army?.generals || [])) {
    const g = state.generals?.find((x) => x.id === gid);
    for (const s of (g?.skills || [])) {
      const k = skillById(s?.cfgId)?.kernel;
      if (!k) continue;
      if (k.control_state || Number(k.control_probability) > 0 || /CONTROL|DEBUFF/i.test(k.effect_type || '')) tags.add('控制');
      else if (/HEAL|RECOVER|RESTORE|BUFF/i.test(k.effect_type || '')) tags.add('续航');
      else if (/DAMAGE/i.test(k.effect_type || '')) tags.add('爆发');
    }
  }
  if (tags.size >= 2 && notes.length < 3) {
    mul *= 0.96;
    notes.push(`战法组合【${[...tags].slice(0, 3).join('·')}】（守军折算 ×0.96）`);
  }
  return { mul, notes, tags: [...tags] };
}

/** 玩家已招募武将的宿命组合视图（六府/关系网展示用）。 */
export function strategyFateView(state, cfg) {
  const names = new Set((state.generals || []).map((g) => cfg?.generalByCfg?.get(Number(g.cfgId))?.name).filter(Boolean));
  const out = [];
  for (const g of loadFateGroups()) {
    const present = g.members.filter((m) => names.has(m));
    if (present.length >= 2) out.push({ id: g.id, title: g.title, present, effect: g.effect });
  }
  return out;
}

/** 供 /__slg/strategy/state 使用。cfg 可选：不给时武将只显示 #id。 */
export function strategyViewState(state, cfg = null) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const conf = factionConfFor(state);
  /* ★ 修 bug-18：人口曾有两套字段同时下发（地图静态 population / 经济层动态 pop），
     几个月后概览与内政页会显示两个不同的数。统一以经济层为准，只留一个来源。 */
  const econAll = ensureCityEcon(state) || {};
  /* ★ U20 粮道：整张图一次 BFS（逐城调用会变成 O(n²) 路网搜索，72 城下明显卡） */
  const SUP = supplyMap(state);
  // ★ 2026-11-18：玩家势力显示层归一（举义=所举义势力名；建国=国号；旧档=我军）
  const oathF = oathFactionOf(state);
  const me = playerIdentity(state, conf);
  const nameOf = (id) => id === 'player'
    ? me.name
    : (conf.factions.find((f) => f.id === id)?.name
      || (id === conf.neutral.id ? conf.neutral.name : id));
  const colorOf = (id) => id === 'player'
    ? me.color
    : (conf.factions.find((f) => f.id === id)?.color || conf.neutral.color);
  // ★ P1-6：本地地图被遮罩挡住，来犯军必须在天下界面可见、可清剿
  /* ★ 2026-11-20：补三项玩家必须看得见的围城信息——打哪座城、还剩多少日撤围、
     那座城现在的民心。旧版只给「兵力/坐标」，玩家无法判断该不该出兵。 */
  const today0 = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  /* ★ 2026-11-20：与六府 panelState 共用 threat-view.js 的唯一映射，
     沙盘与六府不再各算一份围城预警（旧版六府页丢失围城字段）。 */
  const threats = threatRows(state, st, today0);
  return {
    turn: st.turn,
    // ★ 口径统一（2026-11-16 日志排查）：第 N 月 = turn N，与天下日志 chronicle、
    //   strategySnapshot 现行口径、测试断言（第 1 月）一致；turn 0 显示为第 1 月。
    month: Math.max(1, st.turn || 0),
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
    /* ★ 2026-11-20：势力动态（NPC 官阶晋升/学艺/登庸等背景音），与玩家事件流分开展示。 */
    dynamics: (st.dynamics || []).slice(-40).map((e) => ({
      turn: e.turn, day: e.day, text: e.text,
      month: Math.max(1, Number(e.turn) || 0),
    })),
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
      /* ★ 2026-11-17 城防：城墙耐久（玩家能看到敌军城墙打残了多少，据此决定再攻一波）。
         上限由「等级 + 城防属性」派生，当前值取存档；旧档无 wallHp → 完整城墙。 */
      ...wallFieldsOf(state, c),
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
          /* ★ P11 兵役台账：人口/户数/适龄壮丁/已征/本旬可征，界面与结算同源 */
          levy: levyView(state, c.id, { rate: knobGet(state, 'conscriptRate') }),
          /* ★ U14 该城在施/最近完工的内政任务状（进度、执行武将、每旬增量、预计完工） */
          interiorTasks: interiorTaskView(state, c.id),
          /* ★ P50 太守制：本城太守/方针与候选名单，城内页太守卡只读这份，不在界面复算资格 */
          governor: governorView(state, cfg, c.id),
          governorCands: governorCandidates(state, cfg, c.id),
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
    /* ★ P47#3：四态统一展示数据，UI 只读这份，不再散落四种分支 */
    failCheck: failureCheck(state),
    ending: evaluateEnding(state),
    /* ★ P50 太守制总览（替换旧 appointments）：城内页太守卡与六府总览共用 */
    governors: governorListView(state, cfg),
    diplomacy: diplomacyView(state),
    /* ★ M3-4 事件弹窗队列与宿命组合视图（本作设计） */
    pendingEvents: st.pendingEvents || [],
    fates: strategyFateView(state, cfg),
    /* ★ M3-5 剧本视图（本作设计）：激活剧本 + 可选清单 + 开局决策 */
    scenario: scenarioView(state),
    playerCity: st.playerCity || 0,
    // ★ P4-①：举义状态随视图下发，客户端据此决定弹不弹举义页
    oath: {
      done: !oathPending(state),
      lord: oathF?.id || null, lordName: oathF?.name || '', color: oathF?.color || '',
      city: oathOf(state).city || 0,
      // ★ 2026-11-18：显示层归一 + 自建势力状态（举义势力名/国号/自立门槛）
      identity: me,
      founded: isFounded(state) ? { ...state.founded } : null,
      foundStatus: foundStatus(state),
    },
    // ★ P6 俘虏名册（招降入口）
    captives: (state.captives || []).map((c, i) => ({
      idx: i, cfgId: c.cfgId, name: c.name, from: c.from,
      loyal: c.loyal, days: c.days,
      // 修 U08：与 panels.js / 确认框共用 captive-rules.js 唯一公式
      rate: Math.round(captiveRecruitRate(state, c) * 100),
      rateParts: captiveRateParts(state, c),
    })),
    /* ★ P11 / 本作设计 门 4/6：抵达待决的战役、占城后的消化待办 */
    pendingBattles: (st.marches || [])
      .filter((mm) => mm.side === 'player' && mm.pendingBattle && !mm.resolved)
      .map((mm) => ({
        marchId: mm.id, from: mm.from, to: mm.to, armyId: mm.armyId, frac: mm.frac ?? 1,
        fromName: map.cities.find((x) => x.id === Number(mm.from))?.name || cityName(mm.from),
        toName: map.cities.find((x) => x.id === Number(mm.to))?.name || cityName(mm.to),
        arriveDay: mm.arriveDay, troops: Number(mm.troops) || 0,
        enemyTroops: Number(st.cities[mm.to]?.troops) || 0,
        grainCost: Number(mm.grainCost) || 0, lockedSeed: mm.lockedSeed || 0,
      })),
    digest: (st.digest || []).slice(-8),
    // 可出征的城（已按行军校验过滤：关隘封锁即不可走；己方城不再算目标）
    marchable: marchableFrom(st.playerCity || 0, state),
    // ★ P2：行军队列与日内进度（客户端据此画行军线与移动军标）
    // ★ P7：带 km/speed，客户端按「剩余里程 ÷ 剩余日」画，远近军标速度才一致
    // ★ 出征面板：带 armyId / 兵力 / 两端城名 / 剩余日，行军队列可直接操作撤回
    /* ★ P62：相遇判定只算一次，逐支行军与顶层军情共用。前端据此在相遇点画对撞，
       玩家不必再从文字里猜「援军到了没」。 */
    marches: (() => {
      const cityById = {};
      for (const c of map.cities) cityById[c.id] = c;
      const todayView = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
      const clashList = detectClashes({
        marches: st.marches || [], cities: cityById, routes: map.routes, today: todayView,
      });
      const clashByMarch = {};
      for (const c of clashList) { clashByMarch[c.aId] = c; clashByMarch[c.bId] = c; }
      const clashViewOf = (mm) => {
        const c = clashByMarch[mm.id];
        if (!c) return null;
        const mine = c.aId === mm.id;
        const foeLabel = mine ? c.bLabel : c.aLabel;
        const toName = cityById[Number(mm.to)]?.name || cityName(mm.to);
        const fromName = cityById[Number(mm.from)]?.name || cityName(mm.from);
        return {
          kind: c.kind, day: c.day, at: c.at, cityId: c.cityId,
          withLabel: foeLabel,
          withTroops: mine ? c.bTroops : c.aTroops,
          text: c.kind === 'road'
            ? `${foeLabel}迎面而来，两军于${fromName}—${toName}道中相遇`
            : `${foeLabel}亦抵${/城$/.test(toName) ? `${toName}下` : `${toName}城下`}，两军会战`,
        };
      };
      return (st.marches || []).map((mm) => {
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
        /* ★ P14 UX：自动推旬需要知道「前锋抵城待主公定夺」 */
        pendingBattle: !!(mm.pendingBattle && !mm.confirmed && mm.side === 'player'),
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
        /* ★ P62：这支军在途中有没有撞上谁。没有就是 null，前端不画对撞。 */
        clash: clashViewOf(mm),
        /* ★ P62：兵种编成，沙盘按盾/弓/骑画出不同的兵卒队列 */
        order: (a?.order || 0),
        soldiers: a ? (a.soldiers || []).map((v) => Math.max(0, Number(v) || 0)) : null,
      };
      });
    })(),
    dayFrac: dayFraction(state, chapterRules().realMsPerDay),
    msPerDay: Math.max(1000, Math.round(chapterRules().realMsPerDay / (state.clock?.scale || 1))),
    gates: Object.entries((marchGraph() && marchGraph().gateStatus) || {})
      .map(([name, status]) => ({ name, status })),
    routes: map.routes.map((r) => ({ id: r.id, from: r.from, to: r.to, points: r.points, sea: r.sea })),
    /* ★ P62：最近的相遇军情（实时在途的相遇另见 marches[].clash） */
    clashes: (st.clashes || []).slice(-20),
    factions: conf.factions.map((f) => ({ id: f.id, name: f.name, color: f.color })),
    neutral: { id: conf.neutral.id, name: conf.neutral.name, color: conf.neutral.color },
    events: [...st.events].slice(-40).reverse()
      .map((e) => ({ ...e, month: Math.max(1, e.turn || 0) })),
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
