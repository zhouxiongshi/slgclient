/**
 * P63（2026-11-26）两条用户反馈的回归锁：
 *   1. 「电脑 AI 不够智能，不会主动选择弱势敌人征服」——
 *      workable 对明显弱势目标（守军 ≤ 可派兵 7 成）降到 1.0 胜算门槛，
 *      peerOption 按「守军薄 + 胜算大」打分，不再只挑 ratio 最高的硬目标。
 *   2. 「这个界面设计太啰嗦了，风险和失败态在游戏中没有任何用处」——
 *      战法研习改游戏化对话框（战法/效果/进度/委派武将），
 *      不再套通用「决策前预览」的会发生什么 / 风险失败态 / 数值依据；
 *      新增委派武将逐旬自动研习（三国志式委任研究）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, strategySnapshot, localBrain, factionConf } from '../server/domain/strategy.js';
import { panelState, panelAction } from '../server/domain/panels.js';
import {
  assignResearch, unassignResearch, researchTick, researchView, researchPace,
} from '../server/domain/research.js';

const cfg = loadConfig();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fresh = () => normalizeWorld(createWorld(cfg), cfg);

/* ---------------- AI 弱敌优先 ---------------- */

test('P63-① AI 弱敌门槛：谋略/政治速度合理，委派研习有确定节奏', () => {
  const wise = researchPace({ strategy: 96, politics: 93 });
  const dull = researchPace({ strategy: 30, politics: 20 });
  assert.ok(wise.points > dull.points, '谋略越高每旬推进越多');
  assert.ok(wise.scrolls < dull.scrolls, '政治越高每旬耗卷越少');
  assert.ok(wise.scrolls >= 2 && dull.scrolls <= 5, '耗卷有上下限，不会白嫖也不会卡死');
});

test('P63-② 决策脑源码锁死：弱敌降门槛 + 按守军薄打分', () => {
  const src = read('server/domain/strategy-brain.js');
  assert.match(src, /weakFoe/, '必须有弱敌判据');
  assert.match(src, /city\.troops <= send \* 0\.7/, '弱敌判据是守军 ≤ 可派兵 7 成');
  assert.match(src, /Math\.min\(need, 1\.0\)/, '弱敌门槛不高于 1.0（不送死也不碾压）');
  assert.match(src, /function preyScore/, '诸侯目标按弱敌评分排序');
  assert.match(src, /20000 \/ troops/, '守军越薄分越高');
});

test('P63-③ 开局仍有 ≥6 家主动扩张，弱敌改动不破坏既有主动性', () => {
  const state = fresh();
  ensureStrategy(state);
  const plans = factionConf().factions.map((f) => localBrain(f, strategySnapshot(state, f.id), state));
  const expanding = plans.filter((p) => p.goal.type !== '固守' && p.goal.target);
  assert.ok(expanding.length >= 6, `至少 6 家主动出目标，实际 ${expanding.length}`);
});

/* ---------------- 委派自动研习 ---------------- */

test('P63-④ 委派 → 逐旬推进 → 解锁 → 撤回，进度与残卷逐位确定', () => {
  const a = fresh();
  const b = fresh();
  const hero = a.generals.find((g) => g.isProtagonist) || a.generals[0];
  const heroB = b.generals.find((g) => g.isProtagonist) || b.generals[0];
  assert.equal(assignResearch(a, cfg, { cfgId: 10002, generalId: hero.id }).ok, true);
  assert.equal(assignResearch(b, cfg, { cfgId: 10002, generalId: heroB.id }).ok, true);
  let unlockedAt = -1;
  for (let i = 0; i < 14; i += 1) {
    const ea = researchTick(a, cfg, {});
    researchTick(b, cfg, {});
    if (ea.some((x) => x.unlocked)) { unlockedAt = i; break; }
  }
  assert.ok(unlockedAt >= 0, '委派的战法应在若干旬后解锁');
  assert.ok(a.skillbook.unlocked['10002'], '解锁登记到 skillbook');
  assert.equal(a.skillbook.assign['10002'], undefined, '解锁后自动撤销委派');
  /* 两次运行逐位一致 */
  assert.equal(JSON.stringify(a.skillbook), JSON.stringify(b.skillbook));
});

test('P63-⑤ 一人一职、残卷硬闸、撤回保留进度', () => {
  const s = fresh();
  const g1 = s.generals[0];
  assignResearch(s, cfg, { cfgId: 10002, generalId: g1.id });
  /* 同一武将改派别的战法：旧的自动摘掉 */
  assignResearch(s, cfg, { cfgId: 10005, generalId: g1.id });
  const view = researchView(s, cfg);
  assert.equal(view.length, 1, '一名武将只研一条');
  assert.equal(view[0].cfgId, 10005);
  /* 撤回保留进度 */
  researchTick(s, cfg, {});
  const before = s.skillbook.research['10005'].progress;
  assert.equal(unassignResearch(s, { cfgId: 10005 }).ok, true);
  assert.equal(s.skillbook.research['10005'].progress, before, '撤回不改进度');
  assert.equal(researchTick(s, cfg, {}).length, 0, '撤回后不再推进');
  /* 残卷耗尽不推进，但委派保留 */
  const s2 = fresh();
  assignResearch(s2, cfg, { cfgId: 10002, generalId: g1.id });
  s2.items = s2.items.filter((i) => i.kind !== 'scroll');
  researchTick(s2, cfg, {});
  assert.ok(s2.skillbook.assign['10002'], '卷尽时委派保留，等补卷自动续上');
});

test('P63-⑥ 面板协议：下发委派视图与候选武将，动作可委派/撤回', () => {
  const s = fresh();
  const st = panelState(s, cfg);
  assert.ok(Array.isArray(st.researchAssignments), '面板下发已委派视图');
  assert.ok(Array.isArray(st.researchCandidates), '面板下发可委派武将');
  assert.ok(st.researchCandidates.length >= 1, '至少一名武将可委派');
  assert.ok(st.researchCandidates[0].points > 0 && st.researchCandidates[0].scrolls >= 2);
  const hero = s.generals.find((g) => g.isProtagonist) || s.generals[0];
  const r = panelAction(s, cfg, { type: 'assignResearch', cfgId: 10002, generalId: hero.id });
  assert.equal(r.ok, true);
  assert.equal(panelState(s, cfg).researchAssignments.length, 1);
  assert.equal(panelAction(s, cfg, { type: 'unassignResearch', cfgId: 10002 }).ok, true);
});

/* ---------------- 对话框去啰嗦 ---------------- */

test('P63-⑦ 研习对话框游戏化：无「风险与失败态 / 会发生什么」，有委派武将', () => {
  const ui = read('server/panels-ui.js');
  const box = ui.slice(ui.indexOf('function researchBox'), ui.indexOf('function askText'));
  assert.match(box, /战法研习/);
  assert.match(box, /委派武将/);
  assert.match(box, /研习进度/);
  assert.match(box, /data-ract="assign"/);
  assert.doesNotMatch(box, /风险与失败态/);
  assert.doesNotMatch(box, /会发生什么/);
  assert.doesNotMatch(box, /数值依据/);
  /* 研习入口打开对话框，而不是直接投卷 */
  assert.match(ui, /data-act="openResearch"/);
});

test('P63-⑧ 通用决策预览不再拦截研习按钮', () => {
  const ix = read('server/interaction-ui.js');
  assert.match(ix, /el0\.dataset\.act === 'openResearch'/);
  assert.match(ix, /el0\.dataset\.act === 'research'/);
});

test('P63-⑨ 每旬结算接入委派研习推进', () => {
  const src = read('server/domain/strategy.js');
  assert.match(src, /researchTick\(state, cfg, ctx\)/, 'strategyTick 每旬推进委派研习');
});

/* ---------------- 出征交互回归（P63 收敛：保留手动推演与页签） ---------------- */

test('P63-⑩ 自动走日不顶掉手动推演：空格/推演按钮与出征页签仍在', () => {
  const skills = read('server/skills.js');
  const ix = read('server/interaction-ui.js');
  assert.doesNotMatch(skills, /id="slgStratTick" class="pri" style="display:none"/, '推演按钮不能被藏');
  assert.match(skills, /\['queue', '② 行军队列'/, '行军队列页签不能被删');
  assert.match(skills, /\['encounter', '③ 遭遇'/, '遭遇页签不能被删');
  assert.match(ix, /function nextTurn\(\)[\s\S]{0,220}window\.__slgTick/, '空格仍要推进一旬');
  /* 出征成功后停在行军队列页，不关窗（自动走日与行军动画不受影响） */
  assert.match(skills, /war\.tab = 'queue';[\s\S]{0,120}__slgWarWindow/);
});

test('P63-⑪ 显式推演无视界面暂停，抵达待决不冻结全局时钟', () => {
  const idx = read('server/index.js');
  const hd = read('server/handlers.js');
  assert.match(idx, /strategy\/tick[\s\S]{0,600}uiHoldUntil = 0/, 'tick 端点要清界面暂停');
  assert.doesNotMatch(hd, /decisionHold = waitingOrder/, '待决战斗不得冻结全局时钟');
});
