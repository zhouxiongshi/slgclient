/**
 * 人事关系层（U15）：相性 / 义理 / 关系网 / 登庸成功率构成条。
 *
 * 为什么单独一层：
 *  - `panels.js` 刻意不 import `strategy.js`（避免环），而武将详情要显示相性与关系网；
 *  - `handlers.js`（登庸掷骰）与 UI（成功率构成条）必须走**同一个**函数，
 *    否则又回到「描述一套、计算一套」的老毛病（设计规格 2.3）。
 *
 * 数据口径（必须诚实标注）：
 *  - 相性：本作设定。势力锚点 + cfgId 确定性散列，落在 1–149 环形上。
 *    **不是史实**，界面上要写「本作设定」，[terms.json](conf/interaction/terms.json) 的 xiangxing 词条同步。
 *  - 义理：由史载五维（政治×0.6 + 魅力×0.4）折算，属派生值，标 E2。
 *  - 关系网：只收《三国演义》可考的成对关系，逐条带 source 与 confidence。
 *
 * 零内部依赖：只 import oath.js（叶子模块，只读 lore json）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loreStat, protagonistStat } from './oath.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONF_PATH = resolve(ROOT, 'conf', 'relations.json');

let CONF = null;
export function relationConf() {
  if (!CONF) CONF = JSON.parse(readFileSync(CONF_PATH, 'utf8'));
  return CONF;
}

/** 稳定散列（FNV-1a 变体），与 tavern.js 的 mix 不同实现但同样确定性。 */
function hash32(n) {
  let x = (Number(n) || 0) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** 相性：1–149 环形（149 个取值，跨端相接）。势力锚点 ± spread。 */
export function xiangxingOf(cfgId, camp) {
  const c = relationConf().xiangxing;
  const ring = Number(c.ring) || 149;
  const anchor = Number(c.anchors[String(camp ?? 1)]);
  const base = Number.isFinite(anchor) ? anchor : 75;
  const spread = Number(c.spread) || 12;
  const off = (hash32(cfgId) % (spread * 2 + 1)) - spread;
  // 先落 0..148 再 +1，保证永远在 1..149（旧写法会溢出成 150）
  const v = (((base + off - 1) % ring) + ring) % ring;
  return v + 1;
}

/** 相性差（环形最短距离 0–74）。 */
export function xiangxingGap(a, b) {
  const ring = Number(relationConf().xiangxing.ring) || 149;
  const d = Math.abs((Number(a) || 1) - (Number(b) || 1)) % ring;
  return Math.min(d, ring - d);
}

/** 义理 0–100：史载政治/魅力折算，无史料按 50。 */
export function yiliOf(cfgId) {
  const pol = loreStat(cfgId, '政治');
  const chr = loreStat(cfgId, '魅力');
  return Math.max(0, Math.min(100, Math.round(pol * 0.6 + chr * 0.4)));
}

/** 相性差 → 加成百分点：同相性 +12，差 75（最远）−12，线性。 */
export function xiangxingBonus(gap) {
  return Math.round((0.5 - (Number(gap) || 0) / 74) * 24 * 10) / 10;
}

/** 某武将的成对关系（按名字查，返回 [{other,type,note,source,confidence,tone}]）。 */
export function bondsOf(name) {
  if (!name) return [];
  const conf = relationConf();
  const tone = conf.typeToTone || {};
  return (conf.bonds || [])
    .filter((b) => b.a === name || b.b === name)
    .map((b) => ({
      other: b.a === name ? b.b : b.a,
      type: b.type, note: b.note, source: b.source, confidence: b.confidence,
      tone: tone[b.type] || 'sworn',
    }));
}

/** 面板用摘要：{ sworn: [...], rival: [...], lord: [...], note }。 */
export function relationSummary(name) {
  const all = bondsOf(name);
  const pick = (t) => all.filter((b) => b.tone === t).map((b) => ({
    name: b.other, type: b.type, note: b.note, source: b.source,
  }));
  return {
    sworn: pick('sworn'),
    lord: pick('lord'),
    rival: pick('rival'),
    note: all.length
      ? '关系取自《三国演义》可考条目，逐条注明回目；相性为本作设定。'
      : '演义中未收此人的成对关系；相性/义理仍按势力与史载五维折算。',
  };
}

/**
 * 登庸成功率（在野贤才）—— 唯一权威公式。
 * 返回 { rate, parts }：parts 各项相加 = rate（百分点，未截断前），便于「构成条」逐项展示。
 *
 * 参数口径：
 *  - 君主政治：protagonistStat(state,'政治')，0–100
 *  - 相性差：君主与本人的相性环距，越近越容易
 *  - 义理：本人义理越高越不肯背主（在野时义理高=择主严）
 *  - 三顾之礼：被拒一次 +12
 */
export function talentRecruitRate(state, cfg, person) {
  const lordCfgId = 880001;                          // 穿越者（本局主公）
  const lordPol = protagonistStat(state, '政治');
  const g = cfg?.generalByCfg?.get?.(Number(person?.cfgId));
  const camp = g?.camp ?? 1;
  const lordCamp = cfg?.generalByCfg?.get?.(lordCfgId)?.camp ?? 1;
  const gap = xiangxingGap(xiangxingOf(lordCfgId, lordCamp), xiangxingOf(person?.cfgId, camp));
  const yili = yiliOf(person?.cfgId);
  const favorN = Number(state?.tavern?.favor?.[person?.cfgId] || 0);

  const base = 40;
  const polPart = Math.round(lordPol * 0.3 * 10) / 10;
  const xxPart = xiangxingBonus(gap);
  const ylPart = Math.round(((60 - yili) * 0.2) * 10) / 10;   // 义理越高越难挖
  const favorPart = favorN * 12;
  const raw = base + polPart + xxPart + ylPart + favorPart;
  const rate = Math.max(5, Math.min(95, raw));
  const parts = [
    { label: '基础成功率', value: base },
    { label: `君主政治 ${Math.round(lordPol)}（每点 +0.3%）`, value: polPart },
    { label: `相性差 ${gap}（环形 0–74，越近越易）`, value: xxPart },
    { label: `义理 ${yili}（高义理难挖）`, value: ylPart },
  ];
  if (favorPart) parts.push({ label: `三顾之礼 ×${favorN}（每次 +12%）`, value: favorPart });
  if (rate !== raw) {
    parts.push({ label: rate > raw ? '保底 5% 提权' : '上限 95% 截断', value: Math.round((rate - raw) * 10) / 10 });
  }
  return { rate: Math.round(rate * 10) / 10, parts, gap, yili };
}

/** 关系网（可视用）：只在已拥有武将之间连边，避免把未招募的关系泄露给玩家。 */
export function relationGraph(generals, nameOf) {
  const names = new Set((generals || []).map((g) => nameOf(g)));
  const edges = [];
  const seen = new Set();
  for (const g of generals || []) {
    const me = nameOf(g);
    for (const b of bondsOf(me)) {
      if (!names.has(b.other)) continue;
      const key = [me, b.other].sort().join('|') + b.type;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: me, to: b.other, type: b.type, tone: b.tone, note: b.note });
    }
  }
  return { nodes: [...names], edges };
}
