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
import { makeBuild, nextId, mainCity } from '../world.js';
import { rngFor } from './strategy-rng.js';
import { resolveBattle } from '../battle.js';
import { onTileCleared } from './campaign.js';
import { SKILLS, LEVEL_COUNT } from '../skills.js';

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
    resources: Object.fromEntries(conf.factions.map((f) => [f.id, { gold: 8000, grain: 12000 }])),
  };
  bindPlayerHome(state);
  return state.strategy;
}

/** 玩家本城：factions.json 的 playerHome（按城名解析），归属改为玩家。 */
export function bindPlayerHome(state) {
  const st = state.strategy;
  const conf = factionConf();
  const homeName = conf.playerHome || '相';
  const home = strategyMap().cities.find((c) => c.name === homeName);
  if (!home) return null;
  st.playerCity = home.id;
  st.cities[home.id].owner = 'player';
  return home;
}

export function neighborsOf(cityId) {
  const set = new Set();
  for (const r of strategyMap().routes) {
    if (r.from === cityId) set.add(r.to);
    if (r.to === cityId) set.add(r.from);
  }
  return [...set];
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
  return {
    turn: st.turn,
    season: '春秋', // 占位：季节细节等真模型接入时再细化
    seed: state.seed ?? 20261110,
    faction: factionId,
    own: {
      gold: res.gold, grain: res.grain, wood: 0, iron: 0,
      troops, cities: mine.length, mines: 0,
      heroes: [], front_pressure: 0,
    },
    cities: map.cities.map((c) => ({
      id: String(c.id), name: c.name, province: c.provinceId || '',
      is_capital: !!c.provinceCapital, owner: st.cities[c.id]?.owner || 'han',
      troops: st.cities[c.id]?.troops || 0,
      defense: st.cities[c.id]?.defense || 0.4,
      confidence: 1,
    })),
    mines: [],
    neighbors: Object.fromEntries([...neighbors.entries()].map(([k, v]) => [String(k), [...v].map(String)])),
    known_facts: [],
    visible_events: [],
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
  const turnDays = conf.turnDays ?? 10;
  if (state.clock.day - st.lastTurnDay < turnDays) return null;
  st.lastTurnDay = state.clock.day;
  st.turn += 1;

  const results = [];
  for (const f of conf.factions) {
    const snapshot = strategySnapshot(state, f.id);
    const sheet = state.brainRunner
      ? state.brainRunner(f, snapshot)
      : localBrain(f, snapshot, state);
    const applied = applyOrders(state, cfg, ctx, f, sheet);
    results.push({ faction: f.id, orders: sheet.strategy_orders?.length || 0, ...applied });
  }
  return { turn: st.turn, results };
}

/* ---------------------------------------------------------------- 决策脑
 * 与 slg-ai 同协议的首版实现：人格轴、确定性、难度档、IAUS 简化版。
 * 真 Python 模型接入后，把本函数替换为子进程桥即可（指令单结构不变）。
 */
const PERSONA_AXES = {
  曹操: { aggression: 0.65, economy: 0.60, risk: 0.50, tempo: 0.70, defense: 0.55 },
  袁绍: { aggression: 0.35, economy: 0.90, risk: 0.30, tempo: 0.25, defense: 0.65 },
  吕布: { aggression: 0.95, economy: 0.20, risk: 0.85, tempo: 0.90, defense: 0.20 },
  孙权: { aggression: 0.30, economy: 0.70, risk: 0.25, tempo: 0.35, defense: 0.90 },
  刘备: { aggression: 0.45, economy: 0.75, risk: 0.35, tempo: 0.45, defense: 0.60 },
  司马懿: { aggression: 0.55, economy: 0.65, risk: 0.20, tempo: 0.20, defense: 0.85 },
  董卓: { aggression: 0.80, economy: 0.25, risk: 0.75, tempo: 0.75, defense: 0.30 },
  公孙瓒: { aggression: 0.85, economy: 0.35, risk: 0.70, tempo: 0.95, defense: 0.35 },
};

function mistakeRate(difficulty) {
  return difficulty === 'easy' ? 0.2 : difficulty === 'hard' ? 0 : 0.06;
}

export function localBrain(faction, snapshot, state) {
  const conf = factionConf().factions.find((f) => f.id === faction.id) || faction;
  const axes = PERSONA_AXES[conf.persona] || PERSONA_AXES.曹操;
  const r = rngFor(state.seed ?? 20261110, snapshot.turn, `brain:${faction.id}`).random;
  const own = snapshot.own;
  const orders = [];

  // 内政：按经济轴征兵与屯田
  const conscript = Math.round(300 + axes.economy * 700);
  orders.push({
    id: `I${snapshot.turn}-1`, type: '征兵', target: faction.id,
    params: { count: conscript }, eta: 1, on_fail: '屯田',
    expect: '兵力补充', explain: [['经济轴', axes.economy]],
  });

  // 战略：IAUS 简化——对每个邻接敌城打分，只挑分最高的一条
  const candidates = [];
  for (const cid of Object.keys(snapshot.neighbors)) {
    const city = snapshot.cities.find((c) => c.id === cid);
    if (!city || city.owner === faction.id) continue;
    if (city.owner !== 'han' && snapshot.relations[city.owner] === 'ally') continue;
    const isNeighbor = snapshot.neighbors[cid]?.some((nid) => {
      const n = snapshot.cities.find((c) => c.id === nid);
      return n && n.owner === faction.id;
    });
    if (!isNeighbor) continue;
    const garrison = snapshot.cities.find((c) => c.id === cid);
    const score = (1 - garrison.defense) * axes.aggression
      + (1 / (1 + garrison.troops / 3000)) * 0.5
      - (axes.defense * 0.3);
    candidates.push({ city: garrison, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const mistakes = mistakeRate('normal');
  const pick = (r() < mistakes && candidates.length > 1) ? candidates[1] : top;
  if (pick && own.troops > 4000) {
    orders.push({
      id: `S${snapshot.turn}-1`, type: '出征', target: pick.city.id,
      params: { troops: Math.min(own.troops - 2000, Math.round(own.troops * 0.4)) },
      eta: 2, on_fail: '撤退',
      expect: '取城', explain: [['目标城防', Math.round(1 - pick.city.defense, 3)]],
    });
  }

  // 外交：低侵略者更倾向议和/结盟
  if (r() < 0.3 && axes.aggression < 0.6) {
    const others = factionConf().factions.filter((f) => f.id !== faction.id);
    const other = others[Math.floor(r() * others.length)];
    orders.push({
      id: `S${snapshot.turn}-2`, type: '结盟', target: other.id,
      params: {}, eta: 0, on_fail: '维持现状',
      expect: '北境无虞', explain: [['侵略轴低', axes.aggression]],
    });
  }

  return {
    protocol: 'slg-ai-orders-v1',
    turn: snapshot.turn, season: snapshot.season,
    faction: faction.id, personality: conf.persona,
    difficulty: 'normal', seed: snapshot.seed,
    goal: { type: own.troops > 6000 ? '扩张' : '固守', target: '', locked_until: snapshot.turn + 3, reason: ['首版本地脑'] },
    internal_orders: orders.filter((o) => o.id.startsWith('I')),
    strategy_orders: orders.filter((o) => o.id.startsWith('S')),
    explain: [['首版本地决策脑', 1]],
  };
}

/* ---------------------------------------------------------------- 执行层 */
/** 天下大事记。保留整局 200 条（旧实现 50 条滚动截断，读档后本局早先的转折全没了）。 */
function recordEvent(state, text) {
  const st = state.strategy;
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 200) st.events.shift();
}

export function applyOrders(state, cfg, ctx, faction, sheet) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const applied = { moved: [], captured: [], attacked_player: 0 };
  const r = rngFor(state.seed ?? 20261110, st.turn, `apply:${faction.id}`).random;

  for (const order of [...(sheet.internal_orders || []), ...(sheet.strategy_orders || [])]) {
    if (order.type === '征兵') {
      const res = st.resources[faction.id] || (st.resources[faction.id] = { gold: 8000, grain: 12000 });
      const count = Math.max(0, Number(order.params?.count) || 0);
      const cost = count * 2;
      if (res.grain >= cost) {
        res.grain -= cost;
        const own = Object.keys(st.cities).filter((id) => st.cities[id].owner === faction.id);
        if (own.length) {
          const home = own[0];
          st.cities[home].troops += count;
        }
      }
    } else if (order.type === '屯田') {
      const res = st.resources[faction.id];
      if (res) res.grain += 400;
    } else if (order.type === '出征') {
      const targetId = Number(order.target);
      const target = map.cities.find((c) => c.id === targetId);
      const tstate = st.cities[targetId];
      if (!target || !tstate) continue;
      const troops = Math.max(1, Number(order.params?.troops) || 0);
      if (tstate.owner === faction.id) continue;
      if (tstate.owner === state.role?.rid || tstate.owner === 'player') {
        // 打玩家的城：换算成本地地图来犯军，走既有战报
        spawnFactionAssault(state, cfg, ctx, faction, target, troops);
        applied.attacked_player += 1;
        continue;
      }
      const defender = st.cities[targetId];
      const prevOwner = defender.owner;
      const atk = troops * (0.8 + r() * 0.4);
      const def = defender.troops * (1 + defender.defense);
      if (atk > def) {
        defender.owner = faction.id;
        defender.troops = Math.max(300, Math.round(garrisonOf(target) * 0.35));
        applied.captured.push(target.name);
        // ★ P1-7：写清「从谁手里夺的」，避免同一回合两条攻陷信都像凭空发生
        recordEvent(state, `${faction.name}自${ownerNameOf(state, prevOwner)}手中攻陷${target.name}（${target.province}）`);
        ctx.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg: `【天下】${faction.name}自${ownerNameOf(state, prevOwner)}手中攻陷${target.name}。`, time: Date.now() });
      } else {
        defender.troops = Math.max(200, Math.round(defender.troops * 0.85));
        recordEvent(state, `${faction.name}攻${target.name}不利，折兵退走（守军尚存 ${defender.troops}）。`);
      }
    } else if (order.type === '结盟' || order.type === '议和') {
      const other = String(order.target);
      st.relations[`${faction.id}|${other}`] = 'ally';
      st.relations[`${other}|${faction.id}`] = 'ally';
      recordEvent(state, `${faction.name}与${otherName(state, other)}结好。`);
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

/** 诸侯来犯玩家的城：在本地地图上出现一支来犯军，兵力按战略层折算。 */
function spawnFactionAssault(state, cfg, ctx, faction, targetCity, troops) {
  const city = mainCity(state);
  if (!city) return;
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

/** 选出征队伍：优先指定 armyId，否则挑兵力最多的那支（界面只传城时也能打）。 */
function pickArmy(state, armyId) {
  const list = state.armys || [];
  if (armyId) return list.find((a) => a.id === Number(armyId)) || null;
  let best = null;
  let bestN = 0;
  for (const a of list) {
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
function settleArmyBattle(state, cfg, ctx, { army, frac, x, y, defenseOverride }) {
  const before = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army.soldiers?.[i]) || 0)));
  const f = Math.min(1, Math.max(0.05, Number(frac) || 1));
  const commit = before.map((v) => Math.max(0, Math.round(v * f)));
  if (commit.reduce((s, n) => s + n, 0) <= 0) return { ok: false, reason: 'no_troops' };
  const battleArmy = { ...army, soldiers: commit };
  const result = resolveBattle({ cfg, state, army: battleArmy, x, y, defenseOverride });
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
  const summary = win
    ? `攻陷${place}：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}。`
    : `攻${place}不利：我军 ${aTotal} 对守军 ${dTotal}，折损 ${aLoss}，歼敌 ${dLoss}`
      + (rec > 0 ? `，溃兵 ${rec} 归营。` : '。');
  // 额外字段：原客户端忽略，我们自己的战报面板读它做复盘
  result.report.summary = summary;
  result.report.analysis = {
    aTotal, dTotal, aLoss, dLoss, recovered: rec, win,
    aBegin: commit, aRemain: remain,
  };

  state.warReports.unshift(result.report);
  if (state.warReports.length > 100) state.warReports.length = 100;

  ctx.push?.('army.push', army);
  for (const gid of army.generals || []) {
    const g = state.generals?.find((x2) => x2.id === gid);
    if (g) ctx.push?.('general.push', g);
  }
  ctx.push?.('warReport.push', result.report);
  ctx.push?.('roleRes.push', { ...state.roleRes });

  return {
    ok: true, result: result.report.result, report: result.report,
    summary, aTotal, dTotal, recovered: rec, win,
  };
}

/** 战略层城战：从玩家本城出兵打一座邻接城，走真实内核，胜则城池易主。
 *  frac：出兵比例（1 全军 / 0.5 半军 / 0.34 三成）。 */
export function strategyAttack(state, cfg, ctx, { cityId, armyId, frac = 1 }) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const home = st.playerCity;
  const id = Number(cityId);
  const target = map.cities.find((c) => c.id === id);
  const tstate = st.cities[id];
  if (!target || !tstate) return { ok: false, code: 1, reason: 'no_city' };
  if (tstate.owner === 'player') return { ok: false, code: 2, reason: 'own_city' };
  if (!neighborsOf(home).includes(id)) return { ok: false, code: 3, reason: 'not_adjacent' };
  // ★ P0-3：界面只传 cityId，旧实现固定取 armys[0]，而那支可能正好是空队
  const army = pickArmy(state, armyId);
  if (!army) return { ok: false, code: 4, reason: 'no_army' };
  if ((army.generals || []).every((g) => !g)) return { ok: false, code: 4, reason: 'no_general' };
  if ((army.soldiers || []).every((n) => !(n > 0))) return { ok: false, code: 4, reason: 'no_troops' };

  const level = Math.max(1, Math.min(3, target.level || 1));
  const defenseOverride = defenseFor(cfg, id, target, tstate, level);
  const fought = settleArmyBattle(state, cfg, ctx, {
    army, frac, x: 8000 + id, y: 100 + level, defenseOverride,
  });
  if (!fought.ok) return { ok: false, code: 4, reason: fought.reason };

  const win = fought.result === 2;
  if (win) {
    tstate.owner = 'player';
    tstate.troops = Math.max(200, Math.round(defenseOverride.soldiers.reduce((s, n) => s + n, 0) * 0.3));
    recordEvent(state, `主公攻陷${target.name}（${target.province}），守军 ${fought.dTotal} 溃散。`);
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
  return {
    ok: true, result: fought.result, reportId: fought.report.id, city: target.name,
    summary: fought.summary, aTotal: fought.aTotal, dTotal: fought.dTotal,
    recovered: fought.recovered,
  };
}

/** 清剿来犯军：本地地图被遮住后，玩家在天下界面也能看到并处理威胁。 */
export function clearThreat(state, cfg, ctx, { garrisonId, armyId }) {
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

/** 供 /__slg/strategy/state 使用。cfg 可选：不给时武将只显示 #id。 */
export function strategyViewState(state, cfg = null) {
  const st = ensureStrategy(state);
  const map = strategyMap();
  const conf = factionConf();
  const nameOf = (id) => conf.factions.find((f) => f.id === id)?.name
    || (id === conf.neutral.id ? conf.neutral.name : id);
  const colorOf = (id) => conf.factions.find((f) => f.id === id)?.color
    || conf.neutral.color;
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
    armies: (state.armys || []).map((a) => ({
      id: a.id,
      order: a.order,
      soldiers: [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(a.soldiers?.[i]) || 0))),
      generals: (a.generals || []).map((gid) => {
        const g = (state.generals || []).find((x) => x.id === gid);
        if (!g) return null;
        return { id: g.id, name: cfg?.generalByCfg?.get(g.cfgId)?.name || `武将${g.id}` };
      }),
    })),
    cities: map.cities.map((c) => ({
      id: c.id, name: c.name, province: c.province, provinceId: c.provinceId,
      x: c.x, y: c.y, level: c.level, levelName: c.levelName || '', adminLevel: c.adminLevel || '',
      terrain: c.terrain || '', specialty: c.attrs?.特产 || '',
      arms: c.attrs?.主要兵种 || '',
      population: c.population || 0,
      agri: c.attrs?.农业 ?? 0, commerce: c.attrs?.商业 ?? 0,
      cityDef: c.attrs?.城防 ?? 0,
      history: (c.history || '').slice(0, 160),
      owner: st.cities[c.id]?.owner || 'han',
      ownerName: nameOf(st.cities[c.id]?.owner || 'han'),
      color: colorOf(st.cities[c.id]?.owner || 'han'),
      troops: st.cities[c.id]?.troops || 0,
    })),
    playerCity: st.playerCity || 0,
    routes: map.routes.map((r) => ({ id: r.id, from: r.from, to: r.to, points: r.points, sea: r.sea })),
    factions: conf.factions.map((f) => ({ id: f.id, name: f.name, color: f.color })),
    neutral: { id: conf.neutral.id, name: conf.neutral.name, color: conf.neutral.color },
    events: [...st.events].slice(-40).reverse()
      .map((e) => ({ ...e, month: (e.turn || 0) + 1 })),
  };
}
