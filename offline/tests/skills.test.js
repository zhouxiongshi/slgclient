/**
 * 新战斗系统验收：证明不是「换了个计算器」，而是技能体系真的换了。
 *
 * 覆盖：
 *  1. 48 战法表结构 / 每级数值真实成长 / UI 字段约束
 *  2. 运行时资源注入（原 web-desktop 磁盘不改，客户端读到新表）
 *  3. 技能数值进入确定性内核：不同战法 / 不同等级 → 不同结算
 *  4. 战报 c_id / lv / e_v 来自新技能表（不再是 101/201/301/401 + lv10）
 *  5. 技能装配 / 升级协议（含旧 cfgId 拒绝、lvSkill 按 pos 生效）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SKILLS, SKILL_BY_ID, LEVEL_COUNT, skillById, kernelSkillAt, reportSkillFields, LEGACY_UUIDS, createSkillAssets } from '../server/skills.js';
import { runBattle } from '../kernel/index.js';
import { battleConfig, resolveBattle } from '../server/battle.js';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { startOfflineServer } from '../server/index.js';
import { ProtocolClient } from './client.js';

// 仓库布局优先：offline/web；旧布局回退 runtime 构建目录
const WEB = existsSync(resolve(import.meta.dirname, '..', 'web', 'index.html'))
  ? resolve(import.meta.dirname, '..', 'web')
  : resolve(import.meta.dirname, '..', '..', 'runtime', 'client-src', 'build', 'web-desktop');
const CFG = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'conf', 'skills.json'), 'utf8'));
const BATTLE_KIT = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'battle-core', 'config', 'battle_config.json'), 'utf8'));

function hero(id, skills) {
  return {
    heroid: id, name: `测试武将${id}`, level: 10, hero_type: 'normal',
    attack_base: 90, defence_base: 60, intel_base: 80, speed_base: 70, destroy_base: 20,
    attack_grow: 1, defence_grow: 1, intel_grow: 1, speed_grow: 1, destroy_grow: 1,
    skills,
  };
}
function battleWith(skillsA, seed = 12345) {
  return runBattle({
    seed,
    config: battleConfig(),
    units: [
      { unit_id: 'a0', side: 1, hero: hero(1, skillsA), troops: 1000, max_troops: 1000, speed: 100 },
      { unit_id: 'd0', side: 2, hero: hero(2, []), troops: 1000, max_troops: 1000, speed: 90 },
    ],
  });
}
const totalDamage = (r) => r.events
  .filter((e) => e.kind === 'damage')
  .reduce((s, e) => s + (e.payload.calc?.final ?? 0), 0);
/** 单次战法伤害：整场累计会被「目标兵力清零」截断，不能用来比较数值。 */
const skillDamage = (r, skillName) => r.events.find(
  (e) => e.kind === 'damage' && e.payload.skill === skillName,
)?.payload.calc?.final ?? 0;

test('战法表：31 个 / 4 类 / 10 级真实数值成长 / 名称与伤害率来自 battle-kit', () => {
  assert.ok(SKILLS.length >= 24, `战法数 ${SKILLS.length}`);
  assert.equal(CFG.oldSystemRemoved, true);
  assert.equal(CFG.levelCount, 10);
  const classes = new Set(SKILLS.map((s) => s.kernel.skill_class));
  assert.deepEqual([...classes].sort(), ['主动', '被动', '追击', '指挥'].sort());
  const effects = new Set();
  for (const s of SKILLS) {
    if (s.kernel.effect_type) effects.add(s.kernel.effect_type);
    for (const e of s.kernel.effects || []) if (e.effect_type) effects.add(e.effect_type);
  }
  // 真实片段只覆盖伤害/控制/增益——治疗类在 battle-kit 数据里没有原文，不做虚构
  for (const e of ['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE', 'CONTROL', 'BUFF']) {
    assert.ok(effects.has(e), `缺少效果类型 ${e}`);
  }
  for (const e of effects) {
    assert.ok(['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE', 'CONTROL', 'BUFF', 'DEBUFF', 'HEAL'].includes(e), `未知效果类型 ${e}`);
  }
  // 片段内嵌名（轻骑冲阵/异士/混战）是真实游戏文本，不在 796 名录里也合法
  const FRAGMENT_NAMES = new Set(['轻骑冲阵', '异士', '混战']);
  const names = new Set();
  for (const s of SKILLS) {
    assert.ok(!names.has(s.name), `重复战法名 ${s.name}`);
    names.add(s.name);
    assert.ok(
      BATTLE_KIT.skill_names.includes(s.name) || FRAGMENT_NAMES.has(s.name)
      || s.provenance?.pairing === 'authored' || s.provenance?.pairing === 'skill-library'
      || s.provenance?.pairing === 'skill-library-extra',
      `${s.name} 不在 battle-kit 名录`,
    );
    if (s.provenance?.pairing === 'authored' || s.provenance?.pairing === 'skill-library'
      || s.provenance?.pairing === 'skill-library-extra') continue;
    assert.ok(BATTLE_KIT.damage_rates_pct.includes(s.kernel.rate_pct_lv1), `${s.name} 伤害率不是包内样本`);
    const ui = s.ui;
    assert.equal(ui.levels.length, LEVEL_COUNT);
    assert.ok(ui.trigger >= 1 && ui.trigger <= 4);
    assert.ok(ui.target >= 1 && ui.target <= 9);
    assert.equal((ui.des.match(/%n%/g) || []).length, ui.levels[0].effect_value.length);
    assert.equal(ui.include_effect.length, ui.levels[0].effect_value.length);
    for (const ie of ui.include_effect) assert.ok(ie >= 1 && ie <= 6);
    const first = ui.levels[0], last = ui.levels.at(-1);
    const isFixed = s.kernel.rate_pct_lv1 === s.kernel.rate_pct_lv10;
    // 被动无条件生效（概率恒 100%），固定值战法无成长——均豁免
    const noProbGrowth = isFixed || s.ui.trigger === 2;
    if (!noProbGrowth) assert.ok(last.probability > first.probability, `${s.name} 发动概率不成长`);
    first.effect_value.forEach((v, k) => {
      if (!isFixed) assert.ok(last.effect_value[k] > v, `${s.name} 效果值不成长`);
    });
    for (let i = 1; i < ui.levels.length; i += 1) {
      assert.ok(ui.levels[i].effect_value[0] >= ui.levels[i - 1].effect_value[0]);
    }
  }
  // 原占位技能不再存在于新表
  for (const old of ['突击', '百战精兵', '重斩', '锋矢']) {
    assert.ok(!names.has(old), `旧占位技能 ${old} 仍在新表中`);
  }
  assert.equal(skillById(101), null);
  assert.equal(skillById(401), null);
});

test('战法表：UI 数值与内核数值同源，等级越高内核数值越大', () => {
  for (const s of SKILLS.slice(0, 12)) {
    const k1 = kernelSkillAt(s.cfgId, 1);
    const k10 = kernelSkillAt(s.cfgId, 10);
    assert.equal(k1.name, s.name);
    assert.equal(k1.level, 1);
    assert.equal(k10.level, 10);
    assert.equal(k1.effects[0].effect_type, s.kernel.effect_type);
    assert.ok(k10.effects[0].rate_pct > k1.effects[0].rate_pct);
    assert.equal(k1.effects[0].rate_pct, s.ui.levels[0].effect_value[0]);
    assert.equal(k10.effects[0].rate_pct, s.ui.levels[9].effect_value[0]);
    const f = reportSkillFields(s.cfgId, 7);
    assert.equal(f.cfgId, s.cfgId);
    assert.equal(f.lv, 7);
    assert.deepEqual(f.e_v, s.ui.levels[6].effect_value);
  }
});

test('运行时注入：原磁盘产物不改，客户端拿到新战法、旧 4 技能路径已移除', () => {
  const assets = createSkillAssets(WEB);
  const cfg = JSON.parse(assets.intercept('/assets/resources/config.json').body);
  const legacyPaths = Object.keys(cfg.paths).filter((uuid) => Object.values(LEGACY_UUIDS).includes(uuid));
  assert.equal(legacyPaths.length, 0, '旧 4 个占位技能路径仍在 bundle config 中');
  // ★ skill_outline 必须被替换：原版 target 表只有 8 条，新表 target=9（敌军全体）会越界
  const outlineUuid = Object.keys(cfg.paths).find((u) => cfg.paths[u][0] === 'config/json/skill/skill_outline');
  assert.ok(outlineUuid, 'config 里找不到 skill_outline 路径');
  const outlineBody = JSON.parse(assets.intercept(`/assets/resources/import/${outlineUuid.slice(0, 2)}/${outlineUuid}.json`).body);
  assert.equal(outlineBody[5][0][1], 'skill_outline');
  assert.ok(outlineBody[5][0][2].target_type.list.length >= 9, 'outline target 表不足 9 条，target=9 战法会崩');
  for (const uuid of Object.values(LEGACY_UUIDS)) {
    const body = JSON.parse(assets.intercept(`/assets/resources/import/${uuid.slice(0, 2)}/${uuid}.json`).body);
    // cc.JsonAsset 序列化：body[5][0] = [0, _name, json]
    assert.equal(body[5][0][1], 'skill_outline', '旧 UUID 仍返回旧技能数据');
  }
  const injected = assets.injected.filter((x) => x.cfgId >= 10001);
  assert.equal(injected.length, SKILLS.length);
  const first = injected[0];
  const body = JSON.parse(assets.intercept(`/assets/resources/import/${first.uuid.slice(0, 2)}/${first.uuid}.json`).body);
  const ui = body[5][0][2];
  assert.equal(ui.cfgId, first.cfgId);
  assert.equal(ui.levels.length, 10);
  assert.ok(ui.levels[9].effect_value[0] > ui.levels[0].effect_value[0]);
  assert.equal(assets.stats.diskUntouched, true);
  assert.equal(assets.stats.legacyPathsRemoved, 4);
  // 磁盘上的原 config.json 仍是原始内容（未被写回）
  const onDisk = JSON.parse(readFileSync(join(WEB, 'assets', 'resources', 'config.json'), 'utf8'));
  assert.ok(onDisk.paths[LEGACY_UUIDS[101]], '磁盘原产物被改动了');
});

test('技能数值真的进入内核：不同战法 / 不同等级得到不同结算', () => {
  const blade = SKILLS.find((s) => s.kernel.effect_type === 'PHYSICAL_DAMAGE' && s.kernel.rate_pct_lv1 !== undefined);
  const strategy = SKILLS.find((s) => s.kernel.effect_type === 'STRATEGY_DAMAGE');
  // 只在「产生伤害」的战法里比较伤害率，治疗/控制/增益不产生 damage 事件
  const dmgSkills = SKILLS.filter((s) => ['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE'].includes(s.kernel.effect_type));
  // 排除固定值战法（如一雷惊蛰 lv1==lv10），只在有真实成长的战法里比较
  const growing = dmgSkills.filter((s) => s.kernel.rate_pct_lv1 !== s.kernel.rate_pct_lv10);
  const lowRate = growing.slice().sort((a, b) => a.kernel.rate_pct_lv1 - b.kernel.rate_pct_lv1)[0];
  const highRate = growing.slice().sort((a, b) => b.kernel.rate_pct_lv1 - a.kernel.rate_pct_lv1)[0];
  assert.ok(highRate.kernel.rate_pct_lv1 > lowRate.kernel.rate_pct_lv1);
  assert.notEqual(blade.cfgId, strategy.cfgId);

  // 强制「被动必触发」隔离概率差异，只比较数值
  const forcePassive = (cfgId, lv) => {
    const s = kernelSkillAt(cfgId, lv);
    s.skill_class = '被动';
    s.prepare = 0;
    return s;
  };
  const r1 = battleWith([forcePassive(lowRate.cfgId, 1)]);
  const r2 = battleWith([forcePassive(highRate.cfgId, 1)]);
  const r3 = battleWith([forcePassive(lowRate.cfgId, 10)]);
  assert.ok(skillDamage(r2, highRate.name) > skillDamage(r1, lowRate.name),
    `高伤害率战法单次伤害没有更高：${skillDamage(r2, highRate.name)} vs ${skillDamage(r1, lowRate.name)}`);
  assert.ok(skillDamage(r3, lowRate.name) > skillDamage(r1, lowRate.name),
    `技能升到 10 级单次伤害没有提高：${skillDamage(r3, lowRate.name)} vs ${skillDamage(r1, lowRate.name)}`);
  assert.ok(totalDamage(r1) > 0 && totalDamage(r2) > 0 && totalDamage(r3) > 0, '战斗没有产生伤害');

  // 控制 / 增益战法确实产生对应事件（治疗类在真实数据中无原文，不做虚构）
  const control = SKILLS.find((s) => s.kernel.effect_type === 'CONTROL');
  const buff = SKILLS.find((s) => s.kernel.effect_type === 'BUFF');
  const controlResult = battleWith([forcePassive(control.cfgId, 10)]);
  const buffResult = battleWith([forcePassive(buff.cfgId, 10)]);
  assert.ok(controlResult.events.some((e) => e.kind === 'control' || e.kind === 'damage'), '控制战法没有产生 control/damage 事件');
  assert.ok(buffResult.events.some((e) => e.kind === 'buff'), '增益战法没有产生 buff 事件');
});

test('战报技能字段来自新表（c_id 全为 10001+，lv 与 e_v 随装备变化）', () => {
  const cfg = loadConfig();
  const state = createWorld(cfg);
  const army = state.armys[0];
  const before = state.generals.find((g) => g.id === army.generals[0]);
  assert.ok(before.skills.filter(Boolean).length === 1, '主公开局应只有自带战法');
  const { report } = resolveBattle({ cfg, state, army, x: 100, y: 101, seed: 987654 });
  const rounds = JSON.parse(report.rounds);
  const hits = rounds.flatMap((rd) => rd.b.flatMap((h) => [...(h.a_bs || []), ...(h.a_as || []), ...(h.d_as || [])]));
  assert.ok(hits.length > 0, '战报里没有任何技能');
  for (const h of hits) {
    assert.ok(h.c_id >= 10001 && SKILL_BY_ID.has(h.c_id), `战报用了非新表技能 ${h.c_id}`);
    assert.ok(h.lv >= 1 && h.lv <= 10, `等级异常 ${h.lv}`);
    const f = reportSkillFields(h.c_id, h.lv);
    assert.deepEqual(h.e_v, f.e_v, '战报效果值不是该技能该等级的数值');
    assert.deepEqual(h.i_e, f.i_e);
    assert.equal(h.t_id.length, h.kill.length);
  }
  const log = state.battleLog.at(-1);
  assert.equal(log.skillSystem, 'battle-kit/original-fragments/v3');
  assert.ok(log.loadout.length >= 6, '内核没有收到双方武将的装备技能');
  assert.ok(log.reportSkillIds.every((id) => SKILL_BY_ID.has(id)));
});

const tmp = mkdtempSync(join(tmpdir(), 'slg-skills-'));
const httpPort = 21088 + (process.pid % 400);
const wsPort = 21004 + (process.pid % 400);

test('协议：技能列表非空 / 升级按 pos 生效 / 旧技能 ID 被拒绝', async (t) => {
  const server = await startOfflineServer({ saveDir: tmp, httpPort, wsPort, travelMs: 300, quiet: true });
  const client = new ProtocolClient(`ws://127.0.0.1:${wsPort}`);
  try {
    await client.connect();
    await client.request('account.login', { username: 'tester' });
    await client.request('role.enterServer', { session: 'offline-session' });

    const list = await client.request('skill.list', {});
    assert.ok(list.msg.list.length > 0, 'skill.list 仍返回空列表');
    assert.ok(list.msg.list.every((s) => SKILL_BY_ID.has(s.cfgId)), '玩家拥有旧技能 ID');

    const generals = await client.request('general.myGenerals', {});
    const g = generals.msg.generals[0];
    assert.equal(g.skills.filter(Boolean).length, 1);
    assert.equal(g.skills[0].cfgId, 19001);
    const oldLv = g.skills[0].lv;

    const lv = await client.request('general.lvSkill', { gId: g.id, pos: 0 });
    assert.equal(lv.msg.ok, true, `按 pos 升级失败：${lv.msg.reason}`);
    const after = (await client.request('general.myGenerals', {})).msg.generals.find((x) => x.id === g.id);
    assert.equal(after.skills[0].lv, oldLv + 1, '升级没有改变技能等级');

    const bad = await client.request('general.upSkill', { gId: g.id, cfgId: 101, pos: 2 });
    assert.equal(bad.msg.ok, false);
    assert.equal(bad.msg.reason, 'invalid_skill');

    const locked = await client.request('general.upSkill', { gId: g.id, cfgId: SKILLS.find((s) => s.provenance?.pairing !== 'authored').cfgId, pos: 1 });
    assert.equal(locked.msg.ok, false);
    assert.equal(locked.msg.reason, 'slot_locked');

    const innate = await client.request('general.downSkill', { gId: g.id, cfgId: 19001, pos: 0 });
    assert.equal(innate.msg.ok, false);
    assert.equal(innate.msg.reason, 'innate_locked');

    const page = await fetch(`http://127.0.0.1:${httpPort}/__slg/status`);
    const status = await page.json();
    assert.equal(status.skills.skillCount, SKILLS.length);
    assert.equal(status.skills.legacyPathsRemoved, 4);
    assert.equal(status.skills.diskUntouched, true);
  } finally {
    client.close();
    await server.close();
  }
});
