/**
 * 序章节拍。只在游戏日跨过时列出要做的事并改它负责的标记。
 * 产量公式在 economy，进度数字在 drift，死亡文本在 chronicle。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceClock } from '../clock.js';
import { applyDays } from './economy.js';
import { addDrift } from './drift.js';
import { lineFor } from './story.js';
import { peopleById } from './people.js';
import { chainDef, transitionFate } from './fate.js';
import { loadOverrides, overridesMtime } from '../gm/overrides.js';
import { makeBuild, makeGeneral, nextId, mainCity } from '../world.js';

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../conf/campaign/chapter1.json');

let cached = null;
let cachedStamp = '';
export function chapterRules() {
  const stamp = `${statSync(FILE).mtimeMs}:${overridesMtime()}`;
  if (!cached || cachedStamp !== stamp) {
    const base = JSON.parse(readFileSync(FILE, 'utf8'));
    const rules = loadOverrides().rules || {};
    cached = {
      ...base,
      blueprint: { ...base.blueprint },
    };
    if (typeof rules.upkeepPerSoldier === 'number') cached.upkeepPerSoldier = rules.upkeepPerSoldier;
    if (typeof rules.lendGrain === 'number') cached.lendGrain = rules.lendGrain;
    if (typeof rules.realMsPerDay === 'number') cached.realMsPerDay = rules.realMsPerDay;
    if (typeof rules.blueprintBonus === 'number') cached.blueprint.bonus = rules.blueprintBonus;
    cachedStamp = stamp;
  }
  return cached;
}

function say(state, ctx, text) {
  const cm = {
    rid: 0,
    nickName: '系统',
    type: 0,
    msg: text,
    time: Date.now(),
  };
  state.chat = state.chat || [];
  state.chat.push(cm);
  if (state.chat.length > 200) state.chat.shift();
  ctx.push?.('chat.push', cm);
}

export function sayDrift(state, ctx) {
  const d = state.drift || { score: 0, band: 'canon' };
  const label = (chapterRules().driftBands || []).find((b) => b.id === d.band)?.label || d.band;
  say(state, ctx, `天机 ${d.score}/100 · ${label}。`);
}

function spotFree(state, x, y) {
  if (state.citys?.some((c) => c.x === x && c.y === y)) return false;
  if (state.builds?.some((b) => b.x === x && b.y === y)) return false;
  if (state.garrisons?.some((g) => g.x === x && g.y === y && !g.cleared)) return false;
  return true;
}

function findSpot(cfg, state, dist) {
  const city = mainCity(state);
  if (!city) return null;
  for (let ring = dist; ring <= dist + 3; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = city.x + dx;
        const y = city.y + dy;
        if (x < 0 || y < 0 || x >= cfg.width || y >= cfg.height) continue;
        if (!spotFree(state, x, y)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

function spawnWave(state, cfg, ctx, spec, factor, dist = 2) {
  const at = findSpot(cfg, state, dist);
  if (!at) return null;
  const [type, level] = cfg.tileAt(at.x, at.y);
  const soldiers = Math.max(1, Math.round((spec.soldiers || 800) * (factor || 1)));
  const build = makeBuild(cfg, {
    rid: 2, x: at.x, y: at.y, type: type || 52, level: level || 1,
  });
  build.name = spec.name || '黄巾';
  build.RNick = spec.name || '黄巾';
  build.wood = 0;
  build.iron = 0;
  build.stone = 0;
  build.grain = 0;
  state.builds.push(build);
  const garrison = {
    id: nextId(state, 'garrisonId'),
    x: at.x, y: at.y, soldiers, name: build.name, cleared: false, drifted: false,
  };
  state.garrisons.push(garrison);
  ctx.push?.('roleBuild.push', build);
  say(state, ctx, `${build.name}出现在 (${at.x},${at.y})，兵力 ${soldiers}。`);
  return garrison;
}

function playerLands(state) {
  const rid = state.role?.rid;
  return (state.builds || []).filter((b) => b.rid === rid && b.type >= 52 && b.type <= 55);
}

function removeBuild(state, ctx, build) {
  state.builds = state.builds.filter((b) => b !== build);
  ctx.push?.('roleBuild.push', {
    rid: 0, x: build.x, y: build.y, type: build.type, level: 0,
    curDurable: 0, maxDurable: 0,
  });
}

function dropLowestLand(state, ctx) {
  const lands = playerLands(state).sort((a, b) => (a.level - b.level) || (a.x - b.x) || (a.y - b.y));
  const victim = lands[0];
  if (!victim) return null;
  removeBuild(state, ctx, victim);
  say(state, ctx, `黄巾掠走了 (${victim.x},${victim.y}) 的田。`);
  return victim;
}

function grantSpearman(state, cfg, ctx, rules) {
  const used = new Set((state.generals || []).map((g) => g.cfgId));
  const cfgId = [...cfg.generalByCfg.keys()].find((id) => !used.has(id));
  if (cfgId == null) return null;
  const cityId = mainCity(state)?.cityId ?? 1;
  const id = nextId(state, 'generalId');
  const g = makeGeneral(cfg, id, cfgId, cityId, 8);
  state.generals.push(g);
  state.campaign.spearmanId = id;
  const army = state.armys?.[0];
  if (army) {
    const idx = army.generals.findIndex((gid) => !gid);
    if (idx >= 0) {
      army.generals[idx] = id;
      army.soldiers[idx] = 500;
      ctx.push?.('army.push', army);
    }
  }
  ctx.push?.('general.push', g);
  const who = peopleById('tunzhang') || rules.spearman;
  say(state, ctx, `${who.title}入队。${who.temper}。${who.voice}`);
  return g;
}

function finishChapter(state, cfg, ctx, rules) {
  const lands = playerLands(state);
  const held = lands.length >= (rules.finale.holdLands ?? 3) && !!mainCity(state);
  if (!held) {
    const city = mainCity(state);
    const ranked = [...lands].sort((a, b) => {
      const da = Math.max(Math.abs(a.x - city.x), Math.abs(a.y - city.y));
      const db = Math.max(Math.abs(b.x - city.x), Math.abs(b.y - city.y));
      return db - da;
    });
    for (const b of ranked.slice(0, 2)) removeBuild(state, ctx, b);
    state.campaign.ending = 'lost';
    say(state, ctx, '坞堡失守，最远的田丢了。人还在，曲辕犁的图也留下了。');
  } else {
    state.campaign.ending = 'held';
    say(state, ctx, '坞堡守住了。曲辕犁已作用在磨坊上。');
  }
  // 结局落档：界面据此显示「第一章结束」与「重开一局」
  state.campaign.chapter = state.campaign.chapter || 1;
  state.campaign.endingDay = state.clock?.day ?? null;
  if (!state.campaign.blueprints.includes(rules.blueprint.id)) {
    state.campaign.blueprints.push(rules.blueprint.id);
    addDrift(state, 1, 'blueprint:quyuanli', rules.driftBands);
    sayDrift(state, ctx);
  }
  ctx.push?.('roleRes.push', state.roleRes);
}

function runDay(state, cfg, ctx, day, rules) {
  const key = String(day);
  if (state.campaign.fired[key]) return;
  state.campaign.fired[key] = true;
  if (day === 1) {
    say(state, ctx, lineFor(state.drift?.band, {
      canon: '你落在 184 年春。先让磨坊或伐木场动起来，征一队兵，占相邻的地。天下仍按旧史行走。',
      shift: '你落在 184 年春。黄巾的路子已经偏了，坞堡仍得先活下来。',
      rewrite: '你落在 184 年春。这一年的黄巾，不必再按你读过的那一章走。',
    }));
  }
  if (day === rules.wave1.day) spawnWave(state, cfg, ctx, rules.wave1, 1);
  if (day === rules.raid.day) {
    const live = (state.garrisons || []).some((g) => g.name === rules.wave1.name && !g.cleared);
    if (live) dropLowestLand(state, ctx);
  }
  if (day === rules.choice.day) {
    if (!state.campaign.choice && !state.campaign.waveFactor) {
      // 等玩家点选：只推弹窗，不替他做决定
      state.campaign.pendingDay = day;
      ctx.push?.('campaign.pending', pendingPayload(state, rules));
      say(state, ctx, '乡人来问借粮。等你的答复。');
    }
  }
  if (day === rules.wave2.day) {
    if (!state.campaign.waveFactor) {
      // 到点无人应答：按拒援记入本局
      say(state, ctx, '没有等到答复。乡人把这一笔记成了拒援。');
      applyChoice(state, cfg, ctx, rules, 'refuse');
    }
    const factor = state.campaign.waveFactor || rules.wave2.refuseFactor;
    spawnWave(state, cfg, ctx, rules.wave2, factor);
  }
  if (day === rules.finale.day && !state.campaign.ending) finishChapter(state, cfg, ctx, rules);
}

/** 第 20 日二选一的后果。玩家点选（或到点超时）时执行。 */
export function applyChoice(state, cfg, ctx, rules, choice) {
  if (state.campaign.waveFactor) return { ok: false, reason: 'decided' };
  if (choice !== 'lend' && choice !== 'refuse') return { ok: false, reason: 'bad' };
  state.campaign.choice = choice;
  const who = peopleById('xiangren');
  const story = loadOverrides().story || {};
  if (choice === 'lend') {
    const cost = rules.lendGrain ?? 3000;
    state.roleRes.grain = Math.max(0, (state.roleRes.grain || 0) - cost);
    state.campaign.waveFactor = rules.wave2.lendFactor;
    addDrift(state, rules.lendDrift ?? 2, 'lend-grain', rules.driftBands);
    grantSpearman(state, cfg, ctx, rules);
    say(state, ctx, story.lend || lineFor(state.drift?.band, {
      canon: `${who.voice}借出 ${cost} 粮。下一波会弱一些。`,
      shift: `${who.voice}这点粮会把后面的仗带偏。借出 ${cost}。`,
      rewrite: `${who.voice}旧史里没有这笔账。借出 ${cost}。`,
    }));
  } else {
    state.campaign.waveFactor = rules.wave2.refuseFactor;
    say(state, ctx, story.refuse || lineFor(state.drift?.band, {
      canon: `${who.voice}粮留下了。下一波黄巾会更猛，没有人因此入队。`,
      shift: `${who.line}粮留下了，后面的人会记得。`,
      rewrite: `${who.voice}这条线已经不是旧史。粮留下了。`,
    }));
  }
  sayDrift(state, ctx);
  ctx.push?.('roleRes.push', state.roleRes);
  return { ok: true, choice };
}

/** 招募到宿命链上的名字时，链子往前走一格，并让玩家看见替身接棒。 */
export function noticeRecruit(state, ctx, name) {
  const chain = chainDef();
  if (!chain || name !== chain.heroName) return null;
  const result = transitionFate(state, 'recruit');
  if (!result.ok) return null;
  say(state, ctx, `${name}入营。此后旧史里他的那一站，由 ${chain.standIn}替他走。`);
  return result;
}

export function pendingPayload(state, rules) {  const cost = rules.lendGrain ?? 3000;
  return {
    day: rules.choice.day,
    deadlineDay: rules.wave2.day,
    text: (rules.choicePrompt || '借粮 / 拒援？')
      .replace('%n%', String(cost)),
    lend: { grain: cost, waveFactor: rules.wave2.lendFactor, grantsGeneral: true },
    refuse: { waveFactor: rules.wave2.refuseFactor, grantsGeneral: false },
  };
}

/** 序章结束后的余波：黄巾流寇按周期出现，太久不打就掠田。 */
function runPatrols(state, cfg, ctx, rules) {
  const p = rules.patrol;
  if (!p) return;
  const day = state.clock.day;
  const finaleDay = rules.finale.day;
  state.campaign.lastPatrolDay = state.campaign.lastPatrolDay || finaleDay;
  const active = (state.garrisons || []).filter((g) => g.patrol && !g.cleared);

  for (const g of active) {
    if (!g.raided && day - (g.spawnDay || finaleDay) >= (p.raidAfterDays ?? 9)) {
      g.raided = true;
      if (dropLowestLand(state, ctx)) {
        say(state, ctx, `${g.name}掠走了田，往别处去了。打过这一格可以追回些什么。`);
      }
    }
  }

  const stillActive = (state.garrisons || []).filter((g) => g.patrol && !g.cleared);
  if (day - state.campaign.lastPatrolDay >= (p.intervalDays ?? 6)
      && stillActive.length < (p.maxActive ?? 2)) {
    const garrison = spawnWave(state, cfg, ctx, {
      name: p.name || '黄巾流寇',
      soldiers: (p.baseSoldiers ?? 600) + (day - finaleDay) * (p.growthPerDay ?? 25),
    }, 1, 3);
    if (garrison) {
      garrison.patrol = true;
      garrison.spawnDay = day;
      state.campaign.lastPatrolDay = day;
    }
  }
}

/** 时钟往前走，然后入账，然后触发跨过的那些日。 */
export function settleCampaign(state, cfg, ctx, now = Date.now()) {
  const rules = chapterRules();
  const from = state.clock.day;
  const { days } = advanceClock(state, now, rules);
  if (days > 0) applyDays(state, cfg, days, rules);
  // 结局后连开篇文本都不再补推，fired 完全冻结
  if (!state.campaign.ending && !state.campaign.fired['1']) runDay(state, cfg, ctx, 1, rules);
  // ★ P0-4：章节一经结算就停止按日触发。旧实现每天仍写一次 fired，
  //   存档里 fired 会随天数线性膨胀（实测 40 日章节在 day 276 已有 267 个键）。
  if (!state.campaign.ending) {
    for (let d = from + 1; d <= state.clock.day; d += 1) runDay(state, cfg, ctx, d, rules);
  }
  if (!state.campaign.ending
      && state.clock.day >= rules.choice.day && state.clock.day < rules.wave2.day
      && !state.campaign.choice && !state.campaign.waveFactor
      && state.campaign.pendingDay !== state.clock.day) {
    // 读档后落在窗口内：把弹窗补推一次（每天至多一次）
    state.campaign.pendingDay = state.clock.day;
    ctx.push?.('campaign.pending', pendingPayload(state, rules));
  }
  if (state.campaign.ending) runPatrols(state, cfg, ctx, rules);
  if (days > 0) ctx.push?.('roleRes.push', state.roleRes);
  return { days, day: state.clock.day };
}

export function chooseChapter(state, option) {
  if (state.campaign.ending) return { ok: false, reason: 'ended' };
  if (state.campaign.waveFactor) return { ok: false, reason: 'decided' };
  if (option !== 'lend' && option !== 'refuse') return { ok: false, reason: 'bad' };
  return { ok: true, choice: option };
}

export function onTileCleared(state, cfg, x, y) {
  const g = (state.garrisons || []).find((row) => row.x === x && row.y === y && !row.cleared);
  if (!g) return null;
  g.cleared = true;
  const build = state.builds.find((b) => b.x === x && b.y === y);
  if (build) {
    const [type, level] = cfg.tileAt(x, y);
    const conf = cfg.confs.find((c) => c.type === type && c.level === (level || 1))
      || cfg.confs.find((c) => c.type === type);
    if (conf) {
      build.type = type;
      build.level = level || 1;
      build.name = conf.name || build.name;
      build.wood = conf.wood ?? 0;
      build.iron = conf.iron ?? 0;
      build.stone = conf.stone ?? 0;
      build.grain = conf.grain ?? 0;
    }
  }
  if (!g.drifted) {
    g.drifted = true;
    const bonus = g.patrol
      ? (chapterRules().patrol?.clearDrift ?? 1)
      : (chapterRules().clearDrift ?? 3);
    addDrift(state, bonus, `clear:${g.name}`, chapterRules().driftBands);
  }
  return g;
}

