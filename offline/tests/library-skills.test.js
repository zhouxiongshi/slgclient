/**
 * 原创技能库接入：类型、效果、特性来自 skill-library 的自编战法，
 * 武将第一格按 hero_skill_map 里「原创技能库」的对应关系装配。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { SKILLS, kernelSkillAt, createSkillAssets } from '../server/skills.js';
import { loadConfig } from '../server/config.js';
import { makeGeneral, createWorld, normalizeWorld } from '../server/world.js';

const ROOT = resolve(import.meta.dirname, '..');
const library = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'library-skills.json'), 'utf8'));
const heroSkills = JSON.parse(readFileSync(resolve(ROOT, 'conf', 'campaign', 'hero-skills.json'), 'utf8'));
const cfg = loadConfig();

test('去重后的自编战法进入战法表，描述占位和等级成长与效果对齐', () => {
  assert.equal(library.count, 20);
  assert.equal(library.dropped, 108);
  const loaded = SKILLS.filter((s) => s.provenance?.pairing === 'skill-library');
  assert.equal(loaded.length, 20);
  const sigs = new Set();
  for (const s of loaded) {
    const sig = JSON.stringify(s.kernel.effects);
    assert.equal(sigs.has(sig), false, `${s.name} 与另一条效果相同`);
    sigs.add(sig);
  }
  for (const s of loaded) {
    assert.ok(['主动', '被动', '追击', '指挥'].includes(s.kernel.skill_class));
    assert.ok(s.provenance.tags.length >= 1, `${s.name} 没有特性`);
    assert.ok(s.ui.des.includes('特性：'), `${s.name} 描述没有特性`);
    assert.equal(s.ui.levels.length, 10);
    assert.equal((s.ui.des.match(/%n%/g) || []).length, s.kernel.effects.length);
    assert.equal(s.ui.include_effect.length, s.kernel.effects.length);
    const first = s.ui.levels[0].effect_value;
    const last = s.ui.levels.at(-1).effect_value;
    first.forEach((v, i) => {
      if (v > 0) assert.ok(Math.abs(last[i] - v * 2) < 0.02, `${s.name} 10级不是 1 级的两倍`);
    });
  }
});

test('多效果战法按等级把每一段交给内核', () => {
  const burst = kernelSkillAt(910000, 1);
  const grown = kernelSkillAt(910000, 10);
  assert.equal(burst.effects.length, 2);
  assert.equal(burst.effects[0].effect_type, 'PHYSICAL_DAMAGE');
  assert.equal(burst.effects[0].rate_pct, 150);
  assert.equal(grown.effects[0].rate_pct, 300);
  assert.equal(burst.effects[1].effect_type, 'BUFF');
  assert.ok(grown.effects[1].bonus_terms[0].value > burst.effects[1].bonus_terms[0].value);
  const control = kernelSkillAt(910003, 10);
  const hesitation = control.effects.find((e) => e.effect_type === 'CONTROL');
  assert.equal(hesitation.control_state, '犹豫');
  assert.equal(hesitation.control_probability, 0.7);
});

test('武将第一格用技能库对应，主角自带战法不动', () => {
  const lubu = [...cfg.generalByCfg.values()].find((g) => g.name === '吕布');
  assert.ok(lubu, '武将表里没有吕布');
  const g = makeGeneral(cfg, 9, lubu.cfgId, 1, 1);
  assert.equal(g.skills[0].cfgId, heroSkills['吕布']);
  assert.equal(g.skills[1], null);
  assert.equal(g.skills[2], null);
  const world = createWorld(cfg);
  assert.equal(world.generals[0].skills[0].cfgId, 19001);
  const bare = makeGeneral(cfg, 10, lubu.cfgId, 1, 1);
  bare.skills = [null, null, null];
  const state = normalizeWorld({ ...createWorld(cfg), generals: [world.generals[0], bare] }, cfg);
  assert.equal(state.generals[0].skills[0].cfgId, 19001);
  assert.equal(state.generals[1].skills[0].cfgId, heroSkills['吕布']);
});

test('图鉴脚本补丁和武将自带战法号都在内存注入里，磁盘不动', () => {
  const web = existsSync(resolve(ROOT, 'web', 'index.html')) ? resolve(ROOT, 'web') : null;
  assert.ok(web, '缺少 web 目录');
  const assets = createSkillAssets(web);
  const js = assets.intercept('/assets/main/index.js');
  assert.ok(js.body.includes('__slgOpenRoster'));
  assert.equal(js.body.includes('【" + typeName + "】'), false);
  assert.ok(js.body.includes('_ensureSkillTabs'));
  assert.ok(js.body.includes('__slgMountTabs'));
  assert.ok(js.body.includes('_applyCampTab'));
  assert.ok(js.body.includes('["全部", "汉", "群", "魏", "蜀", "吴"]'));
  assert.ok(js.body.includes('历史传记'));
  assert.ok(js.body.includes('_openDossier'));
  const general = assets.intercept('/assets/resources/import/2b/2bb9964d-0938-48d1-b4a5-f2cabf1c1c2b.json');
  const packed = JSON.parse(general.body);
  const list = packed[5][0][2].list;
  const lubu = list.find((g) => g.name === '吕布');
  assert.equal(lubu.skillCfgId, heroSkills['吕布']);
  assert.equal(list.find((g) => g.cfgId === 880001).skillCfgId, 19001);
});
