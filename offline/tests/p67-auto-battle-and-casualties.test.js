/**
 * P67（2026-11-27）出征重构回归：
 *  - 相遇 / 抵城自动开战，不再需要玩家点第二下「确认开战」；
 *  - 相遇的诸侯军并入守军，已入城的援军不重复计算；
 *  - 折损拆阵亡 / 负伤，伤兵按周边城 + 出生城回撤；
 *  - 注入 UI 不再出现手动开战按钮，战况页显示伤兵去向。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, chooseOath, oathOptions, marchableFrom,
  strategyAttack, strategyResolveMarches, strategyViewState,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { splitCasualties, routeWounded, WOUNDED_RATE } from '../server/domain/casualties.js';
import { consumeEncounterDefense } from '../server/domain/encounter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(resolve(ROOT, p), 'utf8');

function mkCtx(state, cfg = loadConfig()) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}

function fresh() {
  const cfg = loadConfig();
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const lord = oathOptions(s).lords.find((l) => l.cities.length >= 2) || oathOptions(s).lords[0];
  const r = chooseOath(s, cfg, mkCtx(s, cfg), { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true);
  return { s, cfg };
}

test('P67-A 折损拆分：一部分阵亡、一部分负伤，逐槽守恒', () => {
  const c = splitCasualties({ lossBySlot: [10, 5, 1] });
  assert.equal(c.totalLoss, 16);
  assert.equal(c.totalWounded, Math.floor(10 * WOUNDED_RATE) + Math.floor(5 * WOUNDED_RATE) + Math.floor(1 * WOUNDED_RATE));
  assert.ok(c.totalWounded > 0, '必须有一部分只是负伤');
  assert.equal(c.totalKilled + c.totalWounded, c.totalLoss, '阵亡 + 负伤 = 折损');
  assert.deepEqual(c.woundedBySlot.map((n, i) => n + c.killedBySlot[i]), c.loss);
});

test('P67-B 伤兵回撤：出生城与周边最近己方城都收，人数守恒', () => {
  const { s } = fresh();
  const st = s.strategy;
  const own = Object.keys(st.cities).map(Number).filter((id) => st.cities[id].owner === 'player');
  assert.ok(own.length >= 2, '需要至少两座己方城才能验证周边城回撤');
  const home = own[0];
  const near = own[1];
  const battle = Number(Object.keys(st.cities).find((id) => st.cities[id].owner !== 'player')) || near;
  const mapCities = Object.keys(st.cities).map(Number).map((id) => ({
    id, name: `城${id}`, x: id * 10, y: 0,
  }));
  const beforeHome = st.cities[home].troops || 0;
  const beforeNear = st.cities[near].troops || 0;
  const routed = routeWounded(s, {
    wounded: [24, 16, 0], fromCityId: home, battleCityId: battle, mapCities,
  });
  const total = routed.reduce((n, w) => n + w.count, 0);
  assert.equal(total, 40, '伤兵不能凭空消失');
  assert.ok(routed.some((w) => w.cityId === home), '出生城必须能收伤兵');
  assert.ok((st.cities[home].troops || 0) > beforeHome || (st.cities[near].troops || 0) > beforeNear);
});

test('P67-C 相遇并兵：敌军并入守军；已入城援军不重复结算', () => {
  const { s } = fresh();
  const st = s.strategy;
  const mm = { id: 7, side: 'player', to: 10, arriveDay: 8 };
  st.marches = [
    { id: 8, side: 'faction', kind: 'assault', to: 10, arriveDay: 9, troops: 600, resolved: false },
    { id: 9, side: 'faction', kind: 'relief', to: 10, arriveDay: 9, troops: 500, resolved: false, reliefMerged: true },
  ];
  const r = consumeEncounterDefense(s, mm);
  assert.equal(r.troops.reduce((n, v) => n + v, 0), 600, '只并相遇且未入城的那支敌军');
  assert.equal(r.met.length, 1);
  assert.equal(st.marches[0].consumedByBattle, 7);
  assert.equal(st.marches[0].resolved, true);
  assert.equal(st.marches[1].resolved, false, '已入城援军由城池驻军计算，不能被这里再吃掉');
});

test('P67-D 抵达自动开战：无待决、直接战报；伤兵去向进战报', () => {
  const { s, cfg } = fresh();
  const st = s.strategy;
  const own = Object.entries(st.cities).filter(([, v]) => v.owner === 'player').map(([id]) => Number(id));
  let picked = null;
  for (const from of own) {
    const to = marchableFrom(from, s).find((id) => st.cities[id]?.owner !== 'player');
    if (!to) continue;
    const army = s.armys.find((a) => !a.marchId && (a.soldiers || []).some((v) => v > 0));
    if (!army) break;
    army.cityId = from;
    army.soldiers = [1200, 0, 0];
    army.generals = [s.generals[0].id, 0, 0];
    picked = { from, to, army };
    break;
  }
  assert.ok(picked, '需要一组可打的出发城/目标城');
  const ctx = mkCtx(s, cfg);
  const atk = strategyAttack(s, cfg, ctx, {
    cityId: picked.to, fromCityId: picked.from, armyId: picked.army.id, frac: 1,
  });
  assert.equal(atk.ok, true, JSON.stringify(atk));
  const mm = st.marches.find((m) => m.id === atk.marchId);
  /* 一支同指目标城、晚一天到的敌军：应被判定为相遇并并进守军 */
  st.marches.push({
    id: 9902, side: 'faction', kind: 'assault', from: picked.from, to: picked.to,
    departDay: Math.max(1, atk.arriveDay - 3), arriveDay: atk.arriveDay + 1,
    troops: 400, factionName: '曹军',
  });
  s.clock.day = atk.arriveDay;
  const reports0 = s.warReports.length;
  strategyResolveMarches(s, cfg, ctx);
  assert.equal(s.warReports.length, reports0 + 1, '抵达当次结算就应写战报');
  const rep = s.warReports[0];
  assert.equal(rep.analysis.auto, true);
  assert.equal(rep.analysis.killed + rep.analysis.wounded, rep.analysis.aLoss);
  assert.ok((rep.analysis.woundedTo || []).length > 0, '负伤者必须有回撤城');
  assert.ok((rep.analysis.encounter || []).some((e) => e.name === '曹军'), '相遇敌军应并进这一仗');
  assert.equal(mm.pendingBattle, false);
  assert.equal(picked.army.marchId, undefined, '结算后队伍必须解锁');
  assert.equal(strategyViewState(s, cfg).pendingBattles.length, 0);
  assert.ok(strategyViewState(s, cfg).autoBattles.length > 0, '战况页要能拿到自动接战记录');
});

test('P67-E 注入 UI：不再有手动开战按钮，战况页展示伤兵去向', () => {
  const skills = src('server/skills.js');
  const hd = src('server/handlers.js');
  assert.ok(!/act\('开战'/.test(skills), '沙盘军标弹窗不能再让玩家点开战');
  assert.ok(!/mkBtn\('确认开战'/.test(skills), '遭遇页不能再有确认开战按钮');
  assert.ok(!/mkBtn\('临阵收兵'/.test(skills), '抵达城下不能再有临阵收兵');
  assert.match(skills, /autoBattles/, '战况页必须读自动接战投影');
  assert.match(skills, /伤兵去向/, '战况页必须显示伤兵去了哪座城');
  assert.match(hd, /routeWounded/, '本地清剿也要走同一套伤兵回撤口径');
});
