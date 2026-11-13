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
import { existsSync, statSync, readFileSync, renameSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadConfig, defaultConfDir } from './config.js';
import { createWorld, loadWorld, saveWorld, resolveWebDir, normalizeWorld, hasProtagonist } from './world.js';
import { handleRequest, processTask, settleWorld, advanceToNextTurn } from './handlers.js';
import { handshakeFrame, encodeFrame, decodeFrame, generateKey } from './codec.js';
import { attachWebSocketServer } from './wsserver.js';
import { createSkillAssets } from './skills.js';
import { loadOverrides, saveOverrides } from './gm/overrides.js';
import { dossierFor } from './domain/dossier.js';
import {
  strategyViewState, oathOptions, chooseOath, strategyFormup, strategyTransport,
  rewardGeneral, strategyInvest, recruitCaptive, strategyAttack, strategyRecallMarch, cancelInvest,
  previewAssault, strategyReorderMarch,
  strategyAppoint, strategyCancelAppointment, diplomacyAct,
} from './domain/strategy.js';
import { panelState, panelAction, panelSelfCheck } from './domain/panels.js';
/* 交互增强层：只读聚合（纯函数），不改 WS 协议与消息结构 */
import { interactionState } from './domain/interaction.js';
/* ★ M2-3 失败态四出路（GDD §3.4）：破产裁军/卖粮、兵尽紧急征兵·雇佣、无将代将、迁都 */
import { disarmForGold, sellGrain, emergencyConscript, relocateCapital } from './domain/failstate.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 六面板浏览器端源码：单文件、原样下发，不经打包也不改动磁盘 web/。
 * 直接读文本而非 import，保证该文件保持纯浏览器脚本（可单独 node --check）。
 */
export const PANELS_UI_SOURCE = readFileSync(resolve(ROOT, 'server/panels-ui.js'), 'utf8');

/**
 * 交互增强层（设计规格 6.1~6.11）：独立浏览器 IIFE，唯一一份源码。
 * 术语表在启动期读一次并内联进脚本前缀 —— 运行时内存查表，零网络请求、零外部依赖，
 * 且与 conf/interaction/terms.json 是同一份数据（描述 = 计算 = 战报同源）。
 */
const IX_TERMS = JSON.parse(readFileSync(resolve(ROOT, 'conf/interaction/terms.json'), 'utf8'));
export const IX_SOURCE = 'window.SLG_TERMS=' + JSON.stringify(IX_TERMS) + ';\n'
  + readFileSync(resolve(ROOT, 'server/interaction-ui.js'), 'utf8');

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
  let loaded = loadWorld(savePath);
  if (loaded && !hasProtagonist(loaded)) {
    // 序章改造前的旧档：没有穿越者，也没有游戏日。归档留底，重开新局。
    const backup = `${savePath}.pre-prologue-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    try { renameSync(savePath, backup); console.log(`[slg-offline:info] 旧档无穿越者主公，已归档为 ${backup}，重开序章`); } catch { /* 归档失败则不读旧档 */ }
    loaded = null;
  }
  let state = normalizeWorld(loaded || createWorld(cfg), cfg);
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

  /* ---------------- 存档档位与 HTTP 小工具（试玩 P2-5） ---------------- */
  /** 1 号档就是正在玩的 save.json（兼容旧档），2/3 号档另起文件 */
  const slotPathOf = (n) => (Number(n) === 1 ? savePath : join(saveDir, `save.slot${Number(n)}.json`));
  const slotInfoOf = (n) => {
    const p = slotPathOf(n);
    const out = { slot: n, path: p, exists: false };
    try {
      const st = statSync(p);
      out.exists = true;
      out.bytes = st.size;
      out.updatedAt = st.mtime.toISOString();
      const data = loadWorld(p);
      if (data) {
        out.day = data.clock?.day ?? null;
        out.roleName = data.role?.nickName || null;
        out.chapter = data.campaign?.chapter ?? null;
        out.ending = data.campaign?.ending || null;
      }
    } catch { /* 读不到就当空档 */ }
    return out;
  };
  const json = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  /**
   * 大 JSON 响应：看 Accept-Encoding 决定是否 gzip。
   * 战略层全量约 59KB，前端 5 秒轮询一次；压缩后约 8KB（试玩 P2-10）。
   * 浏览器 / node fetch 都会自动解压，调用方无需改动。
   */
  const sendJson = (req, res, obj, minBytes = 2048) => {
    const body = Buffer.from(JSON.stringify(obj));
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding',
    };
    if (body.length >= minBytes && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
      const packed = gzipSync(body);
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = packed.length;
      res.writeHead(200, headers);
      res.end(packed);
      return;
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  };
  /** 带体积上限的 JSON 请求体读取；超限或解析失败都回调 null，由调用方回 400 */
  const readJson = (req, limit, done) => {
    const chunks = [];
    let size = 0;
    let closed = false;
    req.on('data', (chunk) => {
      if (closed) return;
      size += chunk.length;
      if (size > limit) { closed = true; req.destroy(); done(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (closed) return;
      closed = true;
      try { done(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { done(null); }
    });
    req.on('error', () => { if (!closed) { closed = true; done(null); } });
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

  /* ---------------- 世界时钟（与客户端请求解耦，试玩 P0-1） ----------------
   * 旧实现只有收到协议请求才结算，窗口失焦 / 玩家长时间不点界面时世界停摆。
   * 现在由服务端自己推进：每 500ms 结算一次，只有跨过游戏日才落盘。
   * 支持热重启后继续：clock.lastRealMs 存在存档里。 */
  let lastWorldSaveDay = state.clock?.day ?? 1;
  const worldTimer = setInterval(() => {
    try {
      const r = settleWorld(ctx);
      if (r.days > 0 || r.builds > 0) {
        lastWorldSaveDay = r.day;
        save();
      }
    } catch (err) {
      log('error', `world tick: ${err.stack || err.message}`);
    }
  }, 500);
  void lastWorldSaveDay;

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
    // 六面板 UI：只在 HTTP 响应里追加一个 script 标签，磁盘 index.html 与打包产物一个字节都不改。
    if (urlPath === '/index.html' && !body.includes(Buffer.from('/__slg/panels/ui.js'))) {
      const html = body.toString('utf8');
      const tag = '<script src="/__slg/panels/ui.js" charset="utf-8"></script>'
        + '<script src="/__slg/interaction/ui.js" charset="utf-8"></script>';
      body = Buffer.from(/<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}</body>`) : html + tag);
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

    /* ---------------- 六面板：独立模块，不改 skills.js ---------------- */
    if (urlPath === '/__slg/panels/ui.js') {
      const buf = Buffer.from(PANELS_UI_SOURCE);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': buf.length,
      });
      res.end(buf);
      return;
    }
    /* ---------------- 交互增强层：静态脚本 + 只读聚合态 ---------------- */
    if (urlPath === '/__slg/interaction/ui.js') {
      const buf = Buffer.from(IX_SOURCE, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': buf.length,
      });
      res.end(buf);
      return;
    }
    if (urlPath === '/__slg/interaction/state' && req.method === 'GET') {
      try { sendJson(req, res, interactionState(state, cfg)); }
      catch (err) {
        log('error', `interaction state: ${err.stack || err.message}`);
        json(res, 500, { ok: false, message: err.message });
      }
      return;
    }
    if (urlPath === '/__slg/panels/selfcheck' && req.method === 'GET') {
      json(res, 200, panelSelfCheck());
      return;
    }
    // ★ P0-2：战报红点轮询（HTTP，六府 dock 用；is_read 沿用原版战报字段）
    if (urlPath === '/__slg/panels/reports-head' && req.method === 'GET') {
      const reps = Array.isArray(state.warReports) ? state.warReports : [];
      const unread = reps.filter((r) => !(r.a_is_read && r.d_is_read)).length;
      json(res, 200, { ok: true, latest: reps.length ? reps[reps.length - 1].id : 0, unread });
      return;
    }
    if (urlPath === '/__slg/panels/state' && req.method === 'GET') {
      try { sendJson(req, res, panelState(state, cfg)); }
      catch (err) { log('error', `panels state: ${err.stack || err.message}`); json(res, 500, { ok: false, message: err.message }); }
      return;
    }
    if (urlPath === '/__slg/panels/action' && req.method === 'POST') {
      readJson(req, 65536, (action) => {
        if (!action) { json(res, 400, { ok: false, message: '请求体无效' }); return; }
        let result;
        try { result = panelAction(state, cfg, action); }
        catch (err) { log('error', `panels action: ${err.stack || err.message}`); result = { ok: false, message: err.message }; }
        if (result.ok) save();
        try { json(res, 200, { ...result, view: panelState(state, cfg) }); }
        catch (err) { json(res, 200, { ...result, view: null, viewError: err.message }); }
      });
      return;
    }

    // ★ P4-①：开局举义页 —— 择主 8 诸侯卡 + 择都 3 候选城
    if (urlPath === '/__slg/oath/options' && req.method === 'GET') {
      try { json(res, 200, { ok: true, ...oathOptions(state) }); }
      catch (err) { log('error', `oath options: ${err.stack || err.message}`); json(res, 500, { ok: false, message: err.message }); }
      return;
    }
    if (urlPath === '/__slg/oath/choose' && req.method === 'POST') {
      readJson(req, 16384, (body) => {
        try {
          const r = chooseOath(state, cfg, ctx, body || {});
          if (r.ok) save();
          json(res, 200, r);
        } catch (err) { log('error', `oath choose: ${err.stack || err.message}`); json(res, 500, { ok: false, message: err.message }); }
      });
      return;
    }

    // 本地调试 / 冒烟用只读端点
    if (urlPath === '/__slg/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true, startedAt, uptimeMs: Date.now() - startedAt,
        httpPort, wsPort, webDir, savePath,
        clock: { day: state.clock?.day ?? 1, scale: state.clock?.scale ?? 1 },
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
      sendJson(req, res, state);
      return;
    }
    if (urlPath === '/__slg/general-dossier' && req.method === 'GET') {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams;
      const doc = dossierFor(state, { cfgId: q.get('cfgId'), name: q.get('name') || '' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(doc));
      return;
    }
    if (urlPath === '/__slg/strategy/state') {
      sendJson(req, res, strategyViewState(state, cfg));
      return;
    }
    // ★ P0/P1/P3 编队·运输·赏赐统一动作口（formup / transport / reward）
    // ★ 出征面板：attack / recall 也走这里，省一条新 WS 协议
    if (urlPath === '/__slg/strategy/action' && req.method === 'POST') {
      readJson(req, 16384, (body) => {
        const act = String(body?.action || '');
        let result;
        if (act === 'formup') result = strategyFormup(state, cfg, ctx, body);
        else if (act === 'transport') result = strategyTransport(state, cfg, ctx, body);
        else if (act === 'reward') result = rewardGeneral(state, cfg, ctx, body);
        else if (act === 'invest') result = strategyInvest(state, cfg, ctx, body);
        /* ★ U14 撤销在施内政任务（已投入不退，界面必须写明） */
        else if (act === 'cancelInvest') result = cancelInvest(state, ctx, { taskId: String(body?.taskId || '') });
        else if (act === 'captive') result = recruitCaptive(state, cfg, ctx, body);
        else if (act === 'attack') {
          const fracRaw = Number(body.frac);
          result = strategyAttack(state, cfg, ctx, {
            cityId: Number(body.cityId),
            armyId: Number(body.armyId) || 0,
            frac: Number.isFinite(fracRaw) && fracRaw > 0 && fracRaw <= 1 ? fracRaw : 1,
            fromCityId: Number(body.fromCityId) || 0,
          });
        } else if (act === 'recall') result = strategyRecallMarch(state, cfg, ctx, { marchId: Number(body.marchId) });
        /* ★ M2-3 失败态四出路（GDD §3.4）：裁军 / 卖粮 / 紧急征兵·雇佣兵 / 迁都 */
        else if (act === 'disarm') result = disarmForGold(state, ctx, { armyId: Number(body.armyId), count: Number(body.count) });
        else if (act === 'sellGrain') result = sellGrain(state, ctx, { grain: Number(body.grain) });
        else if (act === 'emergencyConscript') result = emergencyConscript(state, ctx, {
          cityId: Number(body.cityId), count: Number(body.count), mercenary: !!body.mercenary,
        });
        else if (act === 'relocateCapital') result = relocateCapital(state, ctx, { cityId: Number(body.cityId) });
        /* ★ M2-4 委任对象化与外交（GDD §5.6/§5.8）：委任目标 / 取消委任 / 外交动作 */
        else if (act === 'appoint') result = strategyAppoint(state, cfg, ctx, { cityId: Number(body.cityId), goal: String(body.goal || '') });
        else if (act === 'cancelAppoint') result = strategyCancelAppointment(state, ctx, { apptId: String(body.apptId || '') });
        else if (act === 'diplo') result = diplomacyAct(state, cfg, ctx, {
          action: String(body.diploAction || body.sub || ''), faction: String(body.faction || ''),
          target: String(body.target || ''), gold: Number(body.gold) || 0,
        });
        /* ★ 验收 #10 战前推演：与正式结算同一 resolveBattle / defenseFor / battleSeedFor，
           纯只读沙盒，可无限次回退重试；不能 save()，否则反复推演会把存档反复落盘。 */
        /* ★ 验收 #23：行军队列重排（同日抵达按队列顺序结算，所以顺序是真决策） */
        else if (act === 'reorder') result = strategyReorderMarch(state, ctx, {
          marchId: Number(body.marchId), dir: Number(body.dir) || 1,
        });
        else if (act === 'preview') result = previewAssault(state, cfg, {
          cityId: Number(body.cityId),
          fromCityId: Number(body.fromCityId) || 0,
          armyId: Number(body.armyId) || 0,
          frac: Number(body.frac) || 1,
        });
        else result = { ok: false, reason: 'bad_action' };
        if (result.ok && act !== 'preview') save();
        sendJson(req, res, result);
      });
      return;
    }
    if (urlPath === '/__slg/strategy/panorama.png') {
      try {
        const img = readFileSync(join(ROOT, 'conf', 'campaign', 'strategy', 'map-panorama.png'));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': img.length });
        res.end(img);
      } catch {
        res.writeHead(404); res.end('no panorama');
      }
      return;
    }
    if (urlPath === '/__slg/strategy/detail') {
      try {
        const raw = readFileSync(join(ROOT, 'conf', 'campaign', 'strategy', 'detail.json'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(raw);
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('{}');
      }
      return;
    }
    if (urlPath.startsWith('/__slg/strategy/layers/')) {
      // 图层只允许白名单文件名，避免拼路径读到别处
      const name = urlPath.slice('/__slg/strategy/layers/'.length);
      const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
      const ext = name.split('.').pop().toLowerCase();
      if (!/^[a-z0-9_]+\.(png|jpg|jpeg)$/.test(name) || !MIME[ext]) {
        res.writeHead(404); res.end('bad layer');
        return;
      }
      try {
        const img = readFileSync(join(ROOT, 'conf', 'campaign', 'strategy', 'layers', name));
        res.writeHead(200, {
          'Content-Type': MIME[ext],
          'Cache-Control': 'public, max-age=604800',
          'Content-Length': img.length,
        });
        res.end(img);
      } catch {
        res.writeHead(404); res.end('no layer');
      }
      return;
    }
    if (urlPath === '/__slg/strategy/tick' && req.method === 'POST') {
      // ★ 试玩 P0-1：推演一月必须真的推进 10 天并跑一次诸侯决策，而不是只发个空 tick
      const result = advanceToNextTurn(ctx, Date.now());
      save();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }
    if (urlPath === '/__slg/restart' && req.method === 'POST') {
      // ★ 试玩 P0-4：结局之后给玩家一个「重开一局」的出口
      try {
        state = createWorld(cfg);
        flush();
        log('info', 'world restart by player');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, day: state.clock.day }));
      } catch (err) {
        log('error', `restart failed: ${err.stack || err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false }));
      }
      return;
    }
    /* ---------------- 存档：三档位 + 导出 / 导入（试玩 P2-5） ----------------
     * 旧实现只有一个 save.json，换机或重装就没了。现在：
     *   1 号档 = 正在玩的 save.json（兼容旧档）
     *   2/3 号档 = save.slot2.json / save.slot3.json，可随时存/读
     *   另给 /save/export 下载与 /save/import 导入，跨机器搬档不再靠翻 AppData。 */
    if (urlPath === '/__slg/save/slots' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ current: savePath, slots: [1, 2, 3].map(slotInfoOf) }));
      return;
    }
    if (urlPath === '/__slg/save/slot' && req.method === 'POST') {
      readJson(req, 200000, (body) => {
        const slot = Number(body && body.slot);
        const action = String((body && body.action) || '');
        if (!(slot >= 1 && slot <= 3) || !['save', 'load'].includes(action)) {
          json(res, 400, { ok: false, reason: 'bad_request' });
          return;
        }
        try {
          if (action === 'save') {
            flush();
            saveWorld(slotPathOf(slot), state);
            log('info', `save to slot ${slot}`);
            json(res, 200, { ok: true, slots: [1, 2, 3].map(slotInfoOf) });
            return;
          }
          const data = loadWorld(slotPathOf(slot));
          if (!data) { json(res, 404, { ok: false, reason: 'empty_slot' }); return; }
          state = normalizeWorld(data, cfg);
          flush();
          log('info', `load from slot ${slot}`);
          json(res, 200, { ok: true, day: state.clock?.day ?? 1, slots: [1, 2, 3].map(slotInfoOf) });
        } catch (err) {
          log('error', `slot ${action} failed: ${err.stack || err.message}`);
          json(res, 500, { ok: false, reason: 'io_error' });
        }
      });
      return;
    }
    if (urlPath === '/__slg/save/export' && req.method === 'GET') {
      flush();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="shuanghan-save-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(state));
      return;
    }
    if (urlPath === '/__slg/save/import' && req.method === 'POST') {
      readJson(req, 40 * 1024 * 1024, (body) => {
        try {
          const data = body && body.state ? body.state : body;
          if (!data || typeof data !== 'object' || !data.role) {
            json(res, 400, { ok: false, reason: 'not_a_save' });
            return;
          }
          // 导入前先把现有档备份一份，导错了还能退回去
          try { flush(); renameSync(savePath, `${savePath}.before-import-${Date.now()}.json`); } catch { /* 没有旧档就不用备 */ }
          state = normalizeWorld(data, cfg);
          flush();
          log('info', 'save imported');
          json(res, 200, { ok: true, day: state.clock?.day ?? 1 });
        } catch (err) {
          log('error', `import failed: ${err.stack || err.message}`);
          json(res, 400, { ok: false, reason: 'bad_save' });
        }
      });
      return;
    }
    if (urlPath === '/__slg/gm' && req.method === 'GET') {
      const html = readFileSync(join(ROOT, 'server', 'gm', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (urlPath === '/__slg/board' && req.method === 'GET') {
      const html = readFileSync(join(ROOT, 'server', 'gm', 'board.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (urlPath === '/__slg/gm/overrides' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(loadOverrides()));
      return;
    }
    if (urlPath === '/__slg/gm/overrides' && req.method === 'POST') {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 100000) { req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const saved = saveOverrides(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, overrides: saved }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false }));
        }
      });
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
        /* ★ 修 bug-20：handler 抛异常以前吞成 code 0，客户端表现为「点了没反应」，
           日志之外没有任何线索。现在回 500 + reason，界面能提示、日志能定位。 */
        out = { code: 500, msg: { reason: 'internal', message: String(err.message || err) } };
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
      clearInterval(worldTimer);
      flush();
      wss.closeAll();
      await new Promise((r) => wsHttpServer.close(r));
      await new Promise((r) => httpServer.close(r));
    },
  };
}
