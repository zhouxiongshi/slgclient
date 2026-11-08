/**
 * 离线单机协议服务入口。
 *
 * 端口刻意与原 GameConfig.ts 完全一致（ws 8004 / http 8088），
 * 因此原 web-desktop 构建产物一个字节都不用改就能连上：
 *   serverUrl: "ws://127.0.0.1:8004"
 *   webUrl   : "http://127.0.0.1:8088"
 *
 * 职责：
 *   - 8088：原画面静态资源 + /account/register 等 HTTP 接口
 *   - 8004：原网关线协议（handshake / gzip / AES / {seq,name,msg} 路由）
 *   - 单机世界状态：JSON 存档；定时任务持久化，重启续跑
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, defaultConfDir } from './config.js';
import { createWorld, loadWorld, saveWorld, resolveWebDir, normalizeWorld } from './world.js';
import { handleRequest, processTask } from './handlers.js';
import { handshakeFrame, encodeFrame, decodeFrame, generateKey } from './codec.js';
import { attachWebSocketServer } from './wsserver.js';
import { createSkillAssets } from './skills.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.bin': 'application/octet-stream',
  '.ccon': 'application/octet-stream',
  '.cconb': 'application/octet-stream',
  '.plist': 'application/xml; charset=utf-8',
};

/** @returns {Promise<{close:Function, ctx:Object, status:Function, resetWorld:Function, ports:Object}>} */
export async function startOfflineServer(options = {}) {
  const {
    webDir = resolveWebDir(),
    saveDir = options.saveDir || resolve(ROOT, 'saves'),
    confDir = defaultConfDir(),
    httpPort = 8088,
    wsPort = 8004,
    travelMs = 3000,
    quiet = false,
  } = options;
  const savePath = join(saveDir, 'save.json');
  const cfg = loadConfig(confDir);
  // 新战斗系统：运行时重写技能资源（磁盘上的原 web-desktop 保持逐字节不变）
  const skillAssets = createSkillAssets(webDir);
  let state = normalizeWorld(loadWorld(savePath) || createWorld(cfg), cfg);
  const logs = [];
  const requestLog = [];
  const startedAt = Date.now();

  const log = (level, message) => {
    const entry = { t: Date.now(), level, message };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    if (!quiet) console.log(`[slg-offline:${level}] ${message}`);
  };

  let saveTimer = null;
  const flush = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveWorld(savePath, state);
  };
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveWorld(savePath, state); }, 250);
  };

  let wss = null; // 稍后赋值，push 需要它

  const ctx = {
    cfg,
    get state() { return state; },
    options: { travelMs, webDir, saveDir },
    save,
    log,
    push(name, msg) {
      const obj = { seq: 0, name, code: 0, msg };
      if (!wss) return;
      for (const conn of wss.connections) {
        if (!conn.meta.key) continue;
        try { conn.send(encodeFrame(obj, conn.meta.key)); } catch (err) { log('error', `push failed: ${err.message}`); }
      }
    },
    schedule(at, task) {
      state.pending.push({ at, task });
      save();
    },
  };

  /* ---------------- 定时任务（存档持久化，重启续跑） ---------------- */
  const tick = setInterval(() => {
    const now = Date.now();
    const due = state.pending.filter((p) => p.at <= now);
    if (due.length === 0) return;
    state.pending = state.pending.filter((p) => p.at > now);
    for (const p of due) {
      try { processTask(ctx, p.task); } catch (err) { log('error', `task ${p.task.type}: ${err.stack || err.message}`); }
    }
    save();
  }, 200);

  /* ---------------- HTTP 8088：原画面 + 账号接口 ---------------- */
  /** 静态文件响应：读取成功才发响应；读流出错（如新打包文件被杀毒/索引短暂锁定）自动重试，绝不让请求悬死。 */
  const serveStatic = (rawPath, res, attempt = 0) => {
    let urlPath = rawPath;
    if (urlPath === '/') urlPath = '/index.html';
    const target = resolve(webDir, `.${urlPath}`);
    const root = resolve(webDir);
    if (!target.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    let body;
    try {
      body = readFileSync(target);
    } catch (err) {
      if (attempt < 5) {
        log('warn', `read retry ${attempt + 1}/5 for ${urlPath}: ${err.message}`);
        setTimeout(() => serveStatic(rawPath, res, attempt + 1), 250);
        return;
      }
      log('error', `static read failed for ${urlPath}: ${err.stack || err.message}`);
      res.writeHead(500); res.end('Internal error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    res.end(body);
  };

  const httpServer = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch { res.writeHead(400); res.end('Bad request'); return; }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // 原 HTTP 账号接口
    if (urlPath.startsWith('/account/')) {
      if (urlPath === '/account/forgetpwd') { res.writeHead(200); res.end('forgetPwd'); return; }
      if (urlPath === '/account/resetpwd') { res.writeHead(200); res.end('resetPwd'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }

    // 本地调试 / 冒烟用只读端点
    if (urlPath === '/__slg/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true, startedAt, uptimeMs: Date.now() - startedAt,
        httpPort, wsPort, webDir, savePath,
        connections: wss?.connections.size ?? 0,
        pending: state.pending.length,
        warReports: state.warReports.length,
        battles: state.battleLog.length,
        requestLog: requestLog.slice(-80),
        logs: logs.slice(-40),
        skills: skillAssets.stats,
      }, null, 2));
      return;
    }
    if (urlPath === '/__slg/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state));
      return;
    }

    // 新战斗系统的数据注入：仅重写技能资源的 HTTP 响应，磁盘文件不动
    let override = null;
    try { override = skillAssets.intercept(urlPath); }
    catch (err) { log('error', `skill intercept failed for ${urlPath}: ${err.stack || err.message}`); }
    if (override) {
      res.writeHead(200, {
        'Content-Type': override.contentType,
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(override.body),
      });
      res.end(override.body);
      return;
    }

    // 静态资源：直接指向原 web-desktop 构建产物
    try {
      serveStatic(urlPath, res);
    } catch (err) {
      log('error', `static serve failed for ${urlPath}: ${err.stack || err.message}`);
      if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); } else res.destroy();
    }
  });

  /* ---------------- WS 8004：原网关线协议 ---------------- */
  const wsHttpServer = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  wss = attachWebSocketServer(wsHttpServer, {
    onConnection(conn) {
      const key = generateKey(Date.now() ^ (conn.socket.remotePort || 1));
      conn.meta.key = key;
      conn.send(handshakeFrame(key));   // ★ 必须第一帧，否则客户端一直停在 Checking
      log('info', `ws connected, handshake sent (key=${key})`);
    },
    onClose() { log('info', 'ws closed'); },
    onError(err) { log('error', `ws error: ${err.stack || err.message}`); },
    onMessage(conn, frame) {
      let req;
      try { req = decodeFrame(frame, conn.meta.key); }
      catch (err) { log('error', `decode failed: ${err.message}`); return; }
      requestLog.push({ t: Date.now(), name: req.name, seq: req.seq });
      if (requestLog.length > 500) requestLog.shift();

      let out;
      try { out = handleRequest(ctx, req); }
      catch (err) {
        log('error', `handler ${req.name}: ${err.stack || err.message}`);
        out = { code: 0, msg: {} };
      }
      const body = {
        seq: out.seq ?? req.seq ?? 0,
        name: req.name,           // ★ 原样回显
        code: out.code ?? 0,
        msg: out.msg ?? {},
      };
      try { conn.send(encodeFrame(body, conn.meta.key)); }
      catch (err) { log('error', `encode failed: ${err.message}`); }
    },
  });

  const listen = (server, port) => new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', fail); ok(); });
  });

  await listen(httpServer, httpPort);
  await listen(wsHttpServer, wsPort);
  log('info', `ready: http://127.0.0.1:${httpPort}/  ws://127.0.0.1:${wsPort}  webDir=${webDir}`);

  return {
    ctx,
    ports: { http: httpPort, ws: wsPort },
    status: () => ({
      ok: true, startedAt, uptimeMs: Date.now() - startedAt,
      connections: wss.connections.size, pending: state.pending.length,
      warReports: state.warReports.length, battles: state.battleLog.length,
      requestLog: [...requestLog], logs: [...logs],
      skills: skillAssets.stats,
    }),
    resetWorld() {
      state = createWorld(cfg);
      flush();
      log('info', 'world reset');
    },
    getState: () => state,
    async close() {
      clearInterval(tick);
      flush();
      wss.closeAll();
      await new Promise((r) => wsHttpServer.close(r));
      await new Promise((r) => httpServer.close(r));
    },
  };
}
