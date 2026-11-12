/**
 * 运行时冒烟：真实启动 Electron + 原 web-desktop，验证
 *   - 页面加载完成、canvas 有尺寸、截图不是纯色（原画面确实渲染了）
 *   - 原客户端确实连上 8004 并消费了 handshake
 *   - 无渲染进程崩溃 / 无 error 级控制台输出
 * 结果写入 reports/smoke-original.json 与 smoke-original.png。
 */
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function variance(buffer) {
  // NativeImage.toBitmap() -> 4 bytes/pixel (BGRA)
  let n = 0, sum = 0, sum2 = 0;
  const step = Math.max(4, Math.floor(buffer.length / 4 / 20000) * 4);
  for (let i = 0; i + 3 < buffer.length; i += step) {
    const lum = (buffer[i] * 0.114 + buffer[i + 1] * 0.587 + buffer[i + 2] * 0.299);
    n += 1; sum += lum; sum2 += lum * lum;
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

/** 尝试驱动原 Cocos 登录场景（不修改任何客户端文件，仅运行时调用已有方法）。 */
const AUTO_LOGIN = `(function(){
  try {
    var cc = window.cc || (window.game && window.game.cc);
    if (!cc || !cc.director) return { ok:false, why:'no cc global', globals:Object.keys(window).filter(k=>/cc|cocos|game/i.test(k)).slice(0,20) };
    var scene = cc.director.getScene();
    if (!scene) return { ok:false, why:'no scene' };
    var found = null;
    (function walk(n){
      if (!n || found) return;
      var comps = n.components || [];
      for (var i=0;i<comps.length;i++){
        var c = comps[i];
        var ctor = (c && c.constructor && c.constructor.name) || '';
        if (/LoginLogic/i.test(ctor) || (typeof c.onClickLogin === 'function')) { found = c; return; }
      }
      var kids = n.children || [];
      for (var j=0;j<kids.length;j++) walk(kids[j]);
    })(scene);
    if (!found) return { ok:false, why:'LoginLogic not found' };
    if (found.editName) found.editName.string = 'player';
    if (found.editPass) found.editPass.string = 'smoke123';
    found.onClickLogin();
    return { ok:true, why:'clicked via LoginLogic.onClickLogin' };
  } catch (e) { return { ok:false, why:String(e && e.stack || e) }; }
})()`;

/** 打开原版战报列表 / 详情，验证内核产出的 rounds 能被原 UI 渲染。 */
const REPORT_LIST = `(function(){
  try {
    var cc = window.cc;
    if (!cc || !cc.director) return {ok:false, why:'no cc'};
    // 战报面板是点击「战报」按钮时才实例化，所以要走 MapUILogic.openWarReport()
    var ui = null;
    (function walk(n){
      if(!n || ui) return;
      var cs = n.components || [];
      for(var i=0;i<cs.length;i++){
        var c=cs[i], nm=(c&&c.constructor&&c.constructor.name)||'';
        if(/MapUILogic$/.test(nm) || (c && typeof c.openWarReport==='function')) { ui=c; return; }
      }
      (n.children||[]).forEach(walk);
    })(cc.director.getScene());
    if(!ui) return {ok:false, why:'MapUILogic not found'};
    ui.openWarReport();
    return {ok:true, why:'war report list opened via MapUILogic.openWarReport'};
  } catch(e){ return {ok:false, why:String(e&&e.stack||e)}; }
})()`;

const REPORT_CLICK = `(function(){
  try {
    var cc = window.cc, items = [];
    (function walk(n){
      if(!n) return;
      (n.components||[]).forEach(function(c){
        var nm=(c&&c.constructor&&c.constructor.name)||'';
        if(/WarReportItemLogic$/.test(nm)) items.push(c);
      });
      (n.children||[]).forEach(walk);
    })(cc.director.getScene());
    if(items.length===0) return {ok:false, why:'no WarReportItemLogic'};
    items[0].onClickItem();
    return {ok:true, why:'clicked first war report', items:items.length};
  } catch(e){ return {ok:false, why:String(e&&e.stack||e)}; }
})()`;

/** 地图主界面是否真正就绪（不能只看协议日志，必须看到原 UI 文案）。 */
const MAP_READY = `(function(){
  try {
    var cc = window.cc;
    if(!cc || !cc.director) return {ready:false, why:'no cc'};
    var scene = cc.director.getScene();
    var texts = [];
    (function walk(n){
      if(!n) return;
      (n.components||[]).forEach(function(c){ if(c && typeof c.string === 'string' && c.string) texts.push(c.string); });
      (n.children||[]).forEach(walk);
    })(scene);
    return {
      ready: texts.some(function(t){ return /征收|武将|战报|联盟|募兵|征兵/.test(t); }),
      scene: scene && scene.name,
      texts: texts.slice(0, 16),
    };
  } catch(e){ return {ready:false, why:String(e)}; }
})()`;

/** ★ 新战斗系统验证：直接从原客户端的 resources 里读技能配置。 */
const SKILL_PROBE = `(async function(){
  try {
    var cc = window.cc;
    if(!cc || !cc.director) return {ok:false, why:'no cc'};
    var bundle = cc.resources || (cc.assetManager && cc.assetManager.getBundle('resources'));
    if(!bundle) return {ok:false, why:'no resources bundle'};
    var type = cc.JsonAsset || cc.Asset;
    var assets = await new Promise(function(res){
      try {
        bundle.loadDir('config/json/skill', type, function(){}, function(err, arr){ res(err ? null : arr); });
      } catch(e) { res(null); }
    });
    if(!assets) return {ok:false, why:'loadDir failed'};
    var confs = assets.filter(function(a){ return a && a.json && a.json.cfgId; }).map(function(a){ return a.json; });
    var legacy = ['突击','百战精兵','重斩','锋矢'];
    return {
      ok: true,
      count: confs.length,
      sample: confs.slice(0, 5).map(function(c){ return {
        cfgId:c.cfgId, name:c.name,
        lv1:c.levels[0].effect_value[0], lv10:c.levels[9].effect_value[0],
        p1:c.levels[0].probability, p10:c.levels[9].probability
      }; }),
      legacy: confs.filter(function(c){ return legacy.indexOf(c.name) >= 0; }).map(function(c){ return c.name; }),
      grown: confs.filter(function(c){ return c.levels && c.levels.length === 10 && c.levels[9].effect_value[0] > c.levels[0].effect_value[0]; }).length,
      minCfgId: Math.min.apply(null, confs.map(function(c){ return c.cfgId; })),
      maxCfgId: Math.max.apply(null, confs.map(function(c){ return c.cfgId; })),
    };
  } catch(e) { return {ok:false, why:String(e && e.stack || e)}; }
})()`;

/** 打开原版技能面板（MapUILogic.onClickSkillBtn），验证新表能被原 UI 渲染。 */
const SKILL_PANEL = `(function(){
  try {
    var cc = window.cc;
    if(!cc || !cc.director) return {ok:false, why:'no cc'};
    var ui=null;
    (function walk(n){
      if(!n || ui) return;
      (n.components||[]).forEach(function(c){
        var nm=(c&&c.constructor&&c.constructor.name)||'';
        if(/MapUILogic$/.test(nm) || (c && typeof c.onClickSkillBtn==='function')) ui=c;
      });
      (n.children||[]).forEach(walk);
    })(cc.director.getScene());
    if(!ui) return {ok:false, why:'MapUILogic not found'};
    ui.onClickSkillBtn();
    return {ok:true, why:'skill panel opened'};
  } catch(e){ return {ok:false, why:String(e&&e.stack||e)}; }
})()`;

/** 战报详情里真的渲染出了新战法名（而不是只调用了打开方法）。 */
const REPORT_DETAIL_PROBE = `(function(){
  try {
    var cc = window.cc;
    if(!cc || !cc.director) return {ok:false, why:'no cc'};
    var texts = [], hiddenSkill = 0, desNodes = [];
    (function walk(n){
      if(!n) return;
      var vis = n.activeInHierarchy !== false;
      (n.components||[]).forEach(function(c){
        if(!c || typeof c.string !== 'string' || !c.string) return;
        if(vis) texts.push(c.string);
        else if(/使用技能/.test(c.string)) hiddenSkill += 1;
      });
      (n.children||[]).forEach(walk);
      var comps = n.components || [];
      comps.forEach(function(c){
        var nm=(c&&c.constructor&&c.constructor.name)||'';
        if(/WarReportDes/.test(nm)) desNodes.push({ name:nm, active:n.activeInHierarchy!==false });
      });
    })(cc.director.getScene());
    // 注意：模板字符串里 \d \( 会丢反斜杠，这里刻意用无反斜杠写法
    var skillTexts = texts.filter(function(t){ return t.indexOf('使用技能') >= 0 && t.indexOf('(lv') >= 0 && /lv[0-9]+/.test(t); });
    var anySkillVisible = texts.filter(function(t){ return /使用技能/.test(t); });
    // 旧占位技能必须是「完整技能名」：新战法表里有「全军突击」这类真实战法，
    // 子串 indexOf('突击') 会把它们误判成占位技能导致冒烟假失败。
    // 模板字符串会吞掉反斜杠，用 [(] / [0-9] 等无反斜杠写法。
    var legacyHit = /使用技能[^<]*<color=[^>]*>(突击|百战精兵|重斩|锋矢)[(]lv[0-9]+/;
    var legacy = ['突击','百战精兵','重斩','锋矢'];
    return {
      ok: skillTexts.length > 0,
      skillCount: skillTexts.length,
      visibleSkillNoLv: anySkillVisible.length,
      hiddenSkillTexts: hiddenSkill,
      desNodes: desNodes.slice(0, 6),
      detailTitleVisible: texts.some(function(t){ return /战报详情/.test(t); }),
      sample: (anySkillVisible.length ? anySkillVisible : skillTexts).slice(0, 3).map(function(t){ return t.slice(0, 220); }),
      hasLegacy: skillTexts.some(function(t){ return legacyHit.test(t); }),
    };
  } catch(e){ return {ok:false, why:String(e&&e.stack||e)}; }
})()`;

const PROBE = `({
  cc: typeof window.cc,
  System: typeof window.System,
  back: typeof window.__slgBack,
  canvas: (function(){ var c=document.getElementById('GameCanvas'); return c ? {w:c.width,h:c.height,cw:c.clientWidth,ch:c.clientHeight} : null; })(),
  gameDiv: !!document.getElementById('GameDiv'),
  title: document.title,
  bodyText: (document.body.innerText||'').slice(0,200)
})`;

async function runSmoke(win, server, app) {
  const outDir = process.env.SLG_SMOKE_REPORT_DIR || path.join(__dirname, '..', 'reports');
  const tag = process.env.SLG_SMOKE_TAG || 'original';
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    mode: 'original-web-desktop',
    tag,
    checks: [],
    consoleErrors: [],
  };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: !!ok, detail });
    return !!ok;
  };

  const wc = win.webContents;
  wc.on('console-message', (_e, level, message) => {
    const text = String(message);
    // Electron 开发态的 CSP 提示不是游戏错误，打包后不再出现
    if (/Electron Security Warning/i.test(text)) return;
    if (level >= 2) report.consoleErrors.push({ level, message: text.slice(0, 400) });
  });

  // 等待页面加载 + Cocos 场景创建（注入 31 个技能资源后冷启动会稍慢）
  for (let i = 0; i < 100 && wc.isLoading(); i += 1) await sleep(100);
  for (let i = 0; i < 40; i += 1) {
    const sceneReady = await wc.executeJavaScript(
      '!!(window.cc && window.cc.director && window.cc.director.getScene())', true);
    if (sceneReady) break;
    await sleep(1000);
  }
  await sleep(1500);

  try {
    // 捕获页面内未处理异常的堆栈（只在冒烟进程里挂，不写入任何客户端文件）
    await wc.executeJavaScript(`(function(){
      window.__slgErrors = [];
      window.addEventListener('error', function(e){
        window.__slgErrors.push({ msg:String(e.message), stack:String(e.error && e.error.stack || ''), src:String(e.filename)+':'+e.lineno });
      });
      window.addEventListener('unhandledrejection', function(e){
        window.__slgErrors.push({ msg:'unhandledrejection: '+String(e.reason), stack:String(e.reason && e.reason.stack || '') });
      });
      return true;
    })()`, true);
    const probe = await wc.executeJavaScript(PROBE, true);
    report.probe = probe;
    check('页面标题为原 Cocos 构建产物', /Cocos Creator/.test(probe.title), probe.title);
    check('GameCanvas 存在且尺寸有效', !!probe.canvas && probe.canvas.w > 0 && probe.canvas.h > 0, probe.canvas);
    check('原 GameDiv 容器存在', probe.gameDiv, probe.gameDiv);

    // 冷启动（含 31 个技能资源）时 WS 连接可能晚于页面加载，需等待而不是立即断言
    let status = server.status();
    for (let i = 0; i < 30 && status.connections < 1; i += 1) {
      await sleep(1000);
      status = server.status();
    }
    report.status = {
      connections: status.connections,
      requestLog: status.requestLog,
      battles: status.battles,
      warReports: status.warReports,
    };
    // 客户端首次启动偶发极慢（重打包后资源被重扫）：先等 WS 真正建立，再继续断言
    let connWait = 0;
    for (; connWait < 120; connWait += 1) {
      status = server.status();
      if (status.connections >= 1) break;
      await sleep(1000);
    }
    report.wsWaitSeconds = connWait;
    check('原客户端已建立 WS 连接', status.connections >= 1, status.connections);
    check('原客户端已消费 handshake（后续请求均能被 AES 解密）',
      status.requestLog.length === 0 || status.requestLog.every((x) => typeof x.name === 'string'),
      status.requestLog.length);

    // 尝试自动点登录（若场景尚未建好则重试），让原客户端真正进入地图
    let login = null;
    for (let i = 0; i < 10; i += 1) {
      login = await wc.executeJavaScript(AUTO_LOGIN, true);
      if (login.ok) break;
      await sleep(1000);
    }
    report.autoLogin = login;
    await sleep(9000);
    const status2 = server.status();
    report.statusAfterLogin = {
      requestLog: status2.requestLog,
      connections: status2.connections,
    };
    check('原客户端完成登录链路（account.login / role.enterServer）',
      status2.requestLog.some((x) => x.name === 'account.login') &&
      status2.requestLog.some((x) => x.name === 'role.enterServer'),
      status2.requestLog.map((x) => x.name).slice(-25));
    check('原客户端进入地图（nationMap.config / role.myProperty）',
      status2.requestLog.some((x) => x.name === 'nationMap.config') &&
      status2.requestLog.some((x) => x.name === 'role.myProperty'),
      status2.requestLog.map((x) => x.name).slice(-25));

    // 等原客户端真正把地图场景加载出来（新增 31 个技能资源后会稍慢）
    let mapReady = null;
    for (let i = 0; i < 40; i += 1) {
      mapReady = await wc.executeJavaScript(MAP_READY, true);
      if (mapReady.ready) break;
      await sleep(1000);
    }
    report.mapReady = mapReady;
    check('原地图主界面真正渲染就绪（原 UI 文案可见）', !!mapReady?.ready, mapReady);

    // 固定值战法（原文无 {0} 成长标记）不参与成长计数
    const fixedCount = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'conf', 'skills.json'), 'utf8'))
      .skills.filter((x) => x.kernel.rate_pct_lv1 === x.kernel.rate_pct_lv10).length;

    // ★ 新战斗系统：原客户端 resources 里必须已经是全部新战法
    const skills = await wc.executeJavaScript(SKILL_PROBE, true);
    report.skills = skills;
    check('原客户端加载到全部新战法（运行时注入生效）',
      skills.ok && skills.count >= 24, skills);
    check('原 4 个占位技能未进入客户端',
      skills.ok && skills.legacy.length === 0 && skills.minCfgId >= 10001,
      { legacy: skills.legacy, minCfgId: skills.minCfgId });
    check('技能 10 级数值在客户端真实成长',
      skills.ok && skills.grown >= skills.count - fixedCount, { grown: skills.grown, count: skills.count, fixedCount });

    // 打开原版技能面板并截图（新战法名 / 等级数值由原 UI 渲染）
    const skillPanel = await wc.executeJavaScript(SKILL_PANEL, true);
    report.skillPanel = skillPanel;
    check('原版技能面板可打开', skillPanel.ok, skillPanel);
    await sleep(1200);
    const skillImage = await win.capturePage();
    fs.writeFileSync(path.join(outDir, `smoke-skills-${tag}.png`), skillImage.toPNG());
    await wc.executeJavaScript(`(function(){ try { if(typeof window.__slgBack==='function'){ window.__slgBack(); } return true; } catch(e){ return false; } })()`, true);
    await sleep(600);

    // 在【游戏正在运行】的情况下再跑一场真实战斗：
    // 第二条 WS 连接下达出征 → 内核结算 → warReport.push 广播（原客户端战报 UI 同步收到）
    // 地图未就绪时不要推送，否则原 UI 会拿到未初始化的角色数据（冒烟自身误报）
    if (!report.mapReady?.ready) {
      check('运行中原客户端环境完成内核战斗并产出原版战报', false, '地图未就绪，跳过战斗');
      check('战斗事件指纹可复核（确定性内核）', false, '地图未就绪');
    } else {
    try {
      const { ProtocolClient } = await import('../tests/client.js');
      const battleClient = new ProtocolClient('ws://127.0.0.1:8004', { timeout: 15000 });
      await battleClient.connect();
      const st = server.getState();
      const army = st.armys[0];
      await battleClient.request('account.login', { username: 'smoke' });
      await battleClient.request('role.enterServer', { session: 'offline-session' });
      await battleClient.request('army.assign', {
        armyId: army.id, cmd: 1, x: st.citys[0].x, y: st.citys[0].y + 1,
      });
      const push = await battleClient.waitFor((f) => f.name === 'warReport.push' && f.seq === 0, 15000);
      const r = push.msg;
      check('运行中原客户端环境完成内核战斗并产出原版战报',
        [0, 1, 2].includes(r.result) && typeof r.rounds === 'string' &&
        Array.isArray(JSON.parse(r.rounds)),
        { id: r.id, result: r.result, rounds: JSON.parse(r.rounds).length });
      const bl = server.getState().battleLog.at(-1);
      report.battle = {
        id: r.id, result: r.result, seed: bl?.seed,
        events: bl?.events, event_fingerprint: bl?.event_fingerprint,
        rng_calls: bl?.rng_calls,
      };
      check('战斗事件指纹可复核（确定性内核）',
        /^[0-9a-f]{16}$/.test(bl?.event_fingerprint || '') && bl?.events > 0, report.battle);
      const reportSkillHits = JSON.parse(r.rounds).flatMap((rd) => rd.b.flatMap((h) =>
        [...(h.a_bs || []), ...(h.a_as || []), ...(h.d_as || [])]));
      check('战报技能全部来自新战法表（非旧 101/201/301/401，等级非写死 10）',
        reportSkillHits.length > 0 &&
        reportSkillHits.every((h) => h.c_id >= 10001 && h.lv >= 1 && h.lv <= 10) &&
        reportSkillHits.some((h) => h.lv !== 10),
        { count: reportSkillHits.length, ids: [...new Set(reportSkillHits.map((h) => h.c_id))].slice(0, 8),
          levels: [...new Set(reportSkillHits.map((h) => h.lv))] });
      battleClient.close();
    } catch (err) {
      check('运行中原客户端环境完成内核战斗并产出原版战报', false, String(err && err.stack || err));
    }
    }

    // 关掉可能自动弹出的面板，回到原来的大地图主界面再截图
    await wc.executeJavaScript(`(function(){
      try { if(typeof window.__slgBack==='function'){ window.__slgBack(); window.__slgBack(); } return true; }
      catch(e){ return false; }
    })()`, true);
    await sleep(900);

    // 截图：证明原画面真的渲染出来了（不是纯色/黑屏）
    const image = await win.capturePage();
    const png = image.toPNG();
    fs.writeFileSync(path.join(outDir, `smoke-${tag}.png`), png);
    const bmp = image.toBitmap();
    const v = variance(bmp);
    report.screenshot = { bytes: png.length, variance: Math.round(v) };
    check('截图有画面内容（非纯色/黑屏）', v > 25, report.screenshot);

    // 打开原版战报列表 + 详情：这是 battle-core 输出最终被原 UI 消费的地方
    const listResult = await wc.executeJavaScript(REPORT_LIST, true);
    await sleep(1500);
    const clickResult = await wc.executeJavaScript(REPORT_CLICK, true);
    let detail = null;
    for (let i = 0; i < 8; i += 1) {
      await sleep(700);
      detail = await wc.executeJavaScript(REPORT_DETAIL_PROBE, true);
      if (detail.ok) {
        // 立即截图 + 二次探针：区分"截图时机错过面板"和"探针误报可见"
        const img = await win.capturePage();
        fs.writeFileSync(path.join(outDir, `smoke-warreport-${tag}.png`), img.toPNG());
        detail.afterCapture = await wc.executeJavaScript(REPORT_DETAIL_PROBE, true);
        break;
      }
    }
    report.warReportUI = { list: listResult, click: clickResult, detail };
    check('原版战报列表可打开', listResult.ok, listResult);
    check('原版战报详情可打开（内核 rounds 被 WarReportDesLogic 渲染）',
      clickResult.ok, clickResult);
    check('战报详情显示新战法名、无旧占位技能名',
      detail?.ok === true && detail.hasLegacy === false,
      detail);
    // 详情截图已在探针成功瞬间完成（见上方轮询内逻辑）

    // 战略层本城页：存档卡（三档位 + 导出/导入）必须在真实页面里渲染出来（试玩 P2-5）
    const homePage = await wc.executeJavaScript(`(async function(){
      try {
        if (typeof window.__slgStrategyShow === 'function') window.__slgStrategyShow();
        await new Promise(function(r){ setTimeout(r, 1200); });
        if (typeof window.__slgHomeWindow === 'function') window.__slgHomeWindow();
        else { var btn = document.getElementById('slgBtnHome'); if (btn) btn.click(); }
        // 本城页要串行拉设施、资源、meta、存档档位，给足时间
        var text = '';
        for (var i = 0; i < 24; i++) {
          await new Promise(function(r){ setTimeout(r, 500); });
          var w = document.getElementById('slgCityWin');
          text = w ? (w.textContent || '') : '';
          if (text.indexOf('导出存档文件') >= 0) break;
        }
        var win = document.getElementById('slgCityWin');
        return {
          ok: text.indexOf('存档') >= 0 && text.indexOf('导出存档文件') >= 0,
          slotRows: (text.match(/号档/g) || []).length,
          hasImport: text.indexOf('导入存档文件') >= 0,
          hasWin: !!win,
          winVisible: win ? win.offsetParent !== null : false,
          len: text.length,
          sample: text.slice(0, 160),
        };
      } catch (e) { return { ok: false, error: String(e) }; }
    })()`, true);
    report.homePage = homePage;
    check('本城页存档卡渲染（三档位 + 导出/导入）',
      homePage?.ok === true && (homePage.slotRows || 0) >= 3 && homePage.hasImport === true, homePage);
    await sleep(400);

    // 合并后检查：六府入口须让位于战略层弹层，且不与战略层左上按钮坞重叠
    const dockState = await wc.executeJavaScript(`(function(){
      try {
        var d = document.getElementById('slgPanelsDock');
        if (!d) return { ok:false, reason:'no dock' };
        var z = Number(getComputedStyle(d).zIndex), r = d.getBoundingClientRect();
        var other = document.getElementById('slgDock');
        var or = other ? other.getBoundingClientRect() : null;
        var overlap = !!or && or.width > 0 &&
          !(r.right < or.left || r.left > or.right || r.bottom < or.top || r.top > or.bottom);
        return {
          ok: z > 99998 && z < 100000 && !overlap && r.width > 0 && r.width <= 140,
          zIndex: z, overlapWithStrategyDock: overlap, width: r.width,
          rect: { left:r.left, top:r.top, right:r.right, bottom:r.bottom },
        };
      } catch(e){ return { ok:false, error:String(e) }; }
    })()`, true);
    fs.writeFileSync(path.join(outDir, `smoke-dock-${tag}.png`), (await win.capturePage()).toPNG());
    report.panelDock = dockState;
    check('六府入口层级让位且与战略层按钮坞不重叠', dockState?.ok === true, dockState);

    // ★ P0-2：战报入口必须常驻六府 dock 且红点端点可用
    const repBtn = await wc.executeJavaScript(`(async function(){
      try {
        var b = document.querySelector('#slgPanelsBtns .pb[data-id="__reports"]');
        if (!b) return { ok:false, reason:'no reports button in panels dock' };
        var dot = document.getElementById('slgRepDot');
        var r = await fetch('/__slg/panels/reports-head', { cache:'no-store' });
        var v = await r.json();
        return { ok: !!v.ok, unread: v.unread, latest: v.latest, hasDot: !!dot,
          visible: getComputedStyle(b).display !== 'none' };
      } catch(e){ return { ok:false, error:String(e) }; }
    })()`, true);
    report.reportEntry = repBtn;
    check('战报入口常驻六府 dock 且红点端点可用',
      repBtn?.ok === true && repBtn?.visible === true && repBtn?.hasDot === true, repBtn);

    // 六面板体系 P0：真实页面里逐一点开，并核对「51 条战法每条都有获取途径」
    const panels = await wc.executeJavaScript(`(async function(){
      try {
        if (!window.__slgPanels) return { ok:false, reason:'no __slgPanels (ui.js 未注入)' };
        for (var w=0; w<20 && !window.__slgPanels.state(); w++) {
          await new Promise(function(r){ setTimeout(r, 300); });
        }
        var tabs=['general','strategy','interior','depot','equip','library'], out={};
        for (var i=0;i<tabs.length;i++){
          window.__slgPanels.open(tabs[i]);
          await new Promise(function(r){ setTimeout(r, 420); });
          var b=document.getElementById('slgPanelsBody');
          var tx=b?(b.textContent||''):'';
          var stratKeys=['关隘与行军','诸侯战役意图','出征账','守军（沙盘实时）','选择目标城（全'];
          out[tabs[i]]={
            len: tx.length, sample: tx.slice(0,70),
            overflowX: b ? (b.scrollWidth - b.clientWidth > 4) : true,
            stratKeys: tabs[i]==='strategy' ? stratKeys.filter(function(k){ return tx.indexOf(k)>=0; }) : null,
          };
        }
        var stratOk = !!out.strategy.stratKeys && out.strategy.stratKeys.length === 5;
        var st=window.__slgPanels.state();
        var libOk = !!st && st.library.length === 51
          && st.library.every(function(s){ return s.sources && s.sources.length >= 2; });
        window.__slgPanels.open('library');
        await new Promise(function(r){ setTimeout(r, 250); });
        var hd=document.querySelector('[data-act="skilldetail"]');
        if (hd) hd.click();
        await new Promise(function(r){ setTimeout(r, 300); });
        var b2=document.getElementById('slgPanelsBody');
        var showSource=(b2?(b2.textContent||''):'').indexOf('如何获得') >= 0;
        return {
          ok: tabs.every(function(t){ return out[t].len > 120 && !out[t].overflowX; })
            && libOk && showSource && stratOk,
          tabs: out, libOk: libOk, showSource: showSource, stratOk: stratOk,
          total: st ? st.library.length : 0,
          sourcesCovered: st ? st.librarySummary.sourcesCovered : 0,
        };
      } catch(e){ return {ok:false, error:String(e)}; }
    })()`, true);
    const panelImg = await win.capturePage();
    fs.writeFileSync(path.join(outDir, `smoke-panels-${tag}.png`), panelImg.toPNG());
    // 战略台单独留图：合并后新增关隘 / 诸侯意图 / 出征账三块，需肉眼确认版式
    await wc.executeJavaScript('(function(){ if(window.__slgPanels) window.__slgPanels.open("strategy"); return true; })()', true);
    await sleep(350);
    fs.writeFileSync(path.join(outDir, `smoke-panels-strategy-${tag}.png`), (await win.capturePage()).toPNG());
    await wc.executeJavaScript('(function(){ if(window.__slgPanels) window.__slgPanels.close(); return true; })()', true);
    report.panels = panels;
    check('六面板均可打开且有内容；51 条战法每条可见获取途径',
      panels?.ok === true, panels);
    await sleep(300);

    report.pageErrors = await wc.executeJavaScript('window.__slgErrors || []', true);
    check('页面无未捕获异常（含战报详情渲染）', report.pageErrors.length === 0, report.pageErrors.slice(0, 6));
    check('无渲染进程 error 级控制台输出', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 10));
  } catch (err) {
    check('冒烟过程无异常', false, String(err && err.stack || err));
  }

  report.finishedAt = new Date().toISOString();
  report.failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  report.passed = report.failed.length === 0;
  fs.writeFileSync(path.join(outDir, `smoke-${tag}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log('[slg-offline:smoke]', JSON.stringify({ passed: report.passed, failed: report.failed, probe: report.probe, autoLogin: report.autoLogin }, null, 2));

  if (process.env.SLG_SMOKE_EXIT === '1') {
    setTimeout(() => app.exit(report.passed ? 0 : 1), 500);
  }
  return report;
}

module.exports = { runSmoke };
