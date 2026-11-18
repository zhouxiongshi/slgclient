/**
 * 诸侯势力武将名册（P16）—— 持久化的「人」层。
 *
 * 为什么需要它：
 *  - 审计事实（2026-11-16）：本版之前 AI 守将由 strategy.defenseFor 按
 *    `cityId+owner+level` 哈希**临时生成**（id=950000+…、exp:0、战法取模），
 *    战斗结束即弃。没有持久实体 → 「学战法 / 升级 / 招募 / 俘虏 / 挖墙脚」
 *    全部无处落地，玩家侧六项全有而 AI 侧为零。
 *  - 本模块给每个有地诸侯一份 `state.strategy.rosters[fid]`：
 *    `{ generals:[{cfgId,level,exp,skills,cityId,loyal}], captives:[] }`。
 *    开局按势力 startGenerals + 确定性池播种；每旬成长/招募/招降/挖角/求援；
 *    defenseFor 优先取名册武将，名册为空时仍走旧 hash 兜底（旧档兼容、确定性不变）。
 *
 * 纪律：
 *  - 零外部随机：所有掷骰走 rngFor(seed, turn, tag)，同参可回放；
 *  - 不 import strategy/world（避免环）：势力配置、武将表、名册全部由调用方注入 cfg/state；
 *  - 数值只动等级(1~10)/经验/忠诚/战法引用，五维原表逐字不碰；
 *  - 名册写在 state.strategy 内，随存档天然持久化。
 */

import { rngFor } from './strategy-rng.js';
import { applyGeneralExp } from './general-progress.js';
import { grantMerit, MERIT_GAIN, rankName } from './official-rank.js';
import { SKILLS } from '../skills.js';

const PROTAGONIST_ID = 880001;
/** 名册可学战法白名单：全部真实战法 cfgId（skills.js 已是只读叶子，无环）。 */
const ROSTER_SKILL_IDS = SKILLS.map((s) => Number(s.cfgId)).filter((id) => Number.isFinite(id) && id > 0);

/** 名册主结构：旧档缺字段时补空，不覆盖已有数据。 */
export function ensureRosters(state, conf, cfg) {
  if (!state.strategy) return {};
  const st = state.strategy;
  if (!st.rosters || typeof st.rosters !== 'object' || Array.isArray(st.rosters)) st.rosters = {};
  const factions = Array.isArray(conf?.factions) ? conf.factions : [];
  for (const f of factions) {
    if (!st.rosters[f.id] || typeof st.rosters[f.id] !== 'object') {
      st.rosters[f.id] = { generals: [], captives: [] };
    }
    const r = st.rosters[f.id];
    if (!Array.isArray(r.generals)) r.generals = [];
    if (!Array.isArray(r.captives)) r.captives = [];
    /* 开局播种：只在名册全空、且尚无战事（turn<=1）时做，避免旧档中途灌人。 */
    if (!r.generals.length && (st.turn || 0) <= 1) seedRoster(r, f, conf, cfg);
  }
  return st.rosters;
}

/** 势力开国名册：startGenerals 优先（按名字反查 cfgId），不足用确定性池补齐到 3 人。 */
function seedRoster(roster, faction, conf, cfg) {
  const byName = new Map();
  for (const g of (cfg?.generalByCfg?.values?.() || [])) {
    if (!byName.has(g.name)) byName.set(g.name, Number(g.cfgId));
  }
  const used = new Set();
  const add = (cfgId, level) => {
    const id = Number(cfgId);
    if (!id || id === PROTAGONIST_ID || used.has(id)) return;
    if (!cfg?.generalByCfg?.get(id)) return;
    used.add(id);
    roster.generals.push(makeOfficer(id, level, faction.homeCity || 0, skillsFor(id, level, cfg)));
  };
  /* ★ 平衡契约（P0-3「首战可胜」）：名册守将开局必须不强于旧 hash 守将
     （hash 的 1 级城 = 3 级 + 3 条战法）。故新名册一律 2 级 + 1 条 1 级战法，
     随战斗/学战法成长后才逐步变强，绝不抬高玩家第一仗难度。 */
  for (const name of faction.startGenerals || []) add(byName.get(String(name)), 2);
  /* 补足：从客户端可见池按 cfgId 排序取前几个，确定性；排除在野主角。 */
  if (roster.generals.length < 3) {
    const pool = [...(cfg?.generalByCfg?.values?.() || [])]
      .filter((g) => {
        const id = Number(g.cfgId);
        return cfg.clientGeneralIds ? cfg.clientGeneralIds.has(id) : (id > 100000 && id < 200000);
      })
      .sort((a, b) => Number(a.cfgId) - Number(b.cfgId));
    for (const g of pool) {
      if (roster.generals.length >= 3) break;
      add(g.cfgId, 2);
    }
  }
}

/** 造一个名册武将：等级/经验/忠诚/战法。忠诚 72~92，星级微调。 */
export function makeOfficer(cfgId, level, cityId, skills = []) {
  const lv = Math.max(1, Math.min(10, Math.trunc(Number(level) || 1)));
  return {
    cfgId: Number(cfgId),
    level: lv,
    exp: 0,
    merit: 0,                       // ★ 2026-11-16 功勋：名册武将按战功/守城/内政晋升官阶
    rank: 0,
    cityId: Number(cityId) || 0,
    loyal: 72 + (Number(cfgId) % 21),
    /* ★ BUG审计修复（2026-11-18）：玩家名册战法槽为 [skill, null, null]，
       挖角 t.obj.skills 直接透传时 null.id 抛 TypeError（60 旬系统审计崩溃）。
       过滤空槽后再映射，所有调用点受益。 */
    skills: Array.isArray(skills)
      ? skills.filter(Boolean).slice(0, 3).map((s) => ({ id: Number(s.id || s.cfgId), lv: Number(s.lv) || 1 }))
      : [],
  };
}

/** 开局自带 1~2 条战法：从 SKILLS 取合法 id（不写死 cfgId，白名单由调用方 cfg 提供）。 */
function skillsFor(cfgId, level, cfg) {
  const pool = ROSTER_SKILL_IDS;
  if (!pool.length) return [];
  /* 开局只带 1 条 1 级战法（弱于旧 hash 的 3 条），成长后再补；守 P0-3 首战可胜 */
  const out = [];
  const id = pool[(Math.abs(Number(cfgId)) * 7 + level * 3) % pool.length];
  if (id) out.push({ id, lv: 1 });
  return out;
}

/** defenseFor 用：取该势力驻守某城的名册武将（最多 3 人），转成既有守将对象形状。 */
export function rosterDefenders(state, cfg, owner, cityId, level, exclude = []) {
  const roster = state?.strategy?.rosters?.[owner];
  if (!roster || !Array.isArray(roster.generals) || !roster.generals.length) return [];
  const skip = new Set(exclude.map(Number));
  /* ★ 平衡契约（P0-3 首战可胜 / E2E 真实点击战报）：开局名册里是张飞/夏侯惇
     这类顶级武将，即便 2 级也远强于 hash 的末流守将。故只有**已成长**（≥3 级，
     即打过仗/攻过城积过功）的武将才顶替守城；未成长的开国名册留在「预备」，
     早期城池仍走原 hash 守军。成长后名册才逐步登场，挑战性随局势自然上升。 */
  const grown = roster.generals.filter((g) => (Number(g.level) || 1) >= 3);
  if (!grown.length) return [];
  const pool = grown
    .filter((g) => g && !skip.has(Number(g.cfgId)) && cfg?.generalByCfg?.get(Number(g.cfgId)))
    .filter((g) => !g.cityId || Number(g.cityId) === Number(cityId))
    .sort((a, b) => b.level - a.level || Number(a.cfgId) - Number(b.cfgId));
  const picked = pool.length ? pool : grown
    .filter((g) => g && !skip.has(Number(g.cfgId)) && cfg?.generalByCfg?.get(Number(g.cfgId)))
    .sort((a, b) => b.level - a.level || Number(a.cfgId) - Number(b.cfgId));
  const count = Math.max(1, Math.min(3, level >= 3 ? 3 : (level === 2 ? 2 : 1)));
  return picked.slice(0, count).map((g, k) => ({
    id: 950000 + Number(cityId) * 10 + k,
    cfgId: Number(g.cfgId),
    level: g.level,
    exp: g.exp || 0,
    merit: g.merit || 0,
    rank: g.rank || 0,
    cityId: 0,
    curArms: (k % 3) + 1, star: 3, physical_power: 100, order: 0,
    hasPrPoint: 0, usePrPoint: 0, attack_distance: 0,
    force_added: 0, strategy_added: 0, defense_added: 0,
    speed_added: 0, destroy_added: 0, star_lv: 0, parentId: 0,
    skills: (g.skills || []).slice(0, 3).map((s) => ({ id: Number(s.id), lv: Number(s.lv) || 1, cfgId: Number(s.id) })),
    state: 0,
  }));
}

/** 每旬名册成长：学战法 + 战斗经验结算入口。返回用于记日志的事件数组。 */
export function aiRosterLearnTick(state, conf, cfg, faction, turn) {
  const roster = state?.strategy?.rosters?.[faction.id];
  if (!roster?.generals?.length) return [];
  const axes = (conf?.personas?.[faction.persona] || null);
  const economy = axes?.economy ?? 0.5;
  const res = state.strategy.resources?.[faction.id];
  const notes = [];
  const skillIds = ROSTER_SKILL_IDS;
  for (const g of roster.generals) {
    // 5 级开学习槽（与玩家侧 general-progress 同口径）；最多 3 条；有金才学
    if (g.level < 5 || (g.skills || []).length >= 3 || !skillIds.length) continue;
    if ((res?.gold || 0) < 400) continue;
    const rng = rngFor(state.seed ?? 20261110, turn, `learn:${faction.id}:${g.cfgId}`);
    if (rng.random() > 0.25 + economy * 0.35) continue;
    const owned = new Set((g.skills || []).map((s) => Number(s.id)));
    const candidates = skillIds.filter((id) => !owned.has(id));
    if (!candidates.length) continue;
    const pick = candidates[Math.floor(rng.random() * candidates.length) % candidates.length];
    g.skills = [...(g.skills || []), { id: pick, lv: 1 }];
    res.gold = Math.max(0, (res.gold || 0) - 400);
    notes.push({ kind: '学战法', faction: faction.id, who: faction.name, cfgId: g.cfgId, skillId: pick });
  }
  return notes;
}

/** 给名册武将发经验（战斗胜利/攻城），返回升级列表。expMap: { cfgId: exp }。 */
export function aiRosterGrantExp(state, cfg, factionId, expMap = {}) {
  const roster = state?.strategy?.rosters?.[factionId];
  if (!roster?.generals?.length) return [];
  const ups = [];
  for (const g of roster.generals) {
    const add = Math.max(0, Math.trunc(Number(expMap[g.cfgId]) || 0));
    if (!add) continue;
    const r = applyGeneralExp(g, add);
    if (r.to > r.from) {
      ups.push({ cfgId: g.cfgId, name: cfg?.generalByCfg?.get?.(g.cfgId)?.name || `武将${g.cfgId}`, from: r.from, to: r.to });
    }
  }
  return ups;
}

/**
 * ★ 2026-11-16 诸侯「自己发展」：每旬给名册武将按功勋发经验并晋升官阶。
 * 原因：旧版 AI 武将经验只在攻城胜利时发，守城/内政/养兵都不长，玩家越打越强、
 * 诸侯原地踏步。这里让 AI 每旬按封地规模积累功勋（治政/守土本身即功），
 * 功勋按 official-rank 口径晋官；官阶再经 general-stat.effectiveStatOf 反哺统帅/政治，
 * 名册守将走出「立功→升官→更强」的闭环。全部确定性，无随机，不碰史载五维。
 */
export function aiRosterCultivateTick(state, conf, cfg, faction, turn) {
  const roster = state?.strategy?.rosters?.[faction.id];
  if (!roster?.generals?.length) return [];
  const st = state.strategy;
  const ownCities = Object.values(st.cities || {}).filter((c) => c.owner === faction.id);
  const cityCount = ownCities.length;
  const axes = conf?.personas?.[faction.persona] || {};
  const economy = axes.economy ?? 0.5;
  const notes = [];
  for (const g of roster.generals) {
    /* 治土功勋：城数越多、经济人格越高，治政积累越快；上限温和，避免一夜满级。 */
    const meritAdd = Math.round(2 + cityCount * 1.5 + economy * 3);
    const mr = grantMerit(g, meritAdd);
    /* 与功勋同步发经验：治政/练兵也算历练，但速率低于实战攻城（后者 60~150/次）。 */
    const expAdd = Math.round(4 + economy * 6 + cityCount);
    const up = applyGeneralExp(g, expAdd);
    if (mr.promoted || up.to > up.from) {
      const name = cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || `武将${g.cfgId}`;
      notes.push({
        kind: mr.promoted ? '升官' : '历练', faction: faction.id, cfgId: Number(g.cfgId),
        name, rank: g.rank, rankName: rankName(g.merit), from: up.from, to: up.to,
      });
    }
  }
  return notes;
}

/** 登庸在野武将入名册：玩家与 AI 共用 tavern.people，recruited 标记防重复。 */
export function aiRecruitTick(state, conf, cfg, faction, turn) {
  const roster = state?.strategy?.rosters?.[faction.id];
  if (!roster?.generals?.length) return null;
  if (roster.generals.length >= 8) return null; // 名册上限，避免无限膨胀
  const tavern = state.tavern;
  if (!tavern?.people?.length) return null;
  const res = state.strategy.resources?.[faction.id];
  if ((res?.gold || 0) < 1200) return null;
  const owned = new Set(roster.generals.map((g) => Number(g.cfgId)));
  const rng = rngFor(state.seed ?? 20261110, turn, `recruit:${faction.id}`);
  if (rng.random() > 0.30) return null;
  const pool = tavern.people.filter((p) => !p.recruited && !owned.has(Number(p.cfgId))
    && cfg?.generalByCfg?.get(Number(p.cfgId)));
  if (!pool.length) return null;
  const target = pool[Math.floor(rng.random() * pool.length) % pool.length];
  /* 登庸掷骰：政治/魅力人格上浮，失败不扣金；成功占额并标记 recruited。 */
  const axes = conf?.personas?.[faction.persona] || {};
  const rate = Math.min(0.8, 0.25 + (axes.economy ?? 0.5) * 0.35);
  if (rng.random() > rate) return { kind: '登庸未成', faction: faction.id, cfgId: Number(target.cfgId), name: target.name };
  res.gold = Math.max(0, (res.gold || 0) - 1200);
  target.recruited = true;
  roster.generals.push(makeOfficer(target.cfgId, 2, target.birthCity || 0, skillsFor(target.cfgId, 2, cfg)));
  return { kind: '登庸', faction: faction.id, who: faction.name, cfgId: Number(target.cfgId), name: target.name };
}

/** 挖墙脚：对他势力名册或玩家 state.generals 的低忠诚武将发起劝降。 */
export function aiPoachTick(state, conf, cfg, faction, turn) {
  const roster = state?.strategy?.rosters?.[faction.id];
  if (!roster?.generals?.length) return null;
  const axes = conf?.personas?.[faction.persona] || {};
  if ((axes.economy ?? 0.5) < 0.45) return null; // 好战短视者不挖人
  const res = state.strategy.resources?.[faction.id];
  if ((res?.gold || 0) < 1000) return null;
  const rng = rngFor(state.seed ?? 20261110, turn, `poach:${faction.id}`);
  if (rng.random() > 0.18 + (axes.tempo ?? 0.5) * 0.14) return null;

  const candidates = [];
  // 他势力名册
  for (const [fid, r] of Object.entries(state.strategy.rosters || {})) {
    if (fid === faction.id || !r?.generals) continue;
    for (const g of r.generals) {
      if ((g.loyal ?? 100) < 62) candidates.push({ src: 'roster', fid, obj: g });
    }
  }
  // 玩家武将
  for (const g of state.generals || []) {
    if ((g.loyal ?? 88) < 55) candidates.push({ src: 'player', obj: g });
  }
  if (!candidates.length) return null;
  const t = candidates[Math.floor(rng.random() * candidates.length) % candidates.length];
  const chance = Math.min(0.85, 0.30 + (100 - (t.obj.loyal ?? 60)) / 200);
  if (rng.random() > chance) {
    t.obj.loyal = Math.max(0, (t.obj.loyal ?? 60) - 4); // 挖不成也会动摇
    return { kind: '挖角未成', faction: faction.id, cfgId: Number(t.obj.cfgId) };
  }
  res.gold = Math.max(0, (res.gold || 0) - 1000);
  const cfgId = Number(t.obj.cfgId);
  if (t.src === 'roster') {
    const src = state.strategy.rosters[t.fid];
    const i = src.generals.indexOf(t.obj);
    if (i >= 0) src.generals.splice(i, 1);
  } else {
    const i = (state.generals || []).indexOf(t.obj);
    if (i >= 0) state.generals.splice(i, 1);
  }
  const officer = makeOfficer(cfgId, Math.max(2, Number(t.obj.level) || 2), 0, t.obj.skills || []);
  officer.loyal = 58; // 新投诚者忠诚偏低
  roster.generals.push(officer);
  return {
    kind: '挖角', faction: faction.id, who: faction.name, cfgId,
    name: cfg?.generalByCfg?.get?.(cfgId)?.name || `武将${cfgId}`,
    from: t.src === 'player' ? 'player' : t.fid,
  };
}

/** 求援判定：弱势力向盟友求援，返回可派援军的盟友列表（真正的派兵由 strategy 层做）。 */
export function aiAidRequest(state, conf, faction, turn, st) {
  const own = Object.keys(st.cities || {}).filter((id) => st.cities[id].owner === faction.id);
  if (!own.length || own.length > 2) return null;
  const troops = own.reduce((s, id) => s + (st.cities[id].troops || 0), 0);
  if (troops >= 2600) return null;
  const axes = conf?.personas?.[faction.persona] || {};
  if ((axes.defense ?? 0.5) < 0.45) return null; // 吕布之流不低头
  const rng = rngFor(state.seed ?? 20261110, turn, `aid:${faction.id}`);
  if (rng.random() > 0.35) return null;
  const friends = [];
  for (const f of conf.factions || []) {
    if (f.id === faction.id) continue;
    const rel = st.relations?.[`${faction.id}|${f.id}`];
    const fax = conf?.personas?.[f.persona] || {};
    if (rel === 'ally' || (fax.economy ?? 0.5) >= 0.7) friends.push(f.id);
  }
  if (!friends.length) return null;
  // 冷却：同一势力 6 旬内不求第二次
  state.strategy.rosterAidCooldown = state.strategy.rosterAidCooldown || {};
  const last = state.strategy.rosterAidCooldown[faction.id] || -999;
  if (turn - last < 6) return null;
  state.strategy.rosterAidCooldown[faction.id] = turn;
  return { faction: faction.id, who: faction.name, friends, cities: own.length, troops };
}

/** AI 攻城胜利后俘虏守城名册武将：按歼敌比确定性判定，入势力 captives。 */
export function aiCaptureTick(state, cfg, factionId, victimId, cityId, ratio, day) {
  const victim = state?.strategy?.rosters?.[victimId];
  const winner = state?.strategy?.rosters?.[factionId];
  if (!victim?.generals?.length || !winner) return [];
  const rng = rngFor(state.seed ?? 20261110, Math.max(1, Math.floor(day) || 1),
    `aiCapture:${factionId}:${victimId}:${cityId}`);
  if (rng.random() > 0.55 + 0.4 * Math.max(0, Math.min(1, ratio))) return [];
  const guards = victim.generals.filter((g) => !g.cityId || Number(g.cityId) === Number(cityId));
  const pool = (guards.length ? guards : victim.generals).slice();
  if (!pool.length) return [];
  const taken = pool[Math.floor(rng.random() * pool.length) % pool.length];
  const i = victim.generals.indexOf(taken);
  if (i >= 0) victim.generals.splice(i, 1);
  winner.captives.push({
    cfgId: Number(taken.cfgId),
    name: cfg?.generalByCfg?.get?.(Number(taken.cfgId))?.name || `武将${taken.cfgId}`,
    from: victimId, cityId: Number(cityId), loyal: Math.max(30, (taken.loyal ?? 60) - 15),
    days: 0, day: Math.floor(day) || 1,
  });
  return [{ cfgId: Number(taken.cfgId), from: victimId, cityId: Number(cityId) }];
}

/** 每旬俘虏处置：政治高者招降入名册，满 8 旬未降则释放。 */
export function aiCaptiveTick(state, conf, cfg, faction, turn) {
  const roster = state?.strategy?.rosters?.[faction.id];
  if (!roster?.captives?.length) return [];
  const axes = conf?.personas?.[faction.persona] || {};
  const notes = [];
  for (let i = roster.captives.length - 1; i >= 0; i -= 1) {
    const c = roster.captives[i];
    c.days = (c.days || 0) + 1;
    if (c.days >= 8) {
      roster.captives.splice(i, 1);
      notes.push({ kind: '释俘', faction: faction.id, cfgId: c.cfgId, name: c.name });
      continue;
    }
    const rng = rngFor(state.seed ?? 20261110, turn, `captive:${faction.id}:${c.cfgId}:${c.days}`);
    const rate = Math.min(0.85, 0.22 + (axes.economy ?? 0.5) * 0.35 + (100 - (c.loyal ?? 50)) / 400);
    if (rng.random() > rate) continue;
    roster.captives.splice(i, 1);
    const officer = makeOfficer(c.cfgId, 2, c.cityId || 0, skillsFor(c.cfgId, 2, cfg));
    officer.loyal = 55;
    roster.generals.push(officer);
    notes.push({ kind: '招降', faction: faction.id, who: faction.name, cfgId: c.cfgId, name: c.name });
  }
  return notes;
}
