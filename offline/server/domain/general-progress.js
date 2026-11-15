/**
 * 武将等级。经验只来自出征折损，攒满一档就升级。
 *
 * 上限 10：内核五维按 (100 − 基础) / 9 配到第 10 级封顶，再往上会破表。
 * 学习槽 5 级开；觉醒槽 10 级，并且自带战法要到 10 级。
 * 已有等级只升不降。旧档里积着的经验，读档时一次性结算。
 */

export const GENERAL_LEVEL_CAP = 10;

/** 从当前等级升到下一级需要的经验。1→2 为 40，9→10 为 360。 */
export function expToAdvance(level) {
  const lv = Math.max(1, Math.trunc(Number(level) || 1));
  return 40 * lv;
}

/**
 * 把新增经验并进武将，按档升级。add 为 0 时只结算已有经验（读档用）。
 * 返回 { from, to, exp, need }。满级后经验清零，不再堆积。
 */
export function applyGeneralExp(g, add = 0) {
  const from = Math.max(1, Math.trunc(Number(g.level) || 1));
  let lv = from;
  let exp = Math.max(0, Math.trunc(Number(g.exp) || 0)) + Math.max(0, Math.trunc(Number(add) || 0));
  while (lv < GENERAL_LEVEL_CAP) {
    const need = expToAdvance(lv);
    if (exp < need) break;
    exp -= need;
    lv += 1;
  }
  if (lv >= GENERAL_LEVEL_CAP) exp = 0;
  g.level = lv;
  g.exp = exp;
  return { from, to: lv, exp, need: lv >= GENERAL_LEVEL_CAP ? 0 : expToAdvance(lv) };
}

/** 给界面用的进度。数字都在这里算，客户端只展示。 */
export function generalProgress(g) {
  const level = Math.max(1, Math.trunc(Number(g?.level) || 1));
  const exp = Math.max(0, Math.trunc(Number(g?.exp) || 0));
  const capped = level >= GENERAL_LEVEL_CAP;
  const need = capped ? 0 : expToAdvance(level);
  let next = '已满 10 级，五维成长到头';
  if (level < 5) next = '到 5 级开放学习槽';
  else if (level < GENERAL_LEVEL_CAP) next = '到 10 级，并且自带战法 10 级，开放觉醒槽';
  return { level, exp, need, capped, next };
}

/** 一场战斗的经验入账。返回真正升级了的武将。 */
export function grantBattleExp(state, cfg, expByGeneral) {
  const ups = [];
  for (const [gid, raw] of Object.entries(expByGeneral || {})) {
    const add = Math.max(0, Math.trunc(Number(raw) || 0));
    if (!add) continue;
    const g = (state.generals || []).find((x) => x.id === Number(gid));
    if (!g) continue;
    const r = applyGeneralExp(g, add);
    if (r.to > r.from) {
      const name = cfg?.generalByCfg?.get?.(g.cfgId)?.name || g.name || `武将${g.cfgId}`;
      ups.push({ id: g.id, name, from: r.from, to: r.to });
    }
  }
  return ups;
}

export function levelUpSentence(ups) {
  if (!ups?.length) return '';
  return ` ${ups.map((u) => `${u.name}升到 ${u.to} 级`).join('，')}。五维按成长率上涨。`;
}
