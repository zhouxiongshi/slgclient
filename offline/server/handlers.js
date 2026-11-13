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
import { skillById, LEVEL_COUNT } from './skills.js';
import { marchMs, rewindDays } from './clock.js';
import { facilityBonus, recordRes } from './domain/economy.js';
import { cityLayer, ensureCityEcon, conscriptFactor, cityYield, cityName } from './domain/city-econ.js';
/* ★ P11 兵役制：一户一丁 / 妇孺免征 / 一旬一征 / 先养人口，唯一权威源 */
import { checkLevy, commitLevy, levyView, farmConflictOf } from './domain/levy.js';
import {
  chapterRules, settleCampaign, chooseChapter, onTileCleared, applyChoice, noticeRecruit,
} from './domain/campaign.js';
import { slotBlock } from './domain/slots.js';
import { rngFor } from './domain/strategy-rng.js';
import { ensureTavern, guestsNow, announceTavern, todaysGuests, dayFraction, exploreTalent, cityNameOf } from './domain/tavern.js';
/* ★ U15 相性/义理/关系网：登庸成功率与面板构成条同源 */
import { talentRecruitRate, xiangxingOf, yiliOf, relationSummary, relationGraph } from './domain/relation.js';
import {
  strategyTick, strategyAttack, strategyTurnDays, ensureStrategy, clearThreat,
  strategyResolveMarches, strategyRecallMarch, recordEvent,
} from './domain/strategy.js';
import { createHash } from 'node:crypto';
import { noteIfGeneralDown } from './command.js';
import { factionTraitOf, protagonistStat } from './domain/oath.js';

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

/** 设施被动升级（复刻 model.Facility.GetLevel：升级到点后在读取时自动完成）。 */
function facilityGetLevel(cfg, f) {
  if (f.up_time > 0) {
    const t = cfg.facilityTime(f.type, f.level + 1);
    if (t > 0 && nowSec() >= f.up_time + t) {
      f.level += 1;
      f.up_time = 0;
    }
  }
  return f.level;
}

/** 所有城池设施被动升级（每次请求前调用）。 */
function tickFacilities(state, cfg) {
  for (const list of Object.values(state.facilities || {})) {
    for (const f of list) facilityGetLevel(cfg, f);
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
  for (const list of Object.values(state.facilities || {})) {
    for (const f of list) {
      const lv = facilityGetLevel(cfg, f);
      if (lv <= 0) continue;
      const values = cfg.facilityValues(f.type, lv);
      cfg.facilityAdditions(f.type).forEach((aType, i) => {
        const bonus = facilityBonus(state, aType, chapterRules());
        const v = Math.floor((values[i] || 0) * (1 + bonus));
        if (aType === 17) y.wood += v;
        else if (aType === 18) y.iron += v;
        else if (aType === 19) y.grain += v;
        else if (aType === 20) y.stone += v;
        else if (aType === 21) y.gold += v;
        else if (aType === 23) y.capacity += v;
      });
    }
  }
  return y;
}

/** 领地建筑产量（复刻 roleBuildMgr.GetYield；原版把粮食误加给石矿，此处按正确语义）。 */
function buildYield(state) {
  const y = { wood: 0, iron: 0, stone: 0, grain: 0 };
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
  r.wood_yield = (base.wood_yield ?? 1000) + fa.wood + by.wood + (cl.wood || 0);
  r.iron_yield = (base.iron_yield ?? 1000) + fa.iron + by.iron + (cl.iron || 0);
  r.stone_yield = (base.stone_yield ?? 1000) + fa.stone + by.stone + (cl.stone || 0);
  r.grain_yield = (base.grain_yield ?? 1000) + fa.grain + by.grain + (cl.grain || 0);
  r.gold_yield = (base.gold_yield ?? 1000) + fa.gold + (cl.gold || 0);
  r.depot_capacity = (base.depot_capacity ?? 1000000) + fa.capacity;
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
export function settleWorld(ctx, now = Date.now()) {
  const { state, cfg } = ctx;
  tickFacilities(state, cfg);
  totalYield(state, cfg);
  const settled = settleCampaign(state, cfg, ctx, now);
  // ★ P2：行军到达结算（在诸侯推演之前，保证当天抵达当天开打；战报与播报由内部推）
  strategyResolveMarches(state, cfg, ctx);
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
  const turnDays = strategyTurnDays();
  const turnBefore = st.turn;
  const target = (st.lastTurnDay || 0) + turnDays;
  const need = Math.max(0, target - (state.clock?.day ?? 1));
  /* 修 U22：旧实现每次都用 rewindDays 伪造「已过 10 日」再结算，连点可无限推进，
     回合门槛形同虚设，且界面不告诉玩家发生了什么。现在不再假装是「回合到了」：
       - need > 0 明确标记为 fast-forward（自由快进），返回真实推进天数与结算摘要；
       - need === 0 才是正式回合结算 turn-settle；
       - 摘要供「推进前预览」使用（设计规格 6.10 / P3 / P8：规则 100% 透明）。 */
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
    month: (st.turn || 0) + 1,
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

/** 玩家已拥有技能 = 所有武将装配技能的去重集合（原 proto.Skill{id,cfgId,generals}）。 */
function withGeneralNames(state, cfg, list) {
  return list.map((g) => ({
    ...g,
    name: cfg.generalByCfg.get(g.cfgId)?.name || '',
    star: g.star ?? 0,
    skills: (g.skills || []).map((s) => (s
      ? { ...s, name: skillById(s.cfgId)?.ui?.name || '' }
      : null)),
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
    const { report, kernel, endAttackSoldiers, expByGeneral } = resolveBattle({
      cfg, state, army, x: task.x, y: task.y, seed: task.seed,
    });
    army.soldiers = endAttackSoldiers;
    army.cmd = 0;
    army.state = 1;
    army.to_x = 0; army.to_y = 0; army.end = 0;
    noteIfGeneralDown(state, ctx, army);
    for (const [gid, exp] of Object.entries(expByGeneral)) {
      const g = findGeneral(state, Number(gid));
      if (g) g.exp += exp;
    }
    state.warReports.unshift(report);
    if (state.warReports.length > 100) state.warReports.length = 100;

    // 胜利后占领该格：沿用原有 roleBuild.push 逻辑。黄巾格先清掉守军并还原产量，再推送。
    if (report.result === 2) {
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
    // ★ 试玩 P1-2：soldiers 只有 1 个元素时，旧写法 undefined + 0 = NaN，
    //   Math.max(0, NaN) 仍是 NaN，JSON 序列化成 null 写进存档。
    //   这里先补齐数组并按「有限整数」入账，绝不让 null/NaN 落盘。
    army.soldiers = normalizeTriple(army.soldiers);
    army.con_times = normalizeTriple(army.con_times);
    army.con_cnts = normalizeTriple(army.con_cnts);
    for (let i = 0; i < 3; i += 1) {
      const add = Math.max(0, Math.floor(Number(task.cnts?.[i]) || 0));
      army.soldiers[i] += add;
      army.con_times[i] = 0;
      army.con_cnts[i] = 0;
    }
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
      rsp.msg = { role_res: roleResOf(state) };
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
      const facilities = (list || []).map((f) => ({
        ...clone(f),
        maxLevel: cfg.facilityMaxLevel(f.type),
        nextNeed: cfg.facilityNeed(f.type, f.level + 1),
        nextTime: cfg.facilityTime(f.type, f.level + 1),
      }));
      rsp.msg = { cityId: clientCid, realCityId: realCid, facilities };
      break;
    }
    case 'city.upFacility': {
      // 原版语义：校验 maxLevel / 未在升级中 / 按 facility_*.json 的 need 扣资源；
      // 升级有工期（up_time），到点后由 facilityGetLevel 被动完成
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
      const need = cfg.facilityNeed(fType, f.level + 1);
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
      f.up_time = nowSec();
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
      const sameDay = last > 0 && new Date(last).toDateString() === new Date(now).toDateString();
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
      if (!market || facilityGetLevel(cfg, market) <= 0) {
        // ★ 修 bug-10：以前只回 code 58，没有 msg，客户端只能弹通用错误
        rsp.code = CODE.NotHasJiShi;
        rsp.msg = { reason: 'no_market', hint: '需要先在本城建造并升级「集市」' };
        break;
      }
      const from = m.from || [0, 0, 0, 0];
      const to = m.to || [0, 0, 0, 0];
      const ret = [0, 0, 0, 0];
      for (let i = 0; i < 4; i += 1) {
        if (Number(from[i] || 0) > 0) ret[i] = -Number(from[i]);
        else if (Number(to[i] || 0) > 0) ret[i] = Number(to[i]);
      }
      const r = state.roleRes;
      if (!ret.every((v, i) => (r[RES_KEYS[i]] || 0) + v >= 0)) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'res_not_enough', need: ret };
        break;
      }
      for (let i = 0; i < 4; i += 1) r[RES_KEYS[i]] = (r[RES_KEYS[i]] || 0) + ret[i];
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.msg = {};
      break;
    }

    /* ---------------- 武将 ---------------- */
    case 'general.myGenerals':
      rsp.msg = { generals: withGeneralNames(state, cfg, clone(state.generals)) };
      break;
    case 'general.drawGeneral': {
      ensureTavern(state, cfg);
      const times = Math.max(1, Math.min(10, Number(m.drawTimes ?? 1)));
      const realMsPerDay = chapterRules().realMsPerDay;
      // ★ P6：支持按城招募——各城酒馆来的是本籍在野武将；不带 cityId 时沿用主城口径
      const cityId = Number(m.cityId) || 0;
      const here = guestsNow(state, realMsPerDay, cityId || null).slice(0, times);
      const costEach = cfg.basic.general?.draw_general_cost ?? 30;
      const added = [];
      // ★ 试玩 P1-3：旧实现「此刻无人 / 金不足」都返回 code 0 + 空数组，静默失败。
      //   现在把原因和今天剩下的人一并回给界面，玩家知道自己在等什么。
      if (!here.length) {
        rsp.msg = {
          generals: [],
          reason: 'no_guest',
          cost: costEach,
          today: todaysGuests(state, undefined, cityId || null).map((g) => ({ cfgId: g.cfgId, name: g.name, when: g.when, cityId: g.birthCity })),
        };
        break;
      }
      if ((state.roleRes.gold || 0) < costEach) {
        rsp.msg = { generals: [], reason: 'not_enough_gold', cost: costEach, gold: state.roleRes.gold || 0 };
        break;
      }
      const affordable = Math.min(here.length, Math.floor((state.roleRes.gold || 0) / costEach));
      state.roleRes.gold -= costEach * affordable;
      for (const person of here.slice(0, affordable)) {
        person.recruited = true;
        const row = state.tavern.people.find((p) => p.cfgId === person.cfgId);
        if (row) row.recruited = true;
        const g = makeGeneral(cfg, nextId(state, 'generalId'), person.cfgId, mainCity(state)?.cityId ?? 1, 1);
        state.generals.push(g);
        added.push(g);
        noticeRecruit(state, ctx, cfg.generalByCfg.get(g.cfgId)?.name || '');
        ctx.push('general.push', g);
      }
      syncOwnedSkills(state);
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.msg = { generals: withGeneralNames(state, cfg, clone(added)), reason: added.length ? '' : 'not_enough_gold' };
      break;
    }
    case 'general.composeGeneral': {
      const ids = (m.gIds || []).map(Number);
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
      if (g) {
        const slots = ensureSlots(g);
        if (name === 'general.upSkill') {
          const conf = skillById(cfgId);
          if (!conf) {
            reason = 'invalid_skill';           // 旧 101/201/301/401 一律拒绝
          } else {
            const usedByOthers = state.generals.filter(
              (other) => other.id !== g.id && (other.skills || []).some((s) => s && s.cfgId === cfgId),
            ).length;
            if (usedByOthers >= conf.ui.limit) {
              reason = 'limit_reached';
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
          if (!cur) reason = 'empty_slot';
          else if (cur.lv >= LEVEL_COUNT) reason = 'max_level';
          else {
            const cost = 120 * cur.lv;
            if ((state.roleRes.gold ?? 0) < cost) reason = 'not_enough_gold';
            else {
              state.roleRes.gold -= cost;
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
      rsp.msg = { gId, cfgId, pos, ok, reason };
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
      // ★ 试玩 P1-4：原版只有 3 支队伍。旧逻辑对 order 不做校验，客户端发 order:0
      //   就凭空造出第 4 支空队，同一武将还能同时挂在两支队伍里。
      if (!Number.isInteger(order) || order < 1 || order > 3) {
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
      if (gid > 0 && !findGeneral(state, gid)) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'bad_general', generalId: gid };
        break;
      }
      let army = state.armys.find((a) => a.cityId === cityId && a.order === order);
      // ★ 试玩 bug-2：行军中的队伍不能改编制（否则等于边走边换将补兵）
      if (army && army.marchId) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'marching', army: clone(army) };
        break;
      }
      if (!army) {
        if (gid <= 0) { rsp.msg = { army: {} }; break; }   // 只是把空槽位清空，不建队
        // 新建队伍必须带完整字段，否则 army.generals[pos] 直接抛异常
        army = makeArmy(nextId(state, 'armyId'), cityId, order, [0, 0, 0], [0, 0, 0]);
        state.armys.push(army);
      }
      army.generals = normalizeTriple(army.generals);
      army.soldiers = normalizeTriple(army.soldiers);
      // 同一武将只能占一个槽位：先从其它队伍/槽位摘掉，再落到目标槽位
      if (gid > 0) {
        for (const a of state.armys) {
          a.generals = normalizeTriple(
            (a.generals || []).map((id, i) => (id === gid && !(a === army && i === pos) ? 0 : id)),
          );
        }
        army.generals[pos] = gid;
      } else {
        army.generals[pos] = 0;
      }
      for (const g of state.generals) g.order = 0;
      for (const a of state.armys) for (const id of (a.generals || [])) {
        const g = findGeneral(state, id);
        if (g) g.order = a.order;
      }
      ctx.push('army.push', army);
      ctx.save();
      rsp.msg = { army: clone(army) };
      break;
    }
    case 'army.conscript': {
      const army = armyById(state, m.armyId);
      if (!army) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'no_army' }; break; }
      // ★ 试玩 bug-2：行军中不能征兵（否则路上补满兵再打）
      if (army.marchId) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'marching', army: clone(army) }; break; }
      const cnts = normalizeTriple(m.cnts);
      const total = cnts.reduce((s, n) => s + n, 0);
      if (total <= 0) { rsp.code = CODE.InvalidParam; rsp.msg = { reason: 'zero' }; break; }
      // ★ 试玩 P1-1：每兵成本按 basic.json 逐项扣。旧逻辑把四项加总（31/兵）
      //   全从木头扣，还用 Math.max(0, ...) 兜底 —— 资源不足也能白嫖。
      const c = cfg.basic.conscript || {};
      const per = {
        wood: c.cost_wood ?? 10, iron: c.cost_iron ?? 10, stone: c.cost_stone ?? 0,
        grain: c.cost_grain ?? 10, gold: c.cost_gold ?? 1,
      };
      const need = {
        wood: total * per.wood, iron: total * per.iron, stone: total * per.stone,
        grain: total * per.grain, gold: total * per.gold,
      };
      // ★ P4-①：势力特技改征兵成本（董卓·西凉铁骑 -15%、刘备·仁德 -10%）
      const trait = factionTraitOf(state);
      if (trait.recruitPct) {
        for (const k of Object.keys(need)) {
          need[k] = Math.max(1, Math.round(need[k] * (1 + trait.recruitPct / 100)));
        }
      }
      // 槽位必须已有武将：内核按槽位取将，空槽位征兵等于白扣资源
      const emptySlot = cnts.findIndex((n, i) => n > 0 && !army.generals?.[i]);
      if (emptySlot >= 0) {
        rsp.code = CODE.InvalidParam;
        rsp.msg = { reason: 'empty_slot', slot: emptySlot, per };
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
      if (code !== OK) { rsp.code = code; rsp.msg = { reason: 'res_not_enough', need, per }; break; }
      /* 资源已扣，写兵役台账：本城扣人口基数（×4）、已征户 +N、本旬标记、民心下降 */
      const levyCommit = strict || econ?.[here]
        ? commitLevy(state, here, total)
        : null;
      const farmConflict = farmConflictOf(state, here, total);
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
      ctx.schedule(Date.now() + sec * 1000, { type: 'conscript_done', armyId: army.id, cnts });
      ctx.push('roleRes.push', roleResOf(state));
      ctx.push('army.push', army);
      ctx.save();
      rsp.msg = {
        army: clone(army), role_res: roleResOf(state), etaSec: sec, need,
        levy: levyView(state, here), levyCommit, farmConflict,
        levyNote: `本城征 ${total} 丁：一户一丁、妇孺老弱免征；本旬不可再征。`,
      };
      break;
    }
    case 'army.assign': {
      const army = armyById(state, m.armyId);
      const cmd = Number(m.cmd ?? 0);
      const x = Number(m.x ?? 0);
      const y = Number(m.y ?? 0);
      if (!army) { rsp.msg = { army: {} }; break; }
      const city = mainCity(state);
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
        rsp.code = 5; rsp.msg = { reason: 'not_enough_gold', cost };
        break;
      }
      const exp = exploreTalent(state, cfg, cityId);
      if (!exp.ok) { rsp.code = 0; rsp.msg = { reason: exp.reason }; break; }
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
        rsp.msg = {
          reason: 'not_found', rate: Math.round(rate * 100), cityId, name: exp.target.name,
          favor: favorN + 1, charged: 0,
          /* ★ U15 构成条：逐项拆解（基础/政治/相性/义理/三顾），玩家能看出下次该改什么 */
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
      rsp.msg = {
        conscript: {
          wood: c.cost_wood ?? 10, iron: c.cost_iron ?? 10,
          grain: c.cost_grain ?? 10, gold: c.cost_gold ?? 1,
          timePer: c.cost_time ?? 1,
        },
        drawGeneralCost: cfg.basic.general?.draw_general_cost ?? 30,
        collectLimit: cfg.basic.role?.collect_times_limit ?? 3,
        collectIntervalSec: cfg.basic.role?.collect_interval ?? 30,
      };
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
