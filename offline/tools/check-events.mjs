/**
 * check-events.mjs — 事件系统构建期冲突检测（GDD §8.3 / §13.1 事件 DSL 风险）
 *
 * 校验失败即构建失败（退出码 1）。规则：
 *  1. schema：每条事件过 validateEventSchema（字段白名单、choices、source）
 *  2. 引用有效性：武将名 ∈ heroes-240；城 id ∈ strategy/map.json 72 城；
 *     attitude 目标 ∈ factions.json 8 势力；资源 kind ∈ 白名单
 *  3. once-flag 一致性：同一 flag 不得被两条 once 事件「一设一清」
 *  4. exclusive 引用完整：组内 id 必须存在（跨文件共享 id 集）
 *  5. 禁入词：事件数据内出现 eval(/Function(/new Function 即拒绝
 *  6. reviewed=false 的条目只警告（出戏防线第 4 闸，待人工签核）
 *  7. ★ M3-7：默认校验 events.json + events-extra.json 两批（--events 可覆盖为单文件）
 *
 * 用法：node tools/check-events.mjs [--events conf/campaign/events.json]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEventSchema, parseEffect } from '../server/domain/event-dsl.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? [args[i + 1]] : null;
}

/* 默认两批都查；--events 显式传入时只查指定文件 */
const eventFiles = argOf('--events')
  ? [resolve(ROOT, argOf('--events')[0])]
  : [resolve(ROOT, 'conf/campaign/events.json'), resolve(ROOT, 'conf/campaign/events-extra.json')];

const heroesPath = resolve(ROOT, 'conf/campaign/heroes-240.json');
const mapPath = resolve(ROOT, 'conf/campaign/strategy/map.json');
const factionsPath = resolve(ROOT, 'conf/campaign/strategy/factions.json');

const RESOURCE_KINDS = ['gold', 'grain', 'min_loyalty', 'prisoners', 'besieged_cities', 'supply_cut_armies'];
const LOYALTY_SPECIAL = ['全军', '最低者'];

const heroes = JSON.parse(readFileSync(heroesPath, 'utf8'));
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const factions = JSON.parse(readFileSync(factionsPath, 'utf8'));

const heroNames = new Set(heroes.heroes.map((h) => h.name));
const cityIds = new Set((map.cities || []).map((c) => c.id));
const factionIds = new Set((factions.factions || factions).map((f) => f.id));

const errors = [];
const warns = [];
const idSet = new Set();
let total = 0;
const grandByLayer = {};
let grandOnce = 0;
let exclusiveGroups = new Set();

for (const eventsPath of eventFiles) {
  const doc = JSON.parse(readFileSync(eventsPath, 'utf8'));
  const events = doc.events || [];
  total += events.length;

  /* 0. 禁入词（事件 DSL 不允许脚本化） */
  const rawText = readFileSync(eventsPath, 'utf8');
  for (const banned of ['eval(', 'Function(', 'require(', 'import ', 'process.', 'fetch(']) {
    if (rawText.includes(banned)) errors.push(`禁入词 "${banned}" 出现在 ${eventsPath}`);
  }

  /* 1. schema + 2. 引用有效性（id 集跨文件共享，exclusive 引用也跨文件查） */
  for (const e of events) {
    if (e.id && idSet.has(e.id)) errors.push(`事件 id 重复（跨文件）: ${e.id}`);
    if (e.id) idSet.add(e.id);
    for (const err of validateEventSchema(e, heroNames)) errors.push(err);

    const when = e.when || {};
    for (const c of when.cityOwned || []) {
      if (!cityIds.has(c)) errors.push(`${e.id}: cityOwned 引用不存在城 id ${c}`);
    }
    for (const c of when.cityLost || []) {
      if (!cityIds.has(c)) errors.push(`${e.id}: cityLost 引用不存在城 id ${c}`);
    }
    for (const kind of Object.keys(when.resource || {})) {
      if (!RESOURCE_KINDS.includes(kind)) errors.push(`${e.id}: 资源 kind 不在白名单: ${kind}`);
    }
    for (const c of e.choices || []) {
      for (const fx of c.effects || []) {
        const p = parseEffect(fx);
        if (!p) continue; // schema 已报
        if (p.kind === 'loyalty') {
          if (!LOYALTY_SPECIAL.includes(p.target) && !heroNames.has(p.target)) {
            errors.push(`${e.id}: loyalty 目标不在 heroes-240: ${p.target}`);
          }
        }
        if (p.kind === 'attitude' && !factionIds.has(p.target)) {
          errors.push(`${e.id}: attitude 目标不是势力 id: ${p.target}`);
        }
      }
    }
    if (e.reviewed === false) warns.push(`${e.id} 待人工签核`);
  }

  /* 3. once-flag 一致性：设/清冲突（跨文件共享） */
  const flagOps = new Map();
  for (const e of events) {
    if (!e.once) continue;
    for (const c of e.choices || []) {
      for (const fx of c.effects || []) {
        const p = parseEffect(fx);
        if (!p || (p.kind !== 'flag' && p.kind !== 'flag-')) continue;
        const op = p.kind === 'flag' ? 'set' : 'clear';
        if (!flagOps.has(p.name)) flagOps.set(p.name, []);
        flagOps.get(p.name).push({ id: e.id, op });
      }
    }
  }
  for (const [flag, ops] of flagOps) {
    const hasSet = ops.some((o) => o.op === 'set');
    const hasClear = ops.some((o) => o.op === 'clear');
    if (hasSet && hasClear) {
      errors.push(`flag ${flag} 被多条 once 事件一设一清（冲突）: ${ops.map((o) => o.id).join(', ')}`);
    }
  }

  /* 4. exclusive 引用完整 */
  for (const e of events) {
    for (const other of e.exclusive || []) {
      if (!idSet.has(other)) errors.push(`${e.id}: exclusive 引用不存在的事件 ${other}`);
    }
  }

  /* 汇总 */
  for (const e of events) grandByLayer[e.layer] = (grandByLayer[e.layer] || 0) + 1;
  grandOnce += events.filter((e) => e.once).length;
  for (const e of events) {
    if (e.exclusive) exclusiveGroups.add(e.exclusive.slice().sort().join('|'));
  }
}

if (warns.length) console.warn(`警告（${warns.length} 条）:\n  ${warns.join('\n  ')}`);
console.log(`事件合计 ${total} 条 / ${eventFiles.length} 个文件（${JSON.stringify(grandByLayer)}）；once ${grandOnce} 条；exclusive 组 ${exclusiveGroups.size} 个`);

if (errors.length) {
  console.error(`校验失败（${errors.length} 条）:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log('check-events ok');
