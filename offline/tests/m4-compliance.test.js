/**
 * M4-1 数据溯源合规测试：
 *   1) 全 conf 数据条目（554 条）source+confidence 无缺口，工具 exit 0；
 *   2) 武将 240 confidence 口径（史实→高 / 虚构→低）；
 *   3) 地图示意图声明登记 + UI 真实渲染；
 *   4) 负例：缺 confidence 的数据被扫描器精确抓出（COMPLIANCE_ROOT 临时根）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFFLINE = join(HERE, '..');
const TOOL = join(OFFLINE, 'tools', 'check-compliance.js');

test('M4-1 全量扫描：554 条溯源无缺口，exit 0', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], { cwd: OFFLINE, encoding: 'utf8' });
  assert.equal(r.status, 0, `check-compliance 应 exit 0：${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.totals.entries, 554, '52 事件 + 98 补量 + 24 宿命 + 240 武将 + 6 剧本 + 134 术语');
  assert.equal(j.totals.missing, 0);
  assert.equal(j.totals.files, 6);
});

test('武将 240 位 confidence 口径：史实→高、虚构/传说→低、零缺项', () => {
  const h = JSON.parse(readFileSync(join(OFFLINE, 'conf/campaign/heroes-240.json'), 'utf8'));
  const dist = {};
  for (const x of h.heroes) {
    assert.ok(['高', '中', '低'].includes(x.source.confidence), `${x.name} confidence 非法`);
    assert.ok(x.source.ref && x.source.ref !== '－', `${x.name} source.ref 缺失`);
    if (x.source.confidence === '高') assert.equal(x.source.level, '史实', `${x.name} confidence=高 须 level=史实`);
    dist[x.source.confidence] = (dist[x.source.confidence] || 0) + 1;
  }
  assert.equal(h.heroes.length, 240);
  assert.equal(dist['高'], 233);
  assert.equal(dist['低'], 7);
});

test('地图示意图声明：登记文件存在且 skills.js 渲染同一文本', () => {
  const decl = JSON.parse(readFileSync(join(OFFLINE, 'conf/compliance/map-declaration.json'), 'utf8'));
  assert.equal(decl.type, 'schematic_projection');
  assert.ok(decl.statement.includes('非标准行政地图'));
  const src = readFileSync(join(OFFLINE, 'server/skills.js'), 'utf8');
  assert.ok(src.includes('非标准行政地图'), '战略覆盖层图例必须渲染声明');
});

test('负例：缺 confidence 的条目被精确抓出并 exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'm4comp-'));
  try {
    mkdirSync(join(root, 'conf/campaign/strategy/scenarios'), { recursive: true });
    mkdirSync(join(root, 'conf/compliance'), { recursive: true });
    mkdirSync(join(root, 'conf/interaction'), { recursive: true });
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(root, 'reports'), { recursive: true });
    const badEvent = { id: 'evt.bad', source: { id: 'x', confidence: undefined }, when: {}, effects: [] };
    writeFileSync(join(root, 'conf/campaign/events.json'), JSON.stringify({ version: 1, events: [badEvent] }));
    writeFileSync(join(root, 'conf/campaign/events-extra.json'), JSON.stringify({ version: 1, events: [] }));
    writeFileSync(join(root, 'conf/campaign/fate-groups.json'), JSON.stringify({ version: 1, groups: [] }));
    writeFileSync(join(root, 'conf/campaign/heroes-240.json'), JSON.stringify({ version: 1, heroes: [] }));
    writeFileSync(join(root, 'conf/compliance/map-declaration.json'),
      JSON.stringify({ type: 'schematic_projection', statement: '非标准行政地图' }));
    writeFileSync(join(root, 'conf/interaction/terms.json'), JSON.stringify({ terms: [] }));
    writeFileSync(join(root, 'server/skills.js'), '非标准行政地图');
    writeFileSync(join(root, 'conf/compliance/provenance.json'), JSON.stringify({ assets: [] }));
    const r = spawnSync(process.execPath, [TOOL], {
      cwd: OFFLINE, encoding: 'utf8', env: { ...process.env, COMPLIANCE_ROOT: root },
    });
    assert.equal(r.status, 1, '缺口必须 exit 1');
    assert.match(r.stdout, /evt\.bad/);
    assert.match(r.stdout, /source\.confidence 非法/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
