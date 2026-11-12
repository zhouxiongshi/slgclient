/**
 * U15 相性 / 义理 / 关系网 / 登庸成功率构成条。
 *
 * 锁四件事：
 *  1. 相性落在 1–149 环形、同编号恒定、同势力聚集但个体有差；
 *  2. 义理由史载五维折算且落在 0–100；
 *  3. 关系网只收演义可考条目、双向可查、带出处；
 *  4. 成功率构成条各项相加 == 最终成功率（截断前），且与掷骰同源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy } from '../server/domain/strategy.js';
import {
  relationConf, xiangxingOf, xiangxingGap, xiangxingBonus, yiliOf,
  bondsOf, relationSummary, talentRecruitRate, relationGraph,
} from '../server/domain/relation.js';

const cfg = loadConfig();
const conf = relationConf();

function freshState() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  return state;
}

test('相性：1–149 环形、同编号恒定、按势力聚集（本作设定）', () => {
  const ids = [...cfg.generalByCfg.keys()].slice(0, 200);
  for (const id of ids) {
    const camp = cfg.generalByCfg.get(id).camp ?? 1;
    const x = xiangxingOf(id, camp);
    assert.ok(x >= 1 && x <= 149, `相性越界：${id} → ${x}`);
    assert.equal(x, xiangxingOf(id, camp), '同编号必须恒定（可复现）');
  }
  // 同势力的人应聚集在锚点附近（±spread）
  const spread = Number(conf.xiangxing.spread);
  for (const camp of [1, 3, 4, 5]) {
    const anchor = Number(conf.xiangxing.anchors[String(camp)]);
    const rows = ids.filter((id) => (cfg.generalByCfg.get(id).camp ?? 1) === camp).slice(0, 20);
    for (const id of rows) {
      const x = xiangxingOf(id, camp);
      const d = Math.min(Math.abs(x - anchor), 149 - Math.abs(x - anchor));
      assert.ok(d <= spread, `势力 ${camp} 相性应聚集在 ${anchor}±${spread}，实际 ${x}`);
    }
  }
});

test('相性差是环形最短距离，上下界与加成方向正确', () => {
  assert.equal(xiangxingGap(10, 14), 4);
  // 149 个取值成环：148→149→1→2 共 3 步
  assert.equal(xiangxingGap(148, 2), 3, '跨环两端应取最短距离');
  assert.equal(xiangxingGap(1, 1), 0);
  assert.equal(xiangxingGap(1, 76), 74, '最远 74');
  // 越近加成越高，且正负对称
  assert.ok(xiangxingBonus(0) > xiangxingBonus(30));
  assert.ok(xiangxingBonus(30) > xiangxingBonus(74));
  assert.equal(xiangxingBonus(0), 12);
  assert.equal(xiangxingBonus(74), -12);
  assert.equal(xiangxingBonus(37), 0, '中点应为 0');
});

test('义理：由史载政治×0.6 + 魅力×0.4 折算，落 0–100', () => {
  const cao = [...cfg.generalByCfg.values()].find((g) => g.name === '曹操');
  assert.ok(cao, '配置里应有曹操');
  const y = yiliOf(cao.cfgId);
  assert.ok(y >= 0 && y <= 100);
  // 曹操史载政治 98 / 魅力 92 → 96
  assert.equal(y, 96);
  // 无史料者按 50/50 兜底 → 50
  assert.equal(yiliOf(999999), 50);
});

test('关系网：双向可查、带演义出处、摘要分亲爱/君臣/敌对', () => {
  const s = bondsOf('刘备');
  const names = s.map((b) => b.other);
  assert.ok(names.includes('关羽') && names.includes('诸葛亮'));
  const back = bondsOf('关羽').map((b) => b.other);
  assert.ok(back.includes('刘备'), '关系必须双向可查');
  for (const b of s) {
    assert.ok(b.type && b.note && b.source, `关系缺字段：${JSON.stringify(b)}`);
    assert.ok(/演义/.test(b.source), '出处应指向演义回目');
    assert.ok(['sworn', 'lord', 'rival'].includes(b.tone));
  }
  const r = relationSummary('曹操');
  assert.ok(r.lord.some((b) => b.name === '荀彧'));
  assert.ok(r.rival.some((b) => b.name === '张绣'));
  assert.ok(r.sworn.some((b) => b.name === '夏侯惇'));
  // 无关系者给空数组 + 明确说明，不编造
  const none = relationSummary('十常士');
  assert.deepEqual(none.sworn, []);
  assert.ok(/未收/.test(none.note));
});

test('登庸成功率：构成条各项相加 == 最终成功率（含截断项）', () => {
  const state = freshState();
  const person = { cfgId: 100023, name: '曹操' };
  const calc = talentRecruitRate(state, cfg, person);
  const sum = Math.round(calc.parts.reduce((n, p) => n + p.value, 0) * 10) / 10;
  assert.equal(sum, calc.rate, `构成条之和 ${sum} 应等于成功率 ${calc.rate}`);
  assert.ok(calc.rate >= 5 && calc.rate <= 95);
  assert.ok(calc.parts.some((p) => /相性差/.test(p.label)), '构成条必须包含相性项');
  assert.ok(calc.parts.some((p) => /义理/.test(p.label)), '构成条必须包含义理项');
  // 三顾之礼：被拒一次 +12
  state.tavern = state.tavern || {};
  state.tavern.favor = { [person.cfgId]: 1 };
  const withFavor = talentRecruitRate(state, cfg, person);
  assert.ok(withFavor.rate > calc.rate, '再访应更容易（未触上限时）');
  assert.ok(withFavor.parts.some((p) => /三顾之礼/.test(p.label)));
});

test('登庸成功率对相性差敏感：差越小成功率越高', () => {
  const state = freshState();
  const lordX = xiangxingOf(880001, cfg.generalByCfg.get(880001)?.camp ?? 1);
  const ids = [...cfg.generalByCfg.keys()];
  const scored = ids.slice(0, 60).map((id) => {
    const camp = cfg.generalByCfg.get(id).camp ?? 1;
    return { id, gap: xiangxingGap(lordX, xiangxingOf(id, camp)), rate: talentRecruitRate(state, cfg, { cfgId: id }).rate };
  });
  const near = scored.filter((s) => s.gap <= 10);
  const far = scored.filter((s) => s.gap >= 40);
  const avg = (arr) => arr.reduce((n, s) => n + s.rate, 0) / Math.max(1, arr.length);
  if (near.length && far.length) assert.ok(avg(near) > avg(far), `近相性平均应更高：${avg(near)} vs ${avg(far)}`);
});

test('关系网图只连玩家已有的武将（不泄露未招募关系）', () => {
  const state = freshState();
  const nameOf = (g) => cfg.generalByCfg.get(Number(g.cfgId))?.name || '';
  const two = [{ cfgId: 100023 }, { cfgId: 100031 }];   // 曹操、周瑜：演义无直接关系
  const g = relationGraph(two, nameOf);
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 0, '无关者之间不应凭空连边');
  const liu = [{ cfgId: [...cfg.generalByCfg.values()].find((x) => x.name === '刘备').cfgId },
    { cfgId: [...cfg.generalByCfg.values()].find((x) => x.name === '关羽').cfgId }];
  assert.equal(relationGraph(liu, nameOf).edges.length, 1, '刘备-关羽应有一条边');
});
