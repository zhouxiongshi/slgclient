/**
 * 战斗叙述（Battle Narrative）—— 把「结构化战斗数据」翻译成玩家看得懂的中文。
 *
 * 为什么必须单独一个模块：
 *   1. 战前推演、战报详情、战斗回放、回合报告都要说同一件事。以前各写一份，
 *      于是出现「推演说歼敌 -166」「战报只写：健卒不殆 发动」这类玩家读不懂的输出。
 *   2. 玩家反馈「推演返回一串代码」的根因也在这里：界面直接打印了
 *      report.rounds（它本身就是 JSON 字符串），而不是打印语义。
 *      **语义只由服务端产出**，前端只排版，不再自己拼字符串。
 *
 * 口径（与 battle.js / skills.js 同源）：
 *   - 数值全部取自 conf/skills.json 对应等级的 ui.levels[lv-1] 与 kernel；
 *     取不到就不编（不猜、不凑好看的数字）。
 *   - 文案模板按 skill_class × effect_type 生成；同一战法措辞固定
 *     （按 cfgId 稳定取词，不用 Math.random —— 面板层禁随机）。
 *   - 只读，不参与判定，不改战斗结果。
 */
import { skillById, LEVEL_COUNT, SKILLS } from '../skills.js';

const TARGET_TEXT = {
  self: '自身',
  enemy_single: '敌军单体',
  enemy_all: '敌军全体',
  enemy_two: '敌军群体（2 人）',
  ally_single: '我军单体',
  ally_two: '我军群体（2 人）',
  ally_all: '我军全体',
};

const CLASS_TEXT = { 主动: '主动', 指挥: '指挥', 被动: '被动', 追击: '追击' };

/** 效果类型的「玩家话术」。key = kernel.effect_type */
const EFFECT_VERB = {
  PHYSICAL_DAMAGE: '兵刃攻击',
  STRATEGY_DAMAGE: '谋略攻击',
  CONTROL: '控制',
  BUFF: '增益',
  HEAL: '治疗',
};

/** 战法演出短句：同一战法固定一句（按 cfgId 取模），读起来像战报而不是日志。 */
const FLAVOR = {
  PHYSICAL_DAMAGE: [
    '刀锋斜掠，阵脚为之一挫',
    '铁骑压上，前排应声而乱',
    '一矛贯阵，血染征袍',
    '长驱直入，斩将夺旗',
  ],
  STRATEGY_DAMAGE: [
    '火起上风，烟尘蔽日',
    '奇谋既出，敌军自乱',
    '断其粮道，军心先溃',
    '算无遗策，一击中的',
  ],
  CONTROL: [
    '军令不行，进退失据',
    '阵型被冲散，士卒相顾失色',
    '鼓角失序，全军迟滞',
  ],
  BUFF: [
    '阵型一紧，士卒皆有死战之心',
    '旌旗所指，士气为之一振',
    '甲胄相击，杀声震野',
  ],
  HEAL: [
    '收拢残卒，重整旗鼓',
    '裹创再战，军势复振',
  ],
};

const CONTROL_TEXT = {
  dongyao: '动摇', zhenshe: '震慑', chenmo: '沉默', jiaoxie: '缴械', pantu: '叛逃',
};

const ARMS_TEXT = ['盾', '弓', '骑', '枪', '戟', '刀', '弩', '车', '象'];

function pick(list, seed) {
  if (!list || !list.length) return '';
  return list[Math.abs(Number(seed) || 0) % list.length];
}

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return (Math.round(n * 100) / 100) + '%';
}

/** 目标人数：单体 / 群体按 ui.target + ui.limit 推断；取不到就只说「敌军」。 */
function targetPhrase(skill) {
  const tt = String(skill?.kernel?.target_type || '');
  const base = TARGET_TEXT[tt] || '敌军';
  const limit = Number(skill?.ui?.limit) || 0;
  if (tt === 'enemy_all' && limit > 1) return `敌军全体（至多 ${limit} 人）`;
  return base;
}

/** 名字 → 战法。战报动画只带名字（内核事件只给 skill 字段），这里建一次索引。 */
let NAME_INDEX = null;
export function skillByName(name) {
  const key = String(name || '');
  if (!key) return null;
  if (!NAME_INDEX) {
    NAME_INDEX = new Map();
    for (const s of SKILLS) {
      const n = s.ui?.name || s.name;
      if (n && !NAME_INDEX.has(n)) NAME_INDEX.set(n, s);
    }
  }
  return NAME_INDEX.get(key) || null;
}

/**
 * 单个战法的可读档案。所有字段都是「给人看的」。
 * @param {number|string} key cfgId 或战法名
 * @param {number} lv 1..LEVEL_COUNT
 */
export function skillProfile(key, lv) {
  /* ★ 性能：推演一次要跑 4~5 场内核（主局 + 区间两条 + 变招对照），
     每场 buildBattleAnim 都会为每个动作查一次战法档案；缓存后
     单次推演从 89ms 回落到预算内（GDD §6.7 约束 3：≤50ms）。
     战法表在进程内是静态的（conf/skills.json 只读），缓存不会读到过期值。 */
  const ck = String(key) + '|' + Number(lv || 1);
  const hit = PROFILE_CACHE.get(ck);
  if (hit) return hit;
  const made = computeProfile(key, lv);
  if (made && PROFILE_CACHE.size < 8192) PROFILE_CACHE.set(ck, made);
  return made;
}

const PROFILE_CACHE = new Map();

/** 配置里的战法说明是带 %n% 占位符的模板：按该等级 effect_value 依次填数。
 *  「伤害率%n%%」+ effect_value [77.78] → 「伤害率77.78%」（尾部那个 % 是字面量）。 */
export function desText(s, level = 1) {
  const raw = String(s?.ui?.des || s?.des || '').trim();
  if (!raw) return '';
  if (!raw.includes('%n%')) return raw;
  const levels = s?.ui?.levels || [];
  const row = levels[Math.max(0, Math.min(levels.length - 1, Number(level) - 1))] || {};
  const vals = Array.isArray(row.effect_value) ? row.effect_value : [];
  let i = 0;
  return raw.replace(/%n%/g, () => (vals[i] != null ? String(vals[i++]) : '—'));
}

function computeProfile(key, lv) {
  const s = typeof key === 'string' ? skillByName(key) : skillById(Number(key));
  if (!s) return null;
  const level = Math.max(1, Math.min(LEVEL_COUNT, Math.trunc(Number(lv) || 1)));
  const l = s.ui?.levels?.[level - 1] || {};
  const k = s.kernel || {};
  const cls = CLASS_TEXT[k.skill_class] || k.skill_class || '战法';
  const eff = String(k.effect_type || '');
  const verb = EFFECT_VERB[eff] || '效果';
  const chance = Number(l.probability);
  const rate = Number((l.effect_value || [])[0]);
  const rounds = Number((l.effect_round || [])[0]) || 0;
  const target = targetPhrase(s);
  const arms = Array.isArray(s.ui?.arms) && s.ui.arms.length && s.ui.arms.length < 9
    ? s.ui.arms.map((a) => ARMS_TEXT[Number(a) - 1] || '兵').join('/')
    : '';

  /* 一句话效果：玩家最需要的那句「这个战法到底干什么」 */
  let effect;
  if (eff === 'PHYSICAL_DAMAGE' || eff === 'STRATEGY_DAMAGE') {
    effect = `对${target}发动一次${verb}，伤害率 ${pct(rate)}`
      + (eff === 'STRATEGY_DAMAGE' ? '（受智力影响）' : '（受武力影响）');
  } else if (eff === 'CONTROL') {
    const st = CONTROL_TEXT[String(k.control_state || '')] || '受制';
    effect = `使${target}陷入「${st}」`
      + (rounds > 0 ? `，持续 ${rounds} 回合` : '')
      + (Number(k.control_probability) > 0 ? `，命中率 ${pct(Number(k.control_probability) * 100)}` : '');
  } else if (eff === 'BUFF') {
    const terms = (k.bonus_terms || []).map((t) => `${t.name} ${t.value > 0 ? '+' : ''}${pct(Number(t.value) * 100)}`);
    effect = terms.length ? `自身${terms.join('，')}` : '自身获得增益';
  } else if (eff === 'HEAL') {
    effect = `为${target}恢复兵力，恢复率 ${pct(rate)}`;
  } else {
    /* ★ kernel 里没有 effect_type 的战法（指挥/被动类），退回配置里的官方说明。
       旧兜底写「对敌军生效」——玩家看完还是不知道它干了什么，等于没说。
       注意配置里的说明带 %n% 占位符（如「伤害率%n%%」），必须按该等级数值填掉，
       否则玩家会在面板上看到「恢复率%n%%」这种原始模板（探针实测确有）。 */
    effect = desText(s, level) || `对${target}生效`;
  }

  /* 触发条件：主动/追击看概率，指挥/被动常驻 */
  let trigger;
  if (cls === '被动') trigger = '常驻生效，无需发动';
  else if (cls === '指挥') trigger = '开战即生效，不受控制影响';
  else if (cls === '追击') trigger = `普通攻击命中后，${pct(chance)} 概率追加`;
  else trigger = `${pct(chance)} 概率发动` + (Number(k.prepare) > 0 ? `（需准备 ${k.prepare} 回合）` : '');

  const seed = Number(s.cfgId) || 0;
  return {
    cfgId: s.cfgId,
    name: s.ui?.name || s.name || '战法',
    cls,
    clsText: cls + '战法',
    target,
    arms,
    trigger,
    chance: Number.isFinite(chance) ? chance : null,
    rate: Number.isFinite(rate) ? rate : null,
    rounds,
    effect,
    /* 生动的一句，接在「谁发动了什么」之后 */
    /* ★ 措辞只按 cfgId 取，不掺等级：同一条战法在阵容栏、发动统计、逐回合日志里
       必须是同一句话（探针实测过同一战法出现两种说法，因为一处传了 lv、一处没传）。 */
    flavor: pick(FLAVOR[eff] || FLAVOR.BUFF, seed),
  };
}

/** 战法完整说明（详情展开用）：触发 + 效果 + 兵种限制。 */
export function skillExplain(profile) {
  if (!profile) return '';
  return [profile.trigger, profile.effect, profile.arms ? `限${profile.arms}兵种` : '']
    .filter(Boolean).join('；');
}

/**
 * 单个战斗动作 → 一句叙事。
 * @param {{t, fName, toName, skill, loss, amount, state, round}} a
 */
export function actSentence(a) {
  if (!a) return '';
  const f = a.fName || (a.fSide === 'd' ? '守军' : '我军');
  const to = a.toName || (a.toSide === 'd' ? '守军' : '我军');
  const p = a.skill ? skillProfile(a.skill, a.lv) : null;
  const eff = p ? p.effect : '';
  const flavor = p ? p.flavor : '';
  switch (a.t) {
    case 'prepare':
      return `${f} 蓄势，${a.skill} 将在下一回合发动`;
    case 'skill': {
      const hit = a.loss > 0 ? `，折其 ${fmt(a.loss)} 卒` : '';
      return `${f} 发动「${a.skill}」（${eff}）${hit}${flavor ? '——' + flavor : ''}`;
    }
    case 'hit':
      return a.skill && a.skill !== '普通攻击'
        ? `${f} 以「${a.skill}」击 ${to}，折其 ${fmt(a.loss)} 卒`
        : `${f} 挥军直进 → ${to}，折其 ${fmt(a.loss)} 卒`;
    case 'control':
      return `${f} 施压 ${to}，使其陷入「${a.state || '受制'}」`;
    case 'heal':
      return `${f} 为 ${to} 补员 ${fmt(a.amount)} 卒${flavor ? '——' + flavor : ''}`;
    case 'down':
      return `${to} 阵脚崩坏，全线溃退`;
    default:
      return '';
  }
}

function fmt(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 10000 ? (v / 10000).toFixed(1) + '万' : String(v);
}

/**
 * 战前推演的人话版。
 * 入参就是 previewAssault 的返回对象（含 forces / spreadLines / variantLines）。
 * @returns {{verdict, verdictTone, headline, rows, odds, tips, defenderNotes, myNotes}}
 */
export function previewNarrative(p) {
  if (!p || !p.ok) return null;
  const win = !!p.win;
  const draw = !!p.draw;
  const tone = win ? 'ok' : (draw ? 'warn' : 'bad');
  const verdict = win ? '可下' : (draw ? '相持' : '难下');
  const aTotal = Math.max(1, Number(p.aTotal) || 0);
  const dTotal = Math.max(1, Number(p.dTotal) || 0);
  const ratio = aTotal / dTotal;

  const headline = win
    ? `兵力 ${fmt(aTotal)} 对 ${fmt(dTotal)}，按现行阵容可攻下 ${p.target?.name || '目标'}。`
    : draw
      ? `兵力 ${fmt(aTotal)} 对 ${fmt(dTotal)}，双方都打不动，多半打成相持。`
      : `兵力 ${fmt(aTotal)} 对 ${fmt(dTotal)}（约 1 : ${(dTotal / aTotal).toFixed(1)}），正面强攻要吃大亏。`;

  const rows = [
    { k: '我军投入', v: `${fmt(aTotal)} 兵${p.deploy && p.deploy !== aTotal ? `（本役实出 ${fmt(p.deploy)}）` : ''}` },
    { k: '守军估算', v: `${fmt(dTotal)} 兵${p.intelTier >= 2 ? '（已侦察·精确）' : (p.intelTier === 1 ? '（估算 ±15%）' : '（未侦察 ±40%，实际可能更多）')}` },
    { k: '预计折损', v: `我军 −${fmt(p.aLoss)}（${Math.round(p.aLoss / aTotal * 100)}%）　歼敌 ${fmt(p.dLoss)}` },
    { k: '战后残余', v: `我军 ${fmt(sum(p.remain))} 兵` },
    { k: '行军', v: `程 ${fmt(p.km)} 里 · ${p.days} 日抵达（第 ${p.arriveDay} 日）` },
    { k: '兵种', v: p.counterNote || '双方兵种无克制' },
  ];

  /* 胜负手：把真正决定这场仗的 2~3 条挑出来，而不是让玩家自己算 */
  const tips = [];
  if (ratio < 1.25) {
    tips.push(`兵力偏少：至少带 ${fmt(Math.ceil(dTotal * 1.25))} 兵（守军的 1.25 倍）再打更稳。`);
  } else if (ratio >= 1.6) {
    tips.push(`兵力占优：可以试着减少出兵比例，留住城防。`);
  }
  if (p.counter > 0) tips.push(`兵种克制在我：守军兵力已被折算 −13%，这是可以打的一场。`);
  if (p.counter < 0) tips.push(`兵种被克：守军兵力折算 +15%，换一支配盾/枪的队伍损失会小很多。`);
  if (Number(p.fateMul) > 1) tips.push(`宿命组合生效（守军 ×${p.fateMul.toFixed(2)}），本队武将有额外加成。`);
  if (p.intelTier < 2) tips.push(`守军数字是传闻估算。先派斥候侦察，区间会收窄到 ±15%，推演才靠得住。`);
  if (p.spreadLines && p.spreadLines.length === 2) {
    const w = p.spreadLines[0], b = p.spreadLines[1];
    tips.push(`守军偏多时：${w.win ? '仍可下' : '打不动'}（折损 ${fmt(w.aLoss)}）；`
      + `守军偏少时：${b.win ? '可下' : '仍勉强'}（折损 ${fmt(b.aLoss)}）。`);
  }
  if (!win) tips.push('不打也可以：返回「集结 · 出击」换一座小城，或先补兵再来。推演与否都不影响出征。');

  const myNotes = (p.forces?.mine || []).map((g) => ({
    name: g.name,
    skills: (g.skills || []).map((s) => `${s.name}：${s.effect}`),
  }));
  const defenderNotes = (p.forces?.theirs || []).map((g) => ({
    name: g.name,
    skills: (g.skills || []).map((s) => `${s.name}：${s.effect}`),
  }));

  return { verdict, tone, headline, rows, tips, myNotes, defenderNotes, ratio };
}

function sum(list) {
  return (list || []).reduce((s, n) => s + Math.max(0, Number(n) || 0), 0);
}

/** 战报一句话战果（列表与详情共用，禁止各写一份）。 */
export function reportVerdict(r) {
  const place = r?.place || '目标城下';
  const a = Number(r?.aTotal) || 0;
  const d = Number(r?.dTotal) || 0;
  const aLoss = Math.max(0, Number(r?.aLoss) || 0);
  const dLoss = Math.max(0, Number(r?.dLoss) || 0);
  const res = Number(r?.result);
  if (res === 2) return `克${place}：我军 ${fmt(a)} 折 ${fmt(aLoss)}，歼敌 ${fmt(dLoss)}，城已易手。`;
  if (res === 0) return `攻${place}不利：我军 ${fmt(a)} 折 ${fmt(aLoss)}，歼敌 ${fmt(dLoss)}，被迫退兵。`;
  return `${place}相持：双方皆未破阵（我军折 ${fmt(aLoss)}，歼敌 ${fmt(dLoss)}）。`;
}
