/** 不启动 Electron、只跑协议服务的命令行入口（用于测试与本地调试）。 */
import { startOfflineServer } from './index.js';

const int = (key, fallback) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const server = await startOfflineServer({
  webDir: process.env.SLG_WEB_DIR || undefined,
  saveDir: process.env.SLG_SAVE_DIR || undefined,
  httpPort: int('SLG_HTTP_PORT', 8088),
  wsPort: int('SLG_WS_PORT', 8004),
  travelMs: int('SLG_TRAVEL_MS', 3000),
});

console.log('[slg-offline] standalone server ready');
console.log(`  page : http://127.0.0.1:${server.ports.http}/index.html`);
console.log(`  ws   : ws://127.0.0.1:${server.ports.ws}`);
console.log('  Ctrl+C to stop');

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
