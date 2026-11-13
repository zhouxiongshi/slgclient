/**
 * M3-2 事件系统（GDD §8.1 / §8.2 / §8.3）。
 *
 * 锁四件事：
 *  1. event-dsl：字段/算子白名单（未知字段即拒绝）、六比较、数组语义、flag has/not；
 *  2. event-engine：priority 降序、每旬最多 2 条、exclusive 组内只出 1（其余冷却 1 旬）、
 *     once 永久排除、applyEffects 白名单效果词全落账；
 *  3. check-events：构建期校验全绿（子进程重跑）+ 冲突抓样（坏数据必报错）；
 *  4. events.json：52 条（37 史实/9 条件/6 关系），全部有 source/confidence。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateEvent, validateEventSchema, parseEffect,
} from '../server/domain/event-dsl.js';
import {
  ensureEventState, eventCooldownTick, selectEvents, applyEffects,
} from '../server/domain/event-engine.js';
import { campaignEvents } from '../server/domain/strategy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EVENTS = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/events.json'), 'utf8'));

function ctx(over = {}) {
  return {
    turn: 10, year: 200, season: '夏', faction: 'yanzhou',
    cityOwned: () => [7, 33], cityLost: () => [],
    resource: (kind) => (kind === 'gold' ? 2000 : kind === 'grain' ? 3000 : 0),
    flag: (name) => name === 'guandu_probing',
    relation: () => null,
    generalAlive: () => true,
    generalInTeam: () => false,
    battleLostCount: () => 0,
    battleWonCount: () => 0,
    ...over,
  };
}

const mkState = () => ({});

test('M3-2·event-dsl：白名单外字段即拒绝（fail fast）', () => {
  assert.throws(() => evaluateEvent({ foo: 1 }, ctx()), /不在白名单/, '未知 when 字段必须抛错');
  assert.throws(() => evaluateEvent({ resource: { gold: { '>>': 1 } } }, ctx()), /算子非法/, '未知算子必须抛错');
  assert.throws(() => evaluateEvent({ resource: { gold: 500 } }, ctx()), /单算子对象/, '裸值不是算子对象必须抛错');
  assert.throws(() => evaluateEvent({ resource: { gold: { '>=': 'abc' } } }, ctx()), /必须是数字/, '比较目标必须数字');
});

test('M3-2·event-dsl：六比较与数组字段语义', () => {
  assert.equal(evaluateEvent({ resource: { gold: { '>=': 1000 } } }, ctx()), true, 'gold>=1000');
  assert.equal(evaluateEvent({ resource: { gold: { '<': 1000 } } }, ctx()), false, 'gold<1000 不满足');
  assert.equal(evaluateEvent({ resource: { gold: { '=': 2000 } } }, ctx()), true);
  assert.equal(evaluateEvent({ resource: { gold: { '!=': 2000 } } }, ctx()), false);
  assert.equal(evaluateEvent({ yearMin: 200, yearMax: 210 }, ctx()), true, '年份区间');
  assert.equal(evaluateEvent({ faction: ['yanzhou', 'jizhou'] }, ctx()), true, 'faction in 语义');
  assert.equal(evaluateEvent({ faction: ['jizhou'] }, ctx()), false);
  assert.equal(evaluateEvent({ cityOwned: [7, 33] }, ctx()), true, 'cityOwned AND 语义');
  assert.equal(evaluateEvent({ cityOwned: [8] }, ctx()), false);
  assert.equal(evaluateEvent({ cityLost: [7] }, ctx()), false, '未丢城');
  assert.equal(evaluateEvent({ flag: { has: ['guandu_probing'] } }, ctx()), true);
  assert.equal(evaluateEvent({ flag: { not: ['guandu_probing'] } }, ctx()), false);
  assert.equal(evaluateEvent({ season: ['夏', '秋'] }, ctx()), true);
  assert.equal(evaluateEvent({ battleLost: { count: { '>=': 2 } } }, ctx()), false, '无败绩');
  assert.equal(evaluateEvent({ battleLost: { count: { '>=': 2 } } }, ctx({ battleLostCount: () => 2 })), true);
  // relation 返回 null（无记录）→ 不满足
  assert.equal(evaluateEvent({ relation: { a: '关羽', b: '张辽', value: { '>=': 60 } } }, ctx()), false);
  assert.equal(
    evaluateEvent({ relation: { a: '关羽', b: '张辽', value: { '>=': 60 } } },
      ctx({ relation: () => 80 })),
    true, 'relation 值达标',
  );
});

test('M3-2·event-engine：priority 降序 + 每旬最多 2 条（确定性）', () => {
  const events = [
    { id: 'evt.a', title: 'a', layer: '条件', priority: 50, when: {}, choices: [{ id: 'x', label: 'x', effects: ['nothing'] }], once: false, source: { id: 's', confidence: '高' } },
    { id: 'evt.b', title: 'b', layer: '条件', priority: 90, when: {}, choices: [{ id: 'x', label: 'x', effects: ['nothing'] }], once: false, source: { id: 's', confidence: '高' } },
    { id: 'evt.c', title: 'c', layer: '条件', priority: 70, when: {}, choices: [{ id: 'x', label: 'x', effects: ['nothing'] }], once: false, source: { id: 's', confidence: '高' } },
    { id: 'evt.d', title: 'd', layer: '条件', priority: 60, when: {}, choices: [{ id: 'x', label: 'x', effects: ['nothing'] }], once: false, source: { id: 's', confidence: '高' } },
  ];
  const { selected, deferred } = selectEvents(events, ctx(), mkState());
  assert.deepEqual(selected.map((e) => e.id), ['evt.b', 'evt.c'], '按 priority 降序取前 2');
  assert.deepEqual(deferred, ['evt.d', 'evt.a']);
});

test('M3-2·event-engine：exclusive 组内只出 1，其余冷却 1 旬；once 永久排除', () => {
  const events = [1, 2, 3].map((n) => ({
    id: `evt.grp${n}`, title: `g${n}`, layer: '条件', priority: 80,
    when: {},
    choices: [{ id: 'x', label: 'x', effects: ['nothing'] }],
    once: true,
    exclusive: ['evt.grp1', 'evt.grp2', 'evt.grp3'],
    source: { id: 's', confidence: '高' },
  }));
  const state = mkState();
  const r1 = selectEvents(events, ctx(), state);
  assert.equal(r1.selected.length, 1, '同组一旬只出一条');
  assert.deepEqual(r1.deferred, ['evt.grp2', 'evt.grp3'], '组内其余进冷却');
  assert.equal(state.events.cooldown['evt.grp2'], 1);
  assert.equal(state.events.cooldown['evt.grp3'], 1);
  assert.ok(state.events.fired['evt.grp1'] != null, '选中者记 fired');

  // 下一旬：冷却递减，grp2 解除，grp1 因 once 永久排除
  eventCooldownTick(state);
  assert.ok(!state.events.cooldown['evt.grp2'], '冷却到期清除');
  const r2 = selectEvents(events, ctx(), state);
  assert.deepEqual(r2.selected.map((e) => e.id), ['evt.grp2']);
  // 第三旬只剩 grp3
  eventCooldownTick(state);
  const r3 = selectEvents(events, ctx(), state);
  assert.deepEqual(r3.selected.map((e) => e.id), ['evt.grp3']);
  eventCooldownTick(state);
  const r4 = selectEvents(events, ctx(), state);
  assert.equal(r4.selected.length, 0, 'once 三条全触发后不再出');
});

test('M3-2·applyEffects：效果词全落账，非法词与未知选项拒绝', () => {
  const event = {
    id: 'evt.demo', title: 'demo', layer: '条件', priority: 1, when: {},
    choices: [
      { id: 'a', label: 'a', effects: ['flag:foo', 'flag-:bar', 'gold:-300', 'morale:+10', 'loyalty:许褚:+5', 'attitude:jizhou:-15', 'fame:+2', 'nothing'] },
      { id: 'b', label: 'b', effects: ['gold:+500'] },
    ],
    once: true, source: { id: 's', confidence: '高' },
  };
  const calls = [];
  const api = {
    setFlag: (n) => calls.push(['setFlag', n]),
    clearFlag: (n) => calls.push(['clearFlag', n]),
    addGold: (n) => calls.push(['addGold', n]),
    addMorale: (n) => calls.push(['addMorale', n]),
    addLoyalty: (t, n) => calls.push(['addLoyalty', t, n]),
    addAttitude: (t, n) => calls.push(['addAttitude', t, n]),
    addFame: (n) => calls.push(['addFame', n]),
    turn: () => 42,
  };
  const state = mkState();
  const applied = applyEffects(state, event, 'a', api);
  assert.equal(applied.length, 8);
  assert.deepEqual(calls, [
    ['setFlag', 'foo'], ['clearFlag', 'bar'], ['addGold', -300], ['addMorale', 10],
    ['addLoyalty', '许褚', 5], ['addAttitude', 'jizhou', -15], ['addFame', 2],
  ], '效果词逐项落账');
  // 选择记录（回放用）
  assert.equal(state.events.choices['evt.demo'].turn, 42);
  assert.throws(() => applyEffects(state, event, 'nope', api), /无选项/, '未知 choice 拒绝');
  assert.throws(() => applyEffects(state, { ...event, choices: [{ id: 'c', label: 'c', effects: ['launch:missiles'] }] }, 'c', api), /效果词非法|未实现/, '白名单外效果词拒绝');
});

test('M3-2·events.json：52 条 / 三层计数 / check-events 全绿', () => {
  assert.equal(EVENTS.events.length, 52);
  const byLayer = {};
  for (const e of EVENTS.events) byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
  assert.deepEqual(byLayer, { '史实节点': 37, '条件': 9, '关系': 6 });
  // 每条 source.confidence 齐备（出戏防线闸 4 的数据前提）
  for (const e of EVENTS.events) {
    assert.ok(e.source.id && e.source.confidence, `${e.id} 缺史实依据`);
  }
  const out = execFileSync(process.execPath, [resolve(ROOT, 'tools/check-events.mjs')], { encoding: 'utf8' });
  assert.match(out, /check-events ok/, '构建期校验应通过');
});

test('M3-7·事件补量：两批合计 150 条（GDD §8 上限）/ campaignEvents 合并加载', () => {
  const extra = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/events-extra.json'), 'utf8'));
  assert.equal(extra.events.length, 98);
  assert.equal(EVENTS.events.length + extra.events.length, 150);
  // id 全局唯一（跨文件）
  const ids = new Set();
  for (const e of [...EVENTS.events, ...extra.events]) {
    assert.ok(!ids.has(e.id), `事件 id 重复: ${e.id}`);
    ids.add(e.id);
  }
  // 第二批每条也带史实依据
  for (const e of extra.events) {
    assert.ok(e.source.id && e.source.confidence, `${e.id} 缺史实依据`);
  }
  // 运行期合并加载
  assert.equal(campaignEvents().length, 150);
});

test('M3-2·check-events：坏数据必报错（冲突抓样）', () => {
  // validateEventSchema 直接抓样：缺 choices / 效果词非法 / 引用不存在的武将
  const errs = validateEventSchema(
    { id: 'evt.bad', title: 'x', layer: '条件', priority: 1, when: { generalAlive: ['不存在的武将'] }, text: ['t'], choices: [{ id: 'x', label: 'x', effects: ['bad:word'] }], source: { id: 's', confidence: '高' } },
    new Set(['关羽']),
  );
  assert.ok(errs.some((m) => m.includes('不在 heroes-240')), '应报武将缺员');
  assert.ok(errs.some((m) => m.includes('效果词非法')), '应报效果词非法');
  // parseEffect 词法
  assert.deepEqual(parseEffect('flag:wuchao_burned'), { kind: 'flag', name: 'wuchao_burned' });
  assert.deepEqual(parseEffect('gold:-300'), { kind: 'gold', delta: -300 });
  assert.deepEqual(parseEffect('loyalty:许褚:+5'), { kind: 'loyalty', target: '许褚', delta: 5 });
  assert.equal(parseEffect('eval(evil)'), null);
  assert.deepEqual(parseEffect('nothing'), { kind: 'nothing' });
});
