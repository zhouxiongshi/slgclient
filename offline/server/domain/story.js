/** 按偏离段选一稿。剧情不自己改分数。 */
export function lineFor(band, drafts) {
  const pack = drafts || {};
  if (band === 'rewrite' && pack.rewrite) return pack.rewrite;
  if (band === 'shift' && pack.shift) return pack.shift;
  return pack.canon || '';
}

export function nodeDraft(band) {
  if (band === 'rewrite') return 'rewrite';
  if (band === 'shift') return 'shift';
  return 'canon';
}
