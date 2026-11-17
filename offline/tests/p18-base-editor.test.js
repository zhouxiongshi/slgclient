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
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld, makeGeneral } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { SKILLS, SKILL_BY_ID, kernelSkillAt, LEVEL_COUNT } from '../server/skills.js';
import {
  buildCustomSkill, saveSkill, resetSkill, skillList, customSkillIds,
} from '../server/domain/skill-editor.js';
import {
  editorCreate, editorDeleteCustom, CUSTOM_GENERAL_ID_FROM,
} from '../server/domain/general-editor.js';
import { ensureTavern } from '../server/domain/tavern.js';

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
