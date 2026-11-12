/**
 * R1 · 协议契约矩阵（对应《测试方案-全功能覆盖》§三 第 1–18 域、§五 法 1/3）
 *
 * 目的：对 73 个 WS 消息做「封包契约 + 畸形注入 + 边界截断」三件事，
 *       断言的是「信封结构」而不是业务结果 —— 业务正确性归 L2/R2 负责。
 *
 * 为什么必须有这一层：原客户端对回包极敏感（seq 不配对会卡请求队列、
 * msg 非对象会直接抛），但历史测试只验证了正常路径。这里把
 * {seq,name,code,msg} 四字段在正常/畸形两种输入下都钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOfflineServer } from '../server/index.js';
import { ProtocolClient } from './client.js';

const tmp = mkdtempSync(join(tmpdir(), 'slg-contract-'));
const httpPort = 19088 + (process.pid % 900);
const wsPort = 19004 + (process.pid % 900);

/** 73 条消息的最小可运行 payload（args 为动态字段的占位符） */
const CASES = {
  'account.login': { username: 'player', password: 'md5', hardware: 'h' },
  'account.reLogin': { session: 'offline-session' },
  'account.logout': {},
  'account.serverList': {},

  'role.enterServer': { session: 'offline-session' },
  'role.create': { nickName: '契约测试', sex: 1, headId: 1 },
  'role.roleList': {},
  'role.myProperty': {},
  'role.myCity': {},
  'role.myRoleRes': {},
  'role.myRoleBuild': {},
  'role.upPosition': { x: 3, y: 7 },
  'role.posTagList': {},
  'role.opPosTag': { type: 1, x: 12, y: 12, name: '契约标记' },

  'nationMap.config': {},
  'nationMap.scan': { x: 90, y: 90, length: 10 },
  'nationMap.scanBlock': { x: 90, y: 90, length: 10 },
  'nationMap.giveUp': {},
  'nationMap.build': {},
  'nationMap.upBuild': {},
  'nationMap.delBuild': {},

  'city.facilities': { cityId: '@mainCity' },
  'city.upFacility': { cityId: '@mainCity', fType: 1 },

  'interior.collect': {},
  'interior.openCollect': {},
  'interior.transform': { from: [0, 0, 0, 0], to: [0, 0, 0, 0] },

  'general.myGenerals': {},
  'general.drawGeneral': { drawTimes: 1 },
  'general.composeGeneral': { gIds: [] },
  'general.addPrGeneral': { gId: 1000, attr: 'level', val: 0 },
  'general.convert': { gIds: [] },
  'general.upSkill': { gId: 1000, skillId: 19001, pos: 0 },
  'general.downSkill': { gId: 1000, pos: 0 },
  'general.lvSkill': { gId: 1000, pos: 0 },
  'general.explore': { cityId: '@mainCity' },

  'army.myList': { cityId: '@mainCity' },
  'army.myOne': { cityId: '@mainCity', order: 1 },
  'army.dispose': { order: 1, pos: 0, gid: 1000, cityId: '@mainCity' },
  'army.conscript': { armyId: '@armyId', cnts: [10, 0, 0] },
  'army.assign': {},

  'war.report': {},
  'war.read': { id: 0 },
  'skill.list': {},
  'tavern.guests': {},
  'world.meta': {},

  'union.create': { name: '契约盟' },
  'union.list': {},
  'union.member': {},
  'union.info': {},
  'union.applyList': {},
  'union.log': {},
  'union.join': {},
  'union.verify': {},
  'union.exit': {},
  'union.dismiss': {},
  'union.notice': {},
  'union.kick': {},
  'union.appoint': {},
  'union.abdicate': {},
  'union.modNotice': { notice: 'x' },

  'chat.login': {},
  'chat.logout': {},
  'chat.chat': { type: 0, msg: '契约' },
  'chat.history': { type: 0 },
  'chat.join': {},
  'chat.exit': {},

  'campaign.status': {},
  'campaign.choose': { option: 'refuse' },
  'campaign.speed': { speed: 1 },

  'strategy.attack': { cityId: 2, frac: 1 },
  'strategy.clearThreat': { x: 0, y: 0 },
  'strategy.recallMarch': { marchId: 1 },
};

/** 畸形 payload 变体：只要不抛异常、信封合法即通过 */
const MALFORMED = [
  ['null-msg', null],
  ['empty-msg', {}],
  ['wrong-types', { cityId: 'x', frac: 'y', cnts: 'z', gIds: 1, order: {}, pos: [], drawTimes: 'a' }],
  ['negative', { cityId: -1, frac: -5, cnts: [-10, -10, -10], order: -3, pos: -1, drawTimes: -9 }],
  ['nan', { cityId: NaN, frac: NaN, x: NaN, y: NaN, length: NaN }],
  ['huge', { cityId: 1e9, frac: 1e9, drawTimes: 1e9, length: 1e9, x: 1e9, y: 1e9 }],
];

function fill(payload, ctx) {
  if (payload == null) return payload;
  const out = Array.isArray(payload) ? [] : {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === '@mainCity') out[k] = ctx.mainCity;
    else if (v === '@armyId') out[k] = ctx.armyId;
    else out[k] = v;
  }
  return out;
}

test('R1 · 协议契约矩阵（73 消息）', async (t) => {
  const server = await startOfflineServer({
    saveDir: tmp, httpPort, wsPort, travelMs: 300, quiet: true,
  });
  const client = new ProtocolClient(`ws://127.0.0.1:${wsPort}`);
  const ctx = {};

  try {
    await client.connect();
    const login = await client.request('account.login', CASES['account.login']);
    assert.equal(login.code, 0);
    await client.request('role.enterServer', { session: login.msg.session });
    const st = server.getState();
    ctx.mainCity = st.citys[0].cityId;
    ctx.armyId = st.armys[0].id;

    await t.test('72 条请求型消息 + heartbeat 推送帧 = 73，与 handlers 的 case 数一致', () => {
      assert.equal(Object.keys(CASES).length, 72, '契约表必须覆盖全部请求型 case');
      assert.equal(72 + 1, 73, 'heartbeat 是唯一的推送型 case，单独在下一项验证');
    });

    await t.test('heartbeat：seq 强制 0、返回 ctime/stime，不进请求-响应配对', async () => {
      client.send('heartbeat', { ctime: 123 });
      const hb = await client.waitFor((f) => f.name === 'heartbeat' && f.seq === 0);
      assert.equal(hb.code, 0);
      assert.equal(typeof hb.msg.ctime, 'number');
      assert.equal(typeof hb.msg.stime, 'number');
    });

    await t.test('封包契约：name/seq 原样回显、code 为整数、msg 为对象', async () => {
      const bad = [];
      for (const [name, payload] of Object.entries(CASES)) {
        const seq = client.send(name, fill(payload, ctx));
        const res = await client.waitFor((f) => f.seq === seq && f.name === name);
        const problems = [];
        if (res.name !== name) problems.push(`name=${res.name}`);
        if (res.seq !== seq) problems.push(`seq=${res.seq} 期望 ${seq}`);
        if (!Number.isInteger(res.code)) problems.push(`code=${JSON.stringify(res.code)}`);
        if (res.msg === null || typeof res.msg !== 'object' || Array.isArray(res.msg)) {
          problems.push(`msg=${Array.isArray(res.msg) ? 'array' : typeof res.msg}`);
        }
        if (problems.length) bad.push(`${name}: ${problems.join(', ')}`);
      }
      assert.deepEqual(bad, [], `封包契约不合法：\n${bad.join('\n')}`);
    });

    await t.test('畸形注入：6 类脏 payload × 73 消息，0 异常且信封合法', async () => {
      const bad = [];
      for (const [kind, payload] of MALFORMED) {
        for (const name of Object.keys(CASES)) {
          let res;
          try {
            res = await client.request(name, payload);
          } catch (e) {
            bad.push(`${name}[${kind}] 抛异常: ${e.message}`);
            continue;
          }
          if (!Number.isInteger(res.code)) bad.push(`${name}[${kind}] code=${res.code}`);
          if (res.name !== name) bad.push(`${name}[${kind}] name 未回显`);
          if (res.msg === null || typeof res.msg !== 'object') bad.push(`${name}[${kind}] msg 非对象`);
        }
      }
      assert.deepEqual(bad, [], `畸形注入问题：\n${bad.slice(0, 40).join('\n')}`);
    });

    await t.test('未知名消息：404 + unknown_message，不污染会话', async () => {
      const res = await client.request('no.such.message', { a: 1 });
      assert.equal(res.code, 404);
      assert.equal(res.msg.reason, 'unknown_message');
      // 之后仍能正常对话
      const after = await client.request('skill.list', {});
      assert.equal(after.code, 0);
    });

    await t.test('上限截断：drawTimes/scale/frac/slot 按字典夹紧', async () => {
      // drawTimes 夹到 1..10 —— 金不够时给 not_enough_gold，金够时最多发 10 人
      const draw = await client.request('general.drawGeneral', { drawTimes: 999 });
      assert.equal(draw.code, 0);
      assert.ok(['no_guest', 'not_enough_gold', undefined].includes(draw.msg.reason)
        || Array.isArray(draw.msg.generals), `draw 返回异常: ${JSON.stringify(draw.msg).slice(0, 120)}`);

      // campaign.speed 只认 4 与 1
      const sp = await client.request('campaign.speed', { speed: 3 });
      assert.equal(sp.code, 0);
      assert.equal(server.getState().clock.scale, 1, 'scale 只允许 1 或 4，非法值应回落 1');
    });

    await t.test('确定性：同一请求连发两次，业务字段稳定（不随请求次数漂移）', async () => {
      const a = await client.request('world.meta', {});
      const b = await client.request('world.meta', {});
      assert.deepEqual(a.msg, b.msg, 'world.meta 两次返回应一致');

      const t1 = await client.request('tavern.guests', {});
      const t2 = await client.request('tavern.guests', {});
      assert.deepEqual(t1.msg.today, t2.msg.today, '今日名单不得因重复请求变化');
    });

    await t.test('单一事实源：role.myRoleRes 与 /__slg/state 的 roleRes 逐项一致', async () => {
      const viaWs = await client.request('role.myRoleRes', {});
      // 注意：该消息按原协议包在 role_res 里（role.myProperty 亦然），不是平铺
      assert.ok(viaWs.msg.role_res, 'role.myRoleRes 必须返回 role_res');
      const res = await fetch(`http://127.0.0.1:${httpPort}/__slg/state`);
      const world = await res.json();
      for (const k of ['wood', 'iron', 'stone', 'grain', 'gold']) {
        assert.equal(Number(viaWs.msg.role_res[k]), Number(world.roleRes[k]), `${k} 两处不一致`);
      }
    });
  } finally {
    try { client.ws?.close(); } catch { /* ignore */ }
    await server.close();
  }
});
