/**
 * 零依赖 WebSocket 服务端（RFC 6455 最小完备实现）。
 * 只为让原客户端 ws://127.0.0.1:8004 能连上，避免引入 ws / npm 依赖，
 * 便于打进离线包后不依赖 node_modules。
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WsConnection {
  constructor(socket, head, handlers) {
    this.socket = socket;
    this.handlers = handlers;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.meta = {};
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => {
      this.closed = true;
      handlers.onClose?.(this);
    });
    this.process();
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.process();
  }

  process() {
    while (!this.closed && this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buf.length < offset + 2) return;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) return;
        const big = this.buf.readBigUInt64BE(offset);
        offset += 8;
        if (big > 64n * 1024n * 1024n) { this.close(); return; }
        len = Number(big);
      }

      let mask = null;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        mask = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buf.length < offset + len) return;

      const payload = Buffer.from(this.buf.subarray(offset, offset + len));
      this.buf = Buffer.from(this.buf.subarray(offset + len));
      if (masked) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === OP.CLOSE) { this.close(); return; }
    if (opcode === OP.PING) { this.sendRaw(payload, OP.PONG); return; }
    if (opcode === OP.PONG) return;

    if (opcode === OP.CONT) {
      this.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.deliver(op, full);
      }
      return;
    }

    this.fragmentOpcode = opcode;
    this.fragments = [payload];
    if (fin) {
      const full = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentOpcode = 0;
      this.deliver(opcode, full);
    }
  }

  deliver(opcode, payload) {
    if (opcode === OP.BINARY || opcode === OP.TEXT) {
      try { this.handlers.onMessage?.(this, payload); } catch (err) {
        this.handlers.onError?.(err, this);
      }
    }
  }

  sendRaw(payload, opcode = OP.BINARY) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.close();
    }
  }

  send(buf) {
    this.sendRaw(Buffer.from(buf), OP.BINARY);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch { /* ignore */ }
  }
}

/**
 * 挂到已有 http.Server 上，复用端口。
 * @returns {{broadcast:Function, closeAll:Function, connections:Set}}
 */
export function attachWebSocketServer(httpServer, handlers) {
  const connections = new Set();

  httpServer.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(String(key) + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = new WsConnection(socket, head, {
      ...handlers,
      onClose: (c) => {
        connections.delete(c);
        handlers.onClose?.(c);
      },
    });
    connections.add(conn);
    handlers.onConnection?.(conn);
  });

  return {
    connections,
    broadcast: (buf) => { for (const c of connections) c.send(buf); },
    closeAll: () => { for (const c of connections) c.close(); },
  };
}
