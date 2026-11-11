/**
 * 诸侯战役规划。
 *
 * 不是模型，也不直接改世界。每个月只做三件事：
 *   1. 看自己真知道的局面（兵力、行军、盟约、上月胜负、丢城）；
 *   2. 维持一个锁住的战役目标，没到期、目标还在，就不换；
 *   3. 只编译执行层能走通的指令。打不下来、走不到、盟友，本月就不发兵。
 *
 * 人格轴决定「敢不敢打、打输几次才换目标、愿不愿意结盟」，
 * 不决定所有人去打同一座分最高的城。
 */
import { canMarchBetween, marchableNeighbors } from './march.js';
import { quoteMarch } from './strategy-log.js';

export const PERSONA_AXES = {
  曹操: { aggression: 0.65, economy: 0.60, risk: 0.50, tempo: 0.70, defense: 0.55 },
  袁绍: { aggression: 0.35, economy: 0.90, risk: 0.30, tempo: 0.25, defense: 0.65 },
  吕布: { aggression: 0.95, economy: 0.20, risk: 0.85, tempo: 0.90, defense: 0.20 },
  孙权: { aggression: 0.30, economy: 0.70, risk: 0.25, tempo: 0.35, defense: 0.90 },
  刘备: { aggression: 0.45, economy: 0.75, risk: 0.35, tempo: 0.45, defense: 0.60 },
  司马懿: { aggression: 0.55, economy: 0.65, risk: 0.20, tempo: 0.20, defense: 0.85 },
  董卓: { aggression: 0.80, economy: 0.25, risk: 0.75, tempo: 0.75, defense: 0.30 },
  公孙瓒: { aggression: 0.85, economy: 0.35, risk: 0.70, tempo: 0.95, defense: 0.35 },
};

function blankMemory() {
  return { goal: null, fails: {}, losses: [], grudges: {} };
}

export function readBrainMemory(state, factionId) {
  return state?.strategy?.memory?.[factionId] || blankMemory();
}

export function commitBrainGoal(state, factionId, goal) {
  if (!state.strategy) state.strategy = {};
  if (!state.strategy.memory) state.strategy.memory = {};
  const mem = state.strategy.memory[factionId] || (state.strategy.memory[factionId] = blankMemory());
  mem.goal = goal ? {
    type: goal.type,
    target: goal.target || '',
    lockedUntil: goal.lockedUntil,
    reason: goal.reason || '',
    from: goal.from || '',
    fromName: goal.fromName || '',
    targetName: goal.targetName || '',
  } : null;
  return mem;
}

/** 执行层回报：记下打输几次、谁夺了自己的城。 */
export function noteBattleOutcome(state, factionId, { cityId, ok, victim }) {
  if (!state.strategy) return;
  if (!state.strategy.memory) state.strategy.memory = {};
  const mem = state.strategy.memory[factionId] || (state.strategy.memory[factionId] = blankMemory());
  const key = String(cityId);
  if (ok) mem.fails[key] = 0;
  else mem.fails[key] = (mem.fails[key] || 0) + 1;
  if (victim && victim !== factionId && victim !== 'han' && victim !== 'player') {
    // 自己是进攻方，不在这里记仇
  }
}

export function noteCityLost(state, loserId, cityId, by) {
  if (!loserId || loserId === 'han' || loserId === 'player' || loserId === by) return;
  if (!state.strategy) return;
  if (!state.strategy.memory) state.strategy.memory = {};
  const mem = state.strategy.memory[loserId] || (state.strategy.memory[loserId] = blankMemory());
  mem.losses.push({ cityId: Number(cityId), turn: state.strategy.turn || 0, by });
  while (mem.losses.length > 8) mem.losses.shift();
  mem.grudges[by] = (mem.grudges[by] || 0) + 2;
  if (mem.goal && String(mem.goal.target) === String(cityId)) mem.goal = null;
}

function seasonOf(turn) {
  const m = (Math.max(1, Number(turn) || 1) - 1) % 12;
  return ['春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬', '冬', '冬'][m];
}

function axesOf(persona) {
  return PERSONA_AXES[persona] || PERSONA_AXES.曹操;
}

/**
 * @returns 与 slg-ai-orders-v1 同形的指令单。不写 state。
 */
export function planCampaign(faction, snapshot, state) {
  const axes = axesOf(faction.persona || faction.name);
  const mem = readBrainMemory(state, faction.id);
  const view = buildView(faction, snapshot, state, axes, mem);
  const goal = livingGoal(mem.goal, view) || chooseGoal(view);
  const orders = compile(goal, view);
  const internal = orders.filter((o) => o.id.startsWith('I'));
  const strategy = orders.filter((o) => o.id.startsWith('S'));
  return {
    protocol: 'slg-ai-orders-v1',
    turn: view.turn,
    season: snapshot.season && snapshot.season !== '春秋' ? snapshot.season : seasonOf(view.turn),
    faction: faction.id,
    personality: faction.persona || faction.name,
    difficulty: 'normal',
    seed: snapshot.seed ?? state?.seed ?? 20261110,
    goal: {
      type: goal.type,
      target: goal.target || '',
      locked_until: goal.lockedUntil,
      reason: [goal.reason],
      from: goal.from || '',
      fromName: goal.fromName || '',
      targetName: goal.targetName || '',
    },
    internal_orders: internal,
    strategy_orders: strategy,
    explain: [[goal.reason, 1]],
  };
}

function buildView(faction, snapshot, state, axes, mem) {
  const cities = (snapshot.cities || []).map((c) => ({
    id: Number(c.id),
    name: c.name,
    owner: c.owner,
    troops: Number(c.troops) || 0,
    defense: Number(c.defense) || 0.4,
    province: c.province || '',
    arms: c.arms || '',
  }));
  const byId = new Map(cities.map((c) => [c.id, c]));
  const allIds = cities.map((c) => c.id);
  const reach = new Map();
  function reachOf(id) {
    const n = Number(id);
    if (!reach.has(n)) reach.set(n, new Set(marchableNeighbors(n, allIds).map(Number)));
    return reach.get(n);
  }
  const owned = cities.filter((c) => c.owner === faction.id);
  const ownedIds = new Set(owned.map((c) => c.id));
  const home = cities.find((c) => c.name === faction.home) || owned[0] || null;
  const allies = new Set();
  const relations = snapshot.relations || {};
  for (const [other, rel] of Object.entries(relations)) {
    if (rel === 'ally') allies.add(other);
  }
  // 快照里的 relations 以对方势力 id 为键；执行层用 a|b。两边都认。
  for (const [pair, rel] of Object.entries(state?.strategy?.relations || {})) {
    if (rel !== 'ally') continue;
    const [a, b] = pair.split('|');
    if (a === faction.id) allies.add(b);
    if (b === faction.id) allies.add(a);
  }

  function stageFor(targetId) {
    let best = null;
    for (const src of owned) {
      if (!reachOf(src.id).has(Number(targetId))) continue;
      if (!best || src.troops > best.troops || (src.troops === best.troops && src.id < best.id)) best = src;
    }
    return best;
  }

  const foreign = [];
  for (const c of cities) {
    if (ownedIds.has(c.id)) continue;
    const stage = stageFor(c.id);
    if (!stage) continue;
    foreign.push(c);
  }

  const lords = snapshot.lords || {};
  const lord = (id) => (id === 'han' ? '汉廷' : id === 'player' ? '玩家' : (lords[id] || id));
  const patience = axes.tempo >= 0.75 ? 2 : 1;
  const need = 1.08 + (1 - axes.risk) * 0.42;
  const grain = Number(snapshot.own?.grain) || 0;
  const gold = Number(snapshot.own?.gold) || 0;
  const recruitBudget = Math.max(0, Math.min(
    Math.round(180 + axes.economy * 720),
    Math.floor((grain - 500) / 2),
  )) * 2;

  function odds(stage, city, send) {
    const atk = send * 0.9;
    const def = Math.max(1, city.troops * (1 + city.defense));
    return atk / def;
  }

  function sendOf(stage) {
    const reserve = stage && home && stage.id === home.id
      ? Math.max(320, Math.round(stage.troops * (0.34 + axes.defense * 0.12)))
      : Math.max(260, Math.round((stage?.troops || 0) * 0.18));
    const frac = 0.48 + axes.tempo * 0.22;
    const raw = Math.round((stage?.troops || 0) * frac);
    return { reserve, send: Math.max(0, Math.min(raw, (stage?.troops || 0) - reserve)) };
  }

  function workable(city) {
    if (!city || allies.has(city.owner)) return null;
    const fails = mem.fails?.[String(city.id)] || 0;
    if (fails >= patience) return null;
    const stage = stageFor(city.id);
    if (!stage) return null;
    const { reserve, send } = sendOf(stage);
    if (send < 400) return null;
    const ratio = odds(stage, city, send);
    if (ratio < need) return null;
    const quote = quoteMarch(stage.id, city.id, send, stage.arms, {
      grain: Math.max(0, grain - recruitBudget),
      gold,
    });
    if (!quote.ok) return null;
    return { city, stage, reserve, send, ratio, fails, quote };
  }

  const recentLoss = (mem.losses || []).filter((x) => viewTurn(snapshot) - x.turn <= 3);

  return {
    self: faction.id,
    name: faction.name,
    turn: viewTurn(snapshot),
    axes,
    patience,
    need,
    grain,
    gold,
    movements: snapshot.movements || [],
    home,
    owned,
    cities,
    byId,
    allies,
    foreign,
    reachOf,
    stageFor,
    workable,
    sendOf,
    fails: mem.fails || {},
    losses: mem.losses || [],
    grudges: mem.grudges || {},
    recentLoss,
    mem,
    lord,
  };
}

function viewTurn(snapshot) {
  return Math.max(0, Number(snapshot.turn) || 0);
}

function livingGoal(goal, view) {
  if (!goal || !goal.type) return null;
  if (view.turn >= Number(goal.lockedUntil)) return null;
  if (goal.type === '固守') {
    if (strikeReady(view)) return null;
    return {
      type: '固守', target: '', lockedUntil: goal.lockedUntil, reason: goal.reason || '按兵未满期',
    };
  }
  const city = view.byId.get(Number(goal.target));
  if (!city || city.owner === view.self) return null;
  if (view.allies.has(city.owner)) return null;
  if ((view.fails[String(city.id)] || 0) >= view.patience) return null;
  if (!view.stageFor(city.id)) return null;
  if (goal.type === '吞并' && city.owner !== 'han') return null;
  if (goal.type === '收复' && city.owner === view.self) return null;
  return {
    type: goal.type,
    target: String(city.id),
    lockedUntil: goal.lockedUntil,
    reason: goal.reason || goal.type,
  };
}

function chooseGoal(view) {
  const lock = (type, target, months, reason) => ({
    type, target: target ? String(target) : '', lockedUntil: view.turn + months, reason,
  });

  const home = view.home;
  const worst = capitalThreat(view);
  if (home && worst) {
    return lock('固守', '', 2, `按兵${home.name}，${worst.name}兵压境，先补守军`);
  }
  if (view.grain < 900 && view.axes.economy >= 0.5) {
    return lock('固守', '', 2, '粮草见底，暂停出征，先屯田');
  }

  const rec = recoverOption(view);
  if (rec) {
    return lock('收复', rec.city.id, 2, `收复${rec.city.name}，上月刚失，守军${rec.city.troops}`);
  }

  const hate = revengeOption(view);
  if (hate && view.axes.aggression >= 0.4) {
    return lock('削弱', hate.city.id, 3, `削弱${view.lord(hate.city.owner)}，出兵${hate.city.name}以报失城`);
  }

  const han = hanOption(view);
  if (han) {
    return lock('吞并', han.city.id, 3, `取${han.city.name}，汉廷守军${han.city.troops}，由${han.stage.name}出兵可胜`);
  }

  const bold = peerOption(view);
  const hanFrontier = view.foreign.some((c) => c.owner === 'han');
  if (bold && (view.axes.aggression >= 0.72 || !hanFrontier)) {
    return lock('削弱', bold.city.id, 2, `兵临${bold.city.name}，${view.lord(bold.city.owner)}守军可图`);
  }

  const where = home ? home.name : '本境';
  return lock('固守', '', 2, `按兵${where}，四邻守军尚厚，征兵待时${newsOf(view)}`);
}

function newsOf(view) {
  const bits = [];
  for (const m of view.movements || []) {
    if (m.kind === '出征' && m.result === '克' && m.faction !== view.self) bits.push(`${m.who}取${m.toName}`);
    else if (m.kind === '结盟' && m.faction !== view.self) bits.push(`${m.who}与${m.otherName}结好`);
  }
  return bits.length ? `。军报：${bits.slice(0, 3).join('，')}` : '';
}

function recoverOption(view) {
  let best = null;
  for (const loss of view.recentLoss) {
    const city = view.byId.get(Number(loss.cityId));
    const plan = city && view.workable(city);
    if (!plan) continue;
    if (!best || plan.ratio > best.ratio) best = plan;
  }
  return best;
}

function revengeOption(view) {
  let rival = null;
  let hate = 0;
  for (const [id, n] of Object.entries(view.grudges)) {
    if (view.allies.has(id)) continue;
    if (n > hate) { hate = n; rival = id; }
  }
  if (!rival || hate < 2) return null;
  let best = null;
  for (const c of view.foreign) {
    if (c.owner !== rival) continue;
    const plan = view.workable(c);
    if (!plan) continue;
    if (!best || plan.ratio > best.ratio || (plan.ratio === best.ratio && plan.city.id < best.city.id)) best = plan;
  }
  return best;
}

function hanOption(view) {
  let best = null;
  for (const c of view.foreign) {
    if (c.owner !== 'han') continue;
    const plan = view.workable(c);
    if (!plan) continue;
    // 同样打得过时，先打守军更薄的，避免八家挤同一座大城
    const key = c.troops * 10 + c.id / 1000;
    if (!best || key < best.key) best = { ...plan, key };
  }
  return best;
}

function peerOption(view) {
  let best = null;
  for (const c of view.foreign) {
    if (c.owner === 'han' || c.owner === 'player') continue;
    const plan = view.workable(c);
    if (!plan) continue;
    if (!best || plan.ratio > best.ratio || (plan.ratio === best.ratio && plan.city.id < best.city.id)) best = plan;
  }
  return best;
}

function compile(goal, view) {
  const orders = [];
  let seqI = 0;
  let seqS = 0;
  const addI = (type, target, params, expect) => {
    seqI += 1;
    orders.push({
      id: `I${view.turn}-${seqI}`, type, target, params,
      eta: 1, on_fail: '屯田', expect, explain: [[goal.reason, 1]],
    });
  };
  const addS = (type, target, params, expect) => {
    seqS += 1;
    orders.push({
      id: `S${view.turn}-${seqS}`, type, target, params,
      eta: type === '出征' ? 2 : 0, on_fail: type === '出征' ? '撤退' : '维持现状',
      expect, explain: [[goal.reason, 1]],
    });
  };

  const attack = attackPlan(goal, view);
  const recruitCity = (attack && attack.stage) || recruitFallback(view);
  pushRecruit(addI, view, recruitCity);

  if (attack) {
    const city = attack.city;
    const q = attack.quote || {};
    goal.from = String(attack.stage.id);
    goal.fromName = attack.stage.name;
    goal.targetName = city.name;
    addS('出征', String(city.id), {
      troops: attack.send,
      fromCity: String(attack.stage.id),
      fromName: attack.stage.name,
      toName: city.name,
      reserve: attack.reserve,
      km: q.km, li: q.li, days: q.days,
      grain: q.grain, gold: q.gold,
      horses: q.horses, horseGrain: q.horseGrain, horseGold: q.horseGold,
      totalGrain: q.totalGrain, totalGold: q.totalGold,
      mode: q.mode, dismounted: !!q.dismounted,
    }, `自${attack.stage.name}出兵${city.name}（${goal.type}，${q.li || 0} 里，守军 ${city.troops}）`);
  } else {
    if (recruitCity) {
      goal.from = String(recruitCity.id);
      goal.fromName = recruitCity.name;
    }
    addS('固守', view.self, { cityId: recruitCity ? String(recruitCity.id) : '', cityName: recruitCity?.name || '' }, goal.reason);
  }

  const pact = alliancePlan(view, attack);
  if (pact) {
    addS('结盟', pact.id, { versus: pact.versus }, `与${view.lord(pact.id)}结好，以牵制${view.lord(pact.versus)}`);
  }
  return orders;
}

function attackPlan(goal, view) {
  if (!goal || goal.type === '固守') return null;
  const city = view.byId.get(Number(goal.target));
  return city ? view.workable(city) : null;
}

function capitalThreat(view) {
  const home = view.home;
  if (!home) return null;
  let worst = null;
  for (const c of view.foreign) {
    if (!view.reachOf(home.id).has(c.id)) continue;
    if (view.allies.has(c.owner)) continue;
    const pressure = c.troops / Math.max(1, home.troops);
    const line = 1.45 + view.axes.defense * 0.2;
    if (pressure >= line && (!worst || c.troops > worst.troops)) worst = c;
  }
  return worst;
}

function strikeReady(view) {
  if (hanOption(view)) return true;
  const hanFrontier = view.foreign.some((c) => c.owner === 'han');
  return !hanFrontier && !!peerOption(view);
}

/** 兵补在通往当前最可能目标的那座出发城，不补进打不到的后方。 */
function recruitFallback(view) {
  if (capitalThreat(view) && view.home && view.owned.some((c) => c.id === view.home.id)) return view.home;
  const toward = (pred) => {
    let best = null;
    for (const c of view.foreign) {
      if (!pred(c)) continue;
      const stage = view.stageFor(c.id);
      if (!stage) continue;
      const { send } = view.sendOf(stage);
      if (send < 200) continue;
      const ratio = (send * 0.9) / Math.max(1, c.troops * (1 + c.defense));
      if (!best || ratio > best.ratio || (ratio === best.ratio && stage.id < best.stage.id)) {
        best = { stage, ratio };
      }
    }
    return best && best.stage;
  };
  const han = toward((c) => c.owner === 'han');
  if (han) return han;
  const peer = toward((c) => c.owner !== 'han' && c.owner !== 'player' && !view.allies.has(c.owner));
  if (peer) return peer;
  if (view.home && view.owned.some((c) => c.id === view.home.id)) return view.home;
  return view.owned.slice().sort((a, b) => a.troops - b.troops || a.id - b.id)[0] || null;
}

function pushRecruit(addI, view, city) {
  if (!city) return;
  const want = Math.round(180 + view.axes.economy * 720);
  const afford = Math.floor((view.grain - 500) / 2);
  const count = Math.max(0, Math.min(want, afford));
  if (count >= 150) {
    addI('征兵', view.self, { count, cityId: String(city.id), cityName: city.name }, `于${city.name}征兵 ${count}，补本次战役`);
  } else {
    addI('屯田', view.self, {}, '粮不足以征兵，屯田待时');
  }
}

function alliancePlan(view, attack) {
  if (view.axes.aggression >= 0.62) return null;
  const allyCount = [...view.allies].length;
  if (allyCount >= 2) return null;
  const attackOwner = attack ? attack.city.owner : '';
  const borders = new Set();
  for (const c of view.foreign) {
    if (c.owner !== 'han' && c.owner !== 'player') borders.add(c.owner);
  }
  let rival = attackOwner && attackOwner !== 'han' && attackOwner !== 'player' ? attackOwner : null;
  let hate = 0;
  for (const [id, n] of Object.entries(view.grudges)) {
    if (n > hate && !view.allies.has(id)) { hate = n; rival = id; }
  }
  if (!rival) {
    // 还没结仇：找和自己接壤最多的那家，去拉一个不接壤、但挨着这家的人
    const tally = {};
    for (const c of view.foreign) {
      if (borders.has(c.owner)) tally[c.owner] = (tally[c.owner] || 0) + 1;
    }
    rival = Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] || null;
  }
  if (!rival) return null;

  const rivalCities = view.cities.filter((c) => c.owner === rival);
  let pick = null;
  for (const other of factionIdsTouching(view, rivalCities)) {
    if (other === view.self || other === rival) continue;
    if (view.allies.has(other) || borders.has(other)) continue;
    if ((view.grudges[other] || 0) >= 2) continue;
    if (!pick || other < pick) pick = other;
  }
  if (!pick) return null;
  return { id: pick, versus: rival };
}

function factionIdsTouching(view, rivalCities) {
  const found = new Set();
  for (const rc of rivalCities) {
    const near = view.reachOf(rc.id);
    for (const id of near) {
      const c = view.byId.get(id);
      if (c && c.owner !== 'han' && c.owner !== 'player') found.add(c.owner);
    }
  }
  return found;
}
