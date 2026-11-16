/**
 * 平衡与长局稳定性补强（用户 2026-11-16「平衡性/稳定性都测了吗」）。
 *
 * 审计事实：此前平衡只做数值合法性（0~100/引用有效），无对战胜率实证；
 * 稳定性最长 73 旬脚本模拟、单测仅 8 旬，无长局名册演化。本用例补：
 *  1. 对战强度分布：真实内核批量对战，验证「强弱有序、非一面倒、非随机」；
 *  2. 长局名册演化：100+ 旬模拟，名册规模/等级/忠诚有界、无 NaN、确定性。
 *
 * ★ 2026-11-17 修正：本用例原先自己用 `min(100, force + force_grow×9)` 算属性，
 * 而原表的 `*_grow` 是 0~100 的成长率（吕布 force 100/grow 100、山贼 10/10），
 * 两式都撞上 100 上限 → 顶级武将与末流被算成**同一份属性**，对战胜率退化为抛硬币，
 * 只是恰好在旧的战法概率下过了闸。现改为直接复用 server/battle.js 的 makeHero，
 * 与真实战斗同一条派生链（高属性者成长慢、低属性者才练得动）。
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
import { makeHero } from '../server/battle.js';
import { runBattle, DEFAULT_BATTLE_CONFIG } from '../kernel/index.js';

const cfg = loadConfig();
const FACTIONS = factionConf().factions;
const rosterConf = { personas: PERSONA_AXES, factions: FACTIONS };

function mkUnit(id, side, g) {
  /* 属性派生走生产的 makeHero；战法固定 10001，避免双方战法不同掩盖属性差。 */
  const hero = makeHero({ ...g, cfgId: Number(g.cfgId), level: 10 }, cfg);
  hero.skills = [kernelSkillAt(10001, 10)];
  return {
    unit_id: id, side, pos: 0, hero,
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

test('对战平衡：差距悬殊时强者碾压，同档对手互有胜负（有区分度但不绝对）', () => {
  /* 只取「真实武将」，剔掉 force/grow 都只有 10 的杂兵/山贼档——那些是战场填充单位，
     跟顶级武将打本来就该 20:0，用它当「末流」样本测不出任何东西。 */
  const all = [...cfg.generalByCfg.values()]
    .filter((g) => Number(g.cfgId) >= 100001 && Number(g.cfgId) < 200000)
    .filter((g) => Number(g.force) > 20 && Number(g.force_grow) > 20);
  const score = (g) => Number(g.force) + Number(g.defense) * 0.4 + Number(g.strategy) * 0.4;
  const ranked = all.slice().sort((a, b) => score(b) - score(a));
  assert.ok(ranked.length >= 100, `真实武将样本过少（实测 ${ranked.length}）`);
  const top = ranked[0];
  const peer = ranked[1];
  const bottom = ranked[ranked.length - 1];
  assert.ok(top && peer && bottom && new Set([top.cfgId, peer.cfgId, bottom.cfgId]).size === 3, '应有三个不同样本');

  const N = 20;
  const wins = (a, b) => {
    let w = 0;
    for (let i = 0; i < N; i += 1) {
      const d = duel(Number(a.cfgId), Number(b.cfgId), 20260001 + i);
      if (!d) continue;
      const won = d.winner === 1 || (d.winner == null && d.remain[0] > d.remain[1]);
      if (won) w += 1;
    }
    return w;
  };

  const vsBottom = wins(top, bottom);
  assert.ok(vsBottom >= 18,
    `顶级武将(${top.name})对末位真实武将(${bottom.name})仅 ${vsBottom}/${N}，强度无区分度`);

  /* 同档对手：既不能必胜（战斗失去随机性），也不能全败（强弱读数反了）。 */
  const vsPeer = wins(top, peer);
  assert.ok(vsPeer > 2 && vsPeer < 18,
    `顶级武将(${top.name})对同档(${peer.name}) ${vsPeer}/${N}，战斗随机性/强弱读数异常`);
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
