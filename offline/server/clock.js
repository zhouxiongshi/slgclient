/**
 * 游戏时钟。只回答「现在是第几日、走了几日、行军要多少毫秒」。
 * 不扣粮，不触发剧情。
 */

export function advanceClock(state, now, rules) {
  const clock = state.clock;
  const scale = clock.scale || 1;
  const msPerDay = Math.max(1, Math.round((rules.realMsPerDay ?? 60000) / scale));
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
