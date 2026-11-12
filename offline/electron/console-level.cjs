/**
 * Electron `console-message` 事件的跨版本归一化。
 *
 * 为什么需要它：Electron 35 起，`console-message` 的回调参数从
 * `(event, level: number, message: string, line, sourceId)` 改成了
 * 「单个事件对象」`(details: { level: string, message, lineNumber, sourceId, frame })`。
 * 沿用旧的三参写法，`level` 会恒为 `undefined`，于是 `level >= 2` 永远为假
 * ——「控制台无 error」这项检测会变成永远成立的假结论（我们踩过这个坑：
 * 打了两个版本的「consoleErrors = 0」，其实从未生效）。
 *
 * 本模块是这一判断的**唯一口径**：smoke.cjs / ui-audit.cjs / main.cjs 共用。
 * 不要再在别处写第三个 `(_e, level, message)` 处理器。
 */

/** 把任意版本的 level 归一成 0..3（0=verbose/debug，1=info，2=warning，3=error）。 */
function consoleSeverity(level) {
  if (typeof level === 'number') {
    if (!Number.isFinite(level)) return 1;
    return Math.max(0, Math.min(3, Math.trunc(level)));
  }
  const s = String(level == null ? '' : level).toLowerCase();
  if (s === 'error') return 3;
  if (s === 'warning' || s === 'warn') return 2;
  if (s === 'debug' || s === 'verbose') return 0;
  /* 'info' 与未知值都按 info 处理：宁可漏报 warn，也不要因为拿不到 level 就全量误报 */
  return 1;
}

/** 把 `console-message` 的实参列表解析成 `{ level, message }`，兼容新旧两种签名。 */
function consolePayload(args) {
  const list = Array.isArray(args) ? args : [args];
  const a0 = list[0];
  if (list.length === 1 && a0 && typeof a0 === 'object' && 'message' in a0) {
    return { level: a0.level, message: a0.message };
  }
  /* 旧签名：第一个参数是 Event 对象，level/message 在其后 */
  return { level: list[1], message: list[2] };
}

/** 该条控制台输出是否应当被当作"错误"记进报告。 */
function isConsoleError(args, { ignore } = {}) {
  const d = consolePayload(args);
  const text = String(d.message == null ? '' : d.message);
  if (ignore && ignore.test(text)) return null;
  return consoleSeverity(d.level) >= 2 ? { level: d.level, message: text } : null;
}

module.exports = { consoleSeverity, consolePayload, isConsoleError };
