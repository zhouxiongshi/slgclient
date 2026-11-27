/**
 * P53（2026-11-24）战法描述↔实现一致性裁决回归：
 *  1. 修正层只改文案与机制接线，不改任何等级数值；
 *  2. 反击由 counter 机制落地，伤害率随等级；
 *  3. 净化/属性/发动率/条件易伤词条由内核分桶消费；
 *  4. Python 参考实现与 TS 的内核分桶口径一致（双份源码静态核对）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SKILLS, kernelSkillAt } from '../server/skills.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const byId = (id) => SKILLS.find((s) => s.cfgId === id);
const fix = JSON.parse(read('conf/skill-consistency.json'));

test('P53-① 修正层只修文案/机制，等级数值原样', () => {
  assert.equal(fix.version, 'p53-consistency-1');
  assert.ok(fix.entries.length >= 9, '覆盖全部需文案修正的战法');
  for (const e of fix.entries) {
    assert.ok(byId(e.cfgId), `cfgId ${e.cfgId} 应在运行时表中`);
    assert.equal(e.kernelPatch?.effects, undefined, '不许通过 patch 改效果数值');
    assert.ok(!e.des?.includes('effect_value'), '文案不许夹带内部字段');
  }
  assert.equal(byId(10017).ui.levels[0].effect_value.length, 3, '数值槽数量不动');
  assert.equal(byId(10020).ui.levels[0].effect_value.length, 1);
});

test('P53-② 控制槽标签改为几率，未落地的承诺已删', () => {
  const luanji = byId(10017).ui.des;
  assert.match(luanji, /几率%n%%/);
  assert.doesNotMatch(luanji, /伤害率/);
  assert.match(byId(10018).ui.des, /几率%n%%/);
  assert.doesNotMatch(byId(10028).ui.des, /逃兵/);
  assert.doesNotMatch(byId(10020).ui.des, /递增/);
  assert.doesNotMatch(byId(10029).ui.des, /优先行动/);
  assert.doesNotMatch(byId(10031).ui.des, /分兵|2次普通攻击/);
  assert.match(byId(10003).ui.des, /整场有效/);
  assert.match(byId(10019).ui.des, /整场有效/);
});

test('P53-③ 反击走既有 counter 机制，伤害率随等级（不再当触发概率）', () => {
  const s = byId(10025);
  assert.equal(s.kernel.mechanics.counter.chance, 1, '受到普攻必反击');
  assert.equal(s.kernel.mechanics.counter.rate_from_ui, true);
  const m1 = kernelSkillAt(10025, 1).effects[0].mechanics?.counter;
  const m10 = kernelSkillAt(10025, 10).effects[0].mechanics?.counter;
  assert.ok(m1 && m10, '单效果战法也必须透传 mechanics');
  assert.equal(m1.chance, 1);
  assert.equal(m1.rate_pct, 70, 'P70 玩家指定 Lv1 伤害率 70%');
  assert.equal(m10.rate_pct, 115, 'P70 每级 +5%，Lv10 为 115%');
});

test('P53-④ 语义词条仍以原数值下发，由内核分桶消费', () => {
  const purge = kernelSkillAt(910005, 1).effects.find((e) => e.bonus_terms?.some((b) => b.name === '镇静'));
  assert.ok(purge, '镇静词条保留在效果里（内核按 purge 分桶）');
  assert.equal(purge.bonus_terms[0].value, 10);
  const attr = kernelSkillAt(910009, 1).effects.map((e) => e.bonus_terms?.[0]?.name);
  assert.ok(attr.includes('攻击属性提高') && attr.includes('防御属性提高'));
  const prob = kernelSkillAt(910013, 1).effects.find((e) => e.bonus_terms?.some((b) => b.name === '发动率提高'));
  assert.equal(prob.bonus_terms[0].value, 10);
});

test('P53-⑤ TS 与 Python 参考内核的分桶规则同源', () => {
  const ts = read('../battle-core/src/rules.ts');
  const py = readFileSync('D:/WorkBuddy/battle-kit/kernel/rules.py', 'utf8');
  for (const pat of ['镇静', '属性提高', '发动率提高', '处于.*状态受伤害提高']) {
    assert.ok(ts.includes(pat), `TS 规则含 ${pat}`);
    assert.ok(py.includes(pat), `Python 规则含 ${pat}`);
  }
  assert.match(ts, /ALL_NEGATIVE_STATES/);
  assert.match(py, /ALL_NEGATIVE_STATES/);
});
