/**
 * 操作回执总线（P12）—— 把「服务端拒绝了但原版客户端不显示」的事情接住。
 *
 * 背景（2026-11-16 用户报告「武将第二战法无法学习」）：
 *   原版客户端 SkillInfoLogic.onClickLearn 发完 general.upSkill 就把弹窗关掉，
 *   而 GeneralCommand.onUpSkill / onLvSkill / onDownSkill 的响应处理只有一句
 *   console.log —— 服务端拒绝（学习槽未开 / 战法未解锁 / 限 2 人）时玩家
 *   零反馈，表现就是「点了学习没反应」。web/ 逐字节不可改，客户端补不了 UI，
 *   所以由服务端把回执放进这条内存队列，/__slg/session 轮询带给注入外壳，
 *   外壳转成 toast。不写存档、不改协议、不引用任何领域模块（零依赖叶子）。
 *
 * 纪律：只放「玩家自己刚做的操作」的回执，不放世界事件；容量截断防泄漏。
 */

const MAX = 40;
let seqNo = 0;
const queue = [];

/** 记一条玩家可见回执。text 必须是能直接展示的人话。 */
export function notify(text, kind = 'info') {
  const t = String(text || '').trim();
  if (!t) return null;
  seqNo += 1;
  queue.push({ id: seqNo, t: Date.now(), text: t, kind });
  if (queue.length > MAX) queue.splice(0, queue.length - MAX);
  return seqNo;
}

/** 取 id > since 的回执并把游标推进到最新（单客户端游戏，外壳轮询独占消费）。 */
export function drain(since = 0) {
  const from = Math.max(0, Math.trunc(Number(since) || 0));
  const items = queue.filter((n) => n.id > from);
  return { items, last: seqNo };
}

/** 只看不取（测试/诊断用）。 */
export function peek() {
  return { items: [...queue], last: seqNo };
}

/** 当前最大回执号（首轮轮询用来把游标推进到「现在」，不倒历史账）。 */
export function lastId() {
  return seqNo;
}

/** 测试隔离用。 */
export function resetForTest() {
  queue.length = 0;
  seqNo = 0;
}
