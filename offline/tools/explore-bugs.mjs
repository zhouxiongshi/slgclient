/**
 * 探索性 bug 扫描（可复跑）：node tools/explore-bugs.mjs
 *
 * 遍历 server/handlers.js 里全部 67 个协议入口，对每个入口发 5 组畸形/边界
 * 参数，捕捉 (a) 抛异常 (b) NaN/null 混进返回体与存档 (c) 建筑 level 越界。
 * 「可疑返回」中 generals.skills / campaign.choice 等的 null 是设计上的空值，
 * 客户端已有容错，属预期结果；重点看「抛异常」和「非法 level」两项必须为 0。
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';

const cfg = loadConfig();
const src = readFileSync(new URL('../server/handlers.js', import.meta.url), 'utf8');
const names = [...src.matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]);
const uniq = [...new Set(names)];

function makeCtx(state) {
  const pushes = [];
  return {
    state, cfg, options: {}, pushes,
    push(name, msg) { pushes.push({ name, msg }); },
    save() {}, log() {}, schedule() {},
  };
}

/** 一组典型畸形 / 边界参数 */
const payloads = [
  {},
  { x: -1, y: -1, cityId: -1, gId: -1, armyId: -1, id: -1, level: 999, type: 999, fType: 999 },
  { x: 99999, y: 99999, cityId: 99999, gId: 99999, armyId: 99999, level: 0, type: 0, fType: 0 },
  { x: 'abc', y: null, cityId: undefined, pos: 999, cnts: [-5, -5, -5], from: [1e9, 1e9, 1e9, 1e9], to: [1, 1, 1, 1] },
  { skillId: 99999, cfgId: 99999, lv: 999, pos: -1, seq: -1 },
];

const thrown = [];
const weird = [];
const seen = new Set();

for (const name of uniq) {
  for (let i = 0; i < payloads.length; i += 1) {
    const state = createWorld(cfg);
    const ctx = makeCtx(state);
    let r;
    try {
      r = handleRequest(ctx, { seq: 1, name, msg: payloads[i] });
    } catch (e) {
      thrown.push(`${name} [payload#${i}] ${e.message}`);
      continue;
    }
    if (!r || typeof r.code !== 'number' || Number.isNaN(r.code)) {
      weird.push(`${name} [payload#${i}] 返回非法 code: ${JSON.stringify(r)}`);
    }
    // NaN / Infinity / undefined 混进返回体（JSON 序列化后会变成 null 或丢失）
    const json = JSON.stringify(r);
    if (json && /null/.test(json) && !seen.has(name)) {
      // 只记录可疑：null 出现在数值字段里
      const nullKeys = [];
      const walk = (o, path) => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (v === null) nullKeys.push(`${path}${k}`);
          else if (typeof v === 'number' && !Number.isFinite(v)) nullKeys.push(`${path}${k}=${v}`);
          else if (typeof v === 'object') walk(v, `${path}${k}.`);
        }
      };
      walk(r.msg, '');
      if (nullKeys.length) weird.push(`${name} [payload#${i}] 返回含 null/非有限数: ${nullKeys.slice(0, 6).join(',')}`);
    }
  }
  seen.add(name);
}

/** 建筑流程全序列：检查任何时刻下发给客户端的 level 是否合法（客户端 basic.npc.levels 只有 1~10） */
const state = createWorld(cfg);
const ctx = makeCtx(state);
const badLevels = [];
const checkLevels = (label) => {
  for (const b of state.builds) {
    if (!Number.isInteger(b.level) || b.level < 1 || b.level > 10) {
      badLevels.push(`${label}: (${b.x},${b.y}) type=${b.type} level=${b.level} op=${b.op_level}`);
    }
  }
  for (const p of ctx.pushes) {
    const b = p.msg;
    if (p.name === 'roleBuild.push' && (!Number.isInteger(b.level) || b.level < 1 || b.level > 10)) {
      badLevels.push(`${label}: push (${b.x},${b.y}) level=${b.level}`);
    }
  }
};
checkLevels('初始');
const b0 = state.builds[0];
const steps = [
  ['nationMap.build', { x: b0.x, y: b0.y, type: 56 }],
  ['nationMap.upBuild', { x: b0.x, y: b0.y }],
  ['nationMap.delBuild', { x: b0.x, y: b0.y }],
  ['nationMap.giveUp', { x: b0.x, y: b0.y }],
];
for (const [n, m] of steps) {
  const r = handleRequest(ctx, { seq: 1, name: n, msg: m });
  checkLevels(n);
  console.log(`STEP ${n}: code=${r.code} level=${b0.level} op=${b0.op_level} type=${b0.type}`);
}
// giveUp 的 push 也检查
checkLevels('流程结束');

console.log('\n=== 结果 ===');
console.log('handler 数:', uniq.length, ' 用例数:', uniq.length * payloads.length);
console.log('抛异常:', thrown.length);
thrown.forEach((t) => console.log('  THROW', t));
console.log('可疑返回:', weird.length);
weird.slice(0, 30).forEach((t) => console.log('  WEIRD', t));
console.log('非法 level:', badLevels.length);
badLevels.slice(0, 20).forEach((t) => console.log('  LEVEL', t));
