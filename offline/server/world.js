/**
 * 单机世界状态 —— 等价于原 MySQL slgdb 中「一个玩家」的那部分数据。
 * 字段严格沿用原 Go proto 的 json tag，保证原客户端各 Proxy 直接可用。
 * 静态配置来自原工程 conf/，动态数据持久化到 save.json。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS, LEVEL_COUNT, skillById } from './skills.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// v2：换成 48 战法的新战斗系统（v1 存档读档时自动补技能，不丢资源/城池）
export const SAVE_VERSION = 2;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function makeRoleRes(cfg) {
  const r = cfg.basic.role || {};
  return {
    wood: r.wood ?? 10000,
    iron: r.iron ?? 10000,
    stone: r.stone ?? 10000,
    grain: r.grain ?? 10000,
    gold: r.gold ?? 10000,
    decree: r.decree ?? 20,
    wood_yield: r.wood_yield ?? 1000,
    iron_yield: r.iron_yield ?? 1000,
    stone_yield: r.stone_yield ?? 1000,
    grain_yield: r.grain_yield ?? 1000,
    gold_yield: r.gold_yield ?? 1000,
    depot_capacity: r.depot_capacity ?? 1000000,
  };
}

export function makeGeneral(cfg, id, cfgId, cityId, level = 10) {
  const g = cfg.generalByCfg.get(cfgId) || [...cfg.generalByCfg.values()][0] || { star: 5, arms: [1] };
  return {
    id,
    cfgId,
    physical_power: 100,
    order: 0,
    level,
    exp: 0,
    cityId,
    curArms: g.arms?.[0] ?? 1,
    hasPrPoint: 0,
    usePrPoint: 0,
    attack_distance: 0,
    force_added: 0,
    strategy_added: 0,
    defense_added: 0,
    speed_added: 0,
    destroy_added: 0,
    star_lv: 0,
    star: g.star ?? 5,
    parentId: 0,
    skills: [null, null, null],
    state: 0,
  };
}

/** 客户端 MapUIProxy.arrayToObject 期望的 17 元素武将数组。 */
export function generalToArray(g) {
  return [
    g.id, g.cfgId, g.physical_power, g.order, g.level, g.exp, g.cityId,
    g.curArms, g.hasPrPoint, g.attack_distance, g.force_added,
    g.strategy_added, g.defense_added, g.speed_added, g.destroy_added,
    g.star_lv, g.star,
  ];
}

export function makeArmy(id, cityId, order, generals, soldiers) {
  return {
    id,
    cityId,
    union_id: 0,
    order,
    generals: [...generals],
    soldiers: [...soldiers],
    con_times: [0, 0, 0],
    con_cnts: [0, 0, 0],
    cmd: 0,
    state: 1,
    from_x: 0,
    from_y: 0,
    to_x: 0,
    to_y: 0,
    start: 0,
    end: 0,
  };
}

export function makeCity(cfg, { cityId, rid, x, y, isMain = 1 }) {
  const durable = cfg.basic.city?.durable ?? 100000;
  return {
    cityId,
    rid,
    name: isMain ? '主城' : '分城',
    union_id: 0,
    union_name: '',
    parent_id: 0,
    x,
    y,
    is_main: isMain,
    level: 1,
    cur_durable: durable,
    max_durable: durable,
    occupy_time: Math.floor(Date.now() / 1000),
  };
}

export function makeBuild(cfg, { rid, x, y, type, level = 1 }) {
  const conf = cfg.confs.find((c) => c.type === type && c.level === level)
    || cfg.confs.find((c) => c.type === type)
    || { durable: 10000, defender: 1, name: '领地' };
  return {
    rid,
    RNick: '',
    name: conf.name || '领地',
    union_id: 0,
    union_name: '',
    parent_id: 0,
    x,
    y,
    type,
    level,
    op_level: level,
    // 产量字段（原版 MapRoleBuild.Init 从 map_build 配置填充，参与 GetYield 结算）
    wood: conf.wood ?? 0,
    iron: conf.iron ?? 0,
    stone: conf.stone ?? 0,
    grain: conf.grain ?? 0,
    curDurable: conf.durable,
    maxDurable: conf.durable,
    defender: conf.defender,
    occupy_time: Math.floor(Date.now() / 1000),
    end_time: 0,
    giveUp_time: 0,
  };
}

/** 在中心附近找一个与原来一致的空地格作为主城，保证可复现。 */
function pickStart(cfg) {
  const cx = Math.floor(cfg.width / 2);
  const cy = Math.floor(cfg.height / 2);
  for (let r = 0; r < 12; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= cfg.width || y >= cfg.height) continue;
        const [type] = cfg.tileAt(x, y);
        if (type >= 52 && type <= 55) return { x, y, type };
      }
    }
  }
  return { x: cx, y: cy, type: 55 };
}

/**
 * 新战斗系统：每个武将装配 3 个战法（主动输出 / 追击 / 指挥或被动），
 * 等级分布在 3~10，玩家技能列表按 cfgId 去重。
 */
export function defaultLoadout(i) {
  const byTrigger = (t) => SKILLS.filter((s) => s.trigger === t);
  const active = byTrigger(1);
  const chase = byTrigger(3);
  const command = byTrigger(4);
  const passive = byTrigger(2);
  const thirdPool = i % 2 === 0 ? command : passive;
  const picks = [
    active[i % active.length],
    chase[(i * 3) % chase.length],
    thirdPool[(i * 5) % thirdPool.length],
  ];
  const lvs = [6 + (i % 5), 3 + (i % 4), 4 + ((i * 2) % 6)];
  return picks.map((s, k) => ({ id: s.cfgId, lv: Math.min(LEVEL_COUNT, lvs[k]), cfgId: s.cfgId }));
}

export function assignInitialSkills(state) {
  const owned = new Map();
  state.generals.forEach((g, i) => {
    g.skills = defaultLoadout(i);
    for (const s of g.skills) {
      if (!owned.has(s.cfgId)) owned.set(s.cfgId, { id: s.cfgId, cfgId: s.cfgId, generals: [] });
      owned.get(s.cfgId).generals.push(g.id);
    }
  });
  state.skills = [...owned.values()];
  state.skillVersion = 2;
  return state;
}

export function createWorld(cfg, options = {}) {
  const start = pickStart(cfg);
  const uid = 1;
  const rid = 1;
  const cityId = 1;
  const role = {
    rid, uid,
    nickName: options.nickName || '主公',
    sex: options.sex ?? 1,
    sid: 1,
    balance: 0,
    headId: options.headId ?? 1,
    profile: '',
  };
  const roleRes = makeRoleRes(cfg);
  const citys = [makeCity(cfg, { cityId, rid, x: start.x, y: start.y, isMain: 1 })];

  // 主城周边若干己方领地，保持原有「进入游戏即有领地/建筑」的画面
  const builds = [];
  const offsets = [[-1, 0], [0, -1], [1, 0], [0, 1], [-1, -1], [1, 1]];
  for (const [dx, dy] of offsets) {
    const x = clamp(start.x + dx, 0, cfg.width - 1);
    const y = clamp(start.y + dy, 0, cfg.height - 1);
    const [type, level] = cfg.tileAt(x, y);
    if (type < 52 || type > 55) continue;
    builds.push(makeBuild(cfg, { rid, x, y, type, level: level || 1 }));
  }

  const heroCfgIds = [...cfg.generalByCfg.keys()].slice(0, 15);
  const generals = [];
  for (let i = 0; i < 9 && heroCfgIds.length; i += 1) {
    generals.push(makeGeneral(cfg, 1000 + i, heroCfgIds[i % heroCfgIds.length], cityId, 10));
  }

  const armys = [];
  for (let i = 0; i < 3; i += 1) {
    const gids = [0, 1, 2].map((k) => generals[(i * 3 + k) % generals.length]?.id ?? 0);
    // 原 proto.Army.Order 注释是「第几队，1-5队」；客户端
    // RightInfoNodeLogic.onUpdateArmy 用 _armys[order-1] 索引，必须 1..N
    armys.push(makeArmy(2000 + i, cityId, i + 1, gids, [1000, 1000, 1000]));
  }

  // 原版 GetAndTryCreate：所有设施初始 0 级，由玩家逐个升级
  const facilities = (cfg.facility.list || []).map((f) => ({
    name: f.name,
    level: 0,
    type: f.type,
    up_time: 0,
  }));

  const state = {
    version: SAVE_VERSION,
    createdAt: Date.now(),
    savedAt: Date.now(),
    account: { username: options.username || 'player', password: '', uid, session: 'offline-session' },
    role,
    roleRes,
    citys,
    builds,
    facilities: { [cityId]: facilities },
    generals,
    armys,
    skills: [],
    warReports: [],
    posTags: [],
    union: null,
    chat: [],
    roleAttr: { collectTimes: 0, lastCollectTime: 0, parentId: 0 },
    counters: { generalId: 1000 + generals.length, armyId: 2003, cityId: 2, warReportId: 1, unionId: 1 },
    pending: [],          // 行军 / 征兵 / 建筑升级等定时任务
    battleLog: [],        // 确定性内核的可复核记录
  };
  return assignInitialSkills(state);
}

export function loadWorld(savePath) {
  if (!existsSync(savePath)) return null;
  try {
    const data = JSON.parse(readFileSync(savePath, 'utf8'));
    if (!data || !data.role) return null;
    // v1 是旧战斗系统存档：保留资源/城池/武将，自动换成新战法体系
    if (data.version !== SAVE_VERSION && data.version !== 1) return null;
    data.version = SAVE_VERSION;
    if (data.skillVersion !== 2) assignInitialSkills(data);
    return data;
  } catch {
    return null;
  }
}

/**
 * 旧存档归一化（loadWorld 之后调用）：
 *  - 旧版建筑没有产量字段 / op_level 恒 0，按 map_build 配置补齐；
 *  - op_level=0 且无工期的非要塞建筑视为「空闲」，避免被误判成拆除中。
 */
export function normalizeWorld(state, cfg) {
  for (const b of state.builds || []) {
    const conf = cfg.confs.find((c) => c.type === b.type && c.level === b.level)
      || cfg.confs.find((c) => c.type === b.type);
    if (conf) {
      if (b.wood === undefined) b.wood = conf.wood ?? 0;
      if (b.iron === undefined) b.iron = conf.iron ?? 0;
      if (b.stone === undefined) b.stone = conf.stone ?? 0;
      if (b.grain === undefined) b.grain = conf.grain ?? 0;
    }
    if (!b.op_level && !b.end_time && b.type !== 56) b.op_level = b.level;
    if (b.end_time && b.op_level === undefined) b.op_level = 0;
  }
  if (!state.facilities) state.facilities = {};
  return state;
}

/** 原子写，避免崩溃时写坏存档。 */
export function saveWorld(savePath, state) {
  mkdirSync(dirname(savePath), { recursive: true });
  state.savedAt = Date.now();
  const tmp = `${savePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), 'utf8');
  renameSync(tmp, savePath);
  return true;
}

export function nextId(state, key) {
  const n = state.counters[key] ?? 1;
  state.counters[key] = n + 1;
  return n;
}

export function findGeneral(state, id) {
  return state.generals.find((g) => g.id === id) || null;
}

export function findArmy(state, id) {
  return state.armys.find((a) => a.id === id) || null;
}

export function findCity(state, id) {
  return state.citys.find((c) => c.cityId === id) || null;
}

export function mainCity(state) {
  return state.citys.find((c) => c.is_main === 1) || state.citys[0] || null;
}

export function resolveWebDir(explicit) {
  if (explicit) return resolve(explicit);
  // offline/ → slg/ → runtime/client-src/build/web-desktop
  return resolve(ROOT, '..', 'runtime', 'client-src', 'build', 'web-desktop');
}
