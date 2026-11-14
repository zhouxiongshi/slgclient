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

const TABLE = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
const AUTHORED = join(ROOT, 'conf', 'campaign', 'protagonist-skill.json');
if (existsSync(AUTHORED)) {
  const extra = JSON.parse(readFileSync(AUTHORED, 'utf8'));
  if (!TABLE.skills.some((s) => s.cfgId === extra.cfgId)) TABLE.skills.push(extra);
}
const LIBRARY = join(ROOT, 'conf', 'library-skills.json');
if (existsSync(LIBRARY)) {
  const extra = JSON.parse(readFileSync(LIBRARY, 'utf8'));
  for (const s of extra.skills || []) {
    if (!TABLE.skills.some((x) => x.cfgId === s.cfgId || x.name === s.name)) TABLE.skills.push(s);
  }
}
/* ★ M3-8 战法补量（GDD §9）：29 条新机制组合（内核生效面逐条核对，见 generator 头注） */
const LIBRARY_EXTRA = join(ROOT, 'conf', 'library-skills-extra.json');
if (existsSync(LIBRARY_EXTRA)) {
  const more = JSON.parse(readFileSync(LIBRARY_EXTRA, 'utf8'));
  for (const s of more.skills || []) {
    if (!TABLE.skills.some((x) => x.cfgId === s.cfgId || x.name === s.name)) TABLE.skills.push(s);
  }
}
export const SKILLS = TABLE.skills;
export const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.cfgId, s]));
export const LEVEL_COUNT = TABLE.levelCount;
export const SKILL_TABLE_VERSION = TABLE.version;
export const SKILL_TABLE_SHA = TABLE.sourceSha256;

export function skillById(cfgId) { return SKILL_BY_ID.get(Number(cfgId)) || null; }

/**
 * ★ P7 战法射程（三战口径）：战场 3 槽 = 前锋/中军/大营，
 *   攻击方 pos p 到敌方 pos q 的距离 = p + q + 1（1~5）。
 *   - 追击：目标 = 普攻目标，不受射程限制 → range 9，描述写「目标：普攻目标」
 *   - 其余：先查 conf/skills-range.json 的逐战法覆盖，再按「效果类型 × 单体/群体」推导
 * 修改只发生在内存表（conf/skills.json 不动），UI JsonAsset 与 kernel 同源，保证描述=计算。
 */
const RANGE_CONF_PATH = join(ROOT, 'conf', 'skills-range.json');
const RANGE_CONF = (() => {
  try { return JSON.parse(readFileSync(RANGE_CONF_PATH, 'utf8')); } catch { return {}; }
})();
const RANGE_OVERRIDE = new Map(
  Object.entries(RANGE_CONF.ranges || {}).map(([k, v]) => [Number(k), Number(v) || 9]),
);

/** 群体目标类型（t7/t8/t9）；单体（t6）。我方目标一律视作无距离。 */
function isGroupTarget(tt) { return ['7', '8', '9'].includes(tt); }

export function rangeOf(skill) {
  if (!skill) return 9;
  const ov = RANGE_OVERRIDE.get(Number(skill.cfgId));
  if (ov) return ov;
  if (skill.trigger === 3) return 9;                       // 追击：随普攻目标
  const k = skill.kernel || {};
  const effects = Array.isArray(k.effects) && k.effects.length
    ? k.effects
    : [k];
  const types = effects.map((e) => e.effect_type || '');
  const tt = String(skill.ui?.target ?? skill.ui?.target_type ?? 0);
  const pick = (...order) => {
    const table = RANGE_CONF.derive || {};
    const group = isGroupTarget(tt);
    for (const t of order) {
      const row = table[t];
      if (row) return Number(group ? row.group : row.single) || 9;
    }
    return 9;
  };
  if (types.includes('CONTROL')) return pick('CONTROL', 'PHYSICAL_DAMAGE');
  if (types.includes('STRATEGY_DAMAGE')) return pick('STRATEGY_DAMAGE');
  if (types.includes('PHYSICAL_DAMAGE')) return pick('PHYSICAL_DAMAGE');
  if (types.includes('HEAL')) return 9;
  return pick('BUFF') || 9;                                 // 治疗/增益/自身
}

/**
 * ★ P7 普攻攻击距离：武将 attack_distance 优先，缺省按兵种（盾3 / 弓4 / 骑3）。
 *   距离不足时该武将本回合普攻打不到人——只有战法能越过，这就是配将/站位的意义。
 */
export function attackDistanceOf(general, arms) {
  const own = Number(general?.attack_distance) || 0;
  if (own > 0) return Math.max(1, Math.min(5, own));
  const a = Number(arms ?? general?.curArms) || 1;
  const byArms = RANGE_CONF.attackDistance?.byArms || {};
  const v = Number(byArms[String(a)]);
  if (v > 0) return Math.max(1, Math.min(5, v));
  return Math.max(1, Math.min(5, Number(RANGE_CONF.attackDistance?.default) || 3));
}

const RANGE_NOTE = { 3: '射程3', 4: '射程4', 5: '射程5' };
/** 战法目标人数（描述用）：单体 1、群体 2~3、我方全体 = 无人数信息。 */
function targetNote(skill) {
  const tt = String(skill.ui?.target ?? skill.ui?.target_type ?? 0);
  if (tt === '6') return '单体';
  if (tt === '7' || tt === '8') return '2 人';
  if (tt === '9') return '3 人';
  return '';
}
/**
 * 把射程写进单条战法的 ui（幂等）。skills.js 自身表在模块加载时全部过一遍；
 * panels.js 的独立技能表（mainSkills+libSkills 原始 JSON）也用同一函数补齐，
 * 保证「原客户端技能面板 / 六府战法摘要 / 内核」三处描述与计算同源。
 * ★ P7：描述从「（射程3）」升级为「（有效距离 3 · 3 人）」，玩家能据此决策。
 */
export function applyRangeNote(skill) {
  if (!skill?.ui) return skill;
  const r = rangeOf(skill);
  skill.ui = { ...skill.ui, range: r };
  if (skill.trigger === 3) {
    if (!/普攻目标/.test(skill.ui.des || '')) skill.ui.des = `${skill.ui.des || ''}（目标：普攻目标）`;
    return skill;
  }
  if (r >= 9) return skill;               // 我方/治疗/增益：不写射程，避免噪音
  if (/射程|有效距离/.test(skill.ui.des || '')) return skill;
  const n = targetNote(skill);
  const body = RANGE_NOTE[r] ? `有效距离 ${r}` : `有效距离 ${r}`;
  skill.ui.des = `${skill.ui.des || ''}（${body}${n ? ` · ${n}` : ''}）`;
  return skill;
}
// 一次性把射程写进 UI 描述与 ui.range 字段：原客户端技能面板、六府战法摘要、内核三处同源
for (const s of SKILLS) applyRangeNote(s);

/** 技能等级 → 内核 Effect 的真实数值（不再使用演示随机 pick）。 */
export function kernelSkillAt(cfgId, lv) {
  const s = skillById(cfgId);
  if (!s) return null;
  const level = Math.max(1, Math.min(LEVEL_COUNT, Math.trunc(Number(lv) || 1)));
  const k = s.kernel;
  // ★ 内核直接取 UI 同一份等级数值，保证「界面看到的数值」就是「战斗用的数值」
  const uiLevel = s.ui.levels[level - 1];
  if (Array.isArray(k.effects)) {
    const base = s.ui.levels[0].effect_value;
    return {
      skill_id: k.cfgId,
      name: k.name,
      skill_class: k.skill_class,
      level,
      prepare: k.prepare,
      probability_init: k.probability_init,
      probability_max: k.probability_max,
      main_detail: k.detail_id,
      effects: k.effects.map((e, i) => {
        const now = uiLevel.effect_value[i] ?? 0;
        const growth = base[i] ? now / base[i] : 1;
        const rated = e.effect_type === 'PHYSICAL_DAMAGE' || e.effect_type === 'STRATEGY_DAMAGE' || e.effect_type === 'HEAL';
        return {
          detail_id: e.detail_id,
          effect_type: e.effect_type,
          rate_pct: rated ? now : (e.rate_pct || 0),
          target_type: e.target_type,
          attack_type: e.attack_type || 'normal',
          available_round: e.available_round || 0,
          range: rangeOf(s),
          control_probability: e.effect_type === 'CONTROL' ? now / 100 : (e.control_probability || 0),
          control_state: e.control_state || null,
          bonus_terms: (e.bonus_terms || []).map((b) => ({
            name: b.name,
            value: (b.value || 0) * growth,
            op: b.op ?? 0,
            evidence: 'E2',
          })),
          evidence: 'E2',
        };
      }),
      evidence: 'E2',
    };
  }
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
      range: rangeOf(s),
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
 * 只改内存里的客户端脚本，磁盘上的 index.js 不动。
 * 图鉴点一张卡就打开原有详情（属性 + 技能）；技能列表按触发类型排好并标上类型。
 */
export function patchClientBundle(source) {
  const pieces = [
    [
      `              cfg.camp = cfgData[_i].camp;

              this._generalConfigs.set(cfg.cfgId, cfg);`,
      `              cfg.camp = cfgData[_i].camp;
              cfg.skillCfgId = cfgData[_i].skillCfgId || 0;

              this._generalConfigs.set(cfg.cfgId, cfg);`,
    ],
    [
      `              if (skillConf && skill) {
                icon.getComponent(SkillIconLogic).setData(skill, gSkill);
                iconNameLab.string = skillConf.name;`,
      `              if (skillConf) {
                icon.getComponent(SkillIconLogic).setData(skill || { cfgId: gSkill.cfgId, generals: [] }, gSkill);
                iconNameLab.string = skillConf.name;`,
    ],
    [
      `            window.__slgBack = function () {
              return _this2.closeTopPanel();
            };`,
      `            window.__slgBack = function () {
              return _this2.closeTopPanel();
            };
            window.__slgOpenRoster = function (cfg) {
              if (!cfg) return;
              var sid = cfg.skillCfgId || 0;
              _this2.openGeneralDes(cfg, {
                id: 0, cfgId: cfg.cfgId, level: 1, exp: 0,
                physical_power: cfg.physical_power_limit || 100,
                force_added: 0, strategy_added: 0, defense_added: 0, speed_added: 0, destroy_added: 0,
                skills: [sid ? { id: sid, cfgId: sid, lv: 1 } : null, null, null],
                config: cfg
              });
            };`,
    ],
    [
      `        _proto.onItemClick = function onItemClick(event) {
          var index = event.target.itemIdx;
          this.setIndex(index);
          this.itemClickEvents.forEach(function (handler) {
            handler.emit([this._datas[index], index, event.target]);
          }.bind(this));
        }`,
      `        _proto.onItemClick = function onItemClick(event) {
          var node = event.target && event.target.itemIdx != null ? event.target : (event.currentTarget || event.target);
          var index = node.itemIdx;
          if (index == null) return;
          this.setIndex(index);
          this.itemClickEvents.forEach(function (handler) {
            handler.emit([this._datas[index], index, node]);
          }.bind(this));
          var roster = node.getComponent && node.getComponent("GeneralRosterLogic");
          if (roster && roster._cfg && typeof window.__slgOpenRoster === "function") window.__slgOpenRoster(roster._cfg);
        }`,
    ],
    [
      `          var comp = this.scrollView.node.getComponent(ListLogic);
          comp.setData(arr);
        };

        _proto.onClickClose = function onClickClose() {
          this.node.active = false;
          AudioManager.instance.playClick();
        };

        _proto.onClickItem = function onClickItem(data, target) {`,
      `          this._allSkills = arr;
          this._applySkillTab();
        };

        _proto.onClickClose = function onClickClose() {
          this.node.active = false;
          AudioManager.instance.playClick();
        };

        _proto.onClickItem = function onClickItem(data, target) {`,
    ],
    [
      `  var _applyDecoratedDescriptor, _inheritsLoose, _initializerDefineProperty, _assertThisInitialized, _defineProperty, cclegacy, _decorator, ScrollView, Component, EventMgr, LogicEvent, AudioManager, Skill, SkillCommand, ListLogic;`,
      `  var _applyDecoratedDescriptor, _inheritsLoose, _initializerDefineProperty, _assertThisInitialized, _defineProperty, cclegacy, _decorator, ScrollView, Component, Node, Label, Color, UITransform, Graphics, Mask, EventMgr, LogicEvent, AudioManager, Skill, SkillCommand, ListLogic;`,
    ],
    [
      `      ScrollView = module.ScrollView;
      Component = module.Component;
    }, function (module) {
      EventMgr = module.EventMgr;
    }, function (module) {
      LogicEvent = module.LogicEvent;
    }, function (module) {
      AudioManager = module.AudioManager;
    }, function (module) {
      Skill = module.Skill;`,
      `      ScrollView = module.ScrollView;
      Component = module.Component;
      Node = module.Node;
      Label = module.Label;
      Color = module.Color;
      UITransform = module.UITransform;
      Graphics = module.Graphics;
      Mask = module.Mask;
    }, function (module) {
      EventMgr = module.EventMgr;
    }, function (module) {
      LogicEvent = module.LogicEvent;
    }, function (module) {
      AudioManager = module.AudioManager;
    }, function (module) {
      Skill = module.Skill;`,
    ],
    [
      `        _proto.onEnable = function onEnable() {
          EventMgr.on(LogicEvent.skillListInfo, this.onSkillList, this);
          SkillCommand.getInstance().qrySkillList();
        };`,
      `        if (!window.__slgMountTabs) {
          window.__slgMountTabs = function (owner, scroll, titles, onPick) {
            if (owner._slgTabBar || !scroll || !scroll.node) return;
            var view = scroll.view && scroll.view.node ? scroll.view.node : scroll.view;
            if (!view || typeof view.getComponent !== "function") view = null;
            if (!view) {
              var kids = scroll.node.children;
              for (var i = 0; i < kids.length; i++) {
                if (kids[i].getComponent && kids[i].getComponent(Mask)) { view = kids[i]; break; }
              }
            }
            if (!view) view = scroll.node;
            var ui = view.getComponent(UITransform);
            if (!ui || !view.position) return;
            var mask = view.getComponent(Mask);
            if (!mask) {
              mask = view.addComponent(Mask);
              if (mask.type !== undefined) mask.type = 0;
            }
            mask.enabled = true;
            var tabH = 44;
            var bottom = view.position.y - ui.height * ui.anchorY;
            var oldH = ui.height;
            var oldW = ui.width;
            ui.setContentSize(oldW, Math.max(80, oldH - tabH));
            view.setPosition(view.position.x, bottom + ui.height * ui.anchorY, view.position.z);
            var parent = view.parent;
            var bar = new Node("slgTabs");
            bar.layer = parent.layer;
            bar.parent = parent;
            var top = bottom + oldH;
            bar.setPosition(view.position.x, top - tabH / 2, 0);
            bar.setSiblingIndex(parent.children.length - 1);
            var barW = Math.max(120, oldW - 16);
            bar.addComponent(UITransform).setContentSize(barW, 34);
            var bg = new Node("bg");
            bg.layer = bar.layer;
            bg.parent = bar;
            var bgG = bg.addComponent(Graphics);
            bgG.fillColor = new Color(18, 20, 24, 242);
            bgG.strokeColor = new Color(186, 154, 82, 230);
            bgG.lineWidth = 1.5;
            bgG.roundRect(-barW / 2, -17, barW, 34, 8);
            bgG.fill();
            bgG.stroke();
            owner._slgTabBar = bar;
            owner._slgDraw = [];
            owner._slgLabs = [];
            var gap = barW / titles.length;
            titles.forEach(function (title, idx) {
              var n = new Node("t" + idx);
              n.layer = bar.layer;
              n.parent = bar;
              var pw = gap - 8;
              n.setPosition(-barW / 2 + gap * (idx + 0.5), 0, 0);
              n.addComponent(UITransform).setContentSize(pw, 26);
              var plate = new Node("p");
              plate.layer = bar.layer;
              plate.parent = n;
              var g = plate.addComponent(Graphics);
              function draw(on) {
                g.clear();
                g.fillColor = on ? new Color(122, 88, 34, 255) : new Color(34, 38, 44, 255);
                g.strokeColor = on ? new Color(232, 198, 112, 255) : new Color(78, 82, 88, 255);
                g.lineWidth = 1;
                g.roundRect(-pw / 2, -13, pw, 26, 6);
                g.fill();
                g.stroke();
              }
              draw(idx === 0);
              owner._slgDraw.push(draw);
              var lab = new Node("l").addComponent(Label);
              lab.node.layer = bar.layer;
              lab.node.parent = n;
              lab.string = title;
              lab.fontSize = 15;
              lab.lineHeight = 20;
              lab.useSystemFont = true;
              lab.fontFamily = "Microsoft YaHei";
              lab.color = new Color(255, 236, 190, 255);
              owner._slgLabs.push(lab);
              n.on(Node.EventType.TOUCH_END, function (ev) {
                if (ev) ev.propagationStopped = true;
                owner._slgDraw.forEach(function (fn, i) { fn(i === idx); });
                owner._slgLabs.forEach(function (lb, i) {
                  lb.color = i === idx ? new Color(255, 236, 190, 255) : new Color(176, 176, 176, 255);
                });
                onPick(idx);
              });
            });
            owner._slgLabs.forEach(function (lb, i) {
              lb.color = i === 0 ? new Color(255, 236, 190, 255) : new Color(176, 176, 176, 255);
            });
          };
        }
        _proto._ensureSkillTabs = function _ensureSkillTabs() {
          var self = this;
          try {
            window.__slgMountTabs(this, this.scrollView, ["全部", "主动", "被动", "追击", "指挥"], function (idx) {
              self._skillFilter = idx;
              self._applySkillTab();
            });
          } catch (err) { console.log("skill tabs", err); }
        };
        _proto._applySkillTab = function _applySkillTab() {
          if (!this._allSkills || !this.scrollView) return;
          var filter = this._skillFilter || 0;
          var arr = this._allSkills.filter(function (s) {
            if (!filter) return true;
            var cfg = SkillCommand.getInstance().proxy.getSkillCfg(s.cfgId);
            return cfg && cfg.trigger === filter;
          });
          this.scrollView.node.getComponent(ListLogic).setData(arr);
        };
        _proto.onEnable = function onEnable() {
          EventMgr.on(LogicEvent.skillListInfo, this.onSkillList, this);
          this._ensureSkillTabs();
          SkillCommand.getInstance().qrySkillList();
        };`,
    ],
    [
      `        _proto.initGeneralCfg = function initGeneralCfg() {
          var cfgs = GeneralCommand.getInstance().proxy.getGeneralAllCfg();
          var arr = Array.from(cfgs.values());
          arr.sort(this.sortStar);
          var comp = this.scrollView.node.getComponent(ListLogic);
          comp.setData(arr);
        };`,
      `        _proto.initGeneralCfg = function initGeneralCfg() {
          var cfgs = GeneralCommand.getInstance().proxy.getGeneralAllCfg();
          var arr = Array.from(cfgs.values());
          arr.sort(this.sortStar);
          this._allGenerals = arr;
          var self = this;
          if (window.__slgMountTabs) {
            try {
              window.__slgMountTabs(this, this.scrollView, ["全部", "汉", "群", "魏", "蜀", "吴"], function (idx) {
                self._campFilter = idx;
                self._applyCampTab();
              });
            } catch (err) { console.log("roster tabs", err); }
          }
          this._applyCampTab();
        };
        _proto._applyCampTab = function _applyCampTab() {
          if (!this._allGenerals || !this.scrollView) return;
          var camp = this._campFilter || 0;
          var arr = this._allGenerals.filter(function (cfg) {
            return !camp || cfg.camp === camp;
          });
          this.scrollView.node.getComponent(ListLogic).setData(arr);
        };`,
    ],
    [
      `  var _applyDecoratedDescriptor, _inheritsLoose, _initializerDefineProperty, _assertThisInitialized, _defineProperty, cclegacy, _decorator, Label, Layout, Prefab, Node, instantiate, Component, EventMgr, GeneralData, LogicEvent, GeneralCommand, AudioManager, SkillCommand, SkillIconLogic, GeneralItemLogic;`,
      `  var _applyDecoratedDescriptor, _inheritsLoose, _initializerDefineProperty, _assertThisInitialized, _defineProperty, cclegacy, _decorator, Label, Layout, Prefab, Node, instantiate, Component, Color, UITransform, EventMgr, GeneralData, LogicEvent, GeneralCommand, AudioManager, SkillCommand, SkillIconLogic, GeneralItemLogic;`,
    ],
    [
      `      Label = module.Label;
      Layout = module.Layout;
      Prefab = module.Prefab;
      Node = module.Node;
      instantiate = module.instantiate;
      Component = module.Component;
    }, function (module) {
      EventMgr = module.EventMgr;
    }, function (module) {
      GeneralData = module.GeneralData;`,
      `      Label = module.Label;
      Layout = module.Layout;
      Prefab = module.Prefab;
      Node = module.Node;
      instantiate = module.instantiate;
      Component = module.Component;
      Color = module.Color;
      UITransform = module.UITransform;
    }, function (module) {
      EventMgr = module.EventMgr;
    }, function (module) {
      GeneralData = module.GeneralData;`,
    ],
    [
      `          this.costLabel.string = "cost:" + cfgData.cost;

          for (var index = 0; index < curData.skills.length; index++) {`,
      `          this.costLabel.string = "cost:" + cfgData.cost;
          this._openDossier();

          for (var index = 0; index < curData.skills.length; index++) {`,
    ],
    [
      `        _proto.onClickSkill = function onClickSkill(event, pos) {`,
      `        _proto._ensureDossier = function _ensureDossier() {
          if (this._dossier) return;
          var host = new Node("dossier");
          host.layer = this.node.layer;
          host.parent = this.node;
          var rootUi = this.node.getComponent(UITransform);
          var y = rootUi ? -rootUi.height * rootUi.anchorY + 78 : -220;
          host.setPosition(0, y, 0);
          host.setSiblingIndex(this.node.children.length - 1);
          this._dossierPage = 0;
          this._dossierTabs = [];
          var self = this;
          ["历史传记", "本局画像"].forEach(function (title, idx) {
            var n = new Node("dtab" + idx);
            n.layer = host.layer;
            n.parent = host;
            n.setPosition(-90 + idx * 160, 52, 0);
            var lab = n.addComponent(Label);
            lab.string = title;
            lab.fontSize = 16;
            lab.lineHeight = 22;
            lab.useSystemFont = true;
            lab.fontFamily = "Microsoft YaHei";
            n.getComponent(UITransform).setContentSize(140, 26);
            self._dossierTabs.push(lab);
            n.on(Node.EventType.TOUCH_END, function (ev) {
              if (ev) ev.propagationStopped = true;
              self._dossierPage = idx;
              self._paintDossier();
            });
          });
          var body = new Node("dbody");
          body.layer = host.layer;
          body.parent = host;
          body.setPosition(0, -8, 0);
          var text = body.addComponent(Label);
          text.fontSize = 14;
          text.lineHeight = 18;
          text.useSystemFont = true;
          text.fontFamily = "Microsoft YaHei";
          text.overflow = 3;
          text.enableWrapText = true;
          text.horizontalAlign = 0;
          body.getComponent(UITransform).setContentSize(460, 88);
          this._dossierText = text;
          this._dossier = host;
        };
        _proto._paintDossier = function _paintDossier() {
          var self = this;
          (this._dossierTabs || []).forEach(function (lab, idx) {
            var on = idx === self._dossierPage;
            lab.color = on ? new Color(255, 214, 120, 255) : new Color(168, 168, 168, 255);
            lab.isBold = on;
          });
          var doc = this._dossierDoc;
          if (!doc || !this._dossierText) return;
          if (this._dossierPage === 0) {
            this._dossierText.string = doc.official || "";
            return;
          }
          var p = doc.portrait || {};
          var lines = [];
          lines.push(p.temper ? "性情：" + p.temper : "性情：本局还没为他写画像");
          if (p.desire) lines.push("欲求：" + p.desire);
          if (p.line) lines.push("底线：" + p.line);
          if (p.voice) lines.push("口吻：" + p.voice);
          lines.push(p.owned ? "本局：在册，" + p.level + "级，兵力 " + p.soldiers : "本局：尚未入营");
          lines.push("出战 " + p.battles + " 场，身故 " + p.deaths + " 次");
          if (p.lastDeath) lines.push("最近一次：" + p.lastDeath);
          if (p.fate) lines.push("宿命：" + p.fate);
          this._dossierText.string = lines.join("\\n");
        };
        _proto._openDossier = function _openDossier() {
          this._ensureDossier();
          this._paintDossier();
          var cfg = this._cfgData;
          if (!cfg) return;
          var cfgId = cfg.cfgId;
          var self = this;
          fetch("/__slg/general-dossier?cfgId=" + encodeURIComponent(cfgId) + "&name=" + encodeURIComponent(cfg.name || "")).then(function (res) {
            return res.json();
          }).then(function (doc) {
            if (!self._cfgData || self._cfgData.cfgId !== cfgId) return;
            self._dossierDoc = doc;
            self._paintDossier();
          }).catch(function () {});
        };
        _proto.onClickSkill = function onClickSkill(event, pos) {`,
    ],
    /* ---- 地形/领地详情容错：地图上有 2869 个 level=0 的空地格 ----
     * 原版 getDefenseSoldiers(0) 读 npc.levels[-1].soilders 直接抛异常，
     * 玩家点到空地（或建造中要塞）时整个详情面板崩。这里只改内存里的
     * 客户端脚本，磁盘上的 index.js 一个字节不动，画面资源零改动。 */
    [
      `        _proto3.getDefenseSoldiers = function getDefenseSoldiers(level) {
          console.log("getDefenseSoldiers:", level);
          return this._basic.npc.levels[level - 1].soilders;
        };`,
      `        _proto3.getDefenseSoldiers = function getDefenseSoldiers(level) {
          var list = (this._basic && this._basic.npc && this._basic.npc.levels) || [];
          var row = list[level - 1];
          return row ? row.soilders : 0;
        };`,
    ],
    [
      `        _proto2.getResYieldDesList = function getResYieldDesList(cfg) {
          var list = [];

          if (cfg.grain > 0) {`,
      `        _proto2.getResYieldDesList = function getResYieldDesList(cfg) {
          var list = [];

          if (!cfg) return list;

          if (cfg.grain > 0) {`,
    ],
    [
      `            var resData = MapCommand.getInstance().proxy.getResData(this._data.id);`,
      `            var resData = MapCommand.getInstance().proxy.getResData(this._data.id) || this._data;`,
    ],
    [
      `              this.labelName.string = resCfg.name;`,
      `              this.labelName.string = resCfg ? resCfg.name : (this._data.name || "");`,
    ],
    [
      `        _proto.account_logout = function account_logout() {`,
      `        if (typeof window !== 'undefined' && !window.__slgSend) {
          window.__slgSend = function (name, msg) {
            return NetManager.getInstance().send({ name: name, msg: msg || {} });
          };
        }
        _proto.account_logout = function account_logout() {
          // ★ P11：登出立刻收回所有注入面板，不等轮询
          if (typeof document !== 'undefined') {
            document.documentElement.setAttribute('data-slg-phase', 'login');
            if (window.__slgGateDebug) window.__slgGateDebug.phase = 'login';
          }`,
    ],
    [
      `          EventMgr.on(LogicEvent.openGeneralRoster, this.onOpenGeneralRoster, this);`,
      `          EventMgr.on(LogicEvent.openGeneralRoster, function () {
            /* ★ P6：原版武将名册是 Cocos 面板，被离线遮罩挡住（点击看似没反应）。
               这里改开注入的六府「武将」页，与右侧菜单同一套内容联动。 */
            if (window.__slgPanels && window.__slgPanels.open) window.__slgPanels.open('general');
            else if (window.__slgGeneralsWindow) window.__slgGeneralsWindow();
          }, this);
          EventMgr.on("campaign.pending", this.onCampaignPending, this);
          EventMgr.on("warReport.push", this.onWarReportAnim, this);`,
    ],
    [
      `        _proto.robLoginUI = function robLoginUI() {`,
      `        _proto.onCampaignPending = function onCampaignPending(frame) {
          var d = frame && frame.msg ? frame.msg : (frame || {});
          if (window.__slgCampaignChoice) window.__slgCampaignChoice(d);
        };
        _proto.onWarReportAnim = function onWarReportAnim(frame) {
          var rep = frame && frame.msg ? frame.msg : null;
          if (!rep || !rep.anim) return;
          window.lastWarReport = rep;
          // 本地地图已删除：Cocos 面板都在遮罩之下打不开，战报详情统一走 DOM 战报窗
          if (window.__slgReportsWindow) window.__slgReportsWindow();
          if (window.__slgPlayBattle) window.__slgPlayBattle(rep.anim);
        };
        _proto.robLoginUI = function robLoginUI() {`,
    ],
    [
      `        _proto.onEnterMap = function onEnterMap() {
          var _this2 = this;

          var dataList = [];`,
      `        _proto.onEnterMap = function onEnterMap() {
          var _this2 = this;
          // 登录进图的第一时间就盖住本地地图，不等贴图加载完
          if (typeof document !== 'undefined') {
            // ★ P11：真实「已进图」事件是登录成功的最强信号，立即放行注入 UI。
            // 服务端 /__slg/session 的轮询仍作为登出/异常时的权威兜底。
            document.documentElement.setAttribute('data-slg-phase', 'game');
            if (window.__slgGateDebug) window.__slgGateDebug.phase = 'game';
            if (window.__slgGatePoll) window.__slgGatePoll();
            var gameDiv = document.getElementById('GameDiv');
            if (gameDiv) gameDiv.style.visibility = 'hidden';
            var coverEarly = document.getElementById('slgLocalCover');
            if (coverEarly) coverEarly.style.display = 'block';
            var openStrategy = function () {
              if (window.__slgStrategyShow) window.__slgStrategyShow();
            };
            openStrategy();
            setTimeout(openStrategy, 60);
          }

          var dataList = [];`,
    ],
    [
      `            _this2.clearAllScene();

            _this2._mapScene = instantiate(_this2.mapScenePrefab);
            _this2._mapScene.parent = _this2.node;
            _this2._mapUIScene = instantiate(_this2.mapUIScenePrefab);
            _this2._mapUIScene.parent = _this2.node;

            _this2.addLoadingNode();`,
      `            _this2.clearAllScene();

            _this2._mapScene = instantiate(_this2.mapScenePrefab);
            _this2._mapScene.parent = _this2.node;
            _this2._mapUIScene = instantiate(_this2.mapUIScenePrefab);
            _this2._mapUIScene.parent = _this2.node;
            // 本地地图挂上树之后再盖一次，避免加载完成时闪出来
            if (typeof document !== 'undefined') {
              var gameDiv2 = document.getElementById('GameDiv');
              if (gameDiv2) gameDiv2.style.visibility = 'hidden';
              var cover0 = document.getElementById('slgLocalCover');
              if (cover0) cover0.style.display = 'block';
              if (window.__slgStrategyShow) window.__slgStrategyShow();
            }

            _this2.addLoadingNode();`,
    ],
    [
      `            var cityData = MapCommand.getInstance().cityProxy.getMyCityById(data.msg.cityId);

            var addition = this._proxy.updateMyCityAdditions(cityData.cityId);

            cityData.maxDurable = this._proxy.getMyCityMaxDurable(data.msg.cityId);
            EventMgr.emit(LogicEvent.updateCityAddition, data.msg.cityId, addition);
          }`,
      `            var cityData = MapCommand.getInstance().cityProxy.getMyCityById(data.msg.cityId);

            /* __slg 离线修复：城列表未就绪（登录竞态/异地城查询）时 getMyCityById
               会回 null，原版直接读 .cityId 抛 TypeError——真实点击 E2E 抓到的
               上游崩溃。空引用时整段跳过，只刷设施列表不刷加成。 */
            if (cityData == null) {
              console.log("onCityFacilities: city not ready, skip", data.msg.cityId);
            } else {
            var addition = this._proxy.updateMyCityAdditions(cityData.cityId);

            cityData.maxDurable = this._proxy.getMyCityMaxDurable(data.msg.cityId);
            EventMgr.emit(LogicEvent.updateCityAddition, data.msg.cityId, addition);
            }
          }`,
    ],
  ];
  let out = source;
  for (const [from, to] of pieces) {
    if (!out.includes(from)) throw new Error(`客户端补丁对不上：${from.slice(0, 40)}`);
    out = out.replace(from, to);
  }
  return `${out}\n${STRATEGY_OVERLAY_SOURCE}\n${BATTLE_ANIM_SOURCE}\n${CITY_WINDOW_V2_IMPL}`;
}

/** 战略大地图覆盖层：纯 DOM + canvas，不进 Cocos 场景，磁盘不动。 */
const STRATEGY_OVERLAY_SOURCE = `;(function () {
  if (typeof document === 'undefined') return;
  var MAP_W = 2400, MAP_H = 1350;
  var overlay = null, canvas = null, timer = null, lastState = null, picked = null, pickedPass = null;
  var logPanel = null, logOpen = false, logTab = 'world';
  // 关名锚点相对关隘中心（与预览图文字位置一致），不再使用带方底的城名贴图
  var PASS_LABEL = {
    '剑门关': [-18.5, 32.6], '阳平关': [-18.5, 32.0], '潼关': [-11.0, 32.6], '函谷关': [-58.6, 31.4],
    '武关': [-11.0, 32.0], '雁门关': [-18.5, 32.0], '虎牢关': [-18.5, 32.6], '居庸关': [-18.5, 32.0]
  };
  var DETAIL = null, IMG = {};
  /* 分层渲染：路网 / 城池 / 关隘 / 城名，对应 detail.json 的贴图层。
   * ★ 玩家反馈「图层检索去掉十三州水墨底图和十三州部古名」：
   *   - 底图（layer_base）不是「可关掉的图层」，它就是地图本体；
   *     关掉只会得到一块空白米色，这种开关本身就是伪功能，直接取消，
   *     改为永远绘制（见 draw 里的 baseImg）。
   *   - 古名层（layer_zhou）是十三州旧名文字，只有淡淡几行、放大也读不清，
   *     与城名标注抢位置，按反馈整层废弃，不再请求该贴图。 */
  var LAYER = { road: true, city: true, pass: true, name: true };

  function layerUrl(path) {
    var p = String(path || '');
    while (p.charAt(0) === '/') p = p.slice(1);
    return '/__slg/strategy/' + p;
  }

  function ensureImg(key, src) {
    if (!src) return null;
    if (!IMG[key]) {
      var im = new Image();
      im.onload = function () { if (lastState) draw(lastState); };
      im.src = src;
      IMG[key] = im;
    }
    var cur = IMG[key];
    return (cur.complete && cur.naturalWidth > 0) ? cur : null;
  }

  function loadDetail() {
    fetch('/__slg/strategy/detail').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.cities) return;
      DETAIL = d;
      Object.keys(d.layers || {}).forEach(function (k) {
        if (k === 'name') return;
        ensureImg('layer:' + k, layerUrl(d.layers[k]));
      });
    }).catch(function () {});
  }

  function cityInfo(c) { return (DETAIL && DETAIL.cities && DETAIL.cities[c.id]) || null; }

  /** 选中染色矩阵，与预览图 selTint / selTintPass 一致：城池偏朱红，关隘偏石青。 */
  var TINT_CITY = [
    1.30, 0.06, 0.02, 0, 0.03,
    0.04, 0.90, 0.02, 0, 0,
    0.02, 0.04, 0.64, 0, 0,
    0, 0, 0, 1, 0
  ];
  var TINT_PASS = [
    0.80, 0.02, 0.06, 0, 0,
    0.02, 0.98, 0.08, 0, 0.01,
    0.04, 0.10, 1.32, 0, 0.04,
    0, 0, 0, 1, 0
  ];

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /**
   * 选中染色：只抠这一座城或这一处关的插画，按原图 alpha 做颜色矩阵。
   * 不铺色块、不画边框，轮廓和羽化边留着，外面再加一圈柔光。
   */
  var tintCache = { key: '', canvas: null };
  function tintCrop(layerImg, sx, sy, sw, sh, mode) {
    var key = [mode, sx.toFixed(1), sy.toFixed(1), sw.toFixed(1), sh.toFixed(1)].join('|');
    if (tintCache.key === key && tintCache.canvas) return tintCache.canvas;
    var pw = Math.max(2, Math.round(sw * 2)), ph = Math.max(2, Math.round(sh * 2));
    var off = document.createElement('canvas');
    off.width = pw; off.height = ph;
    var og = off.getContext('2d');
    og.drawImage(layerImg, sx, sy, sw, sh, 0, 0, pw, ph);
    var frame = og.getImageData(0, 0, pw, ph);
    var px = frame.data;
    var m = mode === 'pass' ? TINT_PASS : TINT_CITY;
    var n = px.length;
    for (var i = 0; i < n; i += 4) {
      if (px[i + 3] < 6) continue;
      var R = px[i] / 255, G = px[i + 1] / 255, B = px[i + 2] / 255, A = px[i + 3] / 255;
      var r = m[0] * R + m[1] * G + m[2] * B + m[3] * A + m[4];
      var gv = m[5] * R + m[6] * G + m[7] * B + m[8] * A + m[9];
      var b = m[10] * R + m[11] * G + m[12] * B + m[13] * A + m[14];
      var a = m[15] * R + m[16] * G + m[17] * B + m[18] * A + m[19];
      px[i] = r < 0 ? 0 : (r > 1 ? 255 : (r * 255 + 0.5) | 0);
      px[i + 1] = gv < 0 ? 0 : (gv > 1 ? 255 : (gv * 255 + 0.5) | 0);
      px[i + 2] = b < 0 ? 0 : (b > 1 ? 255 : (b * 255 + 0.5) | 0);
      px[i + 3] = a < 0 ? 0 : (a > 1 ? 255 : (a * 255 + 0.5) | 0);
    }
    og.putImageData(frame, 0, 0);
    tintCache = { key: key, canvas: off };
    return off;
  }


  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function cityLogHtml(c) {
    var logs = (lastState && lastState.cityLogs && lastState.cityLogs[String(c.id)]) || [];
    if (!logs.length) return '<div style="margin-top:6px;color:#9c9382;font-size:11.5px;">这座城还没有军报。</div>';
    return '<div style="margin-top:6px;color:#9c9382;font-size:11.5px;">城池日志</div>'
      + logs.slice().reverse().slice(0, 6).map(function (e) {
        return '<div style="color:#e6dac0;font-size:12px;line-height:1.7;">第 ' + e.month + ' 月 ' + esc(e.text) + '</div>';
      }).join('');
  }

  function buildLog() {
    logPanel = document.createElement('div');
    logPanel.id = 'slgLogPanel';
    logPanel.style.cssText = 'position:absolute;top:52px;right:12px;bottom:12px;width:460px;z-index:6;display:none;'
      + 'flex-direction:column;background:rgba(14,15,11,0.94);border:1px solid rgba(186,154,82,0.45);'
      + 'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);color:#e6dac0;'
      + 'font:13px/1.7 "Microsoft YaHei",sans-serif;text-align:left;';
    logPanel.innerHTML = '<div style="padding:8px 12px 0;color:#e8c670;font-weight:bold;letter-spacing:2px;">天下日志</div>'
      + '<div id="slgLogTabs" style="display:flex;gap:4px;padding:6px 10px;flex-wrap:wrap;"></div>'
      + '<div id="slgLogBody" style="flex:1;overflow:auto;padding:4px 12px 12px;"></div>';
    overlay.appendChild(logPanel);
    var tabs = [['world', '整体'], ['city', '城池'], ['time', '时序'], ['plan', '规划'], ['book', '财报']];
    var bar = document.getElementById('slgLogTabs');
    tabs.forEach(function (pair) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = pair[1];
      b.dataset.tab = pair[0];
      b.style.cssText = 'background:#2a2c30;color:#e8c670;border:1px solid #ba9a52;border-radius:4px;padding:2px 8px;cursor:pointer;';
      b.onclick = function () {
        logTab = pair[0];
        if (lastState) { renderLog(lastState); draw(lastState); }
      };
      bar.appendChild(b);
    });
  }

  function quietMonth(m) {
    return !(m.moves || []).some(function (x) { return x.kind === '出征' || x.kind === '结盟'; });
  }

  function renderLog(s) {
    var body = document.getElementById('slgLogBody');
    if (!body || !logOpen) return;
    var html = '';
    if (logTab === 'world') html = renderWorld(s);
    else if (logTab === 'city') html = renderCityLog(s);
    else if (logTab === 'time') html = renderTimeline(s);
    else if (logTab === 'plan') html = renderPlans(s);
    else html = renderBooks(s);
    body.innerHTML = html || '<div style="opacity:.6">还没有记录。先推演一月。</div>';
  }

  function renderWorld(s) {
    var list = (s.chronicle || []).slice().reverse();
    if (!list.length) return '';
    var groups = [];
    list.forEach(function (m) {
      var quiet = quietMonth(m);
      var prev = groups[groups.length - 1];
      if (quiet && prev && prev.quiet && prev.end + 1 === m.month) {
        prev.end = m.month;
        prev.items.push(m);
      } else groups.push({ quiet: quiet, start: m.month, end: m.month, items: [m] });
    });
    return groups.reverse().map(function (g) {
      if (g.quiet && g.end > g.start) {
        return '<div style="margin-bottom:10px;"><b style="color:#f0d998;">第 ' + g.start + ' 月到第 ' + g.end
          + ' 月</b><div>邻城守军还厚，各家征兵，不出征。</div>'
          + g.items.map(function (m) {
            return '<div style="opacity:.78;font-size:12px;">' + esc(m.text) + '</div>';
          }).join('') + '</div>';
      }
      return g.items.map(function (m) {
        return '<div style="margin-bottom:10px;">' + esc(m.text) + '</div>';
      }).join('');
    }).join('');
  }

  function renderCityLog(s) {
    if (!picked) return '<div style="opacity:.7">在地图上点一座城，这里列出它的出兵、来攻、征兵和易手。</div>';
    var logs = (s.cityLogs && s.cityLogs[String(picked.id)]) || [];
    var head = '<div style="color:#f0d998;font-weight:bold;margin-bottom:6px;">' + esc(picked.name) + ' · ' + esc(picked.ownerName) + '</div>';
    if (!logs.length) return head + '<div style="opacity:.7">这座城还没有军报。</div>';
    return head + logs.slice().reverse().map(function (e) {
      return '<div style="margin-bottom:6px;">第 ' + e.month + ' 月 ' + esc(e.text) + '</div>';
    }).join('');
  }

  function renderTimeline(s) {
    var months = (s.chronicle || []).slice().reverse();
    if (!months.length) return '';
    var names = [];
    var cell = {};
    months.forEach(function (m) {
      (m.moves || []).forEach(function (mv) {
        if (!mv.who || mv.kind === '田赋' || mv.kind === '征兵' || mv.kind === '屯田') return;
        if (names.indexOf(mv.who) < 0) names.push(mv.who);
        var label = '按兵';
        var color = '#9c9382';
        if (mv.kind === '出征' && mv.result === '克') { label = '克' + (mv.toName || ''); color = '#e07060'; }
        else if (mv.kind === '出征' && mv.result === '挫') { label = '挫' + (mv.toName || ''); color = '#c9a066'; }
        else if (mv.kind === '出征') { label = '未发'; color = '#8f8676'; }
        else if (mv.kind === '结盟') { label = '盟' + (mv.otherName || ''); color = '#7dcea0'; }
        cell[mv.who + '@' + m.month] = { label: label, color: color };
      });
    });
    var head = '<div style="display:flex;gap:4px;position:sticky;top:0;background:#14160f;padding-bottom:4px;">'
      + '<div style="width:52px;flex:none;"></div>'
      + months.map(function (m) { return '<div style="width:64px;flex:none;color:#e8c670;font-size:12px;">' + m.month + '月</div>'; }).join('')
      + '</div>';
    var rows = names.map(function (name) {
      return '<div style="display:flex;gap:4px;margin-top:3px;"><div style="width:52px;flex:none;">' + esc(name) + '</div>'
        + months.map(function (m) {
          var hit = cell[name + '@' + m.month];
          return '<div style="width:64px;flex:none;font-size:11px;line-height:1.4;color:' + (hit ? hit.color : '#5c564c') + ';">'
            + esc(hit ? hit.label : '·') + '</div>';
        }).join('') + '</div>';
    }).join('');
    return head + rows;
  }

  function renderPlans(s) {
    var plans = s.plans || [];
    if (!plans.length) return '';
    return '<div style="opacity:.75;font-size:12px;margin-bottom:8px;">虚线标在地图上：从出发城指向本月目标。固守不画线。</div>'
      + plans.map(function (p) {
        var line = p.type === '固守'
          ? ('按兵 ' + (p.fromName || '本境'))
          : ((p.fromName || '出发') + ' → ' + (p.targetName || '目标'));
        return '<div style="margin-bottom:8px;border-left:3px solid ' + (p.color || '#ba9a52') + ';padding-left:8px;">'
          + '<b>' + esc(p.name) + '</b> · ' + esc(p.type)
          + '<div>' + esc(line) + '</div>'
          + '<div style="opacity:.8;">' + esc(p.reason) + '</div></div>';
      }).join('');
  }

  function renderBooks(s) {
    var books = s.books || [];
    if (!books.length) return '';
    return books.map(function (b) {
      var rows = (b.rows || []).map(function (r) {
        return '<tr><td>' + esc(r.name) + '</td><td>' + r.grainIn + '</td><td>' + r.goldIn
          + '</td><td>' + r.grainRecruit + '</td><td>' + r.grainMarch + '</td><td>' + r.goldMarch
          + '</td><td>' + r.horses + '</td><td>' + r.horseGrain + '</td><td>' + r.horseGold
          + '</td><td>' + (r.grainEnd == null ? '—' : r.grainEnd) + '</td><td>' + (r.goldEnd == null ? '—' : r.goldEnd) + '</td></tr>';
      }).join('');
      return '<div style="margin-bottom:12px;"><b style="color:#f0d998;">第 ' + b.month + ' 月</b>'
        + '<div style="overflow-x:auto;"><table style="border-collapse:collapse;font-size:12px;white-space:nowrap;">'
        + '<tr style="color:#9c9382;"><td>势力</td><td>田赋粮</td><td>商税金</td><td>征兵粮</td><td>行军粮</td><td>军饷</td>'
        + '<td>战马</td><td>马料</td><td>马金</td><td>余粮</td><td>余金</td></tr>' + rows + '</table></div></div>';
    }).join('');
  }

  function boot() {
    if (document.getElementById('slgStrategyOverlay')) return;
    // 本地地图遮罩：进图前不显示（登录首页要露出来），进图后才盖住 Cocos 场景
    var cover = document.createElement('div');
    cover.id = 'slgLocalCover';
    cover.style.cssText = 'position:fixed;inset:0;z-index:99000;background:#e4d3c6;display:none;';
    document.body.appendChild(cover);
    overlay = document.createElement('div');
    overlay.id = 'slgStrategyOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;display:none;'
      + 'background:#e4d3c6;';
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    var btnCss = 'background:rgba(22,24,16,.88);color:#e8c670;border:1px solid #ba9a52;'
      + 'border-radius:4px;padding:3px 10px;cursor:pointer;font:13px/1.4 sans-serif;';
    /* ★ 用户 ⑩：左上按钮坞原来是一排各写各的内联样式的方按钮，与右侧六府
       （深底金框、字距 1px）完全是两套观感；而且「武将 / 战报 / 出征」在两边
       各有一份，玩家不知道该点哪边。这里统一成一条「沙盘工具条」：
         - 风格与六府同源（深墨底 / 金线 / 字距 / 同一套 hover）；
         - 只保留沙盘专属动作（推演、出征、本城、缩放、全图、日志）；
           武将与战报只在六府出现，去掉重复入口；
         - 末尾挂「浮窗」开关（图层 / 透镜 / 事务），对应 ⑧ 的显示隐藏。 */
    var dockCss = document.createElement('style');
    dockCss.id = 'slgDockCss';
    dockCss.textContent = ''
      + '#slgDock{display:flex;align-items:center;gap:3px;padding:5px 7px;border-radius:9px;'
      + 'background:linear-gradient(180deg,rgba(26,28,20,.95),rgba(13,14,10,.95));'
      + 'border:1px solid rgba(186,154,82,.5);box-shadow:0 6px 22px rgba(0,0,0,.5);'
      + 'font-family:"Microsoft YaHei",sans-serif}'
      + '#slgDock .gp{color:#8d8567;font-size:10.5px;letter-spacing:2px;padding:0 3px 0 2px;user-select:none}'
      + '#slgDock .sep{width:1px;height:16px;background:rgba(186,154,82,.28);margin:0 4px;display:inline-block}'
      + '#slgDock button{background:transparent;color:#d9cba6;border:1px solid transparent;'
      + 'border-radius:5px;padding:4px 9px;cursor:pointer;font:12.5px/1.35 "Microsoft YaHei",sans-serif;'
      + 'letter-spacing:.5px;transition:background .12s,color .12s,border-color .12s}'
      + '#slgDock button:hover{background:rgba(186,154,82,.18);color:#ffe9b0;border-color:rgba(186,154,82,.4)}'
      + '#slgDock button.pri{background:linear-gradient(180deg,#7d6122,#513c14);color:#ffe9b0;'
      + 'border-color:#c8a44e}'
      + '#slgDock button.pri:hover{background:linear-gradient(180deg,#95762a,#5f4718);color:#fff6d6}'
      + '#slgDock button.icon{padding:4px 7px;min-width:26px;font-size:13px;line-height:1}'
      + '#slgDock button.chip{font-size:11.5px;padding:3px 8px;border-color:rgba(186,154,82,.3);color:#a89c7c}'
      + '#slgDock button.chip.on{color:#ffe9b0;border-color:#ba9a52;background:rgba(186,154,82,.16)}'
      + '@media (max-width:1180px){#slgDock .gp{display:none}}'
      /* 势力面板（原「势力图例」）——与按钮坞、六府同一套色与圆角 */
      + '#slgLegend .lg-head{display:flex;align-items:center;justify-content:space-between;'
      + 'color:#e8c670;font-weight:bold;letter-spacing:2px;padding-bottom:5px;margin-bottom:5px;'
      + 'border-bottom:1px solid rgba(186,154,82,.25)}'
      + '#slgLegend .lg-btns button{background:transparent;color:#c8b88a;border:1px solid rgba(186,154,82,.4);'
      + 'border-radius:4px;padding:0 6px;margin-left:4px;cursor:pointer;font:11px/1.6 "Microsoft YaHei",sans-serif}'
      + '#slgLegend .lg-btns button:hover{color:#ffe9b0;border-color:#ba9a52}'
      + '#slgLegend .lg-list{display:flex;flex-direction:column;gap:2px}'
      + '#slgLegend .lg-row{display:flex;align-items:center;gap:5px;width:100%;text-align:left;'
      + 'background:transparent;border:1px solid transparent;border-radius:5px;padding:2px 5px;'
      + 'color:#d9cba6;cursor:pointer;font:12.5px/1.6 "Microsoft YaHei",sans-serif}'
      + '#slgLegend .lg-row:hover{background:rgba(186,154,82,.16);color:#ffe9b0}'
      + '#slgLegend .lg-row.on{background:rgba(186,154,82,.22);border-color:#ba9a52;color:#fff2cf}'
      + '#slgLegend .lg-row i{width:9px;height:9px;border-radius:50%;flex:0 0 9px}'
      + '#slgLegend .lg-row b{font-weight:600}'
      + '#slgLegend .lg-n{margin-left:auto;color:#9c9382;font-size:11px;white-space:nowrap}'
      + '#slgLegend .lg-row em{font-style:normal;font-size:10.5px;color:#e0c56a;white-space:nowrap}'
      + '#slgLegend .lg-detail{margin-top:7px;padding:6px 7px;border-radius:6px;'
      + 'background:rgba(90,110,70,.14);border:1px solid rgba(186,154,82,.28);font-size:11.5px;line-height:1.75}'
      + '#slgLegend .lg-dt{color:#e8c670;font-weight:bold;margin-bottom:3px}'
      + '#slgLegend .lg-blurb{color:#c8c2b4;margin:3px 0}'
      + '#slgLegend .lg-hold{color:#a9a48f;margin-top:2px}'
      + '#slgLegend .lg-clear{background:transparent;color:#e0c56a;border:1px solid rgba(186,154,82,.45);'
      + 'border-radius:4px;padding:1px 8px;margin-top:5px;cursor:pointer;font:11px/1.7 "Microsoft YaHei",sans-serif}'
      + '#slgLegend .lg-clear:hover{border-color:#e3c46a;color:#ffe9b0}'
      + '#slgLegend .lg-foot{color:#9c9382;font-size:10.5px;line-height:1.6;margin-top:6px;'
      + 'border-top:1px solid rgba(186,154,82,.25);padding-top:4px}';
    document.head.appendChild(dockCss);
    var dock = document.createElement('div');
    dock.id = 'slgDock';
    dock.style.cssText = 'position:absolute;top:12px;left:12px;z-index:4;display:flex;flex-wrap:wrap;'
      + 'gap:3px;max-width:calc(100% - 320px);';
    dock.innerHTML = ''
      + '<span class="gp">沙盘</span>'
      + '<button id="slgStratTick" class="pri">推演一月</button>'
      + '<button id="slgBtnWar" class="pri" data-ix-allow="1">出征</button>'
      + '<button id="slgBtnHome">本城</button>'
      + '<i class="sep"></i>'
      + '<button id="slgBtnZoomIn" class="icon" title="放大（滚轮上）">＋</button>'
      + '<button id="slgBtnZoomOut" class="icon" title="缩小（滚轮下）">－</button>'
      + '<button id="slgBtnFit">全图</button>'
      + '<i class="sep"></i>'
      + '<span class="gp">浮窗</span>'
      + '<button class="chip" data-float="side" title="显示 / 收起「图层与检索」">图层</button>'
      + '<button class="chip" data-float="lens" title="显示 / 收起「地图透镜」">透镜</button>'
      + '<button class="chip" data-float="agenda" title="显示 / 收起「当前事务」">事务</button>'
      + '<button class="chip" data-float="legend" title="显示 / 收起「势力面板」">势力</button>'
      + '<i class="sep"></i>'
      + '<button id="slgBtnLog">天下日志</button>';
    Array.prototype.forEach.call(dock.querySelectorAll('button'), function (b) {
      b.style.fontFamily = '"Microsoft YaHei",sans-serif';
    });
    /* 浮窗开关：状态只落 html[data-slg-float-*]，样式在外壳里，两边不互相引用 */
    Array.prototype.forEach.call(dock.querySelectorAll('[data-float]'), function (chip) {
      var name = chip.getAttribute('data-float');
      var sync = function () {
        var on = !(window.__slgShell && window.__slgShell.float) || window.__slgShell.float(name) !== false;
        chip.className = 'chip' + (on ? ' on' : '');
      };
      chip.onclick = function () {
        if (window.__slgShell && window.__slgShell.toggleFloat) window.__slgShell.toggleFloat(name);
        else {
          var el0 = document.documentElement;
          var off = el0.getAttribute('data-slg-float-' + name) === 'off';
          if (off) el0.removeAttribute('data-slg-float-' + name);
          else el0.setAttribute('data-slg-float-' + name, 'off');
        }
        sync();
      };
      sync();
      window.addEventListener('slg:float', sync);
    });
    var legend = document.createElement('div');
    legend.id = 'slgLegend';
    legend.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:100002;width:252px;display:none;'
      + 'max-height:min(32vh,300px);overflow-y:auto;'
      + 'text-align:left;background:rgba(14,15,11,0.9);'
      + 'border:1px solid rgba(186,154,82,0.45);border-radius:8px;padding:8px 10px 9px;'
      + 'color:#e2d6ba;font:13px/1.7 "Microsoft YaHei",sans-serif;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.45);';
    var foot = document.createElement('div');
    foot.id = 'slgStratFoot';
    foot.style.cssText = 'position:absolute;left:12px;bottom:12px;z-index:4;width:340px;'
      + 'text-align:left;background:rgba(14,15,11,0.88);'
      + 'border:1px solid rgba(186,154,82,0.45);border-radius:8px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.45);overflow:hidden;';
    var footHead = document.createElement('div');
    footHead.style.cssText = 'padding:6px 12px 4px;color:#e8c670;font:bold 13px "Microsoft YaHei",sans-serif;'
      + 'letter-spacing:2px;text-align:left;border-bottom:1px solid rgba(186,154,82,0.25);';
    footHead.innerHTML = '霜寒定九州 · 天下大势'
      + '<div id="slgStratTurn" style="font-weight:normal;letter-spacing:0;opacity:.85;'
      + 'font-size:12px;margin-top:2px;text-align:left;"></div>'
      + '<div id="slgAlert" style="color:#ffb27a;font-weight:normal;letter-spacing:0;'
      + 'font-size:12px;line-height:1.5;text-align:left;"></div>';
    var footList = document.createElement('div');
    footList.id = 'slgStratEvents';
    footList.style.cssText = 'max-height:150px;overflow-y:auto;padding:5px 12px 7px;text-align:left;'
      + 'color:#e6dac0;font:13px/1.85 "Microsoft YaHei",sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.8);';
    foot.appendChild(footHead); foot.appendChild(footList);
    overlay.appendChild(canvas); overlay.appendChild(dock); overlay.appendChild(foot);
    document.body.appendChild(overlay);
    document.body.appendChild(legend);
    buildSidebar();
    buildIntro();
    document.getElementById('slgBtnLog').onclick = function () {
      logOpen = !logOpen;
      if (logPanel) logPanel.style.display = logOpen ? 'flex' : 'none';
      if (lastState) draw(lastState);
    };
    buildLog();
    document.getElementById('slgBtnFit').onclick = function () {
      view.zoom = 1; view.px = 0; view.py = 0; picked = null; pickedPass = null;
      clearViewSaved();   /* ★ #18：复位是玩家主动清空上下文的唯一入口 */
      if (lastState) draw(lastState);
    };
    document.getElementById('slgBtnZoomIn').onclick = function () { if (window.__slgZoom) window.__slgZoom(1); };
    document.getElementById('slgBtnZoomOut').onclick = function () { if (window.__slgZoom) window.__slgZoom(-1); };
    document.getElementById('slgBtnWar').onclick = function () {
      /* ★ 出征面板：沙盘顶部常驻入口，不用先点城再滚到底 */
      if (typeof window.__slgWarWindow === 'function') window.__slgWarWindow({ tab: 'go' });
      else if (window.__slgToast) window.__slgToast('出征面板尚未就绪，请稍候', false);
    };
    document.getElementById('slgBtnHome').onclick = function () {
      if (window.__slgHomeWindow && lastState) window.__slgHomeWindow();
    };
    /* ★ 用户 ⑩：武将 / 战报在左侧坞与右侧六府各有一份，属重复入口。
       六府是它们的家（点开就是完整面板），左侧坞只保留沙盘动作，故此处移除。 */
    document.getElementById('slgStratTick').onclick = function () { window.__slgTick(); };
    // 滚轮缩放（以光标为锚）＋拖拽平移；轻点仍是选城
    canvas.style.cursor = 'grab';
    var drag = null;
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var old = viewScale(rect);
      var zoom = Math.max(1, Math.min(4, view.zoom * (ev.deltaY < 0 ? 1.15 : 0.87)));
      if (zoom === view.zoom && zoom === 1) return;
      var org = origin(rect);
      var wx = (mx - org[0]) / old, wy = (my - org[1]) / old;
      view.zoom = zoom;
      if (view.zoom === 1) { view.px = 0; view.py = 0; }
      else {
        var org2 = origin(rect);
        view.px += mx - (org2[0] + wx * viewScale(rect));
        view.py += my - (org2[1] + wy * viewScale(rect));
      }
      clampPan(rect);
      draw(lastState);
    }, { passive: false });
    canvas.addEventListener('mousedown', function (ev) {
      drag = { x: ev.clientX, y: ev.clientY, px: view.px, py: view.py, moved: false };
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (ev) {
      if (!drag) {
        if (ev.target === canvas && lastState) canvas.style.cursor = hitTarget(ev) ? 'pointer' : 'grab';
        return;
      }
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (drag.moved && view.zoom > 1) {
        view.px = drag.px + dx;
        view.py = drag.py + dy;
        clampPan(canvas.getBoundingClientRect());
        if (lastState) draw(lastState);
      }
    });
    window.addEventListener('mouseup', function (ev) {
      if (!drag) return;
      var moved = drag.moved;
      var isOnCanvas = ev.target === canvas;
      drag = null;
      canvas.style.cursor = 'grab';
      if (!moved && isOnCanvas) pickCity(ev);
    });
    loadDetail();
  }

  function showMap() {
    var ov = document.getElementById('slgStrategyOverlay');
    if (!ov) return;
    var legendEl = document.getElementById('slgLegend');
    if (legendEl) legendEl.style.display = 'block';
    if (!viewRestored) { viewRestored = true; loadViewSaved(); }
    if (ov.style.display === 'none') {
      ov.style.display = 'block';
      refresh();
      if (!timer) timer = setInterval(refresh, 5000);
    } else refresh();
  }

  window.__slgStrategyShow = showMap;
  /* ★ P11：城内页是整屏的，沙盘上的「推演」按钮被盖住，玩家在城里办完事
     被迫先退出去才能推进回合。两个入口共用同一实现，绝不各写一份。 */
  window.__slgTick = function () {
    return fetch('/__slg/strategy/tick', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        refresh();
        /* 城内页开着就地重绘，日/旬/本旬可征 立刻跟着变 */
        if (lastState && document.getElementById('slgCityPage')) {
          var cc = cityOf(lastState, currentCity);
          if (cc) renderCityPage(lastState, cc);
        }
        if (!window.__slgToast) return res;
        if (res.skipped) window.__slgToast('本回合已推演过，还需 ' + Math.max(1, res.need || 0) + ' 个游戏日', false);
        else window.__slgToast('推演至第 ' + (res.month || (res.turn || 0) + 1) + ' 月 · 游戏日 ' + res.day, true);
        return res;
      })
      .catch(function () { return null; });
  };
  /* ★ 验收 #23：战报「回跳」——把战报里的地名找回成地图上的城，居中并选中。
     战报的 place 是「襄陽城下」这类带后缀的字符串，所以按 id → 全名 → 包含 三级匹配。 */
  window.__slgFocusCity = function (nameOrId) {
    if (!lastState) return false;
    var key = String(nameOrId == null ? '' : nameOrId);
    if (!key) return false;
    var hit = null, i;
    for (i = 0; i < lastState.cities.length; i++) {
      if (String(lastState.cities[i].id) === key) { hit = lastState.cities[i]; break; }
    }
    for (i = 0; !hit && i < lastState.cities.length; i++) {
      if (lastState.cities[i].name === key) { hit = lastState.cities[i]; break; }
    }
    for (i = 0; !hit && i < lastState.cities.length; i++) {
      if (key.indexOf(lastState.cities[i].name) >= 0) { hit = lastState.cities[i]; break; }
    }
    if (!hit) return false;
    showMap();
    selectCity(hit);
    return true;
  };
  /* ★ P11 真鼠标验收：把战略城的投影坐标换算成屏幕坐标，供 Electron 的
     webContents.sendInputEvent 派发真实 mousePressed/mouseReleased。
     只做坐标换算，不代替点击——测试必须真的把鼠标按下去。 */
  window.__slgCityScreenPos = function (cityId) {
    if (!lastState || !canvas) return null;
    var c = null;
    for (var i = 0; i < lastState.cities.length; i++) {
      if (Number(lastState.cities[i].id) === Number(cityId)) { c = lastState.cities[i]; break; }
    }
    if (!c) return null;
    var rect = canvas.getBoundingClientRect();
    var o = origin(rect), s = viewScale(rect);
    var x = Math.round(rect.left + o[0] + c.x * s);
    var y = Math.round(rect.top + o[1] + c.y * s);
    return {
      x: x, y: y, id: c.id, name: c.name,
      inView: x > 20 && y > 20 && x < rect.right - 20 && y < rect.bottom - 20,
    };
  };
  window.__slgZoom = function (dir) {
    var rect = canvas.getBoundingClientRect();
    var zoom = Math.max(1, Math.min(4, view.zoom * (dir > 0 ? 1.25 : 0.8)));
    var org = origin(rect);
    var cx = rect.width / 2, cy = rect.height / 2;
    var wx = (cx - org[0]) / viewScale(rect), wy = (cy - org[1]) / viewScale(rect);
    view.zoom = zoom;
    if (zoom === 1) { view.px = 0; view.py = 0; }
    else {
      var org2 = origin(rect);
      view.px += cx - (org2[0] + wx * viewScale(rect));
      view.py += cy - (org2[1] + wy * viewScale(rect));
      clampPan(rect);
    }
    if (lastState) draw(lastState);
  };

  var lastFetchAt = 0;   // ★ P2：动画与服务器时钟对齐（拉取时刻起本地外推）
  var rafId = null;      // ★ P2：行军动画帧句柄
  var lastRafAt = 0;
  function refresh() {
    lastFetchAt = Date.now();
    fetch('/__slg/strategy/state').then(function (r) { return r.json(); }).then(function (s) {
      lastState = s; restorePick(); draw(s);
      if (window.__slgHudTick) window.__slgHudTick();
    }).catch(function () {});
  }

  var view = { zoom: 1, px: 0, py: 0 };
  function clampPan(rect) {
    var s = viewScale(rect);
    var maxX = Math.max(0, (MAP_W * s - rect.width) / 2 + 60);
    var maxY = Math.max(0, (MAP_H * s - rect.height) / 2 + 60);
    view.px = Math.max(-maxX, Math.min(maxX, view.px));
    view.py = Math.max(-maxY, Math.min(maxY, view.py));
  }
  function viewScale(rect) { return Math.min(rect.width / MAP_W, rect.height / MAP_H) * view.zoom; }
  function origin(rect) {
    var s = viewScale(rect);
    return [(rect.width - MAP_W * s) / 2 + view.px, (rect.height - MAP_H * s) / 2 + view.py];
  }

  /* ★ 验收 #18：视口与选中对象跨「模式切换 / 面板开关 / 刷新页面」保持。
     以前每次重开战略图都回到 fit 视图且选中清零，玩家放大到某郡再切出去一趟，
     回来就得重新找城——这属于「模式切换丢上下文」。
     口径：视口(zoom/px/py) + 选中城/关隘 存 sessionStorage（同标签页有效），
     只有玩家主动点「复位」才清空；选中城在城池数据到位后再回填（数据是异步来的）。 */
  var VIEW_KEY = 'slg.map.view';
  var viewRestored = false;
  var pendingPick = 0, pendingPass = '';
  function loadViewSaved() {
    try {
      var v = JSON.parse(window.sessionStorage.getItem(VIEW_KEY) || 'null');
      if (!v) return;
      var z = Number(v.zoom);
      if (z >= 1) {
        view.zoom = Math.max(1, Math.min(4, z));
        view.px = Number(v.px) || 0;
        view.py = Number(v.py) || 0;
        pendingPick = Number(v.cityId) || 0;
        pendingPass = String(v.pass || '');
      }
    } catch (e) { /* 隐私模式禁 sessionStorage 时静默降级：不影响地图 */ }
  }
  var lastSavedView = '';
  function saveView() {
    /* 选中城还没回填时先别写，否则下一次刷新会把待恢复的城覆盖成 0 */
    if (pendingPick || pendingPass) return;
    var json = JSON.stringify({
      zoom: Math.round(view.zoom * 1000) / 1000,
      px: Math.round(view.px), py: Math.round(view.py),
      cityId: picked ? picked.id : 0,
      pass: pickedPass ? pickedPass.name : '',
    });
    /* 行军时 draw 会以 ~20fps 重绘，值没变就不落盘 */
    if (json === lastSavedView) return;
    lastSavedView = json;
    try { window.sessionStorage.setItem(VIEW_KEY, json); } catch (e) { /* 同上 */ }
  }
  function clearViewSaved() {
    pendingPick = 0; pendingPass = '';
    try { window.sessionStorage.removeItem(VIEW_KEY); } catch (e) { /* 同上 */ }
  }
  /* 城池数据异步到：回填上次选中的城/关隘，并同步介绍面板 */
  function restorePick() {
    if (!lastState) return;
    if (pendingPick) {
      var id = pendingPick; pendingPick = 0;
      var c = null;
      for (var i = 0; i < lastState.cities.length; i++) {
        if (lastState.cities[i].id === id) { c = lastState.cities[i]; break; }
      }
      if (c) { picked = c; pickedPass = null; showIntro(c); }
    } else if (pendingPass) {
      var nm = pendingPass; pendingPass = '';
      var ps = (DETAIL && DETAIL.passes) || [];
      for (var j = 0; j < ps.length; j++) if (ps[j].name === nm) { showPassIntro(ps[j]); break; }
    }
  }

  /**
   * 命中按插画真实大小，不再把大都城的热区放大到盖住邻城和关隘。
   * 点在关隘图标上时关隘优先；重叠处取更靠近自身中心的那个。
   */
  function hitTarget(ev) {
    if (!lastState || !canvas) return null;
    var rect = canvas.getBoundingClientRect();
    var scale = viewScale(rect);
    var org = origin(rect);
    var x = (ev.clientX - rect.left - org[0]) / scale;
    var y = (ev.clientY - rect.top - org[1]) / scale;
    var best = null, bestScore = Infinity;
    function take(score, item) {
      if (score < bestScore) { bestScore = score; best = item; }
    }
    for (var i = 0; i < lastState.cities.length; i++) {
      var c = lastState.cities[i];
      var info = cityInfo(c) || {};
      var hw = (info.w || 52) / 2;
      var hh = (info.h || 40) / 2;
      if (hw < 1 || hh < 1) continue;
      var nx = Math.abs(c.x - x) / hw;
      var ny = Math.abs(c.y - y) / hh;
      if (nx > 1 || ny > 1) continue;
      take(Math.hypot(nx, ny), { kind: 'city', city: c });
    }
    if (LAYER.pass && DETAIL && DETAIL.passes) {
      for (var j = 0; j < DETAIL.passes.length; j++) {
        var p = DETAIL.passes[j];
        var icon = (p.size || 31) / 2;
        var r = icon + 6;
        var d = Math.hypot(p.x - x, p.y - y);
        if (d > r) continue;
        take(d <= icon ? d / (icon * 2) : d / r, { kind: 'pass', pass: p });
      }
    }
    return best;
  }

  function pickCity(ev) {
    var hit = hitTarget(ev);
    if (!hit) {
      picked = null;
      pickedPass = null;
      if (lastState) draw(lastState);
      showIntro(null);
      return;
    }
    if (hit.kind === 'pass') {
      showPassIntro(hit.pass);
      if (lastState) draw(lastState);
      return;
    }
    pickedPass = null;
    picked = hit.city;
    if (lastState) draw(lastState);
    /* ★ P11：点城即「进城」。不再同时弹一张介绍小卡 + 一个右侧浮窗，
       那两张和六府/透镜叠在一起正是「桌面杂乱」的来源。 */
    if (introPanel) introPanel.style.display = 'none';
    if (window.__slgCityInterior) window.__slgCityInterior(hit.city.id);
    else if (window.__slgCityWindow) window.__slgCityWindow(hit.city.id);
  }

  function showPassIntro(p) {
    pickedPass = p || null;
    picked = null;
    if (!introPanel || !p) return;
    var status = (DETAIL.march && DETAIL.march.gateStatus && DETAIL.march.gateStatus[p.name]) || p.status || '通行';
    var blocked = status === '封锁';
    introPanel.style.display = 'block';
    introPanel.innerHTML = '<div style="display:flex;align-items:baseline;gap:8px;">'
      + '<b style="font:19px "KaiTi","STKaiti",serif;color:#f0d998;letter-spacing:2px;">' + p.name + '</b>'
      + '<span style="color:' + (blocked ? '#ff6b5e' : '#8fb98a') + ';font-size:12px;">' + status + '</span>'
      + '<span style="flex:1"></span>'
      + '<span data-close="1" style="cursor:pointer;color:#8f8676;">✕</span></div>'
      + '<div style="height:1px;background:rgba(186,154,82,.25);margin:6px 0 5px;"></div>'
      + kvRow('形制', p.kind)
      + kvRow('今地', p.today)
      + kvRow('扼守', p.guard)
      + kvRow('关联道路', p.road)
      + kvRow('两端', (p.ends || []).join(' ↔ '))
      + '<div style="margin-top:7px;color:#9c9382;font-size:11.5px;">沿革</div>'
      + '<div style="color:#cfc2a6;line-height:1.85;">' + (p.evolution || p.guard || '此地无载。') + '</div>'
      + '<div class="cost" style="margin-top:8px;color:#9c9382;line-height:1.75;">'
      + (blocked ? '此关已封锁，前后两段同时禁行。' : '此关通行，行军须经其前后两段，不可绕越。')
      + '</div>';
    var closeBtn = introPanel.querySelector('[data-close]');
    if (closeBtn) closeBtn.onclick = function () {
      introPanel.style.display = 'none';
      picked = null;
      pickedPass = null;
      if (lastState) draw(lastState);
    };
  }

  var sidePanel = null, introPanel = null;

  function buildSidebar() {
    sidePanel = document.createElement('div');
    sidePanel.id = 'slgStratSide';
    sidePanel.style.cssText = 'position:absolute;left:12px;top:52px;z-index:4;width:212px;'
      + 'background:rgba(14,15,11,0.9);border:1px solid rgba(186,154,82,0.45);border-radius:8px;'
      + 'padding:9px 12px 11px;color:#e2d6ba;font:13px/1.7 "Microsoft YaHei",sans-serif;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.45);text-align:left;';
    var head = document.createElement('div');
    head.style.cssText = 'color:#e8c670;font-weight:bold;letter-spacing:2px;text-align:left;'
      + 'border-bottom:1px solid rgba(186,154,82,0.25);padding-bottom:5px;margin-bottom:6px;'
      + 'display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;';
    head.innerHTML = '<span>图层与检索</span>'
      + '<button data-lgside="hide" title="隐藏本面板（可从左上「浮窗」再打开）" '
      + 'style="background:transparent;color:#c8b88a;border:1px solid rgba(186,154,82,.4);'
      + 'border-radius:4px;padding:0 6px;cursor:pointer;font:11px/1.6 &quot;Microsoft YaHei&quot;,sans-serif;">✕</button>';
    sidePanel.appendChild(head);
    head.querySelector('[data-lgside="hide"]').onclick = function (ev) {
      ev.stopPropagation();
      if (window.__slgShell && window.__slgShell.float) window.__slgShell.float('side', false);
      else document.documentElement.setAttribute('data-slg-float-side', 'off');
    };

    /* ★ 用户 ⑦：去掉「十三州水墨底图」「十三州部古名」两项——
       底图是地图本体（关掉只剩空白），古名层已废弃，两者都不该出现在图层列表里。
       列表只留真正可切换的四层。 */
    var LAYER_LABEL = [
      ['road', '分级路网'], ['city', '城池模型'],
      ['pass', '八处关隘'], ['name', '城名标注'],
    ];
    LAYER_LABEL.forEach(function (pair) {
      var lab = document.createElement('label');
      lab.style.cssText = 'display:block;cursor:pointer;line-height:2;text-align:left;color:#e2d6ba;';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!LAYER[pair[0]];
      cb.style.cssText = 'vertical-align:-2px;margin-right:7px;accent-color:#9c3a2c;';
      cb.onchange = function () {
        LAYER[pair[0]] = cb.checked;
        if (lastState) draw(lastState);
      };
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(pair[1]));
      sidePanel.appendChild(lab);
    });

    var title2 = document.createElement('div');
    title2.style.cssText = 'color:#e8c670;font-weight:bold;letter-spacing:2px;text-align:left;'
      + 'border-bottom:1px solid rgba(186,154,82,0.25);padding:8px 0 5px;margin-bottom:6px;';
    title2.textContent = '检索城池 / 关隘';
    sidePanel.appendChild(title2);

    var input = document.createElement('input');
    input.id = 'slgStratFind';
    input.type = 'search';
    input.placeholder = '输入城名或关名，如 长安 / 武关';
    input.setAttribute('list', 'slgStratCityList');
    input.style.cssText = 'width:100%;padding:5px 8px;border:1px solid rgba(186,154,82,0.45);'
      + 'border-radius:4px;background:#0f1109;color:#e6dac0;font:12.5px "Microsoft YaHei",sans-serif;';
    var datalist = document.createElement('datalist');
    datalist.id = 'slgStratCityList';
    sidePanel.appendChild(input);
    sidePanel.appendChild(datalist);

    input.addEventListener('input', function () {
      var key = String(input.value || '').trim();
      if (!key || !lastState) return;
      var hit = null;
      for (var i = 0; i < lastState.cities.length; i++) {
        var c = lastState.cities[i];
        if (c.name === key) { hit = c; break; }
        if (!hit && c.name.indexOf(key) >= 0) hit = c;
      }
      if (hit) { selectCity(hit); return; }
      // 关隘也能检索：选中后居中并展开扼守说明
      var passes = (DETAIL && DETAIL.passes) || [];
      for (var j = 0; j < passes.length; j++) {
        if (passes[j].name === key) {
          picked = null;
          focusOn(passes[j].x, passes[j].y, 2.2);
          showPassIntro(passes[j]);
          if (lastState) draw(lastState);
          return;
        }
      }
    });

    var hint = document.createElement('div');
    hint.style.cssText = 'font-size:11.5px;line-height:1.75;color:#9c9382;margin-top:7px;text-align:left;';
    hint.innerHTML = '滚轮缩放 · 拖动平移 · 点城看介绍 · 点关隘看扼守'
      + '<br><span style="opacity:.75">放大后城名变多：1× 只标要城，1.8× 补郡治，2.8× 全标。</span>';
    sidePanel.appendChild(hint);

    overlay.appendChild(sidePanel);
  }

  function selectCity(c) {
    if (!c) return;
    picked = c;
    pickedPass = null;
    focusOn(c.x, c.y, 2.2);
    showIntro(c);
    if (lastState) draw(lastState);
  }

  function focusOn(x, y, k) {
    view.zoom = Math.max(1, Math.min(4, k || 1));
    var rect = canvas.getBoundingClientRect();
    var s = Math.min(rect.width / MAP_W, rect.height / MAP_H) * view.zoom;
    view.px = (MAP_W / 2 - x) * s;
    view.py = (MAP_H / 2 - y) * s;
    clampPan(rect);
  }

  function buildIntro() {
    introPanel = document.createElement('div');
    introPanel.id = 'slgStratIntro';
    introPanel.style.cssText = 'position:absolute;left:236px;top:52px;z-index:4;width:300px;display:none;'
      + 'background:rgba(14,15,11,0.92);border:1px solid rgba(186,154,82,0.45);border-radius:8px;'
      + 'padding:10px 13px 12px;color:#e2d6ba;font:12.5px/1.8 "Microsoft YaHei",sans-serif;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.45);text-align:left;'
      + 'max-height:calc(100vh - 330px);overflow-y:auto;';
    overlay.appendChild(introPanel);
  }

  function kvRow(k, v) {
    if (v == null || v === '') return '';
    return '<div style="display:flex;gap:8px;text-align:left;border-bottom:1px dotted rgba(186,154,82,.2);padding:2px 0;">'
      + '<span style="flex:0 0 62px;color:#9c9382;">' + k + '</span>'
      + '<span style="flex:1;color:#e6dac0;">' + v + '</span></div>';
  }

  function showIntro(c) {
    if (!introPanel) return;
    if (!c) { introPanel.style.display = 'none'; return; }
    pickedPass = null;
    var info = cityInfo(c) || {};
    introPanel.style.display = 'block';
    introPanel.innerHTML = '<div style="display:flex;align-items:baseline;gap:8px;">'
      + '<b style="font:19px "KaiTi","STKaiti",serif;color:#f0d998;letter-spacing:2px;">' + c.name + '</b>'
      + '<span style="color:' + c.color + ';font-size:12px;">' + c.ownerName + '</span>'
      + '<span style="flex:1"></span>'
      + '<span data-close="1" style="cursor:pointer;color:#8f8676;">✕</span></div>'
      + '<div style="height:1px;background:rgba(186,154,82,.25);margin:6px 0 5px;"></div>'
      + kvRow('等级', 'Lv' + c.level + (c.adminLevel ? '　' + c.adminLevel : ''))
      + kvRow('州郡', c.province + (info.jun ? ' · ' + info.jun : ''))
      + kvRow('今地', info.today)
      + kvRow(c.owner === 'player' ? '驻城兵' : '守军', String(c.owner === 'player' ? (c.troopSum || 0) : (c.troops || 0)))
      + kvRow('人口', c.population ? String(c.population) : '')
      + kvRow('地形', c.terrain)
      + kvRow('特产', c.specialty)
      + kvRow('主要兵种', c.arms)
      + cityLogHtml(c)
      + '<div style="margin-top:7px;color:#9c9382;font-size:11.5px;">史略</div>'
      + '<div style="color:#cfc2a6;line-height:1.85;">' + (info.history || c.history || '此地无载。') + '</div>'
      + '<div style="margin-top:9px;display:flex;gap:6px;">'
      + '<button data-go="1" style="background:rgba(109,83,32,.9);color:#ffe9b0;border:1px solid #a8863e;'
      + 'border-radius:4px;padding:3px 12px;cursor:pointer;font:12px "Microsoft YaHei",sans-serif;">城池详情</button>'
      + '</div>';
    var closeBtn = introPanel.querySelector('[data-close]');
    if (closeBtn) closeBtn.onclick = function () {
      introPanel.style.display = 'none';
      picked = null;
      pickedPass = null;
      if (lastState) draw(lastState);
    };
    var goBtn = introPanel.querySelector('[data-go]');
    if (goBtn) goBtn.onclick = function () {
      if (window.__slgCityWindow) window.__slgCityWindow(c.id);
    };
  }

  /* 十六进制色 → rgba 字符串（画势力范围柔光用，canvas 不认 #rrggbbaa） */
  function tintA(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return 'rgba(138,122,82,' + a + ')';
    var v = parseInt(m[1], 16);
    return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
  }

  /* ---------------- 势力面板（原「势力图例」升级） ----------------
   * ★ 用户 ⑪：势力面板要能「选不同势力看情报、看势力范围」，并且这个面板可以不显示。
   *   - 数据取 s.diplomacy.factions（服务端 diplomacyView 下发的态度/兵力/都城/简介），
   *     取不到就退回 s.factions（只有名与色），绝不自己编数字；
   *   - 点一个势力 = 在地图上铺它的势力范围 + 下方展开情报卡；再点一次取消；
   *   - 面板自身的显示/隐藏走外壳那套 html[data-slg-float-legend]，
   *     与 图层/透镜/事务 一视同仁（见 ui-shell.js 的 FLOATS）。
   * 另外：draw() 在行军时以 20fps 重绘，原来每帧都 innerHTML 重建整块图例
   *   （13 条 + 合规声明），既费 CPU 又会吃掉点击。这里用签名比对，只有内容变了才重建。
   */
  var legendSel = '', legendSig = '', legendFold = false;

  function renderLegend(s) {
    var box = document.getElementById('slgLegend');
    if (!box || !s) return;
    var dip = (s.diplomacy && s.diplomacy.factions) || [];
    var mine = (s.cities || []).filter(function (c) { return String(c.owner) === 'player'; });
    var sig = [legendSel, legendFold, s.turn, s.day, (s.cities || []).length,
      dip.map(function (f) { return [f.id, f.attitude, f.troops, f.homeCity, f.truceUntil].join(':'); }).join(','),
      mine.length].join('|');
    if (sig === legendSig) return;
    legendSig = sig;

    var countOf = function (fid) {
      return (s.cities || []).filter(function (c) { return String(c.owner) === String(fid); }).length;
    };
    var troopOf = function (fid) {
      var t = 0;
      (s.cities || []).forEach(function (c) { if (String(c.owner) === String(fid)) t += Number(c.troops) || 0; });
      return t;
    };
    var shortN = function (n) { return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); };

    var rows = '';
    var addRow = function (fid, name, color, extra, sub) {
      var on = String(legendSel) === String(fid);
      rows += '<button class="lg-row' + (on ? ' on' : '') + '" data-fid="' + esc(fid) + '"'
        + ' title="' + esc(name + '：城 ' + countOf(fid) + ' 座') + '">'
        + '<i style="background:' + esc(color || '#8a8a8a') + '"></i>'
        + '<b>' + esc(name) + '</b>'
        + '<span class="lg-n">' + countOf(fid) + ' 城 · ' + shortN(troopOf(fid)) + '</span>'
        + (extra ? '<em>' + esc(extra) + '</em>' : '')
        + (sub ? '<span class="lg-s">' + esc(sub) + '</span>' : '')
        + '</button>';
    };
    /* 态度定性：>30 亲善 / <-30 敌视，中间为中立；交战与同盟优先。
       列表与情报卡必须同一套口径（原来列表用文字、情报卡印裸数字「态度 3」）。 */
    var attTag = function (f) {
      var a = Number(f && f.attitude) || 0;
      return f && f.war ? '交战' : (f && f.ally ? '同盟' : (a >= 30 ? '亲善' : (a <= -30 ? '敌视' : '中立')));
    };
    var attNum = function (f) { var a = Number(f && f.attitude) || 0; return (a > 0 ? '+' : '') + a; };
    addRow('player', '我军', '#e8c670', '', '');
    dip.forEach(function (f) {
      addRow(f.id, f.name, f.color, attTag(f), '');
    });
    /* 汉廷等无主城势力（有城才算版图，没城就不列，避免空行） */
    var html = '<div class="lg-head"><span>势力 · 版图</span>'
      + '<span class="lg-btns">'
      + '<button data-lg="fold" title="' + (legendFold ? '展开列表' : '只留标题') + '">'
      + (legendFold ? '▣' : '－') + '</button>'
      + '<button data-lg="hide" title="隐藏势力面板（可从左上「浮窗」再打开）">✕</button>'
      + '</span></div>';
    if (!legendFold) {
      html += '<div class="lg-list">' + rows + '</div>';
      /* 选中势力 → 情报卡 */
      if (legendSel) {
        var f2 = legendSel === 'player' ? null
          : dip.filter(function (x) { return String(x.id) === String(legendSel); })[0];
        var name2 = legendSel === 'player' ? '我军' : (f2 ? f2.name : legendSel);
        var hold = (s.cities || []).filter(function (c) { return String(c.owner) === String(legendSel); })
          .slice(0, 10).map(function (c) { return c.name; });
        html += '<div class="lg-detail">'
          + '<div class="lg-dt">' + esc(name2) + ' · 势力范围</div>';
        if (f2) {
          /* homeCity 是城市 id，home 才是城名；先按 id 查名，查不到再用配置里的名字 */
          var homeName = '';
          (s.cities || []).forEach(function (c) { if (String(c.id) === String(f2.homeCity)) homeName = c.name; });
          if (!homeName) homeName = f2.home || (f2.homeCity ? ('城#' + f2.homeCity) : '—');
          var hisTroops = Number(f2.troops) || 0;
          /* 都城被夺时说清「已失」，别让上面刚说「暂无城池」下面又报都城名 */
          var holdCount = countOf(legendSel);
          html += '<div>都城　' + esc(homeName) + (holdCount ? '' : '（已失）')
            + '　态度　' + attNum(f2) + '（' + attTag(f2) + '）</div>'
            + '<div>兵力　' + shortN(hisTroops)
            + (hisTroops > 0 ? ('　我/他 ' + (Number(f2.troopsRatio) || 0) + ' 倍') : '　（已无兵）')
            + '</div>'
            + (f2.intel ? '<div>情报档　' + f2.intel + ' 级（派斥候可提升）</div>' : '')
            + (f2.blurb ? '<div class="lg-blurb">' + esc(f2.blurb) + '</div>' : '');
        } else {
          html += '<div>城池　' + mine.length + ' 座　兵力 '
            + shortN(mine.reduce(function (a, c) { return a + (Number(c.troops) || 0); }, 0)) + '</div>';
        }
        html += '<div class="lg-hold">所辖：' + (hold.length ? esc(hold.join('、')) : '暂无城池')
          + (countOf(legendSel) > hold.length ? ' 等 ' + countOf(legendSel) + ' 座' : '') + '</div>'
          + '<button class="lg-clear" data-lg="clear">取消选中（移开势力范围）</button>'
          + '</div>';
      }
      html += '<div class="lg-foot">点势力名看情报与版图；金环＝本城。'
        + '本图为游戏示意图（等距圆柱投影），非标准行政地图。</div>';
    }
    box.innerHTML = html;
    /* 选中势力后面板会变长，情报卡常在折线下——自动滚到能看见为止（只读，不改选中） */
    var dtEl = box.querySelector('.lg-detail');
    if (dtEl) {
      var br = box.getBoundingClientRect(), dr = dtEl.getBoundingClientRect();
      if (dr.bottom > br.bottom - 4) box.scrollTop = box.scrollHeight;
    }

    Array.prototype.forEach.call(box.querySelectorAll('[data-lg]'), function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var act = b.getAttribute('data-lg');
        if (act === 'fold') { legendFold = !legendFold; legendSig = ''; if (lastState) draw(lastState); return; }
        if (act === 'hide') {
          if (window.__slgShell && window.__slgShell.float) window.__slgShell.float('legend', false);
          else document.documentElement.setAttribute('data-slg-float-legend', 'off');
          return;
        }
        if (act === 'clear') { legendSel = ''; legendSig = ''; if (lastState) draw(lastState); }
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('.lg-row'), function (b) {
      b.onclick = function () {
        var fid = b.getAttribute('data-fid');
        legendSel = String(legendSel) === String(fid) ? '' : fid;
        legendSig = '';
        if (lastState) draw(lastState);
      };
    });
  }

  function draw(s) {
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width; canvas.height = rect.height;
    var g = canvas.getContext('2d');
    var scale = viewScale(rect);
    var org = origin(rect);
    var ox = org[0], oy = org[1];
    function P(p) { return [ox + p[0] * scale, oy + p[1] * scale]; }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#e4d3c6';
    g.fillRect(0, 0, rect.width, rect.height);

    // 底图只用水墨层。全景合成图里已经画了路，不能拿来当底，否则调色会把线路一起洗掉。
    // 底图现在恒绘（不再有开关）：它是地图本体，不是可选装饰。
    var hasLayers = !!(DETAIL && DETAIL.layers);
    var baseImg = hasLayers && DETAIL.layers.base
      ? ensureImg('layer:base', layerUrl(DETAIL.layers.base)) : null;
    if (baseImg) {
      g.drawImage(baseImg, ox, oy, MAP_W * scale, MAP_H * scale);
    } else {
      g.fillStyle = '#efe3cb';
      g.fillRect(ox, oy, MAP_W * scale, MAP_H * scale);
    }

    // 选中时只把底图调浅：路网、城池、关隘都还没画，染底色不会把线路卷进去。
    var focus = picked || pickedPass;
    if (focus && baseImg) {
      g.save();
      g.globalCompositeOperation = 'screen';
      g.fillStyle = 'rgba(255, 246, 226, 0.30)';
      g.fillRect(ox, oy, MAP_W * scale, MAP_H * scale);
      g.restore();
      var fq = P([focus.x, focus.y]);
      var wash = g.createRadialGradient(fq[0], fq[1], 16 * scale, fq[0], fq[1], 420 * scale);
      wash.addColorStop(0, 'rgba(255, 248, 230, 0.40)');
      wash.addColorStop(0.45, 'rgba(247, 232, 204, 0.14)');
      wash.addColorStop(1, 'rgba(247, 232, 204, 0)');
      g.fillStyle = wash;
      g.fillRect(ox, oy, MAP_W * scale, MAP_H * scale);
    }
    // 纸边轻轻沉一圈，仍然只压在底图上
    var vcx = ox + MAP_W * scale / 2, vcy = oy + MAP_H * scale / 2;
    var vr = Math.hypot(MAP_W, MAP_H) * scale * 0.52;
    var vig = g.createRadialGradient(vcx, vcy, vr * 0.58, vcx, vcy, vr);
    vig.addColorStop(0, 'rgba(92, 64, 40, 0)');
    vig.addColorStop(1, 'rgba(92, 64, 40, 0.13)');
    g.fillStyle = vig;
    g.fillRect(ox, oy, MAP_W * scale, MAP_H * scale);

    function drawLayer(key) {
      var pth = LAYER[key] && hasLayers ? DETAIL.layers[key] : null;
      if (!pth) return null;
      var im = ensureImg('layer:' + key, layerUrl(pth));
      if (im) g.drawImage(im, ox, oy, MAP_W * scale, MAP_H * scale);
      return im;
    }
    function paintSelection(layerImg, sx, sy, sw, sh, mode) {
      var iw = layerImg.naturalWidth, ih = layerImg.naturalHeight;
      var x0 = Math.max(0, sx), y0 = Math.max(0, sy);
      var x1 = Math.min(iw, sx + sw), y1 = Math.min(ih, sy + sh);
      if (x1 - x0 < 2 || y1 - y0 < 2) return;
      var tinted = tintCrop(layerImg, x0, y0, x1 - x0, y1 - y0, mode);
      if (!tinted) return;
      var q = P([x0, y0]);
      var dw = (x1 - x0) * scale, dh = (y1 - y0) * scale;
      g.save();
      g.shadowColor = mode === 'pass' ? 'rgba(29,94,142,0.88)' : 'rgba(208,73,44,0.82)';
      g.shadowBlur = Math.max(8, 14 * scale);
      g.drawImage(tinted, q[0], q[1], dw, dh);
      g.restore();
      g.drawImage(tinted, q[0], q[1], dw, dh);
    }

    /* ★ 用户 ⑪：选中势力后画出「势力范围」——每座属城铺一团同色柔光 + 虚线界圈，
       同色连成片即版图。画在路网与城池之前，不遮路、不挡城名。 */
    if (legendSel) {
      var fcol = '#8a7a52';
      var fcities = s.cities.filter(function (c) { return String(c.owner) === String(legendSel); });
      if (fcities.length && fcities[0].color) fcol = fcities[0].color;
      g.save();
      fcities.forEach(function (c) {
        var q = P([c.x, c.y]);
        var rr = Math.max(46, 104 * scale);
        var rg = g.createRadialGradient(q[0], q[1], 2, q[0], q[1], rr);
        rg.addColorStop(0, tintA(fcol, 0.34));
        rg.addColorStop(0.6, tintA(fcol, 0.15));
        rg.addColorStop(1, tintA(fcol, 0));
        g.fillStyle = rg;
        g.beginPath(); g.arc(q[0], q[1], rr, 0, 6.2832); g.fill();
        g.beginPath();
        g.arc(q[0], q[1], Math.max(16, 30 * scale), 0, 6.2832);
        g.setLineDash([5 * scale, 4 * scale]);
        g.strokeStyle = tintA(fcol, 0.78);
        g.lineWidth = Math.max(1.2, 1.6 * scale);
        g.stroke();
        g.setLineDash([]);
      });
      g.restore();
    }

    // 旧「十三州部古名」层（layer_zhou）已废弃，不再绘制
    drawLayer('road');

    // 城池按原大贴上。选中只染这一座插画，裁剪不放大，免得把邻城一起染红。
    var cityImg = drawLayer('city');
    if (cityImg && picked) {
      var selInfo = cityInfo(picked) || {};
      var sw = (selInfo.w || 52) + 6, sh = (selInfo.h || 40) + 6;
      paintSelection(cityImg, picked.x - sw / 2, picked.y - sh / 2, sw, sh, 'city');
    }

    // 本城金环贴在插画脚下，不框选
    s.cities.forEach(function (c) {
      if (s.playerCity !== c.id) return;
      var q = P([c.x, c.y]);
      var bh = ((cityInfo(c) || {}).h || 40) * scale;
      g.beginPath();
      g.arc(q[0], q[1] + bh * 0.38, Math.max(3.5, 5.5 * scale), 0, 6.2832);
      g.strokeStyle = 'rgba(232, 198, 112, 0.95)';
      g.lineWidth = Math.max(1.25, 1.4 * scale);
      g.stroke();
    });

    // ★ P0-1：势力旗帜——燕尾旗插在城池插画上方，旗面 = 势力色 + 诸侯姓氏单字。
    //   玩家本城旗更大、金描边；无主城灰旗无字。画在城名之前，名字始终在最上层。
    s.cities.forEach(function (c) {
      var info = cityInfo(c) || {};
      var q = P([c.x, c.y]);
      var footY = q[1] - (info.h || 40) * scale * 0.5;
      var isPlayer = s.playerCity === c.id;
      var poleH = Math.max(12, (isPlayer ? 30 : 24) * scale);
      var fw = poleH * 1.15, fh = poleH * 0.52, tail = fh * 0.42;
      var topY = footY - poleH;
      var neutral = !c.ownerName || (s.neutral && c.ownerName === s.neutral.name);
      g.save();
      g.strokeStyle = isPlayer ? '#e8c670' : 'rgba(58,42,26,.9)';
      g.lineWidth = Math.max(1, 1.6 * scale);
      g.beginPath(); g.moveTo(q[0], footY); g.lineTo(q[0], topY); g.stroke();
      g.fillStyle = isPlayer ? '#ffd98a' : '#d9c08a';
      g.beginPath(); g.arc(q[0], topY, Math.max(1.2, 1.8 * scale), 0, 6.2832); g.fill();
      // 燕尾旗面：飞端内凹 V 口
      g.beginPath();
      g.moveTo(q[0], topY);
      g.lineTo(q[0] + fw, topY);
      g.lineTo(q[0] + fw - tail, topY + fh / 2);
      g.lineTo(q[0] + fw, topY + fh);
      g.lineTo(q[0], topY + fh);
      g.closePath();
      g.fillStyle = c.color || '#8a8a8a';
      g.globalAlpha = 0.92;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = isPlayer ? 'rgba(232,198,112,.95)' : 'rgba(30,24,14,.55)';
      g.lineWidth = isPlayer ? Math.max(1.2, 1.6 * scale) : Math.max(0.8, 1 * scale);
      g.stroke();
      var ch = neutral ? '' : String(c.ownerName || '').charAt(0);
      if (ch && fh >= 9) {
        var cx = q[0] + fw * 0.42, cy = topY + fh / 2;
        g.font = Math.min(14, fh * 0.72).toFixed(1) + 'px "KaiTi","STKaiti","SimSun",serif';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
        g.lineWidth = Math.max(1, 2 * scale);
        g.strokeStyle = 'rgba(0,0,0,.55)';
        g.strokeText(ch, cx, cy);
        g.fillStyle = '#f7efdb';
        g.fillText(ch, cx, cy);
      }
      g.restore();
    });

    // 关隘贴图里地名带方底，只抠图标本身；地名改用描边文字
    var passImg = (LAYER.pass && hasLayers && DETAIL.layers.pass)
      ? ensureImg('layer:pass', layerUrl(DETAIL.layers.pass)) : null;
    if (passImg && DETAIL.passes) {
      DETAIL.passes.forEach(function (p) {
        var s0 = p.size || 31;
        var x0 = Math.max(0, p.x - s0 / 2), y0 = Math.max(0, p.y - s0 / 2);
        var x1 = Math.min(passImg.naturalWidth, p.x + s0 / 2);
        var y1 = Math.min(passImg.naturalHeight, p.y + s0 / 2);
        if (x1 - x0 < 2 || y1 - y0 < 2) return;
        var pq = P([x0, y0]);
        g.drawImage(passImg, x0, y0, x1 - x0, y1 - y0, pq[0], pq[1], (x1 - x0) * scale, (y1 - y0) * scale);
      });
    }
    if (passImg && pickedPass) {
      var ps = pickedPass.size || 31;
      paintSelection(passImg, pickedPass.x - ps / 2, pickedPass.y - ps / 2, ps, ps, 'pass');
    }

    function inkText(text, mx, my, opt) {
      var q = P([mx, my]);
      var px = (opt.size || 15) * scale;
      g.font = (opt.bold ? '700 ' : '') + px.toFixed(1) + 'px "KaiTi","STKaiti","SimSun",serif';
      g.textAlign = opt.align || 'left';
      g.textBaseline = opt.baseline || 'alphabetic';
      g.lineJoin = 'round';
      g.miterLimit = 2;
      g.lineWidth = Math.max(1, (opt.strokeWidth || 3) * scale);
      g.strokeStyle = opt.stroke;
      g.strokeText(text, q[0], q[1]);
      g.fillStyle = opt.fill;
      g.fillText(text, q[0], q[1]);
    }
    // 城名不再贴带方底的图层，按预览图用楷体描边；选中时字色加深
    // ★ 验收 #22：城名密度随缩放分级——1× 只标要城与本城，1.8× 补中城，2.8× 全标；
    //   同档内再按屏幕占位去重：重要的先占位，小城与已占位标签挤在一起就让位。
    //   口径（哪座城算要城）由服务端 labelRank 给，客户端只管「当前缩放到第几档」。
    if (LAYER.name) {
      var pol = s.labelPolicy || { tiers: [{ zoom: 1, rank: 1 }], minGap: 34 };
      var tier = 1;
      for (var ti = 0; ti < pol.tiers.length; ti++) {
        if (view.zoom >= pol.tiers[ti].zoom - 1e-6) tier = pol.tiers[ti].rank;
      }
      var minGap = (pol.minGap || 34) * scale;
      var lq = [];
      s.cities.forEach(function (c) {
        var on0 = !!(picked && picked.id === c.id);
        var home0 = s.playerCity === c.id;
        var rk = c.labelRank || (c.level >= 3 ? 1 : (c.level === 2 ? 2 : 3));
        if (!on0 && !home0 && rk > tier) return;
        lq.push({ c: c, on: on0, rk: rk, pri: on0 ? 0 : (home0 ? 1 : rk) });
      });
      lq.sort(function (a, b) { return a.pri - b.pri; });
      var placed = [];
      lq.forEach(function (it) {
        var c = it.c;
        var info = cityInfo(c) || {};
        var lf = c.level >= 3 ? 23 : (c.level === 2 ? 19 : 15);
        var q = P([c.x, c.y + (info.h || 40) / 2 + 2]);
        var lw = String(c.name).length * lf * scale * 0.56;
        var lh = lf * scale * 0.92;
        // 选中 / 本城永不被挤掉，其余按占位避让
        if (it.pri > 1) {
          for (var pi = 0; pi < placed.length; pi++) {
            var bp = placed[pi];
            if (Math.abs(bp.x - q[0]) < Math.max(minGap, (bp.w + lw) / 2)
              && Math.abs(bp.y - q[1]) < Math.max(minGap * 0.55, lh)) return;
          }
        }
        placed.push({ x: q[0], y: q[1], w: lw });
        var on = it.on;
        inkText(c.name, c.x, c.y + (info.h || 40) / 2 + 2, {
          size: lf, align: 'center', baseline: 'top', bold: on,
          fill: on ? '#c0392b' : (c.level >= 3 ? '#922c20' : (c.level === 2 ? '#704e26' : '#3a4c3a')),
          stroke: on ? '#fff4dc' : '#f7efdb',
          strokeWidth: on ? 4 : 3
        });
      });
    }
    // ★ P2：行军线与移动军标——departDay/arriveDay + 日内进度插值，路径优先走既有道路折线
    if (s.marches && s.marches.length) {
      var byId = {};
      s.cities.forEach(function (cc) { byId[cc.id] = cc; });
      var msPerDay = s.msPerDay || 15000;
      var dayNow = (s.day || 1) + (s.dayFrac || 0) + (Date.now() - lastFetchAt) / msPerDay;
      s.marches.forEach(function (mm) {
        var a = byId[mm.from], b = byId[mm.to];
        if (!a || !b) return;
        /* ★ U12：诸侯行军同样画在地图上，但用敌红区分；玩家军仍是金色 */
        var isFoe = !!mm.side && mm.side !== 'player';
        var cWalk = isFoe ? 'rgba(225,92,72,.95)' : 'rgba(232,198,112,.9)';
        var cRest = isFoe ? 'rgba(225,92,72,.45)' : 'rgba(232,198,112,.45)';
        var cFlag = isFoe ? '#e15c48' : '#e8c670';
        var span = Math.max(1, mm.arriveDay - mm.departDay);
        var p = Math.max(0, Math.min(1, (dayNow - mm.departDay) / span));
        var pts = [[a.x, a.y], [b.x, b.y]];
        var rts = s.routes || [];
        for (var ri = 0; ri < rts.length; ri++) {
          var rt = rts[ri];
          if ((rt.from === mm.from && rt.to === mm.to) || (rt.from === mm.to && rt.to === mm.from)) {
            if (rt.points && rt.points.length >= 2) { pts = rt.points; }
            break;
          }
        }
        var segs = [], total = 0;
        for (var i = 0; i < pts.length - 1; i++) {
          var L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
          segs.push(L); total += L;
        }
        var walked = p * total;
        var cur = [pts[0][0], pts[0][1]];
        var acc = 0, closed = false, tang = null;
        g.save();
        // 已走部分：实线（玩家金色 / 诸侯敌红）
        g.strokeStyle = cWalk;
        g.lineWidth = Math.max(1.6, 2.2 * scale);
        g.beginPath();
        var q0 = P(pts[0]);
        g.moveTo(q0[0], q0[1]);
        for (var i = 0; i < segs.length; i++) {
          var p0 = pts[i], p1 = pts[i + 1], L2 = segs[i];
          if (acc + L2 <= walked) {
            var q1 = P(p1);
            g.lineTo(q1[0], q1[1]);
            cur = [p1[0], p1[1]]; acc += L2;
            tang = [p1[0] - p0[0], p1[1] - p0[1]];
          } else {
            var t = L2 > 0 ? (walked - acc) / L2 : 0;
            cur = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
            tang = [p1[0] - p0[0], p1[1] - p0[1]];
            var qc = P(cur);
            g.lineTo(qc[0], qc[1]);
            g.stroke();
            // 未走部分：同色虚线（相位随时间走，像一队人还在往前挪）
            g.setLineDash([6 * scale, 5 * scale]);
            g.lineDashOffset = -((Date.now() / 55) % (11 * scale));
            g.strokeStyle = cRest;
            g.lineWidth = Math.max(1.2, 1.6 * scale);
            g.beginPath();
            g.moveTo(qc[0], qc[1]);
            for (var j = i + 1; j < pts.length; j++) {
              var qj = P(pts[j]);
              g.lineTo(qj[0], qj[1]);
            }
            g.stroke();
            closed = true;
            break;
          }
        }
        if (!closed) g.stroke();
        g.setLineDash([]);
        g.lineDashOffset = 0;
        /* ★ 用户 ⑤：「在地图上看不到在途行军部队，需要动画效果」。
           原实现只有一支 12px 小旗 + 3px 圆点，1× 视野下几乎看不见，而且是静止的。
           现在换成：呼吸光环（脉冲）+ 兵力徽章 + 行进方向箭头 + 「→ 城名 · 余 N 日」标签，
           由 Date.now() 驱动相位 —— 20fps 重绘时是连续动画，静帧也停在合理相位，
           不依赖 requestAnimationFrame 是否在跑，也不会因为掉帧而闪。 */
        var qm = P(cur);
        var ph = (Date.now() % 1500) / 1500;
        var pulse = Math.sin(ph * Math.PI * 2) * 0.5 + 0.5;
        var R = Math.max(11, 13 * scale);
        var rgb = isFoe ? '225,92,72' : '232,198,112';
        /* 呼吸光环 */
        g.beginPath();
        g.arc(qm[0], qm[1], R + 3 + pulse * 11, 0, 6.2832);
        g.strokeStyle = 'rgba(' + rgb + ',' + (0.55 * (1 - pulse)).toFixed(3) + ')';
        g.lineWidth = 2;
        g.stroke();
        /* 徽章底盘 */
        g.beginPath(); g.arc(qm[0], qm[1], R, 0, 6.2832);
        g.fillStyle = 'rgba(16,14,8,.86)'; g.fill();
        g.lineWidth = 2; g.strokeStyle = cFlag; g.stroke();
        /* 徽章里的兵力（万级压缩，字号跟着缩放走） */
        var tsum = Math.max(0, Number(mm.troops) || 0);
        var tmsg = tsum >= 10000 ? (tsum / 10000).toFixed(1) + '万' : String(tsum);
        g.fillStyle = cFlag;
        g.font = 'bold ' + Math.max(9, Math.min(12, R * 0.8)).toFixed(1) + 'px "Microsoft YaHei",sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(tmsg, qm[0], qm[1] + 0.5);
        /* 方向箭头：沿当前所在路段切线，告诉玩家「往哪走」 */
        if (tang) {
          var tl = Math.hypot(tang[0], tang[1]) || 1;
          var dx = tang[0] / tl, dy = tang[1] / tl;
          var ax = qm[0] + dx * (R + 10), ay = qm[1] + dy * (R + 10);
          g.beginPath();
          g.moveTo(ax + dx * 8, ay + dy * 8);
          g.lineTo(ax - dy * 5 - dx * 3, ay + dx * 5 - dy * 3);
          g.lineTo(ax + dy * 5 - dx * 3, ay - dx * 5 - dy * 3);
          g.closePath();
          g.fillStyle = cFlag; g.fill();
        }
        /* 标签：我方「→ 目标城 · 余 N 日」，敌方前置势力名 */
        var restDay = Math.max(0, Math.ceil(mm.arriveDay - dayNow));
        var head = isFoe ? ((mm.factionName || '诸侯军') + ' ') : '';
        var label = head + (mm.recalled ? '撤回 ' : '→ ') + (mm.toName || '')
          + ' · 余 ' + restDay + ' 日';
        g.font = Math.max(10, 11.5 * scale).toFixed(1) + 'px "Microsoft YaHei",sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'top';
        g.lineWidth = 3; g.strokeStyle = 'rgba(250,244,228,.88)';
        g.strokeText(label, qm[0], qm[1] + R + 5);
        g.fillStyle = isFoe ? '#9e2b1c' : '#6b4a12';
        g.fillText(label, qm[0], qm[1] + R + 5);
        g.restore();
      });
    }
    if (logOpen && logTab === 'plan' && s.plans) {
      s.plans.forEach(function (p) {
        if (!p.from || !p.target || p.type === '固守') return;
        var a = null, b = null, i;
        for (i = 0; i < s.cities.length; i++) {
          if (String(s.cities[i].id) === String(p.from)) a = s.cities[i];
          if (String(s.cities[i].id) === String(p.target)) b = s.cities[i];
        }
        if (!a || !b) return;
        var pa = P([a.x, a.y]), pb = P([b.x, b.y]);
        g.save();
        g.strokeStyle = p.color || '#c0392b';
        g.lineWidth = Math.max(1.4, 1.8 * scale);
        g.setLineDash([7 * scale, 5 * scale]);
        g.beginPath();
        g.moveTo(pa[0], pa[1]);
        g.lineTo(pb[0], pb[1]);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = p.color || '#c0392b';
        g.beginPath();
        g.arc(pb[0], pb[1], Math.max(3, 4 * scale), 0, 6.2832);
        g.fill();
        g.restore();
      });
    }
    if (LAYER.pass && DETAIL && DETAIL.passes) {
      DETAIL.passes.forEach(function (p) {
        var off = PASS_LABEL[p.name] || [-18.5, 32];
        var on = !!(pickedPass && pickedPass.name === p.name);
        inkText(p.name, p.x + off[0], p.y + off[1], {
          size: 15, align: 'left', baseline: 'alphabetic', bold: on,
          fill: on ? '#16527e' : '#8d3126',
          stroke: on ? '#f4f7fb' : '#f8f1df',
          strokeWidth: on ? 4 : 3
        });
      });
    }

    /* 势力图例/面板：内容只在变化时重建（详见 renderLegend 的头注） */
    renderLegend(s);
    // 事件与回合
    var camp = s.campaign || {};
    var endTxt = camp.ending === 'held' ? ' · 序章已守住'
      : (camp.ending === 'lost' ? ' · 序章失守' : '');
    var turnEl = document.getElementById('slgStratTurn');
    if (turnEl) turnEl.textContent = '第 ' + (s.month || (s.turn || 0) + 1) + ' 月 · 游戏日 ' + s.day
      + '（下一月：第 ' + s.nextTurnDay + ' 日）' + endTxt;
    // ★ P1-6：来犯军必须在天下界面可见，否则本地地图被遮住后威胁等于不存在
    var alertEl = document.getElementById('slgAlert');
    if (alertEl) {
      var alertTxt = (s.threats && s.threats.length) ? ('来犯 ' + s.threats.length + ' 支 · 本城可清剿') : '';
      alertEl.textContent = alertTxt;
      alertEl.style.display = alertTxt ? 'block' : 'none';
    }
    var ev = document.getElementById('slgStratEvents');
    if (ev) {
      if (s.chronicle && s.chronicle.length) {
        ev.innerHTML = s.chronicle.slice(0, 3).map(function (m) {
          return '<div style="margin-bottom:6px;">' + esc(m.text) + '</div>';
        }).join('');
      } else {
        ev.innerHTML = s.events.length
          ? s.events.map(function (e) {
            return '<div>· 第' + (e.month || (e.turn || 0) + 1) + '月 ' + esc(e.text) + '</div>';
          }).join('')
          : '<div style="opacity:.6">天下尚无大事。</div>';
      }
    }
    renderLog(s);
    var legendBox = document.getElementById('slgLegend');
    if (legendBox) legendBox.style.display = logOpen ? 'none' : 'block';
    var dl = document.getElementById('slgStratCityList');
    if (dl && dl.childNodes.length !== s.cities.length + ((DETAIL && DETAIL.passes) || []).length) {
      dl.innerHTML = '';
      s.cities.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); })
        .forEach(function (c) {
          var o = document.createElement('option');
          o.value = c.name;
          dl.appendChild(o);
        });
      ((DETAIL && DETAIL.passes) || []).forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.name;
        dl.appendChild(o);
      });
    }
    /* ★ #18：draw 是所有视口/选中变更的唯一收口，落盘放这里不会漏事件 */
    saveView();

    // ★ P2：有队伍在行军时以 ~20fps 连续重绘，军标平滑移动；走完自动停
    var marching = s.marches && s.marches.some(function (mm) { return !mm.resolved; });
    if (marching && overlay && overlay.style.display !== 'none' && !rafId) {
      rafId = requestAnimationFrame(function loop(ts) {
        rafId = null;
        if (!lastState || (overlay && overlay.style.display === 'none')) return;
        if (ts - lastRafAt > 50) { lastRafAt = ts; draw(lastState); }
        var still = lastState.marches && lastState.marches.some(function (mm) { return !mm.resolved; });
        if (still) rafId = requestAnimationFrame(loop);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();`;

/**
 * 战斗回放 / 战报内嵌战斗画面。
 *
 * ★ 用户反馈「战报没有打斗画面」「只写：健卒不殆 发动，看不懂效果」。两件事一起解决：
 *   1. 把原来「只能全屏回放」的播放器抽成可复用的 Stage —— 战报详情里直接内嵌一块
 *      战斗画面，不必先知道要点「回放」。
 *   2. 每个动作都带一句服务端生成的人话（domain/battle-narrative.js）：
 *      「吕布 发动「健卒不殆」（自身普通攻击伤害 +40%）——铁骑压上，前排应声而乱」，
 *      播放时作为字幕出现在画面下方，玩家能边看边读懂发生了什么。
 *
 * 工程约束：注入层独立 IIFE，不改协议、不改 web/ 产物、不用模板字符串（本文件由
 *   Node 侧以模板串下发，内部一律字符串拼接）。
 */
const BATTLE_ANIM_SOURCE = `;(function () {
  if (typeof document === 'undefined') return;

  var SIDE_COLOR = { a: '#c0392b', d: '#2c5f8a' };
  var SIDE_NAME = { a: '我军', d: '守军' };
  var DUR = { banner: 650, prepare: 450, skill: 950, hit: 620, control: 550, heal: 550, down: 800, result: 1500 };

  function fmt(n) { n = Math.round(Number(n) || 0); return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }

  /* ---------------- 样式（与战报/面板同一套金褐色调） ---------------- */
  function injectCss() {
    if (document.getElementById('slgBattleCss')) return;
    var css = ''
      + '.slgStage{position:relative;display:flex;flex-direction:column;background:#0e1013;'
      + 'border:1px solid #3a3325;border-radius:6px;overflow:hidden}'
      + '.slgStage canvas{display:block;width:100%;height:100%;flex:1;min-height:0}'
      + '.slgStage .sub{position:absolute;left:0;right:0;bottom:40px;padding:7px 14px;'
      + 'background:linear-gradient(180deg,rgba(10,12,8,0),rgba(10,12,8,.88));'
      + 'color:#f0e2b8;font:12.5px/1.65 "Microsoft YaHei",sans-serif;text-align:left;'
      + 'pointer-events:none;min-height:34px}'
      + '.slgStage .sub b{color:#ffe9b0}'
      + '.slgStage .bar{height:40px;flex:0 0 40px;display:flex;align-items:center;gap:8px;'
      + 'padding:0 10px;background:rgba(18,20,14,.96);border-top:1px solid #33302a;'
      + 'font:11.5px "Microsoft YaHei",sans-serif;color:#c8b88a}'
      + '.slgStage .bar button{background:#20221c;color:#e8c670;border:1px solid #6a624a;'
      + 'border-radius:4px;padding:3px 10px;cursor:pointer;font:11.5px "Microsoft YaHei",sans-serif}'
      + '.slgStage .bar button:hover{background:#33362a;border-color:#ba9a52}'
      + '.slgStage .bar .sp{flex:1}'
      + '.slgStage .bar .prog{color:#9c9382}'
      + '#slgBattleOverlay .head{position:absolute;top:0;left:0;right:0;height:38px;display:flex;'
      + 'align-items:center;gap:12px;padding:0 12px;background:#161810;color:#e8c670;'
      + 'font:14px "Microsoft YaHei",sans-serif;z-index:3;border-bottom:1px solid #33302a}'
      + '#slgBattleOverlay .head button{background:#2a2c30;color:#e8c670;border:1px solid #ba9a52;'
      + 'border-radius:4px;padding:2px 10px;cursor:pointer;font:12px "Microsoft YaHei",sans-serif}'
      + '#slgBattleOverlay .body{position:absolute;top:38px;left:0;right:0;bottom:0;padding:10px}';
    var st = document.createElement('style'); st.id = 'slgBattleCss'; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------------- Stage：一场战斗的播放器 ---------------- */
  function createStage(anim, opt) {
    opt = opt || {};
    injectCss();
    var host = document.createElement('div');
    host.className = 'slgStage';
    if (opt.height) host.style.height = opt.height;
    var canvas = document.createElement('canvas');
    var sub = document.createElement('div'); sub.className = 'sub';
    var bar = document.createElement('div'); bar.className = 'bar';
    host.appendChild(canvas); host.appendChild(sub); host.appendChild(bar);

    var state = {
      anim: anim, t0: 0, paused: false, speed: 1, finished: false,
      particles: [], units: {}, cues: [], total: 0, raf: null,
      roundBanner: null, roundUntil: 0, skillBanner: null, skillUntil: 0,
      resultBanner: null, resultColor: null, subText: '', subUntil: 0,
      roundNow: 0, roundTotal: (anim.rounds || []).length,
    };

    /* 参战单位：名字 / 兵力 / 战法说明 */
    (function buildUnits() {
      var put = function (side, list) {
        (list || []).forEach(function (u, i) {
          state.units[side + (u.slot == null ? i : u.slot)] = {
            side: side, slot: u.slot == null ? i : u.slot, name: u.name,
            skills: u.skills || [],
            troops: Math.max(1, u.troops), cur: Math.max(0, u.remain),
            dead: u.remain <= 0, x: 0, y: 0, lungeT: -1, flashT: -1, fallT: -1,
            stateText: '', stateT: 0, skillT: -1,
          };
        });
      };
      put('a', anim.a && anim.a.units);
      put('d', anim.d && anim.d.units);
    })();

    function unitKey(u) { return u ? (u.s + (u.i == null ? 0 : u.i)) : ''; }

    function buildCues() {
      var t = 380, list = [];
      list.push({ t: 0, fn: function () {} });
      (anim.rounds || []).forEach(function (r) {
        list.push({
          t: t, fn: function (c) {
            c.roundBanner = r.round > 0 ? '第 ' + r.round + ' 回合' : '列阵 · 战法先行';
            c.roundUntil = t + DUR.banner;
            c.roundNow = r.round;
          },
        });
        t += DUR.banner;
        (r.acts || []).forEach(function (act) {
          var dur = DUR[act.t] || 500;
          list.push({
            t: t,
            fn: function (c) { applyAct(c, act); },
            end: t + dur,
          });
          t += Math.max(200, dur * 0.55);
        });
      });
      list.push({
        t: t, fn: function (c) {
          c.resultBanner = anim.winner === 2 ? '胜' : (anim.winner === 0 ? '败' : '平');
          c.resultColor = anim.winner === 2 ? '#e8c670' : (anim.winner === 0 ? '#c0392b' : '#9aa0a6');
        },
      });
      list.push({ t: t + DUR.result, fn: function (c) { c.finished = true; } });
      state.total = t + DUR.result;
      return list;
    }

    function applyAct(ctx, act) {
      var f = state.units[unitKey(act.f)];
      var to = state.units[unitKey(act.to || act.unit)];
      /* 字幕：服务端已经写好的人话；没有再退回「谁 发动了什么」 */
      var line = act.text || ((act.fName || '') + ' ' + (act.skill || ''));
      if (act.t === 'skill' && act.effect) line = (act.fName || '') + ' 发动「' + act.skill + '」— ' + act.effect;
      ctx.subText = line;
      ctx.subUntil = performance.now() + Math.max(900, (DUR[act.t] || 500) * 1.2);
      if (act.t === 'hit' && f && to && !f.dead) {
        f.lungeT = performance.now();
        to.flashT = performance.now();
        damage(to, act.loss);
        state.particles.push(mkText('-' + fmt(act.loss), to.x, to.y - 46, '#ff6b5e'));
      } else if (act.t === 'skill' && f) {
        state.skillBanner = (f.name || '') + ' · ' + (act.skill || '战法');
        state.skillUntil = performance.now() + 1100;
        f.skillT = performance.now();
        if (act.to && to) to.flashT = performance.now();
      } else if (act.t === 'control' && to) {
        to.stateText = act.state;
        to.stateT = performance.now();
        state.particles.push(mkText(act.state || '受制', to.x, to.y - 46, '#b07ce8'));
      } else if (act.t === 'heal' && to) {
        var amt = Math.min(act.amount || 0, to.troops - to.cur);
        to.cur += amt;
        state.particles.push(mkText('+' + fmt(amt), to.x, to.y - 46, '#6fcf97'));
      } else if (act.t === 'prepare' && f) {
        state.skillBanner = (f.name || '') + ' · ' + (act.skill || '战法') + '（蓄）';
        state.skillUntil = performance.now() + 800;
      } else if (act.t === 'down' && to) {
        to.dead = true; to.cur = 0; to.fallT = performance.now();
      }
    }

    function damage(u, loss) {
      if (!u || u.dead) return;
      u.cur = Math.max(0, u.cur - loss);
      if (u.cur <= 0) { u.dead = true; u.fallT = performance.now(); }
    }

    function mkText(text, x, y, color) {
      return { text: text, x: x, y: y, t0: performance.now(), color: color };
    }

    /* ---- 绘制 ---- */
    function drawFigure(g, u, now) {
      var side = SIDE_COLOR[u.side] || '#999';
      var x = u.x, y = u.y;
      var lunge = 0;
      if (u.lungeT > 0) {
        var dt = now - u.lungeT;
        if (dt < 620) lunge = Math.sin((dt / 620) * Math.PI) * 46 * (u.side === 'a' ? 1 : -1);
        else u.lungeT = -1;
      }
      var flash = u.flashT > 0 && now - u.flashT < 260;
      var dying = u.dead && u.fallT > 0;
      var fall = dying ? Math.min(1, (now - u.fallT) / 700) : 0;
      g.save();
      g.translate(x + lunge, y);
      if (fall > 0) { g.rotate((fall * Math.PI / 2) * (u.side === 'a' ? 1 : -1)); g.globalAlpha = 1 - fall * 0.85; }
      if (flash) g.globalAlpha = 0.55;
      /* 战法光晕：发动瞬间在脚下铺一圈 */
      if (u.skillT > 0 && now - u.skillT < 900) {
        var k = (now - u.skillT) / 900;
        g.beginPath(); g.arc(0, 6, 20 + k * 34, 0, 6.2832);
        g.strokeStyle = 'rgba(232,198,112,' + (0.6 * (1 - k)).toFixed(3) + ')';
        g.lineWidth = 3; g.stroke();
      }
      g.fillStyle = side;
      g.beginPath(); g.moveTo(-12, 18); g.lineTo(0, -6); g.lineTo(12, 18); g.closePath(); g.fill();
      g.fillStyle = '#f0d9a8';
      g.beginPath(); g.arc(0, -14, 7, 0, 6.2832); g.fill();
      g.fillStyle = side;
      g.beginPath(); g.arc(0, -20, 4, 0, 6.2832); g.fill();
      g.strokeStyle = '#d8cfa8'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(10, 8); g.lineTo(26, -14); g.stroke();
      if (flash) { g.globalAlpha = 0.9; g.fillStyle = '#fff'; g.fillRect(-14, -26, 30, 48); }
      g.restore();
      var count = Math.min(6, Math.ceil((u.dead ? 0 : u.cur) / Math.max(1, u.troops / 10)));
      for (var i = 0; i < count; i++) {
        var sx = x + (u.side === 'a' ? -1 : 1) * (26 + i * 10);
        var sy = y + 22;
        g.fillStyle = side; g.globalAlpha = 0.75;
        g.beginPath(); g.arc(sx, sy, 3.4, 0, 6.2832); g.fill();
        g.strokeStyle = '#d8cfa8'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(sx, sy - 3); g.lineTo(sx + (u.side === 'a' ? 5 : -5), sy - 12); g.stroke();
        g.globalAlpha = 1;
      }
      if (!u.dead || fall < 1) {
        g.fillStyle = '#e6dac0'; g.font = '12px "Microsoft YaHei",sans-serif'; g.textAlign = 'center';
        g.fillText(u.name, x, y - 34);
        var w = 74;
        g.fillStyle = '#22252b'; g.fillRect(x - w / 2, y + 34, w, 5);
        g.fillStyle = side; g.fillRect(x - w / 2, y + 34, w * Math.max(0, u.cur / Math.max(1, u.troops)), 5);
        g.fillStyle = '#c8b88a'; g.font = '11px "Microsoft YaHei",sans-serif';
        g.fillText(fmt(u.cur) + '/' + fmt(u.troops), x, y + 56);
        if (u.stateText && now - u.stateT < 2500) {
          g.fillStyle = '#b07ce8'; g.fillText(u.stateText, x, y - 48);
        }
      }
    }

    function draw(now) {
      var rect = canvas.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      var g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, rect.width, rect.height);
      /* 背景：夜战 / 地平线 / 双方营寨 */
      var bg = g.createLinearGradient(0, 0, 0, rect.height);
      bg.addColorStop(0, '#12151a'); bg.addColorStop(1, '#1a1a14');
      g.fillStyle = bg; g.fillRect(0, 0, rect.width, rect.height);
      g.strokeStyle = 'rgba(200,180,130,0.16)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, rect.height * 0.78); g.lineTo(rect.width, rect.height * 0.78); g.stroke();
      g.fillStyle = 'rgba(192,57,43,.10)'; g.fillRect(0, 0, rect.width * 0.34, rect.height);
      g.fillStyle = 'rgba(44,95,138,.10)'; g.fillRect(rect.width * 0.66, 0, rect.width * 0.34, rect.height);
      /* ★ 站位按画布高度均分：嵌入式战报只有 260~320px，用比例站位（0.34/0.58/0.82）
         会让最后一排的兵力数字压进字幕条。这里改成「上留 46、下留 136（字幕 + 血条）」，
         三排均分，任何高度都不会互相压字。 */
      var topY = 46;
      var bottomY = Math.max(topY + 60, rect.height - 136);
      var stepY = (bottomY - topY) / 2;
      for (var k in state.units) {
        var u = state.units[k];
        var row = Math.min(2, Math.max(0, u.slot == null ? 0 : u.slot));
        u.x = rect.width * (u.side === 'a' ? 0.26 : 0.74);
        u.y = topY + stepY * row;
        drawFigure(g, u, now);
      }
      state.particles = state.particles.filter(function (p) { return now - p.t0 < 1100; });
      state.particles.forEach(function (p) {
        var dt = (now - p.t0) / 1100;
        g.globalAlpha = 1 - dt;
        g.fillStyle = p.color;
        g.font = 'bold 15px "Microsoft YaHei",sans-serif';
        g.textAlign = 'center';
        g.fillText(p.text, p.x, p.y - dt * 26);
        g.globalAlpha = 1;
      });
      if (state.roundBanner && now < (state.roundUntil || 0)) {
        g.fillStyle = 'rgba(20,18,12,0.75)';
        g.fillRect(rect.width / 2 - 90, 14, 180, 32);
        g.fillStyle = '#e8c670'; g.font = 'bold 16px "Microsoft YaHei",sans-serif'; g.textAlign = 'center';
        g.fillText(state.roundBanner, rect.width / 2, 36);
      }
      if (state.skillBanner && now < (state.skillUntil || 0)) {
        g.fillStyle = 'rgba(30,24,10,0.88)';
        g.fillRect(rect.width / 2 - 170, rect.height * 0.13, 340, 42);
        g.strokeStyle = '#e8c670'; g.lineWidth = 1.5;
        g.strokeRect(rect.width / 2 - 170, rect.height * 0.13, 340, 42);
        g.fillStyle = '#ffe9b0'; g.font = 'bold 18px "Microsoft YaHei",sans-serif'; g.textAlign = 'center';
        g.fillText(state.skillBanner, rect.width / 2, rect.height * 0.13 + 29);
      }
      if (state.resultBanner) {
        g.fillStyle = 'rgba(16,14,8,0.72)'; g.fillRect(0, 0, rect.width, rect.height);
        g.fillStyle = state.resultColor || '#e8c670';
        g.font = 'bold 52px "KaiTi","Microsoft YaHei",sans-serif'; g.textAlign = 'center';
        g.fillText(state.resultBanner, rect.width / 2, rect.height / 2);
        g.font = '15px "Microsoft YaHei",sans-serif'; g.fillStyle = '#c8b88a';
        var sa = 0, sd = 0;
        for (var kk in state.units) { if (state.units[kk].side === 'a') sa += state.units[kk].cur; else sd += state.units[kk].cur; }
        g.fillText('我军余 ' + fmt(sa) + ' · 守军余 ' + fmt(sd), rect.width / 2, rect.height / 2 + 34);
      }
    }

    function tick() {
      if (state.paused) { state.raf = null; return; }
      var now = performance.now();
      var elapsed = (now - state.t0) * state.speed;
      if (elapsed >= state.total) state.finished = true;
      state.cues.forEach(function (c) {
        if (elapsed >= c.t && !c.done) { c.done = true; c.fn(state); }
      });
      draw(now);
      renderSub(now);
      renderBar();
      if (!state.finished) state.raf = requestAnimationFrame(tick);
      else { draw(now); renderBar(); state.raf = null; }
    }

    function renderSub(now) {
      if (state.subText && now < state.subUntil) {
        sub.innerHTML = state.subText;
        sub.style.opacity = '1';
      } else {
        sub.style.opacity = '0';
      }
    }

    /* ★ 原实现每帧重建整条控制栏（60fps × 建 4 个元素），长战报会把主线程占满。
       现在只建一次，之后只改文字。 */
    var bPlay = null, bReplay = null, bSpeed = null, progEl = null, barBuilt = false;
    function buildBar() {
      if (barBuilt) return;
      barBuilt = true;
      var mk = function (txt, fn) {
        var b = document.createElement('button');
        b.textContent = txt;
        b.onclick = fn;
        bar.appendChild(b);
        return b;
      };
      bPlay = mk('⏸ 暂停', function () { if (state.paused) resume(); else pause(); });
      bReplay = mk('⟳ 重播', function () { play(); });
      bSpeed = mk('速度 ×1', function () {
        state.speed = state.speed >= 4 ? 1 : state.speed * 2;
        renderBar();
      });
      var sp = document.createElement('span'); sp.className = 'sp';
      progEl = document.createElement('span'); progEl.className = 'prog';
      bar.appendChild(sp); bar.appendChild(progEl);
      if (opt.onClose) mk('关闭', function () { destroy(); opt.onClose(); });
    }
    function renderBar() {
      buildBar();
      bPlay.textContent = state.paused ? '▶ 继续' : '⏸ 暂停';
      bSpeed.textContent = '速度 ×' + state.speed;
      var pctDone = state.total
        ? Math.min(100, Math.round(((performance.now() - state.t0) * state.speed) / state.total * 100))
        : 0;
      progEl.textContent = (state.roundNow > 0
        ? '第 ' + state.roundNow + ' / ' + state.roundTotal + ' 回合' : '列阵') + '　' + pctDone + '%';
    }

    function reset() {
      state.t0 = performance.now();
      state.finished = false;
      state.paused = false;
      state.particles = [];
      state.subText = ''; state.roundNow = 0;
      Object.keys(state.units).forEach(function (k) {
        var u = state.units[k];
        u.cur = Math.max(0, u.dead ? 0 : u.cur);
      });
      /* 全场重放：按初始兵力重建，避免「重播时兵已经打光」 */
      state.units = {};
      (function rebuild() {
        var put = function (side, list) {
          (list || []).forEach(function (u, i) {
            state.units[side + (u.slot == null ? i : u.slot)] = {
              side: side, slot: u.slot == null ? i : u.slot, name: u.name, skills: u.skills || [],
              troops: Math.max(1, u.troops), cur: Math.max(0, u.remain),
              dead: u.remain <= 0, x: 0, y: 0, lungeT: -1, flashT: -1, fallT: -1,
              stateText: '', stateT: 0, skillT: -1,
            };
          });
        };
        put('a', anim.a && anim.a.units); put('d', anim.d && anim.d.units);
      })();
      state.cues = buildCues();
      state.resultBanner = null;
    }

    function play() {
      reset();
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = requestAnimationFrame(tick);
    }
    function pause() {
      if (state.paused) return;
      state.paused = true;
      state.pausedAt = performance.now();
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = null;
      renderBar();
    }
    function resume() {
      if (!state.paused) return;
      state.paused = false;
      /* 暂停 N 毫秒就把起点后移 N 毫秒，恢复后进度不会「跳一大段」 */
      var gap = performance.now() - (state.pausedAt || performance.now());
      state.t0 += gap;
      state.subUntil += gap;
      state.roundUntil += gap;
      state.skillUntil += gap;
      state.raf = requestAnimationFrame(tick);
    }
    function destroy() { if (state.raf) cancelAnimationFrame(state.raf); state.raf = null; host.remove(); }

    host.style.height = opt.height || '300px';
    renderBar();
    if (opt.autoPlay !== false) play(); else { draw(performance.now()); }
    return { el: host, play: play, pause: pause, destroy: destroy, anim: anim };
  }

  /* ---------------- 全屏回放（战报列表「回放」按钮） ---------------- */
  var overlay = null;

  function ensureOverlay() {
    if (overlay) return;
    injectCss();
    overlay = document.createElement('div');
    overlay.id = 'slgBattleOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99997;display:none;background:#0d0f12;';
    var head = document.createElement('div'); head.className = 'head';
    head.innerHTML = '<b id="slgBattleTitle"></b><span style="flex:1"></span>'
      + '<span style="font-size:11.5px;color:#9c9382">看清每一回合发生了什么 · Esc 关闭</span>'
      /* 回放只是「看」，看完要能一步进战报；这条入口是原版就有的，重写时不能丢 */
      + '<button id="slgBattleReport" style="background:#2a2c30;color:#e8c670;'
      + 'border:1px solid #ba9a52;border-radius:4px;padding:2px 10px;cursor:pointer;'
      + 'font:12px &quot;Microsoft YaHei&quot;,sans-serif">战报详情</button>';
    var body = document.createElement('div'); body.className = 'body'; body.id = 'slgBattleBody';
    overlay.appendChild(head); overlay.appendChild(body);
    document.body.appendChild(overlay);
    document.getElementById('slgBattleReport').onclick = function () {
      hide();
      if (window.__slgOpenWarReport) window.__slgOpenWarReport();
      else if (window.__slgReportsWindow) window.__slgReportsWindow();
    };
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay && overlay.style.display !== 'none') hide();
    });
  }

  var current = null;
  function hide() {
    if (overlay) overlay.style.display = 'none';
    if (current) { current.destroy(); current = null; }
  }

  window.__slgPlayBattle = function (data) {
    if (!data || !data.rounds || !data.rounds.length) return;
    ensureOverlay();
    if (current) { current.destroy(); current = null; }
    overlay.style.display = 'block';
    document.getElementById('slgBattleTitle').textContent =
      (data.a && data.a.name ? data.a.name : '我军') + ' 攻 ' + (data.place || '') + '（守军 ' + (data.d && data.d.name ? data.d.name : '') + '）';
    var body = document.getElementById('slgBattleBody');
    body.innerHTML = '';
    current = createStage(data, { autoPlay: true, height: 'calc(100vh - 58px)', onClose: hide });
    body.appendChild(current.el);
  };

  /* 战报详情里内嵌用：把播放器挂到指定容器，返回句柄（含 destroy） */
  window.__slgBattleStage = function (container, data, opt) {
    if (!container || !data || !data.rounds || !data.rounds.length) return null;
    var s = createStage(data, opt || { autoPlay: true, height: '300px' });
    container.appendChild(s.el);
    return s;
  };
})();`;


/** 城池面板 v2：完整实现（样式/布局/六页/全局面板/HUD/抉择弹窗） */
const CITY_WINDOW_V2_IMPL = `;(function () {
  if (typeof document === 'undefined') return;
  var cache = null, tab = 'overview', currentCity = 0, neighbors = {};
  /* ★ 出征面板状态：出发城 / 目标城 / 队伍 / 比例 / 页签。玩家在面板里选一次就记住。 */
  var war = { from: 0, target: 0, armyId: 0, frac: 1, tab: 'go' };
  /* 一键征兵的「在途」状态（城市 → 数量 → 入营时刻）。放在面板层而不是服务端：
     服务端只管 con_times 与结算，界面需要的是「还要等几秒、这旬还能不能再点」。 */
  var levyPending = null;
  /* ★ 验收 #18：出征面板的「未完成输入」（出发城/目标城/队伍/出兵比例/页签）
     跨面板开关与页面刷新保持——选到一半切去内政看粮，回来不必重选。 */
  var WAR_KEY = 'slg.war.state';
  (function restoreWar() {
    try {
      var v = JSON.parse(window.sessionStorage.getItem(WAR_KEY) || 'null');
      if (!v) return;
      if (v.from) war.from = Number(v.from) || 0;
      if (v.target) war.target = Number(v.target) || 0;
      if (v.armyId) war.armyId = Number(v.armyId) || 0;
      var f = Number(v.frac);
      if (f > 0 && f <= 1) war.frac = f;
      if (v.tab) war.tab = String(v.tab);
    } catch (e) { /* 隐私模式静默降级 */ }
  })();
  function saveWar() {
    try {
      window.sessionStorage.setItem(WAR_KEY, JSON.stringify({
        from: war.from, target: war.target, armyId: war.armyId, frac: war.frac, tab: war.tab,
      }));
    } catch (e) { /* 同上 */ }
  }
  var host = null;

  var STYLE = document.createElement('style');
  STYLE.textContent = [
    '#slgUIv2 *{box-sizing:border-box;margin:0;padding:0;}',
    '#slgUIv2 .win{position:fixed;top:12px;right:244px;bottom:12px;width:520px;z-index:100560;'
    + 'background:linear-gradient(180deg,#20221c,#141610);border:1px solid #8a7038;border-radius:10px;'
    + 'color:#e2d6b8;font:13px/1.8 "Microsoft YaHei",sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.7);display:none;}',
    '#slgUIv2 .win-head{position:relative;padding:12px 16px 8px;border-bottom:1px solid #4a4436;background:rgba(60,48,24,.35);}',
    '#slgUIv2 .win-head b{font-size:17px;color:#f0d998;letter-spacing:2px;}',
    '#slgUIv2 .win-head .sub{opacity:.85;font-size:12px;margin-top:2px;}',
    '#slgUIv2 .badge{display:inline-block;padding:0 6px;border-radius:3px;font-size:11px;margin-left:6px;vertical-align:2px;}',
    '#slgUIv2 .badge.cap{background:#7a2a20;color:#ffd9c0;}',
    '#slgUIv2 .badge.home{background:#7a5822;color:#ffe9b0;}',
    '#slgUIv2 .x{position:absolute;top:10px;right:12px;cursor:pointer;color:#a89f86;font-size:16px;padding:2px 8px;}',
    '#slgUIv2 .tabs{display:flex;border-bottom:1px solid #4a4436;}',
    '#slgUIv2 .tabs button{flex:1;background:#20221c;border:none;border-right:1px solid #33302a;color:#a89f86;',
    'padding:7px 0;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgUIv2 .tabs button.on{background:#5c4318;color:#ffe9b0;font-weight:bold;}',
    '#slgUIv2 .body{position:absolute;top:98px;left:0;right:0;bottom:0;overflow-y:auto;padding:12px 16px;}',
    '#slgUIv2 .card{background:rgba(255,255,255,.04);border:1px solid #3a3325;border-radius:6px;padding:10px 12px;margin-bottom:10px;}',
    '#slgUIv2 .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;}',
    '#slgUIv2 .kv{display:flex;justify-content:space-between;border-bottom:1px dashed #33302a;padding:4px 0;}',
    '#slgUIv2 .kv span:last-child{color:#f0d998;}',
    '#slgUIv2 .res{display:flex;gap:10px;flex-wrap:wrap;}',
    '#slgUIv2 .res .r{background:rgba(255,255,255,.05);border:1px solid #3a3325;border-radius:6px;',
    'padding:6px 12px;min-width:96px;}',
    '#slgUIv2 .res .r b{color:#f0d998;font-size:15px;}',
    '#slgUIv2 .res .r small{display:block;opacity:.7;font-size:11px;}',
    '#slgUIv2 .row{display:flex;align-items:center;justify-content:space-between;gap:8px;',
    'padding:7px 0;border-bottom:1px solid #2a2822;}',
    '#slgUIv2 .btn{background:linear-gradient(180deg,#6d5320,#54400f);color:#ffe9b0;border:1px solid #a8863e;',
    'border-radius:4px;padding:3px 14px;cursor:pointer;font:12px "Microsoft YaHei",sans-serif;white-space:nowrap;}',
    '#slgUIv2 .btn:hover{filter:brightness(1.15);}',
    '#slgUIv2 .btn:disabled{background:#2a2c30;color:#6a6a6a;border-color:#4a4a4a;cursor:not-allowed;}',
    '#slgUIv2 .btn.ghost{background:#20221c;color:#c8b88a;border-color:#4a4436;}',
    '#slgUIv2 .chip{display:inline-block;background:#20221c;border:1px solid #4a4436;border-radius:3px;',
    'padding:0 7px;font-size:11px;margin:1px 3px 1px 0;color:#c8b88a;}',
    '#slgUIv2 .cost{font-size:11px;color:#c8b88a;opacity:.95;}',
    '#slgUIv2 .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle;}',
    '#slgUIv2 .star5{color:#ffd766;}#slgUIv2 .star4{color:#c8a2ff;}#slgUIv2 .star3{color:#9fd0ff;}',
    '#slgUIv2 .winTag{color:#a89f86;}',
    /* ★ P11：.win 必须高于交互层浮窗（队列 100110 / 议程 100100 / 提示条 100240），
       旧值 100000 会被「行军队列」这类浮窗压住，出征按钮点不到。 */
    '#slgUIv2 .toast{position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:100880;',
    'padding:8px 22px;border-radius:6px;font:13px "Microsoft YaHei",sans-serif;',
    'box-shadow:0 4px 16px rgba(0,0,0,.6);opacity:0;transition:opacity .25s;}',
    '#slgUIv2 .toast.ok{background:#2c3e28;color:#a9e2a0;border:1px solid #4a6a42;}',
    '#slgUIv2 .toast.bad{background:#41241f;color:#ffb3a7;border:1px solid #7a4038;}',
    /* ★ P11 层级阶梯（与 interaction-ui 同一口径）：城内页 100420 < 决策预览 100760 <
       确认框 100820 < 术语提示 100780 < toast 100880~900。旧值 100002 会被城内页盖住。 */
    '#slgUIv2 .modal{position:fixed;inset:0;z-index:100820;background:rgba(0,0,0,.55);display:flex;',
    'align-items:center;justify-content:center;}',
    '#slgUIv2 .modal .box{width:430px;background:#20221c;border:1px solid #8a7038;border-radius:8px;padding:18px 20px;}',
    '#slgUIv2 .modal .box p{margin:0 0 14px;line-height:1.9;}',
    '#slgUIv2 .modal .bar{display:flex;justify-content:flex-end;gap:8px;}',
    '#slgUIv2 .seg{display:inline-flex;border:1px solid #4a4436;border-radius:4px;overflow:hidden;}',
    '#slgUIv2 .seg button{background:#20221c;color:#a89f86;border:none;padding:3px 12px;cursor:pointer;',
    'font:12px "Microsoft YaHei",sans-serif;border-right:1px solid #33302a;}',
    '#slgUIv2 .seg button.on{background:#5c4318;color:#ffe9b0;}',
    '#slgUIv2 input.n{width:80px;background:#101208;color:#f0d998;border:1px solid #4a4436;',
    'border-radius:4px;padding:3px 8px;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgUIv2 .empty{opacity:.6;padding:20px 0;text-align:center;}',
    /* ★ 战前推演结果（替代原来那串 JSON）：结论条 / 数字表 / 建议 / 双方阵容 */
    '#slgUIv2 .warpv{text-align:left;}',
    '#slgUIv2 .warpv-head{border-left:3px solid #e0c56a;background:rgba(186,154,82,.08);'
      + 'padding:9px 12px;border-radius:4px;margin:6px 0 10px;}',
    '#slgUIv2 .warpv-verdict{font:600 17px/1.4 "KaiTi","STKaiti",serif;letter-spacing:3px;}',
    '#slgUIv2 .warpv-line{font-size:12.5px;line-height:1.75;margin-top:3px;color:#e6dac0;}',
    '#slgUIv2 .warpv-rows{display:grid;grid-template-columns:1fr 1fr;gap:1px 16px;margin-bottom:10px;}',
    '#slgUIv2 .warpv-row{display:flex;gap:8px;font-size:12px;'
      + 'border-bottom:1px dotted rgba(186,154,82,.18);padding:4px 0;}',
    '#slgUIv2 .warpv-row .k{color:#9c9382;flex:0 0 70px;}',
    '#slgUIv2 .warpv-row .v{color:#f0d998;flex:1;min-width:0;}',
    '#slgUIv2 .warpv-tips{border-left:2px solid #6a5a32;padding:4px 0 4px 10px;'
      + 'margin-bottom:10px;font-size:12px;line-height:1.8;}',
    '#slgUIv2 .warpv-tips b{color:#cbb477;font-size:11.5px;letter-spacing:1px;}',
    '#slgUIv2 .warpv-tips .ti{color:#cfc2a6;}',
    '#slgUIv2 .warpv-forces{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:8px;}',
    '#slgUIv2 .warpv-force .ft{font-size:11px;letter-spacing:2px;'
      + 'border-bottom:1px solid rgba(186,154,82,.22);padding-bottom:3px;margin-bottom:5px;}',
    '#slgUIv2 .warpv-force .fg{margin-bottom:7px;}',
    '#slgUIv2 .warpv-force .fg b{color:#f0d998;font-size:12.5px;}',
    '#slgUIv2 .warpv-force .fs{font-size:11px;color:#b6ab92;line-height:1.7;}',
    '#slgUIv2 .warpv-detail{margin-top:6px;font-size:11px;color:#9c9382;}',
    '#slgUIv2 .warpv-detail summary{cursor:pointer;color:#c8b88a;font-size:11.5px;padding:3px 0;}',
    '#slgUIv2 .warpv-detail div{padding:2px 0;line-height:1.7;word-break:break-word;}',
    '@media (max-width:760px){#slgUIv2 .warpv-rows,#slgUIv2 .warpv-forces{grid-template-columns:1fr}}',
    '#slgUIv2 h4{color:#c8b88a;font-size:12px;margin:10px 0 6px;letter-spacing:2px;}',
    /* ★ P11 城市内部页：点地图城池即「进城」，整屏一页，不再叠浮窗 */
    '#slgUIv2 .citypage{position:fixed;inset:0;z-index:100420;display:flex;flex-direction:column;'
      + 'background:radial-gradient(1200px 700px at 78% -20%,rgba(150,116,54,.16),transparent 70%),'
      + 'linear-gradient(160deg,#14160f 0%,#1b1c14 48%,#12140e 100%);color:#e6dac0;'
      + 'font-family:"Microsoft YaHei","PingFang SC",sans-serif;animation:slgCityIn .22s ease-out;}',
    '@keyframes slgCityIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    '#slgUIv2 .citypage-head{display:flex;align-items:center;gap:18px;padding:18px 26px 14px;'
      + 'border-bottom:1px solid rgba(186,154,82,.32);background:rgba(10,12,8,.45);flex:0 0 auto;}',
    '#slgUIv2 .citypage-head .ct{font:26px/1.2 "KaiTi","STKaiti",serif;letter-spacing:4px;color:#f4dfa6;}',
    '#slgUIv2 .citypage-head .cs{font-size:12px;color:#a89f86;margin-top:5px;letter-spacing:1px;}',
    '#slgUIv2 .citypage-head .pills{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto;}',
    '#slgUIv2 .citypage-head .pill{min-width:88px;padding:7px 12px;border:1px solid rgba(186,154,82,.35);'
      + 'border-radius:6px;background:rgba(186,154,82,.07);text-align:left;}',
    '#slgUIv2 .citypage-head .pill small{display:block;font-size:10px;color:#9c9382;letter-spacing:1px;}',
    '#slgUIv2 .citypage-head .pill b{font-size:16px;color:#f0d998;font-weight:600;}',
    '#slgUIv2 .citypage-head .back{background:rgba(109,83,32,.55);color:#ffe9b0;border:1px solid #a8863e;'
      + 'border-radius:5px;padding:8px 15px;cursor:pointer;font-size:13px;white-space:nowrap;}',
    '#slgUIv2 .citypage-head .back:hover{background:rgba(160,124,48,.75);}',
    /* 城内页里的「推演一旬」：整屏页盖住了沙盘按钮，这里必须留同源入口 */
    '#slgUIv2 .citypage-head .citypage-acts{display:flex;gap:8px;margin-left:14px;}',
    '#slgUIv2 .citypage-head .tick{background:linear-gradient(180deg,rgba(150,113,40,.9),rgba(96,72,26,.9));'
      + 'color:#ffe9b0;border:1px solid #c8a25a;border-radius:5px;padding:8px 15px;cursor:pointer;'
      + 'font-size:13px;white-space:nowrap;box-shadow:0 1px 0 rgba(255,235,180,.25) inset;}',
    '#slgUIv2 .citypage-head .tick:hover{background:linear-gradient(180deg,rgba(180,138,52,.95),rgba(120,90,32,.95));}',
    '#slgUIv2 .citypage-main{display:flex;flex:1;min-height:0;}',
    '#slgUIv2 .citypage-nav{width:196px;flex:0 0 196px;padding:16px 12px;border-right:1px solid rgba(186,154,82,.22);'
      + 'background:rgba(8,10,7,.34);display:flex;flex-direction:column;gap:5px;}',
    '#slgUIv2 .citypage-nav .nt{font-size:11px;color:#8f8676;letter-spacing:3px;padding:4px 10px 8px;}',
    '#slgUIv2 .citypage-nav button{text-align:left;padding:10px 13px;border:1px solid transparent;border-radius:5px;'
      + 'background:transparent;color:#b9b096;font-size:13px;cursor:pointer;letter-spacing:1px;}',
    '#slgUIv2 .citypage-nav button:hover{background:rgba(186,154,82,.10);color:#f0d998;}',
    '#slgUIv2 .citypage-nav button.on{background:linear-gradient(90deg,rgba(150,113,40,.42),transparent);'
      + 'border-left:3px solid #d8b062;color:#ffe9b0;font-weight:600;}',
    /* 兼容锚点：nav 同时带 .tabs，抵消通用横向页签条对竖排导航的影响 */
    '#slgUIv2 .citypage-nav.tabs{background:rgba(8,10,7,.34);border-bottom:none;'
      + 'display:flex;flex-direction:column;border-right:1px solid rgba(186,154,82,.22);}',
    '#slgUIv2 .citypage-nav.tabs button{flex:0 0 auto;text-align:left;border-right:none;'
      + 'border-bottom:1px solid transparent;background:transparent;color:#b9b096;'
      + 'padding:10px 13px;border-radius:5px;font-size:13px;letter-spacing:1px;}',
    '#slgUIv2 .citypage-nav.tabs button.on{background:linear-gradient(90deg,rgba(150,113,40,.42),transparent);'
      + 'border-left:3px solid #d8b062;color:#ffe9b0;font-weight:600;}',
    '#slgUIv2 .citypage-nav .spacer{flex:1;}',
    '#slgUIv2 .citypage-nav .hint{font-size:11px;line-height:1.7;color:#8f8676;padding:10px;border-top:1px dashed rgba(186,154,82,.22);}',
    '#slgUIv2 .citypage-body{flex:1;min-width:0;overflow-y:auto;padding:18px 24px 40px;}',
    '#slgUIv2 .citypage-body .card{background:rgba(255,255,255,.035);border-color:rgba(186,154,82,.24);'
      + 'border-radius:7px;padding:12px 15px;margin-bottom:12px;}',
    '#slgUIv2 .citypage-body>.empty{font-size:13px;padding:30px;}',
    '@media (max-width:1100px){#slgUIv2 .citypage-nav{width:150px;flex-basis:150px}'
      + '#slgUIv2 .citypage-head .pill{min-width:70px}}',
    /* ★ P11 整体观感：主窗口统一居中、留白、层次；不再贴右侧和六府挤在一起 */
    '#slgUIv2 .win{right:auto;left:50%;transform:translateX(-50%);top:34px;bottom:34px;'
      + 'width:min(820px,calc(100vw - 96px));border:1px solid #8a7038;border-radius:10px;'
      + 'overflow:hidden;background:linear-gradient(160deg,#1a1d14,#12150f 70%);'
      + 'box-shadow:0 20px 64px rgba(0,0,0,.66);animation:slgWinIn .18s ease-out;}',
    '@keyframes slgWinIn{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%)}}',
    '#slgUIv2 .win-head{padding:13px 20px 10px;background:radial-gradient(620px 140px at 12% -60%,'
      + 'rgba(186,154,82,.24),transparent 75%);border-bottom:1px solid rgba(186,154,82,.28);}',
    '#slgUIv2 .win-head b{font:20px/1.3 "KaiTi","STKaiti",serif;letter-spacing:3px;}',
    '#slgUIv2 .win-head .x{top:12px;right:16px;font-size:19px;border-radius:4px;}',
    '#slgUIv2 .win-head .x:hover{background:rgba(186,154,82,.18);color:#ffe9b0;}',
    '#slgUIv2 .tabs{background:rgba(8,10,7,.5);border-bottom:1px solid rgba(186,154,82,.24);}',
    '#slgUIv2 .tabs button{background:transparent;border-right:none;border-bottom:2px solid transparent;'
      + 'color:#a89f86;padding:9px 6px;font-size:12.5px;letter-spacing:1px;}',
    '#slgUIv2 .tabs button:hover{color:#f0d998;background:rgba(186,154,82,.07);}',
    '#slgUIv2 .tabs button.on{background:rgba(150,113,40,.16);color:#ffe9b0;'
      + 'border-bottom-color:#d8b062;font-weight:600;}',
    '#slgUIv2 .win .body{top:104px;padding:16px 20px 40px;background:transparent;}',
    '#slgUIv2 .card{background:rgba(255,255,255,.032);border:1px solid rgba(186,154,82,.22);'
      + 'border-radius:7px;padding:12px 15px;box-shadow:inset 0 1px 0 rgba(255,255,255,.03);}',
    '#slgUIv2 .card h4{letter-spacing:2px;color:#c8b88a;}',
    '#slgUIv2 .kv{border-bottom:1px dashed rgba(186,154,82,.16);padding:5px 0;}',
    '#slgUIv2 .btn{border-radius:5px;letter-spacing:1px;transition:filter .15s,transform .1s;}',
    '#slgUIv2 .btn:active{transform:translateY(1px);}',
    '#slgUIv2 .modal .box{border-radius:9px;background:linear-gradient(165deg,#20221c,#141a13);'
      + 'box-shadow:0 20px 60px rgba(0,0,0,.65);}',
    '@media (max-width:1100px){#slgUIv2 .win{top:16px;bottom:16px;width:calc(100vw - 40px)}}',
  ].join('');
  document.head.appendChild(STYLE);

  host = document.createElement('div');
  host.id = 'slgUIv2';
  document.body.appendChild(host);

  function toast(msg, ok) {
    var old = host.querySelector('.toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast ' + (ok ? 'ok' : 'bad');
    t.textContent = msg;
    host.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 300); }, 2400);
  }
  window.__slgToast = toast;

  function fmt(n) { n = Math.floor(Number(n) || 0); return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }
  /* ★ 本 IIFE 原先没有 esc —— 城池面板里一堆 esc(...) 会抛 ReferenceError，
     整个页签渲染中断（概览页的出征块因此干脆不出现，看着就像「没有出征入口」）。 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var ERR_TEXT = { 1: '资源不足', 12: '已达最高等级', 16: '资源不足', 53: '此处不可操作', 55: '今日次数已用完', 56: '冷却中', 58: '需要先建集市' };
  function errText(rsp) {
    if (rsp && rsp.msg && rsp.msg.reason) return String(rsp.msg.reason);
    return ERR_TEXT[rsp && rsp.code] || ('失败（' + ((rsp && rsp.code) || '?') + '）');
  }
  // silent：启动早期（客户端模块尚未执行完，__slgSend 还没挂上）的预取不要弹提示，
  // 否则每次打开都会在登录页闪一条「尚未连上游戏」，看着像断线。
  function send(name, msg, silent) {
    if (!window.__slgSend) {
      if (!silent) toast('还没进入游戏，先点「进入游戏」', false);
      return Promise.reject(new Error('not ready'));
    }
    return window.__slgSend(name, msg || {}).then(function (r) { return r.rsp; })
      .catch(function () {
        if (!silent) toast('请求失败', false);
        throw new Error('send fail');
      });
  }
  function mkBtn(label, cls, onClick) {
    var b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><span>' + v + '</span></div>'; }

  /* ★ P7 普攻攻击距离：武将自己填了 attack_distance 就用，否则按兵种（盾3/弓4/骑3）。
     与 server/skills.js 的 attackDistanceOf 同口径，前端只做展示不做结算。 */
  function atkDistOf(g) {
    var own = Number(g && g.attack_distance) || 0;
    if (own > 0) return Math.max(1, Math.min(5, own));
    var a = Number(g && g.curArms) || 1;
    return a === 2 ? 4 : 3;
  }

  function confirmBox(title, lines, okLabel, cancelLabel, onOk) {
    var modal = el('div', 'modal');
    var box = el('div', 'box');
    box.innerHTML = '<h4 style="margin:0 0 8px;font-size:15px;color:#f0d998">' + title + '</h4>'
      + '<p>' + lines.join('<br>') + '</p>';
    var bar = el('div', 'bar');
    bar.appendChild(mkBtn(cancelLabel || '取消', 'ghost', function () { modal.remove(); }));
    bar.appendChild(mkBtn(okLabel || '确定', '', function () { modal.remove(); onOk(); }));
    box.appendChild(bar);
    modal.appendChild(box);
    host.appendChild(modal);
  }

  function fetchState() {
    return fetch('/__slg/strategy/state').then(function (r) { return r.json(); });
  }
  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, reason: '网络异常' }; });
  }
  var metaV = null;
  function loadMeta() {
    if (metaV) return Promise.resolve(metaV);
    return send('world.meta', {}).then(function (rsp) { metaV = rsp.msg; return rsp.msg; });
  }

  /* ★ P11 一屏一窗：任何新主窗口打开前，先收掉城市内部页与六府遮罩。
     过去「点城进城页」和「点出征开浮窗」会同时存在，互相盖住。 */
  function dismissCityAndPanels() {
    var city = document.getElementById('slgCityPage');
    if (city) {
      if (window.__slgCityClose) window.__slgCityClose();
      else city.remove();
    }
    var pm = document.getElementById('slgPanelsMask');
    if (pm) {
      if (window.__slgPanels && window.__slgPanels.close) {
        try { window.__slgPanels.close(); } catch (e) { /* 面板未就绪 */ }
      }
      pm.style.display = 'none';
    }
  }
  function makeWindow(id, title, subHtml, tabs, active, onTab, onClose) {
    dismissCityAndPanels();
    var old = document.getElementById(id);
    if (old) old.remove();
    var win = el('div', 'win');
    win.id = id;
    var head = el('div', 'win-head');
    head.innerHTML = '<b>' + title + '</b>' + (subHtml || '') + '<span class="x">✕</span>';
    win.appendChild(head);
    head.querySelector('.x').onclick = onClose;
    if (tabs && tabs.length) {
      var bar = el('div', 'tabs');
      tabs.forEach(function (t) {
        var b = document.createElement('button');
        b.textContent = t[1];
        if (active === t[0]) b.className = 'on';
        b.onclick = function () { onTab(t[0]); };
        bar.appendChild(b);
      });
      win.appendChild(bar);
    }
    var body = el('div', 'body');
    win.appendChild(body);
    /* ★ 关键修复：样式表里 .win 默认 display:none（本来指望调用方打开），
       但没有任何调用方设过 display —— 城池面板一直是「存在但不可见」，
       玩家点城池只看到左上角浮层，自然觉得「没有内政/出征面板」。 */
    win.style.display = 'block';
    host.appendChild(win);
    return body;
  }

  // 战役抉择（借粮/拒援）——DOM 弹窗，替代被遮罩挡住的 Cocos 弹窗
  window.__slgCampaignChoice = function (d) {
    confirmBox('乡人来问', [
      d.text || '是否借粮？',
      '<span class="cost">借粮：扣 ' + ((d.lend && d.lend.grain) || '?') + ' 粮，屯长来投，下一波黄巾减为 '
      + Math.round(((d.lend && d.lend.waveFactor) || 1) * 100) + '%</span><br>'
      + '<span class="cost">拒援：粮不动，下一波黄巾增至 '
      + Math.round(((d.refuse && d.refuse.waveFactor) || 1) * 100) + '%</span>',
    ], '借粮', '拒援', function () {
      send('campaign.choose', { option: 'lend' }).then(function (rsp) {
        toast(rsp.msg && rsp.msg.ok ? '已借粮。屯长入营。' : errText(rsp), rsp.msg && rsp.msg.ok);
      });
    });
  };

  function cityOf(s, id) {
    for (var i = 0; i < s.cities.length; i++) if (s.cities[i].id === Number(id)) return s.cities[i];
    return null;
  }
  /* 原客户端只认 state.citys 里的城 id（本地主城，通常 1）。
     城池设施协议要「双 id」：cityId 给客户端查城，realCityId 才是要操作的战略城。 */
  function clientCityId() {
    return (cache && cache.citys && cache.citys[0] && cache.citys[0].cityId) || 1;
  }
  function buildNeighbors(s) {
    neighbors = {};
    s.routes.forEach(function (r) {
      (neighbors[r.from] = neighbors[r.from] || []).push(r.to);
      (neighbors[r.to] = neighbors[r.to] || []).push(r.from);
    });
  }

  window.__slgCityWindow = function (cityId, tabId) {
    currentCity = Number(cityId);
    tab = tabId || 'overview';
    fetchState().then(function (s) {
      cache = s; buildNeighbors(s);
      refreshCityView(s);
    }).catch(function () {});
  };
  window.__slgCityClose = function () {
    var w = document.getElementById('slgCityWin');
    if (w) w.remove();
  };

  /* ================= ★ 出征面板 =================
     以前「出征」只是城池概览页底部一块：要先把城点开、再滚到底，只能按整城比例出兵，
     选不了队伍、看不到在途、也不能撤回。这里做成独立作战面板：
       出击（选出发城 → 选队伍 → 选目标）／行军队列（撤回）／战报。 */
  var WAR_REASON = {
    no_city: '目标城不存在', own_city: '那是自己的城，不用打',
    not_own_city: '出发城不是你的', no_army: '该城没有可用队伍',
    no_general: '该队还没有武将', no_troops: '该队没有兵',
    no_grain: '军粮不足', not_adjacent: '两城之间没有可通行军段',
    gate_blocked: '关隘封锁，出不去', marching: '该队正在行军',
    no_march: '这支队已不在途中', already_arrived: '已到城下，来不及撤了',
    bad_action: '未知操作', res_not_enough: '资源不足',
    cooldown: '冷却中', no_gold: '金不足', no_disaster: '眼下无灾可赈',
  };
  function warReason(rs) { return WAR_REASON[rs] || rs || '未知原因'; }
  function warTroops(a) {
    return (a && a.soldiers || []).reduce(function (n, v) { return n + Math.max(0, Number(v) || 0); }, 0);
  }
  /* 与 strategy.js 的 marchDaysBy 同口径：日 = ceil(km ÷ (55 × 速度/100))，夹 1~40 */
  function warDays(km, spd) {
    var v = Math.max(20, Number(spd) || 100);
    return Math.max(1, Math.min(40, Math.ceil((Number(km) || 0) / (55 * (v / 100)))));
  }
  function warOwnCities(s) {
    return (s.cities || []).filter(function (c) { return c.owner === 'player'; });
  }
  function warIdleArmies(s, cityId) {
    return (s.armies || []).filter(function (a) {
      if (Number(a.cityId) !== Number(cityId) || a.marching) return false;
      return (a.generals || []).some(function (g) { return !!g; }) && warTroops(a) > 0;
    });
  }
  function warGenLine(a) {
    return (a.generals || []).map(function (g) {
      return g ? esc(g.name) + '<span class="cost">（' + esc(g.arms || '') + '适性 ' + g.apt + '%）</span>' : '';
    }).filter(Boolean).join('、') || '<span class="cost">无武将</span>';
  }
  function warRefresh(s) {
    fetchState().then(function (s2) { cache = s2; buildNeighbors(s2); renderWar(s2); })
      .catch(function () { renderWar(s); });
  }

  window.__slgWarClose = function () {
    var w = document.getElementById('slgWarWin');
    if (w) w.remove();
    document.documentElement.removeAttribute('data-slg-window');
  };
  window.__slgWarWindow = function (opts) {
    opts = opts || {};
    if (opts.from) war.from = Number(opts.from);
    if (opts.cityId) war.target = Number(opts.cityId);
    if (opts.tab) war.tab = opts.tab;
    fetchState().then(function (s) {
      cache = s; buildNeighbors(s);
      if (!war.from || !warOwnCities(s).some(function (c) { return c.id === war.from; })) {
        war.from = s.playerCity;
      }
      renderWar(s);
    }).catch(function (e) {
      /* 渲染异常不再静默：否则面板只画一半，玩家以为「没这个功能」 */
      if (window.console) console.error('[slg] 出征面板渲染失败', (e && e.stack) || e);
      toast('出征面板渲染失败，请刷新重试', false);
    });
  };

  function renderWar(s) {
    var own = warOwnCities(s);
    if (!own.length) {
      var empty = makeWindow('slgWarWin', '出征', '<div class="sub">尚未举义</div>', [], 'go',
        function () {}, function () { var w = document.getElementById('slgWarWin'); if (w) w.remove(); });
      empty.appendChild(el('div', 'empty', '先在天下沙盘择主举义，有了自己的城才能出兵。'));
      return;
    }
    if (!war.from || !own.some(function (c) { return c.id === war.from; })) {
      war.from = own.some(function (c) { return c.id === s.playerCity; }) ? s.playerCity : own[0].id;
    }
    var fromCity = cityOf(s, war.from);
    var idle = warIdleArmies(s, war.from);
    if (!idle.some(function (a) { return a.id === war.armyId; })) {
      war.armyId = idle.length ? idle[0].id : 0;
    }
    var queue = (s.marches || []).filter(function (m) { return m.side === 'player' && !m.resolved; });
    var pending = s.pendingBattles || [];
    var digest = s.digest || [];
    /* ★ P11 / GDD §2.2 六道门：动机 → 集结 → 行军 → 遭遇 → 结算 → 消化，
       每一道门在面板里都有对应页签，不再「打完就没有下文」。 */
    var tabs = [
      ['go', '① 集结 · 出击'],
      /* 页签保留「行军队列」全称：玩家看得懂，回归脚本也按这个词找页签 */
      ['queue', '② 行军队列' + (queue.length ? '（' + queue.length + '）' : '')],
      ['encounter', '③ 遭遇' + (pending.length ? '（' + pending.length + '）' : '')],
      ['digest', '④ 消化' + (digest.length ? '（' + digest.length + '）' : '')],
      ['diplo', '外交'],
      ['log', '战报'],
    ];
    var body = makeWindow('slgWarWin', '出征',
      '<div class="sub">第 ' + s.day + ' 日 · 我军 ' + own.length + ' 城 · 在途 ' + queue.length + ' 支</div>',
      tabs, war.tab,
      function (t) { war.tab = t; renderWar(cache || s); },
      function () { var w = document.getElementById('slgWarWin'); if (w) w.remove(); });
    body.innerHTML = '';
    if (war.tab === 'go') warGoPanel(s, fromCity, idle, body);
    else if (war.tab === 'queue') warQueuePanel(s, queue, body);
    else if (war.tab === 'encounter') warEncounterPanel(s, pending, body);
    else if (war.tab === 'digest') warDigestPanel(s, digest, body);
    else if (war.tab === 'diplo') warDiploPanel(s, body);
    else warLogPanel(s, body);
    /* ★ #18：面板每次重绘都把「选到一半的输入」落一次，切走再回来原样还在 */
    saveWar();
  }

  /* ★ P11 / GDD §2.2 门 4：抵城不自动开打，先挂「遭遇」，推演过才让确认。 */
  function warEncounterPanel(s, pending, body) {
    if (!pending.length) {
      body.appendChild(el('div', 'empty',
        '当前没有待决的遭遇战。出征后抵达目标城下，队伍会在此等候主公定夺：可反复推演、也可临阵收兵。'));
      return;
    }
    pending.forEach(function (p) {
      var card = el('div', 'card',
        '<h4 style="margin-top:0">⚔ ' + esc(p.fromName) + ' → ' + esc(p.toName) + ' · 两军对阵</h4>'
        + '<div class="grid">'
        + kv('抵达', '第 ' + p.arriveDay + ' 日')
        + kv('我军', fmt(p.troops) + ' 兵')
        + kv('守军约', fmt(p.enemyTroops) + ' 兵')
        + kv('已耗军粮', fmt(p.grainCost))
        + '</div>'
        + '<div class="cost" style="margin-top:6px">此战不可逆：确认后才走正式结算并写战报；撤军退还一半军粮，部队回出发城。</div>');
      var out = el('div', '');
      card.appendChild(out);
      var bar = el('div', 'row');
      bar.style.cssText = 'border:none;gap:7px;justify-content:flex-start;padding-top:8px;';
      var pv = mkBtn('推演一次', 'ghost', function () {
        pv.disabled = true; out.innerHTML = '<div class="cost">沙盒演算中…</div>';
        postJSON('/__slg/strategy/action', {
          action: 'preview', cityId: p.to, fromCityId: p.from,
          armyId: p.armyId, frac: p.frac,
        }).then(function (rs) {
          pv.disabled = false;
          out.innerHTML = rs && rs.ok
            ? warPreviewHtml(rs)
            : '<div class="cost" style="color:#ff9d6b">推演失败：' + esc(warReason(rs && rs.reason)) + '</div>';
        });
      });
      bar.appendChild(pv);
      bar.appendChild(mkBtn('确认开战', '', function () {
        postJSON('/__slg/strategy/action', { action: 'battleConfirm', marchId: p.marchId })
          .then(function (rs) {
            if (!rs || !rs.ok) { toast('开战失败：' + warReason(rs && rs.reason), false); return; }
            toast(rs.result === 2 ? '攻下 ' + rs.city + '！请到「消化」页安置新城' : '战斗已结算，战报已生成', rs.result === 2);
            war.tab = 'log'; warRefresh(s);
          });
      }));
      bar.appendChild(mkBtn('临阵收兵', 'ghost', function () {
        postJSON('/__slg/strategy/action', { action: 'battleRetreat', marchId: p.marchId })
          .then(function (rs) {
            toast(rs && rs.ok ? ('已收兵，退粮 ' + fmt(rs.refund || 0)) : '收兵失败', !!(rs && rs.ok));
            war.tab = 'queue'; warRefresh(s);
          });
      }));
      card.appendChild(bar);
      body.appendChild(card);
    });
  }

  /* ★ P11 / GDD §2.2 门 6：占城之后给「这座城怎么用」的落点，不让流程断在战报。 */
  function warDigestPanel(s, digest, body) {
    if (!digest.length) {
      body.appendChild(el('div', 'empty', '暂无新占城池。攻下一城后，这里会列出待安置的城。'));
      return;
    }
    digest.forEach(function (d) {
      var card = el('div', 'card',
        '<h4 style="margin-top:0">新附 · ' + esc(d.name) + '</h4>'
        + '<div class="cost">第 ' + d.day + ' 日入版图。城破后民心、治安、人口俱损，'
        + '先办「劝课生息 / 赈灾 / 修城」，再考虑从此城出征。</div>');
      var bar = el('div', 'row');
      bar.style.cssText = 'border:none;gap:7px;justify-content:flex-start;padding-top:8px;';
      bar.appendChild(mkBtn('进城治理', '', function () {
        postJSON('/__slg/strategy/action', { action: 'digest', cityId: d.cityId }).then(function () {
          window.__slgWarClose && window.__slgWarClose();
          if (window.__slgCityInterior) window.__slgCityInterior(d.cityId, 'home');
        });
      }));
      bar.appendChild(mkBtn('看战报', 'ghost', function () { war.tab = 'log'; renderWar(s); }));
      card.appendChild(bar);
      body.appendChild(card);
    });
  }

  function warGoPanel(s, fromCity, idle, body) {
    var own = warOwnCities(s);
    /* ★ 出征向导：选出发城 → 选队伍/目标 → 看补给（推演可选）→ 确认。
       用户明确要求：推演不是强制前置，不看也能直接打。 */
    var rail = el('div', 'card',
      '<h4 style="margin-top:0">出征三步 · 选好就能打</h4>'
      + '<div class="cost" style="line-height:1.9">'
      + '① 选出发城与队伍　→　② 选目标城与出兵比例　→　③ 确认出征'
      + '<br><span style="opacity:.8">「战前推演」是可选参谋：想先看会死多少人再打就点一次；'
      + '不想看直接出征也完全可以。抵达后先进入「遭遇」页，可再次推演、确认开战或收兵。</span></div>');
    body.appendChild(rail);
    var fromCard = el('div', 'card', '<h4 style="margin-top:0">出发城</h4>');
    if (own.length > 1) {
      var selFrom = document.createElement('select');
      selFrom.style.cssText = 'background:#101208;color:#e2d6b8;border:1px solid #4a4436;'
        + 'border-radius:4px;padding:3px 8px;font:12px "Microsoft YaHei",sans-serif;';
      own.forEach(function (o) {
        var op = document.createElement('option');
        op.value = String(o.id);
        op.textContent = o.name + '（' + (o.armsCount || 0) + ' 队 / ' + fmt(o.troopSum || 0)
          + ' 兵 · 粮 ' + fmt(o.store || 0) + '）';
        if (o.id === war.from) op.selected = true;
        selFrom.appendChild(op);
      });
      selFrom.onchange = function () {
        war.from = Number(selFrom.value) || 0;
        war.armyId = 0;
        renderWar(cache);
      };
      var fromRow = el('div', 'row', '<span>自哪座城发兵</span>');
      fromRow.appendChild(selFrom);
      fromCard.appendChild(fromRow);
    } else {
      fromCard.appendChild(el('div', 'cost', '唯一据点：<b style="color:#f0d998">' + esc(fromCity.name) + '</b>'));
    }
    fromCard.appendChild(el('div', 'cost',
      '驻城兵力 ' + fmt(fromCity.troopSum || 0) + ' · 城防守军 ' + fmt(fromCity.troops || 0)
      + ' · 城库存粮 ' + fmt(fromCity.store || 0) + ' · 可派队伍 ' + idle.length + ' 支'));
    /* ★ U20 粮道：出征前就把「补给怎么走、断没断、能撑几天」说清楚 */
    var sup = fromCity.supply || null;
    if (sup) {
      var supOk = sup.connected !== false;
      var daily = Math.max(1, (fromCity.troopSum || 0) * 0.1);
      var hold = Math.floor((fromCity.store || 0) / daily);
      fromCard.appendChild(el('div', 'cost',
        '粮道：' + (supOk
          ? '<span style="color:#9ec97f">通 · ' + sup.hops + ' 跳 · 约 ' + sup.km + ' 里</span>'
            + (sup.via && sup.via.length ? '（经 ' + esc(sup.via.join(' → ')) + '）' : '（本城即都城）')
          : '<span style="color:#e07a5f">断绝 ' + (sup.days || 0) + ' 日 · 粮产仅五成、民心每旬 −3</span>')
        + '　城库可支撑约 ' + hold + ' 日'));
      if (sup.cut) {
        fromCard.appendChild(el('div', 'cost', '<span style="color:#e07a5f">'
          + '此刻出征，回来可能连补给点都没了：先打通通路或放弃这座飞地。</span>'));
      }
    }
    body.appendChild(fromCard);

    var armyCard = el('div', 'card', '<h4 style="margin-top:0">可派队伍</h4>');
    if (!idle.length) {
      armyCard.appendChild(el('div', 'empty',
        '本城没有可出征的队伍（须有武将带兵，行军中不算）。先到「征兵」页配将征募。'));
      /* ★ 别让玩家卡在「这座城没兵」：把其它城的可用队伍列出来，一键切过去 */
      var elsewhere = [];
      own.forEach(function (o) {
        if (o.id === war.from) return;
        warIdleArmies(s, o.id).forEach(function (a) { elsewhere.push({ city: o, army: a }); });
      });
      if (elsewhere.length) {
        armyCard.appendChild(el('div', 'cost', '这些城还有可派队伍，点一下就切过去：'));
        elsewhere.slice(0, 6).forEach(function (it) {
          var row = el('div', 'row', '<span>' + esc(it.city.name) + ' · 队伍#' + it.army.order
            + '<span class="cost">　' + fmt(warTroops(it.army)) + ' 兵 · 队速 '
            + Math.round(it.army.speed || 100) + '</span></span>');
          row.appendChild(mkBtn('以此为出发城', 'ghost', function () {
            war.from = it.city.id;
            war.armyId = it.army.id;
            renderWar(cache);
          }));
          armyCard.appendChild(row);
        });
      } else {
        armyCard.appendChild(el('div', 'cost', '全军都在行军或没有兵——先去「征兵」页配将征募。'));
        armyCard.appendChild(mkBtn('去本城征兵', '', function () {
          var w = document.getElementById('slgWarWin');
          if (w) w.remove();
          if (window.__slgCityWindow) window.__slgCityWindow(war.from, 'army');
        }));
      }
    }
    idle.forEach(function (a, ai) {
      var on = a.id === war.armyId;
      var row = el('div', 'row');
      /* GDD §10.4「1–3 切换我方槽位」：槽位就是这条可派队伍列表，
         data-army-index 从 1 起，交互层按键时按它取行。 */
      row.setAttribute('data-army-index', String(ai + 1));
      row.setAttribute('data-army-id', String(a.id));
      if (on) row.setAttribute('data-army-selected', '1');
      row.style.cssText = 'cursor:pointer;padding:8px;border-radius:5px;'
        + (on ? 'background:rgba(240,217,152,.10);border:1px solid #8a7038;' : 'border:1px solid #33302a;');
      row.innerHTML = '<span><b style="color:' + (on ? '#ffe9b0' : '#e2d6b8') + '">'
        + (ai < 3 ? '［' + (ai + 1) + '］' : '') + '队伍#' + a.order + '</b>'
        + '<span class="cost">　盾 ' + fmt(a.soldiers[0]) + ' / 弓 ' + fmt(a.soldiers[1])
        + ' / 骑 ' + fmt(a.soldiers[2]) + '　合计 <b style="color:#f0d998">' + fmt(warTroops(a))
        + '</b> 兵 · 队速 ' + Math.round(a.speed || 100) + '</span>'
        + '<div class="cost">' + warGenLine(a) + '</div></span>';
      row.appendChild(el('span', 'chip', on ? '已选' : '点选'));
      row.onclick = function () { war.armyId = a.id; renderWar(cache); };
      armyCard.appendChild(row);
    });
    body.appendChild(armyCard);

    var army = idle.filter(function (a) { return a.id === war.armyId; })[0] || null;
    var routes = (fromCity.marchRoutes || []).filter(function (r) {
      var t = cityOf(s, r.id);
      return t && t.owner !== 'player';
    });
    if (war.target && !routes.some(function (r) { return Number(r.id) === Number(war.target); })) {
      war.target = 0;
    }
    if (!war.target && routes.length) war.target = routes[0].id;

    var tgtCard = el('div', 'card', '<h4 style="margin-top:0">可攻目标</h4>');
    if (!routes.length) {
      tgtCard.appendChild(el('div', 'empty', '此城周边没有可通行又能打的邻城（关隘封锁或已被我军占据）。'));
    }
    routes.forEach(function (r) {
      var t = cityOf(s, r.id);
      if (!t) return;
      var days = warDays(r.km, army ? army.speed : 100);
      var mine = army ? Math.round(warTroops(army) * war.frac) : 0;
      var their = Number(t.troops) || 0;
      var on = Number(t.id) === Number(war.target);
      var odds = !army ? '<span class="cost">未选队伍</span>'
        : mine >= their * 1.25 ? '<span style="color:#a9e2a0">兵力占优</span>'
          : mine >= their * 0.9 ? '<span style="color:#e0c56a">胜负参半</span>'
            : '<span style="color:#ff6b5e">兵力偏少</span>';
      var row = el('div', 'row');
      row.style.cssText = 'cursor:pointer;padding:8px;border-radius:5px;'
        + (on ? 'background:rgba(240,217,152,.10);border:1px solid #8a7038;' : 'border:1px solid #33302a;');
      row.innerHTML = '<span><span class="dot" style="background:' + t.color + '"></span>'
        + '<b style="color:' + (on ? '#ffe9b0' : '#e2d6b8') + '">' + esc(t.name) + '</b>'
        + '<span class="cost">　' + esc(t.province) + '·' + esc(t.ownerName) + '·守军约 ' + fmt(their) + '</span>'
        + '<div class="cost">程 ' + fmt(r.km) + ' 里 · 预计 ' + days + ' 日 · ' + odds + '</div></span>';
      row.appendChild(el('span', 'chip', on ? '已选' : '点选'));
      row.onclick = function () { war.target = t.id; renderWar(cache); };
      tgtCard.appendChild(row);
    });
    body.appendChild(tgtCard);

    var target = war.target ? cityOf(s, war.target) : null;
    var route = target ? routes.filter(function (r) { return Number(r.id) === Number(target.id); })[0] : null;
    if (!army || !target || !route) {
      body.appendChild(el('div', 'card', '<div class="cost">'
        + (army ? '先选一座目标城。' : '先征兵整备一支能出战的队伍。') + '</div>'));
      return;
    }
    var total = warTroops(army);
    var deploy = Math.max(1, Math.round(total * war.frac));
    var days = warDays(route.km, army.speed);
    var grain = Math.ceil(deploy * 0.1);
    var sum = el('div', 'card', '<h4 style="margin-top:0">出兵概览</h4>');

    sum.appendChild(el('div', 'cost',
      '队伍#' + army.order + ' 共 <b style="color:#f0d998">' + fmt(total) + '</b> 兵，本役实出 '
      + '<b style="color:#f0d998">' + fmt(deploy) + '</b> 兵，留守 ' + fmt(total - deploy) + '。'));

    var seg = el('div', 'seg');
    [['all', '全军', 1], ['half', '半军', 0.5], ['third', '三成', 0.34]].forEach(function (m) {
      var b = document.createElement('button');
      b.textContent = m[1];
      if (Math.abs(war.frac - m[2]) < 0.001) b.className = 'on';
      b.onclick = function () { war.frac = m[2]; renderWar(cache); };
      seg.appendChild(b);
    });
    var segRow = el('div', 'row', '<span>出兵比例</span>');
    segRow.appendChild(seg);
    sum.appendChild(segRow);

    sum.appendChild(el('div', 'cost',
      '行军：程 <b style="color:#f0d998">' + fmt(route.km) + '</b> 里 · 队速 ' + Math.round(army.speed)
      + ' · 预计 <b style="color:#f0d998">' + days + '</b> 日抵达（约第 ' + (s.day + days) + ' 日）'
      + ' · 行军粮 ' + fmt(grain)
      + (days >= 10 ? '　<span class="cost">长途：途中需 ' + Math.floor(days / 10) + ' 次休整</span>' : '')));
    var theirs = Number(target.troops) || 0;
    sum.appendChild(el('div', 'cost',
      '目标守军约 ' + fmt(theirs) + '　'
      + (deploy >= theirs * 1.25 ? '<span style="color:#a9e2a0">兵力占优</span>'
        : deploy >= theirs * 0.9 ? '<span style="color:#e0c56a">胜负参半，看武将与兵种</span>'
          : '<span style="color:#ff6b5e">兵力偏少，建议先增兵或换小城</span>')));

    /* ★ 用户 2026-11-14：出征前允许不推演直接出征。旧实现把推演当第 4 道门，
       不推演按钮就是灰的 —— 那是把「参谋」做成了「关卡」。现在默认可用。 */
    var atkBtn = mkBtn('出征 ' + target.name, '', function () {
      warConfirmAttack(s, fromCity, army, target, route);
    });
    atkBtn.id = 'slgWarAttackBtn';
    /* ★ 本按钮点下去已经有「出兵确认」弹框，交互层不要再套一层成本预览——
       连点两次确认正是用户说的「操作繁琐」。 */
    atkBtn.setAttribute('data-ix-allow', '1');
    sum.appendChild(atkBtn);
    sum.appendChild(el('div', 'cost',
      '直接点「出征」即可，不必先推演；推演只用来提前看折损。'));
    body.appendChild(sum);
    body.appendChild(warPreviewCard(s, fromCity, army, target));
  }

  /* ★ 验收 #10 战前推演：服务端 previewAssault 走 structuredClone 沙盒 + 与正式结算同一套
     resolveBattle / defenseFor / battleSeedFor(…, arriveDay)，所以推演与真打逐位一致。
     这里允许多次点：每次重掷都是同一结果（同种子），点「改比例」再推演才变——可无限次回退重试，
     因为 preview 动作在 index.js 里被明确要求不 save()，绝不写存档。
     ★ 重要：推演是「可选的参谋」，不是出征的前置门。玩家想直接打就直接打。 */
  function warPreviewCard(s, fromCity, army, target) {
    var card = el('div', 'card');
    card.innerHTML = '<h4 style="margin-top:0">战前推演 <span class="cost" style="font-weight:normal">（可选）</span></h4>'
      + '<div class="cost">沙盒里按现行阵容打一遍：不耗粮、不动兵、不写存档。'
      + '不想推演也可以直接出征，推演只是让你提前知道会死多少人。</div>';
    var out = el('div', '');
    card.appendChild(out);
    var btn = mkBtn('推演一次', 'ghost', function () {
      btn.disabled = true; btn.textContent = '推演中…';
      out.innerHTML = '<div class="cost">按现行阵容于沙盒内演算…</div>';
      postJSON('/__slg/strategy/action', {
        action: 'preview', cityId: target.id, armyId: army.id,
        frac: war.frac, fromCityId: fromCity.id,
      }).then(function (rs) {
        btn.disabled = false; btn.textContent = '再推演一次';
        out.innerHTML = rs && rs.ok
          ? warPreviewHtml(rs)
          : '<div class="cost" style="color:#ff9d6b">推演失败：' + esc(warReason(rs && rs.reason)) + '</div>';
      }).catch(function () {
        btn.disabled = false; btn.textContent = '再推演一次';
        out.innerHTML = '<div class="cost" style="color:#ff9d6b">推演失败：服务端无响应</div>';
      });
    });
    btn.style.marginTop = '6px';
    btn.setAttribute('data-war-preview', '1');
    card.appendChild(btn);
    return card;
  }

  function warSum3(a) {
    return (a || []).reduce(function (n, v) { return n + Math.max(0, Number(v) || 0); }, 0);
  }

  /**
   * 推演结果 = 结论条 + 关键数字 + 胜负手 + 双方阵容 + 技术明细（折叠）。
   * 文案全部来自服务端 narrative（domain/battle-narrative.js），前端只排版。
   * 旧实现把 r.rounds（其实是 report.rounds 的 JSON 字符串）直接打进「判定」行，
   * 玩家看到的就是一屏 [{"b":[{"a_id":950081...] —— 这次从数据源上修掉。
   */
  function warPreviewHtml(r) {
    var n = r.narrative || {};
    var tone = n.tone === 'ok' ? '#a9e2a0' : (n.tone === 'warn' ? '#e0c56a' : '#ff6b5e');
    var html = '<div class="warpv">';
    html += '<div class="warpv-head" style="border-color:' + tone + '">'
      + '<div class="warpv-verdict" style="color:' + tone + '">' + esc(n.verdict || '推演完成') + '</div>'
      + '<div class="warpv-line">' + esc(n.headline || r.attribution || '') + '</div></div>';

    html += '<div class="warpv-rows">' + (n.rows || [
      { k: '投入兵力', v: '我军 ' + fmt(r.aTotal) + ' / 守军 ' + fmt(r.dTotal) },
      { k: '预计折损', v: '我军 −' + fmt(r.aLoss) + ' / 歼敌 ' + fmt(r.dLoss) },
    ]).map(function (row) {
      return '<div class="warpv-row"><span class="k">' + esc(row.k) + '</span><span class="v">' + esc(row.v) + '</span></div>';
    }).join('') + '</div>';

    if ((n.tips || []).length) {
      html += '<div class="warpv-tips"><b>该怎么打</b>'
        + n.tips.map(function (t) { return '<div class="ti">· ' + esc(t) + '</div>'; }).join('') + '</div>';
    }

    var force = function (title, list, color) {
      if (!list || !list.length) return '';
      return '<div class="warpv-force"><div class="ft" style="color:' + color + '">' + title + '</div>'
        + list.map(function (g) {
          return '<div class="fg"><b>' + esc(g.name) + '</b>'
            + (g.skills && g.skills.length
              ? g.skills.map(function (sk) {
                return '<div class="fs">「' + esc(sk.name) + '」' + esc(sk.effect || '') + '</div>';
              }).join('')
              : '<div class="fs" style="opacity:.6">无战法</div>')
            + '</div>';
        }).join('') + '</div>';
    };
    var forces = force('我军阵容', n.myNotes, '#e8c670') + force('守军阵容', n.defenderNotes, '#e08a7a');
    if (forces) html += '<div class="warpv-forces">' + forces + '</div>';

    /* 技术明细：战报码/种子/回合数这类东西只给想核对的人，默认折叠 */
    var detail = [];
    detail.push('判定结果码 ' + r.code + '（2=胜 / 1=相持 / 0=败）　演算 ' + (r.rounds || 0) + ' 回合');
    detail.push('战斗种子 0x' + ((Number(r.seed) >>> 0).toString(16).toUpperCase()) + '（同种子必得同战报）');
    if (r.intelNote) detail.push('情报：' + r.intelNote);
    if (r.variant) detail.push('敌方预案：' + r.variant.name + '　' + (r.variant.note || ''));
    if (r.spreadLines && r.spreadLines.length === 2) {
      var w0 = r.spreadLines[0], b0 = r.spreadLines[1];
      detail.push('守军区间：最坏折 ' + fmt(w0.aLoss) + '（' + (w0.win ? '可下' : '难下') + '）'
        + '　最好折 ' + fmt(b0.aLoss) + '（' + (b0.win ? '可下' : '难下') + '）');
    }
    if (r.variantLines && r.variantLines.length) {
      detail.push('若敌方变招：' + r.variantLines.map(function (v) {
        return v.variant + (v.win ? ' 我胜' : ' 我负') + '（折 ' + fmt(v.aLoss) + '）';
      }).join('　'));
    }
    if (r.lockNote) detail.push(r.lockNote);
    if (r.caveat) detail.push(r.caveat);
    html += '<details class="warpv-detail"><summary>演算明细（战报码 / 种子 / 区间）</summary>'
      + detail.map(function (t) { return '<div>' + esc(t) + '</div>'; }).join('') + '</details>';
    html += '</div>';
    return html;
  }

  function warConfirmAttack(s, fromCity, army, target, route) {
    var total = warTroops(army);
    var deploy = Math.max(1, Math.round(total * war.frac));
    var days = warDays(route.km, army.speed);
    var label = war.frac >= 1 ? '全军' : (war.frac === 0.5 ? '半军' : '三成');
    confirmBox('出兵确认', [
      '出发：<b>' + esc(fromCity.name) + '</b> → 目标：<b>' + esc(target.name) + '</b>'
        + '（' + esc(target.ownerName) + '·守军约 ' + fmt(target.troops) + '）',
      '队伍：<b>#' + army.order + '</b>　' + warGenLine(army),
      '规模：' + label + '，实出 <b>' + fmt(deploy) + '</b> 人（该队共 ' + fmt(total) + '）',
      '行军：程 ' + fmt(route.km) + ' 里 · 队速 ' + Math.round(army.speed) + ' · 预计第 ' + (s.day + days)
        + ' 日抵达 · 耗粮 ' + fmt(Math.ceil(deploy * 0.1)),
      '<span class="cost">抵达城下先进入「遭遇」待决，须主公确认开战或临阵收兵；战败折损、溃兵归营。行军途中可在「行军队列」页撤回。</span>',
    ], '出征', '取消', function () {
      postJSON('/__slg/strategy/action', {
        action: 'attack', cityId: target.id, armyId: army.id,
        frac: war.frac, fromCityId: fromCity.id,
        /* ★ P11：抵达先进「遭遇」页，不自动开打（GDD §3.2 门 4→5） */
        confirmBattle: true,
      }).then(function (rs) {
        if (rs && rs.ok) {
          toast('大军自' + (rs.from || fromCity.name) + '开拔，程 ' + Math.round(rs.km || route.km)
            + ' 里，预计第 ' + rs.arriveDay + ' 日抵城下（耗粮 ' + fmt(rs.grainCost) + '）', true);
          war.tab = 'queue';
          warRefresh(s);
        } else {
          toast('出兵失败：' + warReason(rs && rs.reason), false);
        }
      }).catch(function () { toast('出兵失败：服务端无响应', false); });
    });
  }

  /* ★ M2-4 外交（GDD §5.8）：只对 NPC，全部可解释——态度是公式（理由链逐条展开），
     拒绝必须带 {code,text,factors[]}；停战期内诸侯守约不进犯。 */
  function warDiploPanel(s, body) {
    var dip = (cache && cache.diplomacy) || s.diplomacy || { factions: [], day: s.day };
    var card = el('div', 'card', '<h4 style="margin-top:0">诸侯态度</h4>'
      + '<div class="cost">态度 = 史实基础 + 履约×5 − 背约×10 + 联姻 + 赠礼 − 边境摩擦 + 共同敌人 − 占其城×20。'
      + '拒绝必给理由；停战期内诸侯不进犯，但停战期攻城即毁约。</div>');
    var bar = function (v) {
      var n = Math.round((Math.max(-100, Math.min(100, Number(v) || 0)) + 100) / 20);
      return '<span class="cost">' + '▓'.repeat(Math.max(0, n)) + '░'.repeat(Math.max(0, 10 - n)) + '</span>';
    };
    if (!(dip.factions || []).length) {
      card.appendChild(el('div', 'empty', '天下诸侯尚未登场。'));
      body.appendChild(card);
      return;
    }
    var act = function (label, faction, diploAction, extraFn, disabled) {
      var b = mkBtn(label, disabled ? 'ghost' : '', function () {
        var extra = (typeof extraFn === 'function') ? (extraFn() || {}) : (extraFn || {});
        postJSON('/__slg/strategy/action', Object.assign({ action: 'diplo', diploAction: diploAction, faction: faction }, extra))
          .then(function (rs) {
            toast(rs.text || (rs.ok ? '外交已成' : '外交未成'), !!rs.ok);
            fetchState().then(function (s2) { cache = s2; renderWar(cache); });
          })
          .catch(function () { toast('外交动作失败：服务端无响应', false); });
      });
      b.style.margin = '0';
      if (disabled) b.disabled = true;
      return b;
    };
    (dip.factions || []).forEach(function (f) {
      var row = el('div', 'row');
      var flag = [];
      if (f.war) flag.push('<span style="color:#ff6b5e">交战</span>');
      if (f.ally) flag.push('<span style="color:#a9e2a0">盟友</span>');
      if (Number(f.truceUntil) > Number(dip.day || s.day)) flag.push('停战至第 ' + f.truceUntil + ' 日');
      if (f.pass) flag.push('通行权');
      if (f.marriage) flag.push('姻亲');
      if (Number(f.occupied) > 0) flag.push('占其 ' + f.occupied + ' 城');
      var factors = (f.factors || []).filter(function (x) { return x.delta; })
        .map(function (x) { return x.label + (x.delta > 0 ? '+' : '') + x.delta; }).join('　');
      row.innerHTML = '<span><b style="color:' + esc(f.color || '#f0d998') + '">' + esc(f.name) + '</b>'
        + '<span class="cost">　都城 ' + esc(f.home || '—') + ' · 兵 ' + fmt(f.troops) + '（我/彼 ' + f.troopsRatio + '）'
        + (flag.length ? ' · ' + flag.join(' · ') : '') + '</span>'
        + '<div class="cost">态度 ' + bar(f.attitude) + ' <b>' + f.attitude + '</b>'
        + (factors ? '<div style="opacity:.65">' + esc(factors) + '</div>' : '') + '</div></span>';
      var ops = el('div', '');
      ops.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 10px;align-items:center;';
      ops.appendChild(act('停战(1500金)', f.id, 'truce', null, f.gates.truce && !f.gates.truce.ok));
      ops.appendChild(act('通行权(800金)', f.id, 'pass', null, f.gates.pass && !f.gates.pass.ok));
      ops.appendChild(act('结盟', f.id, 'ally', null, f.gates.ally && !f.gates.ally.ok));
      ops.appendChild(act('联姻(3000金)', f.id, 'marriage', null, f.gates.marriage && !f.gates.marriage.ok));
      if (f.gates.requestAttack && f.gates.requestAttack.ok) {
        var sel = el('select');
        sel.style.cssText = 'max-width:104px';
        (dip.factions || []).concat([{ id: 'han', name: '汉廷' }]).forEach(function (t) {
          if (t.id === f.id || t.id === 'player') return;
          var o = el('option'); o.value = t.id; o.textContent = t.name; sel.appendChild(o);
        });
        ops.appendChild(sel);
        ops.appendChild(act('请攻(2000金)', f.id, 'requestAttack', function () { return { target: sel.value }; }, false));
      } else {
        ops.appendChild(act('请攻(2000金)', f.id, 'requestAttack', null, true));
      }
      ops.appendChild(act('劝降', f.id, 'surrender', null, f.gates.surrender && !f.gates.surrender.ok));
      ops.appendChild(act('离间(800金)', f.id, 'sow', null, false));
      ops.appendChild(act('赠礼500', f.id, 'gift', { gold: 500 }, false));
      row.appendChild(ops);
      card.appendChild(row);
    });
    body.appendChild(card);
  }

  /* ★ 验收 #23：行军队列可重排 + 可批量撤回。
     重排不是摆设——strategyResolveMarches 按数组顺序逐支结算，同日抵达同一座城时，
     排在前面的那支面对原守军，后到的可能只看到已易主的城直接班师。
     所以「谁先打」是玩家真决策：弱队先消耗、强队补刀，或强队先破城，都要能改顺序。 */
  function warQueuePanel(s, queue, body) {
    var sel = {};
    var card = el('div', 'card', '<h4 style="margin-top:0">在途 ' + queue.length + ' 支'
      + '<span class="cost" style="font-weight:normal">　顺序即同日结算顺序</span></h4>');
    if (!queue.length) {
      card.appendChild(el('div', 'empty', '当前没有行军中的队伍。'));
      body.appendChild(card);
      return;
    }
    card.appendChild(el('div', 'cost',
      '同日抵达同一座城时，排在前面的先打；后到的若城已易主会直接班师。勾选可批量撤回。'));

    var listBox = el('div', '');
    var bar = el('div', 'row');
    var cntEl = el('span', 'cost', '未选');
    var paint = null;

    var bAll = mkBtn('全选', 'ghost', function () { queue.forEach(function (m) { sel[m.id] = true; }); paint(); });
    var bNone = mkBtn('清空', 'ghost', function () { sel = {}; paint(); });
    var bDo = mkBtn('撤回选中', 'ghost', function () { warBatchRecall(s, queue.filter(function (m) { return sel[m.id]; })); });
    bar.appendChild(cntEl); bar.appendChild(bAll); bar.appendChild(bNone); bar.appendChild(bDo);
    card.appendChild(bar);
    card.appendChild(listBox);

    paint = function () {
      var n = queue.filter(function (m) { return sel[m.id]; }).length;
      cntEl.textContent = n ? ('已选 ' + n + ' 支') : '未选';
      listBox.innerHTML = '';
      queue.forEach(function (m, idx) {
        var left = Math.max(0, m.remainDays != null ? m.remainDays : (m.arriveDay - s.day));
        var pct = Math.round((m.progress || 0) * 100);
        var row = el('div', 'row');

        var ck = document.createElement('input');
        ck.type = 'checkbox';
        ck.checked = !!sel[m.id];
        ck.style.cssText = 'margin:0 4px 0 0;vertical-align:-1px;cursor:pointer;';
        ck.onchange = function () { if (ck.checked) sel[m.id] = true; else delete sel[m.id]; paint(); };

        var head = el('span', '');
        head.style.cursor = 'pointer';
        head.innerHTML = '<b style="color:#f0d998">' + (idx + 1) + '. '
          + (m.kind === 'transport' ? '辎重队' : ('队伍#' + (m.armyId || '?'))) + '</b>'
          + '<span class="cost">　' + esc(m.fromName || m.from) + ' → ' + esc(m.toName || m.to) + '</span>'
          + '<div class="cost">程 ' + fmt(m.km) + ' 里 · 第 ' + m.departDay + ' 日发 → 第 ' + m.arriveDay + ' 日到 · '
          + (left > 0 ? ('余 <b style="color:#f0d998">' + left + '</b> 日（' + pct + '%）') : '<b style="color:#ff9d6b">已抵城下</b>')
          + (m.kind === 'transport'
            ? '　粮 ' + fmt(m.grain)
            : '　兵 ' + fmt(m.troops) + ' · 耗粮 ' + fmt(m.grainCost))
          + '</div>';
        head.onclick = function () {
          if (ck.checked) { ck.checked = false; delete sel[m.id]; } else { ck.checked = true; sel[m.id] = true; }
          paint();
        };

        var ops = el('span', '');
        ops.style.display = 'flex'; ops.style.gap = '4px';
        var up = mkBtn('▲', 'ghost', function () { warReorder(s, m.id, -1); });
        var dn = mkBtn('▼', 'ghost', function () { warReorder(s, m.id, 1); });
        up.style.margin = '0'; dn.style.margin = '0';
        if (idx === 0) up.disabled = true;
        if (idx === queue.length - 1) dn.disabled = true;
        var btn = mkBtn('撤回', 'ghost', function () {
          confirmBox('撤回行军', [
            '<b>' + esc(m.fromName || m.from) + ' → ' + esc(m.toName || m.to) + '</b>',
            '<span class="cost">' + (m.kind === 'transport'
              ? '粮车折返，八成粮回府库（两成路上损耗）。'
              : '队伍回到出发城并解锁，行军粮退回一半。') + '</span>',
          ], '撤回', '继续行军', function () {
            postJSON('/__slg/strategy/action', { action: 'recall', marchId: m.id }).then(function (rs) {
              if (rs && rs.ok) {
                toast('已撤回' + rs.from + '，退回粮 ' + fmt(rs.refund), true);
                warRefresh(s);
              } else toast('撤回失败：' + warReason(rs && rs.reason), false);
            }).catch(function () { toast('撤回失败：服务端无响应', false); });
          });
        });
        btn.style.margin = '0';
        ops.appendChild(up); ops.appendChild(dn); ops.appendChild(btn);

        row.appendChild(ck); row.appendChild(head); row.appendChild(ops);
        listBox.appendChild(row);
      });
    };
    paint();

    body.appendChild(card);
    body.appendChild(el('div', 'cost',
      '行军日数 = 里程 ÷（55 × 队速/100），队速取队内最慢武将，长途最多 40 日。'
      + '已抵城下的队伍当天就会结算，撤不回来。'));
  }

  function warReorder(s, marchId, dir) {
    postJSON('/__slg/strategy/action', { action: 'reorder', marchId: marchId, dir: dir })
      .then(function (rs) {
        if (rs && rs.ok) {
          toast('已' + (dir < 0 ? '前移' : '后移') + '，现居第 ' + rs.order + ' 位（同日先结算）', true);
          warRefresh(s);
        } else {
          var why = { edge: '已经到头了', blocked: '相邻那支不是你的队伍（或已结算）', no_march: '该队已出发或已抵达' };
          toast('调整失败：' + (why[rs && rs.reason] || '队列里找不到这支队'), false);
        }
      }).catch(function () { toast('调整失败：服务端无响应', false); });
  }

  /* 批量撤回：服务端只有单支撤回的动作口（撤回要退粮、要解锁队伍、要记归因），
     这里顺序发 N 次请求，逐个汇报结果——不做「假批量」的前端乐观更新。 */
  function warBatchRecall(s, picked) {
    var ids = (picked || []).map(function (m) { return m.id; });
    if (!ids.length) { toast('先勾选要撤回的队伍', false); return; }
    confirmBox('批量撤回 ' + ids.length + ' 支', [
      '撤回后队伍回到各自出发城并解锁，行军粮各退一半（辎重队退八成）。',
      '<span class="cost">共 ' + ids.length + ' 支，逐支处理并汇总结果。</span>',
    ], '全部撤回', '再想想', function () {
      var left = ids.slice(), done = 0, failed = 0, refund = 0;
      var step = function () {
        if (!left.length) {
          toast('已撤回 ' + done + ' 支，退回粮 ' + fmt(refund) + (failed ? ('；' + failed + ' 支未能撤回') : ''), !failed);
          warRefresh(s);
          return;
        }
        var id = left.shift();
        postJSON('/__slg/strategy/action', { action: 'recall', marchId: id }).then(function (rs) {
          if (rs && rs.ok) { done += 1; refund += Number(rs.refund) || 0; } else failed += 1;
          step();
        }).catch(function () { failed += 1; step(); });
      };
      step();
    });
  }

  function warLogPanel(s, body) {
    var events = (s.events || []).filter(function (e) {
      var t = String(e.text || '');
      return t.indexOf('攻') >= 0 || t.indexOf('陷') >= 0 || t.indexOf('出征') >= 0
        || t.indexOf('军') >= 0 || t.indexOf('折返') >= 0;
    }).slice(0, 24);
    var card = el('div', 'card', '<h4 style="margin-top:0">近期军报</h4>');
    if (!events.length) card.appendChild(el('div', 'empty', '暂无军报。'));
    events.forEach(function (e) {
      card.appendChild(el('div', 'cost', '第 ' + (e.month != null ? e.month : '?') + ' 月　' + esc(e.text)));
    });
    body.appendChild(card);
    if (s.captives && s.captives.length) {
      body.appendChild(el('div', 'cost',
        '阵前被俘 ' + s.captives.length + ' 人，可在六府「武将」页花 300 金招降。'));
    }
  }

  window.__slgHomeWindow = function () {
    /* ★ P11：「本城」按钮与点地图城池同一个落点，避免两套城池界面并存 */
    fetchState().then(function (s) {
      cache = s; buildNeighbors(s);
      window.__slgCityInterior(s.playerCity || 1);
    }).catch(function () {});
  };

  /* ★ P11：tab 渲染器（内政/征兵/府库…）操作完成后统一走这里刷新。
     旧实现一律 renderCity()，在城内页里点一次按钮就会把旧的 slgCityWin 浮窗
     又弹出来，形成两套城池界面。现在按当前实际打开的视图二选一重绘。 */
  function refreshCityView(s) {
    var data = s || cache;
    var c = cityOf(data, currentCity);
    if (!c) return;
    if (document.getElementById('slgCityPage')) renderCityPage(data, c);
    else renderCity(data);
  }
  /* ★ 征兵/内政这类会改服务端状态的操作，必须「重新取一次 state 再重绘」。
     旧实现直接拿面板手里的旧 city 对象重绘，「本旬可征 / 已征户」全是旧值，
     玩家再点一次一键征兵必然撞 cooldown —— 看起来就是「一键征兵失败」。 */
  function reloadCityView() {
    return fetch('/__slg/strategy/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s2) {
        if (!s2 || !s2.cities) return;
        cache = s2; lastState = s2;
        var c2 = cityOf(s2, currentCity);
        if (!c2) return;
        if (document.getElementById('slgCityPage')) renderCityPage(s2, c2);
        else renderCity(s2);
      })
      .catch(function () { /* 服务重启瞬间：保留当前画面 */ });
  }
  /* ── 重绘不抢滚动条 ────────────────────────────────────────────────────
   * 玩家反馈：内政面板升一个设施，滚动条就跳回最上面，下次升级还得重新往下拖。
   * 根因不是某个按钮写错了，而是「操作 → 重新取 state → 重绘」这条路径本身：
   *   整屏城内页会重建 #slgCityBody、浮窗会让 makeWindow 重建 .win .body，
   * 容器一换，scrollTop 必然归零；tabHome 那类在原地 innerHTML='' 再填充的，
   * 清空瞬间滚动位置也被夹到 0，之后内容长回来也不会自己复原。
   * 所以修在重绘边界上：按「容器 + 页签 + 城池」记住滚动位置，重绘后还原。
   * 换页签时用该页签自己的记忆（第一次进就是 0，本来也该在顶部）。
   * ------------------------------------------------------------------ */
  var SCROLL_MEM = {};
  var SCROLL_TIMERS = {};
  function scrollSlot(kind) {
    return kind + '|' + tab + '|' + (currentCity == null ? '-' : currentCity);
  }
  function scrollRemember(kind, node) {
    if (node) SCROLL_MEM[scrollSlot(kind)] = Math.max(0, node.scrollTop || 0);
  }
  /* 设施/府库这类卡片要等协议回包才长出高度，第一次设值会被「当前太短」夹住，
     所以下一帧与 160ms 后各补一次；容器已销毁则静默跳过。 */
  function scrollApply(kind, node) {
    if (!node) return;
    var want = SCROLL_MEM[scrollSlot(kind)] || 0;
    if (want <= 0) return;
    var fix = function () {
      if (!node.isConnected) return;
      if (node.scrollHeight - node.clientHeight >= want - 1) node.scrollTop = want;
    };
    node.scrollTop = want;
    clearTimeout(SCROLL_TIMERS[kind]);
    requestAnimationFrame(fix);
    SCROLL_TIMERS[kind] = setTimeout(fix, 160);
  }

  function renderCity(s) {
    var c = cityOf(s, currentCity);
    if (!c) { window.__slgCityClose(); return; }
    /* 浮窗形态：makeWindow 会把旧窗整块删掉重建，先记下当前滚动位置 */
    scrollRemember('win', document.querySelector('#slgUIv2 .win .body'));
    var isHome = s.playerCity === c.id;
    /* ★ P7：内政页对所有己方城统一（治理卡 + 五项内政任务）；
       府库/设施/存档属于本地主城，单列「府库」页，只在主城出现。 */
    if (tab === 'base' && !isHome) tab = 'overview';
    var tabs = [['overview', '概览'], ['home', '内政'], ['army', '征兵'], ['gens', '武将'], ['tavern', '酒馆'], ['reports', '战报']];
    if (isHome) tabs.push(['base', '府库']);
    var title = c.name + (c.level === 3 ? '<span class="badge cap">州治</span>' : '')
      + (isHome ? '<span class="badge home">本城</span>' : '');
    var body = makeWindow('slgCityWin', title,
      '<div class="sub">' + c.province + ' · <span style="color:' + c.color + '">' + c.ownerName
      + '</span>' + (c.owner === 'player'
        ? ' · 驻城 ' + fmt(c.troopSum || 0) + ' 兵 · 城防 ' + fmt(c.troops)
        : ' · 守军约 ' + fmt(c.troops)) + '</div>',
      tabs,
      tab,
      function (t) { tab = t; refreshCityView(s); },
      window.__slgCityClose);
    body.innerHTML = '';
    if (tab === 'overview') tabOverview(s, c, body, isHome);
    else if (tab === 'home') tabInteriorView(c, body);
    else if (tab === 'base') tabHome(body, c);
    else if (tab === 'army') tabArmy(body, c);
    else if (tab === 'gens') { if (isHome) renderGensInto(body); else tabGeneralView(c, body); }
    else if (tab === 'tavern') { if (isHome) renderTavernInto(body); else tabTavernView(c, body); }
    else if (tab === 'reports') renderReportsInto(body, c);
    scrollApply('win', body);
  }

  /* ==========================================================================
   * ★ P11 · 城市内部页
   * 以前点地图城池只弹右侧 520px 浮窗，和六府 / 透镜 / 当前事务 / 出征窗叠成一团。
   * 现在点城即「进城」：整屏一页，左侧常驻页签，右侧内容区；己方城默认落在「内政」，
   * 玩家一进来就能办本城的事，不用再找按钮。内容复用 renderCity 的同一批 tab 渲染器，
   * 保证「城池窗」与「城内页」显示的是同一份数据，不产生第二套口径。
   * ======================================================================== */
  function cityPageTabs(s, c, isHome) {
    var tabs = [['overview', '概览'], ['home', '内政'], ['army', '征兵'], ['gens', '武将'], ['tavern', '酒馆'], ['reports', '战报']];
    if (isHome) tabs.push(['base', '府库']);
    return tabs;
  }
  function cityPageContent(s, c, body, isHome) {
    body.innerHTML = '';
    if (tab === 'overview') tabOverview(s, c, body, isHome);
    else if (tab === 'home') tabInteriorView(c, body);
    else if (tab === 'base') tabHome(body, c);
    else if (tab === 'army') tabArmy(body, c);
    else if (tab === 'gens') { if (isHome) renderGensInto(body); else tabGeneralView(c, body); }
    else if (tab === 'tavern') { if (isHome) renderTavernInto(body); else tabTavernView(c, body); }
    else if (tab === 'reports') renderReportsInto(body, c);
  }
  function renderCityPage(s, c) {
    var isHome = s.playerCity === c.id;
    if (tab === 'base' && !isHome) tab = 'overview';
    /* 进/切城内页时同步清掉其它主窗口，不等 MutationObserver 的 30ms 兜底 */
    Array.prototype.forEach.call(document.querySelectorAll('#slgUIv2 .win'), function (w) { w.remove(); });
    var pm0 = document.getElementById('slgPanelsMask');
    if (pm0) {
      if (window.__slgPanels && window.__slgPanels.close) {
        try { window.__slgPanels.close(); } catch (e) { /* 面板未就绪 */ }
      }
      pm0.style.display = 'none';
    }
    var page = document.getElementById('slgCityPage');
    if (!page) {
      page = el('div', 'citypage');
      page.id = 'slgCityPage';
      host.appendChild(page);
    }
    /* 下面 page.innerHTML 会把 #slgCityBody 一起重建，先记住玩家当前看到哪一段 */
    scrollRemember('page', page.querySelector('#slgCityBody'));
    var lv = c.levy || null;
    var pill = function (k, v) { return '<div class="pill"><small>' + k + '</small><b>' + v + '</b></div>'; };
    page.innerHTML = '<div class="citypage-head">'
      + '<div><div class="ct">' + esc(c.name) + (c.level === 3 ? ' · 州治' : '') + '</div>'
      + '<div class="cs">' + esc(c.province) + ' · <span style="color:' + c.color + '">' + esc(c.ownerName) + '</span>'
      + ' · 第 ' + (s.day || 1) + ' 日' + (isHome ? ' · 都城' : '') + '</div></div>'
      + '<div class="pills">'
      + pill('人口', fmt(c.pop || c.population || 0))
      + pill('城库粮', fmt(c.store || 0))
      + pill(c.owner === 'player' ? '驻城兵' : '守军约', fmt(c.owner === 'player' ? (c.troopSum || 0) : (c.troops || 0)))
      + pill('民心', c.morale != null ? c.morale : '—')
      + (lv ? pill('本旬可征', fmt(lv.quota)) : '')
      + '</div><div class="citypage-acts">'
      + '<button class="tick" id="slgCityTick" title="与沙盘上的「推演一月」同一实现">推演一旬</button>'
      + '<button class="back" id="slgCityBack">← 返回沙盘</button></div></div>'
      /* id="slgCityWin" 是给既有回归资产（smoke / ui-audit 的 #slgCityWin 选择器）
         与旧调用方留的兼容锚点：它现在是「城内页主体」，不再是右侧浮窗。
         nav 带 .tabs 语义类，页签选择器不用改，视觉由 .citypage-nav 的更高优先级规则兜住。 */
      + '<div class="citypage-main" id="slgCityWin"><div class="citypage-nav tabs" id="slgCityNav"></div>'
      + '<div class="citypage-body" id="slgCityBody"></div></div>';
    page.querySelector('#slgCityBack').onclick = function () { window.__slgCityClose(); };
    page.querySelector('#slgCityTick').onclick = function () { window.__slgTick(); };
    var nav = page.querySelector('#slgCityNav');
    nav.appendChild(el('div', 'nt', '城 内 事 务'));
    var tabs = cityPageTabs(s, c, isHome);
    tabs.forEach(function (t) {
      var b = el('button', tab === t[0] ? 'on' : '', esc(t[1]));
      b.setAttribute('data-citytab', t[0]);
      b.onclick = function () { tab = t[0]; renderCityPage(s, c); };
      nav.appendChild(b);
    });
    nav.appendChild(el('div', 'spacer'));
    if (c.owner === 'player') {
      var war = el('button', '', '⚔ 自本城出征');
      war.setAttribute('data-citytab', 'war');
      war.setAttribute('data-ix-allow', '1'); // 只开面板，不是真正出征，免决策预览
      war.onclick = function () {
        window.__slgCityClose();
        if (window.__slgWarWindow) window.__slgWarWindow({ cityId: c.id, from: c.id, tab: 'go' });
      };
      nav.appendChild(war);
    }
    nav.appendChild(el('div', 'hint',
      (c.owner === 'player'
        ? '己方城：内政与征兵均在此办理。征兵按「一户一丁」，本旬只能征一次。'
        : '敌方城：先看概览与守军，进攻请从「自本城出征」发起。')));
    cityPageContent(s, c, page.querySelector('#slgCityBody'), isHome);
    scrollApply('page', page.querySelector('#slgCityBody'));
    document.documentElement.setAttribute('data-slg-window', 'city');
  }

  /** 点地图城池 / 任何旧入口的统一落点：进入城市内部页。 */
  window.__slgCityInterior = function (cityId, tabId) {
    var cid = Number(cityId) || Number(cache && cache.playerCity) || 0;
    if (!cid) return;
    currentCity = cid;
    tab = tabId || 'home';
    fetchState().then(function (s) {
      cache = s; buildNeighbors(s);
      var c = cityOf(s, cid);
      if (!c) return;
      if (!tabId) tab = c.owner === 'player' ? 'home' : 'overview';
      renderCityPage(s, c);
    }).catch(function () { toast('城池数据未就绪，稍后再点一次', false); });
  };
  /* 老调用方（六府 / 战报回跳 / 出征面板「去本城征兵」）全部改走城内页 */
  window.__slgCityWindow = window.__slgCityInterior;
  window.__slgCityClose = function () {
    var p = document.getElementById('slgCityPage');
    if (p) p.remove();
    var w = document.getElementById('slgCityWin');
    if (w) w.remove();
    document.documentElement.removeAttribute('data-slg-window');
  };

  /* 设施卡：初次挂载与「升级后刷新」共用同一个函数。
     ★ 升级后只重画这一张卡，不再整页重绘 —— 整页重绘会把滚动条一起重置，
     玩家升一个设施就被踹回顶部（玩家 2026-11-14 反馈的原问题）。 */
  function mountFacilitiesCard(card, c) {
    var head = '<h4 style="margin-top:0">' + esc(c.name) + ' · 设施</h4>';
    card.innerHTML = head + '<div class="empty">读取中…</div>';
    send('city.facilities', { cityId: clientCityId(), realCityId: c.id }, true).then(function (rsp) {
      var list2 = (rsp.msg && rsp.msg.facilities) || [];
      card.innerHTML = head;
      if (!list2.length) { card.appendChild(el('div', 'empty', '本城暂无设施数据。')); return; }
      var COST = [['wood', '木'], ['iron', '铁'], ['stone', '石'], ['grain', '粮'], ['gold', '金'], ['decree', '令']];
      list2.forEach(function (f) {
        var row = el('div', 'row');
        var chips = f.level >= f.maxLevel ? '已满级' : COST.filter(function (k) {
          return f.nextNeed && f.nextNeed[k[0]];
        }).map(function (k) {
          return k[1] + ' ' + fmt(f.nextNeed[k[0]]);
        }).join(' · ') + (f.nextTime ? '　工期 ' + f.nextTime + 's' : '');
        row.innerHTML = '<span><b style="color:#f0d998">' + esc(f.name) + '</b> '
          + '<span class="winTag">Lv' + f.level + '/' + f.maxLevel + '</span>'
          + '<div class="cost">' + chips + '</div></span>';
        if (f.up_time > 0) {
          row.appendChild(el('span', 'cost', '升级中…'));
        } else if (f.level >= f.maxLevel) {
          row.appendChild(el('span', 'cost', '—'));
        } else {
          row.appendChild(mkBtn('升级', '', function () {
            send('city.upFacility', { cityId: clientCityId(), realCityId: c.id, fType: f.type }).then(function (r2) {
              if (r2.code === 0) toast(f.name + ' 开始升级', true);
              else toast('升级失败：' + errText(r2), false);
              /* 只刷这张卡：等级/「升级中…」立刻更新，滚动位置与其它卡片原样不动 */
              mountFacilitiesCard(card, c);
              /* 战略层缓存也要新（别处再进内政拿到的是旧值），但不重绘页面 */
              fetchState().then(function (s2) { cache = s2; lastState = s2; }).catch(function () {});
            });
          }));
        }
        card.appendChild(row);
      });
    }).catch(function () {
      card.innerHTML = head + '<div class="cost">设施读取失败，稍后再试。</div>';
    });
  }

  function tabInteriorView(c, body) {
    /* ★ P6 己方非主城：城池内政任务（开垦/招商/募兵/修城/赈灾），每城每旬一次
       ★ P7：加上逐城民心/治安与四项开发度等级，城与城的差别看得见 */
    if (c.owner === 'player') {
      var bar = function (v, max) {
        var n = Math.max(1, Math.round((Number(v) || 0) / (max || 120) * 10));
        return '<span class="cost">' + '▓'.repeat(Math.min(10, n)) + '░'.repeat(Math.max(0, 10 - n)) + '</span>';
      };
      var card = el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 治理</h4>'
        + '<div class="grid">'
        + kv('民心', (c.morale != null ? c.morale : '—') + '　' + bar(c.morale, 100))
        + kv('治安', (c.order != null ? c.order : '—') + '　' + bar(c.order, 100))
        + kv('农田', 'Lv' + (c.lvAgri || 1) + ' · ' + (c.devAgri || 0) + '/120')
        + kv('市集', 'Lv' + (c.lvTrade || 1) + ' · ' + (c.devTrade || 0) + '/120')
        + kv('兵营', 'Lv' + (c.lvArms || 1) + ' · ' + (c.devArms || 0) + '/120')
        + kv('城防', 'Lv' + (c.lvDef || 1) + ' · ' + (c.devDef || 0) + '/120')
        + kv('人口', fmt(c.pop))
        + kv('城库存粮', fmt(c.store))
        + kv('粮道', (c.supply && c.supply.connected === false)
          ? ('<span style="color:#e07a5f">断绝 ' + (c.supply.days || 0) + ' 日</span>')
          : ('通 · ' + ((c.supply && c.supply.hops) || 0) + ' 跳'))
        + '</div>');
      if (c.supply && c.supply.connected === false) {
        card.appendChild(el('div', 'cost', '<span style="color:#e07a5f">'
          + '粮道断绝：本城与都城之间没有己方通路。每旬民心 −3、治安 −1、守军逃散 2%、粮产仅五成。'
          + '打通沿途城池，或集中兵力守住这里等援。</span>'));
      }
      body.appendChild(card);

      /* ★ U14 任务状：先列在施任务（进度/执行武将/每旬增量/撤销），再列可派的五项委派 */
      var taskCard = el('div', 'card', '<h4 style="margin-top:0">内政任务状</h4>');
      var tasks = c.interiorTasks || [];
      if (!tasks.length) {
        taskCard.appendChild(el('div', 'empty', '本城暂无内政任务。选一项委派，会按执行武将能力在 1~3 旬内完工。'));
      } else {
        tasks.forEach(function (t) {
          var active = t.status === 'active';
          var head = '<b style="color:#f0d998">' + esc(t.label) + '</b> '
            + '<span class="winTag">' + (active ? ('进行中 · 第 ' + (t.doneTicks + 1) + '/' + t.ticks + ' 旬') : (t.status === 'done' ? '已完工' : '已撤销')) + '</span>';
          var bar = '▓'.repeat(Math.max(0, Math.round(t.pct / 10))) + '░'.repeat(Math.max(0, 10 - Math.round(t.pct / 10)));
          var meta = '执行：' + esc(t.officer) + (t.officerStat ? ('（' + t.officerStat + '）') : '')
            + '　每旬 +' + t.perTick + '　累计 ' + t.progress + '/' + t.total
            + (active ? ('　预计第 ' + t.endDay + ' 日完工（剩 ' + t.daysLeft + ' 日）') : (t.status === 'cancelled' ? ('　' + esc(t.note || '')) : ''));
          var row = el('div', 'row', '<span>' + head + '<div class="cost">' + bar + ' ' + Math.round(t.pct) + '%</div>'
            + '<div class="cost">' + meta + '</div></span>');
          if (active) {
            row.appendChild(mkBtn('撤销', 'ghost', function () {
              fetch('/__slg/strategy/action', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'cancelInvest', taskId: t.id }),
              }).then(function (r2) { return r2.json(); }).then(function (rs) {
                if (rs.ok) toast(rs.refund > 0 ? ('任务已撤销，退回 ' + rs.refund + ' 金') : '任务已撤销（已投入的金不退，已到账的增量保留）', true);
                else toast('无法撤销：' + (rs.reason || '未知'), false);
                fetchState().then(function (s2) { cache = s2; refreshCityView(s2); });
              });
            }));
          } else {
            row.appendChild(el('span', 'cost', '—'));
          }
          taskCard.appendChild(row);
        });
      }
      body.appendChild(taskCard);

      var invCard = el('div', 'card', '<h4 style="margin-top:0">委派内政</h4>'
        + '<div class="cost">每项委派有成本与工期：执行武将越强，旬数越少（强将 1 旬，普通 2 旬，无驻城武将 3 旬），'
        + '总产出不变。开发度直接提升该城日产与征兵效率。委任五职后，驻在本城的官员每旬还会自动推动对应开发。</div>');
      /* ★ M2：练兵充能 / 招抚期一览（数据来自 econ 视图） */
      var today0 = Number((cache && cache.day) || 0);
      var stat0 = [];
      if (Number(c.drillCharges) > 0) stat0.push('练兵充能 ×' + c.drillCharges);
      if (Number(c.appeaseUntil) > today0) stat0.push('招抚生效至第 ' + c.appeaseUntil + ' 日');
      if (stat0.length) invCard.appendChild(el('div', 'cost', stat0.join('　')));
      var mkInv = function (label, kind, cost, note) {
        /* ★ 修 bug-12：按项冷却 —— 只置灰刚办过的那一项，并写明哪天可再办 */
        var today = Number((cache && cache.day) || 0);
        var days = (c.investDays || {});
        var legacy = Object.keys(days).length ? 0 : Number(c.lastInvestDay || 0);
        var last = Number(days[kind] || legacy) || 0;
        var cdDay = (last && today - last < 10) ? last + 10 : 0;
        var doing = (c.interiorTasks || []).some(function (t) { return t.kind === kind && t.status === 'active'; });
        var b = mkBtn(cdDay ? ('第 ' + cdDay + ' 日可再办') : (doing ? (label + '（进行中）') : (label + '（' + cost + ' 金）')),
          cdDay ? 'ghost' : '', function () {
            fetch('/__slg/strategy/action', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'invest', cityId: c.id, kind: kind }),
            }).then(function (r2) { return r2.json(); }).then(function (rs) {
              if (rs.ok) {
                var tk = rs.task || {};
                toast(rs.instant
                  ? (label + '已完成：' + (rs.effectText || ''))
                  : (label + '已委派给 ' + (tk.officer || '无专员') + '，' + tk.ticks + ' 旬完工（第 ' + tk.endDay + ' 日），每旬 +' + tk.perTick), true);
                fetchState().then(function (s2) { cache = s2; refreshCityView(s2); });
              } else if (rs.reason === 'busy') toast('这项还在办，第 ' + rs.nextDay + ' 日完工', false);
              else if (rs.reason === 'cooldown') toast('这项内政本旬办过了，第 ' + rs.nextDay + ' 日可再办', false);
              else if (rs.reason === 'no_gold') toast('金不足（需 ' + rs.cost + '）', false);
              else if (rs.reason === 'no_disaster') toast('本城眼下无灾可赈', false);
              else toast('无法办理：' + (rs.reason || '未知'), false);
            });
          });
        b.style.margin = '0';
        if (cdDay) b.disabled = true;
        var row = el('div', 'row', '<span>' + label + '<span class="cost">　' + note + '</span></span>');
        row.appendChild(b);
        invCard.appendChild(row);
      };
      /* ★ P11 兵役制：人口是兵源根，摆在第一行，征兵页也反向链回这里 */
      mkInv('劝课生息', 'populate', 400, '人口 +8%、民心 +2 → 新增户口才有新丁可征');
      mkInv('开垦农田', 'agri', 300, '农田 +3 → 粮产上升');
      mkInv('招商兴市', 'trade', 300, '市集 +3 → 金产上升');
      mkInv('募兵整编', 'barracks', 350, '兵营 +3 → 征兵更快，民心 +1');
      mkInv('修筑城防', 'defense', 400, '城防 +2、治安 +2，守军 +150');
      if (c.disaster || c.modUntil) mkInv('开仓赈灾', 'relief', 500, '解除减产，民心 +6、治安 +3');
      /* ★ M2 内政 12 类（GDD §5.4）：新增兴学/招抚/屯田/练兵，全部走同一任务对象 */
      mkInv('兴学', 'study', 600, '酒馆来访贤才 +1 位（常设）');
      mkInv('招抚', 'appease', 450, '治安 +5、叛逃风险 −30%（90 日）');
      mkInv('屯田', 'tuntian', 500, '农田 +2、城库 +800 粮');
      mkInv('练兵', 'drill', 550, '下次自本城出征攻击 +5%（一充能）');
      /* ★ M2 边任务：修路/侦察/离间要指定相邻城，下拉列出 marchRoutes（服务端二次校验相邻） */
      var mkEdgeInv = function (label, kind, cost, note) {
        var today = Number((cache && cache.day) || 0);
        var days = (c.investDays || {});
        var last = Number(days[kind] || 0) || 0;
        var cdDay = (last && today - last < 10) ? last + 10 : 0;
        var doing = (c.interiorTasks || []).some(function (t) { return t.kind === kind && t.status === 'active'; });
        var routes = (c.marchRoutes || []);
        var row = el('div', 'row', '<span>' + label + '<span class="cost">　' + note + '</span></span>');
        var sel = el('select');
        sel.style.cssText = 'max-width:130px';
        routes.forEach(function (rt) {
          var o = el('option');
          o.value = rt.id;
          o.textContent = (rt.name || ('城' + rt.id)) + (rt.km ? ' ' + rt.km + '里' : '');
          sel.appendChild(o);
        });
        var b = mkBtn(cdDay ? ('第 ' + cdDay + ' 日可再办') : (doing ? (label + '（进行中）') : (label + '（' + cost + ' 金）')),
          (cdDay || doing) ? 'ghost' : '', function () {
            fetch('/__slg/strategy/action', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'invest', cityId: c.id, kind: kind, targetCityId: Number(sel.value) || 0 }),
            }).then(function (r2) { return r2.json(); }).then(function (rs) {
              if (rs.ok) {
                var tk = rs.task || {};
                toast(label + '已委派给 ' + (tk.officer || '无专员') + '，' + tk.ticks + ' 旬完工（第 ' + tk.endDay + ' 日）', true);
                fetchState().then(function (s2) { cache = s2; refreshCityView(s2); });
              } else if (rs.reason === 'busy') toast('这项还在办，第 ' + rs.nextDay + ' 日完工', false);
              else if (rs.reason === 'cooldown') toast('这项内政本旬办过了，第 ' + rs.nextDay + ' 日可再办', false);
              else if (rs.reason === 'no_gold') toast('金不足（需 ' + rs.cost + '）', false);
              else if (rs.reason === 'not_adjacent' || rs.reason === 'no_target') toast('目标必须是行军可达的相邻城', false);
              else if (rs.reason === 'target_own_city') toast('侦察/离间只能指敌城', false);
              else if (rs.reason === 'road_done') toast('这条驿道已经修过了', false);
              else toast('无法办理：' + (rs.reason || '未知'), false);
            });
          });
        b.style.margin = '0';
        if (cdDay || doing || !routes.length) b.disabled = true;
        row.appendChild(sel);
        row.appendChild(b);
        invCard.appendChild(row);
      };
      mkEdgeInv('修路（选邻城）', 'road', 700, '该边行军 −1 日（双向）');
      mkEdgeInv('侦察（选邻城）', 'scout', 200, '敌城情报 +1 档');
      mkEdgeInv('离间（选敌城）', 'sow', 800, '守军 −3%、离心 +1');
      body.appendChild(invCard);

      /* ★ M2-4 委任对象化（GDD §5.6）：「我不用管，但我知道它在干什么」——
         每旬自动派一条真实内政任务（与手动同源同价同工期）；缺金置顶暂停、金到位续办、失城中止。 */
      var apptCard = el('div', 'card', '<h4 style="margin-top:0">长驻委任</h4>'
        + '<div class="cost">委任后每旬自动办一条真实内政任务（产出与手动完全同源，报告写清谁涨了什么）；'
        + '缺金时暂停并置顶提醒，金到位自动续办；城丢失自动中止。</div>');
      var appts = ((cache && cache.appointments) || []).filter(function (a) { return Number(a.cityId) === Number(c.id); });
      var mkAppt = function (goal, label, note) {
        var mine = appts.find(function (a) { return a.goal === goal && a.status === 'running'; });
        var b = mkBtn(mine ? (label + '（委任中）') : (label + '·委任'), mine ? 'ghost' : '', function () {
          fetch('/__slg/strategy/action', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'appoint', cityId: c.id, goal: goal }),
          }).then(function (r2) { return r2.json(); }).then(function (rs) {
            if (rs.ok) toast(label + '委任已设：' + note, true);
            else if (rs.reason === 'busy') toast('该城已有同目标委任在办', false);
            else if (rs.reason === 'no_gold') toast('库金不足，本旬暂缓（下一旬自动重试）', false);
            else toast('无法委任：' + (rs.reason || '未知'), false);
            fetchState().then(function (s2) { cache = s2; refreshCityView(s2); });
          });
        });
        b.style.margin = '0';
        if (mine) b.disabled = true;
        var r3 = el('div', 'row', '<span>' + label + '<span class="cost">　' + note + '</span></span>');
        r3.appendChild(b);
        apptCard.appendChild(r3);
      };
      mkAppt('develop', '劝农商', '开垦/招商轮转，抬农田市集');
      mkAppt('recruit', '缮甲兵', '募兵整编，抬兵营');
      mkAppt('defend', '固城防', '修筑城防，抬守备');
      mkAppt('transport', '屯军粮', '屯田积谷，直入城库');
      appts.forEach(function (a) {
        var stTag = a.status === 'blocked'
          ? '<span style="color:#ff9d6b">暂停：' + esc(a.blockedReason || '缺金') + '</span>'
          : (a.status === 'done' ? '已中止（' + esc(a.blockedReason || '') + '）' : '<span style="color:#a9e2a0">运行中</span>');
        var r4 = el('div', 'row', '<span><b style="color:#f0d998">' + esc(a.goalLabel) + '</b>'
          + '<span class="cost">　' + stTag + ' · 已办 ' + (a.doneCount || 0) + ' 单'
          + (a.lastTaskLabel ? ' · 当前：' + esc(a.lastTaskLabel) : '')
          + (a.officer ? ' · 主官 ' + esc(a.officer) : '') + '</span></span>');
        if (a.status === 'running' || a.status === 'blocked') {
          r4.appendChild(mkBtn('取消委任', 'ghost', function () {
            fetch('/__slg/strategy/action', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'cancelAppoint', apptId: a.id }),
            }).then(function (r2) { return r2.json(); }).then(function (rs) {
              if (rs.ok) toast('委任已取消（在施任务照常推进）', true);
              else toast('无法取消：' + (rs.reason || '未知'), false);
              fetchState().then(function (s2) { cache = s2; refreshCityView(s2); });
            });
          }));
        }
        apptCard.appendChild(r4);
      });
      body.appendChild(apptCard);
      body.appendChild(el('div', 'cost',
        '民心的作用：影响人口增长（+2%~6%/月）与粮金产量（×0.85~1.10）。'
        + '治安越高灾害越少。开发度到 100 以上收益递减，别把一座城堆到顶。'));

      /* ★ 修 bug-6：分城也有自己的一套设施（举义时逐城建立），在此可查看与升级。
         ★ 2026-11-14：卡片内容抽到 mountFacilitiesCard()，升级后只重画卡片不重画整页 */
      var facCard = el('div', 'card', '');
      body.appendChild(facCard);
      mountFacilitiesCard(facCard, c);
      return;
    }
    body.appendChild(el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 内政</h4><div class="grid">'
      + kv('归属', c.ownerName)
      + kv('行政', c.adminLevel || c.levelName || ('Lv' + c.level))
      + kv('人口', fmt(c.population))
      + kv('农业', c.agri) + kv('商业', c.commerce)
      + kv('城防', c.cityDef) + kv('特产', c.specialty || '—')
      + kv('地形', c.terrain || '—')
      + '</div><div class="cost" style="margin-top:8px">非我军城池无法在此办理内政；攻占后即可开垦经营。</div>'));
  }

  function tabGeneralView(c, body) {
    /* ★ P6 己方城：驻城武将（驻本城的队伍，含武将/兵力/忠诚），不再是一句占位 */
    if (c.owner === 'player') {
      var card = el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 驻城武将</h4>');
      var stationed = c.stationed || [];
      if (!stationed.length) {
        card.appendChild(el('div', 'empty', '本城没有驻军队伍。出征前整编的队伍会驻在出发城。'));
      }
      stationed.forEach(function (a) {
        var gens = (a.generals || []).map(function (g) {
          return '<span class="chip">' + esc(g.name) + '·忠' + g.loyal + '</span>';
        }).join('');
        var row = el('div', 'row',
          '<span>队伍#' + a.armyId + '<span class="cost">　盾 ' + fmt(a.soldiers[0]) + ' / 弓 ' + fmt(a.soldiers[1]) + ' / 骑 ' + fmt(a.soldiers[2]) + '</span></span>');
        if (gens) row.appendChild(el('div', '', gens));
        card.appendChild(row);
      });
      if (c.owner === 'player') {
        var tip = el('div', 'cost', '整编与出征：天下沙盘左上「武将」→ 队伍整编，或六府「武将」页。');
        card.appendChild(tip);
      }
      body.appendChild(card);
      return;
    }
    body.appendChild(el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 武将</h4>'
      + '<div class="grid">' + kv('守军', fmt(c.troops)) + kv('兵种', c.arms || '—') + '</div>'
      + '<div class="cost" style="margin-top:8px">敌将名册尚未探明。战胜后有机会阵前擒将，可在六府「武将」页招降。</div>'));
  }

  function tabTavernView(c, body) {
    /* ★ P6 己方城酒馆：本籍在野武将来访 + 探索人才（登庸） */
    if (c.owner !== 'player') {
      body.appendChild(el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 酒馆</h4>'
        + '<div class="cost">' + c.name + ' 不在我军治下，酒馆进不去。攻占后即可在此招揽本籍贤才。</div>'));
      return;
    }
    var card = el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 酒馆</h4><div class="empty">读取中…</div>');
    body.appendChild(card);
    send('tavern.guests', { cityId: c.id }, true).then(function (rsp) {
      var m = rsp.msg || {};
      card.innerHTML = '<h4 style="margin-top:0">' + c.name + ' · 酒馆</h4>';
      var head = el('div', 'cost', '招募一位 <b style="color:#f0d998">' + m.cost + '</b> 金。'
        + '各城酒馆来的是本籍在野武将，过了时辰便见不到。');
      card.appendChild(head);
      var list = el('div', 'card', '<h4 style="margin-top:0">今日来访</h4>');
      var today = m.today || [];
      if (!today.length) list.appendChild(el('div', 'empty', '今日无人来访。'));
      today.forEach(function (g) {
        /* ★ U15 相性差/义理/预计登庸率直接写在名字后面：玩家能提前判断「值不值得等」 */
        var meta = (g.xiangxingGap != null)
          ? '<span class="cost">　相性差 ' + g.xiangxingGap + ' · 义理 ' + g.yili + ' · 登庸 ' + g.recruitRate + '%</span>'
          : '';
        var row = el('div', 'row', '<span><b style="color:#f0d998">' + esc(g.name) + '</b> <span class="chip">' + g.when
          + '</span> <span class="cost">' + (g.state === 'now' ? '此刻在店' : g.state === 'passed' ? '已过时辰' : '未到时辰') + '</span>' + meta + '</span>');
        row.appendChild(mkBtn('招募', '', function () {
          send('general.drawGeneral', { drawTimes: 1, cityId: c.id }).then(function (r2) {
            var got = (r2.msg && r2.msg.generals) || [];
            if (got.length) {
              toast('入营：' + got.map(function (x) { return x.name || '武将'; }).join('、'), true);
              send('tavern.guests', { cityId: c.id }, true).then(function (r3) {
                var m3 = r3.msg || {};
                refreshCityView(cache);
              });
            } else toast('招募失败：' + (r2.msg && r2.msg.reason === 'no_guest' ? '此人已过时辰' : r2.msg && r2.msg.reason === 'not_enough_gold' ? '金不足' : (r2.msg && r2.msg.reason) || '未知'), false);
          });
        }));
        list.appendChild(row);
      });
      card.appendChild(list);
      var exRow = el('div', 'row', '<span>探索人才<span class="cost">　' + (m.exploreCost || 100)
        + ' 金 · 派使者探访本城贤才，登庸成功即入仕（政治越高越容易）</span></span>');
      var exBtn = mkBtn(m.exploredToday ? '今日已探索' : '探索人才', m.exploredToday ? 'ghost' : '', function () {
        if (m.exploredToday) { toast('本城今日已探索过，明日再来', false); return; }
        send('general.explore', { cityId: c.id }).then(function (r2) {
          if (r2.code === 0 && r2.msg && r2.msg.general) {
            toast('登庸成功：' + (r2.msg.general.name || '贤才') + ' 入仕！（成功率 ' + r2.msg.rate + '%）', true);
          } else if (r2.msg && r2.msg.reason === 'not_found') {
            /* ★ P7 三顾：失败会累积好感，下次成功率高 12% */
            /* ★ U15 失败也要给构成条：玩家得知道下次该改什么（政治/相性/义理/三顾） */
            var parts = (r2.msg.parts || []).map(function (p) { return p.label + ' ' + (p.value > 0 ? '+' : '') + p.value; }).join('；');
            toast('探索未遇贤才（成功率 ' + r2.msg.rate + '%）'
              + (r2.msg.favor ? '，此人已拒 ' + r2.msg.favor + ' 次，再访更易' : '')
              + (parts ? '。构成：' + parts : '') + '。金已破费', false);
          } else if (r2.msg && r2.msg.reason === 'not_enough_gold') {
            toast('金不足（需 ' + r2.msg.cost + '）', false);
          } else if (r2.msg && r2.msg.reason === 'already_today') {
            toast('本城今日已探索过', false);
          } else toast('探索失败：' + (r2.msg && r2.msg.reason) || '未知', false);
        });
      });
      exBtn.style.margin = '0';
      exRow.appendChild(exBtn);
      card.appendChild(exRow);
    }).catch(function () {
      card.innerHTML = '<div class="cost">读取酒馆失败，稍后再试。</div>';
    });
  }

  function tabOverview(s, c, body, isHome) {
    var card = el('div', 'card');
    card.innerHTML = '<h4 style="margin-top:0">城池画像</h4><div class="grid">'
      + kv('行政', c.adminLevel || c.levelName || ('Lv' + c.level))
      + kv('人口', fmt(c.population))
      + kv('农业', c.agri) + kv('商业', c.commerce)
      + kv('城防', c.cityDef) + kv('特产', c.specialty || '—')
      + kv('主要兵种', c.arms || '—') + kv('地形', c.terrain || '—')
      + '</div>';
    if (c.history) card.appendChild(el('div', '', '<h4>史略</h4><div style="opacity:.85;line-height:1.9">' + c.history + '</div>'));
    body.appendChild(card);

    /* ★ P6 己方城经营状况：人口/城库/日产/灾害，一目了然 */
    if (c.owner === 'player' && c.pop != null) {
      var eco = el('div', 'card', '<h4 style="margin-top:0">经营状况</h4><div class="grid">'
        + kv('常住人口', fmt(c.pop))
        + kv('城库存粮', fmt(c.store))
        + kv('日产 · 粮', '+' + fmt(c.yieldGrain))
        + kv('日产 · 金', '+' + fmt(c.yieldGold))
        + kv('民心', (c.morale != null ? c.morale : '—') + ' / 治安 ' + (c.order != null ? c.order : '—'))
        + kv('粮道', (c.supply && c.supply.connected === false)
          ? ('断绝 ' + (c.supply.days || 0) + ' 日')
          : ('通 · ' + ((c.supply && c.supply.hops) || 0) + ' 跳 / 约 ' + ((c.supply && c.supply.km) || 0) + ' 里'))
        + kv('开发', '农田 Lv' + (c.lvAgri || 1) + ' · 市集 Lv' + (c.lvTrade || 1)
          + ' · 兵营 Lv' + (c.lvArms || 1) + ' · 城防 Lv' + (c.lvDef || 1))
        + (c.modUntil ? kv('减产中', '至第 ' + c.modUntil + ' 日（×' + c.modGrain + '）') : '')
        + (c.disaster ? '<div class="cost" style="color:#ff9d6b">⚠ ' + esc(c.disaster.name || c.disaster.type || '灾害') + '（第 ' + c.disaster.day + ' 日）</div>' : '')
        + '</div>');
      eco.appendChild(el('div', 'cost', '开发度影响日产与征兵：去「内政」页开垦/招商/募兵可提升，委任官员则逐旬自动成长。'));
      body.appendChild(eco);
    }

    var adjCard = el('div', 'card', '<h4 style="margin-top:0">相邻城池</h4>');
    var list = neighbors[c.id] || [];
    if (!list.length) adjCard.appendChild(el('div', 'empty', '此地孤悬。'));
    /* ★ 修 bug-15：「相邻」用路网，但能否进军要过 marchable（关隘封锁会拆段）。
       两处口径必须一致，否则会出现「相邻可前往、出征却说行军受阻」。 */
    var canGo = c.marchable || [];
    list.forEach(function (id) {
      var n = cityOf(s, id);
      if (!n) return;
      var passable = canGo.indexOf(n.id) >= 0;
      var troopText = n.owner === 'player'
        ? '驻城 ' + fmt(n.troopSum || 0) : '守军 ' + fmt(n.troops);
      var row = el('div', 'row');
      row.innerHTML = '<span><span class="dot" style="background:' + n.color + '"></span>'
        + n.name + ' <span class="winTag">（' + n.province + '·' + n.ownerName + '·' + troopText + '）</span>'
        + (passable ? '' : ' <span class="chip" style="color:#ff9d6b;border-color:#7a4038">行军受阻</span>')
        + '</span>';
      var open = mkBtn('前往', 'ghost', function () { window.__slgCityWindow(n.id); });
      open.style.padding = '1px 10px';
      row.appendChild(open);
      adjCard.appendChild(row);
    });
    body.appendChild(adjCard);

    /* ★ 出征入口：真正的操作搬到独立「出征」面板（选队伍/选目标/在途撤回），
       概览页只留情报与一键入口 —— 避免「界面说一套、服务端做一套」。 */
    var ownCities = (s.cities || []).filter(function (x) { return x.owner === 'player' && x.id !== c.id; });
    var origins = ownCities.filter(function (x) { return (x.marchable || []).indexOf(c.id) >= 0; });
    var adjacentOwn = ownCities.filter(function (x) { return (neighbors[x.id] || []).indexOf(c.id) >= 0; });
    if (c.owner === 'player') {
      var mineBox = el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 军事</h4>'
        + '<div class="grid">'
        + kv('驻城兵力', fmt(c.troopSum || 0) + ' 兵 / ' + (c.armsCount || 0) + ' 队')
        + kv('城防守军', fmt(c.troops || 0))
        + kv('城库存粮', fmt(c.store || 0))
        + kv('可出征邻城', (c.marchable || []).length + ' 座')
        + '</div>');
      mineBox.appendChild(el('div', 'cost', '征兵与配将在「征兵」页；出兵、撤军、看行军在出征面板。'));
      mineBox.appendChild(mkBtn('自本城出征', '', function () {
        window.__slgCityClose();
        window.__slgWarWindow({ from: c.id, tab: 'go' });
      }));
      body.appendChild(mineBox);
    } else if (origins.length) {
      var best = origins.map(function (o) {
        var rr = (o.marchRoutes || []).filter(function (r2) { return r2.id === c.id; })[0] || {};
        return { city: o, km: Math.round(rr.km || 0) };
      }).sort(function (a, b) { return a.km - b.km; })[0];
      var box = el('div', 'card', '<h4 style="margin-top:0">出征 ' + c.name + '</h4>'
        + '<div class="grid">'
        + kv('目标守军', fmt(c.troops))
        + kv('归属', c.ownerName)
        + kv('最近出发城', best.city.name + '（' + fmt(best.km) + ' 里）')
        + kv('可出兵城', origins.length + ' 座')
        + '</div>');
      box.appendChild(el('div', 'cost',
        '可自 ' + origins.map(function (o) { return o.name; }).join('、')
        + ' 出兵。出征面板里能挑具体队伍、看实出人数与行军日数，出发后还能撤回。'));
      box.appendChild(mkBtn('打开出征面板', '', function () {
        window.__slgCityClose();
        window.__slgWarWindow({ cityId: c.id, from: best.city.id, tab: 'go' });
      }));
      body.appendChild(box);
    } else if (adjacentOwn.length) {
      // 相邻但没有可通行军段（关隘封锁）
      var gate = ((s.gates || []).find(function (g) { return g.status === '封锁'; }) || {}).name;
      body.appendChild(el('div', 'card',
        '<h4 style="margin-top:0">行军受阻</h4><div class="cost">'
        + '此地与你相邻，但没有可通行军段'
        + (gate ? ('，<b style="color:#ff6b5e">' + gate + '</b> 已封锁') : '')
        + '。关隘是必经节点，须先解封或改走别路。</div>'));
    }
  }

  /* 府库页的设施列表（与内政 tab 的设施卡同一份数据，展示口径不同：这里按资源缺口标红）。
     升级后走 onAfterUpgrade()（= 重绘府库页），因为升级会扣资源、上方资源行必须跟着变。
     ★ 玩家反馈的「升级就跳回顶部」由 tabHome 自身的滚动还原兜住（见 restoreHomeScroll）。 */
  function renderHomeFacilityList(card, c, cid, list, res, onAfterUpgrade) {
    card.innerHTML = '<h4 style="margin-top:0">设施</h4>';
    if (!list.length) { card.appendChild(el('div', 'empty', '本城暂无设施数据。')); return; }
    list.forEach(function (f) {
      var row = el('div', 'row');
      var left = el('div', '');
      left.innerHTML = '<b style="color:#f0d998">' + f.name + '</b> <span class="winTag">Lv'
        + f.level + '/' + f.maxLevel + '</span>';
      var cost = f.nextNeed || {};
      var chips = '';
      [['wood', '木'], ['iron', '铁'], ['stone', '石'], ['grain', '粮'], ['gold', '金'], ['decree', '令']]
        .forEach(function (k) {
          if (cost[k[0]]) {
            var lack = Number(res[k[0]] || 0) < cost[k[0]];
            chips += '<span class="chip" style="' + (lack ? 'color:#ff6b5e;border-color:#7a4038' : '') + '">'
              + k[1] + ' ' + fmt(cost[k[0]]) + '</span>';
          }
        });
      if (f.nextTime) chips += '<span class="chip">工期 ' + f.nextTime + 's</span>';
      left.innerHTML += '<div class="cost">' + (f.level >= f.maxLevel ? '已满级' : chips) + '</div>';
      row.appendChild(left);
      if (f.up_time && f.up_time > 0) {
        row.appendChild(el('span', 'cost', '升级中…'));
      } else if (f.level >= f.maxLevel) {
        row.appendChild(el('span', 'cost', '—'));
      } else {
        row.appendChild(mkBtn('升级', '', function () {
          send('city.upFacility', { cityId: clientCityId(), realCityId: cid, fType: f.type }).then(function (rsp) {
            if (rsp.code === 0) toast(f.name + ' 开始升级', true);
            else toast('升级失败：' + errText(rsp), false);
            if (onAfterUpgrade) onAfterUpgrade();
          });
        }));
      }
      card.appendChild(row);
    });
  }

  function tabHome(body, c) {
    /* ★ P7：兵营/设施属于「本地主城」（原客户端 cityId），不是战略城的 id；
       两者是两套编号。队伍归属才用战略城 id（tabArmy 的 cid）。 */
    var cid = (c && c.id) || (cache && cache.playerCity) || 1;
    /* 这里会在原地把 body 清空再填充（先放「读取中…」），滚动位置被夹到 0 且不会自己复原。
       玩家点一次升级/征收就被踹回面板顶部，所以进函数先记、填完再还原。 */
    var keepTop = body.scrollTop || 0;
    function restoreHomeScroll() {
      if (!(keepTop > 0) || !body.isConnected) return;
      var put = function () {
        if (body.isConnected && (body.scrollHeight - body.clientHeight) >= keepTop - 1) body.scrollTop = keepTop;
      };
      body.scrollTop = keepTop;
      requestAnimationFrame(put);
      setTimeout(put, 200);
    }
    body.innerHTML = '<div class="empty">读取中…</div>';
    Promise.all([send('city.facilities', { cityId: clientCityId(), realCityId: cid }), send('role.myRoleRes', {}), loadMeta()])
      .then(function (rs) {
        body.innerHTML = '';
        var res = (rs[1].msg && rs[1].msg.role_res) || {};
        var meta = rs[2] || { collectIntervalSec: 30, collectLimit: 3 };
        var card = el('div', 'card');
        card.innerHTML = '<h4 style="margin-top:0">府库</h4>';
        var resRow = el('div', 'res');
        [['wood', '木', res.wood_yield], ['iron', '铁', res.iron_yield], ['stone', '石', res.stone_yield],
         ['grain', '粮', res.grain_yield], ['gold', '金', res.gold_yield], ['decree', '政令', null]]
          .forEach(function (r) {
            resRow.appendChild(el('div', 'r', '<b>' + fmt(res[r[0]]) + '</b>'
              + (r[2] != null ? '<small>+' + fmt(r[2]) + '/日</small>' : '<small>&nbsp;</small>')));
          });
        card.appendChild(resRow);
        var collect = el('div', '');
        collect.style.marginTop = '8px';
        collect.appendChild(mkBtn('征收金币（' + meta.collectIntervalSec + ' 秒一次，每日 ' + meta.collectLimit + ' 次）', '', function () {
          send('interior.collect', { cityId: cid }).then(function (rsp) {
            if (rsp.code === 0) toast('征得 ' + fmt(rsp.msg.gold) + ' 金', true);
            else toast('征收失败：' + errText(rsp), false);
            tabHome(body, c);
          });
        }));
        card.appendChild(collect);
        body.appendChild(card);

        /* 设施列表抽到 renderHomeFacilityList()：升级后只重画这张卡。
           原来升级走 tabHome(body,c) 整页重来，滚动条同样被踹回顶部。 */
        var facCard = el('div', 'card', '');
        body.appendChild(facCard);
        renderHomeFacilityList(facCard, c, cid, (rs[0].msg && rs[0].msg.facilities) || [], res,
          function () { tabHome(body, c); });

        // ★ P1-6 / P0-4：来犯军与章节结局都放在本城页，玩家不用切回被遮住的本地地图
        var extra = el('div', '');
        body.appendChild(extra);

        // ★ P2-5：存档三档位 + 导出 / 导入。旧实现只有一份 save.json，换机就没了。
        var saveCard = el('div', 'card', '<h4 style="margin-top:0">存档</h4>');
        var slotBox = el('div', '');
        saveCard.appendChild(slotBox);
        var ioRow = el('div', '');
        ioRow.style.marginTop = '8px';
        ioRow.appendChild(mkBtn('导出存档文件', 'ghost', function () {
          fetch('/__slg/save/export').then(function (r) { return r.blob(); }).then(function (blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'shuanghan-save-' + Date.now() + '.json';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
            toast('存档已导出到下载目录', true);
          }).catch(function () { toast('导出失败', false); });
        }));
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        fileInput.onchange = function () {
          var f = fileInput.files && fileInput.files[0];
          if (!f) return;
          var reader = new FileReader();
          reader.onload = function () {
            var data;
            try { data = JSON.parse(String(reader.result)); } catch { toast('这不是合法的存档文件', false); return; }
            confirmBox('导入存档', ['当前进度会被覆盖（旧档会自动备份一份）。', '确定导入 <b>' + f.name + '</b>？'],
              '导入', '取消', function () {
                postJSON('/__slg/save/import', data).then(function (r) {
                  if (r.ok) { toast('已导入，正在重载', true); setTimeout(function () { location.reload(); }, 600); }
                  else toast('导入失败：' + (r.reason || '格式不对'), false);
                });
              });
          };
          reader.readAsText(f);
          fileInput.value = '';
        };
        ioRow.appendChild(fileInput);
        ioRow.appendChild(mkBtn('导入存档文件', 'ghost', function () { fileInput.click(); }));
        saveCard.appendChild(ioRow);
        body.appendChild(saveCard);

        function renderSlots(list) {
          slotBox.innerHTML = '';
          (list || []).forEach(function (s) {
            var row = el('div', 'row');
            row.innerHTML = '<span>' + s.slot + ' 号档 <span class="winTag">'
              + (s.exists ? ('第 ' + (s.day || '?') + ' 日' + (s.ending ? ' · ' + (s.ending === 'held' ? '守住' : '失守') : ''))
                : '空档') + '</span></span>';
            row.appendChild(mkBtn('存入', 'ghost', function () {
              confirmBox('存入 ' + s.slot + ' 号档',
                [s.exists ? '会覆盖这个档位原来的进度。' : '这个档位还是空的。'], '存入', '取消', function () {
                  postJSON('/__slg/save/slot', { slot: s.slot, action: 'save' }).then(function (r) {
                    toast(r.ok ? ('已存入 ' + s.slot + ' 号档') : '存档失败', !!r.ok);
                    if (r.ok) renderSlots(r.slots);
                  });
                });
            }));
            if (s.exists) {
              row.appendChild(mkBtn('读取', 'ghost', function () {
                confirmBox('读取 ' + s.slot + ' 号档',
                  ['会覆盖当前进度（旧档会自动备份）。'], '读取', '取消', function () {
                    postJSON('/__slg/save/slot', { slot: s.slot, action: 'load' }).then(function (r) {
                      if (r.ok) { toast('已读取，正在重载', true); setTimeout(function () { location.reload(); }, 600); }
                      else toast('读档失败：' + (r.reason || ''), false);
                    });
                  });
              }));
            }
            slotBox.appendChild(row);
          });
        }
        fetch('/__slg/save/slots').then(function (r) { return r.json(); })
          .then(function (r) { renderSlots(r.slots); })
          .catch(function () { slotBox.innerHTML = '<div class="empty">档位读取失败</div>'; });
        fetchState().then(function (s) {
          extra.innerHTML = '';
          var th = s.threats || [];
          var mil = el('div', 'card', '<h4 style="margin-top:0">军情</h4>');
          if (!th.length) mil.appendChild(el('div', 'empty', '境内无来犯之敌。'));
          th.forEach(function (t) {
            var row = el('div', 'row');
            row.innerHTML = '<span>' + t.name + ' <span class="winTag">兵力 ' + fmt(t.soldiers)
              + ' · (' + t.x + ',' + t.y + ')</span></span>';
            row.appendChild(mkBtn('出兵清剿', '', function () {
              confirmBox('清剿来犯军', [
                '目标：<b>' + t.name + '</b>（兵力约 ' + fmt(t.soldiers) + '）',
                '<span class="cost">用当前最强的一支部队出战，战败不会清空家底。</span>',
              ], '出战', '取消', function () {
                send('strategy.clearThreat', { garrisonId: t.id }).then(function (rsp) {
                  if (rsp.msg && rsp.msg.ok) toast(rsp.msg.summary || '已清剿', rsp.msg.result === 2);
                  else toast('清剿失败：' + ((rsp.msg && rsp.msg.reason) || errText(rsp)), false);
                  tabHome(body, c);
                });
              });
            }));
            mil.appendChild(row);
          });
          extra.appendChild(mil);

          var camp = s.campaign || {};
          if (camp.ending) {
            var endCard = el('div', 'card');
            endCard.innerHTML = '<h4 style="margin-top:0">序章 ' +
              (camp.ending === 'held' ? '守住' : '失守') + '</h4>'
              + '<div class="cost">第 ' + (camp.endingDay || '?') + ' 日结算。'
              + '这局还能继续经营，也可以从头再来。</div>';
            endCard.appendChild(mkBtn('重开一局', 'ghost', function () {
              confirmBox('重开一局', ['当前进度会被覆盖，确定重来？'], '重来', '取消', function () {
                fetch('/__slg/restart', { method: 'POST' })
                  .then(function (r) { return r.json(); })
                  .then(function (r) { if (r.ok) location.reload(); else toast('重开失败', false); })
                  .catch(function () { toast('重开失败', false); });
              });
            }));
            extra.appendChild(endCard);
          }
        }).catch(function () {});
        restoreHomeScroll();
      })
      .catch(function () { body.innerHTML = '<div class="empty">读取失败，稍后再试。</div>'; });
  }

  /**
   * 征兵页：编队 + 征入指定槽位。
   * ★ P0-3：原版只有这一个页面能征到 slot0，且没有编队入口 —— 玩家永远只有
   *   主公一支部队，1 将打 3 将必败。现在三槽都能配将、都能征兵。
   */
  function tabArmy(body, c) {
    /* ★ P7：征兵/编队按「当前城」走。分城也有自己的队伍，不再只有首都一支。
       P6 及以前写死 cityId:1，导致分城的武将页永远空白、征兵只征到长安。 */
    var cid = (c && c.id) || (cache && cache.playerCity) || 1;
    body.innerHTML = '<div class="empty">读取中…</div>';
    Promise.all([send('army.myList', { cityId: cid }), loadMeta(), send('role.myRoleRes', {}),
      send('general.myGenerals', {})])
      .then(function (rs) {
        body.innerHTML = '';
        var meta = rs[1] || { conscript: { wood: 10, iron: 10, grain: 10, gold: 1 } };
        var per = meta.conscript || { wood: 10, iron: 10, grain: 10, gold: 1 };
        var res = (rs[2].msg && rs[2].msg.role_res) || {};
        var gens = (rs[3].msg && rs[3].msg.generals) || [];
        var armies = (rs[0].msg && rs[0].msg.armys) || [];
        var byOrder = {};
        armies.forEach(function (a) { byOrder[a.order] = a; });

        /* ★ P11 兵役台账：妇孺老弱不征、一户一丁、一旬只征一次、先养人口。
           一键征兵把原来「每槽输数字 + 点征兵」的 6 次点击压到 1 次。 */
        var lv = (c && c.levy) || null;
        var levyCard = el('div', 'card',
          '<b style="color:#f0d998">' + esc((c && c.name) || '本城') + ' · 编队与征兵</b>　'
          + '<span class="winTag">' + (lv ? esc(lv.season) + '季 · ' : '')
          + (c && c.owner === 'player' ? '驻城兵 ' + fmt(c.troopSum || 0) + ' · 城防 ' : '守军 ')
          + fmt((c && c.troops) || 0) + '</span>');
        if (lv) {
          levyCard.appendChild(el('div', 'grid',
            kv('人口', fmt(lv.pop))
            + kv('户数（5 口/户）', fmt(lv.households))
            + kv('适龄壮丁', fmt(lv.adultMales) + ' <span class="cost">（妇孺老弱 ' + fmt(lv.exempt) + ' 户免征）</span>')
            + kv('已征户（一户一丁）', fmt(lv.levied))
            + kv('本旬可征', '<b style="color:' + (lv.quota > 0 ? '#a9e2a0' : '#ff9d6b') + '">' + fmt(lv.quota) + '</b> 丁')
            + kv('征后人口代价', '每丁 −' + lv.popCostPerSoldier + ' 口')));
        }
        levyCard.appendChild(el('div', 'cost',
          '一户只出一丁，已征之户不再征；妇孺老少一律免征。每城每旬只征一次，'
          + '兵源耗尽要先办内政「劝课生息」增殖人口。'));
        if (lv && !lv.canLevy) {
          levyCard.appendChild(el('div', 'cost',
            '<span style="color:#ff9d6b">' + esc(lv.reasonText || '本旬不可征') + '。' + esc(lv.hint || '') + '</span>'));
          var devBtn = mkBtn('去内政 · 劝课生息', 'ghost', function () {
            window.__slgCityInterior(c.id, 'home');
          });
          devBtn.style.marginTop = '6px';
          levyCard.appendChild(devBtn);
        }
        var quickRow = el('div', 'row');
        quickRow.style.cssText = 'border:none;gap:6px;justify-content:flex-start;padding-top:9px;';
        var firstSlot = null;
        for (var qi = 0; qi < armies.length && !firstSlot; qi++) {
          var ga = armies[qi];
          for (var qp = 0; qp < 3; qp++) {
            if ((ga.generals || [])[qp] && !ga.marching) { firstSlot = { army: ga, pos: qp }; break; }
          }
        }
        /* ★ 一键征兵的三条硬约束，全部在点之前就算清楚（用户报的「一键征兵失败」根因）：
             ① 每旬只能征一次 → 已在征兵中就必须锁按钮，否则二次点击必然撞 cooldown 报错；
             ② 兵源上限 quota；
             ③ 资源（木/铁/粮/金）能支撑多少丁 —— 旧实现只拿 quota 当数量，
                资源不够时服务端拒绝，玩家看到的是「失败了但不知道差多少」。
           把「能征多少」提前算出来，按钮上直接写这个数。 */
        var costOf = function (n) {
          return {
            wood: n * (Number(per.wood) || 0), iron: n * (Number(per.iron) || 0),
            grain: n * (Number(per.grain) || 0), gold: n * (Number(per.gold) || 0),
          };
        };
        var maxAffordable = function () {
          var caps = [];
          [['wood', per.wood], ['iron', per.iron], ['grain', per.grain], ['gold', per.gold]].forEach(function (pair) {
            var each = Number(pair[1]) || 0;
            if (each > 0) caps.push(Math.floor((Number(res[pair[0]]) || 0) / each));
          });
          return caps.length ? Math.min.apply(null, caps) : 0;
        };
        var quotaN = lv ? Math.max(0, Number(lv.quota) || 0) : 0;
        var afford = Math.max(0, maxAffordable());
        var pending = levyPending && levyPending.cityId === cid && levyPending.until > Date.now()
          ? levyPending : null;
        var canGo = function () { return !!(firstSlot && quotaN > 0 && afford > 0 && !pending); };
        var pendingEl = el('div', 'cost', '');
        if (pending) {
          pendingEl.innerHTML = '<span style="color:#e0c56a">征兵中：' + fmt(pending.amount)
            + ' 丁正在路上，约 <b data-levy-sec="1">' + Math.ceil((pending.until - Date.now()) / 1000)
            + '</b> 秒后入营（本旬不可再征）</span>';
          levyCard.appendChild(pendingEl);
          if (levyPending.timer) clearInterval(levyPending.timer);
          levyPending.timer = setInterval(function () {
            var left = Math.ceil((pending.until - Date.now()) / 1000);
            var secEl = pendingEl.querySelector('[data-levy-sec]');
            if (left > 0) { if (secEl) secEl.textContent = String(left); return; }
            clearInterval(levyPending.timer);
            levyPending = null;
            reloadCityView();
          }, 1000);
        } else if (quotaN > 0 && afford < quotaN) {
          levyCard.appendChild(el('div', 'cost', '<span style="color:#e0c56a">'
            + '资源只够征 ' + fmt(afford) + ' 丁（本旬可征 ' + fmt(quotaN) + ' 丁）：'
            + '每兵需 木' + per.wood + ' 铁' + per.iron + ' 粮' + per.grain + ' 金' + per.gold + '。</span>'));
        }
        var doQuick = function (amount) {
          if (!firstSlot) { toast('先给一个槽位配上武将，再一键征兵', false); return; }
          if (pending) { toast('本旬已在征兵中，等兵入营或推进到下一旬', false); return; }
          var n0 = Math.max(0, Math.min(Math.floor(amount), quotaN, afford));
          if (n0 <= 0) { toast('本旬无兵可征：兵源或资源不足', false); return; }
          var cnts = [0, 0, 0];
          cnts[firstSlot.pos] = n0;
          send('army.conscript', { armyId: firstSlot.army.id, cnts: cnts }).then(function (rsp) {
            if (rsp.code === 0) {
              var eta = (rsp.msg && rsp.msg.etaSec) || 2;
              var fc = (rsp.msg && rsp.msg.farmConflict) || null;
              toast('征兵 ' + n0 + ' 丁，约 ' + eta + ' 秒后入营' + (fc ? '（' + fc.note + '）' : ''), true);
              /* ★ 立刻按服务端新状态重绘：不这样做，面板会继续显示旧的 quota/已征户，
                 玩家再点一次就撞 cooldown，看着就是「一键征兵失败」。 */
              levyPending = { cityId: cid, amount: n0, until: Date.now() + Math.max(1, eta) * 1000 };
              setTimeout(function () { reloadCityView(); }, 120);
            } else {
              var rs = (rsp.msg && rsp.msg.reason) || '';
              var msg = {
                levy_cooldown: '本旬已征过兵，下一旬再来',
                levy_exhausted: '各户壮丁已征尽，请先办「劝课生息」增殖人口',
                need_population: '兵源不足，先发展人口',
                over_quota: '超过本旬可征额（' + ((rsp.msg && rsp.msg.quota) || 0) + ' 丁）',
                no_population: '此城无人口', res_not_enough: '资源不足',
              }[rs] || errText(rsp);
              toast('征兵失败：' + msg, false);
              reloadCityView();
            }
          });
        };
        var quick = [['征 100 丁', 100], ['征 300 丁', 300],
          ['一键征满（' + fmt(Math.min(quotaN, afford || quotaN)) + '）', Math.min(quotaN, afford)]];
        quick.forEach(function (q) {
          var b = mkBtn(q[0], '', function () { doQuick(q[1]); });
          b.setAttribute('data-quick-levy', String(q[1]));
          /* 便捷征兵就是「一键」，旁边已写清人口与资源代价；再弹一次决策预览等于把便捷又变繁琐 */
          b.setAttribute('data-ix-allow', '1');
          if (!canGo() || q[1] > Math.min(quotaN, afford)) b.disabled = true;
          quickRow.appendChild(b);
        });
        levyCard.appendChild(quickRow);
        body.appendChild(levyCard);
        if (!gens.length) {
          body.appendChild(el('div', 'empty', '帐下无人。先去「酒馆」招募。'));
          return;
        }

        [1, 2, 3].forEach(function (order) {
          var a = byOrder[order] || {
            id: 0, order: order, generals: [0, 0, 0], soldiers: [0, 0, 0], con_times: [0, 0, 0],
          };
          var total = (a.soldiers || []).reduce(function (x, y) { return x + (Number(y) || 0); }, 0);
          var card = el('div', 'card');
          card.innerHTML = '<div class="row" style="border:none;padding:0 0 2px">'
            + '<b style="color:#f0d998">第 ' + order + ' 军</b><span>兵力 ' + fmt(total) + '</span></div>';
          [0, 1, 2].forEach(function (pos) {
            var gid = (a.generals || [])[pos] || 0;
            var soldiers = (a.soldiers || [])[pos] || 0;
            var waiting = (a.con_times || [])[pos] || 0;
            var row = el('div', 'row');
            var left = el('span', '');
            left.innerHTML = '<span class="winTag">' + ['一', '二', '三'][pos] + '</span> ';
            var sel = document.createElement('select');
            sel.style.cssText = 'background:#101208;color:#e2d6b8;border:1px solid #4a4436;'
              + 'border-radius:4px;padding:2px 6px;font:12px "Microsoft YaHei",sans-serif;';
            var empty = document.createElement('option');
            empty.value = '0';
            empty.textContent = '（空）';
            sel.appendChild(empty);
            gens.forEach(function (g) {
              var o = document.createElement('option');
              o.value = String(g.id);
              o.textContent = (g.name || ('武将' + g.cfgId)) + ' ★' + (g.star || 0);
              if (g.id === gid) o.selected = true;
              sel.appendChild(o);
            });
            sel.onchange = function () {
              send('army.dispose', {
                cityId: cid, order: order, position: pos, generalId: Number(sel.value) || 0,
              }).then(function (rsp) {
                if (rsp.code === 0) toast('第 ' + order + ' 军 · ' + ['一', '二', '三'][pos] + ' 位已更新', true);
                else toast('编队失败：' + errText(rsp), false);
                tabArmy(body, c);
              });
            };
            left.appendChild(sel);
            /* ★ P7：槽位 = 战位（一=前锋 二=中军 三=大营）。
               跨阵营距离 = 我方槽位 + 敌方槽位 + 1：能打到哪里由攻距决定。 */
            var curG = gens.filter(function (g) { return g.id === gid; })[0];
            if (curG) {
              var ad = atkDistOf(curG);
              var reach = ad >= pos + 3 ? '可及敌大营'
                : (ad >= pos + 2 ? '可及敌中军' : '仅及敌前锋');
              var warn = ad < pos + 2;
              left.appendChild(el('span', 'cost',
                '　攻距 ' + ad + ' · ' + (warn ? '<span style="color:#ff9d6b">' + reach + '</span>' : reach)));
            }
            left.appendChild(el('span', 'cost', '　兵力 ' + fmt(soldiers)
              + (waiting > nowSec() ? '（征兵中，' + (waiting - nowSec()) + 's）' : '')));
            row.appendChild(left);

            if (!gid) {
              row.appendChild(el('span', 'cost', '先配将'));
            } else {
              var input = document.createElement('input');
              input.className = 'n';
              input.type = 'number';
              input.value = 100;
              input.min = 1;
              input.style.width = '66px';
              var go = mkBtn('征兵', '', function () {
                var n = Math.max(0, Number(input.value) || 0);
                var cnts = [0, 0, 0];
                cnts[pos] = n;
                send('army.conscript', { armyId: a.id, cnts: cnts }).then(function (rsp) {
                  if (rsp.code === 0) {
                    var eta = (rsp.msg && rsp.msg.etaSec) || 2;
                    toast('征兵 ' + n + ' 人，约 ' + eta + ' 秒后入营', true);
                    setTimeout(function () { tabArmy(body, c); }, (eta + 1) * 1000);
                  } else {
                    var reason = (rsp.msg && rsp.msg.reason) || '';
                    toast('征兵失败：' + (reason === 'res_not_enough' ? '资源不足' : errText(rsp)), false);
                  }
                });
              });
              var n0 = 100;
              var need = { wood: n0 * per.wood, iron: n0 * per.iron, grain: n0 * per.grain, gold: n0 * per.gold };
              var lack = need.wood > res.wood || need.iron > res.iron
                || need.grain > res.grain || need.gold > res.gold;
              var wrap = el('span', '');
              wrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
              wrap.appendChild(input);
              wrap.appendChild(go);
              if (lack) {
                wrap.title = '资源不足：100 兵需 木' + fmt(need.wood) + ' 铁' + fmt(need.iron)
                  + ' 粮' + fmt(need.grain) + ' 金' + fmt(need.gold);
                go.disabled = true;
              }
              row.appendChild(wrap);
            }
            card.appendChild(row);
          });
          body.appendChild(card);
        });
        body.appendChild(el('div', 'cost',
          '每兵：木 ' + per.wood + ' · 铁 ' + per.iron + ' · 粮 ' + per.grain + ' · 金 ' + per.gold));
      })
      .catch(function () { body.innerHTML = '<div class="empty">读取失败，稍后再试。</div>'; });
  }

  function nowSec() { return Math.floor(Date.now() / 1000); }

  function renderGensInto(hostEl) {
    hostEl.innerHTML = '<div class="empty">读取中…</div>';
    send('general.myGenerals', {}).then(function (rsp) {
      hostEl.innerHTML = '';
      var gens = (rsp.msg.generals || []);
      if (!gens.length) { hostEl.appendChild(el('div', 'empty', '帐下无人。')); return; }
      gens.forEach(function (g) {
        var card = el('div', 'card');
        card.innerHTML = '<div class="row" style="border:none;padding:0 0 4px">'
          + '<b class="star' + (g.star >= 5 ? '5' : g.star === 4 ? '4' : '3') + '">'
          + (g.name || '武将' + g.cfgId) + '</b>'
          + '<span>★' + (g.star || 0) + ' · Lv' + g.level
          + ' · ' + (['盾步', '弓兵', '骑兵'][(Number(g.curArms) || 1) - 1])
          + ' · 攻距 ' + atkDistOf(g) + '</span></div>'
          + '<div>' + (g.skills || []).filter(Boolean).map(function (sk) {
            return '<span class="chip">' + (sk.name || ('技' + sk.cfgId)) + ' lv' + sk.lv + '</span>';
          }).join('') + '</div>';
        var skillBar = el('div', '');
        skillBar.style.marginTop = '6px';
        (g.skills || []).forEach(function (sk, pos) {
          if (!sk) return;
          var b = mkBtn('强化「' + (sk.name || '技' + sk.cfgId) + '」', 'ghost', function () {
            send('general.lvSkill', { gId: g.id, pos: pos }).then(function (rsp) {
              if (rsp.code === 0) toast('「' + (sk.name || '技') + '」已强化', true);
              else toast('强化失败：' + errText(rsp), false);
              renderGensInto(hostEl);
            });
          });
          b.style.margin = '2px 6px 2px 0';
          skillBar.appendChild(b);
        });
        card.appendChild(skillBar);
        hostEl.appendChild(card);
      });
    });
  }

  function renderTavernInto(hostEl) {
    hostEl.innerHTML = '<div class="empty">读取中…</div>';
    send('tavern.guests', {}).then(function (rsp) {
      hostEl.innerHTML = '';
      var m = rsp.msg || {};
      hostEl.appendChild(el('div', 'card', '招募一位 <b style="color:#f0d998">' + m.cost
        + '</b> 金。豪杰按辰光来访，过了时辰便见不到。'));
      var list = el('div', 'card', '<h4 style="margin-top:0">此刻在店</h4>');
      var now = m.now || [];
      if (!now.length) {
        list.appendChild(el('div', 'empty', '此刻无人来访——' + (m.nextAt ? (m.nextAt + '再来看') : '等下个时辰')));
      }
      now.forEach(function (g) {
        var row = el('div', 'row');
        row.innerHTML = '<span><b style="color:#f0d998">' + g.name + '</b> <span class="chip">'
          + g.when + '</span></span>';
        row.appendChild(mkBtn('招募', '', function () {
          send('general.drawGeneral', { drawTimes: 1 }).then(function (r2) {
            var got = (r2.msg && r2.msg.generals) || [];
            var reason = (r2.msg && r2.msg.reason) || '';
            if (got.length) {
              toast('入营：' + got.map(function (x) { return x.name || '武将'; }).join('、')
                + '　到「征兵」页把他编入队伍', true);
            } else if (reason === 'not_enough_gold') {
              toast('金不足：需 ' + ((r2.msg && r2.msg.cost) || m.cost) + ' 金', false);
            } else if (reason === 'no_guest') {
              toast('此刻无人来访' + (m.nextAt ? '，' + m.nextAt + '再来' : ''), false);
            } else {
              toast('招募失败：' + errText(r2), false);
            }
            renderTavernInto(hostEl);
          });
        }));
        list.appendChild(row);
      });
      var today = m.today || [];
      if (today.length) {
        var STATE_TXT = { now: '此刻在店', upcoming: '尚未到店', passed: '已过时辰' };
        list.appendChild(el('div', 'cost', '今日可见：' + today.map(function (g) {
          return g.name + '（' + g.when + '·' + (STATE_TXT[g.state] || '') + '）'
            + (g.recruited ? ' ✓已入营' : '');
        }).join('、')));
      }
      hostEl.appendChild(list);
    });
  }

  /** 战报里「守军 N → M」的 M。
   *  ★ 内核允许治疗把兵力顶回原数之上，直接累加余兵会出现「守军 1982 → 2148」
   *    这种自相矛盾的显示（同一屏还写着歼敌 72）。展示口径按「不超过投入」夹住，
   *    歼敌数仍取服务端的 dLoss，不改判定。 */
  function dRemainShown(an) {
    if (!an) return 0;
    var sum = (an.dRemain || []).reduce(function (a, b) { return a + Number(b || 0); }, 0);
    var cap = Number(an.dTotal) || 0;
    return cap > 0 ? Math.min(sum, cap) : sum;
  }

  function renderReportsInto(hostEl, city) {
    hostEl.innerHTML = '<div class="empty">读取中…</div>';
    send('war.report', {}).then(function (rsp) {
      hostEl.innerHTML = '';
      var all = rsp.msg.list || [];
      var list = all;
      if (city) {
        var related = all.filter(function (r) {
          var place = (r.anim && r.anim.place) ? String(r.anim.place) : '';
          return place.indexOf(city.name) >= 0;
        });
        var isHome = cache && cache.playerCity === city.id;
        if (related.length) {
          hostEl.appendChild(el('div', 'cost', '与「' + city.name + '」相关的战报'));
          list = related;
        } else if (isHome) {
          list = all;
        } else {
          hostEl.appendChild(el('div', 'empty', city.name + ' 尚无战报。'));
          return;
        }
      }
      list = list.slice(0, 30);
      if (!list.length) { hostEl.appendChild(el('div', 'empty', '尚无战报。')); return; }
      list.forEach(function (r) {
        var tag = r.result === 2 ? ['胜', '#6fcf97'] : (r.result === 0 ? ['败', '#ff6b5e'] : ['平', '#c8b88a']);
        var place = r.anim && r.anim.place ? r.anim.place : ('(' + r.x + ',' + r.y + ')');
        var row = el('div', 'row');
        var who = el('span', '');
        who.style.cursor = 'pointer';
        who.innerHTML = '<b style="color:' + tag[1] + '">' + tag[0] + '</b> #' + r.id
          + ' <b>' + esc(place) + '</b>'
          + '<span class="cost" style="margin-left:6px" data-fold="1">▸ 展开</span>';
        /* ★ 验收 #23：回合报告可折叠——列表只给胜负与地点，展开才看兵力变化与归因，
           不然三十份战报铺成一面墙，「哪一仗怎么输的」反而读不出来。 */
        var fold = el('div', '');
        fold.style.display = 'none';
        fold.innerHTML = (r.summary ? ('<div style="margin-top:4px">' + esc(r.summary) + '</div>') : '')
          + (r.analysis ? ('<div class="cost">我军 ' + fmt(r.analysis.aTotal) + ' → '
            + fmt((r.analysis.aRemain || []).reduce(function (a, b) { return a + Number(b || 0); }, 0))
            + '　守军 ' + fmt(r.analysis.dTotal) + ' → '
            + fmt(dRemainShown(r.analysis))
            + (r.analysis.aLoss != null ? ('　折损 ' + fmt(r.analysis.aLoss) + ' / 歼敌 ' + fmt(r.analysis.dLoss)) : '')
            + '</div>') : '')
          + (r.ctime ? ('<div class="cost">' + new Date(r.ctime).toLocaleString('zh-CN') + '</div>') : '');
        var tip = who.querySelector('[data-fold]');
        who.onclick = function () {
          var open = fold.style.display !== 'none';
          fold.style.display = open ? 'none' : 'block';
          if (tip) tip.textContent = open ? '▸ 展开' : '▾ 收起';
        };
        var bar = el('div', '');
        if (r.anim) bar.appendChild(mkBtn('回放', 'ghost', function () {
          if (window.__slgPlayBattle) window.__slgPlayBattle(r.anim);
        }));
        // ★ P0-2：详情必须能在被遮住的 Cocos 面板之外打开，否则玩家永远看不到「为什么输」
        bar.appendChild(mkBtn('详情', 'ghost', function () { openReportDetail(r); }));
        /* ★ 验收 #23：回跳——从战报直接回到当时那座城，不用在地图上重新找 */
        bar.appendChild(mkBtn('回跳地图', 'ghost', function () {
          var ok = window.__slgFocusCity ? window.__slgFocusCity(place) : false;
          if (!ok) toast('这张战报没有可回跳的城（' + place + '）', false);
        }));
        row.appendChild(who);
        row.appendChild(bar);
        hostEl.appendChild(row);
        hostEl.appendChild(fold);
      });
    });
  }

  /** 战报详情（DOM）：打斗画面 + 战果 + 战法效果 + 逐回合人话。
   *
   *  ★ 玩家反馈两件事：① 战报没有打斗画面；② 只写「吕布 发动 健卒不殆」，看不懂这战法干嘛。
   *    这次不在前端补文案，而是：
   *      1) 详情顶部直接内嵌 createStage 的战斗画面（跟全屏回放同一套），
   *         打开战报就能看双方对冲，不必先知道要点「回放」；
   *      2) 战法效果说明取服务端 battle-narrative 的 skillProfile（与推演、回放字幕同源），
   *         前端只排版，绝不自造数值；
   *      3) 逐回合日志直接用 act.text（服务端 actSentence 产出），删掉前端那套拼句逻辑
   *         —— 否则同一个动作在回放、详情、推演里会有三种说法。
   */
  function openReportDetail(r) {
    var tag = r.result === 2 ? ['胜', '#6fcf97'] : (r.result === 0 ? ['败', '#ff6b5e'] : ['平', '#c8b88a']);
    var anim = r.anim || { a: { units: [] }, d: { units: [] }, rounds: [] };
    var stage = null;
    var body = makeWindow('slgRepDetail',
      '战报 #' + r.id + ' · <span style="color:' + tag[1] + '">' + tag[0] + '</span>',
      '<div class="sub">' + (anim.place || ('(' + r.x + ',' + r.y + ')'))
      + (r.ctime ? ' · ' + new Date(r.ctime).toLocaleString('zh-CN') : '') + '</div>',
      null, null, null,
      function () {
        /* 关窗时必须停掉 rAF，否则关掉的战报还在后台逐帧画 */
        if (stage) { try { stage.destroy(); } catch (e) { /* 画布已随窗口移除 */ } stage = null; }
        var w = document.getElementById('slgRepDetail');
        if (w) w.remove();
      });

    /* ---- 1. 战果 ---- */
    var sum = el('div', 'card');
    sum.innerHTML = '<h4 style="margin-top:0">战果</h4><div>' + (r.summary || '（无摘要）') + '</div>'
      + (r.analysis ? ('<div class="cost">我军 ' + fmt(r.analysis.aTotal) + ' → '
        + fmt((r.analysis.aRemain || []).reduce(function (a, b) { return a + Number(b || 0); }, 0))
        + '　守军 ' + fmt(r.analysis.dTotal) + ' → '
        + fmt(dRemainShown(r.analysis))
        + (r.analysis.aLoss != null ? ('　折损 ' + fmt(r.analysis.aLoss) + ' / 歼敌 ' + fmt(r.analysis.dLoss)) : '')
        + '</div>') : '');
    body.appendChild(sum);

    /* ---- 2. 打斗画面（内嵌 Stage） ---- */
    var rounds = anim.rounds || [];
    if (rounds.length && window.__slgBattleStage) {
      var sceneCard = el('div', 'card');
      sceneCard.innerHTML = '<h4 style="margin-top:0">战斗画面</h4>'
        + '<div class="muted">下方字幕逐句说明「谁做了什么、打出什么效果、折了多少卒」；'
        + '可暂停 / 重播 / 倍速，也可以点「回放」看全屏。</div>';
      var host2 = el('div', '');
      host2.style.marginTop = '8px';
      sceneCard.appendChild(host2);
      body.appendChild(sceneCard);
      stage = window.__slgBattleStage(host2, anim, { autoPlay: true, height: '340px' });
    } else if (!rounds.length) {
      body.appendChild(el('div', 'card',
        '<h4 style="margin-top:0">战斗画面</h4><div class="muted">'
        + '这张战报没有留存动作流（旧版本战报只存了结果），没法回放打斗。</div>'));
    }

    /* ---- 3. 双方阵容 + 战法效果（回答「健卒不殆到底是什么」） ---- */
    [['我军', anim.a, '#c0392b'], ['守军', anim.d, '#2c5f8a']].forEach(function (side) {
      var units = (side[1] && side[1].units) || [];
      if (!units.length) return;
      var card = el('div', 'card');
      card.innerHTML = '<h4 style="margin-top:0;color:' + side[2] + '">' + side[0]
        + '：' + esc((side[1] && side[1].name) || '') + '</h4>';
      units.forEach(function (u) {
        var row = el('div', '');
        row.style.cssText = 'padding:6px 0;border-bottom:1px dashed #2e2a22';
        row.innerHTML = '<div><b>' + esc(u.name || '武将') + '</b>'
          + '<span class="cost">　' + fmt(u.troops) + ' → ' + fmt(u.remain) + '</span></div>'
          + ((u.skills || []).length
            ? (u.skills || []).map(function (p) {
              return '<div class="cost" style="margin-left:12px">「' + esc(p.name) + '」'
                + (p.clsText ? '（' + esc(p.clsText) + '）' : '') + '：'
                + esc(p.effect || '')
                + (p.flavor ? '　<span style="color:#9c9382">' + esc(p.flavor) + '</span>' : '')
                + '</div>';
            }).join('')
            : '<div class="cost" style="margin-left:12px">无战法</div>');
        card.appendChild(row);
      });
      body.appendChild(card);
    });

    /* ---- 4. 战法发动统计：发动几次、折了多少卒、效果是什么 ---- */
    var skillStat = {};
    rounds.forEach(function (rd) {
      (rd.acts || []).forEach(function (act) {
        if (act.t === 'skill' && act.skill) {
          var s0 = skillStat[act.skill] || (skillStat[act.skill] = { count: 0, loss: 0, effect: '', who: {} });
          s0.count += 1;
          s0.loss += act.loss || 0;
          if (!s0.effect && act.effect) s0.effect = act.effect;
          if (act.fName) s0.who[act.fName] = 1;
        }
      });
    });
    var skeys = Object.keys(skillStat);
    if (skeys.length) {
      var totalLoss = skeys.reduce(function (a, k) { return a + skillStat[k].loss; }, 0) || 1;
      var statCard = el('div', 'card');
      statCard.innerHTML = '<h4 style="margin-top:0">战法发动统计</h4>'
        + '<div class="muted">按确定性事件流汇总；伤害占比 = 该战法歼敌 / 双方战法总歼敌。</div>'
        + skeys.map(function (k) {
          var st0 = skillStat[k];
          var pct = Math.round(st0.loss / totalLoss * 100);
          /* 纯增益/控制类战法不造成伤害，写「伤害占比 0%」会被读成「没生效」；
             这类只报发动次数，只有真的打出伤害的才给占比。 */
          var tail = ' · 发动 ' + st0.count + ' 次'
            + (st0.loss > 0 ? ' · 伤害占比 ' + pct + '%' : ' · 未造成直接伤害');
          return '<div style="padding:5px 0;border-bottom:1px dashed #2e2a22">'
            + '<div><b>「' + esc(k) + '」</b><span class="cost">　' + Object.keys(st0.who).join('、')
            + tail + '</span></div>'
            + (st0.effect ? '<div class="cost" style="margin-left:12px">效果：' + esc(st0.effect) + '</div>' : '')
            + '</div>';
        }).join('');
      body.appendChild(statCard);
    }

    /* ---- 5. 逐回合：一行一个人话动作（服务端 act.text） ---- */
    if (rounds.length) {
      var logCard = el('div', 'card');
      logCard.innerHTML = '<h4 style="margin-top:0">逐回合经过</h4>';
      rounds.slice(0, 12).forEach(function (rd) {
        var box = el('div', '');
        box.style.marginBottom = '8px';
        box.innerHTML = '<div style="color:#e8c670;font-weight:bold;margin:6px 0 2px">'
          + (rd.round > 0 ? '第 ' + rd.round + ' 回合' : '列阵') + '</div>';
        (rd.acts || []).forEach(function (act) {
          var line = act.text || '';
          if (!line) return;
          var color = act.t === 'skill' ? '#ffe9b0'
            : (act.t === 'down' ? '#ff9d6b' : (act.t === 'heal' ? '#a9e2a0' : '#c8c2b4'));
          var d = el('div', '');
          d.style.cssText = 'color:' + color + ';font-size:12.5px;line-height:1.7;text-align:left';
          d.textContent = (act.t === 'skill' ? '◆ ' : '· ') + line;
          box.appendChild(d);
        });
        logCard.appendChild(box);
      });
      if (rounds.length > 12) {
        logCard.appendChild(el('div', 'muted', '（只显示前 12 回合，共 ' + rounds.length + ' 回合）'));
      }
      body.appendChild(logCard);
    }

    body.appendChild(mkBtn('关闭', 'ghost', function () {
      var w = document.getElementById('slgRepDetail');
      if (stage) { try { stage.destroy(); } catch (e) { /* ignore */ } stage = null; }
      if (w) w.remove();
    }));
  }

  window.__slgGeneralsWindow = function () {
    var body = makeWindow('slgGenWin', '帐下武将', '', null, null, null,
      function () { document.getElementById('slgGenWin').remove(); });
    renderGensInto(body);
  };
  window.__slgReportsWindow = function () {
    var body = makeWindow('slgRepWin', '战报', '', null, null, null,
      function () { document.getElementById('slgRepWin').remove(); });
    renderReportsInto(body);
  };
  /* 回放/战报里的「战报详情」统一走这里（原版有这个钩子名，别处也按它找） */
  window.__slgOpenWarReport = window.__slgReportsWindow;

  window.__slgHudTick = function () {
    var hud = document.getElementById('slgHud');
    if (!hud || !window.__slgSend) return;
    window.__slgSend('role.myRoleRes', {}).then(function (r) {
      var res = (r.rsp.msg && r.rsp.msg.role_res) || {};
      var cap = Number(res.depot_capacity) || 0;
      hud.innerHTML = ['wood|木', 'iron|铁', 'stone|石', 'grain|粮', 'gold|金'].map(function (pair) {
        var p = pair.split('|');
        // ★ P1-5：满仓后仍显示「+2000/日」会骗人，这里直接给「已满仓」
        var full = cap > 0 && p[0] !== 'gold' && Number(res[p[0]] || 0) >= cap;
        var tail = full ? '<span style="color:#ff9d6b"> (已满仓)</span>'
          : '<span style="opacity:.65"> (+' + fmt(res[p[0] + '_yield']) + '/日)</span>';
        return '<span>' + p[1] + ' ' + fmt(res[p[0]]) + tail + '</span>';
      }).join('　') + '　<span>令 ' + fmt(res.decree) + '</span>';
    }).catch(function () {});
  };
  // 预取 world.meta：此刻客户端模块可能还没执行完，__slgSend 尚未挂上。
  // 未就绪就跳过预热（各面板打开时会重新取，功能不受影响），
  // 避免在登录页弹「尚未连上游戏」这种看着像断线的提示。
  if (window.__slgSend) loadMeta().catch(function () {});
})();`;


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

  // 1b) ★ 替换原版 skill_outline：原版 target_type.list 只有 8 条（1~8），
  //     新战法表用到 target=9（敌军全体），不替换则技能详情面板读
  //     target_type.list[8].des 时对 undefined 取值直接抛错。
  for (const [uuid, p] of Object.entries(patched.paths)) {
    if (Array.isArray(p) && p[0] === 'config/json/skill/skill_outline') {
      importBodies.set(uuid, jsonAsset('skill_outline', outline));
      break;
    }
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

  const generalUuid = '2bb9964d-0938-48d1-b4a5-f2cabf1c1c2b';
  const generalPath = `/assets/resources/import/${generalUuid.slice(0, 2)}/${generalUuid}.json`;
  const generalFile = join(webDir, 'assets', 'resources', 'import', generalUuid.slice(0, 2), `${generalUuid}.json`);
  if (existsSync(generalFile)) {
    const packed = JSON.parse(readFileSync(generalFile, 'utf8'));
    const body = packed?.[5]?.[0]?.[2];
    const protag = JSON.parse(readFileSync(join(ROOT, 'conf', 'campaign', 'protagonist.json'), 'utf8')).general;
    const heroSkills = existsSync(join(ROOT, 'conf', 'campaign', 'hero-skills.json'))
      ? JSON.parse(readFileSync(join(ROOT, 'conf', 'campaign', 'hero-skills.json'), 'utf8'))
      : {};
    if (body?.list) {
      if (!body.list.some((g) => g.cfgId === protag.cfgId)) body.list.push(protag);
      for (const g of body.list) {
        if (g.cfgId === protag.cfgId) g.skillCfgId = 19001;
        else g.skillCfgId = heroSkills[g.name] || 0;
      }
      byPath.set(generalPath, JSON.stringify(packed));
    }
  }

  const clientPath = '/assets/main/index.js';
  const clientFile = join(webDir, 'assets', 'main', 'index.js');
  let clientBody = null;
  if (existsSync(clientFile)) {
    clientBody = patchClientBundle(readFileSync(clientFile, 'utf8'));
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
      if (urlPath === clientPath && clientBody) {
        return { body: clientBody, contentType: 'text/javascript; charset=utf-8' };
      }
      const body = byPath.get(urlPath);
      if (body !== undefined) return { body, contentType: 'application/json; charset=utf-8' };
      return null;
    },
    uuidFor,
    injected,
  };
}
