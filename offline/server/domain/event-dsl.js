/**
 * event-dsl.js — 事件条件 DSL（GDD §8.1 / §8.2）
 *
 * 「够用即可，不做通用脚本」：
 *  - 字段白名单：turn / year / season / faction / cityOwned / cityLost /
 *    resource / flag / relation / generalAlive / generalDead / generalInTeam /
 *    battleLost / battleWon（未知字段一律 throw，构建期与运行期同拒）
 *  - 时间字段有两种写法，**都生效**（见 §「边界字段」）：
 *      turnMin/turnMax/yearMin/yearMax  → 裸数字是上下界，单算子对象走算子
 *      turn/year                        → 裸数字是精确相等，单算子对象走算子
 *  - 算子白名单：= != > >= < <= in not_in（值比较走单算子对象 {">=": 500}）
 *  - 禁止：任意 JS 表达式、网络请求、随机数（随机必须走 rngFor 并声明）
 *
 * 零依赖叶子：不知道 state 长什么样，只消费 ctx 查询回调。
 */
export const WHEN_FIELDS = [
  'turnMin', 'turnMax', 'yearMin', 'yearMax', 'turn', 'year', 'season', 'faction',
  'cityOwned', 'cityLost', 'resource', 'flag', 'relation',
  'generalAlive', 'generalDead', 'generalInTeam', 'battleLost', 'battleWon',
];
export const OPS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not_in'];
export const LAYERS = ['史实节点', '条件', '关系'];
export const EFFECT_KINDS = ['flag', 'flag-', 'gold', 'morale', 'loyalty', 'attitude', 'fame', 'nothing'];

/* ------------------------------------------------------------------ */
/* 单算子对象比较：value 形如 {">=": 500}，只允许一个键                  */
/* ------------------------------------------------------------------ */
function cmpValue(opObj, actual) {
  if (!opObj || typeof opObj !== 'object' || Array.isArray(opObj)) {
    throw new Error(`条件值必须是单算子对象，得到 ${JSON.stringify(opObj)}`);
  }
  const keys = Object.keys(opObj);
  if (keys.length !== 1 || !OPS.includes(keys[0])) {
    throw new Error(`算子非法（须为 ${OPS.join('/')} 之一且仅一个）: ${keys.join(',')}`);
  }
  const op = keys[0];
  const want = opObj[keys[0]];
  /* in / not_in 的比较目标是数组，不能走「必须是数字」那道闸；先分出去 */
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(want)) throw new Error(`${op} 的比较目标必须是数组: ${JSON.stringify(want)}`);
    return op === 'in' ? want.includes(actual) : !want.includes(actual);
  }
  if (typeof want !== 'number') throw new Error(`比较目标必须是数字: ${JSON.stringify(want)}`);
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  switch (op) {
    case '=': return actual === want;
    case '!=': return actual !== want;
    case '>': return actual > want;
    case '>=': return actual >= want;
    case '<': return actual < want;
    case '<=': return actual <= want;
    default: throw new Error(`未实现的算子: ${op}`);
  }
}

/* ------------------------------------------------------------------ */
/* 时间/边界字段：裸数字与单算子对象**都生效**                          */
/* ------------------------------------------------------------------ */
/* 历史缺陷（P3-03）：turnMin/yearMin 等只认裸数字，照 GDD §8.2 写成        */
/*   { "turnMin": { ">=": 5 } } 会被静默忽略 —— 条件恒成立、不报错。      */
/* 静默放宽比抛错危险得多（事件会在不该触发的时候全触发），所以这里两种写法  */
/* 都支持，且对象写法里的非法算子照旧 throw。                              */
function boundOk(spec, actual, kind) {
  if (typeof spec === 'number') {
    if (!Number.isFinite(spec)) throw new Error(`边界值必须是有限数字: ${JSON.stringify(spec)}`);
    return kind === 'min' ? actual >= spec : actual <= spec;
  }
  return cmpValue(spec, actual); // 非数字非对象、或多算子对象，在这里 throw
}

function exactOk(spec, actual) {
  if (typeof spec === 'number') {
    if (!Number.isFinite(spec)) throw new Error(`时间值必须是有限数字: ${JSON.stringify(spec)}`);
    return actual === spec;
  }
  return cmpValue(spec, actual);
}

/* ------------------------------------------------------------------ */
/* 条件求值。ctx 接口（全部由调用方适配，本模块只读）：                    */
/*   { turn, year, season, faction,                                     */
/*     cityOwned() -> [id],  cityLost() -> [id],                        */
/*     resource(kind) -> number,       flag(name) -> bool,              */
/*     relation(a,b,type) -> number|null,                              */
/*     generalAlive(name) -> bool,     generalDead -> !alive            */
/*     generalInTeam(name) -> bool,                                    */
/*     battleLostCount(withinTurn) -> n, battleWonCount(withinTurn) -> n } */
/* ------------------------------------------------------------------ */
export function evaluateEvent(when, ctx) {
  if (!when || typeof when !== 'object') throw new Error('when 缺失');
  const unknown = Object.keys(when).filter((k) => !WHEN_FIELDS.includes(k));
  if (unknown.length) throw new Error(`事件条件字段不在白名单: ${unknown.join(',')}（允许 ${WHEN_FIELDS.join(',')}）`);

  if (when.turnMin != null && !boundOk(when.turnMin, ctx.turn, 'min')) return false;
  if (when.turnMax != null && !boundOk(when.turnMax, ctx.turn, 'max')) return false;
  if (when.yearMin != null && !boundOk(when.yearMin, ctx.year, 'min')) return false;
  if (when.yearMax != null && !boundOk(when.yearMax, ctx.year, 'max')) return false;
  /* GDD §8.2 的字段名是 turn / year（精确匹配或单算子） */
  if (when.turn != null && !exactOk(when.turn, ctx.turn)) return false;
  if (when.year != null && !exactOk(when.year, ctx.year)) return false;
  if (when.season != null) {
    const want = Array.isArray(when.season) ? when.season : [when.season];
    if (!want.includes(ctx.season)) return false;
  }
  if (when.faction != null && !when.faction.includes(ctx.faction)) return false;

  if (when.cityOwned != null) {
    const owned = ctx.cityOwned() || [];
    for (const id of when.cityOwned) {
      if (!owned.includes(id)) return false;
    }
  }
  if (when.cityLost != null) {
    const lost = ctx.cityLost() || [];
    for (const id of when.cityLost) {
      if (!lost.includes(id)) return false;
    }
  }
  if (when.resource != null) {
    for (const [kind, opObj] of Object.entries(when.resource)) {
      if (!cmpValue(opObj, ctx.resource(kind))) return false;
    }
  }
  if (when.flag != null) {
    for (const name of when.flag.has || []) {
      if (!ctx.flag(name)) return false;
    }
    for (const name of when.flag.not || []) {
      if (ctx.flag(name)) return false;
    }
  }
  if (when.relation != null) {
    const r = when.relation;
    if (!r.a || !r.b) throw new Error('relation 条件缺 a/b');
    const v = ctx.relation(r.a, r.b, r.type);
    if (v == null) return false;
    if (r.value && !cmpValue(r.value, v)) return false;
  }
  if (when.generalAlive != null) {
    for (const name of when.generalAlive) {
      if (!ctx.generalAlive(name)) return false;
    }
  }
  if (when.generalDead != null) {
    for (const name of when.generalDead) {
      if (ctx.generalAlive(name)) return false; // 还活着 → 不满足
    }
  }
  if (when.generalInTeam != null) {
    for (const name of when.generalInTeam) {
      if (!ctx.generalInTeam(name)) return false;
    }
  }
  if (when.battleLost != null) {
    const b = when.battleLost;
    const n = ctx.battleLostCount(b.withinTurn || 4);
    if (b.count && !cmpValue(b.count, n)) return false;
  }
  if (when.battleWon != null) {
    const b = when.battleWon;
    const n = ctx.battleWonCount(b.withinTurn || 4);
    if (b.count && !cmpValue(b.count, n)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* schema 校验（构建期 + 测试用）。返回错误列表，空数组 = 通过。           */
/* ------------------------------------------------------------------ */
export function validateEventSchema(e, heroNames) {
  const errs = [];
  const bad = (m) => errs.push(`${e.id || '(无id)'}: ${m}`);
  if (!e.id) bad('缺 id');
  else if (!String(e.id).startsWith('evt.')) bad(`id 必须以 evt. 开头: ${e.id}`);
  if (!e.title) bad('缺 title');
  if (!LAYERS.includes(e.layer)) bad(`layer 必须是 ${LAYERS.join('/')}: ${e.layer}`);
  if (!Number.isInteger(e.priority)) bad('缺 priority（整数）');
  if (!e.when || typeof e.when !== 'object') bad('缺 when');
  else {
    const unknown = Object.keys(e.when).filter((k) => !WHEN_FIELDS.includes(k));
    if (unknown.length) bad(`when 字段不在白名单: ${unknown.join(',')}`);
    /* 时间/边界字段：构建期就把「非法写法」拦掉，别等到运行期静默失效 */
    for (const k of ['turnMin', 'turnMax', 'yearMin', 'yearMax', 'turn', 'year']) {
      const v = e.when[k];
      if (v == null) continue;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) bad(`${k} 必须是有限数字`);
        continue;
      }
      if (typeof v !== 'object' || Array.isArray(v)) {
        bad(`${k} 必须是数字或单算子对象，得到 ${JSON.stringify(v)}`);
        continue;
      }
      const ks = Object.keys(v);
      if (ks.length !== 1 || !OPS.includes(ks[0])) bad(`${k} 的算子非法（须为 ${OPS.join('/')} 之一且仅一个）: ${ks.join(',')}`);
    }
  }
  if (!Array.isArray(e.text) || e.text.length === 0) bad('缺 text（至少一段）');
  if (!Array.isArray(e.choices) || e.choices.length === 0) bad('缺 choices');
  else {
    for (const c of e.choices) {
      if (!c.id) bad('choice 缺 id');
      if (!c.label) bad(`choice ${c.id} 缺 label`);
      if (!Array.isArray(c.effects) || c.effects.length === 0) bad(`choice ${c.id} 缺 effects`);
      else {
        for (const fx of c.effects) {
          if (!parseEffect(fx)) bad(`choice ${c.id} 效果词非法: ${fx}（允许 ${EFFECT_KINDS.join('/')}）`);
        }
      }
    }
    const ids = new Set(e.choices.map((c) => c.id));
    if (ids.size !== e.choices.length) bad('choice id 重复');
  }
  if (!e.source?.id) bad('缺 source.id（史实依据）');
  if (!e.source?.confidence) bad('缺 source.confidence');
  // 引用有效性
  const refs = [];
  if (e.when) {
    refs.push(...(e.when.generalAlive || []), ...(e.when.generalDead || []), ...(e.when.generalInTeam || []));
    if (e.when.relation) refs.push(e.when.relation.a, e.when.relation.b);
  }
  if (heroNames && heroNames.size) {
    for (const n of refs) {
      if (!heroNames.has(n)) bad(`引用武将不在 heroes-240: ${n}`);
    }
  }
  if (e.exclusive && !Array.isArray(e.exclusive)) bad('exclusive 必须是数组');
  return errs;
}

/* ------------------------------------------------------------------ */
/* 效果词解析：kind:payload:±n 或 kind:name:±n                          */
/*   flag:wuchao_burned  flag-:wuchao_burned  gold:+500  gold:-300      */
/*   morale:+10  loyalty:许褚:+5  attitude:caocao:-15  fame:+3  nothing */
/* ------------------------------------------------------------------ */
export function parseEffect(fx) {
  if (typeof fx !== 'string') return null;
  if (fx === 'nothing') return { kind: 'nothing' };
  const parts = fx.split(':');
  if (!EFFECT_KINDS.includes(parts[0])) return null;
  const kind = parts[0];
  if (kind === 'flag' || kind === 'flag-') {
    if (parts.length !== 2 || !parts[1]) return null;
    return { kind, name: parts[1] };
  }
  if (kind === 'gold' || kind === 'morale' || kind === 'fame') {
    if (parts.length !== 2) return null;
    const n = Number(parts[1]);
    if (!Number.isFinite(n) || n === 0) return null;
    return { kind, delta: n };
  }
  // loyalty:武将名:±n / attitude:势力id:±n
  if (parts.length !== 3) return null;
  const n = Number(parts[2]);
  if (!Number.isFinite(n) || n === 0) return null;
  return { kind, target: parts[1], delta: n };
}
