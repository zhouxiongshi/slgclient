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
    minWidth: Math.min(1024, width),
    minHeight: Math.min(576, height),
    center: true,
    title: '霜寒定九州',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webgl: true,
    },
  });

  // ★ P2-1：页面自带的 <title>（Cocos Creator | SLG Demo）不许覆盖窗口标题
  win.on('page-title-updated', (e) => { e.preventDefault(); });

  win.once('ready-to-show', () => {
    win.show();
    if (process.env.SLG_SMOKE === '1') {
      require('./smoke.cjs').runSmoke(win, server, app).catch(logError);
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    logError(new Error(`renderer gone: ${JSON.stringify(details)}`));
  });
  win.webContents.on('console-message', (_e, level, message) => {
    const text = String(message);
    if (/Electron Security Warning/i.test(text)) return; // 开发态 CSP 提示，非游戏错误
    if (level >= 2) logError(new Error(`renderer console: ${text}`));
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
  win.loadURL('http://127.0.0.1:8088/index.html');
}

process.on('uncaughtException', logError);
process.on('unhandledRejection', logError);

// 冒烟时用隔离的临时 userData，保证每轮都是全新存档 / 空 localStorage，结果可复现
if (process.env.SLG_SMOKE === '1') {
  const os = require('node:os');
  app.setPath('userData', path.join(os.tmpdir(), `slg-offline-smoke-${process.pid}`));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    // ★ P2-2：去掉 Electron 默认 File/Edit/View 菜单（按 Alt 会弹出来，完全不像正式游戏）
    Menu.setApplicationMenu(null);
    try {
      server = await bootServer();
      ipcMain.handle('app:status', () => server.status());
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
