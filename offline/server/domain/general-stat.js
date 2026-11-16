/**
 * 武将属性口径的唯一派生层（零环依赖叶子模块，禁止 import 任何 domain / server 模块）。
 *
 * ★ M4-10 百分制（2026-11-14）
 *   玩家要求：所有人物基础属性上限 100，超过 100 的全部重新设计。
 *   本模块从此成为「唯一 0~100 口径」的守门人：
 *     · 对外（面板 / 战斗 / 内政 / 外交 / 行军）一律 0~100，与能力表同量纲；
 *     · conf/json/general/general.json 是原客户端「百分制 ×100」的设计值
 *       （force 8400 就是武力 84），在 config.loadConfig 里一次性归一化，
 *       归一化之后任何模块都读不到 0~10000；
 *     · heroes-240.json 的史载五维本来就是 0~100（同款），直通，
 *       不再做 ×100、也不再做 2500+65v 的压缩映射。
 *
 *   历史背景（M4-8）：旧实现把史载五维 ×100 当战斗数值，造成 100 倍极差、
 *   成长只有原表一半、吕布对刘璋 7.36 倍对轰；M4-8 用 2500+65v 压缩过，
 *   本次统一到百分制后压缩映射不再需要——上下限固定 1~100，而实际分布
 *   （原表中位 68、史实中位 65）本就落在的同一区间。
 *
 *   口径约定：
 *     · 本局战斗数值：0~100，进内核不再 ÷100（内核本来就是百分制）。
 *     · 史载五维：0~100，用于史料档案 / 登庸 / 宿命 / 政治 / 魅力。
 *     · 两者现在同一量纲，玩家可以直接比较，不再有「7200 vs 98」这种错觉。
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 史载五维钳位到 1~100；非数值按 50（「缺史载」的既有兜底）处理。 */
export function clampFive(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return clamp(Math.round(n), 1, 100);
}

/** 0~100 能力值直通（史载五维本身已是百分制）。 */
export function toGameStat(five) {
  return clampFive(five);
}

/**
 * 原表「百分制 ×100」→ 0~100。
 * 只在 config.loadConfig 归一化时使用；其余模块一律通过 gameStatOf 取值。
 */
export function toPercentFromRaw(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return clamp(Math.round(n / 100), 1, 100);
}

/** 0~100 史载 → 0~100 每级成长（内核再 /100*10 换成每级点数）。25~80，与原表同量级。 */
export function toGameGrow(five) {
  return Math.round(25 + clampFive(five) * 0.55);
}

/**
 * 攻城：由统率 / 武力派生，0~100。
 * 没有独立攻城维度（靠兵器适性），本作保留该维度作为「破城能力」，
 * 取统率六成 + 武力四成再压到 0~70——与原表 destroy 折算后（中位约 12、上限 70）
 * 同一量级，不改变攻城的相对强弱结构。
 */
export function toDestroyStat(tong, wu) {
  const avg = clampFive(tong) * 0.6 + clampFive(wu) * 0.4;
  return clamp(Math.round(avg * 0.2), 5, 70);
}

/** 统御 / 招募 cost：由五维总和派生（成本不是能力，仍是 10~45 的小整数）。 */
export function toCostStat(fiveSum) {
  const s = Math.max(0, Number(fiveSum) || 0);
  return Math.max(10, Math.min(45, Math.round(10 + s / 14)));
}

/**
 * 取某位武将的本局战斗数值（0~100）。
 * 主公（880001）已在 loadConfig 里并入 generalByCfg，因此无需任何硬编码分支。
 * 装备 / 战功增量由调用方自行叠加，本函数只返回基线。
 *
 * v > 100 的保险分支：万一有调用方绕过 loadConfig 归一化（脚本 / 旧存档），
 * 也不会把 0~10000 的值泄漏到面板和公式里。
 */
export function gameStatOf(cfg, g, key, fallback = 60) {
  if (!g) return fallback;
  const row = cfg?.generalByCfg?.get?.(Number(g.cfgId));
  const v = Number(row?.[key]);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return v > 100 ? toPercentFromRaw(v) : v;
}

/** 史载「魅力」→ 0~100（魅力本来就是 0~100，直通）。 */
export function charmStatOf(loreCharm) {
  return clampFive(loreCharm);
}

/**
 * 政治（第六维）：0~100 百分制，口径与其余五维一致。
 * 主公、史实武将、原表武将、AI 名册统一在 config.loadConfig 里补 politics，
 * 这里只负责取数与钳位；史载原表逐字不动，任何派生只在归一化层发生。
 */
export function politicsOf(fiveZheng) {
  return clampFive(fiveZheng);
}

/**
 * 官职加成后的有效属性值（0~100 封顶，破红线一律 clamp）。
 * rank 为官阶 0~9：武将的统帅（defense）与谋臣/政治家的政治（politics）随官阶提升。
 * 只叠加「官阶加成」，不动史载基线；缺参时退回基线。玩家面板与 AI 结算同源。
 */
export function effectiveStatOf(base, rank = 0, key = '', career = '') {
  const b = clampFive(base);
  const r = Math.max(0, Math.min(9, Math.trunc(Number(rank) || 0)));
  if (r === 0) return b;
  const isPoliticalCareer = career === 'civil' || career === 'strategist' || career === 'scholar';
  let bonus = 0;
  if (key === 'defense') bonus = r * 2;                    // 官阶高 → 统兵能力强
  else if (key === 'politics' && isPoliticalCareer) bonus = r * 3; // 谋臣/政治家治政更强
  else if (key === 'politics') bonus = r;                   // 其他武将小幅
  return clamp(b + bonus, 1, 100);
}
