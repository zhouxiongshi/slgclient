/**
 * 内政只保留能回到粮、金、兵、城防、人口的六项。
 * 兴学、招抚、屯田、练兵、修路、侦察、离间已从任务表删除，旧档里还在办的单直接取消。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyInvest,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { KINDS, advanceInteriorTasks } from '../server/domain/interior-task.js';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  state.roleRes.gold = 100000;
  return { state, st: state.strategy };
}

function ownFirst(st) {
  return Number(Object.keys(st.cities).find((id) => st.cities[id].owner === 'player'));
}

test('内政任务只剩六项，砍掉的种类不能再派', () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ['agri', 'barracks', 'defense', 'populate', 'relief', 'trade']);
  const { state, st } = oathWorld();
  const cid = ownFirst(st);
  for (const kind of ['study', 'appease', 'tuntian', 'drill', 'road', 'scout', 'sow']) {
    const r = strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind });
    assert.equal(r.ok, false, kind);
    assert.equal(r.reason, 'bad_kind', kind);
  }
});

test('开垦仍按旬把农田加上去', () => {
  const { state, st } = oathWorld();
  const cid = ownFirst(st);
  st.cityEcon[cid].devAgri = 40;
  const r = strategyInvest(state, cfg, { push() {} }, { cityId: cid, kind: 'agri' });
  assert.equal(r.ok, true, JSON.stringify(r));
  state.clock.day += 40;
  const done = advanceInteriorTasks(state, cfg, { push() {} });
  assert.ok(done.completed.some((t) => t.kind === 'agri'));
  assert.ok(st.cityEcon[cid].devAgri > 40);
});

test('旧档里还在办的兴学单会被取消，不再改酒馆', () => {
  const { state, st } = oathWorld();
  const cid = ownFirst(st);
  st.interiorTasks = [{
    id: 'it-old', kind: 'study', cityId: cid, cityName: '旧城', startDay: 1,
    ticks: 3, perTick: 0, total: 0, status: 'active', ticksDone: 0,
    officerName: '无专员', officerStat: 0, cost: 600, cancelable: true,
  }];
  state.clock.day = 40;
  const done = advanceInteriorTasks(state, cfg, { push() {} });
  assert.equal(st.interiorTasks[0].status, 'cancelled');
  assert.equal(st.interiorTasks[0].reason, '这项内政已取消');
  assert.equal(state.tavern.studyBonus, undefined);
  assert.ok(done.completed.some((t) => t.cancelled));
});
