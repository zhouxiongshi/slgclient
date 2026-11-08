/**
 * Electron 壳：只做三件事
 *   1) 在本进程内启动离线协议服务（127.0.0.1:8088 / 8004）
 *   2) 用 BrowserWindow 加载【原 web-desktop 构建产物】的 index.html
 *   3) 存档放 userData，崩溃写日志
 *
 * 不向页面注入任何脚本、不修改 index.html、不替换任何资源：
 * 呈现的就是原来那套地图 / 城池 / 建筑 / UI。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
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
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 576,
    title: '三国策略 · 单机版',
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
