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
 * 数据口径：本作配置 battle_config.json（796 战法名 / 83 伤害率 / 58 组等级插值 / 188 效果术语）。
 */
import { runBattle, DEFAULT_BATTLE_CONFIG, crc32Utf8 } from '../kernel/index.js';
import { generalToArray, findGeneral, nextId } from './world.js';
import { kernelSkillAt, reportSkillFields, SKILLS, LEVEL_COUNT, attackDistanceOf } from './skills.js';
import { skillProfile, actSentence } from './domain/battle-narrative.js';
import { knobGet } from './domain/knobs.js';
/* ★ M4-13：兵种适性的唯一数值源（零依赖叶子），展示层与战斗结算同源 */
import { armsApt } from './domain/aptitude.js';
/* ★ M4-13：地图格守军同样按坐标确定性分配，不再复用写死的 6 个 cfgId */
import { garrisonCfgIds } from './domain/garrison.js';
/* ★ 2026-11-16：官阶反哺统兵能力——统帅(defense)按官阶加成，史载原表不动 */
import { effectiveStatOf } from './domain/general-stat.js';

/** 本作设计：一方兵力降到开战时的这个比例及以下，算溃败。 */
export const ROUT_RATIO = 0.1;

/**
 * 兵力进入伤害（本作设计 的兵力系数）。
 * 内核把兵力当生命、伤害不读兵力，所以 800 兵和 5000 兵打出的伤害曾经一样。
 * 以 800 为 1，指数小于 1：添兵有用，单槽堆到上限也不会按人数线性秒杀。
 */
export function troopStrikeMul(troops) {
  const t = Math.max(1, Number(troops) || 1);
  return Math.max(0.5, Math.min(3.2, Math.pow(t / 800, 0.55)));
}

/**
 * 胜负只看溃败，不看「谁还剩得多」。
 * 回合打满而双方都还在一成以上：未决（1），攻方不占城。
 * 返回 2 攻方胜 / 0 守方胜 / 1 未决。
 */
/** 兵力明显多于守军时，攻方伤害提高。均势（不到 1.15 倍）不加，避免「人多一点点就占城」。 */
export function attackerOddsMul(atkTroops, defTroops) {
  const odds = Math.max(0, Number(atkTroops) || 0) / Math.max(1, Number(defTroops) || 0);
  if (odds < 1.15) return 1;
  return Math.min(6.5, 1 + (odds - 1) * 11.2);
}

export function judgeBattle({ winner, aStart, dStart, aLeft, dLeft }) {
  const aRout = aStart > 0 && aLeft / aStart <= ROUT_RATIO;
  const dRout = dStart > 0 && dLeft / dStart <= ROUT_RATIO;
  if (dRout && !aRout) return 2;
  if (aRout && !dRout) return 0;
  if (aRout && dRout) return aLeft >= dLeft ? 2 : 0;
  if (winner === 1) return 2;
  if (winner === 2) return 0;
  return 1;
}

/** 真实兵力 → 内核兵力 1:1（配合下面的 troop_factor 微调）。
 *  原先用 10 会把 1000 兵压成 100 兵，1 回合就打完；实测 1:1 + troop_factor=0.2
 *  时一场战斗平均 2.2 回合 / 59 事件 / 约 22 条战报 hit，四类战法能完整展开。 */
export const TROOP_SCALE = 1;

/* ======================= 城防与攻城（2026-11-17）=======================
 * 城墙数值口径在 domain/city-wall.js（零依赖叶子，面板与战略层共用同一份）。
 * 这里只负责「战斗内怎么用」：
 *   · 守军防御加成按城墙完好比例取 wallDefMul（完整=旧口径 1.5，破城=无加成）；
 *   · 攻方按参战武将的攻城值（destroy）× 投入兵力打出破墙伤害；
 *   · 破城当阵守军再折损 breachRout（城墙崩塌），但**不参与 judgeBattle**——
 *     占城语义保持原样，不推翻既有验收契约。
 * 详见 domain/city-wall.js 顶部说明。
 */
import { WALL, wallMaxOf, wallRatioOf, wallDefMul } from './domain/city-wall.js';
export { WALL, wallMaxOf, wallRatioOf, wallDefMul };
/**
 * 攻方一波攻城能打掉多少城墙耐久。
 * 逐将取攻城值 × 该将投入兵力 → 破墙效率，再乘统一系数。
 * units 为 [{ destroy, soldiers }]（由 resolveBattle 从参战阵容现算，避免二次派生）。
 */
export function siegeDamageOf(units) {
  let sum = 0;
  for (const u of units || []) {
    const d = Math.max(0, Number(u.destroy) || 0);
    const s = Math.max(0, Number(u.soldiers) || 0);
    if (d <= 0 || s <= 0) continue;
    sum += d * troopStrikeMul(s);
  }
  return Math.round(sum * WALL.siegeK);
}

/** 内核配置快照：本作配置 原数值 + corrected 减伤方向修正。 */
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

/** 把原 general.json 的武将属性映射成内核 Hero（属性数值直接来源于原配置）。
 *  ★ 2026-11-17：导出给平衡/攻城用例复用同一条派生链——测试自己再算一遍属性
 *  就会出现「双方都顶到 100、强度无区分度」的假平衡（见 ai-career-balance 用例）。 */
export function makeHero(g, cfg) {
  /* ★ M2-3 代将（本作设计）：五维 50、无战法、不可培养——防止连环阵亡后无法出征的兜底 */
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
    name: `武将${g.cfgId}`, force: 60, strategy: 60, defense: 60,
    speed: 60, destroy: 12, force_grow: 30, strategy_grow: 30,
    defense_grow: 30, speed_grow: 30, destroy_grow: 20, arms: [1],
  };
  /* ★ M4-10：generalByCfg 已统一到百分制（0~100），进内核不再 ÷100——
     内核本来就是百分制（attack_base 60 就是武力 60）。`*_grow` 仍是 0~100 的
     成长率，按 /100*10 换算成每级点数（原表 30 → 每级 +3）。
     ★ 上限硬约束：的能力上限是 100，所以每级点数再按 (100-base)/9 收敛，
     Lv10 恰好不超过 100——高属性者成长慢，低属性者才练得动。 */
  const attr = (base, grow) => {
    const b = Math.round(Number(base ?? 60));
    const raw = Math.round(((grow ?? 30) / 100) * 10 * 100) / 100;
    /* cap 必须**向下**取到两位：向上取整会让 84 + 9×1.78 = 100.02 破上限。 */
    const cap = Math.max(0, (100 - b) / 9);
    return { base: b, grow: Math.min(raw, Math.floor(cap * 100) / 100) };
  };
  /* ★ 官阶加成（2026-11-16）：武将统帅随官阶提升（每阶 +2，封顶 100）；
     基线与成长率仍取 generalByCfg 原表，加成只在派生层叠加。rank=0 时不生效。 */
  const rank = Math.max(0, Math.trunc(Number(g.rank) || 0));
  const a = attr(gc.force, gc.force_grow);
  const d = attr(effectiveStatOf(gc.defense, rank, 'defense'), gc.defense_grow);
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
  const hero = makeHero(general, cfg);
  /* ★ M4-13：兵种适性从「只展示」变成「真进战斗」。
     取该武将五维在当前兵种上的适性系数（1.00~1.15），乘到攻/防基础值；
     界面上的「适性 X%」用的是同一个 armsApt()，描述与计算同源。
     只动攻防、不动速度/智力：速度会改变 actionOrder，进而漂事件指纹。
     clamp 100 守住的能力上限（M4-10 红线）。 */
  const gc = cfg.generalByCfg.get(Number(general.cfgId));
  const apt = gc
    ? armsApt({ force: gc.force, strategy: gc.strategy, defense: gc.defense }, general.curArms || 1)
    : 1;
  hero.attack_base = Math.min(100, Math.max(1, Math.round(hero.attack_base * apt)));
  hero.defence_base = Math.min(100, Math.max(1, Math.round(hero.defence_base * apt)));
  return {
    unit_id: unitId,
    side,
    /* ★ P6 战位：0=前锋 1=中军 2=大营，战法射程按此结算 */
    pos: Number(pos) || 0,
    hero,
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
  const garrison = (state.garrisons || []).find((g) => g.x === x && g.y === y && !g.cleared);
  const soldierCount = garrison?.soldiers ?? tier?.soldiers ?? 1000;
  const ids = [910001, 910002, 910003];
  /* ★ M4-13：坐标 → 守将名单确定性哈希。旧代码写死 army[0] 的
     [100002,100003,100004]，全地图每块地都是同三个人。 */
  const cfgIds = garrisonCfgIds(cfg, {
    cityId: Number(x) * 1000 + Number(y),
    owner: 'han',
    level: level || 1,
    exclude: [
      ...(state.generals || []).map((g) => Number(g.cfgId)),
      ...(state.captives || []).map((c) => Number(c.cfgId)),
    ],
  });
  return {
    generals: cfgIds.slice(0, 3).map((cfgId, k) => ({
      id: ids[k],
      cfgId,
      level: Math.max(1, level || 1),
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
    soldiers: cfgIds.slice(0, 3).map(() => soldierCount),
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
  /* ★ 玩家反馈「战报只有一行『谁发动了什么』」：动画里的每个动作都要带一句
     人话（谁 → 谁、效果是什么、折了多少卒），由 domain/battle-narrative 统一生成。
     前端只排版，不再自己拼句子 —— 否则战报详情、回放字幕、推演会各说一套。 */
  /* 带上 lv：同一条战法在不同等级数值不同，文案必须用「这名武将实际装备的等级」，
     否则战报会把 lv4 的健卒不殆说成 lv1 的 +40%。 */
  const profOf = (g) => (g.skills || [])
    .map((s) => (s && s.cfgId ? { ...skillProfile(s.cfgId, s.lv || 1), lv: s.lv || 1 } : null))
    .filter(Boolean);
  const units = {
    a: attackers.map(({ g }, i) => ({
      slot: i,
      name: cfg.generalByCfg.get(g.cfgId)?.name || `武将${g.cfgId}`,
      skills: profOf(g),
    })),
    d: defense.generals.map((g, i) => ({
      slot: i,
      name: cfg.generalByCfg.get(g.cfgId)?.name || `武将${g.cfgId}`,
      skills: profOf(g),
    })),
  };
  const nameOf = (ref) => {
    if (!ref) return '';
    const list = units[ref.s === 'd' ? 'd' : 'a'] || [];
    const u = list[ref.i];
    return u ? u.name : (ref.s === 'd' ? '守军' : '我军');
  };
  /* 该动作释放的战法在这名武将身上是几级（查不到按 1 级，绝不瞎猜高等级） */
  const lvOf = (ref, skillName) => {
    if (!ref) return 1;
    const list = units[ref.s === 'd' ? 'd' : 'a'] || [];
    const u = list[ref.i];
    const hit = (u?.skills || []).find((s) => s.name === skillName);
    return hit && hit.lv ? hit.lv : 1;
  };
  const rounds = [];
  for (const [round, evs] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    const acts = [];
    /* ★ M4-13：距离轨迹由内核单独返回（不进 events、不影响事件指纹），
       这里把它翻成战报里看得见的一句话。玩家此前完全看不到距离规则生效，
       才觉得「战法写了距离、战斗里却没有距离」。 */
    const rangeNotes = (kernel.range_trace || []).filter((t) => t.round === round);
    const skillLoss = new Map();
    for (const ev of evs) {
      if (ev.kind !== 'damage') continue;
      const key = `${ev.actor}|${String(ev.payload.skill ?? '')}`;
      skillLoss.set(key, (skillLoss.get(key) || 0)
        + Math.max(0, Math.round((ev.payload.applied ?? 0) * TROOP_SCALE)));
    }
    for (const ev of evs) {
      const p = ev.payload || {};
      let act = null;
      if (ev.kind === 'skill_prepare') {
        act = { t: 'prepare', f: unitOf(ev.actor), skill: String(p.skill ?? '') };
      } else if (ev.kind === 'skill_trigger') {
        act = {
          t: 'skill', f: unitOf(ev.actor), skill: String(p.skill ?? ''),
          loss: skillLoss.get(`${ev.actor}|${String(p.skill ?? '')}`) || 0,
          /* M4-7：回击复用了 skill_trigger 通道（战报 c_id/lv/e_v 才能查到），
             但要单独标出来，否则玩家会把「受击还击」误读成又一次开战生效。 */
          counter: !!p.counter,
        };
      } else if (ev.kind === 'damage') {
        act = {
          t: 'hit', f: unitOf(ev.actor), to: unitOf(p.target ?? 'a0'),
          loss: Math.max(0, Math.round((p.applied ?? 0) * TROOP_SCALE)),
          skill: String(p.skill ?? '普通攻击'),
        };
      } else if (ev.kind === 'control') {
        act = { t: 'control', f: unitOf(ev.actor), to: unitOf(p.target ?? 'a0'), state: String(p.state ?? '') };
      } else if (ev.kind === 'control_immune') {
        /* M4-7 洞察：内核拒绝施加控制时要进战报，玩家才知道这 3 回合买了什么 */
        act = {
          t: 'immune', f: unitOf(ev.actor), to: unitOf(p.target ?? 'a0'),
          state: String(p.state ?? ''),
        };
      } else if (ev.kind === 'heal') {
        const amount = Math.round((Number(p.applied ?? p.amount ?? 0)) * TROOP_SCALE);
        /* 0 治疗没有任何信息量，只会在战报里刷「回复 0」两行（实测确有） */
        if (amount <= 0) continue;
        act = { t: 'heal', f: unitOf(ev.actor), to: unitOf(p.target ?? 'a0'), amount };
      } else if (ev.kind === 'unit_down') {
        act = { t: 'down', unit: unitOf(p.unit ?? 'a0') };
      }
      if (!act) continue;
      act.fName = nameOf(act.f || act.unit);
      act.toName = act.to ? nameOf(act.to) : act.fName;
      if (act.skill) act.lv = lvOf(act.f || act.unit, act.skill);
      const prof = act.skill ? skillProfile(act.skill, act.lv || 1) : null;
      if (prof) { act.effect = prof.effect; act.cls = prof.cls; }
      act.text = actSentence(act);
      /* ★ M4-13：把「射程之外的敌军」写进战法叙述。轨迹按 actor + 战法名匹配，
         只在实际发生过滤时追加，其它战报文本逐字不变。 */
      if ((act.t === 'skill' || act.t === 'hit') && rangeNotes.length) {
        const rn = rangeNotes.find((t) => t.kind === 'skill' && t.actor === ev.actor
          && String(t.skill ?? '') === String(p.skill ?? ''));
        if (rn && rn.out_of_range.length) {
          act.rangeNote = `有效距离 ${rn.range} · 仅及 ${rn.reachable}/${rn.total} 名敌军`
            + `（最近相隔 ${rn.nearest} 格，${rn.out_of_range.length} 人在射程外）`;
          act.text += `〔${act.rangeNote}〕`;
        }
      }
      acts.push(act);
    }
    /* 普攻超距打空时内核不产生 damage 事件（静默跳过），单独补一句叙述。
       否则玩家只看到「这一回合某人没动作」，永远不知道是站位太靠后。 */
    for (const rn of rangeNotes.filter((t) => t.kind === 'normal')) {
      const f = { s: rn.actor[0], i: Number(rn.actor.slice(1)) || 0 };
      const posName = ['前锋', '中军', '大营'][Math.min(2, f.i)] || '后阵';
      acts.push({
        t: 'range', f, fName: nameOf(f),
        text: `${nameOf(f)} 列于${posName}，攻距 ${rn.range}，最近敌军相隔 ${rn.nearest} 格——弓矢不及，本回合未能出手`,
      });
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
      total: attackers.reduce((s, { slot }) => s + (beginSoldiers[slot] || 0), 0),
      units: attackers.map(({ slot, g }, i) => ({
        slot: i,
        armySlot: slot,
        name: cfg.generalByCfg.get(g.cfgId)?.name || `武将${g.cfgId}`,
        troops: beginSoldiers[slot] ?? 0,
        remain: attackRemain[slot] ?? 0,
        skills: units.a[i].skills,
      })),
    },
    d: {
      name: nameD,
      total: defense.soldiers.reduce((s, v) => s + Math.max(0, Number(v) || 0), 0),
      units: defense.generals.map((g, i) => ({
        slot: i,
        name: cfg.generalByCfg.get(g.cfgId)?.name || `武将${g.cfgId}`,
        troops: defense.soldiers[i] ?? 0,
        remain: defenseRemain[i] ?? 0,
        skills: units.d[i].skills,
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

export function resolveBattle({
  cfg, state, army, x, y, seed, defenseOverride = null, withAnim = true, siege = false, siegeWall = null,
}) {
  const siegeBattle = siege;
  /* withAnim=false：推演用。推演只要数值与叙事，不需要回放动作流；
     而 buildBattleAnim 要为每个动作生成一句人话（战法档案 + 措辞），
     一次推演要跑 4~5 场内核，累计就顶爆 本作设计 的单次 ≤50ms 预算。 */
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

  const atkHead = beginSoldiers.reduce((s, n) => s + n, 0);
  const defHead = (defense.soldiers || []).reduce((s, n) => s + Math.max(0, Number(n) || 0), 0);
  const mass = attackerOddsMul(atkHead, defHead);
  attackers.forEach(({ slot, g }, i) => {
    const uid = `a${i}`;
    idMap[uid] = g.id;
    const unit = makeUnit(uid, 1, g, cfg, beginSoldiers[slot], slot);
    unit.hero.attack_base = Math.max(1, Math.round(unit.hero.attack_base * troopStrikeMul(beginSoldiers[slot]) * mass));
    buildLookup(uid, unit);
    units.push(unit);
  });
  /* ★ 2026-11-17 城防：城墙完好比例决定守军防御加成（完整=旧口径 sieveWallMul）。
     旧实现恒 1.5、与城防属性无关；现在城墙被打残后守军立刻变软。 */
  const wall = siegeBattle ? wallDefMul(state, siegeWall) : 1;
  const terrain = String(defenseOverride?.terrain || '');
  const terrainMul = /山|险|隘/.test(terrain) ? 1.12 : 1;
  defenders.forEach((g, i) => {
    const uid = `d${i}`;
    idMap[uid] = g.id;
    const troops = defense.soldiers[i] ?? 0;
    const unit = makeUnit(uid, 2, g, cfg, troops, i);
    unit.hero.attack_base = Math.max(1, Math.round(unit.hero.attack_base * troopStrikeMul(troops)));
    if (wall !== 1 || terrainMul !== 1) {
      unit.hero.defence_base = Math.max(1, Math.round(unit.hero.defence_base * wall * terrainMul));
    }
    buildLookup(uid, unit);
    units.push(unit);
  });
  idMap.system = 0;
  /* 攻方攻城值（destroy）在这一战里换成的破墙伤害：按参战武将 × 投入兵力现算。
     没传 siegeWall 的老调用方（本地清剿 / 旧测试）按「城墙完整」处理，口径与升级前一致。 */
  const siegeWallMax = Math.max(1, Number(siegeWall?.max) || 0);
  const siegeWallHp = Number.isFinite(Number(siegeWall?.hp)) && siegeWallMax > 0
    ? Math.max(0, Math.min(siegeWallMax, Number(siegeWall.hp)))
    : siegeWallMax;
  const siegeDmg = siegeBattle && siegeWallMax > 0
    ? siegeDamageOf(units.filter((u) => u.side === 1).map((u) => ({
      destroy: (Number(u.hero.destroy_base) || 0)
        + (Number(u.hero.destroy_grow) || 0) * ((Number(u.hero.level) || 1) - 1),
      soldiers: Number(u.troops) || 0,
    })))
    : 0;

  /* ★ 验收 #10：战斗种子只依赖 (队伍, 坐标, 到达日)，与 battleLog 长度解耦。
     这样「战前推演」可以算出与正式结算**逐位相同**的种子，预演结果才有意义。
     旧口径含 battleLog.length，等于预演必错一档。 */
  const battleSeed = seed ?? battleSeedFor(army.id, x, y, state.clock?.day ?? 1);
  /* troop_factor 0.2 时 8 回合打不垮守军（兵力只是生命）。1.25 让约 1.5 倍的军队
     能在回合上限内打崩小城；双方都还剩一成以上时仍是未决，不按人头多判胜。 */
  const fightCfg = {
    ...battleConfig(),
    round_limit: Math.round(Number(knobGet(state, 'roundMax')) || 8),
    troop_factor: 0.45,
  };
  const kernel = runBattle({ units, seed: battleSeed, config: fightCfg });

  // 按槽位回填：没上阵的槽位余兵记 0（它们本来就没有兵）
  const attackRemain = [0, 0, 0];
  attackers.forEach(({ slot }, i) => {
    attackRemain[slot] = Math.max(0, Math.round((kernel.final_troops[`a${i}`] ?? 0) * TROOP_SCALE));
  });
  const defenseRemain = defenders.map((_, i) =>
    Math.max(0, Math.round((kernel.final_troops[`d${i}`] ?? 0) * TROOP_SCALE)));

  const aStart = beginSoldiers.reduce((s, n) => s + n, 0);
  const dStart = defense.soldiers.reduce((s, n) => s + Math.max(0, Number(n) || 0), 0);
  const aLeft0 = attackRemain.reduce((s, n) => s + n, 0);
  const dLeft0 = defenseRemain.reduce((s, n) => s + n, 0);
  const resultCode = judgeBattle({
    winner: kernel.winner, aStart, dStart, aLeft: aLeft0, dLeft: dLeft0,
  });
  /* 本作设计 追击：溃败之后，败方再损「胜方骑兵占比 × pursuitRate」。未决不追。 */
  if (resultCode === 2 || resultCode === 0) {
    const winnerBegin = resultCode === 2 ? beginSoldiers : defense.soldiers;
    const start = winnerBegin.reduce((s, n) => s + Math.max(0, Number(n) || 0), 0);
    const cav = Math.max(0, Number(winnerBegin[2]) || 0);
    const cut = start > 0 ? (cav / start) * ((Number(knobGet(state, 'pursuitRate')) || 0) / 100) : 0;
    if (cut > 0) {
      const side = resultCode === 2 ? defenseRemain : attackRemain;
      for (let i = 0; i < side.length; i += 1) side[i] = Math.max(0, Math.round(side[i] * (1 - cut)));
    }
  }

  /* ★ 2026-11-17 城防：攻城值换来的破墙伤害在这里结算。
     破城（wallHp 归零）当阵守军再折损 breachRout——城墙塌了守军溃散，
     但**不参与 judgeBattle**（占城语义保持原样，避免推翻既有契约）。 */
  let siegeInfo = null;
  if (siegeBattle && siegeWallMax > 0) {
    const hpAfter = Math.max(0, siegeWallHp - siegeDmg);
    const breached = hpAfter <= 0 && siegeWallHp > 0;
    if (breached) {
      for (let i = 0; i < defenseRemain.length; i += 1) {
        defenseRemain[i] = Math.max(0, Math.round(defenseRemain[i] * (1 - WALL.breachRout)));
      }
    }
    siegeInfo = {
      max: siegeWallMax,
      hpBefore: siegeWallHp,
      hpAfter,
      damage: Math.min(siegeDmg, siegeWallHp),
      breached,
      ratioBefore: Math.round((siegeWallHp / siegeWallMax) * 100),
      ratioAfter: Math.round((hpAfter / siegeWallMax) * 100),
      defMul: Math.round(wall * 100) / 100,
    };
  }

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
    anim: withAnim
      ? buildBattleAnim({
        kernel, attackers, defense, army, beginSoldiers, state, cfg, x, y,
        resultCode, attackRemain, defenseRemain,
      })
      : null,
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

  return {
    report, kernel, endAttackSoldiers: attackRemain, endDefenseSoldiers: defenseRemain, expByGeneral, siege: siegeInfo,
  };
}
