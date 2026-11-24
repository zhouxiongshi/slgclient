/**
 * 官方同名战法镜像（可复跑）。
 *
 * 输入：官方公开战法库快照 JSON（由 SLG_OFFICIAL_SKILL_JSON 指定；默认取仓库外上一轮快照）。
 * 输出：conf/skill-mirror.json —— 只含「同名 + 本作内核可忠实表达」的战法覆盖条目，
 *       以及 skip 台账（同名但机制超出本作内核能力，保留原样，不做假照搬）。
 *
 * 规则：
 *   ① 名称必须逐字相同（trim 后）；
 *   ② 官方十级描述里的每个百分比都要能归到：伤害 / 治疗 / 控制 / 自身或友军增益 / 敌军减益；
 *   ③ 支持 1 回合准备、发动率区间（Lv1→Lv10 线性插值）、目标与有效距离；
 *   ④ 反击、分兵、连击、叠加、随机多效果、承伤修正等本作内核没有的词一律整条跳过；
 *   ⑤ 不动 cfgId / detail_id，编辑器覆盖层（custom-skills.json）仍在最后装载，玩家手改优先。
 *
 * 用法：node tools/mirror-official-skills.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const SOURCE = process.env.SLG_OFFICIAL_SKILL_JSON
  || join(REPO, 'skill-library-official-20261120.json');
const OUT = process.env.SLG_MIRROR_OUT || join(ROOT, 'conf', 'skill-mirror.json');
/* 端点写在合规台账里（纯数据，不进源码）；源码不出现任何外部网络地址。 */
const provenance = JSON.parse(readFileSync(join(ROOT, 'conf', 'compliance', 'provenance.json'), 'utf8'));
const sourceAsset = (provenance.assets || []).find((a) => a.path === 'skill-library-official-20261120.json');
const endpoint = String(sourceAsset?.origin || '').match(/g0\.gph\.netease\.com\/[\x21-\x7E]+/);
if (!endpoint) {
  console.error('[mirror] 合规台账里缺少官方端点记录');
  process.exit(2);
}
const SOURCE_URL = 'https:' + '//' + endpoint[0];

if (!existsSync(SOURCE)) {
  console.error(`[mirror] 找不到官方快照：${SOURCE}（设置 SLG_OFFICIAL_SKILL_JSON 指定路径）`);
  process.exit(2);
}
const raw = readFileSync(SOURCE);
const official = JSON.parse(raw.toString('utf8'));
const sha256 = createHash('sha256').update(raw).digest('hex');

/* 本地五张原表：与 server/skills.js 的装载顺序保持一致（不含编辑器覆盖层）。 */
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
const byName = new Map(official.map((s) => [String(s.name).trim(), s]));
const TRIGGER = { 主动: 1, 被动: 2, 追击: 3, 指挥: 4 };
const STATES = ['犹豫', '混乱', '暴走', '怯战'];
const UNSUPPORTED = /反击|分兵|连击|优先行动|叠加|随机|免疫|驱散|复活|规避|无差别攻击|恐慌|燃烧|妖术|受到.*伤害(提高|降低|提升|下降)|几率.*伤害率|伤害率.*几率|伤害率与原技能|每回合|每次|每发动|试图|若|否则|仅由|下\d?次|首回合|前\d回合|第[一二三四五六七八九十\d]回合|累计|指定|替换为|为代价|无法恢复|无法进行策略攻击|阻止|[二三四五六七八九十2-9]次(攻击|猛攻|策略攻击)/;

/** 官方「无法发动主动战法 / 无法进行普通攻击」与本作内核控制状态等价，先归一化。 */
function canonical(text) {
  let s = String(text || '');
  if (!s.includes('陷入犹豫状态')) s = s.replace(/无法发动主动战法/g, '陷入犹豫状态');
  else s = s.replace(/无法发动主动战法/g, '');
  if (!s.includes('陷入怯战状态')) s = s.replace(/无法进行普通攻击/g, '陷入怯战状态');
  else s = s.replace(/无法进行普通攻击/g, '');
  return s.replace(/，+/g, '，');
}

/** 一个百分比槽 → 内核效果类型。返回 null 表示整条战法不镜像。 */
function classifyClause(clause) {
  const nums = [...clause.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;
  if (nums.length !== 1) return null;
  if (UNSUPPORTED.test(clause)) return null;
  const v = nums[0];
  const st = STATES.find((x) => clause.includes(x));
  if (st && /(陷入|进入|使.*状态)/.test(clause)) {
    return { kind: 'CONTROL', value: v, state: st };
  }
  if (/恢复率/.test(clause)) return { kind: 'HEAL', value: v };
  if (/伤害率/.test(clause)) {
    return { kind: 'STRATEGY_DAMAGE', value: v };
  }
  if (/伤害(提高|提升|降低|下降)/.test(clause) || /(攻击|防御|谋略)属性(提高|提升|降低|下降)/.test(clause)) {
    const down = /降低|下降/.test(clause);
    const enemy = /敌军|目标/.test(clause);
    /* 敌军减益 / 我军增益都落到 target.buffs，方向由 BUFF/DEBUFF 决定；
       承伤修正（「受到伤害…」）已在 UNSUPPORTED 里排除，不在这里假装实现。 */
    const enemyWantsLower = enemy ? down : !down;
    return { kind: enemyWantsLower ? 'DEBUFF' : 'BUFF', value: v,
      term: (clause.match(/(伤害|攻击|防御|谋略)(?:属性)?(?:提高|提升|降低|下降)/) || ['伤害修正'])[0] };
  }
  return null;
}

/** 策略攻击要看整句，不能只看 clause（「发动策略攻击（伤害率…）」会拆开）。 */
function refineDamageKinds(desc, parsed) {
  let cursor = 0;
  const parts = desc.split(/([，；。])/);
  for (const p of parts) {
    if (/^[，；。]$/.test(p) || !p) continue;
    const at = desc.indexOf(p, cursor);
    cursor = at + p.length;
    const hit = parsed.find((x) => x._raw === p);
    if (hit && /策略|谋略/.test(p) && hit.kind === 'STRATEGY_DAMAGE') hit.kind = 'STRATEGY_DAMAGE';
    if (hit && !/策略|谋略/.test(p) && hit.kind === 'STRATEGY_DAMAGE') hit.kind = 'PHYSICAL_DAMAGE';
  }
  return parsed;
}

function parseDesc(desc) {
  const out = [];
  for (const clause of String(desc || '').split(/[，；。]/)) {
    if (!clause) continue;
    /* 官方「陷入犹豫状态」不带百分比：触发即必定施加，内核按 100% 命中落地。 */
    const st = STATES.find((x) => clause.includes(x));
    if (st && /(陷入|进入)/.test(clause) && !/%/.test(clause)) {
      out.push({ kind: 'CONTROL', value: 100, state: st, _raw: clause, _placeholder: false });
      continue;
    }
    if (!/%/.test(clause)) continue;
    const one = classifyClause(clause);
    if (!one) return null;
    /* 「策略攻击（伤害率…）」与「伤害率」同句时已经能判断；跨句保守按兵刃。 */
    if (one.kind === 'STRATEGY_DAMAGE' && !/策略|谋略/.test(clause)) one.kind = 'PHYSICAL_DAMAGE';
    one._raw = clause;
    one._placeholder = true;
    out.push(one);
  }
  return out;
}

function sameShape(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x.kind === b[i].kind && x.state === b[i].state && x.term === b[i].term);
}
const round2 = (n) => Math.round(Number(n) * 100) / 100;
function interp(a, b, i) { return round2(a + (b - a) * i / 9); }

function parseProbability(text, cls) {
  const s = String(text || '').trim();
  if (s === '--' || !s) return cls === '被动' || cls === '指挥' ? [100, 100] : null;
  const m = s.match(/^(\d+(?:\.\d+)?)%(?:-(\d+(?:\.\d+)?)%)?$/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (lo < 1 || hi > 60 || hi < lo) return null;
  return [lo, hi];
}

function targetOf(text, trigger) {
  const t = String(text || '');
  if (trigger === 3 || t.includes('攻击目标')) return { tt: 'enemy_single', ui: 6 };
  if (/自己|自身/.test(t) && !/我军|敌军|友军/.test(t)) return { tt: 'self', ui: 6 };
  if (/友军单体/.test(t)) return { tt: 'ally_single', ui: 6 };
  if (/我军|友军全体|友军群体/.test(t)) return { tt: 'ally_all', ui: 9 };
  if (/敌军全体/.test(t)) return { tt: 'enemy_all', ui: 9 };
  if (/敌军群体/.test(t)) return { tt: /3个/.test(t) ? 'enemy_all' : 'enemy_group', ui: /3个/.test(t) ? 9 : 8 };
  if (/敌军单体/.test(t)) return { tt: 'enemy_single', ui: 6 };
  return null;
}

function mirrorOne(local, off) {
  /* 条件、叠加、随机、多段、状态免疫等整句级语义本作内核没有对应物：
     哪怕其中某个百分比能匹配，也不能假装「照搬」——整条保留原样。 */
  if (/属性(提高|提升|降低|下降)\s*\d/.test(canonical(off.desc))
    || /属性(提高|提升|降低|下降)\s*\d/.test(canonical(off['desc(level1)']))) {
    return { skip: '存在非百分比属性点效果，内核无同名槽位' };
  }
  if (UNSUPPORTED.test(canonical(off.desc)) || UNSUPPORTED.test(canonical(off['desc(level1)']))) {
    return { skip: '描述含本作内核不支持的条件/叠加/多段机制' };
  }
  /* ★ P49：方向性修复——「伤害降低/伤害提高」不带「受到」前缀时是输出增减益，
     只有挂敌军（DEBUFF）方向才正确；本工具把 BUFF/DEBUFF 一律落 self/enemy_single，
     落成 self 的这类词条会反向作用在自己身上（锋矢/犒劳曾被审计判 P1）。
     无法忠实落地 → 按红线「不做假照搬」剔除进 skip 台账，回退本地语义正确版本。 */
  if (!/受到/.test(canonical(off.desc))
    && /伤害降低|伤害提高/.test(canonical(off.desc))
    && !/敌军/.test(String(off.targetType || ''))) {
    return { skip: 'P49：输出增减益词条映射为 self 会反向作用，无法忠实落地，回退本地版本' };
  }
  const cls = String(off.type || '').trim();
  if (!TRIGGER[cls]) return { skip: '不支持的战法类别：' + cls };
  const trigger = TRIGGER[cls];
  const prob = parseProbability(off.probability, cls);
  if (!prob) return { skip: '发动率无法解析或越界：' + off.probability };
  const tgt = targetOf(off.targetType, trigger);
  if (!tgt) return { skip: '目标类型无法映射：' + off.targetType };
  /* ★ P59：同名 ≠ 同机制。官方这条的「目标形状」或「准备回合」与本作原表不一致时整条跳过。
     真实事故：本作 10008「一骑当千」是敌军单体、无准备；官方同名条目是
     「1 回合准备，对敌军全体」。镜像层整条替换后，单体 140% 变成全体 140%，
     守军一回合打我三名武将，战报只能看到「对方输出一次、我方三人各掉 200+」，
     玩家完全无法解释。按红线「不做假照搬」——机制形状不同就不镜像，保留本地版本。
     只比「单体 / 多目标」这一层，是因为单体↔多目标是数量级差别；
     enemy_all ↔ enemy_group 都属多目标，允许镜像官方数值。 */
  const shapeOf = (tt) => {
    const x = String(tt || '');
    if (x === 'enemy_single') return 'enemy1';
    if (x.startsWith('enemy')) return 'enemyN';
    if (x === 'self') return 'self';
    if (x.startsWith('ally')) return 'ally';
    return x;
  };
  const localTt = String(
    local.kernel?.effects?.[0]?.target_type || local.kernel?.target_type || '',
  );
  const localPrepare = Number(local.kernel?.prepare) || 0;
  const officialPrepare = Number((String(off.desc || '').match(/(\d+)回合准备/) || [])[1] || 0);
  if (localTt && shapeOf(tgt.tt) !== shapeOf(localTt)) {
    return { skip: `目标形状不一致（本作 ${localTt} / 官方 ${tgt.tt}），不做假照搬` };
  }
  if (localPrepare !== officialPrepare) {
    return { skip: `准备回合不一致（本作 ${localPrepare} / 官方 ${officialPrepare}），不做假照搬` };
  }
  const desc10 = canonical(off.desc);
  const desc1 = canonical(off['desc(level1)']);
  const lv10 = parseDesc(desc10);
  const lv1 = parseDesc(desc1);
  if (!sameShape(lv1, lv10) || !lv10.length) return { skip: '描述无可忠实映射的百分比效果槽' };
  const prepare = Number((String(off.desc || '').match(/(\d+)回合准备/) || [])[1] || 0);
  const detail = local.kernel?.effects?.[0]?.detail_id || local.kernel?.detail_id || 900000;
  const effects = lv10.map((slot, i) => {
    const e = {
      detail_id: Number(detail) + i,
      effect_type: slot.kind,
      rate_pct: slot.value,
      target_type: slot.kind === 'BUFF' || slot.kind === 'DEBUFF'
        ? (tgt.tt.startsWith('enemy') ? 'enemy_single' : 'self')
        : tgt.tt,
      attack_type: slot.kind === 'STRATEGY_DAMAGE' ? 'chain' : 'normal',
      available_round: 0,
      control_probability: slot.kind === 'CONTROL' ? round2(lv1[i].value / 100) : 0,
      control_state: slot.kind === 'CONTROL' ? slot.state : null,
      bonus_terms: slot.kind === 'BUFF' || slot.kind === 'DEBUFF'
        ? [{ name: slot.term, value: lv1[i].value, op: 0 }] : [],
    };
    return e;
  });
  const levels = [];
  for (let i = 0; i < 10; i += 1) {
    levels.push({
      probability: interp(prob[0], prob[1], i),
      effect_value: lv10.map((slot, k) => interp(lv1[k].value, slot.value, i)),
      effect_round: lv10.map(() => 0),
    });
  }
  const queues = new Map();
  for (const slot of lv10) {
    if (!queues.has(slot._raw)) queues.set(slot._raw, []);
    queues.get(slot._raw).push(slot);
  }
  let n = 0;
  const des = desc10.split(/([，；。])/).map((part) => {
    if (!part || /^[，；。]$/.test(part)) return part;
    const queue = queues.get(part);
    const slot = queue && queue.shift();
    if (!slot) return part;
    /* 渲染层会把 %n% 替换成裸数值；写法必须是 %n%% 才能留下一个真实百分号。 */
    if (slot._placeholder) return part.replace(/(\d+(?:\.\d+)?)%/g, () => { n += 1; return '%n%%'; });
    n += 1;
    return part + '（命中率%n%%）';
  }).join('');
  if (n !== effects.length) return { skip: '描述占位符数量与效果槽不一致' };
  const ui = {
    ...(local.ui || {}),
    name: local.name,
    des,
    include_effect: effects.map((_, i) => i + 1),
    trigger,
    target: tgt.ui,
    levels,
    range: Number(off.distance) > 0 ? Number(off.distance) : 9,
  };
  const kernel = {
    cfgId: local.cfgId,
    name: local.name,
    skill_class: cls,
    effect_type: effects[0].effect_type,
    rate_pct_lv1: levels[0].effect_value[0],
    rate_pct_lv10: levels[9].effect_value[0],
    probability_init: levels[0].probability / 100,
    probability_max: levels[9].probability / 100,
    prepare,
    target_type: effects[0].target_type,
    attack_type: effects[0].attack_type,
    control_state: effects[0].control_state,
    control_probability: effects[0].control_probability,
    bonus_terms: effects[0].bonus_terms,
    detail_id: Number(detail),
    effects,
  };
  return { skill: {
    cfgId: local.cfgId, name: local.name, trigger, dir: local.dir || '',
    ui, kernel,
    provenance: {
      ...(local.provenance || {}),
      mirror: {
        officialId: off.id,
        sourceUrl: SOURCE_URL,
        sourceSha256: sha256,
        officialType: cls,
        officialProbability: off.probability,
        officialTarget: String(off.targetType || '').trim(),
        officialLv1: off['desc(level1)'],
        officialLv10: off.desc,
      },
    },
  } };
}

const skills = [];
const skipped = [];
for (const local of ours) {
  const off = byName.get(String(local.name).trim());
  if (!off) {
    skipped.push({ cfgId: local.cfgId, name: local.name, reason: '无同名条目' });
    continue;
  }
  const r = mirrorOne(local, off);
  if (r.skip) skipped.push({ cfgId: local.cfgId, name: local.name, reason: r.skip });
  else skills.push(r.skill);
}
const doc = {
  version: 1,
  generatedBy: 'tools/mirror-official-skills.mjs',
  sourceUrl: SOURCE_URL,
  sourceSha256: sha256,
  count: skills.length,
  skippedCount: skipped.length,
  rules: '同名逐字匹配；仅镜像伤害/治疗/控制/增减益可忠实落地的百分比槽；其余保留原样',
  skills,
  skipped,
};
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`[mirror] 本地 ${ours.length} 条 / 官方 ${official.length} 条：镜像 ${skills.length} 条，保留 ${skipped.length} 条`);
console.log(`[mirror] 输出 ${OUT}`);
