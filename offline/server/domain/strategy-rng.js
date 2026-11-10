/**
 * 战略层确定性随机：与 slg-ai 同一条纪律——
 * Random(seed + turn×1000 + crc32(标识))，禁用 hash() 盐。
 */
import { crc32Utf8 } from '../../kernel/index.js';

/** 返回 { random(): [0,1) }，同 seed+turn+tag 恒定序列。 */
export function rngFor(seed, turn, tag) {
  let state = (Number(seed) >>> 0) + (Number(turn) >>> 0) * 1000 + (crc32Utf8(String(tag)) >>> 0);
  // xorshift32：确定性、快，分布对首版够用
  return {
    random() {
      state ^= state << 13; state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5; state >>>= 0;
      return state / 4294967296;
    },
  };
}
