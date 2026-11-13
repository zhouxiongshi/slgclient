/**
 * M3-3：六剧本生成器测试（GDD §12.1 四条开局校验）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenario } from '../tools/build-scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAP = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/strategy/map.json'), 'utf8'));
const SCEN_DIR = resolve(ROOT, 'conf/campaign/strategy/scenarios');

const EXPECT = [
  ['huangjin-184', 184],
  ['taodong-190', 190],
  ['guandu-200', 200],
  ['chibi-208', 208],
  ['yiling-221', 221],
  ['sanfen-229', 229],
];

const adjacency = new Map(MAP.cities.map((c) => [c.id, []]));
for (const r of MAP.routes) {
  if (adjacency.has(r.from) && adjacency.has(r.to)) {
    adjacency.get(r.from).push(r.to);
    adjacency.get(r.to).push(r.from);
  }
}

function load(id) {
  return JSON.parse(readFileSync(resolve(SCEN_DIR, `${id}.json`), 'utf8'));
}

test('M3-3·六剧本文件齐全且年份正确', () => {
  for (const [id, year] of EXPECT) {
    const doc = load(id);
    assert.equal(doc.id, id);
    assert.equal(doc.year, year);
    assert.ok(doc.cityOwner, `${id} 缺 cityOwner`);
    assert.equal(doc.reviewed, false, `${id} 应待人工签核`);
  }
});

test('M3-3·V1 每城必有主且无未知势力', () => {
  for (const [id] of EXPECT) {
    const doc = load(id);
    const fIds = new Set(doc.factions.map((f) => f.id));
    const keys = Object.keys(doc.cityOwner);
    assert.equal(keys.length, MAP.cities.length, `${id} 归属城数`);
    const covered = new Set(keys.map(Number));
    for (const c of MAP.cities) assert.ok(covered.has(c.id), `${id} 缺城 ${c.id}`);
    for (const fid of Object.values(doc.cityOwner)) {
      assert.ok(fIds.has(fid), `${id} 未知势力 ${fid}`);
    }
  }
});

test('M3-3·V2 有脑势力 1..12 城', () => {
  for (const [id] of EXPECT) {
    const doc = load(id);
    const counts = {};
    for (const fid of Object.values(doc.cityOwner)) counts[fid] = (counts[fid] || 0) + 1;
    for (const f of doc.factions) {
      if (!f.brain) continue;
      const n = counts[f.id] || 0;
      assert.ok(n >= 1 && n <= 12, `${id} 有脑势力 ${f.id} ${n} 城越界`);
    }
  }
});

test('M3-3·V3 玩家势力邻接 ≥2 个非己方城', () => {
  for (const [id] of EXPECT) {
    const doc = load(id);
    for (const pid of doc.playerDefault) {
      const mine = Object.entries(doc.cityOwner)
        .filter(([, f]) => f === pid)
        .map(([cid]) => Number(cid));
      assert.ok(mine.length > 0, `${id} 玩家势力 ${pid} 无城`);
      const others = new Set();
      for (const cid of mine) {
        for (const nb of adjacency.get(cid) || []) {
          if (doc.cityOwner[String(nb)] !== pid) others.add(nb);
        }
      }
      assert.ok(others.size >= 2, `${id} 玩家 ${pid} 邻接非己城 ${others.size} (<2)`);
    }
  }
});

test('M3-3·V4 任意两势力路网连通', () => {
  for (const [id] of EXPECT) {
    const doc = load(id);
    const byF = {};
    for (const [cid, fid] of Object.entries(doc.cityOwner)) {
      (byF[fid] = byF[fid] || []).push(Number(cid));
    }
    const list = Object.keys(byF);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const seen = new Set(byF[list[i]]);
        const queue = [...byF[list[i]]];
        let ok = false;
        while (queue.length && !ok) {
          const x = queue.shift();
          for (const y of adjacency.get(x) || []) {
            if (seen.has(y)) continue;
            if (byF[list[j]].includes(y)) { ok = true; break; }
            seen.add(y);
            queue.push(y);
          }
        }
        assert.ok(ok, `${id} ${list[i]}↔${list[j]} 不连通`);
      }
    }
  }
});

test('M3-3·validateScenario 能抓出归属缺口', () => {
  const doc = load('taodong-190');
  const ownership = new Map(Object.entries(doc.cityOwner).map(([k, v]) => [Number(k), v]));
  const ok = validateScenario(doc, ownership);
  assert.deepEqual(ok.errs, []);
  // 抠掉一城 → V1 城数不符
  const broken = new Map(ownership);
  broken.delete(72);
  const bad = validateScenario(doc, broken);
  assert.ok(bad.errs.some((e) => e.startsWith('V1')), '缺城应触发 V1');
});

test('M3-3·生成器 --check 子进程校验通过', () => {
  assert.ok(existsSync(resolve(ROOT, 'tools/build-scenarios.mjs')));
  execFileSync(process.execPath, [resolve(ROOT, 'tools/build-scenarios.mjs'), '--check'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
});
