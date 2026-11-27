/**
 * M4-13 回归：距离做实 / 兵种适性进战斗 / 守将去重 / 俘虏链路 / 出征待决超时。
 *
 * 用户 2026-11-15 反馈的四条，逐条给出「全绿也不能再退化」的断言：
 *   1) 战法写了距离，战斗里却看不出意义 → 内核必须产出距离轨迹，战报必须接线；
 *   2) 兵种适性只是界面百分比 → 必须与战斗结算同源并真的乘进属性；
 *   3) 敌方将领一直是十常侍、换个城还是 → 守将必须按城确定性分配且跨城不撞名；
 *   4) 抓了敌将没有招降、出征流程不连贯 → 俘虏两条路径同源 + 处置出口 + 待决兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { runBattle, DEFAULT_BATTLE_CONFIG } from '../kernel/index.js';
import { kernelSkillAt } from '../server/skills.js';
import { makeDefenders } from '../server/battle.js';
import { armsApt as aptLeaf, aptTriple, bestArms } from '../server/domain/aptitude.js';
import { armsApt as aptReexport } from '../server/domain/city-econ.js';
import { garrisonCfgIds, garrisonPool } from '../server/domain/garrison.js';
import { captureFromBattle, releaseCaptive, executeCaptive } from '../server/domain/captives.js';
import {
  FAME_PER_RELEASE, INFAMY_PER_EXECUTE, ATTITUDE_ON_RELEASE,
  ATTITUDE_ON_EXECUTE, EXEMPT_FACTION_ON_EXECUTE, defectRateWithFame,
} from '../server/domain/captive-reputation.js';
import { ensureStrategy, strategyResolveMarches } from '../server/domain/strategy.js';

const cfg = loadConfig();
const readSrc = (p) => readFileSync(new URL(`../server/${p}`, import.meta.url), 'utf8');

/* ---------------- 1. 内核距离轨迹（不进 events、不漂指纹） ---------------- */

function mkUnit(id, side, pos, attackRange, skills = []) {
  return {
    unit_id: id, side, pos, attack_range: attackRange,
    hero: {
      heroid: id, name: `武${id}`, level: 10, hero_type: 'normal', hit_range: 1,
      country: '', quality: 5,
      attack_base: 90, defence_base: 40, intel_base: 90, speed_base: 80, destroy_base: 50,
      attack_grow: 0, defence_grow: 0, intel_grow: 0, speed_grow: 0, destroy_grow: 0,
      skills,
    },
    troops: 2000, max_troops: 2000, speed: 100,
  };
}

test('距离轨迹：普攻超距打空要留下「弓矢不及」记录', () => {
  const r = runBattle({
    units: [mkUnit('a2', 1, 2, 3), mkUnit('d2', 2, 2, 3)],
    seed: 20261115, config: DEFAULT_BATTLE_CONFIG,
  });
  const normals = (r.range_trace || []).filter((t) => t.kind === 'normal');
  assert.ok(normals.length > 0, '大营短手武将够不着敌大营，必须留下距离轨迹');
  assert.equal(normals[0].range, 3);
  assert.equal(normals[0].nearest, 5, '大营→敌大营距离 = 2+2+1 = 5');
  assert.equal(normals[0].reachable, 0);
  assert.ok(normals[0].out_of_range.includes('d2'));
});

test('距离轨迹：战法射程之外的敌军要被记下来', () => {
  const sk = kernelSkillAt(10001, 10);
  for (const e of sk.effects) e.range = 3;
  const r = runBattle({
    units: [
      mkUnit('a2', 1, 2, 9, [sk]),
      mkUnit('d0', 2, 0, 9), mkUnit('d1', 2, 1, 9), mkUnit('d2', 2, 2, 9),
    ],
    seed: 20261115, config: DEFAULT_BATTLE_CONFIG,
  });
  const skills = (r.range_trace || []).filter((t) => t.kind === 'skill');
  assert.ok(skills.length > 0, '射程筛掉目标时必须留下可观测轨迹');
  const t0 = skills[0];
  assert.equal(t0.range, 3);
  assert.equal(t0.total, 3);
  assert.ok(t0.reachable < t0.total, '应只命中部分敌军');
  assert.ok(t0.out_of_range.length > 0);
});

test('距离轨迹：无距离约束时为空，事件指纹逐字节不变', () => {
  const units = [mkUnit('a0', 1, 0, 9), mkUnit('d0', 2, 0, 9)];
  const a = runBattle({ units, seed: 777, config: DEFAULT_BATTLE_CONFIG });
  const b = runBattle({ units, seed: 777, config: DEFAULT_BATTLE_CONFIG });
  assert.deepEqual(a.range_trace, [], '常规战斗不应产生距离噪音');
  assert.equal(a.event_fingerprint, b.event_fingerprint);
  assert.deepEqual(a.events, b.events, '同输入同 seed 事件流必须逐字节一致');
  /* 轨迹与事件流物理分离：events 里不允许出现 range_trace 相关字段 */
  assert.ok(a.events.every((e) => !('range_trace' in e.payload)));
});

test('战报接线：battle.js 把距离轨迹翻成人话，并引用适性同源函数', () => {
  const src = readSrc('battle.js');
  assert.match(src, /kernel\.range_trace/, '战报必须读取内核距离轨迹');
  assert.match(src, /弓矢不及/, '普攻超距要能讲出来');
  assert.match(src, /有效距离 \$\{rn\.range\}/, '战法射程要写进叙述');
  assert.match(src, /armsApt\(/, '适性必须真的进入战斗结算');
});

/* ---------------- 2. 兵种适性同源 ---------------- */

test('适性：展示层与战斗层是同一个函数，区间 100%~115%', () => {
  assert.strictEqual(aptLeaf, aptReexport, '两套适性口径必须收敛成一个');
  assert.equal(aptLeaf({ defense: 100 }, 1), 1.15);
  assert.equal(aptLeaf({ strategy: 0 }, 2), 1, '下限锁 100%，保住首战平衡基线');
  assert.deepEqual(aptTriple({ defense: 100, strategy: 50, force: 0 }), [115, 100, 100]);
  assert.equal(bestArms({ defense: 100, strategy: 50, force: 0 }).arms, 1);
});

/* ---------------- 3. 守将去重 ---------------- */

test('守将：30 座城名单基本不撞、同城不重复、十常士不再垄断', () => {
  const seen = new Set();
  let dup = 0;
  for (let id = 1; id <= 30; id += 1) {
    const ids = garrisonCfgIds(cfg, { cityId: id, owner: 'han', level: 3 });
    assert.equal(ids.length, 3, '州治 3 将');
    assert.equal(new Set(ids).size, ids.length, `城 ${id} 内部守将重复`);
    for (const x of ids) {
      assert.ok(cfg.generalByCfg.get(x), `守将 ${x} 必须能在武将表查到真名`);
      assert.ok(cfg.clientGeneralIds.has(x), `守将 ${x} 必须在原版客户端武将表内，否则战报 UI 查表为 null`);
    }
    const key = ids.join(',');
    if (seen.has(key)) dup += 1;
    seen.add(key);
  }
  assert.ok(dup <= 2, `30 座城里重复名单 ${dup} 组，仍然过于集中`);

  let small = 0;
  let eunuch = 0;
  for (let id = 1; id <= 30; id += 1) {
    const ids = garrisonCfgIds(cfg, { cityId: id, owner: 'han', level: 1 });
    small += ids.length;
    eunuch += ids.filter((x) => x === 100002).length;
  }
  assert.ok(eunuch / small < 0.3, `1 级城里十常士占比 ${(eunuch / small * 100).toFixed(0)}%，仍在垄断`);
});

test('守将：同参可复算、势力倾向生效、排除已拥有武将', () => {
  const a = garrisonCfgIds(cfg, { cityId: 7, owner: 'yanzhou', level: 2 });
  const b = garrisonCfgIds(cfg, { cityId: 7, owner: 'yanzhou', level: 2 });
  assert.deepEqual(a, b, '同一座城反复攻打，守将必须恒定（推演=结算的前提）');
  assert.notDeepEqual(a, garrisonCfgIds(cfg, { cityId: 8, owner: 'yanzhou', level: 2 }));
  const han = garrisonCfgIds(cfg, { cityId: 7, owner: 'han', level: 2 });
  assert.notDeepEqual(a, han, '不同势力应有不同的守将倾向');
  const pool = garrisonPool(cfg, { exclude: [100003] });
  assert.ok(!pool.some((g) => Number(g.cfgId) === 100003), '已拥有武将不应再当守将');
});

test('守将：只取原版客户端可见武将，原版战报不会因 null 武将打不开', () => {
  assert.ok(cfg.clientGeneralIds instanceof Set && cfg.clientGeneralIds.size > 300,
    '配置必须导出「客户端可见武将集」，不能用数字范围猜');
  const st = createWorld(cfg);
  const c = st.citys[0];
  /* electron/smoke.cjs 的真实出征目标就是 (city[0].x, city[0].y+1)。
     M4-13 首轮曾在这里取到 240091 杨阜 / 240128 韩浩，客户端查表 null，
     战报列表与详情双双抛 "Cannot read properties of null (reading 'name')"。 */
  for (const [x, y] of [[c.x, c.y + 1], [c.x + 3, c.y - 2], [12, 34]]) {
    const d = makeDefenders(cfg, st, x, y);
    assert.ok(d.generals.length > 0, `(${x},${y}) 必须有守将`);
    for (const g of d.generals) {
      assert.ok(cfg.clientGeneralIds.has(Number(g.cfgId)),
        `守将 ${g.cfgId} 不在原版客户端武将表，原版战报会崩`);
      assert.ok(cfg.generalByCfg.get(Number(g.cfgId))?.name, `守将 ${g.cfgId} 必须有真名`);
    }
  }
  assert.ok(garrisonPool(cfg).every((g) => cfg.clientGeneralIds.has(Number(g.cfgId))),
    '守将池不得夹带 heroes-240 追加武将');
});

/* ---------------- 4. 俘虏链路 ---------------- */

function fakeReport(ids = [100003, 100004]) {
  return {
    b_d_general: JSON.stringify(ids.map((id, i) => [900000 + i, id, 0])),
    b_d_army: JSON.stringify({ soldiers: [1000, 1000] }),
    e_d_army: JSON.stringify({ soldiers: [0, 0] }),   // 全歼 → 必俘
  };
}

test('俘虏：全歼必俘有名守将，已在押不重复，放归/处斩都可用', () => {
  const state = createWorld(cfg);
  state.captives = [];
  state.generals = [];
  state.seed = 12345;
  const report = fakeReport();
  const added = captureFromBattle(state, cfg, { report, place: '测试城', day: 10, seed: 12345 });
  assert.equal(added.length, 2, '全歼时应擒得 2 名守将');
  assert.ok(added.every((c) => c.name && c.from === '测试城'));
  const again = captureFromBattle(state, cfg, { report, place: '测试城', day: 10, seed: 12345 });
  assert.equal(again.length, 0, '已在押的不得重复入押');

  assert.equal(releaseCaptive(state, { idx: 0 }).ok, true);
  assert.equal(state.captives.length, 1);
  const kill = executeCaptive(state, { idx: 0 });
  assert.equal(kill.ok, true);
  assert.equal(state.captives.length, 0);
  assert.ok((state.role?.infamy || 0) >= 1, '处斩应记一笔恶名');
});

test('俘虏处置：放归记名望、处斩记恶名与态度后果，四源同源', () => {
  const state = createWorld(cfg);
  ensureStrategy(state, cfg);
  state.captives = [];
  state.generals = [];
  state.seed = 12345;
  const added = captureFromBattle(state, cfg, { report: fakeReport(), place: '测试城', day: 10, seed: 12345 });
  assert.equal(added.length, 2);

  const touched = [];
  const api = {
    adjustAttitude(delta, exempt) {
      touched.push({ delta, exempt });
      return [{ faction: 'yanzhou', attitude: -5 }];
    },
  };
  const fame0 = Number(state.strategy?.fame) || 0;
  const rel = releaseCaptive(state, { idx: 0, diplomacyApi: api });
  assert.equal(rel.ok, true);
  assert.equal(rel.fameDelta, FAME_PER_RELEASE);
  assert.equal((Number(state.strategy?.fame) || 0) - fame0, FAME_PER_RELEASE, '放归应实打实加名望');
  assert.equal(rel.attitudeDelta, ATTITUDE_ON_RELEASE);
  assert.equal(touched.length, 1, '放归必须走态度落账口');

  const inf0 = Number(state.role?.infamy) || 0;
  const fame1 = Number(state.strategy?.fame) || 0;
  const exe = executeCaptive(state, { idx: 0, diplomacyApi: api });
  assert.equal(exe.ok, true);
  assert.equal(exe.infamyDelta, INFAMY_PER_EXECUTE);
  assert.equal((Number(state.role?.infamy) || 0) - inf0, INFAMY_PER_EXECUTE, '处斩应记恶名');
  assert.equal((Number(state.strategy?.fame) || 0) - fame1, -FAME_PER_RELEASE, '处斩应扣名望');
  assert.equal(exe.attitudeDelta, ATTITUDE_ON_EXECUTE);
  assert.equal(touched[1].exempt, EXEMPT_FACTION_ON_EXECUTE, '处斩必须豁免董卓');

  // 名望必须进入来投率，否则又是死字段
  assert.ok(defectRateWithFame(0.03, 0) < defectRateWithFame(0.03, 20), '名望越高来投率越高');
  assert.equal(defectRateWithFame(0.03, 10000), defectRateWithFame(0.03, 40),
    '名望贡献封顶 FAME_DEFECT_CAP，防止刷放归拉满来投率');
  assert.ok(defectRateWithFame(0.03, 40) < 0.45, '封顶后仍需叠加城数/武将名望才可能到 45%');
});

test('俘虏：两条占领路径与三条处置出口都已接线', () => {
  const handlers = readSrc('handlers.js');
  const strategy = readSrc('domain/strategy.js');
  const index = readSrc('index.js');
  assert.match(handlers, /captureFromBattle/, 'WS 地图格占领路径必须落俘虏（过去只战略层落）');
  assert.match(strategy, /captureFromBattle/, '战略层占城必须落俘虏');
  assert.match(index, /captiveRelease/, '放归入口');
  assert.match(index, /captiveExecute/, '处斩入口');
  assert.match(strategy, /consumeEncounterDefense/, 'P67 相遇敌军必须并进守军，抵城自动开战');
  assert.match(strategy, /strategyRetreatBattle/, '旧存档待决行仍要有撤回兼容口，不能永久锁死队伍');
});

/* ---------------- 5. 待决遭遇超时兜底 ---------------- */

test('出征：旧存档待决行按新口径自动结算并解锁队伍', () => {
  const state = createWorld(cfg);
  ensureStrategy(state);
  const st = state.strategy;
  const cityIds = Object.keys(st.cities).map(Number);
  const from = cityIds[0];
  const to = cityIds[1] || cityIds[0];
  const army = (state.armys || [])[0];
  assert.ok(army, '初始世界应有一支队伍');
  army.marchId = 991;
  st.marches = [{
    id: 991, side: 'player', from, to, armyId: army.id,
    departDay: 1, arriveDay: 1, grainCost: 200, troops: 100,
    confirmBattle: true, confirmed: false, pendingBattle: true, pendingSinceDay: 1,
  }];
  state.clock.day = 40;                       // 远超旧兜底，验证新口径也不锁死
  strategyResolveMarches(state, cfg, {
    state, cfg, push() {}, save() {}, log() {}, schedule() {},
  });
  const left = (st.marches || []).find((m) => m.id === 991);
  assert.ok(!left || left.resolved === true, '旧待决行应被自动结算');
  assert.equal(army.marchId, undefined, '队伍必须解锁，否则永久卡在「已抵城下」');
});

/* ---------------- 6. 出征 UI 连贯性静态闸 ---------------- */

test('出征：自动开战提示、智能默认页签、滚动记忆、战况入口都在', () => {
  const ui = readSrc('skills.js');
  assert.match(ui, /lastAutoReportId/, '自动开战要有状态驱动的新战报提示');
  assert.match(ui, /markWarBadge/, '出征窗没开时 dock 也要有角标');
  assert.match(ui, /scrollRemember\('war'/, '出征窗重绘要记住滚动位置');
  assert.match(ui, /war\.tab = 'encounter'; renderWar\(cache \|\| s\)/, '队列页要给出直达战况页的按钮');
  assert.match(ui, /s\.pendingBattles \|\| \[\]\)\.length \|\| \(s\.autoBattles \|\| \[\]\)\.length\) \? 'encounter'/, '入口要按战况智能落页');
  assert.ok(!/__slgWarWindow\(\{ tab: 'go' \}\)/.test(ui), '入口不该再硬编码回集结页');
});
