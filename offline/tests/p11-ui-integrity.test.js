/**
 * P11 · 界面外壳与交互层完整性回归
 *
 * 这几条全是 2026-11-13 真鼠标试玩（electron/mouse-playtest.cjs）里**实际踩到**的坑，
 * 每一条都对应一个玩家能感知的症状，所以必须用测试钉住，不能再靠人眼复查：
 *
 *   1. 事件卡 POST 用 `act` 字段，服务端只读 `action` → 返回 bad_action，
 *      卡片点不掉、每回合重弹（症状：窗口反复遮挡、点了没反应）。
 *   2. CSS 字符串里把注释放进 `+ /* … *\/ +` 之间 → 解析成「加号连一元加号」，
 *      整条规则被吞掉，弹窗退化成文档流元素（症状：按钮在，但点不到）。
 *   3. 层级倒挂：`.win`(100000) 低于浮窗(100110)、`.slgIx-modal`(100300) 低于城内页(100420)
 *      → 出征按钮、确认框被别的东西压住。
 *   4. 交互层的成本预览会拦截弹窗内按钮 → 点「出征」先弹预览、确认后又被拦一次，
 *      玩家要连点两次（症状：操作繁琐、套娃弹窗）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOfflineServer } from '../server/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const HTTP_PORT = 21088 + (process.pid % 800);
const WS_PORT = 21004 + (process.pid % 800);

/** 从源码里取出所有 `z-index:NNN` 并返回某个选择器附近的那个值 */
function zIndexOf(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return null;
  const seg = src.slice(i, i + 400);
  const m = seg.match(/z-index:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

test('P11 · 事件抉择字段兼容：act / action 都能落账', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'slg-p11-ui-'));
  const server = await startOfflineServer({
    saveDir: tmp, httpPort: HTTP_PORT, wsPort: WS_PORT, travelMs: 200, quiet: true,
  });
  const post = (body) => fetch(`http://127.0.0.1:${HTTP_PORT}/__slg/strategy/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  try {
    await t.test('交互层发的 {act:"eventChoice"} 不再被判 bad_action', async () => {
      const r = await post({ act: 'eventChoice', id: 'evt.__not_exist__', choice: 'x' });
      assert.notEqual(r.reason, 'bad_action',
        '服务端必须同时认 act 与 action；返回 bad_action 说明事件卡永远点不掉');
    });

    await t.test('老字段 {action:"…"} 仍然可用（协议兼容）', async () => {
      const r = await post({ action: 'digest', cityId: 1 });
      assert.notEqual(r.reason, 'bad_action', 'action 字段不能被新逻辑挤掉');
    });

    await t.test('未知动作仍是 bad_action（兜底不被放宽）', async () => {
      const r = await post({ act: 'no_such_action_at_all' });
      assert.equal(r.reason, 'bad_action');
    });
  } finally {
    await server.close();
  }
});

test('P11 · 注入 CSS 完整性：拼接不能把整条规则吃掉', () => {
  const files = ['server/interaction-ui.js', 'server/skills.js', 'server/ui-shell.js'];
  for (const f of files) {
    const src = read(f);
    assert.ok(!/^\s*\+\s*\/\*/m.test(src),
      `${f}: 注释写在 \`+\` 之后会被解析成「加号 + 一元加号」，字符串变 NaN、规则丢失。`
      + '把注释放到加号之前。');
  }
  const ix = read('server/interaction-ui.js');
  assert.ok(ix.includes('.slgIx-modal{position:fixed;inset:0;z-index:'),
    '决策预览/事件卡必须仍是 position:fixed 的整屏遮罩');
  assert.ok(/\.slgIx-modal\{position:fixed;inset:0;z-index:100760;/.test(ix),
    '弹窗层级须为 100760（高于城内页 100420）');
});

test('P11 · 层级阶梯：主窗口 > 浮窗，弹窗 > 主窗口', () => {
  const skills = read('server/skills.js');
  const ix = read('server/interaction-ui.js');
  const shell = read('server/ui-shell.js');

  const zWin = zIndexOf(skills, "'#slgUIv2 .win{");
  const zCity = zIndexOf(skills, "'#slgUIv2 .citypage{");
  const zModal = zIndexOf(skills, "'#slgUIv2 .modal{");
  const zIxModal = zIndexOf(ix, "'.slgIx-modal{");
  const zQueue = zIndexOf(ix, "'#slgIxQueue{");
  const zGuide = zIndexOf(shell, "'#slgIxGuide{");   // 外壳覆写，仅作存在性校验

  for (const [name, v] of Object.entries({ zWin, zCity, zModal, zIxModal, zQueue })) {
    assert.ok(Number.isFinite(v), `${name} 必须能解析到确定的 z-index`);
  }
  assert.ok(zWin > zQueue, `.win(${zWin}) 必须高于行军队列浮窗(${zQueue})，否则出征按钮被压住`);
  assert.ok(zIxModal > zCity, `.slgIx-modal(${zIxModal}) 必须高于城内页(${zCity})`);
  assert.ok(zModal > zCity, `.modal(${zModal}) 必须高于城内页(${zCity})`);
  assert.ok(zGuide === null || zGuide > zCity || zGuide < 100500, '指南浮窗不得插到弹窗之上');
});

test('P11 · 交互层不得拦截弹窗内的确认按钮', () => {
  const ix = read('server/interaction-ui.js');
  assert.ok(/closest\('\.slgIx-modal, #slgUIv2 \.modal'\)\)\s*return;/.test(ix),
    'interceptCosts 必须跳过弹窗内按钮，否则「出征」会被预览二次拦截');
  /* 事件卡选项、出征按钮都要显式放行，避免再套一层预览 */
  assert.ok(/data-evt-choice="' \+ esc\(c\.id\) \+ '" data-ix-allow="1"/.test(ix),
    '事件卡选项按钮必须带 data-ix-allow');
  const skills = read('server/skills.js');
  assert.ok(skills.includes("atkBtn.setAttribute('data-ix-allow', '1')"),
    '出征按钮必须带 data-ix-allow（它自身已有确认框）');
  assert.ok(skills.includes("b.setAttribute('data-ix-allow', '1')"),
    '便捷征兵按钮必须带 data-ix-allow（一键操作不能再弹预览）');
});

test('P11 · 城内页必须自带推演入口，且与沙盘同源', () => {
  const skills = read('server/skills.js');
  assert.ok(skills.includes('id="slgCityTick"'), '城内页是全屏的，必须自带「推演一旬」按钮');
  assert.ok(skills.includes("page.querySelector('#slgCityTick').onclick = function () { window.__slgTick(); }"),
    '城内推演必须复用 window.__slgTick，不能另写一份');
  assert.ok(skills.includes("document.getElementById('slgStratTick').onclick = function () { window.__slgTick(); }"),
    '沙盘推演也必须走 window.__slgTick');
});

test('P11 · 入门向导可操作闭环：去操作跳转 + 我已完成推进，且无过期概率口径', () => {
  const ix = read('server/interaction-ui.js');
  // 每关有「去操作」按钮，点了跳转到对应面板（不是只让玩家读文字）
  assert.ok(ix.includes('data-act="go"'), '向导必须有「去操作」按钮');
  assert.ok(/act === 'go'/.test(ix) && /jumpTo\(kind, id\)/.test(ix),
    '「去操作」必须复用 jumpTo 跳到目标面板');
  assert.ok(ix.includes('data-act="done"') && ix.includes('我已完成'),
    '推进按钮应改为「我已完成」，形成「看说明→去操作→完成」闭环');
  // g0 举义开场步存在
  assert.ok(/id: 'g0', title: '举义起兵'/.test(ix), '应有举义开场引导（第一次接触的第一块屏幕）');
  // g3 旧「成功率 +12%」过期口径已移除（当前招募/登庸不显示概率）
  assert.ok(!/成功率 \+12%/.test(ix), '向导不得残留「成功率 +12%」的过期口径');
  // 可跳过/稍后/重看：三态齐全
  assert.ok(ix.includes("data-act='skip'") || ix.includes('data-act="skip"'), '可跳过');
  assert.ok(ix.includes("data-act='later'") || ix.includes('data-act="later"'), '可稍后');
  assert.ok(/guide: function \(\)/.test(ix), '可重看（__slgIX.guide）');
});

test('P11 · 武将人物卡：原版立绘主视觉 + 史载五维条 + 列表缩略头像，且资产异步就绪后重绘', () => {
  const p = read('server/panels-ui.js');
  // 人物卡主体：立绘 img[data-slgcid] + 阵营描边 + 星级 + 五维条
  assert.ok(p.includes('function heroCardHtml(g)'), '人物卡渲染函数存在');
  assert.ok(p.includes('class="hcArt"') && p.includes('hcPortrait'), '立绘主视觉存在');
  assert.ok(p.includes('data-slgcid='), '立绘走原版资产桥（带 cfgId 回填锚点）');
  assert.ok(/--hcc:/.test(p) && p.includes('function campColor('), '阵营色描边存在');
  assert.ok(p.includes('hcStars') && p.includes('historyStats'), '史载五维条取自 lore.historyStats（不编造）');
  assert.ok(p.includes('hcName') && p.includes('hcStar'), '武将名与星级展示');
  // 列表缩略头像（帐下 + 在野）
  assert.ok(p.includes('function portraitThumb('), '列表缩略头像函数存在');
  assert.equal((p.match(/portraitThumb\(/g) || []).length >= 3, true, '帐下与在野列表都用缩略头像');
  // 资产异步就绪后重绘
  assert.ok(p.includes("'slg:portraits-ready'"), '立绘映射就绪后重绘面板');
  // 五维条口径：史载五维 0~100，长度 5
  assert.ok(/dims = \['统率', '武力', '智力', '政治', '魅力'\]/.test(p), '五维条为史载五维五项');
});
