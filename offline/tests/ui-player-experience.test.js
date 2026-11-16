/**
 * 2026-11-16 用户实机反馈回归：
 *  1. 主公 2 技能（学习槽）点击必给提示（注入 UI 空槽补可点按钮）；
 *  2. 招募拒绝台词拟人、按性格与谋略选词，界面不显示概率/到店提示；
 *  3. 政治第六维所有武将初始化即带；官阶按功勋晋升、反哺统帅/政治；
 *  4. 主公六维上调、防御标签改「统帅」、指挥技能 100% 发动 + 回击 35% 起。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { applyGeneralExp, grantBattleExp, takeBattlePromos } from '../server/domain/general-progress.js';
import { refusalLine, personaOf } from '../server/domain/recruit-refusal.js';
import {
  rankOfMerit, meritForRank, grantMerit, careerTagOf, RANK_NAMES,
} from '../server/domain/official-rank.js';
import { effectiveStatOf, politicsOf } from '../server/domain/general-stat.js';
import { STAT_LABEL } from '../server/domain/panels.js';
import { talentRecruitRate } from '../server/domain/relation.js';
import { ensureTavern, todaysGuests } from '../server/domain/tavern.js';
import { rngFor } from '../server/domain/strategy-rng.js';
import { aiRosterCultivateTick, ensureRosters } from '../server/domain/ai-roster.js';
import { factionConf, ensureStrategy } from '../server/domain/strategy.js';
import { PERSONA_AXES } from '../server/domain/strategy-brain.js';

const ROOT = resolve(import.meta.dirname, '..');
const cfg = loadConfig();
const noopCtx = (state) => ({ state, cfg, options: {}, push() {}, save() {}, log() {}, schedule() {} });

/* ── 任务4：政治属性 ─────────────────────────────────────────────────── */
test('政治第六维：全表武将初始化都有 0~100 的 politics，主公 93', () => {
  let n = 0;
  for (const g of cfg.generalByCfg.values()) {
    assert.ok(Number.isFinite(Number(g.politics)), `${g.name} 缺政治`);
    assert.ok(Number(g.politics) >= 1 && Number(g.politics) <= 100, `${g.name} 政治越界 ${g.politics}`);
    n += 1;
  }
  assert.ok(n > 400);
  const prot = cfg.generalByCfg.get(880001);
  assert.equal(prot.politics, 93);
  assert.equal(politicsOf(93), 93);
  assert.equal(politicsOf(999), 100);
  assert.equal(politicsOf(NaN), 50);

  const state = normalizeWorld(createWorld(cfg), cfg);
  const hero = state.generals[0];
  assert.equal(hero.politics_added, 0, '每个在册武将带 politics_added');
  assert.ok(state.generals.every((g) => Number.isFinite(Number(g.merit))), '每个武将带功勋');
});

test('玩家可见的 defense 标签已改为「统帅」，并新增「政治」', () => {
  assert.equal(STAT_LABEL.defense, '统帅');
  assert.equal(STAT_LABEL.politics, '政治');
  const ui = readFileSync(resolve(ROOT, 'server', 'editor-ui.js'), 'utf8');
  assert.ok(ui.includes("defense: '统帅'"), '编辑器标签同步改名');
});

/* ── 任务5：主公属性与技能 ──────────────────────────────────────────── */
test('主公初始六维达到指定值', () => {
  const prot = cfg.generalByCfg.get(880001);
  assert.deepEqual(
    [prot.force, prot.strategy, prot.defense, prot.speed, prot.politics],
    [99, 96, 91, 87, 93],
  );
});

/* ── 任务3：功勋官阶闭环 ────────────────────────────────────────────── */
test('功勋→官阶单调、封顶 9，名字可读', () => {
  assert.equal(rankOfMerit(0), 0);
  assert.equal(rankOfMerit(meritForRank(1) - 1), 0);
  assert.equal(rankOfMerit(meritForRank(1)), 1);
  assert.equal(rankOfMerit(1e9), 9);
  assert.equal(RANK_NAMES.length, 10);
  let prev = -1;
  for (let m = 0; m <= 4000; m += 100) {
    const r = rankOfMerit(m);
    assert.ok(r >= prev, '官阶随功勋单调不降');
    prev = r;
  }
});

test('grantMerit 只增不减、晋升标记正确；能力加成封顶 100', () => {
  const g = { merit: 0, rank: 0 };
  const r1 = grantMerit(g, meritForRank(3));
  assert.equal(r1.rank, 3);
  assert.equal(r1.promoted, true);
  assert.equal(g.merit, meritForRank(3));
  const r2 = grantMerit(g, 5);
  assert.equal(r2.promoted, false);
  assert.ok(g.merit > r1.merit);
  // 统帅随官阶提升；政治对文职加成更高；都不破 100
  assert.ok(effectiveStatOf(90, 9, 'defense') > effectiveStatOf(90, 0, 'defense'));
  assert.equal(effectiveStatOf(99, 9, 'defense'), 100);
  assert.ok(effectiveStatOf(70, 6, 'politics', 'civil') > effectiveStatOf(70, 6, 'politics', 'warrior'));
  assert.equal(careerTagOf({ strategy: 95, politics: 90 }), 'strategist');
  assert.equal(careerTagOf({ force: 95, strategy: 30 }), 'warrior');
});

test('战斗立功累积功勋并可能晋官，战报有晋升文案', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const g = state.generals[0];
  takeBattlePromos();
  // 一次性给足升到三阶的功勋：折损经验 + win 一笔（每场约 12+12=24 功勋）
  for (let i = 0; i < 20; i += 1) grantBattleExp(state, cfg, { [g.id]: 100 }, { win: true });
  assert.ok((g.merit || 0) > meritForRank(2), '功勋应显著累积');
  assert.ok((g.rank || 0) >= 3, '应晋升到三阶以上');
});

/* ── 任务3：AI 自己发展（功勋封官 + 追赶） ─────────────────────────── */
test('AI 名册每旬按功勋晋升官阶与等级，不再停滞', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  const conf = { ...factionConf(), personas: PERSONA_AXES };
  ensureRosters(state, conf, cfg);
  const fid = conf.factions[0].id;
  const officer = state.strategy.rosters[fid].generals[0];
  assert.ok(officer, '势力应有开局名册');
  assert.equal(officer.merit, 0);
  assert.equal(officer.rank, 0);
  for (let turn = 1; turn <= 60; turn += 1) aiRosterCultivateTick(state, conf, cfg, conf.factions[0], turn);
  assert.ok(officer.merit > meritForRank(2), 'AI 武将功勋应随治政累积');
  assert.ok(officer.rank >= 2, 'AI 武将应凭功勋晋官');
  assert.ok(officer.level >= 3, 'AI 武将应靠历练升级');
  assert.ok(Number.isFinite(officer.defense_added) || officer.rank > 0, '名册有界、无 NaN');
});

/* ── 任务2：拟人拒绝台词 ────────────────────────────────────────────── */
test('拒绝台词按性格分五种口吻，均为汉末场景人话、不含概率数字', () => {
  const cases = [
    [{ five: { wu: 96, zhi: 30 }, type: '猛将' }, 'mangfu'],
    [{ five: { wu: 90, zhi: 75, tong: 92 }, type: '名将' }, 'mingjiang'],
    [{ five: { zheng: 95, zhi: 90 }, type: '名士' }, 'mingshi'],
    [{ five: { zhi: 96, zheng: 88 }, type: '谋士' }, 'mouchen'],
    [{ five: { wu: 80, zhi: 60 }, type: '军阀' }, 'zhuhou'],
  ];
  for (const [row, persona] of cases) {
    const line = refusalLine(row, { cfgId: 100001, favor: 0 });
    assert.equal(line.persona, persona, `${row.type} 应归 ${persona}`);
    assert.ok(line.text.length >= 12, '拒绝台词要像人话，不能太短');
    assert.ok(!/%|成功率|概率|%/.test(line.text), '拒绝台词不得出现概率数字');
  }
});

test('谋略越高拒绝越有情商：高谋略走圆融版本；三顾多次另有软话', () => {
  const low = refusalLine({ five: { wu: 95, zhi: 30 }, type: '将领' }, { cfgId: 100001, favor: 0 });
  const high = refusalLine({ five: { wu: 95, zhi: 92 }, type: '将领' }, { cfgId: 100001, favor: 0 });
  assert.notEqual(high.text, low.text, '高谋略应用不同（更圆融）台词');
  assert.ok(/将军|知遇|去就|看重/.test(high.text), '高情商版本措辞更周全');
  const revisit = refusalLine({ five: { wu: 95, zhi: 92 }, type: '将领' }, { cfgId: 100001, favor: 2 });
  assert.notEqual(revisit.text, high.text, '三顾多次应换软话');
});

test('招募拒绝响应带拟人 line，且界面不再暴露概率/到店提示', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureTavern(state, cfg);
  const ctx = noopCtx(state);
  state.clock.scale = 1;
  state.clock.accMs = Math.floor(60000 * 0.5);          // 午后窗口有在店客人
  const cityId = state.strategy?.playerCity || 1;
  const guest = todaysGuests(state, undefined, cityId).find((g) => 0.5 >= g.from && 0.5 < g.to);
  assert.ok(guest, '午后应有在店客人');
  const rate = talentRecruitRate(state, cfg, { cfgId: guest.cfgId }).rate / 100;
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  let miss = 0;
  for (let s = 1; s < 40000 && !miss; s += 1) {
    if (rngFor(s * 7919, day, `draw:${cityId}:${guest.cfgId}:0`).random() >= rate) miss = s * 7919;
  }
  state.seed = miss;
  const r = handleRequest(ctx, { seq: 1, name: 'general.drawGeneral', msg: { drawTimes: 1, cityId, cfgId: guest.cfgId } });
  assert.equal(r.msg.reason, 'refused', '必拒种子应产生拒绝');
  assert.ok(typeof r.msg.line === 'string' && r.msg.line.length >= 12, '拒绝回执带拟人台词');
  const ui = readFileSync(resolve(ROOT, 'server', 'skills.js'), 'utf8');
  assert.ok(!ui.includes('成功率 \' + m2.rate'), '界面不再显示成功率');
  assert.ok(!ui.includes('才到店'), '界面不再提示到店时辰');
});

/* ── 任务1：学习槽可点提示 ──────────────────────────────────────────── */
test('注入 UI：空学习槽带可点按钮并给提示；主公 Lv5 真实可学第二战法', () => {
  const ui = readFileSync(resolve(ROOT, 'server', 'skills.js'), 'utf8');
  assert.ok(ui.includes('为何不能学？'), '锁槽点击要给原因');
  assert.ok(ui.includes('去学习 / 装配战法'), '开槽点击要给引导');
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = noopCtx(state);
  const hero = state.generals.find((x) => x.isProtagonist);
  assert.equal(hero.level, 1);
  let r = handleRequest(ctx, { seq: 1, name: 'general.upSkill', msg: { gId: hero.id, cfgId: 10001, pos: 1 } });
  assert.equal(r.msg.reason, 'slot_locked', 'Lv1 学习槽未开');
  assert.match(r.msg.hint, /5 级/);
  applyGeneralExp(hero, 400);
  assert.equal(hero.level, 5);
  r = handleRequest(ctx, { seq: 1, name: 'general.upSkill', msg: { gId: hero.id, cfgId: 10001, pos: 1 } });
  assert.equal(r.msg.ok, true, 'Lv5 后主公可学第二战法');
  assert.equal(hero.skills[1].cfgId, 10001);
});
