/**
 * 2026-11-16 用户实机反馈回归：
 *  1. 主公 2 技能（学习槽）点击必给提示（注入 UI 空槽补可点按钮）；
 *  2. 招募拒绝台词拟人、按性格与谋略选词，界面不显示概率/到店提示；
 *  3. 政治第六维所有武将初始化即带；官阶按功勋晋升、反哺统帅/政治；
 *  4. 主公六维上调、防御标签改「统帅」、指挥技能 100% 发动 + 回击 35% 起。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { applyGeneralExp, grantBattleExp, takeBattlePromos } from '../server/domain/general-progress.js';
import { refusalLine, personaOf, failLine } from '../server/domain/recruit-refusal.js';
import {
  rankOfMerit, meritForRank, grantMerit, careerTagOf, RANK_NAMES,
  slotCapForRank, slotCapOf,
} from '../server/domain/official-rank.js';
import { effectiveStatOf, politicsOf } from '../server/domain/general-stat.js';
import { STAT_LABEL } from '../server/domain/panels.js';
import { talentRecruitRate } from '../server/domain/relation.js';
import { ensureTavern, todaysGuests } from '../server/domain/tavern.js';
import { rngFor } from '../server/domain/strategy-rng.js';
import { aiRosterCultivateTick, ensureRosters } from '../server/domain/ai-roster.js';
import {
  factionConf, ensureStrategy, strategyFormup, dispatchGeneral,
  oathOptions, chooseOath, strategyAttack, strategyViewState, dispatchTick } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
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
  /* ★ 2026-11-17：编辑器重写为「初始数据编辑器」页签化后，属性标签统一取自
     服务端 EDIT_RANGES（唯一口径，defense='统帅'、politics='政治'），
     前端不再内联一份会漂移的标签表。 */
  const ui = readFileSync(resolve(ROOT, 'server', 'editor-ui.js'), 'utf8');
  assert.ok(ui.includes('ranges[k].label'), '编辑器属性标签应取自 EDIT_RANGES 下发');
  assert.ok(ui.includes("'force', 'strategy', 'defense', 'speed', 'destroy', 'politics'"),
    '编辑器六维应含政治');
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

test('拒绝理由和谐度：全人设台词不含威胁/贬低/生硬词（2026-11-18 用户反馈「非常不和谐」）', () => {
  // 遍历五类人设 × 首访/高谋略/三顾，所有拒绝句都不得出现挑衅、轻慢、命令式措辞
  const banned = /休要再提|费口舌|一见高下|拿刀说话|别费话|少绕弯子|自家收着|若再相逼|呸！|不识抬举/;
  const personas = [
    { five: { wu: 95, zhi: 30 }, type: '莽夫' },
    { five: { wu: 88, zhi: 60 }, type: '名将' },
    { five: { zheng: 95, zhi: 90 }, type: '名士' },
    { five: { zhi: 96, zheng: 88 }, type: '谋士' },
    { five: { wu: 80, zhi: 60 }, type: '军阀' },
  ];
  for (const row of personas) {
    for (const favor of [0, 2]) {
      for (const zhi of [30, 95]) {
        const cfgRow = { ...row, five: { ...row.five, zhi } };
        const text = refusalLine(cfgRow, { cfgId: 100001, favor }).text;
        assert.ok(!banned.test(text), `${row.type}(谋略${zhi},访${favor}) 出现不和谐词：${text}`);
      }
    }
  }
  // poor 场面话也不得再是账房口吻
  assert.ok(!/体面|账目/.test(failLine('poor', { cost: 30, short: 12 })), '金不足文案去掉账房口吻');
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

/* ── 追加：招募失败提示拟人化（2026-11-17）───────────────────────────── */
test('招募失败五类场面话：具名、汉末口吻、不含英文 token', () => {
  assert.match(failLine('left', { name: '赵云' }), /赵云/);
  assert.match(failLine('not_yet', { name: '张飞', when: '午时' }), /午时/);
  assert.match(failLine('absent', { name: '关羽' }), /关羽/);
  assert.match(failLine('empty', {}), /在座|改日|酒肆/);
  assert.match(failLine('poor', { cost: 30, short: 12 }), /30|差 12/);
  for (const k of ['left', 'not_yet', 'absent', 'empty', 'poor']) {
    const s = failLine(k, { name: '甲', when: '午后', cost: 30, short: 5 });
    assert.ok(s && !/[a-z_]{3,}/i.test(s), `${k} 台词不应含英文工程 token`);
  }
  assert.equal(failLine('unknown', {}), '');
});

test('酒馆招募 not_today 回执带 name 与拟人 line，不再出现 undefined', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = noopCtx(state);
  ensureTavern(state, cfg);
  const cityId = state.strategy.playerCity;
  const r = handleRequest(ctx, { seq: 1, name: 'general.drawGeneral', msg: { drawTimes: 1, cityId, cfgId: 999999 } });
  assert.equal(r.msg.reason, 'not_today');
  assert.ok(typeof r.msg.name === 'string', '必须回 name，避免界面拼出 undefined');
  assert.ok(typeof r.msg.line === 'string' && r.msg.line.length > 6, '必须回拟人台词');
  assert.ok(!r.msg.line.includes('undefined'));
});

/* ── 追加：武将调防与招募落城（2026-11-17）─────────────────────────── */
function oathState() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  chooseOath(state, cfg, noopCtx(state), { lord: lords[0].id, city: lords[0].cities[0].id });
  return state;
}

test('武将调防：改所在城、离队，同城/敌城/无将各有中文原因', () => {
  const state = oathState();
  const st = state.strategy;
  const mine = Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player').map(Number);
  const g = state.generals[0];
  const from = Number(g.cityId);
  const army = state.armys.find((a) => Number(a.cityId) === from) || state.armys[0];
  army.cityId = from;
  delete army.marchId;
  army.generals = [g.id, 0, 0];
  const to = mine.find((id) => id !== from);
  assert.ok(to, '举义后应有第二座己方城');
  const ctx = noopCtx(state);
  const r = dispatchGeneral(state, cfg, ctx, { generalId: g.id, toCityId: to });
  assert.equal(r.ok, true, JSON.stringify(r));
  /* ★ P74：调防改成行程——下达当天是「启程」，抵达日才落城、摘队。 */
  assert.equal(r.transit, true, '调防应先启程');
  assert.equal(g.cityId, from, '下达当天人还没走');
  assert.ok(g.transit && g.transit.to === to, '途中记为在途');
  state.clock.day = (Number(state.clock.day) || 1) + Math.max(1, Number(r.marchDays) || 1) + 1;
  dispatchTick(state, cfg, ctx);
  assert.equal(g.cityId, to, '抵达日武将所在城应变更');
  assert.equal(g.order, 0, '调离后队伍序号应清零');
  assert.ok(!(army.generals || []).includes(g.id), '应从原队伍摘除');
  assert.equal(dispatchGeneral(state, cfg, ctx, { generalId: g.id, toCityId: to }).reason, 'same_city');
  const enemy = Object.keys(st.cities).map(Number).find((id) => st.cities[id].owner !== 'player');
  assert.equal(dispatchGeneral(state, cfg, ctx, { generalId: g.id, toCityId: enemy }).reason, 'not_own_city');
  assert.equal(dispatchGeneral(state, cfg, ctx, { generalId: 999999, toCityId: to }).reason, 'no_general');
});

test('酒馆招募落城等于招募所在城，不再写死主城', () => {
  const state = oathState();
  ensureTavern(state, cfg);
  const st = state.strategy;
  const mine = Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player').map(Number);
  /* 选一座非都城、非 1 的己方城，才能区分新旧实现（旧实现恒落 1）。 */
  const target = mine.find((id) => id !== st.playerCity && id !== 1) || mine.find((id) => id !== st.playerCity);
  assert.ok(target);
  state.clock.scale = 1;
  state.clock.accMs = Math.floor(60000 * 0.05);
  const guest = todaysGuests(state, undefined, target).find((x) => 0.05 >= x.from && 0.05 < x.to);
  assert.ok(guest, '目标城应有人在店');
  const rate = talentRecruitRate(state, cfg, { cfgId: guest.cfgId }).rate / 100;
  const day = Math.max(1, Math.floor(Number(state.clock?.day) || 1));
  let hit = 0;
  for (let s = 1; s < 40000 && !hit; s += 1) {
    const seed = s * 7919;
    if (rngFor(seed, day, `draw:${target}:${guest.cfgId}:0`).random() < rate) hit = seed;
  }
  assert.ok(hit, '应能找到必中种子');
  state.seed = hit;
  const r = handleRequest(noopCtx(state), { seq: 1, name: 'general.drawGeneral', msg: { drawTimes: 1, cityId: target, cfgId: guest.cfgId } });
  assert.equal(r.msg.generals.length, 1, JSON.stringify(r.msg));
  const g = state.generals.find((x) => x.cfgId === guest.cfgId);
  assert.equal(g.cityId, target, '落城应为招募所在城，不是主城');
});

/* ── 追加：带兵上限随官阶提升（每槽 5000 + 官阶×300）─────────────────── */
test('带兵上限纯函数：白身 5000、每阶 +300、三公 7700，越界钳制且确定性', () => {
  assert.equal(slotCapForRank(0), 5000);
  assert.equal(slotCapForRank(1), 5300);
  assert.equal(slotCapForRank(5), 6500);
  assert.equal(slotCapForRank(9), 7700);
  assert.equal(slotCapForRank(99), 7700, '官阶封顶 9');
  assert.equal(slotCapForRank(-5), 5000, '负官阶回退白身');
  assert.equal(slotCapOf({}), 5000, '无功勋对象回退基础上限');
  assert.equal(slotCapOf({ merit: meritForRank(7) }), 7100, '按累计功勋换算');
  assert.equal(slotCapOf({ merit: 99999 }), 7700);
});

test('编队按每槽武将官阶校验带兵上限：高官阶可填 6100，降为白身即拒并回传真实 cap', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state, cfg);
  const army = state.armys[0];
  const homeId = state.strategy.playerCity;
  army.cityId = homeId;
  army.soldiers = [6200, 0, 0];
  /* ★ P54：本例只验证官阶带兵上限，先把 fixture 驻城对齐到队伍所在城。 */
  state.generals[0].cityId = homeId;
  army.generals = [state.generals[0].id, 0, 0];
  delete army.marchId;
  const vet = state.generals[0];
  vet.merit = meritForRank(4); // 4 阶 → 5000+1200=6200
  const ok = strategyFormup(state, cfg, noopCtx(state), {
    armyId: army.id, generals: army.generals, soldiers: [6100, 0, 0],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  vet.merit = 0; // 同将降回白身，同样 6100 应超限
  const bad = strategyFormup(state, cfg, noopCtx(state), {
    armyId: army.id, generals: army.generals, soldiers: [6100, 0, 0],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'over_cap');
  assert.equal(bad.cap, 5000, '回传该槽真实上限（白身 5000）');
  assert.equal(bad.caps[0], 5000);
});

test('编队 UI 逐槽展示上限与官阶，over_cap 提示带动态数字', () => {
  const ui = readFileSync(resolve(ROOT, 'server', 'panels-ui.js'), 'utf8');
  assert.ok(ui.includes('slotCapOfGen'), '编队弹窗按槽取上限');
  assert.ok(ui.includes('上限 \' + fmt(cap)'), '逐槽显示该武将带兵上限');
  assert.ok(ui.includes('官阶越高上限越高'), '超限提示解释官阶关系');
  const panel = readFileSync(resolve(ROOT, 'server', 'domain', 'panels.js'), 'utf8');
  assert.ok(panel.includes('slotCap: slotCapOf(g)'), 'allGenerals 带出每槽上限');
});

test('真链路出征：白身 7600 兵退回 2600（按 5000），三公退回 0（7700 上限内）', () => {
  const returnedToCity = (merit) => {
    const state = normalizeWorld(createWorld(cfg), cfg);
    ensureStrategy(state);
    ensureCityEcon(state);
    const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
    const oath = chooseOath(state, cfg, noopCtx(state), { lord: lords[0].id, city: lords[0].cities[0].id });
    assert.equal(oath.ok, true);
    const cid = state.strategy.playerCity;
    const army = state.armys[0];
    army.cityId = cid;
    delete army.marchId;
    const g = state.generals[0];
    g.merit = merit;
    army.generals = [g.id, 0, 0];
    army.soldiers = [7600, 0, 0];
    state.roleRes.grain = 200000;
    const row = strategyViewState(state, cfg).cities.find((c) => Number(c.id) === cid);
    const target = (row?.marchRoutes || []).map((r) => Number(r.id))
      .find((id) => state.strategy.cities[id] && state.strategy.cities[id].owner !== 'player');
    assert.ok(target, '应有相邻敌城');
    const before = state.strategy.cities[cid].troops;
    const atk = strategyAttack(state, cfg, noopCtx(state), {
      cityId: target, armyId: army.id, fromCityId: cid, frac: 1,
    });
    assert.equal(atk.ok, true, JSON.stringify(atk));
    return state.strategy.cities[cid].troops - before;
  };
  assert.equal(returnedToCity(0), 2600, '白身按 5000 截断，多 2600 退回驻城');
  assert.equal(returnedToCity(meritForRank(9)), 0, '三公 7700 上限内，7600 不截断');
});
