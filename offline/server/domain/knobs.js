/**
 * 全局参数表（GDD §9.2「30 个可调 knob」）。
 *
 * 用法三条（写死）：
 *  1. 所有数值必须从这张表读，禁止散落魔法数字——旧代码在改到时切换，新代码一律走 `knobGet`。
 *  2. 覆盖顺序：`state.knobs[名]`（存档内，GM/难度写这里）> 表内默认值；写入必须过区间校验，
 *     越界钳到 min/max（不报错，让坏档也能跑）。
 *  3. 读参一律 `knobGet(state, 名)`，不直接读 KNOBS——保证存档覆盖生效且测试可注入。
 *
 * 零依赖叶子：不 import 任何 domain 模块（strategy/city-econ 都会引它，不能反向）。
 */

/** 30 个 knob：value 默认 / min~max 允许区间 / note 影响。与 GDD §9.2 表逐行对应。 */
export const KNOBS = {
  turnDays: { value: 10, min: 7, max: 15, note: '全局节奏（改它等于重做平衡）' },
  grainPerSoldierDay: { value: 0.1, min: 0.08, max: 0.15, note: '粮耗（每兵每日）' },
  conscriptRate: { value: 0.06, min: 0.04, max: 0.08, note: '兵源上限（人口占比）' },
  conscriptGoldPer: { value: 2, min: 1, max: 4, note: '征兵成本（金/兵）' },
  upkeepPerSoldier: { value: 0.02, min: 0.01, max: 0.04, note: '月俸禄（每兵）' },
  popGrowthYear: { value: 0.015, min: 0.01, max: 0.03, note: '人口年增长' },
  devMax: { value: 100, min: 60, max: 120, note: '开发度上限' },
  postBonusMax: { value: 30, min: 20, max: 40, note: '官员加成上限（%）' },
  policyBonusMax: { value: 25, min: 15, max: 35, note: '政策加成上限（%）' },
  adjBonusMax: { value: 15, min: 8, max: 25, note: '相邻加成上限（%）' },
  supplyLossPer100: { value: 2, min: 1, max: 4, note: '调运损耗（%/百里）' },
  interceptPerEdge: { value: 8, min: 5, max: 12, note: '被截概率（%/敌方边）' },
  moraleRout: { value: 20, min: 15, max: 30, note: '溃败阈值' },
  roundMax: { value: 8, min: 6, max: 12, note: '战斗回合上限' },
  pursuitRate: { value: 30, min: 20, max: 40, note: '追击损失（%）' },
  battleJitter: { value: 0.02, min: 0, max: 0.05, note: '战斗抖动（必须与种子绑定）' },
  recruitBase: { value: 30, min: 20, max: 45, note: '登庸基础率（%）' },
  loyaltyWarn: { value: 30, min: 20, max: 40, note: '叛逃预警线' },
  fateGroups: { value: 24, min: 24, max: 24, note: '宿命组数（固定）' },
  eventPerTurnMax: { value: 2, min: 1, max: 3, note: '每回合事件上限' },
  adviceMax: { value: 5, min: 3, max: 7, note: '建言条数' },
  undoDepth: { value: 5, min: 3, max: 10, note: '撤销深度' },
  previewCost: { value: 0, min: 0, max: 0, note: '预演消耗（不可调，写死）' },
  difficultyAi: { value: 1.0, min: 0.8, max: 1.4, note: 'AI 强度倍率' },
  difficultyRes: { value: 1.0, min: 0.8, max: 1.3, note: '玩家资源倍率' },
  difficultyDiplo: { value: 1.0, min: 0.8, max: 1.3, note: '外交压力倍率' },
  siegeWallMul: { value: 1.5, min: 1.2, max: 2.0, note: '守城城防倍率' },
  fireDamageMul: { value: 1.5, min: 1.3, max: 2.0, note: '火攻倍率' },
  crossRiverWinterCost: { value: 1.3, min: 1.1, max: 1.6, note: '冬季渡河粮耗' },
  saveVersion: { value: 2, min: 2, max: 2, note: '存档版本（v2 = 粮并入城库）' },
};

/** 读参：存档覆盖 > 默认值，越界钳到允许区间。未知名返回 undefined（宁可显式失败）。 */
export function knobGet(state, name) {
  const K = KNOBS[name];
  if (!K) return undefined;
  const raw = Number(state?.knobs?.[name]);
  const v = Number.isFinite(raw) ? raw : K.value;
  return Math.max(K.min, Math.min(K.max, v));
}

/** 写参（GM/难度切换用）：越界钳回区间并回写存档。返回实际生效值。 */
export function knobSet(state, name, value) {
  const K = KNOBS[name];
  if (!K) return { ok: false, reason: 'no_knob' };
  if (!state.knobs) state.knobs = {};
  const v = Math.max(K.min, Math.min(K.max, Number(value)));
  if (!Number.isFinite(v)) return { ok: false, reason: 'bad_value' };
  state.knobs[name] = v;
  return { ok: true, name, value: v };
}

/** 快照（调试/平衡脚本用）：全部 knob 的当前生效值。 */
export function knobSnapshot(state) {
  const out = {};
  for (const name of Object.keys(KNOBS)) out[name] = knobGet(state, name);
  return out;
}
