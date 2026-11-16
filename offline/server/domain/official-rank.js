/**
 * 功勋与官阶（2026-11-16）—— 玩家与诸侯 AI 共用的一条「按功升官」口径。
 *
 * 为什么需要：
 *  - 旧版 state.panelMerits[id].merits 是只写不读的死字段，武将打仗/守城/内政
 *    也没有功勋来源；诸侯名册更连 merit 字段都没有。用户反馈「玩家越来越强，
 *    诸侯停滞不前，武将提升很慢」，根因之一就是 AI 没有可积累的功勋轴。
 *  - 本模块给出唯一的功勋累积与官阶换算：功勋只增不减，官阶按累计功勋晋升，
 *    官阶再反哺统帅（统兵）与政治（治政）能力，形成「立功→升官→更强」闭环。
 *
 * 纪律：零依赖叶子（禁止 import 任何 domain / server 模块）。
 *  - 只处理数字：功勋、官阶、能力加成，不碰史载五维原表；
 *  - 全部确定性、无随机，同输入同输出，供玩家面板与 AI 结算同源；
 *  - 官阶 0~9（0 白身，9 丞相/太尉级别），能力加成在 general-stat.effectiveStatOf
 *    里 clamp 到 100，绝不突破百分制红线。
 */

export const RANK_CAP = 9;
export const RANK_NAMES = [
  '白身', '亭长', '啬夫', '县吏', '郡掾', '别部司马', '校尉', '中郎将', '四方将军', '三公',
];

/** 升到官阶 r（1~9）所需的累计功勋。曲线递增，越到高阶越难。 */
export function meritForRank(r) {
  const n = Math.max(1, Math.min(RANK_CAP, Math.trunc(Number(r) || 1)));
  return 40 * n * n; // 40 / 160 / 360 / 640 / 1000 / 1440 / 1960 / 2560 / 3240
}

/** 由累计功勋换算官阶（0~9），只升不降。 */
export function rankOfMerit(merit) {
  const m = Math.max(0, Math.trunc(Number(merit) || 0));
  let r = 0;
  for (let i = 1; i <= RANK_CAP; i += 1) {
    if (m >= meritForRank(i)) r = i;
    else break;
  }
  return r;
}

export function rankName(merit) {
  return RANK_NAMES[rankOfMerit(merit)];
}

/**
 * 带兵上限（2026-11-16）：每槽基础 5000，官阶每升一阶 +300。
 * 0 阶白身 5000 → 9 阶三公 7700。只按累计功勋换算，功高者自然能多带一营。
 * 这是「官职高统兵能力强」在兵力层面的落点（统帅值加成走 general-stat.effectiveStatOf）。
 * 零依赖、确定性；满级仍远低于一城兵源，不破坏城库/粮草硬闸。
 */
export const SLOT_CAP_BASE = 5000;
export const SLOT_CAP_PER_RANK = 300;
export function slotCapForRank(rank) {
  const r = Math.max(0, Math.min(RANK_CAP, Math.trunc(Number(rank) || 0)));
  return SLOT_CAP_BASE + r * SLOT_CAP_PER_RANK;
}
/** 由任意带 merit 字段的对象取带兵上限（空对象/空槽回退基础 5000）。 */
export function slotCapOf(officer) {
  return slotCapForRank(rankOfMerit(officer?.merit));
}

/**
 * 由本局属性行判定职业标签（纯数字、零依赖，与面板 careerOf 的史载口径互补）。
 * 取五维最高项：政治/谋略归 civil/strategist（文治），供政治加成判型；
 * 其余归武职。数值来自 config 归一化后的 generalByCfg（0~100）。
 */
export function careerTagOf(row) {
  const dims = [
    ['force', 'warrior'], ['strategy', 'strategist'], ['defense', 'commander'],
    ['politics', 'civil'], ['destroy', 'commander'],
  ];
  let top = 'generalist';
  let topVal = -1;
  for (const [key, tag] of dims) {
    const v = Number(row?.[key]) || 0;
    if (v > topVal) { topVal = v; top = tag; }
  }
  return topVal < 60 ? 'generalist' : top;
}

/** 各类行为的功勋权重（整数）。内政/守城/攻城/斩将/以少胜多。 */
export const MERIT_GAIN = {
  battle: 12,       // 参战并取胜
  defense: 10,      // 守城成功
  capture: 16,      // 攻城略地
  interior: 6,      // 督办内政按期完工
  upset: 20,        // 以少胜多额外
};

/**
 * 给任意「带 merit 字段的对象」累加功勋并返回新官阶 { merit, rank, promoted }。
 * 调用方负责把 merit 写回对象；本函数不改入参。
 */
export function addMerit(officer, amount, kind = '') {
  const before = Math.max(0, Math.trunc(Number(officer?.merit) || 0));
  const w = Number.isFinite(Number(amount)) ? Math.trunc(Number(amount)) : (MERIT_GAIN[kind] || 0);
  const merit = before + Math.max(0, w);
  const rank = rankOfMerit(merit);
  return { merit, rank, promoted: rank > rankOfMerit(before), gain: Math.max(0, w) };
}

/**
 * 结算一名武将的功勋并回写，返回是否升官。input 为 { merit, rank } 的对象。
 * 功勋只增；官阶由功勋唯一决定，不单独存（避免两处口径漂移）。
 */
export function grantMerit(officer, amount, kind = '') {
  const r = addMerit(officer, amount, kind);
  officer.merit = r.merit;
  officer.rank = r.rank;
  return r;
}
