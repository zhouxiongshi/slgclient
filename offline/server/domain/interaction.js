/**
 * 交互增强层的数据聚合（纯函数，零 IO 副作用，不写存档）。
 *
 * 设计规格对应：
 *  - 5.4 单一事实源：顶栏 / 城池面板 / 战略台 / 建言卡共用这一份聚合，不各算一份。
 *  - 6.4 当前事务 / 军师建言：只列可行动项，按紧急度排序，Top5 由前端截断。
 *  - 6.10 回合推进预览：点「推进」之前就能看到本回合将发生什么。
 *  - 4.4 情报分级：每条信息标 source / confidence，估算值不伪装成精确值。
 *
 * 纪律：
 *  - 不 import strategy.js / panels.js（它们互相成环），只读 state 与静态 map.json，
 *    因此本模块零内部依赖，不新增任何环。
 *  - 不调用 Math.random；所有「预报」都是按公开规则的确定性推导，并标注推导口径。
 *  - 服务端没提供的字段一律写进 fieldGaps，前端必须显示「服务端未提供 + 降级口径」。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captiveRecruitRate, captiveRateParts } from './captive-rules.js';
// city-econ 只依赖 economy，不反向依赖本模块，不会形成环
import { cityYield } from './city-econ.js';
/* ★ U20 粮道（supply → march，不反向依赖本模块）；★ U14 内政任务状（interior-task → economy） */
import { supplyMap } from './supply.js';
import { interiorTaskView } from './interior-task.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAP_PATH = resolve(ROOT, 'conf', 'campaign', 'strategy', 'map.json');
let MAP_CACHE = null;
function mapCities() {
  if (!MAP_CACHE) MAP_CACHE = JSON.parse(readFileSync(MAP_PATH, 'utf8')).cities;
  return MAP_CACHE;
}
function cityNameOf(id) {
  const c = mapCities().find((x) => Number(x.id) === Number(id));
  return c ? c.name : `城${id}`;
}
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** 君主五维里的政治（用于招降率），从存档里取，缺省 70。 */
function protagonistPol(state) {
  const p = state.role?.protagonist || state.protagonist || {};
  return num(p.政治 ?? p.politics, 70);
}

/**
 * 生成完整交互态。前端只依赖这一个端点，避免三次请求各自算一份导致口径漂移。
 */
export function interactionState(state, cfg) {
  const st = state.strategy || {};
  const day = Math.floor(num(state.clock?.day, 1));
  const turn = num(st.turn, 0);
  const month = num(state.clock?.month, (turn % 12) + 1);
  // 逐城经济挂在 state.strategy.cityEcon（不是 state.cityEcon），取错会全城显示 0 粮
  const econ = (st && st.cityEcon) || state.cityEcon || {};
  const roleRes = state.roleRes || {};
  const generals = Array.isArray(state.generals) ? state.generals : [];
  const captives = Array.isArray(state.captives) ? state.captives : [];
  const marches = Array.isArray(st.marches) ? st.marches.filter((m) => !m.resolved) : [];
  const ownIds = Object.entries(st.cities || {})
    .filter(([, v]) => v.owner === 'player').map(([id]) => Number(id));

  /* ---------- 俸禄与忠诚（U17 单轨口径，唯一权威来源 city-econ.loyaltyTick） ---------- */
  const salaryRows = generals.map((g) => ({
    id: g.id, name: nameOfGeneral(state, cfg, g), star: num(g.star, 3),
    due: 20 * num(g.star, 3), loyal: num(g.loyal, 88),
  }));
  const salaryTotal = salaryRows.reduce((s, r) => s + r.due, 0);
  const lowLoyalty = salaryRows.filter((r) => r.loyal < 70)
    .sort((a, b) => a.loyal - b.loyal)
    .map((r) => ({ ...r, reason: r.loyal < 40 ? '忠诚 <40，叛逃风险 10%' : '忠诚 <70，叛逃风险 3%' }));

  /* ---------- 逐城城库 / 灾害风险 / 内政冷却 ---------- */
  /* ★ U20 粮道：整图一次 BFS，逐城复用 */
  const SUPPLY = supplyMap(state);
  const TASKS = interiorTaskView(state);
  const cityRows = [];
  for (const id of ownIds) {
    const e = econ[id] || {};
    const meta = mapCities().find((c) => Number(c.id) === Number(id)) || {};
    const risk = num(meta.attrs?.灾害风险, 50);
    const store = num(e.store, 0);
    const troops = num(st.cities?.[id]?.troops, 0);
    // 与 city-econ 的耗粮口径一致：驻军按 1%/日、城务保底 2
    const dailyUse = Math.max(1, Math.round(troops * 0.01 + 2));
    const yieldGrain = num(e.yieldGrain, num(cityYield(state, id)?.grain, 0));
    const investDays = st.investDays || e.investDays || {};
    cityRows.push({
      id, name: cityNameOf(id), province: meta.province || '',
      specialty: meta.specialty || '', arms: meta.arms || '',
      pop: num(e.pop, num(meta.population, 0)), store, yieldGrain, dailyUse,
      order: num(e.order, 60), morale: num(e.morale, 60),
      devAgri: num(e.devAgri), devTrade: num(e.devTrade), devArms: num(e.devArms), devDef: num(e.devDef),
      disasterRisk: risk, disasterBasis: meta.disasterBasis || '按州估算（服务端未逐城下发依据）',
      supportDays: Math.floor(store / dailyUse),
      investReady: Object.keys(investDays).length === 0 || day - Math.max(...Object.values(investDays).map(num)) >= 1,
      /* ★ U20 粮道连通（断粮城由 supplyTick 打上 supplyCut，界面据此变色） */
      supply: (() => {
        const s = SUPPLY.byCity[id] || { connected: false, hops: -1, km: -1, via: [] };
        return {
          connected: !!s.connected, hops: s.hops, km: s.km,
          via: (s.via || []).map(cityNameOf),
          cut: !!e.supplyCut, days: num(e.supplyDays, 0),
        };
      })(),
      /* ★ U14 该城在施任务（进度百分比与完工日，界面直接画条） */
      tasks: TASKS.filter((t) => t.cityId === id && t.status === 'active')
        .map((t) => ({ id: t.id, label: t.label, officer: t.officer, pct: t.pct, endDay: t.endDay, perTick: t.perTick })),
    });
  }
  const lowGrain = cityRows.filter((c) => c.supportDays < 10);
  const highRisk = cityRows.filter((c) => c.disasterRisk >= 70)
    .sort((a, b) => b.disasterRisk - a.disasterRisk);

  /* ---------- 可行动项（6.4：不列结果播报，只列「现在能做什么」） ---------- */
  const agenda = [];
  const push = (a) => agenda.push({
    id: a.id, title: a.title, urgency: a.urgency, deadline: a.deadline,
    source: a.source, confidence: a.confidence, jump: a.jump,
    detail: a.detail, action: a.action || '', ignore: false,
  });
  /* ★ U20 粮道断绝：比缺粮更急（缺粮还能买，断路只能打或撤） */
  const cutCities = cityRows.filter((c) => c.supply && c.supply.connected === false);
  for (const c of cutCities.slice(0, 3)) {
    push({
      id: `supply:${c.id}`, title: `${c.name}粮道断绝（第 ${(c.supply && c.supply.days) || 10} 日）`,
      urgency: 0, deadline: '每旬都在掉民心', source: 'supply.js 连通判定（精确）', confidence: '高',
      jump: { kind: 'city', id: c.id }, action: '打通通路 / 放弃飞地 / 就地屯粮',
      detail: '断粮每旬：民心 −3、治安 −1、守军逃散 2%、粮产 ×0.55。粮道 = 沿己方城与未封锁关隘能走到都城。',
    });
  }
  for (const c of lowGrain) {
    push({
      id: `grain:${c.id}`, title: `${c.name}存粮仅够 ${c.supportDays} 日`,
      urgency: 1, deadline: '本回合内', source: '逐城城库（精确）', confidence: '高',
      jump: { kind: 'city', id: c.id }, action: '运粮 / 屯田',
      detail: `城库 ${c.store}，驻军 ${Math.max(0, Math.round((c.dailyUse - 2) * 100))} 每日耗粮约 ${c.dailyUse}，可支撑 ${c.supportDays} 日；断粮会影响士气与守军。`,
    });
  }
  for (const r of lowLoyalty.slice(0, 3)) {
    push({
      id: `loyal:${r.id}`, title: `${r.name}忠诚 ${r.loyal}，${r.reason}`,
      urgency: 2, deadline: '本旬结算前', source: 'state.generals[].loyal（精确）', confidence: '高',
      jump: { kind: 'general', id: r.id }, action: '赏赐 / 委任 / 核查俸禄',
      detail: `本月俸禄总额 ${salaryTotal} 金，府库 ${Math.floor(num(roleRes.gold))} 金；欠饷会触发全军忠诚 -5。`,
    });
  }
  if (captives.length) {
    const best = captives.map((c, i) => ({ c, i, rate: captiveRecruitRate(state, c) }))
      .sort((a, b) => b.rate - a.rate)[0];
    push({
      id: `captive:${best.i}`, title: `可招降「${best.c.name}」，成功率 ${Math.round(best.rate * 100)}%`,
      urgency: 3, deadline: '俘虏每旬忠诚 -2', source: 'captive-rules.js（精确）', confidence: '高',
      jump: { kind: 'captive', id: best.i }, action: '招降（300 金，失败不扣费）',
      detail: '构成：' + captiveRateParts(state, best.c).parts.map((p) => `${p.label} ${p.value > 0 ? '+' : ''}${p.value}%`).join(' · '),
    });
  }
  const ready = cityRows.filter((c) => c.investReady);
  if (ready.length) {
    push({
      id: 'invest:ready', title: `${ready.length} 座城的内政指令已冷却就绪`,
      urgency: 4, deadline: '本回合', source: 'state.strategy.investDays（精确）', confidence: '高',
      jump: { kind: 'city', id: ready[0].id }, action: '开发农田 / 市集 / 兵营',
      detail: `优先 ${ready.slice(0, 3).map((c) => c.name).join('、')}；开发度反馈到逐城产量。`,
    });
  }
  /* ★ U14 内政任务状：只剩最后一旬的提醒（不是「结果播报」，是仍可干预的窗口） */
  const nearDone = TASKS.filter((t) => t.status === 'active' && t.daysLeft <= 10);
  if (nearDone.length) {
    push({
      id: 'interior:near', title: `${nearDone.length} 项内政将在 ${TASKS.some((t) => t.daysLeft <= 0) ? '本回合' : '10 日内'}完工`,
      urgency: 4, deadline: '本旬结算', source: 'interior-task.js（精确）', confidence: '高',
      jump: { kind: 'city', id: nearDone[0].cityId }, action: '查看任务状 / 撤销重派',
      detail: nearDone.slice(0, 3).map((t) => `${t.city}${t.label}（${t.officer}，剩 ${t.daysLeft} 日）`).join('；'),
    });
  }
  const marchable = Array.isArray(st.marchable) ? st.marchable : [];
  if (marchable.length && generals.length >= 2) {
    push({
      id: 'attack:ready', title: `有 ${marchable.length} 座可攻目标，可编队出征`,
      urgency: 5, deadline: '无', source: 'march.js 行军校验（精确）', confidence: '高',
      jump: { kind: 'war' }, action: '编队 → 选出发城 → 补给确认 → 出征',
      detail: '出征前请看战前对比卡；行军时长按里程 ÷ 速度计算，地图军标逐日推进。',
    });
  }
  for (const c of highRisk.slice(0, 2)) {
    push({
      id: `risk:${c.id}`, title: `${c.name}灾害风险 ${c.disasterRisk}，建议提升治安`,
      urgency: 6, deadline: '下一旬掷骰前', source: `${c.disasterBasis}（估算）`, confidence: '中',
      jump: { kind: 'city', id: c.id }, action: '治安内政 / 委任政务官',
      detail: '灾害每旬按 风险 × 政务官0.8 × 治安(0.7~1.0) 掷骰，政务官在岗可降 20% 概率。',
    });
  }
  agenda.sort((a, b) => a.urgency - b.urgency);

  /* ---------- 回合推进预览（6.10 / P3） ---------- */
  const turnDays = num(cfg?.strategyTurnDays, 10);
  const nextTurnDay = num(st.lastTurnDay, 0) + turnDays;
  const turnPreview = {
    day, turn, nextTurnDay, need: Math.max(0, nextTurnDay - day), turnDays,
    note: nextTurnDay > day ? '自由快进：按真实天数补算产出与事件，非额外奖励' : '正式回合结算',
    willHappen: [
      `日产结算（金 / 粮 / 木 / 铁 / 石 / 命令书）`,
      `军饷与俸禄 ${salaryTotal} 金`,
      `在途队伍 ${marches.length} 支，其中 ${marches.filter((m) => m.arriveDay <= nextTurnDay).length} 支预计抵达`,
      `逐旬事件：灾害 / 忠诚 / 俘虏 / 在野出仕（确定性种子）`,
    ],
  };

  /* ---------- 章节 K：服务端未提供 / 需前端降级的字段 ---------- */
  const fieldGaps = [
    /* ★ U15 已实装：相性（本作设定，势力锚点+编号散列）、义理（史载政治/魅力折算）、
       演义关系网（conf/relations.json）、登庸成功率构成条（relation.talentRecruitRate）。
       仍未实装的是「姻亲/义结金兰」这类玩家主动建立关系的操作。 */
    { field: '关系网（玩家主动结亲/结义）', have: false, use: '外交与人情经营', fallback: '当前关系网只读（演义既有关系）；玩家侧只影响登庸成功率' },
    /* ★ U20 已实装：supply.js 的连通判定、断粮惩罚、出征粮道预估（marchSupplyEstimate） */
    { field: '敌方侦察精确值', have: false, use: '战前对比卡', fallback: '按「估算」档展示，并给「派斥候」补情报动作' },
    /* ★ U14 已实装：interior-task.js 的任务对象（执行武将/工期/每旬增量/状态/撤销） */
    { field: '逐将战前 delta', have: false, use: '决策预览', fallback: '按公开规则推算并标注「推算值」，不伪装成权威值' },
  ];

  return {
    ok: true, day, turn, month,
    season: ['冬', '春', '夏', '秋'][Math.floor((month - 1) / 3) % 4] || '春',
    treasury: {
      gold: Math.floor(num(roleRes.gold)), grain: Math.floor(num(roleRes.grain)),
      wood: Math.floor(num(roleRes.wood)), iron: Math.floor(num(roleRes.iron)),
      stone: Math.floor(num(roleRes.stone)), decree: Math.floor(num(roleRes.decree)),
    },
    salary: { total: salaryTotal, count: salaryRows.length, coveragePct: salaryTotal ? Math.min(100, Math.round(num(roleRes.gold) / salaryTotal * 100)) : 100 },
    cities: cityRows,
    generals: salaryRows,
    captives: captives.map((c, i) => ({
      idx: i, name: c.name, loyal: num(c.loyal, 50), days: num(c.days, 0),
      rate: Math.round(captiveRecruitRate(state, c) * 100), parts: captiveRateParts(state, c),
    })),
    marches: marches.map((m) => ({
      id: m.id, side: m.side || 'player', from: m.from, to: m.to,
      fromName: cityNameOf(m.from), toName: cityNameOf(m.to),
      arriveDay: m.arriveDay, remain: Math.max(0, num(m.arriveDay) - day),
      km: m.km, speed: m.speed, troops: m.troops,
      intel: m.intel || (m.side === 'faction' ? 'estimated' : 'precise'),
    })),
    alerts: {
      lowLoyalty,
      lowGrain: lowGrain.map((c) => ({ id: c.id, name: c.name, store: c.store, supportDays: c.supportDays })),
      highRisk: highRisk.map((c) => ({ id: c.id, name: c.name, risk: c.disasterRisk })),
      /* ★ U20 断粮告警（0 优先级，红条） */
      supplyCut: cutCities.map((c) => ({ id: c.id, name: c.name, days: (c.supply && c.supply.days) || 10 })),
    },
    agenda, turnPreview, fieldGaps,
  };
}

function nameOfGeneral(state, cfg, g) {
  const row = cfg?.generalByCfg?.get(Number(g.cfgId));
  return row?.name || g.name || `武将${g.id}`;
}
