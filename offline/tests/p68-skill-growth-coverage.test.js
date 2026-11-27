/**
 * P68 战法升级成长全量覆盖闸（用户 2026-11-27：「反击技能升级没有任何变化，
 * Lv1-Lv10 的属性一模一样。这是严重 bug，检查其他技能是否也存在类似问题」）。
 *
 * 缺陷根因（两类）：
 *   ① 无同名官方战法的本作战法整条曲线 Lv1==Lv10（一雷惊蛰/健卒不殆/混战/
 *      轻骑冲阵/异士），官方成长对齐层直接跳过，升级零反馈；
 *   ② 镜像层把官方「陷入 X 状态」无百分比描述照搬成命中率 100→100
 *      （反计/佯攻），升级同样零反馈。
 * 修复口径（满级平衡不动，只把 Lv1 端拉到一半，线性插值）：
 *   - ①由 tools/sync-growth-direction.mjs 平线兜底（rule: 'flat-upgrade'）；
 *   - ②由 tools/mirror-official-skills.mjs designedControlGrowth（50→100）。
 * 反击（10025）由 P53 接线、P70 改为玩家指定曲线 70→115（每级 +5%），一并锁住防回退。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS, kernelSkillAt } from '../server/skills.js';
import { panelState } from '../server/domain/panels.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { loadConfig } from '../server/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = JSON.parse(readFileSync(join(ROOT, 'conf', 'skill-mirror.json'), 'utf8'));
const mirrorByName = new Map(MIRROR.skills.map((s) => [s.name, s]));

/** 运行时全表扫描：不允许任何一条战法十级全平（升级必须有反馈）。 */
test('P68-① 运行时战法表不存在 Lv1==Lv10 的平线战法', () => {
  const flat = [];
  for (const s of SKILLS) {
    const lv = s.ui?.levels || [];
    if (lv.length < 2) continue;
    const vals = lv.map((l) => l.effect_value);
    if (vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0]))) flat.push(s.name);
  }
  assert.deepEqual(flat, [], `以下战法升级无任何变化（平线）：${flat.join('、')}`);
});

test('P68-② 平线兜底五条：Lv1=Lv10 一半，内核数值随级缩放', () => {
  const expect = [
    [10020, '一雷惊蛰', 75, 150],
    [10026, '健卒不殆', 20, 40],
    [10027, '混战', 25, 50],
    [10029, '轻骑冲阵', 20, 40],
    [10030, '异士', 12.5, 25],
  ];
  for (const [cfgId, name, lo, hi] of expect) {
    const s = SKILLS.find((x) => Number(x.cfgId) === cfgId);
    assert.ok(s, `${name} 不在运行时表`);
    const vals = s.ui.levels.map((l) => l.effect_value[0]);
    assert.equal(vals[0], lo, `${name} Lv1 应为 ${lo}`);
    assert.equal(vals[9], hi, `${name} Lv10 终点保留 ${hi}`);
    for (let i = 0; i < 10; i += 1) {
      const want = Math.round((lo + (hi - lo) * i / 9) * 100) / 100;
      assert.equal(vals[i], want, `${name} Lv${i + 1} 非线性插值`);
    }
    const k10 = kernelSkillAt(cfgId, 10);
    assert.equal(k10.effects[0].rate_pct, hi, `${name} 内核 Lv10 伤害率应为 ${hi}`);
    assert.equal(kernelSkillAt(cfgId, 1).effects[0].rate_pct, lo, `${name} 内核 Lv1 伤害率应为 ${lo}`);
  }
  /* BUFF 槽（普攻加成）也必须随级：健卒不殆 Lv1 0.2 → Lv10 0.4 */
  const b1 = kernelSkillAt(10026, 1).effects[0].bonus_terms[0].value;
  const b10 = kernelSkillAt(10026, 10).effects[0].bonus_terms[0].value;
  assert.equal(b1, 0.2, '健卒不殆 Lv1 普攻加成应为 0.2');
  assert.equal(b10, 0.4, '健卒不殆 Lv10 普攻加成应为 0.4');
});

test('P68-③ 镜像控制槽：命中率 Lv1=50%→Lv10=100%，内核命中随级，留痕可审计', () => {
  for (const name of ['反计', '佯攻']) {
    const m = mirrorByName.get(name);
    assert.ok(m, `${name} 不在镜像层`);
    const vals = m.ui.levels.map((l) => l.effect_value[0]);
    assert.equal(vals[0], 50, `${name} 镜像命中率 Lv1 应为 50`);
    assert.equal(vals[9], 100, `${name} 镜像命中率 Lv10 终点保留 100`);
    assert.match(String(m.provenance?.mirror?.designedControlGrowth || ''), /Lv1=50%→Lv10=100%/,
      `${name} 缺设计成长留痕（无法区分官方原文与本作设计）`);
    const cfgId = Number(m.cfgId);
    const k1 = kernelSkillAt(cfgId, 1).effects[0];
    const k10 = kernelSkillAt(cfgId, 10).effects[0];
    assert.equal(k1.control_probability, 0.5, `${name} 内核 Lv1 命中率应为 0.5`);
    assert.equal(k10.control_probability, 1, `${name} 内核 Lv10 命中率应为 1`);
  }
});

test('P68-④ / P70 反击伤害率 70% 起每级 +5%，战斗与战法库同源', () => {
  const s = SKILLS.find((x) => Number(x.cfgId) === 10025);
  const vals = s.ui.levels.map((l) => l.effect_value[0]);
  assert.equal(vals[0], 70, 'P70 玩家指定 Lv1 伤害率 70%');
  assert.equal(vals[9], 115, 'P70 每级 +5%，Lv10 为 115%');
  for (let i = 0; i < 10; i += 1) {
    assert.equal(vals[i], 70 + 5 * i, `反击 Lv${i + 1} 伤害率应为 ${70 + 5 * i}`);
    const counter = kernelSkillAt(10025, i + 1).effects[0].mechanics?.counter;
    assert.ok(counter, `反击 Lv${i + 1} 缺回击机制`);
    assert.equal(counter.chance, 1, '受到普攻必反击');
    assert.equal(counter.rate_pct, vals[i], `反击 Lv${i + 1} 内核回击伤害率应与界面同源`);
  }
});

/* ★ P69：P68 只锁了战斗用的 SKILLS，战法库 UI 另有从 conf/skills.json 拼的原始表，
   绕开镜像/成长/一致性覆盖链，反击在界面上仍是十级全 75。这一条锁 UI 投影。 */
test('P69-① / P70 战法库数值曲线与运行时同源：反击 Lv1=70、Lv10=115，描述随级', () => {
  const cfg = loadConfig();
  const state = normalizeWorld(createWorld(cfg), cfg);
  const lib = panelState(state, cfg).library;
  const e = lib.find((x) => Number(x.cfgId) === 10025);
  assert.ok(e, '反击不在战法库投影里');
  assert.equal(Number(e.levelCount), 10);
  assert.equal(e.levels[1].effect_value[0], 70, '战法库 Lv1 应为玩家指定的 70');
  assert.equal(e.levels[10].effect_value[0], 115, '战法库 Lv10 应为 115');
  for (let i = 1; i <= 10; i += 1) {
    assert.equal(e.levels[i].effect_value[0], SKILLS.find((x) => Number(x.cfgId) === 10025).ui.levels[i - 1].effect_value[0],
      `战法库 Lv${i} 必须与战斗运行时表同源`);
  }
  assert.match(e.des, /70%/, 'Lv1 描述里的 %n 也要取同一份等级数据');
});

test('P69-② 战法库全库不允许十级全平', () => {
  const cfg = loadConfig();
  const state = normalizeWorld(createWorld(cfg), cfg);
  const flat = panelState(state, cfg).library.filter((x) => {
    if (Number(x.levelCount) < 2) return false;
    const first = JSON.stringify(x.levels[1].effect_value);
    return Object.keys(x.levels).every((k) => JSON.stringify(x.levels[k].effect_value) === first);
  }).map((x) => x.name);
  assert.deepEqual(flat, [], `战法库升级无反馈：${flat.join('、')}`);
});

/* ★ P70：玩家指定数值必须能扛住生成器复跑，且原表/一致性元数据不漂移。
   生成器复跑字节一致性由 p31-growth-direction.test.js 的复跑自检锁住。 */
test('P70-① 反击人工覆写有留痕，原表与一致性元数据同源', () => {
  const growth = JSON.parse(readFileSync(join(ROOT, 'conf', 'skill-growth-direction.json'), 'utf8'));
  const g = growth.entries.find((x) => Number(x.cfgId) === 10025);
  assert.equal(g.manualOverride, true, '反击必须标记为人工覆写，防生成器按官方快照冲回');
  assert.match(g.manualReason, /P70/);
  assert.deepEqual(g.levels.map((l) => l.effect_value[0]), [70, 75, 80, 85, 90, 95, 100, 105, 110, 115]);

  const raw = JSON.parse(readFileSync(join(ROOT, 'conf', 'skills.json'), 'utf8'));
  const src = raw.skills.find((x) => Number(x.cfgId) === 10025);
  assert.ok(src.ui.levels.every((l) => l.effect_value[0] === 75), 'conf 原表必须保持官方快照不动');

  const fix = JSON.parse(readFileSync(join(ROOT, 'conf', 'skill-consistency.json'), 'utf8'));
  const f = fix.entries.find((x) => Number(x.cfgId) === 10025);
  assert.equal(f.kernelPatch.mechanics.counter.rate_pct, 70);
  assert.equal(f.kernelPatch.mechanics.counter.rate_from_ui, true);
});
