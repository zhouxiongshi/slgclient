/**
 * M4-10 武将属性百分制回归（三国志11 口径）。
 *
 * 背景：M3-4 把 heroes-240.json 的史载五维（0~100）直接 ×100 当战斗数值，
 * 造成百倍极差、成长只有原表一半、攻城/统御按剧情权重分档（M4-8 用压缩映射
 * 临时压住了）。玩家后来明确要求「所有人物基础属性上限 100，超过 100 的全部
 * 重新设计」——M4-10 直接改成三国志11 百分制：
 *   · 对外（面板/战斗/内政/外交/行军）一律 0~100；
 *   · 原表 general.json 的「百分制 ×100」在 loadConfig 一次性归一化；
 *   · 与史载表交集的人物，以史载五维为权威覆盖原表主属性；
 *   · 成长按 (100-base)/9 收敛，Lv10 恰好不超过 100。
 *
 * 硬纪律：史实原表 heroes-240.json 逐字不动，只测派生层与调用层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import {
  toGameStat, toGameGrow, toDestroyStat, toCostStat, toPercentFromRaw,
  gameStatOf, charmStatOf,
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
const STATS = ['force', 'strategy', 'defense', 'speed', 'destroy'];

/** 复刻 battle.js makeHero 的成长收敛：每级点数按 (100-base)/9 封顶（向下取两位）。 */
const grownAt10 = (base, growPct) => {
  const raw = Math.round(((Number(growPct) || 30) / 100) * 10 * 100) / 100;
  const cap = Math.max(0, (100 - Number(base)) / 9);
  return Number(base) + 9 * Math.min(raw, Math.floor(cap * 100) / 100);
};

test('百分制钳位：1~100、单调不减、缺值兜底 50', () => {
  assert.equal(toGameStat(0), 1);
  assert.equal(toGameStat(1), 1);
  assert.equal(toGameStat(100), 100);
  assert.equal(toGameStat(500), 100, '超过 100 必须重新设计到上限内');
  assert.equal(toGameStat(-30), 1);
  assert.equal(toGameStat(NaN), 50);
  for (let v = 2; v <= 100; v += 1) {
    assert.ok(toGameStat(v) >= toGameStat(v - 1), `史载 ${v} 不许弱于 ${v - 1}`);
  }
});

test('原表「百分制 ×100」归一化：8400→84、10000→100、100→1', () => {
  assert.equal(toPercentFromRaw(8400), 84);
  assert.equal(toPercentFromRaw(10000), 100);
  assert.equal(toPercentFromRaw(100), 1);
  assert.equal(toPercentFromRaw(718), 7);
});

test('全表 505 位：五个战斗维度全部落在 1~100', () => {
  assert.ok(all.length >= 500, `武将表异常：${all.length}`);
  for (const k of STATS) {
    for (const g of all) {
      const v = Number(g[k]);
      assert.ok(Number.isFinite(v) && v >= 1 && v <= 100,
        `${g.name}.${k}=${v} 越界（三国志11 上限 100）`);
    }
  }
});

test('交集人物以史载五维为权威：吕布统率 70 覆盖原表 97', () => {
  const lv = all.find((g) => g.name === '吕布');
  const cc = all.find((g) => g.name === '曹操');
  const zg = all.find((g) => g.name === '诸葛亮');
  const gy = all.find((g) => g.name === '关羽');
  assert.ok(lv && cc && zg && gy, '名将必须在表内');
  // 史载五维：吕布 tong70/wu100/zhi35，曹操 tong98/wu72/zhi96，诸葛 zhi100
  assert.equal(lv.force, 100, '吕布武力应为 100');
  assert.equal(lv.defense, 70, '吕布统率必须取史载 70，不能沿用原表 97');
  assert.equal(lv.strategy, 35);
  assert.ok(cc.defense > lv.defense, '曹操统率必须高于吕布（史载 98 > 70）');
  assert.equal(zg.strategy, 100);
  assert.equal(gy.force, 97);
});

test('成长收敛：任何武将 Lv10 都不超过 100', () => {
  for (const k of STATS) {
    for (const g of all) {
      const v = grownAt10(g[k], g[`${k}_grow`]);
      assert.ok(v <= 100.001, `${g.name}.${k} Lv10=${v.toFixed(1)} 破上限`);
    }
  }
  // 高属性者成长必须慢：吕布武力 100 → 不再涨
  const lv = all.find((g) => g.name === '吕布');
  assert.equal(grownAt10(lv.force, lv.force_grow), 100);
});

test('派生量仍与原表同量级：成长 25~80、攻城 5~70、统御 10~45', () => {
  assert.ok(toGameGrow(0) >= 25 && toGameGrow(100) <= 80);
  assert.ok(toGameGrow(62) >= 50, '成长中位必须与原表同量级');
  assert.ok(toDestroyStat(0, 0) < toDestroyStat(100, 100));
  assert.ok(toDestroyStat(100, 100) <= 70);
  assert.ok(toCostStat(195) < toCostStat(442));
  assert.ok(toCostStat(500) <= 45);
  const g50 = all.map((g) => Number(g.force_grow)).filter(Number.isFinite);
  assert.ok(median(g50) >= 30 && median(g50) <= 80, `成长中位 ${median(g50)} 越界`);
});

test('史实原表未被改写，派生逻辑只剩一处', () => {
  const doc = JSON.parse(read('conf/campaign/heroes-240.json'));
  assert.equal(doc.heroes.length, 240);
  const five = doc.heroes.flatMap((h) => Object.values(h.five || {}));
  assert.ok(Math.max(...five) <= 100 && Math.min(...five) >= 0, '史载五维必须仍是 0~100');
  const configSrc = codeOnly(read('server/config.js'));
  assert.match(configSrc, /toGameStat\(/, 'config.js 必须走统一派生层');
  assert.match(configSrc, /toPercentFromRaw\(/, '原表必须在 loadConfig 归一化');
  assert.doesNotMatch(configSrc, /\*\s*100\)/, '不许回退到「史载五维 ×100」的旧写法');
});

test('跨系统同口径：主公按维度取值，四个调用点不再硬编码', () => {
  const row = cfg.generalByCfg.get(880001);
  assert.ok(row, '主公必须已并入 generalByCfg');
  assert.ok(Number(row.force) <= 100 && Number(row.force) >= 1, '主公也必须是百分制');
  const prot = { id: 1, cfgId: 880001, isProtagonist: true };
  for (const k of STATS) {
    assert.equal(gameStatOf(cfg, prot, k), row[k], `主公 ${k} 必须取 protagonist.json`);
  }
  assert.equal(officerStat(cfg, prot, 'strategy'), row.strategy);
  assert.equal(officerStat(cfg, prot, 'charm'), row.strategy);
  assert.equal(charmStatOf(15), 15);
  for (const rel of [
    'server/domain/city-econ.js', 'server/domain/interior-task.js',
    'server/domain/diplomacy.js', 'server/domain/strategy.js', 'server/domain/panels.js',
  ]) {
    assert.match(codeOnly(read(rel)), /gameStatOf\(|toPercentFromRaw\(/, `${rel} 必须走统一取数`);
    assert.doesNotMatch(codeOnly(read(rel)), /isProtagonist\s*\?\s*7400/,
      `${rel} 不许回退到主公恒取 7400`);
  }
});

test('实战倍率：吕布对刘璋 Lv10 对轰伤害比 ≤3.5（修复前 7.36）', () => {
  const lv = all.find((g) => g.name === '吕布');
  const lz = all.find((g) => g.name === '刘璋');
  assert.ok(lv && lz);
  const factor = (d) => 1 - 0.5 * (d / (d + 200));
  const ratio = (grownAt10(lv.force, lv.force_grow) * factor(grownAt10(lz.defense, lz.defense_grow)))
    / (grownAt10(lz.force, lz.force_grow) * factor(grownAt10(lv.defense, lv.defense_grow)));
  assert.ok(ratio <= 3.5, `对轰倍率 ${ratio.toFixed(2)} 仍超出可接受区间`);
});

test('UI 只讲一套口径：0~100，不再出现 0~10000 / ÷100', () => {
  const ui = codeOnly(read('server/panels-ui.js'));
  assert.match(ui, /本局战斗数值 0~100/);
  assert.match(ui, /史料档案 · 史载五维（0~100）/);
  assert.match(ui, /史载统率 /);
  assert.doesNotMatch(ui, /0~10000/, '面板不许再出现万分数值');
  assert.doesNotMatch(ui, /两套口径不可直接比较/, '两套口径已经统一，这句说明要删掉');
});
