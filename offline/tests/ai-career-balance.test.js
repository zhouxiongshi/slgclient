/**
 * 平衡与长局稳定性补强（用户 2026-11-16「平衡性/稳定性都测了吗」）。
 *
 * 审计事实：此前平衡只做数值合法性（0~100/引用有效），无对战胜率实证；
 * 稳定性最长 73 旬脚本模拟、单测仅 8 旬，无长局名册演化。本用例补：
 *  1. 对战强度分布：真实内核批量对战，验证「强弱有序、非一面倒、非随机」；
 *  2. 长局名册演化：100+ 旬模拟，名册规模/等级/忠诚有界、无 NaN、确定性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, factionConf } from '../server/domain/strategy.js';
import { ensureTavern } from '../server/domain/tavern.js';
import {
  aiRosterLearnTick, aiRecruitTick, aiPoachTick, aiCaptiveTick, aiAidRequest,
} from '../server/domain/ai-roster.js';
import { PERSONA_AXES } from '../server/domain/strategy-brain.js';
import { kernelSkillAt } from '../server/skills.js';
import { runBattle, DEFAULT_BATTLE_CONFIG } from '../kernel/index.js';

const cfg = loadConfig();
const FACTIONS = factionConf().factions;
const rosterConf = { personas: PERSONA_AXES, factions: FACTIONS };

function mkUnit(id, side, g, seedN = 0) {
  const lv = 10;
  const grow = (base, gk) => Math.min(100, (base || 50) + (g[gk] || 3) * (lv - 1));
  return {
    unit_id: id, side, pos: 0,
    hero: {
      heroid: id, name: g.name || `武${g.cfgId}`, level: lv, hero_type: 'normal', hit_range: 1, country: '', quality: 5,
      attack_base: grow(g.force, 'force_grow'), defence_base: grow(g.defense, 'defense_grow'),
      intel_base: grow(g.intel, 'intel_grow'), speed_base: grow(g.speed, 'speed_grow'),
      destroy_base: grow(g.destroy, 'destroy_grow'),
      attack_grow: 3, defence_grow: 3, intel_grow: 3, speed_grow: 3, destroy_grow: 3,
      skills: [kernelSkillAt(10001, 10)],
    },
    troops: 2000, max_troops: 2000, speed: 100, attack_range: 5,
  };
}

function duel(strongId, weakId, seed) {
  const sg = cfg.generalByCfg.get(strongId);
  const wg = cfg.generalByCfg.get(weakId);
  if (!sg || !wg) return null;
  const r = runBattle({
    units: [mkUnit('a0', 1, sg), mkUnit('d0', 2, wg)],
    seed, config: DEFAULT_BATTLE_CONFIG,
  });
  const ft = r.final_troops || {};
  const a = Number(ft.a0) || 0;
  const b = Number(ft.d0) || 0;
  return { winner: r.winner, remain: [a, b] };
}

test('对战平衡：顶级武将对末流胜率 > 50% 且非全胜（强度有区分度但不绝对）', () => {
  const all = [...cfg.generalByCfg.values()].filter((g) => Number(g.cfgId) >= 100001 && Number(g.cfgId) < 200000);
  const byForce = all.slice().sort((a, b) => (b.force + (b.force_grow || 0) * 9) - (a.force + (a.force_grow || 0) * 9));
  const strong = byForce[0];
  const weak = byForce[byForce.length - 1];
  assert.ok(strong && weak && strong.cfgId !== weak.cfgId, '应有强弱样本');
  let strongWins = 0;
  const N = 20;
  for (let i = 0; i < N; i += 1) {
    const d = duel(Number(strong.cfgId), Number(weak.cfgId), 20260001 + i);
    if (!d) continue;
    const won = d.winner === 1 || (d.winner == null && d.remain[0] > d.remain[1]);
    if (won) strongWins += 1;
  }
  assert.ok(strongWins > N / 2,
    `顶级武将(${strong.name})对末流(${weak.name})胜场仅 ${strongWins}/${N}，强度无区分度`);
  assert.ok(strongWins < N,
    `顶级武将(${strong.name})对末流(${weak.name})竟 ${strongWins}/${N} 全胜，战斗失去随机性`);
});

test('长局稳定性：120 旬名册演化后规模有界、数值合法、无 NaN', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureTavern(state, cfg);
  ensureStrategy(state, cfg);
  const st = state.strategy;
  const factions = FACTIONS;
  for (let turn = 1; turn <= 120; turn += 1) {
    for (const f of factions) {
      if (st.resources[f.id]) st.resources[f.id].gold = 50000; // 排除资源枯竭对演化断言的干扰
      aiRosterLearnTick(state, rosterConf, cfg, f, turn);
      aiRecruitTick(state, rosterConf, cfg, f, turn);
      aiPoachTick(state, rosterConf, cfg, f, turn);
      aiCaptiveTick(state, rosterConf, cfg, f, turn);
      aiAidRequest(state, rosterConf, f, turn, st);
    }
  }
  for (const f of factions) {
    const r = st.rosters[f.id];
    assert.ok(r.generals.length >= 1 && r.generals.length <= 8, `${f.id} 名册规模越界 ${r.generals.length}`);
    for (const g of r.generals) {
      assert.ok(Number.isFinite(g.level) && g.level >= 1 && g.level <= 10, `${g.cfgId} 等级非法`);
      assert.ok(Number.isFinite(g.loyal) && g.loyal >= 0 && g.loyal <= 100, `${g.cfgId} 忠诚非法`);
      assert.ok(Array.isArray(g.skills) && g.skills.length <= 3, `${g.cfgId} 战法槽越界`);
      for (const s of g.skills) assert.ok(Number.isFinite(s.id) && Number.isFinite(s.lv), `${g.cfgId} 战法数值 NaN`);
    }
    for (const c of r.captives) assert.ok(Number.isFinite(c.days) && c.days >= 0, '俘虏天数非法');
  }
});

test('长局确定性：同种子 120 旬双跑名册逐字节一致', () => {
  const run = () => {
    const state = normalizeWorld(createWorld(cfg), cfg);
    ensureTavern(state, cfg); ensureStrategy(state, cfg);
    const st = state.strategy;
    for (let turn = 1; turn <= 120; turn += 1) {
      for (const f of FACTIONS) {
        if (st.resources[f.id]) st.resources[f.id].gold = 50000;
        aiRosterLearnTick(state, rosterConf, cfg, f, turn);
        aiRecruitTick(state, rosterConf, cfg, f, turn);
        aiPoachTick(state, rosterConf, cfg, f, turn);
        aiCaptiveTick(state, rosterConf, cfg, f, turn);
      }
    }
    return JSON.stringify(st.rosters);
  };
  assert.equal(run(), run(), '同种子双跑名册演化必须一致');
});
