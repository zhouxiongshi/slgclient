/**
 * 闭环支线端到端检查（P75）
 *
 *   node tools/line-check.js                 # 用玩家真实存档副本（默认）
 *   node tools/line-check.js --fresh         # 空存档新开局
 *   node tools/line-check.js --only=L4,L8    # 只跑指定支线
 *
 * 判定口径：不只看返回值 ok，必须验「状态真的变了」「反馈文案存在」「下一步还能走」。
 * 动作全部走玩家真实入口：
 *   POST /__slg/strategy/action      战略层（出征/调遣/内政/运输/外交/事件/俘虏）
 *   POST /__slg/panels/action        六府（研习/装配/岗位）
 *   handleRequest(ctx, {name})       WS 协议（征兵/战法/酒馆/探索）
 * 时钟推进用真实 settleWorld，等价于玩家开着游戏等时钟走。
 */
import { startOfflineServer } from '../server/index.js';
import { settleWorld, handleRequest } from '../server/handlers.js';
import { loadConfig } from '../server/config.js';
import { factionConf } from '../server/domain/strategy.js';
import { salaryDueOf } from '../server/domain/city-econ.js';
import { busyReasonOf } from '../server/domain/general-busy.js';
import { diplomacyView } from '../server/domain/diplomacy.js';
import { mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLAYER_SAVE = 'C:/Users/Administrator/AppData/Roaming/三国策略 · 单机版/saves/save.json';
const fresh = process.argv.includes('--fresh');
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim().toUpperCase())) : null;

const results = [];
function rec(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${name}${detail ? ' — ' + detail : ''}`);
}
const run = (id) => !only || only.has(id);

const tmp = mkdtempSync(join(tmpdir(), 'slg-line-'));
if (!fresh && existsSync(PLAYER_SAVE)) copyFileSync(PLAYER_SAVE, join(tmp, 'save.json'));

const httpPort = 26088 + (process.pid % 500);
const wsPort = 27004 + (process.pid % 500);
const server = await startOfflineServer({ saveDir: tmp, httpPort, wsPort, travelMs: 200, quiet: true });
const base = `http://127.0.0.1:${httpPort}`;
const state = server.getState();
const cfg = loadConfig();
const FAC = factionConf().factions || [];
const ctx = { state, cfg, options: {}, push() {}, schedule() {}, save() {}, log() {} };

const post = async (p, body) => (await fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
})).json();
const getj = async (p) => (await fetch(base + p)).json();
const act = (body) => post('/__slg/strategy/action', body);
const pnl = (body) => post('/__slg/panels/action', body);
/* WS 协议入口：与客户端发送完全同一条路（含 settleWorld） */
const proto = (name, msg) => handleRequest(ctx, { name, msg: msg || {} });

function tick(days) {
  for (let i = 0; i < days; i += 1) {
    state.clock.day = (Number(state.clock.day) || 1) + 1;
    settleWorld(ctx, Date.now() + i * 1000);
  }
}

const cityName = (id) => {
  const map = (cfg.map?.cities || cfg.cities || []).find((x) => Number(x.id ?? x.cityId) === Number(id));
  return map?.name || map?.cityName || `#${id}`;
};
const myCities = () => Object.entries(state.strategy.cities).filter(([, v]) => v.owner === 'player').map(([id]) => Number(id));
const armyTroops = (a) => (a?.soldiers || []).reduce((s, n) => s + (Number(n) || 0), 0);
const idleArmyIn = (cityId) => (state.armys || []).find((a) => Number(a.cityId) === Number(cityId) && !a.marchId);
/* 有兵有将的空闲部队（出征/解散/清剿都要它） */
const readyArmy = () => (state.armys || []).find((a) => !a.marchId
  && (a.generals || []).some((g) => g) && (a.soldiers || []).some((n) => n > 0));
const econ = (id) => state.strategy.cityEcon[id] || {};

try {
  const homes = myCities();
  console.log(`\n[摸底] day=${state.clock.day} turn=${state.strategy.turn} 我方城=${homes.length} ${homes.map(cityName).join('/')}`);
  console.log(`[摸底] 部队=${(state.armys || []).length} 武将=${(state.generals || []).length} 战报=${(state.warReports || []).length} 势力=${FAC.length}`);
  if (!homes.length) throw new Error('没有我方城池，无法进行支线检查');
  const HOME = homes[0];
  const richHome = (state.armys || []).find((a) => a.soldiers?.some((n) => n > 0))?.cityId || HOME;
  /* 丰粮金，避免支线因资源不足假红；数值仍走真实扣减 */
  state.roleRes.grain = Math.max(Number(state.roleRes.grain) || 0, 200000);
  state.roleRes.gold = Math.max(Number(state.roleRes.gold) || 0, 200000);
  state.roleRes.jungong = Math.max(Number(state.roleRes.jungong) || 0, 5000);

  /* ============ L3 征兵 ============ */
  if (run('L3')) {
    const army = idleArmyIn(richHome);
    if (!army) rec('L3', '征兵：预览→征兵→兵力增加', false, '无部队可征');
    else {
      const pv = proto('army.conscriptPreview', { armyId: army.id });
      const max = Number(pv?.msg?.max) || 0;
      const before = armyTroops(army);
      if (max > 0) {
        const con0 = (army.con_cnts || []).reduce((s2, n) => s2 + (Number(n) || 0), 0);
        const r = proto('army.conscript', { armyId: army.id, amount: max, fill: true });
        /* ★ 征兵是异步的：受理后进 con_cnts（在途），到点才并入 soldiers。
           两条都要认，否则会把「已受理」误判成「没征到」。 */
        const con1 = (army.con_cnts || []).reduce((s2, n) => s2 + (Number(n) || 0), 0);
        const after = armyTroops(army);
        const accepted = r?.code === 0 && (con1 > con0 || after > before);
        rec('L3', '征兵：预览→征兵→受理并进入在途/入列', accepted,
          `${cityName(army.cityId)} 可征=${max} 在途 ${con0}→${con1} 兵列 ${before}→${after}`);
      } else {
        rec('L3', '征兵：不可征必须给原因', !!pv?.msg?.reason, `max=0 reason=${pv?.msg?.reason || '(空)'}`);
      }
    }
  }

  /* ============ L3b 兵打光→名额回池 ============ */
  if (run('L3B')) {
    const army = idleArmyIn(richHome);
    if (!army) rec('L3B', '征兵：兵打光名额立刻回池', false, '本城无部队');
    else {
      const sol = army.soldiers.slice();
      const cityTroops = Number(state.strategy.cities[army.cityId].troops) || 0;
      const savedArmys = (state.armys || []).filter((a) => Number(a.cityId) === Number(army.cityId) && a.id !== army.id);
      army.soldiers = [0, 0, 0];
      state.strategy.cities[army.cityId].troops = 0;
      state.armys = state.armys.filter((a) => Number(a.cityId) !== Number(army.cityId) || a.id === army.id);
      econ(army.cityId).lastLevyTurn = -1;
      const pv = proto('army.conscriptPreview', { armyId: army.id });
      const max = Number(pv?.msg?.max) || 0;
      rec('L3B', '征兵：兵打光后名额立刻回池', max > 0,
        `${cityName(army.cityId)} 清空后本旬可征=${max} reason=${pv?.msg?.reason || ''}`);
      army.soldiers = sol;
      state.strategy.cities[army.cityId].troops = cityTroops;
      state.armys = state.armys.concat(savedArmys);
      econ(army.cityId).lastLevyTurn = -1;
    }
  }

  /* ============ L13 运输粮道 ============ */
  if (run('L13') && homes.length >= 2) {
    const to = homes.find((id) => id !== richHome) ?? homes[0];
    const s0 = Number(econ(to).store) || 0;
    const r = await act({ action: 'transport', cityId: to, fromCityId: richHome, grain: 300 });
    tick((Number(r?.days) || 5) + 2);
    const s1 = Number(econ(to).store) || 0;
    rec('L13', '运输：调粮→在途→抵达入仓', r?.ok === true && s1 > s0,
      `${cityName(richHome)}→${cityName(to)} 300 石 ${r?.days || '?'}日 城库 ${s0}→${s1}`);
  }

  /* ============ L4 内政建设（工期以旬计，完成后 status=done 且产出真涨） ============ */
  if (run('L4')) {
    const FIELD_OF = { farm: 'devAgri', market: 'devTrade', barracks: 'devArms', wall: 'devDef' };
    let done = null;
    for (const kind of ['farm', 'market', 'wall', 'barracks', 'school', 'relief']) {
      const r = await act({ action: 'invest', cityId: HOME, kind });
      if (r?.ok) { done = { kind, r }; break; }
    }
    if (!done) {
      const r = await act({ action: 'invest', cityId: HOME, kind: 'farm' });
      rec('L4', '内政：办差→推进→完成落到产出', false, `全部办差被拒：${JSON.stringify(r).slice(0, 180)}`);
    } else {
      const taskId = done.r.task?.id ?? done.r.taskId;
      const t0 = (state.strategy.interiorTasks || []).find((t) => t.id === taskId);
      const need = Number(t0?.ticks ?? 3);
      const field = FIELD_OF[done.kind];
      const v0 = field ? Number(econ(HOME)[field] ?? 0) : null;
      tick(Math.max(need, 1) * 10 + 15);
      const t1 = (state.strategy.interiorTasks || []).find((t) => t.id === taskId);
      const v1 = field ? Number(econ(HOME)[field] ?? 0) : null;
      const finished = !t1 || t1.status === 'done';
      /* 有 field 的办差必须真的把产出加上去；赈灾/劝课这类走别的字段，只验完工 */
      const grew = field == null || v1 > v0;
      rec('L4', '内政：办差→逐旬推进→完成且产出真涨', finished && grew,
        `${done.kind} 工期${need}旬 status=${t1?.status || '已移除'} ${field ? `${field} ${v0}→${v1}` : '（非产出类）'}`);
    }
  }

  /* ============ L5 太守任命 ============ */
  if (run('L5')) {
    const pick = (state.generals || []).find((g) => Number(g.cityId) === HOME && !g.transit && !g.isLord);
    if (!pick) rec('L5', '太守：任命本城官员并生效', false, '本城无可用官员');
    else {
      const r = await act({ action: 'governorSet', cityId: HOME, officerId: pick.id, policy: 'agri' });
      const cur = (state.strategy.governors || {})[HOME];
      const gid = cur && Number(cur.officerId ?? 0);
      rec('L5', '太守：任命本城官员+方针生效', r?.ok === true && gid === Number(pick.id),
        `${pick.name || pick.id}→${cityName(HOME)} 方针=${cur?.policy} ${r?.ok === false ? JSON.stringify(r).slice(0, 120) : ''}`);
      const outsider = (state.generals || []).find((g) => Number(g.cityId) !== HOME && !g.transit);
      if (outsider) {
        const bad = await act({ action: 'governorSet', cityId: HOME, officerId: outsider.id });
        rec('L5b', '太守：非本城官员必须硬拒', bad?.ok === false && bad?.reason === 'not_local_city',
          `reason=${bad?.reason}`);
      }
    }
  }

  /* ============ L6 调遣行程 ============ */
  if (run('L6') && homes.length >= 2) {
    const to = homes.find((id) => id !== HOME);
    /* ★ P76：跳过占身武将（L5 刚任命的太守正占身，被拦是正确行为） */
    const g = (state.generals || []).find((x) => Number(x.cityId) === HOME && !x.transit && !busyReasonOf(state, x.id));
    if (!g) rec('L6', '调遣：启程→在途→抵达', false, '出发城无武将');
    else {
      const from = Number(g.cityId);
      const r = await act({ action: 'dispatchGeneral', generalId: g.id, toCityId: to, fromCityId: from });
      const departed = r?.ok === true && Number(g.cityId) === from && !!g.transit;
      tick((Number(r?.marchDays) || 3) + 2);
      const arrived = Number(g.cityId) === to && !g.transit;
      rec('L6', '调遣：启程→在途→抵达落城', departed && arrived,
        `${g.name || g.id} ${cityName(from)}→${cityName(to)} ${r?.marchDays || '?'}日 ${departed ? '已启程' : '未启程'} ${arrived ? '已抵达' : '未抵达'}`);
    }
  }

  /* ============ L8 战法研习（挑真正未解锁的） ============ */
  if (run('L8')) {
    /* ★ P76：占身武将不能接研习，挑无占身的 */
    const g = (state.generals || []).find((x) => Number(x.cityId) === richHome && !busyReasonOf(state, x.id))
      || (state.generals || []).find((x) => !x.transit && !busyReasonOf(state, x.id));
    const lib = (await getj('/__slg/panels/state'))?.library || [];
    const locked = lib.find((s) => s && s.cfgId && !state.skillbook?.unlocked?.[String(s.cfgId)]);
    if (!g || !locked) rec('L8', '研习：委派→逐旬→习得', false, `武将=${!!g} 未解锁战法=${!!locked}（库${lib.length}条）`);
    else {
      const r = await pnl({ type: 'assignResearch', cfgId: locked.cfgId, generalId: g.id });
      const assigned = !!state.skillbook?.assign?.[String(locked.cfgId)];
      const key = String(locked.cfgId);
      const progAt = () => {
        const cur = state.skillbook?.research?.[key];
        return { p: Number(cur?.progress ?? 0), need: Number(cur?.need ?? 0) };
      };
      const p0 = progAt();
      tick(60);
      const p1 = progAt();
      tick(240);
      const p2 = progAt();
      const unlocked = !!(state.skillbook?.unlocked?.[key]);
      /* 判据：进度必须真的在涨（不是卡死），且最终能解锁 */
      const progressing = p1.p > p0.p || unlocked;
      rec('L8', '研习：委派→逐旬推进→习得入库', r?.ok === true && assigned && progressing && unlocked,
        `${g.name || g.id} 研 ${locked.name || locked.cfgId} 进度 ${p0.p}/${p0.need} → 60日 ${p1.p} → 300日 ${p2.p} 解锁=${unlocked}`);
    }
  }

  /* ============ L9 武将成长 ============ */
  if (run('L9')) {
    const g = (state.generals || []).find((x) => Number(x.cityId) === HOME && Number(x.loyal ?? 0) < 99)
      || (state.generals || []).find((x) => Number(x.loyal ?? 0) < 99)
      || (state.generals || [])[0];
    const l0 = Number(g?.loyal ?? 0);
    const r = await act({ action: 'reward', generalId: g?.id, amount: 300 });
    const l1 = Number((state.generals || []).find((x) => x.id === g?.id)?.loyal ?? 0);
    rec('L9', '成长：赏赐→忠诚提升', r?.ok === true && l1 > l0,
      `${g?.name || g?.id} 忠诚 ${l0}→${l1}`);
    const cap = (state.generals || []).find((x) => Number(x.level) >= 10 && !x.advanced);
    if (cap) {
      const adv = await act({ action: 'advanceGeneral', generalId: cap.id });
      rec('L9b', '成长：满 10 级→付费进阶', adv?.ok === true && !!cap.advanced, `Lv${cap.level} advanced=${cap.advanced}`);
    }
  }

  /* ============ L10 外交：赠礼抬态度 → 门槛动作（停战）成立 ============ */
  if (run('L10')) {
    const att = (fid) => {
      const v = diplomacyView(state);
      const row = (v.factions || []).find((f) => f.id === fid);
      return row ? { value: Number(row.attitude), war: !!row.war, truce: Number(row.truceUntil) || 0 } : null;
    };
    const target = FAC.find((f) => att(f.id)) || FAC[0];
    if (!target) rec('L10', '外交：赠礼→态度上升→停战成立', false, '无外交对象');
    else {
      const b0 = att(target.id);
      state.roleRes.gold = Math.max(Number(state.roleRes.gold) || 0, 120000);
      let last = null;
      for (let i = 0; i < 6 && (att(target.id)?.value ?? 0) < -25; i += 1) {
        last = await act({ action: 'diplo', diploAction: 'gift', faction: String(target.id), gold: 10000 });
      }
      const b1 = att(target.id);
      const rose = !!b1 && b1.value > (b0?.value ?? 0);
      rec('L10', '外交：赠礼→态度真的上升', rose,
        `${target.name || target.id} 态度 ${b0?.value}→${b1?.value} ${last?.ok === false ? JSON.stringify(last).slice(0, 120) : ''}`);
      /* 门槛动作：态度够 -30 就能停战；不够也必须给可读拒绝理由 */
      if (b1) {
        const t = await act({ action: 'diplo', diploAction: 'truce', faction: String(target.id), gold: 1500 });
        const b2 = att(target.id);
        const ok = t?.ok === true ? (b2.truce > 0 || !b2.war) : (t?.ok === false && !!t.text);
        rec('L10b', '外交：停战→休兵生效（或给可读拒绝理由）', ok,
          `${target.name || target.id} truce=${b2?.truce ?? 0} ${t?.ok === false ? String(t.text).slice(0, 80) : '已休兵'}`);
      }
    }
  }

  /* ============ L11 事件抉择（事件冷却 6 旬，最多等 180 日） ============ */
  if (run('L11')) {
    const pending = () => (state.strategy.pendingEvents || []);
    let ev = pending()[0];
    for (let i = 0; i < 24 && !ev; i += 1) { tick(10); ev = pending()[0]; }
    if (!ev) rec('L11', '事件：弹卡→选项→后果落地', false, '240 日内未出现待决事件');
    else {
      const c0 = ev.choices?.[0] || { id: 'ok' };
      const r = await act({ action: 'eventChoice', id: ev.id, choice: String(c0.id ?? 'ok') });
      const gone = !pending().some((e) => e.id === ev.id);
      rec('L11', '事件：弹卡→选项→后果落地并收卡', r?.ok !== false && gone,
        `事件#${ev.id}「${String(ev.title || ev.text || '').slice(0, 24)}」选项=${c0.id ?? 0} ${r?.ok === false ? JSON.stringify(r).slice(0, 140) : '已结算'}`);
    }
  }

  /* ============ L12 阶段目标 ============ */
  if (run('L12')) {
    const v = (await getj('/__slg/panels/state'))?.strategy || {};
    const sg = v.nextStage || v.stages;
    const ok = !!sg && (typeof sg === 'object');
    rec('L12', '阶段目标：目标存在且可读', ok,
      sg ? `nextStage=${JSON.stringify(sg).slice(0, 120)}` : '无 nextStage/stages 字段');
  }

  /* ============ L7 编队→征兵→解散（用临时小队，不动主力） ============ */
  if (run('L7')) {
    /* ★ P76：无占身才能编队（太守/研习/办差中的会被正确拦下） */
    const g = (state.generals || []).find((x) => Number(x.cityId) === HOME && !x.transit && !x.order && !busyReasonOf(state, x.id));
    const cid = HOME;
    const t0 = Number(state.strategy.cities[cid].troops) || 0;
    if (!g) rec('L7', '编队：新建队伍→征兵→解散→兵回城', false, '本城无空闲武将');
    else if (t0 < 400) rec('L7', '编队：新建队伍→征兵→解散→兵回城', false, `城兵不足 ${t0}`);
    else {
      const mk = proto('army.dispose', { cityId: cid, order: 1, position: 0, generalId: g.id });
      const army = (state.armys || []).find((a) => Number(a.cityId) === cid && Number(a.order) === 1);
      const created = !!army && (army.generals || []).includes(Number(g.id));
      let conscripted = false;
      if (army) {
        const pv = proto('army.conscriptPreview', { armyId: army.id });
        const mx = Math.min(Number(pv?.msg?.max) || 0, 300);
        if (mx > 0) conscripted = proto('army.conscript', { armyId: army.id, amount: mx, fill: true })?.code === 0;
      }
      const sol = armyTroops(army);
      const t1 = Number(state.strategy.cities[cid].troops) || 0;
      const d = army ? await act({ action: 'disbandArmy', armyId: army.id }) : { ok: false, reason: 'no_army' };
      const gone = !(state.armys || []).some((a) => Number(a.id) === Number(army?.id));
      const t2 = Number(state.strategy.cities[cid].troops) || 0;
      rec('L7', '编队：新建队伍→征兵→解散→兵回城',
        created && d?.ok === true && gone && t2 >= t1,
        `新建队${army?.id} 征兵${sol} 城兵 ${t0}→${t1}→${t2} ${gone ? '队伍已撤' : '队伍仍在'} ${mk?.code !== 0 ? `dispose=${JSON.stringify(mk?.msg || {}).slice(0, 80)}` : ''}`);
    }
  }

  /* ============ L17 清剿营地（用真实来犯军营地） ============ */
  if (run('L17')) {
    const army = readyArmy();
    const g = (state.garrisons || []).find((x) => !x.cleared);
    if (!g) rec('L17', '清剿：营地→出兵→清除', false, '当前无来犯军营地');
    else if (!army) rec('L17', '清剿：营地→出兵→清除', false, '无可用部队');
    else {
      const r0 = proto('strategy.clearThreat', { garrisonId: g.id, armyId: army.id });
      const r = r0?.msg || r0;
      const cleared = !!(state.garrisons || []).find((x) => x.id === g.id)?.cleared;
      rec('L17', '清剿：营地→出兵→清除', r?.ok === true && cleared,
        `营地#${g.id}(${g.name}) ${r?.ok === false ? JSON.stringify(r).slice(0, 140) : (cleared ? '已清除' : '未清除')}`);
    }
  }

  /* ============ L16 出征→行军→自动开战→战报 ============ */
  if (run('L16')) {
    const army = readyArmy();
    const from = Number(army?.cityId) || richHome;
    const { marchableFrom } = await import('../server/domain/strategy.js');
    const near = marchableFrom(from, state).map(Number);
    const foeId = near.find((id) => {
      const s = state.strategy.cities[id];
      return s && s.owner !== 'player' && s.owner !== 'neutral';
    });
    if (!army) rec('L16', '出征：出征→行军→自动开战→战报带回放', false, '无可用部队（有将有兵）');
    else if (!foeId) rec('L16', '出征：出征→行军→自动开战→战报带回放', false, `${cityName(from)}无相邻敌城 marchable=${JSON.stringify(near).slice(0, 80)}`);
    else {
      const r = await act({ action: 'attack', cityId: foeId, armyId: army.id, fromCityId: from, frac: 1 });
      const marched = r?.ok === true && !!army.marchId;
      const rep0 = (state.warReports || []).length;
      tick(50);
      const fresh = (state.warReports || []).slice(rep0);
      const hasAnim = fresh.some((x) => x.anim);
      const taken = state.strategy.cities[foeId]?.owner === 'player';
      rec('L16', '出征：出征→行军→自动开战→战报带回放',
        marched && (fresh.length > 0 || taken),
        `${cityName(from)}→${cityName(foeId)} ${marched ? '已出发' : `未出发 ${JSON.stringify(r).slice(0, 120)}`} 战报+${fresh.length} 带anim=${hasAnim} 占城=${taken}`);
    }
  }

  /* ============ L14 俘虏三条出口：义释 / 招降 / 处斩 ============ */
  if (run('L14')) {
    state.captives = Array.isArray(state.captives) ? state.captives : [];
    state.roleRes.gold = Math.max(Number(state.roleRes.gold) || 0, 200000);
    /* 俘虏是打出来的，本局可能一名未擒；三条出口要各验一次，就按真实存档结构补足。
       动作与判定全部走真实入口，补的只是「输入数据」。 */
    const owned = new Set((state.generals || []).map((g) => Number(g.cfgId)));
    const held = new Set(state.captives.map((c) => Number(c.cfgId)));
    const pool = [...cfg.generalByCfg.keys()].filter((id) => !owned.has(Number(id)) && !held.has(Number(id)));
    while (state.captives.length < 3 && pool.length) {
      const cid = pool.shift();
      state.captives.push({
        cfgId: Number(cid), name: cfg.generalByCfg.get(cid)?.name || `武将${cid}`,
        from: cityName(HOME), loyal: 50, days: 0, day: Number(state.clock.day) || 1,
      });
    }
    if (!state.captives.length) rec('L14', '俘虏：义释/招降/处斩→出营', false, '无俘虏可用');
    else {
      const n0 = state.captives.length;
      const r1 = await act({ action: 'captiveRelease', idx: 0 });
      const released = r1?.ok === true && state.captives.length < n0;
      rec('L14', '俘虏：义释→名望+态度→出营', released,
        `俘虏 ${n0}→${state.captives.length} ${r1?.ok === false ? JSON.stringify(r1).slice(0, 120) : `名望+${r1.fameDelta ?? 0}`}`);

      const g0 = (state.generals || []).length;
      const r2 = await act({ action: 'captive', idx: 0 });
      const joined = (state.generals || []).length > g0;
      rec('L14b', '俘虏：招降→入我军（或给可读拒绝理由）',
        joined || (r2?.ok === false && !!r2.text),
        `${r2?.ok === false ? String(r2.text).slice(0, 80) : '已归顺'} 武将 ${g0}→${(state.generals || []).length}`);

      if (state.captives.length) {
        const n1 = state.captives.length;
        const r3 = await act({ action: 'captiveExecute', idx: 0 });
        rec('L14c', '俘虏：处斩→出营且恶名留痕', r3?.ok === true && state.captives.length < n1,
          `俘虏 ${n1}→${state.captives.length} ${r3?.ok === false ? JSON.stringify(r3).slice(0, 120) : `恶名${r3.infamy ?? 0}`}`);
      } else {
        rec('L14c', '俘虏：处斩→出营且恶名留痕', false, '招降后已无俘虏');
      }
    }
  }

  /* ============ L15 酒馆招募 ============ */
  if (run('L15')) {
    const r = proto('tavern.guests', { cityId: HOME });
    const guests = [...(r?.msg?.now || []), ...(r?.msg?.today || []), ...(r?.msg?.guests || [])];
    const n0 = (state.generals || []).length;
    if (!guests.length) rec('L15', '酒馆：访客名单→登庸入营', false, `名单为空 ${JSON.stringify(r?.msg || {}).slice(0, 100)}`);
    else {
      const t = proto('general.explore', { cityId: HOME });
      const n1 = (state.generals || []).length;
      rec('L15', '酒馆：访客名单→登庸入营', n1 > n0 || t?.code === 0,
        `访客=${guests.length} 武将 ${n0}→${n1} ${t?.msg?.line || t?.msg?.reason || ''}`);
    }
  }

  /* ============ L2 守城战（诸侯来犯抵达即打） ============ */
  if (run('L2')) {
    const { spawnFactionAssault } = await import('../server/domain/strategy.js');
    const faction = FAC[0];
    if (!faction) rec('L2', '守城：来犯抵达→守城战→可回放战报', false, '势力配置为空');
    else {
      const rep0 = (state.warReports || []).length;
      spawnFactionAssault(state, cfg, ctx, faction, { id: HOME, name: cityName(HOME) }, 800);
      const g = (state.garrisons || []).filter((x) => Number(x.targetCity) === HOME && !x.cleared).pop();
      if (!g) rec('L2', '守城：来犯抵达→守城战→可回放战报', false, '未能生成来犯军');
      else {
        g.arriveDay = Number(state.clock.day);
        tick(2);
        const def = (state.warReports || []).slice(rep0).find((x) => x.defense || x.anim);
        rec('L2', '守城：来犯抵达→守城战→可回放战报', !!def,
          `${cityName(HOME)} ${def ? `守方=${def.anim?.a?.name}(${def.anim?.a?.total}) 攻城=${def.anim?.d?.name}(${def.anim?.d?.total})` : '无守城战报'}`);
      }
    }
  }

  /* ============ L19 粮道断绝：飞地断粮→民心降+守军逃散→连通后恢复 ============ */
  if (run('L19')) {
    const { supplyMap, supplyTick } = await import('../server/domain/supply.js');
    const m0 = supplyMap(state);
    /* 找一个 hops≥1 的己方城，把它的必经节点临时判给敌方来切断粮道
       （只改 owner 并直接调 supplyTick，不走 settleWorld，不碰部队与归属结算） */
    const target = Object.entries(m0.byCity)
      .filter(([id, v]) => state.strategy.cities[id]?.owner === 'player' && v.hops >= 1)
      .sort((a, b) => b[1].hops - a[1].hops)[0];
    if (!target) rec('L19', '粮道：断绝→民心降守军散→恢复', false, '无多跳己方城可切断');
    else {
      const [tid, info] = target;
      const via = Number((info.via || [])[0]) || 0;
      const e = econ(tid);
      const morale0 = Number(e.morale ?? 60);
      const troops0 = Number(state.strategy.cities[tid].troops) || 0;
      const owners = Object.entries(state.strategy.cities).map(([id, v]) => [id, v.owner]);
      if (via) state.strategy.cities[via].owner = '__test_cut__';
      const hit = supplyTick(state, cfg, ctx);
      const cut = !!(hit.isolated || []).map(Number).includes(Number(tid));
      const morale1 = Number(e.morale ?? 60);
      const troops1 = Number(state.strategy.cities[tid].troops) || 0;
      for (const [id, o] of owners) state.strategy.cities[id].owner = o;
      const back = supplyTick(state, cfg, ctx);
      const recovered = (back.recovered || []).map(Number).includes(Number(tid));
      rec('L19', '粮道：断绝→民心降+守军逃散→复通恢复',
        cut && morale1 < morale0 && troops1 <= troops0 && recovered,
        `${cityName(tid)} 断绝=${cut} 民心 ${morale0}→${morale1} 守军 ${troops0}→${troops1} 复通=${recovered}`);
    }
  }

  /* ============ L20 研习占身互斥（P76） ============ */
  if (run('L20')) {
    const lib = (await getj('/__slg/panels/state'))?.library || [];
    const lockedList = lib.filter((x) => x && x.cfgId && !state.skillbook?.unlocked?.[String(x.cfgId)]);
    const g = (state.generals || []).find((x) => Number(x.cityId) === HOME && !x.transit && !busyReasonOf(state, x.id));
    if (!g || lockedList.length < 2) {
      rec('L20', '研习占身：有任务在身不能接研习', false, `闲员=${!!g} 未解锁战法=${lockedList.length}条`);
    } else {
      /* 真实占身路径：任命太守（他城/本城太守都算占身） */
      const rGov = await act({ action: 'governorSet', cityId: HOME, officerId: g.id, policy: 'agri' });
      const r = await pnl({ type: 'assignResearch', cfgId: lockedList[0].cfgId, generalId: g.id });
      const blocked = r?.ok === false && /研习战法|腾不出手|正任太守/.test(String(r.message || ''));
      rec('L20', '研习占身：太守在身委派研习被拦且给中文理由', rGov?.ok === true && blocked,
        `${g.name || g.id} 任太守后委派研习→${r?.ok === false ? String(r.message).slice(0, 60) : '被放行(缺陷)'}`);
      /* 反向：研习中的武将不能任太守 */
      const g2 = (state.generals || []).find((x) => !x.transit && !busyReasonOf(state, x.id)
        && Number(x.cityId) !== Number(g.id));
      if (g2) {
        const key = String(lockedList[1].cfgId);
        state.skillbook.research = state.skillbook.research || {};
        if (!state.skillbook.research[key]) state.skillbook.research[key] = { progress: 0, need: 120 };
        const a = await pnl({ type: 'assignResearch', cfgId: Number(key), generalId: g2.id });
        const gvCity = Number(g2.cityId);
        const r2 = await act({ action: 'governorSet', cityId: gvCity, officerId: g2.id, policy: null });
        rec('L20b', '研习占身：研习中的武将任太守被拦', a?.ok === true && r2?.ok === false
          && String(r2.reason || '').startsWith('busy_'),
          `${g2.name || g2.id} 研习后任太守→${r2?.ok === false ? r2.reason : '被放行(缺陷)'}`);
        delete state.skillbook.assign[key];
      }
    }
  }

  /* ============ L21 部队调防（P76）：整队进驻己方邻城，归属地改到目标城 ============ */
  if (run('L21')) {
    const marchableFrom = (await import('../server/domain/strategy.js')).marchableFrom;
    const pool = (state.armys || []).filter((a) => state.strategy.cities[a.cityId]?.owner === 'player'
      && (a.soldiers || []).some((n) => n > 0) && !a.marchId);
    let picked = null;
    for (const a of pool) {
      const near = marchableFrom(Number(a.cityId), state).map(Number);
      /* 有己方邻城直接用；没有就把一个邻城临时划给玩家（验证器存档副本，跑完不还原，
         便于观察归属变更后的世界——正式回归锁在 tests/p76-busy-and-moves.test.js） */
      const own = near.filter((id) => state.strategy.cities[id]?.owner === 'player');
      if (own.length) { picked = { army: a, to: own[0], flipped: false }; break; }
      if (near.length) {
        const b = near[0];
        state.strategy.cities[b].owner = 'player';
        picked = { army: a, to: b, flipped: true };
        break;
      }
    }
    if (!picked) rec('L21', '部队调防：整队进驻→归属地变更', false, '没有带兵队伍可调');
    else {
      const { army: a0, to, flipped } = picked;
      const from = Number(a0.cityId);
      state.roleRes.grain = Math.max(Number(state.roleRes.grain) || 0, 500000);
      const r = await act({ action: 'armyMove', armyId: a0.id, cityId: to, fromCityId: from });
      const departed = r?.ok === true && !!a0.marchId;
      if (departed) {
        const m = (state.strategy.marches || []).find((x) => x.kind === 'armyMove' && !x.resolved);
        tick((Number(m?.arriveDay) || state.clock.day) - state.clock.day + 1);
      }
      rec('L21', '部队调防：整队进驻→归属地变更',
        r?.ok === true && departed && Number(a0.cityId) === to && !a0.marchId,
        `队伍${a0.id} ${cityName(from)}→${cityName(to)}${flipped ? '（邻城临时划入）' : ''} `
        + `${r?.ok === false ? JSON.stringify(r).slice(0, 80) : ''} 抵达后归属=${cityName(a0.cityId)}`);
    }
  }

  /* ============ L18 军粮/俸禄欠付 ============ */
  if (run('L18')) {
    const due0 = salaryDueOf(state);
    const nonLord = () => (state.generals || []).filter((g) => !g.isProtagonist);
    const avg = (arr) => (arr.length ? arr.reduce((a, g) => a + (Number(g.loyal) || 0), 0) / arr.length : 0);
    const avg0 = avg(nonLord());
    /* events 是 480 上限的环形队列，按长度切片会取空；直接按内容扫尾部 */
    const evTail = () => (state.strategy.events || []).slice(-40);
    /* 每旬都清零：真实「府库一直空虚」的场景，而不是只空一旬又被税收填上 */
    const trace = [];
    for (let i = 0; i < 30; i += 1) {
      state.roleRes.gold = 0;
      state.roleRes.grain = 0;
      tick(1);
      if (state.clock.day % 10 === 0) {
        trace.push(`d${state.clock.day}:金${Math.round(state.roleRes.gold)}${
          salaryDueOf(state) > 0 ? '欠' : '齐'}:忠${avg(nonLord()).toFixed(1)}`);
      }
    }
    if (process.env.SLG_LINE_DEBUG) console.log('    [L18 trace]', trace.join(' | '));
    const avg1 = avg(nonLord());
    const logged = evTail().some((e) => /欠饷|府库空虚/.test(String(e.text || '')))
      || (state.strategy.notes || []).some((n) => /欠饷|府库空虚/.test(String(n.text || '')));
    rec('L18', '军粮/俸禄欠付：断粮→忠诚下滑且大事记留痕（不静默）',
      due0 >= 0 && avg1 < avg0 && logged,
      `应发俸禄=${Math.round(due0)} 忠诚均值 ${avg0.toFixed(1)}→${avg1.toFixed(1)} 留痕=${logged}`);
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 汇总 ${pass}/${results.length} =====`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  待查 ${r.id} ${r.name} — ${r.detail}`);
} catch (err) {
  console.error('\n[line-check] 中断：', err.stack || err.message);
  process.exitCode = 1;
} finally {
  await server.close();
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
