/**
 * P33（2026-11-21）UI 可读性与展示一致性回归：
 *  1. 抉择记录/toast 不再暴露 flag / attitude / 英文势力 id；
 *  2. 跳转提示不再硬编码「视口与选中态未丢失（P4）」；
 *  3. 武将只保留人物卡右侧一套五维，属性页已并入人物卡；
 *  4. 无史载武将用本局属性回填，不再整栏「—」；
 *  5. 阵前俘虏独立表格 + data-id 精确处置，左栏不再挤三个按钮；
 *  6. 整编统一 0 基下标并给实时合计/余兵反馈；
 *  7. 兵刃面板把 bonusPct / forge.cost 翻成中文，不漏 JSON 报文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, strategyEventChoice } from '../server/domain/strategy.js';
import { panelState } from '../server/domain/panels.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const cfg = loadConfig();

test('P33-① 事件效果落账回传中文 appliedText，日志与 toast 同源', () => {
  const state = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(state);
  state.strategy.pendingEvents = [{ id: 'evt.189.dongzhuo.enter', title: '董卓入洛' }];
  const r = strategyEventChoice(state, cfg, { push() {} }, {
    id: 'evt.189.dongzhuo.enter', choice: 'submit',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.appliedText.includes('对董卓态度 +15'), r.appliedText);
  assert.doesNotMatch(r.appliedText, /flag|attitude|sili/i, '内部枚举不得出现在玩家文案');
  const rec = state.strategy.events.find((e) => String(e.text || '').includes('事件·抉择'));
  assert.ok(rec && rec.text.includes('对董卓态度 +15'), '日志必须用同一份中文文案');
  const ix = read('server/interaction-ui.js');
  assert.ok(ix.includes('res.appliedText'), 'toast 直接取服务端中文文案');
  assert.doesNotMatch(ix, /立flag/);
});

test('P33-② 跳转提示只说去向与返回方式，不再夹带内部断言/编号', () => {
  const ix = read('server/interaction-ui.js');
  assert.doesNotMatch(ix, /地图视口与选中态未丢失/);
  assert.ok(ix.includes("toast('已打开' + where + '；沙盘位置保持不变"), '提示应可操作');
  assert.ok(/jump: 'tavern'/.test(ix) && /kind === 'tavern'/.test(ix), '酒馆跳转未被破坏');
});

test('P33-③ 武将页只有一套属性：人物卡右侧五维，属性表格页删除', () => {
  const p = read('server/panels-ui.js');
  assert.ok(p.includes('function heroCardHtml(g)') && p.includes('function heroStateHtml(g)'));
  assert.doesNotMatch(p, /function genAttrHtml\(/);
  assert.doesNotMatch(p, /\['attr', '属性'\]/);
  assert.doesNotMatch(p, /属性 · ' \+ esc\(g\.name\)/);
  assert.ok(p.includes('本局战斗数值 0~100'), '统一口径保留');
  assert.ok(p.includes('史料档案 · 史载五维（0~100）'), '史载标签保留但不重复成第二页');
});

test('P33-④ 无史载武将取本局属性，不整栏空白；魅力缺源显示「未设」', () => {
  const p = read('server/panels-ui.js');
  assert.ok(p.includes('hasLoreStats ? loreStats[d]'), '有史载取史载五维');
  assert.ok(p.includes('localStats[CARD_STAT_KEYS[d]]'), '无史载取本局 final/base');
  assert.ok(p.includes("(known ? v : '未设')"), '无源字段明确标注，不编造');
  const view = panelState(createWorld(cfg), cfg);
  const prot = view.generals.find((g) => g.isProtagonist);
  assert.ok(prot && prot.base.force > 0, '主角本局五维必须存在');
});

test('P33-⑤ 俘虏独立表格精确到人，按钮带 data-id 且不再猜原属势力', () => {
  const p = read('server/panels-ui.js');
  assert.ok(p.includes('function captivePanelHtml()') && p.includes('id="slgCaptivePanel"'));
  assert.ok(p.includes('<button class="btn" data-act="captive" data-id="'));
  assert.ok(p.includes('<button class="capbtn" data-act="captiveRelease" data-id="'));
  assert.ok(p.includes('<button class="capbtn danger" data-act="captiveExecute" data-id="'));
  assert.doesNotMatch(p, /data-act="captiveRelease" data-i=/, '旧 data-i 导致永远作用在索引 0');
  const state = createWorld(cfg);
  state.captives = [{ cfgId: 100001, name: '吕布', from: '长安', loyal: 50, days: 1, day: 10 }];
  const view = panelState(state, cfg);
  assert.equal(view.captives[0].from, '长安');
  assert.equal(view.captives[0].cfgId, 100001);
  assert.ok(view.captives[0].rate > 0 && view.captives[0].rateParts.parts.length > 0);
});

test('P33-⑥ 整编 0 基下标统一，实时反馈与平分入口都在', () => {
  const p = read('server/panels-ui.js');
  assert.ok(p.includes('var generals = [0, 1, 2].map(function (slot)'));
  assert.ok(p.includes('data-fup="troop\' + slot + \'"'), '兵力输入改为 troop0~2');
  assert.ok(p.includes('data-fup="gen\' + slot + \'"'), '下拉 gen0~2');
  assert.ok(p.includes('slgFormupSummary') && p.includes('data-fup="even"'));
  assert.ok(p.includes('slotCapOfGen') && p.includes('满级三公 9500'));
  assert.doesNotMatch(p, /troop1\/troop2\/troop3/);
});

test('P33-⑦ 兵刃面板不直接展示 JSON 报文', () => {
  const p = read('server/panels-ui.js');
  assert.doesNotMatch(p, /JSON\.stringify\(worn\.bonusPct\)/);
  assert.doesNotMatch(p, /JSON\.stringify\(i\.forge\.cost\)/);
  assert.ok(p.includes('function statBonusText(o)') && p.includes('function costText(o)'));
  assert.ok(p.includes("COST_LABELS = { gold: '金'"), '材料有中文映射');
});
