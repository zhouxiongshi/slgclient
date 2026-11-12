/**
 * 招降规则：唯一权威公式（U08 / 设计规格 2.3「描述 = 计算 = 战报同源」）。
 *
 * 纪律：
 *  - 零内部依赖（只读 oath.js 的 protagonistStat），strategy.js 与 panels.js 都引它，
 *    避免 domain 层成环（panels.js 刻意不 import strategy.js，见该文件头注释）。
 *  - 面板展示的「降率」、确认框的成功率构成条、实际掷骰，全部走同一个函数。
 *  - 禁止在别处重写 0.45 / 0.05 / 0.002 这些系数。
 */
import { protagonistStat } from './oath.js';

/** 招降一次的花费（金）。 */
export const CAPTIVE_COST = 300;

/** 成功率，返回 0~1 的小数；上限 95%。 */
export function captiveRecruitRate(state, cap) {
  const pol = protagonistStat(state, '政治');
  return Math.min(0.95, 0.45 + (Number(cap?.days) || 0) * 0.05 + pol * 0.002);
}

/**
 * 成功率构成条（设计规格 6.2 / 6.8：逐项拆解，玩家点之前就该看到）。
 * 返回 { parts: [{label, value}], final }，单位百分点；parts 各项相加 === final。
 */
export function captiveRateParts(state, cap) {
  const pol = protagonistStat(state, '政治');
  const days = Number(cap?.days) || 0;
  const base = 45;
  const dayBonus = days * 5;
  const polBonus = pol * 0.2;
  const raw = base + dayBonus + polBonus;
  const final = Math.min(95, raw);
  const parts = [
    { label: '基础成功率', value: round1(base) },
    { label: `关押 ${days} 旬（每旬 +5%）`, value: round1(dayBonus) },
    { label: `君主政治 ${Math.round(pol)}（每点 +0.2%）`, value: round1(polBonus) },
  ];
  if (final < raw) parts.push({ label: '上限 95% 截断', value: round1(final - raw) });
  return { parts, final: round1(final) };
}

function round1(v) { return Math.round(v * 10) / 10; }
