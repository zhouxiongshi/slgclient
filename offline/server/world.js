/**
 * 单机世界状态 —— 等价于原 MySQL slgdb 中「一个玩家」的那部分数据。
 * 字段严格沿用原 Go proto 的 json tag，保证原客户端各 Proxy 直接可用。
 * 静态配置来自原工程 conf/，动态数据持久化到 save.json。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS, LEVEL_COUNT, skillById } from './skills.js';
import { ensureTavern } from './domain/tavern.js';
import { ensureFates } from './domain/fate.js';
import { ensureStrategy } from './domain/strategy.js';
import { ensurePanels } from './domain/panels.js';
import { loadOverrides, applyTileOverlay } from './gm/overrides.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HERO_SKILLS = existsSync(join(ROOT, 'conf', 'campaign', 'hero-skills.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'conf', 'campaign', 'hero-skills.json'), 'utf8'))
  : {};

function innateOf(cfg, cfgId) {
  const name = cfg.generalByCfg.get(cfgId)?.name;
  const id = name ? HERO_SKILLS[name] : 0;
  if (!id || !skillById(id)) return null;
  return { id, lv: 1, cfgId: id };
}

// v3：游戏日、军饷、序章标记。v1/v2 读档时补字段，不丢资源、城池、武将。
export const SAVE_VERSION = 3;

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
    skills: [innateOf(cfg, cfgId), null, null],
    talent: null,
    talentUnlocked: false,
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
  const over = loadOverrides();
  const picked = pickStart(cfg);
  const start = over.city && Number.isFinite(over.city.x) && Number.isFinite(over.city.y)
    ? { x: clamp(over.city.x, 0, cfg.width - 1), y: clamp(over.city.y, 0, cfg.height - 1) }
    : picked;
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
  if (over.city?.name) citys[0].name = over.city.name;

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

  const hero = makeGeneral(cfg, 1000, 880001, cityId, 1);
  hero.isProtagonist = true;
  // 开局只有穿越者自带的那一个战法（其余槽位靠剧本与酒馆补），这是既定设定，不改
  hero.skills = [{ id: 19001, lv: 1, cfgId: 19001 }, null, null];
  const generals = [hero];

  const armys = [];
  for (let i = 0; i < 3; i += 1) {
    const gids = i === 0 ? [hero.id, 0, 0] : [0, 0, 0];
    const soldiers = i === 0 ? [800, 0, 0] : [0, 0, 0];
    armys.push(makeArmy(2000 + i, cityId, i + 1, gids, soldiers));
  }

  // 原版 GetAndTryCreate：所有设施初始 0 级，由玩家逐个升级
  const facilities = (cfg.facility.list || []).map((f) => ({
    name: f.name,
    level: 0,
    type: f.type,
    up_time: 0,
  }));
  for (const extra of over.facilities || []) {
    const row = facilities.find((f) => f.type === extra.type);
    if (row && Number.isFinite(extra.level)) row.level = extra.level;
  }

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
    skills: [{ id: 19001, cfgId: 19001, generals: [hero.id] }],
    warReports: [],
    posTags: [],
    union: null,
    chat: [],
    roleAttr: { collectTimes: 0, lastCollectTime: 0, parentId: 0 },
    counters: { generalId: 1001, armyId: 2003, cityId: 2, warReportId: 1, unionId: 1 },
    pending: [],          // 行军 / 征兵 / 建筑升级等定时任务
    battleLog: [],        // 确定性内核的可复核记录
    clock: { day: 1, scale: 1, lastRealMs: Date.now(), accMs: 0 },
    drift: { score: 0, band: 'canon', log: [] },
    campaign: {
      id: 'chapter1', fired: {}, choice: null, waveFactor: null,
      blueprints: [], ending: null, spearmanId: 0,
      pendingDay: 0, lastPatrolDay: 0,
    },
    garrisons: [],
    chronicle: [],
  };
  state.skillVersion = 3;
  return state;
}

/** 序章以穿越者开局：没有主公（880001）的存档是改造前的旧档，不能直接续。 */
export function hasProtagonist(state) {
  return (state?.generals || []).some((g) => g.isProtagonist || g.cfgId === 880001);
}

export function loadWorld(savePath) {
  if (!existsSync(savePath)) return null;
  try {
    const data = JSON.parse(readFileSync(savePath, 'utf8'));
    if (!data || !data.role) return null;
    // v1 是旧战斗系统存档：保留资源/城池/武将，自动换成新战法体系
    // v2 没有游戏日和序章字段，读入后由 normalizeWorld 补上
    if (data.version !== 1 && data.version !== 2 && data.version !== SAVE_VERSION) return null;
    if (data.version === 1) assignInitialSkills(data);
    data.version = SAVE_VERSION;
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
    // ★ 旧存档用 level=0 标记「建造中」，客户端 npc.levels 只有 1~10，
    //   下发后地形详情面板会越界崩溃；统一纠正为合法等级并补 building 标记。
    if (!Number.isInteger(b.level) || b.level < 1 || b.level > 10) {
      b.level = Math.max(1, Math.min(10, Number(b.op_level) || 1));
    }
    if ((b.end_time || 0) > 0 && b.building === undefined) b.building = true;
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
  if (!state.roleAttr) state.roleAttr = {};
  if (!state.clock) state.clock = { day: 1, scale: 1, lastRealMs: Date.now(), accMs: 0 };
  if (!state.drift) state.drift = { score: 0, band: 'canon', log: [] };
  if (!state.campaign) {
    state.campaign = {
      id: 'chapter1', fired: {}, choice: null, waveFactor: null,
      blueprints: [], ending: null, spearmanId: 0,
    };
  }
  if (!state.garrisons) state.garrisons = [];
  if (!state.chronicle) state.chronicle = [];
  if (!state.chat) state.chat = [];
  if (!Array.isArray(state.warReports)) state.warReports = [];
  if (!state.counters) state.counters = {};
  // ★ 试玩 P1-2：旧档里的兵种槽可能是 [100, null, null]（NaN 序列化）。
  //   统一补成 3 个非负整数，客户端读 soldiers[1] 不再拿到 null。
  for (const a of state.armys || []) {
    for (const key of ['soldiers', 'con_times', 'con_cnts', 'generals']) {
      const list = Array.isArray(a[key]) ? a[key] : [];
      a[key] = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(list[i]) || 0)));
    }
  }
  // ★ 试玩 P0-4：结局后旧版本仍在按日写 campaign.fired（实测 day 276 有 267 个键）。
  //   这里剪掉过老的键，只保留第 1 天与最近 60 天；它们都在过去，不会被重新触发。
  if (state.campaign?.fired && typeof state.campaign.fired === 'object') {
    const keys = Object.keys(state.campaign.fired)
      .map((k) => Number(k)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (keys.length > 80) {
      const keep = new Set(['1', ...keys.slice(-60).map(String)]);
      for (const k of Object.keys(state.campaign.fired)) {
        if (!keep.has(k)) delete state.campaign.fired[k];
      }
    }
  }
  if (state.campaign && state.campaign.chapter == null) state.campaign.chapter = 1;
  for (const g of state.generals || []) {
    if (!Array.isArray(g.skills)) g.skills = [null, null, null];
    while (g.skills.length < 3) g.skills.push(null);
    if (g.isProtagonist || g.skills[0]) continue;
    const innate = innateOf(cfg, g.cfgId);
    if (!innate) continue;
    g.skills[0] = innate;
    if (!Array.isArray(state.skills)) state.skills = [];
    let row = state.skills.find((s) => s.cfgId === innate.cfgId);
    if (!row) {
      row = { id: innate.cfgId, cfgId: innate.cfgId, generals: [] };
      state.skills.push(row);
    }
    if (!row.generals.includes(g.id)) row.generals.push(g.id);
  }
  ensureTavern(state, cfg);
  ensureFates(state);
  ensureStrategy(state);
  ensurePanels(state, cfg);   // 六面板新字段兜底：11-08 之前无 strategy 的旧档也能开
  applyTileOverlay(state);
  state.version = SAVE_VERSION;
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
  // 仓库布局优先：offline/web（本分支自带的 web-desktop 逐字节副本）
  const inRepo = resolve(ROOT, 'web');
  if (existsSync(join(inRepo, 'index.html'))) return inRepo;
  // 旧开发布局：slg/runtime/client-src/build/web-desktop
  return resolve(ROOT, '..', 'runtime', 'client-src', 'build', 'web-desktop');
}
