/**
 * P61-E（2026-11-25）难度四档、终局统一与 AI 人格回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, difficultyList, applyDifficulty,
  stageGoalTick, strategyContinueSandbox,
} from '../server/domain/strategy.js';
import { evaluateEnding } from '../server/domain/failstate.js';
import { GRAND_ENDING, GRAND_UNIFY_CITIES } from '../server/domain/stage-goals.js';
import { knobGet } from '../server/domain/knobs.js';
import { advanceToNextTurn } from '../server/handlers.js';
import { PERSONA_AXES, planCampaign } from '../server/domain/strategy-brain.js';

const cfg = loadConfig();
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
function fresh(difficulty) {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const lord = oathOptions(s).lords.find((l) => l.cities.length >= 2) || oathOptions(s).lords[0];
  const r = chooseOath(s, cfg, mkCtx(s), { lord: lord.id, city: lord.cities[0].id, difficulty });
  assert.equal(r.ok, true);
  return s;
}

test('P61-S5 四档难度：开局选择写入三个旋钮，外交倍率真正被消费', () => {
  const levels = difficultyList();
  assert.deepEqual(levels.map((x) => x.id), ['chrono', 'normal', 'challenge', 'conquest']);
  assert.deepEqual(oathOptions(createWorld(cfg)).difficulties.map((x) => x.label),
    ['史实', '常规', '挑战', '霸业']);
  const easy = fresh('chrono');
  const hard = fresh('conquest');
  assert.equal(easy.difficulty, 'chrono');
  assert.ok(knobGet(easy, 'difficultyAi') < knobGet(hard, 'difficultyAi'));
  assert.ok(knobGet(easy, 'difficultyRes') > knobGet(hard, 'difficultyRes'));
  assert.ok(knobGet(easy, 'difficultyDiplo') < knobGet(hard, 'difficultyDiplo'));
  const src = readFileSync(new URL('../server/domain/diplomacy.js', import.meta.url), 'utf8');
  assert.match(src, /60 \* dm/);
  assert.match(src, /difficultyDiplo/);
});

test('P61-S6 终局：24 城称帝只是阶段，30 城写史评并冻结回合', () => {
  const s = fresh('normal');
  const ids = Object.keys(s.strategy.cities).map(Number).sort((a, b) => a - b);
  assert.ok(ids.length > GRAND_UNIFY_CITIES);
  for (const id of ids) s.strategy.cities[id].owner = 'han';
  for (let i = 0; i < 24; i += 1) s.strategy.cities[ids[i]].owner = 'player';
  stageGoalTick(s, cfg, mkCtx(s));
  assert.equal(s.strategy.sandboxEnding.title, '称帝');
  assert.equal(s.strategy.grandEnding, undefined, '24 城不得冒充终局');
  assert.equal(evaluateEnding(s), null);
  for (let i = 24; i < GRAND_UNIFY_CITIES; i += 1) s.strategy.cities[ids[i]].owner = 'player';
  for (const id of ids) if (!s.strategy.cities[id].owner || s.strategy.cities[id].owner === 'han') s.strategy.cities[id].owner = 'han';
  stageGoalTick(s, cfg, mkCtx(s));
  assert.equal(s.strategy.grandEnding.title, GRAND_ENDING.title);
  assert.ok(s.strategy.grandEnding.history.length > 10);
  assert.equal(s.strategy.endGameFrozen, true);
  const end = evaluateEnding(s);
  assert.equal(end.type, 'unified');
  assert.equal(end.text, s.strategy.grandEnding.history, '史评与结局唯一真源同源');
  const blocked = advanceToNextTurn(mkCtx(s));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'ending_frozen');
  assert.equal(strategyContinueSandbox(s, mkCtx(s)).ok, true);
  assert.equal(s.strategy.endGameFrozen, false);
  assert.equal(evaluateEnding(s).type, 'unified', '续局后史评仍在');
});

test('P61-S9 AI 人格：常见诸侯各有轴，未配置者确定性分配且不再全体同款', () => {
  assert.equal(Object.keys(PERSONA_AXES).length >= 16, true);
  const s = fresh('normal');
  const axes = new Set();
  for (const name of ['马腾', '刘表', '袁术', '张鲁', '公孙度', '未知势力甲', '未知势力乙']) {
    const f = { id: name, name, persona: name };
    const orders = planCampaign(f, {
      turn: 3, season: '春', cities: [], factions: [], marches: [],
    }, s);
    assert.equal(orders.protocol, 'slg-ai-orders-v1');
    axes.add(orders.personality);
  }
  assert.ok(axes.size >= 5, `人格名应各异，实际 ${axes.size}`);
});
