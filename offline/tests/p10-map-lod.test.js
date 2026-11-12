/**
 * 验收 #22：地图密度随缩放分级——72 城不全量标注。
 *
 * 口径在服务端（domain/map-lod.js）：哪座城算「要城」是领域判断，必须可单测；
 * 客户端只负责「当前缩放到第几档 + 屏幕占位去重」。这里测的是口径本身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZOOM_TIERS, cityLabelRank, labelTierForZoom, labelPolicy, shouldLabel,
} from '../server/domain/map-lod.js';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath, strategyViewState } from '../server/domain/strategy.js';

const cfg = loadConfig();

test('要城判定：本城/大城/重兵城进第一档，小县进第三档', () => {
  assert.equal(cityLabelRank({ level: 3 }), 1, '州治(level 3)必须常驻标注');
  assert.equal(cityLabelRank({ level: 1, troops: 5000 }), 1, '重兵小城也算要城');
  assert.equal(cityLabelRank({ level: 2 }), 2);
  assert.equal(cityLabelRank({ level: 1 }), 3);
  assert.equal(cityLabelRank({ level: 1 }, { isPlayer: true }), 1, '玩家本城无条件第一档');
  assert.equal(cityLabelRank({ level: 1, troops: 1300 }), 2, '有驻军的小城抬到第二档');
});

test('缩放档位单调：放大只会让标注变多，绝不反向', () => {
  const tiers = [1, 1.2, 1.8, 2, 2.8, 3.5, 4].map(labelTierForZoom);
  for (let i = 1; i < tiers.length; i += 1) {
    assert.ok(tiers[i] >= tiers[i - 1], `档位在 ${i} 处回退了：${tiers.join(',')}`);
  }
  assert.equal(labelTierForZoom(1), 1);
  assert.equal(labelTierForZoom(1.79), 1, '没到 1.8 仍是第一档');
  assert.equal(labelTierForZoom(1.8), 2);
  assert.equal(labelTierForZoom(2.8), 3);
  assert.equal(labelTierForZoom(4), 3, '全标后不再增档');
  assert.equal(labelTierForZoom(0.2), 1, '低于 1 倍钳到第一档');
  assert.equal(labelTierForZoom(99), 3);
});

test('1 倍下不全量标注：72 城只标其中一小部分', () => {
  const cities = [];
  for (let i = 0; i < 72; i += 1) {
    cities.push({ id: i + 1, level: i < 8 ? 3 : (i < 30 ? 2 : 1), troops: 0 });
  }
  const at1 = cities.filter((c) => shouldLabel(c, 1));
  const at28 = cities.filter((c) => shouldLabel(c, 2.8));
  assert.ok(at1.length < 20, `1 倍下标注了 ${at1.length} 座，仍然过密`);
  assert.equal(at28.length, 72, '2.8 倍必须全标，玩家放大就是为了看小城');
  assert.ok(at28.length > at1.length * 2, '放大后要明显变密');
});

test('档位策略随视图下发：客户端不必自己猜阈值', () => {
  const pol = labelPolicy();
  assert.equal(pol.tiers.length, ZOOM_TIERS.length);
  assert.ok(pol.minGap >= 24, '屏幕最小间距必须给出来，否则去重无从谈起');
  assert.deepEqual(pol.tiers.map((t) => t.zoom), ZOOM_TIERS.map((t) => t.zoom));
});

test('战略视图里每座城都带 labelRank，且本城恒为 1', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  chooseOath(state, cfg, { push() {} }, { lord: lords[0].id, city: lords[0].cities[0].id });
  const view = strategyViewState(state, cfg);
  assert.ok(view.labelPolicy && view.labelPolicy.tiers.length, '视图必须下发 labelPolicy');
  const ranks = view.cities.map((c) => c.labelRank);
  assert.ok(ranks.every((r) => r === 1 || r === 2 || r === 3), `labelRank 越界：${ranks.filter((r) => r < 1 || r > 3).slice(0, 5)}`);
  const home = view.cities.find((c) => c.id === state.strategy.playerCity);
  assert.equal(home.labelRank, 1, '玩家本城必须第一档，任何时候都看得见自己在哪');
  const n1 = ranks.filter((r) => r === 1).length;
  assert.ok(n1 < view.cities.length, '不能所有城都在第一档（那就等于没分级）');
});
