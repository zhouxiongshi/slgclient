/**
 * P11 · 登录门禁契约：未登录前 /__slg/session.ready=false，且 index.html 首帧
 * 就带 data-slg-phase="login" 的隐藏样式；真实 WS `account.login` 成功后才放行。
 *
 * 这是用户第 2 项「未登录前不该看到任何面板数据」的服务端硬证据，
 * 与 electron/mouse-playtest.cjs 的浏览器侧取证互为交叉验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOfflineServer } from '../server/index.js';
import { ProtocolClient } from './client.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'slg-session-'));
const httpPort = 23088 + (process.pid % 500);
const wsPort = 23004 + (process.pid % 500);
const base = `http://127.0.0.1:${httpPort}`;

test('P11 登录门禁：登录前隐藏、登录后放行、登出后收回', async () => {
  const server = await startOfflineServer({ saveDir: tmp, httpPort, wsPort, travelMs: 300, quiet: true });
  const client = new ProtocolClient(`ws://127.0.0.1:${wsPort}`);
  try {
    const before = await (await fetch(base + '/__slg/session')).json();
    assert.equal(before.ok, true);
    assert.equal(before.ready, false, '服务刚起来、还没 WS 登录时不能放行');
    assert.equal(before.phase, 'login');

    const html = await (await fetch(base + '/index.html')).text();
    assert.ok(html.includes('data-slg-phase', '首帧就要带登录阶段标记'));
    assert.ok(html.includes('/__slg/shell/ui.js', '界面外壳脚本必须随响应下发'));
    assert.ok(html.includes('html[data-slg-phase="login"] #slgIxRoot'), '登录态要隐藏交互层根节点');

    await client.connect();
    const login = await client.request('account.login', { username: 'mouse', password: 'pw' });
    assert.equal(login.code, 0);
    const after = await (await fetch(base + '/__slg/session')).json();
    assert.equal(after.ready, true, '真实 WS 登录成功后才放行');
    assert.equal(after.phase, 'game');
    assert.equal(after.username, 'mouse');

    await client.request('account.logout', {});
    const out = await (await fetch(base + '/__slg/session')).json();
    assert.equal(out.ready, false, '登出立刻收回面板');
    assert.equal(out.phase, 'login');

    /* 磁盘 web/ 一个字节都没动 */
    const { readFileSync } = await import('node:fs');
    const disk = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
    assert.ok(!disk.includes('/__slg/shell/ui.js'));
    assert.ok(!disk.includes('data-slg-phase'));
  } finally {
    client.close();
    await server.close();
  }
});
