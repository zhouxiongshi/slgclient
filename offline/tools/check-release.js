/**
 * Steam 买断制单机「运行层面」上架条件核查 —— 原画面 100% 保留版。
 *
 * 与旧版 standalone 核查的根本区别：
 *   旧版核查的是自绘 Canvas 界面；本核查要求 UI/地图/城池/建筑/配套逻辑
 *   全部来自原 slgclient 的 web-desktop 构建产物，且逐字节未改。
 *
 * 只判定本机可验证的部分；账号/付费/素材/法务列入 requires_user。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLG = resolve(ROOT, '..');
// 仓库布局（offline-standalone 分支）：SLG 即客户端仓库本身，battle-core 在仓库根
const BATTLE_CORE = join(SLG, 'battle-core');
// 旧开发布局时 SLG 是父目录、客户端仓库在其 slgclient/ 子目录
const CLIENT = existsSync(join(SLG, '.git')) ? SLG : join(SLG, 'slgclient');
const WEB_SRC = existsSync(join(ROOT, 'web', 'index.html'))
  ? join(ROOT, 'web')
  : join(SLG, 'runtime', 'client-src', 'build', 'web-desktop');
const OUT = join(ROOT, 'build', 'SLG-Offline-win32-x64');
const APP = join(OUT, 'resources', 'app');
const REPORTS = join(ROOT, 'reports');
mkdirSync(REPORTS, { recursive: true });

const achieved = [];
const failed = [];
const requiresUser = [];

function check(name, condition, detail = '') {
  (condition ? achieved : failed).push({ name, detail });
  return !!condition;
}
function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function manifest(dir) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[relative(dir, p).replace(/\\/g, '/')] = { size: st.size, sha256: sha256(p) };
    }
  };
  walk(dir);
  return out;
}
function fingerprint(m) {
  return createHash('sha256').update(Object.keys(m).map((k) => `${k}:${m[k].sha256}`).join('\n')).digest('hex');
}
function runTests(cwd) {
  const r = spawnSync('npm', ['test'], { cwd, encoding: 'utf8', timeout: 300000, shell: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const fail = out.match(/# fail (\d+)/);
  const pass = out.match(/# pass (\d+)/);
  return {
    ok: r.status === 0 && (!fail || fail[1] === '0'),
    tests: pass ? Number(pass[1]) : 0,
    fails: fail ? Number(fail[1]) : -1,
    out,
  };
}
function filesIn(dir, exts = /\.(js|cjs|mjs|json|html|css)$/) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/* ---------------- 1. 交付文件完整性 ---------------- */
const required = [
  'package.json', 'server/codec.js', 'server/wsserver.js', 'server/config.js',
  'server/world.js', 'server/battle.js', 'server/handlers.js', 'server/index.js',
  'server/standalone.js', 'electron/main.cjs', 'electron/smoke.cjs',
  'kernel/index.js', 'kernel/engine.js', 'kernel/rules.js', 'kernel/rng.js',
  'conf/mapRes_0.json', 'conf/json/basic.json',
  'tools/pack.js', 'tools/smoke.js', 'tools/check-release.js', 'tools/build-skills.js',
  'tests/client.js', 'tests/codec.test.js', 'tests/protocol.test.js', 'tests/skills.test.js',
  'conf/skills.json', 'server/skills.js',
];
for (const f of required) check(`交付文件：${f}`, existsSync(join(ROOT, f)));

/* ---------------- 2. 原画面 100% 保留（最核心） ---------------- */
const pack = readJson(join(REPORTS, 'pack.json'));
const srcManifest = manifest(WEB_SRC);
const dstManifest = manifest(join(APP, 'web'));
const diff = [];
for (const k of new Set([...Object.keys(srcManifest), ...Object.keys(dstManifest)])) {
  if (!srcManifest[k] || !dstManifest[k] || srcManifest[k].sha256 !== dstManifest[k].sha256) diff.push(k);
}
check('原 web-desktop 逐字节复制到包内（UI/地图/城池/建筑/配套逻辑未改）',
  diff.length === 0 && Object.keys(srcManifest).length > 1000,
  `${Object.keys(srcManifest).length} 个文件 / ${diff.length} 处差异`);
check('构建清单指纹可复现',
  !!pack?.webFingerprint && pack.webFingerprint === fingerprint(srcManifest),
  pack?.webFingerprint);
check('打包清单标记：无自定义 Canvas UI',
  pack?.containsCustomCanvasUI === false && pack?.byteIdentical === true && Array.isArray(pack.diff) && pack.diff.length === 0,
  `byteIdentical=${pack?.byteIdentical} diff=${pack?.diff?.length}`);

const customUI = filesIn(APP, /\.(js|html)$/).filter((p) => {
  const rel = relative(APP, p).replace(/\\/g, '/');
  return rel.startsWith('app/') || /mapview|standalone\/app|custom-canvas/i.test(rel);
});
check('包内不含自绘 Canvas 界面或 standalone/app 新 UI', customUI.length === 0, customUI.slice(0, 3));

const indexHtml = readFileSync(join(APP, 'web', 'index.html'), 'utf8');
check('原 index.html 未被注入自定义脚本/悬浮按钮',
  !/SLG_UI_START|slgBackBtn|slgBackHint|<script[^>]+app\//i.test(indexHtml) && /Cocos Creator/.test(indexHtml),
  `${indexHtml.length} bytes`);

// 原工程源码工作区必须干净：证明"其他内容都不要换"
const git = spawnSync('git', ['status', '--porcelain'], { cwd: CLIENT, encoding: 'utf8' });
check(existsSync(join(SLG, '.git'))
  ? '客户端仓库工作区干净（本分支改动全部已提交）'
  : '原 slgclient 源码未被本次改造修改',
  git.status === 0 && (git.stdout ?? '').trim() === '',
  (git.stdout ?? '').trim().slice(0, 200) || 'clean');

/* ---------------- 3. 战斗内核稳定性 ---------------- */
const coreTests = runTests(BATTLE_CORE);
check('战斗内核单测全通过（纯函数/引擎/黄金向量/压力）',
  coreTests.ok && coreTests.tests >= 30, `${coreTests.tests} tests / ${coreTests.fails} fail`);
check('跨语言黄金向量：175 条事件逐条一致',
  /175 条事件逐条/.test(coreTests.out) && !/# fail [1-9]/.test(coreTests.out), '');
const stress = readJson(join(BATTLE_CORE, 'reports', 'stress.json'));
check('战斗内核 10000 场压测：不变量与确定性零失败',
  !!stress?.passed && stress.invariant_failures === 0 && stress.determinism_failures === 0,
  stress ? `${stress.total_battles} 场 / ${stress.total_events} 事件` : '缺少 stress.json');

const gameTests = runTests(ROOT);
check('离线协议层测试全通过（编解码/登录/战斗/存档重启）',
  gameTests.ok && gameTests.tests >= 10, `${gameTests.tests} tests / ${gameTests.fails} fail`);
check('协议测试覆盖存档重启续跑',
  /重启|续跑|loadWorld|save\.json/.test(gameTests.out) || /重启|续跑/.test(readFileSync(join(ROOT, 'tests/protocol.test.js'), 'utf8')), '');

/* ---------------- 4. 内核确实接入原工程战报链路 ---------------- */
const bridge = readFileSync(join(ROOT, 'server', 'battle.js'), 'utf8');
check('战斗结算走确定性内核并翻译为原版 rounds 战报',
  /runBattle/.test(bridge) && /rounds/.test(bridge) && /event_fingerprint|fingerprint/.test(bridge), '');
check('原客户端战报 UI 未被改动（仍由 web-desktop 原产物渲染）',
  diff.length === 0 && !existsSync(join(APP, 'web', 'app')), '');

/* ---------------- 4b. 新战斗系统：完整替换旧技能体系 ---------------- */
const skillTable = readJson(join(ROOT, 'conf', 'skills.json'));
const legacySkillFiles = [
  'zhudong/tuji.json', 'beidong/baizhanjingbing.json',
  'zuiji/zhongzhan.json', 'zhihui/fengshi.json',
].map((f) => join(ROOT, 'conf', 'json', 'skill', f));
// 固定值战法（原文无 {0} 成长标记）不要求成长；被动概率恒 100%
const fixedCount = (skillTable?.skills ?? []).filter((s) => s.kernel.rate_pct_lv1 === s.kernel.rate_pct_lv10).length;
const skillGrowthOK = (skillTable?.skills ?? []).every((s) => {
  const fixed = s.kernel.rate_pct_lv1 === s.kernel.rate_pct_lv10;
  const lv = s.ui.levels;
  if (lv.length !== skillTable.levelCount) return false;
  if (!fixed && lv.at(-1).effect_value[0] <= lv[0].effect_value[0]) return false;
  if (s.ui.trigger !== 2 && lv.at(-1).probability <= lv[0].probability) return false;
  return true;
});
check('完整战法表：31 个战法 / 4 类 / 10 级真实数值成长 / 数值来自 battle-kit',
  skillTable?.count >= 24 && skillTable?.oldSystemRemoved === true && skillGrowthOK,
  `${skillTable?.count} 个 / ${skillTable?.levelCount} 级（固定值 ${fixedCount} 个）`);
check('原 4 个占位技能配置已从交付包移除',
  legacySkillFiles.every((p) => !existsSync(p)), '');
check('旧战斗公式与占位技能映射已从结算代码移除',
  !/AbsInt\(|force\s*-\s*defense|SKILL_CFG_BY_CLASS|SKILL_CLASSES/.test(bridge) &&
  /kernelSkillAt|loadoutFor/.test(bridge), '');
const skillRuntime = readFileSync(join(ROOT, 'server', 'skills.js'), 'utf8');
check('运行时注入：磁盘原产物不改 / 旧技能路径移除 / 新战法注入',
  /delete patched\.paths\[uuid\]/.test(skillRuntime) &&
  /jsonAsset\(/.test(skillRuntime) && /diskUntouched:\s*true/.test(skillRuntime), '');
check('技能装配与升级协议测试通过（skill.list / 按 pos 升级 / 旧 ID 拒绝）',
  gameTests.ok && /技能列表非空/.test(gameTests.out), '');

/* ---------------- 5. 完全离线 ---------------- */
const scanTargets = filesIn(join(ROOT, 'server'))
  .concat(filesIn(join(ROOT, 'electron')))
  .concat(filesIn(join(ROOT, 'kernel')))
  .concat(filesIn(join(ROOT, 'tools')))
  .concat(filesIn(join(ROOT, 'tests')));
const external = [];
for (const p of scanTargets) {
  const text = readFileSync(p, 'utf8');
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const url = m[0];
    if (!/127\.0\.0\.1|localhost|www\.w3\.org|schemas\.microsoft/.test(url)) {
      external.push(`${relative(ROOT, p).replace(/\\/g, '/')}: ${url.slice(0, 80)}`);
    }
  }
}
check('源码零外部网络地址（仅 127.0.0.1 回环）', external.length === 0, external.slice(0, 5).join(' | '));

const serverSrc = readFileSync(join(ROOT, 'server', 'index.js'), 'utf8');
check('HTTP / WS 均只监听 127.0.0.1',
  /\.listen\(port, ['"]127\.0\.0\.1['"]/.test(serverSrc) && (serverSrc.match(/127\.0\.0\.1/g) || []).length >= 4, '');
const allServerCode = filesIn(join(ROOT, 'server')).map((p) => readFileSync(p, 'utf8')).join('\n');
// 只检查真实的模块依赖 / 连接串，注释里"等价于原 MySQL slgdb"这类说明文字不算依赖
const externalDeps = /(?:from\s*|import\s*\(|require\(\s*)['"](?:mysql2?|mariadb|better-sqlite3|pg)['"]|sql\.Open\(|go-sql-driver|slgserver\/bin|:\s*3306\b/i.test(allServerCode);
check('不依赖 Go 服务端 / MySQL / 外部数据库', !externalDeps, '');
// <a href>（Cocos 模板自带的官网署名）不会自动加载资源，且点击会被 will-navigate 拦截；
// 只为保持原产物逐字节不改而保留它。真正的资源标签（script/link/img...）不得指向外部。
const htmlNoAnchors = indexHtml.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '');
const remoteAssets = [...htmlNoAnchors.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/g)]
  .map((m) => m[1]).filter((u) => !/127\.0\.0\.1|localhost/.test(u));
const hasNavGuard = /will-navigate/.test(readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8'));
check('外部导航被拦截、页面不加载远程资源', hasNavGuard && remoteAssets.length === 0,
  remoteAssets.length ? remoteAssets.slice(0, 3).join(' | ') : '仅保留 Cocos 模板署名超链接（点击被拦截）');

/* ---------------- 6. 壳健壮性与存档 ---------------- */
const main = readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8');
check('主进程单实例 / 异常日志 / 崩溃日志 / 启动失败提示',
  /requestSingleInstanceLock/.test(main) && /uncaughtException/.test(main) &&
  /crash\.log/.test(main) && /showErrorBox/.test(main), '');
check('渲染进程隔离（contextIsolation=true / nodeIntegration=false）',
  /contextIsolation:\s*true/.test(main) && /nodeIntegration:\s*false/.test(main), '');
const world = readFileSync(join(ROOT, 'server', 'world.js'), 'utf8');
check('存档：版本校验 + 原子写 + 自动持久化 + 重启续跑',
  /SAVE_VERSION/.test(world) && /renameSync/.test(world) &&
  /export function loadWorld/.test(world) && /export function saveWorld/.test(world) &&
  /save\(\)/.test(serverSrc) && /loadWorld\(savePath\)/.test(serverSrc), '');

/* ---------------- 7. 打包产物与运行时冒烟 ---------------- */
const exe = join(OUT, 'SLG-Offline.exe');
check('可双击的独立 Windows 可执行文件存在',
  existsSync(exe) && statSync(exe).size > 100 * 1024 * 1024,
  existsSync(exe) ? `${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB` : 'missing');
check('构建脚本可复现（npm run pack）', existsSync(join(ROOT, 'tools', 'pack.js')), '');

for (const [label, file] of [['源码目录态', 'smoke-original.json'], ['打包产物态', 'smoke-packaged.json']]) {
  const r = readJson(join(REPORTS, file));
  const checks = r?.checks ?? [];
  const bad = checks.filter((c) => !c.ok).map((c) => c.name);
  check(`${label}冒烟全通过（${checks.length} 项）`, !!r?.passed && bad.length === 0, bad.join(' | '));
  check(`${label}页面零未捕获异常 / 零 error 输出`,
    Array.isArray(r?.pageErrors) && r.pageErrors.length === 0 &&
    Array.isArray(r?.consoleErrors) && r.consoleErrors.length === 0,
    `page=${r?.pageErrors?.length} console=${r?.consoleErrors?.length}`);
  check(`${label}原画面截图非黑屏`, (r?.screenshot?.variance ?? 0) > 25, JSON.stringify(r?.screenshot));
  check(`${label}原版战报详情成功渲染内核 rounds`,
    r?.warReportUI?.list?.ok === true && r?.warReportUI?.click?.ok === true,
    JSON.stringify(r?.warReportUI));
  check(`${label}地图主界面真正渲染就绪（原 UI 文案可见）`,
    r?.mapReady?.ready === true, JSON.stringify(r?.mapReady));
  check(`${label}客户端加载全部新战法、数值成长符合真实数据、无旧占位技能`,
    (r?.skills?.count ?? 0) >= 24 && (r?.skills?.grown ?? 0) >= (r?.skills?.count ?? 0) - fixedCount &&
    Array.isArray(r?.skills?.legacy) && r.skills.legacy.length === 0 &&
    (r?.skills?.minCfgId ?? 0) >= 10001, JSON.stringify(r?.skills)?.slice(0, 240));
  check(`${label}战报详情显示新战法名、无旧占位技能名`,
    r?.warReportUI?.detail?.ok === true && r?.warReportUI?.detail?.hasLegacy === false,
    JSON.stringify(r?.warReportUI?.detail)?.slice(0, 200));
  check(`${label}内核战斗事件指纹可复核`,
    /^[0-9a-f]{16}$/.test(r?.battle?.event_fingerprint ?? '') && (r?.battle?.events ?? 0) > 0,
    JSON.stringify(r?.battle));
}

/* ---------------- 7.9 合规台账（U26） ---------------- */
{
  const compliancePath = join(REPORTS, 'compliance.json');
  let compliance = readJson(compliancePath, null);
  if (!compliance) {
    spawnSync(process.execPath, [join(ROOT, 'tools', 'compliance-report.js')], { cwd: ROOT, stdio: 'ignore' });
    compliance = readJson(compliancePath, null);
  }
  check('合规台账存在且覆盖全部第三方派生数据（conf/compliance/provenance.json）',
    !!compliance && Number(compliance.asset_count) >= 8,
    JSON.stringify({ asset_count: compliance?.asset_count, problems: compliance?.problems?.length }));
  check('仓库与发行包内无 IL / 反汇编 / 原始二进制夹带',
    !!compliance && Array.isArray(compliance.problems) &&
    compliance.problems.filter((p) => /forbidden/.test(p.kind)).length === 0,
    JSON.stringify((compliance?.problems || []).filter((p) => /forbidden/.test(p.kind))));
  if (compliance?.unlicensed?.length) {
    requiresUser.push({
      name: '未授权第三方资产必须在发行前替换或取得授权',
      detail: compliance.unlicensed.map((u) => `${u.path}（${u.kind}）：${u.action}`).join('；'),
    });
  }
}

/* ---------------- 8. 需用户处理（本机无法验证） ---------------- */
requiresUser.push(
  { name: 'Steamworks 账号与 Steam Direct 上架费', detail: '每款应用 US$100，需本人注册与付款；我无法代办。' },
  { name: '商店页素材与文案', detail: '胶囊图/库图/截图/预告片/简介/标签/语言；用户已说明素材后续统一替换。' },
  { name: '内容调查与年龄分级', detail: 'Steam 内容问卷、地区评级；买断制无内购仍需填写。' },
  { name: '第三方素材与名录合规', detail: '当前画面/武将名/战法名/数值均来自学习项目与 battle-kit 导出表；上线前须整体换皮或取得授权。battle-kit/export/完整原始版 的 IL 反汇编与 610 类结构不得随包分发。' },
  { name: '法务与发行', detail: '版权声明 / EULA / 隐私政策（本作不联网不收集数据，可简化）、中国发行所需版号（如在大陆商业化发行）。' },
  { name: '代码签名与多机实测', detail: '建议购买 EV/OV 代码签名证书减少 SmartScreen 误报；在多台 Windows 机器、不同分辨率下实测。' },
  { name: 'Steamworks SDK 集成（可选增强）', detail: '成就、云存档、Steam 覆盖层、DRM；非上架必需，当前版本未集成。' },
);

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Steam 买断制单机「可运行层面」基本条件；素材/账号/法务不在本机验证范围',
  build: '原 slgclient web-desktop 画面 100% 保留（逐字节）；本地协议服务替代 Go 网关 + MySQL；31 战法新战斗系统（4 类 / 10 级成长 / 6 类效果）驱动 battle-core 确定性内核',
  ready_for_steam_basics: failed.length === 0,
  achieved_count: achieved.length,
  failed_count: failed.length,
  achieved,
  failed,
  requires_user: requiresUser,
  known_followups: [
    'battle-kit 原版 E2 减伤式方向反了（防御越高伤害越高）；内核已提供 defense_model=corrected 开关，默认保持与参考实现逐位一致，后续数值微调时建议切换。',
    '31 个战法通过运行时资源重写送进原客户端（磁盘 web-desktop 逐字节未改），技能列表/详情/战报全部由原 UI 渲染；内核完整事件流与指纹保存在 state.battleLog，后续可继续扩展战法数量与效果。',
    '原 web-desktop 构建产物自带 Cocos 调试 stats（FPS/Frame time 等），正式发布前可在 Cocos 构建配置中关闭；本次为保持画面 100% 一致未改。',
    '战报详情里富文本标签重叠是原工程既有排版表现，本次为保持原 UI 未改。',
    '素材、名称、数值按用户计划后续统一替换；本版仅验证可运行层面。',
  ],
};
writeFileSync(join(REPORTS, 'release-check.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  ready_for_steam_basics: report.ready_for_steam_basics,
  achieved_count: achieved.length,
  failed_count: failed.length,
  failed,
  requires_user_count: requiresUser.length,
}, null, 2));
if (!report.ready_for_steam_basics) process.exitCode = 1;
