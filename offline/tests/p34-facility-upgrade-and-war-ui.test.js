/**
 * P34 · 设施升级死锁 / 工期单位 / 遭遇对阵对齐
 *
 * 实机反馈 2026-11-22：集市、伐木场等所有设施升级都报错，且升级后工期显示秒。
 * 根因：原始 facility_*.json 给每种设施统一配「木铁石粮各 lv×1000」，全局粮池
 * 被驻军吃空后连「建集市→兑换粮食」自救链都点不动；UI 直接把原始 time 当秒显示。
 * 本测试钉住派生成本去粮、工期按游戏日、拒绝原因中文，以及遭遇/推演双方左右对齐。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';

const cfg = loadConfig();
const SKILLS = readFileSync(new URL('../server/skills.js', import.meta.url), 'utf8');
const HANDLERS = readFileSync(new URL('../server/handlers.js', import.meta.url), 'utf8');
const CONFIG = readFileSync(new URL('../server/config.js', import.meta.url), 'utf8');
const req = (name, msg = {}) => ({ seq: 1, name, msg });
const ctxOf = (state) => ({ state, cfg, options: {}, pushes: [], push() {}, save() {}, log() {} });
const tick = (ctx) => handleRequest(ctx, req('role.myRoleRes'));

test('P34·派生成本去粮但原表逐字不动：粮池为 0 也能升级集市/伐木场', () => {
  const raw = cfg.facilityNeed(15, 1);
  assert.equal(raw.grain, 1000, '原始配置表不许改');
  const need = cfg.facilityUpgradeNeed(15, 1);
  assert.equal(need.grain, undefined, '派生成本不吃粮');
  assert.equal(need.wood, raw.wood);
  assert.equal(need.iron, raw.iron);
  assert.equal(need.stone, raw.stone);

  const state = createWorld(cfg);
  const ctx = ctxOf(state);
  state.roleRes.grain = 0;
  const before = { ...state.roleRes };
  for (const fType of [15, 17]) {
    const r = handleRequest(ctx, req('city.upFacility', { cityId: 1, fType }));
    assert.equal(r.code, 0, `粮池见底时 ${fType} 应可升级: ${r.reason || ''}`);
  }
  assert.equal(state.roleRes.grain, 0, '升级不扣粮');
  assert.equal(state.roleRes.wood, before.wood - 2 * need.wood);
  assert.equal(state.roleRes.iron, before.iron - 2 * need.iron);
  assert.equal(state.roleRes.stone, before.stone - 2 * need.stone);
});

test('P34·设施工期按游戏日完成，不是真实秒', () => {
  const state = createWorld(cfg);
  const ctx = ctxOf(state);
  const r = handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 19 }));
  assert.equal(r.code, 0);
  const f = state.facilities[1].find((x) => x.type === 19);
  assert.equal(f.up_day, state.clock.day, '开工日记游戏日');
  const days = cfg.facilityUpgradeDays(19, 1);
  assert.equal(days, 10);

  state.clock.day += days - 1;
  tick(ctx);
  assert.equal(f.level, 0, '差 1 日不得提前完成');
  const view = handleRequest(ctx, req('city.facilities', { cityId: 1, realCityId: 1 })).msg.facilities
    .find((x) => x.type === 19);
  assert.equal(view.nextDays, days, '下发游戏日工期');
  assert.equal(view.upgradeRemainDays, 1, '剩余也是游戏日');

  state.clock.day += 1;
  tick(ctx);
  assert.equal(f.level, 1, '满工期才升级');
  assert.equal(f.up_time, 0);
  assert.equal(f.up_day, 0);
});

test('P34·老存档秒级 up_time 只迁移起点，不会瞬间跳级', () => {
  const state = createWorld(cfg);
  const ctx = ctxOf(state);
  const f = state.facilities[1].find((x) => x.type === 19);
  f.up_time = Math.floor(Date.now() / 1000) - 3600;
  tick(ctx);
  assert.equal(f.up_day, state.clock.day, '老进度从当前游戏日续算');
  assert.equal(f.level, 0, '迁移不得直接送一级');
});

test('P34·拒绝原因中文降级，工期展示不再出现秒', () => {
  assert.match(CONFIG, /facilityUpgradeNeed/);
  assert.match(CONFIG, /delete need\.grain/);
  assert.match(HANDLERS, /nextNeed: cfg\.facilityUpgradeNeed/);
  assert.match(HANDLERS, /f\.up_day = Number\(state\.clock\?\.day\)/);
  assert.match(HANDLERS, /upgradeRemainDays: p\.remain/);
  assert.match(SKILLS, /function dayText\(n\)/);
  assert.match(SKILLS, /工期 ' \+ dayText\(f\.nextDays\)/);
  assert.ok(!/工期 ' \+ f\.nextTime \+ 's/.test(SKILLS), '旧秒级工期文案不得回退');
  assert.match(SKILLS, /res_not_enough: '资源不足'/);
  assert.ok(!/if \(reason\) return String\(rsp\.msg\.reason\)/.test(SKILLS), '英文 reason 不得直出');
});

test('P34·遭遇与推演界面双方左右等宽对齐', () => {
  assert.match(SKILLS, /#slgUIv2 \.war-faceoff\{display:grid;grid-template-columns:1fr 1fr/);
  assert.match(SKILLS, /#slgUIv2 \.war-side\.mine/);
  assert.match(SKILLS, /#slgUIv2 \.war-side\.theirs/);
  assert.match(SKILLS, /@media \(max-width:760px\)\{[^}]*#slgUIv2 \.war-faceoff\{grid-template-columns:1fr\}/);
  const encounter = SKILLS.slice(SKILLS.indexOf('function warEncounterPanel'), SKILLS.indexOf('function warDigestPanel'));
  const preview = SKILLS.slice(SKILLS.indexOf('function warPreviewHtml'), SKILLS.indexOf('function warConfirmAttack'));
  assert.match(encounter, /warSideHtml\('a', '我军'/);
  assert.match(encounter, /warSideHtml\('d', '守军约'/);
  assert.doesNotMatch(encounter, /kv\('我军'/);
  assert.doesNotMatch(encounter, /kv\('守军约'/);
  assert.match(preview, /warSideHtml\('a', '我军 · 投入 \/ 折损'/);
  assert.match(preview, /warSideHtml\('d', '守军 · 城防 \/ 歼敌'/);
});
