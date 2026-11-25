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
import { marchableNeighbors } from './march.js';
import { quoteMarch } from './strategy-log.js';
/* ★ 2026-11-22：难度旋钮首次接入决策脑——只缩放扩张门槛，不碰伤害公式 */
import { knobGet } from './knobs.js';

export const PERSONA_AXES = {
  曹操: { aggression: 0.65, economy: 0.60, risk: 0.50, tempo: 0.70, defense: 0.55 },
  袁绍: { aggression: 0.35, economy: 0.90, risk: 0.30, tempo: 0.25, defense: 0.65 },
  吕布: { aggression: 0.95, economy: 0.20, risk: 0.85, tempo: 0.90, defense: 0.20 },
  孙权: { aggression: 0.30, economy: 0.70, risk: 0.25, tempo: 0.35, defense: 0.90 },
  刘备: { aggression: 0.45, economy: 0.75, risk: 0.35, tempo: 0.45, defense: 0.60 },
  司马懿: { aggression: 0.55, economy: 0.65, risk: 0.20, tempo: 0.20, defense: 0.85 },
  董卓: { aggression: 0.80, economy: 0.25, risk: 0.75, tempo: 0.75, defense: 0.30 },
  公孙瓒: { aggression: 0.85, economy: 0.35, risk: 0.70, tempo: 0.95, defense: 0.35 },
  /* ★ P61-S9：补齐常见诸侯人格，避免 72 城里的多数势力共用一条默认轴。 */
  汉廷: { aggression: 0.20, economy: 0.55, risk: 0.15, tempo: 0.20, defense: 0.80 },
  马腾: { aggression: 0.70, economy: 0.40, risk: 0.65, tempo: 0.70, defense: 0.45 },
  韩遂: { aggression: 0.65, economy: 0.35, risk: 0.60, tempo: 0.60, defense: 0.40 },
  刘表: { aggression: 0.25, economy: 0.80, risk: 0.20, tempo: 0.25, defense: 0.85 },
  袁术: { aggression: 0.60, economy: 0.45, risk: 0.80, tempo: 0.65, defense: 0.35 },
  公孙度: { aggression: 0.45, economy: 0.55, risk: 0.40, tempo: 0.35, defense: 0.75 },
  陶谦: { aggression: 0.25, economy: 0.70, risk: 0.25, tempo: 0.30, defense: 0.70 },
  张鲁: { aggression: 0.35, economy: 0.60, risk: 0.20, tempo: 0.30, defense: 0.80 },
};

const AXIS_POOL = Object.values(PERSONA_AXES);

function blankMemory() {
  /* ★ P60：failsTurn 与 fails 同键成对——fails 只记「败了几次」，failsTurn 记「最后一败第几旬」，
     workable 据此把 8 旬前的旧败按过期处理。旧档没有 failsTurn 也合法（读档兜底 -999）。 */
  return { goal: null, fails: {}, failsTurn: {}, losses: [], grudges: {} };
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
  else {
    mem.fails[key] = (mem.fails[key] || 0) + 1;
    /* ★ P60：记住败在第几旬，供 workable 的失败衰减判断。没有这行，
       「败一次就永不再打这座城」会让 AI 对弱敌也永久放弃。 */
    mem.failsTurn = mem.failsTurn || {};
    mem.failsTurn[key] = Math.max(0, Number(state.strategy?.turn) || 0);
  }
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
  if (PERSONA_AXES[persona]) return PERSONA_AXES[persona];
  /* ★ P61-S9：未配置的势力按人格名确定性地分配一条既有轴，
     不再全体回退曹操——不同诸侯在同一局面下会做出不同决策。 */
  const key = String(persona || '');
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return AXIS_POOL[h % AXIS_POOL.length];
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
  /* difficultyAi 只改敢不敢打：高难度降低所需兵力比；1.0 时对汉廷城仍单独减压。 */
  const aiMul = Math.max(0.8, Math.min(1.4, Number(knobGet(state, 'difficultyAi')) || 1));
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

  function workable(city, needMul = 1, sendMul = 1) {
    if (!city || allies.has(city.owner)) return null;
    /* ★ P60：失败记忆衰减——同一座城 8 旬前的败仗不再拦路。旧实现 fails 只在
       自己打下该城时清零，而打不下又不会再打，形成死锁：AI 撞过一次南墙，
       那怕对方只剩几百守军也永久绕道，表现就是「从不主动征服弱敌」。 */
    const turnNow = viewTurn(snapshot);
    const failN = Number(mem.fails?.[String(city.id)]) || 0;
    const failAt = Number(mem.failsTurn?.[String(city.id)]);
    const fails = failN > 0 && Number.isFinite(failAt) && turnNow - failAt > 8 ? 0 : failN;
    if (fails >= patience) return null;
    const stage = stageFor(city.id);
    if (!stage) return null;
    const reserve = sendOf(stage).reserve;
    /* ★ 2026-11-22：汉廷城是无人值守的扩张目标，旧实现与有主城同门槛
       （实测 30 旬只从 24 座降到 13 座，多数诸侯长期固守）。现在单独减压：
       门槛 ×0.28、多派六成、下限 400→250；difficultyAi 高档再放低门槛。 */
    const expansion = city.owner === 'han';
    /* ★ P60：极弱城减压——守军 ≤300 的城与汉廷空城同一条出兵下限（250），
       否则兵少的出发城凑不出 400 兵，眼睁睁看着嘴边的弱敌打不了。 */
    const weakPrey = !expansion && Number(city.troops) <= 300;
    const sendFactor = sendMul * (expansion ? 1.6 : 1);
    const needFactor = (expansion ? 0.28 : 1) / aiMul;
    /* sendMul：制衡讨伐时 1.35（倾巢而出），常规出征 1（sendOf 基准） */
    const raw = Math.round((stage?.troops || 0) * (0.48 + axes.tempo * 0.22) * sendFactor);
    const send = Math.max(0, Math.min(raw, (stage?.troops || 0) - reserve));
    if (send < (expansion || weakPrey ? 250 : 400)) return null;
    const ratio = odds(stage, city, send);
    if (ratio < need * needMul * needFactor) return null;
    const quote = quoteMarch(stage.id, city.id, send, stage.arms, {
      grain: Math.max(0, grain - recruitBudget),
      gold,
    });
    if (!quote.ok) return null;
    return { city, stage, reserve, send, ratio, fails, quote };
  }

  const recentLoss = (mem.losses || []).filter((x) => viewTurn(snapshot) - x.turn <= 3);

  /* ★ 2026-11-16 追赶：玩家兵力/城数远超本势力时，征兵规模温和上浮，
     避免「玩家滚雪球、诸侯原地踏步」。只放大既有征兵 want，不改粮约束，
     上限 2.0×，仍受 afford（城库粮）硬闸，确定性、无随机。 */
  const myTroops = owned.reduce((s, c) => s + c.troops, 0);
  const playerTroops = cities.filter((c) => c.owner === 'player').reduce((s, c) => s + c.troops, 0);
  const myCities = owned.length;
  const playerCities = cities.filter((c) => c.owner === 'player').length;
  const troopGap = playerTroops / Math.max(1, myTroops);
  const cityGap = playerCities / Math.max(1, myCities);
  const catchUp = Math.max(1, Math.min(2.0, 1 + Math.max(troopGap - 1, cityGap - 1) * 0.5));

  return {
    catchUp,
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

  /* ★ P14 制衡（用户 2026-11-16「全程没有挑战性」）：玩家城数/兵力坐大后，
     诸侯不再无视玩家——同 other 诸侯一样择可图之城讨伐，让中期起压力上来。 */
  const power = balanceOfPower(view);
  const against = playerOption(view);
  if (against && (view.axes.aggression >= 0.4 || power.share >= 0.4)) {
    return lock('削弱', against.city.id, 3, `${view.lord('player')}势大，出兵${against.city.name}以制衡`);
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

/* ★ P14 制衡：玩家城数/兵力占比（按非汉廷城计）。城数 ≥3 或占比 ≥25% 即视为
   「势大」，可入诸侯讨伐目标；占比 ≥40% 时连低 aggression 的稳健派也会出手。 */
function balanceOfPower(view) {
  const mine = view.cities.filter((c) => c.owner === 'player');
  const others = view.cities.filter((c) => c.owner !== 'han').length || 1;
  return { count: mine.length, share: mine.length / others };
}

function playerOption(view) {
  const p = balanceOfPower(view);
  /* ★ 2026-11-19 玩法修复：旧门槛是「城数 ≥3 或占比 ≥25%」才把玩家列入讨伐目标，
     实测玩家 5 城、占比 8% 时永远进不了池子，AI 全程只互殴，前中期零压力。
     现在只要玩家有 2 座城就进入候选（仍受「打得过」与 6 旬冷却约束），
     让扩张本身开始招来反扑——这才是「占城有代价」的另一半。 */
  if (p.count < 2 && p.share < 0.15) return null;
  /* ★ 讨伐冷却（P15 灭国闭环回归）：打玩家的出征在战略层永不消耗目标（玩家城
     不随 NPC 进攻易主），无冷却会让制衡吃掉全部输出、饿死正常扩张——
     每次讨伐玩家后歇 6 旬，压力保持但不空转。 */
  if (view.turn - (Number(view.mem?.lastPlayerAtk) || -999) < 6) return null;
  /* 制衡减压：玩家城守军厚，与打千余守军的汉城同一条 need 线会让制衡永远开不
     出兵——占比越高减压越大（0.85 / 0.7），讨伐玩家成为现实选项。 */
  const needMul = p.share >= 0.4 ? 0.7 : 0.85;
  let best = null;
  for (const c of view.foreign) {
    if (c.owner !== 'player') continue;
    const plan = view.workable(c, needMul, 1.35);
    if (!plan) continue;
    if (!best || plan.ratio > best.ratio) best = plan;
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
  if (!city) return null;
  /* ★ P14 制衡目标复查同门槛：chooseGoal 对玩家目标用了减压 need / 倾巢 sendMul，
     这里复查必须同参，否则目标被选中却永远发不出兵。 */
  if (city.owner === 'player') {
    const p = balanceOfPower(view);
    return view.workable(city, p.share >= 0.4 ? 0.7 : 0.85, 1.35);
  }
  return view.workable(city);
}

function capitalThreat(view) {
  const home = view.home;
  if (!home) return null;
  let worst = null;
  for (const c of view.foreign) {
    if (!view.reachOf(home.id).has(c.id)) continue;
    if (view.allies.has(c.owner)) continue;
    /* ★ 2026-11-22：汉廷空城不会被玩家用来压境，不该把 AI 锁在城里。 */
    if (c.owner === 'han') continue;
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
  /* ★ P14 内政感知（用户「内政笨」）：兵压境/刚失城时征兵规模上浮，
     安稳期按 economy 基线走——不再是无威胁也傻征同一批。 */
  const threat = capitalThreat(view);
  const mul = threat
    ? 1 + Math.min(0.8, (threat.troops / Math.max(1, view.home?.troops || 1)) * 0.35)
    : (view.recentLoss.length ? 1.25 : 1);
  /* ★ 2026-11-16：叠加追赶系数（玩家坐大时诸侯征兵上浮，封顶 2×），
     仍受城库粮 afford 硬闸，粮不够就转屯田，不会出现凭空兵力。 */
  const want = Math.round((180 + view.axes.economy * 720) * mul * (view.catchUp || 1));
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
  /* ★ P14 制衡：玩家势大时优先拉人共同制衡玩家（除非对某诸侯仇更深）。 */
  const power = balanceOfPower(view);
  if ((!rival || hate < 3) && power.share >= 0.35 && power.count >= 3) rival = 'player';
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
