/**
 * 身故履历。只记录已经发生的死法，不算伤害，不改资源。
 * official 是正史短评（虚构人物为「史无此人」）；played 是这一盘的轨迹。
 */
export function recordDeath(state, entry) {
  const list = state.chronicle || (state.chronicle = []);
  const row = {
    generalId: entry.generalId ?? 0,
    cfgId: entry.cfgId ?? 0,
    name: entry.name || '',
    day: state.clock?.day ?? 1,
    band: state.drift?.band ?? 'canon',
    official: entry.official || '史无此人',
    played: entry.played || '',
  };
  list.push(row);
  return row;
}
