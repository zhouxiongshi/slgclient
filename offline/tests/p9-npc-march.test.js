/**
 * P9 诸侯行军可见性（U12）：诸侯来犯必须在地图上变成一支「能被看见、能被读 ETA」的队伍，
 * 且时长口径与玩家共用 marchDaysBy（按里程/速度），到达只标记 resolved，不重复开打。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, oathOptions, chooseOath, spawnFactionAssault,
  strategyViewState, strategyResolveMarches, marchKmBetween, marchDaysBy,
  factionConf,
} from '../server/domain/strategy.js';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const lord = lords[0];
  const r = chooseOath(state, cfg, { push() {} }, { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true, '举义应成功');
  return { state, st: state.strategy };
}

test('U12 诸侯来犯：写入 side=faction 的可见行军，里程/速度/ETA 与玩家同口径', () => {
  const { state, st } = oathWorld();
  const me = Object.entries(st.cities).find(([, v]) => v.owner === 'player');
  const targetId = Number(me[0]);
  const target = { id: targetId, name: me[1].name || '测试城' };
  // 选一个「仍持有城池」的诸侯（所选君主已转成玩家，不能拿他当敌军）
  const factionIds = new Set(factionConf().factions.map((f) => f.id));
  const foeId = Object.values(st.cities).map((v) => v.owner)
    .find((o) => o !== 'player' && factionIds.has(o));
  const foe = factionConf().factions.find((f) => f.id === foeId);
  assert.ok(foe, '应存在仍持城的诸侯');
  const src = Object.entries(st.cities).find(([id, v]) => v.owner === foe.id);
  assert.ok(src, '应存在该势力治下的城');
  const fromId = Number(src[0]);

  const before = (st.marches || []).length;
  const ctx = { push() {} };
  spawnFactionAssault(state, cfg, ctx, foe, target, 1200, fromId);

  const rows = (st.marches || []).slice(before);
  assert.equal(rows.length, 1, '应新增一条行军实体');
  const row = rows[0];
  assert.equal(row.side, 'faction', '必须标为诸侯方，前端才能用敌红区分');
  assert.equal(row.factionName, foe.name);
  assert.ok(row.troops > 0, '兵力不能是 0（否则 UI 显示成空队）');
  assert.ok(row.km > 0, '应有真实里程');
  assert.equal(row.marchDays, marchDaysBy(row.km, row.speed), '时长必须与玩家共用同一公式');
  assert.equal(row.arriveDay, row.departDay + row.marchDays);

  // 视图层要能读到兵力与番号
  const view = strategyViewState(state, cfg);
  const vrow = (view.marches || []).find((m) => m.id === row.id);
  assert.ok(vrow, '视图应包含诸侯行军');
  assert.equal(vrow.side, 'faction');
  assert.ok(vrow.troops > 0, '视图层兵力不能丢失');
  assert.equal(vrow.factionName, foe.name);
  assert.ok(vrow.remainDays >= 0);
});

test('U12 诸侯行军到达：只标记 resolved，不重复开战、不改城归属', () => {
  const { state, st } = oathWorld();
  const me = Object.entries(st.cities).find(([, v]) => v.owner === 'player');
  const targetId = Number(me[0]);
  const factionIds = new Set(factionConf().factions.map((f) => f.id));
  const foeId = Object.values(st.cities).map((v) => v.owner)
    .find((o) => o !== 'player' && factionIds.has(o));
  const foe = factionConf().factions.find((f) => f.id === foeId);
  const src = Object.entries(st.cities).find(([id, v]) => v.owner === foe.id);
  spawnFactionAssault(state, cfg, { push() {} }, foe, { id: targetId, name: me[1].name || '测试城' }, 900, Number(src[0]));
  const row = st.marches[st.marches.length - 1];
  const ownerBefore = st.cities[targetId].owner;
  const warsBefore = (state.warReports || []).length;

  state.clock.day = row.arriveDay;
  const out = strategyResolveMarches(state, cfg, { push() {} });
  assert.ok(Array.isArray(out));
  assert.equal(row.resolved, true, '到达应标记 resolved（供战报回看）');
  assert.equal(st.cities[targetId].owner, ownerBefore, '诸侯行军不得在此处改城归属');
  assert.equal((state.warReports || []).length, warsBefore, '不得重复开战刷战报');
});
