/**
 * 新战斗系统的数据层。
 *
 * 关键设计：原 web-desktop 构建产物【一个字节都不改】。
 * Cocos 3.4 的 resources 技能配置是 5 个独立 cc.JsonAsset 文件，
 * 通过 8088 静态服务按 UUID 请求。这里在运行时拦截这些请求：
 *   - /assets/resources/config.json  → 注入 48 个新战法的路径映射
 *   - /assets/resources/import/xx/<uuid>.json → 返回新战法的 JsonAsset 内容
 *   - 原 4 个占位技能 UUID → 内容整体替换为新战法（旧「突击/百战精兵/重斩/锋矢」不再进入游戏）
 * 因此原 SkillProxy / SkillInfoLogic / WarReportDesItemLogic 一行不改，
 * 但读到的是全新战法表与真实等级数值。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TABLE_PATH = join(ROOT, 'conf', 'skills.json');

/** 原工程 4 个占位技能在 web-desktop 里的 UUID（由 assets/resources/config.json 得到）。 */
export const LEGACY_UUIDS = {
  101: 'a24a465d-363b-4164-b0df-b0279f150721', // 突击
  201: 'ecb09d80-14c5-45bb-b665-0e268b0bbbcd', // 百战精兵
  301: '686fb60f-714d-4b0e-8c7d-f489797dbc5c', // 重斩
  401: 'c80762ed-a4ac-4e5a-b178-2803de36d50a', // 锋矢
};
export const OUTLINE_UUID = 'cbb1460b-b029-4421-8608-0e852a81b4ef';

const TABLE = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
export const SKILLS = TABLE.skills;
export const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.cfgId, s]));
export const SKILL_BY_NAME = new Map(SKILLS.map((s) => [s.name, s]));
export const LEVEL_COUNT = TABLE.levelCount;
export const SKILL_TABLE_VERSION = TABLE.version;
export const SKILL_TABLE_SHA = TABLE.sourceSha256;

export function skillById(cfgId) { return SKILL_BY_ID.get(Number(cfgId)) || null; }
export function skillByName(name) { return SKILL_BY_NAME.get(String(name)) || null; }
export function uiConf(cfgId) { return skillById(cfgId)?.ui ?? null; }

/** 技能等级 → 内核 Effect 的真实数值（不再使用演示随机 pick）。 */
export function kernelSkillAt(cfgId, lv) {
  const s = skillById(cfgId);
  if (!s) return null;
  const level = Math.max(1, Math.min(LEVEL_COUNT, Math.trunc(Number(lv) || 1)));
  const k = s.kernel;
  // ★ 内核直接取 UI 同一份等级数值，保证「界面看到的数值」就是「战斗用的数值」
  const uiLevel = s.ui.levels[level - 1];
  const rate = uiLevel.effect_value[0];
  const growth = rate / Math.max(1, s.ui.levels[0].effect_value[0]);
  return {
    skill_id: k.cfgId,
    name: k.name,
    skill_class: k.skill_class,
    level,
    prepare: k.prepare,
    probability_init: k.probability_init,
    probability_max: k.probability_max,
    main_detail: k.detail_id,
    effects: [{
      detail_id: k.detail_id,
      effect_type: k.effect_type,
      rate_pct: rate,
      target_type: k.target_type,
      attack_type: k.attack_type,
      available_round: 0,
      control_probability: k.control_probability,
      control_state: k.control_state,
      bonus_terms: k.bonus_terms.map((b) => ({
        name: b.name,
        value: b.value * growth,
        op: b.op,
        evidence: 'E2',
      })),
      evidence: 'E0',
    }],
    evidence: 'E0',
  };
}

/** 战报技能字段（c_id / lv / i_e / e_v / e_r）来源于新技能表对应等级。 */
export function reportSkillFields(cfgId, lv) {
  const s = skillById(cfgId);
  if (!s) return null;
  const level = Math.max(1, Math.min(LEVEL_COUNT, Math.trunc(Number(lv) || 1)));
  const l = s.ui.levels[level - 1];
  return {
    cfgId: s.cfgId,
    lv: level,
    i_e: [...s.ui.include_effect],
    e_v: [...l.effect_value],
    e_r: [...l.effect_round],
    name: s.name,
    class: s.kernel.skill_class,
  };
}

/** 稳定 UUID：以 hex 开头，保证 Cocos 的 import/<前两位>/<uuid>.json 路径合法。 */
function uuidFor(cfgId) {
  const h = createHash('sha256').update(`slg-battle-skill-${cfgId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Cocos 3.4 cc.JsonAsset 序列化结构（与构建产物内原文件逐字段一致）。 */
function jsonAsset(name, json) {
  return JSON.stringify([
    1, 0, 0,
    [['cc.JsonAsset', ['_name', 'json'], 1]],
    [[0, 0, 1, 3]],
    [[0, name, json]],
    0, 0, [], [], [],
  ]);
}

/**
 * 构造运行时资源重写器。
 * @param {string} webDir 原 web-desktop 目录（打包后为 resources/app/web）
 */
export function createSkillAssets(webDir) {
  const cfgPath = join(webDir, 'assets', 'resources', 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`找不到 resources/config.json: ${cfgPath}`);
  const original = JSON.parse(readFileSync(cfgPath, 'utf8'));

  const patched = structuredClone(original);
  const importBodies = new Map();     // uuid → JsonAsset 字符串
  const injected = [];
  const outline = JSON.parse(readFileSync(join(ROOT, 'conf', 'json', 'skill', 'skill_outline.json'), 'utf8'));

  // 1) ★ 去掉原系统：从 bundle 路径表移除 4 个占位技能，客户端不再加载它们。
  //    万一浏览器缓存了旧 config 仍来请求，也只返回大纲，绝不返回旧技能数值。
  const legacyOrder = [101, 201, 301, 401];
  for (const oldId of legacyOrder) {
    const uuid = LEGACY_UUIDS[oldId];
    delete patched.paths[uuid];
    importBodies.set(uuid, jsonAsset('skill_outline', outline));
  }

  // 2) 新增全部 48 个战法：路径统一挂在 config/json/skill/ 下（loadDir 会加载）
  for (const s of SKILLS) {
    const uuid = uuidFor(s.cfgId);
    patched.uuids.push(uuid);
    patched.paths[uuid] = [`config/json/skill/${s.dir}/skill_${s.cfgId}`, 'cc.JsonAsset'];
    importBodies.set(uuid, jsonAsset(`skill_${s.cfgId}`, s.ui));
    injected.push({ uuid, cfgId: s.cfgId });
  }

  const configBody = JSON.stringify(patched);
  const byPath = new Map();
  for (const [uuid, body] of importBodies) {
    byPath.set(`/assets/resources/import/${uuid.slice(0, 2)}/${uuid}.json`, body);
  }

  return {
    stats: {
      tableVersion: SKILL_TABLE_VERSION,
      sourceSha256: SKILL_TABLE_SHA,
      skillCount: SKILLS.length,
      levelCount: LEVEL_COUNT,
      injectedAssets: injected.length,
      legacyPathsRemoved: legacyOrder.length,
      legacySkills: ['突击', '百战精兵', '重斩', '锋矢'],
      configOriginalBytes: readFileSync(cfgPath).length,
      configPatchedBytes: configBody.length,
      diskUntouched: true,
    },
    /** @returns {{body:string, contentType:string}|null} */
    intercept(urlPath) {
      if (urlPath === '/assets/resources/config.json') {
        return { body: configBody, contentType: 'application/json; charset=utf-8' };
      }
      const body = byPath.get(urlPath);
      if (body !== undefined) return { body, contentType: 'application/json; charset=utf-8' };
      return null;
    },
    uuidFor,
    injected,
  };
}
