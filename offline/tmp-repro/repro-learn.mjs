import { loadConfig } from '../server/config.js';
import { createWorld, normalizeWorld } from '../server/world.js';
import { panelState, panelAction } from '../server/domain/panels.js';
import { applyGeneralExp } from '../server/domain/general-progress.js';

const cfg = loadConfig();
const s = normalizeWorld(createWorld(cfg), cfg);
const g = s.generals[0];
console.log('general', g.id, g.cfgId, 'level', g.level, 'skills', JSON.stringify(g.skills));

// 模拟打了两仗升到 5 级
applyGeneralExp(g, 400);
console.log('after exp -> level', g.level, 'exp', g.exp);

// 解锁一条战法
s.skillbook.unlocked['10001'] = { level: 1, source: '战功研习' };

const v = panelState(s, cfg);
const vg = (v.generals || []).find((x) => x.id === g.id);
console.log('view general keys', vg ? Object.keys(vg).slice(0, 20) : 'MISSING');
console.log('view slots', JSON.stringify(vg?.slots));

// 玩家点击「→ 学习槽」
const r = panelAction(s, cfg, { type: 'learn', gId: g.id, pos: 1, cfgId: 10001 });
console.log('learn result', JSON.stringify(r).slice(0, 400));
console.log('state skills after', JSON.stringify(g.skills));
