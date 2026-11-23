/**
 * 物资去处。日产的木铁石粮金会顶满仓库，满了就不再入库。
 * 军工不占这五样仓库，也不每天白送，只能用木铁督造，再拿去升级战法。
 * 石、粮、金另有本城开发度可以吃掉，开发度到 120 为止。
 */

import { recordRes } from './economy.js';
import { ensureCityEcon } from './city-econ.js';

export const JUNGONG_WOOD = 80;
export const JUNGONG_IRON = 40;
export const STONE_PER_JUNGONG = 200;
export const RESERVE_WOOD = 2000;
export const RESERVE_IRON = 1000;
export const RESERVE_STONE = 2000;
export const DEV_CAP = 120;

const INVEST = {
  agri: { field: 'devAgri', res: 'grain', per: 3000, reserve: 5000, label: '农业' },
  trade: { field: 'devTrade', res: 'gold', per: 4000, reserve: 5000, label: '商业' },
  def: { field: 'devDef', res: 'stone', per: 600, reserve: RESERVE_STONE, label: '城防' },
};

const USE = {
  wood: '和铁一起督造军工，也用于征兵和设施',
  iron: '和木一起督造军工，也用于征兵和设施',
  stone: '修本城城防；城防到顶后可折价造成军工',
  grain: '军饷、征兵、城库存粮，也可投入本城农业',
  gold: '招募、内政委派、设施和俸禄，也可投入本城商业。战法不花金',
  decree: '升级设施、颁行提案',
  jungong: '只用于武将战法升级',
};

const LABEL = {
  wood: '木', iron: '铁', stone: '石', grain: '粮', gold: '金', decree: '政令', jungong: '军工',
};

function dayOf(state) {
  return Math.floor(Number(state.clock?.day) || 1);
}

export function ensureJungong(state) {
  if (!state.roleRes) state.roleRes = {};
  const n = Number(state.roleRes.jungong);
  state.roleRes.jungong = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return state.roleRes;
}

function fail(reason, extra = {}) {
  const hints = {
    nothing: '没有可动用的库存',
    not_enough: '材料不够',
    not_own_city: '只能投在自己的城',
    dev_capped: '这项开发度已经到 120',
    bad_field: '不知道投到哪一项',
  };
  return { ok: false, reason, hint: hints[reason] || reason, ...extra };
}

function pushRes(state, ctx) {
  ctx?.push?.('roleRes.push', { ...state.roleRes });
}

/** 80 木 + 40 铁 = 1 军工。drain 时各留 2000 木、1000 铁给征兵。 */
export function craftJungong(state, ctx, { count, drain } = {}) {
  const r = ensureJungong(state);
  const woodHave = Math.floor(Number(r.wood) || 0);
  const ironHave = Math.floor(Number(r.iron) || 0);
  let n = Math.floor(Number(count) || 0);
  if (drain) {
    const woodRoom = Math.max(0, woodHave - RESERVE_WOOD);
    const ironRoom = Math.max(0, ironHave - RESERVE_IRON);
    n = Math.min(Math.floor(woodRoom / JUNGONG_WOOD), Math.floor(ironRoom / JUNGONG_IRON));
  }
  n = Math.max(0, Math.min(n, 20000));
  if (n <= 0) return fail('nothing', { wood: woodHave, iron: ironHave, jungong: r.jungong });
  const wood = n * JUNGONG_WOOD;
  const iron = n * JUNGONG_IRON;
  if (woodHave < wood || ironHave < iron) {
    return fail('not_enough', { needWood: wood, needIron: iron, wood: woodHave, iron: ironHave });
  }
  r.wood -= wood;
  r.iron -= iron;
  r.jungong += n;
  const day = dayOf(state);
  recordRes(state, 'wood', -wood, '督造军工', day);
  recordRes(state, 'iron', -iron, '督造军工', day);
  recordRes(state, 'jungong', n, '督造军工', day);
  pushRes(state, ctx);
  return {
    ok: true, count: n, wood, iron, jungong: r.jungong,
    text: `造成军工 ${n}，用了木 ${wood}、铁 ${iron}。现有军工 ${r.jungong}。`,
  };
}

/** 石的折价口：200 石 = 1 军工，比木铁贵。drain 时留 2000 石。 */
export function smeltStone(state, ctx, { count, drain } = {}) {
  const r = ensureJungong(state);
  const have = Math.floor(Number(r.stone) || 0);
  let n = Math.floor(Number(count) || 0);
  if (drain) n = Math.floor(Math.max(0, have - RESERVE_STONE) / STONE_PER_JUNGONG);
  n = Math.max(0, Math.min(n, 20000));
  if (n <= 0) return fail('nothing', { stone: have, jungong: r.jungong });
  const stone = n * STONE_PER_JUNGONG;
  if (have < stone) return fail('not_enough', { needStone: stone, stone: have });
  r.stone -= stone;
  r.jungong += n;
  const day = dayOf(state);
  recordRes(state, 'stone', -stone, '折石为军工', day);
  recordRes(state, 'jungong', n, '折石为军工', day);
  pushRes(state, ctx);
  return {
    ok: true, count: n, stone, jungong: r.jungong,
    text: `折石造成军工 ${n}，用了石 ${stone}。现有军工 ${r.jungong}。`,
  };
}

/** 把一种物资投入本城开发度。field：agri / trade / def。 */
export function investDev(state, ctx, { cityId, field, count, drain } = {}) {
  const spec = INVEST[String(field || '')];
  if (!spec) return fail('bad_field');
  ensureCityEcon(state);
  const st = state.strategy;
  const id = Number(cityId) || Number(st?.playerCity) || 0;
  const city = st?.cities?.[id];
  if (!city || city.owner !== 'player') return fail('not_own_city');
  const econ = st.cityEcon?.[id];
  if (!econ) return fail('not_own_city');
  const cur = Math.floor(Number(econ[spec.field]) || 0);
  const room = Math.max(0, DEV_CAP - cur);
  if (room <= 0) return fail('dev_capped', { field, dev: cur });
  const have = Math.floor(Number(state.roleRes?.[spec.res]) || 0);
  let packs = Math.floor(Number(count) || 0);
  if (drain) packs = Math.floor(Math.max(0, have - spec.reserve) / spec.per);
  packs = Math.max(0, Math.min(packs, room, Math.floor(have / spec.per), DEV_CAP));
  if (packs <= 0) return fail(have < spec.per ? 'not_enough' : 'nothing', { field, have, per: spec.per, room });
  const cost = packs * spec.per;
  state.roleRes[spec.res] = have - cost;
  econ[spec.field] = cur + packs;
  recordRes(state, spec.res, -cost, `投入${spec.label}`, dayOf(state));
  pushRes(state, ctx);
  return {
    ok: true, field, packs, dev: econ[spec.field], cost, cityId: id,
    text: `${spec.label} +${packs}，花了 ${cost}。现为 ${econ[spec.field]}/${DEV_CAP}。`,
  };
}

/** 内政和府库共用的说明。产量数字和按钮都从这里来。 */
export function materialGuide(state) {
  const r = ensureJungong(state);
  const cap = Number(r.depot_capacity) || 1000000;
  const keys = ['wood', 'iron', 'stone', 'grain', 'gold', 'decree', 'jungong'];
  const resources = keys.map((key) => {
    const stock = Math.floor(Number(r[key]) || 0);
    const capped = key !== 'decree' && key !== 'jungong';
    return {
      key,
      label: LABEL[key],
      use: USE[key],
      stock,
      yield: Math.floor(Number(r[`${key}_yield`]) || 0),
      capacity: capped ? cap : null,
      full: capped && stock >= cap,
    };
  });
  const actions = [
    { id: 'craft10', label: '造 10 军工', note: `木 ${JUNGONG_WOOD * 10} + 铁 ${JUNGONG_IRON * 10}`, body: { action: 'craft', count: 10 } },
    { id: 'craftDrain', label: '多余木铁造成军工', note: `留木 ${RESERVE_WOOD}、铁 ${RESERVE_IRON} 给征兵`, body: { action: 'craft', drain: true } },
    { id: 'def1', label: '本城城防 +1', note: `石 ${INVEST.def.per}`, needsCity: true, body: { action: 'investDev', field: 'def', count: 1 } },
    { id: 'defDrain', label: '多余的石修城防', note: `留石 ${RESERVE_STONE}，上限 ${DEV_CAP}`, needsCity: true, body: { action: 'investDev', field: 'def', drain: true } },
    { id: 'smelt10', label: '折石造 10 军工', note: `石 ${STONE_PER_JUNGONG * 10}，比木铁贵`, body: { action: 'smeltStone', count: 10 } },
    { id: 'smeltDrain', label: '多余的石折成军工', note: `留石 ${RESERVE_STONE}`, body: { action: 'smeltStone', drain: true } },
    { id: 'agri1', label: '本城农业 +1', note: `粮 ${INVEST.agri.per}`, needsCity: true, body: { action: 'investDev', field: 'agri', count: 1 } },
    { id: 'agriDrain', label: '多余的粮投入农业', note: `留粮 ${INVEST.agri.reserve}，上限 ${DEV_CAP}`, needsCity: true, body: { action: 'investDev', field: 'agri', drain: true } },
    { id: 'trade1', label: '本城商业 +1', note: `金 ${INVEST.trade.per}`, needsCity: true, body: { action: 'investDev', field: 'trade', count: 1 } },
    { id: 'tradeDrain', label: '多余的金投入商业', note: `留金 ${INVEST.trade.reserve}，上限 ${DEV_CAP}`, needsCity: true, body: { action: 'investDev', field: 'trade', drain: true } },
    { id: 'sell', label: '粜粮', note: '本旬最多 2000 粮，1 粮换 0.5 金', body: { action: 'sellGrain', grain: 2000 } },
  ];
  return {
    jungong: r.jungong,
    resources,
    actions,
    /* 府库用途的三句话：界面直接展示，避免玩家把「库存」和「日产」「上限」混成一团。
       ★ P50：物资去处是即时物资转化（粮/石/木铁换开发与军工），点了立刻结算；
       金驱动的发展走城内页太守与方针，不再有委派任务。 */
    brief: '府库管三件事：看库存与日产、把多余物资即时投到本城开发或督造军工、查收支流水。'
      + '政令与军工不进仓库上限，也不会每天白送；木铁石粮金满仓后当天产量不再入库。',
    rule: '战法升级只花军工，费用是当前等级的平方 × 20，而且战法等级不能超过武将等级。'
      + '武将经验来自出征折损，满了自动升级，最高 10 级；5 级开学习槽，10 级且自带战法 10 级开觉醒槽。'
      + '仓库满了，当天产量不再入库。',
  };
}
