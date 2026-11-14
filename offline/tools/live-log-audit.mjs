/**
 * 真实服务器会话日志审计（配合 tools/system-audit.mjs 的领域层模拟）。
 *
 *   node tools/live-log-audit.mjs [--seconds 120] [--scale 30]
 *
 * 起真实 HTTP/WS 服务（非 mock），加速世界时钟（scale 倍），在会话期内反复走
 * 状态查询 / 推演 / 内政 / 事件 / 出征 / 面板 / 静态资源等真实端点，
 * 最后从 status().logs 与 requestLog 扫 error/warn/异常栈与非 2xx。
 * 输出 reports/live-log-audit.json。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOfflineServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'reports', 'live-log-audit.json');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
  const seconds = opt('seconds', 120), scale = opt('scale', 30);
  const saveDir = mkdtempSync(join(tmpdir(), 'slg-live-'));
  const httpPort = 18891, wsPort = 18892;
  const server = await startOfflineServer({ saveDir, httpPort, wsPort, travelMs: 1000, quiet: true });
  const base = `http://127.0.0.1:${httpPort}`;
  server.getState().clock.scale = scale;   // 真实世界时钟加速：60s/日 ÷ scale

  const get = async (p) => {
    try {
      const r = await fetch(base + p);
      const t = await r.text();
      return { status: r.status, len: t.length, json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
    } catch (e) { return { status: 0, error: e.message }; }
  };
  const post = async (p, body) => {
    try {
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const t = await r.text();
      return { status: r.status, len: t.length, json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
    } catch (e) { return { status: 0, error: e.message }; }
  };

  const endpoints = [];
  const record = (name, r) => { endpoints.push({ name, status: r.status, len: r.len ?? 0, error: r.error || null }); };
  const started = Date.now();
  let rounds = 0;
  const actions = [
    { action: 'formup', armyId: 2000, generals: [1000, 0, 0], soldiers: [800, 0, 0] },
    { action: 'invest', cityId: 10, kind: 'agri' },
    { action: 'transport', cityId: 10, grain: 100, fromCityId: 1 },
    { action: 'reward', generalId: 1000, amount: 10 },
    { action: 'diplo', diploAction: 'gift', faction: 'yanzhou', gold: 10 },
    { action: 'eventChoice', id: 'opening-1', choice: 'a' },
  ];
  while (Date.now() - started < seconds * 1000) {
    rounds += 1;
    record('GET /', await get('/'));
    record('GET /__slg/state', await get('/__slg/state'));
    record('GET /__slg/strategy/state', await get('/__slg/strategy/state'));
    record('GET /__slg/interaction/state', await get('/__slg/interaction/state'));
    record('GET /__slg/strategy/detail', await get('/__slg/strategy/detail'));
    record('GET /__slg/gm', await get('/__slg/gm'));
    record('GET /__slg/panels/state', await get('/__slg/panels/state'));
    record('POST /__slg/strategy/tick', await post('/__slg/strategy/tick', {}));
    record('POST /__slg/strategy/action', await post('/__slg/strategy/action', actions[rounds % actions.length]));
    record('GET /__slg/gm/overrides', await get('/__slg/gm/overrides'));
    await sleep(1500);
  }

  const status = server.status();
  const logs = status.logs || [];
  const errorLogs = logs.filter((l) => l.level === 'error');
  const warnLogs = logs.filter((l) => l.level === 'warn');
  const keywords = /error|Error|undefined|NaN|Infinity|exception|异常|报错|failed|ECONN|ENOENT|EPERM/;
  const suspicious = logs.filter((l) => keywords.test(l.message));
  const non2xx = endpoints.filter((e) => e.status < 200 || e.status >= 300 || e.error);
  const report = {
    generatedAt: new Date().toISOString(),
    session: { seconds: Math.round((Date.now() - started) / 1000), scale, rounds, httpPort, wsPort },
    summary: {
      endpoints: endpoints.length, non2xx: non2xx.length,
      logs: logs.length, errorLogs: errorLogs.length, warnLogs: warnLogs.length, suspicious: suspicious.length,
      warReports: status.warReports, battles: status.battles, pending: status.pending,
      clockDay: server.getState().clock.day,
    },
    errorLogs: errorLogs.slice(0, 30), warnLogs: warnLogs.slice(0, 30),
    suspiciousLogs: suspicious.slice(0, 30), non2xx: non2xx.slice(0, 30),
    endpointKinds: [...new Set(endpoints.map((e) => e.name))],
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  await server.close();
  rmSync(saveDir, { recursive: true, force: true });
  console.log(`[live-log-audit] ${report.session.seconds}s / ${rounds} 轮 / ${endpoints.length} 端点调用 / 游戏日推进至 ${report.summary.clockDay}`);
  console.log(`[live-log-audit] 日志 ${logs.length}：error ${errorLogs.length} / warn ${warnLogs.length} / 可疑 ${suspicious.length}；非 2xx ${non2xx.length}`);
  console.log(`[live-log-audit] 报告: ${OUT}`);
  if (errorLogs.length || non2xx.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
