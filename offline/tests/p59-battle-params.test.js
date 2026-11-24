/**
 * P59（2026-11-25）战斗参数回归：
 *  玩家反馈「攻打邯郸战报 9 我方 3 人、属性更高、出手次数更多却输」。
 *  复盘发现三处参数把「3 打 1」变成「挨打」：
 *   ① 兵力系数按单槽兵力算：3×740 各得 0.958，1×3515 得 2.257 → 单次伤害差 17 倍；
 *   ② 普攻伤害率按 unit_id 从 83 条战法样本里哈希取一个（7%~150%，永久固定），
 *      同一队里一人 130%、一人 18.89%（每次只掉 2 兵）；
 *   ③ 同名镜像层把单体战法「一骑当千」整体替换成官方「1 回合准备 + 敌军全体」，
 *      守军一回合打我三名武将。
 *  本文件锁死这三条口径，防止回退。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { battleConfig, troopStrikeMul, resolveBattle } from '../server/battle.js';
import { kernelSkillAt } from '../server/skills.js';
import { makeHero } from '../server/battle.js';

const cfg = loadConfig();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fresh = () => normalizeWorld(createWorld(cfg), cfg);

test('P59-① 兵力系数按「该侧总兵力」算：同样 2220 兵，拆三队不再受罚', () => {
  const src = read('server/battle.js');
  assert.match(src, /const atkStrike = troopStrikeMul\(atkHead\)/, '攻方必须用侧总兵力');
  assert.match(src, /const defStrike = troopStrikeMul\(defHead\)/, '守方必须用侧总兵力');
  assert.ok(!src.includes('troopStrikeMul(beginSoldiers[slot])'), '不得再按单槽兵力算系数');
  /* 系数本身仍按绝对兵力给：添兵有用是设计意图，只是不再惩罚分兵。 */
  assert.ok(troopStrikeMul(2220) > troopStrikeMul(740), '总兵力越多系数越高');
  assert.equal(troopStrikeMul(800), 1);
});

test('P59-② 普攻伤害率固定 100%：不再按 unit_id 从战法样本里哈希取', () => {
  const conf = battleConfig();
  assert.ok(Array.isArray(conf.damage_rates_pct) && conf.damage_rates_pct.length > 0);
  assert.deepEqual([...new Set(conf.damage_rates_pct)], [100], '普攻样本必须全部 100%');
});

test('P59-③ 一骑当千回到「敌军单体、无准备」：镜像不许把单体洗成全体', () => {
  const k = kernelSkillAt(10008, 1);
  assert.equal(k.effects[0].target_type, 'enemy_single', '一骑当千必须是单体');
  assert.equal(Number(k.prepare) || 0, 0, '本作这条没有准备回合');
  assert.equal(k.effects[0].rate_pct, 140);
  const mirror = JSON.parse(read('conf/skill-mirror.json'));
  assert.ok(!mirror.skills.some((s) => Number(s.cfgId) === 10008), '10008 不得再出现在镜像层');
  const skip = mirror.skipped.find((s) => Number(s.cfgId) === 10008);
  assert.ok(skip && /目标形状不一致/.test(skip.reason), '10008 必须留在 skip 台账并写明原因');
});

test('P59-④ 同阵容同种子：修后能打下 3515 守军，不再被单体守军打崩', () => {
  const s = fresh();
  const army = s.armys.find((a) => (a.generals || []).filter(Boolean).length >= 3) || s.armys[0];
  assert.ok(army, '开局应有队伍');
  army.soldiers = [740, 738, 738];
  const pool = s.generals.slice(0, 3);
  while (pool.length < 3) pool.push(s.generals[0]);
  for (const g of pool) g.level = 9;
  army.generals = pool.map((g) => g.id);
  const defender = {
    id: 950770, cfgId: 100475, level: 3, curArms: 1, star: 3,
    physical_power: 100, order: 0, exp: 0, cityId: 0, hasPrPoint: 0, usePrPoint: 0,
    attack_distance: 0, force_added: 0, strategy_added: 0, defense_added: 0,
    speed_added: 0, destroy_added: 0, star_lv: 0, parentId: 0, state: 0,
    skills: [
      { id: 10008, cfgId: 10008, lv: 1 },
      { id: 10021, cfgId: 10021, lv: 2 },
      { id: 910001, cfgId: 910001, lv: 3 },
    ],
  };
  const r = resolveBattle({
    cfg, state: s, army, x: 8077, y: 101, seed: 1748410472, withAnim: false,
    siege: true, siegeWall: { hp: 5000, max: 5000 },
    defenseOverride: { generals: [defender], soldiers: [3515], level: 3, name: '邯郸守军' },
  });
  const dmg = { a: 0, d: 0 };
  for (const e of r.kernel.events) {
    if (e.payload?.applied == null) continue;
    if (String(e.actor).startsWith('a')) dmg.a += e.payload.applied; else dmg.d += e.payload.applied;
  }
  /* 旧口径：攻方 536 / 守方 2216（全灭）；修后攻方输出翻数倍、守方不再是「一次打三人」。 */
  assert.ok(dmg.a > 1500, `攻方总伤害过低（${dmg.a}），兵力系数或普攻率可能回退`);
  assert.ok(dmg.a > dmg.d, `攻方输出应高于守方（${dmg.a} vs ${dmg.d}）`);
});

test('P59-⑤ 抓俘重写战报摘要时，城墙与宿命文案不能被吞掉', () => {
  const src = read('server/domain/strategy.js');
  assert.match(src, /result\.report\.summary = summary \+ wallNote \+ counterNote \+ fateNote;/, '抓俘分支必须补回城墙段落');
});

test('P59-⑥ 武将属性派生仍守住 100 上限（守军等级低不等于弱）', () => {
  const s = fresh();
  const g = s.generals.find((x) => Number(x.cfgId) === 100475) || s.generals[0];
  const h = makeHero({ ...g, level: 3, curArms: 1 }, cfg);
  assert.ok(h.attack_base <= 100 && h.defence_base <= 100, '属性上限 100 不得被派生层突破');
});
