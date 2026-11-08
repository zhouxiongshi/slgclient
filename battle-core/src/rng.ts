/**
 * 确定性随机数。
 *
 * PythonRandom 精确复刻 CPython random.Random(int) 的 MT19937 + init_by_array
 * 以及 random() 的 53 位合成方式，因此同一 seed 产生的序列与 battle-kit
 * 的 Python 参考实现逐位一致（用于对齐事件流统计量）。
 *
 * 全部用 Math.imul / 无符号位移保证 32 位语义，不依赖平台浮点实现。
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PythonRandom {
  private mt: number[] = new Array<number>(N).fill(0);
  private index = N + 1;
  /** 已产生的 random() 次数（每次消耗 2 个 uint32） */
  public calls = 0;

  constructor(seed: number) {
    const key = this.seedToKey(seed);
    this.initByArray(key);
  }

  /** CPython random_seed：取 |seed|，按小端切成 32 位字 */
  private seedToKey(seed: number): number[] {
    let n = Math.abs(Math.trunc(seed));
    if (!Number.isFinite(n)) n = 0;
    if (n === 0) return [0];
    const key: number[] = [];
    // 用除法逐块取低 32 位，避免 BigInt，支持到 2^53
    while (n > 0) {
      const chunk = n % 4294967296;
      key.push(chunk >>> 0);
      n = Math.floor(n / 4294967296);
    }
    return key;
  }

  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i += 1) {
      const prev = this.mt[i - 1];
      this.mt[i] = (Math.imul(1812433253, (prev ^ (prev >>> 30)) >>> 0) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);
    for (; k > 0; k -= 1) {
      const prev = this.mt[i - 1];
      this.mt[i] =
        (((this.mt[i] ^ Math.imul((prev ^ (prev >>> 30)) >>> 0, 1664525)) >>> 0) +
          key[j] + j) >>> 0;
      i += 1;
      j += 1;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k > 0; k -= 1) {
      const prev = this.mt[i - 1];
      this.mt[i] =
        (((this.mt[i] ^ Math.imul((prev ^ (prev >>> 30)) >>> 0, 1566083941)) >>> 0) - i) >>> 0;
      i += 1;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  private genrandUint32(): number {
    if (this.index >= N) {
      for (let kk = 0; kk < N - M; kk += 1) {
        const y = (this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK);
        this.mt[kk] = (this.mt[kk + M] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      }
      for (let kk = N - M; kk < N - 1; kk += 1) {
        const y = (this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK);
        this.mt[kk] = (this.mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      }
      const y = (this.mt[N - 1] & UPPER_MASK) | (this.mt[0] & LOWER_MASK);
      this.mt[N - 1] = (this.mt[M - 1] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      this.index = 0;
    }
    let y = this.mt[this.index];
    this.index += 1;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** 与 Python random.random() 完全一致 */
  random(): number {
    this.calls += 1;
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }
}

/** 备用确定性发生器（后续若不再需要对齐 Python 可切换） */
export class Mulberry32Rng {
  private state: number;
  public calls = 0;
  constructor(seed: number) {
    this.state = Math.trunc(seed) >>> 0;
  }
  random(): number {
    this.calls += 1;
    let t = (this.state + 0x6d2b79f5) >>> 0;
    this.state = t;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export type Rng = { random(): number; calls: number };
