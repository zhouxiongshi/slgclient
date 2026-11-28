/**
 * ★ P76 武将占身唯一口径：一名武将同一时间只能干一件事。
 *
 * 用户原话：「战法委派研习不允许同一个武将同一时间重复研习多个战法，
 * 有任务在身就不能再干别的事情」。旧实现各模块各判各的：
 * 办差只拦行军、研习不拦任何事、太守任命不看研习——结果一人身兼数职，
 * 研习进度照涨、差事照办，玩家视角就是「任务没有分量」。
 *
 * 本模块只读 state，不依赖任何领域模块（防环）。
 * 写侧（各任务入口的拒绝）与读侧（UI 候选过滤）都必须走这里，禁止另判。
 */

export const BUSY_REASONS = {
  research: '正研习战法',
  task: '正办内政差事',
  governor: '正任太守',
  post: '在六府当值',
  marching: '随军行军',
  transit: '在赴任途中',
};

/**
 * 任务互斥表：研习/办差/太守/六府/行军/在途互斥（双侧都拦）。
 * 注意：只是「挂在驻城队伍编制里」不算占身——那是编制不是任务，
 * 否则办差自动挑人会全军误拦；行军中才真占身（marching）。
 */
export function busyReasonOf(state, gid) {
  const id = Number(gid) || 0;
  if (!id || !state) return '';
  const g = (state.generals || []).find((x) => Number(x.id) === id);
  if (!g) return '';
  if (g.transit) return 'transit';
  for (const a of state.armys || []) {
    if (!(a.generals || []).map(Number).includes(id)) continue;
    if (a.marchId) return 'marching';
    break;   // 驻城编制不占身
  }
  for (const t of state.strategy?.interiorTasks || []) {
    if (t && t.status === 'active' && Number(t.officerId) === id) return 'task';
  }
  for (const gv of Object.values(state.strategy?.governors || {})) {
    if (Number(gv?.officerId) === id) return 'governor';
  }
  for (const p of Object.values(state.interior?.posts || {})) {
    if (Number(p) === id) return 'post';
  }
  for (const row of Object.values(state.skillbook?.assign || {})) {
    if (Number(row?.generalId) === id) return 'research';
  }
  return '';
}

/**
 * 一句话说明为何派不了。generalName 由调用方传入（各模块自己的取名口径），
 * 传入空串则只给原因短语。
 */
export function busyText(reason, generalName = '') {
  const who = generalName ? `「${generalName}」` : '该武将';
  const what = BUSY_REASONS[reason] || '另有要务在身';
  return `${who}${what}，腾不出手`;
}

/**
 * ★ P76 旧档归一：一个武将只保留一份研习委派（保留进度最深那份，进度不丢）。
 * assignResearch 写入前与 researchTick 每旬都要跑——旧档里可能躺着同一人多份。
 * 返回被摘掉的数量（供测试断言）。
 */
export function normalizeResearchAssign(state) {
  const assign = state?.skillbook?.assign;
  if (!assign || typeof assign !== 'object') return 0;
  const kept = new Map();          // generalId -> { key, progress }
  const drop = [];
  for (const [key, row] of Object.entries(assign)) {
    const gid = Number(row?.generalId) || 0;
    if (!gid) continue;
    const prog = Number(state.skillbook.research?.[key]?.progress) || 0;
    const prev = kept.get(gid);
    if (!prev) { kept.set(gid, { key, progress: prog }); continue; }
    if (prog > prev.progress) { drop.push(prev.key); kept.set(gid, { key, progress: prog }); }
    else drop.push(key);
  }
  for (const key of drop) delete assign[key];
  return drop.length;
}
