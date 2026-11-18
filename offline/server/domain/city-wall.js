/**
 * 城防数值口径（2026-11-17）——零依赖叶子模块。
 *
 * 用户反馈：「武将的攻城属性目前没有用处，城防在游戏攻占中没有起到实际意义」。
 *
 * 旧实现只有一处城墙：`wall = knob(siegeWallMul)` 恒 1.5，乘在守军 defence_base 上，
 * 全服每座城同一个值，与「城防」属性无关，也与玩家武将的「攻城」属性无关——
 * destroy 进不了任何公式，城防只是面板上的一个百分数。
 *
 * 现在把城墙做成**有耐久的实体**，本模块只负责「一城有多少城墙」与
 * 「城墙还剩多少 → 守军加成多少」这两条纯公式，供三处共用：
 *   · server/battle.js       —— 战斗内决定守军防御加成、结算破墙伤害；
 *   · server/domain/strategy.js —— 攻城前后读写城池 wallHp、每旬修复；
 *   · server/domain/panels.js   —— 面板把城墙耐久显示给玩家。
 *
 * 依赖纪律：本文件不 import 任何 server / domain 模块（knobGet 是零依赖叶子，
 * 且只用于读取参数表里的城防倍率），保证 panels → 本模块不会成环。
 */
import { knobGet } from './knobs.js';

export const WALL = {
  /** 每座城的基础耐久（与等级/城防无关的那一段） */
  base: 300,
  /** 每级城的城砖：1 级 +450 / 2 级 +900 / 3 级 +1350 */
  perLevel: 450,
  /** 城防属性 0~100 → 0~600 耐久（城防 63 的中位 1 级城约 +378） */
  perDef: 6,
  /** 攻城值 → 破墙伤害系数：destroy 40 带 2000 兵，一波约打掉 400 耐久 */
  siegeK: 6,
  /** 破城当阵的守军额外折损比例（城墙崩塌、守军溃散） */
  breachRout: 0.12,
  /** 每旬自然修复的城墙比例（被围不修）。必须明显低于「一波攻城能打掉的比」，
      否则每旬修 5% 会把 12%~15% 的破墙进度吃掉大半，城墙永远打不穿、城防等于没有。 */
  repairPerTurn: 0.02,
  /** ★ 2026-11-18 经济闭环：修城墙要花石头（每点耐久耗石）。此前修复是凭空 +2%，
      石头作为「城防物资」却进不了最直觉的用途。取 3 石/点：1 级城中位耐久约 1250，
      每旬满修 25 点 = 75 石，与采石场日产同量级，玩家能感知但不至于修不起。 */
  stonePerHp: 3,
};

/** 修复 add 点耐久需要的石头（纯函数，供结算与面板同源）。 */
export function repairCostOf(add) {
  return Math.max(0, Math.round((Number(add) || 0) * WALL.stonePerHp));
}

/** 一城的城墙耐久上限：等级 + 城防属性共同决定（城防越高越耐打）。 */
export function wallMaxOf(target, level) {
  const def = Math.max(0, Math.min(100, Number(target?.attrs?.城防 ?? 50)) || 0);
  const lv = Math.max(1, Math.min(3, Math.trunc(Number(level) || 1)));
  return Math.round(WALL.base + lv * WALL.perLevel + def * WALL.perDef);
}

/** 城墙完好比例（0~1）。没有 wallHp 的旧档/无城墙场景按「完整」处理。 */
export function wallRatioOf(wall) {
  const max = Math.max(1, Number(wall?.max) || 0);
  const hp = Number.isFinite(Number(wall?.hp)) ? Number(wall.hp) : max;
  return Math.max(0, Math.min(1, hp / max));
}

/**
 * 城墙给守军的防御加成倍率：完整 = 参数表 siegeWallMul（旧口径 1.5），破城 = 1.0。
 * 这就是「城防」的实际作用面——城墙被打残，守军立刻变软。
 */
export function wallDefMul(state, wall) {
  const top = Math.max(1, Number(knobGet(state, 'siegeWallMul')) || 1);
  return 1 + (top - 1) * wallRatioOf(wall);
}

/** 面板用：把城墙折算成玩家可读的一组数（百分比 + 是否已破）。 */
export function wallView(wall) {
  if (!wall) return null;
  const max = Math.max(1, Number(wall.max) || 1);
  const hp = Math.max(0, Math.min(max, Number(wall.hp) || 0));
  return { hp, max, pct: Math.round((hp / max) * 100), breached: hp <= 0 };
}
