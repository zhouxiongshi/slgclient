/**
 * ★ M4-12：生效设施单一权威清单（零环依赖叶子）。
 *
 * 背景（玩家 2026-11-15 反馈）：「左上角菜单上的内政和直接用鼠标点击城市的
 * 内政设施不一样，左上角的设施有些设施没用上，属于过度设施」。
 *
 * 取证：原版 facility.json 共 26 项设施，但离线结算（handlers.facilityAdditions）
 * 只消费 6 种 addition 类型——木/铁/粮/石/金产量与府库上限。另外集市(15)
 * 虽不进产量，却是 interior.transform「府库资源兑换」的硬门槛，必须保留。
 * 合计 7 项生效设施；其余 19 项（疾风营、铁壁营、军机营、尚武营、军营、
 * 预备役所、五势力点将台、封禅台、校场、统帅厅、募兵所、社稷坛、城墙、
 * 女墙、主城）加的是带兵上限、行军速度、招募概率、城防耐久等服务端根本
 * 不读的属性：升级只扣资源，不会产生任何游戏效果，正是「过度设施」。
 *
 * 纪律：
 *  - 生效判据不硬编码设施 type，而是查 cfg.facilityAdditions(type) 是否命中
 *    EFFECTIVE_ADDITIONS；配置换了清单自动跟着变，不会漂移。
 *  - EFFECTIVE_ADDITIONS 同时是结算层与展示层的唯一对照表：判据改一处，
 *    两边一起变，杜绝「界面说生效、结算不生效」。
 *  - 原表 conf/json/facility/* 逐字不动（数据溯源红线）；隐藏只在协议出口做。
 *  - 存档 state.facilities 仍保留全量模板，旧档兼容；只是不再暴露给 UI、
 *    不再允许给未生效设施升级。
 */

/** addition 类型 → 结算轴。必须与 handlers.facilityAdditions 的写入轴一致。 */
export const EFFECTIVE_ADDITIONS = Object.freeze({
  17: 'wood',
  18: 'iron',
  19: 'grain',
  20: 'stone',
  21: 'gold',
  23: 'capacity',
});

/** 不进产量结算、但作为玩法硬门槛的设施（升级必须有意义才允许）。 */
export const GATE_FACILITIES = Object.freeze({
  15: '解锁府库资源兑换',
});

export const AXIS_LABEL = Object.freeze({
  wood: '木材产量',
  iron: '铁矿产量',
  grain: '粮草产量',
  stone: '石料产量',
  gold: '金币产量',
  capacity: '府库容量',
});

/** 设施的生效加成轴；未命中结算表返回空数组。 */
export function effectiveAxes(cfg, f) {
  const type = Number(f?.type ?? f);
  if (!Number.isFinite(type) || !cfg?.facilityAdditions) return [];
  const additions = cfg.facilityAdditions(type) || [];
  return additions
    .map((aType) => EFFECTIVE_ADDITIONS[aType])
    .filter(Boolean)
    .filter((axis, i, arr) => arr.indexOf(axis) === i);
}

export function isActiveFacility(cfg, f) {
  const type = Number(f?.type ?? f);
  return effectiveAxes(cfg, f).length > 0 || Object.hasOwn(GATE_FACILITIES, String(type));
}

/** 给 UI 用的一句话效果说明；未生效设施明确写「未参与本版本结算」。 */
export function facilityEffectText(cfg, f) {
  const type = Number(f?.type ?? f);
  const axes = effectiveAxes(cfg, f).map((a) => AXIS_LABEL[a]);
  if (GATE_FACILITIES[String(type)]) axes.push(GATE_FACILITIES[String(type)]);
  return axes.length ? axes.join(' / ') : '未参与本版本结算';
}

/**
 * GM / 开发回退：设环境变量 SLG_LEGACY_FACILITIES=1 可让协议返回原版全量
 * 26 项（每项带 active 标记，UI 会注明未生效），用于对照取证。默认关闭。
 */
export function legacyFacilitiesEnabled() {
  return process.env.SLG_LEGACY_FACILITIES === '1';
}

/**
 * 协议出口统一整形：默认只回生效设施；legacy 模式回全量但逐项标注。
 * 返回 { rows, allCount, hiddenCount, legacy }，两处 UI（本城/城池内页）
 * 与六府内政都从同一份结果取数，杜绝两套清单。
 */
export function facilityView(cfg, list, opts = {}) {
  const legacy = opts.legacy ?? legacyFacilitiesEnabled();
  const all = (list || []).map((f) => {
    const conf = typeof f === 'object' && f !== null ? f : { type: f };
    return { ...conf, active: isActiveFacility(cfg, conf), effectText: facilityEffectText(cfg, conf) };
  });
  const rows = legacy ? all : all.filter((f) => f.active);
  return { rows, allCount: all.length, hiddenCount: all.length - rows.length, legacy };
}
