/**
 * P62（2026-11-25）出征表现与相遇回归：
 *  - 道中遭遇 / 城下会战的判定与视图字段（沙盘据此画对撞）；
 *  - 相遇军情按「日 + 双方 id」去重，逐帧重绘不会刷屏；
 *  - 出征页简化后仍保留验收锚点（出征按钮 / 队伍槽位 / 三步文案）；
 *  - 沙盘部队棋子与路线预览的静态接线不丢。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  ensureStrategy, chooseOath, oathOptions, strategyViewState, marchableFrom,
  strategyAttack, clashTick,
} from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { clashOfPair, detectClashes, pointAt, pathFor } from '../server/domain/clash.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_SRC = readFileSync(resolve(ROOT, 'server/skills.js'), 'utf8');

const CITY = {
  1: { id: 1, name: '安邑', x: 0, y: 0 },
  10: { id: 10, name: '邺', x: 100, y: 0 },
  20: { id: 20, name: '晋阳', x: 200, y: 40 },
  /* 两座与玩家无关的城，用来验证「诸侯互相路过不占玩家地图」 */
  30: { id: 30, name: '蓟', x: 300, y: 80 },
  40: { id: 40, name: '代', x: 400, y: 120 },
};
const ROUTES = [{ id: 'r1', from: 1, to: 10, points: [[0, 0], [50, 12], [100, 0]] }];

function mkCtx(state) {
  const pushes = [];
  return { state, cfg: loadConfig(), pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
function fresh() {
  const cfg = loadConfig();
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const lord = oathOptions(s).lords.find((l) => l.cities.length >= 2) || oathOptions(s).lords[0];
  const r = chooseOath(s, cfg, mkCtx(s), { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true);
  return { s, cfg };
}

test('P62-A 道中遭遇：同路段相向、时间窗交叠 → 相遇日与相遇点落在路径上', () => {
  const a = { id: 1, side: 'player', kind: 'attack', from: 1, to: 10, departDay: 1, arriveDay: 5, troops: 1000 };
  const b = { id: 2, side: 'faction', kind: 'assault', from: 10, to: 1, departDay: 2, arriveDay: 6, troops: 800 };
  const c = clashOfPair(a, b, { cities: CITY, routes: ROUTES, today: 3 });
  assert.ok(c, '相向而行且时间窗交叠必须判定为相遇');
  assert.equal(c.kind, 'road');
  /* 归一化：A 走 (t-1)/4，B 走 (t-2)/4，同位置时两者相加为 1 → t=3.5 → 第 4 日 */
  assert.equal(c.day, 4);
  assert.equal(c.aId, 1);
  assert.equal(c.bId, 2);
  /* 相遇点必须落在 1→10 的折线上，而不是端点 */
  assert.ok(c.at.x > 0 && c.at.x < 100, `相遇点应在两城之间，实际 ${c.at.x}`);
  assert.match(c.text, /道中相遇/);
});

test('P62-A 时间窗不交叠不算相遇（隔着十几天不可能撞上）', () => {
  const a = { id: 1, side: 'player', from: 1, to: 10, departDay: 1, arriveDay: 4 };
  const b = { id: 2, side: 'faction', from: 10, to: 1, departDay: 20, arriveDay: 24 };
  assert.equal(clashOfPair(a, b, { cities: CITY, routes: ROUTES, today: 2 }), null);
});

test('P62-A 城下会战：同指一城、抵达日相差 ≤2 日；差远了就只是先后抵达', () => {
  const a = { id: 3, side: 'player', kind: 'attack', from: 1, to: 10, departDay: 1, arriveDay: 6, troops: 1200 };
  const near = { id: 4, side: 'faction', kind: 'relief', from: 20, to: 10, departDay: 3, arriveDay: 7, troops: 500, factionName: '曹军' };
  const far = { id: 5, side: 'faction', kind: 'relief', from: 20, to: 10, departDay: 3, arriveDay: 12, troops: 500, factionName: '袁军' };
  const c = clashOfPair(a, near, { cities: CITY, routes: ROUTES, today: 6 });
  assert.ok(c);
  assert.equal(c.kind, 'city');
  assert.equal(c.day, 7, '会战发生在后到者抵达那天');
  assert.match(c.text, /会战/);
  assert.equal(clashOfPair(a, far, { cities: CITY, routes: ROUTES, today: 4 }), null);
});

test('P62-A 只把涉及玩家的相遇交给沙盘，诸侯互相路过不占玩家地图', () => {
  const a = { id: 1, side: 'player', from: 1, to: 10, departDay: 1, arriveDay: 5 };
  const b = { id: 2, side: 'faction', from: 10, to: 1, departDay: 2, arriveDay: 6 };
  const c = { id: 3, side: 'faction', from: 30, to: 40, departDay: 2, arriveDay: 4 };
  const d = { id: 4, side: 'faction', from: 40, to: 30, departDay: 3, arriveDay: 5 };
  const list = detectClashes({ marches: [a, b, c, d], cities: CITY, routes: ROUTES, today: 2 });
  assert.equal(list.length, 1);
  assert.equal(list[0].aId, 1);
  /* 运粮队不算战兵 */
  const t = { id: 9, side: 'faction', kind: 'transport', from: 10, to: 1, departDay: 2, arriveDay: 6 };
  assert.equal(clashOfPair(a, t, { cities: CITY, routes: ROUTES, today: 2 }), null);
});

test('P62-A 路径工具：反向查询要给出「从 from 走向 to」的点序', () => {
  const pts = pathFor(ROUTES, 10, 1, CITY);
  assert.deepEqual(pts[0], [100, 0]);
  assert.deepEqual(pts[pts.length - 1], [0, 0]);
  const mid = pointAt(pathFor(ROUTES, 1, 10, CITY), 0.5);
  assert.ok(mid[0] > 40 && mid[0] < 60, `折线中点应靠近 50，实际 ${mid[0]}`);
});

test('P62-A 视图：marches 带 clash/soldiers/order，顶层带 clashes', () => {
  const { s, cfg } = fresh();
  const st = s.strategy;
  const army = s.armys.find((a) => !a.marchId && a.soldiers.some((v) => v > 0));
  const target = marchableFrom(army.cityId).find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  const at = strategyAttack(s, cfg, mkCtx(s), { cityId: target, fromCityId: army.cityId, armyId: army.id, frac: 0.5 });
  assert.equal(at.ok, true);
  const fromId = army.cityId;
  st.marches.push({
    id: 9901, side: 'faction', kind: 'assault', from: target, to: fromId,
    departDay: 2, arriveDay: 12, troops: 700, factionName: '曹军',
  });
  const v = strategyViewState(s, cfg);
  const mine = v.marches.find((m) => m.side === 'player');
  assert.ok(mine.clash, '相向的敌军必须让玩家这支军带上 clash');
  assert.ok(mine.clash.at.x > 0 && mine.clash.at.y > 0);
  assert.match(mine.clash.text, /迎面而来|道中相遇/);
  assert.ok(Array.isArray(mine.soldiers), '部队编成要下发，沙盘按盾/弓/骑排队列');
  assert.ok(Array.isArray(v.clashes));
});

test('P62-A 相遇军情去重：同一天反复结算只记一条', () => {
  const { s, cfg } = fresh();
  const st = s.strategy;
  const army = s.armys.find((a) => !a.marchId && a.soldiers.some((v) => v > 0));
  const target = marchableFrom(army.cityId).find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  strategyAttack(s, cfg, mkCtx(s), { cityId: target, fromCityId: army.cityId, armyId: army.id, frac: 0.5 });
  st.marches.push({
    id: 9902, side: 'faction', kind: 'assault', from: target, to: army.cityId,
    departDay: 2, arriveDay: 12, troops: 700, factionName: '曹军',
  });
  s.clock.day = 5;
  const ctx = mkCtx(s);
  const first = clashTick(s, cfg, ctx);
  const second = clashTick(s, cfg, ctx);
  assert.ok(first.length >= 1, '首次结算要产出相遇军情');
  assert.equal(second.length, 0, '同一天重复结算不得重复记账');
  assert.ok(st.clashes.length >= 1);
  assert.equal(ctx.pushes.filter((p) => p.name === 'march.clash').length, first.length);
});

test('P62-B 沙盘：部队棋子与诸侯军移动已接线（静态断言）', () => {
  assert.match(SKILLS_SRC, /function drawTroopToken/, '要有部队棋子绘制函数');
  assert.match(SKILLS_SRC, /anyMarching/, '有在途部队就要驱动重绘（含诸侯军）');
  assert.doesNotMatch(SKILLS_SRC, /诸侯军不做逐帧移动画面/, '旧「诸侯军静态红线」的口径必须撤掉');
  /* 军标与相遇层都不能再退回纯静态标记 */
  assert.match(SKILLS_SRC, /mm\.clash/, '沙盘要读 marches[].clash');
  assert.match(SKILLS_SRC, /会战|遭遇/, '相遇要有地图字样');
});

test('P62-D 出征页简化：保留验收锚点，细节收进折叠军议', () => {
  assert.match(SKILLS_SRC, /出征三步/, '鼠标试玩按「出征三步」断言向导存在');
  assert.match(SKILLS_SRC, /slgWarAttackBtn/, '出征按钮 id 不能丢');
  assert.match(SKILLS_SRC, /data-army-index/, '键盘 1–3 槽位依赖这个属性');
  assert.match(SKILLS_SRC, /data-war-preview/, '推演按钮标记不能丢');
  assert.match(SKILLS_SRC, /军议详情/, '参谋信息要收进折叠区');
  assert.match(SKILLS_SRC, /__slgWarRoutePreview/, '选目标要能预览进军路线');
  /* 主屏不再常驻这些长卡 */
  assert.doesNotMatch(SKILLS_SRC, /<h4 style="margin-top:0">站位 · 射程 · 适性<\/h4>/, '站位卡不再常驻主屏');
  assert.doesNotMatch(SKILLS_SRC, /<h4 style="margin-top:0">出兵概览<\/h4>/, '旧概览卡已被「③ 出师」取代');
});
