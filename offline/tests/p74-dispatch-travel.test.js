/**
 * P74 回归闸：武将调遣从「瞬移」改成「启程 → 在途 → 抵达」。
 *
 * 玩家原话（2026-11-27）：「武将调遣，从一个城池调遣到另外一个城池，调遣过程你只是
 * 下达了一个任务，应该在结束本回合内政结束时触发调遣动作，武将移动动画动作」。
 *
 * 旧实现 `applyDispatch()` 当场改 `g.cityId`，地图上什么都没有；
 * 现在写一条 `kind:'dispatch'` 的行军牌（客户端复用插值画棋子），
 * 武将挂 `g.transit` 在途，`dispatchTick()` 在旬界抵达日才落城。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath,
  dispatchGeneral, dispatchGenerals, dispatchTick, strategyResolveMarches,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { formationGeneralCheck } from '../server/domain/formation.js';
import { governorCandidates } from '../server/domain/governor.js';

const cfg = loadConfig();

function world() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const pushes = [];
  const ctx = {
    state: s, cfg, pushes, options: {},
    push(n, m) { pushes.push({ n, m }); },
    schedule() {}, save() {}, log() {},
  };
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  assert.ok(lords.length, '至少要有两座城的势力才能测调遣');
  assert.equal(chooseOath(s, cfg, ctx, { lord: lords[0].id, city: lords[0].cities[0].id }).ok, true);
  const mine = Object.keys(s.strategy.cities)
    .filter((id) => s.strategy.cities[id].owner === 'player').map(Number);
  assert.ok(mine.length >= 2, '玩家需要至少两座城');
  const from = mine[0];
  const to = mine[1];
  const g = (s.generals || []).find((x) => Number(x.cityId) === from && !x.isProtagonist) || (s.generals || [])[0];
  assert.ok(g, '出发城要有武将');
  g.cityId = from;
  s.clock.day = 1;
  return { s, ctx, from, to, g, pushes };
}

test('P74-D1 调遣是「启程」不是「瞬移」：驻地不变、挂上在途、地图出一条行程', () => {
  const { s, ctx, from, to, g } = world();
  const r = dispatchGeneral(s, cfg, ctx, { generalId: g.id, toCityId: to });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transit, true, '必须回「在途」而不是「已到达」');
  assert.ok(r.marchDays >= 1, '必须算出行程天数');
  assert.equal(Number(g.cityId), from, '下达当天人还没走，驻地不改');
  assert.ok(g.transit && g.transit.to === to, '武将必须进入在途态');
  const card = (s.strategy.marches || []).find((mm) => mm.kind === 'dispatch');
  assert.ok(card, '地图上必须有一条可见行程牌');
  assert.equal(card.side, 'player');
  assert.equal(card.troops, 0, '调遣不带兵，不能画成大军');
  assert.equal(card.arriveDay, 1 + r.marchDays);
});

test('P74-D2 在途期间不可出征、不可再调、不可任太守', () => {
  const { s, ctx, from, to, g } = world();
  dispatchGeneral(s, cfg, ctx, { generalId: g.id, toCityId: to });

  const again = dispatchGeneral(s, cfg, ctx, { generalId: g.id, toCityId: from });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'in_transit', '同一人不能被派两次');

  const f = formationGeneralCheck(s, { generalId: g.id, cityId: from });
  assert.equal(f.ok, false, '在途武将不能被编进出征队伍');
  assert.equal(f.reason, 'in_transit');

  const cands = governorCandidates(s, cfg, from).map((c) => Number(c.id));
  assert.ok(!cands.includes(Number(g.id)), '在途武将不该出现在太守候选里');
});

test('P74-D3 抵达日才落城：驻地改到目标城、行程牌收束、军情留痕', () => {
  const { s, ctx, to, g } = world();
  const r = dispatchGeneral(s, cfg, ctx, { generalId: g.id, toCityId: to });
  s.clock.day = r.arriveDay - 1;
  assert.equal(dispatchTick(s, cfg, ctx).length, 0, '差一天不许提前落城');

  s.clock.day = r.arriveDay;
  const out = dispatchTick(s, cfg, ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'dispatch-arrive');
  assert.equal(Number(g.cityId), to, '抵达日必须真的落到目标城');
  assert.equal(g.transit, undefined, '在途标记要清掉');
  const card = (s.strategy.marches || []).find((mm) => mm.kind === 'dispatch');
  assert.equal(card.resolved, true, '行程牌要收起来，不能留一个鬼影');
  const ev = (s.strategy.events || []).map((e) => e.text).join('|');
  assert.ok(/抵达/.test(ev), `军情要留「抵达」，实际 ${ev.slice(-80)}`);
});

test('P74-D4 目标城易主则半路折返：人不许凭空蒸发', () => {
  const { s, ctx, from, to, g } = world();
  const r = dispatchGeneral(s, cfg, ctx, { generalId: g.id, toCityId: to });
  s.strategy.cities[to].owner = 'youzhou';
  s.clock.day = r.arriveDay;
  const out = dispatchTick(s, cfg, ctx);
  assert.equal(out[0].kind, 'dispatch-abort');
  assert.equal(Number(g.cityId), from, '折返原城');
  assert.equal(g.transit, undefined);
});

test('P74-D5 调遣牌不进战斗结算：行军解析必须放过它', () => {
  const { s, ctx, to, g } = world();
  dispatchGeneral(s, cfg, ctx, { generalId: g.id, toCityId: to });
  const reports = (s.warReports || []).length;
  s.clock.day = 40;
  strategyResolveMarches(s, cfg, ctx);
  assert.equal((s.warReports || []).length, reports, '调遣不许产出战报');
  assert.equal(Number(g.cityId) !== to || g.transit, true, '行军解析不得替 dispatchTick 落城');
});

test('P74-D6 批量调遣同目标：各按距离算天数，最迟的那天统一到位', () => {
  const { s, ctx, to, g } = world();
  const more = (s.generals || []).filter((x) => Number(x.cityId) === Number(g.cityId) && x.id !== g.id).slice(0, 2);
  const ids = [g.id, ...more.map((x) => x.id)];
  const r = dispatchGenerals(s, cfg, ctx, { generalIds: ids, toCityId: to });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transit, true);
  assert.ok(r.marchDays >= 1);
  for (const id of ids) {
    const gg = s.generals.find((x) => Number(x.id) === Number(id));
    assert.ok(gg.transit, `${id} 必须在途`);
    assert.notEqual(Number(gg.cityId), to, '当天不许瞬移到位');
  }
  s.clock.day = r.marchDays + 1;
  dispatchTick(s, cfg, ctx);
  for (const id of ids) {
    const gg = s.generals.find((x) => Number(x.id) === Number(id));
    assert.equal(Number(gg.cityId), to, `${id} 应在抵达日到位`);
  }
});
