/**
 * 确定性随机数。
 *
 * PythonRandom 精确复刻 CPython random.Random(int) 的 MT19937 + init_by_array
 * 以及 random() 的 53 位合成方式，因此同一 seed 产生的序列与 battle-kit
 * 的 Python 参考实现逐位一致（用于对齐事件流统计量）。
 *
 * 全部用 Math.imul / 无符号位移保证 32 位语义，不依赖平台浮点实现。
 */
export declare class PythonRandom {
    private mt;
    private index;
    /** 已产生的 random() 次数（每次消耗 2 个 uint32） */
    calls: number;
    constructor(seed: number);
    /** CPython random_seed：取 |seed|，按小端切成 32 位字 */
    private seedToKey;
    private initGenrand;
    private initByArray;
    private genrandUint32;
    /** 与 Python random.random() 完全一致 */
    random(): number;
}
/** 备用确定性发生器（后续若不再需要对齐 Python 可切换） */
export declare class Mulberry32Rng {
    private state;
    calls: number;
    constructor(seed: number);
    random(): number;
}
export type Rng = {
    random(): number;
    calls: number;
};
