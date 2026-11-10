/**
 * 存档三档位 + 导出 / 导入（试玩 P2-5）。
 * 旧实现只有一份 save.json，换机或重装即丢；这里验证新接口真的能存、能读、能搬。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOfflineServer } from '../server/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'slg-save-'));
const httpPort = 19088 + (process.pid % 500);
const wsPort = 19004 + (process.pid % 500);
const base = `http://127.0.0.1:${httpPort}`;

const getJson = (path) => fetch(base + path).then((r) => r.json());
const postJson = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('存档：三档位、导出、导入都可用', async (t) => {
  const server = await startOfflineServer({ saveDir: tmp, httpPort, wsPort, quiet: true });
  t.after(() => {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('档位列表固定三档，且带当前档路径', async () => {
    const r = await getJson('/__slg/save/slots');
    assert.equal(r.slots.length, 3);
    assert.deepEqual(r.slots.map((s) => s.slot), [1, 2, 3]);
    assert.equal(typeof r.current, 'string');
    for (const s of r.slots) {
      assert.equal(typeof s.exists, 'boolean');
      assert.equal(typeof s.path, 'string');
    }
  });

  await t.test('存到 2 号档后列表能看到日期', async () => {
    const saved = await postJson('/__slg/save/slot', { slot: 2, action: 'save' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true);
    assert.equal(existsSync(join(tmp, 'save.slot2.json')), true);
    const slot2 = saved.body.slots.find((s) => s.slot === 2);
    assert.equal(slot2.exists, true);
    assert.ok(slot2.bytes > 1000);
    assert.ok(slot2.day >= 1);
  });

  await t.test('导出的存档是完整 state，可以直接再导入', async () => {
    const res = await fetch(base + '/__slg/save/export');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="shuanghan-save-/);
    const state = await res.json();
    assert.ok(state.role && state.role.rid);
    assert.ok(state.clock && state.clock.day >= 1);

    const imported = await postJson('/__slg/save/import', state);
    assert.equal(imported.status, 200);
    assert.equal(imported.body.ok, true);
    assert.ok(imported.body.day >= 1);
  });

  await t.test('读取 2 号档成功并回带天数', async () => {
    const loaded = await postJson('/__slg/save/slot', { slot: 2, action: 'load' });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.ok, true);
    assert.ok(loaded.body.day >= 1);
  });

  await t.test('非法档位 / 非法动作 / 垃圾存档都被拒绝', async () => {
    assert.equal((await postJson('/__slg/save/slot', { slot: 9, action: 'save' })).status, 400);
    assert.equal((await postJson('/__slg/save/slot', { slot: 2, action: 'drop' })).status, 400);
    assert.equal((await postJson('/__slg/save/slot', { slot: 3, action: 'load' })).status, 404);

    const bad = await postJson('/__slg/save/import', { hello: 'world' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.reason, 'not_a_save');
  });
});
