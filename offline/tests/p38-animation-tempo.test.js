/**
 * P38（2026-11-22）战斗回放节奏与打击感回归：
 *  1. 单一虚拟时钟把 cue 与特效一起放慢 30%；
 *  2. 暂停/进度/首帧都走同一时钟，避免暂停补偿错位；
 *  3. 命中火花、交叉刀光、突进残影是纯绘制增强，不改战报数值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'server/skills.js'), 'utf8');
const start = src.indexOf('const BATTLE_ANIM_SOURCE');
const anim = src.slice(start, src.indexOf('const CITY_WINDOW_V2_IMPL', start));

test('P38-① 单一 TIME_SCALE=0.7 同时管 cue 与特效，真实时钟只保留绑定处', () => {
  assert.match(anim, /var TIME_SCALE = 0\.7/, '整体放慢 30%');
  assert.match(anim, /function nowMs\(\) \{ return _perfNow\(\) \* TIME_SCALE; \}/);
  const bare = anim.match(/performance\.now\(\)/g) || [];
  assert.equal(bare.length, 0, '动画 IIFE 内不得残留未缩放的真实时钟');
  assert.match(anim, /var elapsed = \(now - state\.t0\) \* state\.speed/, 'cue 仍走虚拟时钟');
  assert.match(anim, /var now = nowMs\(\);[\s\S]*var elapsed/, '主循环取虚拟时钟');
  assert.match(anim, /state\.pausedAt = nowMs\(\)/, '暂停补偿同钟');
  assert.match(anim, /state\.t0 = nowMs\(\)/, '播放起点同钟');
});

test('P38-② 打击感增强只落在绘制函数，不改折损与结算', () => {
  assert.match(anim, /for \(var i = 0; i < 12; i \+= 1\)/, '命中火花加密到 12 束');
  assert.match(anim, /交叉刀光 \+ 命中白心/, '命中交叉刀光存在');
  assert.match(anim, /突进时留两道半透明残影/, '冲锋残影存在');
  assert.match(anim, /damage\(to, loss\)/, '折损仍来自战报 act.loss');
  assert.doesNotMatch(anim, /act\.loss \* TIME_SCALE|TIME_SCALE \* loss/, '缩放只能作用于时间，不能改兵力');
});
