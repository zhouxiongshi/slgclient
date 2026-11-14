/**
 * M4-11 武将编辑器：属性 + 自带战法的覆盖层编辑（domain/general-editor.js）。
 *
 * 关键红线：
 *   - 原表（general.json / heroes-240.json / protagonist.json）逐字不动，
 *     编辑只写 GM 覆盖层 overrides.json 的 generals 段；
 *   - 属性量纲是 M4-10 三国志11 百分制（1~100），越界钳位；
 *   - 战法 cfgId 必须在运行时战法表内（skills.js SKILL_BY_ID）；
 *   - 保存对 generalByCfg 即时生效（唯一权威），reset 从 generalOriginal 恢复；
 *   - 当前存档 state.generals 的自带战法槽立即同步。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(dirname(), '..');
function dirname() { return new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); }

const OVERRIDES_FILE = resolve(ROOT, 'conf/campaign/overrides.json');
/* 首次备份 = 真实初始状态；无论测试中途怎么写盘、哪怕失败退出，
   afterEach 都统一收敛回这份原始内容——否则残留覆盖会污染
   后续任何测试文件的 loadConfig（general-balance 假红已验证过）。 */
let originalBackup = null;
let overridesBackup = null;
function backupOverrides() {
  if (originalBackup === null) {
    originalBackup = existsSync(OVERRIDES_FILE) ? readFileSync(OVERRIDES_FILE, 'utf8') : null;
  }
  overridesBackup = originalBackup;
}
function restoreOverrides() {
  if (overridesBackup === null) {
    if (existsSync(OVERRIDES_FILE)) writeFileSync(OVERRIDES_FILE, JSON.stringify({ tiles: [], facilities: [], city: null, rules: {}, story: {}, generals: {} }, null, 2));
  } else {
    writeFileSync(OVERRIDES_FILE, overridesBackup);
  }
}

const codeOnly = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

async function fresh() {
  const { loadConfig } = await import('../server/config.js');
  return loadConfig();
}

beforeEach(() => { backupOverrides(); });
afterEach(() => { restoreOverrides(); });

test('sanitizeGeneralEdit：五维钳位 1~100、成长 1~100、cost/star 区间', async () => {
  const { sanitizeGeneralEdit } = await import('../server/domain/general-editor.js');
  const out = sanitizeGeneralEdit({ force: 300, strategy: 0, defense: 55.7, speed: -9, destroy: 100, force_grow: 999, cost: 0, star: 9 });
  assert.equal(out.force, 100);
  assert.equal(out.strategy, 1);
  assert.equal(out.defense, 56);
  assert.equal(out.speed, 1);
  assert.equal(out.destroy, 100);
  assert.equal(out.force_grow, 100);
  assert.equal(out.cost, 1);
  assert.equal(out.star, 5);
});

test('sanitizeGeneralEdit：战法 cfgId 必须在运行时战法表内，非法归 0', async () => {
  const { sanitizeGeneralEdit } = await import('../server/domain/general-editor.js');
  const bad = sanitizeGeneralEdit({ skillCfgId: 999999999 });
  assert.equal(bad.skillCfgId, 0);
  const none = sanitizeGeneralEdit({ skillCfgId: 0 });
  assert.equal(none.skillCfgId, 0);
  /* 真实表里至少存在一条战法可被引用 */
  const { SKILL_BY_ID } = await import('../server/skills.js');
  assert.ok(SKILL_BY_ID.size >= 100, '运行时战法表应为合并全集');
  const firstId = SKILL_BY_ID.keys().next().value;
  const ok = sanitizeGeneralEdit({ skillCfgId: firstId });
  assert.equal(ok.skillCfgId, firstId);
});

test('sanitizeGeneralEdit：空输入 / 未知字段全部丢弃', async () => {
  const { sanitizeGeneralEdit } = await import('../server/domain/general-editor.js');
  assert.equal(sanitizeGeneralEdit({}), null);
  assert.equal(sanitizeGeneralEdit({ hack: 1, name: '改' }), null);
  assert.equal(sanitizeGeneralEdit(null), null);
});

test('editorSave：写覆盖层 + generalByCfg 即时生效 + generalOriginal 记录原值', async () => {
  restoreOverrides();
  const cfg = await fresh();
  const { editorSave, editorReset } = await import('../server/domain/general-editor.js');
  const target = [...cfg.generalByCfg.values()].find((g) => g.name === '吕布') || [...cfg.generalByCfg.values()][0];
  const orig = { force: target.force, strategy: target.strategy };
  const r = editorSave(cfg, { generals: [] }, { cfgId: target.cfgId, force: 100, strategy: 1 });
  assert.ok(r.ok);
  assert.equal(target.force, 100, 'generalByCfg 是唯一权威，保存即生效');
  assert.equal(target.strategy, 1);
  const keep = cfg.generalOriginal.get(Number(target.cfgId));
  assert.equal(keep.force, orig.force, '原值被记录，供 reset 恢复');
  const onDisk = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf8'));
  assert.equal(onDisk.generals[String(target.cfgId)].force, 100, '覆盖层落盘');
  editorReset(cfg, { generals: [] }, { cfgId: target.cfgId });
  restoreOverrides();
});

test('editorReset：恢复原值并删除覆盖', async () => {
  restoreOverrides();
  const cfg = await fresh();
  const { editorSave, editorReset } = await import('../server/domain/general-editor.js');
  const target = [...cfg.generalByCfg.values()].find((g) => g.name === '吕布') || [...cfg.generalByCfg.values()][0];
  const origForce = target.force;
  editorSave(cfg, { generals: [] }, { cfgId: target.cfgId, force: 77 });
  assert.equal(target.force, 77);
  const r = editorReset(cfg, { generals: [] }, { cfgId: target.cfgId });
  assert.ok(r.ok);
  assert.equal(target.force, origForce, 'reset 从 generalOriginal 恢复');
  const onDisk = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf8'));
  assert.equal(onDisk.generals[String(target.cfgId)], undefined, '覆盖已删除');
  restoreOverrides();
});

test('editorSave：当前存档武将的自带战法槽立即同步（skills[0]）', async () => {
  restoreOverrides();
  const cfg = await fresh();
  const { editorSave, editorReset } = await import('../server/domain/general-editor.js');
  const { SKILL_BY_ID } = await import('../server/skills.js');
  const skillId = SKILL_BY_ID.keys().next().value;
  const state = { generals: [{ id: 'g1', cfgId: 240002, skills: [null, null, null] }, { id: 'g2', cfgId: 240002, skills: [{ id: 1, lv: 1, cfgId: 1 }] }] };
  const r = editorSave(cfg, state, { cfgId: 240002, skillCfgId: skillId });
  assert.ok(r.ok);
  assert.equal(r.stateSynced, 2, '同 cfgId 的所有武将实例都同步');
  assert.deepEqual(state.generals[0].skills[0], { id: skillId, lv: 1, cfgId: skillId });
  assert.deepEqual(state.generals[1].skills[0], { id: skillId, lv: 1, cfgId: skillId });
  /* 清空战法：skillCfgId=0 → skills[0]=null */
  const r2 = editorSave(cfg, state, { cfgId: 240002, skillCfgId: 0 });
  assert.ok(r2.ok);
  assert.equal(state.generals[0].skills[0], null);
  editorReset(cfg, state, { cfgId: 240002 });
  restoreOverrides();
});

test('editorSave：未知 cfgId 拒绝；列表含全表与覆盖标记', async () => {
  restoreOverrides();
  const cfg = await fresh();
  const { editorSave, editorList } = await import('../server/domain/general-editor.js');
  const bad = editorSave(cfg, {}, { cfgId: 99999999, force: 50 });
  assert.equal(bad.ok, false);
  const list = editorList(cfg);
  assert.ok(list.ok);
  assert.equal(list.rows.length, cfg.generalByCfg.size);
  assert.ok(list.rows.some((r) => r.isProtagonist), '主公也在可编辑列表里');
  restoreOverrides();
});

test('loadConfig：overrides.generals 覆盖在新配置构建时生效（新开局同源）', async () => {
  restoreOverrides();
  /* 预写覆盖层，再 loadConfig，验证覆盖生效 */
  const before = existsSync(OVERRIDES_FILE) ? JSON.parse(readFileSync(OVERRIDES_FILE, 'utf8')) : {};
  before.generals = before.generals || {};
  before.generals['880001'] = { force: 91, skillCfgId: 0 };
  writeFileSync(OVERRIDES_FILE, JSON.stringify(before, null, 2));
  const cfg = await fresh();
  const protag = cfg.generalByCfg.get(880001);
  assert.equal(protag.force, 91, 'loadConfig 应用覆盖');
  assert.equal(protag.skillCfgId, 0);
  assert.equal(cfg.generalOriginal.get(880001).force !== 91, true, '原值另存');
  restoreOverrides();
});

test('world.js innateOf：编辑器覆盖优先于 hero-skills 按名映射（静态闸）', () => {
  const src = codeOnly('server/world.js');
  assert.match(src, /loadOverrides\(\)\.generals\?\.\[String\(Number\(cfgId\)\)\]/);
  assert.match(src, /edited !== undefined/, '0 = 编辑器清空成白板，必须短路按名映射');
});

test('红线：编辑器不写任何原表文件，写入只经 saveOverrides', () => {
  const ed = codeOnly('server/domain/general-editor.js');
  assert.doesNotMatch(ed, /writeFileSync/, '编辑器领域层不许直接写盘');
  assert.match(ed, /saveOverrides/);
  const gm = read('server/gm/overrides.js');
  assert.match(gm, /'conf\/campaign\/overrides\.json'|conf.*campaign.*overrides/, '写入目标只许是覆盖层');
  assert.doesNotMatch(gm.replace(/\/\*[\s\S]*?\*\//g, ''), /general\.json|heroes-240|protagonist\.json/, '覆盖层模块不碰原表');
});

test('editor-ui.js：纯浏览器脚本静态闸', () => {
  const ui = codeOnly('server/editor-ui.js');
  assert.doesNotMatch(ui, /Math\.random/, '面板层禁 Math.random');
  assert.match(ui, /__slgEditorOpen/, '设置面板入口函数');
  assert.match(ui, /Escape/, 'Esc 关闭路径');
  assert.doesNotMatch(ui, /slgIx-modal/, '不计入 ui-shell 一屏一窗统计');
  assert.match(ui, /__slg\/editor/, '端点前缀');
  assert.match(ui, /'\/save'/);
  assert.match(ui, /'\/reset'/);
});

test('index.js：编辑器端点与脚本注入齐备', () => {
  const src = codeOnly('server/index.js');
  assert.match(src, /editorList, editorSave, editorReset/);
  assert.match(src, /EDITOR_UI_SOURCE/);
  assert.match(src, /\/__slg\/editor\/state/);
  assert.match(src, /\/__slg\/editor\/save/);
  assert.match(src, /\/__slg\/editor\/reset/);
  assert.match(src, /\/__slg\/editor\/ui\.js/);
});

test('interaction-ui.js：设置面板有武将编辑器入口', () => {
  const src = codeOnly('server/interaction-ui.js');
  assert.match(src, /武将编辑器/);
  assert.match(src, /__slgEditorOpen/);
});
