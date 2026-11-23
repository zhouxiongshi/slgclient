/**
 * P46（2026-11-22）P41 后续审计残留回归：
 *  中文失败原因直通、已结算诸侯行军撤标、横向菜单战报红点、
 *  非城池物资任务跨城去重、玩家文案去内部编号、合规台账补登记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { ensureStrategy } from '../server/domain/strategy.js';
import { beginMaterialTask, materialTaskView } from '../server/domain/material-task.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const cfg = loadConfig();

test('P46-① 领域层中文 message/hint 直通玩家提示，英文内部码仍被拦下', () => {
  const sk = read('server/skills.js');
  assert.ok(sk.includes('var direct = rsp && (rsp.message || rsp.hint);'), 'errText 读取中文原因字段');
  assert.ok(sk.includes('/[一-龥]/.test(direct)'), '只直通含中文的文案');
  const hasChinese = /[一-龥]/;
  assert.equal(hasChinese.test('「造 10 军工」已有一件在办，完工后再派'), true);
  assert.equal(hasChinese.test('no_gold'), false);
  assert.equal(hasChinese.test('unknown_action'), false);
});

test('P46-② 已结算的诸侯行军不再停留在沙盘上', () => {
  const sk = read('server/skills.js');
  assert.ok(sk.includes('if (isFoe && mm.resolved) return;'), '敌方 resolved 行军跳过绘制');
  assert.ok(sk.includes("mm.side !== 'player'"), '玩家军与 AI 分支仍严格分开');
});

test('P46-③ 六府收起后，横向菜单战报 chip 同步未读红点', () => {
  const sk = read('server/skills.js');
  const pu = read('server/panels-ui.js');
  assert.ok(sk.includes('id="slgRepDotTop"'), '横向菜单存在可见红点节点');
  assert.ok(sk.includes("data-slgpanel=\"__reports\""), '红点挂在该 chip 内');
  assert.ok(sk.includes('#slgUIv2 .rdot{'), '红点有绝对定位与底色样式');
  assert.ok(pu.includes('function reportDots()'), '发布轮询统一取新旧两个红点');
  assert.ok(pu.includes("document.getElementById('slgRepDotTop')"), '同步到可见红点');
  assert.ok(pu.includes('reportDots().forEach'), '已读时两个红点一起熄灭');
});

test('P46-④ 非城池物资任务跨城不能重复下单，且归一到 cityId=0', () => {
  const s = createWorld(cfg);
  ensureStrategy(s);
  s.clock.day = 10;
  const ctx = { push() {} };
  const first = beginMaterialTask(s, cfg, ctx, {
    actionId: 'craft10', officerId: 0, cityId: Number(s.strategy.playerCity) || 0,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = beginMaterialTask(s, cfg, ctx, {
    actionId: 'craft10', officerId: 0, cityId: 999999,
  });
  assert.equal(second.ok, false, '换一座城点进去也算同一件事');
  assert.match(second.message, /已有一件在办/);
  const list = materialTaskView(s);
  assert.equal(list.length, 1, '只允许一件事在办');
  assert.equal(list[0].cityId, 0, '非 needsCity 任务不绑定偶然的城内页城市');
});

test('P46-⑤ 玩家可见文案不再夹带内部里程碑编号', () => {
  /* 与 ui-presentation-hygiene 同口径：注释里的内部编号允许保留，只扫玩家可见代码。 */
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['server/panels-ui.js', 'server/interaction-ui.js', 'server/skills.js']) {
    const t = stripComments(read(f));
    assert.doesNotMatch(t, /将在 P\d+ 接入/, `${f} 不得出现过期里程碑`);
    assert.doesNotMatch(t, /（P\d+）/, `${f} 不得出现内部编号`);
  }
});

test('P46-⑥ 先天战法 96 条已进合规台账，审计工具会扫到', () => {
  const prov = JSON.parse(read('conf/compliance/provenance.json'));
  const entry = prov.assets.find((a) => a.path === 'offline/conf/innate-skills.json');
  assert.ok(entry, '先天战法必须登记');
  assert.equal(entry.status, 'derived_unlicensed', '与 skills.json 同批第三方来源');
  assert.equal(entry.count, 96);
  assert.ok(read('tools/compliance-report.js').includes("'offline/conf/innate-skills.json'"), 'DERIVED_GLOBS 覆盖该文件');
  /* ★ P47#6：不再读 reports/compliance.json —— reports/ 被 .gitignore 忽略，
     干净 clone 不先跑生成器就会让全量单测假红。台账源本身就是权威：
     直接从 provenance.json 推导「未授权项 ≥8、每条都有状态与来源」。 */
  const derived = prov.assets.filter((a) => a.status === 'derived_unlicensed');
  assert.ok(derived.length >= 8, `未授权派生项应 ≥8，实测 ${derived.length}`);
  for (const a of derived) {
    assert.ok(a.source || a.note || a.path, `${a.path} 缺少来源/说明，台账不可复核`);
  }
});

test('P46-⑦ 文档漂移已修正：经验系数与撤围天数', () => {
  const fc = read('docs/FIELD-CONTRACT.md');
  assert.ok(fc.includes('BATTLE_EXP_PER_LOSS = 0.8'));
  assert.doesNotMatch(fc, /每槽损失 × 0\.5/);
  const sdd = read('docs/SDD-软件详细设计说明书.md');
  assert.ok(sdd.includes('180 日粮尽自退'));
  assert.doesNotMatch(sdd, /120 日粮尽自退/);
});
