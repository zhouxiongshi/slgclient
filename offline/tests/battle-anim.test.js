/**
 * 战斗动画脚本：内核事件流 → 可播放的演出脚本（随战报推送）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildBattleAnim } from '../server/battle.js';
import { loadConfig } from '../server/config.js';
import { createSkillAssets } from '../server/skills.js';

const ROOT = resolve(import.meta.dirname, '..');
const cfg = loadConfig();

function fakeKernel() {
  return {
    rounds: 2,
    winner: 1,
    final_troops: { a0: 600, d0: 300, d1: 0, d2: 200 },
    total_troops_by_side: { '1': 600, '2': 500 },
    events: [
      { round: 1, actor: 'a0', kind: 'skill_trigger', payload: { skill: '衔枚断后' } },
      { round: 1, actor: 'a0', kind: 'damage', payload: { skill: '衔枚断后', target: 'd0', applied: 2500 } },
      { round: 1, actor: 'a0', kind: 'damage', payload: { skill: '普通攻击', target: 'd1', applied: 1200 } },
      { round: 1, actor: 'd0', kind: 'control', payload: { target: 'a0', state: '犹豫' } },
      { round: 2, actor: 'a0', kind: 'heal', payload: { target: 'a0', amount: 200, applied: 200 } },
      { round: 2, actor: 'a0', kind: 'unit_down', payload: { unit: 'd1' } },
    ],
  };
}

function fakeState() {
  return {
    role: { nickName: '主公' },
    garrisons: [{ x: 3, y: 4, name: '黄巾游骑', cleared: false }],
    battleLog: [],
  };
}

test('动画脚本：回合分组、技能伤害合计、控制/治疗/倒下齐全', () => {
  const anim = buildBattleAnim({
    kernel: fakeKernel(),
    attackers: [{ slot: 0, g: { cfgId: 880001 } }],
    defense: { generals: [{ cfgId: 100002 }, { cfgId: 100003 }, { cfgId: 100004 }], soldiers: [1000, 1000, 1000] },
    army: { soldiers: [800, 0, 0] },
    beginSoldiers: [800, 0, 0],
    state: fakeState(),
    cfg, x: 3, y: 4, resultCode: 2,
    attackRemain: [800, 0, 0], defenseRemain: [500, 0, 300],
  });
  assert.equal(anim.winner, 2);
  assert.equal(anim.a.units[0].name, '主公');
  assert.equal(anim.d.name, '黄巾游骑');
  assert.equal(anim.rounds.length, 2);
  const r1 = anim.rounds[0];
  const skill = r1.acts.find((a) => a.t === 'skill');
  assert.ok(skill, '应有战法动作');
  assert.equal(skill.loss, 2500, '战法伤害 = 同回合同战法伤害合计');
  assert.ok(r1.acts.some((a) => a.t === 'hit' && a.skill === '普通攻击'));
  assert.ok(r1.acts.some((a) => a.t === 'control' && a.state === '犹豫'));
  const r2 = anim.rounds[1];
  assert.ok(r2.acts.some((a) => a.t === 'heal' && a.amount > 0));
  assert.ok(r2.acts.some((a) => a.t === 'down'));
});

test('客户端注入含播放器挂钩与回放入口', () => {
  const web = resolve(ROOT, 'web');
  if (!existsSync(resolve(web, 'index.html'))) return;
  const assets = createSkillAssets(web);
  const js = assets.intercept('/assets/main/index.js').body;
  assert.ok(js.includes('__slgPlayBattle'));
  assert.ok(js.includes('onWarReportAnim'));
  assert.ok(js.includes('warReport.push'));
  assert.ok(js.includes('__slgOpenWarReport'));
});

test('图本随包携带（打包目录里有 2400×1350 全景）', () => {
  const p = resolve(ROOT, 'conf', 'campaign', 'strategy', 'map-panorama.png');
  assert.ok(existsSync(p), '缺少 map-panorama.png');
  const b = readFileSync(p);
  assert.equal(b.readUInt32BE(16), 2400);
  assert.equal(b.readUInt32BE(20), 1350);
});
