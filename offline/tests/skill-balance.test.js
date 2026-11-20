/**
 * 技能概率与输出平衡闸（用户 2026-11-17「所有技能释放概率都是 70% 非常不合理、
 * 输出相差太大，所有技能都给我测试下」）。
 *
 * 口径由 tools/skill-balance.mjs 统一落地，本用例对**运行时战法表**（server/skills.js
 * 的 SKILLS，即玩家实际看到的那一张）复核，防止两类回退：
 *   ① 有人重新生成 conf/library-skills.json 后把概率冲回「清一色 70%」；
 *   ② 有人调伤害率把某个战法顶成必胜技。
 *
 * 度量：期望输出指数 = 发动次数 × 发动率(Lv10) × 伤害率(Lv10) × 目标数
 *   发动次数：指挥 1；被动 8（每回合）；主动/追击 8（每回合）；准备型 floor(8/(prepare+1))
 *   目标数：enemy_single/self = 1；enemy_group/enemy_all = 3
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS } from '../server/skills.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = JSON.parse(readFileSync(join(ROOT, 'conf', 'skill-mirror.json'), 'utf8'));
const MIRRORED = new Map(MIRROR.skills.map((s) => [Number(s.cfgId), s]));
const mirrorOf = (s) => MIRRORED.get(Number(s.cfgId));

const DMG = new Set(['PHYSICAL_DAMAGE', 'STRATEGY_DAMAGE']);
const NON_ROLL = new Set(['指挥', '被动']);

function castsOf(s) {
  const c = s.kernel.skill_class;
  if (c === '指挥') return 1;
  if (c === '被动') return 8;
  const prep = Number(s.kernel.prepare) || 0;
  return prep > 0 ? Math.floor(8 / (prep + 1)) : 8;
}
function targetsOf(s) {
  const k = s.kernel;
  const t = k.target_type || k.effects?.[0]?.target_type || 'enemy_single';
  return /group|all/i.test(String(t)) ? 3 : 1;
}
function damageSlots(s) {
  const k = s.kernel;
  if (Array.isArray(k.effects)) {
    const out = [];
    k.effects.forEach((e, i) => { if (DMG.has(e.effect_type)) out.push(i); });
    return out;
  }
  return DMG.has(k.effect_type) ? [0] : [];
}
function rateLv10(s) {
  const lv = s.ui.levels.at(-1);
  return damageSlots(s).reduce((a, i) => a + (Number(lv.effect_value[i]) || 0), 0);
}

const ROWS = SKILLS.map((s) => {
  const n = s.ui.levels.length;
  const rate = rateLv10(s);
  const p1 = s.ui.levels[0].probability;
  const p10 = s.ui.levels[n - 1].probability;
  const targets = targetsOf(s);
  const idx = Math.round(castsOf(s) * (p10 / 100) * rate * targets);
  return { s, name: s.name, cls: s.kernel.skill_class, rate, p1, p10, targets, idx };
});
const ACTIVE_DMG = ROWS.filter((r) => !NON_ROLL.has(r.cls) && r.rate > 0);

test('主动/追击发动率：按伤害率反推的 32%~50% 区间，且逐级成长（不再清一色 70%）', () => {
  assert.ok(ACTIVE_DMG.length >= 70, `可结算的主动/追击战法应足够多（实测 ${ACTIVE_DMG.length}）`);
  for (const r of ACTIVE_DMG) {
    const m = mirrorOf(r.s);
    if (m) {
      /* 镜像条目的发动率以官方公开战法库为准（区间战法 Lv1→Lv10 线性成长，
         固定发动率战法十级同值）；这里核「与官方逐字一致」而不是本作自造的 32~50 带。 */
      const raw = String(m.provenance.mirror.officialProbability || '');
      const p = raw.match(/(\d+(?:\.\d+)?)%(?:-(\d+(?:\.\d+)?)%)?/);
      assert.ok(p, `${r.name} 镜像缺官方发动率：${raw}`);
      assert.equal(r.p1, Number(p[1]), `${r.name} Lv1 发动率应等于官方 ${raw}`);
      assert.equal(r.p10, Number(p[2] || p[1]), `${r.name} Lv10 发动率应等于官方 ${raw}`);
      assert.ok(r.p10 >= 20 && r.p10 <= 60, `${r.name} 官方发动率 ${r.p10}% 仍需在 20~60 安全区`);
      continue;
    }
    assert.ok(r.p10 >= 32 && r.p10 <= 50, `${r.name} Lv10 发动率 ${r.p10}% 越界（应在 32~50）`);
    assert.ok(r.p1 >= 30 && r.p1 <= 45, `${r.name} Lv1 发动率 ${r.p1}% 越界（应在 30~45）`);
    assert.ok(r.p10 > r.p1, `${r.name} 发动率无成长（${r.p1}%→${r.p10}%）`);
  }
  const distinct = new Set(ACTIVE_DMG.map((r) => r.p10));
  assert.ok(distinct.size >= 4, `发动率档位过少（${[...distinct].join('/')}），说明又被写成了统一值`);
  const same70 = ACTIVE_DMG.filter((r) => r.p10 === 70).length;
  assert.equal(same70, 0, `仍有 ${same70} 条战法 Lv10 发动率是 70%`);
});

test('输出指数：主动/追击收敛在 300~2000，极差 ≤ 7 倍', () => {
  const idx = ACTIVE_DMG.map((r) => r.idx);
  const lo = Math.min(...idx), hi = Math.max(...idx);
  const out = ACTIVE_DMG.filter((r) => r.idx < 300 || r.idx > 2000)
    .map((r) => `${r.name}=${r.idx}`);
  assert.deepEqual(out, [], '以下战法输出指数越界（应在 300~2000）：\n' + out.join('\n'));
  assert.ok(hi / lo <= 7.01, `输出极差 ${(hi / lo).toFixed(2)} 倍过大（${lo}~${hi}）`);
  // 中位数不能偏到某一端，否则说明缩放把整体拉平/拉爆
  const sorted = [...idx].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  assert.ok(med >= 450 && med <= 1100, `输出指数中位数 ${med} 偏离合理中心`);
});

test('每目标输出：单体与群体的单体收益不悬殊（200~950，极差 ≤ 5 倍）', () => {
  const per = ACTIVE_DMG.map((r) => ({ ...r, pt: Math.round(r.idx / r.targets) }));
  const lo = Math.min(...per.map((r) => r.pt)), hi = Math.max(...per.map((r) => r.pt));
  const out = per.filter((r) => r.pt < 200 || r.pt > 950).map((r) => `${r.name}=${r.pt}/${r.targets}目标`);
  assert.deepEqual(out, [], '以下战法单体收益越界（应在 200~950）：\n' + out.join('\n'));
  assert.ok(hi / lo <= 5.01, `单体收益极差 ${(hi / lo).toFixed(2)} 倍过大（${lo}~${hi}）`);
});

test('指挥/被动必发动：发动率恒 100%，且伤害不至于顶成必胜技', () => {
  const cmd = ROWS.filter((r) => NON_ROLL.has(r.cls));
  assert.ok(cmd.length >= 60, `指挥/被动战法应足够多（实测 ${cmd.length}）`);
  for (const r of cmd) {
    assert.equal(r.p10, 100, `${r.name}（${r.cls}）Lv10 发动率应为 100%，实测 ${r.p10}%`);
    assert.equal(r.p1, 100, `${r.name}（${r.cls}）Lv1 发动率应为 100%，实测 ${r.p1}%`);
    assert.ok(r.s.kernel.probability_max === 1, `${r.name} 内核 probability_max 应为 1`);
    assert.ok(r.idx <= 2000, `${r.name} 输出指数 ${r.idx} 超过 2000（指挥不该顶成必胜技）`);
  }
});

test('控制槽：命中率 ≤ 100% 且 Lv10 = Lv1×2（不会必中、也不许无成长）', () => {
  let slots = 0;
  for (const s of SKILLS) {
    const k = s.kernel;
    const effs = Array.isArray(k.effects) ? k.effects : (k.effect_type ? [k] : []);
    const n = s.ui.levels.length;
    effs.forEach((e, i) => {
      if (e.effect_type !== 'CONTROL') return;
      slots += 1;
      const a = Number(s.ui.levels[0].effect_value[i]) || 0;
      const b = Number(s.ui.levels[n - 1].effect_value[i]) || 0;
      assert.ok(b <= 100, `${s.name} 控制命中率 Lv10=${b}% 超过 100%（等于必中）`);
      assert.ok(b > 0, `${s.name} 控制命中率为 0，控制槽等于不存在`);
      /* 官方「陷入 X 状态」不带命中率，等价于触发必中；镜像层记 100%→100%，
         不适用本作自造战法的「Lv10 = Lv1×2」成长规则。 */
      if (mirrorOf(s) && a === 100 && b === 100) return;
      assert.ok(Math.abs(b - a * 2) < 0.02, `${s.name} 控制命中率成长断裂 ${a}%→${b}%`);
    });
  }
  assert.ok(slots >= 40, `控制槽数量异常（实测 ${slots}）`);
});

test('ui 与内核概率同源：probability_max/init 等于首末级发动率', () => {
  for (const r of ROWS) {
    const s = r.s;
    const n = s.ui.levels.length;
    assert.ok(Math.abs(s.kernel.probability_max * 100 - s.ui.levels[n - 1].probability) < 0.51,
      `${r.name} kernel.probability_max=${s.kernel.probability_max} 与 ui Lv10=${s.ui.levels[n - 1].probability}% 不同源`);
    assert.ok(Math.abs(s.kernel.probability_init * 100 - s.ui.levels[0].probability) < 0.51,
      `${r.name} kernel.probability_init 与 ui Lv1 不同源`);
    assert.ok(s.ui.levels[n - 1].probability <= 100 && s.ui.levels[0].probability <= 100,
      `${r.name} 存在 >100% 的发动率`);
  }
});
