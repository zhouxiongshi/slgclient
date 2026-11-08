/**
 * 三个客户端能显示的战法格，外加一个不进原界面的天赋格。
 * 0 自带：可升级，不能替换、不能卸下。
 * 1 学习：5 级开启。
 * 2 觉醒：20 级且自带战法 10 级才开启。
 * 天赋：默认不开，只由剧情把 talentUnlocked 设为 true。
 */

export function emptySlots() {
  return [null, null, null];
}

export function slotBlock(g, pos, action) {
  if (pos < 0 || pos > 2) return 'slot_locked';
  if (pos === 0 && (action === 'replace' || action === 'remove')) return 'innate_locked';
  if (pos === 1 && (g.level || 1) < 5) return 'slot_locked';
  if (pos === 2) {
    const innateLv = g.skills?.[0]?.lv || 0;
    if ((g.level || 1) < 20 || innateLv < 10) return 'slot_locked';
  }
  return '';
}

export function unlockTalent(g) {
  g.talentUnlocked = true;
  return g;
}
