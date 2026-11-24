/**
 * P58（2026-11-24）战法解锁条件可见：
 *  玩家反馈「战法看不到解锁条件」——旧界面每个槽只给一句「需武将 Lv5 解锁」，
 *  既不显示武将现在几级、还差几级，也不显示战法本身要先研习解锁。
 *  本文件锁死四件事：
 *   1. 门槛唯一口径 slotUnlock：need / have / 差额 / 文案都由它算；
 *   2. 六府面板下发结构化 unlock，锁着的槽也写清「现在 Lv几、还差几级」；
 *   3. 装配目标槽按「已开且空」选，不再死发学习槽把已学会的战法顶掉；战法可卸下重装；
 *   4. 原客户端「武将战法」页与本机协议同源（slotRules），文案里必须有解锁条件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { panelState, panelAction } from '../server/domain/panels.js';
import { slotUnlock } from '../server/domain/slots.js';

const cfg = loadConfig();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
const fresh = () => normalizeWorld(createWorld(cfg), cfg);
const heroOf = (s) => s.generals.find((g) => g.isProtagonist || Number(g.cfgId) === 880001);

test('P58-① 门槛唯一口径：学习槽 5 级、觉醒槽 10 级且自带 10 级，文案带当前值与差额', () => {
  const low = slotUnlock({ level: 3, skills: [{ cfgId: 19001, lv: 2 }] }, 1);
  assert.equal(low.open, false);
  assert.equal(low.rules[0].need, 5);
  assert.equal(low.rules[0].have, 3);
  assert.match(low.text, /当前 Lv3/);
  assert.match(low.text, /还差 2 级/);

  const awk = slotUnlock({ level: 7, skills: [{ cfgId: 19001, lv: 4 }] }, 2);
  assert.equal(awk.open, false);
  assert.equal(awk.rules.length, 2, '觉醒槽两条条件都要列出来');
  assert.match(awk.text, /武将 Lv10（当前 Lv7，还差 3 级）/);
  assert.match(awk.text, /自带战法 Lv10（当前 Lv4，还差 6 级）/);

  const ok = slotUnlock({ level: 10, skills: [{ cfgId: 19001, lv: 10 }] }, 2);
  assert.equal(ok.open, true);

  const innate = slotUnlock({ level: 12, skills: [null] }, 2);
  assert.equal(innate.open, false);
  assert.match(innate.text, /没有自带战法/);

  const zero = slotUnlock({ level: 12, skills: [{ cfgId: 19001, lv: 10 }] }, 0);
  assert.equal(zero.open, true);
  assert.equal(zero.replaceable, false, '自带槽只能升级，不能换');
});

test('P58-② 六府面板：锁着的槽也下发结构化条件与差额，玩家不用自己猜', () => {
  const s = fresh();
  const hero = heroOf(s);
  hero.level = 4;
  const view = panelState(s, cfg);
  const row = view.generals.find((g) => g.id === hero.id);
  const learn = row.slots[1];
  assert.equal(learn.locked, true);
  assert.equal(learn.unlock.open, false);
  assert.match(learn.lockText, /还差 1 级/, '锁着的槽必须写清还差几级');
  assert.equal(learn.unlock.rules[0].have, 4);
  const awake = row.slots[2];
  assert.equal(awake.unlock.rules.length, 2);
  assert.match(awake.unlock.text, /自带战法 Lv10/);

  hero.level = 10;
  hero.skills[0] = { ...(hero.skills[0] || { cfgId: 19001 }), lv: 10 };
  const view2 = panelState(s, cfg);
  const awake2 = view2.generals.find((g) => g.id === hero.id).slots[2];
  assert.equal(awake2.unlock.open, true, 'Lv10 且自带战法 10 级后觉醒槽必须开');
});

test('P58-③ 装配目标槽按「已开且空」选，装满后给出可执行的下一步', () => {
  const ui = read('server/panels-ui.js');
  assert.match(ui, /function skillTargetSlot/, '目标槽必须有唯一实现');
  assert.ok(!ui.includes('→ 学习槽'), '不得再死写「→ 学习槽」');
  assert.match(ui, /解锁条件：/, '每个槽都要渲染解锁条件');
  assert.match(ui, /data-act="unskill"/, '学习/觉醒槽要能卸下，否则装满后再也换不了');
  assert.match(ui, /兵书残卷/, '战法库要显示现有残卷数，否则研习门槛看不见');
});

test('P58-④ 六府 learn 用到正确槽位，downSkill 能腾槽，自带槽拒绝卸下', () => {
  const s = fresh();
  const hero = heroOf(s);
  hero.level = 6;
  const r1 = panelAction(s, cfg, { type: 'learn', gId: hero.id, pos: 1, cfgId: 10001 });
  assert.equal(r1.ok, true, r1.message);
  assert.equal(Number(hero.skills[1].cfgId), 10001);

  const r2 = panelAction(s, cfg, { type: 'downSkill', gId: hero.id, pos: 0 });
  assert.equal(r2.ok, false, '自带战法不能卸下');
  assert.match(r2.message, /自带战法不能卸下/);

  const r3 = panelAction(s, cfg, { type: 'downSkill', gId: hero.id, pos: 1 });
  assert.equal(r3.ok, true, r3.message);
  assert.equal(hero.skills[1], null, '卸下后该槽必须真空出来');

  const r4 = panelAction(s, cfg, { type: 'downSkill', gId: hero.id, pos: 1 });
  assert.equal(r4.ok, false, '空槽再卸必须被拒');
});

test('P58-⑤ 原客户端「武将战法」页与本机同源：slotRules 下发且文案含解锁条件', () => {
  const s = fresh();
  const hero = heroOf(s);
  hero.level = 2;
  const ctx = mkCtx(s);
  const r = handleRequest(ctx, req('general.myGenerals', {}));
  assert.equal(r.code, 0);
  const me = r.msg.generals.find((g) => g.id === hero.id);
  assert.ok(Array.isArray(me.slotRules) && me.slotRules.length === 3, '三个槽的门槛都要下发');
  assert.equal(me.slotRules[1].open, false);
  assert.match(me.slotRules[1].text, /还差 3 级/);
  const ui = read('server/skills.js');
  assert.match(ui, /slotRules/, '界面必须读本机下发的门槛，不再自己算等级');
  assert.match(ui, /解锁条件：/, '空槽必须显示解锁条件');
});
