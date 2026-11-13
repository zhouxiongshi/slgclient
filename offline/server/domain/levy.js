/**
 * 兵役制（P11 / GDD §5.5 修订版）——「人口 → 户 → 适龄壮丁 → 已征户 → 本旬可征」
 *
 * 为什么要单独一个模块：征兵的四条硬规则以前散在 handlers.js 的一段脚本里，
 *   面板显示、预览、服务端结算各算一份，结果就是「可以反复征兵、总能征满」。
 *   这里是唯一权威源：handlers 结算、strategy 视图、六府面板、交互层建言全部读它。
 *
 * 四条规则（用户 2026-11-13 明确要求，GDD §5.5 已同步修订）：
 *   1. 妇孺老少不征：户均 5 口，只有 62% 的户有适龄壮丁（其余为老弱/妇孺/幼户）。
 *   2. 一户征兵一位：已征户数 `levied` 永久累计，人口增长产生的新户才补进来。
 *   3. 不允许反复征兵：每城每旬（turn）只允许一次征兵，`lastLevyTurn` 卡住。
 *   4. 内政先发展人口：可征为 0 时明确回 `need_population`，指向「劝课生息」内政。
 *
 * 零依赖叶子：不 import strategy / city-econ / panels（它们互相成环）。
 * 只读 state，写只写 state.strategy.cityEcon[cityId] 的四个字段。
 */
export const HOUSEHOLD_SIZE = 5;        // 户均人口
export const ADULT_MALE_RATE = 0.62;    // 有适龄壮丁的户占比（其余为妇孺老弱户）
export const POP_PER_SOLDIER = 4;       // GDD：征 1 兵，人口基数 -4（抽丁 + 眷属随军 + 田荒）
export const TURN_CAP_RATE = 0.05;      // 单旬最多征总人口的 5%，防止一次抽空
export const SEASON_FACTOR = { 春: 0.8, 夏: 1.0, 秋: 1.1, 冬: 0.7 };
const SEASONS = ['春', '夏', '秋', '冬'];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 与 strategy.strategyEventCtx 同口径：1 年 360 日，90 日一季。 */
export function seasonOf(state) {
  const day = Math.max(1, Math.floor(num(state?.clock?.day, 1)));
  return SEASONS[Math.floor(((day - 1) % 360) / 90)] || '春';
}

/** 旬键：优先用战略层 turn，旧档退化成 day/turnDays。 */
export function levyTurnOf(state) {
  const st = state?.strategy || {};
  const day = Math.max(1, Math.floor(num(state?.clock?.day, 1)));
  const turnDays = Math.max(1, Math.floor(num(st.turnDays, 10)));
  return Math.floor(num(st.turn, Math.floor((day - 1) / turnDays)));
}

function econOf(state, cityId) {
  const id = Number(cityId);
  return state?.strategy?.cityEcon?.[id] || null;
}

/** 兵役台账（旧档自动补 0，不覆盖已有值）。 */
export function levyLedger(state, cityId) {
  const e = econOf(state, cityId);
  if (!e) return { levied: 0, lastLevyTurn: -1, levyCount: 0, levyTotal: 0 };
  if (e.levied == null) e.levied = 0;
  if (e.lastLevyTurn == null) e.lastLevyTurn = -1;
  if (e.levyCount == null) e.levyCount = 0;
  if (e.levyTotal == null) e.levyTotal = 0;
  return e;
}

/**
 * 该城兵源全景。所有界面数字都从这里取，不许自己再算一遍。
 * @returns {{pop,households,adultMales,exempt,levied,houseBalance,seasonalCap,turnCap,
 *            quota,season,seasonFactor,turn,lastLevyTurn,nextTurn,armsFactor,
 *            canLevy,reason,reasonText,hint}}
 */
export function levyView(state, cityId, opts = {}) {
  const id = Number(cityId);
  const e = econOf(state, id);
  const pop = Math.max(0, Math.floor(num(e?.pop, 0)));
  const households = Math.floor(pop / HOUSEHOLD_SIZE);
  /* 妇孺老少：把「无适龄壮丁的户」显式算出来并下发，界面要显示这一栏 */
  const adultMales = Math.floor(households * ADULT_MALE_RATE);
  const exempt = Math.max(0, households - adultMales);
  const ledger = levyLedger(state, id);
  const levied = Math.max(0, Math.floor(num(ledger.levied, 0)));
  const houseBalance = Math.max(0, adultMales - levied);

  const season = seasonOf(state);
  const seasonFactor = SEASON_FACTOR[season] ?? 1;
  const armsFactor = clamp(0.7 + num(e?.devArms, 50) / 250, 0.7, 1.2);
  const rate = clamp(num(opts.rate, 0.06), 0.01, 0.2);
  const seasonalCap = Math.max(0, Math.floor(pop * rate * armsFactor * seasonFactor));
  const turnCap = Math.max(0, Math.floor(pop * TURN_CAP_RATE));
  const quota = Math.max(0, Math.min(houseBalance, seasonalCap, turnCap));

  const turn = levyTurnOf(state);
  const lastTurn = Math.floor(num(ledger.lastLevyTurn, -1));
  const cooling = lastTurn === turn;
  let reason = '';
  let reasonText = '';
  let hint = '';
  if (pop <= 0) { reason = 'no_population'; reasonText = '此城无人口'; hint = '先办「劝课生息」招徕流民。'; }
  else if (cooling) { reason = 'levy_cooldown'; reasonText = '本旬已征过兵'; hint = '每旬只征一次，推进到下一旬再来；或先办内政增殖人口。'; }
  else if (houseBalance <= 0) { reason = 'levy_exhausted'; reasonText = '各户壮丁已尽（一户一丁）'; hint = '妇孺老弱不可征；办「劝课生息」增加户口后才有新丁。'; }
  else if (quota <= 0) { reason = 'need_population'; reasonText = '兵源不足，需先发展人口'; hint = '办「劝课生息」或等人口自然增长。'; }

  return {
    pop, households, adultMales, exempt, levied, houseBalance,
    seasonalCap, turnCap, quota, season, seasonFactor, armsFactor,
    turn, lastLevyTurn: lastTurn, nextTurn: turn + 1,
    canLevy: !reason && quota > 0, reason, reasonText, hint,
    popCostPerSoldier: POP_PER_SOLDIER,
  };
}

/**
 * 征兵前的唯一校验口。返回 { ok, reason, quota, levy }。
 * `strict=false`（未举义/旧档无玩家城）时跳过人口限制，保持旧行为，避免锁死老存档。
 */
export function checkLevy(state, cityId, count, opts = {}) {
  const want = Math.max(0, Math.floor(num(count, 0)));
  const levy = levyView(state, cityId, opts);
  if (opts.strict === false) return { ok: true, reason: '', quota: want || levy.quota, levy, count: want };
  if (want <= 0) return { ok: false, reason: 'zero', quota: levy.quota, levy, count: 0 };
  if (!levy.pop) return { ok: false, reason: 'no_population', quota: 0, levy, count: want };
  if (levy.lastLevyTurn === levy.turn) return { ok: false, reason: 'levy_cooldown', quota: 0, levy, count: want };
  if (want > levy.quota) {
    return {
      ok: false,
      reason: levy.houseBalance <= 0 ? 'levy_exhausted' : (levy.quota <= 0 ? 'need_population' : 'over_quota'),
      quota: levy.quota, levy, count: want,
    };
  }
  return { ok: true, reason: '', quota: levy.quota, levy, count: want };
}

/**
 * 征兵成功后写台账 + 扣人口基数。必须由 handlers 在资源扣除成功之后调用一次。
 * 人口按 GDD 的 ×4 扣，但不低于 1 户（留 5 口），避免城市被一次征空。
 */
export function commitLevy(state, cityId, count) {
  const id = Number(cityId);
  const e = econOf(state, id);
  if (!e) return null;
  const ledger = levyLedger(state, id);
  const want = Math.max(0, Math.floor(num(count, 0)));
  const popBefore = Math.max(0, Math.floor(num(e.pop, 0)));
  const popAfter = Math.max(HOUSEHOLD_SIZE, popBefore - want * POP_PER_SOLDIER);
  e.pop = popAfter;
  ledger.levied = Math.max(0, Math.floor(num(ledger.levied, 0))) + want;
  ledger.lastLevyTurn = levyTurnOf(state);
  ledger.levyCount = Math.max(0, Math.floor(num(ledger.levyCount, 0))) + 1;
  ledger.levyTotal = Math.max(0, Math.floor(num(ledger.levyTotal, 0))) + want;
  /* 抽丁伤民心：按抽走人口占比折算，与旧 P7 系数同量级 */
  const bite = (want * POP_PER_SOLDIER / Math.max(1, popBefore)) * 60;
  e.morale = Math.max(0, Math.round((num(e.morale, 60) - bite) * 10) / 10);
  return { popBefore, popAfter, popCost: popBefore - popAfter, levy: levyView(state, id) };
}

/** 春征超过上限 50% → 秋收田赋 −15%（GDD §5.5 农时冲突，提前显示在预览里）。
 *  ★ 必须在 commitLevy **之前**调用：抽丁会扣人口，人口一少 seasonalCap 就缩水，
 *    用扣完的人口算比例会虚高（实测出现过「本次 125%」这种不可能的数）。 */
export function farmConflictOf(state, cityId, count, opts = {}) {
  const levy = levyView(state, cityId, opts);
  if (levy.season !== '春' || levy.seasonalCap <= 0) return null;
  const ratio = num(count, 0) / levy.seasonalCap;
  if (ratio <= 0.5) return null;
  return { penaltyPct: 15, note: `春耕抽丁超过兵源上限 50%：秋收田赋 −15%（本次 ${Math.round(ratio * 100)}%）` };
}
