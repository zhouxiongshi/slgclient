/**
 * 同名战法镜像闸：确认「同名可忠实落地者照搬、其余原样保留」的边界不被悄悄改写。
 *
 * ① 镜像条目确实被运行时战法表装载，cfgId / 名称不变；
 * ② 十级发动率与效果值逐条来自官方快照记录的 Lv1→Lv10，线性插值、非随机；
 * ③ 描述占位符数量与效果槽严格一一对齐（面板数字 = 内核数字）；
 * ④ 被判定为「内核不支持 / 无同名」的条目没有混进镜像，保留原表；
 * ⑤ 生成脚本可复跑且结果稳定（同一快照生成同一份 JSON）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SKILLS, skillById, kernelSkillAt } from '../server/skills.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO = resolve(ROOT, '..');
const MIRROR_PATH = join(ROOT, 'conf', 'skill-mirror.json');
const SOURCE_PATH = process.env.SLG_OFFICIAL_SKILL_JSON
  || join(REPO, 'skill-library-official-20261120.json');
const doc = JSON.parse(readFileSync(MIRROR_PATH, 'utf8'));
const round2 = (n) => Math.round(Number(n) * 100) / 100;

test('镜像规模与来源可追溯：至少 10 条，skip 台账完整', () => {
  assert.ok(doc.skills.length >= 10, `镜像条目过少（${doc.skills.length}）`);
  assert.ok(doc.skippedCount >= 50, '未命同名 / 内核不支持的条目必须留痕');
  assert.equal(doc.skipped.length, doc.skippedCount);
  assert.match(doc.sourceUrl, /^https:\/\//);
  assert.match(doc.sourceSha256, /^[0-9a-f]{64}$/);
  if (existsSync(SOURCE_PATH)) {
    const sha = createHash('sha256').update(readFileSync(SOURCE_PATH)).digest('hex');
    assert.equal(sha, doc.sourceSha256, '镜像来源与快照指纹不一致');
  }
});

test('每条镜像均已装载；cfgId / 名称 / 十级数值 / 内核完全同源', () => {
  /* ★ P53：一致性修正层是显式的、可审计的文案权威；仅对登记在案的条目豁免
     镜像原文前缀断言，其余镜像仍要求逐字同源，防止未授权改写。 */
  const fixDoc = JSON.parse(readFileSync(
    new URL('../conf/skill-consistency.json', import.meta.url), 'utf8'));
  const fixedDes = new Map((fixDoc.entries || []).filter((e) => e.des)
    .map((e) => [Number(e.cfgId), e.des]));
  for (const m of doc.skills) {
    const s = skillById(m.cfgId);
    assert.ok(s, `${m.cfgId} 镜像战法未进入运行时表`);
    assert.equal(s.name, m.name);
    /* 运行时会按射程规则追加「（有效距离 N · M 人）」，原文必须是其前缀。 */
    if (fixedDes.has(Number(m.cfgId))) {
      assert.equal(s.ui.des, fixedDes.get(Number(m.cfgId)), `${m.name} 应按 P53 修正层文案展示`);
    } else {
      assert.ok(s.ui.des.startsWith(m.ui.des), `${m.name} 描述被改写：${s.ui.des}`);
    }
    assert.equal(s.kernel.skill_class, m.kernel.skill_class);
    assert.deepEqual(s.ui.levels, m.ui.levels);
    /* 面板的 %n% 与 effect_value 必须逐个对齐，否则玩家看到 A、内核算 B。 */
    const slots = (m.ui.des.match(/%n%/g) || []).length;
    assert.equal(slots, m.ui.levels[0].effect_value.length, `${m.name} 描述占位符与效果槽不等`);
    const k = kernelSkillAt(m.cfgId, 10);
    assert.ok(k.effects.length === m.kernel.effects.length, `${m.name} 内核效果槽数量漂移`);
    assert.equal(k.probability_init * 100, m.ui.levels[0].probability);
    assert.equal(k.probability_max * 100, m.ui.levels[9].probability);
  }
});

test('十级数值严格线性插值，无随机跳档', () => {
  const num = (s) => String(s).match(/(\d+(?:\.\d+)?)%/g);
  for (const m of doc.skills) {
    const lv = m.ui.levels;
    const probRaw = String(m.provenance.mirror.officialProbability || '');
    const pp = probRaw.match(/(\d+(?:\.\d+)?)%(?:-(\d+(?:\.\d+)?)%)?/);
    const p1 = pp ? Number(pp[1]) : 100;
    const p10 = pp ? Number(pp[2] || pp[1]) : 100;
    assert.ok(pp || probRaw === '--', `${m.name} 缺官方发动率记录：${probRaw}`);
    assert.equal(m.kernel.skill_class === '指挥' || m.kernel.skill_class === '被动', !pp,
      `${m.name} 类别与发动率记录不匹配`);
    for (let i = 0; i < 10; i += 1) {
      assert.equal(lv[i].probability, round2(p1 + (p10 - p1) * i / 9), `${m.name} Lv${i + 1} 发动率漂移`);
    }
    const descPct = num(m.provenance.mirror.officialLv10) || [];
    const lv1Pct = num(m.provenance.mirror.officialLv1) || [];
    assert.equal(descPct.length, lv1Pct.length, `${m.name} 官方 Lv1/Lv10 百分比数量不等`);
    /* 纯控制型官方描述可以一个百分比都没有（触发即必中），此时占位符由镜像层补齐。 */
    const slots = (m.ui.des.match(/%n%/g) || []).length;
    assert.equal(slots, m.ui.levels[0].effect_value.length, `${m.name} 控制型描述槽位不齐`);
  }
});

test('未镜像条目保持原表：runtime 里没有镜像留痕', () => {
  const ids = new Set(doc.skills.map((s) => Number(s.cfgId)));
  const skipped = new Set(doc.skipped.map((s) => Number(s.cfgId)));
  assert.equal(ids.size, doc.skills.length, '镜像 cfgId 重复');
  for (const s of SKILLS) {
    if (!skipped.has(Number(s.cfgId))) continue;
    assert.ok(!s.provenance?.mirror, `${s.name} 在 skip 台账里却仍带镜像标记`);
  }
});

test('生成脚本可复跑：同一快照产出同一 JSON（写临时文件，不动出厂产物 mtime）', () => {
  const before = readFileSync(MIRROR_PATH, 'utf8');
  const out = join(tmpdir(), `slg-mirror-check-${process.pid}.json`);
  execFileSync(process.execPath, [join(ROOT, 'tools', 'mirror-official-skills.mjs')], {
    cwd: ROOT, env: { ...process.env, SLG_MIRROR_OUT: out }, stdio: 'ignore',
  });
  assert.equal(readFileSync(out, 'utf8'), before, '再次生成结果漂移');
  unlinkSync(out);
});
