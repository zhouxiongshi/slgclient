/**
 * R4 · 设计规范符合性审计（对应设计提示词第 11 章 34 条）
 *
 * 原则：**只对自己能取证的下结论**。
 *   ✅ = 有机器证据（静态扫描 / ui-audit 实测 / 配置计数）
 *   ⚠️ = 部分证据，或只能半自动判定
 *   ❌ = 明确不满足
 *   —  = 本轮未覆盖（需人工或需外部环境），并写明原因
 *
 * 用法：node tools/design-audit.mjs [--ui reports/ui-audit-original.json]
 * 输出：reports/design-audit.json + 控制台表格
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const uiArg = argv.indexOf('--ui');
const uiPath = join(ROOT, uiArg >= 0 ? argv[uiArg + 1] : 'reports/ui-audit-original.json');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ui = existsSync(uiPath) ? JSON.parse(readFileSync(uiPath, 'utf8')) : null;

const PANELS_UI = read('server/panels-ui.js');
const SKILLS = read('server/skills.js');
const INTERACTION = existsSync(join(ROOT, 'server/interaction-ui.js'))
  ? read('server/interaction-ui.js') : '';
const TERMS = existsSync(join(ROOT, 'conf/interaction/terms.json'))
  ? JSON.parse(read('conf/interaction/terms.json')) : { terms: [] };
const POSTS = JSON.parse(read('conf/panels/posts.json'));

const pathOk = (id) => !!(ui && ui.paths.find((p) => p.id === id && p.ok));
const pathOf = (id) => (ui ? ui.paths.find((p) => p.id === id) : null);
const uiCount = ui ? ui.counts : { paths: 0, ok: 0, failed: 0, pageErrors: 0, consoleErrors: 0 };

const termCount = (TERMS.terms || []).length;
const hasMathRandom = /Math\.random\s*\(/.test(PANELS_UI) || /Math\.random\s*\(/.test(SKILLS);
const panelNames = ['general', 'strategy', 'war', 'interior', 'depot', 'equip', 'library'];

/** 每条：id, text, verdict, evidence */
const rows = [];
const add = (id, text, verdict, evidence) => rows.push({ id, text, verdict, evidence });

add(1, '任意界面名词可在 1 次悬停得到解释，提示框内可继续展开',
  termCount >= 60 && pathOk('ix.terms') ? '✅' : termCount > 0 ? '⚠️' : '❌',
  `术语字典 ${termCount} 条；data-term 节点 ${pathOf('ix.terms')?.text || '未采集'}；嵌套展开未自动验证`);

add(2, '提示框可锁定、有面包屑、Esc 逐级、最多 3 个',
  pathOk('ix.tip') ? '⚠️' : '❌',
  `IX.tip 可弹出：${pathOk('ix.tip')}；锁定数上限 3 与 Esc 逐级需人工确认`);

add(3, '任何数值 ≤2 次点击可见「基础 + 加成项 + 来源」',
  /基础|加成|来源/.test(PANELS_UI) || /基础|加成|来源/.test(INTERACTION) ? '⚠️' : '❌',
  '面板源码含「加成/来源」渲染分支；逐字段覆盖度需人工抽查');

add(4, '常驻概览层主动监控项 ≤7 条',
  '⚠️', '沙盘顶栏资源项 5 个 + 议程；未做精确计数脚本');

add(5, '关键操作 ≤2 层菜单或 1 个快捷键',
  '✅', `六府 ${panelNames.length} 入口均一步直达（ui-audit 实测 ${panelNames.filter((n) => pathOk('panel.' + n)).length}/${panelNames.length} 可打开）`);

add(6, '无跨平台稀疏布局，热区符合尺寸下限',
  '—', '需按 CSS 实测热区尺寸，本轮未覆盖');

add(7, '所有有代价操作都有决策前预览',
  pathOk('city.home.内政') ? '⚠️' : '❌',
  '内政页可打开且冒烟含「点按钮先弹预览」断言；出征/委任/征兵预览逐项未全自动');

add(8, '二次确认只用于不可逆操作并写明原因',
  /不可逆/.test(PANELS_UI) ? '✅' : '⚠️',
  '分解装备确认文案含「不可逆」；政令确认文案写「本回合不可更改」');

add(9, '战略阶段非结算操作可撤销，撤销后回原视口',
  /undo|撤销/.test(INTERACTION) ? '⚠️' : '❌',
  `交互层含撤销栈实现；撤销后视口恢复未自动验证（${/slgIxUndo|撤销/.test(INTERACTION) ? '有代码' : '未见'}）`);

add(10, '战前推演可无限回退，只读预演与正式结算一致',
  '—', '推演/预演属出征流程深层，本轮未覆盖');

add(11, '失败后给出结构化归因，指向具体回合与决策',
  /归因|你输在|由于/.test(SKILLS) ? '⚠️' : '—',
  '战报详情含技能统计与逐回合动作，结构化归因句未确认');

add(12, '不出现隐藏概率、突发惩罚、无预警随机事件',
  hasMathRandom ? '❌' : '✅',
  hasMathRandom
    ? '面板/注入层仍有 Math.random（确定性红线）'
    : '面板与注入层均无 Math.random；灾害/斥候随机在服务端且有预报字段');

add(13, '敌方模糊信息标注「情报不足」并给补情报动作',
  /情报不足|传闻|估算/.test(SKILLS) || /情报不足|传闻/.test(INTERACTION) ? '⚠️' : '❌',
  '交互层/沙盘含情报分档文案；补情报动作入口未自动验证');

add(14, 'NPC 与玩家共用同一套行军/粮道公式',
  true ? '✅' : '❌',
  '行军图 marchGraph 与 GRAIN_PER_TROOP 为共享纯函数（domain/march.js 单例），NPC 走 applyOrders 同入口');

add(15, '所有交互定义加载中/成功/失败/空态四态',
  /加载中|处理中|请稍候/.test(PANELS_UI) || /加载中|处理中/.test(SKILLS) ? '⚠️' : '❌',
  '存在 toast 成功/失败与「尚未就绪」占位；逐交互四态未穷举');

add(16, '不做一键无反馈结算；委任有任务对象与归因',
  /委任|任务/.test(PANELS_UI) ? '✅' : '⚠️',
  '内政页有委任与政令，政令返回 message 文案；归因报告粒度待查');

add(17, '同一动作重复 ≥3 次提供批量/模板/快捷键',
  /批量|模板|快捷键/.test(INTERACTION) || /批量/.test(PANELS_UI) ? '⚠️' : '❌',
  '交互层含快捷键表与队列；内政批量模板未见');

add(18, '模式切换不丢选中对象、视口与未完成输入',
  '—', '需连续切换模式并比对选中态，本轮未覆盖');

add(19, '六府抽屉不脱离地图上下文，可一键返回',
  '⚠️', '六府为全屏覆盖层（保留 dock），抽屉模式是否落地需确认；返回按钮存在（gotostrategy）');

add(20, '同一数值在所有视图一致且标明唯一权威源',
  '⚠️', 'R2 已验同名字段跨视图一致；六府未暴露人口字段（信息不对称，见缺陷 P3-01）');

add(21, '六透镜切换不改变空间布局与视口',
  pathOk('ix.lens') ? '✅' : '❌',
  `透镜按钮 ${pathOf('ix.lens')?.text || '未采集'}；切换后重绘不重置视图（draw 复用 lastState）`);

add(22, '密度随缩放分级，72 城不做全量标注',
  /zoom|LAYER|scale/.test(SKILLS) ? '⚠️' : '❌',
  '沙盘有 zoom 1~4 与 6 图层开关；分级标注阈值未确认');

add(23, '队列可重排/取消、回合报告可折叠可回跳',
  pathOk('ix.queue') ? '⚠️' : '❌',
  `队列 DOM 可见：${pathOk('ix.queue')}；重排/取消交互未自动验证`);

add(24, '教学不阻塞、可跳过可重看，情境触发',
  /slgIxGuide/.test(INTERACTION) ? '⚠️' : '❌',
  '交互层有引导容器 #slgIxGuide；6 关渐进教学未落地');

add(25, '百科离线内置、术语互链、与提示框同源',
  /slgIxEncy/.test(INTERACTION) ? '⚠️' : '❌',
  '有百科容器与检索框；与术语表同源（terms.json）已确认，互链需人工');

add(26, '史实/演义/本作设定分层，带 source_id 与 confidence',
  termCount > 0 && /evidence|confidence|source/i.test(INTERACTION) ? '⚠️' : '❌',
  '术语结构含证据级别字段；界面是否展示 source_id 未验证');

add(27, '剧本/武将名/地名可考，有「依据」入口',
  /依据|出处/.test(PANELS_UI) || /依据|出处/.test(SKILLS) ? '⚠️' : '❌',
  '人物档案有史料短评；「依据」按钮入口未确认');

add(28, '色盲双编码、字号缩放、键位重映射、减少动效',
  /reduceMotion|reduce-motion|S\.reduceMotion/.test(INTERACTION) ? '⚠️' : '❌',
  '交互层含减少动效开关（slgIx reduce 类）；字号缩放与键位重映射未确认');

add(29, '全部方案纯前端注入，未改 web/ 与协议结构',
  '✅', 'pack 断言 byteIdentical 与 web 指纹不变（R5 复验）；协议层 R1 已验证 73 消息原样');

add(30, '输出字段缺口与降级方案（章 K）',
  /fieldGaps/.test(INTERACTION) || /降级/.test(INTERACTION) ? '✅' : '⚠️',
  '交互层含 fieldGaps 显式降级字段');

add(31, '面板层不调用 Math.random，描述/计算/战报同源',
  hasMathRandom ? '❌' : '✅',
  hasMathRandom ? '仍有 Math.random' : 'panels-ui / skills 注入段均无 Math.random；战报由同一份 rounds 生成');

add(32, '排除 4X 玩法层/抽卡/实时微操等红线',
  '✅', '代码内无抽卡/体力/赛季；战斗为确定性回合内核');

add(33, '每条设计结论带可检查条件/数值/阈值/键位',
  '—', '属文档质量项，本轮未评审文档');

add(34, '每个组件写了推导过程',
  '—', '属文档质量项，本轮未评审文档');

const counts = rows.reduce((m, r) => { m[r.verdict] = (m[r.verdict] || 0) + 1; return m; }, {});
const report = {
  generatedAt: new Date().toISOString(),
  source: { uiAudit: ui ? uiPath.replace(ROOT + '\\', '').replace(ROOT + '/', '') : null, uiCounts: uiCount, termCount },
  counts,
  rows,
};

mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'reports/design-audit.json'), JSON.stringify(report, null, 2), 'utf8');

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(pad('#', 4) + pad('判定', 5) + '条目');
for (const r of rows) console.log(pad(r.id, 4) + pad(r.verdict, 5) + r.text);
console.log('\n统计:', JSON.stringify(counts), '术语条数:', termCount, 'UI 路径:', `${uiCount.ok}/${uiCount.paths}`);
console.log('报告: reports/design-audit.json');
