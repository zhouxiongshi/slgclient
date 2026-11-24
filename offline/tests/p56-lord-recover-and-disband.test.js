/**
 * P56（2026-11-24）队伍回归：
 *  1. 主公在编队候选/整编下拉里显示为本名，不再「武将1000 / 武将880001」；
 *  2. 旧批量调防把主公调走后，征兵页给出所在城与一键归队；
 *  3. 主公不可被旧协议「合成/转化」抹掉；现代存档缺人时原地补回而不丢进度；
 *  4. 队伍可真正解散：退兵/清在途/作废令牌/释放武将/删队，行军中拒绝；
 *  5. UI 全选不再带走主公与在编武将，两处编队入口都提供解散按钮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld, hasProtagonist } from '../server/world.js';
import { handleRequest } from '../server/handlers.js';
import { panelState } from '../server/domain/panels.js';
import { disbandArmy } from '../server/domain/formation.js';

const cfg = loadConfig();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const req = (name, msg = {}) => ({ seq: 1, name, msg });
function mkCtx(state) {
  const pushes = [];
  return { state, cfg, pushes, push(n, m) { pushes.push({ name: n, msg: m }); }, save() {}, log() {}, schedule() {} };
}
const fresh = () => normalizeWorld(createWorld(cfg), cfg);
const heroOf = (s) => s.generals.find((g) => g.isProtagonist || Number(g.cfgId) === 880001);

test('P56-① 主公在编队候选与整编下拉里使用本名', () => {
  const s = fresh();
  const ctx = mkCtx(s);
  const r = handleRequest(ctx, req('general.myGenerals', { cityId: Number(s.citys[0].cityId) }));
  assert.equal(r.code, 0);
  assert.equal(r.msg.generals[0].name, '主公');
  assert.equal(r.msg.protagonist.inCity, true);
  const view = panelState(s, cfg);
  assert.equal(view.strategy.allGenerals[0].name, '主公');
  assert.equal(view.strategy.armies[0].generals[0].name, '主公');
});

test('P56-② 主公被批量调防到别城时，征兵页能看见所在城', () => {
  const s = fresh();
  const hero = heroOf(s);
  hero.cityId = 2;
  const ctx = mkCtx(s);
  const r = handleRequest(ctx, req('general.myGenerals', { cityId: Number(s.citys[0].cityId) }));
  assert.equal(r.code, 0);
  assert.equal(r.msg.generals.length, 0, '本城候选仍不混入别城武将');
  assert.equal(r.msg.protagonist.id, hero.id);
  assert.equal(r.msg.protagonist.cityId, 2);
  assert.equal(r.msg.protagonist.inCity, false);
  assert.equal(r.msg.protagonist.name, '主公');
});

test('P56-③ 主公不可被合成/转卖，旧协议也删不掉', () => {
  for (const name of ['general.composeGeneral', 'general.convert']) {
    const s = fresh();
    const hero = heroOf(s);
    const ctx = mkCtx(s);
    const r = handleRequest(ctx, req(name, { gIds: [hero.id] }));
    assert.equal(r.code, 1, name + ' 必须拒绝');
    assert.equal(r.msg.reason, 'protagonist_locked');
    assert.ok(s.generals.some((g) => g.id === hero.id), name + ' 不得删除主公');
  }
});

test('P56-④ 现代存档缺主公时原地补回，保留资源与其他存档字段', () => {
  const base = fresh();
  const hero = heroOf(base);
  const staleId = hero.id;
  const gold = base.roleRes.gold;
  base.generals = base.generals.filter((g) => g.id !== staleId);
  base.armys[0].generals[0] = staleId; // 旧协议删人留下僵尸引用

  const fixed = normalizeWorld(base, cfg);
  const restored = heroOf(fixed);
  assert.ok(hasProtagonist(fixed));
  assert.equal(fixed.roleRes.gold, gold, '不得清档重开');
  assert.equal(fixed.generals.length, 1);
  assert.equal(restored.cfgId, 880001);
  assert.equal(restored.skills[0]?.cfgId, 19001);
  assert.equal(fixed.armys[0].generals[0], restored.id, '补回后重新入队');
  assert.ok((fixed.skills || []).some((s) => Number(s.cfgId) === 19001
    && (s.generals || []).includes(restored.id)), '自带战法登记同步');
});

test('P56-⑤ 解散队伍：三槽兵力/在途退驻城，武将释放，队伍移除', () => {
  const s = fresh();
  const ctx = mkCtx(s);
  const a = s.armys[0];
  const hero = heroOf(s);
  const gids = [hero.id, 0, 0];
  a.generals = [...gids];
  a.soldiers = [800, 120, 30];
  a.con_cnts = [0, 50, 0];
  a.con_times = [0, 9999999999999, 0];
  const before = Number(s.strategy.cities[a.cityId].troops) || 0;
  const token = a.conToken || 0;

  const r = disbandArmy(s, ctx, { armyId: a.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.returned, 1000);
  assert.equal(s.armys.some((x) => x.id === a.id), false, '队伍从名册移除');
  assert.equal(Number(s.strategy.cities[a.cityId].troops), before + 1000, '兵力与在途全部退驻城');
  assert.equal(Number(hero.order) || 0, 0, '武将不再带旧队号');
  assert.ok(a.conToken > token, '在途定时器已作废');
  assert.ok(ctx.pushes.some((p) => p.name === 'army.disband'), '下发队伍移除事件');
});

test('P56-⑥ 行军中不可解散；WS 入口与既有队号 4~99 同样可用', () => {
  const s = fresh();
  const ctx = mkCtx(s);
  const a = s.armys[1];
  a.marchId = 77;
  const blocked = disbandArmy(s, ctx, { armyId: a.id });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'marching');
  delete a.marchId;

  a.order = 7; // P55 残部重编的合法既有队号
  const r = handleRequest(ctx, req('army.disband', { armyId: a.id }));
  assert.equal(r.code, 0, 'WS 解散入口可用');
  assert.equal(s.armys.some((x) => x.id === a.id), false);
});

test('P56-⑦ UI：全选不带走主公，征兵页/整编弹窗都有解散入口', () => {
  const ui = read('server/panels-ui.js');
  assert.match(ui, /return !g\.isProtagonist && g\.state !== '在编'/, '全选只选闲置且非主公');
  assert.match(ui, /data-fup="disband"/, '整编弹窗提供解散按钮');
  assert.match(ui, /action: 'disbandArmy'/, '解散走统一动作口');
  const sk = read('server/skills.js');
  assert.match(sk, /主公归队/, '主公在别城时给出一键归队');
  assert.match(sk, /send\('army\.disband'/, '征兵页提供解散入口');
  assert.match(sk, /orders\.indexOf\(a\.order\) < 0/, '4~99 号队伍也能显示并可解散');
  const gateway = read('server/index.js');
  assert.match(gateway, /act === 'disbandArmy'/, 'HTTP 动作口接了解散');
  const handler = read('server/handlers.js');
  assert.match(handler, /case 'army\.disband'/, 'WS 动作口接了解散');
});
