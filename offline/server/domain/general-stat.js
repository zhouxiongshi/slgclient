/**
 * 武将属性口径的唯一派生层（零环依赖叶子模块，禁止 import 任何 domain / server 模块）。
 *
 * 背景（M4-8 平衡纠偏）：
 *   原客户端 general.json 的五维是「游戏战斗数值」0~10000，是设计好的平衡曲线；
 *   heroes-240.json 的史载五维（统率/武力/智力/政治/魅力）是 0~100 的史书评价。
 *   M3-4 曾把后者直接 ×100 当战斗数值用，结果：
 *     · 武力 8 的虚构人物 → force 800，武力 100 → 10000，极差 12.5 倍；
 *     · *_grow 由 five/2 得 5~50，而原表是 30~100，Lv10 差距再放大约 2 倍；
 *     · destroy 只按 layer 分 1400/1700/2000 三档，与人物能力完全脱钩；
 *     · cost 也按 layer 定 35~45，core 层低维武将反而最贵。
 *   同一场战斗里，原表吕布对史实派生刘璋的 Lv10 对轰伤害比达 7.36 倍。
 *
 * 修法：史实原表 heroes-240.json 逐字不动（M4-1 数据溯源红线），只在「史载五维
 *   → 本局战斗数值」这一层做单调压缩映射，让派生段与原表落在同一量级、同一
 *   成长速率；并且战斗 / 内政 / 外交 / 行军全部通过本模块取数，杜绝两套口径。
 *
 * 口径约定：
 *   · 史载五维 0~100：仅用于史料档案、登庸、宿命、职业判定，不直接参与结算。
 *   · 本局战斗数值 0~10000：进内核前 /100（见 server/battle.js makeHero），
 *     也用于内政/外交/行军；主公同样是这套口径，取 protagonist.json 的对应维度。
 */

/** 史载五维钳位到 0~100；非数值按 50（「缺史载」的既有兜底）处理。 */
export function clampFive(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

/** 0~100 史载 → 0~10000 本局战斗数值。单调、极差 ≤3.6 倍（2500~9000）。 */
export function toGameStat(five) {
  return Math.round(2500 + clampFive(five) * 65);
}

/** 0~100 史载 → 0~100 每级成长（进内核再 /100）。25~80，与原表中位 63 同量级。 */
export function toGameGrow(five) {
  return Math.round(25 + clampFive(five) * 0.55);
}

/** 攻城：由统率/武力派生，不再由剧情权重 layer 决定（原表 100~7000，主体 1000~3500）。 */
export function toDestroyStat(tong, wu) {
  const avg = (clampFive(tong) + clampFive(wu)) / 2;
  return Math.round(500 + avg * 26);
}

/** 统御/招募 cost：由五维总和派生，不再由 layer 决定（原表 4~100，主体 15~40）。 */
export function toCostStat(fiveSum) {
  const s = Math.max(0, Number(fiveSum) || 0);
  return Math.max(10, Math.min(45, Math.round(10 + s / 14)));
}

/**
 * 取某位武将的本局战斗数值（0~10000）。
 * 主公（880001）已在 loadConfig 里并入 generalByCfg，因此无需任何硬编码分支。
 * 装备 / 战功增量由调用方自行叠加，本函数只返回基线。
 */
export function gameStatOf(cfg, g, key, fallback = 6000) {
  if (!g) return fallback;
  const row = cfg?.generalByCfg?.get?.(Number(g.cfgId));
  const v = Number(row?.[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 史载「魅力」在本局没有对应维度：走统一映射折算成 0~10000，
 * 而不是旧代码 ×80（那会让魅力 15 的人只有 1200、魅力 100 的人 8000）。
 */
export function charmStatOf(loreCharm) {
  return toGameStat(loreCharm);
}
