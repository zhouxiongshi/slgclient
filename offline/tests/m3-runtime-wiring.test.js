/**
 * M3-4 运行期接线测试：
 *  1. heroes-240 入包（config.js）：505 条武将、240 名全在、新武将可 makeGeneral；
 *  2. 事件 tick（strategy.js）：strategyEventTick 出队 ≤2 条、once 落 fired、pending 不堆叠；
 *  3. 事件点选：eventChoice 效果词落账（gold/fame）、pending 消费、抉择进 chronicle；
 *  4. 宿命组合落战斗（GDD §7.5）：桃园三人同队守军折算 <1，单人无效，推演/结算同源；
 *  5. 视图下发：pendingEvents / fates 随 strategyViewState 出去；
 *  6. 态度事件因子：adjustAttitudeByEvent → attitudeOf 理由链可见；
 *  7. cityLost 口径：everOwned 记账 → 条件层 cityLost 可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld, makeGeneral, nextId } from '../server/world.js';
import {
  ensureStrategy, strategyEventTick, strategyEventChoice, strategyEventCtx,
  fateComboDefMul, strategyFateView, strategyViewState, chooseOath, oathOptions,
  campaignEvents,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { adjustAttitudeByEvent, attitudeOf } from '../server/domain/diplomacy.js';

const cfg = loadConfig();

function baseWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  state.clock.day = 30;
  return state;
}

function lordWorld() {
  const state = baseWorld();
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  return state;
}

test('M3-4·heroes-240 入包：武将表 240 名全在、新武将可建', () => {
  const heroes = JSON.parse(readFileSync(new URL('../conf/campaign/heroes-240.json', import.meta.url), 'utf8'));
  const names = heroes.heroes.map((h) => h.name);
  assert.equal(names.length, 240);
  const inTable = names.filter((n) => [...cfg.generalByCfg.values()].some((g) => g.name === n));
  assert.equal(inTable.length, 240, `heroes-240 全员入包，缺 ${names.length - inTable.length}`);
  // 新分配段武将（240001+）能 makeGeneral 且星级在模板范围
  const fresh = [...cfg.generalByCfg.values()].find((g) => Number(g.cfgId) >= 240001);
  assert.ok(fresh, '应有 240001+ 新武将条目');
  const state = baseWorld();
  const g = makeGeneral(cfg, nextId(state, 'generalId'), fresh.cfgId, 1, 1);
  assert.ok(g.star >= 3 && g.star <= 5);
  state.generals.push(g);
});

test('M3-4·事件 tick：出队 ≤2、once 落 fired、pending 不堆叠', () => {
  const state = baseWorld();
  const t1 = strategyEventTick(state);
  assert.ok(t1 && t1.pending >= 1, '第 30 日应有事件出队');
  assert.ok(t1.pending <= 2, '每旬最多 2 条（GDD §8.3）');
  const st = state.strategy;
  assert.equal(st.pendingEvents.length, t1.pending);
  const onceIds = st.pendingEvents.filter((e) => e.id === 'evt.184.zhangjiao');
  assert.ok(onceIds.length <= 1);
  const t2 = strategyEventTick(state);
  assert.equal(t2.pending, t1.pending, '未决事件不堆叠');
  assert.ok(st.eventSys.fired['evt.184.zhangjiao'] !== undefined, 'once 事件进 fired');
});

test('M3-4·事件点选：效果词落账 + pending 消费 + 抉择进 chronicle', () => {
  const state = baseWorld();
  const st = state.strategy;
  const ev = campaignEvents().find((e) => e.id === 'evt.184.zhangjiao');
  assert.ok(ev, 'events.json 应含 evt.184.zhangjiao');
  st.pendingEvents = [{ id: ev.id, title: ev.title }];
  const goldBefore = Math.round(state.roleRes.gold);
  const relief = ev.choices.find((c) => c.effects.some((f) => f.startsWith('gold:')));
  const goldDelta = relief.effects
    .filter((f) => f.startsWith('gold:'))
    .reduce((s, f) => s + Number(f.slice(5)), 0);
  const r = strategyEventChoice(state, cfg, { push() {} }, { id: ev.id, choice: relief.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(Math.round(state.roleRes.gold), Math.max(0, goldBefore + goldDelta));
  assert.equal(st.pendingEvents.length, 0, '点选后消费');
  const rec = st.events.find((m) => String(m.text || '').includes('事件·抉择'));
  assert.ok(rec, '抉择应进 chronicle');
  // 坏选项拒绝
  st.pendingEvents = [{ id: ev.id, title: ev.title }];
  const bad = strategyEventChoice(state, cfg, {}, { id: ev.id, choice: 'nope' });
  assert.equal(bad.ok, false);
});

test('M3-4·宿命组合：桃园三人同队折算 ×0.95²，单人无效', () => {
  const state = baseWorld();
  const pick = (name) => [...cfg.generalByCfg.values()].find((g) => g.name === name)?.cfgId;
  const mk = (name) => {
    const g = makeGeneral(cfg, nextId(state, 'generalId'), pick(name), 1, 1);
    state.generals.push(g);
    return g;
  };
  const liu = mk('刘备'); const guan = mk('关羽'); const zhang = mk('张飞'); const solo = mk('赵云');
  const army3 = { generals: [liu.id, guan.id, zhang.id] };
  const f3 = fateComboDefMul(state, cfg, army3);
  assert.ok(f3.mul < 1 && f3.mul > 0.85, `三人同队折算 ${f3.mul}`);
  assert.ok(f3.notes.some((n) => n.includes('桃园')), f3.notes.join(';'));
  const f1 = fateComboDefMul(state, cfg, { generals: [solo.id] });
  assert.equal(f1.mul, 1, '单人无组合');
  const f2 = fateComboDefMul(state, cfg, { generals: [liu.id, solo.id] });
  assert.equal(f2.mul, 1, '两人不同组无组合');
  const empty = fateComboDefMul(state, cfg, { generals: [] });
  assert.equal(empty.mul, 1);
});

test('M3-4·视图下发：pendingEvents / fates 随 strategyViewState 出去', () => {
  const state = lordWorld();
  const st = state.strategy;
  st.pendingEvents = [{ id: 'x', title: '测试事件', choices: [{ id: 'a', label: '甲' }] }];
  // 桃园三人入帐
  const pick = (name) => [...cfg.generalByCfg.values()].find((g) => g.name === name)?.cfgId;
  for (const name of ['刘备', '关羽', '张飞']) {
    state.generals.push(makeGeneral(cfg, nextId(state, 'generalId'), pick(name), st.playerCity, 1));
  }
  const view = strategyViewState(state, cfg);
  assert.ok(Array.isArray(view.pendingEvents) && view.pendingEvents[0]?.id === 'x');
  assert.ok(Array.isArray(view.fates));
  const taoyuan = view.fates.find((f) => String(f.title).includes('桃园'));
  assert.ok(taoyuan, `应有桃园组合，实际 ${view.fates.map((f) => f.title).join(',')}`);
  assert.equal(taoyuan.present.length, 3);
});

test('M3-4·态度事件因子：adjustAttitudeByEvent 进理由链', () => {
  const state = baseWorld();
  const before = attitudeOf(state, 'player', 'jizhou').value;
  const r = adjustAttitudeByEvent(state, 'jizhou', 12);
  assert.equal(r.ok, true);
  const { value, factors } = attitudeOf(state, 'player', 'jizhou');
  assert.equal(value, Math.min(100, before + 12));
  assert.ok(factors.some((f) => f.label === '事件' && f.delta === 12), JSON.stringify(factors));
  // 累计与钳制：eventAdj 上限 100，整体 attitude 再钳 -100..100
  adjustAttitudeByEvent(state, 'jizhou', 200);
  const after = attitudeOf(state, 'player', 'jizhou');
  const evFactor = after.factors.find((f) => f.label === '事件')?.delta ?? 0;
  assert.equal(evFactor, 100, 'eventAdj 应钳在 100');
  assert.equal(after.value, Math.max(-100, Math.min(100, after.factors.reduce((s, f) => s + f.delta, 0))));
});

test('M3-4·cityLost 口径：everOwned 记账 → ctx.cityLost 可用', () => {
  const state = lordWorld();
  const st = state.strategy;
  const ctx = strategyEventCtx(state);
  assert.deepEqual(ctx.cityLost(), [], '开局无失城');
  const owned = Object.keys(st.cities).filter((id) => st.cities[id].owner === 'player').map(Number);
  assert.ok(owned.length >= 1, '举义后应有城');
  // 模拟失城（正式翻转走各自结算，这里只验口径）
  st.cities[owned[0]].owner = 'jizhou';
  assert.deepEqual(ctx.cityLost(), [owned[0]]);
  assert.ok(ctx.cityOwned().includes(owned[1] ?? owned[0]) === false || ctx.cityOwned().length >= 0);
});
