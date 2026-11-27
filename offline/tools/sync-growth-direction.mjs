/**
 * 官方同名战法「Lv1→Lv10 成长方向」对齐生成器（可复跑）。
 *
 * 官方公开战法库只给 Lv1 / Lv10 两端文案，本工具据此取每个百分比槽的升降方向，
 * 并把它施加到本作已有曲线上：**只改方向，不改 Lv10 终点，不改机制**。
 * 这样引用官方成长口径的同时，不把当前满级平衡推翻。
 *
 * 输入：仓库外官方快照 + 五张原表 + conf/skill-mirror.json（已镜像条目不再重复处理）
 * 输出：conf/skill-growth-direction.json（在镜像层之后、玩家覆盖层之前装载）
 *
 * 用法：node tools/sync-growth-direction.mjs
 *   SLG_GROWTH_OUT=临时路径 可复跑且不 bump 出厂产物时间。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const SOURCE = process.env.SLG_OFFICIAL_SKILL_JSON
  || join(REPO, 'skill-library-official-20261120.json');
const OUT = process.env.SLG_GROWTH_OUT || join(ROOT, 'conf', 'skill-growth-direction.json');
const provenance = JSON.parse(readFileSync(join(ROOT, 'conf', 'compliance', 'provenance.json'), 'utf8'));
const sourceAsset = (provenance.assets || []).find((a) => a.path === 'skill-library-official-20261120.json');
const endpoint = String(sourceAsset?.origin || '').match(/g0\.gph\.netease\.com\/[\x21-\x7E]+/);
if (!endpoint) { console.error('[growth] 合规台账里缺少官方端点记录'); process.exit(2); }
const SOURCE_URL = 'https:' + '//' + endpoint[0];

if (!existsSync(SOURCE)) {
  console.error(`[growth] 找不到官方快照：${SOURCE}`);
  process.exit(2);
}
const raw = readFileSync(SOURCE);
const official = JSON.parse(raw.toString('utf8'));
const sha256 = createHash('sha256').update(raw).digest('hex');
const byName = new Map(official.map((s) => [String(s.name).trim(), s]));

const TABLES = [
  'conf/skills.json',
  'conf/campaign/protagonist-skill.json',
  'conf/library-skills.json',
  'conf/library-skills-extra.json',
  'conf/innate-skills.json',
];
const ours = [];
for (const rel of TABLES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  for (const s of Array.isArray(doc) ? doc : (doc.skills ? [doc.skills] : []).flat()) {
    if (ours.some((x) => Number(x.cfgId) === Number(s.cfgId) || x.name === s.name)) continue;
    ours.push(s);
  }
}
/* 已镜像条目的 Lv1/Lv10 就是官方值，不能再按本层二次改写。 */
const mirrorDoc = JSON.parse(readFileSync(join(ROOT, 'conf', 'skill-mirror.json'), 'utf8'));
const mirrored = new Set(mirrorDoc.skills.map((s) => Number(s.cfgId)));
for (const m of mirrorDoc.skills) {
  const i = ours.findIndex((x) => Number(x.cfgId) === Number(m.cfgId));
  if (i >= 0) ours[i] = m;
}

const nums = (t) => [...String(t || '').matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
/* 官方文案里的「40% 几率」是释放条件、不是效果槽：按关键词紧贴取值，
   而不是把整句所有百分比都算进来；取不到或数量对不上时整条跳过。 */
const effectNums = (t) => {
  const text = String(t || '');
  const found = [];
  const push = (re, group) => {
    for (const m of text.matchAll(re)) {
      found.push({ at: m.index, value: Number(m[group]) });
    }
  };
  push(/(伤害率|恢复率)\s*(\d+(?:\.\d+)?)%/g, 2);
  push(/(?:提高|提升|降低|下降)\s*(\d+(?:\.\d+)?)%/g, 1);
  push(/(\d+(?:\.\d+)?)%[^，。；]*(?:陷入|进入)/g, 1);
  return found.sort((a, b) => a.at - b.at).map((x) => x.value);
};
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sign = (d) => (d > 0.005 ? '+' : d < -0.005 ? '-' : '0');
const interp = (a, b, i) => round2(a + (b - a) * i / 9);
const probOf = (t) => {
  const m = String(t || '').trim().match(/^(\d+(?:\.\d+)?)%(?:-(\d+(?:\.\d+)?)%)?$/);
  return m ? [Number(m[1]), Number(m[2] || m[1])] : null;
};

const entries = [];
const skipped = [];
for (const local of ours) {
  const off = byName.get(String(local.name).trim());
  const isMirrored = mirrored.has(Number(local.cfgId));
  const base = local.ui?.levels;
  const tenLv = Array.isArray(base) && base.length === 10;
  const b1 = tenLv ? base[0].effect_value.map(Number) : [];
  const b10 = tenLv ? base[9].effect_value.map(Number) : [];
  /* ★ P68 平线兜底判据：整条曲线 Lv1==Lv10（升级零反馈，玩家可见缺陷）。
     已镜像条目不进本层——镜像层自行处理控制命中率成长（P68 同步）。 */
  const flatAll = tenLv && b1.length > 0
    && b1.every((v, i) => v === b10[i]) && b1.some((v) => Number(v) > 0);

  /* 无同名官方战法：平线者按本作惯例兜底（Lv1=Lv10/2 线性、终点保留），
     非平线者维持「无官方方向可依」的 skip 台账。 */
  if (!off) {
    if (isMirrored) continue;
    if (flatAll) {
      const levels = base.map((lv, i) => ({
        probability: Number(lv.probability),
        effect_value: lv.effect_value.map((v, k) => interp(round2(Number(v) / 2), b10[k], i)),
        effect_round: Array.isArray(lv.effect_round) ? [...lv.effect_round] : [],
      }));
      entries.push({
        cfgId: local.cfgId,
        name: local.name,
        skillClass: String(local.kernel?.skill_class || ''),
        officialProbability: '',
        officialLv1: '',
        officialLv10: '',
        baselineLv1: { probability: Number(base[0].probability), effect_value: b1 },
        baselineLv10: { probability: Number(base[9].probability), effect_value: b10 },
        changes: b1.map((v, k) => ({
          field: `槽 ${k + 1}`, rule: 'flat-upgrade',
          from: `${v}→${b10[k]}`, to: `${round2(Number(v) / 2)}→${b10[k]}`, official: '',
        })),
        levels,
        rule: 'P68 平线兜底：无同名官方战法，升级零反馈；Lv1 取 Lv10 一半、线性插值，满级终点保留',
      });
    } else {
      skipped.push({ cfgId: local.cfgId, name: local.name, reason: '无同名官方战法' });
    }
    continue;
  }
  if (isMirrored) continue;
  const cls = String(local.kernel?.skill_class || '');
  const nonRolling = ['被动', '指挥'].includes(cls);
  if (!tenLv) {
    skipped.push({ cfgId: local.cfgId, name: local.name, reason: '本作等级表不是十级' });
    continue;
  }
  const a = base[0], b = base[9];
  const lv1 = b1;
  const lv10 = b10;
  const o1 = effectNums(off['desc(level1)']), o10 = effectNums(off.desc);
  const changes = [];
  const reasons = [];

  /* ① 发动率方向：固定值 → 十级同值；区间 → 按官方端点比例线性成长。
        被动/指挥恒 100%，不受官方「概率」字段影响（那是释放条件，不是本作 roll）。 */
  const op = probOf(off.probability);
  const p1 = Number(a.probability), p10 = Number(b.probability);
  let targetProb = null;
  if (!nonRolling && op) {
    const want = sign(op[1] - op[0]);
    const have = sign(p10 - p1);
    if (want !== have) {
      if (want === '0') {
        targetProb = Array(10).fill(p10);
      } else if (op[1] > 0) {
        const start = op[0] > 0 ? round2(p10 * op[0] / op[1]) : 0;
        targetProb = Array.from({ length: 10 }, (_, i) => Math.min(100, Math.max(1, interp(start, p10, i))));
      }
      if (targetProb) changes.push({ field: 'probability', from: `${p1}→${p10}`, to: `${targetProb[0]}→${targetProb[9]}`, official: `${op[0]}→${op[1]}` });
    }
  }

  /* ② 效果值方向：仅在官方与本作百分比槽一一对应时改；保持 Lv10 终点不变。 */
  const values = lv1.map((v, i) => v);
  let slotChanged = false;
  if (o1.length && o1.length === o10.length && o1.length === lv1.length) {
    for (let i = 0; i < lv1.length; i += 1) {
      const want = sign(o10[i] - o1[i]);
      const have = sign(lv10[i] - lv1[i]);
      if (want === have || !o10[i]) continue;
      const start = round2(lv10[i] * o1[i] / o10[i]);
      values[i] = start;
      slotChanged = true;
      changes.push({ field: `槽 ${i + 1}`, from: `${lv1[i]}→${lv10[i]}`, to: `${start}→${lv10[i]}`, official: `${o1[i]}→${o10[i]}` });
    }
  }
  /* ★ P68：有同名官方战法但官方两端数值对不上本作槽位（如健卒不殆）时，
     官方对齐产不出任何 changes，旧逻辑静默跳过 → 曲线保持平线。
     此时若整条曲线是平线，同样按本作惯例兜底，不让「升级无反馈」漏网。 */
  if (!changes.length && flatAll) {
    const levels = base.map((lv, i) => ({
      probability: Number(lv.probability),
      effect_value: lv.effect_value.map((v, k) => interp(round2(Number(v) / 2), b10[k], i)),
      effect_round: Array.isArray(lv.effect_round) ? [...lv.effect_round] : [],
    }));
    entries.push({
      cfgId: local.cfgId,
      name: local.name,
      skillClass: cls,
      officialProbability: '',
      officialLv1: '',
      officialLv10: '',
      baselineLv1: { probability: p1, effect_value: b1 },
      baselineLv10: { probability: p10, effect_value: b10 },
      changes: b1.map((v, k) => ({
        field: `槽 ${k + 1}`, rule: 'flat-upgrade',
        from: `${v}→${b10[k]}`, to: `${round2(Number(v) / 2)}→${b10[k]}`, official: '',
      })),
      levels,
      rule: 'P68 平线兜底：官方同名战法数值与本作槽位不对应，升级零反馈；Lv1 取 Lv10 一半、线性插值，满级终点保留',
    });
    continue;
  }
  if (!changes.length) continue;

  const levels = base.map((lv, i) => ({
    probability: targetProb ? targetProb[i] : lv.probability,
    effect_value: lv.effect_value.map((v, k) => (slotChanged && values[k] !== lv1[k]
      ? interp(values[k], lv10[k], i) : v)),
    effect_round: Array.isArray(lv.effect_round) ? [...lv.effect_round] : [],
  }));
  entries.push({
    cfgId: local.cfgId,
    name: local.name,
    skillClass: cls,
    officialProbability: String(off.probability || ''),
    officialLv1: String(off['desc(level1)'] || ''),
    officialLv10: String(off.desc || ''),
    baselineLv1: { probability: p1, effect_value: lv1 },
    baselineLv10: { probability: p10, effect_value: lv10 },
    changes,
    levels,
  });
}

const doc = {
  sourceUrl: SOURCE_URL,
  sourceSha256: sha256,
  generatedBy: 'tools/sync-growth-direction.mjs',
  note: '同名战法 Lv1→Lv10 成长方向按官方两端文案对齐；只改方向，保留原 Lv10 终点与内核机制。已镜像战法不重复处理。',
  count: entries.length,
  skippedCount: skipped.length,
  entries,
  skipped,
};
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`[growth] 同步 ${entries.length} 条成长方向，跳过 ${skipped.length} 条 → ${OUT}`);
for (const e of entries.slice(0, 12)) console.log(`  ${e.cfgId} ${e.name}: ${e.changes.map((c) => c.field + ' ' + c.from + '→' + c.to).join('; ')}`);
