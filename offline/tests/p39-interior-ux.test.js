/**
 * P50（2026-11-23）内政太守制回归（参考三国志12-14）：
 *  1. 城内页只留一张「太守 · 方针」卡：旧「当前推荐一步 / 全部任务折叠 / 劝课生息快捷 /
 *     委派内政六项 / 长驻委任」全部删除，不再有任何逐项派单入口；
 *  2. 太守自动办政与旧手动同源（beginInteriorTask），太守本人执行、缺金置顶续办；
 *  3. 物资去处回归即时办理，旧任务层（选武将/任务队列/应急折叠）删除；
 *  4. 拒绝原因统一中文 errText，不直出 reason。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'server/skills.js'), 'utf8');
const seg = src.slice(src.indexOf('function tabInteriorView'), src.indexOf('function tabGeneralView'));

test('P50-① 城内页只留太守·方针卡，旧三套派单入口全删', () => {
  assert.ok(seg.includes('太守 · 方针'), '必须有太守·方针卡');
  for (const label of ['任命太守', '撤任太守', '一键补任']) {
    assert.ok(seg.includes(`mkBtn('${label}'`), `太守卡必须有「${label}」`);
  }
  assert.ok(seg.includes("action: 'governorSet'") && seg.includes("action: 'governorAutoFill'"),
    '走太守制端点');
  for (const gone of ['当前推荐一步', '委派内政', '长驻委任', '一键委派', '全部任务', '劝课生息·快速办理']) {
    assert.ok(!seg.includes(gone), `旧入口「${gone}」必须删除`);
  }
  assert.ok(seg.includes("mkBtn('去征兵'") && seg.includes("mkBtn('去府库升级设施'"), '跳转按钮保留');
});

test('P50-② 物资去处回归即时办理，任务层删除', () => {
  const mat = src.slice(src.indexOf('function paintMaterialGuide'), src.indexOf('function mountMaterialCard'));
  assert.ok(mat.includes('物资去处 · 即时办理'), '物资去处只做即时');
  for (const gone of ['物资去处 · 委派办理', 'data-mtask', '委派执行', '全部物资动作（即时办理，应急用）']) {
    assert.ok(!src.includes(gone), `物资任务层残留「${gone}」必须删除`);
  }
  assert.ok(!src.includes("action: 'materialTask'") && !src.includes('materialTaskCancel'),
    '客户端不再发物资任务端点');
});

test('P50-③ 服务端：物资任务与旧委任端点删除，太守端点接线', () => {
  const idx = readFileSync(resolve(ROOT, 'server/index.js'), 'utf8');
  assert.ok(!idx.includes("act === 'materialTask'") && !idx.includes("act === 'appoint'")
    && !idx.includes("act === 'cancelAppoint'"), '旧端点必须删除');
  assert.ok(idx.includes("act === 'governorSet'") && idx.includes("act === 'governorAutoFill'"),
    '新端点必须接线');
  assert.ok(!readFileSync(resolve(ROOT, 'server/index.js'), 'utf8').includes('material-task.js'),
    'index 不再引用 material-task');
});

test('P50-④ 太守自动办政与旧手动同源，缺金置顶续办', () => {
  const gov = readFileSync(resolve(ROOT, 'server/domain/governor.js'), 'utf8');
  assert.ok(gov.includes('beginInteriorTask(state, cfg, ctx'), '旬界必须走 beginInteriorTask 同源派单');
  assert.ok(gov.includes("'blocked'") && gov.includes('缺金'), '缺金置顶不静默跳过');
  assert.ok(gov.includes('migrateAppointments'), '旧档 appointments 必须有迁移');
  const cityEcon = readFileSync(resolve(ROOT, 'server/domain/city-econ.js'), 'utf8');
  assert.ok(cityEcon.includes('governorTick(state, cfg, ctx)'), '旬结算必须推进太守');
  assert.ok(!cityEcon.includes('appointmentTick'), '旧 appointmentTick 接线必须删除');
  // 太守纳入忠诚「委任在岗」集合
  assert.ok(cityEcon.includes('governors') && cityEcon.includes('postedIds.add(oid)'), '太守应享委任忠诚');
});

test('P50-⑤ 拒绝原因统一中文 errText', () => {
  assert.doesNotMatch(seg, /rs\.reason \|\| '未知'/, '禁止把英文 reason 弹给玩家');
  assert.match(src, /function errText[\s\S]{0,400}rsp\.reason/, 'errText 兼容平铺 reason');
});
