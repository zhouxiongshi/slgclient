/**
 * R1 · HTTP 管理口契约（对应《测试方案》§三 第 15/16 域、§五 法 1/3）
 *
 * 覆盖 27 类路径：静态注入、六府、举义、战略、存档、GM、协议兜底与安全边界。
 * 判定口径：状态码 + 响应结构 + 关键语义（而不是只求 200）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOfflineServer } from '../server/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'slg-http-'));
const httpPort = 20088 + (process.pid % 900);
const base = `http://127.0.0.1:${httpPort}`;
const wsPort = 20004 + (process.pid % 900);

const get = (p) => fetch(base + p);
const post = (p, body, raw) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': typeof raw === 'string' ? 'text/plain' : 'application/json' },
  body: typeof raw === 'string' ? raw : JSON.stringify(body ?? {}),
});

test('R1 · HTTP 管理口契约（27 类路径）', async (t) => {
  const server = await startOfflineServer({
    saveDir: tmp, httpPort, wsPort, travelMs: 300, quiet: true,
  });
  const state = server.getState();
  const mainCity = state.citys[0].cityId;

  try {
    await t.test('index.html：运行时注入 script，但磁盘文件不含注入痕迹', async () => {
      const res = await get('/index.html');
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('/__slg/panels/ui.js'), '响应里必须有注入的 script');

      const disk = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
      assert.ok(!disk.includes('/__slg/panels/ui.js'), '磁盘 index.html 不得被写入注入标签');
    });

    await t.test('ui.js：下发 panels-ui.js 原文且类型正确', async () => {
      const res = await get('/__slg/panels/ui.js');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /javascript/);
      const js = await res.text();
      assert.ok(js.includes('__slgPanels'), '必须包含六府全局钩子');
      // 面板层禁 Math.random（P2.3 确定性红线）
      assert.ok(!/Math\.random\s*\(/.test(js), 'panel-ui.js 不得调用 Math.random');
    });

    await t.test('六府 state：六个面板的数据源齐全（扁平结构）', async () => {
      const res = await get('/__slg/panels/state');
      assert.equal(res.status, 200);
      const v = await res.json();
      // 注意：panels/state 是扁平结构（不是 {general:{...}} 分桶）
      assert.ok(Array.isArray(v.generals), '缺少武将名册 generals[]');
      assert.ok(Array.isArray(v.items), '缺少府库 items[]');
      assert.ok(v.interior && typeof v.interior === 'object', '缺少内政 interior');
      assert.ok(v.strategy && typeof v.strategy === 'object', '缺少战略 strategy');
      assert.ok(Array.isArray(v.strategy.cities), '战略台应带 72 城');
      assert.equal(v.strategy.cities.length, 72);
      assert.ok(Array.isArray(v.library), '缺少战法库 library[]');
      assert.ok(typeof v.day === 'number' && typeof v.turn === 'number');
    });

    await t.test('六府 selfcheck：51 条配方自检全通（无缺失/无错配/无超限）', async () => {
      const res = await get('/__slg/panels/selfcheck');
      assert.equal(res.status, 200);
      const v = await res.json();
      assert.equal(v.ok, true, `自检未通过: ${JSON.stringify(v).slice(0, 200)}`);
      assert.equal(v.skillCount, 51, '配方库应为 51 条');
      assert.deepEqual(v.missing, [], '不得有缺少获取途径的配方');
      assert.deepEqual(v.mismatch, [], '不得有名称不一致');
      assert.deepEqual(v.overItem, [], '不得有单件加成超 8%');
    });

    await t.test('战报红点：reports-head 返回 latest/unread 数字', async () => {
      const res = await get('/__slg/panels/reports-head');
      const v = await res.json();
      assert.equal(typeof v.latest, 'number');
      assert.equal(typeof v.unread, 'number');
    });

    await t.test('panels/action：未知动作拒绝、不存在物品拒绝，且失败带 message', async () => {
      // 面板动作的字段是 type（不是 action），失败文案字段是 message（原版风格）
      const bad = await post('/__slg/panels/action', { type: 'nope' });
      const bv = await bad.json();
      assert.equal(bv.ok, false);
      assert.ok(bv.message, '失败必须给 message');
      assert.ok(bv.view, '失败也要回 view，前端才能继续渲染');

      const gone = await (await post('/__slg/panels/action', { type: 'dismantle', itemId: 999999 })).json();
      assert.equal(gone.ok, false, '不存在的物品应失败');
      assert.ok(gone.message);
    });

    await t.test('举义：8 诸侯卡各带候选都城；非法提交被拒', async () => {
      const res = await get('/__slg/oath/options');
      const v = await res.json();
      assert.equal(v.lords.length, 8, '诸侯卡应为 8 张');
      for (const l of v.lords) {
        assert.ok(l.color && l.trait && l.trait.name, `诸侯 ${l.name} 缺色或性情`);
        assert.ok(Array.isArray(l.cities) && l.cities.length > 0, `诸侯 ${l.name} 缺候选都城`);
        assert.ok(l.cities.every((c) => typeof c.id === 'number' && c.name), '候选城要有 id 与名称');
      }

      const bad = await post('/__slg/oath/choose', { lord: '不存在', city: -1 });
      const bv = await bad.json();
      assert.equal(bv.ok, false);
    });

    await t.test('战略台：72 城 / 详情 / 底图 / 图层白名单', async () => {
      const st = await (await get('/__slg/strategy/state')).json();
      assert.equal(st.cities.length, 72, '固定 72 城');
      assert.equal(typeof st.day, 'number');
      assert.ok(Array.isArray(st.marches));
      assert.ok(Array.isArray(st.routes));

      const detail = await (await get('/__slg/strategy/detail')).json();
      assert.ok(Object.keys(detail).length > 0, 'detail 不应为空');

      const pano = await get('/__slg/strategy/panorama.png');
      assert.equal(pano.status, 200);
      assert.match(pano.headers.get('content-type') || '', /image/);

      // 白名单：非 png/jpg 一律拒
      const badLayer = await get('/__slg/strategy/layers/evil.html');
      assert.notEqual(badLayer.status, 200, '非法图层名必须被拒');
    });

    await t.test('strategy/action：未知 act 拒绝；formup 缺参失败带 reason', async () => {
      const bad = await (await post('/__slg/strategy/action', { act: 'nope' })).json();
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, 'bad_action');

      const formup = await (await post('/__slg/strategy/action', { act: 'formup', cityId: mainCity })).json();
      assert.equal(formup.ok, false);
      assert.ok(formup.reason, '编队缺参应给 reason');
    });

    await t.test('strategy/tick：返回 skipped/advanced，且 day 单调不减', async () => {
      const before = server.getState().clock.day;
      const v = await (await post('/__slg/strategy/tick', {})).json();
      assert.equal(typeof v.day, 'number');
      assert.ok(v.day >= before, `推演后 day 不应回退：${before} → ${v.day}`);
      assert.ok('skipped' in v || 'advanced' in v);
    });

    await t.test('存档：三档位、越界拒绝、空档读取拒绝、存读往返一致', async () => {
      const slots = await (await get('/__slg/save/slots')).json();
      assert.equal(slots.slots.length, 3, '应有三个档位');
      assert.deepEqual(slots.slots.map((s) => s.slot), [1, 2, 3]);
      // current 是当前档的绝对路径（不是档位序号）
      assert.ok(typeof slots.current === 'string' && slots.current.length > 0, 'current 应为路径字符串');
      assert.ok(slots.slots.some((s) => s.path === slots.current), 'current 必须指向某个档位');

      const oob = await (await post('/__slg/save/slot', { slot: 9, action: 'save' })).json();
      assert.equal(oob.ok, false);
      assert.equal(oob.reason, 'bad_request');

      const empty = await (await post('/__slg/save/slot', { slot: 3, action: 'load' })).json();
      assert.equal(empty.ok, false);
      assert.equal(empty.reason, 'empty_slot');

      const dayBefore = server.getState().clock.day;
      assert.equal((await (await post('/__slg/save/slot', { slot: 3, action: 'save' })).json()).ok, true);
      assert.equal((await (await post('/__slg/save/slot', { slot: 3, action: 'load' })).json()).ok, true);
      assert.equal(server.getState().clock.day, dayBefore, '存读往返后 day 应一致');
    });

    await t.test('导出/导入：导出是完整 world；空对象报 not_a_save；往返成功', async () => {
      const exp = await get('/__slg/save/export');
      assert.equal(exp.status, 200);
      assert.match(exp.headers.get('content-disposition') || '', /attachment/);
      const exported = await exp.json();
      assert.ok(exported.role && exported.roleRes, '导出内容必须是 world');

      const bad = await (await post('/__slg/save/import', {})).json();
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, 'not_a_save');

      const okRes = await (await post('/__slg/save/import', exported)).json();
      assert.equal(okRes.ok, true, `导入应成功: ${JSON.stringify(okRes)}`);
      assert.equal(typeof okRes.day, 'number');
    });

    await t.test('GM：编辑页/看板可取；overrides 读写往返', async () => {
      assert.equal((await get('/__slg/gm')).status, 200);
      assert.equal((await get('/__slg/board')).status, 200);

      const before = await (await get('/__slg/gm/overrides')).json();
      assert.equal(typeof before, 'object');

      const w = await (await post('/__slg/gm/overrides', { rules: { upkeepPerSoldier: 999 } })).json();
      assert.equal(w.ok, true);
      const after = await (await get('/__slg/gm/overrides')).json();
      // 规则必须被 RULE_RANGES 夹紧
      assert.ok(Number(after.rules?.upkeepPerSoldier) <= 100, 'upkeepPerSoldier 应被夹到 ≤100');

      // 还原，避免污染后续轮次
      await post('/__slg/gm/overrides', before);
    });

    await t.test('安全：路径穿越被拒、未知 /__slg 路径 404、OPTIONS 204', async () => {
      const trav = await get('/../server/index.js');
      const travText = await trav.text();
      assert.ok(!travText.includes('startOfflineServer'), '不得穿越到源码目录');
      assert.ok(!travText.includes('__slg'), '不得返回源码内容');

      const unknown = await get('/__slg/definitely-not-a-route');
      assert.equal(unknown.status, 404);

      const opt = await fetch(base + '/__slg/panels/state', { method: 'OPTIONS' });
      assert.equal(opt.status, 204);
    });

    await t.test('原版账号口：forgetpwd/resetpwd 与原 account/* 兜底', async () => {
      const fp = await get('/account/forgetpwd');
      assert.equal(fp.status, 200);
      assert.ok((await fp.text()).length > 0);

      const any = await (await post('/account/whatever', {})).json();
      assert.equal(any.code, 0);
    });

    await t.test('restart：重置为新局（day=1、战报清空、举义未完成）', async () => {
      const v = await (await post('/__slg/restart', {})).json();
      assert.equal(v.ok, true);
      const st = server.getState();
      assert.equal(st.clock.day, 1);
      assert.equal(st.warReports.length, 0);
      assert.equal(st.oath.done, false);
    });
  } finally {
    await server.close();
  }
});
