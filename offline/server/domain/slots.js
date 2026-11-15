/**
 * 三个客户端能显示的战法格，外加一个不进原界面的天赋格。
 * 0 自带：可升级，不能替换、不能卸下。
 * 1 学习：5 级开启。
 * 2 觉醒：10 级且自带战法 10 级才开启。
 *    武将等级上限就是 10（五维成长按这个封顶），觉醒槽跟着这个上限，不再写成到不了的 20 级。
 * 天赋：默认不开，只由剧情把 talentUnlocked 设为 true。
 *
 * 升级花军工，不花金。费用 = 当前等级的平方 × 20（1 级升 2 级要 20，9 级升 10 级要 1620）。
 * 战法等级不能超过武将等级。
 */

/** 战法最高 10 级。装配、六府、原客户端共用这一条花费。 */
export const SKILL_LEVEL_CAP = 10;

export function skillUpgradeCost(lv) {
  const n = Math.max(1, Math.trunc(Number(lv) || 1));
  return 20 * n * n;
}

export function skillUpgradeBlock(g, skill) {
  if (!skill?.cfgId) return 'empty_slot';
  const lv = Math.max(1, Math.trunc(Number(skill.lv) || 1));
  if (lv >= SKILL_LEVEL_CAP) return 'max_level';
  if (Math.max(1, Math.trunc(Number(g?.level) || 1)) < lv + 1) return 'need_general_level';
  return '';
}

export function skillActionHint(reason, cost = 0, nextLv = 0) {
  const map = {
    invalid_skill: '战法不存在',
    limit_reached: '这条战法同时最多 2 人学会',
    innate_locked: '自带战法不能换成别的，只能在本页升级',
    slot_locked: '这个槽还没开：学习槽要武将 5 级，觉醒槽要 10 级且自带战法 10 级',
    empty_slot: '这个槽还没有战法',
    max_level: '已满 10 级',
    need_general_level: `武将要到 ${nextLv || '下一级'} 级，才能把战法升到这一级。经验来自出征折损`,
    not_enough_jungong: `军工不够，这一级要 ${cost}。内政页用木和铁督造`,
  };
  return map[reason] || reason || '无法操作';
}

export function slotBlock(g, pos, action) {
  if (pos < 0 || pos > 2) return 'slot_locked';
  if (pos === 0 && (action === 'replace' || action === 'remove')) return 'innate_locked';
  if (pos === 1 && (g.level || 1) < 5) return 'slot_locked';
  if (pos === 2) {
    const innateLv = g.skills?.[0]?.lv || 0;
    if ((g.level || 1) < 10 || innateLv < 10) return 'slot_locked';
  }
  return '';
}

export function unlockTalent(g) {
  g.talentUnlocked = true;
  return g;
}
