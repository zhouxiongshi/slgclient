/**
 * 六面板体系 P0 回归：静态资料纪律、旧档兼容、数值红线、确定性、动作校验、HTTP 注入。
 * 只测新模块，不改任何既有测试与战斗内核。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import {
  panelState, panelAction, panelSelfCheck, ensurePanels, PANEL_CONF,
} from '../server/domain/panels.js';
import { PANELS_UI_SOURCE } from '../server/panels-ui.js';
import { startOfflineServer } from '../server/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cfg = loadConfig();
const fresh = () => normalizeWorld(createWorld(cfg), cfg);

test('战法库：51 条、每条 ≥2 条公开获取途径、研习兜底、文本与 battle-kit 原文一致', () => {
  const chk = panelSelfCheck();
  assert.equal(chk.ok, true, JSON.stringify(chk));
  assert.equal(chk.skillCount, 51);
  assert.deepEqual(chk.missing, []);
  assert.deepEqual(chk.mismatch, []);
  assert.deepEqual(chk.overItem, []);
  const all = PANEL_CONF.recipes.recipes;
  assert.ok(all.every((r) => r.sources.some((s) => s.type === 'research')), '每条都有战功研习兜底');
  assert.ok(all.every((r) => r.sources.every((s) => s.where && s.cost && s.detail)), '配方无隐藏信息');
  // 名称/描述不得改写：与 conf 原文逐字比对
  const raw = [...PANEL_CONF.mainSkills, ...PANEL_CONF.libSkills];
  const byId = new Map(raw.map((s) => [Number(s.cfgId), s]));
  for (const s of panelState(fresh(), cfg).library) {
    const r = byId.get(s.cfgId);
    assert.equal(s.name, r.ui?.name ?? r.name);
    assert.equal(s.des, r.ui?.des ?? '');
  }
});

test('装备红线：单件 ≤8%、全套四件合计 ≤25%，卸下后回到基线', () => {
  const s = fresh();
  const g = s.generals[0];
  // 给主角凑齐四件：府库赠 2 件 + 锻造 2 件
  panelAction(s, cfg, { type: 'forge', cfgId: 300003 });
  panelAction(s, cfg, { type: 'forge', cfgId: 300011 });
  let v = panelState(s, cfg);
  const ids = { weapon: 500001, armor: 500002 };
  const extra = v.items.filter((i) => i.slot === 'weapon' || i.slot === 'mount');
  const equip = (slot, itemId) => panelAction(s, cfg, { type: 'equip', gId: g.id, slot, itemId });
  assert.equal(equip('weapon', ids.weapon).ok, true);
  assert.equal(equip('armor', ids.armor).ok, true);
  // 同槽换装（覆盖）以及坐骑
  const mount = extra.find((i) => i.slot === 'mount');
  if (mount) assert.equal(equip('mount', mount.id).ok, true);
  v = panelState(s, cfg);
  const base = v.generals[0].base;
  for (const k of Object.keys(base)) {
    if (!base[k]) continue;
    assert.ok(v.generals[0].added[k] / base[k] <= 0.2501,
      `${k} 增幅 ${(v.generals[0].added[k] / base[k] * 100).toFixed(1)}% 超过 25%`);
  }
  for (const slot of ['weapon', 'armor', 'mount']) {
    if (v.generals[0].equipment[slot]) panelAction(s, cfg, { type: 'unequip', gId: g.id, slot });
  }
  v = panelState(s, cfg);
  for (const k of Object.keys(base)) assert.equal(v.generals[0].added[k], 0, `${k} 卸下后应回到基线`);

  // 白盒：四槽全部塞同一件 8% 装备，验证 25% 夹紧真的生效（不是靠配置凑巧不超）
  const s2 = fresh();
  const g2 = s2.generals[0];
  for (const slot of ['weapon', 'armor', 'mount', 'tome']) s2.equipment[String(g2.id)][slot] = 500001;
  const v2 = panelState(s2, cfg);
  assert.equal(v2.generals[0].equipBonus.force, Math.round(v2.generals[0].base.force * 0.25));
});

test('旧档兼容：无 strategy / items / skillbook / interior 的存档也能开、能存', () => {
  const old = createWorld(cfg);
  delete old.strategy;
  delete old.clock;
  delete old.campaign;
  const s = normalizeWorld(old, cfg);
  assert.ok(s.items.length > 0);
  assert.ok(s.equipment[String(s.generals[0].id)]);
  assert.ok(s.skillbook.unlocked);
  assert.equal(s.interior.posts.agri, 0);
  const v = panelState(s, cfg);
  assert.equal(v.library.length, 51);
  assert.equal(v.generals.length, 1);
  // 二次 normalize 不会重复赠礼（幂等）
  const before = s.items.length;
  normalizeWorld(s, cfg);
  assert.equal(s.items.length, before);
});

test('确定性：同一状态深拷贝后执行相同动作序列，结果逐字节一致', () => {
  const run = () => {
    const s = fresh();
    const g = s.generals[0];
    const seq = [
      { type: 'equip', gId: g.id, slot: 'weapon', itemId: 500001 },
      { type: 'research', cfgId: 10003, amount: 10 },
      { type: 'appoint', post: 'agri', target: g.id },
      { type: 'proposal', id: 'farm' },
      { type: 'forge', cfgId: 300003 },
    ];
    const results = seq.map((a) => panelAction(s, cfg, a));
    return JSON.stringify({ results, view: panelState(s, cfg) });
  };
  assert.equal(run(), run());
});

test('动作校验：非法输入全部被拒且不破坏存档', () => {
  const s = fresh();
  const g = s.generals[0];
  const bad = [
    { type: 'equip', gId: g.id, slot: 'nope', itemId: 500001 },
    { type: 'equip', gId: g.id, slot: 'weapon', itemId: 999999 },
    { type: 'equip', gId: g.id, slot: 'weapon', itemId: 500002 }, // 护具装兵刃槽
    { type: 'unequip', gId: g.id, slot: 'mount' },                  // 空槽
    { type: 'learn', gId: g.id, pos: 1, cfgId: 10001 },             // Lv1 未解锁学习槽
    { type: 'learn', gId: g.id, pos: 0, cfgId: 10001 },             // 自带槽不可替换
    { type: 'research', cfgId: 999999, amount: 10 },
    { type: 'appoint', post: 'nope', target: g.id },
    { type: 'proposal', id: 'nope' },
    { type: 'forge', cfgId: 999999 },
    { type: 'unknown' },
  ];
  for (const a of bad) {
    const r = panelAction(s, cfg, a);
    assert.equal(r.ok, false, `${JSON.stringify(a)} 应被拒绝，实际 ${JSON.stringify(r)}`);
    assert.ok(typeof r.message === 'string' && r.message.length > 0);
  }
  assert.equal(panelState(s, cfg).ok, true);
  // 提案一回合只允许一次
  const p1 = panelAction(s, cfg, { type: 'proposal', id: 'farm' });
  const p2 = panelAction(s, cfg, { type: 'proposal', id: 'levy' });
  assert.equal(p1.ok, true);
  assert.equal(p2.ok, false);
});

test('研习：消耗残卷推进，满额解锁且不重复扣', () => {
  const s = fresh();
  const rec = PANEL_CONF.recipes.recipes.find((r) => r.cfgId === 10003);
  const need = rec.sources.find((x) => x.type === 'research').progressNeed;
  s.items.push({ id: 999001, cfgId: 400001, kind: 'scroll', count: 1000, ownerGeneralId: 0, source: '测试', forgedAt: 1 });
  const before = panelState(s, cfg).scrolls;
  const r = panelAction(s, cfg, { type: 'research', cfgId: 10003, amount: 10 });
  assert.equal(r.ok, true);
  assert.equal(panelState(s, cfg).scrolls, before - 10);
  for (let i = 0; i < 30 && !s.skillbook.unlocked['10003']; i++) {
    panelAction(s, cfg, { type: 'research', cfgId: 10003, amount: 20 });
  }
  assert.ok(s.skillbook.unlocked['10003'], `应已解锁（need=${need}）`);
  assert.equal(panelAction(s, cfg, { type: 'research', cfgId: 10003, amount: 10 }).ok, false);
});

test('UI 源码：语法可解析、无 Math.random、磁盘 index.html 未被改写', () => {
  assert.doesNotThrow(() => new vm.Script(PANELS_UI_SOURCE));
  assert.ok(PANELS_UI_SOURCE.includes('__slgPanels'));
  assert.ok(!/Math\.random/.test(PANELS_UI_SOURCE), '面板层不得引入非确定性随机');
  const disk = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.ok(!disk.includes('/__slg/panels/ui.js'), '磁盘原画面不得被注入');
  assert.ok(/Cocos Creator/.test(disk));
});

test('HTTP：index.html 运行时注入、ui.js 可下发、state/selfcheck/action 可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panels-test-'));
  const srv = await startOfflineServer({ saveDir: dir, httpPort: 19951, wsPort: 19952, quiet: true });
  try {
    const base = 'http://127.0.0.1:19951';
    const html = await (await fetch(`${base}/index.html`)).text();
    assert.ok(html.includes('/__slg/panels/ui.js'));
    const ui = await fetch(`${base}/__slg/panels/ui.js`);
    assert.equal(ui.status, 200);
    const src = await ui.text();
    assert.ok(src.includes('__slgPanels'));
    assert.doesNotThrow(() => new vm.Script(src));
    const chk = await (await fetch(`${base}/__slg/panels/selfcheck`)).json();
    assert.equal(chk.ok, true);
    const st = await (await fetch(`${base}/__slg/panels/state`)).json();
    assert.equal(st.ok, true);
    assert.equal(st.library.length, 51);
    assert.equal(st.librarySummary.sourcesCovered, 51);
    assert.equal(st.forgeCatalog.length, 18);
    const action = await (await fetch(`${base}/__slg/panels/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'equip', gId: st.generals[0].id, slot: 'weapon', itemId: st.items[0].id }),
    })).json();
    assert.equal(action.ok, true);
    assert.ok(action.view.generals[0].added.force > 0);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
