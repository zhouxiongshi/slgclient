/**
 * 存档门槛：序章改造前的旧档没有穿越者主公，启动时归档留底并重开新局。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOfflineServer } from '../server/index.js';
import { hasProtagonist } from '../server/world.js';

test('无主角的旧档被归档，重开后开局只有主公', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slg-old-save-'));
  const savePath = join(dir, 'save.json');
  // 仿造一份序章改造前的存档：一批随机武将，没有 880001
  writeFileSync(savePath, JSON.stringify({
    version: 2,
    role: { rid: 1, uid: 1, nickName: '旧玩家' },
    generals: [{ id: 1000, cfgId: 100002, level: 10, skills: [] }],
    armys: [{ armyId: 2000, generals: [1000, 0, 0], soldiers: [1000, 0, 0] }],
  }), 'utf8');
  assert.equal(hasProtagonist(JSON.parse('{}')), false);

  const httpPort = 23088 + (process.pid % 100);
  const wsPort = 23004 + (process.pid % 100);
  const server = await startOfflineServer({
    saveDir: dir, httpPort, wsPort, travelMs: 300, quiet: true,
  });
  try {
    const state = server.ctx.state;
    assert.ok(hasProtagonist(state), '重开后必须有主公');
    assert.equal(state.generals.length, 1);
    assert.equal(state.generals[0].cfgId, 880001);
    const backups = readdirSync(dir).filter((n) => n.startsWith('save.json.pre-prologue-'));
    assert.equal(backups.length, 1, '旧档留底一份');
  } finally {
    await server.close();
  }
});
