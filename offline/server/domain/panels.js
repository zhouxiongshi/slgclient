/**
 * 六大面板的领域层（纯函数 + 确定性），不碰战斗内核、不碰磁盘 web/。
 *
 * 设计纪律（见 docs/体系设计方案-待确认.md）：
 *  - 战法名称 / 类型 / 描述 / 数值一律读 conf/ 原文，本文件不改写任何一个字；
 *  - 人物文本只从 conf/panels/generals-lore.json（构建期导出）读取，缺项写「史无明载」；
 *  - 装备单件 ≤8%、全套 ≤25%，只改五维增量与机制型特性；
 *  - 所有新存档字段由 ensurePanels 兜底，11-08 那份无 strategy 的旧档也能开；
 *  - 无随机：本模块不调用 Math.random，需要随机处一律走 rngFor(seed, turn, tag)。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slotBlock } from './slots.js';
/* 刻意只 import oath.js（零依赖小模块）而不 import strategy.js ——
   它反向 import world.js，而 world.js 又 import 本文件，会成环。 */
import { oathOf, oathFactionOf, strategyCity, factionTraitOf } from './oath.js';
import { ensureCityEcon, cityYield, armsApt, ARMS_NAMES } from './city-econ.js';
/* 战略台以并行会话的战略层为唯一口径：行军可达/关隘取 march.js，出征账取 strategy-log.js。
   刻意不 import strategy.js —— 它反向 import world.js，而 world.js 又 import 本文件，会成环。 */
import { marchableNeighbors, marchGraph } from './march.js';
import { booksOf } from './strategy-log.js';
import { captiveRateParts, captiveRecruitRate } from './captive-rules.js';
/* ★ U15 相性 / 义理 / 关系网（relation.js 只依赖 oath.js，不成环） */
import { xiangxingOf, yiliOf, relationSummary, talentRecruitRate } from './relation.js';
import { recordRes } from './economy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

export const PANEL_CONF = {
  lore: load('conf/panels/generals-lore.json'),
  recipes: load('conf/panels/skill-recipes.json'),
  items: load('conf/panels/items.json'),
  posts: load('conf/panels/posts.json'),
  mainSkills: load('conf/skills.json').skills,
  libSkills: load('conf/library-skills.json').skills,
  map: (() => { try { return load('conf/campaign/strategy/map.json'); } catch { return { cities: [] }; } })(),
  factions: (() => { try { return load('conf/campaign/strategy/factions.json'); } catch { return { factions: [] }; } })(),
  protagonist: (() => { try { return load('conf/campaign/protagonist.json').general; } catch { return null; } })(),
};

const SKILLS = [...PANEL_CONF.mainSkills, ...PANEL_CONF.libSkills];
// ★ P6：战法描述补射程——与内核/原客户端技能面板同一函数，保证描述=计算
import { applyRangeNote } from '../skills.js';
for (const s of SKILLS) applyRangeNote(s);
const SKILL_BY_ID = new Map(SKILLS.map((s) => [Number(s.cfgId), s]));
const ITEM_BY_ID = new Map(PANEL_CONF.items.items.map((i) => [Number(i.id), i]));
const RECIPE_BY_ID = new Map(PANEL_CONF.recipes.recipes.map((r) => [Number(r.cfgId), r]));
const LORE_BY_CFG = new Map(PANEL_CONF.lore.list.map((r) => [Number(r.cfgId), r]));
const EQUIP_KEYS = ['force', 'strategy', 'defense', 'speed', 'destroy'];
const SLOT_IDS = PANEL_CONF.items.slots.map((s) => s.id);
const RES_LABEL = { wood: '木', iron: '铁', stone: '石', grain: '粮', gold: '金', decree: '政令' };
const STAT_LABEL = { force: '武力', strategy: '谋略', defense: '防御', speed: '速度', destroy: '攻城' };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const int = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : def; };
const round2 = (n) => Math.round(n * 100) / 100;

/* -------------------------------------------------------------------------- */
/* 存档兼容                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 给新字段兜底。normalizeWorld() 每次启动都会调用，因此：
 *  - 只补字段、不改既有值；
 *  - 开局赠品用 panelBootstrapped 标记，保证旧档 / 重复读档不会无限刷物品。
 */
export function ensurePanels(state, cfg = {}) {
  if (!Array.isArray(state.items)) state.items = [];
  if (!state.equipment || typeof state.equipment !== 'object') state.equipment = {};
  if (!state.panelBase || typeof state.panelBase !== 'object') state.panelBase = {};
  if (!state.panelMerits || typeof state.panelMerits !== 'object') state.panelMerits = {};
  if (!state.skillbook || typeof state.skillbook !== 'object') state.skillbook = {};
  if (!state.skillbook.unlocked || typeof state.skillbook.unlocked !== 'object') state.skillbook.unlocked = {};
  if (!state.skillbook.research || typeof state.skillbook.research !== 'object') state.skillbook.research = {};

  const posts = {};
  for (const p of PANEL_CONF.posts.posts) posts[p.id] = 0;
  if (!state.interior || typeof state.interior !== 'object') state.interior = {};
  if (!state.interior.posts || typeof state.interior.posts !== 'object') state.interior.posts = posts;
  for (const p of PANEL_CONF.posts.posts) {
    if (state.interior.posts[p.id] == null) state.interior.posts[p.id] = 0;
  }
  const c = PANEL_CONF.posts.constraints;
  if (!Number.isFinite(state.interior.morale)) state.interior.morale = c.morale.init;
  if (!Number.isFinite(state.interior.order)) state.interior.order = c.order.init;
  if (!Number.isFinite(state.interior.corruption)) state.interior.corruption = c.corruption.init;
  if (state.interior.appliedThisTurn == null) state.interior.appliedThisTurn = null;
  if (!Number.isFinite(state.interior.appliedTurn)) state.interior.appliedTurn = -1;

  for (const g of state.generals || []) {
    const id = String(g.id);
    if (!state.equipment[id]) state.equipment[id] = { weapon: 0, armor: 0, mount: 0, tome: 0 };
    else for (const s of SLOT_IDS) if (state.equipment[id][s] == null) state.equipment[id][s] = 0;
    if (!state.panelBase[id]) {
      // 兼容「已有装备但缺基线」的旧档：先扣掉装备部分，再记录真实基线，
      // 否则下一次穿脱会把同一份加成重复叠加。
      const already = equipBonusFor(baseStats(cfg, g), state.equipment[id], state);
      state.panelBase[id] = Object.fromEntries(
        EQUIP_KEYS.map((k) => [k, (Number(g[`${k}_added`]) || 0) - (already[k] || 0)]),
      );
    }
    if (!state.panelMerits[id]) state.panelMerits[id] = { battles: 0, merits: 0, defense: 0, upset: 0 };
  }

  if (!state.panelBootstrapped) {
    const gift = PANEL_CONF.items.starterGift || [];
    gift.forEach((cfgId, i) => {
      state.items.push({
        id: 500001 + i, cfgId, kind: 'equip', count: 1,
        ownerGeneralId: 0, source: '开局', forgedAt: state.clock?.day || 1,
      });
    });
    state.items.push({ id: 500010, cfgId: 400001, kind: 'scroll', count: 30, ownerGeneralId: 0, source: '开局', forgedAt: 1 });
    state.items.push({ id: 500011, cfgId: 400003, kind: 'material', count: 2, ownerGeneralId: 0, source: '开局', forgedAt: 1 });
    state.items.push({ id: 500012, cfgId: 400004, kind: 'relic', count: 1, ownerGeneralId: 0, source: '序章', forgedAt: 1 });
    // 主角自带战法作为「已解锁」种子，其余走六源获取
    for (const g of state.generals || []) {
      const s = g.skills?.[0];
      if (s?.cfgId) state.skillbook.unlocked[String(s.cfgId)] = { level: int(s.lv, 1), source: '自带' };
    }
    // 开局预置：两条已解锁、一条研习中，让「已解锁 / 研习中 / 未解锁」三色状态在原型里可验收。
    // 这只是初始状态，之后全部靠六源推进，不额外赠送。
    for (const id of [10001, 910000]) {
      state.skillbook.unlocked[String(id)] = { level: 1, source: '开局旧藏' };
    }
    state.skillbook.research['10002'] = { progress: 12, need: 100 };
    state.panelBootstrapped = true;
  }
  return state;
}

/* -------------------------------------------------------------------------- */
/* 内部计算                                                                   */
/* -------------------------------------------------------------------------- */

function generalName(state, cfg, g) {
  if (g.isProtagonist) return state.role?.nickName || '主公';
  return cfg.generalByCfg?.get?.(g.cfgId)?.name || `武将${g.cfgId}`;
}

function baseStats(cfg, g) {
  // 穿越者主公不在客户端名录里，基础五维取自 campaign/protagonist.json
  const c = g.isProtagonist && PANEL_CONF.protagonist
    ? PANEL_CONF.protagonist
    : (cfg.generalByCfg?.get?.(g.cfgId) || {});
  return Object.fromEntries(EQUIP_KEYS.map((k) => [k, Number(c[k]) || 0]));
}

/** 槽位里存的是物品实例 id，需先回查 conf 定义；单件 ≤8%、四件合计 ≤25%。 */
function itemDefOf(state, instId) {
  const inst = (state.items || []).find((i) => Number(i.id) === Number(instId));
  return inst ? ITEM_BY_ID.get(Number(inst.cfgId)) : null;
}

/** 按「基础五维百分比」结算装备加成；单件 ≤8%、四件合计 ≤25%。 */
function equipBonusFor(base, eq, state) {
  const sum = Object.fromEntries(EQUIP_KEYS.map((k) => [k, 0]));
  const red = PANEL_CONF.items.redline;
  for (const slot of SLOT_IDS) {
    const item = itemDefOf(state, eq?.[slot]);
    if (!item) continue;
    for (const k of EQUIP_KEYS) {
      const pct = clamp(Number(item.bonusPct?.[k]) || 0, 0, red.perItemPct);
      sum[k] += Math.round(base[k] * pct / 100);
    }
  }
  for (const k of EQUIP_KEYS) sum[k] = Math.round(clamp(sum[k], 0, base[k] * red.fullSetPct / 100));
  return sum;
}

function scrollCount(state) {
  return (state.items || []).filter((i) => i.kind === 'scroll' && !i.ownerGeneralId)
    .reduce((n, i) => n + (Number(i.count) || 0), 0);
}

function takeScrolls(state, n) {
  let left = n;
  for (const i of state.items || []) {
    if (left <= 0) break;
    if (i.kind !== 'scroll' || i.ownerGeneralId) continue;
    const use = Math.min(left, Number(i.count) || 0);
    i.count -= use; left -= use;
  }
  state.items = (state.items || []).filter((i) => i.count !== 0);
  return n - left;
}

function ownedSkillIds(state) {
  const ids = new Set(Object.keys(state.skillbook.unlocked || {}).map(Number));
  for (const g of state.generals || []) for (const s of g.skills || []) if (s?.cfgId) ids.add(Number(s.cfgId));
  return ids;
}

function equippedBy(state, cfgId) {
  const out = [];
  for (const g of state.generals || []) {
    for (const s of g.skills || []) if (Number(s?.cfgId) === Number(cfgId)) { out.push(g.id); break; }
  }
  return out;
}

function isDeployed(state, gId) {
  return (state.armys || []).some((a) => (a.generals || []).includes(Number(gId)));
}

function turnOf(state) { return int(state.strategy?.turn, 0); }

/** 每回合三张提案：确定性（不用 Math.random），按回合号与固定标签洗牌。 */
function proposalsFor(state) {
  const all = PANEL_CONF.posts.proposals;
  const t = turnOf(state);
  const offset = (t * 3) % all.length;
  return [0, 1, 2].map((i) => all[(offset + i) % all.length]);
}

/**
 * 各岗位加成百分比（P1：从「只显示」升级为「真实生效」）。
 * 红线：单岗位 ≤30%，随城池数递减，出征中减半。与界面显示同源。
 */
export function postBonusPct(state) {
  const c = PANEL_CONF.posts.redline;
  const cityCount = Math.max(1, (state.citys || []).length || 1);
  const bonusPct = {};
  for (const p of PANEL_CONF.posts.posts) {
    const gId = Number(state.interior?.posts?.[p.id]) || 0;
    if (!gId) { bonusPct[p.id] = 0; continue; }
    const g = (state.generals || []).find((x) => x.id === gId);
    if (!g) { bonusPct[p.id] = 0; continue; }
    const lore = LORE_BY_CFG.get(Number(g.cfgId));
    const stat = lore?.historyStats?.[p.stat] || 50;
    let pct = Math.min(c.maxBonusPct, round2(stat / 100 * 30 - (cityCount - 1) * c.decayPerCity));
    if (isDeployed(state, gId)) pct = round2(pct / 2);   // 出征中减半，明写在界面
    bonusPct[p.id] = Math.max(0, pct);
  }
  return bonusPct;
}

/** 岗位加成折算到资源轴：{grain: 12, gold: 8, ...}，economy.applyDays 直接乘产量。 */
export function yieldBonusByResource(state) {
  const bonusPct = postBonusPct(state);
  const out = {};
  for (const p of PANEL_CONF.posts.posts) {
    const pct = bonusPct[p.id] || 0;
    if (pct > 0 && p.resource) out[p.resource] = Math.max(0, out[p.resource] || 0) + pct;
  }
  // ★ P4-①：势力特技计入同一张加成表（内政面板「委任加成」列随之如实显示）
  const trait = factionTraitOf(state);
  for (const [k, v] of Object.entries(trait.yields || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/** 在岗委任人数（俸禄用）：有人的岗位每天发俸禄，让委任有成本、政治值有回报。 */
export function filledPostCount(state) {
  return Object.values(state.interior?.posts || {}).filter((v) => Number(v) > 0).length;
}

/* -------------------------------------------------------------------------- */
/* 武将职业体系（P4）：五维自动判定四职业 + 岗位限制                          */
/* -------------------------------------------------------------------------- */

export const CAREER_NAMES = {
  commander: '统帅', warrior: '猛将', strategist: '军师', civil: '政务官', generalist: '干才',
};

/** 每职业的适任岗位：出征主将 / 军师随军 / 内政委任。 */
export const CAREER_FIT = {
  commander: { leader: true, aide: true, civilPost: true, note: '可任主将、可掌内政' },
  warrior: { leader: true, aide: false, civilPost: false, note: '可任主将冲锋，不宜掌内政' },
  strategist: { leader: false, aide: true, civilPost: false, note: '随军军师，不宜领兵为帅' },
  civil: { leader: false, aide: false, civilPost: true, note: '内政专才，不上战场' },
  generalist: { leader: true, aide: true, civilPost: true, note: '什么都行，什么都不精' },
};

/**
 * 职业判定（P4）：读 generals-lore 的历史五维（统率/武力/智力/政治/魅力），
 * 主属性最高且 ≥80 归入对应职业；不足 80 或史无明载 → 干才。
 * 主角等新面孔没有历史五维，按干才处理（什么都行），委任加成走默认值。
 */
export function careerOf(g) {
  const lore = LORE_BY_CFG.get(Number(g?.cfgId));
  const st = lore?.historyStats || null;
  const dims = ['统率', '武力', '智力', '政治', '魅力'];
  if (!st) return { career: 'generalist', top: null, topVal: 0 };
  let top = null, topVal = -1;
  for (const d of dims) {
    const v = Number(st[d]) || 0;
    if (v > topVal) { topVal = v; top = d; }
  }
  if (topVal < 80 || !top) return { career: 'generalist', top, topVal };
  const career = top === '统率' ? 'commander'
    : top === '武力' ? 'warrior'
      : top === '智力' ? 'strategist' : 'civil';
  return { career, top, topVal };
}

function interiorOutput(state, cfg) {
  const res = state.roleRes || {};
  const bonusPct = postBonusPct(state);
  const resBonus = yieldBonusByResource(state);
  // 收支流水视图（P0-3）：府库面板展示「钱花哪了」；净变化取最近 30 条按资源合计
  const ledgerSrc = Array.isArray(state.resLedger) ? state.resLedger : [];
  const netKeys = ['wood', 'iron', 'stone', 'grain', 'gold'];
  const netSrc = ledgerSrc.slice(-30);
  return {
    bonusPct,
    resources: ['wood', 'iron', 'stone', 'grain', 'gold', 'decree'].map((k) => ({
      key: k, label: RES_LABEL[k],
      stock: Number(res[k]) || 0,
      yield: Number(res[`${k}_yield`]) || 0,
      bonusPct: resBonus[k] || 0,
      capacity: k === 'decree' ? null : Number(res.depot_capacity) || 0,
    })),
    ledger: {
      entries: ledgerSrc.slice(-14).reverse(),
      net: netKeys.map((k) => ({
        key: k, label: RES_LABEL[k],
        delta: netSrc.reduce((acc, e) => acc + (e.res === k ? (Number(e.delta) || 0) : 0), 0),
      })),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 面板聚合状态（GET /__slg/panels/state）                                    */
/* -------------------------------------------------------------------------- */

export function panelState(state, cfg) {
  ensurePanels(state, cfg);
  const owned = ownedSkillIds(state);

  const generals = (state.generals || []).map((g) => {
    const eq = state.equipment[String(g.id)] || {};
    const base = baseStats(cfg, g);
    const bonus = equipBonusFor(base, eq, state);
    const lore = LORE_BY_CFG.get(Number(g.cfgId)) || null;
    const slots = [0, 1, 2].map((pos) => {
      const s = g.skills?.[pos];
      const conf = s?.cfgId ? SKILL_BY_ID.get(Number(s.cfgId)) : null;
      const block = slotBlock(g, pos, 'replace');
      return {
        pos,
        locked: !!block,
        lockText: block === 'innate_locked' ? '自带战法，不可替换'
          : pos === 1 ? '需武将 Lv5 解锁' : '需 Lv20 且自带战法 10 级',
        skill: conf ? {
          cfgId: conf.cfgId,
          name: conf.ui?.name ?? conf.name,
          des: conf.ui?.des ?? '',
          trigger: conf.trigger,
          level: int(s.lv, 1),
          probability: conf.ui?.levels?.[int(s.lv, 1) - 1]?.probability ?? null,
        } : null,
      };
    });
    const gname = generalName(state, cfg, g);
    const camp = cfg?.generalByCfg?.get?.(Number(g.cfgId))?.camp ?? 1;
    return {
      id: g.id, cfgId: g.cfgId, name: gname,
      /* ★ U15 相性/义理/关系网：相性与义理标注为本作设定（派生值），关系逐条带回目出处 */
      xiangxing: xiangxingOf(g.cfgId, camp),
      yili: yiliOf(g.cfgId),
      camp,
      isProtagonist: !!g.isProtagonist, level: int(g.level, 1), star: int(g.star, 0),
      exp: int(g.exp, 0), physical: int(g.physical_power, 100),
      state: isDeployed(state, g.id) ? '在编' : '闲置',
      career: careerOf(g).career,
      careerName: CAREER_NAMES[careerOf(g).career],
      careerNote: CAREER_FIT[careerOf(g).career].note,
      loyal: Math.round(g.loyal ?? 88),        // ★ P1 忠诚度（旬结算/赏赐）
      salaryPerXun: 20 * (Number(g.star) || 3), // ★ P1 旬俸
      appointed: Object.entries(state.interior.posts || {}).filter(([, v]) => Number(v) === g.id).map(([k]) => k),
      base, added: Object.fromEntries(EQUIP_KEYS.map((k) => [k, Number(g[`${k}_added`]) || 0])),
      final: Object.fromEntries(EQUIP_KEYS.map((k) => [k, base[k] + (Number(g[`${k}_added`]) || 0)])),
      equipBonus: bonus,
      equipment: Object.fromEntries(SLOT_IDS.map((s) => {
        const it = itemDefOf(state, eq[s]);
        return [s, it ? { itemId: eq[s], cfgId: it.id, name: it.name, trait: it.trait, set: it.set, bonusPct: it.bonusPct } : null];
      })),
      slots,
      lore,
      merits: state.panelMerits[String(g.id)] || { battles: 0, merits: 0, defense: 0, upset: 0 },
      relations: relationSummary(gname),
    };
  });

  const ownedCfgIds = new Set(generals.map((g) => Number(g.cfgId)));
  const prospects = PANEL_CONF.lore.list
    .filter((r) => !ownedCfgIds.has(Number(r.cfgId)))
    .slice(0, 12)
    .map((r) => {
      const camp = cfg?.generalByCfg?.get?.(Number(r.cfgId))?.camp ?? 1;
      const calc = talentRecruitRate(state, cfg, { cfgId: r.cfgId });
      return {
        cfgId: r.cfgId, name: r.name, zi: r.zi, faction: r.faction,
        historyStats: r.historyStats, brief: r.brief,
        xiangxing: xiangxingOf(r.cfgId, camp), yili: yiliOf(r.cfgId),
        recruitRate: calc.rate, recruitParts: calc.parts, xiangxingGap: calc.gap,
        relations: relationSummary(r.name),
      };
    });

  const items = (state.items || []).map((i) => {
    const def = ITEM_BY_ID.get(Number(i.cfgId));
    const mat = PANEL_CONF.items.materials.find((m) => Number(m.id) === Number(i.cfgId));
    const owner = Number(i.ownerGeneralId) || 0;
    const ownerName = owner ? (generals.find((g) => g.id === owner)?.name || '') : '';
    return {
      id: i.id, cfgId: i.cfgId, count: Number(i.count) || 0, kind: i.kind,
      name: def?.name || mat?.name || `物品${i.cfgId}`,
      slot: def?.slot || null, slotName: def?.slotName || null,
      trait: def?.trait || '', tale: def?.tale || mat?.note || '',
      bonusPct: def?.bonusPct || null, set: def?.set || null,
      forge: def?.forge || null,
      source: i.source || '—', ownerGeneralId: owner, ownerName,
    };
  });

  const library = SKILLS.map((s) => {
    const id = Number(s.cfgId);
    const r = RECIPE_BY_ID.get(id) || { sources: [], trigger: `类型${s.trigger}`, tags: [] };
    const unl = state.skillbook.unlocked[String(id)] || null;
    const res = state.skillbook.research[String(id)] || null;
    const by = equippedBy(state, id);
    const status = unl || owned.has(id) ? 'unlocked' : res ? 'researching' : 'locked';
    const lv = Object.assign({}, ...(s.ui?.levels || []).map((l, i) => ({ [i + 1]: { probability: l.probability, effect_value: l.effect_value } })));
    return {
      cfgId: id,
      name: s.ui?.name ?? s.name,
      des: s.ui?.des ?? '',
      range: s.ui?.range ?? null,
      trigger: r.trigger, tags: r.tags, sourceGroup: r.sourceGroup,
      target: s.ui?.target ?? null, arms: s.ui?.arms ?? [],
      levels: lv, levelCount: (s.ui?.levels || []).length,
      status, level: unl?.level || (owned.has(id) ? 1 : 0),
      equippedBy: by, equipLimit: 2,
      research: res ? { progress: res.progress, need: res.need } : null,
      sources: r.sources || [],
      guarantee: r.guarantee || '',
    };
  });

  /* 战略台数据源对齐（以并行会话的战略层为主，不再自己造估算值）：
     - 城池 / 归属 / 实时驻军取 state.strategy.cities（strategyAttack 实际用的就是 troops）；
     - 行军可达与关隘封锁取 march.js，与出征校验同一份规则；
     - 诸侯战役意图取 strategy-brain 写入的 st.memory[*].goal；
     - 拟人日志与出征账取 strategy-log 写入的 st.chronicle。 */
  const st = state.strategy || {};
  const cityRows = st.cities && typeof st.cities === 'object' ? st.cities : {};
  const mapCities = PANEL_CONF.map.cities || [];
  const myCities = mapCities.filter((c) => cityRows[c.id]?.owner === 'player');
  let marchable = [];
  let gates = [];
  // 与 strategy.js 的 marchableFrom 同一实现：marchableNeighbors(home, 全图城 id)
  try {
    marchable = (marchableNeighbors(st.playerCity || 0, mapCities.map((c) => c.id)) || []).map(Number);
  } catch { marchable = []; }
  try {
    gates = Object.entries(marchGraph()?.gateStatus || {})
      .map(([name, status]) => ({ name, status }));
  } catch { gates = []; }
  const reachable = new Set(marchable);
  const factionNames = Object.fromEntries((PANEL_CONF.factions?.factions || [])
    .map((f) => [String(f.id), f.name]));
  const nameOfFaction = (id) => factionNames[String(id)]
    || (id === 'player' ? '我军' : PANEL_CONF.factions?.neutral?.name || id);
  const threats = (Array.isArray(state.garrisons) ? state.garrisons : [])
    .filter((g) => !g.cleared)
    .map((g) => ({
      id: g.id, name: g.name || '来犯军',
      soldiers: Math.max(0, Math.round(Number(g.soldiers) || 0)),
      faction: g.faction || '', patrol: !!g.patrol,
    }));
  const events = (Array.isArray(st.events) ? st.events : []).slice(-8).reverse()
    .map((e) => ({ ...e, month: (e.turn || 0) + 1 }));
  const cityBrief = mapCities.map((c) => {
    const row = cityRows[c.id] || {};
    const troops = Math.max(0, Math.round(Number(row.troops) || 0));
    return {
      id: c.id, name: c.name, province: c.province, level: c.level,
      owner: row.owner || 'han', ownerName: nameOfFaction(row.owner || 'han'), troops,
      garrison: troops, // 兼容旧 UI 字段：已改为实时驻军，不再是拍脑袋估算
      agriculture: c.attrs?.农业 ?? null, commerce: c.attrs?.商业 ?? null,
      cityDef: c.attrs?.城防 ?? null,
      // 修 U06：特产/主要兵种在 map.json 顶层，attrs 里没有这两个键（旧写法恒空）。
      terrain: c.terrain || '', specialty: c.specialty || c.attrs?.特产 || '',
      arms: c.arms || c.attrs?.主要兵种 || '',
      reachable: reachable.has(Number(c.id)),
      // ★ P2/P3 城市经营（仅玩家城）：人口/城库/逐城日产/灾害状态
      ...(row.owner === 'player' ? (() => {
        const e = ensureCityEcon(state)?.[c.id];
        if (!e) return {};
        const y = cityYield(state, c.id);
        const mod = e.mod && Number(state.clock?.day) <= e.mod.until ? e.mod : null;
        return {
          pop: e.pop, store: e.store,
          yieldGrain: y?.grain || 0, yieldGold: y?.gold || 0,
          disaster: e.disaster || null,
          modLabel: mod ? (mod.grain < 1 ? '歉收中' : '丰产中') : '',
        };
      })() : {}),
      note: '守军取天下沙盘实时数据；出征仍受行军路段与关隘封锁限制',
    };
  });
  const chronicle = (Array.isArray(st.chronicle) ? st.chronicle : []).slice(-6).reverse();
  let books = [];
  try { books = chronicle.map((m) => ({ month: m.month, rows: booksOf(m.moves || []) })); }
  catch { books = []; }
  const plans = Object.entries(st.memory || {}).map(([fid, mem]) => {
    const goal = mem?.goal;
    if (!goal) return null;
    return {
      id: fid, name: factionNames[String(fid)] || fid,
      type: goal.type || '', targetName: goal.targetName || goal.target || '',
      reason: goal.reason || '', lockedUntil: goal.lockedUntil || 0,
    };
  }).filter(Boolean);

  return {
    ok: true,
    version: 1,
    day: int(state.clock?.day, 1),
    month: turnOf(state) + 1,
    turn: turnOf(state),
    roleName: state.role?.nickName || '主公',
    // ★ P4-①：举义状态随面板下发，客户端据此弹举义页 / 显示势力徽记
    oath: (function () {
      const o = oathOf(state);
      const f = oathFactionOf(state);
      const city = f ? strategyCity(o.city) : null;
      return {
        done: o.done !== false,
        lord: f?.id || null, lordName: f?.name || '', color: f?.color || '',
        traitName: f?.trait?.name || '', traitDesc: f?.trait?.desc || '',
        cityName: city?.name || '',
      };
    })(),
    generals,
    // ★ P6 俘虏名册：六府「武将」页招降入口（政治判定在 strategy.recruitCaptive，这里只展示）
    // 修 U08：降率与「成功率构成条」走 captive-rules.js 唯一公式，
    // 旧实现缺 rate 字段，界面显示「降率约 undefined%」。
    captives: (state.captives || []).map((c, i) => ({
      idx: i, name: c.name, from: c.from, loyal: c.loyal, days: c.days,
      star: cfg.generalByCfg.get(Number(c.cfgId))?.star ?? 0,
      rate: Math.round(captiveRecruitRate(state, c) * 100),
      rateParts: captiveRateParts(state, c),
    })),
    prospects,
    items,
    scrolls: scrollCount(state),
    library,
    librarySummary: {
      total: library.length,
      unlocked: library.filter((x) => x.status === 'unlocked').length,
      researching: library.filter((x) => x.status === 'researching').length,
      sourcesCovered: library.filter((x) => x.sources.length >= 2).length,
    },
    slots: PANEL_CONF.items.slots,
    statLabels: STAT_LABEL,
    redline: PANEL_CONF.items.redline,
    forgeCatalog: PANEL_CONF.items.items.map((i) => ({
      id: i.id, name: i.name, slot: i.slot, slotName: i.slotName,
      trait: i.trait, set: i.set, bonusPct: i.bonusPct, forge: i.forge,
    })),
    interior: {
      posts: PANEL_CONF.posts.posts.map((p) => ({
        ...p, generalId: Number(state.interior.posts[p.id]) || 0,
        generalName: generals.find((g) => g.id === Number(state.interior.posts[p.id]))?.name || '',
      })),
      constraints: { ...PANEL_CONF.posts.constraints, morale: state.interior.morale, order: state.interior.order, corruption: state.interior.corruption },
      visibleRule: PANEL_CONF.posts.visibleRule,
      proposals: proposalsFor(state),
      appliedThisTurn: state.interior.appliedTurn === turnOf(state) ? state.interior.appliedThisTurn : null,
      output: interiorOutput(state, cfg),
    },
    strategy: {
      chapter: int(state.campaign?.chapter, 1),
      ending: state.campaign?.ending || null,
      cityCount: myCities.length,
      totalCities: mapCities.length,
      soldiers: (state.armys || []).reduce((n, a) => n + (a.soldiers || []).reduce((m, x) => m + (Number(x) || 0), 0), 0),
      threats, events, cities: cityBrief,
      // ★ P0 编队：三槽=盾步/弓兵/骑兵，带武将名与适性（编队弹窗数据源）
      armies: (state.armys || []).map((a) => ({
        id: a.id, order: a.order, marching: !!a.marchId,
        soldiers: (a.soldiers || []).map((v) => Math.max(0, Math.floor(Number(v) || 0))),
        armsNames: [ARMS_NAMES[1], ARMS_NAMES[2], ARMS_NAMES[3]],
        generals: (a.generals || []).map((gid, i) => {
          const g = (state.generals || []).find((x) => x.id === gid);
          if (!g) return null;
          const gc = cfg.generalByCfg.get(Number(g.cfgId)) || {};
          return {
            id: g.id,
            name: gc.name || `武将${g.id}`,
            arms: ARMS_NAMES[i + 1] || '',
            apt: Math.round(armsApt({ force: gc.force, strategy: gc.strategy, defense: gc.defense }, i + 1) * 100),
            loyal: Math.round(g.loyal ?? 88),
          };
        }),
      })),
      allGenerals: (state.generals || []).map((g) => {
        const gc = cfg.generalByCfg.get(Number(g.cfgId)) || {};
        return { id: g.id, name: gc.name || `武将${g.id}` };
      }),
      marchable, gates, plans, chronicle, books,
      recentReports: (state.warReports || []).slice(-5).reverse(),
      note: '决策台只给数据，不替玩家决定；城池、实时守军、行军可达、关隘与诸侯战役意图均取自天下沙盘（战略层）同一份数据。',
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 动作（POST /__slg/panels/action）                                          */
/* -------------------------------------------------------------------------- */

/** 把「非装备来源的原有增量 + 当前装备加成」写回 *_added，不污染既有强化数值。 */
function recomputeEquip(state, g, bonus) {
  const base = state.panelBase[String(g.id)] || {};
  for (const k of EQUIP_KEYS) g[`${k}_added`] = (Number(base[k]) || 0) + (Number(bonus[k]) || 0);
}

function fail(message) { return { ok: false, message }; }
function done(message, extra = {}) { return { ok: true, message, ...extra }; }

/** 供 index.js 调用的写动作；全部显式改 state，调用方负责 save() 与回话。 */
export function panelAction(state, cfg, action = {}) {
  ensurePanels(state, cfg);
  const type = String(action.type || '');
  const gId = int(action.gId, 0);
  const g = (state.generals || []).find((x) => x.id === gId) || null;
  const needGeneral = () => { if (!g) throw new Error('找不到该武将'); };
  const base = g ? baseStats(cfg, g) : Object.fromEntries(EQUIP_KEYS.map((k) => [k, 0]));
  const applyEquip = () => {
    const bonus = equipBonusFor(base, state.equipment[String(gId)], state);
    recomputeEquip(state, g, bonus);
    return bonus;
  };

  try {
    if (type === 'equip') {
      needGeneral();
      const slot = String(action.slot || '');
      if (!SLOT_IDS.includes(slot)) return fail('未知装备槽');
      const row = (state.items || []).find((i) => Number(i.id) === int(action.itemId, -1));
      if (!row) return fail('府库里没有这件物品');
      const def = ITEM_BY_ID.get(Number(row.cfgId));
      if (!def || def.slot !== slot) return fail('这件物品不能装在该槽位');
      for (const [id, eq] of Object.entries(state.equipment)) {
        if (Number(id) !== gId && Number(eq[slot]) === Number(row.id)) return fail('该物品已由其他武将佩戴');
      }
      const old = state.equipment[String(gId)][slot];
      if (old) { const prev = (state.items || []).find((i) => Number(i.id) === Number(old)); if (prev) prev.ownerGeneralId = 0; }
      state.equipment[String(gId)][slot] = row.id;
      row.ownerGeneralId = gId;
      const bonus = applyEquip();
      return done(`${generalName(state, cfg, g)}装备了「${def.name}」`, { delta: bonus });
    }

    if (type === 'unequip') {
      needGeneral();
      const slot = String(action.slot || '');
      if (!SLOT_IDS.includes(slot)) return fail('未知装备槽');
      const old = Number(state.equipment[String(gId)][slot]) || 0;
      if (!old) return fail('该槽位本来就是空的');
      const row = (state.items || []).find((i) => Number(i.id) === old);
      if (row) row.ownerGeneralId = 0;
      state.equipment[String(gId)][slot] = 0;
      const bonus = applyEquip();
      return done('已卸下，无消耗', { delta: bonus });
    }

    if (type === 'forge') {
      const def = ITEM_BY_ID.get(int(action.cfgId, -1));
      if (!def) return fail('没有这张锻造配方');
      const cost = def.forge.cost;
      for (const [k, v] of Object.entries(cost)) {
        if ((Number(state.roleRes?.[k]) || 0) < v) return fail(`${RES_LABEL[k] || k}不足，需 ${v}`);
      }
      for (const [k, v] of Object.entries(cost)) state.roleRes[k] = (Number(state.roleRes[k]) || 0) - v;
      for (const [k, v] of Object.entries(cost)) recordRes(state, k, -v, `锻造「${def.name}」`);
      const id = Math.max(500000, ...(state.items || []).map((i) => Number(i.id) || 0)) + 1;
      state.items.push({ id, cfgId: def.id, kind: 'equip', count: 1, ownerGeneralId: 0, source: `锻造·${def.forge.drawing}`, forgedAt: int(state.clock?.day, 1) });
      return done(`「${def.name}」锻造完成（100% 成功，词条固定）`, { itemId: id });
    }

    if (type === 'dismantle') {
      const idx = (state.items || []).findIndex((i) => Number(i.id) === int(action.itemId, -1));
      if (idx < 0) return fail('物品不存在');
      const row = state.items[idx];
      if (row.ownerGeneralId) return fail('请先卸下再分解');
      const def = ITEM_BY_ID.get(Number(row.cfgId));
      const gain = def ? 120 : 20;
      const iron = (state.items || []).find((i) => Number(i.cfgId) === 400002);
      if (iron) iron.count = (Number(iron.count) || 0) + Math.ceil(gain / 40);
      else state.items.push({ id: Date.now(), cfgId: 400002, kind: 'material', count: Math.ceil(gain / 40), ownerGeneralId: 0, source: '分解', forgedAt: int(state.clock?.day, 1) });
      state.items.splice(idx, 1);
      return done(`已分解「${def?.name || '物品'}」，返还精铁（分解不可逆，已二次确认）`);
    }

    if (type === 'research') {
      const cfgId = int(action.cfgId, -1);
      const s = SKILL_BY_ID.get(cfgId);
      if (!s) return fail('战法不存在');
      if (state.skillbook.unlocked[String(cfgId)]) return fail('该战法已解锁');
      const rec = RECIPE_BY_ID.get(cfgId);
      const need = int(rec?.sources.find((x) => x.type === 'research')?.progressNeed, 100);
      const row = state.skillbook.research[String(cfgId)] || { progress: 0, need };
      const want = Math.max(1, int(action.amount, 10));
      const available = scrollCount(state);
      if (available <= 0) return fail('兵书残卷不足：打胜仗、守城、斩将可获残卷');
      const used = takeScrolls(state, Math.min(want, available));
      row.progress += used; row.need = need;
      state.skillbook.research[String(cfgId)] = row;
      if (row.progress >= need) {
        delete state.skillbook.research[String(cfgId)];
        state.skillbook.unlocked[String(cfgId)] = { level: 1, source: '战功研习' };
        return done(`「${s.ui?.name ?? s.name}」研习完成，已解锁`, { unlocked: true });
      }
      return done(`投入残卷 ${used}，研习进度 ${row.progress}/${need}`, { progress: row.progress, need });
    }

    if (type === 'learn') {
      needGeneral();
      const pos = int(action.pos, -1);
      const cfgId = int(action.cfgId, -1);
      const s = SKILL_BY_ID.get(cfgId);
      if (!s) return fail('战法不存在');
      const block = slotBlock(g, pos, 'replace');
      if (block) return fail(pos === 0 ? '自带战法不可替换' : pos === 1 ? '需 Lv5 解锁该槽' : '需 Lv20 且自带战法 10 级');
      if (!state.skillbook.unlocked[String(cfgId)]) return fail('该战法尚未解锁，请先到战法库查看获取途径');
      const by = equippedBy(state, cfgId).filter((id) => id !== gId);
      if (by.length >= 2) return fail('每条战法同时最多 2 人装配');
      g.skills[pos] = { id: cfgId, cfgId, lv: 1 };
      return done(`${generalName(state, cfg, g)}学会了「${s.ui?.name ?? s.name}」`);
    }

    if (type === 'appoint') {
      const post = String(action.post || '');
      const p = PANEL_CONF.posts.posts.find((x) => x.id === post);
      if (!p) return fail('未知岗位');
      const target = int(action.target, 0);
      if (target) {
        const g = (state.generals || []).find((x) => x.id === target);
        if (!g) return fail('找不到该武将');
        // ★ P4：岗位限制——职业的意义在岗位限制。军师/猛将不上内政岗。
        const fit = CAREER_FIT[careerOf(g).career];
        if (!fit.civilPost) {
          return fail(`${generalName(state, cfg, g)}是${CAREER_NAMES[careerOf(g).career]}（${careerOf(g).top}${careerOf(g).topVal}），${fit.note}，不宜掌${p.name}`);
        }
      }
      state.interior.posts[post] = target;
      return done(target ? `已委任 ${generalName(state, cfg, (state.generals || []).find((x) => x.id === target))} 掌${p.name}` : `已撤去${p.name}委任`, { output: interiorOutput(state, cfg) });
    }

    if (type === 'proposal') {
      const id = String(action.id || '');
      if (state.interior.appliedTurn === turnOf(state)) return fail('本回合已用过政令，下月再来');
      const p = proposalsFor(state).find((x) => x.id === id);
      if (!p) return fail('本回合没有这张提案');
      // 提案代价里的「-X 资源」统一折算为金/粮/木/政令的确定性扣减；不产生随机
      const cost = { amnesty: { gold: 500 }, farm: { gold: 600 }, levy: { grain: 800 }, repair: { wood: 800, iron: 400 }, audit: { decree: 2 } }[id] || {};
      for (const [k, v] of Object.entries(cost)) {
        if ((Number(state.roleRes?.[k]) || 0) < v) return fail(`${RES_LABEL[k] || k}不足，需 ${v}`);
      }
      for (const [k, v] of Object.entries(cost)) state.roleRes[k] -= v;
      for (const [k, v] of Object.entries(cost)) recordRes(state, k, -v, `政令「${p.name}」`);
      state.interior.appliedTurn = turnOf(state);
      state.interior.appliedThisTurn = id;
      if (id === 'levy') state.interior.morale = clamp(state.interior.morale - 8, 0, 100);
      if (id === 'amnesty') { state.interior.morale = clamp(state.interior.morale + 12, 0, 100); state.interior.order = clamp(state.interior.order + 6, 0, 100); }
      if (id === 'audit') state.interior.corruption = clamp(state.interior.corruption - 6, 0, 100);
      return done(`已颁行「${p.name}」：${p.effect}（${p.cost}，持续 ${p.turns} 回合）`, { output: interiorOutput(state, cfg) });
    }

    return fail(`未知动作：${type}`);
  } catch (err) {
    return fail(err?.message || String(err));
  }
}

/** 供单测与冒烟使用的只读自检：51 条战法是否都有 ≥2 条公开获取途径、且文本未被改写。 */
export function panelSelfCheck() {
  const conf = PANEL_CONF.recipes;
  const missing = conf.recipes.filter((r) => (r.sources || []).length < 2
    || !r.sources.some((s) => s.type === 'research')
    || r.sources.some((s) => !s.where || !s.cost || !s.detail));
  const mismatch = conf.recipes.filter((r) => {
    const s = SKILL_BY_ID.get(Number(r.cfgId));
    return !s || (s.ui?.name ?? s.name) !== r.name;
  });
  const overItem = PANEL_CONF.items.items.filter((i) =>
    Object.values(i.bonusPct || {}).some((v) => v > PANEL_CONF.items.redline.perItemPct));
  return {
    skillCount: conf.recipes.length,
    missing,
    mismatch,
    overItem,
    ok: missing.length === 0 && mismatch.length === 0 && overItem.length === 0,
  };
}
