/**
 * advice.js — 玩家侧「军师建言」（零依赖叶子，不读 NPC 脑）
 *
 * 设计来源：详细设计 §3.3「无事可做检测」与 §5.7「建言卡 schema」。
 * 每旬结算后由上层把四项事实传进来：
 *   有可开发城 / 有可招募武将 / 有可打目标 / 有可处理异常。
 * 四项全否必须产出一条「机会建言」；连续两旬全否由 `idleTurns` 标记，
 * 供发布检查与测试断言，避免「玩家对着空地图发呆」变成无人发现的缺口。
 *
 * 纪律：只读 state.strategy.adviceIdle* 记账，不改任何玩法数值；
 * 不出「必胜/必败」判断，依据只写可追溯的数字与来源。
 */
import { knobGet } from './knobs.js';

export const ADVICE_CHECKS = [
  { key: 'invest', label: '有可开发城' },
  { key: 'recruit', label: '有可招募武将' },
  { key: 'attack', label: '有可打目标' },
  { key: 'anomaly', label: '有可处理异常' },
];

const card = (o) => ({
  id: o.id,
  kind: o.kind || 'opportunity',
  title: o.title,
  action: o.action || null,
  basis: Array.isArray(o.basis) ? o.basis : [],
  confidence: o.confidence || 'mid',
  expires: Number.isFinite(Number(o.expires)) ? Math.max(1, Math.trunc(Number(o.expires))) : 3,
  source: o.source || 'rule:advice',
});

/**
 * @param {object} state 世界存档（只读玩法字段；adviceIdle* 是唯一写入点）
 * @param {object} facts 上层已经算好的四项事实，不在本模块复算玩家可见数值
 */
export function evaluateAdvice(state, facts = {}) {
  const st = state?.strategy || {};
  const checks = {
    invest: !!facts.investReady,
    recruit: !!facts.canRecruit,
    attack: (Number(facts.marchable) || 0) > 0,
    anomaly: (Number(facts.cutCities) || 0) + (Number(facts.lowGrain) || 0)
      + (Number(facts.lowLoyalty) || 0) > 0,
  };
  const idle = ADVICE_CHECKS.every((c) => !checks[c.key]);
  const turn = Math.max(0, Math.trunc(Number(facts.turn) || 0));
  if (idle && Number(st.adviceIdleTurn) !== turn) {
    st.adviceIdleTurn = turn;
    st.adviceIdleTurns = (Number(st.adviceIdleTurns) || 0) + 1;
  } else if (!idle) {
    st.adviceIdleTurns = 0;
  }

  const cards = [];
  if (idle) {
    cards.push(card({
      id: 'advice:idle', kind: 'opportunity', title: '眼下暂无可用机会：先查粮道与内政冷却',
      action: { type: 'inspect', target: 'agenda' },
      basis: ['可开发城 0', '可招武将 0', '可打目标 0', '可处理异常 0'],
      confidence: 'high', expires: 3, source: 'rule:no_action_four_checks',
    }));
  }
  if (checks.anomaly) {
    cards.push(card({
      id: 'advice:anomaly', kind: 'warning', title: '先处理粮道 / 缺粮 / 低忠诚',
      action: { type: 'inspect', target: 'city' },
      basis: [
        `粮道断绝 ${Number(facts.cutCities) || 0} 城`,
        `存粮不足 ${Number(facts.lowGrain) || 0} 城`,
        `低忠诚 ${Number(facts.lowLoyalty) || 0} 人`,
      ],
      confidence: 'high', expires: 2, source: 'rule:anomaly_first',
    }));
  }
  if (checks.attack) {
    cards.push(card({
      id: 'advice:attack', kind: 'opportunity', title: `邻境有 ${Math.trunc(Number(facts.marchable))} 个可打目标`,
      action: { type: 'preview', target: 'war' },
      basis: ['按行军图可达性推算', '未侦察守军为估算，不给必胜结论'],
      confidence: 'mid', expires: 3, source: 'rule:weak_neighbor',
    }));
  }
  const max = Math.max(3, Math.min(7, Math.round(Number(knobGet(state, 'adviceMax')) || 5)));
  return {
    checks, idle, idleTurns: Number(st.adviceIdleTurns) || 0,
    cards: cards.slice(0, max), max,
  };
}
