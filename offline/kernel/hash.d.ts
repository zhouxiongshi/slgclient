/** 纯 JS 的编码与哈希工具：零依赖、跨 Node / 浏览器 / Cocos 一致。 */
/** 字符串 -> UTF-8 字节（与 Python str.encode('utf-8') 一致，含代理对） */
export declare function utf8Bytes(s: string): number[];
/** zlib.crc32(str.encode('utf-8'))，返回 uint32 */
export declare function crc32Utf8(s: string): number;
/** 递归排序 key 的稳定序列化，用于配置/事件指纹 */
export declare function stableStringify(value: unknown): string;
/** 16 位十六进制指纹：两轮不同初值的 FNV-1a，碰撞概率远低于单轮 */
export declare function hash16(input: string): string;
