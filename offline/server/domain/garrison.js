/**
 * 城池守将确定性分配（M4-13）—— 零依赖叶子，不 import strategy / battle。
 *
 * 修复的问题：conf/json/npc/npc_army.json 全表只有 100002~100006 六个 cfgId，
 * 8 个等级里 7 个的 army[0] 都是 [100002, 100003, 100004]，而 defenseFor() /
 * makeDefenders() 又写死取 army[0]、level 被夹到 1~3 —— 于是 1 级城永远只有
 * 「十常士(100002)」一个守将，玩家连打几座城看到的都是同一批人。
 *
 * 现在改成：城池 id + 势力 + 等级 → 确定性哈希 → 从全表武将池取 1~3 人。
 *   · 同一座城反复攻打，守将恒定（推演与正式结算必须一致）；
 *   · 不同城池起点不同、步长取质数，名单几乎不重叠；
 *   · 势力 startGenerals 里的人排到池前段，守军有地域感；
 *   · 排除玩家已拥有 / 已在押 / 主角 / 代将，避免「抓到自己人」。
 * npc_army.json 降级为兵力与等级配置，不再提供 cfgIds。
 */

/** FNV-1a 32 位，纯函数，不引入任何随机源。 */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 势力优先 + 全表兜底的确定性武将池。 */
export function garrisonPool(cfg, { preferNames = [], exclude = [] } = {}) {
  const skip = new Set([880001, ...exclude.map(Number)].filter((n) => Number.isFinite(n)));
  const map = cfg?.generalByCfg;
  const all = typeof map?.values === 'function' ? [...map.values()] : [];
  /* ★ M4-13 冒烟回归（真因）：原版战报 UI 按 cfgId 查的是打包在 web/ 里的原版
     general.json，只有 100001~100593。heroes-240 追加的 240xxx+ 只存在于服务端
     generalByCfg，注入 UI 显示得了，但 WarReportItemLogic.setTeams →
     GeneralItemLogic.updateView 会拿到 null 并抛 "reading 'name'"，战报列表和
     详情双双打不开。守将/俘虏会回填进原版战报，因此必须按客户端可见集准入。
     clientGeneralIds 由 config.js 在并入追加武将**之前**取快照；轻量测试桩没带
     这个集合时，退化成「非追加条目」启发式，仍不会把 240xxx 放进守军。 */
  const visible = cfg?.clientGeneralIds;
  const clientVisible = (g, id) => {
    if (visible instanceof Set && visible.size) return visible.has(id);
    return id < 200000 && !g.heroMeta;
  };
  const prefer = new Set(preferNames.map(String));
  return all
    .filter((g) => {
      const id = Number(g.cfgId);
      const nm = String(g.name || '');
      return Number.isFinite(id) && id >= 100002 && !skip.has(id)
        && clientVisible(g, id)
        && nm && !/^武将\d+|^代将/.test(nm);
    })
    .map((g) => ({ g, front: prefer.has(String(g.name)) ? 0 : 1 }))
    .sort((a, b) => a.front - b.front || Number(a.g.cfgId) - Number(b.g.cfgId))
    .map((x) => x.g);
}

/**
 * 取该城守将 cfgId 列表。
 * @returns {number[]} 长度 1~3，确定性、同城恒定、跨城不重复
 */
export function garrisonCfgIds(cfg, {
  cityId = 0, owner = 'han', level = 1, exclude = [], preferNames = [],
} = {}) {
  const count = Math.max(1, Math.min(3, level >= 3 ? 3 : (level === 2 ? 2 : 1)));
  const pool = garrisonPool(cfg, { preferNames, exclude });
  /* 极端兜底：配置缺失时仍返回可用名单，不让战斗崩掉。 */
  if (!pool.length) return [100002, 100003, 100004].slice(0, count);
  /* 有势力名将时只在该势力班底里抽，不足再补低阶常备。
     旧逻辑把名将排到池首，哈希起点却落在全表 500 人里，孙权的城会守出于禁。 */
  const prefer = new Set((preferNames || []).map(String));
  const named = pool.filter((g) => prefer.has(String(g.name)));
  let source = pool;
  if (named.length) {
    const generics = pool.filter((g) => {
      const id = Number(g.cfgId);
      return id >= 100002 && id <= 100030 && !prefer.has(String(g.name));
    });
    source = named.concat(generics);
    if (source.length < count) {
      source = named.concat(pool.filter((g) => !named.some((n) => Number(n.cfgId) === Number(g.cfgId))));
    }
  }
  const start = hash32(`${Number(cityId) || 0}:${owner}:${Number(level) || 1}`) % source.length;
  const stride = 37;                     // 质数步长，同城三将不相邻、跨城起点分散
  const used = new Set();
  const out = [];
  for (let k = 0; k < count && out.length < pool.length; k += 1) {
    let idx = (start + k * stride) % source.length;
    for (let guard = 0; guard < source.length; guard += 1) {
      const id = Number(source[idx].cfgId);
      if (!used.has(id)) { used.add(id); out.push(id); break; }
      idx = (idx + 1) % source.length;
    }
  }
  return out;
}

/** 守将显示名（战报 / 遭遇页用），取不到就回落为势力名。 */
export function garrisonLabel(cfg, ids, fallback = '守军') {
  const names = (ids || [])
    .map((id) => cfg?.generalByCfg?.get(Number(id))?.name)
    .filter(Boolean);
  if (!names.length) return fallback;
  return names.length <= 2 ? names.join('、') : `${names[0]}等 ${names.length} 将`;
}
