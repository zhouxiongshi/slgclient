/**
 * OP-01 / OP-02（2026-11-15 产品决策）回归闸：
 *   1) 金侧新增「国库沉淀税」支出阀门，让挂机现金从线性外推变为向稳态收敛；
 *   2) 删除从未被消费的 moraleRout 占位，UI 文案与 supply.js 断粮结算同源。
 *
 * 硬约束：阀门只改存量，不动产量 / 原表 / 战斗数值；每笔支出必须进府库流水
 * （P1 可解释），且 GM 能把税率设成 0 完全关闭。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { applyDays } from '../server/domain/economy.js';
import { KNOBS, knobGet } from '../server/domain/knobs.js';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const cfg = loadConfig();
const RULES = { decreePerDay: 2, upkeepPerSoldier: 0 };

function world(gold) {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true, '举义应成功（ownsCity 是阀门生效前提）');
  ensureCityEcon(state);
  state.roleRes.gold_yield = 400;   // 400 金/日 → 4,000 金/旬毛产
  state.roleRes.gold = gold;
  return state;
}

test('参数表仍 30 项：删掉零消费的 moraleRout，换成生效的 goldHoardTaxPct', () => {
  assert.equal(Object.keys(KNOBS).length, 30, 'm2-failstate 也锁这个数，不许悄悄增减');
  assert.ok(!('moraleRout' in KNOBS), '士气占位必须删除，避免玩家误以为有士气系统');
  assert.ok('goldHoardTaxPct' in KNOBS);
  assert.equal(knobGet({}, 'goldHoardTaxPct'), 4, '默认 4%/旬');
  assert.equal(KNOBS.goldHoardTaxPct.min, 0, '0 = 关闭阀门，必须允许');
});

test('国库沉淀税：超出 3 旬周转金才收，且每笔进府库流水', () => {
  const s = world(200000);
  const r = applyDays(s, cfg, 10, RULES);
  assert.ok(r.hoardTaxPaid > 0, '高存量必须触发回收');
  const rows = (s.resLedger || []).filter((x) => x.reason === '国库沉淀税');
  assert.equal(rows.length, 1, '支出必须可查，不能凭空消失');
  assert.equal(rows[0].delta, -r.hoardTaxPaid);
  /* P61-B：免税额收紧为 3 × 每旬金毛产 = 12,000；税基是超出部分而非全额 */
  const expected = Math.floor((200000 + 4000 - 0 - Math.round(4000 * 0.35) - 12000) * 0.04);
  assert.ok(Math.abs(r.hoardTaxPaid - expected) <= 2, `税基应只取沉淀部分，实收 ${r.hoardTaxPaid} / 期望 ${expected}`);
});

test('国库沉淀税：开局周转金内免税，不惩罚早期节奏', () => {
  const s = world(6000);
  const r = applyDays(s, cfg, 10, RULES);
  assert.equal(r.hoardTaxPaid, 0);
  assert.equal((s.resLedger || []).some((x) => x.reason === '国库沉淀税'), false);
});

test('国库沉淀税：GM 设 0 可完全关闭阀门', () => {
  const s = world(200000);
  s.knobs = { ...(s.knobs || {}), goldHoardTaxPct: 0 };
  const r = applyDays(s, cfg, 10, RULES);
  assert.equal(r.hoardTaxPaid, 0);
});

test('多旬收敛：4% 阀门下存量向稳态收敛，不再线性外推', () => {
  const taxed = world(200000);
  const free = world(200000);
  free.knobs = { ...(free.knobs || {}), goldHoardTaxPct: 0 };
  const gainsA = [];
  const gainsB = [];
  for (let i = 0; i < 30; i += 1) {
    const a0 = taxed.roleRes.gold, b0 = free.roleRes.gold;
    applyDays(taxed, cfg, 10, RULES);
    applyDays(free, cfg, 10, RULES);
    gainsA.push(taxed.roleRes.gold - a0);
    gainsB.push(free.roleRes.gold - b0);
  }
  assert.ok(taxed.roleRes.gold < free.roleRes.gold, '阀门必须真的压住存量');
  const early = gainsA.slice(0, 5).reduce((s, n) => s + n, 0);
  const late = gainsA.slice(-5).reduce((s, n) => s + n, 0);
  assert.ok(late > early, `应逐渐趋于稳态（前 5 旬 ${early}，后 5 旬 ${late}）`);
  assert.ok(gainsB.every((n) => n > 0), '无阀门时确实无限线性增长（对照）');
});

test('DEV-14：粮道断文案与 supply.js 同源，不得再出现「士气 −5」', () => {
  /* 静态闸只看玩家能看到的字符串，注释里复盘旧文案不算回归 */
  const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const ui = codeOnly(read('server/interaction-ui.js'));
  const supply = read('server/domain/supply.js');
  assert.doesNotMatch(ui, /士气\s*[−-]\s*5/, '旧文案暗示了不存在的士气系统');
  assert.match(ui, /民心\s*−3、治安\s*−1/, '必须按实现的民心/治安口径写');
  assert.match(supply, /民心\s*−3/, '实现侧仍是同一组数值');
});

test('GAP-01 旁证：注入层不编造士气数值，fieldGaps 保持显式降级', () => {
  const ix = read('server/domain/interaction.js');
  assert.match(ix, /刻意降级的设计特性/, '字段缺口 必须写明三项为何不补');
  assert.match(ix, /have:\s*false/);
  assert.doesNotMatch(ix, /have:\s*true\s*}/, '不许把降级项标成「已提供」');
});
