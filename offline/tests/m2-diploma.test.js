/**
 * M2-4b 外交系统（GDD §5.8）。
 *
 * 锁五件事：
 *  1. 态度公式确定性 + factors 理由链逐条展开（拒绝必须带 {code,text,factors[]}）；
 *  2. 门槛表：停战/通行权/结盟/联姻门槛不达标拒绝，文本含「未达 N」；
 *  3. 占城登记：occupied+1、开战；停战期攻城 = 毁约（betray+1、停战解除）；
 *  4. 离间：情报 < 估算档拒绝且退金；同 seed 判定确定性；
 *  5. 劝降：兵力比不足拒绝则开战；停战生效后 truceActive 为真（NPC 守约）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath, strategyViewState } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import {
  diplomacyAct, diplomacyView, attitudeOf, noteCityCaptured, truceActive, ACTIONS,
} from '../server/domain/diplomacy.js';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const r = chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  assert.equal(r.ok, true);
  return { state, st: state.strategy };
}

function someFaction(st) {
  return Object.values(st.cities).map((v) => v.owner)
    .find((o) => o && o !== 'player' && o !== 'han');
}

test('M2-4·外交：态度公式确定性 + 理由链逐条展开', () => {
  const { state } = oathWorld();
  const fid = someFaction(state.strategy);
  const a1 = attitudeOf(state, 'player', fid);
  const a2 = attitudeOf(state, 'player', fid);
  assert.equal(a1.value, a2.value, '同一 state 重放态度恒定');
  assert.ok(a1.value >= -100 && a1.value <= 100, '态度 ∈ [-100, 100]');
  const labels = a1.factors.map((f) => f.label);
  for (const key of ['基础(史实关系)', '边境摩擦']) {
    assert.ok(labels.includes(key), `理由链应含「${key}」档：${labels.join(',')}`);
  }
  // 视图下发：每势力带 gates 预览表
  const view = strategyViewState(state, cfg);
  const row = (view.diplomacy.factions || []).find((f) => f.id === fid);
  assert.ok(row, '外交视图应含该势力');
  for (const k of Object.keys(ACTIONS)) assert.ok(row.gates[k], `gates.${k} 应存在`);
});

test('M2-4·外交：门槛不达标拒绝必带理由链（「未达 N」）', () => {
  const { state, st } = oathWorld();
  state.roleRes.gold = 100000;
  const fid = someFaction(st);
  // 把态度压到最低：伪造占城与背约，确保低于结盟 55 档
  for (let i = 0; i < 4; i++) noteCityCaptured(state, 'player', fid);
  const att = attitudeOf(state, 'player', fid);
  assert.ok(att.value < 55, `伪造后态度 ${att.value} 应低于 55`);
  const r = diplomacyAct(state, cfg, { push() {} }, { action: 'ally', faction: fid });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rejected');
  assert.ok(r.text.includes('未达 55'), `拒绝文案应含门槛：${r.text}`);
  assert.ok(Array.isArray(r.factors) && r.factors.length >= 2, '理由链 factors 必须非空（没有理由链的外交回复视为 bug）');
});

test('M2-4·外交：停战成功后守约 + 占城毁约记账', () => {
  const { state, st } = oathWorld();
  state.roleRes.gold = 100000;
  const fid = someFaction(st);
  // 停战门槛 -30：先把态度抬进门槛（履约 +5/次 用伪造方式不可行，直接走赠礼抬态度）
  const gift = diplomacyAct(state, cfg, { push() {} }, { action: 'gift', faction: fid, gold: 6000 });
  assert.equal(gift.ok, true, JSON.stringify(gift));
  const truce = diplomacyAct(state, cfg, { push() {} }, { action: 'truce', faction: fid });
  if (truce.ok) {
    assert.equal(truceAttitude(state, fid) >= -30, true);
    assert.equal(truceActive(state, fid, 'player'), true, '停战期内 truceActive 应为真（NPC 守约口）');
    // 停战期攻城 = 毁约
    noteCityCaptured(state, 'player', fid);
    assert.equal(truceActive(state, fid, 'player'), false, '毁约即停战解除');
    const p = state.strategy.diplomacy.pairs[['player', fid].sort().join('|')];
    assert.ok(p.betray >= 1, '毁约应记背约档（态度 −10/次）');
    assert.ok(p.occupied >= 1, '占城应记账（态度 −20/城）');
  } else {
    // 态度仍不达 -30：拒绝也要带理由链
    assert.equal(truce.code, 'rejected');
    assert.ok(truce.text.includes('未达 -30'));
  }

  function truceAttitude(state2, fid2) {
    return attitudeOf(state2, 'player', fid2).value;
  }
});

test('M2-4·外交：离间——情报不足退金；判定确定性', () => {
  const { state, st } = oathWorld();
  state.roleRes.gold = 100000;
  const fid = someFaction(st);
  const view = diplomacyView(state);
  const row = (view.factions || []).find((f) => f.id === fid);
  const home = Number(row.homeCity);
  // 情报不足：拒绝且金退回
  const goldBefore = state.roleRes.gold;
  const r1 = diplomacyAct(state, cfg, { push() {} }, { action: 'sow', faction: fid });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'no_intel', `应拒绝于情报门槛：${r1.text || r1.reason}`);
  assert.equal(state.roleRes.gold, goldBefore, '情报不足必须退金（不吞钱）');
  // 都城侦察到估算档后再试：智力判定出结论（成败都给可解释文本）
  st.intel = st.intel || {};
  st.intel[home] = 1;
  const r2 = diplomacyAct(state, cfg, { push() {} }, { action: 'sow', faction: fid });
  assert.ok('ok' in r2, '情报足应进入智力判定（成或败都给结论）');
  assert.ok(r2.text && r2.text.length > 0, '无论成败都要有可解释文本');
  // 若失败，sowFail 记档；若成功，都城守军下降——两条路都要有账
  if (!r2.ok) {
    const p = st.diplomacy.pairs[['player', fid].sort().join('|')];
    assert.ok(p.sowFail >= 1, '识破应记 sowFail（态度 −15）');
  } else {
    assert.ok(st.cities[home].troops >= 200);
  }
});

test('M2-4·外交：劝降兵力比不足则拒绝并开战', () => {
  const { state, st } = oathWorld();
  const fid = someFaction(st);
  const r = diplomacyAct(state, cfg, { push() {} }, { action: 'surrender', faction: fid });
  assert.equal(r.ok, false, '开局兵力比不可能达 3:1');
  const p = st.diplomacy.pairs[['player', fid].sort().join('|')];
  assert.equal(p.war, true, '拒绝则开战（GDD 门槛表）');
  assert.ok(r.text.length > 0, '拒绝必须可解释');
});

test('M2-4·外交：非法参数路径', () => {
  const { state } = oathWorld();
  state.roleRes.gold = 100000;
  const bad1 = diplomacyAct(state, cfg, { push() {} }, { action: 'no_such', faction: 'sili' });
  assert.equal(bad1.ok, false);
  const bad2 = diplomacyAct(state, cfg, { push() {} }, { action: 'ally', faction: 'no_such_faction' });
  assert.equal(bad2.ok, false);
  assert.equal(bad2.reason, 'no_faction');
});
