/**
 * M3-1（GDD §7.1 / §7.5）。
 *
 * 锁三件事：
 *  1. heroes-240：240 位三层（60/100/80）、字段完整、宿命成员全覆盖、核心层有 traits；
 *  2. fate-groups：24 组结构校验、相性环形距离、登庸相性分项；
 *  3. evaluateFates：active / dormant / broken 三档判定（宿命可断，断链记代价）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadFateGroups, validateFateGroups, fatesOfHero,
  xiangxingGap, xiangxingBonus, evaluateFates, groupById, XIANGXING_RING,
} from '../server/domain/fate-groups.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const HEROES = JSON.parse(readFileSync(resolve(ROOT, 'conf/campaign/heroes-240.json'), 'utf8'));
const FATES = loadFateGroups();

test('M3-1·heroes-240：构建校验全绿（V1..V6）', () => {
  const out = execFileSync(process.execPath, [resolve(ROOT, 'tools/build-heroes.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /check ok: 240 位/, 'build-heroes --check 应通过');
});

test('M3-1·heroes-240：三层计数与字段完整性', () => {
  const h = HEROES.heroes;
  assert.equal(h.length, 240);
  const by = { core: 0, important: 0, minor: 0 };
  for (const x of h) {
    by[x.layer] = (by[x.layer] || 0) + 1;
    for (const v of Object.values(x.five)) assert.ok(v >= 1 && v <= 100, `${x.name} 五维越界 ${v}`);
    assert.equal(typeof x.yili, 'number');
    assert.ok(x.xiangxing >= 1 && x.xiangxing <= XIANGXING_RING, `${x.name} 相性越界`);
    assert.ok(x.source.ref, `${x.name} 缺史实依据`);
  }
  assert.deepEqual(by, { core: 60, important: 100, minor: 80 });
});

test('M3-1·heroes-240：宿命成员全部带 fate 组与关系边（一人可属多组）', () => {
  const names = new Set(HEROES.heroes.map((x) => x.name));
  for (const g of FATES) {
    for (const m of g.members) {
      assert.ok(names.has(m), `宿命组 ${g.id} 成员缺员: ${m}`);
      const hero = HEROES.heroes.find((x) => x.name === m);
      // fate 单值记首个组；此人参与的所有组都必须有 bonds 边
      const myGroupIds = fatesOfHero(m).map((x) => x.id);
      assert.ok(myGroupIds.includes(hero.fate), `${m} 的 fate=${hero.fate} 应属于其组集 ${myGroupIds}`);
      for (const gid of myGroupIds) {
        assert.ok(hero.bonds.some((b) => b.groupId === gid), `${m} 应有宿命组 ${gid} 的关系边`);
      }
    }
  }
  const withFate = HEROES.heroes.filter((x) => x.fate).length;
  assert.equal(withFate, 41, `41 位宿命成员，实际 ${withFate}`);
  // 多组归属抽样：曹操 5 组、赵云 3 组
  const cc = HEROES.heroes.find((x) => x.name === '曹操');
  const ccEdges = new Set(cc.bonds.filter((b) => b.groupId).map((b) => b.groupId));
  assert.deepEqual([...ccEdges].sort(), fatesOfHero('曹操').map((x) => x.id).sort());
});

test('M3-1·heroes-240：核心层每位有 traits，孙刘曹等高光在核心层', () => {
  for (const x of HEROES.heroes.filter((h) => h.layer === 'core')) {
    assert.ok(x.traits.length >= 1, `核心层缺 traits: ${x.name}`);
  }
  for (const n of ['刘备', '曹操', '孙策', '诸葛亮', '吕布', '貂蝉']) {
    const x = HEROES.heroes.find((h) => h.name === n);
    assert.ok(x && x.layer === 'core', `${n} 应在核心层`);
  }
  // GDD §12 准入：八王之乱后人物不进核心层
  for (const x of HEROES.heroes.filter((h) => h.layer === 'core')) {
    assert.notEqual(x.name, '刘渊', '刘渊（304 年发迹）不进核心层');
    assert.ok(x.died == null || x.died <= 281, `核心层 ${x.name} 卒年 ${x.died} 超出玩法区间`);
  }
});

test('M3-1·fate-groups：24 组结构齐备，fullChain 恰 8 组', () => {
  assert.equal(FATES.length, 24);
  assert.equal(validateFateGroups(FATES).length, 0, '结构校验应零错误');
  assert.equal(FATES.filter((g) => g.fullChain).length, 8, '完整事件链恰 8 组');
  // 校验器能抓出坏组：缺断链代价+缺史实依据+缺置信度（3 条）/ 组内重名 / 成员不足
  const errs = validateFateGroups([
    { id: 'x', members: ['A', 'B'], effect: 'e' },                       // 缺 breakEffect/source.id/source.confidence
    { id: 'y', members: ['A', 'A'], effect: 'e', breakEffect: 'b',
      source: { id: 's', confidence: '高' } },                            // 组内重名
    { id: 'z', members: ['A'], effect: 'e', breakEffect: 'b',
      source: { id: 's', confidence: '高' } },                            // 成员不足
  ]);
  assert.equal(errs.length, 5);
});

test('M3-1·fate-groups：相性环形距离与登庸分项（GDD §7.3）', () => {
  assert.equal(xiangxingGap(1, 149), 1, '环形相邻：1 与 149 距离 1');
  assert.equal(xiangxingGap(1, 75), 74, '对径距离 74');
  assert.equal(xiangxingGap(100, 100), 0);
  assert.equal(xiangxingBonus(100, 100), 25, 'gap 0 → +25%');
  assert.equal(xiangxingBonus(1, 149), 25, 'gap 1 → +25%');
  assert.equal(xiangxingBonus(1, 20), 18, 'gap 19 → +18%');
  assert.equal(xiangxingBonus(1, 40), 10, 'gap 39 → +10%');
  assert.equal(xiangxingBonus(1, 80), 0, 'gap 79 → 0');
  // 赵云三宿命（wolong-zilong / sanjiang / baima）
  const zy = fatesOfHero('赵云').map((g) => g.id).sort();
  assert.deepEqual(zy, ['baima', 'sanjiang', 'wolong-zilong']);
});

test('M3-1·evaluateFates：active/dormant/broken 三档判定', () => {
  // 全员存活且全部出仕 → 全部 active
  const allIn = evaluateFates(() => true);
  assert.equal(allIn.active.length, 24);
  assert.equal(allIn.broken.length, 0);
  assert.equal(allIn.dormant.length, 0);
  // 全员存活但无人出仕 → 全部 dormant（组合加成待激活）
  const noneIn = evaluateFates(() => true, { heroInCourt: () => false });
  assert.equal(noneIn.dormant.length, 24);
  assert.equal(noneIn.active.length, 0);
  // 关羽死 → taoyuan/sanjiang broken，其余不受影响
  const deadGy = evaluateFates((n) => n !== '关羽');
  const gyGroups = fatesOfHero('关羽').map((g) => g.id);
  for (const gid of gyGroups) {
    const b = deadGy.broken.find((x) => x.id === gid);
    assert.ok(b, `关羽死应断组 ${gid}`);
    assert.deepEqual(b.cause, ['关羽'], `断链 cause 应记死者: ${gid}`);
    assert.ok(b.breakEffect, '断链必须带代价文案');
  }
  assert.equal(deadGy.broken.length, gyGroups.length, '只断关羽所在的组');
  // 宿命组定义可查
  const t = groupById('taoyuan');
  assert.equal(t.members.join('/'), '刘备/关羽/张飞');
  assert.ok(t.trigger && t.effect);
});
