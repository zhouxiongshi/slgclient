/**
 * 玩家界面呈现卫生回归。
 *
 * 1) 俘虏处置按钮必须与六府面板共用同一套按钮语言：明确字号、前景色、底色与危险色，
 *    小字说明也不能压到几乎看不见。
 * 2) 玩家可见文案不得出现借鉴对象、外部名录、内部规格编号或工程溯源字段。
 *    工程溯源数据仍保留在 conf/ 中供合规检查，但禁止再渲染到界面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const UI_FILES = [
  'server/panels-ui.js',
  'server/interaction-ui.js',
  'server/ui-shell.js',
  'server/editor-ui.js',
  'server/skills.js',
];

const SOURCE_LEAKS = [
  '三国志11', '三国志14', '三国志9', '三国志13',
  '文明6', '文明7', 'CK3', '率土之滨',
  'battle-kit', '设计规格', '章节 K',
  '数值来源', 'source_id', 'confidence', '证据级别', '可信度',
];

test('俘虏处置按钮使用六府统一按钮样式，字体与对比度可读', () => {
  const src = read('server/panels-ui.js');
  assert.match(src, /#slgPanelsWin \.capbtn\{[^}]*background:#2c2f22;color:#e8d7a8/,
    '按钮应有明确底色与浅色前景，不能落回浏览器默认样式');
  assert.match(src, /#slgPanelsWin \.capbtn\{[^}]*font:13px "Microsoft YaHei",sans-serif/,
    '按钮字号应与六府正文一致（13px）');
  assert.match(src, /#slgPanelsWin \.capbtn\.danger\{border-color:#a8664c;color:#f0b39b;/,
    '处斩按钮需有独立的危险色，但仍保持浅色可读文字');
  assert.match(src, /#slgPanelsWin \.caprow \.genrow small\{color:#b3a88f;\}/,
    '俘虏行的小字说明不能沿用低对比度灰色');
  assert.match(src, /<button class="capbtn" data-act="captiveRelease"/);
  assert.match(src, /<button class="capbtn danger" data-act="captiveExecute"/);
  assert.doesNotMatch(src, /class="ghost" data-act="captive/,
    '六府窗口没有 .ghost 样式，不得再使用该类');
});

test('注入层不含任何借鉴对象、外部名录或工程溯源提示', () => {
  for (const file of UI_FILES) {
    const src = read(file);
    for (const token of SOURCE_LEAKS) {
      assert.ok(!src.includes(token), `${file} 仍会向玩家暴露来源提示：${token}`);
    }
  }
});

test('术语表玩家可见字段不再写借鉴来源，但工程溯源字段仍保留', () => {
  const terms = JSON.parse(read('conf/interaction/terms.json')).terms;
  assert.equal(terms.length, 134);
  for (const t of terms) {
    for (const field of ['名称', '简述', '证据级别']) {
      for (const token of SOURCE_LEAKS) {
        assert.ok(!String(t[field] || '').includes(token), `${t.id}.${field} 含来源提示：${token}`);
      }
    }
    assert.ok(Array.isArray(t['数值来源']) && t['数值来源'].length > 0, `${t.id} 数值来源缺失`);
    assert.ok(t.source_id && t.confidence, `${t.id} 工程溯源字段缺失`);
  }
});
