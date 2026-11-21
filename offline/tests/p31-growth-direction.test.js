/**
 * P31 同名战法成长方向闸：官方 Lv1/Lv10 升降方向必须落到运行时十级表，
 * 同时保留原 Lv10 终点与本作内核机制（只改曲线形状，不做假照搬）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SKILLS, GROWTH_DIRECTION, skillById, kernelSkillAt } from '../server/skills.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO = resolve(ROOT, '..');
const PATH = join(ROOT, 'conf', 'skill-growth-direction.json');
const MIRROR = JSON.parse(readFileSync(join(ROOT, 'conf', 'skill-mirror.json'), 'utf8'));
const SOURCE = process.env.SLG_OFFICIAL_SKILL_JSON
  || join(REPO, 'skill-library-official-20261120.json');
const doc = JSON.parse(readFileSync(PATH, 'utf8'));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const dir = (d) => (d > 0.005 ? '+' : d < -0.005 ? '-' : '0');
const end = (text, idx) => Number(String(text).split('→')[idx]);

test('成长层来源可追溯，且未把镜像条目二次改写', () => {
  assert.ok(doc.count >= 40, `成长方向条目过少（${doc.count}）`);
  assert.equal(doc.entries.length, doc.count);
  assert.equal(doc.skipped.length, doc.skippedCount);
  assert.match(doc.sourceUrl, /^https:\/\//);
  assert.match(doc.sourceSha256, /^[0-9a-f]{64}$/);
  if (existsSync(SOURCE)) {
    assert.equal(createHash('sha256').update(readFileSync(SOURCE)).digest('hex'), doc.sourceSha256);
  }
  const mirrored = new Set(MIRROR.skills.map((s) => Number(s.cfgId)));
  for (const g of doc.entries) assert.ok(!mirrored.has(Number(g.cfgId)), `${g.name} 已镜像却再次改成长`);
});

test('每条成长方向都装载到运行时，十级数值与内核同源', () => {
  for (const g of doc.entries) {
    const s = skillById(g.cfgId);
    assert.ok(s, `${g.cfgId} 成长层战法未进入运行时表`);
    assert.equal(s.name, g.name);
    assert.deepEqual(s.ui.levels, g.levels, `${g.name} 运行时十级表与成长层漂移`);
    const k1 = kernelSkillAt(g.cfgId, 1), k10 = kernelSkillAt(g.cfgId, 10);
    assert.equal(k1.probability_init * 100, g.levels[0].probability, `${g.name} 内核 Lv1 概率漂移`);
    assert.equal(k10.probability_max * 100, g.levels[9].probability, `${g.name} 内核 Lv10 概率漂移`);
    const official = String(g.officialProbability || '').match(/(\d+(?:\.\d+)?)%(?:-(\d+(?:\.\d+)?)%)?/);
    if (g.changes.some((c) => c.field === 'probability')) {
      assert.ok(official, `${g.name} 改了发动率却没有官方记录`);
      assert.equal(dir(end(g.changes.find((c) => c.field === 'probability').official, 1)
        - end(g.changes.find((c) => c.field === 'probability').official, 0)),
      dir(g.levels[9].probability - g.levels[0].probability), `${g.name} 发动率方向与官方反向`);
    } else if (['被动', '指挥'].includes(g.skillClass)) {
      assert.equal(g.levels[0].probability, 100, `${g.name} 被动/指挥概率不是恒 100`);
      assert.equal(g.levels[9].probability, 100, `${g.name} 被动/指挥概率不是恒 100`);
    }
  }
});

test('效果槽只改方向、不改满级终点；每一级线性插值', () => {
  for (const g of doc.entries) {
    const slotChanges = g.changes.filter((c) => c.field.startsWith('槽 '));
    for (const c of slotChanges) {
      const i = Number(c.field.replace('槽 ', '')) - 1;
      assert.equal(dir(end(c.official, 1) - end(c.official, 0)),
        dir(g.levels[9].effect_value[i] - g.levels[0].effect_value[i]),
        `${g.name} ${c.field} 方向与官方反向`);
      assert.equal(round2(g.levels[9].effect_value[i]), g.baselineLv10.effect_value[i],
        `${g.name} ${c.field} Lv10 终点被改写`);
      for (let lv = 0; lv < 10; lv += 1) {
        assert.equal(round2(g.levels[lv].effect_value[i]),
          round2(g.levels[0].effect_value[i]
            + (g.levels[9].effect_value[i] - g.levels[0].effect_value[i]) * lv / 9),
          `${g.name} ${c.field} Lv${lv + 1} 非线性跳档`);
      }
    }
    const probChange = g.changes.find((c) => c.field === 'probability');
    if (probChange) {
      assert.equal(g.levels[9].probability, g.baselineLv10.probability,
        `${g.name} Lv10 发动率终点被改写`);
    }
  }
});

test('生成脚本可复跑：同一快照产出同一 JSON（写临时文件，不动出厂产物 mtime）', () => {
  const before = readFileSync(PATH, 'utf8');
  const out = join(tmpdir(), `slg-growth-check-${process.pid}.json`);
  execFileSync(process.execPath, [join(ROOT, 'tools', 'sync-growth-direction.mjs')], {
    cwd: ROOT, env: { ...process.env, SLG_GROWTH_OUT: out }, stdio: 'ignore',
  });
  assert.equal(readFileSync(out, 'utf8'), before, '再次生成结果漂移');
  unlinkSync(out);
});

test('无同名与已镜像条目没有混进成长层', () => {
  const ids = new Set(doc.entries.map((g) => Number(g.cfgId)));
  assert.equal(ids.size, doc.entries.length, '成长层 cfgId 重复');
  for (const g of doc.skipped) assert.ok(!ids.has(Number(g.cfgId)), `${g.name} 在 skip 台账却改了成长`);
  assert.ok(SKILLS.length > 150, '运行时战法表异常');
});
