/**
 * M4-8 武将属性平衡回归。
 *
 * 背景：M3-4 把 heroes-240.json 的史载五维（0~100）直接 ×100 当战斗数值
 * （0~10000），造成百倍极差、成长只有原表一半、攻城/统御按剧情权重分档。
 * 同条件下吕布对刘璋 Lv10 对轰伤害比 7.36 倍。M4-8 引入
 * server/domain/general-stat.js 统一压缩映射，并让战斗/内政/外交/行军同口径。
 *
 * 硬纪律：史实原表逐字不动，只测派生层与调用层；不依赖技能表内容，
 * 避免与「全武将初始战法」工作线互相干扰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import {
  toGameStat, toGameGrow, toDestroyStat, toCostStat, gameStatOf, charmStatOf,
} from '../server/domain/general-stat.js';
import { officerStat } from '../server/domain/interior-task.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
/** 静态断言只扫代码行，避免注释里引用旧字面量造成假红（M4-6 踩过的坑）。 */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const median = (a) => {
  const v = [...a].sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
};

const cfg = loadConfig();
const all = [...cfg.generalByCfg.values()];
const original = all.filter((g) => Number(g.cfgId) < 240001 && Number(g.cfgId) !== 880001);
const derived = all.filter((g) => Number(g.cfgId) >= 240001 && Number(g.cfgId) !== 880001);
const FIVE_KEYS = ['force', 'strategy', 'defense', 'speed'];

test('派生映射：单调、钳位、极差 ≤3.6 倍，成长与原表同量级', () => {
  assert.equal(toGameStat(0), 2500);
  assert.equal(toGameStat(100), 9000);
  for (let v = 1; v <= 100; v += 1) {
    assert.ok(toGameStat(v) > toGameStat(v - 1), `史载 ${v} 必须严格强于 ${v - 1}`);
  }
  assert.equal(toGameStat(-30), 2500);
  assert.equal(toGameStat(500), 9000);
  assert.equal(toGameStat(NaN), 5750);           // 缺史载按 50 兜底
  assert.ok(toGameGrow(0) >= 25 && toGameGrow(100) <= 80);
  assert.ok(toGameGrow(62) >= 50, '成长中位必须与原表 63 同量级');
  assert.ok(toDestroyStat(0, 0) < toDestroyStat(100, 100));
  assert.ok(toCostStat(195) < toCostStat(442));
});

test('史实派生段：四项主属性全部落在 2500~9000，极差 ≤3.6 倍', () => {
  assert.ok(derived.length >= 100, `派生武将数量异常：${derived.length}`);
  for (const k of FIVE_KEYS) {
    const v = derived.map((g) => Number(g[k])).filter(Number.isFinite);
    const lo = Math.min(...v), hi = Math.max(...v);
    assert.ok(lo >= 2500, `${k} 下限 ${lo} 过低（旧实现会让武力 8 的人只有 800）`);
    assert.ok(hi <= 9000, `${k} 上限 ${hi} 越界`);
    assert.ok(hi / lo <= 3.6, `${k} 极差 ${(hi / lo).toFixed(2)} 倍，仍会击穿平衡`);
  }
  const dGrow = derived.map((g) => Number(g.force_grow));
  assert.ok(median(dGrow) >= 50, `派生成长中位 ${median(dGrow)} 仍只有原表一半`);
  assert.ok(Math.abs(median(dGrow) - median(original.map((g) => Number(g.force_grow)))) <= 12,
    '派生段与原表成长必须同量级');
});

test('攻城与统御不再由剧情权重 layer 决定', () => {
  const destroys = new Set(derived.map((g) => Number(g.destroy)));
  assert.ok(destroys.size >= 20, `攻城只有 ${destroys.size} 种取值，仍像按 star 分档`);
  const costs = new Set(derived.map((g) => Number(g.cost)));
  assert.ok(costs.size >= 15, `统御只有 ${costs.size} 种取值，仍像按 layer 分档`);
  // 同 layer 内部必须允许不同的 cost / destroy
  const doc = JSON.parse(read('conf/campaign/heroes-240.json'));
  const byName = new Map(doc.heroes.map((h) => [h.name, h]));
  const coreVals = derived.filter((g) => byName.get(g.name)?.layer === 'core');
  assert.ok(new Set(coreVals.map((g) => g.destroy)).size > 1, 'core 层攻城值不该完全相同');
  assert.ok(new Set(coreVals.map((g) => g.cost)).size > 1, 'core 层统御不该完全相同');
});

test('史实原表未被改写，派生逻辑只剩一处', () => {
  const doc = JSON.parse(read('conf/campaign/heroes-240.json'));
  assert.equal(doc.heroes.length, 240);
  const five = doc.heroes.flatMap((h) => Object.values(h.five || {}));
  assert.ok(Math.max(...five) <= 100 && Math.min(...five) >= 0, '史载五维必须仍是 0~100');
  const configSrc = codeOnly(read('server/config.js'));
  assert.match(configSrc, /toGameStat\(/, 'config.js 必须走统一派生层');
  assert.doesNotMatch(configSrc, /Number\(five\.wu\) \|\| 50\) \* 100/,
    '不许回退到「史载五维 ×100」的旧写法');
});

test('跨系统同口径：主公按维度取值，四个调用点不再硬编码', () => {
  const row = cfg.generalByCfg.get(880001);
  assert.ok(row, '主公必须已并入 generalByCfg');
  const prot = { id: 1, cfgId: 880001, isProtagonist: true };
  for (const k of ['force', 'strategy', 'defense', 'speed', 'destroy']) {
    assert.equal(gameStatOf(cfg, prot, k), row[k], `主公 ${k} 必须取 protagonist.json`);
  }
  assert.equal(officerStat(cfg, prot, 'strategy'), row.strategy);
  assert.equal(officerStat(cfg, prot, 'charm'), row.strategy);
  assert.equal(charmStatOf(15), toGameStat(15));
  for (const rel of [
    'server/domain/city-econ.js', 'server/domain/interior-task.js',
    'server/domain/diplomacy.js', 'server/domain/strategy.js',
  ]) {
    assert.match(codeOnly(read(rel)), /gameStatOf\(/, `${rel} 必须走统一取数`);
    assert.doesNotMatch(codeOnly(read(rel)), /isProtagonist\s*\?\s*7400/,
      `${rel} 不许回退到主公恒取 7400`);
  }
});

test('实战倍率：吕布对刘璋 Lv10 对轰伤害比 ≤3.5（修复前 7.36）', () => {
  const lv = all.find((g) => g.name === '吕布');
  const lz = all.find((g) => g.name === '刘璋');
  assert.ok(lv && lz);
  const attr = (g, k, grow) => Math.round(Number(g[k]) / 100)
    + (Math.round(Number(g[grow]) / 100 * 10) / 10) * 9;
  const factor = (d) => 1 - 0.5 * (d / (d + 200));   // corrected 减伤方向
  const ratio = (attr(lv, 'force', 'force_grow') * factor(attr(lz, 'defense', 'defense_grow')))
    / (attr(lz, 'force', 'force_grow') * factor(attr(lv, 'defense', 'defense_grow')));
  assert.ok(ratio <= 3.5, `对轰倍率 ${ratio.toFixed(2)} 仍超出可接受区间`);
});

test('UI 明确标注两套口径，避免 7,200 与史载 98 被误读为 70 倍差距', () => {
  const ui = read('server/panels-ui.js');
  assert.match(ui, /本局战斗数值 0~10000/);
  assert.match(ui, /史料档案 · 史载五维（0~100）/);
  assert.match(ui, /史载统率 /);
  assert.match(ui, /两套口径不可直接比较/);
});
