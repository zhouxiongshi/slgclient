/**
 * P35（2026-11-22）招降失败提示中文同源回归。
 *
 * 根因：recruitCaptive 的失败返回体只有内部 reason（refused / escaped / no_gold / no_captive），
 * 六府 strategyAction 在缺少中文说明时把 reason 原样拼进提示，玩家看到「失败：refused」。
 * 本测试锁住：
 *   1. 领域层失败分支下发同源中文 text，reason/结算字段保持不变；
 *   2. 玩家文案不含内部协议码；
 *   3. UI 优先显示 text，兜底映射覆盖全部招降失败 reason，不再拼接 reason。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { recruitCaptive } from '../server/domain/strategy.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const cfg = loadConfig();

function fresh(loyal = 50) {
  const st = normalizeWorld(createWorld(cfg), cfg);
  st.roleRes.gold = 5000;
  st.captives = [{ cfgId: 100001, name: '吕布', from: '长安', loyal, days: 1, day: 10 }];
  return st;
}

function forceFail(loyal) {
  /* rngFor(seed, turn, tag) 在固定配置下由回合决定掷骰；扫几个回合找确定性失败点。 */
  for (let turn = 1; turn <= 30; turn += 1) {
    const st = fresh(loyal);
    st.strategy.turn = turn;
    const r = recruitCaptive(st, cfg, { push() {} }, { idx: 0 });
    if (r.ok === false && (r.reason === 'refused' || r.reason === 'escaped')) return { st, r };
  }
  assert.fail('30 个回合内未触发招降失败，测试构造失效');
}

test('P35-① 招降被拒：中文 text 与判定同源，未扣金且内部码不漏出', () => {
  const { st, r } = forceFail(50);
  assert.equal(r.reason, 'refused');
  assert.equal(r.charged, 0);
  assert.equal(st.roleRes.gold, 5000, '拒绝归降不得扣金');
  assert.equal(st.captives[0].loyal, 40, '忠诚照旧 -10');
  assert.match(r.text, /吕布/);
  assert.match(r.text, /拒绝归降/);
  assert.match(r.text, /忠诚降至 40/);
  assert.match(r.text, /本次把握 \d+%/);
  assert.match(r.text, /未扣金/);
  assert.doesNotMatch(r.text, /refused|escaped|no_gold|no_captive/, '玩家文案不得出现内部码');
});

test('P35-② 招降失败越狱：中文 text 写明逃走且不扣金', () => {
  const { st, r } = forceFail(9);
  assert.equal(r.reason, 'escaped');
  assert.equal(st.captives.length, 0, '越狱后俘虏出册');
  assert.equal(st.roleRes.gold, 5000);
  assert.match(r.text, /吕布/);
  assert.match(r.text, /越狱逃走/);
  assert.match(r.text, /未扣金/);
  assert.doesNotMatch(r.text, /refused|escaped|no_gold|no_captive/);
});

test('P35-③ 俘虏不存在 / 金不足也有中文说明，reason 仍保留给协议', () => {
  const none = fresh();
  none.captives = [];
  const r1 = recruitCaptive(none, cfg, { push() {} }, { idx: 0 });
  assert.equal(r1.reason, 'no_captive');
  assert.match(r1.text, /不在营中/);
  assert.doesNotMatch(r1.text, /no_captive/);

  const poor = fresh();
  poor.roleRes.gold = 0;
  const r2 = recruitCaptive(poor, cfg, { push() {} }, { idx: 0 });
  assert.equal(r2.reason, 'no_gold');
  assert.match(r2.text, /300 金/);
  assert.match(r2.text, /府库不足/);
  assert.doesNotMatch(r2.text, /no_gold/);
});

test('P35-④ 六府动作提示优先中文 text，兜底映射不再拼接 reason', () => {
  const ui = read('server/panels-ui.js');
  const seg = ui.slice(ui.indexOf('var ACTION_REASON_TEXT'), ui.indexOf('function formupBox'));
  assert.ok(seg.includes('r.text || r.hint || ACTION_REASON_TEXT[r.reason]'), '必须先取结算同源中文文案');
  for (const key of ['no_captive', 'refused', 'escaped', 'no_gold']) {
    assert.match(seg, new RegExp(`${key}:`), `兜底映射缺少 ${key}`);
  }
  assert.doesNotMatch(seg, /'失败：' \+ r\.reason/, '旧实现会把内部码直出给玩家');
  assert.ok(seg.includes('操作未生效，请刷新后再试'), '未知原因也要中文降级');
});
