/**
 * 把 skill-library 的原创技能库写成游戏能加载的战法表。
 * 只读 adapted/skills_library.json 和原创技能库那一段武将对应。
 * 不读 source/ 里的原游戏战法名和描述。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = resolve('D:/WorkBuddy/battle-kit/skill-library/adapted/skills_library.json');
const MAP = resolve('D:/WorkBuddy/battle-kit/skill-library/adapted/hero_skill_map.csv');

const CLASS_TRIGGER = { 主动: 1, 被动: 2, 追击: 3, 指挥: 4 };
const CLASS_DIR = { 主动: 'zhudong', 被动: 'beidong', 追击: 'zuiji', 指挥: 'zhihui' };
const TARGET = {
  self: [1, '自身'],
  ally_group: [5, '我军全体'],
  enemy_single: [6, '敌军单体'],
  enemy_group: [9, '敌军全体'],
};
const round = (n) => Math.round(n * 100) / 100;

function effectIcon(effect) {
  const name = effect.bonus_terms?.[0]?.name || '';
  if (name.includes('防御') || name.includes('减伤')) return 3;
  if (name.includes('谋略') || name.includes('智力')) return 4;
  if (name.includes('速度')) return 5;
  if (name.includes('攻击')) return 2;
  return 1;
}

function slotOf(effect) {
  const known = TARGET[effect.target_type];
  if (!known) throw new Error(`未知目标 ${effect.target_type}`);
  const [, who] = known;
  if (effect.effect_type === 'PHYSICAL_DAMAGE') {
    return { text: `对${who}造成兵刃伤害（伤害率%n%%）`, value: effect.rate_pct, icon: 1 };
  }
  if (effect.effect_type === 'STRATEGY_DAMAGE') {
    return { text: `对${who}造成谋略伤害（伤害率%n%%）`, value: effect.rate_pct, icon: 1 };
  }
  if (effect.effect_type === 'HEAL') {
    return { text: `为${who}恢复兵力（恢复率%n%%）`, value: effect.rate_pct, icon: 1 };
  }
  if (effect.effect_type === 'CONTROL') {
    return {
      text: `使${who}陷入${effect.control_state}（几率%n%%）`,
      value: round((effect.control_probability || 0) * 100),
      icon: 1,
    };
  }
  if (effect.effect_type === 'BUFF' || effect.effect_type === 'DEBUFF') {
    const term = effect.bonus_terms?.[0]?.name || (effect.effect_type === 'BUFF' ? '增益' : '减益');
    return {
      text: `${who}${term}（%n%%）`,
      value: effect.bonus_terms?.[0]?.value ?? 0,
      icon: effectIcon(effect),
    };
  }
  throw new Error(`未知效果 ${effect.effect_type}`);
}

function levelsOf(values, probability) {
  const pct = Math.round(probability * 100);
  const levels = [];
  for (let lv = 1; lv <= 10; lv += 1) {
    const scale = 1 + (lv - 1) / 9;
    levels.push({
      probability: pct,
      effect_value: values.map((v) => round(v * scale)),
      effect_round: values.map(() => 0),
    });
  }
  return levels;
}

const lib = JSON.parse(readFileSync(LIB, 'utf8'));
const skills = lib.map((s) => {
  const slots = s.effects.map(slotOf);
  const trigger = CLASS_TRIGGER[s.skill_class];
  if (!trigger) throw new Error(`未知类型 ${s.skill_class}`);
  const tags = s.meta?.tags || [];
  const des = `${slots.map((x) => x.text).join('，')}。特性：${tags.join('、')}。`;
  const values = slots.map((x) => x.value);
  if ((des.match(/%n%/g) || []).length !== values.length) {
    throw new Error(`${s.name} 描述占位与数值对不上`);
  }
  return {
    cfgId: s.skill_id,
    name: s.name,
    trigger,
    dir: CLASS_DIR[s.skill_class],
    ui: {
      cfgId: s.skill_id,
      name: s.name,
      des,
      trigger,
      target: TARGET[s.effects[0].target_type][0],
      limit: 3,
      arms: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      include_effect: slots.map((x) => x.icon),
      levels: levelsOf(values, s.probability_init),
    },
    kernel: {
      cfgId: s.skill_id,
      name: s.name,
      skill_class: s.skill_class,
      prepare: s.prepare || 0,
      probability_init: s.probability_init,
      probability_max: s.probability_max,
      detail_id: s.main_detail,
      effects: s.effects.map((e) => ({
        detail_id: e.detail_id,
        effect_type: e.effect_type,
        rate_pct: e.rate_pct,
        target_type: e.target_type,
        attack_type: e.attack_type || 'normal',
        available_round: e.available_round || 0,
        control_state: e.control_state,
        control_probability: e.control_probability || 0,
        bonus_terms: (e.bonus_terms || []).map((b) => ({ name: b.name, value: b.value, op: b.op })),
      })),
    },
    provenance: {
      pairing: 'skill-library',
      source: 'battle-kit/skill-library/adapted/skills_library.json',
      pattern: s.meta?.pattern_name || '',
      tags,
      quality: s.skill_quality,
    },
  };
});

const heroSkill = {};
const lines = readFileSync(MAP, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(1);
for (const line of lines) {
  if (!line.trim()) continue;
  const [scope, id, , hero] = line.split(',');
  if (scope !== '原创技能库' || !hero || heroSkill[hero]) continue;
  heroSkill[hero] = Number(id);
}

function signature(s) {
  return JSON.stringify({
    cls: s.kernel.skill_class,
    trigger: s.ui.trigger,
    target: s.ui.target,
    effects: s.kernel.effects.map((e) => ({
      t: e.effect_type,
      tgt: e.target_type,
      r: e.rate_pct,
      c: e.control_state,
      p: e.control_probability,
      b: (e.bonus_terms || []).map((term) => [term.name, term.value, term.op]),
    })),
  });
}

const kept = [];
const redirect = new Map();
const seen = new Map();
for (const s of skills) {
  const sig = signature(s);
  if (seen.has(sig)) {
    redirect.set(s.cfgId, seen.get(sig));
    continue;
  }
  seen.set(sig, s.cfgId);
  kept.push(s);
}
for (const hero of Object.keys(heroSkill)) {
  const id = heroSkill[hero];
  heroSkill[hero] = redirect.get(id) || id;
}
const used = {};
for (const id of Object.values(heroSkill)) used[id] = (used[id] || 0) + 1;
for (const s of kept) s.ui.limit = Math.max(1, used[s.cfgId] || 1);

writeFileSync(resolve(ROOT, 'conf', 'library-skills.json'), JSON.stringify({ count: kept.length, dropped: skills.length - kept.length, skills: kept }));
writeFileSync(resolve(ROOT, 'conf', 'campaign', 'hero-skills.json'), JSON.stringify(heroSkill, null, 2));
console.log(`skills ${kept.length} dropped ${skills.length - kept.length} heroes ${Object.keys(heroSkill).length}`);
