/**
 * 把 config/battle_config.json 生成为 src/default-config.ts。
 *
 * 用途：让内核在 Cocos / 浏览器中零文件 IO 即可拿到默认配置。
 * 修改数值表后执行 `npm run export-config` 再 build 即可。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const src = resolve(root, 'config/battle_config.json');
const dst = resolve(root, 'src/default-config.ts');

const raw = readFileSync(src, 'utf8').trim();
// 先 parse 一次确认是合法 JSON，避免把坏文件写进源码
JSON.parse(raw);

const banner = [
  '/**',
  ' * 自动生成，请勿手工编辑。',
  ' * 数据源：config/battle_config.json（从 battle-kit 原样复制）。',
  ' * 重新生成：npm run export-config',
  ' */',
  '',
].join('\n');

const content = `${banner}import type { BattleConfig } from './types.js';\n\nexport const DEFAULT_BATTLE_CONFIG: BattleConfig = ${raw};\n`;
writeFileSync(dst, content, 'utf8');
console.log(`[export-config] 已生成 ${dst} (${content.length} 字符)`);
