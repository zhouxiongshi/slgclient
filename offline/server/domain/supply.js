/**
 * 粮道与断粮（U20）。
 *
 * 规则（写进游戏内说明，不做隐藏惩罚）：
 *  - 粮道 = 从该城出发，沿**己方城池**与**未封锁关隘**能走到都城的路径；
 *    走不到＝断粮（`supplyCut`）。草原上孤悬的飞地不再是「无代价收益」。
 *  - 断粮城每旬：民心 −3、治安 −1、守军逃散 2%、粮产 ×0.55（金产不受影响，商路不同）。
 *  - 断粮解除后下一旬自动恢复，不做二次惩罚。
 *
 * 依赖方向：supply → march（只读路网）+ economy（记账）。city-econ 引本模块做旬结算，
 * 本模块**不** import city-econ / strategy，避免成环。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canMarchBetween } from './march.js';
/* ★ M2-3：粮耗口径走全局参数表（knobs.js 零依赖，无环） */
import { knobGet } from './knobs.js';

/* 城名只读 map.json（与 city-econ / tavern 同一口径）。本模块不能 import city-econ，
   否则 city-econ → supply → city-econ 成环。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let CITY_NAMES = null;
function cityName(id) {
  if (!CITY_NAMES) {
    try {
      const m = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json'), 'utf8'));
      CITY_NAMES = new Map((m.cities || []).map((c) => [Number(c.id), c.name]));
    } catch { CITY_NAMES = new Map(); }
  }
  return CITY_NAMES.get(Number(id)) || `城${id}`;
}

/** 事件簿追加（同 strategy.recordEvent 的形状）。本模块不 import strategy，防止成环。 */
function recordEvent(state, text) {
  const st = state?.strategy;
  if (!st) return;
  if (!Array.isArray(st.events)) st.events = [];
  st.events.push({ turn: st.turn, text, day: state.clock?.day ?? 0 });
  while (st.events.length > 480) st.events.shift();
}

export { cityName as supplyCityName };

/** 己方城之间的粮道邻接（一次 BFS 复用，避免逐城重复算路）。
 *  ★ M2 L2：接受 factionId（玩家 / 诸侯），军级补给线与城级共用同一张图。 */
function ownedAdjacency(state, factionId = 'player') {
  const st = state?.strategy;
  const owned = Object.entries(st?.cities || {})
    .filter(([, v]) => v && v.owner === factionId)
    .map(([id]) => Number(id));
  const adj = new Map(owned.map((id) => [id, []]));
  for (let i = 0; i < owned.length; i += 1) {
    for (let j = i + 1; j < owned.length; j += 1) {
      const a = owned[i];
      const b = owned[j];
      const r = canMarchBetween(a, b);
      if (r.ok) {
        adj.get(a).push({ to: b, km: routeKm(r.path), via: r.via || [] });
        adj.get(b).push({ to: a, km: routeKm(r.path), via: (r.via || []).slice().reverse() });
      }
    }
  }
  return { adj, owned };
}

/** 路径里程估算：无 km 表时按每段 100 里兜底（只用于展示，不参与结算）。 */
function routeKm(path) {
  if (!Array.isArray(path) || path.length < 2) return 0;
  return (path.length - 1) * 100;
}

/**
 * 全图粮道（以都城为根做 BFS）。
 * 返回 { capital, byCity: { [cityId]: {connected, hops, km, via, path} }, isolated: [...] }
 */
export function supplyMap(state) {
  const st = state?.strategy;
  const capital = Number(st?.playerCity) || 0;
  const { adj, owned } = ownedAdjacency(state);
  const byCity = {};
  for (const id of owned) {
    byCity[id] = { connected: owned.includes(capital) ? id === capital : false, hops: 0, km: 0, via: [], path: [id] };
  }
  if (!capital || !owned.includes(capital)) {
    // 都城丢了：不做断粮惩罚（正处在亡国流程里，再加一层衰减只会让玩家莫名其妙）
    for (const id of owned) byCity[id] = { connected: true, hops: 0, km: 0, via: [], path: [id], exempt: true };
    return { capital, byCity, isolated: [], exempt: true };
  }
  const dist = new Map([[capital, { hops: 0, km: 0, path: [capital] }]]);
  const queue = [capital];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of adj.get(cur) || []) {
      if (dist.has(e.to)) continue;
      const prev = dist.get(cur);
      dist.set(e.to, { hops: prev.hops + 1, km: prev.km + e.km, path: [...prev.path, e.to] });
      queue.push(e.to);
    }
  }
  const isolated = [];
  for (const id of owned) {
    const d = dist.get(id);
    if (d) {
      byCity[id] = { connected: true, hops: d.hops, km: d.km, via: d.path.slice(1, -1), path: d.path };
    } else {
      byCity[id] = { connected: false, hops: -1, km: -1, via: [], path: [id], reason: 'no_owned_path' };
      isolated.push(id);
    }
  }
  return { capital, byCity, isolated };
}

/** 单城粮道（界面/出征预览用）。 */
export function supplyFor(state, cityId) {
  const m = supplyMap(state);
  return { capital: m.capital, ...(m.byCity[Number(cityId)] || { connected: false, hops: -1, km: -1, via: [] }) };
}

/**
 * 出征粮道预估：出发城城库存粮能支撑多少日。
 * dailyUse 与 strategy.js 的出发粮口径一致（每兵每 10 日 1 粮 → 0.1/兵/日）。
 */
export function marchSupplyEstimate(state, fromCityId, soldiers, days = 1) {
  const st = state?.strategy;
  const e = st?.cityEcon?.[Number(fromCityId)];
  const supply = supplyFor(state, fromCityId);
  const store = Number(e?.store) || 0;
  const perSoldier = knobGet(state, 'grainPerSoldierDay') ?? 0.1;
  const daily = Math.max(perSoldier, (Number(soldiers) || 0) * perSoldier);
  const daysCanHold = Math.floor(store / daily);
  return {
    fromCityId: Number(fromCityId),
    connected: supply.connected,
    hops: supply.hops,
    km: supply.km,
    via: supply.via,
    store,
    dailyNeed: Math.round(daily * 10) / 10,
    daysCanHold,
    enough: daysCanHold >= Math.max(1, Number(days) || 1),
    note: supply.connected
      ? `粮道通（${supply.hops} 跳 · 约 ${supply.km} 里）`
      : '粮道断绝：出发城与都城之间没有己方通路，出征后无法补给',
  };
}

/**
 * ★ M2 粮道 L2：军级补给线（GDD §5.3，玩家与 NPC 共用同一函数——§9.4 同函数判据）。
 *
 * 口径（写死，与城级 L1 一致的确定性判定）：
 *  - 补给节点 = 己方城（cityEcon.store > 0）。本沙盘关隘不可占领（gateStatus 只有
 *    通行/封锁，无归属字段），「路径未被敌方控制」由己方图 BFS 天然保证：
 *    ownedAdjacency 只在己方城之间连边，敌城/封锁关隘根本进不了图。
 *  - 部队锚点 = 行军行的出发城（march.from）。锚点失守 → 补给断。
 *  - 需求 = 0.1 粮/兵/旬（与出征粮 GRAIN_PER_TROOP 同一单兵口径）。
 */
export function supplyLineForArmy(state, factionId, march) {
  const st = state?.strategy;
  const fid = String(factionId || '');
  if (!st || !fid) return { connected: false, reason: 'no_faction' };
  const anchor = Number(march?.from) || 0;
  const row = st.cities[anchor];
  if (!row || row.owner !== fid) return { connected: false, reason: 'from_lost', anchor };
  const econ = st.cityEcon || {};
  const storeOf = (id) => Math.max(0, Math.floor(Number(econ[id]?.store) || 0));
  const need = Math.round((Number(march?.troops) || 0) * (knobGet(state, 'grainPerSoldierDay') ?? 0.1));
  if (storeOf(anchor) > 0) {
    return { connected: true, nodeId: anchor, hops: 0, store: storeOf(anchor), need, anchor };
  }
  const { adj } = ownedAdjacency(state, fid);
  // BFS：最近的 store>0 己方城即补给节点（先到先得，同跳数按邻接顺序，确定性）
  const dist = new Map([[anchor, { hops: 0, path: [anchor] }]]);
  const queue = [anchor];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of adj.get(cur) || []) {
      if (dist.has(e.to)) continue;
      const prev = dist.get(cur);
      const d = { hops: prev.hops + 1, path: [...prev.path, e.to] };
      dist.set(e.to, d);
      if (storeOf(e.to) > 0) {
        return { connected: true, nodeId: e.to, hops: d.hops, store: storeOf(e.to), path: d.path, need, anchor };
      }
      queue.push(e.to);
    }
  }
  return { connected: false, reason: 'no_supply_node', anchor };
}

/**
 * ★ M2 每旬军粮结算（由 cityEconTick 在旬界调用；GDD §5.3 断粮惩罚链的军级部分）：
 *  - 通畅：就地取粮，0.1 粮/兵 扣补给节点城库；
 *  - 断绝：第 1 旬警告（附带两个可执行应对——运输队 / 撤军），第 3 旬起逃兵 2%/旬；
 *  - 玩家与 NPC 同一入口（march.side/factionId 区分归属，同一判定、同一惩罚）。
 *  运输队（kind:'transport'）本身就是补给动作，不吃补给判定。
 */
export function armySupplyTick(state, ctx) {
  const st = state?.strategy;
  if (!st || !Array.isArray(st.marches)) return { fed: [], cut: [] };
  const fed = [];
  const cut = [];
  for (const mm of st.marches) {
    if (mm.resolved || mm.kind === 'transport') continue;
    const fid = mm.side === 'player' ? 'player' : String(mm.factionId || '');
    if (!fid) continue;
    const line = supplyLineForArmy(state, fid, mm);
    if (line.connected) {
      const e = st.cityEcon?.[line.nodeId];
      const need = Math.round((Number(mm.troops) || 0) * (knobGet(state, 'grainPerSoldierDay') ?? 0.1));
      if (e && need > 0) e.store = Math.max(0, Math.floor(Number(e.store) || 0) - need);
      if ((Number(mm.supplyCutDays) || 0) > 0) {
        recordEvent(state, `${cityName(mm.from)}方向的部队补给恢复，士心安。`);
        mm.supplyCutDays = 0;
      }
      mm.supplyOk = true;
      mm.supplyNode = line.nodeId;
      fed.push({ marchId: mm.id, side: mm.side, nodeId: line.nodeId, need });
      continue;
    }
    mm.supplyOk = false;
    mm.supplyCutDays = (Number(mm.supplyCutDays) || 0) + 10;
    const troopsBefore = Math.max(0, Math.round(Number(mm.troops) || 0));
    let deserters = 0;
    if (mm.supplyCutDays >= 30 && troopsBefore > 0) {
      deserters = Math.max(1, Math.ceil(troopsBefore * 0.02));
      mm.troops = Math.max(0, troopsBefore - deserters);
    }
    const sideName = mm.side === 'player' ? '我军' : `${mm.factionName || '诸侯'}军`;
    if (mm.supplyCutDays === 10) {
      const msg = `【粮道】${sideName}自${cityName(mm.from)}出征${cityName(mm.to)}的部队补给线断绝。`
        + '应对：派运输队送粮续命，或撤军回城——第 3 旬起士卒开始逃散。';
      recordEvent(state, msg);
      ctx?.push?.('chat.push', { rid: 0, nickName: '系统', type: 0, msg, time: Date.now() });
    } else if (deserters > 0) {
      recordEvent(state, `${sideName}补给断绝第 ${mm.supplyCutDays / 10} 旬，逃兵 ${deserters}。`);
    }
    cut.push({ marchId: mm.id, side: mm.side, days: mm.supplyCutDays, deserters });
  }
  return { fed, cut };
}

/**
 * 每旬结算（由 cityEconTick 调用）。返回 { isolated, recovered, hits }。
 * 断粮惩罚写在该城经营对象上：supplyCut / supplyDays。
 */
export function supplyTick(state, cfg, ctx) {
  const st = state?.strategy;
  const econ = st?.cityEcon;
  if (!st || !econ) return { isolated: [], recovered: [], hits: [] };
  const map = supplyMap(state);
  const hits = [];
  const isolated = [];
  const recovered = [];
  for (const [idStr, e] of Object.entries(econ)) {
    const id = Number(idStr);
    if (st.cities?.[id]?.owner !== 'player') continue;
    const s = map.byCity[id];
    if (!s || s.exempt) continue;
    if (s.connected) {
      if (e.supplyCut) {
        e.supplyCut = false;
        e.supplyDays = 0;
        recovered.push(id);
        recordEvent(state, `${cityName(id)}粮道恢复，民心回升。`);
      }
      continue;
    }
    e.supplyCut = true;
    e.supplyDays = (Number(e.supplyDays) || 0) + 10;
    const moraleBefore = Number(e.morale ?? 60);
    e.morale = Math.max(0, Math.round((moraleBefore - 3) * 10) / 10);
    e.order = Math.max(0, Math.round((Number(e.order ?? 60) - 1) * 10) / 10);
    const row = st.cities[id];
    const troopsBefore = Number(row.troops) || 0;
    row.troops = Math.round(troopsBefore * 0.98);          // 守军逃散 2%/旬
    const cn = cityName(id);
    hits.push({
      cityId: id, city: cn, morale: Math.round(e.morale), order: Math.round(e.order),
      troopsLost: troopsBefore - row.troops, days: e.supplyDays,
    });
    isolated.push(id);
    recordEvent(state, `${cn}粮道断绝（第 ${e.supplyDays} 日）：民心 −3、治安 −1、守军逃散 ${troopsBefore - row.troops}。`);
  }
  if (hits.length && ctx?.push) {
    ctx.push('chat.push', {
      rid: 0, nickName: '系统', type: 0,
      msg: `【粮道】${hits.map((h) => h.city).join('、')}与都城之间没有己方通路：民心下滑、守军逃散。`
        + '连回本土或放弃飞地，二选一。',
      time: Date.now(),
    });
  }
  return { isolated, recovered, hits };
}
