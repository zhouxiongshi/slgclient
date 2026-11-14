#!/usr/bin/env node
/**
 * M3-3：六剧本城池分配生成器（GDD §4.5 / §12.1）。
 *
 * 输入：本脚本内嵌的「史实归属表」（州级基准 + 城级修正）。
 * 输出：conf/campaign/strategy/scenarios/*.json 六份。
 *
 * 四条开局校验（GDD §12.1，失败即构建失败）：
 *   V1 每城必有主（覆盖 72 城且无重复、无未知城/未知势力）；
 *   V2 每个有脑势力 1..12 城（汉廷 han 是无主归集，豁免上限——GDD §12.1 规则 1）；
 *   V3 玩家可选势力开局邻接 ≥2 个非己方城（保证有事可做）；
 *   V4 任意两势力之间路网连通（BFS 保证打得到）。
 *
 * 运行期接线（scenario.factions 替换 factionConf、开局决策弹窗）属 M3-4，
 * 本文件只产数据与校验。
 *
 * 用法：
 *   node tools/build-scenarios.mjs           # 生成 + 校验
 *   node tools/build-scenarios.mjs --check   # 只校验（不落盘）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_FILE = resolve(ROOT, 'conf/campaign/strategy/map.json');
const OUT_DIR = resolve(ROOT, 'conf/campaign/strategy/scenarios');

const map = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
const cityById = new Map(map.cities.map((c) => [c.id, c]));
const cityByName = new Map(map.cities.map((c) => [c.name, c.id]));

/* ------------------------------------------------------------------ */
/* 邻接表（无向；忽略指向不存在城的路线）                                */
/* ------------------------------------------------------------------ */
const adjacency = new Map(map.cities.map((c) => [c.id, []]));
for (const r of map.routes) {
  if (adjacency.has(r.from) && adjacency.has(r.to)) {
    adjacency.get(r.from).push(r.to);
    adjacency.get(r.to).push(r.from);
  }
}

/* ------------------------------------------------------------------ */
/* 史实归属表。prov：州级基准；fix：城级修正（后写覆盖先写）。            */
/* 势力 id 尽量复用 conf/campaign/strategy/factions.json 的 8 个 id，   */
/* 汉廷固定 han；剧本专属势力（黄巾/孙坚/孙策）用局部 id。               */
/* ------------------------------------------------------------------ */

const T40D_190 = {
  prov: {
    sili: ['sili'],
    yan: ['caocao'],
    ji: ['yuanshao'],
    qing: ['yuanshao'],
  },
  fix: {
    dongzhuo: ['长安', '雒阳', '安邑', '弘农', '高陵', '姑臧', '临泾', '狄道', '晋阳', '长子', '离石', '阴馆'],
    caocao: ['定陶', '昌邑', '陈留', '奉高', '濮阳'],
    yuanshao: ['邺', '乐成', '卢奴', '甘陵', '邯郸', '平原'],
    sunjian: ['宛', '陈', '临湘'],
  },
};

const SCENARIOS = [
  {
    id: 'huangjin-184',
    name: '黄巾 184',
    year: 184,
    playerDefault: ['han'],
    playerOptions: { han: '汉廷（皇甫嵩 / 卢植 / 朱儁 三选一视角）' },
    factions: [
      { id: 'han', name: '汉廷', persona: '皇甫嵩', color: '#8a7a52', home: '相', brain: false,
        blurb: '184 年朝廷平叛视角。刘备/曹操此时皆在其麾下为义军。', reuse: true },
      { id: 'huangjin', name: '黄巾', persona: '张角', color: '#b45309', home: '甘陵', brain: true,
        blurb: '苍天已死，岁在甲子。冀州南阳豫州三十六方同日而起。',
        special: '黄巾城不可常规开发，靠「圣所」产兵，镇压后转民城。' },
    ],
    prov: { jing: ['han'] },
    fix: { huangjin: ['甘陵', '卢奴', '邯郸', '宛', '陈'] },
    opening: {
      decision: 'siege',
      text: '黄巾三十六方同日而起：冀州张角主力、南阳张曼成、豫州波才。先救哪一路？',
      choices: ['北上冀州', '南下南阳', '先固守本城'],
    },
    specialRules: ['黄巾城不可常规开发，靠「圣所」产兵，镇压后转民城'],
    source: '后汉书·皇甫嵩传 / 三国志·武帝纪（184 布局）',
    confidence: '高',
  },
  {
    id: 'taodong-190',
    name: '讨董 190',
    year: 190,
    playerDefault: ['caocao'],
    playerOptions: { caocao: '曹操（陈留起兵）', yuanshao: '袁绍（联军盟主）', sunjian: '孙坚（先锋）' },
    factions: [
      { id: 'dongzhuo', name: '董卓', persona: '董卓', color: '#7f1d1d', home: '长安', brain: true,
        blurb: '废立天子，虎踞关中。西凉铁骑天下骇怕。', reuse: true },
      { id: 'caocao', name: '曹操', persona: '曹操', color: '#1d4ed8', home: '陈留', brain: true,
        blurb: '陈留散家财起兵，首倡义军。', reuse: true },
      { id: 'yuanshao', name: '袁绍', persona: '袁绍', color: '#6d28d9', home: '邺', brain: true,
        blurb: '四世三公，讨董盟主，门生故吏遍天下。', reuse: true },
      { id: 'sunjian', name: '孙坚', persona: '孙坚', color: '#b91c1c', home: '宛', brain: true,
        blurb: '江东猛虎，长沙起兵北上，斩华雄破吕布者。' },
      { id: 'han', name: '汉廷', persona: '汉廷', color: '#8a7a52', home: '相', brain: false,
        blurb: '未被卷入关东战事的州郡，无脑。', reuse: true },
    ],
    prov: T40D_190.prov,
    fix: T40D_190.fix,
    opening: {
      decision: 'ally',
      text: '袁绍会盟孟津，联军声望系于此战：攻董卓得声望，抢地盘失声望，声望 <0 被踢出联军。',
      choices: ['随盟主会攻雒阳', '屯兵观望', '先取邻郡扩地'],
    },
    specialRules: ['联军声望：攻董卓得，抢地盘失；声望 <0 被踢出联军'],
    source: '三国志·武帝纪 / 孙破虏传 / 后汉书·董卓传（190 布局）',
    confidence: '高',
  },
  {
    id: 'guandu-200',
    name: '官渡 200',
    year: 200,
    playerDefault: ['caocao'],
    playerOptions: { caocao: '曹操（弱势守方）', yuanshao: '袁绍（强势攻方）' },
    factions: [
      { id: 'caocao', name: '曹操', persona: '曹操', color: '#1d4ed8', home: '濮阳', brain: true,
        blurb: '奉天子以令不臣，兵少而精，粮仅支一年。', reuse: true },
      { id: 'yuanshao', name: '袁绍', persona: '袁绍', color: '#6d28d9', home: '邺', brain: true,
        blurb: '据冀幽青并四州，带甲十万，粮多而谋缓。', reuse: true },
      { id: 'sunce', name: '孙策', persona: '孙策', color: '#b91c1c', home: '吴', brain: true,
        blurb: '已定江东，密谋袭许迎天子——历史上遇刺而止。' },
      { id: 'han', name: '汉廷', persona: '刘表 / 刘璋 / 公孙度等', color: '#8a7a52', home: '相', brain: false,
        blurb: '荆州益州辽东交州各守其境，无脑。', reuse: true },
    ],
    prov: {
      yan: ['caocao'], yu: ['caocao'],
      ji: ['yuanshao'],
      yang: ['sunce'],
    },
    fix: {
      caocao: ['定陶', '昌邑', '陈留', '奉高', '濮阳', '相', '陈', '雒阳', '安邑', '弘农', '彭城', '下邳'],
      yuanshao: ['邺', '乐成', '卢奴', '甘陵', '邯郸', '蓟', '涿', '土垠', '昌辽', '高柳', '平原', '晋阳'],
      sunce: ['吴', '山阴', '宛陵'],
    },
    opening: {
      decision: 'grain',
      text: '袁军压境而我粮仅支一年：先征粮还是先破延津？乌巢粮仓是袁军命门。',
      choices: ['坚壁清野守官渡', '袭延津试锋', '回防许都护粮道'],
    },
    specialRules: ['乌巢粮仓为特殊节点，焚毁则袁军全线断粮'],
    source: '三国志·武帝纪 / 袁绍传（200 布局，乌巢前置）',
    confidence: '高',
  },
  {
    id: 'chibi-208',
    name: '赤壁 208',
    year: 208,
    playerDefault: ['sunquan'],
    playerOptions: { sunquan: '孙权（主战）', liubei: '刘备（依附）', caocao: '曹操（南压）' },
    factions: [
      { id: 'caocao', name: '曹操', persona: '曹操', color: '#1d4ed8', home: '雒阳', brain: true,
        blurb: '北方已定，挥师南下，与孙权「会猎于吴」。', reuse: true },
      { id: 'sunquan', name: '孙权', persona: '孙权', color: '#0e7490', home: '吴', brain: true,
        blurb: '承父兄之业据江东，战和未决。', reuse: true },
      { id: 'liubei', name: '刘备', persona: '刘备', color: '#166534', home: '江陵', brain: true,
        blurb: '当阳新败，依附刘琦，唯与吴联盟可图存。', reuse: true },
      { id: 'han', name: '汉廷', persona: '刘璋 / 马腾 / 公孙度等', color: '#8a7a52', home: '相', brain: false,
        blurb: '益凉幽并徐冀诸州在北方名义下或割据观望，无脑。', reuse: true },
    ],
    prov: {
      sili: ['caocao'], yan: ['caocao'], yu: ['caocao'],
      yang: ['sunquan'],
      jing: ['liubei'],
    },
    fix: {
      caocao: ['长安', '雒阳', '安邑', '弘农', '高陵', '定陶', '昌邑', '陈留', '奉高', '濮阳', '相', '陈'],
      sunquan: ['吴', '山阴', '宛陵', '南昌', '建安', '庐陵', '永宁'],
      liubei: ['临湘', '江陵', '临沅', '泉陵'],
      han: ['宛', '郴'],
    },
    opening: {
      decision: 'ally',
      text: '曹操檄文已至，与会猎于吴。主战主和，一战定三国雏形——下回合风向将明。',
      choices: ['联刘抗曹', '送质议和', '整军静观'],
    },
    specialRules: ['水战规则启用；疫病按季节概率；火攻需东南风预报（风向回合开始公示）'],
    source: '三国志·吴主传 / 周瑜传 / 先主传（208 布局，荆南四郡前置）',
    confidence: '高',
  },
  {
    id: 'yiling-221',
    name: '夷陵 221',
    year: 221,
    playerDefault: ['liubei'],
    playerOptions: { liubei: '刘备（复仇）', sunquan: '陆逊（国运）' },
    factions: [
      { id: 'liubei', name: '刘备', persona: '刘备', color: '#166534', home: '成都', brain: true,
        blurb: '称帝益州，倾国东征，为关羽复仇。', reuse: true },
      { id: 'sunquan', name: '孙权', persona: '陆逊', color: '#0e7490', home: '建业', brain: true,
        blurb: '袭荆州后据扬荆，陆逊督军拒蜀。', reuse: true },
      { id: 'caocao', name: '曹丕', persona: '曹丕', color: '#1d4ed8', home: '雒阳', brain: true,
        blurb: '代汉称帝，坐观吴蜀相争。', reuse: true },
      { id: 'han', name: '汉廷', persona: '公孙恭 / 士燮等', color: '#8a7a52', home: '相', brain: false,
        blurb: '幽并凉徐冀青交州残存势力，无脑。', reuse: true },
    ],
    prov: {
      yi: ['liubei'],
      yang: ['sunquan'], jing: ['sunquan'],
      sili: ['caocao'], yan: ['caocao'], yu: ['caocao'],
    },
    fix: {
      liubei: ['成都', '南郑', '江州', '朱提', '武阳', '汉嘉', '滇池', '邛都', '阴平道'],
      sunquan: ['吴', '山阴', '宛陵', '南昌', '建安', '庐陵', '永宁', '临湘', '江陵', '临沅', '泉陵', '郴'],
      caocao: ['长安', '雒阳', '安邑', '弘农', '高陵', '定陶', '昌邑', '陈留', '奉高', '濮阳', '相', '陈'],
      han: ['宛'],
    },
    opening: {
      decision: 'siege',
      text: '倾国东征：山地连营补给距离惩罚 ×2，七百里连营可被火攻。打到夷陵还是稳住巫峡？',
      choices: ['水陆并进直取江陵', '依山连营缓推', '屯驻巫峡防魏'],
    },
    specialRules: ['山地连营：补给距离惩罚 ×2；七百里连营可被火攻'],
    source: '三国志·先主传 / 陆逊传（221 布局）',
    confidence: '高',
  },
  {
    id: 'sanfen-229',
    name: '三分 229',
    year: 229,
    playerDefault: ['liubei'],
    playerOptions: { liubei: '蜀（北伐）', caocao: '魏（守成）', sunquan: '吴（称帝）' },
    factions: [
      { id: 'liubei', name: '蜀汉', persona: '诸葛亮', color: '#166534', home: '成都', brain: true,
        blurb: '诸葛亮复出祁山，北伐以攻代守。', reuse: true },
      { id: 'caocao', name: '曹魏', persona: '曹叡', color: '#1d4ed8', home: '雒阳', brain: true,
        blurb: '据中原十二城，守成而国力最强。', reuse: true },
      { id: 'sunquan', name: '东吴', persona: '孙权', color: '#0e7490', home: '建业', brain: true,
        blurb: '称帝建业，据扬荆十二城。', reuse: true },
      { id: 'han', name: '汉廷', persona: '辽东 / 凉并边郡', color: '#8a7a52', home: '相', brain: false,
        blurb: '幽并凉徐冀青交州与南阳，无脑。', reuse: true },
    ],
    prov: {
      yi: ['liubei'],
      yang: ['sunquan'], jing: ['sunquan'],
      sili: ['caocao'], yan: ['caocao'], yu: ['caocao'],
    },
    fix: {
      liubei: ['成都', '南郑', '江州', '朱提', '武阳', '汉嘉', '滇池', '邛都', '阴平道'],
      sunquan: ['吴', '山阴', '宛陵', '南昌', '建安', '庐陵', '永宁', '临湘', '江陵', '临沅', '泉陵', '郴'],
      caocao: ['长安', '雒阳', '安邑', '弘农', '高陵', '定陶', '昌邑', '陈留', '奉高', '濮阳', '相', '陈'],
      han: ['宛'],
    },
    opening: {
      decision: 'grain',
      text: '北伐粮道千里，陇右麦熟在即：抢收陇麦还是先断魏军粮道？',
      choices: ['抢收陇麦', '断魏粮道', '固守汉中养兵'],
    },
    specialRules: ['国力差距大，弱方靠关隘与粮道守；北伐/防守目标不同'],
    source: '三国志·后主传（建兴七年）/ 晋书·宣帝纪（229 布局）',
    confidence: '高',
  },
];

/* ------------------------------------------------------------------ */
/* 生成归属映射                                                          */
/* ------------------------------------------------------------------ */
const PROV_KEY = {
  司隶: 'sili', 益州: 'yi', 交州: 'jiao', 兖州: 'yan', 冀州: 'ji', 凉州: 'liang',
  并州: 'bing', 幽州: 'you', 徐州: 'xu', 扬州: 'yang', 荆州: 'jing', 豫州: 'yu', 青州: 'qing',
};

function resolveOwnership(sc) {
  const owner = new Map();
  // 州级基准
  for (const c of map.cities) {
    const key = PROV_KEY[c.province];
    const fid = (sc.prov[key] && sc.prov[key][0]) || 'han';
    owner.set(c.id, fid);
  }
  // 城级修正（列表按顺序展开，同名冲突即错）
  for (const [fid, names] of Object.entries(sc.fix || {})) {
    for (const n of names) {
      const id = cityByName.get(n);
      if (id == null) throw new Error(`[${sc.id}] 城级修正引用不存在的城: ${n}`);
      if (owner.get(id) !== fid) owner.set(id, fid);
    }
  }
  return owner;
}

/* ------------------------------------------------------------------ */
/* 四条校验（GDD §12.1）                                                */
/* ------------------------------------------------------------------ */
export function validateScenario(sc, ownership) {
  const errs = [];
  const warns = [];
  const fIds = new Set(sc.factions.map((f) => f.id));
  const brainIds = new Set(sc.factions.filter((f) => f.brain).map((f) => f.id));

  // V1 每城必有主
  if (ownership.size !== map.cities.length) errs.push(`V1 归属数 ${ownership.size} != 城数 ${map.cities.length}`);
  for (const [id, fid] of ownership) {
    if (!fIds.has(fid)) errs.push(`V1 城 ${id} 归属未知势力 ${fid}`);
  }
  for (const f of sc.factions) {
    if (f.brain && ![...ownership.values()].includes(f.id)) {
      errs.push(`V2 有脑势力 ${f.id} 零城`);
    }
  }

  // V2 有脑势力 1..12 城（汉廷豁免）
  const counts = {};
  for (const fid of ownership.values()) counts[fid] = (counts[fid] || 0) + 1;
  for (const [fid, n] of Object.entries(counts)) {
    if (fid === 'han') continue;
    if (n < 1) errs.push(`V2 势力 ${fid} 零城`);
    else if (n > 12) errs.push(`V2 势力 ${fid} ${n} 城超上限 12`);
    if (brainIds.has(fid) && n < 1) errs.push(`V2 有脑势力 ${fid} 无城`);
  }

  // V3 玩家势力邻接 ≥2 个非己方城
  const playerIds = sc.playerDefault || [];
  for (const pid of playerIds) {
    const mine = [...ownership.entries()].filter(([, f]) => f === pid).map(([id]) => id);
    if (!mine.length) { errs.push(`V3 玩家势力 ${pid} 无城`); continue; }
    const neighborOthers = new Set();
    for (const id of mine) {
      for (const nb of adjacency.get(id) || []) {
        if (ownership.get(nb) !== pid) neighborOthers.add(nb);
      }
    }
    if (neighborOthers.size < 2) errs.push(`V3 玩家势力 ${pid} 邻接非己城仅 ${neighborOthers.size} (<2)`);
  }

  // V4 任意两势力路网连通（含汉廷）
  const byFaction = {};
  for (const [id, fid] of ownership) (byFaction[fid] = byFaction[fid] || []).push(id);
  const fList = Object.keys(byFaction);
  for (let i = 0; i < fList.length; i += 1) {
    for (let j = i + 1; j < fList.length; j += 1) {
      const a = fList[i]; const b = fList[j];
      const seen = new Set(byFaction[a]);
      const queue = [...byFaction[a]];
      let ok = false;
      while (queue.length && !ok) {
        const x = queue.shift();
        for (const y of adjacency.get(x) || []) {
          if (seen.has(y)) continue;
          if (byFaction[b].includes(y)) { ok = true; break; }
          seen.add(y);
          queue.push(y);
        }
      }
      if (!ok) errs.push(`V4 势力 ${a} 与 ${b} 路网不连通`);
    }
  }

  // 附加警告：开局待处理事务预算（GDD §3.1 / §4.5：>3 条违反点击预算）
  if (sc.factions.filter((f) => f.brain).length > 4) {
    warns.push('有脑势力 >4，旬结算 NPC 决策量大，注意性能');
  }
  return { errs, warns, counts };
}

function buildScenarioDoc(sc) {
  const ownership = resolveOwnership(sc);
  const { errs, warns, counts } = validateScenario(sc, ownership);
  if (errs.length) {
    throw new Error(`[${sc.id}] 校验失败:\n  ${errs.join('\n  ')}`);
  }
  const cityOwner = Object.fromEntries(
    [...ownership.entries()].sort((a, b) => a[0] - b[0]).map(([id, fid]) => [String(id), fid]),
  );
  return {
    id: sc.id,
    name: sc.name,
    year: sc.year,
    playerDefault: sc.playerDefault,
    playerOptions: sc.playerOptions,
    factions: sc.factions,
    cityOwner,
    opening: sc.opening,
    specialRules: sc.specialRules,
    source: sc.source,
    confidence: sc.confidence,
    reviewed: false, // 出戏防线第 4 闸：与 events.json 同款，待人工签核
    meta: {
      cityCount: ownership.size,
      factionCityCounts: counts,
      validatedAt: new Date().toISOString().slice(0, 10),
      validator: 'tools/build-scenarios.mjs (V1..V4)',
    },
    _warns: warns,
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */
const checkOnly = process.argv.includes('--check');
const results = [];
for (const sc of SCENARIOS) {
  const doc = buildScenarioDoc(sc);
  results.push({ sc, doc });
  const brainSummary = Object.entries(doc.meta.factionCityCounts)
    .filter(([fid]) => fid !== 'han')
    .map(([fid, n]) => `${fid}:${n}`)
    .join(' ');
  console.log(`ok ${sc.id}  ${sc.name}  城池分配 ${brainSummary}  han:${doc.meta.factionCityCounts.han || 0}${doc._warns.length ? `  warn: ${doc._warns.join(';')}` : ''}`);
  if (!checkOnly) {
    mkdirSync(OUT_DIR, { recursive: true });
    const out = { ...doc };
    delete out._warns;
    const file = resolve(OUT_DIR, `${sc.id}.json`);
    const next = `${JSON.stringify(out, null, 1)}\n`;
    /* 只有 validatedAt 变了就不算「内容有过改动」——不写盘。
       （否则每跑一次校验，6 个剧本文件全部变成「已修改」，check-release 的
         「工作区干净」永远红；打一局游戏、跑一次验收都会把工作树弄脏，
         玩家/开发者只能靠 git checkout 反复擦屁股。） */
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* 首次生成，照写 */ }
    const noStamp = (t) => t
      .replace(/\r\n/g, '\n')                       /* 工作区是 CRLF、生成是 LF，不归一化会永远判「不同」 */
      .replace(/"validatedAt": "[^"]*",?/, '');
    if (!prev || noStamp(prev) !== noStamp(next)) writeFileSync(file, next, 'utf8');
  }
}
console.log(`\n${checkOnly ? 'check' : 'build'} 完成：${results.length}/6 剧本`);
if (checkOnly && !existsSync(OUT_DIR)) {
  console.error('scenarios/ 目录不存在');
  process.exit(1);
}
