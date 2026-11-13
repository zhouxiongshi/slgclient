/**
 * ★ 新战斗系统结算核心 ★
 *
 * 原 slg 的不完善战斗（攻防差值绝对值公式、随机先手、策略/速度不参与、
 * 4 个技能 10 级数值全同）已整体废弃：
 * 本文件不再引用原 Go 战斗公式，也不再引用原占位技能表。
 *
 * 现在的链路：
 *   武将装备的战法(cfgId + lv) → conf/skills.json 的真实数值
 *   → battle-core 确定性内核（指挥/被动/主动/追击 + 伤害/治疗/控制/增减益）
 *   → 翻译成原 proto.WarReport.rounds（c_id/lv/i_e/e_v/e_r/kill 全部来自新技能表）
 *   → 原 WarReportDesItemLogic 照常渲染，UI 一行未改
 *
 * 数值来源：battle-kit battle_config.json（796 战法名 / 83 伤害率 / 58 组等级插值 / 188 效果术语）。
 */
import { runBattle, DEFAULT_BATTLE_CONFIG, crc32Utf8 } from '../kernel/index.js';
import { generalToArray, findGeneral, nextId } from './world.js';
import { kernelSkillAt, reportSkillFields, SKILLS, LEVEL_COUNT, attackDistanceOf } from './skills.js';

/** 真实兵力 → 内核兵力 1:1（配合下面的 troop_factor 微调）。
 *  原先用 10 会把 1000 兵压成 100 兵，1 回合就打完；实测 1:1 + troop_factor=0.2
 *  时一场战斗平均 2.2 回合 / 59 事件 / 约 22 条战报 hit，四类战法能完整展开。 */
export const TROOP_SCALE = 1;

/** 内核配置快照：battle-kit 原数值 + corrected 减伤方向修正。 */
let _cfg = null;
export function battleConfig() {
  if (!_cfg) {
    _cfg = structuredClone(DEFAULT_BATTLE_CONFIG);
    _cfg.defense_model = 'corrected';
    // 原包 troop_factor=1 时单场战斗 1 回合就结束，四类战法与治疗/控制来不及展开；
    // 按用户授权的「不合适再做微调」下调（实测见 TROOP_SCALE 注释）。
    _cfg.troop_factor = 0.2;
  }
  return _cfg;
}

/** 武将装备槽 → 内核 Skill[]；没有装备时按 heroid 稳定分配 3 个战法（守军/异常兜底）。 */
function loadoutFor(g) {
  const equipped = (g.skills || [])
    .filter((s) => s && s.cfgId && kernelSkillAt(s.cfgId, s.lv))
    .map((s) => kernelSkillAt(s.cfgId, s.lv || 1));
  if (equipped.length > 0) return equipped;
  if (Array.isArray(g.skills)) return [];
  const seed = Number(g.id) || 1;
  return [0, 1, 2].map((k) => {
    const s = SKILLS[(seed * 7 + k * 13) % SKILLS.length];
    const lv = Math.max(1, Math.min(LEVEL_COUNT, (g.level || 1) + k));
    return kernelSkillAt(s.cfgId, lv);
  });
}

/** 把原 general.json 的武将属性映射成内核 Hero（属性数值直接来源于原配置）。 */
function makeHero(g, cfg) {
  /* ★ M2-3 代将（GDD §3.4）：五维 50、无战法、不可培养——防止连环阵亡后无法出征的兜底 */
  if (g.isStandIn) {
    return {
      heroid: g.id, name: g.name || '代将', level: g.level || 1,
      hero_type: 'normal', hit_range: 1, country: '', quality: 1,
      attack_base: 50, defence_base: 50, intel_base: 50, speed_base: 50, destroy_base: 50,
      attack_grow: 3, defence_grow: 3, intel_grow: 3, speed_grow: 3, destroy_grow: 3,
      skills: [],
    };
  }
  const gc = cfg.generalByCfg.get(g.cfgId) || {
    name: `武将${g.cfgId}`, force: 8000, strategy: 8000, defense: 8000,
    speed: 7000, destroy: 2000, force_grow: 30, strategy_grow: 30,
    defense_grow: 30, speed_grow: 30, destroy_grow: 20, arms: [1],
  };
  const attr = (base, grow) => ({
    base: Math.round((base ?? 8000) / 100),
    grow: Math.round(((grow ?? 30) / 100) * 10) / 10,
  });
  const a = attr(gc.force, gc.force_grow);
  const d = attr(gc.defense, gc.defense_grow);
  const i = attr(gc.strategy, gc.strategy_grow);
  const s = attr(gc.speed, gc.speed_grow);
  const de = attr(gc.destroy, gc.destroy_grow);

  return {
    heroid: g.id,
    name: gc.name || `武将${g.cfgId}`,
    level: g.level || 10,
    hero_type: ['normal', 'armor', 'chain'][(g.curArms || 1) % 3],
    hit_range: 1,
    country: '',
    quality: g.star ?? 5,
    attack_base: a.base,
    defence_base: d.base,
    intel_base: i.base,
    speed_base: s.base,
    destroy_base: de.base,
    attack_grow: a.grow,
    defence_grow: d.grow,
    intel_grow: i.grow,
    speed_grow: s.grow,
    destroy_grow: de.grow,
    skills: loadoutFor(g),       // ★ 战法数值进入内核的唯一入口
  };
}

function makeUnit(unitId, side, general, cfg, troops, pos = 0) {
  return {
    unit_id: unitId,
    side,
    /* ★ P6 战位：0=前锋 1=中军 2=大营，战法射程按此结算 */
    pos: Number(pos) || 0,
    hero: makeHero(general, cfg),
    troops: Math.max(1, Math.ceil(troops / TROOP_SCALE)),
    max_troops: Math.max(1, Math.ceil(troops / TROOP_SCALE)),
    speed: general.curArms ? 100 + general.curArms : 100,
    /* ★ P7 普攻攻击距离：武将自己填了 attack_distance 就用它，否则按兵种（盾3/弓4/骑3）。
       大营里的短手武将打不到人，只有战法能越排——站位因此有取舍。 */
    attack_range: attackDistanceOf(general, general.curArms),
  };
}

/** 依据地图格等级构造系统守军；守军同样装备新战法（等级随地块等级）。
 *  override：战略层城战时由外部给定守军（武将/兵力/名号），跳过地块查表。 */
export function makeDefenders(cfg, state, x, y, override = null) {
  if (override) {
    return {
      generals: override.generals,
      soldiers: [...override.soldiers],
      level: override.level || 1,
      name: override.name || '守军',
      place: override.place || null,
    };
  }
  const [, level] = cfg.tileAt(x, y);
  const tier = cfg.npcArmy.armys?.[Math.max(0, (level || 1) - 1)] || cfg.npcArmy.armys?.[0];
  const layout = tier?.army?.[0] || { lvs: [1, 1, 1], cfgIds: [100002, 100003, 100004] };
  const garrison = (state.garrisons || []).find((g) => g.x === x && g.y === y && !g.cleared);
  const soldierCount = garrison?.soldiers ?? tier?.soldiers ?? 1000;
  const ids = [910001, 910002, 910003];
  return {
    generals: layout.cfgIds.slice(0, 3).map((cfgId, k) => ({
      id: ids[k],
      cfgId,
      level: Math.max(1, layout.lvs?.[k] ?? 1),
      curArms: (k % 3) + 1,
      star: 3,
      physical_power: 100, order: 0, exp: 0, cityId: 0,
      hasPrPoint: 0, usePrPoint: 0, attack_distance: 0,
      force_added: 0, strategy_added: 0, defense_added: 0,
      speed_added: 0, destroy_added: 0, star_lv: 0, parentId: 0,
      skills: [0, 1, 2].map((j) => {
        const sk = SKILLS[((level || 1) * 7 + k * 11 + j * 13) % SKILLS.length];
        return { id: sk.cfgId, lv: Math.max(1, Math.min(LEVEL_COUNT, (level || 1) + j)), cfgId: sk.cfgId };
      }),
      state: 0,
    })),
    soldiers: [soldierCount, soldierCount, soldierCount],
    level: level || 1,
  };
}

/**
 * 把内核事件流翻译成原版 rounds/hit/skillHit 结构。
 * 技能字段全部来自 conf/skills.json 对应等级，不再写死 101/201/301/401 / lv10。
 */
export function kernelEventsToRounds(result, idMap, skillLookup) {
  const byRound = new Map();
  for (const ev of result.events) {
    if (!byRound.has(ev.round)) byRound.set(ev.round, []);
    byRound.get(ev.round).push(ev);
  }
  const firstEnemyOf = (actor) => {
    const isAttacker = String(actor).startsWith('a');
    const ids = Object.entries(idMap).filter(([k]) => k.startsWith(isAttacker ? 'd' : 'a'));
    return ids.length ? Number(ids[0][1]) : 0;
  };

  const rounds = [];
  for (let r = 1; r <= Math.max(1, result.rounds); r += 1) {
    const evs = byRound.get(r) || [];
    const damageByActor = new Map();
    for (const ev of evs) {
      if (ev.kind !== 'damage') continue;
      if (!damageByActor.has(ev.actor)) damageByActor.set(ev.actor, []);
      damageByActor.get(ev.actor).push({
        skill: String(ev.payload.skill ?? ''),
        target: ev.payload.target,
        applied: Number(ev.payload.applied ?? ev.payload.calc?.final ?? 0),
      });
    }

    // 原版语义：一条 hit = 该武将本回合的一次攻击动作，
    // 攻击前/后/受击后技能挂在 a_bs / a_as / d_as，技能伤害累加进 d_loss。
    // 不把无伤害的增益/控制战法单独做成 hit，否则原 UI 会显示「损失 0 士兵」。
    const b = [];
    const hitsByActor = new Map();
    const mkHit = (actor, target, loss) => ({
      a_id: idMap[actor] ?? 0, d_id: target, d_loss: loss,
      a_bs: [], a_as: [], d_as: [],
    });
    for (const ev of evs) {
      if (ev.kind !== 'damage' || String(ev.payload.skill ?? '') !== '普通攻击') continue;
      const loss = Math.max(0, Math.round((ev.payload.applied ?? 0) * TROOP_SCALE));
      const hit = hitsByActor.get(ev.actor);
      if (hit) hit.d_loss += loss;
      else {
        const created = mkHit(ev.actor, idMap[ev.payload.target] ?? 0, loss);
        hitsByActor.set(ev.actor, created);
        b.push(created);
      }
    }

    for (const se of evs) {
      if (se.kind !== 'skill_trigger' && se.kind !== 'skill_prepare') continue;
      const info = skillLookup[se.actor]?.get(String(se.payload.skill ?? ''));
      if (!info) continue;
      const dmgs = (damageByActor.get(se.actor) || []).filter((d) => d.skill === se.payload.skill);
      const t_id = [];
      const kill = [];
      for (const d of dmgs) {
        t_id.push(idMap[d.target] ?? 0);
        kill.push(Math.max(0, Math.round(d.applied * TROOP_SCALE)));
      }
      if (t_id.length === 0) { t_id.push(firstEnemyOf(se.actor)); kill.push(0); }
      const loss = kill.reduce((s, n) => s + n, 0);
      const skillHit = {
        f_id: idMap[se.actor] ?? 0,
        t_id,
        c_id: info.cfgId,
        lv: info.lv,
        i_e: [...info.i_e],
        e_v: [...info.e_v],
        e_r: [...info.e_r],
        kill,
      };
      let hit = hitsByActor.get(se.actor);
      if (!hit) {
        hit = mkHit(se.actor, t_id[0], 0);
        hitsByActor.set(se.actor, hit);
        b.push(hit);
      }
      hit.d_loss += loss;
      if (String(se.actor).startsWith('d')) hit.d_as.push(skillHit);
      else if (info.class === '追击' || info.class === '被动') hit.a_as.push(skillHit);
      else hit.a_bs.push(skillHit);
    }
    if (b.length > 0) rounds.push({ b });
  }
  if (rounds.length === 0) rounds.push({ b: [{ a_id: 0, d_id: 0, d_loss: 0 }] });
  return rounds;
}

function armySnapshot(army, soldiers) {
  return { ...army, soldiers: [...soldiers] };
}

/** 把内核事件流编排成可播放的动画脚本（随战报推送，客户端覆盖层负责演出）。
 *  attackers 为 [{slot, g}]：slot 是队伍里的兵种槽（0~2），动画里的 unit 序号
 *  仍是内核的数组下标，两者不能混用（槽位可能有空将）。 */
export function buildBattleAnim({ kernel, attackers, defense, army, beginSoldiers, state, cfg, x, y, resultCode, attackRemain, defenseRemain }) {
  const byRound = new Map();
  for (const ev of kernel.events) {
    if (!byRound.has(ev.round)) byRound.set(ev.round, []);
    byRound.get(ev.round).push(ev);
  }
  const unitOf = (uid) => ({ s: uid[0], i: Number(uid.slice(1)) });
  const nameA = state.role?.nickName || '我军';
  const garrison = (state.garrisons || []).find((g) => g.x === x && g.y === y && !g.cleared);
  const nameD = defense.name || garrison?.name || '守军';
  const place = defense.place || garrison?.name || `(${x},${y})`;
  const rounds = [];
  for (const [round, evs] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    const acts = [];
    const skillLoss = new Map();
    for (const ev of evs) {
      if (ev.kind !== 'damage') continue;
      const key = `${ev.actor}|${String(ev.payload.skill ?? '')}`;
      skillLoss.set(key, (skillLoss.get(key) || 0)
        + Math.max(0, Math.round((ev.payload.applied ?? 0) * TROOP_SCALE)));
    }
    for (const ev of evs) {
      const p = ev.payload || {};
      if (ev.kind === 'skill_prepare') {
        acts.push({ t: 'prepare', f: unitOf(ev.actor), skill: String(p.skill ?? '') });
      } else if (ev.kind === 'skill_trigger') {
        acts.push({
          t: 'skill', f: unitOf(ev.actor), skill: String(p.skill ?? ''),
          loss: skillLoss.get(`${ev.actor}|${String(p.skill ?? '')}`) || 0,
        });
      } else if (ev.kind === 'damage') {
        acts.push({
          t: 'hit', f: unitOf(ev.actor), to: unitOf(p.target ?? 'a0'),
          loss: Math.max(0, Math.round((p.applied ?? 0) * TROOP_SCALE)),
          skill: String(p.skill ?? '普通攻击'),
        });
      } else if (ev.kind === 'control') {
        acts.push({ t: 'control', f: unitOf(ev.actor), to: unitOf(p.target ?? 'a0'), state: String(p.state ?? '') });
      } else if (ev.kind === 'heal') {
        acts.push({ t: 'heal', f: unitOf(ev.actor), to: unitOf(p.target ?? 'a0'), amount: Number(p.applied ?? p.amount ?? 0) * TROOP_SCALE });
      } else if (ev.kind === 'unit_down') {
        acts.push({ t: 'down', unit: unitOf(p.unit ?? 'a0') });
      }
    }
    if (acts.length) rounds.push({ round, acts });
  }
  return {
    id: state.battleLog.length + 1,
    x, y,
    place,
    winner: resultCode,
    a: {
      name: nameA,
      units: attackers.map(({ slot, g }, i) => ({
        slot: i,
        armySlot: slot,
        name: cfg.generalByCfg.get(g.cfgId)?.name || `武将${g.cfgId}`,
        troops: beginSoldiers[slot] ?? 0,
        remain: attackRemain[slot] ?? 0,
      })),
    },
    d: {
      name: nameD,
      units: defense.generals.map((g, i) => ({
        slot: i,
        name: cfg.generalByCfg.get(g.cfgId)?.name || `武将${g.cfgId}`,
        troops: defense.soldiers[i] ?? 0,
        remain: defenseRemain[i] ?? 0,
      })),
    },
    rounds,
  };
}

/** 执行一场战斗，产出原版 WarReport + 战后兵力/经验。
 *  defenseOverride：战略层城战传入的外部守军（跳过地块守军查表）。
 *
 *  ★ 试玩 P1-2 根因：攻击方按「有武将的槽位」过滤后，旧代码直接把过滤后的
 *    数组写回 army.soldiers，槽位 1/2 为空时返回值会从 3 个缩成 1 个，
 *    之后再往 index 1 征兵就是 undefined + n = NaN → 存档 null。
 *    现在始终按 3 槽对齐返回（endAttackSoldiers 长度恒为 3）。 */
/** 战斗种子的唯一公式（预演与正式结算共用；改这里等于改所有战报）。 */
export function battleSeedFor(armyId, x, y, day) {
  return crc32Utf8(`${armyId}:${x}:${y}:${Math.max(1, Math.floor(Number(day) || 1))}`);
}

export function resolveBattle({ cfg, state, army, x, y, seed, defenseOverride = null }) {
  const beginSoldiers = [0, 1, 2].map((i) => Math.max(0, Math.floor(Number(army.soldiers?.[i]) || 0)));
  // 有武将且有余兵的槽位才上阵；slot 保留原槽位号，序号 i 才是内核 unit id
  const attackers = (army.generals || [])
    .map((gid, slot) => ({ slot, g: gid ? findGeneral(state, gid) : null }))
    .filter(({ slot, g }) => g && beginSoldiers[slot] > 0);
  const defense = makeDefenders(cfg, state, x, y, defenseOverride);
  const defenders = defense.generals;

  const idMap = {};
  const units = [];
  const skillLookup = {};
  const buildLookup = (uid, unit) => {
    skillLookup[uid] = new Map(unit.hero.skills.map((sk) => {
      const f = reportSkillFields(sk.skill_id, sk.level);
      return [sk.name, f ? { ...f, class: sk.skill_class } : null];
    }).filter(([, v]) => v));
  };

  attackers.forEach(({ slot, g }, i) => {
    const uid = `a${i}`;
    idMap[uid] = g.id;
    const unit = makeUnit(uid, 1, g, cfg, beginSoldiers[slot], slot);
    /* ★ M2 练兵（GDD §5.4）：+10 士气折算攻击 +5%，随队伍走；
       previewAssault 与正式结算用同一 army.drillMorale 口径，推演与真打逐位一致 */
    const drill = Math.max(0, Math.min(10, Number(army.drillMorale) || 0));
    if (drill > 0) unit.hero.attack_base = Math.round(unit.hero.attack_base * (1 + 0.005 * drill));
    buildLookup(uid, unit);
    units.push(unit);
  });
  defenders.forEach((g, i) => {
    const uid = `d${i}`;
    idMap[uid] = g.id;
    const unit = makeUnit(uid, 2, g, cfg, defense.soldiers[i] ?? 0, i);
    buildLookup(uid, unit);
    units.push(unit);
  });
  idMap.system = 0;

  /* ★ 验收 #10：战斗种子只依赖 (队伍, 坐标, 到达日)，与 battleLog 长度解耦。
     这样「战前推演」可以算出与正式结算**逐位相同**的种子，预演结果才有意义。
     旧口径含 battleLog.length，等于预演必错一档。 */
  const battleSeed = seed ?? battleSeedFor(army.id, x, y, state.clock?.day ?? 1);
  const kernel = runBattle({ units, seed: battleSeed, config: battleConfig() });

  // 按槽位回填：没上阵的槽位余兵记 0（它们本来就没有兵）
  const attackRemain = [0, 0, 0];
  attackers.forEach(({ slot }, i) => {
    attackRemain[slot] = Math.max(0, Math.round((kernel.final_troops[`a${i}`] ?? 0) * TROOP_SCALE));
  });
  const defenseRemain = defenders.map((_, i) =>
    Math.max(0, Math.round((kernel.final_troops[`d${i}`] ?? 0) * TROOP_SCALE)));

  const aTotal = kernel.total_troops_by_side['1'] ?? attackRemain.reduce((s, n) => s + n, 0);
  const dTotal = kernel.total_troops_by_side['2'] ?? defenseRemain.reduce((s, n) => s + n, 0);
  let resultCode = 1;
  if (kernel.winner === 1) resultCode = 2;
  else if (kernel.winner === 2) resultCode = 0;
  else resultCode = aTotal > dTotal ? 2 : (aTotal < dTotal ? 0 : 1);

  const begAttackArmy = armySnapshot(army, beginSoldiers);
  const endAttackArmy = armySnapshot(army, attackRemain);
  const begDefenseArmy = {
    id: -1, cityId: 0, union_id: 0, order: 0,
    generals: defenders.map((g) => g.id),
    soldiers: [...defense.soldiers],
    con_times: [0, 0, 0], con_cnts: [0, 0, 0],
    cmd: 2, state: 1, from_x: x, from_y: y, to_x: x, to_y: y,
    start: 0, end: 0,
  };
  const endDefenseArmy = { ...begDefenseArmy, soldiers: defenseRemain };

  const begA = attackers.map(({ g }) => generalToArray(g));
  const expByGeneral = {};
  const endA = attackers.map(({ slot, g }) => {
    const exp = Math.max(0, Math.round((beginSoldiers[slot] - attackRemain[slot]) * 0.5));
    expByGeneral[g.id] = exp;
    return generalToArray({ ...g, exp: g.exp + exp });
  });
  const begD = defenders.map(generalToArray);
  const endD = defenders.map(generalToArray);
  const rounds = kernelEventsToRounds(kernel, idMap, skillLookup);

  const id = nextId(state, 'warReportId');
  const report = {
    id,
    a_rid: state.role.rid,
    d_rid: 0,
    b_a_army: JSON.stringify(begAttackArmy),
    b_d_army: JSON.stringify(begDefenseArmy),
    e_a_army: JSON.stringify(endAttackArmy),
    e_d_army: JSON.stringify(endDefenseArmy),
    b_a_general: JSON.stringify(begA),
    b_d_general: JSON.stringify(begD),
    e_a_general: JSON.stringify(endA),
    e_d_general: JSON.stringify(endD),
    result: resultCode,
    rounds: JSON.stringify(rounds),
    anim: buildBattleAnim({
      kernel, attackers, defense, army, beginSoldiers, state, cfg, x, y,
      resultCode, attackRemain, defenseRemain,
    }),
    a_is_read: false,
    d_is_read: false,
    destroy: resultCode === 2 ? 100 : 0,
    occupy: resultCode === 2 ? 1 : 0,
    x, y,
    ctime: Date.now(),
  };

  /** 可复核记录：技能清单、事件指纹、seed 全部留档。 */
  const loadout = Object.entries(skillLookup).flatMap(([uid, m]) =>
    [...m.values()].map((f) => ({ unit: uid, cfgId: f.cfgId, lv: f.lv, name: f.name, class: f.class })));
  state.battleLog.push({
    id, seed: battleSeed, x, y,
    armyId: army.id,
    winner: kernel.winner,
    result: resultCode,
    rounds: kernel.rounds,
    events: kernel.events.length,
    event_fingerprint: kernel.event_fingerprint,
    config_fingerprint: kernel.config_fingerprint,
    rng_calls: kernel.rng_calls,
    skillSystem: 'battle-kit/original-fragments/v3',
    loadout,
    reportSkillIds: [...new Set(rounds.flatMap((rd) => rd.b.flatMap((h) =>
      [...h.a_bs, ...h.a_as, ...h.d_as].map((s) => s.c_id))))],
  });
  if (state.battleLog.length > 200) state.battleLog.shift();

  return { report, kernel, endAttackSoldiers: attackRemain, endDefenseSoldiers: defenseRemain, expByGeneral };
}
