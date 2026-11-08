/**
 * 探索性测试抓出的 4 类真实 bug 的防回归验收：
 *
 *  1. army.dispose 给不存在的队伍槽位配武将时崩溃（新建 army 缺 generals 等字段）
 *  2. 协议入参 NaN / null 未清洗 → 写进存档变 null → 重启后客户端读 .x/.y 崩
 *  3. 建造中要塞 level=0（客户端 npc.levels 只有 1~10）；旧逻辑在
 *     level 恰好等于目标等级时工期永远无法完成
 *  4. 地图 2869 个 level=0 空地格点击崩溃 → 运行时客户端补丁（磁盘文件不动）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { patchClientBundle } from '../server/skills.js';

const cfg = loadConfig();
const WEB = resolve(import.meta.dirname, '..', 'web');
const req = (name, msg = {}) => ({ seq: 1, name, msg });
const nowSec = () => Math.floor(Date.now() / 1000);

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, options: {}, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    save() {}, log() {}, schedule() {},
  };
}

test('army.dispose：新建队伍槽位不再抛异常，army 字段完整且不污染状态', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const before = state.armys.length;
  const order = 1 + Math.max(...state.armys.map((a) => a.order));  // 一定是尚未创建的槽位
  const r = handleRequest(ctx, req('army.dispose', { cityId: 1, order, position: 0, generalId: 1000 }));
  assert.equal(r.code, 0);
  assert.equal(state.armys.length, before + 1);
  const army = state.armys.find((a) => a.cityId === 1 && a.order === order);
  assert.ok(army, '新队伍已创建');
  assert.deepEqual(army.generals, [1000, 0, 0]);
  assert.deepEqual(army.soldiers, [0, 0, 0]);
  assert.deepEqual(army.con_times, [0, 0, 0]);
  assert.equal(army.cmd, 0);
  assert.equal(ctx.pushes.filter((p) => p.name === 'army.push').length, 1);
  // 重复操作同一槽位不应再抛异常
  assert.equal(handleRequest(ctx, req('army.dispose', { cityId: 1, order, position: 1, generalId: 1000 })).code, 0);
  assert.equal(state.armys.length, before + 1);
});

test('协议入参清洗：NaN/null 坐标不会进入返回体或存档', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const bad = { x: 'abc', y: null, type: 1, name: '测试标记' };
  const r1 = handleRequest(ctx, req('role.opPosTag', bad));
  assert.equal(r1.code, 0);
  assert.ok(Number.isFinite(r1.msg.x) && Number.isFinite(r1.msg.y), '返回坐标必须是有限数');
  assert.equal(r1.msg.name, '测试标记', '字符串字段不能被误伤');
  assert.ok(state.posTags.every((t) => Number.isFinite(t.x) && Number.isFinite(t.y)));
  const r2 = handleRequest(ctx, req('nationMap.giveUp', { x: 'abc', y: undefined }));
  assert.ok(Number.isFinite(r2.msg.x) && Number.isFinite(r2.msg.y));
  const r3 = handleRequest(ctx, req('union.join', { y: null }));
  assert.notEqual(r3.msg.y, null, 'union 也不再透传 null');
  // 存档 JSON 里不能出现坐标 null（NaN 序列化后的形态）
  const saved = JSON.stringify(state);
  assert.ok(!/"(x|y)":null/.test(saved), '存档中不含 null 坐标');
  // 剧情/聊天的字符串型 option 不能被数值化
  const r4 = handleRequest(ctx, req('campaign.choose', { option: 'lend' }));
  assert.equal(r4.code, 0);
  assert.equal(r4.msg.choice, 'lend');
});

test('建筑流程全程 level 合法（1~10），建造中不降为 0', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const b = state.builds[0];
  const legal = (v) => Number.isInteger(v) && v >= 1 && v <= 10;
  const checkAll = (label) => {
    for (const x of state.builds) assert.ok(legal(x.level), `${label}: 建筑 (${x.x},${x.y}) level=${x.level}`);
    for (const p of ctx.pushes) {
      if (p.name === 'roleBuild.push') assert.ok(legal(p.msg.level), `${label}: push level=${p.msg.level}`);
    }
  };
  checkAll('初始');
  assert.equal(handleRequest(ctx, req('nationMap.build', { x: b.x, y: b.y, type: 56 })).code, 0);
  checkAll('建造中');
  assert.equal(b.building, true);
  b.end_time = nowSec() - 1;
  handleRequest(ctx, req('role.myRoleRes'));
  checkAll('建造完成');
  assert.equal(b.level, 1);
  assert.equal(b.building, false);
  assert.equal(handleRequest(ctx, req('nationMap.upBuild', { x: b.x, y: b.y })).code, 0);
  checkAll('升级中');
  b.end_time = nowSec() - 1;
  handleRequest(ctx, req('role.myRoleRes'));
  checkAll('升级完成');
  assert.equal(b.level, 2);
  assert.equal(handleRequest(ctx, req('nationMap.delBuild', { x: b.x, y: b.y })).code, 0);
  checkAll('拆除中');
  b.end_time = nowSec() - 1;
  handleRequest(ctx, req('role.myRoleRes'));
  checkAll('拆除完成');
  assert.equal(handleRequest(ctx, req('nationMap.giveUp', { x: b.x, y: b.y })).code, 0);
  checkAll('放弃领地');
});

test('工期在「资源地等级恰好等于目标等级」时也能完成（旧逻辑会卡死）', () => {
  const state = createWorld(cfg);
  const ctx = makeCtx(state);
  const b = state.builds[0];
  b.level = 1;                       // 与目标要塞等级相同
  b.op_level = 1;
  assert.equal(handleRequest(ctx, req('nationMap.build', { x: b.x, y: b.y, type: 56 })).code, 0);
  assert.equal(b.building, true);
  b.end_time = nowSec() - 1;
  handleRequest(ctx, req('role.myRoleRes'));
  assert.equal(b.building, false, '工期必须结束');
  assert.equal(b.end_time, 0);
  assert.equal(b.level, 1);
});

test('旧存档 level=0 的建筑在加载时被纠正', () => {
  const state = createWorld(cfg);
  const b = state.builds[0];
  b.level = 0;
  b.op_level = 1;
  b.end_time = nowSec() + 100;
  delete b.building;
  normalizeWorld(state, cfg);
  assert.ok(b.level >= 1 && b.level <= 10, `纠正后 level=${b.level}`);
  assert.equal(b.building, true, '旧存档的工期标记被补齐');
});

test('客户端运行时补丁修复空地格崩溃，磁盘 index.js 保持逐字节不变', () => {
  const file = resolve(WEB, 'assets', 'main', 'index.js');
  const source = readFileSync(file, 'utf8');
  const mapRes = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'conf', 'mapRes_0.json'), 'utf8'));
  const zeroTiles = mapRes.list.filter((t) => t[1] === 0).length;
  assert.ok(zeroTiles > 0, '地图确实存在 level=0 空地格（补丁必要性）');
  assert.ok(source.includes('this._basic.npc.levels[level - 1].soilders'), '原版越界代码仍在磁盘文件里');
  const patched = patchClientBundle(source);
  assert.ok(patched.includes('var row = list[level - 1]'), '守军查询加了边界保护');
  assert.ok(patched.includes('if (!cfg) return list;'), '产量描述加了 null 保护');
  assert.ok(patched.includes('resCfg ? resCfg.name'), '地块名称加了 null 保护');
  assert.equal(readFileSync(file, 'utf8'), source, '磁盘文件未被修改');
  console.log(`  (地图 level=0 空地格 ${zeroTiles} / ${mapRes.list.length})`);
});
