/**
 * R2 · 领域逻辑补充覆盖（对应《测试方案》§三 第 5/7/8/11/13/15 域、§五 法 2/4/5）
 *
 * 只补既有 25 个测试文件没覆盖到的空白：
 *   1) 设施配置完整性（26 类 × maxLevel / 首级 need / 工期）
 *   2) 委任加成红线：≤30%、随城数递减、出征中减半
 *   3) 单一事实源：同一人口在 strategyViewState / panelState 两处一致
 *   4) 势力 AI：8 诸侯都产出结构化指令单
 *   5) 行军图：80 节点 / 125 边 / 8 关隘，封关后不可通行
 *   6) 战法等级曲线：Lv10 = 2 × Lv1
 *   7) 确定性：同种子同事件指纹
 *   8) 旧档归一化：NaN / null / 负数槽位收敛为 0
 *   9) 注入层确定性：UI 源码不得出现 Math.random
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, strategyViewState, strategySnapshot, factionConf } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { panelState, postBonusPct, PANEL_CONF } from '../server/domain/panels.js';
import { planCampaign } from '../server/domain/strategy-brain.js';
import { marchGraph, edgePassable, isGateBlocked, setGateStatus } from '../server/domain/march.js';
import { levelValue } from '../kernel/index.js';
import { resolveBattle } from '../server/battle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();

// createWorld 只给骨架，normalizeWorld 才补齐 strategy/tavern/panels 等派生字段
const freshWorld = () => normalizeWorld(createWorld(cfg), cfg);

test('R2 · 领域逻辑补充覆盖', async (t) => {
  await t.test('设施配置：26 类，每类 maxLevel>0 且有首级 need 与工期', () => {
    const types = [...cfg.facilityByType.keys()];
    assert.ok(types.length >= 26, `设施类型应 ≥26，实际 ${types.length}`);

    const bad = [];
    for (const type of types) {
      const max = cfg.facilityMaxLevel(type);
      if (!(max > 0)) { bad.push(`type=${type} maxLevel=${max}`); continue; }
      const need = cfg.facilityNeed(type, 1);
      if (!need || typeof need !== 'object') bad.push(`type=${type} 无首级 need`);
      const time = cfg.facilityTime(type, 1);
      if (!(time >= 0)) bad.push(`type=${type} 工期非法 ${time}`);
      // 满级那一档也必须存在（否则升到上限时会拿到 null）
      if (cfg.facilityNeed(type, max) == null) bad.push(`type=${type} 满级(${max}) 缺 need`);
    }
    assert.deepEqual(bad, [], `设施配置不完整：\n${bad.join('\n')}`);
  });

  await t.test('委任红线：单岗 ≤30%，随城数递减（每城 -2），出征中减半', () => {
    const red = PANEL_CONF.posts.redline;
    assert.equal(red.maxBonusPct, 30, '红线必须写死 30%');
    assert.ok(red.decayPerCity > 0, '必须定义随城数递减');

    const w = freshWorld();
    ensureStrategy(w, cfg);
    const postId = PANEL_CONF.posts.posts[0].id;
    const gid = w.generals[0].id;

    // 不在队中 → 全额
    w.armys.forEach((a) => { a.generals = (a.generals || []).map((x) => (x === gid ? 0 : x)); });
    w.interior = w.interior || {};
    w.interior.posts = { ...(w.interior.posts || {}), [postId]: gid };
    const home = postBonusPct(w)[postId];
    assert.ok(home >= 0 && home <= 30, `加成应在 [0,30]，实际 ${home}`);

    // 城数 +3 → 每城递减 decayPerCity
    const baseLen = w.citys.length;
    for (let i = 0; i < 3; i++) w.citys.push({ ...w.citys[0], cityId: 900 + i });
    const many = postBonusPct(w)[postId];
    const expectMany = Math.max(0, home - 3 * red.decayPerCity);
    assert.equal(many, expectMany, `城数 +3 应递减 ${3 * red.decayPerCity}：${home} → ${many}（期望 ${expectMany}）`);
    w.citys.length = baseLen;

    // 回到队中 → 减半
    w.armys[0].generals[0] = gid;
    const deployed = postBonusPct(w)[postId];
    assert.equal(deployed, Math.max(0, home / 2), `出征中应减半：${home} → ${deployed}`);
  });

  await t.test('单一事实源：两处视图的同名字段必须逐城一致', () => {
    const w = freshWorld();
    ensureStrategy(w, cfg);
    ensureCityEcon(w);
    const view = strategyViewState(w, cfg).cities;
    const panel = panelState(w, cfg).strategy.cities;
    assert.equal(panel.length, view.length, '两处城数必须一致');

    const bad = [];
    for (const v of view) {
      const p = panel.find((x) => x.id === v.id);
      if (!p) { bad.push(`城 ${v.id} 在六府视图缺失`); continue; }
      for (const k of ['name', 'province', 'level', 'owner', 'ownerName', 'troops', 'terrain', 'specialty', 'arms']) {
        if (String(p[k] ?? '') !== String(v[k] ?? '')) bad.push(`城 ${v.id}.${k}: 六府=${p[k]} 战略台=${v[k]}`);
      }
    }
    assert.deepEqual(bad.slice(0, 12), [], `同名字段跨视图不一致：\n${bad.slice(0, 12).join('\n')}`);
  });

  await t.test('势力 AI：8 诸侯都产出目标与指令单', () => {
    const w = freshWorld();
    ensureStrategy(w, cfg);
    const factions = factionConf().factions;
    assert.equal(factions.length, 8, '应有 8 个诸侯');

    const bad = [];
    const seen = new Set();
    for (const f of factions) {
      const r = planCampaign(f, strategySnapshot(w, f.id), w);
      if (!r || !r.goal || typeof r.goal.type !== 'string' || !r.goal.type) { bad.push(`${f.name} 缺目标`); continue; }
      seen.add(r.goal.type);
      if (r.protocol !== 'slg-ai-orders-v1') bad.push(`${f.name} 协议号错误：${r.protocol}`);
      if (!Array.isArray(r.internal_orders) || !Array.isArray(r.strategy_orders)) {
        bad.push(`${f.name} 指令单结构不合法`);
        continue;
      }
      // 指令 id 前缀必须与分桶一致（I=内政 / S=战略），否则 applyOrders 会漏执行
      if (r.internal_orders.some((o) => !o.id.startsWith('I'))) bad.push(`${f.name} 内政单混入非 I 前缀`);
      if (r.strategy_orders.some((o) => !o.id.startsWith('S'))) bad.push(`${f.name} 战略单混入非 S 前缀`);
      if (r.internal_orders.length + r.strategy_orders.length === 0) bad.push(`${f.name} 指令单为空`);
      if (!Array.isArray(r.goal.reason) || !r.goal.reason[0]) bad.push(`${f.name} 缺归因 reason`);
    }
    assert.deepEqual(bad, [], `诸侯 AI 输出不完整：\n${bad.join('\n')}`);
    assert.ok(seen.size >= 2, `8 个诸侯的目标不应完全相同（当前只有 ${[...seen].join('/')}）`);
  });

  await t.test('行军图：80 节点 / 125 边 / 8 关隘，封关后跨关边不可通行', () => {
    const g = marchGraph();
    assert.ok(g, '行军图必须能加载');
    assert.equal(g.nodes.length, 80, `节点应为 80，实际 ${g.nodes.length}`);
    assert.equal(g.edges.size, 125, `边应为 125，实际 ${g.edges.size}`);
    assert.equal(Object.keys(g.gateStatus).length, 8, '应有 8 个关隘');

    // 关隘在路网里本身就是节点：跨关边是「城 → 关隘」（toCityId 为 null）
    const gated = [...g.edges.values()].filter((e) => e.gate);
    assert.ok(gated.length > 0, '至少有一条边跨关隘');
    const edge = gated[0];

    assert.equal(edgePassable(edge.id), true, `封锁前 ${edge.from}→${edge.to} 应可通行`);
    setGateStatus(edge.gate, '封锁');
    assert.equal(isGateBlocked(edge.gate), true, `关隘 ${edge.gate} 应处于封锁态`);
    assert.equal(edgePassable(edge.id), false, `封锁 ${edge.gate} 后该边应不可通行`);
    setGateStatus(edge.gate, '通行');
    assert.equal(edgePassable(edge.id), true, '恢复通行后应重新可用');
  });

  await t.test('战法等级曲线：Lv10 恰为 Lv1 的 2 倍且单调不减', () => {
    assert.equal(levelValue(100, 1), 100);
    assert.equal(levelValue(100, 10), 200, 'Lv10 必须恰为 Lv1 的 2 倍');
    let prev = -Infinity;
    for (let lv = 1; lv <= 10; lv++) {
      const v = levelValue(100, lv);
      assert.ok(v >= prev, `等级曲线必须单调不减：Lv${lv}=${v}`);
      prev = v;
    }
  });

  await t.test('确定性：同一世界同种子两次战斗，事件指纹与结果一致', () => {
    const w = freshWorld();
    const army = w.armys[0];
    army.soldiers = [800, 0, 0];
    army.generals = [w.generals[0].id, 0, 0];
    const spot = { x: 100, y: 100 };

    const a = resolveBattle({ cfg, state: w, army, x: spot.x, y: spot.y, seed: 424242 });
    const b = resolveBattle({ cfg, state: w, army, x: spot.x, y: spot.y, seed: 424242 });

    assert.equal(a.kernel.event_fingerprint, b.kernel.event_fingerprint, '同种子必须同事件指纹');
    assert.equal(a.report.result, b.report.result, '同种子必须同胜负');
    assert.equal(a.kernel.events.length, b.kernel.events.length, '同种子事件数应一致');
    assert.ok(a.kernel.events.length > 0, '必须真的打了（事件数 > 0）');
    assert.ok(a.report.rounds && a.report.rounds.length > 0, '必须有逐回合战报');
  });

  await t.test('旧档归一化：NaN / null / 负数的三槽字段收敛为 0', () => {
    const w = freshWorld();
    const dirty = JSON.parse(JSON.stringify(w));
    dirty.armys[0].soldiers = [NaN, null, -5];
    dirty.armys[0].con_times = [NaN, -1, null];
    dirty.armys[0].con_cnts = [null, NaN, -9];
    dirty.armys[0].generals = [NaN, null, -1];

    const fixed = normalizeWorld(dirty, cfg);
    for (const k of ['soldiers', 'con_times', 'con_cnts', 'generals']) {
      const arr = fixed.armys[0][k];
      assert.ok(Array.isArray(arr) && arr.length === 3, `${k} 必须归一为长度 3 的数组，实际 ${JSON.stringify(arr)}`);
      assert.deepEqual(arr, [0, 0, 0], `${k} 非有限数与负数必须收敛为 0，实际 ${JSON.stringify(arr)}`);
    }
  });

  await t.test('注入层确定性：面板/注入源码不含 Math.random', () => {
    const bad = [];
    for (const f of ['server/panels-ui.js', 'server/skills.js', 'server/interaction-ui.js']) {
      if (/Math\.random\s*\(/.test(readFileSync(join(ROOT, f), 'utf8'))) bad.push(f);
    }
    assert.deepEqual(bad, [], `面板/注入层不得调用 Math.random（P2.3 红线）：${bad.join(', ')}`);
  });
});
