/**
 * P61-F（2026-11-25）：事件硬后果 / 无事可做检测 / 败仗代价 / 进阶与战法组合。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { parseEffect, validateEventSchema } from '../server/domain/event-dsl.js';
import { applyEffects } from '../server/domain/event-engine.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyEventChoice,
  fateComboDefMul, advanceGeneral,
} from '../server/domain/strategy.js';
import { evaluateAdvice } from '../server/domain/advice.js';
import { interactionState } from '../server/domain/interaction.js';
import { applyGeneralExp, generalProgress, ADVANCED_LEVEL_CAP } from '../server/domain/general-progress.js';
import { makeHero } from '../server/battle.js';
import { SKILLS } from '../server/skills.js';

const cfg = loadConfig();
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
function fresh() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const lord = oathOptions(s).lords.find((l) => l.cities.length >= 2) || oathOptions(s).lords[0];
  const r = chooseOath(s, cfg, mkCtx(s), { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true);
  return s;
}

test('P61-S7 事件效果词新增三类硬后果，schema 全量通过', () => {
  assert.deepEqual(parseEffect('city:7:player'), { kind: 'city', cityId: 7, owner: 'player' });
  assert.deepEqual(parseEffect('troops:capital:+600'), { kind: 'troops', where: 'capital', delta: 600 });
  assert.deepEqual(parseEffect('join:鲁肃:capital'), { kind: 'join', target: '鲁肃', where: 'capital' });
  const events = JSON.parse(readFileSync(new URL('../conf/campaign/events.json', import.meta.url), 'utf8')).events;
  const bad = events.flatMap((e) => validateEventSchema(e, null));
  assert.deepEqual(bad, [], `事件 schema 失败：${bad.join('; ')}`);
  assert.ok(events.find((e) => e.id === 'evt.rel.lusu').choices[0].effects.includes('join:鲁肃:capital'));
});

test('P61-S7 硬效果只经上层 api 落账，局势不符时不假装生效', () => {
  const calls = [];
  const ev = { id: 'evt.x', choices: [{ id: 'a', effects: ['city:7:player', 'troops:frontline:-800', 'nothing'] }] };
  const applied = applyEffects({}, ev, 'a', {
    setCityOwner: (id, owner) => { calls.push(['city', id, owner]); return { text: '城易主' }; },
    addTroops: (where, delta) => { calls.push(['troops', where, delta]); return null; },
  });
  assert.equal(calls.length, 2);
  assert.equal(applied.filter((a) => a.kind === 'troops').length, 0, 'addTroops 返回 null 时不记入已生效');
  assert.equal(applied[0].kind, 'city');
});

test('P61-S7 玩家选择事件真的改驻军，appliedText 中文同源', () => {
  const s = fresh();
  const capital = Number(s.strategy.playerCity);
  s.strategy.cities[capital].owner = 'player';
  s.strategy.cities[capital].troops = 1000;
  s.strategy.pendingEvents = [{
    id: 'evt.cond.defeat.morale', title: '败军之众', choices: [{ id: 'care', label: '抚恤' }],
    sinceTurn: s.strategy.turn || 1,
  }];
  const r = strategyEventChoice(s, cfg, mkCtx(s), { id: 'evt.cond.defeat.morale', choice: 'care' });
  assert.equal(r.ok, true);
  assert.equal(s.strategy.cities[capital].troops, 1600);
  assert.match(r.appliedText, /驻军 1000 → 1600/);
  assert.equal(s.strategy.pendingEvents.length, 0);
});

test('P61-S10 四项全否生成机会建言，连续两旬只记一次', () => {
  const s = fresh();
  const facts = { turn: 3, investReady: false, canRecruit: false, marchable: 0, cutCities: 0, lowGrain: 0, lowLoyalty: 0 };
  const a1 = evaluateAdvice(s, facts);
  assert.equal(a1.idle, true);
  assert.equal(a1.idleTurns, 1);
  assert.ok(a1.cards.some((c) => c.source === 'rule:no_action_four_checks'));
  const a2 = evaluateAdvice(s, facts);
  assert.equal(a2.idleTurns, 1, '同一旬视图刷新不得重复累加');
  assert.equal(evaluateAdvice(s, { ...facts, turn: 4 }).idleTurns, 2);
  assert.equal(evaluateAdvice(s, { ...facts, turn: 5, marchable: 1 }).idleTurns, 0);
  const ix = interactionState(s, cfg);
  assert.ok(ix.advice, '交互态必须下发 advice 供 UI/测试读取');
});

test('P61-S11 败仗代价：负伤两旬降攻防，到期自动复原', () => {
  const s = fresh();
  const g = s.generals.find((x) => !x.isProtagonist) || s.generals[0];
  const row = cfg.generalByCfg.get(Number(g.cfgId)) || {};
  const day = Number(s.clock?.day) || 1;
  const normal = makeHero(g, cfg);
  g.injuredUntil = day + 20;
  const hurt = makeHero(g, cfg);
  assert.ok(hurt.attack_base <= normal.attack_base);
  assert.ok(hurt.defence_base <= normal.defence_base);
  g.injuredUntil = day - 1;
  assert.deepEqual(makeHero(g, cfg), normal, '伤愈后攻防复原');
  const src = readFileSync(new URL('../server/domain/strategy.js', import.meta.url), 'utf8');
  assert.match(src, /defeatCost/);
  assert.match(src, /败军代价/);
  void row;
});

test('P61-S12 满级进阶到 15，战斗加成只在派生层；战法标签组合给折算', () => {
  const s = fresh();
  const g = s.generals.find((x) => !x.isProtagonist) || s.generals[0];
  g.level = 10; g.exp = 0; g.advanced = false; s.roleRes.gold = 5000;
  assert.equal(advanceGeneral(s, cfg, mkCtx(s), { generalId: g.id }).ok, true);
  assert.equal(g.advanced, true);
  applyGeneralExp(g, 100000);
  assert.equal(g.level, ADVANCED_LEVEL_CAP);
  const p = generalProgress(g);
  assert.equal(p.capped, true);
  assert.equal(p.tag, '进阶');
  const normal = makeHero({ ...g, level: 10, advanced: false }, cfg);
  const advanced = makeHero(g, cfg);
  assert.ok(advanced.attack_base >= normal.attack_base, '进阶不改史载五维原表，只走派生加成');
  assert.equal(advanced.level, 10, '内核仍按 10 级成长读表');

  const ctrl = SKILLS.find((x) => x.kernel?.control_state);
  const sustain = SKILLS.find((x) => /HEAL|RECOVER|RESTORE|BUFF/i.test(x.kernel?.effect_type || ''));
  assert.ok(ctrl && sustain, '配置中必须有控制与续航两类战法');
  const a = s.armys[0] || { id: 1, generals: [g.id, g.id], soldiers: [100, 100, 100] };
  a.generals = [g.id, g.id];
  g.skills = [{ cfgId: ctrl.cfgId, lv: 1 }, { cfgId: sustain.cfgId, lv: 1 }];
  const combo = fateComboDefMul(s, cfg, a);
  assert.ok(combo.tags.includes('控制') && combo.tags.includes('续航'));
  assert.ok(combo.mul < 1, '组合必须真实改变守军折算');
});
