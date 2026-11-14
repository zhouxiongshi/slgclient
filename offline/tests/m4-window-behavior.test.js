/**
 * M4-6 窗口行为与弹层治理回归。
 *
 * 用户实机反馈两条：
 *   ① 游戏一直压在最上层，点不到其他应用、也点不到任务栏最小化按钮（"无法缩小"）；
 *   ② 弹窗一直出现在最上层、挡住整个游戏。
 *
 * 根因（两条都是真缺陷，不是使用习惯）：
 *   - electron/main.cjs 在自动化环境变量下 setAlwaysOnTop(true,'screen-saver')；
 *     该层在 Windows 高于任务栏，且进程一旦继承 SLG_* 变量，正常游玩也会永久置顶。
 *   - interaction-ui.js 的事件卡是整屏模态 + 必答（点遮罩只 stopPropagation）+ 20s
 *     轮询重建；玩家不选就被永久挡住，关掉也会在 20 秒后原样弹回。
 *
 * 这里做静态纪律断言；真实点击链路由双态冒烟 / ui-audit / mouse-playtest 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const main = read('electron/main.cjs');
/* 注释里会记录「旧实现曾怎么写」用于排障，纪律断言只看真正的代码行，
   否则注释一提到 screen-saver / Math.random 就会假红。 */
const mainCode = main.split('\n')
  .filter((line) => !/^\s*(?:\/\*|\*|\/\/)/.test(line)).join('\n');
const preload = read('electron/preload.cjs');
const ix = read('server/interaction-ui.js');
const shell = read('server/ui-shell.js');

test('M4-6·窗口默认绝不置顶，且可最小化 / 可缩小 / 可切换应用', () => {
  assert.match(mainCode,/alwaysOnTop:\s*false/, 'BrowserWindow 必须显式关闭置顶');
  assert.match(mainCode,/minimizable:\s*true/);
  assert.match(mainCode,/maximizable:\s*true/);
  assert.match(mainCode,/resizable:\s*true/);
  assert.match(mainCode,/fullscreenable:\s*true/);
  assert.match(mainCode,/minWidth:\s*Math\.min\(900/, '窗口可拖到比 1024 更小');
  assert.doesNotMatch(mainCode,/setAlwaysOnTop\(true,\s*'screen-saver'\)/,
    'screen-saver 层高于任务栏，禁止再出现');
  assert.match(mainCode,/backgroundThrottling:\s*false/, '遮挡时 rAF 仍由该开关兜住');
});

test('M4-6·自动化不霸屏；置顶只能由玩家显式开启且只用 floating 层', () => {
  assert.doesNotMatch(mainCode,/^\s*win\.setAlwaysOnTop\(true/m,
    '自动化分支不得无条件置顶');
  assert.match(mainCode,/SLG_FORCE_TOP === '1'\) win\.setAlwaysOnTop\(true, 'floating'\)/,
    'CI 逃生口必须是显式环境变量');
  assert.match(mainCode,/setAlwaysOnTop\(!!on, 'floating'\)/);
  assert.match(mainCode,/win:always-on-top/);
  assert.match(mainCode,/win:minimize/);
  assert.match(mainCode,/win:is-always-on-top/);
});

test('M4-6·二次启动不抢焦点，隔离目录不使用 Math.random', () => {
  assert.match(mainCode,/win\.showInactive\(\)/, '不得把玩家从别的应用拽回游戏');
  assert.match(mainCode,/second-instance/);
  assert.doesNotMatch(mainCode,/Math\.random/, '壳层不引入随机数');
  assert.match(mainCode,/process\.hrtime\.bigint\(\)/);
});

test('M4-6·preload 是最小权限白名单，不泄漏 ipcRenderer / node', () => {
  assert.ok(existsSync(join(ROOT, 'electron', 'preload.cjs')));
  assert.match(mainCode,/preload:\s*path\.join\(__dirname, 'preload\.cjs'\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('__slgWin'/);
  for (const k of ['isElectron', 'isAlwaysOnTop', 'setAlwaysOnTop', 'minimize']) {
    assert.match(preload, new RegExp(`\\b${k}\\b`), `缺少白名单方法 ${k}`);
  }
  assert.doesNotMatch(preload, /require\('(?:node:)?fs'\)/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/,
    '不得把 ipcRenderer 整个暴露给页面');
  assert.doesNotMatch(preload, /nodeIntegration/);
});

test('M4-6·设置面板提供置顶开关与最小化入口，且仅在 Electron 内出现', () => {
  assert.match(ix, /window\.__slgWin && window\.__slgWin\.isElectron/);
  assert.match(ix, /data-act="ontop"/);
  assert.match(ix, /data-act="minimize"/);
  assert.match(ix, /setAlwaysOnTop\(!S\.alwaysOnTop\)/);
  assert.match(ix, /alwaysOnTop: false/, '默认状态必须是关');
  assert.doesNotMatch(ix, /alwaysOnTop: S\.|saved\.alwaysOnTop/,
    '置顶状态不得持久化，否则重启又霸屏');
  assert.match(ix, /重启游戏自动关闭/);
});

test('M4-6·事件卡非模态、可收起、不再无限复活', () => {
  assert.match(ix, /\.slgIx-modal\.slgIxEvent\{inset:auto;right:16px;bottom:92px/,
    '事件卡不得再整屏遮罩');
  assert.match(ix, /\.slgIx-modal\.slgIxEvent\{[^}]*pointer-events:none/);
  assert.match(ix, /\.slgIx-modal\.slgIxEvent \.box\{[^}]*pointer-events:auto/);
  assert.match(ix, /data-evt-later="1"/, '必须有「稍后处理」按钮');
  assert.match(ix, /dismissedEvents/, '必须有会话内静音表');
  assert.match(ix, /function dismissEvent\(/);
  assert.match(ix, /slgIxEventBadge/, '必须有未决事件徽标可重新打开');
  assert.match(ix, /function updateEventBadge\(/);
  assert.doesNotMatch(ix, /必答卡：点遮罩不关闭/, '旧的「必答不关闭」注释与行为都要移除');
  assert.match(ix, /if \(e\.target === mask\) dismissEvent\(want\.id, mask\)/);
  /* Esc / Shift+Esc 两条关闭路径都必须走静音，否则 20s 后复活 */
  assert.equal((ix.match(/dismissEvent\(m\.dataset\.evtId, m\)/g) || []).length, 1);
  assert.equal((ix.match(/dismissEvent\(top\.dataset\.evtId, top\)/g) || []).length, 1);
});

test('M4-6·一屏一窗统计排除非模态事件卡', () => {
  assert.match(shell, /\.slgIx-modal:not\(\.slgIxEvent\), #slgUIv2 \.modal/,
    '事件卡不能触发 data-slg-dialog 把 dock / 图例全隐藏');
});
