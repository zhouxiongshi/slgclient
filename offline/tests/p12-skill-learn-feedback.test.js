/**
 * P12 操作回执：武将第二战法「无法学习」的根因修复。
 *
 * 用户报告（2026-11-16）：武将第二战法无法学习。实查三层：
 *   1. 原版客户端 SkillInfoLogic.onClickLearn 发完 general.upSkill 就关弹窗，
 *      而 GeneralCommand.onUpSkill / onLvSkill / onDownSkill 只有 console.log ——
 *      服务端拒绝（学习槽未开 / 未解锁 / 限 2 人）时玩家零反馈。
 *   2. 协议层 general.upSkill 不查战法库解锁，与六府装配不一致，可绕过研习系统。
 *   3. 回执通道：notice-bus（内存队列）→ /__slg/session?since=N → 外壳轮询
 *      派发 slg:notice → 交互层 toast。web/ 逐字节不动、协议不动。
 *
 * 玩法判定本身不变：学习槽仍 5 级开（GDD §5.4 户役/养成规则），
 * 本文件修的是「被拒绝时玩家看得见」与「解锁口径唯一」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { applyGeneralExp } from '../server/domain/general-progress.js';
import { notify, drain, lastId, resetForTest, peek } from '../server/notice-bus.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cfg = loadConfig();
const req = (name, msg = {}) => ({ seq: 1, name, msg });

function makeCtx(state) {
  return {
    state, cfg, options: {},
    push() {}, save() {}, log() {}, schedule() {},
  };
}

test('回执总线：notify 入队、drain 增量消费、lastId 对齐游标不倒历史账', () => {
  resetForTest();
  assert.equal(lastId(), 0);
  notify('第一条', 'warn');
  notify('第二条', 'ok');
  assert.equal(lastId(), 2);
  // since=0 的首轮语义由路由层实现（返回 last 不返回 items），bus 层 drain(0) 给全量
  assert.deepEqual(drain(0).items.map((n) => n.text), ['第一条', '第二条']);
  const d1 = drain(0);
  assert.equal(d1.last, 2);
  assert.deepEqual(drain(2).items, [], '游标之后没有新回执');
  notify('第三条');
  const d2 = drain(d1.last);
  assert.deepEqual(d2.items.map((n) => n.text), ['第三条']);
  assert.equal(d2.last, 3);
  notify('', 'ok');            // 空文本不入队
  assert.equal(lastId(), 3);
  assert.ok(peek().items.length <= 40, '容量截断防泄漏');
  resetForTest();
  assert.equal(lastId(), 0);
});

test('学习被拒时必须留下玩家可见回执：等级不够 / 未解锁 / 限 2 人 / 军工不足', () => {
  resetForTest();
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = makeCtx(state);
  const g = state.generals[0];

  // ① Lv1 点学习：slot_locked，回执要告诉玩家「到 5 级」
  let r = handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: 10001, pos: 1 }));
  assert.equal(r.msg.ok, false);
  assert.equal(r.msg.reason, 'slot_locked');
  assert.match(r.msg.hint, /5 级/);
  let box = drain(0);
  assert.equal(box.items.length, 1, '拒绝必须进回执队列');
  assert.match(box.items[0].text, /5 级/);
  assert.equal(box.items[0].kind, 'warn');

  // ② Lv5 但战法未解锁：not_unlocked，回执给下一步（去战法库研习）。
  //    10001 是开局预置解锁（panels.js「开局旧藏」），未解锁的用 10003。
  applyGeneralExp(g, 400);
  assert.equal(g.level, 5);
  r = handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: 10003, pos: 1 }));
  assert.equal(r.msg.reason, 'not_unlocked');
  box = drain(box.last);
  assert.match(box.items.at(-1).text, /战法库/);

  // ③ 限 2 人：换一条未预置的 10005，主公 + 两个自造武将依次学，第三人被拒
  state.skillbook.unlocked['10005'] = { level: 1, source: '战功研习' };
  const fake = (id) => ({
    id, cfgId: 880100 + id, name: `测试将${id}`, level: 5, star: 3,
    skills: [null, null, null], loyal: 90, exp: 0,
  });
  state.generals.push(fake(9001), fake(9002), fake(9003));
  const learners = [g.id, 9001, 9002, 9003];
  let learned = 0;
  let limitBox = null;
  for (const lid of learners) {
    const r2 = handleRequest(ctx, req('general.upSkill', { gId: lid, cfgId: 10005, pos: 1 }));
    if (r2.msg.ok) learned += 1;
    else if (r2.msg.reason === 'limit_reached') { limitBox = r2; break; }
    else { limitBox = r2; break; }
  }
  assert.equal(learned, 3, '10005 的原表上限 ui.limit=3，应学满 3 人');
  assert.equal(limitBox?.msg.reason, 'limit_reached');
  box = drain(box.last);
  assert.match(box.items.at(-1).text, /上限 3 人/);

  // ④ 升级军工不足：回执给金额
  state.roleRes.jungong = 0;
  r = handleRequest(ctx, req('general.lvSkill', { gId: g.id, pos: 0 }));
  assert.equal(r.msg.reason, 'not_enough_jungong');
  box = drain(box.last);
  assert.match(box.items.at(-1).text, /军工/);
  resetForTest();
});

test('学习成功回执：带武将名与战法名（玩家唯一能看见的确认通道）', () => {
  resetForTest();
  const state = normalizeWorld(createWorld(cfg), cfg);
  const ctx = makeCtx(state);
  const g = state.generals[0];
  applyGeneralExp(g, 400);
  state.skillbook.unlocked['10001'] = { level: 1, source: '战功研习' };
  const r = handleRequest(ctx, req('general.upSkill', { gId: g.id, cfgId: 10001, pos: 1 }));
  assert.equal(r.msg.ok, true);
  assert.equal(g.skills[1].cfgId, 10001);
  const box = drain(0);
  const okNotice = box.items.filter((n) => n.kind === 'ok');
  assert.equal(okNotice.length, 1, '成功只给 upSkill 报喜，升级不刷屏');
  assert.match(okNotice[0].text, /学会了/);
  assert.match(okNotice[0].text, /10001|击势/);
  resetForTest();
});

test('下发链路：/__slg/session?since=N 捎带回执，首轮只对齐游标', async () => {
  resetForTest();
  notify('回执A', 'warn');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'slg-p12-'));
  const { startOfflineServer } = await import('../server/index.js');
  const srv = await startOfflineServer({ saveDir: dir, httpPort: 19961, wsPort: 19962, quiet: true });
  try {
    const base = 'http://127.0.0.1:19961';
    const first = await (await fetch(`${base}/__slg/session?since=0`)).json();
    assert.deepEqual(first.notices, [], '首轮不倒历史账');
    assert.ok(first.noticeLast >= 1, '但要把游标推进到现在');
    notify('回执B', 'ok');
    const second = await (await fetch(`${base}/__slg/session?since=${first.noticeLast}`)).json();
    assert.deepEqual(second.notices.map((n) => n.text), ['回执B']);
    assert.equal(second.notices[0].kind, 'ok');
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
  resetForTest();
});

test('注入链路静态闸：轮询捎带 since、派发 slg:notice、交互层监听并转 toast', () => {
  const index = readFileSync(resolve(ROOT, 'server/index.js'), 'utf8');
  const shell = readFileSync(resolve(ROOT, 'server/ui-shell.js'), 'utf8');
  const ix = readFileSync(resolve(ROOT, 'server/interaction-ui.js'), 'utf8');
  // 轮询带游标（写进 index.js 的 gateBoot 注入串）
  assert.match(index, /session\?since="\+D\.noticeCursor/);
  assert.match(index, /slg:notice/);
  // 交互层监听并转 toast，kind 映射 warn→fail（红）显示
  assert.match(ix, /addEventListener\('slg:notice'/);
  assert.match(ix, /n\.kind === 'warn' \? 'fail'/);
  // 处理器把拒绝与成功都写进回执（handlers.js）
  const handlers = readFileSync(resolve(ROOT, 'server/handlers.js'), 'utf8');
  assert.match(handlers, /if \(!ok && hint\) notify\(hint, 'warn'\)/);
  assert.match(handlers, /notify\(`\$\{gName\}学会了/);
  // 外壳本就不用管回执（职责在 gateBoot + 交互层），防止有人把消费逻辑写进两处
  assert.doesNotMatch(shell, /slg:notice/);
});

test('解锁口径唯一：协议层 upSkill 与六府装配同一条校验（不再绕过战法库）', () => {
  const handlers = readFileSync(resolve(ROOT, 'server/handlers.js'), 'utf8');
  assert.match(handlers, /skillbook\?\.unlocked\?\.\[String\(cfgId\)\]/, '协议层必须查战法库解锁');
  const slots = readFileSync(resolve(ROOT, 'server/domain/slots.js'), 'utf8');
  assert.match(slots, /not_unlocked/, '拒绝理由要给玩家能行动的下一步');
});
