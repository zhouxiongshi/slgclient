/**
 * 构建期生成六大面板的静态资料（运行时零外部依赖、不查 MySQL、不联网）。
 *
 * 输入：
 *   conf/skills.json              31 条 battle-kit 主战法原文
 *   conf/library-skills.json      20 条 battle-kit 库战法原文
 *   conf/campaign/strategy/map.json 战略地图 72 城
 *   web/.../general.json          客户端武将名录 368 位（游戏五维）
 *   D:/WorkBuddy/three-kingdoms/characters.csv  936 位史料档案（五维/字/履历/演义）
 *
 * 输出（全部落在 conf/panels/，打进离线包）：
 *   generals-lore.json   120 位精简武将档案
 *   skill-recipes.json   51 条战法的六源公开配方
 *   items.json           装备 / 材料 / 锻造配方 / 开局赠礼
 *   posts.json           五岗位 / 提案模板 / 数值红线
 *
 * 纪律：战法名称、类型、描述、数值一律从 conf/ 原文读取，本脚本不改写任何一个字；
 *       人物文本只从 CSV 读取，缺项写「史无明载」，不生成新的人设。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'conf', 'panels');
const LORE = 'D:/WorkBuddy/three-kingdoms/characters.csv';
mkdirSync(OUT, { recursive: true });

const readJson = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
const write = (name, obj) => {
  writeFileSync(resolve(OUT, name), JSON.stringify(obj, null, 2), 'utf8');
  console.log(`[panels-conf] ${name}: ${JSON.stringify(obj).length} bytes`);
};

/** 支持引号内逗号的极简 CSV 解析 */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const NONE = '史无明载';
const clean = (v) => {
  const s = String(v ?? '').trim();
  return !s || s === '-' || s === '无' || s === '不详' || s === '待考' ? NONE : s;
};

/* ---------------- 1) 武将档案：120 位，按史料五维均值择优 ---------------- */
const clientGeneralPath = resolve(ROOT, 'web/assets/resources/import/2b/2bb9964d-0938-48d1-b4a5-f2cabf1c1c2b.json');
const clientGenerals = existsSync(clientGeneralPath)
  ? (JSON.parse(readFileSync(clientGeneralPath, 'utf8'))?.[5]?.[0]?.[2]?.list || [])
  : [];
const gameByName = new Map();
for (const g of clientGenerals) if (!gameByName.has(g.name)) gameByName.set(g.name, g);

const csv = existsSync(LORE) ? parseCsv(readFileSync(LORE, 'utf8').replace(/^\uFEFF/, '')) : [];
const head = csv[0] || [];
const idx = (name) => head.indexOf(name);
const loreRows = csv.slice(1).filter((r) => r.length > 5).map((r) => ({
  name: clean(r[idx('姓名')]),
  zi: clean(r[idx('字')]),
  hometown: clean(r[idx('籍贯古称')]),
  faction: clean(r[idx('归属势力')]),
  era: clean(r[idx('活跃分期')]),
  brief: clean(r[idx('一句话履历')]),
  deeds: clean(r[idx('详细履历事迹')]),
  romance: clean(r[idx('演义形象')]),
  tags: clean(r[idx('游戏标签')]),
  stats: {
    统率: Number(r[idx('统率')]) || 0,
    武力: Number(r[idx('武力')]) || 0,
    智力: Number(r[idx('智力')]) || 0,
    政治: Number(r[idx('政治')]) || 0,
    魅力: Number(r[idx('魅力')]) || 0,
  },
})).filter((r) => r.name !== NONE);

const avg = (s) => (s.统率 + s.武力 + s.智力 + s.政治 + s.魅力) / 5;
// 只收录「游戏名录里真有」的人物，保证面板里点得到、招得到；按五维均值取前 120。
const chosen = loreRows
  .filter((r) => gameByName.has(r.name))
  .sort((a, b) => avg(b.stats) - avg(a.stats) || a.name.localeCompare(b.name, 'zh'))
  .slice(0, 120);

const lore = {
  version: 1,
  source: 'D:/WorkBuddy/three-kingdoms/characters.csv（构建期导出，运行时不依赖外部资料库）',
  note: '人物文本逐字取自资料库；缺项写「史无明载」，不生成新的人设。',
  count: chosen.length,
  list: chosen.map((r) => {
    const g = gameByName.get(r.name);
    return {
      name: r.name,
      cfgId: g.cfgId,
      zi: r.zi,
      hometown: r.hometown,
      faction: r.faction,
      era: r.era,
      brief: r.brief,
      deeds: r.deeds.slice(0, 220),
      romance: r.romance.slice(0, 220),
      tags: r.tags,
      historyStats: r.stats,
      gameStats: {
        force: g.force, strategy: g.strategy, defense: g.defense,
        speed: g.speed, destroy: g.destroy, star: g.star,
      },
    };
  }),
};
write('generals-lore.json', lore);

/* ---------------- 2) 51 条战法：六源公开配方 ---------------- */
const main = readJson('conf/skills.json').skills;
const lib = readJson('conf/library-skills.json').skills;
const all = [...main, ...lib];
const heroSkills = existsSync(resolve(ROOT, 'conf/campaign/hero-skills.json'))
  ? readJson('conf/campaign/hero-skills.json') : {};
const innateIds = new Set([19001, ...Object.values(heroSkills).map(Number)]);
const map = existsSync(resolve(ROOT, 'conf/campaign/strategy/map.json'))
  ? readJson('conf/campaign/strategy/map.json') : { cities: [] };
const cities = (map.cities || []).map((c) => c.name).filter(Boolean);
const names = lore.list.map((r) => r.name);
const pick = (arr, i, salt = 0) => arr.length ? arr[(i * 7 + salt * 13) % arr.length] : '陈留';

const EVENTS = [
  ['三让徐州', ['刘备', '陶谦', '关羽', '张飞']],
  ['煮酒论英雄', ['刘备', '曹操']],
  ['桃园结义', ['刘备', '关羽', '张飞']],
  ['火烧赤壁', ['周瑜', '诸葛亮', '黄盖']],
  ['草船借箭', ['诸葛亮', '鲁肃']],
  ['单刀会', ['关羽', '鲁肃']],
  ['白衣渡江', ['吕蒙', '陆逊']],
  ['七擒孟获', ['诸葛亮', '马岱']],
  ['空城计', ['诸葛亮', '司马懿']],
  ['辕门射戟', ['吕布', '刘备', '纪灵']],
  ['官渡之战', ['曹操', '袁绍', '许攸']],
  ['夷陵之战', ['陆逊', '刘备']],
];
const TRIGGER = { 1: '主动', 2: '指挥', 3: '突击', 4: '被动', 5: '内政' };
const EFFECT_TAG = { 1: '输出', 2: '增益', 3: '控制', 4: '恢复', 5: '内政' };

const recipes = all.map((s, i) => {
  const ui = s.ui || {};
  const need = 60 + (Number(s.cfgId) % 5) * 20;         // 60~140 残卷，确定性
  const sources = [];
  const innate = innateIds.has(Number(s.cfgId));

  // ① 自带战法（仅如实标注，不改写原文）
  if (innate) sources.push({
    type: 'innate', label: '自带战法', where: '招募即得', cost: '无',
    detail: '该武将自带，绑定不可卸；可在战法库查看 10 级数值曲线。',
  });

  // ② 战功研习：所有战法的兜底路径，绝不出现「错过就永远缺」
  sources.push({
    type: 'research', label: '战功研习', where: '藏书阁 / 战法库「去获取」',
    cost: `兵书残卷 ×${need}`,
    detail: `研习进度 0 → 100% 后解锁。残卷来自战报结算：以少胜多 +12、守城成功 +8、斩将 +6、普通胜利 +3。`,
    progressNeed: need,
  });

  // ③ 每四条轮换一条特色来源（师承 / 拾遗 / 传承 / 事件），信息全公开
  const kind = i % 4;
  if (kind === 0) {
    const mentor = pick(names, i, 1);
    sources.push({
      type: 'mentor', label: '师承', where: `酒馆 · 在野名士「${mentor}」`,
      cost: '阅历 200 ＋ 见面礼 金 500',
      detail: `与${mentor}亲密度达到「相识」即可学得，无需把${mentor}招入帐下；学得后直接解锁。`,
    });
  } else if (kind === 1) {
    const city = pick(cities, i, 2);
    sources.push({
      type: 'discovery', label: '拾遗', where: `攻陷「${city}」后探索古迹`,
      cost: '一次性（政令 1）',
      detail: `城池首次易主时可在府库领取战法秘卷，直接解锁；城池来源见战略沙盘。`,
    });
  } else if (kind === 2) {
    const donor = pick(names, i, 3);
    sources.push({
      type: 'inherit', label: '传承', where: '武将面板「传承」',
      cost: `一名冗余／退役武将（示例：${donor}）`,
      detail: '仅允许重复或退役武将；操作前自动备份存档，7 游戏日内可花金 2000 复原，绝不出现拆错核心将。',
    });
  } else {
    const [ev, cast] = EVENTS[i % EVENTS.length];
    sources.push({
      type: 'event', label: '事件战法', where: `演义事件「${ev}」`,
      cost: `需同时在帐下：${cast.join('、')}`,
      detail: '兑换后直接可用、无需研习；配方与所需武将开局即在战法库公开，兑换前会显示各人当前在编／委任状态。',
    });
  }

  // ④ 每 8 条再补一条师承，保证「至少两条路径」之外还有冗余
  if (i % 8 === 5) {
    const mentor = pick(names, i, 5);
    sources.push({
      type: 'mentor', label: '师承', where: `酒馆 · 在野名士「${mentor}」`,
      cost: '阅历 200 ＋ 见面礼 金 500',
      detail: `不必招到${mentor}也能拜师，避免流派被抽卡锁死。`,
    });
  }

  return {
    cfgId: s.cfgId,
    name: s.name,                       // 原文
    trigger: TRIGGER[s.trigger] || `类型${s.trigger}`,
    dir: s.dir,
    tags: (ui.include_effect || []).map((e) => EFFECT_TAG[e] || `效果${e}`),
    sourceGroup: s.cfgId >= 910000 ? '库战法' : '主战法',
    sources,
    guarantee: '研发（战功研习）为永久兜底，任何战法都不会因错过事件而永久缺失。',
  };
});

write('skill-recipes.json', {
  version: 1,
  source: 'conf/skills.json + conf/library-skills.json（battle-kit 原文，名称/类型/描述不改写）',
  principle: ['没有随机', '没有不可逆的意外', '没有死路（每条至少两条获取路径）'],
  count: recipes.length,
  recipes,
});

/* ---------------- 3) 装备 / 材料 / 锻造 ---------------- */
const SLOT = { weapon: '兵刃', armor: '护具', mount: '坐骑', tome: '兵书' };
// 加成按「基础五维的百分比」结算：单件 ≤8%，全套 ≤25%（由 panels.js 统一夹紧）
const itemDefs = [
  ['青龙偃月刀', 'weapon', '关羽', '先攻：首回合行动顺序提前', { force: 8 }, '桃园'],
  ['丈八蛇矛', 'weapon', '张飞', '免准备：准备战法少待一回合', { force: 7, speed: 1 }, '桃园'],
  ['方天画戟', 'weapon', '吕布', '对骑兵增伤（机制，不改伤害率）', { force: 8 }, '无双'],
  ['雌雄双股剑', 'weapon', '刘备', '守城时先手', { force: 5, strategy: 3 }, '桃园'],
  ['古锭刀', 'weapon', '孙坚', '击败敌军后追击判定提前', { force: 6, destroy: 2 }, '江东'],
  ['诸葛连弩', 'weapon', '诸葛亮', '主动战法目标 +1（机制）', { strategy: 8 }, '卧龙'],
  ['玄铁甲', 'armor', '典韦', '受到突击战法时减伤判定提前', { defense: 8 }, '虎卫'],
  ['鹤氅', 'armor', '诸葛亮', '计穷免疫改为「延后一回合结算」', { strategy: 6, defense: 2 }, '卧龙'],
  ['明光铠', 'armor', '曹丕', '守城时减伤（机制）', { defense: 7, force: 1 }, '魏武'],
  ['藤甲', 'armor', '孟获', '对火攻伤害判定单独结算', { defense: 6, destroy: 2 }, '南中'],
  ['赤兔', 'mount', '吕布', '行军 +1 格；先攻判定提前', { speed: 8 }, '无双'],
  ['的卢', 'mount', '刘备', '撤退时保留 5% 溃兵', { speed: 6, defense: 2 }, '桃园'],
  ['绝影', 'mount', '曹操', '战败时溃兵归营 +5%', { speed: 6, strategy: 2 }, '魏武'],
  ['爪黄飞电', 'mount', '曹操', '内政巡视范围 +1 城', { speed: 5, strategy: 3 }, '魏武'],
  ['孙子兵法', 'tome', '孙武', '内政：军备岗位产量 +3%', { strategy: 8 }, '兵家'],
  ['六韬', 'tome', '姜尚', '内政：农政岗位产量 +3%', { strategy: 5, defense: 3 }, '兵家'],
  ['孟德新书', 'tome', '曹操', '战功研习进度 +10%', { strategy: 7, force: 1 }, '魏武'],
  ['太平要术', 'tome', '张角', '恢复类战法目标 +1（机制）', { strategy: 6, defense: 2 }, '黄天'],
];
const items = itemDefs.map((d, i) => ({
  id: 300001 + i,
  name: d[0], slot: d[1], slotName: SLOT[d[1]],
  tale: `典出${d[2]}相关记载与演义。`,
  trait: d[3],
  bonusPct: d[4],
  set: d[5],
  forge: {
    cost: { iron: 300 + i * 20, wood: 120 + i * 10, gold: 200 },
    drawing: `图·${d[0]}`,
    success: 1,
    note: '100% 成功，词条固定可预览，不售卖图纸。',
  },
}));
write('items.json', {
  version: 1,
  redline: { perItemPct: 8, fullSetPct: 25, traitOnlyChanges: '时机/目标/条件，不改伤害率' },
  slots: Object.entries(SLOT).map(([k, v]) => ({ id: k, name: v })),
  banned: ['随机词条', '强化失败', '洗练', '无视/免疫类词条', '绑定不可卸', '付费入口'],
  items,
  materials: [
    { id: 400001, name: '兵书残卷', kind: 'scroll', note: '战报结算产出，用于战功研习' },
    { id: 400002, name: '精铁', kind: 'material', note: '锻造材料' },
    { id: 400003, name: '名匠图样', kind: 'material', note: '攻陷名城拾遗' },
    { id: 400004, name: '州郡信物', kind: 'relic', note: '剧情兑换，不加战力' },
  ],
  starterGift: [300001, 300007], // 青龙偃月刀、玄铁甲：开局各赠一件，府库与穿戴台立即可试
});

/* ---------------- 4) 岗位 / 提案 / 数值红线 ---------------- */
write('posts.json', {
  version: 1,
  redline: { maxBonusPct: 30, decayPerCity: 2, note: '岗位加成 ≤ 基础产出 30%，且随城池数递减，防后期滚雪球' },
  posts: [
    { id: 'agri', name: '农政', stat: '政治', resource: 'grain', desc: '屯田积谷，影响粮产与民心' },
    { id: 'commerce', name: '商事', stat: '智力', resource: 'gold', desc: '市易通商，影响金与商税' },
    { id: 'military', name: '军备', stat: '统率', resource: 'iron', desc: '冶铁造械，影响征兵工期与器械' },
    { id: 'defense', name: '城防', stat: '武力', resource: 'stone', desc: '缮甲筑城，影响守军与城防' },
    { id: 'personnel', name: '人事', stat: '魅力', resource: 'wood', desc: '招贤纳士，影响在野名士亲密度' },
  ],
  constraints: {
    morale: { init: 70, min: 0, max: 100, note: '民心过低触发减产' },
    order: { init: 70, min: 0, max: 100, note: '治安过低触发流寇事件' },
    corruption: { init: 5, min: 0, max: 100, note: '腐败随城数上升，人事岗位可压制' },
  },
  visibleRule: '出征中的武将，内政收益减半（明写在界面上，不做隐藏规则）。',
  proposals: [
    { id: 'levy', name: '急征', effect: '征兵工期 -20%', cost: '民心 -8、粮 -800', turns: 1 },
    { id: 'farm', name: '劝农', effect: '粮产 +25%', cost: '金 -600', turns: 2 },
    { id: 'repair', name: '修械', effect: '攻城伤害判定 +1 档', cost: '木 -800、铁 -400', turns: 1 },
    { id: 'amnesty', name: '安民', effect: '民心 +12、治安 +6', cost: '金 -500', turns: 1 },
    { id: 'audit', name: '整饬', effect: '腐败 -6', cost: '政令 -2', turns: 1 },
  ],
});

console.log('[panels-conf] done: 4 files');
