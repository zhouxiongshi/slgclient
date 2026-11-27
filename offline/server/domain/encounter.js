/**
 * 行军相遇 → 自动开战（P67）。
 *
 * 相遇本身仍由 domain/clash.js 做事实判定（同指一城、抵达日相差 ≤2）；
 * 本模块只解决「相遇的敌兵怎么进这一仗」：
 *   - 城下相遇的诸侯军（援军 / 来犯军）并入本次攻城战的守军；
 *   - 该行军实体立刻标记 consumedByBattle，避免随后又并兵入城造成重复结算；
 *   - 已先一步入城的援军（reliefMerged）由 defenseFor 读城池驻军计算，不再重复加。
 *
 * 于是玩家不需要再点第二下「开战」：抵城那一刻打的就是眼前这支敌军 + 城里守军。
 */

import { CLASH_CITY_WINDOW } from './clash.js';
import { splitTroopsToSlots } from './casualties.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 吃掉与 mm 在目标城下相遇的敌军行军，返回应叠加的守军兵力。
 * 纯写 state.strategy.marches 的标记，不动兵力内核。
 */
export function consumeEncounterDefense(state, mm) {
  const st = state?.strategy || {};
  const targetId = Number(mm?.to);
  const mineId = Number(mm?.id);
  const arriveDay = num(mm?.arriveDay, 1);
  const troops = [0, 0, 0];
  const met = [];
  if (!targetId || !mineId) return { troops, met };
  for (const foe of (st.marches || [])) {
    if (!foe || foe.side === 'player' || foe.resolved || foe.recalled || foe.consumedByBattle) continue;
    if (Number(foe.to) !== targetId || foe.kind === 'transport') continue;
    /* 援军已经并进守军：城池驻军才是它的唯一落点，不能两边都算。 */
    if (foe.kind === 'relief' && foe.reliefMerged) continue;
    if (Math.abs(num(foe.arriveDay, arriveDay) - arriveDay) > CLASH_CITY_WINDOW) continue;
    const total = Math.max(0, Math.round(num(foe.troops)));
    if (total <= 0) continue;
    const slots = splitTroopsToSlots(total);
    for (let i = 0; i < 3; i += 1) troops[i] += slots[i];
    foe.resolved = true;
    foe.consumedByBattle = mineId;
    met.push({
      id: foe.id,
      side: foe.side,
      kind: foe.kind || '',
      name: foe.factionName || '诸侯军',
      troops: total,
    });
  }
  return { troops, met };
}
