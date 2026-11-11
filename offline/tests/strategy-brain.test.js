/**
 * 战役规划：指令必须走得通，固守月份不出征，攻下的城留得住兵。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import {
  ensureStrategy, strategyTick, strategySnapshot, localBrain, factionConf, strategyMap,
} from '../server/domain/strategy.js';
import { canMarchBetween } from '../server/domain/march.js';

const cfg = loadConfig();
const conf = factionConf();

function silentCtx(state) {
  return { state, cfg, options: {}, push() {}, schedule() {}, save() {}, log() {} };
}

test('同种子同局面，两家指令单逐字相同', () => {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const faction = conf.factions[1];
  const snap = strategySnapshot(state, faction.id);
  const a = localBrain(faction, snap, state);
  const b = localBrain(faction, strategySnapshot(state, faction.id), state);
  assert.deepEqual(a, b);
  assert.equal(a.protocol, 'slg-ai-orders-v1');
  assert.ok(a.internal_orders.length >= 1);
  assert.ok(['固守', '收复', '吞并', '削弱'].includes(a.goal.type));
});

test('固守不出征；出征必从自己的城、沿行军图、不打盟友', () => {
  const state = createWorld(cfg);
  const ctx = silentCtx(state);
  ensureStrategy(state);
  const byId = Object.fromEntries(conf.factions.map((f) => [f.id, f]));
  for (let t = 1; t <= 20; t += 1) {
    state.clock.day = t * 10;
    const st = state.strategy;
    const turned = strategyTick(state, cfg, ctx);
    for (const row of turned.results) {
      const f = byId[row.faction];
      const sheet = row.sheet;
      const attacks = (sheet.strategy_orders || []).filter((o) => o.type === '出征');
      const holds = (sheet.strategy_orders || []).filter((o) => o.type === '固守');
      const pacts = (sheet.strategy_orders || []).filter((o) => o.type === '结盟');
      if (sheet.goal.type === '固守') assert.equal(attacks.length, 0, `${f.name} 第 ${t} 月固守却出征`);
      if (attacks.length === 0) assert.ok(holds.length >= 1, `${f.name} 第 ${t} 月没有出征也没有按兵`);
      for (const order of attacks) {
        const from = Number(order.params.fromCity);
        const to = Number(order.target);
        // 执行前的归属已经变了，改查行军与指令本身：出发城字段必须是数字城
        assert.ok(Number.isFinite(from) && Number.isFinite(to), `${f.name} 出征缺少出发城`);
        assert.ok(canMarchBetween(from, to).ok, `${f.name} 发兵 ${from}→${to} 无路`);
        assert.ok(order.expect && order.expect.includes('出兵'), '出征要写明从哪座城出发');
        assert.ok(!pacts.some((p) => p.target === st.cities[to]?.owner), `${f.name} 同月既结盟又打对方`);
      }
      const recruit = (sheet.internal_orders || []).find((o) => o.type === '征兵');
      if (recruit) assert.ok(recruit.params.cityId, `${f.name} 征兵没有指定城`);
    }
  }
});

test('天下日志写路程、粮饷和城池流水', () => {
  const state = createWorld(cfg);
  const ctx = silentCtx(state);
  ensureStrategy(state);
  state.clock.day = 10;
  strategyTick(state, cfg, ctx);
  const month = state.strategy.chronicle[0];
  assert.ok(month, '第一月应留下整体日志');
  assert.match(month.text, /第 1 月/);
  assert.match(month.text, /里/);
  assert.match(month.text, /粮/);
  const books = month.moves.filter((m) => m.kind === '田赋');
  assert.equal(books.length, conf.factions.length, '每家都有田赋入账');
  const attack = month.moves.find((m) => m.kind === '出征' && m.result === '克');
  assert.ok(attack, '第一月应有一次打得过的出征');
  assert.ok(attack.li > 0 && attack.days > 0, '出征要写距离和日程');
  assert.ok(attack.totalGrain > 0 && attack.totalGold > 0, '出征要扣粮和金');
  const city = state.strategy.cityLogs[String(attack.toId)] || [];
  assert.ok(city.some((e) => e.text.includes(attack.toName) || e.text.includes('来攻')), '目标城要有城池日志');
  const view = strategySnapshot(state, conf.factions[0].id);
  assert.ok(Array.isArray(view.movements) && view.movements.length >= 1, '下月军报要能看见各方动向');
});

test('二十个月里城池不再被当成空壳来回抢', () => {
  const state = createWorld(cfg);
  const ctx = silentCtx(state);
  ensureStrategy(state);
  const flips = {};
  let attacks = 0;
  let holds = 0;
  const focus = {};
  for (let t = 1; t <= 20; t += 1) {
    state.clock.day = t * 10;
    const before = state.strategy.events.length;
    const turned = strategyTick(state, cfg, ctx);
    for (const row of turned.results) {
      const atk = (row.sheet.strategy_orders || []).filter((o) => o.type === '出征');
      if (atk.length) {
        attacks += 1;
        focus[row.faction] = focus[row.faction] || {};
        const id = String(atk[0].target);
        focus[row.faction][id] = (focus[row.faction][id] || 0) + 1;
      } else holds += 1;
    }
    for (const ev of state.strategy.events.slice(before)) {
      const m = /遂克(.+)。/.exec(ev.text);
      if (m) flips[m[1]] = (flips[m[1]] || 0) + 1;
    }
  }
  const worst = Object.entries(flips).sort((a, b) => b[1] - a[1])[0];
  assert.ok(holds >= 40, `按兵太少（${holds}），还是每个月都在硬打`);
  assert.ok(attacks >= 8, `二十个月几乎没人出征（${attacks}）`);
  assert.ok(!worst || worst[1] <= 6, `${worst ? worst[0] : ''} 被攻陷 ${worst ? worst[1] : 0} 次，仍在来回易手`);
  for (const f of conf.factions) {
    const bag = focus[f.id] || {};
    const total = Object.values(bag).reduce((s, n) => s + n, 0);
    const top = Math.max(0, ...Object.values(bag));
    if (total >= 8) assert.ok(top / total <= 0.6, `${f.name} 有 ${(top / total * 100).toFixed(0)}% 的出征打同一座城`);
  }
  const home = strategyMap().cities.find((c) => c.name === conf.playerHome);
  const playerLost = state.strategy.cities[home.id].owner !== 'player'
    && (flips[home.name] || 0) > 3;
  assert.equal(playerLost, false, '玩家本城被反复当成软柿子');
});
