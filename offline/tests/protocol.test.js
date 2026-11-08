/**
 * 端到端协议测试：完全按原客户端的线协议对话，验证
 * 登录 → 进图 → 原操作 → 出征 → 确定性战斗 → 原版战报 → 存档/读档。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOfflineServer } from '../server/index.js';
import { ProtocolClient } from './client.js';
import { runBattle, DEFAULT_BATTLE_CONFIG } from '../kernel/index.js';
import { resolveBattle, battleConfig } from '../server/battle.js';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';

const tmp = mkdtempSync(join(tmpdir(), 'slg-offline-'));
const httpPort = 18088 + (process.pid % 1000);
const wsPort = 18004 + (process.pid % 1000);

test('离线协议服务：完整链路 + 确定性战斗 + 存档', async (t) => {
  const server = await startOfflineServer({
    saveDir: tmp, httpPort, wsPort, travelMs: 300, quiet: true,
  });
  const client = new ProtocolClient(`ws://127.0.0.1:${wsPort}`);

  try {
    await t.test('handshake 是连接后的第一帧，且带 16 位 key', async () => {
      const hand = await client.connect();
      assert.equal(hand.name, 'handshake');
      assert.equal(hand.msg.key.length, 16);
      assert.equal(client.raw[0].length > 0, true);
    });

    await t.test('账号登录 / 进入服务器 / 全量属性（字段名与原 proto 一致）', async () => {
      const login = await client.request('account.login', { username: 'player', password: 'md5', hardware: 'x' });
      assert.equal(login.code, 0);
      assert.equal(login.msg.uid, 1);
      assert.equal(typeof login.msg.session, 'string');

      const enter = await client.request('role.enterServer', { session: login.msg.session });
      assert.equal(enter.code, 0);
      assert.ok(enter.msg.role.rid > 0);
      assert.ok(enter.msg.role_res.wood >= 0);
      assert.equal(typeof enter.msg.time, 'number');

      const conf = await client.request('nationMap.config', {});
      assert.ok(Array.isArray(conf.msg.Confs), 'nationMap.config 必须返回大写 Confs');
      assert.ok(conf.msg.Confs.length > 0);

      const prop = await client.request('role.myProperty', {});
      assert.ok(Array.isArray(prop.msg.citys));
      assert.ok(prop.msg.citys.length >= 1, '至少要有一个主城');
      assert.equal(prop.msg.citys[0].is_main, 1);
      assert.ok(Array.isArray(prop.msg.generals));
      assert.ok(Array.isArray(prop.msg.armys));
      assert.ok(Array.isArray(prop.msg.mr_builds));

      const cityId = prop.msg.citys[0].cityId;
      const fac = await client.request('city.facilities', { cityId });
      assert.equal(fac.msg.cityId, cityId);
      assert.ok(Array.isArray(fac.msg.facilities));

      const armys = await client.request('army.myList', { cityId });
      assert.ok(armys.msg.armys.length >= 1);

      const pos = await client.request('role.posTagList', {});
      assert.ok(Array.isArray(pos.msg.pos_tags));

      const wr = await client.request('war.report', {});
      assert.ok(Array.isArray(wr.msg.list));

      const skill = await client.request('skill.list', {});
      assert.ok(Array.isArray(skill.msg.list));

      const oc = await client.request('interior.openCollect', {});
      assert.equal(typeof oc.msg.limit, 'number');
    });

    await t.test('原操作链（征收 / 设施升级 / 征兵 / 标记 / 聊天）均可应答', async () => {
      const cityId = server.getState().citys[0].cityId;
      assert.equal((await client.request('interior.collect', {})).code, 0);
      assert.equal((await client.request('city.upFacility', { cityId, fType: 1 })).code, 0);
      assert.equal((await client.request('army.conscript', { armyId: server.getState().armys[0].id, cnts: [100, 100, 100] })).code, 0);
      assert.equal((await client.request('role.opPosTag', { type: 1, x: 10, y: 10, name: '标记' })).code, 0);
      assert.equal((await client.request('chat.chat', { type: 0, msg: '单机测试' })).code, 0);
      assert.equal((await client.request('nationMap.scanBlock', { x: 90, y: 90, length: 20 })).code, 0);
      // 原心跳是 seq=0 推送，回包同样是 seq=0（不走请求-响应配对）
      client.send('heartbeat', { ctime: Date.now() });
      const hb = await client.waitFor((f) => f.name === 'heartbeat' && f.seq === 0);
      assert.equal(hb.code, 0);
      assert.equal(typeof hb.msg.stime, 'number');
    });

    await t.test('出征触发确定性内核战斗，产出原版 WarReport 结构', async () => {
      const army = server.getState().armys[0];
      const assign = await client.request('army.assign', { armyId: army.id, cmd: 1, x: 100, y: 101 });
      assert.equal(assign.code, 0);
      assert.equal(assign.msg.army.cmd, 1);
      assert.equal(assign.msg.army.to_x, 100);

      const push = await client.waitFor((f) => f.name === 'warReport.push' && f.seq === 0, 8000);
      const r = push.msg;
      assert.equal(push.code, 0);
      assert.equal(r.a_rid, 1);
      assert.equal(r.x, 100);
      assert.equal(r.y, 101);
      assert.ok([0, 1, 2].includes(r.result));
      // 客户端 MapUIProxy.createWarReprot 会对这些字段做 JSON.parse
      for (const k of ['b_a_army', 'b_d_army', 'e_a_army', 'e_d_army',
        'b_a_general', 'b_d_general', 'e_a_general', 'e_d_general', 'rounds']) {
        assert.equal(typeof r[k], 'string', `${k} 必须是 JSON 字符串`);
        assert.doesNotThrow(() => JSON.parse(r[k]), `${k} 必须可 JSON.parse`);
      }
      const rounds = JSON.parse(r.rounds);
      assert.ok(Array.isArray(rounds) && rounds.length > 0);
      for (const round of rounds) {
        assert.ok(Array.isArray(round.b));
        for (const hit of round.b) {
          for (const k of ['a_id', 'd_id', 'd_loss', 'a_bs', 'a_as', 'd_as']) {
            assert.ok(k in hit, `hit 缺少 ${k}`);
          }
        }
      }
      const generals = JSON.parse(r.b_a_general);
      assert.equal(generals.length, 1);
      assert.equal(generals[0].length, 17);

      // 内核证据：事件指纹 / rng 调用数 / 可复现
      const logEntry = server.getState().battleLog.at(-1);
      assert.ok(logEntry);
      assert.equal(logEntry.events > 0, true);
      assert.match(logEntry.event_fingerprint, /^[0-9a-f]{16}$/);
      assert.ok(logEntry.rng_calls > 0);

      const wr = await client.request('war.report', {});
      assert.ok(wr.msg.list.some((x) => x.id === r.id));
    });

    await t.test('同 seed 同输入 → 完全相同事件指纹（确定性）', async () => {
      const cfg = loadConfig();
      const w1 = createWorld(cfg);
      const w2 = createWorld(cfg);
      const a = w1.armys[0];
      const b = w2.armys[0];
      const r1 = resolveBattle({ cfg, state: w1, army: a, x: 100, y: 101, seed: 424242 });
      const r2 = resolveBattle({ cfg, state: w2, army: b, x: 100, y: 101, seed: 424242 });
      assert.equal(r1.kernel.event_fingerprint, r2.kernel.event_fingerprint);
      assert.equal(r1.kernel.rng_calls, r2.kernel.rng_calls);
      assert.deepEqual(r1.report.rounds, r2.report.rounds);
      assert.equal(r1.report.result, r2.report.result);
    });

    await t.test('不同 seed → 事件流不同', () => {
      const cfg = loadConfig();
      const w1 = createWorld(cfg);
      const w2 = createWorld(cfg);
      const r1 = resolveBattle({ cfg, state: w1, army: w1.armys[0], x: 100, y: 101, seed: 1 });
      const r2 = resolveBattle({ cfg, state: w2, army: w2.armys[0], x: 100, y: 101, seed: 2 });
      assert.notEqual(r1.kernel.event_fingerprint, r2.kernel.event_fingerprint);
    });

    await t.test('HTTP 8088 账号接口与原画面静态资源可访问', async () => {
      const reg = await fetch(`http://127.0.0.1:${httpPort}/account/register?username=a&password=b&hardware=c`);
      assert.equal(reg.status, 200);
      assert.equal((await reg.json()).code, 0);
      const page = await fetch(`http://127.0.0.1:${httpPort}/index.html`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Cocos Creator/);
      assert.match(html, /GameCanvas/);
      const status = await (await fetch(`http://127.0.0.1:${httpPort}/__slg/status`)).json();
      assert.ok(status.requestLog.some((x) => x.name === 'role.myProperty'));
      assert.ok(status.battles >= 1);
    });

    await t.test('存档落盘，重启后战报/领地/资源仍在', async () => {
      client.close();
      await server.close();
      assert.equal(existsSync(join(tmp, 'save.json')), true);
      const saved = JSON.parse(readFileSync(join(tmp, 'save.json'), 'utf8'));
      assert.ok(saved.warReports.length >= 1);

      const server2 = await startOfflineServer({ saveDir: tmp, httpPort: httpPort + 1, wsPort: wsPort + 1, travelMs: 300, quiet: true });
      const client2 = new ProtocolClient(`ws://127.0.0.1:${wsPort + 1}`);
      try {
        await client2.connect();
        await client2.request('account.login', { username: 'player', password: 'md5' });
        await client2.request('role.enterServer', { session: 'offline-session' });
        const wr = await client2.request('war.report', {});
        assert.ok(wr.msg.list.length >= 1);
        assert.equal(server2.getState().battleLog.length >= 1, true);
      } finally {
        client2.close();
        await server2.close();
      }
    });
  } finally {
    client.close();
    try { await server.close(); } catch { /* 可能已关闭 */ }
    rmSync(tmp, { recursive: true, force: true });
  }
});
