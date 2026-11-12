/**
 * 开局举义（P4-①）：择主定都、初始武将团、势力特技、旧档兼容。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import {
  ensureStrategy, strategyViewState, oathOptions, chooseOath,
  strategyMap, marchableFrom, strategyAttack,
} from '../server/domain/strategy.js';
import { oathPending, oathOf, factionTraitOf } from '../server/domain/oath.js';
import { ensureTavern } from '../server/domain/tavern.js';
import { yieldBonusByResource } from '../server/domain/panels.js';
import { applyDays, countSoldiers } from '../server/domain/economy.js';

const cfg = loadConfig();
const map = strategyMap();
const cityByName = (name) => map.cities.find((c) => c.name === name);
const generalName = (cfgId) => cfg.generalByCfg.get(Number(cfgId))?.name || '';

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, options: {}, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    schedule() {}, save() {}, log() {},
  };
}

test('新档未举义：面板/视图下发 done=false，默认锚城不被夺走', () => {
  const state = createWorld(cfg);
  const st = ensureStrategy(state);
  assert.equal(oathPending(state), true);
  const view = strategyViewState(state);
  assert.equal(view.oath.done, false);
  const home = cityByName('相');
  assert.equal(st.playerCity, home.id);
  assert.notEqual(st.cities[home.id].owner, 'player');
});

test('旧档无 oath 字段：视为已举义，默认城照旧归玩家，绝不弹页', () => {
  const state = createWorld(cfg);
  delete state.oath;
  const st = ensureStrategy(state);
  assert.equal(oathOf(state).done, true);
  const view = strategyViewState(state);
  assert.equal(view.oath.done, true);
  const home = cityByName('相');
  assert.equal(st.cities[home.id].owner, 'player');
});

test('举义选项：8 家诸侯卡，各 3 座候选都城，武将团 3 人', () => {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const opts = oathOptions(state);
  assert.equal(opts.done, false);
  assert.equal(opts.lords.length, 8);
  for (const l of opts.lords) {
    assert.equal(l.cities.length, 3, `${l.name} 应有 3 座候选城`);
    assert.ok(l.trait.name && l.trait.desc, `${l.name} 应有特技文案`);
    assert.equal(l.generals.length, 3, `${l.name} 应有 3 员初始武将`);
    for (const c of l.cities) {
      assert.ok(cityByName(c.name), `候选城 ${c.name} 必须在图上`);
      assert.ok(['沃野型', '雄关型', '僻壤型'].includes(c.type));
    }
  }
});

test('择主定都：曹操名下城池尽归玩家，初始武将团入营，酒馆同步已招募', () => {
  const state = createWorld(cfg);
  ensureStrategy(state);
  ensureTavern(state, cfg);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  const cap = cao.cities.find((c) => c.name === '濮阳') || cao.cities[0];
  const r = chooseOath(state, cfg, makeCtx(state), { lord: cao.id, city: cap.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lordName, '曹操');
  assert.equal(state.oath.done, true);
  const st = state.strategy;
  assert.equal(st.playerCity, cap.id);
  // 原兖州诸侯名下所有城易帜
  for (const c of map.cities) {
    if (c.provinceId === cao.id) assert.equal(st.cities[c.id].owner, 'player');
  }
  assert.notEqual(st.cities[cityByName('长安').id].owner, 'player');
  // 初始武将团 3 员入营（主角之外）
  const names = state.generals.map((g) => generalName(g.cfgId));
  for (const n of cao.generals) assert.ok(names.includes(n), `${n} 应入营`);
  assert.equal(state.generals.length, 1 + cao.generals.length);
  // 酒馆池同步标记，避免之后在酒馆再招到同一人
  for (const p of state.tavern.people) {
    if (cao.generals.includes(p.name)) assert.equal(p.recruited, true);
  }
  // 技能登记表更新：主角自带战法仍在册，新武将自带战法入册
  //（个别 innate 不在技能库配置里时按酒馆招募同一口径跳过）
  const regIds = new Set(state.skills.map((s) => Number(s.cfgId)));
  assert.ok(regIds.has(19001), '主角自带战法 19001 应保留在册');
  assert.ok(state.skills.length >= 2, '新武将自带战法应入册');
  assert.ok(state.skills.every((s) => Array.isArray(s.generals) && s.generals.length > 0));
});

test('势力特技：曹操商税金 +15% 计入产量加成表', () => {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  chooseOath(state, cfg, {}, { lord: cao.id, city: cao.cities[0].id });
  assert.equal(yieldBonusByResource(state).gold, 15);
});

test('势力特技：公孙瓒军饷 -20%', () => {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const gz = oathOptions(state).lords.find((l) => l.name === '公孙瓒');
  chooseOath(state, cfg, {}, { lord: gz.id, city: gz.cities[0].id });
  const soldiers = countSoldiers(state);
  // 与真实链路同口径：campaign.js 把 factionTraitOf(state).upkeepPct 并进 applyDays 的 rules
  assert.equal(factionTraitOf(state).upkeepPct, -20);
  const r = applyDays(state, cfg, 1, { upkeepPerSoldier: 1, upkeepPct: -20 });
  assert.equal(r.upkeepPaid, Math.floor(soldiers * 0.8));
});

test('势力特技：吕布行军快一日抵达', () => {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const lv = oathOptions(state).lords.find((l) => l.name === '吕布');
  chooseOath(state, cfg, makeCtx(state), { lord: lv.id, city: lv.cities[0].id });
  const st = state.strategy;
  const targetId = marchableFrom(st.playerCity)
    .find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  assert.ok(targetId, '吕布都城应有可出征的邻城');
  state.clock.day = 5;
  const r = strategyAttack(state, cfg, makeCtx(state), { cityId: targetId });
  assert.equal(r.ok, true, JSON.stringify(r));
  const m = st.marches[st.marches.length - 1];
  assert.equal(m.arriveDay - m.departDay, 1);
});

test('举义拒绝：城不属于该诸侯、重复举义都无效', () => {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  const bad = chooseOath(state, cfg, {}, { lord: cao.id, city: cityByName('长安').id });
  assert.equal(bad.ok, false);
  assert.equal(oathPending(state), true);
  chooseOath(state, cfg, {}, { lord: cao.id, city: cao.cities[0].id });
  const again = chooseOath(state, cfg, {}, { lord: cao.id, city: cao.cities[0].id });
  assert.equal(again.ok, false);
});
