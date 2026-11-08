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
  nextId, findGeneral, findArmy, findCity, mainCity, makeGeneral,
  makeBuild, makeCity, makeArmy, generalToArray,
} from './world.js';
import { resolveBattle } from './battle.js';
import { skillById, LEVEL_COUNT } from './skills.js';
import { marchMs } from './clock.js';
import { facilityBonus } from './domain/economy.js';
import {
  chapterRules, settleCampaign, chooseChapter, onTileCleared,
} from './domain/campaign.js';
import { slotBlock } from './domain/slots.js';
import { ensureTavern, guestsNow, announceTavern } from './domain/tavern.js';
import { noteIfGeneralDown } from './command.js';

const OK = 0;
const nowSec = () => Math.floor(Date.now() / 1000);
const clone = (v) => JSON.parse(JSON.stringify(v));
const RES_KEYS = ['wood', 'iron', 'stone', 'grain'];

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

/** 总产量 = 基础 + 设施 + 领地（复刻 GetYield），并同步回 role_res 供客户端界面显示。 */
function totalYield(state, cfg) {
  const base = cfg.basic.role || {};
  const fa = facilityAdditions(state, cfg);
  const by = buildYield(state);
  const r = state.roleRes;
  r.wood_yield = (base.wood_yield ?? 1000) + fa.wood + by.wood;
  r.iron_yield = (base.iron_yield ?? 1000) + fa.iron + by.iron;
  r.stone_yield = (base.stone_yield ?? 1000) + fa.stone + by.stone;
  r.grain_yield = (base.grain_yield ?? 1000) + fa.grain + by.grain;
  r.gold_yield = (base.gold_yield ?? 1000) + fa.gold;
  r.depot_capacity = (base.depot_capacity ?? 1000000) + fa.capacity;
  return r;
}

/** 原版 TryUseNeed：政令不足→25，资源不足→16，成功扣除→0。 */
function tryUseNeed(state, need) {
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
  return OK;
}

/** 设施到点仍按真实秒。资源改按游戏日入账，军饷和序章在 settleCampaign。 */
function accrue(ctx) {
  const { state, cfg } = ctx;
  tickFacilities(state, cfg);
  totalYield(state, cfg);
  settleCampaign(state, cfg, ctx, Date.now());
  ensureTavern(state, cfg);
  announceTavern(state, ctx, chapterRules().realMsPerDay);
  return tickBuilds(state, cfg);
}

function roleResOf(state) {
  return clone(state.roleRes);
}

function armyById(state, id) {
  return findArmy(state, Number(id));
}

/** 玩家已拥有技能 = 所有武将装配技能的去重集合（原 proto.Skill{id,cfgId,generals}）。 */
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
    for (let i = 0; i < 3; i += 1) {
      army.soldiers[i] = Math.max(0, army.soldiers[i] + (task.cnts?.[i] || 0));
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
  const finishedBuilds = accrue(ctx);
  for (const b of finishedBuilds) ctx.push('roleBuild.push', b); // 建造/升级/拆除到点，主动推原版通道
  const rsp = {};

  switch (name) {
    /* ---------------- 连接 / 账号 ---------------- */
    case 'heartbeat':
      rsp.msg = { ctime: m.ctime ?? Date.now(), stime: Date.now() };
      return { code: OK, msg: rsp.msg, seq: 0 };

    case 'account.login':
      state.account.username = m.username || state.account.username;
      state.account.password = m.password || '';
      ctx.save();
      rsp.msg = {
        username: state.account.username,
        password: state.account.password,
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
      const code = tryUseNeed(state, c.need);
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
        const code = tryUseNeed(state, c.need);
        if (code !== OK) { rsp.code = code; break; }
        b.building = true;
        b.op_level = c.level;            // level 保持当前值，op_level 为目标等级
        b.end_time = nowSec() + (c.time ?? 0);
      } else {
        const c = cfg.buildCustomCfg(b.type, b.level);
        if (!c) { rsp.code = CODE.InvalidParam; break; }
        const code = tryUseNeed(state, c.need);
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
      const cityId = Number(m.cityId ?? mainCity(state)?.cityId ?? 1);
      rsp.msg = { cityId, facilities: clone(state.facilities[cityId] || []) };
      break;
    }
    case 'city.upFacility': {
      // 原版语义：校验 maxLevel / 未在升级中 / 按 facility_*.json 的 need 扣资源；
      // 升级有工期（up_time），到点后由 facilityGetLevel 被动完成
      const cityId = Number(m.cityId ?? mainCity(state)?.cityId ?? 1);
      const fType = Number(m.fType ?? 0);
      const list = state.facilities[cityId] || (state.facilities[cityId] = []);
      let f = list.find((x) => x.type === fType);
      if (!f) {
        // 原版 GetAndTryCreate：设施缺失时按 facility.json 补建
        const conf = (cfg.facility.list || []).find((x) => x.type === fType);
        f = { name: conf?.name || '设施', level: 0, type: fType, up_time: 0 };
        list.push(f);
      }
      const maxLv = cfg.facilityMaxLevel(fType);
      if (maxLv <= 0 || f.level >= maxLv) { rsp.code = CODE.UpError; break; }
      if (f.up_time > 0) { rsp.code = CODE.UpError; break; } // 正在升级中
      const need = cfg.facilityNeed(fType, f.level + 1);
      if (!need) { rsp.code = CODE.UpError; break; }
      const code = tryUseNeed(state, need);
      if (code !== OK) { rsp.code = code; break; }
      f.up_time = nowSec();
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.msg = { cityId, facility: clone(f), role_res: roleResOf(state) };
      break;
    }
    case 'interior.collect': {
      // 原版语义：按日重置次数 → 次数上限 → CD → 金币 = 税收产量（含设施加成）
      const limit = cfg.basic.role?.collect_times_limit ?? 3;
      const interval = (cfg.basic.role?.collect_interval ?? 30) * 1000;
      const now = Date.now();
      const last = state.roleAttr.lastCollectTime || 0;
      const sameDay = last > 0 && new Date(last).toDateString() === new Date(now).toDateString();
      if (!sameDay) state.roleAttr.collectTimes = 0;
      if ((state.roleAttr.collectTimes || 0) >= limit) { rsp.code = CODE.OutCollectTimesLimit; break; }
      if (sameDay && now - last < interval) { rsp.code = CODE.InCdCanNotOperate; break; }
      const r = totalYield(state, cfg);
      const gold = r.gold_yield || 1000;
      state.roleRes.gold += gold;
      state.roleAttr.collectTimes = (state.roleAttr.collectTimes || 0) + 1;
      state.roleAttr.lastCollectTime = now;
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      let nextTime;
      if (state.roleAttr.collectTimes >= limit) {
        const d = new Date(now);
        d.setHours(24, 0, 0, 0);          // 次日零点（原版语义）
        nextTime = d.getTime();
      } else {
        nextTime = now + interval;
      }
      rsp.msg = {
        gold, limit,
        cur_times: state.roleAttr.collectTimes,
        next_time: nextTime,
      };
      break;
    }
    case 'interior.openCollect':
      rsp.msg = {
        limit: cfg.basic.role?.collect_times_limit ?? 3,
        cur_times: state.roleAttr.collectTimes || 0,
        next_time: state.roleAttr.lastCollectTime
          ? state.roleAttr.lastCollectTime + (cfg.basic.role?.collect_interval ?? 30) * 1000
          : 0,
      };
      break;
    case 'interior.transform': {
      // 原版语义：必须有集市（type 15）→ ret[i] = -From[i] 或 +To[i]（不同索引）→ 不可扣成负数
      const city = mainCity(state);
      const facilities = state.facilities[city?.cityId ?? 1] || [];
      const market = facilities.find((f) => f.type === 15);
      if (!market || facilityGetLevel(cfg, market) <= 0) { rsp.code = CODE.NotHasJiShi; break; }
      const from = m.from || [0, 0, 0, 0];
      const to = m.to || [0, 0, 0, 0];
      const ret = [0, 0, 0, 0];
      for (let i = 0; i < 4; i += 1) {
        if (Number(from[i] || 0) > 0) ret[i] = -Number(from[i]);
        else if (Number(to[i] || 0) > 0) ret[i] = Number(to[i]);
      }
      const r = state.roleRes;
      if (!ret.every((v, i) => (r[RES_KEYS[i]] || 0) + v >= 0)) { rsp.code = CODE.InvalidParam; break; }
      for (let i = 0; i < 4; i += 1) r[RES_KEYS[i]] = (r[RES_KEYS[i]] || 0) + ret[i];
      ctx.push('roleRes.push', roleResOf(state));
      ctx.save();
      rsp.msg = {};
      break;
    }

    /* ---------------- 武将 ---------------- */
    case 'general.myGenerals':
      rsp.msg = { generals: clone(state.generals) };
      break;
    case 'general.drawGeneral': {
      ensureTavern(state, cfg);
      const times = Math.max(1, Math.min(10, Number(m.drawTimes ?? 1)));
      const here = guestsNow(state, chapterRules().realMsPerDay).slice(0, times);
      const costEach = cfg.basic.general?.draw_general_cost ?? 30;
      const added = [];
      if (here.length && (state.roleRes.gold || 0) >= costEach) {
        const affordable = Math.min(here.length, Math.floor((state.roleRes.gold || 0) / costEach));
        state.roleRes.gold -= costEach * affordable;
        for (const person of here.slice(0, affordable)) {
          person.recruited = true;
          const row = state.tavern.people.find((p) => p.cfgId === person.cfgId);
          if (row) row.recruited = true;
          const g = makeGeneral(cfg, nextId(state, 'generalId'), person.cfgId, mainCity(state)?.cityId ?? 1, 1);
          state.generals.push(g);
          added.push(g);
          ctx.push('general.push', g);
        }
        syncOwnedSkills(state);
        ctx.push('roleRes.push', roleResOf(state));
        ctx.save();
      }
      rsp.msg = { generals: clone(added) };
      break;
    }
    case 'general.composeGeneral': {
      const ids = (m.gIds || []).map(Number);
      state.generals = state.generals.filter((g) => !ids.includes(g.id));
      const g = makeGeneral(cfg, nextId(state, 'generalId'), Number(m.compId) || [...cfg.generalByCfg.keys()][0], mainCity(state)?.cityId ?? 1, 1);
      state.generals.push(g);
      syncOwnedSkills(state);
      ctx.save();
      rsp.msg = { generals: [clone(g)] };
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
      const gid = Number(m.generalId ?? 0);
      let army = state.armys.find((a) => a.cityId === cityId && a.order === order);
      if (!army) {
        // ★ 修复：新建队伍必须带完整字段，否则 army.generals[pos] 直接抛异常，
        //   该请求在网关层被吞掉（玩家点「配置武将」无反应），state.armys 还被污染。
        army = makeArmy(nextId(state, 'armyId'), cityId, order, [0, 0, 0], [0, 0, 0]);
        state.armys.push(army);
      }
      if (!Array.isArray(army.generals)) army.generals = [0, 0, 0];
      if (pos >= 0 && pos < 3) army.generals[pos] = gid;
      else {
        for (let i = 0; i < 3; i += 1) if (army.generals[i] === gid) army.generals[i] = 0;
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
      const cnts = (m.cnts || [0, 0, 0]).map((n) => Math.max(0, Number(n) || 0));
      const c = cfg.basic.conscript || {};
      let cost = 0;
      for (let i = 0; i < 3; i += 1) {
        cost += cnts[i] * ((c.cost_wood ?? 10) + (c.cost_iron ?? 10) + (c.cost_grain ?? 10) + (c.cost_gold ?? 1));
      }
      state.roleRes.wood = Math.max(0, state.roleRes.wood - cost);
      if (army) {
        for (let i = 0; i < 3; i += 1) {
          army.con_cnts[i] = cnts[i];
          army.con_times[i] = nowSec() + Math.max(1, (c.cost_time ?? 1) * cnts[i]);
        }
      }
      // 原版征兵需等待；单机下缩短到 2 秒，仍走同一 army.push 通道
      ctx.schedule(Date.now() + 2000, { type: 'conscript_done', armyId: Number(m.armyId), cnts });
      ctx.push('roleRes.push', roleResOf(state));
      ctx.push('army.push', army || {});
      ctx.save();
      rsp.msg = { army: clone(army || {}), role_res: roleResOf(state) };
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
        blueprints: [...(state.campaign?.blueprints || [])],
        spearmanId: state.campaign?.spearmanId ?? 0,
      };
      break;
    case 'campaign.choose': {
      const picked = m.option === 'lend' || m.option === 0 ? 'lend'
        : (m.option === 'refuse' || m.option === 1 ? 'refuse' : '');
      const result = chooseChapter(state, picked);
      if (!result.ok) rsp.code = CODE.InvalidParam;
      else ctx.save();
      rsp.msg = { choice: state.campaign?.choice ?? null, ok: result.ok };
      break;
    }
    case 'campaign.speed': {
      const scale = Number(m.scale) === 4 ? 4 : 1;
      state.clock.scale = scale;
      ctx.save();
      rsp.msg = { scale };
      break;
    }

    default:
      // 未知消息一律给空对象 + code 0，客户端不会 toast，也不会卡住请求队列
      ctx.log('warn', `unhandled message: ${name}`);
      rsp.msg = {};
  }

  // code 默认 0（OK）；玩法校验失败时按原版 constant/code.go 返回，客户端弹原版提示
  return { code: rsp.code ?? OK, msg: rsp.msg };
}
