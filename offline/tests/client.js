/** 极简协议客户端：用与原 WebSock.ts 相同的编解码跟离线服务对话。 */
import { encodeFrame, decodeFrame } from '../server/codec.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProtocolClient {
  constructor(url, options = {}) {
    this.url = url;
    this.key = '';
    this.seq = 0;
    this.frames = [];   // 已解码的加密帧（不含 handshake）
    this.pushes = [];   // seq === 0 的推送
    this.raw = [];      // 原始帧
    this.timeout = options.timeout ?? 10000;
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', (ev) => {
      const buf = Buffer.from(ev.data);
      this.raw.push(buf);
      const key = this.key || '';
      try {
        const obj = decodeFrame(buf, key);
        if (obj.name === 'handshake') return;
        this.frames.push(obj);
        if (obj.seq === 0) this.pushes.push(obj);
      } catch { /* 忽略解码失败帧 */ }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e?.message || 'unknown'}`)), { once: true });
    });

    // 第一帧必须是明文 handshake（无 AES、无 hex）
    const first = await this.waitRaw((b) => {
      try { return decodeFrame(b, '').name === 'handshake'; } catch { return false; }
    });
    const hand = decodeFrame(first, '');
    if (hand.name !== 'handshake' || !hand.msg?.key || hand.msg.key.length !== 16) {
      throw new Error('handshake 缺失或格式错误');
    }
    this.key = hand.msg.key;
    this.handshake = hand;
    return hand;
  }

  waitRaw(pred, timeout = this.timeout) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.raw.find(pred);
        if (found) return resolve(found);
        if (Date.now() - start > timeout) return reject(new Error('waitRaw timeout'));
        setTimeout(check, 15);
      };
      check();
    });
  }

  send(name, msg = {}) {
    const seq = ++this.seq;
    this.ws.send(encodeFrame({ seq, name, msg }, this.key));
    return seq;
  }

  async waitFor(pred, timeout = this.timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      await sleep(15);
    }
    throw new Error(`waitFor timeout (frames=${this.frames.length})`);
  }

  async request(name, msg = {}) {
    const seq = this.send(name, msg);
    return this.waitFor((f) => f.seq === seq && f.name === name);
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
