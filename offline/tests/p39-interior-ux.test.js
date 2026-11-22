/**
 * P39（2026-11-22）内政界面减负回归：
 *  1. 城内页只主推一步，六项委派收进「全部任务」，功能不删；
 *  2. 下一步链接从委派卡移到推荐卡，入口更集中；
 *  3. 内政/委任/撤销的拒绝原因统一走中文 errText，不再直出 reason。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'server/skills.js'), 'utf8');
const seg = src.slice(src.indexOf('function tabInteriorView'), src.indexOf('function tabGeneralView'));

test('P39-① 主视口只给推荐一步，六项委派可展开且按钮都在', () => {
  assert.ok(seg.includes('当前推荐一步'), '必须有单一推荐卡');
  assert.ok(seg.includes("mkBtn('一键委派'") && seg.includes("mkBtn('全部任务'"), '一键委派 + 展开入口');
  assert.ok(seg.includes("recommend.appendChild(popRow)"), '劝课生息保留常驻快捷入口');
  assert.ok(seg.includes("invCard.style.display = 'none'"), '默认收起次要任务');
  assert.ok(seg.includes('body.insertBefore(invCard, taskCard)'), '展开后仍在任务状之前');
  for (const label of ['劝课生息', '开垦农田', '招商兴市', '募兵整编', '修筑城防']) {
    assert.ok(seg.includes("mkInv('" + label + "'"), `原有任务 ${label} 不得删`);
  }
  assert.ok(seg.includes("if (c.disaster || c.modUntil) mkInv('开仓赈灾'"), '赈灾仍按灾情出现');
});

test('P39-② 下一步链接集中到推荐卡，拒绝原因统一中文', () => {
  assert.ok(seg.includes("mkBtn('去征兵'") && seg.includes("mkBtn('去府库升级设施'"));
  assert.ok(seg.indexOf('recommend.appendChild(sink)') > 0, '跳转按钮落在推荐卡');
  assert.doesNotMatch(seg, /rs\.reason \|\| '未知'/, '禁止把英文 reason 弹给玩家');
  assert.match(src, /function errText[\s\S]{0,400}rsp\.reason/, 'errText 兼容平铺 reason');
  assert.match(src, /no_disaster: '本城眼下无灾可赈'/);
});
