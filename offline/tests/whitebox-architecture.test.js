/* 白盒 WB · 架构禁令与不变量（依据 docs/ARCHITECTURE.md）
 *
 * 这一组不看功能对不对，只看「代码有没有长歪」：依赖方向、零环、
 * 单一事实源、随机来源、种子唯一。所有断言都是静态扫描，
 * 一律先剥注释再匹配 —— 否则注释里写个 Math.random 就会假红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOMAIN = join(ROOT, 'server', 'domain');

/** 剥掉 // 行注释与 /* *\/ 块注释，保留代码。静态断言必须先过这一层。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function read(p) {
  return readFileSync(p, 'utf8');
}

/** 解析某文件的领域内部依赖（只认 './xxx.js' 相对引用）。 */
function domainDeps(file) {
  const src = stripComments(read(join(DOMAIN, file)));
  return [...src.matchAll(/from '\.\/([a-z0-9-]+)\.js'/g)].map((m) => `${m[1]}.js`);
}

const DOMAIN_FILES = readdirSync(DOMAIN).filter((f) => f.endsWith('.js'));

test('WB-01 领域层零循环依赖（ARCH §2「同一层不互相调用」，实际用环检测兜底）', () => {
  const graph = new Map();
  for (const f of DOMAIN_FILES) graph.set(f, domainDeps(f));

  const state = new Map(); // 1=在栈上 2=已完成
  const stack = [];
  const cycles = [];

  function visit(node) {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (!graph.has(dep)) continue; // 指向领域层之外（配置/地图数据）不算
      if (state.get(dep) === 1) {
        const at = stack.indexOf(dep);
        cycles.push([...stack.slice(at), dep].join(' → '));
      } else if (!state.get(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  }
  for (const f of DOMAIN_FILES) if (!state.get(f)) visit(f);

  assert.deepEqual(cycles, [], `领域层出现循环依赖：\n${cycles.join('\n')}`);
  assert.ok(DOMAIN_FILES.length >= 30, `领域模块数应 ≥30，实际 ${DOMAIN_FILES.length}`);
});

test('WB-02 零依赖叶子只许依赖纯函数叶子（ARCH §9/§9.1/§9.16 的依赖禁令）', () => {
  /* 「零依赖叶子」的实际口径：不 import strategy.js / panels.js / city-econ.js
     （这三个互相已经成环，挂进来就等于把环焊死）。纯函数叶子之间可以互相引用，
     例如 captive-rules 只读 oath.js 的 protagonistStat —— 这一点已在文件头注记，
     属已声明的例外，不算违规。 */
  const FORBIDDEN = ['strategy.js', 'panels.js', 'city-econ.js', 'interaction.js'];
  const LEAVES = [
    'interior-task.js', 'supply.js', 'relation.js', 'map-lod.js', 'levy.js',
    'failstate.js', 'knobs.js', 'fate-groups.js', 'event-dsl.js', 'event-engine.js',
    'oath.js', 'captive-rules.js',
  ];
  const bad = [];
  for (const leaf of LEAVES) {
    for (const dep of domainDeps(leaf)) {
      if (FORBIDDEN.includes(dep)) bad.push(`${leaf} → ${dep}`);
    }
  }
  assert.deepEqual(bad, [], `叶子模块反向依赖了环内模块：\n${bad.join('\n')}`);
});

test('WB-03 剧情/履历/宿命三条禁令（ARCH §5 不许出现的依赖）', () => {
  const cases = [
    ['campaign.js', ['battle.js', 'strategy.js'], '剧情只发「开打」命令，不许 import 战斗/战略'],
    ['chronicle.js', ['battle.js', 'economy.js'], '履历只读死亡事实，不 import 战斗/经济'],
    ['fate.js', ['strategy-map.js', 'economy.js'], '宿命只管人在不在链上，不 import 地图/经济'],
  ];
  const bad = [];
  for (const [file, forbidden, why] of cases) {
    const deps = domainDeps(file);
    for (const f of forbidden) if (deps.includes(f)) bad.push(`${file} → ${f}（${why}）`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('WB-04 注入层零 Math.random（ARCH §8 硬约束 3，剥注释后匹配）', () => {
  const files = ['interaction-ui.js', 'panels-ui.js', 'skills.js', 'ui-shell.js'];
  const bad = [];
  for (const f of files) {
    const body = stripComments(read(join(ROOT, 'server', f)));
    if (/Math\.random\s*\(/.test(body)) bad.push(f);
  }
  assert.deepEqual(bad, [], `注入层出现不可复现的随机源：${bad.join(', ')}`);
});

test('WB-05 战斗种子只有一个公式（ARCH §9 不变量 1）', () => {
  /* 只许 battle.js 定义 battleSeedFor；别处只能调用。定义处是 `export function battleSeedFor`。 */
  const files = ['battle.js', 'skills.js', 'handlers.js', 'index.js',
    ...DOMAIN_FILES.map((f) => join('domain', f))];
  const defs = [];
  for (const rel of files) {
    const src = stripComments(read(join(ROOT, 'server', rel)));
    if (/export\s+function\s+battleSeedFor|function\s+battleSeedFor\s*\(/.test(src)) defs.push(rel);
  }
  assert.deepEqual(defs, ['battle.js'], `battleSeedFor 必须唯一定义在 battle.js，实际：${defs.join(', ')}`);
});

test('WB-06 双账本写入切断（ARCH §9.1 口径 1：粮只许汇总写入）', () => {
  /* 禁止 `resources[...].grain = ...` 直接赋值；唯一写入口是 refreshGrainSummary
     与 spendFactionGrain / creditFactionGrain 这三个函数内部。 */
  const files = ['strategy.js', 'march.js', 'economy.js', 'city-econ.js', 'handlers.js'];
  const bad = [];
  for (const rel of files) {
    const p = rel.includes('/') ? join(ROOT, 'server', rel) : join(ROOT, 'server', 'domain', rel);
    let src;
    try { src = stripComments(read(p)); } catch { continue; }
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/resources\[[^\]]+\]\.grain\s*=[^=]/.test(line)) bad.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `resources[].grain 被直接赋值（应走 refreshGrainSummary/credit）：${bad.join(', ')}`);
});

test('WB-07 客户端不复算数值（ARCH §5：画面只显示服务器推来的数）', () => {
  /* 注入层里不该出现服务端公式的特征符号：battleSeedFor / resolveBattle / 日产公式。 */
  const forbidden = [/battleSeedFor\s*\(/, /resolveBattle\s*\(/, /runBattle\s*\(/, /accrue\w*\s*\(/];
  const files = ['interaction-ui.js', 'panels-ui.js', 'skills.js', 'ui-shell.js'];
  const bad = [];
  for (const f of files) {
    const body = stripComments(read(join(ROOT, 'server', f)));
    for (const re of forbidden) if (re.test(body)) bad.push(`${f} 命中 ${re}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('WB-08 事件 DSL 是白名单闸门（ARCH §9.6：未知字段与算子必须 throw）', async () => {
  const { evaluateEvent } = await import('../server/domain/event-dsl.js');
  const ctx = { turn: 1, year: 184, season: 'spring', resource: () => 100 };
  /* 未知字段：白名单外一律拒绝，不做「不认识就当假的」静默放过 */
  assert.throws(() => evaluateEvent({ 不存在的字段: 1 }, ctx), /未知|unknown|白名单/i);
  /* 未知算子：resource 走 cmpValue */
  assert.throws(() => evaluateEvent({ resource: { grain: { '≈': 1 } } }, ctx), /算子|operator|未知|unknown/i);
  /* 多键算子对象也非法 */
  assert.throws(() => evaluateEvent({ resource: { grain: { '>=': 1, '<=': 9 } } }, ctx), /算子|operator/i);
  /* 非数字非对象 */
  assert.throws(() => evaluateEvent({ turnMin: 'abc' }, ctx), /单算子|算子|数字/i);
  /* 合法路径 */
  assert.equal(evaluateEvent({ turnMin: 1 }, ctx), true);
  assert.equal(evaluateEvent({ turnMin: 5 }, ctx), false);
  assert.equal(evaluateEvent({ resource: { grain: { '>=': 50 } } }, ctx), true);
});

test('WB-08b 时间/边界字段双写法等价（裸数字与单算子对象都生效，不再静默恒真）', async () => {
  const { evaluateEvent, validateEventSchema } = await import('../server/domain/event-dsl.js');
  const ctx = { turn: 1, year: 190, season: 'spring', resource: () => 100 };

  /* 裸数字：turnMin/yearMin 是「宽松下界」 */
  assert.equal(evaluateEvent({ yearMin: 184 }, ctx), true);
  assert.equal(evaluateEvent({ yearMin: 200 }, ctx), false);
  assert.equal(evaluateEvent({ yearMax: 184 }, ctx), false);
  assert.equal(evaluateEvent({ turnMax: 1 }, ctx), true);

  /* 对象写法必须与裸数字等价 —— P3-03 修的就是这条：
     修之前 { yearMin: {'>=': 999} } 会被静默忽略（恒为 true），约束彻底失效。 */
  assert.equal(evaluateEvent({ yearMin: { '>=': 184 } }, ctx), true);
  assert.equal(evaluateEvent({ yearMin: { '>=': 999 } }, ctx), false, '对象写法必须真的生效');
  assert.equal(evaluateEvent({ yearMax: { '<': 200 } }, ctx), true);
  assert.equal(evaluateEvent({ turnMin: { '>': 1 } }, ctx), false);

  /* GDD §8.2 的字段名 turn / year 也受支持：裸数字=精确匹配，对象走算子 */
  assert.equal(evaluateEvent({ year: 190 }, ctx), true);
  assert.equal(evaluateEvent({ year: 184 }, ctx), false);
  assert.equal(evaluateEvent({ turn: { '>=': 1 } }, ctx), true);
  assert.equal(evaluateEvent({ turn: { '>=': 2 } }, ctx), false);

  /* in / not_in 的比较目标是数组（曾被「必须是数字」那道闸误伤，恒抛） */
  assert.equal(evaluateEvent({ resource: { grain: { in: [100, 200] } } }, ctx), true);
  assert.equal(evaluateEvent({ resource: { grain: { in: [7, 8] } } }, ctx), false);
  assert.equal(evaluateEvent({ resource: { grain: { not_in: [100] } } }, ctx), false);
  assert.equal(evaluateEvent({ resource: { grain: { not_in: [7, 8] } } }, ctx), true);
  assert.throws(() => evaluateEvent({ resource: { grain: { in: 100 } } }, ctx), /数组/);

  /* 构建期就拦非法写法，别等运行期 */
  const base = { id: 'evt.x', title: 't', layer: '条件', priority: 1, text: ['a'], source: { id: 's', confidence: 'FACT' } };
  const mk = (when) => ({ ...base, when, choices: [{ id: 'c1', label: 'l', effects: ['gold:+1'] }] });
  assert.deepEqual(validateEventSchema(mk({ turnMin: 5 })), []);
  assert.deepEqual(validateEventSchema(mk({ year: { '>=': 184 } })), []);
  assert.ok(validateEventSchema(mk({ turnMin: 'abc' })).length > 0, '字符串边界必须报错');
  assert.ok(validateEventSchema(mk({ turnMin: { '>=': 1, '<': 9 } })).length > 0, '多算子必须报错');
});
