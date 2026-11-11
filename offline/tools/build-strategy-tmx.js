/**
 * 把《东汉十三州_城池模型图.tmx》转成游戏战略图配置。
 *
 * tmx 是这套地图的唯一权威来源：六层预渲染图 + 五个对象组
 *   10_城池·72座（含完整属性）
 *   11_路线·117条
 *   12_关隘·8座
 *   13_十三州部
 *   14_行军段·125段（关隘必经）
 *
 * 输出（offline/conf/campaign/strategy/）：
 *   id-registry.json   稳定 ID 注册表（增量维护，ID 永不复用）
 *   map.json           规范化战略图（城/路全部用稳定 ID）
 *   layers/*.png|jpg   tmx 的六层直接拷出来，供渲染与图层开关
 *   detail.json        城池/关隘/州名/路线等级/行军段 的史料与校验数据
 *
 * 换图、加城、删城、改名、挪位置：重跑本工具即可；已有 ID 与 AI 记忆不受影响。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStrategyMap, emptyRegistry } from '../server/domain/strategy-map.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TILED = 'D:/WorkBuddy/three-kingdoms/tiled';
const TMX = resolve(TILED, '东汉十三州_城池模型图.tmx');
const OUT = resolve(ROOT, 'conf', 'campaign', 'strategy');
const LAYERS = resolve(OUT, 'layers');
const REGISTRY_PATH = resolve(OUT, 'id-registry.json');

const PROVINCE_ID = new Map([
  ['司隶', 'sili'], ['豫州', 'yuzhou'], ['冀州', 'jizhou'], ['兖州', 'yanzhou'],
  ['徐州', 'xuzhou'], ['青州', 'qingzhou'], ['荆州', 'jingzhou'], ['扬州', 'yangzhou'],
  ['益州', 'yizhou'], ['凉州', 'liangzhou'], ['并州', 'bingzhou'], ['幽州', 'youzhou'], ['交州', 'jiaozhou'],
]);
const ATTR_KEYS = ['民心', '繁荣', '士气', '农业', '商业', '城防', '兵源', '水运', '治安', '开发度', '战略价值', '灾害风险'];

/** tmx 图层名 → 游戏里的图层键与文件名 */
const IMAGE_LAYERS = {
  '00_底图·东汉十三州水墨': ['base', 'layer_base.png'],
  '01_十三州部·古名': ['zhou', 'layer_zhou.png'],
  '02_分级路网·117条': ['road', 'layer_road.png'],
  '03_城池模型·72座（无边框贴合）': ['city', 'layer_city.png'],
  '04_关隘·8座（均在路线上）': ['pass', 'layer_pass.png'],
  '05_城名标注·汉末古名': ['name', 'layer_name.png'],
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function readTmx(file) {
  const xml = readFileSync(file, 'utf8');
  const layers = [];
  for (const m of xml.matchAll(/<imagelayer\b([^>]*)>([\s\S]*?)<\/imagelayer>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[1])?.[1] || '');
    const src = /<image\s+source="([^"]*)"/.exec(m[2])?.[1] || '';
    layers.push({ name, source: unescapeXml(src) });
  }
  const groups = [];
  for (const m of xml.matchAll(/<objectgroup\b([^>]*)>([\s\S]*?)<\/objectgroup>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[1])?.[1] || '');
    const objects = [];
    for (const o of m[2].matchAll(/<object\b([^>]*?)(?:\/>|>([\s\S]*?)<\/object>)/g)) {
      const attrs = o[1];
      const props = {};
      for (const p of (o[2] || '').matchAll(/<property\s+name="([^"]*)"\s+value="([^"]*)"/g)) {
        props[unescapeXml(p[1])] = unescapeXml(p[2]);
      }
      const objX = num(/x="([^"]*)"/.exec(attrs)?.[1]);
      const objY = num(/y="([^"]*)"/.exec(attrs)?.[1]);
      // tmx 的折线坐标相对对象原点，必须加上 x/y 才是画布坐标
      const polyRaw = /<polyline\s+points="([^"]*)"/.exec(o[2] || '')?.[1] || '';
      const points = polyRaw.trim()
        ? polyRaw.trim().split(/\s+/).map((pair) => {
          const [px, py] = pair.split(',').map(Number);
          return [Math.round((objX + px) * 10) / 10, Math.round((objY + py) * 10) / 10];
        })
        : [];
      objects.push({
        id: num(/id="([^"]*)"/.exec(attrs)?.[1]),
        name: unescapeXml(/name="([^"]*)"/.exec(attrs)?.[1] || ''),
        x: objX,
        y: objY,
        width: num(/width="([^"]*)"/.exec(attrs)?.[1]),
        height: num(/height="([^"]*)"/.exec(attrs)?.[1]),
        points,
        props,
      });
    }
    groups.push({ name, objects });
  }
  const props = {};
  for (const p of xml.matchAll(/<property\s+name="([^"]*)"\s+value="([^"]*)"/g)) {
    if (!(unescapeXml(p[1]) in props)) props[unescapeXml(p[1])] = unescapeXml(p[2]);
  }
  return { layers, groups, props };
}

const tmx = readTmx(TMX);
const groupByName = (frag) => tmx.groups.find((g) => g.name.includes(frag));
const gCity = groupByName('城池');
const gRoute = groupByName('路线');
const gPass = groupByName('关隘');
const gZhou = groupByName('州部');
const gMarch = groupByName('行军段');
for (const [label, g] of [['城池', gCity], ['路线', gRoute], ['关隘', gPass], ['州部', gZhou], ['行军段', gMarch]]) {
  if (!g) throw new Error(`tmx 缺少对象组：${label}`);
}

// ---------------------------------------------------------------- 城池
const cities = gCity.objects.map((o) => {
  const p = o.props;
  const alias = String(p['别名'] || '').split(/[、,;；]/).map((s) => s.trim()).filter(Boolean);
  const province = p['所属州'] || '';
  return {
    ref: p['城池ID'] || o.name,
    name: o.name,
    alias,
    province,
    provinceId: PROVINCE_ID.get(province) || null,
    level: num(p['等级']),
    levelName: p['等级名'] || '',
    adminLevel: p['行政等级'] || '',
    terrain: p['地形'] || '',
    isIsland: (p['城池规模'] || '').includes('岛'),
    // tmx 对象框是「左上角 + 宽高」，游戏里全部按中心点定位
    x: Math.round(((o.x ?? 0) + (o.width ?? 0) / 2) * 10) / 10,
    y: Math.round(((o.y ?? 0) + (o.height ?? 0) / 2) * 10) / 10,
    width: o.width ?? null,
    height: o.height ?? null,
    population: num(p['鼎立期估测人口']),
    attrs: Object.fromEntries(ATTR_KEYS.map((k) => [k, num(p[k])])),
    history: p['历史简介'] || '',
    gameName: p['游戏对应名'] || '',
    jun: p['所属郡国'] || '',
    today: p['今地'] || '',
    specialty: p['特产'] || '',
    arms: p['主要兵种'] || '',
    model: p['城池模型'] || '',
  };
});

// ---------------------------------------------------------------- 州治
const zhou = gZhou.objects.map((o) => ({
  name: o.name,
  x: o.x,
  y: o.y,
  cityCount: num(o.props['城数']),
  capital: o.props['治所'] || '',
}));
const capitalNames = new Set(zhou.map((z) => z.capital).filter(Boolean));
for (const c of cities) c.provinceCapital = capitalNames.has(c.name);

if (cities.length !== Number(tmx.props['城池数'] || cities.length)) {
  throw new Error(`城池数与 tmx 声明不一致：解析 ${cities.length} / 声明 ${tmx.props['城池数']}`);
}

// ---------------------------------------------------------------- 路线
const routesRaw = gRoute.objects.map((o) => {
  const p = o.props;
  if (!o.points || o.points.length < 2) throw new Error(`路线 ${o.name} 没有折线`);
  return {
    id: p.id || o.name.split(' ')[0],
    a: p.a || '',
    b: p.b || '',
    points: o.points,
    display_points: o.points,
    tier: p['等级'] || '',
    rank: { 驰道: 1, 水道: 2, 官道: 3, 郡道: 4 }[p['等级']] || 4,
    corridor: p['干线'] || '',
    km: num(p['里程km']),
    li: num(p['汉里']),
    days: num(p['日程']),
    history: p['史载'] || '',
    gates: String(p['途经关隘'] || '').split(/[、,;；]/).map((s) => s.trim()).filter(Boolean),
    sea: (p['等级'] || '') === '水道',
  };
});

// ---------------------------------------------------------------- 关隘
const passes = gPass.objects.map((o) => {
  const p = o.props;
  return {
    name: o.name,
    x: o.x,
    y: o.y,
    size: o.width ?? 15,
    kind: p['形制'] || '关隘',
    alias: p['别名'] || '',
    province: p['所属州'] || '',
    today: p['今地'] || '',
    guard: p['扼守'] || '',
    evolution: p['沿革'] || '',
    road: p['关联道路'] || '',
    roadId: p['路线ID'] || '',
    ends: [p['端城a'], p['端城b']].filter(Boolean),
    status: p['通行'] || '通行',
    arcPos: num(p['弧长位置']),
    deviation: num(p['偏离路线']),
  };
});
// tmx 的关隘是方框左上角，转成中心点；城名标注从关隘对象旁推一个位置
for (const pass of passes) {
  pass.size = pass.size || 31;
  pass.x = Math.round((pass.x + pass.size / 2) * 10) / 10;
  pass.y = Math.round((pass.y + pass.size / 2) * 10) / 10;
  pass.labelX = pass.x + pass.size * 0.55;
  pass.labelY = pass.y + pass.size * 0.45;
}

// ---------------------------------------------------------------- 行军段
const marchEdges = gMarch.objects.map((o) => {
  const p = o.props;
  return {
    id: p.id || o.name.split(' ')[0],
    routeId: p['路线ID'] || '',
    from: p['起点'] || '',
    to: p['终点'] || '',
    gate: p['关隘节点'] || '',
    km: num(p['里程km']),
    days: num(p['日程']),
  };
});

// ---------------------------------------------------------------- 稳定 ID
const registry = existsSync(REGISTRY_PATH)
  ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
  : emptyRegistry();

const { registry: newRegistry, map, report } = buildStrategyMap(cities, routesRaw, registry);

mkdirSync(OUT, { recursive: true });
writeFileSync(REGISTRY_PATH, JSON.stringify(newRegistry, null, 2), 'utf8');

const mapOut = {
  version: 3,
  edition: '东汉十三州·城池模型图',
  source: TMX,
  generatedAt: new Date().toISOString(),
  canvas: { w: 2400, h: 1350 },
  ...map,
};
writeFileSync(resolve(OUT, 'map.json'), JSON.stringify(mapOut, null, 2), 'utf8');

// ---------------------------------------------------------------- 六层图
mkdirSync(LAYERS, { recursive: true });
const layerFiles = {};
for (const layer of tmx.layers) {
  const hit = IMAGE_LAYERS[layer.name];
  if (!hit) continue;
  const [key, outName] = hit;
  const src = resolve(TILED, layer.source);
  if (!existsSync(src)) throw new Error(`tmx 图层图缺失：${src}`);
  const dst = resolve(LAYERS, outName);
  copyFileSync(src, dst);
  layerFiles[key] = `layers/${outName}`;
}
if (Object.keys(layerFiles).length !== Object.keys(IMAGE_LAYERS).length) {
  throw new Error(`图层数不符：只拷到 ${Object.keys(layerFiles).join(',')}`);
}

// ---------------------------------------------------------------- 史料与校验
const nameById = new Map(mapOut.cities.map((c) => [c.id, c.name]));
const refById = new Map(mapOut.cities.map((c) => [c.id, c.ref]));
const routeById = new Map(mapOut.routes.map((r) => [r.id, r]));

const cityDetail = {};
for (const c of cities) {
  const gameCity = mapOut.cities.find((x) => x.ref === c.ref);
  if (!gameCity) throw new Error(`城池 ${c.name}(${c.ref}) 没有拿到稳定 ID`);
  cityDetail[gameCity.id] = {
    ref: c.ref,
    jun: c.jun,
    today: c.today,
    model: c.model,
    specialty: c.specialty,
    arms: c.arms,
    population: c.population,
    w: c.width,
    h: c.height,
    history: c.history,
    gameName: c.gameName,
  };
}

const routeDetail = {};
for (const r of routesRaw) {
  const game = mapOut.routes.find((x) => x.id === r.id);
  if (!game) continue;
  routeDetail[r.id] = {
    tier: r.tier,
    rank: r.rank,
    km: r.km,
    li: r.li,
    days: r.days,
    corridor: r.corridor,
    history: r.history,
    gates: r.gates,
    fromName: r.a,
    toName: r.b,
  };
}

const marchNodes = [];
const seenNode = new Set();
for (const e of marchEdges) {
  for (const n of [e.from, e.to]) {
    if (!n || seenNode.has(n)) continue;
    seenNode.add(n);
    const cityHit = mapOut.cities.find((c) => c.name === n);
    marchNodes.push({ name: n, cityId: cityHit ? cityHit.id : null, gate: passes.some((p) => p.name === n) });
  }
}

/** 行军校验：只允许沿既有行军段推进，关隘封锁则其前后两段禁行。 */
function buildMarch() {
  const gateStatus = {};
  for (const p of passes) gateStatus[p.name] = p.status;
  return {
    rule: tmx.props['行军规则'] || '',
    noOffroad: true,
    connected: true,
    segments: num(tmx.props['行军段数']) ?? marchEdges.length,
    nodes: marchNodes,
    edges: marchEdges.map((e) => {
      const u = mapOut.cities.find((c) => c.name === e.from);
      const v = mapOut.cities.find((c) => c.name === e.to);
      return {
        id: e.id,
        routeId: e.routeId,
        from: e.from,
        to: e.to,
        fromCityId: u ? u.id : null,
        toCityId: v ? v.id : null,
        gate: e.gate,
        km: e.km,
        days: e.days,
      };
    }),
    gateStatus,
  };
}

const detail = {
  version: 3,
  canvas: { w: 2400, h: 1350 },
  source: TMX,
  layers: layerFiles,
  zhou,
  passes,
  cities: cityDetail,
  routes: routeDetail,
  march: buildMarch(),
};
writeFileSync(resolve(OUT, 'detail.json'), JSON.stringify(detail), 'utf8');

// ---------------------------------------------------------------- 报告
console.log('[strategy-tmx] 已从 tmx 重建战略图');
console.log(`  城池 ${mapOut.cities.length}（新增 ${report.added.length} 改名 ${report.renamed.length} 删除 ${report.removed.length}）`);
console.log(`  道路 ${mapOut.routes.length} · 警告 ${report.warnings.length}`);
for (const w of report.warnings.slice(0, 8)) console.log('  !', w);
for (const a of report.added.slice(0, 12)) console.log(`  + id=${a.id} ${a.name} (${a.ref})`);
for (const r of report.renamed.slice(0, 8)) console.log(`  ~ id=${r.id} ${r.from} → ${r.to}`);
for (const d of report.removed.slice(0, 12)) console.log(`  - id=${d.id} ${d.name}（墓碑）`);
for (const [k, v] of Object.entries(layerFiles)) console.log(`  图层 ${k.padEnd(5)} ${v}`);
console.log(`  关隘 ${passes.length} · 州名 ${zhou.length} · 行军段 ${marchEdges.length} · 行军节点 ${marchNodes.length}`);
const tiers = Object.values(routeDetail).reduce((a, r) => ((a[r.tier] = (a[r.tier] || 0) + 1), a), {});
console.log('  路线分级', JSON.stringify(tiers));
