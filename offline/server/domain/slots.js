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
    limit_reached: '这条战法的装配名额已满（上限以战法档案为准）',
    innate_locked: '自带战法不能换成别的，只能在本页升级',
    slot_locked: '这个槽还没开：学习槽要武将 5 级，觉醒槽要 10 级且自带战法 10 级',
    empty_slot: '这个槽还没有战法',
    max_level: '已满 10 级',
    need_general_level: `武将要到 ${nextLv || '下一级'} 级，才能把战法升到这一级。经验来自出征折损`,
    not_enough_jungong: `军工不够，这一级要 ${cost}。内政页用木和铁督造`,
    /* ★ P12：协议层 general.upSkill 与六府装配（panels learn）补齐同一条校验。
       原版客户端的学习列表会列出全部战法配置，不查解锁就放行等于绕过
       战法库研习系统；拒绝理由必须给玩家能行动的下一步。 */
    not_unlocked: '这条战法还没在战法库解锁：打胜仗、守城、斩将攒兵书残卷，去六府「战法库」研习',
  };
  return map[reason] || reason || '无法操作';
}

/**
 * ★ P58：槽位解锁条件唯一口径。
 * 旧实现把「需武将 Lv5 解锁」这种半句话散在 panels.js / panels-ui.js / skills.js 三处，
 * 玩家只看到「空槽位」，看不到自己差几级、差哪一条——这就是「战法看不到解锁条件」。
 * 这里一次算清 need / have / 差额 / 可读文案，UI 只渲染，不再各自拼门槛。
 */
export function slotUnlock(g, pos) {
  const lv = Math.max(1, Math.trunc(Number(g?.level) || 1));
  const innate = g?.skills?.[0] || null;
  const innateLv = Math.max(0, Math.trunc(Number(innate?.lv) || 0));
  const p = Math.trunc(Number(pos));

  if (p === 0) {
    return {
      pos: 0, open: !!innate, replaceable: false, rules: [],
      short: '自带 · 只可升级',
      text: innate ? '自带战法入营即有，只能在本页升级，不能换成别的战法' : '该武将没有自带战法',
    };
  }
  if (p !== 1 && p !== 2) {
    return { pos: p, open: false, replaceable: false, rules: [], short: '无此槽位', text: '没有这个战法槽' };
  }

  const rules = p === 1
    ? [{ key: 'general_level', label: '武将 Lv5', need: 5, have: lv }]
    : [
      { key: 'general_level', label: '武将 Lv10', need: 10, have: lv },
      { key: 'innate_level', label: '自带战法 Lv10', need: 10, have: innateLv },
    ];
  const open = rules.every((r) => r.have >= r.need);
  const short = p === 1 ? '需武将 Lv5' : '需武将 Lv10 且自带战法 Lv10';
  let text;
  if (open) text = '条件已满，可以装配';
  else if (p === 2 && !innate) text = '该武将没有自带战法，觉醒槽开不了';
  else {
    text = rules.filter((r) => r.have < r.need)
      .map((r) => `${r.label}（当前 Lv${r.have}，还差 ${r.need - r.have} 级）`)
      .join('；');
  }
  return { pos: p, open, replaceable: true, rules, short, text };
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
