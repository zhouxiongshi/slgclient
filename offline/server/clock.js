/**
 * 游戏时钟。只回答「现在是第几日、走了几日、行军要多少毫秒」。
 * 不扣粮，不触发剧情。
 */

export function advanceClock(state, now, rules) {
  const clock = state.clock;
  const scale = clock.scale || 1;
  /* mapMsPerDay 只给沙盘自动走日用，不改 scale（scale 仍只允许 1 或 4）。 */
  const msPerDay = Math.max(400, Math.round(
    Number(clock.mapMsPerDay) > 0
      ? Number(clock.mapMsPerDay)
      : ((rules.realMsPerDay ?? 60000) / scale),
  ));
  /* 城池页、出征窗、决策框打开时客户端续期 uiHoldUntil。
     停住时把 lastRealMs 拨到现在，松手后不会把停着的时间一次补回来。 */
  /* 城下还有没下令的仗，或者操作界面开着：日子停住，松手后不补走。 */
  if (clock.decisionHold || (clock.uiHoldUntil || 0) > now) {
    clock.lastRealMs = now;
    clock.accMs = 0;
    return { days: 0, day: clock.day, msPerDay };
  }
  const elapsed = Math.max(0, now - (clock.lastRealMs ?? now));
  clock.lastRealMs = now;
  clock.accMs = (clock.accMs || 0) + elapsed;
  const max = rules.maxDaysPerSettle ?? 40;
  let days = 0;
  while (clock.accMs >= msPerDay && days < max) {
    clock.accMs -= msPerDay;
    days += 1;
  }
  if (days >= max) clock.accMs = 0;
  clock.day += days;
  return { days, day: clock.day, msPerDay };
}

/** 测试和存档跳日：把上次结算拨回 N 个游戏日。下一次 settle 才会真正入账。 */
export function rewindDays(state, days, rules, now = Date.now()) {
  const scale = state.clock?.scale || 1;
  const msPerDay = Math.max(1, Math.round((rules.realMsPerDay ?? 60000) / scale));
  state.clock.lastRealMs = now - days * msPerDay;
  state.clock.accMs = 0;
}

/**
 * 行军时长。options.travelMs 为 3000 时视为「未指定」，改走距离；
 * 冒烟和协议测试传入更小的固定值时保持原样，避免用例被行军拖长。
 */
export function marchMs(state, fromX, fromY, toX, toY, rules, overrideMs) {
  if (overrideMs != null && overrideMs !== 3000) return overrideMs;
  const scale = state.clock?.scale || 1;
  const tiles = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY));
  const sec = Math.min(
    rules.marchMaxSec ?? 40,
    Math.max(rules.marchMinSec ?? 3, tiles * (rules.marchSecPerTile ?? 1.5)),
  );
  return Math.max(1, Math.round((sec * 1000) / scale));
}
