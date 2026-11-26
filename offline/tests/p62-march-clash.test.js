/**
 * P62（2026-11-25）出征表现与相遇回归：
 *  - 城下会战的判定与视图字段（沙盘据此画对撞）；
 *  - 道中相向而过**不算**相遇（用户要求撤掉野外拦截），只在城下开打；
 *  - 会战军情按「日 + 双方 id」去重，逐帧重绘不会刷屏；
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
import { clashOfPair, detectClashes } from '../server/domain/clash.js';

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

test('P62-A 城下会战：同指一城、抵达日相差 ≤2 日；差远了就只是先后抵达', () => {
  const a = { id: 3, side: 'player', kind: 'attack', from: 1, to: 10, departDay: 1, arriveDay: 6, troops: 1200 };
  const near = { id: 4, side: 'faction', kind: 'relief', from: 20, to: 10, departDay: 3, arriveDay: 7, troops: 500, factionName: '曹军' };
  const far = { id: 5, side: 'faction', kind: 'relief', from: 20, to: 10, departDay: 3, arriveDay: 12, troops: 500, factionName: '袁军' };
  const c = clashOfPair(a, near, { cities: CITY, today: 6 });
  assert.ok(c);
  assert.equal(c.kind, 'city');
  assert.equal(c.day, 7, '会战发生在后到者抵达那天');
  assert.equal(c.at.x, 100, '会战点落在目标城');
  assert.equal(c.aTroops, 1200);
  assert.equal(c.bTroops, 500);
  assert.match(c.text, /会战/);
  assert.match(c.text, /城下|城下下/, '城名已带「城」时不要写成「邺城城下」');
  assert.equal(clashOfPair(a, far, { cities: CITY, today: 4 }), null);
});

test('P62-A 道中相向而过不算相遇：野外不开打、不扣兵、不上地图', () => {
  const a = { id: 1, side: 'player', kind: 'attack', from: 1, to: 10, departDay: 1, arriveDay: 5, troops: 1000 };
  const b = { id: 2, side: 'faction', kind: 'assault', from: 10, to: 1, departDay: 2, arriveDay: 6, troops: 800 };
  /* 用户要求：撤掉道中拦截。目标城不同就各走各的路，哪怕正好在路上擦肩。 */
  assert.equal(clashOfPair(a, b, { cities: CITY, today: 3 }), null);
  assert.equal(detectClashes({ marches: [a, b], cities: CITY, today: 3 }).length, 0);
  /* 判定模块里不能再有 road 这一种类 */
  const src = readFileSync(resolve(ROOT, 'server/domain/clash.js'), 'utf8');
  assert.doesNotMatch(src, /kind: 'road'/, '道中遭遇必须彻底拆掉，不能只藏起来');
  assert.doesNotMatch(src, /pathFor|pointAt/, '只为道中相遇服务的折线取点工具应一并移除');
});

test('P62-A 只把涉及玩家的会战交给沙盘，诸侯互相路过不占玩家地图', () => {
  /* 玩家与援军同指邺城 */
  const a = { id: 1, side: 'player', from: 1, to: 10, departDay: 1, arriveDay: 5 };
  const b = { id: 2, side: 'faction', from: 20, to: 10, departDay: 2, arriveDay: 6 };
  /* 两诸侯互相换城，玩家无关 */
  const c = { id: 3, side: 'faction', from: 30, to: 40, departDay: 2, arriveDay: 4 };
  const d = { id: 4, side: 'faction', from: 40, to: 30, departDay: 3, arriveDay: 5 };
  const list = detectClashes({ marches: [a, b, c, d], cities: CITY, today: 2 });
  assert.equal(list.length, 1);
  assert.equal(list[0].aId, 1);
  assert.equal(list[0].cityId, 10);
  /* 运粮队不算战兵：哪怕同指一城也不算会战 */
  const t = { id: 9, side: 'faction', kind: 'transport', from: 20, to: 10, departDay: 2, arriveDay: 6 };
  assert.equal(clashOfPair(a, t, { cities: CITY, today: 2 }), null);
});

test('P62-A 视图：marches 带 clash/soldiers/order，顶层带 clashes', () => {
  const { s, cfg } = fresh();
  const st = s.strategy;
  const army = s.armys.find((a) => !a.marchId && a.soldiers.some((v) => v > 0));
  const target = marchableFrom(army.cityId).find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  const at = strategyAttack(s, cfg, mkCtx(s), { cityId: target, fromCityId: army.cityId, armyId: army.id, frac: 0.5 });
  assert.equal(at.ok, true);
  /* 同一目标城、抵达日差 1 天的援军 → 城下会战 */
  const reliefFrom = Object.keys(st.cities).map(Number)
    .find((id) => id !== Number(target) && id !== Number(army.cityId)) || Number(target);
  st.marches.push({
    id: 9901, side: 'faction', kind: 'relief', from: reliefFrom, to: target,
    departDay: Math.max(1, (Number(at.arriveDay) || 5) - 4),
    arriveDay: (Number(at.arriveDay) || 5) + 1, troops: 700, factionName: '曹军',
  });
  const v = strategyViewState(s, cfg);
  const mine = v.marches.find((m) => m.side === 'player');
  assert.ok(mine.clash, '同指一城、抵达日相近的援军必须让玩家这支军带上 clash');
  assert.equal(mine.clash.kind, 'city');
  assert.equal(mine.clash.cityId, Number(target));
  assert.equal(mine.clash.withLabel, '曹军');
  assert.equal(mine.clash.withTroops, 700);
  assert.match(mine.clash.text, /会战/);
  assert.ok(Array.isArray(mine.soldiers), '部队编成要下发，沙盘按盾/弓/骑排队列');
  assert.ok(Number(mine.order) >= 0, '队号要下发，兵力牌与「第 N 队」标注都靠它');
  assert.ok(Array.isArray(v.clashes));
});

test('P62-A 会战军情去重：同一天反复结算只记一条', () => {
  const { s, cfg } = fresh();
  const st = s.strategy;
  const army = s.armys.find((a) => !a.marchId && a.soldiers.some((v) => v > 0));
  const target = marchableFrom(army.cityId).find((id) => st.cities[id] && st.cities[id].owner !== 'player');
  const at = strategyAttack(s, cfg, mkCtx(s), { cityId: target, fromCityId: army.cityId, armyId: army.id, frac: 0.5 });
  assert.equal(at.ok, true);
  const reliefFrom = Object.keys(st.cities).map(Number)
    .find((id) => id !== Number(target) && id !== Number(army.cityId)) || Number(target);
  st.marches.push({
    id: 9902, side: 'faction', kind: 'relief', from: reliefFrom, to: target,
    departDay: Math.max(1, (Number(at.arriveDay) || 5) - 4),
    arriveDay: (Number(at.arriveDay) || 5) + 1, troops: 700, factionName: '曹军',
  });
  s.clock.day = 2;
  const ctx = mkCtx(s);
  const first = clashTick(s, cfg, ctx);
  const second = clashTick(s, cfg, ctx);
  assert.ok(first.length >= 1, '首次结算要产出会战军情');
  assert.equal(second.length, 0, '同一天重复结算不得重复记账');
  assert.ok(st.clashes.length >= 1);
  assert.equal(ctx.pushes.filter((p) => p.name === 'march.clash').length, first.length);
});

test('P62-B 沙盘：部队棋子与诸侯军移动已接线（静态断言）', () => {
  assert.match(SKILLS_SRC, /function drawTroopToken/, '要有部队棋子绘制函数');
  assert.match(SKILLS_SRC, /anyMarching/, '有在途部队就要驱动重绘（含诸侯军）');
  assert.doesNotMatch(SKILLS_SRC, /诸侯军不做逐帧移动画面/, '旧「诸侯军静态红线」的口径必须撤掉');
  /* 军标与会战层都不能再退回纯静态标记 */
  assert.match(SKILLS_SRC, /mm\.clash/, '沙盘要读 marches[].clash');
  assert.match(SKILLS_SRC, /'会战'/, '会战要有地图字样');
  assert.doesNotMatch(SKILLS_SRC, /'会战' : '遭遇'/, '「遭遇」这一种已撤掉，不要再按 kind 分叉');
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
