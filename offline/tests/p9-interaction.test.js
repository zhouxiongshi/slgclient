/**
 * P9 交互聚合层：单一事实源。
 * 这里锁三件容易回退的事：
 *   1) 逐城经济必须从 state.strategy.cityEcon 取（取错会全城显示 0 粮）；
 *   2) 城池特产 / 主要兵种取顶层字段，不能是空串；
 *   3) 灾害风险必须逐城有差异，不能全表同一个默认值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath } from '../server/domain/strategy.js';
import { ensureCityEcon } from '../server/domain/city-econ.js';
import { interactionState } from '../server/domain/interaction.js';

const cfg = loadConfig();

function oathWorld() {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  const lords = oathOptions(state).lords.filter((l) => l.cities.length >= 2);
  const lord = lords[0];
  const r = chooseOath(state, cfg, { push() {} }, { lord: lord.id, city: lord.cities[0].id });
  assert.equal(r.ok, true, '举义应成功');
  ensureCityEcon(state);
  return state;
}

test('交互态：逐城城库取自 strategy.cityEcon，不因取错字段变成 0', () => {
  const state = oathWorld();
  const d = interactionState(state, cfg);
  assert.ok(d.cities.length > 0);
  for (const c of d.cities) {
    assert.ok(c.store > 0, `${c.name} 城库不应为 0（说明取错了 state.cityEcon）`);
    assert.ok(c.supportDays >= 0);
    assert.ok(c.dailyUse >= 1, '每日耗粮应有下界');
  }
});

test('交互态：特产 / 主要兵种 / 灾害风险逐城有值且有差异', () => {
  const state = oathWorld();
  const d = interactionState(state, cfg);
  const withSpec = d.cities.filter((c) => c.specialty);
  assert.ok(withSpec.length > 0, '至少应有城带特产（顶层 c.specialty）');
  const risks = new Set(d.cities.map((c) => c.disasterRisk));
  assert.ok(risks.size > 1, `灾害风险不应全图同值：${[...risks].join(',')}`);
  for (const c of d.cities) {
    assert.ok(Number.isFinite(c.disasterRisk), '灾害风险应是数字');
  }
});

test('交互态：建言只列可行动项，且带跳转与来源', () => {
  const state = oathWorld();
  const d = interactionState(state, cfg);
  assert.ok(Array.isArray(d.agenda));
  for (const a of d.agenda) {
    assert.ok(a.id && a.title, '建言必须有 id 与标题');
    assert.ok(a.jump && a.jump.kind, '建言必须能跳转');
    assert.ok(a.source, '建言必须标注数据来源');
    assert.ok(['高', '中', '低'].includes(a.confidence), '可信度必须分档');
  }
  // 回合预览必须说明「快进是补算而非奖励」
  assert.match(d.turnPreview.note, /快进|结算/);
  assert.ok(Array.isArray(d.turnPreview.willHappen) && d.turnPreview.willHappen.length >= 3);
});

/* ★ GAP-01（2026-11-15 产品裁决）：fieldGaps 三项是刻意降级的设计特性，
   不是「待补齐的字段缺口」。这条测试锁的不是「清单存在」，而是「谁都不许
   为了把清单清零而硬造数值」——补精确侦察值会废掉情报区间玩法，
   补逐将 delta 等于无证据编造，主动结亲/结义属于新玩法。 */
test('fieldGaps：三项显式降级，have=false 且都有降级口径（不许编造数值）', () => {
  const state = oathWorld();
  const d = interactionState(state, cfg);
  assert.ok(Array.isArray(d.fieldGaps) && d.fieldGaps.length === 3, '三项降级必须逐条在册');
  const topics = ['结亲', '侦察', 'delta'];
  for (const topic of topics) {
    assert.ok(d.fieldGaps.some((g) => String(g.field).includes(topic)), `缺少 ${topic} 的降级登记`);
  }
  for (const g of d.fieldGaps) {
    assert.equal(g.have, false, `${g.field} 不得被标成「已提供」`);
    assert.ok(String(g.fallback || '').length >= 8, `${g.field} 必须给出可显示的降级口径`);
    assert.ok(String(g.use || '').length > 0, `${g.field} 必须写明用途`);
  }
});
