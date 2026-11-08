/** 蝴蝶进度。只记 0–100 和段落，不改地图、不写台词。 */

export function bandOf(score, bands) {
  const n = Math.max(0, Math.min(100, score));
  const list = bands || [
    { id: 'canon', max: 29 },
    { id: 'shift', max: 59 },
    { id: 'rewrite', max: 100 },
  ];
  for (const b of list) {
    if (n <= b.max) return b.id;
  }
  return 'rewrite';
}

export function addDrift(state, amount, reason, bands) {
  const drift = state.drift || (state.drift = { score: 0, band: 'canon', log: [] });
  const next = Math.max(0, Math.min(100, (drift.score || 0) + amount));
  drift.score = next;
  drift.band = bandOf(next, bands);
  drift.log.push({ amount, reason, score: next, band: drift.band });
  if (drift.log.length > 100) drift.log.shift();
  return drift;
}
