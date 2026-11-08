/**
 * 宿命链。只回答「这一站该写谁的名字」，不改地图，不算伤害。
 * 序章不招募关羽，链停在「在册」。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAIN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../conf/campaign/fates.json'), 'utf8'));

const NEXT = {
  roster: { recruit: 'standin', die: 'broken' },
  standin: { die: 'broken' },
  broken: {},
};

export function chainDef() {
  return CHAIN;
}

export function ensureFates(state) {
  if (!state.fates) state.fates = {};
  if (!state.fates[CHAIN.id]) state.fates[CHAIN.id] = 'roster';
  return state.fates;
}

export function fateState(state, id = CHAIN.id) {
  return state.fates?.[id] || 'roster';
}

export function transitionFate(state, action, id = CHAIN.id) {
  ensureFates(state);
  const cur = state.fates[id];
  const next = NEXT[cur]?.[action];
  if (!next) return { ok: false, state: cur };
  state.fates[id] = next;
  return { ok: true, state: next };
}

export function actorName(state, id = CHAIN.id) {
  const cur = fateState(state, id);
  if (cur === 'standin') return CHAIN.standIn;
  if (cur === 'broken') return '无名部曲';
  return CHAIN.heroName;
}
