/**
 * 端口预检：探测工具启动前必须确认 8088/8004 没有被上一轮的残留进程占着。
 *
 * 为什么需要：打包态跑完若留了一个 SLG-Offline.exe（异常退出、或上个工具被中断），
 * 下一次探测会在深层抛 `EADDRINUSE`，而报告目录里还躺着**上一次**的 JSON ——
 * 命令行照样打印「✓ 全绿」，实际测的是旧结果。本轮就被这个坑误导了三次：
 * 一次 probe 判「无结果」、一次 check-release 报「408 tests / 2 fail」。
 *
 * 策略：只自动清理**本项目自己的**进程（electron / SLG-Offline），其它进程一律
 * 报告并退出，绝不乱杀别人。
 */
import { execSync } from 'node:child_process';

const OWN = /^(electron|SLG-Offline)(\.exe)?$/i;

/** 返回 [{ port, pid, name }]（仅 LISTENING） */
export function listeningOn(ports) {
  const want = new Set(ports.map((p) => String(p)));
  const out = [];
  if (process.platform === 'win32') {
    let text = '';
    try {
      text = execSync('netstat -ano -p TCP', { encoding: 'utf8', timeout: 15000 });
    } catch { return out; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
      if (!m || !want.has(m[1])) continue;
      out.push({ port: Number(m[1]), pid: Number(m[2]), name: nameOf(Number(m[2])) });
    }
    return out;
  }
  let text = '';
  try {
    text = execSync(`lsof -nP -iTCP -sTCP:LISTEN -t`, { encoding: 'utf8', timeout: 15000 });
  } catch { return out; }
  for (const pid of text.split(/\s+/).filter(Boolean)) {
    out.push({ port: 0, pid: Number(pid), name: nameOf(Number(pid)) });
  }
  return out;
}

function nameOf(pid) {
  try {
    if (process.platform === 'win32') {
      return execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 10000 })
        .split(',')[0].replace(/"/g, '').trim();
    }
    return execSync(`ps -o comm= -p ${pid}`, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch { return ''; }
}

export function killTree(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 15000 });
    else process.kill(pid, 'SIGKILL');
    return true;
  } catch { return false; }
}

/**
 * 启动前调用。占用的若是本项目进程 → 清掉；否则打印怎么处理并退出。
 * @param {number[]} ports
 * @param {string} label 工具名，只用于日志前缀
 */
export function assertPortsFree(ports, label) {
  const busy = listeningOn(ports);
  if (!busy.length) return;
  const mine = busy.filter((b) => OWN.test(b.name));
  const others = busy.filter((b) => !OWN.test(b.name));
  if (mine.length) {
    console.warn(`[${label}] 端口被上一轮残留的本项目进程占用，正在清理：`
      + mine.map((b) => `:${b.port} pid=${b.pid} ${b.name}`).join('，'));
    for (const b of mine) killTree(b.pid);
    // 给 Windows 释放端口一点时间，再放行（下面会再查一次）
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const again = listeningOn(ports).filter((b) => OWN.test(b.name));
      if (!again.length) break;
      try { execSync('ping -n 1 -w 120 127.0.0.1 > nul', { stdio: 'ignore' }); } catch { /* 忽略 */ }
    }
  }
  const still = listeningOn(ports);
  if (still.length) {
    console.error(`[${label}] 端口仍被占用，无法开始（报告会是上一次的旧结果，别当本次结论）：`);
    for (const b of still) console.error(`   :${b.port}  pid=${b.pid}  ${b.name || '未知进程'}`);
    console.error(`[${label}] 请先结束这些进程再重跑（本项目进程会被自动清理，非本项目的不会）。`);
    process.exit(2);
  }
}
