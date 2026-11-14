/**
 * 回归闸：① 全武将初始战法覆盖与战法配置自洽；② 点名武将属性回落。
 *
 * 为什么需要：改之前 hero-skills.json 只有 61 人，其余武将 skills[0] 恒为 null，
 * 而且没人校验「描述里的 %n% 个数」和「内核结算槽数」是否相等——少一个占位符
 * 玩家就会在技能详情里看到裸奔的 %n%，多一个则数值错位。属性侧同理：同名
 * 4 星版本曾比 5 星还高，靠人工看配置表发现不了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKILLS, skillById, kernelSkillAt, rangeOf } from '../server/skills.js';

const ROOT = resolve(import.meta.dirname, '..');
const read = (...p) => JSON.parse(readFileSync(resolve(ROOT, ...p), 'utf8'));
const innate = read('conf', 'innate-skills.json');
const audit = read('conf', 'campaign', 'innate-skill-audit.json');
const heroSkills = read('conf', 'campaign', 'hero-skills.json');
const general = read('conf', 'json', 'general', 'general.json');
const heroes240 = read('conf', 'campaign', 'heroes-240.json');
const protag = read('conf', 'campaign', 'protagonist.json');
const statAudit = read('conf', 'campaign', 'hero-stat-audit.json');

const DIMS = ['force', 'strategy', 'defense', 'speed', 'destroy'];
const sum = (o, ks) => ks.reduce((s, k) => s + (Number(o[k]) || 0), 0);
const q = (arr, p) => {
  const v = arr.slice().sort((a, b) => a - b);
  return v[Math.max(0, Math.min(v.length - 1, Math.floor((v.length - 1) * p)))] ?? 0;
};
const KTARGET_REV = {
  self: 1, self_and_ally_single: 2, ally_single: 2, ally_group: 4, ally_all: 5,
  enemy_single: 6, enemy_group: 8, enemy_all: 9,
};

test('每一个武将都有初始战法，且映射都指向真实存在的战法', () => {
  const names = new Set([
    ...general.list.map((g) => g.name),
    ...heroes240.heroes.map((h) => h.name),
    protag.general.name,
  ]);
  const missing = [...names].filter((n) => !Number.isFinite(Number(heroSkills[n])));
  assert.deepEqual(missing, [], `${missing.length} 位武将没有初始战法`);
  const dangling = Object.entries(heroSkills).filter(([, id]) => !skillById(Number(id)));
  assert.deepEqual(dangling, [], '存在指向不存在战法的映射');
  assert.equal(audit.totals.heroes, names.size, '审计表人数与武将名单不一致');
  assert.ok(audit.totals.w0Linked > 100, 'W0 关联的武将过少，映射可能退化成随机');
  assert.ok(audit.caveat.includes('自带战法'), '审计表缺少「不是自带战法」的免责说明');
});

test('新增战法的描述占位、等级成长、目标与内核槽一一对应', () => {
  const oldNames = new Set(SKILLS.filter((s) => s.cfgId < 920000).map((s) => s.name));
  assert.ok(innate.skills.length >= 60, '代表战法过少，效果范式覆盖不足');
  for (const s of innate.skills) {
    const ph = (s.ui.des.match(/%n%/g) || []).length;
    assert.equal(ph, s.ui.levels[0].effect_value.length, `${s.name} 描述占位与结算槽不符`);
    assert.equal(s.ui.levels.length, 10, `${s.name} 不是 10 级`);
    assert.equal(s.kernel.effects.length, ph, `${s.name} kernel 槽数不符`);
    assert.equal(KTARGET_REV[s.kernel.effects[0].target_type], s.ui.target, `${s.name} 客户端目标类型与主槽不一致`);
    s.ui.levels[0].effect_value.forEach((v, i) => {
      assert.ok(Math.abs(s.ui.levels[9].effect_value[i] - v * 2) < 0.05,
        `${s.name} 第 ${i + 1} 槽 Lv10 不是 Lv1 的两倍`);
    });
    assert.equal(oldNames.has(s.name), false, `${s.name} 与包内原有战法重名`);
    assert.equal(rangeOf(s), s.ui.range, `${s.name} 内核射程与描述里的有效距离不符`);
    const k1 = kernelSkillAt(s.cfgId, 1);
    const k10 = kernelSkillAt(s.cfgId, 10);
    assert.ok(k1 && k10, `${s.name} 无法转换成内核战法`);
    assert.equal(k1.effects.length, ph);
    assert.ok(k10.effects[0].rate_pct >= k1.effects[0].rate_pct, `${s.name} 升级后主效果反而下降`);
  }
  assert.equal(SKILLS.filter((s) => s.cfgId >= 920000).length, innate.count, '新战法未全部注册进运行时表');
});

test('点名武将属性回落到同星级中位附近，同名多版本按星级单调', () => {
  const p75 = {};
  for (const star of [3, 4, 5]) {
    p75[star] = q(general.list.filter((g) => Number(g.star) === star).map((g) => sum(g, DIMS)), 0.75);
  }
  for (const name of ['夏侯惇', '黄盖']) {
    const rows = general.list.filter((g) => g.name === name);
    assert.ok(rows.length >= 2, `${name} 版本数异常`);
    for (const r of rows) {
      assert.ok(sum(r, DIMS) <= p75[Number(r.star)], `${name} ${r.cfgId} 超出同星 p75`);
    }
    const sorted = rows.slice().sort((a, b) => Number(b.star) - Number(a.star));
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(sum(sorted[i], DIMS) <= sum(sorted[i - 1], DIMS) * 0.95 + 1,
        `${name} 低星版本 ${sorted[i].cfgId} 反超/追平高星版本`);
    }
  }
  assert.ok(sum(protag.general, DIMS) <= p75[4], '主角超出 4 星 p75');
  assert.ok(statAudit.monotonic.length >= 5, '属性审计表缺少单调性记录');
  for (const c of statAudit.changes) {
    assert.ok(c.after.base <= c.before.base, `${c.label} 属性回落方向错了`);
    assert.ok(c.after.grow <= c.before.grow, `${c.label} 成长率不降反升`);
  }
});

/* ★ 名实一致闸（本轮新增）：这是玩家一眼能看穿的错误，靠人工复查 424 位管不住。
   改之前「苦肉计」被发给 14 个不相干的人（丁夫人、刘度…）、「奋疾先登」判给赵云、
   「当阳桥」发给兀突骨——表面看每人都有战法，本质是错的。 */
test('真人专属战法只归本人，通用战法不得冒用他人专属名', () => {
  const ownByName = new Map();       // 战法名 → 归属武将
  const ov = read('conf', 'campaign', 'innate-skill-overrides.json');
  for (const [hero, spec] of Object.entries(ov.heroes)) ownByName.set(spec.skill, hero);

  /* ① 覆盖表里的战法名，只有本人能拿 */
  for (const [skillName, owner] of ownByName) {
    const holders = Object.entries(heroSkills)
      .filter(([, id]) => (skillById(Number(id))?.name || '') === skillName)
      .map(([n]) => n);
    const others = holders.filter((n) => n !== owner);
    assert.deepEqual(others, [], `专属战法「${skillName}」被派给了非归属者：${others.join('、')}`);
  }

  /* ② 覆盖表里的武将必须真的拿到本人战法（不能因为复用/改名而失效） */
  for (const [hero, spec] of Object.entries(ov.heroes)) {
    const id = heroSkills[hero];
    if (!Number.isFinite(Number(id))) continue;        // 本作未收录该武将
    const got = skillById(Number(id))?.name || '';
    assert.equal(got, spec.skill, `${hero} 应持「${spec.skill}」，实际是「${got}」`);
  }
});

test('伤害类型与官网 effect 标签一致（防止「赵云打谋略伤害」这类反向配置）', () => {
  /* W0 表里「攻击伤害」= 兵刃， 「策略攻击伤害」= 谋略。自动映射曾把
     银龙冲阵/定军扬威（都是攻击伤害）翻成 STRATEGY_DAMAGE。 */
  const phys = new Set(['辕门射戟', '银龙冲阵', '樊渊泅囚', '定军扬威', '长坂之吼',
    '傲将奇兵', '重斩', '小霸王', '血溅黄砂', '其疾如风']);
  for (const s of innate.skills) {
    if (!phys.has(s.name)) continue;
    const t = s.kernel.effects[0].effect_type;
    assert.ok(t === 'PHYSICAL_DAMAGE' || t === 'BUFF' || t === 'CONTROL',
      `${s.name} 被翻成 ${t}，与官网「攻击伤害」标签矛盾`);
  }
  /* 谋略类不能被翻成兵刃 */
  for (const s of innate.skills) {
    if (!['火势风威', '诸葛锦囊', '望风而降'].includes(s.name)) continue;
    const t = s.kernel.effects[0].effect_type;
    assert.notEqual(t, 'PHYSICAL_DAMAGE', `${s.name} 是谋略战法，不该出物理伤害`);
  }
});
