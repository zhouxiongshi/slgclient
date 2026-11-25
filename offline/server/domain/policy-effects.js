/**
 * 太守方针的真实取舍（P61-S1，零依赖叶子）。
 *
 * 旧六方针只改施工顺序，所有项目最终都会做完——是伪选择。
 * 现在每条方针同时决定「资源分配比例」与「禁止动工的种类」：
 * 产量修正落在 city-econ.cityYield，互斥落在 governor.governorTick，
 * 两处共用本表，界面文案也读同一份说明，杜绝三处口径漂移。
 */
export const POLICY_EFFECTS = {
  auto: {
    yields: {}, forbid: [],
    note: '不偏不倚：不增产也不减产，各种工程都可办。',
  },
  agri: {
    yields: { grain: 1.25, gold: 0.85 }, forbid: ['barracks'],
    note: '粮产 +25%，金产 −15%；募兵整编停工。',
  },
  trade: {
    yields: { gold: 1.25, grain: 0.85 }, forbid: ['barracks', 'defense'],
    note: '金产 +25%，粮产 −15%；募兵与城防停工。',
  },
  military: {
    yields: { grain: 0.8, gold: 0.9 }, forbid: ['agri', 'trade'],
    note: '粮产 −20%、金产 −10%；农田与市集停工，全力募兵。',
  },
  defense: {
    yields: { gold: 0.5, stone: 1.25 }, forbid: ['trade'],
    note: '商税减半、石产 +25%；市集停工，全力修城。',
  },
  civil: {
    yields: { gold: 0.9 }, forbid: ['defense'],
    note: '金产 −10%；城防停工，先养民生。',
  },
};

export function policyEffect(policy) {
  return POLICY_EFFECTS[String(policy || '')] || POLICY_EFFECTS.auto;
}
