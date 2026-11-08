/**
 * 武将详情旁的两页：历史传记、本局画像。
 * 传记只用已经写好的短评；没有的人就写明史书未立传，不补一篇。
 * 画像统计只数这一局里已经发生的事。
 */
import { peopleByTitle } from './people.js';
import { fateState, chainDef } from './fate.js';

const FATE_TEXT = {
  roster: '在册，尚未入营',
  standin: '关羽已入营，陆昭走这条路',
  broken: '链已断',
};

function countBattles(state, cfgId) {
  let n = 0;
  for (const report of state.warReports || []) {
    for (const key of ['b_a_general', 'b_d_general']) {
      let rows = [];
      try { rows = JSON.parse(report[key] || '[]'); } catch { rows = []; }
      if (rows.some((row) => Array.isArray(row) && row[1] === cfgId)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

function soldiersOf(state, generalIds) {
  let n = 0;
  const ids = new Set(generalIds);
  for (const army of state.armys || []) {
    (army.generals || []).forEach((gid, i) => {
      if (ids.has(gid)) n += army.soldiers?.[i] || 0;
    });
  }
  return n;
}

export function dossierFor(state, { cfgId, name }) {
  const id = Number(cfgId) || 0;
  const person = peopleByTitle(name);
  const owned = (state.generals || []).filter((g) => g.cfgId === id);
  const chain = chainDef();
  const onChain = name === chain.heroName || name === chain.standIn;
  const deaths = (state.chronicle || []).filter((row) => row.cfgId === id || row.name === name);
  return {
    name,
    cfgId: id,
    official: person?.official || '史书未在本局单独立传。',
    portrait: {
      temper: person?.temper || '',
      desire: person?.desire || '',
      line: person?.line || '',
      voice: person?.voice || '',
      owned: owned.length > 0,
      level: owned.reduce((m, g) => Math.max(m, g.level || 0), 0),
      soldiers: soldiersOf(state, owned.map((g) => g.id)),
      battles: countBattles(state, id),
      deaths: deaths.length,
      lastDeath: deaths.at(-1)?.played || '',
      fate: onChain ? (FATE_TEXT[fateState(state)] || '') : '',
    },
  };
}
