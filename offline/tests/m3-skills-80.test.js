/**
 * M3-8 战法补量（GDD §9「战法 80 条」）：主线 31 + 库 20 + 新机制组合 29 = 80
 * （另有主角专属 1 条不在「战法库」口径内，运行时表共 81）。
 *
 * 覆盖面：
 *   1. 总量与文件完备（conf/library-skills-extra.json 29 条，910100~910128）
 *   2. 效果签名全局唯一（skill_class+prepare+槽序[类型/目标/控制词/增益词/available]）
 *   3. ui / kernel 同源（占位数=效果数、lv1→lv10 双倍成长、include_effect 对齐、特性段）
 *   4. 内核生效面纪律（无 DEBUFF、控制槽伴随伤害、犹豫控制率 ≤0.3、追击单目标、
 *      BUFF 词全部为攻击方伤害加成词——battle-core attacker.buffs 全求和）
 *   5. 武将装配：core 60 位每人 ≥2 条且引用全部有效；240 位 skills 数 ≤3
 *   6. 内核实跑：prepare/治疗/控制/光环四类新战法在真实战斗中产生对应事件
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKILLS, SKILL_BY_ID, kernelSkillAt, LEVEL_COUNT } from '../server/skills.js';
import { runBattle, DEFAULT_BATTLE_CONFIG } from '../kernel/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const main = JSON.parse(readFileSync(resolve(ROOT, 'conf/skills.json'), 'utf8'));
const lib = JSON.parse(readFileSync(resolve(ROOT, 'conf/library-skills.json'), 'utf8'));
const extra = JSON.parse(readFileSync(resolve(ROOT, 'conf/library-skills-extra.json'), 'utf8'));
const heroesDoc = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/heroes-240.json'), 'utf8'));

const EXTRA_SKILLS = extra.skills;
const EXTRA_IDS = new Set(EXTRA_SKILLS.map((s) => s.cfgId));
const isExtra = (s) => s.provenance?.pairing === 'skill-library-extra';

/** 攻击方伤害加成词白名单：内核 attacker.buffs 无差别求和，词必须真实指向伤害。 */
const ATTACK_BUFF_WORDS = new Set(['攻击伤害提高', '策略攻击伤害提高', '防御属性提高']);

function signature(s) {
  const k = s.kernel;
  const fx = (Array.isArray(k.effects) && k.effects.length ? k.effects : [k]).map((e) =>
    [e.effect_type, e.target_type, e.control_state ?? null,
      (e.bonus_terms || []).map((b) => b.name).join('+') || '-', e.available_round ?? 0].join('/'));
  return `${k.skill_class}#${k.prepare ?? 0}#${fx.join('|')}`;
}

test('战法总量：主线+库+extra = 80，运行时表含主角专属共 81', () => {
  assert.equal(main.count, 31);
  assert.equal(lib.count, 20);
  assert.equal(extra.count, 29);
  assert.equal(main.count + lib.count + extra.count, 80, 'GDD §16 M3 战法 80 条');
  assert.equal(SKILLS.length, 81, '另含 protagonist-skill.json 主角专属');
  for (let i = 0; i < 29; i += 1) assert.equal(EXTRA_SKILLS[i].cfgId, 910100 + i, `cfgId 连续 ${i}`);
});

test('29 条新战法效果签名与主线/库内/本批内部全部唯一', () => {
  const sigs = new Map();
  for (const s of [...main.skills, ...lib.skills]) sigs.set(signature(s), s.name);
  for (const s of EXTRA_SKILLS) {
    const sig = signature(s);
    assert.equal(sigs.has(sig), false, `${s.name} 签名与 ${sigs.get(sig)} 重复`);
    sigs.set(sig, s.name);
  }
});

test('ui 与 kernel 同源：占位/效果数/等级成长/目标映射对齐', () => {
  for (const s of EXTRA_SKILLS) {
    const k = s.kernel, ui = s.ui;
    assert.ok(Array.isArray(k.effects) && k.effects.length >= 1, `${s.name} 无效果槽`);
    assert.equal(k.cfgId, ui.cfgId);
    assert.equal(k.name, ui.name);
    assert.equal((ui.des.match(/%n%/g) || []).length, k.effects.length, `${s.name} 占位数`);
    assert.equal(ui.include_effect.length, k.effects.length, `${s.name} include_effect`);
    assert.equal(ui.levels.length, LEVEL_COUNT);
    assert.ok(ui.des.includes('特性：'), `${s.name} 缺特性段`);
    const first = ui.levels[0], last = ui.levels.at(-1);
    first.effect_value.forEach((v, i) => {
      if (v > 0) assert.ok(Math.abs(last.effect_value[i] - v * 2) < 0.02, `${s.name} 槽${i} lv10≠lv1×2`);
    });
    // 目标映射：ui.target 与 effects[0].target_type 一致
    const NUM = { self: 1, ally_single: 4, ally_group: 5, enemy_single: 6, enemy_group: 9 };
    assert.equal(ui.target, NUM[k.effects[0].target_type], `${s.name} ui.target 与效果目标不符`);
    // kernelSkillAt 取值走同一条链
    const at = kernelSkillAt(s.cfgId, 5);
    assert.equal(at.name, s.name);
    assert.equal(at.effects.length, k.effects.length);
  }
});

test('内核生效面纪律：无 DEBUFF、控制伴随伤害、犹豫≤0.3、追击单体、BUFF 词真实生效', () => {
  const DECORATIVE = new Set(['混乱', '动摇', '怯战', '暴走']);
  for (const s of EXTRA_SKILLS) {
    const k = s.kernel;
    const hasDamage = k.effects.some((e) => e.effect_type === 'PHYSICAL_DAMAGE' || e.effect_type === 'STRATEGY_DAMAGE');
    for (const e of k.effects) {
      assert.notEqual(e.effect_type, 'DEBUFF', `${s.name} 使用内核不结算的 DEBUFF`);
      if (e.effect_type === 'CONTROL') {
        assert.ok(hasDamage, `${s.name} 控制槽无伤害伴随`);
        if (e.control_state === '犹豫') assert.ok(e.control_probability <= 0.3, `${s.name} 犹豫控制率超 0.3`);
        else assert.ok(DECORATIVE.has(e.control_state) || hasDamage, `${s.name} 控制词 ${e.control_state} 未伴随伤害`);
      }
      if (e.effect_type === 'BUFF') {
        for (const b of e.bonus_terms) {
          assert.ok(ATTACK_BUFF_WORDS.has(b.name), `${s.name} BUFF 词「${b.name}」不进伤害链（描述≠计算）`);
        }
      }
      if (k.skill_class === '追击') {
        assert.ok(!String(e.target_type).startsWith('enemy') || e.target_type === 'enemy_single',
          `${s.name} 追击非单目标`);
      }
    }
    // 概率纪律
    if (k.skill_class === '被动' || k.skill_class === '指挥') {
      assert.equal(k.probability_init, 1, `${s.name} 被动/指挥发动率`);
    } else {
      assert.ok(k.probability_init >= 0.3 && k.probability_init <= 0.5, `${s.name} 发动率越界`);
    }
    if (k.prepare === 2) {
      const dmg = k.effects.find((e) => e.effect_type.includes('DAMAGE'));
      assert.ok(dmg && dmg.rate_pct >= 180, `${s.name} 两回合准备倍率不足`);
    }
  }
});

test('武将装配：core 60 位每人 ≥2 条 ≤3 条，引用全部有效；其余层 ≤3 条', () => {
  const allIds = new Set(SKILLS.map((s) => s.cfgId));
  const core = heroesDoc.heroes.filter((h) => h.layer === 'core');
  assert.equal(core.length, 60);
  for (const h of heroesDoc.heroes) {
    const sk = h.skills || [];
    assert.ok(sk.length <= 3, `${h.name} 战法 ${sk.length} 条超上限`);
    for (const id of sk) assert.ok(allIds.has(id), `${h.name} 引用无效战法 ${id}`);
    if (h.layer === 'core') {
      assert.ok(sk.length >= 2, `核心武将 ${h.name} 仅 ${sk.length} 条战法`);
    }
  }
  // core 的新池战法应覆盖相当比例的 29 条（装配不是摆设）
  const usedExtra = new Set(core.flatMap((h) => (h.skills || []).filter((id) => EXTRA_IDS.has(id))));
  assert.ok(usedExtra.size >= 15, `core 实际使用新战法仅 ${usedExtra.size} 条`);
});

test('内核实跑：准备/治疗/控制/光环/被动五类新战法产生真实事件', () => {
  const mkUnit = (id, side, cfgId) => ({
    unit_id: id, side, pos: 0,
    hero: {
      heroid: id, name: `武${id}`, level: 10, hero_type: 'normal', hit_range: 1, country: '', quality: 5,
      attack_base: 90, defence_base: 40, intel_base: 90, speed_base: 80, destroy_base: 50,
      attack_grow: 3, defence_grow: 3, intel_grow: 3, speed_grow: 3, destroy_grow: 3,
      skills: [kernelSkillAt(cfgId, 10)],
    },
    troops: 2000, max_troops: 2000, speed: 100, attack_range: 5,
  });
  const fight = (aId, dId) => {
    const r = runBattle({
      units: [mkUnit('a0', 1, aId), mkUnit('d0', 2, dId)],
      seed: 20261113, config: DEFAULT_BATTLE_CONFIG,
    });
    return r;
  };

  // 惊雷贯阵（prepare=2 单体重击 220%）：应出现 skill_prepare + skill_trigger + 伤害
  const r1 = fight(910101, 910112);
  const kinds1 = r1.events.map((e) => e.kind);
  assert.ok(kinds1.includes('skill_prepare'), '惊雷贯阵未出现准备事件');
  const trig1 = r1.events.find((e) => e.kind === 'skill_trigger' && e.payload.skill === '惊雷贯阵');
  assert.ok(trig1, '惊雷贯阵未发动');
  const dmg1 = r1.events.filter((e) => e.kind === 'damage' && e.payload.skill === '惊雷贯阵');
  assert.ok(dmg1.length >= 1 && dmg1.every((e) => e.payload.applied > 0), '惊雷贯阵无伤害');

  // 悬壶济军（治疗我军单体）：治疗事件量 > 0
  const r2 = fight(910106, 910115);
  const heals = r2.events.filter((e) => e.kind === 'heal' && e.payload.amount > 0);
  assert.ok(heals.length >= 1, '悬壶济军未产生治疗');

  // 天罗地网（策略群体 + 犹豫 0.3）：应出现 control 事件（确定性种子下至少存在一次）
  const r3 = fight(910109, 910110);
  assert.ok(r3.events.some((e) => e.kind === 'damage' && e.payload.skill === '天罗地网'), '天罗地网无伤害');
  assert.ok(r3.events.some((e) => e.kind === 'control' && e.payload.state === '犹豫'), '天罗地网未产生犹豫');

  // 逆锋决胜（被动 available_round=2 增伤 15%）：被动无条件触发过
  const r4 = fight(910114, 910116);
  const buffs4 = r4.events.filter((e) => e.kind === 'buff' && e.payload.terms.includes('攻击伤害提高'));
  assert.ok(buffs4.length >= 1, '逆锋决胜被动增益未挂账');

  // 深沟高垒（指挥 available_round=2 光环）：指挥阶段即结算
  const r5 = fight(910126, 910118);
  assert.ok(r5.events.some((e) => e.kind === 'buff' && e.payload.terms.includes('攻击伤害提高')), '深沟高垒光环未结算');
  // 确定性：同种子同事件指纹
  const r1b = fight(910101, 910112);
  assert.equal(r1.event_fingerprint, r1b.event_fingerprint, '同种子指纹漂移');
});
