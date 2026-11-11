/**
 * 注入到客户端的脚本必须能被浏览器解析。
 *
 * 这些脚本以模板字符串形式写进 server/skills.js，正则里的反斜杠会被外层模板
 * 字符串吃掉（/^\/+/ 变成 /^/+/）。曾经因此让整个页面脚本语法错误、卡在主界面，
 * 而字符串断言查不出来。这里把注入后的 index.js 真编译一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillAssets } from '../server/skills.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(ROOT, 'web');

test('注入后的客户端脚本可编译（无语法错误）', () => {
  assert.ok(existsSync(resolve(WEB, 'index.html')), '缺少 web 目录');
  const assets = createSkillAssets(WEB);
  const js = assets.intercept('/assets/main/index.js');
  assert.ok(js && typeof js.body === 'string' && js.body.length > 0, '没有返回客户端脚本');

  // new Function 走的是和浏览器同一个解析器，语法错误会在这里抛出
  try {
    new Function(js.body);
  } catch (err) {
    assert.fail(`注入脚本无法解析：${err.message}`);
  }
});

test('注入脚本里没有会被模板字符串吃掉的正则转义', () => {
  const assets = createSkillAssets(WEB);
  const body = assets.intercept('/assets/main/index.js').body;
  // 出现 /^/+/ 这种写法说明反斜杠在写入模板字符串时丢了
  assert.equal(/\/\^\//.test(body) && /\/\^\/\+\//.test(body), false,
    '发现 /^/+/ 这类残缺正则，应改用字符串方式处理');
});

test('分层资源路径由运行时代码拼接，不含转义敏感写法', () => {
  const assets = createSkillAssets(WEB);
  const body = assets.intercept('/assets/main/index.js').body;
  assert.ok(body.includes('__slg/strategy/layers/') || body.includes("'/__slg/strategy/'"),
    '缺少图层路径拼接');
  assert.ok(body.indexOf('slgStratSide') >= 0, '缺少图层面板');
  assert.ok(body.indexOf('slgStratFind') >= 0, '缺少城池检索框');
  assert.ok(body.indexOf('slgStratIntro') >= 0, '缺少城池介绍面板');
  assert.ok(body.indexOf("getElementById('GameDiv')") >= 0, '登录后没有盖住本地地图');
  assert.ok(body.indexOf('function inkText') >= 0, '城名仍依赖带方底的贴图');
});
