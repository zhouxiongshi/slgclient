/**
 * Electron 壳：只做三件事
 *   1) 在本进程内启动离线协议服务（127.0.0.1:8088 / 8004）
 *   2) 用 BrowserWindow 加载【原 web-desktop 构建产物】的 index.html
 *   3) 存档放 userData，崩溃写日志
 *
 * 不向页面注入任何脚本、不修改 index.html、不替换任何资源：
 * 呈现的就是原来那套地图 / 城池 / 建筑 / UI。
 */
const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
/* 控制台级别的新旧签名归一化，与 smoke.cjs / ui-audit.cjs 共用同一口径 */
const { consoleSeverity, consolePayload } = require('./console-level.cjs');

const ROOT = path.join(__dirname, '..');
const PACKAGED_WEB = path.join(ROOT, 'web');

let win = null;
let server = null;

function logError(err) {
  const line = `[${new Date().toISOString()}] ${err instanceof Error ? err.stack || err.message : String(err)}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line, 'utf8');
  } catch { /* ignore */ }
  console.error(line);
}

async function bootServer() {
  const mod = await import('../server/index.js');
  const opts = {
    saveDir: path.join(app.getPath('userData'), 'saves'),
    httpPort: 8088,
    wsPort: 8004,
    travelMs: 3000,
  };
  // 打包后 web/ 随包携带；开发态直接用原工程的 build/web-desktop
  if (fs.existsSync(path.join(PACKAGED_WEB, 'index.html'))) {
    opts.webDir = PACKAGED_WEB;
  }
  return mod.startOfflineServer(opts);
}

function createWindow() {
  // ★ P2-3：窗口必须落在可用工作区内。旧实现固定 1280×720 且不居中，
  //   在小屏/多显示器上右边界会超出屏幕，顶部「天下」按钮被裁掉。
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1280, area.width - 40);
  const height = Math.min(720, area.height - 40);
  win = new BrowserWindow({
    width,
    height,
    /* ★ 玩家反馈：窗口「缩不小」。旧值 1024×576 把可拖动下限卡死，放宽到
       900×540（布局矩阵仍以 ≥1280 为验收基准，小窗由断点样式自适应）。 */
    minWidth: Math.min(900, width),
    minHeight: Math.min(540, height),
    center: true,
    title: '霜寒定九州',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    show: false,
    /* ★ 玩家反馈：游戏一直压在其他应用上面，点不到别的窗口、也点不到任务栏的
       最小化按钮。旧实现在自动化测试分支把窗口设成 screen-saver 级置顶，
       该层在 Windows 高于任务栏；一旦进程继承了 SLG_* 环境变量，正常游玩也会
       变成永久置顶。遮挡导致 rAF 停摆的问题已由 backgroundThrottling:false 根治，
       所以这里把「默认绝不置顶 / 可最小化 / 可缩放」写成显式契约。 */
    alwaysOnTop: false,
    minimizable: true,
    maximizable: true,
    resizable: true,
    fullscreenable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webgl: true,
      /* 窗口行为（置顶开关 / 最小化）的唯一受控通道；不暴露 node / ipcRenderer。 */
      preload: path.join(__dirname, 'preload.cjs'),
      /* ★ 自动化必须关掉后台节流：窗口一旦被判定为遮挡/失焦，Chromium 会把
         requestAnimationFrame 降到 0，Cocos 的 director 就永远不建场景
         （FPS 0 / Draw call 0），测试看起来像「页面没加载」。 */
      backgroundThrottling: false,
    },
  });

  // ★ P2-1：页面自带的 <title>（Cocos Creator | SLG Demo）不许覆盖窗口标题
  win.on('page-title-updated', (e) => { e.preventDefault(); });

  win.once('ready-to-show', () => {
    win.show();
    /* 自动化模式只做一次聚焦，绝不再置顶：遮挡节流已由 backgroundThrottling:false
       与 webContents.setBackgroundThrottling(false) 双重兜住，无需霸占桌面。
       若确实需要强制前台（无人值守的 CI），显式设 SLG_FORCE_TOP=1，且只用
       floating 层——不会盖住任务栏与系统级窗口；默认关闭。 */
    const automated = process.env.SLG_SMOKE === '1' || process.env.SLG_AUDIT === '1'
      || process.env.SLG_MOUSE === '1' || process.env.SLG_PERF === '1' || process.env.SLG_LAYOUT === '1'
      || process.env.SLG_DIAG === '1';
    if (automated) {
      try {
        win.focus();
        win.webContents.setBackgroundThrottling(false);
        if (process.env.SLG_FORCE_TOP === '1') win.setAlwaysOnTop(true, 'floating');
      } catch { /* ignore */ }
    }
    if (process.env.SLG_SMOKE === '1') {
      require('./smoke.cjs').runSmoke(win, server, app).catch(logError);
    } else if (process.env.SLG_AUDIT === '1') {
      require('./ui-audit.cjs').runAudit(win, server, app).catch(logError);
    } else if (process.env.SLG_MOUSE === '1') {
      require('./mouse-playtest.cjs').runMousePlaytest(win, server, app).catch(logError);
    } else if (process.env.SLG_PERF === '1') {
      require('./perf-probe.cjs').runPerf(win, server, app).catch(logError);
    } else if (process.env.SLG_LAYOUT === '1') {
      require('./layout-audit.cjs').runLayout(win, server, app).catch(logError);
    } else if (process.env.SLG_DIAG === '1') {
      require('./ui-probe.cjs').runProbe(win, server, app).catch(logError);
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    logError(new Error(`renderer gone: ${JSON.stringify(details)}`));
  });
  /* ★ 修：Electron 35+ 的 console-message 只传一个事件对象，旧的三参写法让 level
     恒为 undefined，`level >= 2` 永远为假 —— 主进程这边「renderer console: …」的
     崩溃日志同样从未真正记过。归一化走 console-level.cjs（唯一口径）。 */
  win.webContents.on('console-message', (...args) => {
    const d = consolePayload(args);
    const text = String(d.message == null ? '' : d.message);
    if (/Electron Security Warning/i.test(text)) return; // 开发态 CSP 提示，非游戏错误
    if (consoleSeverity(d.level) >= 2) logError(new Error(`renderer console: ${text}`));
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:8088/')) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });

  // 页面加载失败（如首启偶发的资源竞态）自动重试，最多 3 次
  let reloads = 0;
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || reloads >= 3) return;
    reloads += 1;
    logError(new Error(`load failed (${code} ${desc}), retrying ${reloads}/3`));
    setTimeout(() => win && win.webContents.loadURL('http://127.0.0.1:8088/index.html'), 1500);
  });
  /* 性能探针的「首屏」从 loadURL 这一刻算起（GDD §11.5 预算 <3s）：
     必须含主进程起服务 + 页面加载 + Cocos 场景创建 + 注入层首帧。 */
  global.__slgBootT0 = Date.now();
  win.loadURL('http://127.0.0.1:8088/index.html');
}

process.on('uncaughtException', logError);
process.on('unhandledRejection', logError);

// 冒烟/审计/试玩/性能时用隔离的临时 userData，保证每轮都是全新存档 / 空 localStorage，结果可复现
if (process.env.SLG_SMOKE === '1' || process.env.SLG_AUDIT === '1'
  || process.env.SLG_MOUSE === '1' || process.env.SLG_PERF === '1' || process.env.SLG_LAYOUT === '1'
  || process.env.SLG_DIAG === '1') {
  const os = require('node:os');
  const kind = process.env.SLG_MOUSE === '1' ? 'mouse'
    : process.env.SLG_PERF === '1' ? 'perf'
      : process.env.SLG_LAYOUT === '1' ? 'layout'
        : process.env.SLG_DIAG === '1' ? 'probe'
          : (process.env.SLG_AUDIT === '1' ? 'audit' : 'smoke');
  /* ★ 只用 pid 命名不够：pid 会被系统复用，复用时会捡到上一轮留下的 save.json，
     于是「举义页」被跳过，同一份脚本跑出来的路径数在 57/59 之间抖 —— 测试就不可复现了。
     加时间戳后缀，保证每轮真的是空存档。 */
  /* 确定性：pid 会被系统复用，加时间戳 + 高精度单调计数；不引入随机数。 */
  const stamp = Date.now().toString(36) + '-' + process.hrtime.bigint().toString(36);
  app.setPath('userData', path.join(os.tmpdir(), `slg-offline-${kind}-${process.pid}-${stamp}`));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  /* 二次启动只把已有窗口「显示出来」，不抢焦点：玩家正在别的应用里时，
     不该被游戏强行拽回前台。 */
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.showInactive();
  });
  app.whenReady().then(async () => {
    // ★ P2-2：去掉 Electron 默认 File/Edit/View 菜单（按 Alt 会弹出来，完全不像正式游戏）
    Menu.setApplicationMenu(null);
    try {
      server = await bootServer();
      ipcMain.handle('app:status', () => server.status());
      /* 窗口行为 IPC：只在玩家于「快捷键 / 设置」里显式操作时才改。
         永不自动置顶；置顶也只用 floating 层，不使用 screen-saver 层。 */
      ipcMain.handle('win:is-always-on-top', () => !!(win && win.isAlwaysOnTop()));
      ipcMain.handle('win:always-on-top', (_e, on) => {
        if (!win) return false;
        win.setAlwaysOnTop(!!on, 'floating');
        return win.isAlwaysOnTop();
      });
      ipcMain.handle('win:minimize', () => {
        if (win && win.isMinimizable()) win.minimize();
        return true;
      });
      createWindow();
    } catch (err) {
      logError(err);
      const { dialog } = require('electron');
      dialog.showErrorBox('启动失败', `本地服务无法启动：${err.message}`);
      app.quit();
    }
  });
  app.on('window-all-closed', async () => {
    try { await server?.close(); } catch (err) { logError(err); }
    app.quit();
  });
}
