/**
 * P44（2026-11-22）AI 行军表现回归：诸侯军只画静态红线/箭头/兵力/抵达旬，
 * 不按帧插值、不流光、不呼吸，也不再驱动 rAF；玩家行军动画保持不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'server/skills.js'), 'utf8');
const seg = src.slice(src.indexOf('if (s.marches && s.marches.length)'), src.indexOf('if (logOpen && logTab ==='));
const tail = src.slice(src.indexOf('var playerMarching = function (st)'), src.indexOf('})();', src.indexOf('var playerMarching')));

test('P44-① 敌方走静态分支：完整路线 + 固定徽章 + 势力/目标/抵达旬', () => {
  assert.ok(seg.includes('if (isFoe) {'), '敌方独立分支');
  assert.ok(seg.includes('var fLen = total * 0.62'), '标记位置固定，不按当前时间插值');
  assert.ok(seg.includes("' · 第 ' + Math.max(1, Math.floor(Number(mm.arriveDay) || 1)) + ' 日抵达'"), '抵达旬可见');
  assert.ok(seg.includes('(mm.factionName || \'诸侯军\')'), '势力名可见');
  assert.ok(seg.includes('g.strokeText(fLabel'), '标签有描边，红底上可读');
  assert.ok(seg.includes('return;'), '敌方分支不再落到玩家动画绘制');
});

test('P44-② 敌方分支内没有时间驱动的动画量', () => {
  const foe = seg.slice(seg.indexOf('if (isFoe) {'), seg.indexOf('var walked = p * total;'));
  assert.doesNotMatch(foe, /Date\.now\(\)|lineDashOffset|pulse|dayNow/, '敌方不逐帧移动/呼吸/流光');
  assert.doesNotMatch(foe, /setLineDash/, '敌方路线为静态实线');
});

test('P44-③ 只有玩家行军驱动重绘，AI 实体仍被快照保留', () => {
  assert.ok(tail.includes("!mm.resolved && (!mm.side || mm.side === 'player')"), 'rAF 只认玩家队伍');
  assert.doesNotMatch(tail, /return !mm\.resolved;/);
  assert.ok(src.includes('id="slgFoeMarch"'), '页脚给出静态标记图例');
  const st = readFileSync(resolve(ROOT, 'server/domain/strategy.js'), 'utf8');
  assert.ok(st.includes("side: 'faction'"), 'AI 行军实体仍在领域层生成，仅表现层不动画');
});
