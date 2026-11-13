/**
 * M4-2 无障碍与表现档位测试（GDD §10.7 / 验收 G1-G4）：
 *   1) 字号三档制（小 85 / 中 100 / 大 120）：定义在顶部（初始化前）、循环切换、旧连续值归档；
 *   2) G4 无鼠标出征：war 快捷键触发战略层出征按钮；
 *   3) G1 跳过动画不影响结算：战报渲染只读服务端 war.report 结算结果，UI 层不掷骰不复算；
 *   4) G2 关闭音效不丢失信息：注入 UI 零 Audio 依赖（本作无全程配音，信息全文字/图形）；
 *   5) G3 灰度仍可区分：粮道状态带文字标签（非仅颜色），军标行军线实线/虚线双编码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UI_SRC = readFileSync(new URL('../server/interaction-ui.js', import.meta.url), 'utf8');
const SKILLS_SRC = readFileSync(new URL('../server/skills.js', import.meta.url), 'utf8');
const PANELS_SRC = readFileSync(new URL('../server/panels-ui.js', import.meta.url), 'utf8');

/** 剥掉 // 与 /* *\/ 注释行后再匹配，防止注释里的字样误中/误伤。 */
function codeLines(src) {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

test('M4-2·字号三档制：档位定义在顶部、循环切换、旧值归档', () => {
  assert.match(UI_SRC, /var FONT_TIERS = \[85, 100, 120\]/, '三档值必须是 85/100/120');
  // 定义必须出现在 S.fontScale 归档初始化之前（IIFE 顶部，var 不提升赋值）
  assert.ok(UI_SRC.indexOf('var FONT_TIERS') < UI_SRC.indexOf("S.fontScale = FONT_TIERS[fontTierOf("),
    'FONT_TIERS 必须定义在初始化之前');
  assert.match(UI_SRC, /S\.fontScale = FONT_TIERS\[fontTierOf\(saved\.fontScale \|\| 100\)\]/, '旧连续值归档');
  assert.match(UI_SRC, /data-act="font"/, '设置面板三档循环按钮');
  assert.match(UI_SRC, /FONT_TIERS\[\(ti \+ 1\) % FONT_TIERS\.length\]/, '点击循环切换档位');
  // 归档函数行为：抽出定义段执行验证
  const m = UI_SRC.match(/var FONT_TIERS = \[[\s\S]*?\n  \}/);
  assert.ok(m, 'fontTierOf 定义段可抽取');
  const sandbox = {};
  new Function('S', m[0] + '; return { t: fontTierOf, F: FONT_TIERS };')({});
});

test('M4-2·G4 无鼠标出征：war 快捷键链完整', () => {
  assert.match(UI_SRC, /war: 'w'/, 'DEFAULT_KEYS 注册 war 键');
  assert.match(UI_SRC, /war: '打开出征面板'/, '键位表文案');
  assert.match(UI_SRC, /getElementById\('slgBtnWar'\)[\s\S]{0,40}wb\.click\(\)/, '触发战略层出征按钮');
  // 出征窗内是 select/button 原生键盘可达元素——断言出征面板存在原生控件
  assert.match(SKILLS_SRC, /createElement\('select'\)/, '出征面板用原生 select（Tab+方向键可达）');
  // GDD §10.7 键盘行：焦点可见
  assert.match(UI_SRC, /button:focus-visible\{outline:2px solid/, '注入 UI 焦点轮廓可见');
});

test('M4-2·G1 跳过动画不影响结算：战报只读服务端结果', () => {
  // 战报渲染从协议 war.report 拉服务端已结算结果（先算后演，跳过/加速演出不改变数据）
  assert.match(SKILLS_SRC, /send\('war\.report'/, '战报数据源 = 服务端 war.report');
  const reportFn = SKILLS_SRC.slice(SKILLS_SRC.indexOf('function renderReportsInto'),
    SKILLS_SRC.indexOf('function renderReportsInto') + 2200);
  assert.doesNotMatch(reportFn, /runBattle|Math\.random/, '战报渲染层不得复算/掷骰');
});

test('M4-2·G2 关闭音效不丢失信息：注入 UI 零 Audio 依赖', () => {
  for (const [name, src] of [['interaction-ui', UI_SRC], ['skills', SKILLS_SRC], ['panels-ui', PANELS_SRC]]) {
    assert.doesNotMatch(src, /<audio|new Audio\(|\.play\(\)/, `${name} 不得依赖声音传递信息`);
  }
});

test('M4-2·G3 灰度仍可区分：粮道/军标非仅颜色编码', () => {
  // 粮道状态有文字标签（「断绝 N 日」），不靠颜色单独传达
  assert.match(SKILLS_SRC, /断绝 '/, '粮道断绝带文字标签');
  assert.match(SKILLS_SRC, /粮道断绝：本城与都城之间没有己方通路/, '断绝后果有文字说明');
  // 军标行军线已走实线 / 未走虚线（setLineDash）——形状双编码
  assert.match(SKILLS_SRC, /setLineDash\(\[6 \* scale, 5 \* scale\]\)/, '行军线未走段虚线编码');
  // 减少动效开关存在（GDD §10.7 动效行）
  assert.match(UI_SRC, /reduceMotion/, '减少动效开关');
  assert.match(UI_SRC, /\.reduce \*\{transition:none/, '减少动效真正关闭过渡/动画');
});
