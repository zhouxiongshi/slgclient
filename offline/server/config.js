/**
 * 静态配置加载 —— 直接复用原工程 slgserver/data/conf/json/ 的原始配置文件，
 * 数值、名称、地形一个都不改。离线包内自带 conf/ 副本，不依赖原仓库路径。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOverrides } from './gm/overrides.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultConfDir() {
  const local = resolve(ROOT, 'conf');
  if (existsSync(resolve(local, 'json', 'basic.json'))) return local;
  // 开发环境兜底：直接读原工程配置
  return resolve(ROOT, '..', 'slgserver', 'data', 'conf');
}

function readJson(base, rel) {
  return JSON.parse(readFileSync(resolve(base, rel), 'utf8'));
}

export function loadConfig(confDir = defaultConfDir()) {
  const dir = resolve(confDir, 'json');
  const basic = readJson(dir, 'basic.json');
  const mapBuild = readJson(dir, 'map_build.json');
  const general = readJson(dir, 'general/general.json');
  const generalBasic = readJson(dir, 'general/general_basic.json');
  const generalArms = readJson(dir, 'general/general_arms.json');
  const npcArmy = readJson(dir, 'npc/npc_army.json');
  const facility = readJson(dir, 'facility/facility.json');

  // 设施等级配置：每个设施一份 facility_*.json（additions/levels[need,values,time]）。
  // 原版 facility.FConf 就是按这套文件驱动的，升级消耗/工期/加成全部来自这里。
  const facilityByType = new Map();
  const fdir = resolve(dir, 'facility');
  for (const name of readdirSync(fdir)) {
    if (!name.endsWith('.json') || name === 'facility.json' || name === 'facility_addition.json') continue;
    try {
      const fc = JSON.parse(readFileSync(resolve(fdir, name), 'utf8'));
      if (typeof fc.type === 'number') facilityByType.set(fc.type, fc);
    } catch { /* 单个配置损坏不阻塞启动 */ }
  }

  // 自定义建筑（要塞等）：建造/升级的消耗与工期
  let buildCustomCfgs = [];
  try {
    buildCustomCfgs = readJson(dir, 'map_build_custom.json').cfg || [];
  } catch { /* 无自定义建筑配置 */ }
  const buildCustomByType = new Map(buildCustomCfgs.map((c) => [c.type, c]));

  const skillOutline = readJson(dir, 'skill/skill_outline.json');

  let mapRes = null;
  try {
    mapRes = readJson(confDir, 'mapRes_0.json');
  } catch { /* 地图数据不可用时退化为默认地形 */ }

  // Go proto.Conf 的 json tag 是 "Wood"（大写 W），客户端 MapProxy 读的也是 Wood。
  // 同时保留小写 wood 以兼容两种读取方式。
  const confs = (mapBuild.cfg || []).map((c) => ({
    type: c.type,
    level: c.level,
    name: c.name,
    Wood: c.wood ?? 0,
    wood: c.wood ?? 0,
    iron: c.iron ?? 0,
    stone: c.stone ?? 0,
    grain: c.grain ?? 0,
    durable: c.durable ?? 0,
    defender: c.defender ?? 0,
  }));

  try {
    const protag = JSON.parse(readFileSync(resolve(confDir, 'campaign', 'protagonist.json'), 'utf8'));
    if (protag.general && !(general.list || []).some((g) => g.cfgId === protag.general.cfgId)) {
      general.list.push(protag.general);
    }
  } catch { /* 没有穿越者模板时仍用原武将表 */ }
  const generalByCfg = new Map((general.list || []).map((g) => [g.cfgId, g]));
  const armsByType = new Map((generalArms.arms || []).map((a) => [a.id, a]));

  const baseTileAt = (x, y) => {
    if (!mapRes) return [55, 1];
    const w = mapRes.w || 200;
    const idx = x + y * w;
    return mapRes.list?.[idx] ?? [0, 0];
  };
  const tileAt = (x, y) => {
    const base = baseTileAt(x, y);
    const hit = loadOverrides().tiles.find((t) => t.x === x && t.y === y);
    if (!hit) return base;
    return [hit.type ?? base[0], hit.level ?? base[1]];
  };

  return {
    confDir,
    basic,
    mapBuild,
    general,
    generalBasic,
    generalArms,
    npcArmy,
    facility,
    skillOutline,
    mapRes,
    confs,
    generalByCfg,
    armsByType,
    tileAt,
    width: mapRes?.w ?? 200,
    height: mapRes?.h ?? 200,
    facilityByType,
    buildCustomByType,
    facilityMaxLevel: (t) => facilityByType.get(t)?.levels?.length ?? 0,
    facilityNeed: (t, lv) => facilityByType.get(t)?.levels?.[lv - 1]?.need ?? null,
    facilityTime: (t, lv) => facilityByType.get(t)?.levels?.[lv - 1]?.time ?? 0,
    facilityValues: (t, lv) => facilityByType.get(t)?.levels?.[lv - 1]?.values ?? [],
    facilityAdditions: (t) => facilityByType.get(t)?.additions ?? [],
    buildCustomCfg: (t, lv) => buildCustomByType.get(t)?.levels?.find((l) => l.level === lv) ?? null,
  };
}
