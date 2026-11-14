/**
 * M4-7 主角自带战法 19001「后世之识」——玩家指定的指挥战法三效果。
 *
 * 覆盖：
 *   1. 配置同源：ui.des 占位 = kernel.effects 槽数 = include_effect；回击概率 30% 起、
 *      每级 +5%、Lv10 = 75%；洞察 3 回合、减伤 30%、回击 87% 策略伤害固定。
 *   2. kernelSkillAt 逐槽注入：界面写多少，内核就用多少（杜绝两套数字）。
 *   3. 内核实跑：自身+一名友军获得洞察、前 3 回合免疫控制、第 4 回合可受控；
 *      受击按等级概率回击，回击伤害率固定 87%（不随武将等级二次成长）；
 *      自身受伤降低 30%；同种子事件指纹一致。
 *   4. 战报同源：回击伤害进 skillHit（c_id=19001），免疫/回击有专属叙述。
 *   5. 防退化：旧战法不产生任何新事件/新字段，黄金向量语义不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SKILLS, skillById, kernelSkillAt, reportSkillFields, LEVEL_COUNT,
} from '../server/skills.js';
import { runBattle, DEFAULT_BATTLE_CONFIG } from '../kernel/index.js';
import { desText, skillProfile, actSentence } from '../server/domain/battle-narrative.js';
import { kernelEventsToRounds } from '../server/battle.js';

const ROOT = resolve(import.meta.dirname, '..');
const authored = JSON.parse(readFileSync(
  resolve(ROOT, 'conf', 'campaign', 'protagonist-skill.json'), 'utf8',
));
const CFG_ID = 19001;

/** 必定命中的主动控制战法，用来验证洞察的 3 回合边界。 */
const CONTROL_SKILL = {
  skill_id: 999001, name: '测试控制', skill_class: '主动', level: 10, prepare: 0,
  probability_init: 1, probability_max: 1, main_detail: 999001,
  effects: [{
    detail_id: 9990011, effect_type: 'CONTROL', rate_pct: 0, target_type: 'enemy_all',
    attack_type: 'normal', available_round: 0, control_state: '犹豫',
    control_probability: 1, bonus_terms: [], evidence: 'E2',
  }],
  evidence: 'E2',
};

function mkUnit(id, side, skills, troops = 100000) {
  return {
    unit_id: id, side, pos: 0, attack_range: 9,
    hero: {
      heroid: id, name: `武${id}`, level: 10, hero_type: 'normal', hit_range: 1,
      country: '', quality: 5,
      attack_base: 90, defence_base: 40, intel_base: 90, speed_base: 80, destroy_base: 50,
      attack_grow: 3, defence_grow: 3, intel_grow: 3, speed_grow: 3, destroy_grow: 3,
      skills,
    },
    troops, max_troops: troops, speed: 100,
  };
}

/** 主角 + 一名友军 vs 必中控制的敌军；兵力充足，保证打满 6 回合。 */
function fight(lv, seed = 20261114) {
  return runBattle({
    units: [
      mkUnit('a0', 1, [kernelSkillAt(CFG_ID, lv)]),
      mkUnit('a1', 1, []),
      mkUnit('d0', 2, [CONTROL_SKILL]),
    ],
    seed, config: DEFAULT_BATTLE_CONFIG, roundLimit: 6,
  });
}

test('配置：指挥战法三槽，占位数/效果数/图标数/等级数对齐', () => {
  const s = skillById(CFG_ID);
  assert.ok(s, '19001 必须并入运行时战法表');
  assert.equal(SKILLS.length, 81);
  assert.equal(authored.provenance.pairing, 'authored');
  assert.equal(s.kernel.skill_class, '指挥');
  assert.equal(s.kernel.prepare, 0);
  assert.equal(s.kernel.probability_init, 1, '指挥开战即生效');
  assert.equal(s.kernel.effects.length, 3);
  assert.equal((s.ui.des.match(/%n%/g) || []).length, 3);
  assert.equal(s.ui.include_effect.length, 3);
  assert.equal(s.ui.levels.length, LEVEL_COUNT);
  assert.equal(s.ui.target, 5);
  assert.equal(s.ui.limit, 2);
  assert.equal(s.kernel.effects[0].target_type, 'self_and_ally_single');
  assert.equal(s.kernel.effects[1].target_type, 'self');
  assert.equal(s.kernel.effects[2].target_type, 'self');
});

test('配置：回击概率 30% 起每级 +5%，洞察/减伤/伤害率固定', () => {
  const s = skillById(CFG_ID);
  const [eInsight, eCounter, eReduce] = s.kernel.effects;
  assert.equal(eInsight.mechanics.insight_rounds, 3);
  assert.equal(eCounter.mechanics.counter.rate_pct, 87);
  assert.equal(eCounter.mechanics.counter.damage_type, 'STRATEGY_DAMAGE');
  assert.equal(eReduce.mechanics.damage_taken_reduce, 0.3);
  assert.ok(s.ui.des.includes('87% 策略伤害'), '描述里的伤害率必须与内核同源');
  assert.ok(s.ui.des.includes('免疫控制') && s.ui.des.includes('受到伤害降低'));

  s.ui.levels.forEach((row, i) => {
    assert.deepEqual(row.effect_value, [3, 30 + i * 5, 30], `Lv${i + 1} 槽值`);
    assert.equal(row.probability, 100, '指挥战法发动率恒 100%');
  });
  assert.equal(s.ui.levels.at(-1).effect_value[1], 75, 'Lv10 回击概率 75%');
  assert.equal(reportSkillFields(CFG_ID, 10).e_v[1], 75, '战报字段同源');
});

test('映射：kernelSkillAt 逐等级取 UI 槽值，界面数字即结算数字', () => {
  for (let lv = 1; lv <= LEVEL_COUNT; lv += 1) {
    const k = kernelSkillAt(CFG_ID, lv);
    const [vInsight, vCounter, vReduce] = authored.ui.levels[lv - 1].effect_value;
    assert.equal(k.skill_class, '指挥');
    assert.equal(k.effects.length, 3);
    assert.equal(k.effects[0].mechanics.insight_rounds, vInsight);
    assert.equal(k.effects[1].mechanics.counter.chance, vCounter / 100);
    assert.equal(k.effects[1].mechanics.counter.rate_pct, 87);
    assert.equal(k.effects[2].mechanics.damage_taken_reduce, vReduce / 100);
    // 三槽都是 BUFF，不能误进攻击方 bonus_terms（否则减伤会变成增伤）
    for (const e of k.effects) {
      assert.equal(e.effect_type, 'BUFF');
      assert.deepEqual(e.bonus_terms, []);
    }
  }
  assert.equal(kernelSkillAt(CFG_ID, 1).effects[1].mechanics.counter.chance, 0.3);
  assert.equal(kernelSkillAt(CFG_ID, 10).effects[1].mechanics.counter.chance, 0.75);
});

test('叙述：面板/战报读到的就是指定效果，%n% 按等级填掉', () => {
  const s = skillById(CFG_ID);
  assert.equal(desText(s, 1),
    '战斗开始时，自身与一名友军获得 3 回合洞察（免疫控制）；自身受到攻击时，有 30% 概率回击一次，造成 87% 策略伤害；自身受到伤害降低 30%。');
  assert.ok(desText(s, 10).includes('有 75% 概率回击一次'));
  assert.ok(!desText(s, 10).includes('%n%'));
  const p = skillProfile(CFG_ID, 10);
  assert.equal(p.cls, '指挥');
  assert.equal(p.target, '自身与一名友军');
  assert.ok(p.effect.includes('洞察') && p.effect.includes('回击') && p.effect.includes('受到伤害降低'));
  assert.ok(p.trigger.includes('开战即生效'));
  assert.match(actSentence({ t: 'skill', fName: '主角', skill: '后世之识', loss: 120, counter: true }),
    /受击回击/);
  assert.match(actSentence({ t: 'immune', toName: '主角', state: '犹豫' }), /洞察生效，免疫/);
});

test('内核实跑：自身+一名友军获得洞察，前 3 回合免疫，第 4 回合可受控', () => {
  const r = fight(1);
  const granted = r.events.filter((e) => e.kind === 'reaction' && e.payload.mechanics.includes('洞察'));
  assert.deepEqual(granted.map((e) => e.payload.target).sort(), ['a0', 'a1'], '洞察只给自身与一名友军');
  assert.equal(r.events.filter((e) => e.kind === 'reaction' && e.payload.mechanics.includes('回击')).length, 1);
  assert.equal(r.events.filter((e) => e.kind === 'reaction' && e.payload.mechanics.includes('受到伤害降低')).length, 1);

  const immuneRounds = [...new Set(r.events.filter((e) => e.kind === 'control_immune').map((e) => e.round))];
  const controlRounds = [...new Set(r.events.filter((e) => e.kind === 'control').map((e) => e.round))];
  assert.deepEqual(immuneRounds.sort(), [1, 2, 3], '前 3 回合免疫控制');
  assert.ok(controlRounds.length > 0 && controlRounds.every((x) => x >= 4), '第 4 回合起洞察失效');
  const expired = r.events.filter((e) => e.kind === 'reaction_expire' && e.payload.kind === 'insight');
  assert.deepEqual(expired.map((e) => e.round), [3, 3]);
  assert.deepEqual(expired.map((e) => e.actor).sort(), ['a0', 'a1']);
});

test('内核实跑：回击按等级概率触发、伤害率恒 87%、自身受伤降低 30%', () => {
  const r = fight(1);
  const counterHits = r.events.filter((e) => e.kind === 'damage' && e.payload.counter);
  assert.ok(counterHits.length >= 1, 'Lv1 应至少回击一次');
  for (const e of counterHits) {
    assert.equal(e.payload.effect_type, 'STRATEGY_DAMAGE');
    assert.equal(e.payload.rate_pct_at_level, 87, '武将 Lv10 也不得把 87% 二次放大');
    assert.equal(e.payload.skill, '后世之识');
  }
  assert.ok(r.events.some((e) => e.kind === 'skill_trigger' && e.payload.counter), '回击必须有发动事件供战报取数');

  const mitigated = r.events.filter((e) => e.kind === 'damage' && e.payload.damage_reduce > 0);
  assert.ok(mitigated.length >= 1, '自身受击应带减伤');
  for (const e of mitigated) {
    assert.equal(e.payload.damage_reduce, 0.3);
    assert.equal(e.payload.applied, Math.max(0, Math.trunc(e.payload.before_mitigation * 0.7)));
  }
  // 回击打向敌军，敌军没有减伤 reaction
  for (const e of counterHits) assert.equal(e.payload.damage_reduce, undefined);

  // 多 seed 聚合：Lv10 的 75% 必须显著高于 Lv1 的 30%
  let c1 = 0; let c10 = 0;
  for (let seed = 1; seed <= 20; seed += 1) {
    c1 += fight(1, seed).events.filter((e) => e.kind === 'damage' && e.payload.counter).length;
    c10 += fight(10, seed).events.filter((e) => e.kind === 'damage' && e.payload.counter).length;
  }
  assert.ok(c10 > c1 * 1.8, `回击概率成长失效：Lv1=${c1} Lv10=${c10}`);
  assert.equal(fight(1).event_fingerprint, r.event_fingerprint, '同种子必须逐事件可复现');
});

test('战报同源：回击伤害进 skillHit（c_id=19001），不是只在内核里空转', () => {
  const r = fight(10);
  const idMap = { a0: 1, a1: 2, d0: 3 };
  const skillLookup = {
    a0: new Map([['后世之识', { ...reportSkillFields(CFG_ID, 10), class: '指挥' }]]),
  };
  const rounds = kernelEventsToRounds(r, idMap, skillLookup);
  const skillHits = rounds.flatMap((x) => x.b).flatMap((h) => [...h.a_bs, ...h.a_as, ...h.d_as]);
  const protag = skillHits.filter((h) => h.c_id === CFG_ID && h.lv === 10);
  assert.ok(protag.length >= 1, '回击战法应出现在战报技能栏');
  assert.ok(protag.some((h) => h.kill.some((n) => n > 0)), '回击造成的伤害必须记进战报 kill');
});

test('防退化：旧战法事件流不含任何 M4-7 新事件或新字段', () => {
  const legacy = runBattle({
    units: [mkUnit('a0', 1, [kernelSkillAt(910100, 10)]), mkUnit('d0', 2, [kernelSkillAt(910112, 10)])],
    seed: 20261113, config: DEFAULT_BATTLE_CONFIG, roundLimit: 6,
  });
  const newKinds = new Set(['reaction', 'reaction_expire', 'control_immune', 'counter_miss']);
  assert.ok(legacy.events.every((e) => !newKinds.has(e.kind)), '旧战法不得产生新事件');
  assert.ok(legacy.events.filter((e) => e.kind === 'damage')
    .every((e) => !('damage_reduce' in e.payload) && !('counter' in e.payload)
      && !('before_mitigation' in e.payload)), '旧战法 damage payload 必须逐字段不变');
  assert.ok(legacy.events.filter((e) => e.kind === 'buff')
    .every((e) => !('mechanics' in e.payload)), '旧战法 buff payload 必须逐字段不变');
  assert.equal(legacy.event_fingerprint, runBattle({
    units: [mkUnit('a0', 1, [kernelSkillAt(910100, 10)]), mkUnit('d0', 2, [kernelSkillAt(910112, 10)])],
    seed: 20261113, config: DEFAULT_BATTLE_CONFIG, roundLimit: 6,
  }).event_fingerprint, '旧战法确定性不变');
});

test('防退化：战报层保留免疫与回击的专属叙述分支', () => {
  const battleSrc = readFileSync(resolve(ROOT, 'server', 'battle.js'), 'utf8');
  const narrativeSrc = readFileSync(resolve(ROOT, 'server', 'domain', 'battle-narrative.js'), 'utf8');
  assert.match(battleSrc, /control_immune/, '免疫事件必须进战报编排');
  assert.match(battleSrc, /counter: !!p\.counter/, '回击事件必须与开战生效区分');
  assert.match(narrativeSrc, /受击回击/, '回击必须有专属话术');
  assert.match(narrativeSrc, /洞察生效，免疫/, '洞察免疫必须有专属话术');
});
