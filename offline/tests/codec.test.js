import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame, decodeFrame, handshakeFrame, generateKey,
  zeroPad, aesEncryptHex, aesDecryptHex, roundTripCheck,
} from '../server/codec.js';

const KEY = generateKey(12345);

test('密钥为 16 位 [0-9a-zA-Z]', () => {
  assert.equal(KEY.length, 16);
  assert.match(KEY, /^[0-9a-zA-Z]{16}$/);
});

test('ZeroPadding 对齐时同样补满一整块（与 CryptoJS 一致）', () => {
  assert.equal(zeroPad(Buffer.alloc(0)).length, 16);
  assert.equal(zeroPad(Buffer.alloc(16)).length, 32);
  assert.equal(zeroPad(Buffer.alloc(15)).length, 16);
  assert.equal(zeroPad(Buffer.alloc(17)).length, 32);
});

test('AES-128-CBC + hex 往返（含中文、长文本）', () => {
  for (const s of ['{}', '{"a":1}', JSON.stringify({ msg: '中文测试'.repeat(200) })]) {
    assert.equal(aesDecryptHex(aesEncryptHex(s, KEY), KEY), s);
  }
});

test('加密帧是标准 GZIP，可被 zlib 解压；解密后 JSON 完全一致', () => {
  const samples = [
    { seq: 1, name: 'account.login', msg: { username: 'a' } },
    { seq: 2, name: 'role.myProperty', msg: { citys: [], 中文: '城池' } },
  ];
  for (const s of samples) {
    const frame = encodeFrame(s, KEY);
    assert.equal(frame[0], 0x1f);
    assert.equal(frame[1], 0x8b);
    assert.deepEqual(decodeFrame(frame, KEY), s);
    assert.equal(roundTripCheck(s, KEY), true);
  }
});

test('handshake 帧为明文 JSON + gzip，且不加密', () => {
  const frame = handshakeFrame(KEY);
  assert.equal(frame[0], 0x1f);
  const obj = decodeFrame(frame, '');
  assert.equal(obj.seq, 0);
  assert.equal(obj.name, 'handshake');
  assert.equal(obj.code, 0);
  assert.equal(obj.msg.key, KEY);
});
