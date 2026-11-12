/**
 * 地图标注分级（验收 #22：密度随缩放分级，72 城不全量标注）。
 *
 * 为什么分级放在服务端算：一座城该不该标是**城市重要性**的判断（等级/守军/是否玩家本城），
 * 属于领域口径，必须可单测、可解释；而「当前缩放到第几档」纯粹是客户端视口状态。
 * 于是这里的职责边界是：
 *   - `cityLabelRank` 给视图层的每座城打 rank（1 要城 / 2 中城 / 3 小城）；
 *   - `labelPolicy()` 下发档位阈值，客户端只做 `rank <= 当前档` 的过滤与屏幕占位去重。
 * 这样「哪座城算要城」只有一处口径，不会出现服务端和前端各判一套。
 */

/** 缩放档位：小于 1.8 倍只标要城，1.8 倍起补中城，2.8 倍起全标。 */
export const ZOOM_TIERS = [
  { zoom: 1, rank: 1, name: '轮廓', desc: '只看要城与己方本城' },
  { zoom: 1.8, rank: 2, name: '州郡', desc: '补标郡治与有驻军的城' },
  { zoom: 2.8, rank: 3, name: '城池', desc: '全量标注，含小县' },
];

/** 一档最低标什么：rank 数值越小越重要。 */
export function cityLabelRank(c, { isPlayer = false } = {}) {
  if (isPlayer) return 1;
  const lv = Number(c?.level) || 1;
  const troops = Number(c?.troops) || 0;
  if (lv >= 3 || troops >= 3000) return 1;
  if (lv === 2 || troops >= 1200) return 2;
  return 3;
}

/** 当前缩放能标到第几档（rank 上限）。缩放钳在 1~4，与地图 view.zoom 同口径。 */
export function labelTierForZoom(zoom) {
  const z = Math.max(1, Math.min(4, Number(zoom) || 1));
  let tier = 1;
  for (const t of ZOOM_TIERS) if (z >= t.zoom - 1e-6) tier = t.rank;
  return tier;
}

/** 下发给客户端的策略：档位阈值 + 屏幕最小占位间距（像素，未乘缩放）。 */
export function labelPolicy() {
  return {
    tiers: ZOOM_TIERS.map((t) => ({ zoom: t.zoom, rank: t.rank, name: t.name, desc: t.desc })),
    /* 两个标签在屏幕上小于这个间距就只留重要的那个；放大后间距变大，小城自然露出来。 */
    minGap: 34,
  };
}

/** 该城在当前缩放下是否允许标注（不含屏幕占位去重，那一步在客户端做）。 */
export function shouldLabel(c, zoom, { isPlayer = false } = {}) {
  return cityLabelRank(c, { isPlayer }) <= labelTierForZoom(zoom);
}
