/**
 * 太守制（P50 / 2026-11-23）：对齐业界成熟 SLG 的内政思路重构。
 *
 *   典型做法一：内政=给设施/岗位配人，配完自动涨——「配人」是核心操作；
 *   典型做法二：任务书+都市委任方针，玩家批方针、不批单；
 *   典型做法三：内政几乎全自动，玩家只任免太守、定方针，报告自动汇总。
 *
 * 本作落地（替换旧「长驻委任 + 手动逐项派单 + 物资任务」三套并行系统）：
 *  · 每座己方城一条太守记录 { officerId, officerName, policy, status, ... }；
 *  · 玩家唯一决策 = 任免太守 + 选方针，其余全自动；
 *  · 旬界 governorTick：有灾自动赈济 → 按方针优先序自动办理真实内政任务
 *    （走 interior-task.beginInteriorTask，与旧手动派单同源同价同工期，总产出不变）；
 *  · 缺金暂停置顶、金到位自动续办、失城中止（沿用旧委任的硬规则）；
 *  · 太守在城则由太守本人办理（归因写太守），太守出征/空缺退回驻城最高属性者，
 *    再退「太守亲办」基准工期 ×1.5；
 *  · 旧档 st.appointments 自动迁移为太守记录（一次性，goal→policy 映射）。
 *
 * 硬约束：只 import interior-task（其本身只依赖 economy/oath/general-stat 叶子），无环；
 * 确定性：不掷骰、不用 Math.random；同一 state 重放得到同样的太守决策。
 */

import { beginInteriorTask, interiorTasks, officerStat, KINDS } from './interior-task.js';
import { policyEffect } from './policy-effects.js';

/** 城方针（玩家可见六选一）。
 *  ★ P61-S1：方针不再只是施工顺序——同时决定资源配比与互斥工程，
 *  说明文字直接取 policy-effects 的同一份，玩家看到什么就真执行什么。 */
export const POLICIES = Object.fromEntries(Object.entries({
  auto: {
    label: '太守自决', order: ['populate', 'agri', 'trade', 'barracks', 'defense'],
    desc: '按民生→农→商→兵→防自动补短板',
  },
  agri: { label: '重农', order: ['agri', 'populate', 'trade'], desc: '优先开垦农田，兼顾民生与市集' },
  trade: { label: '重商', order: ['trade', 'populate', 'agri'], desc: '优先招商兴市，兼顾民生与农田' },
  military: { label: '强兵', order: ['barracks', 'defense', 'populate'], desc: '优先募兵整编，兼顾城防与民生' },
  defense: { label: '固防', order: ['defense', 'barracks', 'populate'], desc: '优先修筑城防，兼顾兵营与民生' },
  civil: { label: '安民', order: ['populate', 'agri', 'trade'], desc: '优先劝课生息，兼顾农桑商务' },
}).map(([key, p]) => {
  const e = policyEffect(key);
  return [key, { ...p, forbid: e.forbid, effectNote: e.note }];
}));

const clamp = (v) => Math.max(0, Math.trunc(Number(v) || 0));
const dayOf = (state) => Math.max(1, Math.floor(Number(state?.clock?.day) || 1));

function recordEvent(state, text) {
  const st = state?.strategy;
  if (!st) return;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

function pushChat(ctx, msg) {
  ctx?.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg, time: Date.now() });
}

/** 太守记录表（挂在 state.strategy.governors，键为城 id；旧档自动补空表）。 */
export function governors(state) {
  const st = state?.strategy;
  if (!st) return {};
  if (!st.governors || typeof st.governors !== 'object') st.governors = {};
  return st.governors;
}

/** 旧档迁移：st.appointments（长驻委任）→ 太守记录，一次性。 */
function migrateAppointments(state) {
  const st = state?.strategy;
  if (!st || st.appointmentsMigrated) return;
  st.appointmentsMigrated = true;
  const old = Array.isArray(st.appointments) ? st.appointments : [];
  const goalMap = { develop: 'auto', recruit: 'military', defend: 'defense' };
  for (const a of old) {
    if (!a || (a.status !== 'running' && a.status !== 'blocked')) continue;
    const id = Number(a.cityId);
    if (!id || governors(state)[id]) continue;
    const row = st.cities?.[id];
    if (!row || row.owner !== 'player') continue;
    governors(state)[id] = {
      officerId: Number(a.officerId) || 0,
      officerName: a.officerName || '',
      policy: goalMap[a.goal] || 'auto',
      status: a.status === 'blocked' ? 'blocked' : 'running',
      blockedReason: a.status === 'blocked' ? '缺金' : null,
      doneCount: Number(a.doneCount) || 0,
      startDay: Number(a.startDay) || dayOf(state),
      migrated: true,
    };
    recordEvent(state, `${row.name || `城${id}`}：旧委任已换算为太守制（方针：${POLICIES[goalMap[a.goal] || 'auto']?.label || '太守自决'}）。`);
  }
}

/** 为每座己方城补默认太守记录（方针=太守自决、无太守），不弹事件（静默初始化）。 */
function ensureGovernors(state) {
  migrateAppointments(state);
  const st = state.strategy;
  const day = dayOf(state);
  for (const [id, row] of Object.entries(st.cities || {})) {
    if (!row || row.owner !== 'player') continue;
    const cid = Number(id);
    if (!governors(state)[cid]) {
      governors(state)[cid] = {
        officerId: 0, officerName: '', policy: 'auto',
        status: 'running', blockedReason: null, doneCount: 0, startDay: day,
      };
    }
  }
}

/** 城内政执行者：优先太守本人（在城、非行军），否则返回 null 交给 pickOfficer 兜底。 */
function governorOfficer(state, cfg, cid, statKey) {
  const gv = governors(state)[cid];
  const oid = Number(gv?.officerId) || 0;
  if (!oid) return null;
  const g = (state.generals || []).find((x) => Number(x.id) === oid);
  if (!g) return null;
  const marching = (state.armys || []).some((a) => a.marchId && (a.generals || []).includes(oid));
  if (marching) return null;
  const name = cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || `武将${g.id}`;
  return { id: g.id, name, stat: Math.round(officerStat(cfg, g, statKey)) };
}

/** 太守展示形态（城内页 / 六府总览共用同一口径）。 */
export function governorView(state, cfg, cityId) {
  const st = state.strategy;
  const cid = Number(cityId);
  const gv = governors(state)[cid];
  const row = st?.cities?.[cid];
  if (!gv || !row) return null;
  const P = POLICIES[gv.policy] || POLICIES.auto;
  const active = interiorTasks(state)
    .filter((t) => t.status === 'active' && Number(t.cityId) === cid)
    .map((t) => ({ kind: t.kind, label: KINDS[t.kind]?.label || t.kind, endDay: t.startDay + t.ticks * 10 }));
  const officerG = (state.generals || []).find((x) => Number(x.id) === Number(gv.officerId));
  return {
    cityId: cid,
    city: row.name || `城${cid}`,
    officerId: Number(gv.officerId) || 0,
    officer: gv.officerName || '',
    officerStat: officerG ? Math.round(officerStat(cfg, officerG, 'politics')) : 0,
    policy: POLICIES[gv.policy] ? gv.policy : 'auto',
    policyLabel: P.label,
    policyDesc: P.desc,
    /* ★ P61-S1：方针的真实收益与停工项必须和玩家看到的一致 */
    policyEffect: P.effectNote,
    forbid: (P.forbid || []).map((k) => KINDS[k]?.label || k),
    status: gv.status === 'blocked' ? 'blocked' : 'running',
    blockedReason: gv.blockedReason || null,
    doneCount: Number(gv.doneCount) || 0,
    active,
  };
}

/** 全部己方城太守总览（按城 id 升序）。 */
export function governorListView(state, cfg) {
  ensureGovernors(state);
  return Object.keys(state.strategy.cities || {})
    .map((id) => governorView(state, cfg, Number(id)))
    .filter(Boolean)
    .sort((a, b) => a.cityId - b.cityId);
}

/**
 * 太守候选：己方武将，排除行军中、他城太守、六府在岗者。
 * 政治降序 → 忠诚降序 → id 升序（重放一致）。主角可手工任命，但一键补任不占主角。
 */
export function governorCandidates(state, cfg, cityId = 0) {
  const cid = Number(cityId) || 0;
  const taken = new Set();          // 他城太守
  const posting = new Set(          // 六府岗位在编
    Object.values(state.interior?.posts || {}).map(Number).filter((v) => v > 0),
  );
  const gvAll = governors(state);
  for (const [id, gv] of Object.entries(gvAll)) {
    const oid = Number(gv?.officerId) || 0;
    if (oid && Number(id) !== cid) taken.add(oid);
  }
  const marching = new Set();
  for (const a of state.armys || []) if (a.marchId) for (const gid of a.generals || []) if (gid) marching.add(Number(gid));
  return (state.generals || [])
    .filter((g) => !marching.has(Number(g.id)))
    .filter((g) => !taken.has(Number(g.id)))
    .filter((g) => !posting.has(Number(g.id)))
    .map((g) => ({
      id: Number(g.id),
      name: cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || g.name || `武将${g.id}`,
      politics: Math.round(officerStat(cfg, g, 'politics')),
      loyal: Math.round(Number(g.loyal) || 0),
      isProtagonist: !!g.isProtagonist,
    }))
    .sort((a, b) => b.politics - a.politics || b.loyal - a.loyal || a.id - b.id);
}

/**
 * 任免太守 / 改方针（同一入口，body 里给了什么就改什么）。
 * officerId=0 表示撤任（在施任务照常推进）。
 * reason: not_own_city / bad_policy / no_general / marching / busy_elsewhere
 */
export function governorSet(state, cfg, ctx, { cityId, officerId, policy } = {}) {
  const st = state?.strategy;
  const cid = Number(cityId);
  const row = st?.cities?.[cid];
  if (!row || row.owner !== 'player') return { ok: false, reason: 'not_own_city' };
  ensureGovernors(state);
  const gv = governors(state)[cid];

  if (policy != null && policy !== '') {
    if (!POLICIES[policy]) return { ok: false, reason: 'bad_policy' };
    if (gv.policy !== policy) {
      gv.policy = policy;
      gv.status = 'running';
      gv.blockedReason = null;
      recordEvent(state, `${row.name || `城${cid}`}方针改为「${POLICIES[policy].label}」：${POLICIES[policy].desc}。`);
      pushChat(ctx, `【内政】${row.name || `城${cid}`}方针改为「${POLICIES[policy].label}」。`);
    }
  }

  if (officerId != null) {
    const oid = clamp(officerId);
    if (oid) {
      const g = (state.generals || []).find((x) => Number(x.id) === oid);
      if (!g) return { ok: false, reason: 'no_general' };
      if ((state.armys || []).some((a) => a.marchId && (a.generals || []).includes(oid))) {
        return { ok: false, reason: 'marching' };
      }
      for (const [otherId, other] of Object.entries(governors(state))) {
        if (Number(otherId) !== cid && Number(other?.officerId) === oid) {
          return { ok: false, reason: 'busy_elsewhere', cityId: Number(otherId) };
        }
      }
      const name = cfg?.generalByCfg?.get?.(Number(g.cfgId))?.name || `武将${g.id}`;
      gv.officerId = oid;
      gv.officerName = name;
      recordEvent(state, `${row.name || `城${cid}`}太守任命为${name}：内政由太守按方针自动办理。`);
      pushChat(ctx, `【内政】${row.name || `城${cid}`}太守任命为${name}。`);
    } else if (gv.officerId) {
      recordEvent(state, `${row.name || `城${cid}`}太守${gv.officerName ? `（${gv.officerName}）` : ''}撤任：由太守亲办（工期 ×1.5）。`);
      gv.officerId = 0;
      gv.officerName = '';
    }
  }
  return { ok: true, governor: governorView(state, cfg, cid) };
}

/** 一键补任空缺太守（全部己方城或指定城）；政治最高者优先，同分忠诚、id 兜底。 */
export function governorAutoFill(state, cfg, ctx, { cityId } = {}) {
  ensureGovernors(state);
  const st = state.strategy;
  const want = cityId ? [Number(cityId)] : null;
  const filled = [];
  for (const [id, row] of Object.entries(st.cities || {})) {
    if (!row || row.owner !== 'player') continue;
    const cid = Number(id);
    if (want && !want.includes(cid)) continue;
    const gv = governors(state)[cid];
    if (!gv || (Number(gv.officerId) || 0)) continue;
    const cand = governorCandidates(state, cfg, cid).filter((g) => !g.isProtagonist);
    if (!cand.length) continue;
    const pick = cand[0];
    const r = governorSet(state, cfg, ctx, { cityId: cid, officerId: pick.id });
    if (r.ok) filled.push({ cityId: cid, city: row.name || `城${cid}`, officer: pick.name, politics: pick.politics });
  }
  if (filled.length) {
    pushChat(ctx, `【内政】一键补任太守：${filled.map((f) => `${f.city}→${f.officer}`).join('、')}。`);
  }
  return { ok: true, filled, remaining: governorListView(state, cfg).filter((g) => !g.officerId).length };
}

/**
 * 旬界推进（cityEconTick 每 10 日调用）：
 *  ① 有灾自动开仓赈济（应急不等旬）；
 *  ② 按方针优先序，给第一个「无在施任务」的项目派单（同源 beginInteriorTask）；
 *  ③ 缺金 → blocked 置顶；金到位自动续办；失城中止。
 * 返回 { started, blocked, resumed, ended } 供回合报告引用。
 */
export function governorTick(state, cfg, ctx) {
  ensureGovernors(state);
  const st = state.strategy;
  const out = { started: [], blocked: [], resumed: [], ended: [] };
  for (const [id, row] of Object.entries(st.cities || {})) {
    const cid = Number(id);
    const gv = governors(state)[cid];
    if (!gv) continue;
    // 城丢失 → 委任/太守中止（硬规则：城失即止，写一条留痕）
    if (!row || row.owner !== 'player') {
      if (gv.status === 'running' || gv.status === 'blocked') {
        gv.status = 'done';
        gv.blockedReason = '城失';
        recordEvent(state, `${row?.name || `城${cid}`}失城，太守办政中止。`);
        out.ended.push(governorView(state, cfg, cid));
      }
      continue;
    }
    const e = st.cityEcon?.[cid];
    if (!e) continue;

    // 有灾自动赈济：只在真实减产（grain<1 的 mod）在施时开仓——丰收（grain 1.5）
    // 与纯记录性的 disaster 不赈，避免把加成赈没了或反复空耗库金
    if (e.mod && Number(e.mod.grain) < 1 && KINDS.relief) {
      beginInteriorTask(state, cfg, ctx, {
        cityId: cid, kind: 'relief',
        officerId: Number(gv.officerId) || 0,
      });
    }

    const P = POLICIES[gv.policy] || POLICIES.auto;
    const activeKinds = new Set(
      interiorTasks(state).filter((t) => t.status === 'active' && Number(t.cityId) === cid).map((t) => t.kind),
    );
    for (const kind of P.order) {
      if (kind === 'relief' || activeKinds.has(kind)) continue;
      /* ★ P61-S1：方针互斥——重农不练兵、固防商税减半、重商不修城。
         玩家选方针时就能看到停工项，不再所有项目最终都做完。 */
      if (Array.isArray(P.forbid) && P.forbid.includes(kind)) continue;
      const r = beginInteriorTask(state, cfg, ctx, {
        cityId: cid, kind, officerId: Number(gv.officerId) || 0,
      });
      if (r.ok) {
        gv.doneCount = (Number(gv.doneCount) || 0) + 1;
        if (gv.status === 'blocked') {
          gv.status = 'running';
          gv.blockedReason = null;
          recordEvent(state, `${row.name || `城${cid}`}太守恢复办政：库金到位，续办${KINDS[kind]?.label || ''}。`);
          out.resumed.push(governorView(state, cfg, cid));
        }
        const v = governorView(state, cfg, cid);
        if (v) out.started.push(v);
        break;                          // 每城每旬至多新开一单（有灾赈济另计）
      }
      if (r.reason === 'no_gold') {
        if (gv.status !== 'blocked') {
          gv.status = 'blocked';
          gv.blockedReason = '缺金';
          recordEvent(state, `${row.name || `城${cid}`}太守暂停：库金不足（${KINDS[kind]?.label || ''}需 ${KINDS[kind]?.cost || 0} 金），金到位自动续办。`);
          out.blocked.push(governorView(state, cfg, cid));
        }
        break;                          // 缺金不再尝试别的项目
      }
      // busy/cooldown 等其它原因：换下一项尝试
    }
  }
  return out;
}
