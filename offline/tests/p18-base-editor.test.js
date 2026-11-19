/**
 * ★ 2026-11-17 初始数据编辑器验收（用户：「技能和属性要提供新增和编辑功能。
 *   不是存档编辑，是初始编辑……我要自己来修改和创建」+「招募成功或者失败都没有日志」）。
 *
 * 三条链路：
 *   1. 招募日志：drawGeneral 各失败/成功分支全部 recordEvent（事件卡/战略事件流可见）；
 *   2. 战法编辑器：custom-skills.json 覆盖层 —— 新增 29xxx、覆盖既有、重置还原，
 *      编辑器侧校验 = skill-balance 平衡闸同口径（输出指数 300~2000、控制 ×2、
 *      指挥/被动恒 100%、kernel/ui 同源）；
 *   3. 武将编辑器：新增 890001+（loadConfig 注入 → 酒馆客池 → makeGeneral），
 *      初始口径不改当前存档；自建可删、原表条目不可删。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld, makeGeneral } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { SKILLS, SKILL_BY_ID, kernelSkillAt, LEVEL_COUNT } from '../server/skills.js';
import {
  buildCustomSkill, saveSkill, resetSkill, skillList, customSkillIds, patchExistingSkill,
} from '../server/domain/skill-editor.js';
import {
  editorCreate, editorDeleteCustom, CUSTOM_GENERAL_ID_FROM, editorSave, editorReset,
} from '../server/domain/general-editor.js';
import { ensureTavern } from '../server/domain/tavern.js';
import { runBattle, DEFAULT_BATTLE_CONFIG } from '../kernel/index.js';

const cfg = loadConfig();
const CUSTOM_FILE = resolve(import.meta.dirname, '..', 'conf', 'campaign', 'custom-skills.json');

function makeCtx(state) {
  return {
    state, cfg, options: {}, pushes: [],
    push() {}, save() {}, log() {}, schedule() {},
  };
}

/* ---------------- 1. 招募日志 ---------------- */

test('招募（指名）：金不足分支落事件日志，含武将名', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = makeCtx(state);
  ensureTavern(state, cfg);
  state.roleRes.gold = 0; // 强制走「府库金不足」分支（窗口分支也可能先命中，两者都必须有日志）
  const person = state.tavern.people.find((p) => !p.recruited);
  assert.ok(person, '酒馆应有在野客人');
  const before = state.strategy.events.length;
  const r = handleRequest(ctx, { seq: 1, name: 'general.drawGeneral', msg: { cfgId: person.cfgId, drawTimes: 1 } });
  assert.equal(r.code, 0);
  const events = state.strategy.events.slice(before);
  assert.ok(events.some((e) => e.text.includes(person.name)),
    `招募失败必须落事件日志（含「${person.name}」），实际：${events.map((e) => e.text).join(' | ') || '（无）'}`);
  assert.ok(events.every((e) => !/[A-Za-z_]{4,}/.test(e.text.replace(/cfgId|drawGeneral/g, ''))),
    '招募日志不得出现英文 reason 词');
});

test('招募（连抽）：座上无人 / 金不足分支落事件日志', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = makeCtx(state);
  ensureTavern(state, cfg);
  // 金不足：必然走 not_enough_gold（若有客）或 no_guest（无客），两者都要有日志
  state.roleRes.gold = 0;
  const before = state.strategy.events.length;
  handleRequest(ctx, { seq: 1, name: 'general.drawGeneral', msg: { drawTimes: 3 } });
  const events = state.strategy.events.slice(before);
  assert.ok(events.length >= 1, '连抽失败必须落事件日志');
  assert.ok(events.some((e) => /酒肆|府库金不足|延请/.test(e.text)),
    `日志文案应可读：${events.map((e) => e.text).join(' | ')}`);
});

test('招募成功分支与拟人分支的 recordEvent 源码闸（每个 return/break 路径都有日志）', () => {
  const src = readFileSync(resolve(import.meta.dirname, '..', 'server', 'handlers.js'), 'utf8');
  const seg = src.slice(src.indexOf("case 'general.drawGeneral'"), src.indexOf("case 'general.composeGeneral'"));
  assert.ok(seg.includes('recordEvent(state, `以 ${costEach} 金延得'), '成功（指名）必须有日志');
  assert.ok(seg.includes('recordEvent(state, `延请「${row.name}」被婉拒'), '婉拒（指名）必须有日志');
  assert.ok(seg.includes('recordEvent(state, `延请「${person.name}」被婉拒'), '婉拒（连抽）必须有日志');
  assert.ok(seg.includes('recordEvent(state, \'酒肆此刻无人可招'), '座上无人必须有日志');
  assert.ok(seg.includes('recordEvent(state, `府库金不足'), '金不足必须有日志');
  assert.ok(seg.includes('recordEvent(state, `「${row.name}」方才离席归家'), '离席必须有日志');
  assert.ok(seg.includes('recordEvent(state, `「${row.name}」${row.when || \'稍后\'}才到'), '未到必须有日志');
  assert.ok(seg.includes('recordEvent(state, `延请「${known.name'), '不在本城必须有日志');
});

/* ---------------- 2. 战法编辑器 ---------------- */

test('战法新增：主动单体伤害，运行时/kernel/ui 三路同源，输出指数在闸内', () => {
  const r = saveSkill(SKILLS, {
    name: '测试斩', skillClass: '主动', effectType: 'PHYSICAL_DAMAGE',
    targetType: 'enemy_single', probLv1: 35, probLv10: 40, valueLv1: 100, valueLv10: 200,
  });
  try {
    assert.ok(r.ok, r.message);
    assert.ok(r.cfgId >= 29001, `新战法应从 29001 起编号（实测 ${r.cfgId}）`);
    const s = SKILL_BY_ID.get(r.cfgId);
    assert.ok(s, '保存后运行时表立即可见');
    assert.equal(s.ui.levels.length, LEVEL_COUNT, '必须十级');
    const k10 = kernelSkillAt(r.cfgId, 10);
    assert.equal(k10.effects[0].rate_pct, 200, 'kernel Lv10 伤害率 = ui 末级');
    assert.equal(s.ui.levels.at(-1).effect_value[0], 200);
    assert.equal(s.kernel.probability_max, 0.4, 'probability_max 与 ui Lv10 同源');
    assert.equal(s.kernel.probability_init, 0.35);
    assert.ok(s.ui.levels.at(-1).probability > s.ui.levels[0].probability, '发动率逐级成长');
    // 输出指数闸：casts(8) × 0.40 × 200 × 1 = 640 ∈ [300,2000]
    const idx = 8 * 0.4 * 200 * 1;
    assert.ok(idx >= 300 && idx <= 2000);
    assert.equal(s.kernel.detail_id, s.kernel.effects[0].detail_id);
    assert.deepEqual(s.kernel.bonus_terms, [], '不得把机制写进 bonus_terms');
  } finally {
    resetSkill(SKILLS, { cfgId: r.cfgId });
  }
  assert.ok(!SKILL_BY_ID.has(r.cfgId), '重置后自建战法应从运行时表移除');
});

test('战法平衡校验：群体高伤被拒并给出上限提示；控制命中率 Lv10=Lv1×2 且 ≤100', () => {
  const bad = saveSkill(SKILLS, {
    name: '过分技', skillClass: '主动', effectType: 'STRATEGY_DAMAGE',
    targetType: 'enemy_all', probLv1: 45, probLv10: 50, valueLv1: 300, valueLv10: 300,
  });
  assert.ok(!bad.ok && /输出指数/.test(bad.message), `应被输出指数闸拦下：${bad.message}`);

  const r = saveSkill(SKILLS, {
    name: '测试定身', skillClass: '主动', effectType: 'CONTROL',
    targetType: 'enemy_single', probLv1: 35, probLv10: 44, valueLv1: 40, controlState: '混乱',
  });
  try {
    assert.ok(r.ok, r.message);
    const s = SKILL_BY_ID.get(r.cfgId);
    assert.equal(s.ui.levels[0].effect_value[0], 40);
    assert.equal(s.ui.levels.at(-1).effect_value[0], 80, '控制命中率 Lv10 = Lv1×2');
    assert.equal(s.kernel.effects[0].control_state, '混乱');
    assert.equal(s.kernel.rate_pct_lv1, 0, '控制战法不带伤害率（fixed 判定）');
  } finally {
    resetSkill(SKILLS, { cfgId: r.cfgId });
  }
});

test('指挥/被动恒 100% 发动且 kernel 同源；恒定概率不强推成长', () => {
  const r = saveSkill(SKILLS, {
    name: '测试天阵', skillClass: '指挥', effectType: 'PHYSICAL_DAMAGE',
    targetType: 'enemy_all', probLv1: 10, probLv10: 10, valueLv1: 120, valueLv10: 150,
  });
  try {
    assert.ok(r.ok, r.message);
    const s = SKILL_BY_ID.get(r.cfgId);
    assert.deepEqual(s.ui.levels.map((l) => l.probability), [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    assert.equal(s.kernel.probability_init, 1);
    assert.equal(s.kernel.probability_max, 1);
  } finally {
    resetSkill(SKILLS, { cfgId: r.cfgId });
  }
});

test('覆盖既有战法 + 重置还原：运行时回到原表数值，原文件逐字不动', () => {
  const original = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'conf', 'skills.json'), 'utf8'));
  const base10 = original.skills.find((s) => s.cfgId === 10001).ui.levels.at(-1).effect_value[0];
  const r = saveSkill(SKILLS, {
    cfgId: 10001, name: '击势', skillClass: '主动', effectType: 'PHYSICAL_DAMAGE',
    targetType: 'enemy_all', probLv1: 35, probLv10: 40, valueLv1: 80, valueLv10: 160,
  });
  try {
    assert.ok(r.ok, r.message);
    assert.equal(SKILL_BY_ID.get(10001).ui.levels.at(-1).effect_value[0], 160, '运行时已覆盖');
  } finally {
    const rr = resetSkill(SKILLS, { cfgId: 10001 });
    assert.ok(rr.ok && rr.restored, rr.message);
  }
  assert.equal(SKILL_BY_ID.get(10001).ui.levels.at(-1).effect_value[0], base10, '重置后还原原表数值');
  const after = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'conf', 'skills.json'), 'utf8'));
  assert.equal(after.skills.find((s) => s.cfgId === 10001).ui.levels.at(-1).effect_value[0], base10,
    'conf/skills.json 原表逐字不动');
});

test('skillList：全表 + 自建标记 + 表单口径下发；未知 cfgId 拒绝编辑', () => {
  const r = saveSkill(SKILLS, {
    name: '列表探针', skillClass: '被动', effectType: 'HEAL',
    targetType: 'ally_group', probLv1: 100, probLv10: 100, valueLv1: 50, valueLv10: 80,
  });
  try {
    assert.ok(r.ok, r.message);
    const list = skillList(SKILLS);
    const row = list.rows.find((x) => x.cfgId === r.cfgId);
    assert.ok(row && row.custom, 'skillList 应带自建标记');
    assert.ok(list.meta && list.meta.classes.length === 4, '表单口径应下发');
    const bad = saveSkill(SKILLS, { cfgId: 999999, name: '幽灵', skillClass: '主动', effectType: 'HEAL', targetType: 'self', probLv1: 35, probLv10: 40, valueLv1: 50, valueLv10: 60 });
    assert.ok(!bad.ok && /未知战法/.test(bad.message), '未知 cfgId 必须拒绝');
  } finally {
    resetSkill(SKILLS, { cfgId: r.cfgId });
  }
  assert.equal(customSkillIds().size, 0, '测试收尾：覆盖层应清空');
  assert.ok(!readFileSync(CUSTOM_FILE, 'utf8').includes('列表探针'), 'custom-skills.json 不残留测试数据');
});

/* ---------------- 3. 武将编辑器 ---------------- */

test('武将新增：cfgId 自动分配、属性钳位、loadConfig 注入、酒馆客池与 makeGeneral 可见', () => {
  const r = editorCreate(cfg, {
    name: '测试自建将', country: '自定义', arms: 3,
    force: 88, strategy: 44, defense: 66, speed: 70, destroy: 90, politics: 55,
    force_grow: 40, cost: 20, star: 4, skillCfgId: 10001,
  });
  try {
    assert.ok(r.ok, r.message);
    assert.ok(r.cfgId >= CUSTOM_GENERAL_ID_FROM, `应从 ${CUSTOM_GENERAL_ID_FROM} 起编号`);
    const row = cfg.generalByCfg.get(r.cfgId);
    assert.ok(row && row.name === '测试自建将' && row.__custom__);
    assert.deepEqual(row.arms, [3]);
    assert.ok(row.force <= 100 && row.force >= 1, '百分制钳位');

    const cfg2 = loadConfig(); // 覆盖层 → 注入链路（新开局同路径）
    const injected = cfg2.generalByCfg.get(r.cfgId);
    assert.ok(injected && injected.force === 88 && injected.skillCfgId === 10001);

    const state = normalizeWorld(createWorld(cfg2), cfg2);
    ensureTavern(state, cfg2);
    assert.ok(state.tavern.people.some((p) => p.cfgId === r.cfgId), '酒馆客池应出现自建武将');
    const g = makeGeneral(cfg2, 99999, r.cfgId, 1, 10);
    assert.equal(g.star, 4);
    assert.equal(g.curArms, 3);
    assert.deepEqual(g.skills[0] && g.skills[0].cfgId, 10001, '自带战法按编辑器口径');
  } finally {
    editorDeleteCustom(cfg, { cfgId: r.cfgId });
  }
  assert.ok(!cfg.generalByCfg.has(r.cfgId), '删除后 cfg 移除');
  assert.ok(!loadConfig().generalByCfg.has(r.cfgId), '删除后 loadConfig 不再注入');
});

test('武将编辑器：名字必填；只能删除自建条目（原表武将拒绝删除）', () => {
  const noName = editorCreate(cfg, { force: 50 });
  assert.ok(!noName.ok && /武将名/.test(noName.message));
  const refused = editorDeleteCustom(cfg, { cfgId: 100010 });
  assert.ok(!refused.ok && /只能删除/.test(refused.message), '原表武将不可删');
});

test('武将/战法覆盖层收尾干净：测试不留残留数据', () => {
  assert.equal(customSkillIds().size, 0, 'custom-skills.json 应为空');
  const ov = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'conf', 'campaign', 'overrides.json'), 'utf8'));
  const customs = Object.values(ov.generals || {}).filter((g) => g.__custom__);
  assert.deepEqual(customs, [], 'overrides.generals 不残留自建武将');
});

/* ---------------- 4. 编辑器 bug 回归（2026-11-18 用户「检查编辑器是否有 bug」） ---------------- */

test('编辑器bug：控制战法列表显示真实命中率而非 0→0（否则编辑后命中率被 clamp 成 1%）', () => {
  const rows = skillList(SKILLS).rows;
  const pureCtl = rows.find((r) => r.effect === 'CONTROL' && r.cfgId === 10017);
  assert.ok(pureCtl, '应能列出纯控制战法');
  assert.ok(pureCtl.rate1 >= 30 && pureCtl.rate10 === pureCtl.rate1 * 2,
    `控制战法应显示命中率且 Lv10=Lv1×2，实际 ${pureCtl.rate1}→${pureCtl.rate10}`);
  assert.ok(pureCtl.controlState, '控制战法应回传 controlState 供表单回填');
  // 多效果战法里的控制槽也按命中率口径展示主伤害槽（不误显示 0）
  const multi = rows.find((r) => r.cfgId === 910003);
  assert.ok(multi && multi.rate1 > 0 && multi.rate10 > multi.rate1, '多效果战法主伤害槽数值正常');
});

test('编辑器bug：编辑多效果战法只改主槽，保留其余效果槽与控制状态', () => {
  const base = SKILLS.find((s) => s.cfgId === 910003); // 连弩之策 = 兵刃 + 控制(犹豫)
  const built = buildCustomSkill({
    cfgId: 910003, name: '连弩之策', skillClass: '主动', effectType: 'PHYSICAL_DAMAGE',
    targetType: 'enemy_single', probLv1: 41, probLv10: 49, valueLv1: 80, valueLv10: 160,
  }, new Set(SKILLS.map((s) => s.cfgId)), SKILLS);
  assert.ok(built.ok, built.message);
  const patched = patchExistingSkill(base, built);
  const effs = patched.kernel.effects;
  assert.equal(effs.length, 2, '两个效果槽都在');
  assert.equal(effs[1].effect_type, 'CONTROL', '控制槽保留');
  assert.equal(effs[1].control_state, '犹豫', '控制状态保留（不被改成默认混乱）');
  assert.equal(effs[1].control_probability, 0.35, '控制命中率保留');
  assert.equal(patched.ui.levels[0].effect_value[0], 80, '主伤害槽 Lv1 已改');
  assert.equal(patched.ui.levels[9].effect_value[1], 70, '控制槽命中率 Lv10 未被触碰');
  assert.equal(base.ui.levels[0].effect_value[0], 90, '原表对象不被就地修改');
});

test('编辑器bug：编辑准备型战法保留 prepare，编辑机制战法保留 mechanics', () => {
  const b2 = buildCustomSkill({
    cfgId: 10020, name: '一雷惊蛰', skillClass: '主动', effectType: 'STRATEGY_DAMAGE',
    targetType: 'enemy_single', probLv1: 42, probLv10: 50, valueLv1: 150, valueLv10: 150,
  }, new Set(SKILLS.map((s) => s.cfgId)), SKILLS);
  assert.ok(b2.ok, b2.message);
  assert.equal(patchExistingSkill(SKILLS.find((s) => s.cfgId === 10020), b2).kernel.prepare, 1, '准备回合保留');

  const mech = SKILLS.find((s) => s.cfgId === 19001); // 坐镇中军：3×BUFF+mechanics
  assert.ok(mech.kernel.effects.some((e) => e.mechanics), '前提：主公战法带 mechanics');
  const built3 = buildCustomSkill({
    cfgId: 19001, name: '坐镇中军', skillClass: '指挥', effectType: 'PHYSICAL_DAMAGE',
    targetType: 'enemy_all', probLv1: 100, probLv10: 100, valueLv1: 10, valueLv10: 20,
  }, new Set(SKILLS.map((s) => s.cfgId)), SKILLS);
  assert.ok(built3.ok, built3.message);
  const patched3 = patchExistingSkill(mech, built3);
  assert.equal(patched3.kernel.effects.length, 3, '三个机制槽都在');
  assert.ok(patched3.kernel.effects.every((e) => e.mechanics), 'mechanics 全部保留');
  assert.equal(patched3.trigger, 4, 'trigger 保留');
});

test('编辑器bug：新建战法重名被拒，不覆盖原表战法', () => {
  const dup = buildCustomSkill({
    name: '击势', skillClass: '主动', effectType: 'PHYSICAL_DAMAGE',
    targetType: 'enemy_single', probLv1: 35, probLv10: 40, valueLv1: 100, valueLv10: 200,
  }, new Set(SKILLS.map((s) => s.cfgId)), SKILLS);
  assert.ok(!dup.ok && /同名/.test(dup.message), `重名应被拒：${dup.message}`);
  assert.ok(SKILL_BY_ID.get(10001).name === '击势', '原表 10001 仍在且名字未变');
});

test('编辑器bug：重置覆盖条目后 ui.range/有效距离描述被还原', () => {
  const orig = SKILLS.find((s) => s.cfgId === 10001);
  const target = orig.ui.target;
  const r = saveSkill(SKILLS, {
    cfgId: 10001, name: '击势', skillClass: '主动', effectType: 'PHYSICAL_DAMAGE',
    targetType: 'enemy_single', probLv1: 35, probLv10: 40, valueLv1: 100, valueLv10: 200,
  });
  assert.ok(r.ok, r.message);
  const rr = resetSkill(SKILLS, { cfgId: 10001 });
  assert.ok(rr.ok && rr.restored);
  const restored = SKILL_BY_ID.get(10001);
  assert.equal(restored.ui.target, target, 'ui.target 还原');
  assert.ok(typeof restored.ui.range === 'number' && restored.ui.range >= 1, 'ui.range 应被重新套用');
});

test('编辑器自建战法在真实内核战斗里正常结算伤害（非空结算）', () => {
  const mk = (id, side, cfgId) => ({
    unit_id: id, side, pos: 0,
    hero: {
      heroid: id, name: '武', level: 10, hero_type: 'normal', hit_range: 1, country: '', quality: 5,
      attack_base: 90, defence_base: 40, intel_base: 90, speed_base: 80, destroy_base: 50,
      attack_grow: 3, defence_grow: 3, intel_grow: 3, speed_grow: 3, destroy_grow: 3,
      skills: [kernelSkillAt(cfgId, 10)],
    },
    troops: 2000, max_troops: 2000, speed: 100, attack_range: 5,
  });
  const r = saveSkill(SKILLS, {
    name: '实测穿刺', skillClass: '主动', effectType: 'PHYSICAL_DAMAGE',
    targetType: 'enemy_single', probLv1: 35, probLv10: 50, valueLv1: 100, valueLv10: 200,
  });
  assert.ok(r.ok, r.message);
  try {
    const res = runBattle({
      units: [mk('a0', 1, r.cfgId), mk('d0', 2, 10001)],
      seed: 20261118, config: DEFAULT_BATTLE_CONFIG,
    });
    assert.ok(Array.isArray(res.events), '内核应产出事件流');
    const dmgEvents = res.events.filter((e) => e.kind === 'damage' && e.payload?.skill === '实测穿刺');
    assert.ok(dmgEvents.length > 0, '自建战法必须真实造成至少一次伤害（不能空结算）');
    assert.ok(dmgEvents.every((e) => Number(e.payload.applied) > 0), '每次伤害 applied 必须 > 0');
  } finally {
    resetSkill(SKILLS, { cfgId: r.cfgId });
  }
});

test('编辑器bug：保存武将属性不重置自带战法等级', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const g = state.generals.find((x) => x.skills?.[0]?.cfgId); // 找有自带战法的武将
  assert.ok(g, '前提：有带自带战法的武将');
  g.skills[0].lv = 7; // 模拟已练到高级
  const skillId = g.skills[0].cfgId;
  try {
    editorSave(cfg, state, { cfgId: g.cfgId, force: 61 });
    // syncStateSkill 原地修改 state.generals，g 引用仍有效
    assert.equal(g.skills[0].lv, 7, '改属性后自带战法等级保留（不被清零到 1）');
    assert.equal(g.skills[0].cfgId, skillId, '自带战法不变');
  } finally {
    // 还原编辑器覆盖，避免污染其它测试
    editorReset(cfg, state, { cfgId: g.cfgId });
  }
});
