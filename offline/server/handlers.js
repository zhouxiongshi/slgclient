/**
 * 原网关全部消息的单机应答实现。
 *
 * 铁律：
 *  1) 响应 name 原样回显请求 name、seq 原样回显、code 恒 0（见 net/serverconn.go:110）
 *  2) 字段名逐字沿用 Go proto 的 json tag（大小写敏感：Confs / Wood / Members / Roles / Lists）
 *  3) 只提供「玩家动态数据」；地图、城池、建筑、武将、技能的静态配置由原客户端
 *     从自己的 resources 加载，本服务一个都不碰 —— 画面因此 100% 不变
 */
import {
  nextId, findGeneral, findArmy, mainCity, makeGeneral,
  makeBuild, makeArmy, makeFacilityList,
} from './world.js';
import { resolveBattle } from './battle.js';
import { skillById } from './skills.js';
import { desText } from './domain/battle-narrative.js';
/* ★ M4-13：两条占领路径共用同一套俘虏判定 */
import { captureFromBattle } from './domain/captives.js';
import { marchMs, rewindDays } from './clock.js';
import { facilityBonus, recordRes } from './domain/economy.js';
/* ★ M4-12：生效设施单一权威清单 —— 结算判据与两处 UI 的显示清单同源。 */
import { EFFECTIVE_ADDITIONS, isActiveFacility, facilityView } from './domain/facility-catalog.js';
import { cityLayer, ensureCityEcon, conscriptFactor, cityYield, cityName, playerGoldYield, playerGrainYield, playerStockYield } from './domain/city-econ.js';
/* ★ P11 兵役制：一户一丁 / 妇孺免征 / 一旬一征 / 先养人口，唯一权威源 */
import { checkLevy, commitLevy, levyView, farmConflictOf } from './domain/levy.js';
import {
  chapterRules, settleCampaign, chooseChapter, onTileCleared, applyChoice, noticeRecruit,
} from './domain/campaign.js';
import { slotBlock, slotUnlock, skillUpgradeCost, skillUpgradeBlock, SKILL_LEVEL_CAP, skillActionHint } from './domain/slots.js';
import { grantBattleExp, levelUpSentence, generalProgress, takeBattlePromos } from './domain/general-progress.js';
import { RANK_NAMES } from './domain/official-rank.js';
/* ★ P12 操作回执：原版客户端 onUpSkill/onLvSkill/onDownSkill 只 console.log，
   拒绝时玩家零反馈（「点了学习没反应」）。回执进 notice-bus，
   由 /__slg/session 轮询带给注入外壳转 toast。 */
import { notify } from './notice-bus.js';
import { materialGuide } from './domain/armory.js';
import { rngFor } from './domain/strategy-rng.js';
import { ensureTavern, guestsNow, announceTavern, todaysGuests, dayFraction, exploreTalent, cityNameOf } from './domain/tavern.js';
/* ★ U15 相性/义理/关系网：登庸成功率与面板构成条同源 */
import { talentRecruitRate, xiangxingOf, yiliOf, relationSummary, relationGraph } from './domain/relation.js';
/* ★ 2026-11-16：招募拒绝台词（零依赖叶子），按人设与三顾次数说人话 */
import { refusalLine, failLine } from './domain/recruit-refusal.js';
import {
  strategyTick, strategyAttack, strategyTurnDays, ensureStrategy, clearThreat,
  strategyResolveMarches, strategyRecallMarch, recordEvent, factionReliefTick,
  assaultBattleTick, assaultEscalationTick, dispatchTick, stageGoalTick, clashTick, strategyMap,
} from './domain/strategy.js';
/* ★ P67：本地清剿与战略攻城共用同一套「折损拆阵亡/负伤、伤兵回城」口径 */
import { splitCasualties, routeWounded } from './domain/casualties.js';
import { createHash } from 'node:crypto';
import { noteIfGeneralDown } from './command.js';
import { factionTraitOf, protagonistStat, oathPending } from './domain/oath.js';
import { conscriptNeed, checkSlotCaps, splitEven, affordableConscript, planDisarm, ARMS_NAMES } from './domain/conscript.js';
/* ★ P54：编队资格（同城 / 一人一队 / 派生 order）唯一口径，与六府整编共用。 */
import { formationGeneralCheck, syncGeneralOrders, releaseSlot, disbandArmy, normalizeArmyOrders } from './domain/formation.js';
import { foundNation, foundStatus, playerIdentity } from './domain/faction-identity.js';

const OK = 0;
const nowSec = () => Math.floor(Date.now() / 1000);
const clone = (v) => JSON.parse(JSON.stringify(v));
const RES_KEYS = ['wood', 'iron', 'stone', 'grain'];

/**
 * ★ 抓 bug-1：城归属判定。
 * 战略城以 owner === 'player' 为准；未举义时玩家只有本地主城（state.citys[0]），
 * 那种情况下沿用旧档语义，但**只认这一座**，不会给任意 id 开口子。
 */
function isOwnCity(state, cityId) {
  const cid = Number(cityId) || 0;
  if (cid <= 0) return false;
  const st = state.strategy || {};
  if (st.cities?.[cid]?.owner === 'player') return true;
  const local = (state.citys || [])[0];
  if (!local) return false;
  const localIds = [Number(local.cityId), Number(local.id)].filter((v) => v > 0);
  if (!localIds.includes(cid)) return false;
  return !Object.values(st.cities || {}).some((v) => v.owner === 'player');
}

/** 简单口令摘要：离线版不落明文（bug-19），只留不可逆摘要 + 首次登录标记。 */
function passwordDigest(raw) {
  return createHash('sha256').update(`shuanghan:${String(raw || '')}`).digest('hex').slice(0, 32);
}

/**
 * ★ 修 bug-6/21：取某座城的设施表。
 * 战略城用 `s<id>` 键（举义时批量建好、占新城后懒建），本地主城沿用数字键；
 * 两者编号会撞（都为 1），所以战略城首次取用时把数字键那份旧进度迁过去，不丢升级。
 */
function ownFacilityList(state, cfg, cityId) {
  const cid = Number(cityId) || 0;
  if (!state.facilities) state.facilities = {};
  const localId = Number((state.citys || [])[0]?.cityId) || 0;
  const isStrategyCity = !!(state.strategy?.cities?.[cid]);
  /* 本地主城的编号（通常是 1）与战略城会撞号：那座城就是同一座，继续用数字键，
     免得把原版已升级的设施进度分叉成两份。其它战略城才走 s<id>。 */
  const key = (isStrategyCity && cid !== localId) ? `s${cid}` : String(cid);
  if (!Array.isArray(state.facilities[key])) {
    const legacy = state.facilities[cid];
    state.facilities[key] = Array.isArray(legacy) && key !== String(cid)
      ? JSON.parse(JSON.stringify(legacy))
      : makeFacilityList(cfg);
  }
  return state.facilities[key];
}

/**
 * 协议入参数值规范化（防 NaN / null 污染存档）。
 * 客户端偶发会带 null、字符串或 NaN（例如拖拽坐标未初始化）。服务端直接
 * Number() 会得到 NaN，JSON 序列化后变成 null 写进存档，重启后客户端读
 * `.x/.y` 就崩（crash.log 中的 reading 'y' / 'width'）。
 * 这里统一把已知数值字段转成有限数；字符串型字段（名称、章节选项、聊天内容）
 * 一律原样保留，避免误伤剧情/聊天协议。
 */
const NUMERIC_KEYS = new Set([
  'x', 'y', 'cityId', 'order', 'position', 'pos', 'gId', 'generalId', 'armyId',
  'id', 'rid', 'RId', 'uid', 'level', 'lv', 'type', 'fType', 'cfgId', 'skillId',
  'seq', 'cnt', 'num', 'count', 'star', 'starLv', 'decree', 'ctime', 'time',
  'index', 'slot', 'scale', 'curDurable', 'maxDurable',
]);
const ARRAY_NUMERIC_KEYS = new Set(['cnts', 'from', 'to', 'generals', 'soldiers', 'levels']);
function sanitizeMsg(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = { ...raw };
  for (const [k, v] of Object.entries(out)) {
    if (NUMERIC_KEYS.has(k)) {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : 0;
    } else if (ARRAY_NUMERIC_KEYS.has(k) && Array.isArray(v)) {
      out[k] = v.map((n) => { const x = Number(n); return Number.isFinite(x) ? x : 0; });
    } else if (typeof v === 'number' && !Number.isFinite(v)) {
      out[k] = 0;
    }
  }
  return out;
}

/** 原版错误码（slgserver/constant/code.go），客户端据此弹原版提示框。 */
const CODE = {
  InvalidParam: 1,
  CityNotMe: 11,
  UpError: 12,
  ResNotEnough: 16,
  BuildNotMe: 21,
  DecreeNotEnough: 25,
  CanNotBuildNew: 49,
  CanNotUpBuild: 53,
  CanNotDestroy: 54,
  OutCollectTimesLimit: 55,
  InCdCanNotOperate: 56,
  NotHasJiShi: 58,
};

/**
 * 设施升级进度（★ P34：工期按游戏日，不再按真实秒）。
 * up_day 记开工的游戏日；老存档只有秒级 up_time，首次读取时以当前日为起点，
 * 保证旧档不会瞬间跳级，也不会永远卡在升级中。
 */
function facilityProgress(state, cfg, f) {
  const days = Math.max(0, Math.round(Number(cfg.facilityUpgradeDays?.(f.type, f.level + 1)
    ?? cfg.facilityTime(f.type, f.level + 1)) || 0));
  const active = Number(f.up_time) > 0;
  let startDay = Number(f.up_day) || 0;
  if (active && !startDay) {
    startDay = Number(f.up_time) > 1e9 ? Number(state.clock?.day) || 1 : Number(f.up_time);
    f.up_day = startDay;
  }
  const passed = active ? Math.max(0, (Number(state.clock?.day) || 1) - startDay) : 0;
  return { days, active, startDay, passed, remain: active ? Math.max(0, days - passed) : 0 };
}

/** 设施被动升级（到点后在读取时自动完成；完成判据是游戏日，不是墙上时钟）。 */
function facilityGetLevel(state, cfg, f) {
  if (Number(f.up_time) > 0) {
    const p = facilityProgress(state, cfg, f);
    if (p.days > 0 && p.passed >= p.days) {
      f.level += 1;
      f.up_time = 0;
      f.up_day = 0;
    }
  }
  return f.level;
}

/** 所有城池设施被动升级（每次请求前调用）。 */
function tickFacilities(state, cfg) {
  for (const list of Object.values(state.facilities || {})) {
    for (const f of list) facilityGetLevel(state, cfg, f);
  }
}

/**
 * 领地建筑（要塞）建造/升级/拆除到点完成（复刻 MapRoleBuild.ToProto 的被动结算）：
 *  op_level > 0 → 建造/升级完成，level = op_level；
 *  op_level == 0 → 拆除完成，恢复为地图资源地（ConvertToRes 语义）。
 * @returns {Array} 完成变化的建筑
 */
function tickBuilds(state, cfg) {
  const done = [];
  for (const b of state.builds) {
    // ★ 工期判断只看 end_time：旧版依赖 op_level !== level，建造中的领地若
    //   level 恰好等于目标等级就会永远卡住；旧存档的 level=0 也能在这里被纠正。
    const end = b.end_time || 0;
    if (end <= 0 || nowSec() < end) continue;
    const inProgress = b.building || (b.op_level ?? b.level) !== b.level;
    if (!inProgress && (b.op_level ?? 0) !== 0) continue;
    if ((b.op_level ?? 0) === 0) {
      const [t, lv] = cfg.tileAt(b.x, b.y);
      const conf = cfg.confs.find((c) => c.type === t && c.level === (lv || 1))
        || cfg.confs.find((c) => c.type === t)
        || { durable: 10000, defender: 1, name: '领地' };
      b.type = t;
      b.level = lv || 1;
      b.name = conf.name || '领地';
      b.wood = conf.wood ?? 0;
      b.iron = conf.iron ?? 0;
      b.stone = conf.stone ?? 0;
      b.grain = conf.grain ?? 0;
      b.maxDurable = conf.durable ?? 10000;
      b.curDurable = Math.min(b.maxDurable, b.curDurable || b.maxDurable);
      b.defender = conf.defender ?? 1;
      b.op_level = b.level;
    } else if (b.op_level !== b.level || b.building) {
      b.level = b.op_level;
      const c = cfg.buildCustomCfg(b.type, b.level);
      if (c) {
        b.name = c.name ?? b.name;
        b.maxDurable = c.durable ?? b.maxDurable;
        b.curDurable = Math.min(b.maxDurable, b.curDurable || b.maxDurable);
        b.defender = c.defender ?? b.defender;
      }
    } else {
      continue;
    }
    b.end_time = 0;
    b.building = false;
    done.push(b);
  }
  return done;
}

/** 设施加成（复刻 facilityMgr.GetYield / GetDepotCapacity）。 */
function facilityAdditions(state, cfg) {
  const y = { wood: 0, iron: 0, stone: 0, grain: 0, gold: 0, capacity: 0 };
  const localId = Number(state.citys?.[0]?.cityId) || 0;
  for (const [key, list] of Object.entries(state.facilities || {})) {
    /* 城池失守后设施表还在，但加成必须归当前城主。
       ownFacilityList 的键约定：战略城 s<id>，本地主城/旧档用纯数字 id。 */
    const cid = /^s\d+$/.test(key) ? Number(key.slice(1))
      : (/^\d+$/.test(key) ? Number(key) : 0);
    const cityRow = cid ? state.strategy?.cities?.[cid] : null;
    /* 序章/旧档的本地主城沿用数字键，战略层 mirror 的 owner 可能还是 NPC，
       但此时设施仍属玩家（不按 mirror 处理）；举义后则一律按当前归属判。 */
    const localPrologue = cid === localId && state.oath?.done !== true;
    if (cityRow?.owner && cityRow.owner !== 'player' && !localPrologue) continue;
    for (const f of list || []) {
      const lv = facilityGetLevel(state, cfg, f);
      if (lv <= 0) continue;
      const values = cfg.facilityValues(f.type, lv);
      cfg.facilityAdditions(f.type).forEach((aType, i) => {
        const bonus = facilityBonus(state, aType, chapterRules());
        const v = Math.floor((values[i] || 0) * (1 + bonus));
        /* ★ M4-12：写入轴与 EFFECTIVE_ADDITIONS 同源，界面说生效的设施这里必读。 */
        const axis = EFFECTIVE_ADDITIONS[aType];
        if (axis) y[axis] += v;
      });
    }
  }
  return y;
}

/** 领地建筑产量（复刻 roleBuildMgr.GetYield；原版把粮食误加给石矿，此处按正确语义）。
 *  ★ 2026-11-19 玩法修复：这些「土地」是序章坞堡周边的领地建筑。玩家举义后已经离开
 *  坞堡、改以城池为基本盘，旧实现却继续按静态字段发产量——实测土地Lv.7 单条就供
 *  7000 石/日，10 旬把府库石头从 1 万顶到 74 万、20 旬撞上 100 万上限，木/铁同理。
 *  举义后一律停发，资源改由城池与设施产出（cityYield 已同步上调，保证仍能自持）。 */
function buildYield(state) {
  const y = { wood: 0, iron: 0, stone: 0, grain: 0 };
  if (state.oath?.done === true) return y;
  for (const b of state.builds) {
    y.wood += b.wood || 0;
    y.iron += b.iron || 0;
    y.stone += b.stone || 0;
    y.grain += b.grain || 0;
  }
  return y;
}

/** 总产量 = 基础 + 设施 + 领地（复刻 GetYield），并同步回 role_res 供客户端界面显示。
 *  ★ P2 城市经营：叠加玩家名下城池的逐城加成层（农/商开发度 + 特产）。 */
function totalYield(state, cfg) {
  const base = cfg.basic.role || {};
  const fa = facilityAdditions(state, cfg);
  const by = buildYield(state);
  const cl = cityLayer(state);
  const r = state.roleRes;
  r.wood_yield = playerStockYield(state, 'wood', base.wood_yield ?? 1000, fa.wood, by.wood);
  r.iron_yield = playerStockYield(state, 'iron', base.iron_yield ?? 1000, fa.iron, by.iron);
  r.stone_yield = playerStockYield(state, 'stone', base.stone_yield ?? 1000, fa.stone, by.stone);
  r.grain_yield = playerGrainYield(state, base.grain_yield ?? 1000, fa.grain, by.grain);
  r.gold_yield = playerGoldYield(state, base.gold_yield ?? 1000, fa.gold);
  /* ★ 2026-11-19 玩法修复：府库上限旧为常量 100 万，木/铁/石 20 旬内全部封顶，
     采集系统彻底失去意义。改成「有城后随城数派生」：10 万起底 + 每城 2 万，
     5 城约 20 万，既留出周转空间，又让资源在 3~5 旬尺度上真正流动。
     序章（尚无城）沿用配置基数，不影响原有坞堡节奏。 */
  const ownedCities = Object.values(state.strategy?.cities || {})
    .filter((row) => row?.owner === 'player').length;
  r.depot_capacity = ownedCities > 0
    ? 100000 + ownedCities * 20000 + fa.capacity
    : ((base.depot_capacity ?? 1000000) + fa.capacity);
  r.city_layer = cl;   // 内政面板「城池加成」明细展示用
  return r;
}

/** 3 槽数组归一化：补长、去 NaN/null、取非负整数。 */
function normalizeTriple(list) {
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    out[i] = Math.max(0, Math.floor(Number(list?.[i]) || 0));
  }
  return out;
}

/** 原版 TryUseNeed：政令不足→25，资源不足→16，成功扣除→0。
 *  ★ P1：带 reason 时逐项写入收支流水，玩家在府库能看到「钱花哪了」。 */
function tryUseNeed(state, need, reason) {
  const r = state.roleRes;
  const n = {
    decree: need?.decree ?? 0, wood: need?.wood ?? 0, iron: need?.iron ?? 0,
    stone: need?.stone ?? 0, grain: need?.grain ?? 0, gold: need?.gold ?? 0,
  };
  if (n.decree > (r.decree || 0)) return CODE.DecreeNotEnough;
  if (n.wood > (r.wood || 0) || n.iron > (r.iron || 0) || n.stone > (r.stone || 0)
    || n.grain > (r.grain || 0) || n.gold > (r.gold || 0)) return CODE.ResNotEnough;
  r.decree -= n.decree;
  r.wood -= n.wood;
  r.iron -= n.iron;
  r.stone -= n.stone;
  r.grain -= n.grain;
  r.gold -= n.gold;
  if (reason) {
    for (const [k, v] of Object.entries(n)) {
      if (v > 0 && k !== 'decree') recordRes(state, k, -v, reason);
    }
    if (n.decree > 0) recordRes(state, 'decree', -n.decree, reason);
  }
  return OK;
}

/**
 * 世界日结算：请求内与「服务端定时器」共用同一个入口。
 *
 * ★ 试玩 P0-1：原先只有收到客户端请求才结算，窗口失焦 / 玩家长时间不点界面时
 *   世界直接停摆（day、accMs、savedAt 纹丝不动）。现在由 index.js 每 500ms
 *   调一次，时钟与请求彻底解耦；请求内再调只是为了「读完就拿到最新值」。
 *
 * 返回 { days, day, builds }：days>0 才需要落盘，避免 500ms 写一次存档。
 */
/** 征兵按游戏日入营。墙上的定时器故意放得很晚，这里才是玩家看得到的到账。 */
function deliverDueConscripts(ctx) {
  const day = Math.floor(Number(ctx.state.clock?.day) || 1);
  for (const army of ctx.state.armys || []) {
    const due = Math.floor(Number(army.conArriveDay) || 0);
    if (!due || day < due) continue;
    const cnts = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army.con_cnts?.[i]) || 0)));
    if (!cnts.some((n) => n > 0)) { army.conArriveDay = 0; continue; }
    processTask(ctx, { type: 'conscript_done', armyId: army.id, cnts, token: army.conToken });
  }
}

export function settleWorld(ctx, now = Date.now()) {
  const { state, cfg } = ctx;
  /* ★ P57：不依赖重启——老档同城重复队号在任意 WS 请求入口先拆开，
     否则征兵页仍按 order 覆盖掉主公所在的真队伍。 */
  normalizeArmyOrders(state);
  tickFacilities(state, cfg);
  totalYield(state, cfg);
  /* ★ P63 修：待决战斗不再冻结全局时钟。
     旧实现在这里按 pendingBattle 设 decisionHold，审计/挂机脚本没有真人界面去续期
     uiHoldUntil，时钟从此 days=0 空转（M4-4 灭国闭环因此永远触发不了）。
     待决战斗本来就只认玩家显式 confirmBattle / retreat，不会自己打完；
     「玩家看弹窗时停日子」由真客户端 /__slg/clock/hold 的 uiHoldUntil 负责，
     弹窗关掉后继续走日也不改变仗还停在城下等待的事实。 */
  /* 旧档只有墙上的征兵倒计时、没有入营日：改记到下一日，避免重启后兵永远不到。 */
  const today = Math.floor(Number(state.clock?.day) || 1);
  for (const army of state.armys || []) {
    const pending = [0, 1, 2].some((i) => Math.floor(Number(army.con_cnts?.[i]) || 0) > 0);
    if (pending && !Math.floor(Number(army.conArriveDay) || 0)) army.conArriveDay = today + 1;
  }
  const settled = settleCampaign(state, cfg, ctx, now);
  if ((settled?.days || 0) > 0) deliverDueConscripts(ctx);
  // ★ P2：行军到达结算（在诸侯推演之前，保证当天抵达当天开打；战报与播报由内部推）
  /* ★ P14：驰援感知在到达结算**之前**跑——玩家大军在途时守方就有机会派援军
     ★ P67：相遇判定排在驰援之后、抵达结算之前——先记「两军撞上了」，
       再由 strategyResolveMarches 把相遇敌军并进守军、抵城自动开战；
       顺序反了就会漏掉最后一天的遭遇，或把同一支援军算两遍。 */
  factionReliefTick(state, cfg, ctx);
  clashTick(state, cfg, ctx);
  strategyResolveMarches(state, cfg, ctx);
  /* ★ P73：诸侯来犯抵达当日就打完守城战（内核结算 + 战报 + 回放），
     不再「走到城下就消失、40 日后再抽象围城」。
     顺序必须在 marches 解析之后（当天抵达当天打、驰援已并兵入守），
     在围城推进之前（打完就撤营，围城只留给没有抵达日的旧档营地）。 */
  assaultBattleTick(state, cfg, ctx);
  /* ★ 2026-11-19：来犯军围城推进。旧版来犯军摆在家门口没有任何后果，
     世界对玩家零压力；现在 40 日不清剿就围城，围城每旬掉守军/民心。 */
  assaultEscalationTick(state, cfg, ctx);
  /* ★ P74：武将调遣在旬界落城（抵达日到点才改驻地、发军情）。
     放在行军/开打之后：当天抵达的部队先结算，再让赴任武将入城，避免抢同一城的编制。 */
  dispatchTick(state, cfg, ctx);
  stageGoalTick(state, cfg, ctx);
  strategyTick(state, cfg, ctx, now);
  ensureTavern(state, cfg);
  announceTavern(state, ctx, chapterRules().realMsPerDay);
  const finishedBuilds = tickBuilds(state, cfg);
  for (const b of finishedBuilds) ctx.push?.('roleBuild.push', b);
  return { days: settled.days, day: state.clock.day, builds: finishedBuilds.length };
}

/**
 * 推演一月：原子地把时钟推到下一个回合日，并立刻执行一次诸侯决策。
 * ★ 试玩 P0-1：旧实现只发一个 tick，天数不够时返回 {skipped:true} 且界面无提示，
 *   玩家点了跟没点一样。现在要么真的推进 10 天，要么返回还差几天。
 */
export function advanceToNextTurn(ctx, now = Date.now()) {
  const { state, cfg } = ctx;
  const st = ensureStrategy(state);
  /* ★ P61-S6：终局史评出现后冻结回合，只有玩家显式「继续沙盘」才恢复。 */
  if (st.endGameFrozen && st.grandEnding) {
    return { ok: false, reason: 'ending_frozen', days: 0, ending: st.grandEnding };
  }
  const turnDays = strategyTurnDays();
  const turnBefore = st.turn;
  const target = (st.lastTurnDay || 0) + turnDays;
  const need = Math.max(0, target - (state.clock?.day ?? 1));
  /* 修 U22：旧实现每次都用 rewindDays 伪造「已过 10 日」再结算，连点可无限推进，
     回合门槛形同虚设，且界面不告诉玩家发生了什么。现在不再假装是「回合到了」：
       - need > 0 明确标记为 fast-forward（自由快进），返回真实推进天数与结算摘要；
       - need === 0 才是正式回合结算 turn-settle；
       - 摘要供「推进前预览」使用（本作约定 / P3 / P8：规则 100% 透明）。 */
  const fastForward = need > 0;
  const preview = {
    days: need || turnDays,
    marching: (st.marches || []).filter((m) => !m.resolved).length,
    arriving: (st.marches || []).filter((m) => !m.resolved && m.arriveDay <= target).length,
    captives: (state.captives || []).length,
    lowLoyalty: (state.generals || []).filter((g) => (g.loyal ?? 88) < 70).length,
    treasury: Math.floor(Number(state.roleRes?.gold) || 0),
    note: fastForward
      ? `快进 ${need} 日：按真实天数补算产出、军饷、行军、灾害与事件（非额外奖励）`
      : '正式回合结算：执行诸侯决策与旬度事件',
  };
  if (need > 0) {
    // rewindDays 把上次结算时刻拨回 need 个游戏日，下一次 settle 正好补足
    rewindDays(state, need, chapterRules(), now);
    settleWorld(ctx, now);
  } else {
    strategyTick(state, cfg, ctx, now);
  }
  return {
    skipped: st.turn === turnBefore,
    advanced: need,
    advancedDays: need,
    mode: fastForward ? 'fast-forward' : 'turn-settle',
    preview,
    day: state.clock.day,
    turn: st.turn,
    /* ★ 口径统一：month = turn（与天下日志 chronicle 同源），turn 0 兜底为 1。 */
    month: Math.max(1, st.turn || 0),
    nextTurnDay: (st.lastTurnDay || 0) + turnDays,
    need: Math.max(0, (st.lastTurnDay || 0) + turnDays - state.clock.day),
  };
}

/** 征兵工期：原版 1 秒/兵，单机下压到 2~30 秒，并给出 ETA 让界面能显示倒计时。 */
function conscriptSec(total, secPerTroop = 1) {
  const raw = Math.ceil(total * Math.max(0.001, Number(secPerTroop) || 1) * 0.02);
  return Math.max(2, Math.min(30, raw));
}

function roleResOf(state) {
  return clone(state.roleRes);
}

function armyById(state, id) {
  return findArmy(state, Number(id));
}

/** 主公不在一般武将配置表里：统一用角色昵称兜底，别再露出「武将880001」。 */
function generalDisplayName(state, cfg, g) {
  if (!g) return '';
  if (g.isProtagonist || Number(g.cfgId) === 880001) return state.role?.nickName || '主公';
  return cfg.generalByCfg?.get?.(Number(g.cfgId))?.name || g.name || '';
}

/** 玩家已拥有技能 = 所有武将装配技能的去重集合（原 proto.Skill{id,cfgId,generals}）。 */
function withGeneralNames(state, cfg, list) {
  return list.map((g) => ({
    ...g,
    name: generalDisplayName(state, cfg, g),
    star: g.star ?? 0,
    skills: (g.skills || []).map((s) => {
      if (!s) return null;
      const conf = skillById(s.cfgId);
      const lv = Math.max(1, Math.trunc(Number(s.lv) || 1));
      const maxed = lv >= SKILL_LEVEL_CAP;
      const block = skillUpgradeBlock(g, s);
      return {
        ...s,
        name: conf?.ui?.name || conf?.name || '',
        des: desText(conf, lv),
        nextDes: maxed ? '' : desText(conf, lv + 1),
        upgradeCost: maxed ? 0 : skillUpgradeCost(lv),
        upgradeBlock: block === 'need_general_level' ? skillActionHint(block, 0, lv + 1) : '',
        maxed,
        probability: conf?.ui?.levels?.[lv - 1]?.probability ?? null,
      };
    }),
    progress: generalProgress(g),
    /* ★ P58：原客户端「武将战法」页只显示「学习槽未开：武将要到 5 级」，
       不显示当前等级与还差几级。这里把三个槽的门槛一起下发，
       界面（skills.js）只渲染，门槛口径仍在 domain/slots.js 一处。 */
    slotRules: [0, 1, 2].map((pos) => slotUnlock(g, pos)),
  }));
}
function syncOwnedSkills(state) {
  const owned = new Map();
  for (const g of state.generals) {
    for (const s of (g.skills || [])) {
      if (!s || !s.cfgId || !skillById(s.cfgId)) continue;
      if (!owned.has(s.cfgId)) owned.set(s.cfgId, { id: s.cfgId, cfgId: s.cfgId, generals: [] });
      owned.get(s.cfgId).generals.push(g.id);
    }
  }
  state.skills = [...owned.values()];
  return state.skills;
}

/** 装配 / 卸下 / 升级都按「技能槽 pos」操作（原客户端 lvSkill 只发 {gId,pos}）。 */
function ensureSlots(g) {
  if (!Array.isArray(g.skills)) g.skills = [];
  while (g.skills.length < 3) g.skills.push(null);
  return g.skills;
}

/** 定时任务的统一入口（存档里持久化，进程重启后继续）。 */
export function processTask(ctx, task) {
  const { state, cfg } = ctx;
  if (task.type === 'battle_arrive') {
    const army = armyById(state, task.armyId);
    if (!army) return;
    const begin = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army.soldiers?.[i]) || 0)));
    const { report, kernel, endAttackSoldiers, expByGeneral } = resolveBattle({
      cfg, state, army, x: task.x, y: task.y, seed: task.seed,
    });
    /* ★ P67：清剿也算伤亡——负伤者退出队伍，退往周边最近己方城与出发城。 */
    const casualties = splitCasualties({
      lossBySlot: begin.map((n, i) => Math.max(0, n - (endAttackSoldiers[i] || 0))),
    });
    const woundedTo = routeWounded(state, {
      wounded: casualties.wounded,
      killed: casualties.killed,
      fromCityId: Number(army.cityId) || ensureStrategy(state).playerCity || 0,
      battleCityId: 0,
      mapCities: strategyMap().cities,
      playerCityFallback: oathPending(state),
    });
    army.soldiers = endAttackSoldiers;
    const where = woundedTo.map((w) => `${w.name} ${w.count}`).join('、');
    if (casualties.totalWounded > 0) {
      const note = `折损中阵亡 ${casualties.totalKilled}、负伤 ${casualties.totalWounded}${where ? `，伤兵退往${where}` : '，伤兵流散未入城'}。`;
      report.summary = `${report.summary || ''}${note}`;
      recordEvent(state, `${report.summary}`);
    }
    report.analysis = {
      ...(report.analysis || {}),
      killed: casualties.totalKilled, wounded: casualties.totalWounded,
      killedBySlot: casualties.killed, woundedBySlot: casualties.wounded,
      woundedTo, auto: true,
    };
    army.cmd = 0;
    army.state = 1;
    army.to_x = 0; army.to_y = 0; army.end = 0;
    noteIfGeneralDown(state, ctx, army);
    const ups = grantBattleExp(state, cfg, expByGeneral, { win: report.result === 2 });
    const expLine = levelUpSentence(ups);
    /* ★ 2026-11-16：功勋晋升入战报，玩家看得见「立功→升官」。 */
    const promos = takeBattlePromos();
    const promoLine = promos.length
      ? ` ${promos.map((p) => `${p.name}积功升为${RANK_NAMES[p.rank]}`).join('，')}。`
      : '';
    if ((expLine || promoLine) && report) report.summary = `${report.summary || ''}${expLine}${promoLine}`;
    state.warReports.unshift(report);
    if (state.warReports.length > 100) state.warReports.length = 100;

    // 胜利后占领该格：沿用原有 roleBuild.push 逻辑。黄巾格先清掉守军并还原产量，再推送。
    if (report.result === 2) {
      /* ★ M4-13：地图格占领同样落俘虏。过去只有战略层 settleArmyBattle 写
         state.captives，而玩家常规 army.assign 走的是这条路径 —— 于是占下的
         大多数地盘「抓了将却没处招降」，招降按钮永远不出现。 */
      const added = captureFromBattle(state, cfg, {
        report,
        place: `(${task.x},${task.y})`,
        day: Math.floor(Number(state.clock?.day) || 1),
        seed: state.seed ?? 20261110,
      });
      if (added.length) {
        const names = added.map((c) => c.name).join('、');
        report.summary = `${report.summary || ''} 阵前擒得敌将「${names}」，可在武将府招降／释放／处斩。`;
        for (const c of added) {
          recordEvent(state, `(${task.x},${task.y}) 告捷，敌将「${c.name}」被俘，押入大营听候发落。`);
        }
      }
      onTileCleared(state, cfg, task.x, task.y);
      const [type, level] = cfg.tileAt(task.x, task.y);
      const exists = state.builds.find((b) => b.x === task.x && b.y === task.y);
      if (exists) {
        exists.rid = state.role.rid;
        exists.giveUp_time = 0;
        ctx.push('roleBuild.push', exists);
      } else {
        const build = makeBuild(cfg, { rid: state.role.rid, x: task.x, y: task.y, type, level: level || 1 });
        state.builds.push(build);
        ctx.push('roleBuild.push', build);
      }
    }

    ctx.push('warReport.push', report);
    ctx.push('army.push', army);
    ctx.push('roleRes.push', roleResOf(state));
    for (const gid of army.generals) {
      const g = findGeneral(state, gid);
      if (g) ctx.push('general.push', g);
    }
    ctx.save();
    ctx.log('info', `battle#${report.id} at(${task.x},${task.y}) result=${report.result} events=${kernel.events.length} fp=${kernel.event_fingerprint}`);
    return;
  }

  if (task.type === 'conscript_done') {
    const army = armyById(state, task.armyId);
    if (!army) return;
    /* ★ 2026-11-19 P1-5：令牌不一致 = 玩家已解甲/重新征兵，旧定时器不得再补兵。
       旧档/旧任务没有 token，保持原行为兼容。 */
    if (task.token != null && army.conToken != null && task.token !== army.conToken) return;
    // ★ 试玩 P1-2：soldiers 只有 1 个元素时，旧写法 undefined + 0 = NaN，
    //   Math.max(0, NaN) 仍是 NaN，JSON 序列化成 null 写进存档。
    //   这里先补齐数组并按「有限整数」入账，绝不让 null/NaN 落盘。
    army.soldiers = normalizeTriple(army.soldiers);
    army.con_times = normalizeTriple(army.con_times);
    army.con_cnts = normalizeTriple(army.con_cnts);
    /* ★ P55：行军中抵达的在途兵不得补进队伍——出征兵力/军粮已按出发快照锁定，
       中途补兵等于白嫖战力且预览失真。资源已扣，兵改退驻城，绝不蒸发。 */
    if (army.marchId) {
      const totalBack = [0, 1, 2].reduce((s, i) => s + Math.max(0, Math.floor(Number(task.cnts?.[i]) || 0)), 0);
      const home = state.strategy?.cities?.[Number(army.cityId)]
        || Object.values(state.strategy?.cities || {}).find((c) => c && c.owner === 'player');
      if (home && totalBack > 0) {
        home.troops = Math.max(0, Math.floor(Number(home.troops) || 0) + totalBack);
        recordEvent(state, `第 ${army.order} 军行军期间征兵 ${totalBack} 人到位，已改退驻城待命。`);
      }
      army.con_times = [0, 0, 0];
      army.con_cnts = [0, 0, 0];
      army.conArriveDay = 0;
      army.conToken = Math.floor(Number(army.conToken) || 0) + 1;
      ctx.push('army.push', army);
      ctx.save();
      return;
    }
    for (let i = 0; i < 3; i += 1) {
      const add = Math.max(0, Math.floor(Number(task.cnts?.[i]) || 0));
      /* ★ P55：空槽（武将已调防/撤下）不得补兵，否则再造空槽幽灵兵。 */
      if (!army.generals?.[i]) { army.con_times[i] = 0; army.con_cnts[i] = 0; continue; }
      army.soldiers[i] += add;
      army.con_times[i] = 0;
      army.con_cnts[i] = 0;
    }
    army.conArriveDay = 0;
    army.conToken = Math.floor(Number(army.conToken) || 0) + 1;
    ctx.push('army.push', army);
    ctx.save();
  }
}

/* eslint-disable complexity */
export function handleRequest(ctx, req) {
  const { state, cfg, options } = ctx;
  const name = req.name;
  const m = sanitizeMsg(req.msg);
  settleWorld(ctx);
  const rsp = {};

  switch (name) {
    /* ---------------- 连接 / 账号 ---------------- */
    case 'heartbeat':
      rsp.msg = { ctime: m.ctime ?? Date.now(), stime: Date.now() };
      return { code: OK, msg: rsp.msg, seq: 0 };

    case 'account.login':
      state.account.username = m.username || state.account.username;
      /* ★ 修 bug-19：口令不再明文进存档、也不再回传客户端。
         离线版存档会被复制/分享，留明文等于把口令写进可读 JSON。 */
      if (m.password) state.account.passHash = passwordDigest(m.password);
      delete state.account.password;
      ctx.save();
      rsp.msg = {
        username: state.account.username,
        session: state.account.session,
        uid: state.account.uid,
      };
      break;
    case 'account.reLogin':
      rsp.msg = { session: m.session || state.account.session };
      break;
    case 'account.logout':
      rsp.msg = { uid: state.account.uid };
      break;
    case 'account.serverList':
      rsp.msg = { Lists: [] };
      break;

    /* ---------------- 角色 ---------------- */
    case 'role.enterServer':
      rsp.msg = {
        role: clone(state.role),
        role_res: roleResOf(state),
        time: Date.now(),
        token: state.account.session,
      };
      break;
    case 'role.create':
      state.role.nickName = m.nickName || state.role.nickName;
      state.role.sex = m.sex ?? state.role.sex;
      state.role.headId = m.headId ?? state.role.headId;
      ctx.save();
      rsp.msg = { role: clone(state.role) };
      break;
    case 'role.roleList':
      rsp.msg = { Roles: [clone(state.role)] };
      break;
    case 'role.myProperty':
      rsp.msg = {
        role_res: roleResOf(state),
        mr_builds: clone(state.builds),
        generals: clone(state.generals),
        citys: clone(state.citys),
        armys: clone(state.armys),
      };
      break;
    case 'role.myCity':
      rsp.msg = { citys: clone(state.citys) };
      break;
    case 'role.myRoleRes':
      /* ★ P50：物资去处回归即时办理，guide 只带资源概览与动作清单（旧任务队列/可派武将已删）。 */
      rsp.msg = {
        role_res: roleResOf(state),
        guide: materialGuide(state),
      };
      break;
    case 'role.myRoleBuild':
      rsp.msg = { mr_builds: clone(state.builds) };
      break;
    case 'role.upPosition':
      rsp.msg = { x: m.x ?? 0, y: m.y ?? 0 };
      break;
    case 'role.posTagList':
      rsp.msg = { pos_tags: clone(state.posTags) };
      break;
    case 'role.opPosTag': {
      const type = Number(m.type ?? 0);
      const x = Number(m.x ?? 0);
      const y = Number(m.y ?? 0);
      const tag = { x, y, name: m.name || '' };
      if (type === 0) {
        state.posTags = state.posTags.filter((t) => !(t.x === x && t.y === y));
      } else {
        state.posTags = state.posTags.filter((t) => !(t.x === x && t.y === y));
        const limit = cfg.basic.role?.pos_tag_limit ?? 10;
        if (state.posTags.length < limit) state.posTags.push(tag);
      }
      ctx.save();
      rsp.msg = { type, ...tag };
      break;
    }

    /* ---------------- 大地图 ---------------- */
    case 'nationMap.config':
      rsp.msg = { Confs: clone(cfg.confs) };
      break;
    case 'nationMap.scan':
    case 'nationMap.scanBlock': {
      const x = Number(m.x ?? 0);
      const y = Number(m.y ?? 0);
      const len = Number(m.length ?? 10);
      const inBlock = (o) => o.x >= x && o.x < x + len && o.y >= y && o.y < y + len;
      rsp.msg = {
        mr_builds: clone(state.builds.filter(inBlock)),
        mc_builds: clone(state.citys.filter(inBlock)),
        armys: clone(state.armys.filter((a) => a.cmd !== 0 && inBlock({ x: a.to_x, y: a.to_y }))),
      };
      break;
    }
    case 'nationMap.giveUp': {
      const x = Number(m.x ?? 0), y = Number(m.y ?? 0);
      state.builds = state.builds.filter((b) => !(b.x === x && b.y === y));
      // ★ 修复：放弃领地推送的占位对象 level 不能是 0，客户端地形详情面板
      //   getDefenseSoldiers(0) 会读 npc.levels[-1].soilders 崩溃。
      const [, tileLevel] = cfg.tileAt(x, y);
      ctx.push('roleBuild.push', {
        rid: 0, x, y, type: 53, level: tileLevel || 1, curDurable: 0, maxDurable: 0,
      });
      ctx.save();
      rsp.msg = { x, y };
      break;
    }
    case 'nationMap.build': {
      // 原版语义：在自己有产量的领地上建造要塞（map_build_custom），扣 need、有工期
      const x = Number(m.x ?? 0), y = Number(m.y ?? 0), type = Number(m.type ?? 0);
      const b = state.builds.find((bb) => bb.x === x && bb.y === y);
      if (!b) { rsp.code = CODE.BuildNotMe; break; }
      const isRes = (b.wood || 0) + (b.iron || 0) + (b.stone || 0) + (b.grain || 0) > 0;
      if (!isRes || b.building || (b.op_level ?? b.level) !== b.level) { rsp.code = CODE.CanNotBuildNew; break; }
      const fortressLimit = cfg.basic.build?.fortress_limit ?? 10;
      if (state.builds.filter((bb) => bb.type === 56).length >= fortressLimit) {
        rsp.code = CODE.CanNotBuildNew;
        break;
      }
      const c = cfg.buildCustomCfg(type, 1);
      if (!c) { rsp.code = CODE.InvalidParam; break; }
      const code = tryUseNeed(state, c.need, `建造·${c.name || type}`);
      if (code !== OK) { rsp.code = code; break; }
      b.type = c.type ?? type;
      b.name = c.name ?? b.name;
      // ★ 修复：原版把 level 降为 c.level-1=0 标记「建造中」，但客户端
      //   npc.levels 只有 1~10，level=0 下发给详情面板必崩。改用独立
      //   building 标记，level 全程保持合法值，工期结束再设为目标等级。
      b.building = true;
      b.op_level = c.level ?? 1;
      b.end_time = nowSec() + (c.time ?? 0);
      b.giveUp_time = 0;
      ctx.push('roleBuild.push', b);
      ctx.save();
      rsp.msg = { x, y, type };
      break;
    }
    case 'nationMap.upBuild':
    case 'nationMap.delBuild': {
      // 原版语义：只有要塞可以升级/拆除；升级扣 need 有工期，拆除同样扣 need 有工期
      const x = Number(m.x ?? 0), y = Number(m.y ?? 0);
      const b = state.builds.find((bb) => bb.x === x && bb.y === y);
      if (!b) { rsp.code = CODE.BuildNotMe; break; }
      if (b.type !== 56) { rsp.code = name === 'nationMap.upBuild' ? CODE.CanNotUpBuild : CODE.CanNotDestroy; break; }
      if ((b.giveUp_time || 0) > 0) { rsp.code = CODE.CanNotUpBuild; break; }
      if ((b.op_level ?? b.level) !== b.level || b.building) { rsp.code = CODE.CanNotUpBuild; break; } // 建造/升级中
      if (name === 'nationMap.upBuild') {
        const c = cfg.buildCustomCfg(b.type, b.level + 1);
        if (!c) { rsp.code = CODE.InvalidParam; break; }
        const code = tryUseNeed(state, c.need, `要塞升级 ${b.level}→${b.level + 1}`);
        if (code !== OK) { rsp.code = code; break; }
        b.building = true;
        b.op_level = c.level;            // level 保持当前值，op_level 为目标等级
        b.end_time = nowSec() + (c.time ?? 0);
      } else {
        const c = cfg.buildCustomCfg(b.type, b.level);
        if (!c) { rsp.code = CODE.InvalidParam; break; }
        const code = tryUseNeed(state, c.need, '要塞拆除');
        if (code !== OK) { rsp.code = code; break; }
        b.building = true;
        b.op_level = 0;                  // 标记拆除中，到点由 tickBuilds 恢复为资源地
        b.end_time = nowSec() + (c.time ?? 0);
      }
      ctx.push('roleBuild.push', b);
      ctx.save();
      rsp.msg = { x, y, build: clone(b) };
      break;
    }

    /* ---------------- 城池设施 / 内政 ---------------- */
    case 'city.facilities': {
      /* ★ 客户端 qryCityFacilities 不传参时 cityId=0，用 ?? 会让 0 漏过去，
         结果回一个不存在的城、客户端 getMyCityById(0) 拿到 null 直接崩。0 视作未指定。 */
      const cityId = Number(m.cityId) || mainCity(state)?.cityId || 1;
      /* ★ 兜底：客户端只认自己 citys 里的 id，回一个不存在的城会让它 getMyCityById 返回 null */
      const known = (state.citys || []).some((x) => Number(x.cityId) === cityId)
        || !!state.strategy?.cities?.[cityId];
      if (!known) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'no_city', cityId };
        break;
      }
      /* ★ 修 bug-6：设施按「战略城」各存一份（键 s<id>）。
         realCityId 是「要看哪座战略城的设施」，cityId 仍是客户端自己的城 ——
         原客户端拿 msg.cityId 去 getMyCityById，回战略城 id 会拿到 null 直接崩。 */
      const realCid = Number(m.realCityId) || cityId;
      /* 修 U04：回给客户端的 cityId 必须是原版 state.citys 里真实存在的 id。
         战略层 72 城用另一套编号，客户端 getMyCityById(战略城id) 返回 null 会直接抛
         TypeError。双 id 规避只挡住了不传参的路径，显式传战略城 id 仍会崩，这里做终局回落。 */
      const clientCid = (state.citys || []).some((x) => Number(x.cityId) === cityId)
        ? cityId : (Number(mainCity(state)?.cityId) || 1);
      const list = ownFacilityList(state, cfg, realCid);
      const rawFacilities = (list || []).map((f) => {
        const p = facilityProgress(state, cfg, f);
        return {
          ...clone(f),
          maxLevel: cfg.facilityMaxLevel(f.type),
          nextNeed: cfg.facilityUpgradeNeed(f.type, f.level + 1),
          /* nextDays 是玩家可见工期（游戏日）；nextTime 保留兼容字段但不再显示秒。 */
          nextDays: p.days,
          nextTime: p.days,
          upgradeDays: p.days,
          upgradeRemainDays: p.remain,
          upgradeStartDay: p.startDay,
        };
      });
      /* ★ M4-12：两处设施 UI（本城/城池内页）与六府内政都只读这一份结果。
         默认隐藏 20 项「未参与结算」的原版占位设施；GM 可用
         SLG_LEGACY_FACILITIES=1 取回全量做对照（逐项带 active 标记）。 */
      const view = facilityView(cfg, rawFacilities);
      rsp.msg = {
        cityId: clientCid, realCityId: realCid, facilities: view.rows,
        allCount: view.allCount, hiddenCount: view.hiddenCount, legacy: view.legacy,
      };
      break;
    }
    case 'city.upFacility': {
      // 原版语义：校验 maxLevel / 未在升级中 / 按派生 need 扣资源；
      // 工期按游戏日（up_day + facilityUpgradeDays），到点后由 facilityGetLevel 被动完成
      /* ★ 客户端 qryCityFacilities 不传参时 cityId=0，用 ?? 会让 0 漏过去，
         结果回一个不存在的城、客户端 getMyCityById(0) 拿到 null 直接崩。0 视作未指定。 */
      const cityId = Number(m.cityId) || mainCity(state)?.cityId || 1;
      const realCid = Number(m.realCityId) || cityId;
      const fType = Number(m.fType ?? 0);
      /* ★ 修 bug-7：旧实现不校验归属，能拿自己的资源给敌方城修磨坊。
         只有在自己的城（或未举义时的本地主城）才能动设施。 */
      if (!isOwnCity(state, realCid)) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'not_own_city', cityId: realCid };
        break;
      }
      /* ★ M4-12：配置里存在但未参与本版本结算的「过度设施」不许再扣资源升级。
         未知 fType 不在这里拦，继续走原有的 no_such_facility 分支（错误优先级不变）。 */
      const knownFacility = (cfg.facility.list || []).find((x) => Number(x.type) === fType);
      if (knownFacility && !isActiveFacility(cfg, knownFacility)) {
        rsp.code = CODE.UpError;
        rsp.msg = {
          reason: 'facility_disabled', fType, name: knownFacility.name,
          hint: '该设施未参与本版本结算，升级不生效',
        };
        break;
      }
      const list = ownFacilityList(state, cfg, realCid);
      let f = list.find((x) => x.type === fType);
      if (!f) {
        // 原版 GetAndTryCreate：设施缺失时按 facility.json 补建
        const conf = (cfg.facility.list || []).find((x) => x.type === fType);
        if (!conf) {
          // ★ 修 bug-9：三处 UpError 以前都不带 msg，客户端只能弹通用报错
          rsp.code = CODE.UpError;
          rsp.msg = { reason: 'no_such_facility', fType };
          break;
        }
        f = { name: conf.name || '设施', level: 0, type: fType, up_time: 0 };
        list.push(f);
      }
      const maxLv = cfg.facilityMaxLevel(fType);
      if (maxLv <= 0 || f.level >= maxLv) {
        rsp.code = CODE.UpError;
        rsp.msg = { reason: 'max_level', level: f.level, maxLevel: maxLv };
        break;
      }
      if (f.up_time > 0) {
        rsp.code = CODE.UpError;
        rsp.msg = { reason: 'upgrading', fType, level: f.level };
        break;
      } // 正在升级中
      /* 派生成本：原表吃粮会让全局粮池见底时所有设施（含集市）永久锁死，这里只去粮。 */
      const need = cfg.facilityUpgradeNeed(fType, f.level + 1);
      if (!need) {
        rsp.code = CODE.UpError;
        rsp.msg = { reason: 'no_cost_table', fType, nextLevel: f.level + 1 };
        break;
      }
      const code = tryUseNeed(state, need, `设施「${f.name}」升至 ${f.level + 1} 级`);
      if (code !== OK) {
        rsp.code = code;
        rsp.msg = { reason: 'res_not_enough', need, cost: need };
        break;
      }
      /* up_time 保留给旧协议/存档识别「升级中」，真正完成判据是 up_day + 游戏日工期。 */
      f.up_time = nowSec();
      f.up_day = Number(state.clock?.day) || 1;
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.msg = { cityId, realCityId: realCid, facility: clone(f), role_res: roleResOf(state) };
      break;
    }
    case 'interior.collect': {
      // 原版语义：按日重置次数 → 次数上限 → CD → 金币 = 税收产量（含设施加成）
      /* ★ 修 bug-8：旧实现恒取 mainCity(state)，点哪座城征收都加同一份金。
         现在按 m.cityId 取城，金产用该城 cityYield；次数与 CD 也按城独立记。 */
      const wantCity = Number(m.cityId ?? 0);
      const econ = ensureCityEcon(state)?.[wantCity];
      const cityOwner = state.strategy?.cities?.[wantCity]?.owner;
      const cityBased = !!(econ && cityOwner === 'player');
      if (wantCity && !cityBased) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'not_own_city', cityId: wantCity };
        break;
      }
      const bucket = cityBased ? econ : state.roleAttr;
      const limit = cfg.basic.role?.collect_times_limit ?? 3;
      const interval = (cfg.basic.role?.collect_interval ?? 30) * 1000;
      const now = Date.now();
      const last = bucket.lastCollectTime || 0;
      /* ★ P61-B3：征收次数改按游戏日（state.clock.day）重置，不再跟真实系统日期走。
         改系统时间或长局跨真实次日都不再凭空刷新次数。CD 仍按真实秒数，避免挂机刷。 */
      const dayNow = Math.max(1, Number(state.clock?.day) || 1);
      const sameDay = Number(bucket.collectDay) === dayNow;
      if (!sameDay) bucket.collectTimes = 0;
      if ((bucket.collectTimes || 0) >= limit) {
        // ★ 修 bug-11：以前只回 code，玩家不知道是「次数用完」还是「冷却中」
        rsp.code = CODE.OutCollectTimesLimit;
        rsp.msg = { reason: 'times_limit', limit, cur_times: bucket.collectTimes, cityId: wantCity || 0 };
        break;
      }
      if (sameDay && now - last < interval) {
        rsp.code = CODE.InCdCanNotOperate;
        rsp.msg = {
          reason: 'cooldown', cityId: wantCity || 0,
          next_time: last + interval, waitSec: Math.ceil((interval - (now - last)) / 1000),
        };
        break;
      }
      const r = totalYield(state, cfg);
      const gold = cityBased
        ? Math.max(200, Math.round((cityYield(state, wantCity)?.gold || 0) * 8))
        : (r.gold_yield || 1000);
      state.roleRes.gold += gold;
      recordRes(state, 'gold', gold, cityBased ? `税赋征收·${cityName(wantCity)}` : '税赋征收');
      bucket.collectTimes = (bucket.collectTimes || 0) + 1;
      bucket.lastCollectTime = now;
      bucket.collectDay = dayNow;
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      let nextTime;
      if (bucket.collectTimes >= limit) {
        const d = new Date(now);
        d.setHours(24, 0, 0, 0);          // 次日零点（原版语义）
        nextTime = d.getTime();
      } else {
        nextTime = now + interval;
      }
      rsp.msg = {
        gold, limit, cityId: wantCity || 0,
        cur_times: bucket.collectTimes,
        next_time: nextTime,
        next_day: dayNow + 1,
      };
      break;
    }
    case 'interior.openCollect': {
      const wantCity = Number(m.cityId ?? 0);
      const e = wantCity ? ensureCityEcon(state)?.[wantCity] : null;
      const bucket = (e && state.strategy?.cities?.[wantCity]?.owner === 'player') ? e : state.roleAttr;
      rsp.msg = {
        limit: cfg.basic.role?.collect_times_limit ?? 3,
        cur_times: bucket.collectTimes || 0,
        next_time: bucket.lastCollectTime
          ? bucket.lastCollectTime + (cfg.basic.role?.collect_interval ?? 30) * 1000
          : 0,
      };
      break;
    }
    case 'interior.transform': {
      // 原版语义：必须有集市（type 15）→ ret[i] = -From[i] 或 +To[i]（不同索引）→ 不可扣成负数
      const city = mainCity(state);
      const facilities = state.facilities[city?.cityId ?? 1] || [];
      const market = facilities.find((f) => f.type === 15);
      if (!market || facilityGetLevel(state, cfg, market) <= 0) {
        // ★ 修 bug-10：以前只回 code 58，没有 msg，客户端只能弹通用错误
        rsp.code = CODE.NotHasJiShi;
        rsp.msg = { reason: 'no_market', hint: '需要先在本城建造并升级「集市」' };
        break;
      }
      const from = m.from || [0, 0, 0, 0];
      const to = m.to || [0, 0, 0, 0];
      /* ★ P61-B4：服务端按 transform_rate 算产出，客户端只能指定「从哪种资源、换到哪种资源」。
       * 旧实现信任客户端提交的 to 数值，只查总量不查比例，协议层可 1 木换 1 粮。
       * 这里覆盖 P1-6 的「不碰比例」旧裁决：评估确认那是套利口子，改为唯一服务端口径。 */
      const rate = Math.max(1, Math.min(100, Number(cfg.basic?.city?.transform_rate) ?? 50));
      const src = from.findIndex((v) => Number(v) > 0);
      const dst = to.findIndex((v) => Number(v) > 0);
      const amount = src >= 0 ? Math.floor(Number(from[src])) : 0;
      const extraFrom = from.filter((v, i) => i !== src && Number(v) > 0).length;
      const extraTo = to.filter((v, i) => i !== dst && Number(v) > 0).length;
      const out = dst >= 0 && amount > 0 ? Math.floor(amount * rate / 100) : 0;
      if (src < 0 || dst < 0 || src === dst || extraFrom || extraTo || amount <= 0 || out <= 0) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = {
          reason: 'bad_transform',
          hint: `集市只换一种资源到另一种资源，产出按兑换率 ${rate}% 由本机核算`,
          rate,
        };
        break;
      }
      const ret = [0, 0, 0, 0];
      ret[src] = -amount;
      ret[dst] = out;
      const r = state.roleRes;
      if (!ret.every((v, i) => (r[RES_KEYS[i]] || 0) + v >= 0)) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'res_not_enough', need: ret };
        break;
      }
      for (let i = 0; i < 4; i += 1) {
        if (!ret[i]) continue;
        r[RES_KEYS[i]] = (r[RES_KEYS[i]] || 0) + ret[i];
        /* ★ P40：集市兑换与征兵/缴获一样进府库流水，否则「钱粮去哪了」在账本里查不到。 */
        recordRes(state, RES_KEYS[i], ret[i], '集市兑换');
      }
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.msg = { rate, fromIndex: src, toIndex: dst, spent: amount, gained: out };
      break;
    }

    /* ---------------- 武将 ---------------- */
    case 'general.myGenerals': {
      /* ★ P54：可选 cityId —— 征兵页按当前城取候选武将，不再把别城的人塞进下拉。
         不带 cityId 时仍是全量名单（武将战法页等沿用旧语义）。 */
      const cityId = Number(m.cityId ?? 0);
      const list = cityId > 0
        ? state.generals.filter((g) => Number(g.cityId) === cityId)
        : state.generals;
      /* ★ P56：主公即使因旧批量调防去了别城也要让征兵页看得见「人在哪里」，
         否则候选列表里凭空少一个人，玩家只会以为武将丢了。 */
      const hero = state.generals.find((g) => g?.isProtagonist || Number(g?.cfgId) === 880001) || null;
      const heroCity = Number(hero?.cityId) || 0;
      rsp.msg = {
        generals: withGeneralNames(state, cfg, clone(list)), cityId,
        protagonist: hero ? {
          id: Number(hero.id), name: generalDisplayName(state, cfg, hero),
          cityId: heroCity, cityName: state.strategy?.cities?.[heroCity]?.name || cityNameOf(heroCity),
          inCity: !cityId || heroCity === cityId,
        } : null,
      };
      break;
    }
    case 'general.drawGeneral': {
      ensureTavern(state, cfg);
      const times = Math.max(1, Math.min(10, Number(m.drawTimes ?? 1)));
      const realMsPerDay = chapterRules().realMsPerDay;
      // ★ P6：支持按城招募——各城酒馆来的是本籍在野武将；不带 cityId 时沿用主城口径
      const cityId = Number(m.cityId) || 0;
      const costEach = cfg.basic.general?.draw_general_cost ?? 30;
      const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
      /* ★ 2026-11-17：招募成功/失败全部落事件日志（用户反馈「招募成功或者失败都没有日志」）。
         与探索登庸（recordEvent 遣使探索…）同口径，事件卡与战略事件流都可见。 */
      const recruitCity = cityNameOf(cityId || state.strategy?.playerCity || mainCity(state)?.cityId || 1);
      const added = [];
      const refused = [];
      // ★ P13 指名招募：玩家在来访名单里点了谁，就只招谁（旧实现取「此刻在店」第一个，
      //   玩家点 A 来的却是 B）。指名时必须真的在店，过时辰/未到店都给可读原因。
      if (m.cfgId != null && Number(m.cfgId) > 0) {
        const targetId = Number(m.cfgId);
        const row = todaysGuests(state, undefined, cityId || null)
          .find((g) => Number(g.cfgId) === targetId);
        if (!row) {
          /* ★ 2026-11-17：旧实现只回 cfgId，前端拼出「undefined 此刻不在座上」。补 name 与拟人句。 */
          const known = (state.tavern.people || []).find((p) => Number(p.cfgId) === targetId) || {};
          recordEvent(state, `延请「${known.name || `#${targetId}`}」：店里寻不见此人，许是回了乡里。`);
          rsp.msg = {
            generals: [], reason: 'not_today', cfgId: targetId, name: known.name || '', cost: costEach,
            line: failLine('absent', { name: known.name || '' }),
          };
          break;
        }
        const frac = dayFraction(state, realMsPerDay);
        if (frac >= row.to) {
          recordEvent(state, `「${row.name}」方才离席归家，今日延请未成。`);
          rsp.msg = {
            generals: [], reason: 'guest_left', name: row.name, cost: costEach,
            line: failLine('left', { name: row.name }),
          };
          break;
        }
        if (frac < row.from) {
          recordEvent(state, `「${row.name}」${row.when || '稍后'}才到，遣人去早了。`);
          rsp.msg = {
            generals: [], reason: 'not_arrived', name: row.name, when: row.when, cost: costEach,
            line: failLine('not_yet', { name: row.name, when: row.when }),
          };
          break;
        }
        if ((state.roleRes.gold || 0) < costEach) {
          const short = Math.max(0, costEach - (state.roleRes.gold || 0));
          recordEvent(state, `府库金不足（需 ${costEach}，尚差 ${short}），延请「${row.name}」未成。`);
          rsp.msg = {
            generals: [], reason: 'not_enough_gold', cost: costEach, gold: state.roleRes.gold || 0, short,
            line: failLine('poor', { cost: costEach, short }),
          };
          break;
        }
        /* ★ P13 武将可以拒绝：掷骰与「探索登庸」同一条公式（relation.talentRecruitRate），
           面板展示的「登庸 X%」就是结算概率。失败不收费，三顾好感 +1（再访更易）。 */
        state.tavern.favor = state.tavern.favor || {};
        const favorN = Number(state.tavern.favor[targetId] || 0);
        const calc = talentRecruitRate(state, cfg, row);
        const rate = calc.rate / 100;
        const success = rngFor(state.seed ?? 20261110, day,
          `draw:${cityId || 'all'}:${targetId}:${favorN}`).random() < rate;
        if (!success) {
          state.tavern.favor[targetId] = favorN + 1;
          ctx.push?.('roleRes.push', roleResOf(state));
          ctx.save();
          const line = refusalLine(cfg.generalByCfg.get(targetId) || {}, { cfgId: targetId, favor: favorN + 1 });
          recordEvent(state, `延请「${row.name}」被婉拒——精诚所至，改日再访或可转机。`);
          rsp.msg = {
            generals: [], reason: 'refused', name: row.name,
            rate: Math.round(rate * 100), favor: favorN + 1, parts: calc.parts,
            line: line.text, persona: line.persona,
            cost: costEach, charged: 0,
          };
          break;
        }
        delete state.tavern.favor[targetId];
        state.roleRes.gold -= costEach;
        recordRes(state, 'gold', -costEach, `招募·${row.name}`, day);
        const person = state.tavern.people.find((p) => Number(p.cfgId) === targetId);
        if (person) person.recruited = true;
        /* ★ 2026-11-17：落城改为「招募所在城」，旧实现写死 mainCity（本地城 1），
           在成都酒馆招到的人也记在长安，导致武将归属与实际驻地不一致、无法派遣。 */
        const g = makeGeneral(cfg, nextId(state, 'generalId'), targetId,
          cityId || state.strategy?.playerCity || mainCity(state)?.cityId || 1, 1);
        state.generals.push(g);
        added.push(g);
        recordEvent(state, `以 ${costEach} 金延得「${row.name}」入仕，落籍「${recruitCity}」。`);
        noticeRecruit(state, ctx, row.name || '');
        ctx.push('general.push', g);
        syncOwnedSkills(state);
        ctx.push('roleRes.push', roleResOf(state));
        ctx.save();
        rsp.msg = { generals: withGeneralNames(state, cfg, clone(added)), rate: Math.round(rate * 100), reason: '' };
        break;
      }
      /* 旧口径（不指名）：此刻在店的客人依次尝试——武将同样可能婉拒（P13）。 */
      const here = guestsNow(state, realMsPerDay, cityId || null).slice(0, times);
      // ★ 试玩 P1-3：旧实现「此刻无人 / 金不足」都返回 code 0 + 空数组，静默失败。
      //   现在把原因和今天剩下的人一并回给界面，玩家知道自己在等什么。
      if (!here.length) {
        recordEvent(state, '酒肆此刻无人可招，改日再来。');
        rsp.msg = {
          generals: [],
          reason: 'no_guest',
          cost: costEach,
          line: failLine('empty', {}),
          today: todaysGuests(state, undefined, cityId || null).map((g) => ({ cfgId: g.cfgId, name: g.name, when: g.when, cityId: g.birthCity })),
        };
        break;
      }
      if ((state.roleRes.gold || 0) < costEach) {
        const short = Math.max(0, costEach - (state.roleRes.gold || 0));
        recordEvent(state, `府库金不足（每位需 ${costEach} 金，尚差 ${short}），无人应征。`);
        rsp.msg = {
          generals: [], reason: 'not_enough_gold', cost: costEach, gold: state.roleRes.gold || 0, short,
          line: failLine('poor', { cost: costEach, short }),
        };
        break;
      }
      state.tavern.favor = state.tavern.favor || {};
      for (const person of here) {
        if ((state.roleRes.gold || 0) < costEach) break;
        const favorN = Number(state.tavern.favor[person.cfgId] || 0);
        const calc = talentRecruitRate(state, cfg, person);
        const rate = calc.rate / 100;
        const success = rngFor(state.seed ?? 20261110, day,
          `draw:${cityId || 'all'}:${person.cfgId}:${favorN}`).random() < rate;
        if (!success) {
          state.tavern.favor[person.cfgId] = favorN + 1;
          const line = refusalLine(cfg.generalByCfg.get(Number(person.cfgId)) || {}, { cfgId: person.cfgId, favor: favorN + 1 });
          recordEvent(state, `延请「${person.name}」被婉拒——精诚所至，改日再访或可转机。`);
          refused.push({ cfgId: person.cfgId, name: person.name, rate: Math.round(rate * 100), favor: favorN + 1, line: line.text, persona: line.persona });
          continue;
        }
        delete state.tavern.favor[person.cfgId];
        state.roleRes.gold -= costEach;
        recordRes(state, 'gold', -costEach, `招募·${person.name}`, day);
        person.recruited = true;
        const row = state.tavern.people.find((p) => p.cfgId === person.cfgId);
        if (row) row.recruited = true;
        const g = makeGeneral(cfg, nextId(state, 'generalId'), person.cfgId,
          cityId || state.strategy?.playerCity || mainCity(state)?.cityId || 1, 1);
        state.generals.push(g);
        added.push(g);
        recordEvent(state, `以 ${costEach} 金延得「${person.name}」入仕，落籍「${recruitCity}」。`);
        noticeRecruit(state, ctx, cfg.generalByCfg.get(g.cfgId)?.name || '');
        ctx.push('general.push', g);
      }
      syncOwnedSkills(state);
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.msg = {
        generals: withGeneralNames(state, cfg, clone(added)),
        refused, reason: added.length ? '' : (refused.length ? 'refused' : 'not_enough_gold'),
      };
      break;
    }
    case 'general.composeGeneral': {
      const ids = (m.gIds || []).map(Number);
      /* ★ P56：旧协议曾允许把主公当材料合成，一旦抹掉就无法再组队；这里硬拦并给中文回执。 */
      if (ids.some((id) => (state.generals || []).some((g) => Number(g.id) === id
        && (g.isProtagonist || Number(g.cfgId) === 880001)))) {
        notify('主公不可作为合成材料', 'warn');
        rsp.code = CODE.InvalidParam;
        rsp.msg = { generals: [], reason: 'protagonist_locked' };
        break;
      }
      state.generals = state.generals.filter((g) => !ids.includes(g.id));
      const g = makeGeneral(cfg, nextId(state, 'generalId'), Number(m.compId) || [...cfg.generalByCfg.keys()][0], mainCity(state)?.cityId ?? 1, 1);
      state.generals.push(g);
      noticeRecruit(state, ctx, cfg.generalByCfg.get(g.cfgId)?.name || '');
      syncOwnedSkills(state);
      ctx.save();
      rsp.msg = { generals: withGeneralNames(state, cfg, [g]) };
      break;
    }
    case 'general.addPrGeneral': {
      const g = findGeneral(state, Number(m.compId));
      if (g) {
        g.force_added += Number(m.forceAdd ?? 0);
        g.strategy_added += Number(m.strategyAdd ?? 0);
        g.defense_added += Number(m.defenseAdd ?? 0);
        g.speed_added += Number(m.speedAdd ?? 0);
        g.destroy_added += Number(m.destroyAdd ?? 0);
        ctx.push('general.push', g);
        ctx.save();
      }
      rsp.msg = { general: clone(g || {}) };
      break;
    }
    case 'general.convert': {
      const ids = (m.gIds || []).map(Number);
      /* ★ P56：同上，转卖武将也不能把剧情主角卖掉。 */
      if (ids.some((id) => (state.generals || []).some((g) => Number(g.id) === id
        && (g.isProtagonist || Number(g.cfgId) === 880001)))) {
        notify('主公不可转卖', 'warn');
        rsp.code = CODE.InvalidParam;
        rsp.msg = {
          gIds: [], gold: Math.floor(Number(state.roleRes?.gold) || 0), add_gold: 0,
          reason: 'protagonist_locked',
        };
        break;
      }
      const add = ids.length * 100;
      state.generals = state.generals.filter((g) => !ids.includes(g.id));
      state.roleRes.gold += add;
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.msg = { gIds: ids, gold: state.roleRes.gold, add_gold: add };
      break;
    }
    case 'general.upSkill':
    case 'general.downSkill':
    case 'general.lvSkill': {
      const gId = Number(m.gId ?? 0);
      const cfgId = Number(m.cfgId ?? 0);
      const pos = Math.max(0, Math.min(2, Number(m.pos ?? 0)));
      const g = findGeneral(state, gId);
      let ok = false;
      let reason = '';
      let paid = 0;
      let limitCap = 0;   // ★ P12：limit_reached 时带回原表上限，回执文案能给准数
      if (g) {
        const slots = ensureSlots(g);
        if (name === 'general.upSkill') {
          const conf = skillById(cfgId);
          if (!conf) {
            reason = 'invalid_skill';           // 旧 101/201/301/401 一律拒绝
          } else if (!state.skillbook?.unlocked?.[String(cfgId)]) {
            /* ★ P12：与六府装配（panels learn）同一条校验。原版客户端的学习列表
               列出全部战法配置，不查解锁等于绕过战法库研习系统。 */
            reason = 'not_unlocked';
          } else {
            const usedByOthers = state.generals.filter(
              (other) => other.id !== g.id && (other.skills || []).some((s) => s && s.cfgId === cfgId),
            ).length;
            if (usedByOthers >= conf.ui.limit) {
              reason = 'limit_reached';
              limitCap = Math.max(1, Math.trunc(Number(conf.ui?.limit) || 2));
            } else {
              const blocked = slotBlock(g, pos, 'replace');
              if (blocked) reason = blocked;
              else {
                slots[pos] = { id: cfgId, lv: 1, cfgId };
                ok = true;
              }
            }
          }
        } else if (name === 'general.downSkill') {
          const blocked = slotBlock(g, pos, 'remove');
          const cur = slots[pos];
          if (blocked) reason = blocked;
          else if (cur && (cfgId === 0 || cur.cfgId === cfgId)) {
            slots[pos] = null;
            ok = true;
          }
        } else {
          // ★ 修复：按槽位取技能，客户端不传 cfgId
          const cur = slots[pos];
          const blocked = skillUpgradeBlock(g, cur);
          if (blocked) reason = blocked;
          else {
            const cost = skillUpgradeCost(cur.lv);
            if ((state.roleRes.jungong ?? 0) < cost) reason = 'not_enough_jungong';
            else {
              state.roleRes.jungong -= cost;
              paid = cost;
              recordRes(state, 'jungong', -cost, '战法升级', state.clock?.day);
              cur.lv += 1;
              ok = true;
              ctx.push('roleRes.push', roleResOf(state));
            }
          }
        }
        const owned = syncOwnedSkills(state);
        if (ok) {
          const inst = owned.find((s) => s.cfgId === (slots[pos]?.cfgId ?? cfgId));
          if (inst) ctx.push('skill.push', inst);
        }
        ctx.push('general.push', g);
        ctx.save();
      }
      const curLv = g ? (ensureSlots(g)[pos]?.lv || 0) : 0;
      const nextLv = (curLv || 1) + (ok ? 0 : 1);
      const need = (reason === 'not_enough_jungong' || reason === 'need_general_level')
        ? skillUpgradeCost(Math.max(1, curLv || 1))
        : paid;
      let hint = ok ? '' : skillActionHint(reason, need, nextLv);
      if (!ok && reason === 'limit_reached' && limitCap) hint += `（上限 ${limitCap} 人）`;
      /* ★ P12：原版客户端对这三个动作的响应只 console.log、弹窗发完即关，
         拒绝时玩家看到的就是「点了没反应」。回执进 notice-bus，外壳转 toast。
         成功只给 upSkill 报喜（升级的槽位图标本来就会即时刷新）。 */
      if (!ok && hint) notify(hint, 'warn');
      else if (ok && name === 'general.upSkill') {
        const gName = cfg.generalByCfg?.get?.(g.cfgId)?.name || g.name || `武将${g.cfgId}`;
        const learnedId = ensureSlots(g)[pos]?.cfgId;
        const learned = skillById(learnedId);
        notify(`${gName}学会了「${learned?.ui?.name || learned?.name || '战法'}」`, 'ok');
      }
      rsp.msg = {
        gId, cfgId, pos, ok, reason,
        lv: curLv,
        cost: need,
        gold: Math.floor(Number(state.roleRes?.gold) || 0),
        jungong: Math.floor(Number(state.roleRes?.jungong) || 0),
        hint,
      };
      break;
    }

    /* ---------------- 军队 / 出征（战斗入口） ---------------- */
    case 'army.myList': {
      const cityId = Number(m.cityId ?? 1);
      rsp.msg = { cityId, armys: clone(state.armys.filter((a) => a.cityId === cityId)) };
      break;
    }
    case 'army.myOne':
      rsp.msg = { army: clone(armyById(state, m.cityId && m.order !== undefined
        ? state.armys.find((a) => a.cityId === Number(m.cityId) && a.order === Number(m.order))?.id
        : m.armyId) || {}) };
      break;
    case 'army.dispose': {
      const cityId = Number(m.cityId ?? 1);
      const order = Number(m.order ?? 0);
      const pos = Number(m.position ?? 0);
      const gid = Math.max(0, Math.floor(Number(m.generalId ?? 0)));
      // ★ 试玩 P1-4：新建队伍仍只准 1~3；★ P55 残部重编会产生 4~99 的既有队伍，
      //   这些队伍必须能撤将/解散，否则玩家面对空壳队毫无操作手段。
      if (!Number.isInteger(order) || order < 1 || order > 99) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'bad_order', army: {} };
        break;
      }
      if (!Number.isInteger(pos) || pos < 0 || pos > 2) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'bad_pos', army: {} };
        break;
      }
      /* ★ 试玩 bug-1/3：旧实现不校验城归属、不校验武将存在，
         于是「给敌方城/不存在的城编队」「把武将塞进 999999 号槽」都能过。
         城必须是我方城（或未举义时的唯一本地主城），武将要真实存在。 */
      if (!isOwnCity(state, cityId)) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'not_own_city', cityId };
        break;
      }
      let army = state.armys.find((a) => a.cityId === cityId && a.order === order);
      if (!army && order > 3) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'bad_order', army: {} };
        break;
      }
      // ★ 试玩 bug-2：行军中的队伍不能改编制（否则等于边走边换将补兵）
      if (army && army.marchId) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'marching', army: clone(army) };
        break;
      }
      /* ★ P54：同城 + 一人一队，两个编队入口共用同一份判据。
         旧实现静默把武将从别队/别城搬来，界面还显示"可选"，玩家看到的就是重复编队。 */
      if (gid > 0) {
        const check = formationGeneralCheck(state, {
          generalId: gid, cityId, armyId: army ? army.id : 0, missingReason: 'bad_general',
        });
        if (!check.ok) {
          rsp.code = CODE.InvalidParam;
          rsp.msg = { ...check, army: clone(army || {}) };
          break;
        }
      }
      if (!army) {
        if (gid <= 0) { rsp.msg = { army: {} }; break; }   // 只是把空槽位清空，不建队
        // 新建队伍必须带完整字段，否则 army.generals[pos] 直接抛异常
        army = makeArmy(nextId(state, 'armyId'), cityId, order, [0, 0, 0], [0, 0, 0]);
        state.armys.push(army);
      }
      army.generals = normalizeTriple(army.generals);
      army.soldiers = normalizeTriple(army.soldiers);
      /* ★ 2026-11-18 用户诉求：剔除武将后兵力不再停留在空槽。
         旧实现只改 generals[pos]、不动 soldiers[pos]，出现「有兵无将」槽位仍显示旧兵力。
         现在任何槽位从「有将」变「无将」，该槽兵力/在途退回驻城并清零，UI 不再显示幽灵兵力。 */
      /* ★ P55：与调防共用同一份退兵口径——清兵/清在途/作废令牌，
         旧实现在无驻城记录时把兵写回刚清空的槽，正是「空槽带兵」幽灵兵的来源。 */
      const returnTroopsToCity = (a, slot) => { releaseSlot(state, a, slot); };
      /* ★ P54：跨队占用已被上方拒绝；这里只清同队旧槽（同队换槽合法），连带退兵不留幽灵兵。 */
      if (gid > 0) {
        for (const a of state.armys) {
          (a.generals || []).forEach((id, i) => {
            if (Number(id) === gid && !(a === army && i === pos)) {
              returnTroopsToCity(a, i);
              a.generals[i] = 0;
            }
          });
        }
        army.generals[pos] = gid;
      } else {
        // 显式清空本槽：仅当原本有将/有兵时才退兵，避免重复清空调度
        if (army.generals[pos] || (army.soldiers?.[pos] > 0) || (army.con_cnts?.[pos] > 0)) {
          returnTroopsToCity(army, pos);
        }
        army.generals[pos] = 0;
      }
      syncGeneralOrders(state);
      ctx.push('army.push', army);
      ctx.save();
      rsp.msg = { army: clone(army) };
      break;
    }
    /* ★ P56：解散整队——按 armyId 定位，退兵/清在途/释放武将/删队一次完成。 */
    case 'army.disband': {
      const result = disbandArmy(state, ctx, { armyId: m.armyId });
      if (!result.ok) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { ...result };
        break;
      }
      ctx.save();
      notify(`第 ${result.order} 军已解散，${result.returned} 兵退回驻城`, 'ok');
      rsp.msg = result;
      break;
    }
    /* ★ 2026-11-19 P0-2：一键征满的可征数量由服务端权威给出。
       UI 旧实现只算木/铁/粮/金、还按盾步单价，漏了石耗与弓骑倍率 → 按钮亮着但必被拒。
       这里复用与 army.conscript 同一套领域函数，只读、不写 state。 */
    case 'army.conscriptPreview': {
      const army = armyById(state, m.armyId);
      if (!army) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'no_army', max: 0 }; break; }
      /* ★ P55：驻地为敌城的队伍不预览可征量（队伍权限统一闸）。 */
      if (!isOwnCity(state, army.cityId)) {
        rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'not_own_city', max: 0 }; break;
      }
      const c0 = cfg.basic.conscript || {};
      const trait0 = factionTraitOf(state);
      const perSlot0 = conscriptNeed([1, 1, 1], c0, trait0).perSlot;
      const st0 = state.strategy || {};
      const own0 = Object.entries(st0.cities || {}).filter(([, v]) => v.owner === 'player').map(([id]) => Number(id));
      const here0 = Number(army.cityId) || (own0[0] || 0);
      const levy0 = checkLevy(state, here0, 1, {
        strict: own0.length > 0, rate: cfg.basic?.conscriptRate ?? 0.06,
      });
      const res0 = state.roleRes || {};
      const max = affordableConscript(levy0.quota || 0, army, (gid) => findGeneral(state, gid), res0, c0, trait0);
      const plan0 = splitEven(max, army, (gid) => findGeneral(state, gid));
      const need0 = conscriptNeed(plan0.cnts, c0, trait0).need;
      rsp.msg = {
        max, cnts: plan0.cnts, need: need0, perSlot: perSlot0,
        quota: levy0.quota || 0, reason: levy0.ok || max > 0 ? '' : (levy0.reason || ''),
        canLevy: !!levy0.ok,
      };
      break;
    }
    case 'army.conscript': {
      const army = armyById(state, m.armyId);
      if (!army) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'no_army' }; break; }
      /* ★ P55：队伍权限——驻地为敌城的队伍不得动用我方资源征兵。 */
      if (!isOwnCity(state, army.cityId)) {
        rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'not_own_city', army: clone(army) }; break;
      }
      // ★ 试玩 bug-2：行军中不能征兵（否则路上补满兵再打）
      if (army.marchId) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'marching', army: clone(army) }; break; }
      /* ★ 2026-11-18 用户诉求「一键征满平分所有兵力」：m.fill=true 时服务端按
         该队伍有将的三槽剩余额度（等级+官阶上限−现有−在途）平分 m.amount，
         分配逻辑在服务端（界面不复算数值），UI 只发总量。 */
      let cnts = normalizeTriple(m.cnts);
      if (m.fill === true) {
        const plan = splitEven(Number(m.amount) || 0, army, (gid) => findGeneral(state, gid));
        cnts = plan.cnts;
      }
      const total = cnts.reduce((s, n) => s + n, 0);
      if (total <= 0) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'zero' }; break; }
      // ★ 试玩 P1-1：每兵成本按 basic.json 逐项扣。旧逻辑把四项加总（31/兵）
      //   全从木头扣，还用 Math.max(0, ...) 兜底 —— 资源不足也能白嫖。
      const c = cfg.basic.conscript || {};
      /* ★ 2026-11-18 征兵领域化（用户诉求：兵种差异化消耗 + 等级/官职带兵上限）：
         need 计算下沉 domain/conscript.js（盾步/弓/骑分单价、铁派生石耗、势力特技），
         handlers 变薄。石耗派生规则不变：原表 cost_stone=0 不改，派生 max(5,⌊铁/2⌋)。 */
      const trait = factionTraitOf(state);
      const { need, perSlot, total: needTotal } = conscriptNeed(cnts, c, trait);
      const per = perSlot[0]; // 兼容回包字段（旧客户端读 per 做展示）
      // 槽位必须已有武将：内核按槽位取将，空槽位征兵等于白扣资源
      const emptySlot = cnts.findIndex((n, i) => n > 0 && !army.generals?.[i]);
      if (emptySlot >= 0) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'empty_slot', slot: emptySlot, per };
        break;
      }
      /* ★ 用户诉求：征兵也校验带兵上限（旧实现只在整编校验，征兵可堆过上限）。
         本次要征 + 已在途 + 现有 不得超过该槽武将「等级+官阶」上限。 */
      const capsCheck = checkSlotCaps(cnts, army, (gid) => findGeneral(state, gid));
      if (!capsCheck.ok) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'over_cap', slot: capsCheck.slot, cap: capsCheck.cap,
          have: capsCheck.have, add: capsCheck.add, caps: capsCheck.caps, perSlot };
        break;
      }
      /* ★ P11 兵役制：先校验兵源，再扣资源。
         旧实现先扣资源再查人口，人口不足时资源已被扣走（点了没反应还掉资源）；
         而且「每兵吃 1 人口、从名下各城分摊」允许无限反复征兵，妇孺老弱也被算成丁。
         现在统一走 domain/levy.js：人口 → 户 → 适龄壮丁 → 已征户 → 本旬可征。 */
      const econ = ensureCityEcon(state);
      const st = state.strategy || {};
      const own = Object.entries(st.cities || {}).filter(([, v]) => v.owner === 'player').map(([id]) => Number(id));
      const here = Number(army.cityId) || (own[0] || 0);
      const strict = own.length > 0;   // 旧档/未举义无玩家城：不启用人口限制，避免锁死老存档
      const levyCheck = checkLevy(state, here, total, { strict, rate: cfg.basic?.conscriptRate ?? 0.06 });
      if (!levyCheck.ok) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = {
          reason: levyCheck.reason, cityId: here, need: total,
          quota: levyCheck.quota, levy: levyCheck.levy,
        };
        break;
      }
      const code = tryUseNeed(state, need, `征兵 ${total} 人`);
      if (code !== OK) {
        /* ★ 2026-11-19：把“到底差什么”回给 UI，别只说资源不足（石耗最容易被漏掉）。 */
        const lack = {};
        for (const key of Object.keys(need || {})) {
          const short = Math.max(0, Math.floor(Number(need[key]) || 0)
            - Math.floor(Number(state.roleRes?.[key]) || 0));
          if (short > 0) lack[key] = short;
        }
        rsp.code = code; rsp.msg = { reason: 'res_not_enough', need, per, perSlot, lack };
        break;
      }
      /* ★ 农时冲突要在扣人口之前算（扣完人再算，分母缩水，百分比会虚高） */
      const farmConflict = farmConflictOf(state, here, total, { rate: cfg.basic?.conscriptRate ?? 0.06 });
      /* 资源已扣，写兵役台账：本城扣人口基数（×4）、已征户 +N、本旬标记、民心下降 */
      const levyCommit = strict || econ?.[here]
        ? commitLevy(state, here, total)
        : null;
      /* ★ 2026-11-20 修：春征超限的「秋收田赋 −15%」此前只弹 toast、从未落账。
         这里把惩罚写到城经营对象（当年有效），由 cityYield 在秋季真正扣减粮产，
         兑现 farmConflict 对玩家的承诺。跨年后年份不匹配自动失效。 */
      if (farmConflict && econ?.[here]) {
        econ[here].farmPenaltyYear = Math.floor((Math.max(1, Math.floor(Number(state.clock?.day) || 1)) - 1) / 360);
        econ[here].farmPenaltyPct = farmConflict.penaltyPct;
      }
      /* ★ P7 兵营与民心：兵营等级越高征兵越快，民心低则征不动 */
      const secRaw = conscriptSec(total, c.cost_time);
      const cf = conscriptFactor(state, army.cityId || mainCity(state)?.cityId || 1);
      const sec = Math.max(2, Math.min(30, Math.round(secRaw * cf)));
      army.soldiers = normalizeTriple(army.soldiers);
      army.con_times = normalizeTriple(army.con_times);
      army.con_cnts = normalizeTriple(army.con_cnts);
      for (let i = 0; i < 3; i += 1) {
        army.con_cnts[i] = cnts[i];
        army.con_times[i] = cnts[i] > 0 ? nowSec() + sec : 0;
      }
      /* ★ 2026-11-19 P1-5：在途征兵令牌。解甲时作废，避免“退了金还补兵”。 */
      army.conToken = Math.floor(Number(army.conToken) || 0) + 1;
      /* 入营看游戏日，不看墙上的秒。人在城里时日子是停的，回到沙盘走到下一日才到账。
         定时器只留给回归测试找任务，放到很久以后，避免人还在城池页时兵已经进营。 */
      army.conArriveDay = Math.floor(Number(state.clock?.day) || 1) + 1;
      ctx.schedule(Date.now() + 14 * 86400000, {
        type: 'conscript_done', armyId: army.id, cnts, token: army.conToken,
      });
      ctx.push('roleRes.push', roleResOf(state));
      ctx.push('army.push', army);
      ctx.save();
      rsp.msg = {
        army: clone(army), role_res: roleResOf(state), etaSec: sec, need,
        // ★ 2026-11-18：兵种明细（各槽单兵成本 + 兵种名 + 本次分配），供 UI 展示差异化消耗
        perSlot, armsNames: ARMS_NAMES, cnts, caps: capsCheck.caps,
        levy: levyView(state, here), levyCommit, farmConflict,
        levyNote: `本城征 ${total} 丁：一户一丁、妇孺老弱免征；本旬不可再征。`,
      };
      break;
    }
    /* ★ 2026-11-18 用户诉求：解甲归田（玩家协议层此前完全缺失裁兵入口）。
       领域计算在 domain/conscript.planDisarm，handlers 只做参数校验 + 写回。 */
    case 'army.disarm': {
      const army = armyById(state, m.armyId);
      if (!army) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'no_army' }; break; }
      /* ★ P55：敌城驻军不得把兵「退回」敌城守军。 */
      if (!isOwnCity(state, army.cityId)) {
        rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'not_own_city', army: clone(army) }; break;
      }
      if (army.marchId) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'marching', army: clone(army) }; break; }
      const plan = planDisarm(m.counts || m.disband, army, null, { marching: !!army.marchId });
      if (!plan.ok) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: plan.reason }; break; }
      // 三槽遣散：兵退回驻城、清空在途、兵力写回
      army.soldiers = normalizeTriple(plan.remaining);
      army.con_cnts = [0, 0, 0];
      army.con_times = [0, 0, 0];
      army.conToken = Math.floor(Number(army.conToken) || 0) + 1; // 作废在途征兵
      const st = state.strategy || {};
      /* ★ P56：驻城记录缺失时退到玩家主城，绝不让遣散的兵凭空蒸发。 */
      const city = st.cities?.[Number(army.cityId)]
        || st.cities?.[Number(st.playerCity)]
        || Object.values(st.cities || {}).find((c) => c && c.owner === 'player');
      if (city) city.troops = Math.max(0, Math.floor(Number(city.troops) || 0) + plan.returnToCity);
      // 返还 30% 兵值金（与裁军同口径），走流水
      const r = state.roleRes;
      r.gold = Math.max(0, Math.floor(Number(r.gold) || 0) + plan.refund);
      recordRes(state, 'gold', plan.refund, `解甲归田·${plan.disbanded}兵`, Math.floor(Number(state.clock?.day) || 1));
      recordEvent(state, `第 ${army.order} 军解甲归田 ${plan.disbanded} 兵（${plan.amounts.map((n, i) => ARMS_NAMES[i] + n).join('、')}），退回驻城并返回兵值金 ${plan.refund}。`);
      ctx.push('roleRes.push', roleResOf(state));
      ctx.push('army.push', army);
      ctx.save();
      rsp.msg = { army: clone(army), disbanded: plan.disbanded, refund: plan.refund,
        returned: plan.returnToCity, cityTroops: city ? city.troops : null };
      break;
    }
    case 'army.assign': {
      const army = armyById(state, m.armyId);
      const cmd = Number(m.cmd ?? 0);
      const x = Number(m.x ?? 0);
      const y = Number(m.y ?? 0);
      if (!army) { rsp.msg = { army: {} }; break; }
      /* ★ P55：与 dispose/conscript/disarm 同口径——行军中队伍不得二次派兵，
         否则同一队伍同时挂战略行军与 battle_arrive 定时器，双线并发结算。 */
      if (army.marchId) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'marching', army: clone(army) };
        break;
      }
      /* ★ P55：队伍权限——驻地为敌城的队伍不得出兵（含易主瞬间的窗口）。 */
      if (!isOwnCity(state, army.cityId)) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'not_own_city', army: clone(army) };
        break;
      }
      /* ★ P55：优先用驻城自身的沙盘坐标（举义后本地主城与战略城是两套编号）；
         仅当该城确属我方时才采用，未举义的老存档仍走 mainCity，避免出发坐标错位。 */
      const homeRow = state.strategy?.cities?.[Number(army.cityId)];
      const city = (homeRow && homeRow.owner === 'player'
        && Number(homeRow.x) && Number(homeRow.y))
        ? homeRow : mainCity(state);
      army.cmd = cmd;
      army.from_x = city?.x ?? 0;
      army.from_y = city?.y ?? 0;
      army.start = nowSec();
      if (cmd === 1) {
        // ★ 攻击：排队到点后由确定性 battle-core 结算，再推原版战报
        const travelMs = marchMs(
          state, army.from_x, army.from_y, x, y, chapterRules(), options.travelMs,
        );
        army.state = 0;
        army.to_x = x; army.to_y = y;
        army.end = nowSec() + Math.ceil(travelMs / 1000);
        const seed = (army.id * 7919 + x * 104729 + y * 15485863 + state.battleLog.length) >>> 0;
        ctx.schedule(Date.now() + travelMs, { type: 'battle_arrive', armyId: army.id, x, y, seed });
        ctx.log('info', `army#${army.id} march to (${x},${y}), battle in ${travelMs}ms`);
      } else {
        army.state = 1;
        army.to_x = 0; army.to_y = 0; army.end = 0;
      }
      ctx.push('army.push', army);
      ctx.save();
      rsp.msg = { army: clone(army) };
      break;
    }

    /* ---------------- 战报 ---------------- */
    case 'war.report':
      rsp.msg = { list: clone(state.warReports.slice(0, 100)) };
      break;
    case 'war.read': {
      const id = Number(m.id ?? 0);
      for (const r of state.warReports) {
        if (id === 0 || r.id === id) { r.a_is_read = true; r.d_is_read = true; }
      }
      ctx.save();
      rsp.msg = { id };
      break;
    }

    /* ---------------- 技能 ---------------- */
    case 'skill.list':
      rsp.msg = { list: clone(state.skills) };
      break;

    case 'tavern.guests': {
      const realMsPerDay = chapterRules().realMsPerDay;
      const frac = dayFraction(state, realMsPerDay);
      // ★ P6：按城查询来访（msg.cityId）；缺省主城口径
      const cityId = Number(m.cityId) || 0;
      const live = guestsNow(state, realMsPerDay, cityId || null);
      const now = live.map((g) => ({ cfgId: g.cfgId, name: g.name, when: g.when }));
      /* ★ U15 来访名单带上相性/义理与登庸预计成功率（与 general.explore 掷骰同源） */
      const today = todaysGuests(state, undefined, cityId || null).map((g) => {
        const calc = talentRecruitRate(state, cfg, g);
        const camp = cfg?.generalByCfg?.get?.(Number(g.cfgId))?.camp ?? 1;
        return {
          cfgId: g.cfgId,
          name: g.name,
          when: g.when,
          recruited: false,
          birthCity: g.birthCity,
          xiangxing: xiangxingOf(g.cfgId, camp),
          yili: yiliOf(g.cfgId),
          xiangxingGap: calc.gap,
          recruitRate: calc.rate,
          // ★ P1-3：让界面能区分「还没到时辰 / 此刻在店 / 已过时辰」
          state: frac >= g.to ? 'passed' : (frac >= g.from ? 'now' : 'upcoming'),
        };
      });
      const nextAt = live.length
        ? null
        : today.find((g) => g.state === 'upcoming')?.when || '明日';
      rsp.msg = {
        now, today,
        cost: cfg.basic.general?.draw_general_cost ?? 30,
        day: state.clock?.day ?? 1,
        nextAt,
        cityId: cityId || null,
        exploredToday: cityId ? Boolean(state.tavern?.explores?.[`${state.clock?.day || 1}:${cityId}`]) : false,
        exploreCost: 100,
      };
      break;
    }

    /* ★ P6 探索人才（登庸）：派主角在指定城探索，成功即登庸一名在野武将。
     *   成功率 = 55% + 主角政治 × 0.3%；每城每日一次；费用 100 金。 */
    case 'general.explore': {
      const cityId = Number(m.cityId) || state.strategy?.playerCity || 1;
      const cost = 100;
      if ((state.roleRes.gold || 0) < cost) {
        const short = Math.max(0, cost - (state.roleRes.gold || 0));
        rsp.code = 5; rsp.msg = { reason: 'not_enough_gold', cost, short, line: failLine('poor', { cost, short }) };
        break;
      }
      const exp = exploreTalent(state, cfg, cityId);
      if (!exp.ok) {
        /* ★ 与招募同口径：失败给拟人句，不把 already_today/no_talent 暴露给玩家。 */
        const line = exp.reason === 'already_today'
          ? '本城今日已遣使探访过，明日再来。'
          : '本城在野贤才都已探访过，换座城再寻访罢。';
        rsp.code = 0; rsp.msg = { reason: exp.reason, line };
        break;
      }
      /* ★ U15 三顾之礼 + 相性 + 义理：成功率构成条与掷骰同源（relation.talentRecruitRate）。
         旧口径（55% + 政治×0.3%）只看政治，玩家无从判断「为什么这人挖不动」。 */
      state.tavern.favor = state.tavern.favor || {};
      const favorN = Number(state.tavern.favor[exp.target.cfgId] || 0);
      const calc = talentRecruitRate(state, cfg, exp.target);
      const rate = calc.rate / 100;
      /* 修 U21/U11：登庸掷骰改走确定性 rngFor（同 seed + 日 + 城 + 人 + 登门次数恒定）；
         费用只在成功登庸后扣，失败不收费（旧实现失败也扣 100 金且无补偿）。 */
      const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
      const success = rngFor(state.seed ?? 20261110, day,
        `explore:${cityId}:${exp.target.cfgId}:${favorN}`).random() < rate;
      if (!success) {
        state.tavern.favor[exp.target.cfgId] = favorN + 1;
        ctx.push?.('roleRes.push', roleResOf(state));
        ctx.save();
        rsp.code = 0;
        const exLine = refusalLine(cfg.generalByCfg.get(Number(exp.target.cfgId)) || {}, {
          cfgId: exp.target.cfgId, favor: favorN + 1,
        });
        rsp.msg = {
          reason: 'not_found', rate: Math.round(rate * 100), cityId, name: exp.target.name,
          favor: favorN + 1, charged: 0,
          line: exLine.text, persona: exLine.persona,
          /* 工程字段保留供审计；界面只显示 line，不复算概率 */
          parts: calc.parts, xiangxingGap: calc.gap, yili: calc.yili,
        };
        break;
      }
      state.roleRes.gold -= cost;
      recordRes(state, 'gold', -cost, `探索人才·${cityNameOf(cityId)}`);
      const person = exp.target;
      person.recruited = true;
      delete state.tavern.favor[person.cfgId];
      const g = makeGeneral(cfg, nextId(state, 'generalId'), person.cfgId, cityId, 1);
      g.loyal = Math.min(100, 80 + Math.round(protagonistStat(state, '魅力') / 20));
      state.generals.push(g);
      noticeRecruit(state, ctx, person.name || '');
      ctx.push('general.push', g);
      syncOwnedSkills(state);
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.code = 0;
      rsp.msg = {
        general: withGeneralNames(state, cfg, clone([g]))[0],
        rate: Math.round(rate * 100),
        parts: calc.parts,
        cityId,
      };
      recordEvent(state, `遣使探索${cityNameOf(cityId)}，登庸在野贤才「${person.name}」，即日入仕。`);
      break;
    }

    case 'world.meta': {
      const c = cfg.basic.conscript || {};
      /* ★ 2026-11-18：下发三兵种差异化单兵成本（盾步/弓/骑），并补上此前漏掉的石耗。
         conscript 保留盾步单价做兼容；conscriptPerSlot 供征兵页逐槽显示各自成本。 */
      const metaNeed = conscriptNeed([1, 1, 1], c, {});
      rsp.msg = {
        conscript: {
          wood: metaNeed.perSlot[0].wood, iron: metaNeed.perSlot[0].iron,
          stone: metaNeed.perSlot[0].stone, grain: metaNeed.perSlot[0].grain,
          gold: metaNeed.perSlot[0].gold, timePer: c.cost_time ?? 1,
        },
        conscriptPerSlot: metaNeed.perSlot.map((p) => ({ ...p, timePer: c.cost_time ?? 1 })),
        conscriptArmsNames: ARMS_NAMES,
        drawGeneralCost: cfg.basic.general?.draw_general_cost ?? 30,
        collectLimit: cfg.basic.role?.collect_times_limit ?? 3,
        collectIntervalSec: cfg.basic.role?.collect_interval ?? 30,
      };
      break;
    }

    /* ★ 2026-11-18 自建势力（用户裁决：局内达条件解锁 + 输入国号；领域在 faction-identity） */
    case 'nation.foundStatus': {
      rsp.msg = { ...foundStatus(state), identity: playerIdentity(state, cfg) };
      break;
    }
    case 'nation.found': {
      const r = foundNation(state, m.name, m.color);
      if (!r.ok) { rsp.code = CODE.InvalidParam; rsp.msg = r; break; }
      recordEvent(state, `第 ${r.founded.day} 日，主公于旧主之外自立，国号「${r.founded.name}」，自此独树一帜。`);
      ctx.save();
      rsp.msg = { founded: r.founded, identity: playerIdentity(state, cfg) };
      break;
    }
    /* ---------------- 联盟（单机：仅自己） ---------------- */
    case 'union.create': {
      state.union = {
        id: nextId(state, 'unionId'), name: m.name || '我的联盟',
        cnt: 1, notice: '',
        major: [{ rid: state.role.rid, name: state.role.nickName, title: 0 }],
        members: [{ rid: state.role.rid, name: state.role.nickName, title: 0, x: mainCity(state)?.x ?? 0, y: mainCity(state)?.y ?? 0 }],
      };
      ctx.save();
      rsp.msg = { id: state.union.id, name: state.union.name };
      break;
    }
    case 'union.list':
      rsp.msg = { list: state.union ? [clone({ id: state.union.id, name: state.union.name, cnt: state.union.cnt, notice: state.union.notice, major: state.union.major })] : [] };
      break;
    case 'union.member':
      rsp.msg = { id: Number(m.id ?? 0), Members: clone(state.union?.members || []) };
      break;
    case 'union.info':
      rsp.msg = { id: Number(m.id ?? 0), info: clone(state.union || {}) };
      break;
    case 'union.applyList':
      rsp.msg = { id: Number(m.id ?? 0), applys: [] };
      break;
    case 'union.log':
      rsp.msg = { logs: [] };
      break;
    case 'union.join':
    case 'union.verify':
    case 'union.exit':
    case 'union.dismiss':
    case 'union.notice':
    case 'union.kick':
    case 'union.appoint':
    case 'union.abdicate':
      rsp.msg = { ...m };
      break;
    case 'union.modNotice':
      if (state.union) { state.union.notice = m.text || ''; ctx.save(); }
      rsp.msg = { id: state.union?.id ?? 0, text: m.text || '' };
      break;

    /* ---------------- 聊天 ---------------- */
    case 'chat.login':
      rsp.msg = { rid: m.rid ?? state.role.rid, nickName: m.nickName ?? state.role.nickName };
      break;
    case 'chat.logout':
      rsp.msg = { RId: m.RId ?? 0 };
      break;
    case 'chat.chat': {
      const cm = {
        rid: state.role.rid, nickName: state.role.nickName,
        type: Number(m.type ?? 0), msg: String(m.msg ?? ''), time: Date.now(),
      };
      state.chat.push(cm);
      if (state.chat.length > 200) state.chat.shift();
      ctx.push('chat.push', cm);
      ctx.save();
      rsp.msg = cm;
      break;
    }
    case 'chat.history':
      rsp.msg = { type: Number(m.type ?? 0), msgs: clone(state.chat.filter((c) => c.type === Number(m.type ?? 0))) };
      break;
    case 'chat.join':
    case 'chat.exit':
      rsp.msg = { type: Number(m.type ?? 0), id: Number(m.id ?? 0) };
      break;

    case 'campaign.status':
      rsp.msg = {
        day: state.clock?.day ?? 1,
        scale: state.clock?.scale ?? 1,
        drift: state.drift?.score ?? 0,
        band: state.drift?.band ?? 'canon',
        choice: state.campaign?.choice ?? null,
        ending: state.campaign?.ending ?? null,
        endingDay: state.campaign?.endingDay ?? null,
        chapter: state.campaign?.chapter ?? 1,
        // 结局之后是否还能按日触发（P0-4：结算完就冻结，不再写 fired）
        frozen: !!state.campaign?.ending,
        blueprints: [...(state.campaign?.blueprints || [])],
        spearmanId: state.campaign?.spearmanId ?? 0,
      };
      break;
    case 'campaign.choose': {
      const picked = m.option === 'lend' || m.option === 0 ? 'lend'
        : (m.option === 'refuse' || m.option === 1 ? 'refuse' : '');
      const decided = chooseChapter(state, picked);
      let applied = false;
      if (decided.ok) {
        const result = applyChoice(state, cfg, ctx, chapterRules(), picked);
        applied = result.ok || state.campaign.choice === picked;
      }
      const ok = decided.ok && applied;
      if (!ok) rsp.code = CODE.InvalidParam;
      else ctx.save();
      rsp.msg = { choice: state.campaign?.choice ?? null, ok };
      break;
    }
    case 'campaign.speed': {
      const scale = Number(m.scale) === 4 ? 4 : 1;
      state.clock.scale = scale;
      ctx.save();
      rsp.msg = { scale };
      break;
    }
    case 'strategy.attack': {
      const fracRaw = Number(m.frac);
      const frac = Number.isFinite(fracRaw) && fracRaw > 0 && fracRaw <= 1 ? fracRaw : 1;
      const result = strategyAttack(state, cfg, ctx, {
        cityId: Number(m.cityId), armyId: Number(m.armyId), frac,
        fromCityId: Number(m.fromCityId) || 0,
      });
      /* ★ 修 bug-14：旧实现失败时同时用 code≠0 与 msg.ok=false 两套语义，
         客户端判 code 就刷新界面、判 ok 就弹 toast，出现「说失败但已刷新」。
         现在统一：ok 是唯一判定，code 只作为协议层错误码同步（非 0 即失败）。 */
      if (!result.ok) rsp.code = CODE.InvalidParam;
      else ctx.save();
      rsp.msg = {
        ok: result.ok, marching: result.marching || false, reason: result.reason,
        marchId: result.marchId, arriveDay: result.arriveDay, need: result.need,
        city: result.city, grainCost: result.grainCost,
        marchDays: result.marchDays, km: result.km, speed: result.speed, from: result.from,
        armyId: result.armyId || 0, troops: result.troops || 0,
        deploy: result.deploy || 0, frac: result.frac ?? frac,
      };
      break;
    }
    case 'strategy.recallMarch': {
      // ★ 出征面板：撤回在途队伍（攻击队解锁归城、运输队粮车折返）
      const result = strategyRecallMarch(state, cfg, ctx, { marchId: Number(m.marchId) });
      if (!result.ok) rsp.code = CODE.InvalidParam;
      else ctx.save();
      rsp.msg = result;
      break;
    }
    case 'strategy.clearThreat': {
      const result = clearThreat(state, cfg, ctx, {
        garrisonId: Number(m.garrisonId), armyId: Number(m.armyId),
      });
      if (!result.ok) rsp.code = CODE.InvalidParam;
      else ctx.save();
      rsp.msg = result;
      break;
    }

    default:
      /* ★ 修 bug-22：未知消息以前也回 code 0，客户端表现为「点了成功但什么也没发生」。
         现在明确回 404，让版本不匹配能被看见。 */
      ctx.log('warn', `unhandled message: ${name}`);
      rsp.code = 404;
      rsp.msg = { reason: 'unknown_message', name };
  }

  // code 默认 0（OK）；玩法校验失败时按原版 constant/code.go 返回，客户端弹原版提示
  return { code: rsp.code ?? OK, msg: rsp.msg };
}
