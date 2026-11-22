/**
 * P45（2026-11-22）物资去处任务化回归：
 *  委派不扣物资、到期才执行原数值函数、幂等、失败/撤销如实反馈，
 *  游戏里默认走任务表单，即时按钮收进应急折叠区。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { ensureStrategy } from '../server/domain/strategy.js';
import {
  beginMaterialTask, advanceMaterialTasks, cancelMaterialTask,
  materialTaskView, materialOfficers, planMaterialTicks,
} from '../server/domain/material-task.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const cfg = loadConfig();
const ctx = () => ({ push() {} });

function fresh(day = 10) {
  const s = createWorld(cfg);
  ensureStrategy(s);
  s.clock.day = day;
  return s;
}

test('P45-① 委派只登记任务，不提前扣物资；同一件事不能重复委派', () => {
  const s = fresh();
  const before = { wood: s.roleRes.wood, iron: s.roleRes.iron, jungong: s.roleRes.jungong };
  const r = beginMaterialTask(s, cfg, ctx(), { actionId: 'craft10', officerId: 0, cityId: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.roleRes.wood, before.wood);
  assert.equal(s.roleRes.iron, before.iron);
  assert.equal(s.roleRes.jungong, before.jungong);
  const v = materialTaskView(s)[0];
  assert.equal(v.status, 'active');
  assert.equal(v.officer, '太守亲办');
  assert.ok(v.endDay > v.startDay && v.pct === 0, JSON.stringify(v));
  const dup = beginMaterialTask(s, cfg, ctx(), { actionId: 'craft10', officerId: 0, cityId: 0 });
  assert.equal(dup.ok, false);
  assert.ok(dup.message.includes('已有一件在办'), dup.message);
});

test('P45-② 到期才执行原动作，数值与瞬时版完全一致，且重复推进不会二次执行', () => {
  const s = fresh();
  const before = { wood: s.roleRes.wood, iron: s.roleRes.iron, jungong: s.roleRes.jungong };
  const r = beginMaterialTask(s, cfg, ctx(), { actionId: 'craft10', officerId: 0, cityId: 0 });
  const taskId = r.task.id;
  assert.deepEqual(advanceMaterialTasks(s, cfg, ctx()), { done: [], failed: [] }, '未到期不得执行');
  s.clock.day = r.task.endDay;
  const out = advanceMaterialTasks(s, cfg, ctx());
  assert.deepEqual(out.done, [taskId], JSON.stringify(out));
  assert.equal(before.wood - s.roleRes.wood, 800, '10 军工 = 80 木 ×10');
  assert.equal(before.iron - s.roleRes.iron, 400, '10 军工 = 40 铁 ×10');
  assert.equal(s.roleRes.jungong - before.jungong, 10);
  const after = { ...s.roleRes };
  advanceMaterialTasks(s, cfg, ctx());
  advanceMaterialTasks(s, cfg, ctx());
  assert.deepEqual({ wood: s.roleRes.wood, iron: s.roleRes.iron, jungong: s.roleRes.jungong },
    { wood: after.wood, iron: after.iron, jungong: after.jungong }, '幂等，不得重复扣');
  assert.equal(materialTaskView(s).find((t) => t.id === taskId).statusText, '已完工');
});

test('P45-③ 到期条件不满足记为未办成、不扣物资；撤销同样不扣', () => {
  const s = fresh();
  const before = { grain: s.roleRes.grain, gold: s.roleRes.gold };
  const r = beginMaterialTask(s, cfg, ctx(), { actionId: 'agri1', officerId: 0, cityId: 999 });
  assert.equal(r.ok, true);
  s.clock.day = r.task.endDay;
  const out = advanceMaterialTasks(s, cfg, ctx());
  assert.deepEqual(out.failed, [r.task.id], JSON.stringify(out));
  assert.equal(s.roleRes.grain, before.grain, '失败不得扣粮');
  assert.ok(materialTaskView(s).find((t) => t.id === r.task.id).note.includes('未扣物资'));

  const s2 = fresh();
  const gold0 = s2.roleRes.gold;
  const r2 = beginMaterialTask(s2, cfg, ctx(), { actionId: 'sell', officerId: 0, cityId: 0 });
  assert.equal(cancelMaterialTask(s2, { taskId: r2.task.id }).ok, true);
  s2.clock.day = r2.task.endDay;
  assert.deepEqual(advanceMaterialTasks(s2, cfg, ctx()), { done: [], failed: [] });
  assert.equal(s2.roleRes.gold, gold0);
});

test('P45-④ 工期只跟属性有关；武将候选排除行军中且按属性排序', () => {
  assert.equal(planMaterialTicks('craft10', 90), 1);
  assert.equal(planMaterialTicks('craft10', 70), 1);
  assert.equal(planMaterialTicks('craft10', 40), 2);
  assert.equal(planMaterialTicks('craftDrain', 0), 3, '无人亲办加半旬');
  const s = fresh();
  s.generals.push({ id: 77, cfgId: 100023, name: '测试曹操', level: 1, skills: [] });
  s.armys = [{ id: 1, cityId: s.strategy.playerCity, marchId: 9, generals: [77] }];
  const officers = materialOfficers(s, cfg, 'craft10');
  assert.ok(officers.length > 0);
  assert.ok(!officers.some((o) => o.id === 77), '行军中的武将不得出现在候选');
  assert.ok(officers[0].stats && officers[0].stats.politics != null, '各属性都随候选下发');
});

test('P45-⑤ UI/协议接线：默认展示任务表单，即时入口收起且代价仍可见', () => {
  const sk = read('server/skills.js');
  const seg = sk.slice(sk.indexOf('function paintMaterialGuide'), sk.indexOf('function mountMaterialCard'));
  assert.ok(seg.includes('物资去处 · 委派办理'));
  assert.ok(seg.includes('action: \'materialTask\''), '委派走任务端点');
  assert.ok(seg.includes('selTask.onchange = fillOfficers'), '换任务会换属性排序');
  assert.ok(seg.includes('panel.style.display = on ? \'flex\' : \'none\''), '即时按钮默认收起');
  assert.ok(seg.includes("esc(a.note)"), '代价仍可见');
  assert.doesNotMatch(seg, /rs\.hint \|\| rs\.reason/);
  const h = read('server/handlers.js');
  assert.ok(h.includes('tasks: materialTaskView(state)'), 'guide 带任务队列');
  assert.ok(h.includes('officers: materialOfficers(state, cfg)'), 'guide 带可派武将');
  const idx = read('server/index.js');
  assert.ok(idx.includes("act === 'materialTask'") && idx.includes("act === 'materialTaskCancel'"));
  const st = read('server/domain/strategy.js');
  assert.ok(st.includes('advanceMaterialTasks(state, cfg, ctx)'), '旬结算必须推进任务');
});
