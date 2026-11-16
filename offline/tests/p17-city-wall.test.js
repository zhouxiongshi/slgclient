/**
 * P17 城防与攻城属性（用户 2026-11-17「武将的攻城属性目前没有用处，
 * 城防在游戏攻占中没有起到实际意义」）。
 *
 * 旧实现：城墙 = 参数表 siegeWallMul 恒 1.5，乘在守军 defence_base 上，
 * 全服每座城同一个值；玩家的攻城值（destroy）进不了任何公式，
 * 城防也只是面板上的一个百分数。
 *
 * 新口径（详见 server/domain/city-wall.js）：
 *   · 城墙耐久 wallMax = 基础 + 等级 × 每级 + 城防属性 × 每点；
 *   · 攻方每场按「攻城值 × 投入兵力」打出破墙伤害，逐波把 wallHp 打低；
 *   · 守军防御加成按城墙完好比例在 1.0 ~ siegeWallMul 之间线性取值；
 *   · 破城当阵守军额外折损，城池 defense 下滑一次（修复过半才复位）；
 *   · 每旬自然修复 2%，被围不修。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyAttack, strategyViewState,
  marchableFrom, strategyMap, cityWall, applySiegeResult, repairCityWalls,
} from '../server/domain/strategy.js';
import { wallMaxOf, wallRatioOf, wallDefMul, WALL } from '../server/domain/city-wall.js';
import { siegeDamageOf } from '../server/battle.js';
import { settleWorld } from '../server/handlers.js';
import { chapterRules } from '../server/domain/campaign.js';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const lord = lords[0];
  const r = chooseOath(state, cfg, { push() {} }, { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true, '举义应成功');
  return { state, st: state.strategy };
}

/** 按游戏日推进（时钟走真实毫秒，测试里直接给未来时间戳）。 */
function advance(state, days) {
  const ctx = { state, cfg, push() {} };
  const perDay = chapterRules().realMsPerDay;
  const now = Date.now() + days * perDay * 1.2;
  settleWorld(ctx, now);
  return ctx;
}

test('城墙耐久：城防越高、等级越高越厚，且下限不为 0', () => {
  const low = wallMaxOf({ attrs: { 城防: 10 } }, 1);
  const mid = wallMaxOf({ attrs: { 城防: 60 } }, 1);
  const high = wallMaxOf({ attrs: { 城防: 100 } }, 1);
  assert.ok(low < mid && mid < high, `城防应单调抬耐久：${low}/${mid}/${high}`);
  const lv1 = wallMaxOf({ attrs: { 城防: 60 } }, 1);
  const lv3 = wallMaxOf({ attrs: { 城防: 60 } }, 3);
  assert.ok(lv3 > lv1, `高等级城应更厚：lv1=${lv1} lv3=${lv3}`);
  assert.ok(wallMaxOf({ attrs: { 城防: 0 } }, 1) > 0, '空城防也应有基础城墙');
  /* 真实地图上必须真的分档，否则「城防」仍然没有区分度 */
  const map = strategyMap();
  const maxes = [...new Set(map.cities.map((c) => wallMaxOf(c, c.level || 1)))].sort((a, b) => a - b);
  assert.ok(maxes.length >= 10, `72 城的城墙上限应有多档（实测 ${maxes.length} 档）`);
  assert.ok(maxes.at(-1) / maxes[0] >= 1.5, `强弱城墙上限差距过小：${maxes[0]}~${maxes.at(-1)}`);
});

test('守军据城加成：完整 1.5×、半破 1.25×、破城无加成（旧口径只在满墙时相同）', () => {
  const state = { strategy: { knobs: {} } };
  const max = 1000;
  assert.equal(Number(wallDefMul(state, { hp: max, max }).toFixed(3)), 1.5);
  assert.equal(Number(wallDefMul(state, { hp: max / 2, max }).toFixed(3)), 1.25);
  assert.equal(Number(wallDefMul(state, { hp: 0, max }).toFixed(3)), 1);
  /* 旧档没有 wallHp → 视为完整城墙，口径与升级前一致 */
  assert.equal(wallRatioOf({ max }), 1);
  assert.equal(wallRatioOf(null), 1);
});

test('攻城伤害：只认参战武将的攻城值与兵力，零攻城值打不动城墙', () => {
  const one = siegeDamageOf([{ destroy: 40, soldiers: 2000 }]);
  const two = siegeDamageOf([{ destroy: 40, soldiers: 2000 }, { destroy: 40, soldiers: 2000 }]);
  const weak = siegeDamageOf([{ destroy: 10, soldiers: 2000 }]);
  assert.ok(one > 0, '有攻城值就该打出伤害');
  assert.ok(two > one, '多一支同等队伍应更快破墙');
  assert.ok(one > weak, '攻城值高应打得更快');
  assert.equal(siegeDamageOf([{ destroy: 0, soldiers: 2000 }]), 0, '零攻城值不得拆墙');
  assert.equal(siegeDamageOf([{ destroy: 40, soldiers: 0 }]), 0, '没有兵也不得拆墙');
});

test('真链路攻城：城墙按攻城值下降，战报写城墙进度，破城后守势下滑', () => {
  const { state, st } = oathWorld();
  const home = st.playerCity;
  const enemy = marchableFrom(home, state).map(Number)
    .find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  assert.ok(enemy, '本城应有可攻的邻城');
  const wall0 = cityWall(state, enemy);
  assert.ok(wall0 && wall0.hp === wall0.max, '开局城墙应是完整的');

  const army = state.armys.find((a) => !a.marchId);
  assert.ok(army, '应有可出征的队伍');
  army.soldiers = [1200, 1200, 0];
  const r = strategyAttack(state, cfg, { push() {} }, { cityId: enemy, fromCityId: home, frac: 1 });
  assert.equal(r.ok, true, `出征应成功：${JSON.stringify(r)}`);
  advance(state, 12);

  const wall1 = cityWall(state, enemy);
  assert.ok(wall1.hp < wall0.hp || wall1.hp === 0,
    `攻城后城墙应受损（${wall0.hp} → ${wall1.hp}）`);
  const report = state.warReports[0];
  assert.ok(report, '应写下战报');
  assert.match(String(report.summary || ''), /城墙/, `战报必须写明城墙进度：${report.summary}`);
  assert.ok(report.siege && report.siege.damage > 0, '战报应带攻城结算明细');
  assert.ok(report.siege.defMul >= 1 && report.siege.defMul <= 1.5,
    `守军据城加成应在 1~1.5（实测 ${report.siege && report.siege.defMul}）`);
});

test('破城：applySiegeResult 归零城墙、城防下滑一次，修复过半后复位', () => {
  const { state, st } = oathWorld();
  const id = Number(Object.keys(st.cities)[0]);
  const wall = cityWall(state, id);
  const defBefore = Number(st.cities[id].defense) || 0.4;

  applySiegeResult(state, id, {
    max: wall.max, hpBefore: wall.max, hpAfter: 0, damage: wall.max, breached: true,
  });
  assert.equal(st.cities[id].wallHp, 0, '破城后城墙应为 0');
  assert.ok(st.cities[id].defense < defBefore, '破城应让城防系数下滑');

  const defAfter = st.cities[id].defense;
  /* 反复破城不得把 defense 无限往下扣 */
  applySiegeResult(state, id, {
    max: wall.max, hpBefore: 10, hpAfter: 0, damage: 10, breached: true,
  });
  assert.equal(st.cities[id].defense, defAfter, '城墙已成瓦砾时不应重复扣城防');

  /* 修复到一半以上 → 重新算「有城防」，再破可再扣 */
  st.cities[id].wallHp = Math.round(wall.max * 0.8);
  delete st.cities[id].wallRubble;
  applySiegeResult(state, id, {
    max: wall.max, hpBefore: Math.round(wall.max * 0.8), hpAfter: 0,
    damage: Math.round(wall.max * 0.8), breached: true,
  });
  assert.ok(st.cities[id].defense < defAfter, '修好后的城墙再被打破应再次重创城防');
});

test('每旬修复：未被围的城逐旬回墙，被围的城不修', () => {
  const { state, st } = oathWorld();
  const ids = Object.keys(st.cities).map(Number);
  const a = ids[0];
  const b = ids[1];
  const wallA = cityWall(state, a);
  const wallB = cityWall(state, b);
  st.cities[a].wallHp = Math.round(wallA.max * 0.4);
  st.cities[b].wallHp = Math.round(wallB.max * 0.4);
  st.cities[b].besieged = true;

  const fixed = repairCityWalls(state);
  assert.ok(fixed > 0, '应有城墙被修复');
  assert.ok(st.cities[a].wallHp > Math.round(wallA.max * 0.4), `未围城应回墙（${st.cities[a].wallHp}）`);
  assert.equal(st.cities[b].wallHp, Math.round(wallB.max * 0.4), '被围城不应修复');
  assert.ok(WALL.repairPerTurn > 0 && WALL.repairPerTurn < 0.05,
    '修复速度必须低于一波攻城能打掉的比，否则城墙永远打不穿');
});

test('面板与视图同源：城池视图带城墙四件套，旧档缺字段按完整城墙显示', () => {
  const { state, st } = oathWorld();
  const view = strategyViewState(state, cfg);
  assert.ok(view.cities.length >= 70, '城池视图应包含全图');
  for (const c of view.cities.slice(0, 10)) {
    assert.ok(c.wallMax > 0, `${c.name} 缺城墙上限`);
    assert.equal(c.wallPct, Math.round((c.wallHp / c.wallMax) * 100), `${c.name} 城墙百分比与耐久不同源`);
    assert.equal(typeof c.wallBreached, 'boolean', `${c.name} 缺破城标记`);
  }
  /* 旧档：删掉 wallHp 后视图必须按「完整城墙」给，不得显示 0% */
  const id = Number(Object.keys(st.cities)[0]);
  delete st.cities[id].wallHp;
  const view2 = strategyViewState(state, cfg);
  const row = view2.cities.find((c) => Number(c.id) === id);
  assert.equal(row.wallPct, 100, `旧档无 wallHp 应按完整城墙显示（实测 ${row.wallPct}%）`);
});
