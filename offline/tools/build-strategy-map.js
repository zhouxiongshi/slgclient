/**
 * 把《东汉十三州·城池模型图》资料数据转换成游戏战略层配置。
 *
 * 输入（D:/WorkBuddy/three-kingdoms/tiled/data/）：
 *   城市模型版_地图数据.json   meta/rule/cities[73]/routes[118]/zhou[13]/regions
 *
 * 输出（offline/conf/campaign/strategy/）：
 *   id-registry.json   稳定 ID 注册表（增量维护，ID 永不复用）
 *   map.json           规范化战略图（城市/道路全部用稳定 ID）
 *
 * 后续在地图上加城、删城、改名、挪位置：重跑本工具即可，
 * 已有 ID 与 AI 记忆不受影响；报告会列出新增/删除/改名清单。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStrategyMap, emptyRegistry } from '../server/domain/strategy-map.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = 'D:/WorkBuddy/three-kingdoms/tiled/data';
const SOURCE_FILE = resolve(DATA, '城市模型版_地图数据.json');
const OUT = resolve(ROOT, 'conf', 'campaign', 'strategy');
const REGISTRY_PATH = resolve(OUT, 'id-registry.json');

const world = JSON.parse(readFileSync(SOURCE_FILE, 'utf8'));
const citiesRaw = world.cities;
const routesRaw = world.routes;
const zhou = world.zhou || [];

const provinceIdByName = new Map([
  ['司隶', 'sili'], ['豫州', 'yuzhou'], ['冀州', 'jizhou'], ['兖州', 'yanzhou'],
  ['徐州', 'xuzhou'], ['青州', 'qingzhou'], ['荆州', 'jingzhou'], ['扬州', 'yangzhou'],
  ['益州', 'yizhou'], ['凉州', 'liangzhou'], ['并州', 'bingzhou'], ['幽州', 'youzhou'], ['交州', 'jiaozhou'],
]);
const capitalByProvince = new Map(zhou.map((z) => [z.州, z.治所]));

const ATTR_KEYS = ['民心', '繁荣', '士气', '农业', '商业', '城防', '兵源', '水运', '治安', '开发度', '战略价值', '灾害风险'];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

const incoming = citiesRaw.map((c) => {
  const alias = String(c['别名'] || '').split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
  const provinceId = provinceIdByName.get(c['所属州']) || null;
  const capitalName = provinceId ? capitalByProvince.get(c['所属州']) : null;
  return {
    ref: c['城池ID'],
    name: c['城名'],
    alias,
    province: c['所属州'],
    provinceId,
    provinceCapital: !!capitalName && (c['城名'] === capitalName || alias.includes(capitalName)),
    level: num(c['等级']),
    levelName: c['等级名'] || '',
    adminLevel: c['行政等级'] || '',
    terrain: c['地形'] || '',
    isIsland: (c['类别'] || '').includes('岛屿'),
    x: num(c['显示x']),
    y: num(c['显示y']),
    population: num(c['鼎立期估测人口']),
    attrs: Object.fromEntries(ATTR_KEYS.map((k) => [k, num(c[k])])),
    history: c['历史简介'] || '',
    gameName: c['游戏对应名'] || '',
  };
});

const registry = existsSync(REGISTRY_PATH)
  ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
  : emptyRegistry();

const { registry: newRegistry, map, report } = buildStrategyMap(incoming, routesRaw, registry);

mkdirSync(OUT, { recursive: true });
writeFileSync(REGISTRY_PATH, JSON.stringify(newRegistry, null, 2), 'utf8');
writeFileSync(resolve(OUT, 'map.json'), JSON.stringify({
  version: 2,
  edition: '东汉十三州·城池模型图',
  source: SOURCE_FILE,
  generatedAt: new Date().toISOString(),
  canvas: { w: 2400, h: 1350 },
  ...map,
}, null, 2), 'utf8');

console.log(`城市 ${map.cities.length}（新增 ${report.added.length} 改名 ${report.renamed.length} 删除 ${report.removed.length}）`);
console.log(`道路 ${map.routes.length}，警告 ${report.warnings.length}`);
for (const w of report.warnings.slice(0, 12)) console.log('  !', w);
for (const a of report.added.slice(0, 20)) console.log(`  + id=${a.id} ${a.name} (${a.ref || '无ID'})`);
for (const r of report.renamed.slice(0, 12)) console.log(`  ~ id=${r.id} ${r.from} → ${r.to}`);
for (const d of report.removed.slice(0, 20)) console.log(`  - id=${d.id} ${d.name}（墓碑）`);
