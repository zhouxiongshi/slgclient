/**
 * M4-12 生效设施单一权威清单 —— 防退化验收。
 *
 * 玩家反馈：「左上角菜单上的内政和直接用鼠标点击城市的内政设施不一样，
 * 左上角的设施有些设施没用上，属于过度设施」。
 *
 * 结论：原版 26 项设施里只有 6 项进结算（木/铁/粮/石/金/府库容量），
 * 加上集市(15) 作为「府库资源兑换」门槛共 7 项生效；其余 19 项升级
 * 只扣资源、不产生任何效果。协议出口过滤 + 禁止升级 + 两处 UI 同源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { panelState } from '../server/domain/panels.js';
import {
  EFFECTIVE_ADDITIONS, GATE_FACILITIES, effectiveAxes, isActiveFacility,
  facilityEffectText, facilityView,
} from '../server/domain/facility-catalog.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const cfg = loadConfig();

const req = (name, msg = {}) => ({ seq: 1, name, msg });
function makeCtx(state) {
  return { state, cfg, options: {}, push() {}, save() {}, log() {} };
}
function world() {
  const state = createWorld(cfg);
  return { state, ctx: makeCtx(state) };
}

const ACTIVE_TYPES = [15, 17, 18, 19, 20, 21, 25];

test('catalog：26 项里只有 7 项生效（6 项结算 + 集市门槛），19 项属过度设施', () => {
  const list = cfg.facility.list;
  assert.equal(list.length, 26, '原版设施表逐字不动');
  const active = list.filter((f) => isActiveFacility(cfg, f)).map((f) => f.type).sort((a, b) => a - b);
  assert.deepEqual(active, ACTIVE_TYPES);
  const disabled = list.filter((f) => !isActiveFacility(cfg, f));
  assert.equal(disabled.length, 19);
  for (const f of disabled) {
    assert.equal(effectiveAxes(cfg, f).length, 0, `${f.name} 不该进任何结算轴`);
    assert.match(facilityEffectText(cfg, f), /未参与本版本结算/);
  }
});

test('catalog：效果说明与结算轴同源；集市不能漏掉（兑换门槛）', () => {
  assert.deepEqual(cfg.facilityAdditions(19), [19], '磨坊 → 粮');
  assert.equal(EFFECTIVE_ADDITIONS[19], 'grain');
  assert.match(facilityEffectText(cfg, { type: 19 }), /粮草产量/);
  assert.equal(GATE_FACILITIES['15'], '解锁府库资源兑换');
  assert.equal(isActiveFacility(cfg, { type: 15 }), true);
  assert.match(facilityEffectText(cfg, { type: 15 }), /解锁府库资源兑换/);
  assert.equal(isActiveFacility(cfg, { type: 1 }), false, '疾风营未生效');
});

test('city.facilities：只回 7 项生效设施，带效果说明与隐藏数量', () => {
  const { ctx } = world();
  const rsp = handleRequest(ctx, req('city.facilities', { cityId: 1 }));
  assert.equal(rsp.code, 0);
  const rows = rsp.msg.facilities || [];
  assert.deepEqual(rows.map((f) => f.type).sort((a, b) => a - b), ACTIVE_TYPES);
  assert.equal(rsp.msg.allCount, 26);
  assert.equal(rsp.msg.hiddenCount, 19);
  assert.equal(rsp.msg.legacy, false);
  for (const f of rows) {
    assert.equal(f.active, true);
    assert.ok(f.effectText && !/未参与本版本结算/.test(f.effectText), `${f.name} 要有实际作用说明`);
  }
});

test('city.upFacility：过度设施拒绝升级（不再扣资源），生效设施与集市仍可升', () => {
  const { state, ctx } = world();
  const before = { ...state.roleRes };
  const denied = handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 1 }));
  assert.notEqual(denied.code, 0);
  assert.equal(denied.msg.reason, 'facility_disabled');
  assert.equal(state.roleRes.wood, before.wood, '被拒的升级不许扣资源');

  const ok = handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 19 }));
  assert.equal(ok.code, 0, '磨坊仍可升级');
  const market = handleRequest(ctx, req('city.upFacility', { cityId: 1, fType: 15 }));
  assert.equal(market.code, 0, '集市仍可升级（兑换门槛）');
});

test('panelState：六府·内政的设施与协议同源（两处入口一致）', () => {
  const { state, ctx } = world();
  const proto = handleRequest(ctx, req('city.facilities', { cityId: 1 }));
  const panel = panelState(state, cfg).interior.facilities;
  assert.equal(panel.allCount, 26);
  assert.equal(panel.hiddenCount, 19);
  assert.deepEqual(panel.rows.map((f) => f.name), proto.msg.facilities.map((f) => f.name));
  assert.deepEqual(panel.rows.map((f) => f.effectText), proto.msg.facilities.map((f) => f.effectText));
});

test('GM 回退：SLG_LEGACY_FACILITIES=1 可取回全量 26 项做对照（逐项带 active）', () => {
  const list = cfg.facility.list.map((f) => ({ ...f, level: 0 }));
  const normal = facilityView(cfg, list, { legacy: false });
  assert.equal(normal.rows.length, 7);
  const legacy = facilityView(cfg, list, { legacy: true });
  assert.equal(legacy.rows.length, 26);
  assert.equal(legacy.hiddenCount, 0);
  assert.equal(legacy.rows.filter((f) => f.active).length, 7);
  assert.equal(legacy.rows.filter((f) => !f.active).length, 19);
});

test('静态闸：结算与显示共用同一张判据表，两处设施 UI 都有同源说明', () => {
  const handlers = read('server/handlers.js');
  assert.match(handlers, /EFFECTIVE_ADDITIONS\[aType\]/, '结算层不许再硬编码 17/18/19/20/21/23 分支');
  assert.match(handlers, /facilityView\(cfg, rawFacilities\)/, '协议出口统一走 catalog');
  assert.match(handlers, /facility_disabled/, '升级拦截');
  const skills = read('server/skills.js');
  assert.match(skills, /hiddenCount/, '城池内页设施卡写明隐藏数量');
  assert.match(skills, /effectText/, '设施卡显示实际作用');
  const panelsUi = read('server/panels-ui.js');
  assert.match(panelsUi, /生效设施（与城池内页同源）/);
  assert.match(panelsUi, /it\.facilities/, '六府内政读同源数据');
  const panels = read('server/domain/panels.js');
  assert.match(panels, /facilityView\(cfg, list, \{ legacy: false \}\)/);
});
