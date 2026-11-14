/**
 * 系统性验收回归（M4-4）：
 *   1) 8 旬加速模拟：零未捕获异常 / 零不变量违反 / 灭国闭环达成 / 确定性通过；
 *   2) 场景清单无 THREW（业务拒绝允许，异常不允许）；
 *   3) 武将平衡：零无效战法引用、零战法错配、零高维零战法、CSV 忠实；
 *   4) 已知设计口径：层级倒挂仍在（layer 是剧情权重不是强度档，报告里如实登记）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAudit } from '../tools/system-audit.mjs';

test('M4-4·8 旬加速模拟：零异常 / 零不变量 / 灭国闭环 / 确定性', () => {
  const a = runAudit({ seed: 20261114, turns: 8 });
  const b = runAudit({ seed: 20261114, turns: 8 });
  assert.equal(a.summary.errors, 0, `场景异常：${JSON.stringify(a.errors).slice(0, 400)}`);
  assert.equal(a.summary.invariants, 0, `不变量违反：${a.invariants.slice(0, 5).join(' | ')}`);
  assert.equal(a.summary.scenarioErrors, 0, '业务拒绝允许，THREW 不允许');
  assert.equal(a.summary.suspiciousLogs, 0);
  assert.equal(a.summary.consoleErrors, 0);
  assert.ok(a.conquest.eliminated, '一方势力应被灭掉');
  assert.ok(a.conquest.postTurns >= 10, '灭国后须再跑 10 旬验证闭环');
  const js = JSON.stringify({ s: a.series, c: a.conquest, sc: a.scenarios });
  const js2 = JSON.stringify({ s: b.series, c: b.conquest, sc: b.scenarios });
  assert.equal(js, js2, '同种子两次运行必须逐旬一致');
  // 存档回读场景必须成功
  assert.ok(a.scenarios.some((x) => x.name === '存档·JSON 回读' && x.ok));
  /* M4-5：真链路自检——日产入账、玩家金全程为正，杜绝「挂机金恒 0」假结论回潮 */
  assert.equal(a.summary.dayChain, 'settleWorld');
  assert.equal(a.summary.dailyIncomeOk, true, '每旬都应看得到 gold_yield 与属地日产流水');
  assert.equal(a.summary.playerGoldNeverZero, true, '真链路玩家金有日产，不应归零');
  assert.ok(a.series.every((s) => s.player.goldYield > 0));
});

test('M4-5·模拟脚本只准调 settleWorld，不准再手写结算链', () => {
  for (const p of ['../tools/system-audit.mjs', '../tools/sim-60turns.mjs']) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.match(src, /import \{ settleWorld \} from '\.\.\/server\/handlers\.js'/, `${p} 必须走世界推进唯一真入口`);
    assert.doesNotMatch(src, /state\.clock\.day\s*[+]?=/, `${p} 不许手动累加游戏日（漏日产）`);
    assert.doesNotMatch(src, /cityEconTick\(/, `${p} 不许外部重跑城经（strategyTick 内部已调）`);
    assert.doesNotMatch(src, /strategyTick\(state/, `${p} 不许绕过 settleWorld 直接跑旬结算`);
  }
});

test('M4-4·武将平衡：装配修复后三项归零 + CSV 忠实', () => {
  const heroes = JSON.parse(readFileSync(new URL('../conf/campaign/heroes-240.json', import.meta.url), 'utf8')).heroes;
  const tables = ['../conf/skills.json', '../conf/library-skills.json', '../conf/library-skills-extra.json']
    .flatMap((p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')).skills);
  const byId = new Map(tables.map((s) => [s.cfgId, s]));
  const sum = (h) => Object.values(h.five).reduce((s, v) => s + v, 0);
  const coreMean = heroes.filter((h) => h.layer === 'core')
    .reduce((s, h) => s + sum(h), 0) / heroes.filter((h) => h.layer === 'core').length;
  const kindOf = (id) => {
    const s = byId.get(id);
    if (!s) return null;
    const k = s.kernel || s;
    const fx = Array.isArray(k.effects) && k.effects.length ? k.effects : [k];
    const types = new Set(fx.map((e) => e.effect_type));
    return { physical: types.has('PHYSICAL_DAMAGE'), strategy: types.has('STRATEGY_DAMAGE') };
  };
  let badRefs = 0, mismatch = 0, zeroHigh = 0;
  for (const h of heroes) {
    const ids = h.skills || [];
    for (const id of ids) if (!byId.has(id)) badRefs += 1;
    const kinds = ids.map(kindOf).filter(Boolean);
    if (h.layer === 'core' && h.five.wu >= 90 && !kinds.some((k) => k.physical)) mismatch += 1;
    if (h.layer === 'core' && h.five.zhi >= 90 && !kinds.some((k) => k.strategy)) mismatch += 1;
    if (!ids.length && sum(h) >= coreMean) zeroHigh += 1;
  }
  assert.equal(badRefs, 0, '战法引用必须全部有效');
  assert.equal(mismatch, 0, 'core 高武/高智不许战法错配');
  assert.equal(zeroHigh, 0, '五维和达 core 均值者不许零战法');
  assert.equal(heroes.length, 240);
  // core 保底 2 条（M3-8 口径不能回退）
  assert.ok(heroes.filter((h) => h.layer === 'core').every((h) => (h.skills || []).length >= 2));
});
