/**
 * P54（2026-11-24）编队同城与选将回归：
 *  1. 征兵页候选武将由服务端按当前城下发，界面不再列出他城/在编武将；
 *  2. 六府整编弹窗只列队伍驻城武将，同弹窗内一人不占两槽；
 *  3. 两个编队入口共用 formationGeneralCheck：跨城、跨队占用一律拒绝；
 *  4. general.myGenerals 新增可选 cityId，g.order 编队后统一重算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyFormup,
} from '../server/domain/strategy.js';
import { formationGeneralCheck } from '../server/domain/formation.js';

const cfg = loadConfig();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
function fresh() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(s, cfg, mkCtx(s), { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  const from = Number(s.strategy.playerCity);
  const to = Number(Object.entries(s.strategy.cities)
    .find(([id, c]) => c.owner === 'player' && Number(id) !== from)?.[0]);
  assert.ok(Number.isFinite(to) && to > 0, '前提：举义后至少两座己方城');
  return { s, from, to };
}

test('P54-① 候选来源：征兵页按城请求，两个编队 UI 都挡在编/他城武将', () => {
  const skill = read('server/skills.js');
  assert.match(skill, /send\('general\.myGenerals', \{ cityId: cid \}\)/, '候选名单带着当前城请求');
  assert.match(skill, /Number\(g\.cityId\) === Number\(cid\)/, '旧缓存也不能露出别城武将');
  assert.match(skill, /o\.disabled = busy/);
  assert.match(skill, /编队只认本城武将，且一人只在一队/);
  assert.match(skill, /general_other_city: '该武将不在本城/, '英文 reason 有中文兜底');

  const ui = read('server/panels-ui.js');
  assert.match(ui, /Number\(g\.cityId\) === armyCity/, '整编下拉只列队伍驻城武将');
  assert.match(ui, /data-busy=/);
  assert.match(ui, /cur\.ids\.some\(function \(v, i\) \{ return i !== slot && v === id; \}\)/,
    '同一弹窗内同一武将不能占两个槽');
  assert.match(ui, /已隐藏他城武将/);
  assert.match(ui, /general_other_city: '该武将不在本队驻城/, '整编失败原因中文');

  const view = read('server/domain/panels.js');
  assert.match(view, /cityId: int\(a\.cityId, 0\)/, '队伍驻城必须下发到整编弹窗');
});

test('P54-② 领域判据：同城可编、跨城拒绝、跨队占用拒绝', () => {
  const { s, from, to } = fresh();
  const pool = s.generals.filter((g) => Number(g.cityId) === from);
  assert.ok(pool.length >= 2, '前提：本城至少两名武将');
  const g = pool[0];
  const homeArmy = s.armys.find((a) => (a.generals || []).includes(g.id));
  assert.ok(homeArmy, '前提：该武将已在某支队伍');

  const ok = formationGeneralCheck(s, { generalId: g.id, cityId: from, armyId: homeArmy.id });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.general.id, g.id);

  pool[1].cityId = to;
  const cross = formationGeneralCheck(s, { generalId: pool[1].id, cityId: from });
  assert.equal(cross.ok, false);
  assert.equal(cross.reason, 'general_other_city');
  assert.equal(cross.generalCityId, to);

  s.armys.push({ id: 90054, cityId: from, order: 3, generals: [g.id, 0, 0], soldiers: [0, 0, 0] });
  const busy = formationGeneralCheck(s, { generalId: g.id, cityId: from, armyId: s.armys[0].id });
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'in_other_army');
  assert.equal(busy.armyId, 90054);
});

test('P54-③ general.myGenerals 可选 cityId：征兵候选只含本城，武将页不带参仍是全量', () => {
  const { s, from } = fresh();
  const ctx = mkCtx(s);
  const moved = s.generals[1];
  moved.cityId = from === 1 ? 2 : 1;

  const here = handleRequest(ctx, req('general.myGenerals', { cityId: from }));
  assert.equal(here.code, 0);
  const ids = here.msg.generals.map((g) => g.id);
  assert.equal(ids.includes(moved.id), false, '他城武将不得进入征兵候选');
  assert.ok(ids.length > 0 && ids.length < s.generals.length);

  const all = handleRequest(ctx, req('general.myGenerals', {}));
  assert.equal(all.msg.generals.length, s.generals.length, '不带 cityId 仍是全量名单');
});

test('P54-④ army.dispose：跨城武将编队被拒，状态零改动', () => {
  const { s, from, to } = fresh();
  const ctx = mkCtx(s);
  const army = s.armys.find((a) => a.cityId === from && a.order === 1) || s.armys[0];
  const before = JSON.stringify(army.generals);
  const g = s.generals.find((x) => Number(x.cityId) === from);
  g.cityId = to;

  const r = handleRequest(ctx, req('army.dispose', {
    cityId: from, order: army.order, position: 1, generalId: g.id,
  }));
  assert.equal(r.code, 1);
  assert.equal(r.msg.reason, 'general_other_city');
  assert.equal(JSON.stringify(army.generals), before, '拒绝后队伍槽位不动');
});

test('P54-⑤ army.dispose：已在别队的武将不得再次编队', () => {
  const { s, from } = fresh();
  const ctx = mkCtx(s);
  const holder = s.armys.find((a) => (a.generals || []).some((id) => Number(id) > 0));
  const gid = (holder.generals || []).find((id) => Number(id) > 0);
  assert.ok(gid, '前提：有在编武将');
  let target = s.armys.find((a) => a.id !== holder.id);
  if (!target) {
    target = { id: 90055, cityId: from, order: [1, 2, 3].find((o) => !s.armys.some((a) => a.order === o)), generals: [0, 0, 0], soldiers: [0, 0, 0] };
    s.armys.push(target);
  }
  const before = JSON.stringify(target.generals);

  const r = handleRequest(ctx, req('army.dispose', {
    cityId: from, order: target.order, position: 0, generalId: gid,
  }));
  assert.equal(r.code, 1, JSON.stringify(r.msg));
  assert.equal(r.msg.reason, 'in_other_army');
  assert.equal(JSON.stringify(target.generals), before, '目标队槽位不动');
  assert.equal(holder.generals.includes(gid), true, '原队仍持有该武将');
});

test('P54-⑥ strategyFormup：跨城武将被拒，合法换将后 order 同步重算', () => {
  const { s, from, to } = fresh();
  const ctx = mkCtx(s);
  const army = s.armys[0];
  const cityId = Number(army.cityId) || from;
  const pool = s.generals.filter((g) => Number(g.cityId) === cityId).slice(0, 3);
  assert.ok(pool.length >= 3, '前提：驻城至少三名武将');
  const before = JSON.stringify(army.generals);
  const total = (army.soldiers || []).reduce((a, b) => a + b, 0);
  const one = Math.floor(total / 3);
  const troops = [one, one, total - one * 2];
  const gids = pool.map((g) => g.id);

  pool[0].cityId = to;
  const bad = strategyFormup(s, cfg, ctx, { armyId: army.id, generals: gids, soldiers: troops });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'general_other_city');
  assert.equal(JSON.stringify(army.generals), before, '拒绝后队伍槽位不动');
  pool[0].cityId = cityId;

  const ok = strategyFormup(s, cfg, ctx, { armyId: army.id, generals: gids, soldiers: troops });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  for (let i = 0; i < 3; i += 1) assert.equal(pool[i].order, army.order, 'g.order 是队伍编号的派生字段');
});
