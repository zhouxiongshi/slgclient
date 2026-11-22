/**
 * P40 回归：真实时钟下的围城幂等 / 集市兑换流水 / 玩家文案兜底 / 双态布局硬闸。
 *
 * 两个实质性缺陷都来自「约定与真实调用频率不一致」：
 *   1) assaultEscalationTick 注释写「每旬调一次」，实际 handleRequest 与世界定时器
 *      每 500ms 都调一次；`today % 10 === 0` 于是让同一天扣 120 次民心与守军。
 *   2) interior.transform 直接改 roleRes，却没走 recordRes，府库流水查不到兑换。
 * 另加两条静态闸，防止英文 reason 与打包态布局报告再次从发布口径里漏出去。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import {
  ensureStrategy, oathOptions, chooseOath, strategyMap,
  spawnFactionAssault, assaultEscalationTick,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const cfg = loadConfig();

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, pushes, options: {},
    push(n, m) { pushes.push({ n, m }); },
    schedule() {}, save() {}, log() {},
  };
}
const req = (name, msg = {}) => ({ seq: 1, name, msg });

function siegedState() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  ensureCityEcon(state);
  const ctx = makeCtx(state);
  const cao = oathOptions(state).lords.find((l) => l.name === '曹操');
  assert.equal(chooseOath(state, cfg, ctx, { lord: cao.id, city: cao.cities[0].id }).ok, true);
  state.clock.day = 1;
  const [targetId] = Object.entries(state.strategy.cities).find(([, c]) => c.owner === 'player');
  const target = strategyMap().cities.find((c) => c.id === Number(targetId));
  const g = spawnFactionAssault(state, cfg, ctx, { id: 'jizhou', name: '袁绍' }, target, 6000);
  assert.ok(g, '应生成来犯军');
  return { state, ctx, g, cityId: Number(targetId) };
}

test('P40-① 同一游戏日内反复调围城推进，损耗只结算一次', () => {
  const { state, ctx, g, cityId } = siegedState();
  state.clock.day = 41;                      // 过 40 日宽限，进入围城损耗期
  const e0 = state.strategy.cityEcon[cityId];
  const before = { morale: e0.morale, troops: state.strategy.cities[cityId].troops };
  assert.ok(before.troops > 0);

  for (let i = 0; i < 120; i++) assaultEscalationTick(state, cfg, ctx);

  assert.equal(Number(e0.morale), before.morale - 4,
    '同一天重复 120 次只能扣一旬的 4 点民心，不能扣 480');
  assert.ok(state.strategy.cities[cityId].troops > 0, '单次损耗不应直接把守军打光');
  assert.ok(state.strategy.cities[cityId].troops < before.troops, '但确实要有一次真实损耗');
  assert.equal(Number(g.lastSiegeDrainStep) >= 4, true, '幂等键要写到来犯军上');

  /* 跨到下一旬步数后必须再扣一次，不能因为幂等键永久封死围城压力。 */
  state.clock.day = 51;
  assaultEscalationTick(state, cfg, ctx);
  assert.equal(Number(e0.morale), before.morale - 8, '跨旬后应再扣一次');
});

test('P40-② 集市兑换进府库流水，正负两侧都可审计', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  assert.equal(handleRequest(ctx, req('interior.transform', { from: [100, 0, 0, 0] })).code, 58);
  state.roleRes.wood += 100000;
  handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 15 }));
  const market = state.facilities[1].find((x) => x.type === 15);
  state.clock.day += cfg.facilityUpgradeDays(15, 1);
  handleRequest(ctx, req('role.myRoleRes'));
  assert.ok(market.level >= 1);

  state.resLedger = [];
  const r = handleRequest(ctx, req('interior.transform', {
    from: [500, 0, 0, 0], to: [0, 0, 0, 500],
  }));
  assert.equal(r.code, 0);
  const rows = (state.resLedger || []).filter((x) => x.reason === '集市兑换');
  assert.deepEqual(rows.map((x) => [x.res, x.delta]), [['wood', -500], ['grain', 500]]);
});

test('P40-③ 玩家可见 reason 一律中文兜底，自立与存档不再直出内部码', () => {
  const s = read('server/skills.js');
  for (const code of ['already_founded', 'oath_pending', 'not_enough_cities',
    'empty_name', 'not_a_save', 'bad_save', 'io_error']) {
    assert.ok(s.includes(`${code}: '`), `中文映射表缺 ${code}`);
  }
  assert.match(s, /function reasonText\(reason\)/);
  assert.match(s, /function warReason\(rs\) \{ return WAR_REASON\[rs\] \|\| REASON_TEXT\[rs\] \|\|/);
  assert.ok(!s.includes("toast('自立失败：' + ((rsp.msg && rsp.msg.reason)"), '自立失败不得直出 reason');
  assert.ok(!s.includes("toast('导入失败：' + (r.reason"), '导入失败不得直出 reason');
  assert.ok(!s.includes("toast('读档失败：' + (r.reason"), '读档失败不得直出 reason');
  assert.match(s, /confirmBox\('解甲归田'[\s\S]{0,500}该槽在途征兵会一并作废/);
  assert.match(s, /if \(!\(want >= 1\)\) \{ toast\('请先填写 1 以上的征兵人数'/);
});

test('P40-④ 打包态布局报告纳入发布闸新鲜度与硬断言', () => {
  const c = read('tools/check-release.js');
  assert.match(c, /\['布局美观审计（打包态）', 'layout-packaged\.json', 'layout-audit\.js'\]/);
  assert.match(c, /\['打包态', 'layout-packaged\.json'\]/);
  assert.match(c, /r\?\.clippedTotal \?\? -1\) === 0/);
});
