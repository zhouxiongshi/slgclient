/**
 * 导出「天下大事」推演实录 + 决策脑审计。
 *
 * 用法：node tools/dump-strategy-log.mjs [月数=20] [输出目录]
 * 不写入存档、不启动服务；只用当前源码把一局从零跑到第 N 月。
 * 输出：<输出目录>/天下日志-推演实录.md 与 天下日志-原始数据.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import {
  strategyTick, ensureStrategy, strategySnapshot, localBrain, factionConf,
} from '../server/domain/strategy.js';

const months = Number(process.argv[2]) || 20;
const outDir = resolve(process.argv[3] || resolve(process.cwd(), '..', '..', 'docs'));
mkdirSync(outDir, { recursive: true });

const cfg = loadConfig();
const state = createWorld(cfg);
const ctx = { state, cfg, options: {}, push() {}, schedule() {}, save() {}, log() {} };
const conf = factionConf();
const nameOf = Object.fromEntries(conf.factions.map((f) => [f.id, f.name]));

const monthsLog = [];
const allEvents = [];
const targetHits = Object.fromEntries(conf.factions.map((f) => [f.id, {}]));
const goalHits = { 扩张: 0, 固守: 0 };
const orderTypes = {};

for (let t = 1; t <= months; t += 1) {
  state.clock.day = t * 10;
  const st = ensureStrategy(state);
  const before = st.events.length;

  // 审计：真实 tick 内每个势力拿到的指令单（复算一次，确定性一致）
  const sheets = conf.factions.map((f) => ({ f, sheet: localBrain(f, strategySnapshot(state, f.id), state) }));
  for (const { f, sheet } of sheets) {
    goalHits[sheet.goal.type] = (goalHits[sheet.goal.type] || 0) + 1;
    for (const o of [...(sheet.internal_orders || []), ...(sheet.strategy_orders || [])]) {
      orderTypes[o.type] = (orderTypes[o.type] || 0) + 1;
      if (o.type === '出征') {
        const k = String(o.target);
        targetHits[f.id][k] = (targetHits[f.id][k] || 0) + 1;
      }
    }
  }

  strategyTick(state, cfg, ctx);
  const fresh = st.events.slice(before);
  fresh.forEach((e) => allEvents.push({ month: t, day: e.day, text: e.text }));
  monthsLog.push({ month: t, day: t * 10, events: fresh.map((e) => e.text), sheets });
}

// ---- 量化诊断 ----
const classify = (s) => {
  if (/攻陷/.test(s)) return '攻陷';
  if (/攻.+不利/.test(s)) return '攻城失利';
  if (/结好/.test(s)) return '结盟';
  if (/背弃/.test(s)) return '背盟';
  return '其它';
};
const kinds = {};
for (const e of allEvents) kinds[classify(e.text)] = (kinds[classify(e.text)] || 0) + 1;

const flips = {};
for (const e of allEvents) {
  const m = e.text.match(/攻陷([^（(]+)/);
  if (m) flips[m[1]] = (flips[m[1]] || 0) + 1;
}
const topFlips = Object.entries(flips).sort((a, b) => b[1] - a[1]).slice(0, 8);

const locks = conf.factions.map((f) => {
  const hits = Object.entries(targetHits[f.id]).sort((a, b) => b[1] - a[1]);
  const top = hits[0] || ['-', 0];
  return { name: f.name, topTarget: top[0], count: top[1], rate: (top[1] / months * 100).toFixed(0) + '%', distinct: hits.length };
});

const md = [];
md.push('# 天下大事 · 推演实录与决策脑审计');
md.push('');
md.push(`- 生成：${new Date().toLocaleString('zh-CN')}`);
md.push(`- 来源：\`offline/tools/dump-strategy-log.mjs\`，从 \`createWorld\` 从零跑 ${months} 个月（每 10 游戏日一回合），未加载任何存档、未改任何存档。`);
md.push(`- 决策脑：\`server/domain/strategy.js → localBrain()\`（\`state.brainRunner\` 未注入，全仓库无赋值点）。`);
md.push('');
md.push('## 一、量化诊断');
md.push('');
md.push('| 指标 | 数值 |');
md.push('|---|---|');
md.push(`| 推演月数 | ${months} |`);
md.push(`| 天下日志条数 | ${allEvents.length} |`);
md.push(`| 月均事件 | ${(allEvents.length / months).toFixed(1)} |`);
md.push(`| 日志句式种类 | ${Object.keys(kinds).length} 种（${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' / ')}） |`);
md.push(`| 8 家诸侯 × ${months} 月 = ${months * 8} 次决策，指令类型 | ${Object.entries(orderTypes).map(([k, v]) => `${k} ${v}`).join(' / ')} |`);
md.push(`| \`goal.type\` 分布 | ${Object.entries(goalHits).map(([k, v]) => `${k} ${v}`).join(' / ')}（不改变任何行为，纯装饰） |`);
md.push('');
md.push('### 出征目标锁定率（同一势力反复打同一座城）');
md.push('');
md.push('| 势力 | 最常打的目标城 id | 次数 | 占比 | 打过的不同目标数 |');
md.push('|---|---|---|---|---|');
for (const l of locks) md.push(`| ${l.name} | ${l.topTarget} | ${l.count} | ${l.rate} | ${l.distinct} |`);
md.push('');
md.push('### 反复易手的城（同一座城被反复攻陷）');
md.push('');
md.push('| 城 | 被攻陷次数 |');
md.push('|---|---|');
for (const [name, n] of topFlips) md.push(`| ${name} | ${n} |`);
md.push('');
md.push('## 二、结论：这不是「战略小模型」跑出来的');
md.push('');
md.push('当前生效的决策脑是 `server/domain/strategy.js` 里的 `localBrain()`（约 65 行纯 `if` + 一次线性打分 + xorshift32 随机数），**不是任何模型**：');
md.push('');
md.push('1. `strategyTick()` 第 219–222 行写着 `state.brainRunner ? state.brainRunner(...) : localBrain(...)`；全仓库对 `brainRunner` **没有任何赋值点**（`grep -rn "brainRunner =" ` 排除 build 后 0 命中），所以永远落在 `localBrain`。');
md.push('2. 同文件 231–233 行注释原文：「首版实现……**真 Python 模型接入后，把本函数替换为子进程桥即可**」——预留了接口，但没接。');
md.push('3. 全仓库无 `*.onnx` / `*.pt` / `*.gguf` / `*.pkl`，`server/` 内无 `child_process`、无 `spawn`、无 python、无 LLM / HTTP 推理调用。`slg-ai` 只作为协议名字符串 `slg-ai-orders-v1` 和注释存在。');
md.push('4. `conf/campaign/strategy/factions.json` 自述「初版占位映射」；`docs/PLAYTEST-fix-report.md` 第 94 行已注明「NPC 仍无动态 AI」。');
md.push('');
md.push('也就是说：**8 条人格轴 + IAUS 打分 + 指令单协议，是一个「装成模型接口」的规则脚本**，不是小模型。日志不拟人，是它的必然结果，不是模型退化了。');
md.push('');
md.push('### 死板僵硬的六个机制根因');
md.push('');
md.push('| # | 根因 | 代码位置 / 后果 |');
md.push('|---|---|---|');
md.push('| 1 | 攻陷后守军直接压到 `garrisonOf()*0.35`（下限 300） | `applyOrders` 攻陷分支。新城永远最弱 → 下月被邻居按打分公式挑中 → 抢回 → 又变最弱，形成死循环。「平原」20 个月内被攻陷 45 次 |');
md.push('| 2 | 征兵只加在本方 `own[0]` 第一座城 | `applyOrders` 征兵分支。前线城永远得不到补充，谁占谁裸奔 |');
md.push('| 3 | 打分公式对所有势力同构：`(1-城防)×侵略 + 1/(1+兵/3000)×0.5 - 防御×0.3` | `localBrain`。只有 aggression 一轴进入目标选择，其余 4 条人格轴不影响打谁；同图同分 → 每家长期锁定同一个城 id（曹操/袁绍 90% 打 66，公孙瓒 90% 打 43） |');
md.push('| 4 | 结盟对象 `others[floor(r()*len)]` 纯随机，`expect` 恒为「北境无虞」 | `localBrain` 外交分支；且结盟令排在出征令之后执行，出现同月「先打后盟」 |');
md.push('| 5 | `goal` / `eta` / `on_fail` / `difficulty` / `explain` / `locked_until` 全是装饰字段 | 执行层一个都不读；`goal=固守` 的月份照样下出征令 |');
md.push('| 6 | 脑是「瞎」的：`known_facts: []`、`visible_events: []`、`heroes: []`、`threat: {}`、`front_pressure: 0`、`season` 硬编码「春秋」 | `strategySnapshot()`。看不到敌情、记不住上月、没有战损记忆，自然不可能有因果与拟人叙事 |');
md.push('');
md.push('日志侧同样只有 8 个字符串模板（`recordEvent` 调用点），无动机、无兵力对比、无季节、无因果链，所以读起来像流水账。');
md.push('');
md.push('## 三、天下日志全文');
md.push('');
for (const m of monthsLog) {
  md.push(`### 第 ${m.month} 月（游戏日 ${m.day}）`);
  md.push('');
  for (const e of m.events) md.push(`- ${e}`);
  md.push('');
  md.push('<details><summary>本月 8 家诸侯指令单</summary>');
  md.push('');
  md.push('```');
  for (const { f, sheet } of m.sheets) {
    const acts = [...(sheet.internal_orders || []), ...(sheet.strategy_orders || [])]
      .map((o) => `${o.type}→${o.target} [${o.expect}] 依据:${(o.explain || []).map((x) => x[0]).join(',')}`).join(' ; ');
    md.push(`${f.name.padEnd(4, '　')} goal=${sheet.goal.type} | ${acts}`);
  }
  md.push('```');
  md.push('');
  md.push('</details>');
  md.push('');
}

writeFileSync(join(outDir, '天下日志-推演实录.md'), md.join('\n'), 'utf8');
writeFileSync(join(outDir, '天下日志-原始数据.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), months, events: allEvents,
  kinds, goalHits, orderTypes, locks, topFlips, monthsLog,
}, null, 2), 'utf8');

console.log(`events=${allEvents.length} kinds=${JSON.stringify(kinds)}`);
console.log(`topFlips=${JSON.stringify(topFlips.slice(0, 5))}`);
console.log(`locks=${JSON.stringify(locks)}`);
console.log(`out=${outDir}`);
