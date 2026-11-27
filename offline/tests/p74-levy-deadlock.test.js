/**
 * P74 回归闸：兵源不再「空占名额」。
 *
 * 玩家报障（2026-11-27）：「兵力打完了就无法继续征兵了，游戏就阻塞了，城池就只能等死了」。
 *
 * 真因不是人口不长，而是额度算法算错了对象：
 *   旧口径 `余户 = 适龄壮丁 − cityEcon.levied`，而 `levied` 是**历史台账**，
 *   只在 `routeWounded()` 的阵亡分支里回退。任何没走那条路的掉兵（全军覆没、
 *   解散、城破丢兵、旧档迁移）都会让它永久虚高。
 *   实测玩家存档：昌邑人口 9.7 万、壮丁 1.2 万、在役 0，`余户` 仍是 0，
 *   界面报「各户壮丁已尽」——城看起来被永久判死。
 *
 * 现口径：`有效在役 = min(台账, 真实在役)`，兵没了名额立刻回池；兵还在照旧受限。
 *   `真实在役 = 城内兵 + 归属本城的部队（含在途）`。
 */
import './_isolate-overrides.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { ensureStrategy, oathOptions, chooseOath } from '../server/domain/strategy.js';
import { ensureCityEcon, popTick } from '../server/domain/city-econ.js';
import {
  levyView, inServiceOf, checkLevy, commitLevy, HOUSEHOLD_SIZE,
} from '../server/domain/levy.js';

const cfg = loadConfig();
const ctx = () => ({ push() {}, schedule() {}, save() {}, log() {} });

function fresh() {
  const s = normalizeWorld(createWorld(cfg), cfg);
  ensureStrategy(s);
  ensureCityEcon(s);
  const lords = oathOptions(s).lords.filter((l) => l.cities.length >= 2);
  assert.equal(chooseOath(s, cfg, ctx(), { lord: lords[0].id, city: lords[0].cities[0].id }).ok, true);
  const cid = Number(Object.keys(s.strategy.cities).find((id) => s.strategy.cities[id].owner === 'player'));
  return { s, cid, e: s.strategy.cityEcon[cid] };
}

test('P74-L1 兵打光了立刻能再征：台账虚高也不许把城判死', () => {
  const { s, cid, e } = fresh();
  e.pop = 100000; e.levied = 12000; e.levyTotal = 13000; e.lastLevyTurn = -1;
  /* 玩家把兵拼光了：城内 0、部队全灭 */
  s.strategy.cities[cid].troops = 0;
  s.armys = (s.armys || []).filter((a) => Number(a.cityId) !== cid);

  const v = levyView(s, cid);
  assert.equal(v.inService, 0, '真实在役必须是 0');
  assert.equal(v.levied, 12000, '台账本身不改（历史留痕）');
  assert.ok(v.houseBalance > 0, `余户必须回池，实际 ${v.houseBalance}`);
  assert.ok(v.quota >= 1, `兵打光后本旬必须可征，实际 ${v.quota}`);
  assert.equal(checkLevy(s, cid, 1).ok, true, 'checkLevy 必须放行');
});

test('P74-L2 兵还在就照旧受限：修的是空占，不是放松上限', () => {
  const { s, cid, e } = fresh();
  e.pop = 100000; e.levied = 12400; e.lastLevyTurn = -1;
  /* 壮丁 = floor(20000 户 × 0.62) = 12400；城里已有 12400 兵 */
  s.strategy.cities[cid].troops = Math.floor(e.pop / 5 * 0.62);
  const v = levyView(s, cid);
  assert.equal(v.houseBalance, 0, '在役满编时不得再征');
  assert.ok(v.quota === 0);
  assert.equal(v.reason, 'levy_exhausted');
});

test('P74-L3 在途部队算在役：出征在外的兵不能一边抽空本城', () => {
  const { s, cid, e } = fresh();
  e.pop = 50000; e.levied = 0; e.lastLevyTurn = -1;
  s.strategy.cities[cid].troops = 0;
  s.armys = s.armys || [];
  s.armys.push({ id: 900001, cityId: cid, generals: [0, 0, 0], soldiers: [1000, 500, 0] });
  assert.equal(inServiceOf(s, cid), 1500, '在途三槽都要计入在役');
  /* 台账 0、在役 1500 → 有效在役取 min = 0（不空占），额度仍是全壮丁 6200 */
  assert.equal(levyView(s, cid).houseBalance, 6200);
  /* 反过来：台账记了 6200 而实际只剩 1500 在役 → 有效在役降为 1500，余 4700 */
  e.levied = 6200;
  assert.equal(levyView(s, cid).houseBalance, 4700, '台账虚高时必须按真实在役回池');
});

test('P74-L4 原因文案分得清「在役满编」与「人丁太少」', () => {
  const { s, cid, e } = fresh();
  /* ① 人丁太少 */
  e.pop = 10; e.levied = 0; e.lastLevyTurn = -1;
  s.strategy.cities[cid].troops = 0;
  s.armys = [];
  let v = levyView(s, cid);
  assert.equal(v.reason, 'need_population', `人丁少应报人丁，实际 ${v.reason}`);
  assert.ok(/人丁/.test(v.reasonText), `文案要点明人丁，实际「${v.reasonText}」`);

  /* ② 在役满编 */
  e.pop = 100000; e.levied = 12400;
  s.strategy.cities[cid].troops = 12400;
  v = levyView(s, cid);
  assert.equal(v.reason, 'levy_exhausted');
  assert.ok(/在役/.test(v.reasonText), `文案要点明在役，实际「${v.reasonText}」`);
  assert.ok(/打光|解散|生息/.test(v.hint), `提示必须给出可操作出口，实际「${v.hint}」`);
});

test('P74-L5 低位人口按户保底：受创小城不再等几百旬', () => {
  const { s, cid, e } = fresh();
  e.pop = 40; e.levied = 0; e.lastLevyTurn = -1;
  s.strategy.cities[cid].troops = 0;
  s.armys = [];
  for (let i = 0; i < 5; i += 1) popTick(s, ctx());
  assert.ok(e.pop >= 40 + 5 * HOUSEHOLD_SIZE,
    `低位每旬至少 +1 户（+${HOUSEHOLD_SIZE} 口），实际 5 旬后 ${e.pop} 口`);
  assert.ok(levyView(s, cid).quota >= 1, '5 旬后应能征到兵');
});

test('P74-L6 征完立刻重算：不会因为「刚征过」就永久显示壮丁已尽', () => {
  const { s, cid, e } = fresh();
  e.pop = 100000; e.levied = 0; e.lastLevyTurn = -1;
  s.strategy.cities[cid].troops = 0;
  s.armys = [];
  const v0 = levyView(s, cid);
  assert.ok(v0.quota > 0);
  const take = Math.min(200, v0.quota);
  commitLevy(s, cid, take);
  s.strategy.cities[cid].troops = take;      // 征到的兵入城
  const v1 = levyView(s, cid);
  assert.equal(v1.reason, 'levy_cooldown', '本旬原因为冷却，不是兵源耗尽');
  /* 推进一旬：仍应可再征，不得卡死 */
  s.clock.day += 10; s.strategy.turn += 1;
  e.lastLevyTurn = -1;
  const v2 = levyView(s, cid);
  assert.ok(v2.quota >= 1, `下一旬应可再征，实际 ${v2.quota}（余户 ${v2.houseBalance}）`);
});
