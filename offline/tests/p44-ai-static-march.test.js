/**
 * P44（2026-11-22）AI 行军表现回归 —— ★ P62（2026-11-25）按用户要求换代。
 *
 * 旧口径：诸侯军只画静态红线/固定徽章，不按帧插值、不驱动 rAF。
 * 新口径：玩家明确要求「部队出征要有移动动画、队伍相遇要在地图上触发」，
 *        诸侯军（援军、来犯军）是最该被看见的威胁，改为与玩家军共用同一套
 *        插值移动 + 部队棋子；性能由「沙盘可见 + 20fps 上限」控制。
 *
 * 因此旧断言（敌方静态分支 / 只有玩家驱动 rAF）整条替换；
 * 仍然守护的底线：AI 行军实体照旧在领域层生成，表现层不另造数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'server/skills.js'), 'utf8');
/* ★ P65：月度行军回放把起点条件扩成「在途 || 回放」，切片起点不能用旧字面量，
   否则 indexOf=-1 取到空串，明明绘制实现还在却误报整段丢失。 */
const marchAt = src.indexOf('// ★ P2：行军线与移动军标');
if (marchAt < 0) throw new Error('找不到行军绘制段');
const seg = src.slice(marchAt, src.indexOf('if (logOpen && logTab ===', marchAt));
const rafAt = src.indexOf('var anyMarching = function (st)');
const tail = rafAt < 0 ? '' : src.slice(rafAt, src.indexOf('})();', rafAt));

test('P62-① 诸侯军不再走静态分支，与玩家军共用移动绘制', () => {
  assert.doesNotMatch(seg, /if \(isFoe\) \{\s*\n\s*var fLen = total \* 0\.62/, '旧静态分支必须撤掉');
  assert.doesNotMatch(seg, /total \* 0\.62/, '固定 62% 位置的静态标记不得回潮');
  assert.ok(seg.includes('drawTroopToken'), '两边共用部队棋子绘制');
  assert.ok(seg.includes("isFoe ? '225,92,72' : '232,198,112'"), '敌方赤红、我方金色仍要区分');
});

test('P62-② 双方军标都由时间驱动：插值移动 + 流光 + 踏步相位', () => {
  assert.ok(seg.includes('var walked = p * total;'), '按日进度插值走位');
  assert.ok(seg.includes('lineDashOffset'), '未走路段是流动虚线');
  assert.ok(seg.includes('Date.now() % 1600'), '棋子相位由时间驱动（踏步/旗面）');
  /* 部队棋子三件套：旗、兵卒队列、队尾扬尘 */
  assert.ok(seg.includes('drawTroopToken'), '棋子函数在调用点可见');
  const token = src.slice(src.indexOf('function drawTroopToken'), src.indexOf('return { labelY:'));
  assert.ok(token.includes('兵卒横队'), '有兵卒队列');
  assert.ok(token.includes('旗杆'), '有旗杆');
  assert.ok(token.includes('扬尘'), '有队尾扬尘');
});

test('P62-③ 任何在途部队都驱动重绘；AI 实体仍由领域层生成', () => {
  assert.ok(tail.includes('!mm.resolved && !mm.recalled'), 'rAF 认全部在途行军，不再只认玩家');
  assert.match(tail, /anyMarching/, '函数名与「任何行军」语义一致');
  const st = readFileSync(resolve(ROOT, 'server/domain/strategy.js'), 'utf8');
  assert.ok(st.includes("side: 'faction'"), 'AI 行军实体仍在领域层生成，只是表现层开始动起来');
  /* 页脚不能再宣称「静态标记」 */
  assert.doesNotMatch(src, /静态标记，不逐帧移动/);
});
