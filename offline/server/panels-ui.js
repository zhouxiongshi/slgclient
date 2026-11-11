/**
 * 六大面板的浏览器端源码由独立文件承载，经 /__slg/panels/ui.js 下发。
 * 好处：源码可单独 node --check；不污染 server/skills.js；磁盘 web/ 与打包产物逐字节不变。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = resolve(fileURLToPath(new URL('.', import.meta.url)), 'panels-ui.source.js');

export const PANELS_UI_SOURCE = readFileSync(FILE, 'utf8');
export const PANELS_UI_PATH = FILE;
