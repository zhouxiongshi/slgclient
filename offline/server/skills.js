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
        _proto.account_logout = function account_logout() {`,
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
  // 分层渲染：底图 / 州名 / 路网 / 城池 / 关隘 / 城名，对应 tmx 的六层贴图
  var LAYER = { base: true, zhou: true, road: true, city: true, pass: true, name: true };

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
        else if (mv.kind === '出征') { label = '未发'; color = '#8a8070'; }
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
    var dock = document.createElement('div');
    dock.id = 'slgDock';
    dock.style.cssText = 'position:absolute;top:12px;left:12px;z-index:4;display:flex;flex-wrap:wrap;gap:6px;'
      + 'max-width:calc(100% - 780px);';
    dock.innerHTML = ''
      + '<button id="slgStratTick" style="' + btnCss + '">推演一月</button>'
      + '<button id="slgBtnWar" style="' + btnCss + '">出征</button>'
      + '<button id="slgBtnHome" style="' + btnCss + '">本城</button>'
      + '<button id="slgBtnGens" style="' + btnCss + '">武将</button>'
      + '<button id="slgBtnReps" style="' + btnCss + '">战报</button>'
      + '<button id="slgBtnZoomIn" style="' + btnCss + '">放大</button>'
      + '<button id="slgBtnZoomOut" style="' + btnCss + '">缩小</button>'
      + '<button id="slgBtnFit" style="' + btnCss + '">全图</button>'
      + '<button id="slgBtnLog" style="' + btnCss + '">天下日志</button>';
    Array.prototype.forEach.call(dock.querySelectorAll('button'), function (b) {
      b.style.fontFamily = '"Microsoft YaHei",sans-serif';
    });
    var legend = document.createElement('div');
    legend.id = 'slgLegend';
    legend.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:100002;width:220px;display:none;'
      + 'text-align:left;background:rgba(14,15,11,0.88);'
      + 'border:1px solid rgba(186,154,82,0.45);border-radius:8px;padding:8px 12px;'
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
    document.getElementById('slgBtnGens').onclick = function () {
      /* ★ P6：与右侧六府菜单联动——优先开六府「武将」页，旧窗口兜底 */
      if (window.__slgPanels && window.__slgPanels.open) window.__slgPanels.open('general');
      else if (window.__slgGeneralsWindow) window.__slgGeneralsWindow();
    };
    document.getElementById('slgBtnReps').onclick = function () {
      if (window.__slgReportsWindow) window.__slgReportsWindow();
    };
    document.getElementById('slgStratTick').onclick = function () {
      // ★ P0-1：推演一月现在是服务端原子推进 10 天并跑一次诸侯决策，必须给玩家回话
      fetch('/__slg/strategy/tick', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          refresh();
          if (!window.__slgToast) return;
          if (res.skipped) window.__slgToast('本回合已推演过，还需 ' + Math.max(1, res.need || 0) + ' 个游戏日', false);
          else window.__slgToast('推演至第 ' + (res.month || (res.turn || 0) + 1) + ' 月 · 游戏日 ' + res.day, true);
        })
        .catch(function () {});
    };
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
    showIntro(hit.city);
    if (window.__slgCityWindow) window.__slgCityWindow(hit.city.id);
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
      + 'border-bottom:1px solid rgba(186,154,82,0.25);padding-bottom:5px;margin-bottom:6px;';
    head.textContent = '图层与检索';
    sidePanel.appendChild(head);

    var LAYER_LABEL = [
      ['base', '十三州水墨底图'], ['zhou', '十三州部古名'], ['road', '分级路网'],
      ['city', '城池模型'], ['pass', '八处关隘'], ['name', '城名标注'],
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
    var hasLayers = !!(DETAIL && DETAIL.layers);
    var baseImg = LAYER.base && hasLayers && DETAIL.layers.base
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

    drawLayer('zhou');
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
        var acc = 0, closed = false;
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
          } else {
            var t = L2 > 0 ? (walked - acc) / L2 : 0;
            cur = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
            var qc = P(cur);
            g.lineTo(qc[0], qc[1]);
            g.stroke();
            // 未走部分：同色虚线
            g.setLineDash([6 * scale, 5 * scale]);
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
        // 军标：小旗插在当前位置
        var qm = P(cur);
        g.fillStyle = 'rgba(20,16,8,.55)';
        g.beginPath(); g.arc(qm[0], qm[1] + 2 * scale, Math.max(2.5, 3.5 * scale), 0, 6.2832); g.fill();
        var fh2 = Math.max(7, 12 * scale), fw2 = fh2 * 1.1;
        g.fillStyle = cFlag;
        g.beginPath();
        g.moveTo(qm[0], qm[1] - fh2);
        g.lineTo(qm[0] + fw2, qm[1] - fh2 + fh2 * 0.3);
        g.lineTo(qm[0], qm[1] - fh2 + fh2 * 0.62);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(30,24,14,.8)'; g.lineWidth = Math.max(0.8, 1 * scale); g.stroke();
        g.strokeStyle = cFlag;
        g.beginPath(); g.moveTo(qm[0], qm[1] - fh2); g.lineTo(qm[0], qm[1]); g.stroke();
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

    // 势力图例固定在游戏窗口右下角，不随地图拖动；条目左对齐
    var legend = document.getElementById('slgLegend');
    if (legend) {
      var html = '<div style="color:#e8c670;font-weight:bold;letter-spacing:2px;text-align:left;">势力</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;column-gap:14px;text-align:left;">';
      for (var i = 0; i < s.factions.length; i++) {
        var f = s.factions[i];
        html += '<div style="text-align:left;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;'
          + 'background:' + f.color + ';margin-right:6px;vertical-align:-1px;"></span>' + f.name + '</div>';
      }
      html += '<div style="text-align:left;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;'
        + 'background:' + s.neutral.color + ';margin-right:6px;vertical-align:-1px;"></span>' + s.neutral.name + '</div>';
      html += '</div><div style="border-top:1px solid rgba(186,154,82,.25);margin-top:3px;padding-top:3px;text-align:left;">'
        + '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;'
        + 'border:2px solid #e8c670;margin-right:5px;vertical-align:-1px;"></span>金环＝本城</div>';
      legend.innerHTML = html;
    }
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

/** 战斗回放：把战报里的确定性事件流播成平铺对拼动画。 */
const BATTLE_ANIM_SOURCE = `;(function () {
  if (typeof document === 'undefined') return;
  var overlay = null, canvas = null, raf = null;
  var anim = null, cues = [], t0 = 0, particles = [], units = {}, finished = false;

  var SIDE_COLOR = { a: '#c0392b', d: '#2c5f8a' };
  var SIDE_NAME = { a: '攻方', d: '守方' };
  var DUR = { banner: 650, prepare: 450, skill: 950, hit: 620, control: 550, heal: 550, down: 800, result: 1400 };

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'slgBattleOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99997;display:none;background:#101216;';
    var head = document.createElement('div');
    head.style.cssText = 'position:absolute;top:0;left:0;right:0;height:34px;display:flex;align-items:center;'
      + 'padding:0 12px;gap:14px;background:#161810;color:#e8c670;font:14px "Microsoft YaHei",sans-serif;z-index:3;';
    head.innerHTML = '<b id="slgBattleTitle"></b><span style="flex:1"></span>'
      + '<button id="slgBattleReplay" style="background:#2a2c30;color:#e8c670;border:1px solid #ba9a52;border-radius:4px;padding:2px 10px;cursor:pointer;">重播</button>'
      + '<button id="slgBattleReport" style="background:#2a2c30;color:#e8c670;border:1px solid #ba9a52;border-radius:4px;padding:2px 10px;cursor:pointer;">战报详情</button>'
      + '<button id="slgBattleClose" style="background:#2a2c30;color:#c9c9c9;border:1px solid #666;border-radius:4px;padding:2px 10px;cursor:pointer;">关闭</button>';
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;top:34px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 34px);';
    overlay.appendChild(head); overlay.appendChild(canvas);
    document.body.appendChild(overlay);
    document.getElementById('slgBattleClose').onclick = hide;
    document.getElementById('slgBattleReplay').onclick = function () { if (anim) play(anim); };
    document.getElementById('slgBattleReport').onclick = function () {
      hide();
      if (window.__slgOpenWarReport) window.__slgOpenWarReport();
    };
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay && overlay.style.display !== 'none') hide();
    });
  }

  function hide() {
    if (overlay) overlay.style.display = 'none';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  function unitKey(u) { return u ? (u.s + u.i) : ''; }

  function buildUnits(a) {
    units = {};
    var put = function (side, list) {
      (list || []).forEach(function (u, i) {
        units[side + u.slot] = {
          side: side, slot: u.slot, name: u.name,
          troops: Math.max(1, u.troops), cur: Math.max(0, u.remain),
          dead: u.remain <= 0, x: 0, y: 0, lungeT: -1, flashT: -1, fallT: -1,
        };
      });
    };
    put('a', a.a && a.a.units); put('d', a.d && a.d.units);
  }

  function buildCues(a) {
    cues = [];
    var t = 400;
    cues.push({ t: 0, fn: function () {} });
    a.rounds.forEach(function (r) {
      cues.push({ t: t, fn: function (ctx) { ctx.roundBanner = '第 ' + r.round + ' 回合'; ctx.roundUntil = t + DUR.banner; } });
      t += DUR.banner;
      r.acts.forEach(function (act) {
        var dur = DUR[act.t] || 500;
        cues.push({
          t: t, fn: function (ctx) { applyAct(ctx, act); },
          end: t + dur,
        });
        t += Math.max(220, dur * 0.55);
      });
    });
    cues.push({
      t: t, fn: function (ctx) {
        ctx.resultBanner = a.winner === 2 ? '胜' : (a.winner === 0 ? '败' : '平');
        ctx.resultColor = a.winner === 2 ? '#e8c670' : (a.winner === 0 ? '#c0392b' : '#9aa0a6');
      },
    });
    cues.push({ t: t + DUR.result, fn: function (ctx) { ctx.finished = true; } });
    return t + DUR.result;
  }

  function applyAct(ctx, act) {
    var f = units[unitKey(act.f)];
    var to = units[unitKey(act.to || act.unit)];
    if (act.t === 'hit' && f && to && !f.dead) {
      f.lungeT = performance.now();
      f.lungeTarget = to;
      to.flashT = performance.now();
      damage(to, act.loss);
      particles.push(mkText('-' + fmt(act.loss), to.x, to.y - 46, '#ff6b5e'));
    } else if (act.t === 'skill' && f) {
      // 战法伤害已由同回合的 hit 动作结算，这里只做演出，不重复扣兵
      ctx.skillBanner = (f.name || '') + ' · ' + (act.skill || '战法');
      ctx.skillUntil = performance.now() + 900;
      f.skillT = performance.now();
      if (act.to && to) to.flashT = performance.now();
    } else if (act.t === 'control' && to) {
      to.stateText = act.state;
      to.stateT = performance.now();
      particles.push(mkText(act.state || '受制', to.x, to.y - 46, '#b07ce8'));
    } else if (act.t === 'heal' && to) {
      var amt = Math.min(act.amount || 0, to.troops - to.cur);
      to.cur += amt;
      particles.push(mkText('+' + fmt(amt), to.x, to.y - 46, '#6fcf97'));
    } else if (act.t === 'prepare' && f) {
      ctx.skillBanner = (f.name || '') + ' · ' + (act.skill || '战法') + '（蓄）';
      ctx.skillUntil = performance.now() + 700;
    } else if (act.t === 'down' && to) {
      to.dead = true; to.cur = 0; to.fallT = performance.now();
    }
  }

  function damage(u, loss) {
    if (!u || u.dead) return;
    u.cur = Math.max(0, u.cur - loss);
    if (u.cur <= 0) { u.dead = true; u.fallT = performance.now(); }
  }

  function fmt(n) { n = Math.round(n || 0); return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }
  function mkText(text, x, y, color) { return { text: text, x: x, y: y, t0: performance.now(), color: color }; }

  function play(data) {
    ensureOverlay();
    overlay.style.display = 'block';
    anim = data;
    finished = false;
    document.getElementById('slgBattleTitle').textContent =
      (data.a.name || '') + ' ⚔ ' + (data.d.name || '') + '　@ (' + data.x + ',' + data.y + ')';
    buildUnits(data);
    var total = buildCues(data);
    particles = [];
    t0 = performance.now();
    if (raf) cancelAnimationFrame(raf);
    var loop = function () {
      var now = performance.now();
      if (now - t0 >= total) { finished = true; }
      var ctxState = { roundBanner: null, skillBanner: null, resultBanner: null, finished: finished };
      for (var i = 0; i < cues.length; i++) {
        var c = cues[i];
        if (now - t0 >= c.t && !c.done) { c.done = true; c.fn(ctxState); }
      }
      draw(now, ctxState);
      if (now - t0 < total) raf = requestAnimationFrame(loop);
      else { draw(now, ctxState); raf = null; }
    };
    raf = requestAnimationFrame(loop);
  }

  function drawFigure(g, u, now) {
    var side = SIDE_COLOR[u.side] || '#999';
    var isGen = true;
    var x = u.x, y = u.y;
    var lunge = 0;
    if (u.lungeT > 0) {
      var dt = now - u.lungeT;
      if (dt < 620) {
        var p = dt / 620;
        lunge = Math.sin(p * Math.PI) * 46 * (u.side === 'a' ? 1 : -1);
      } else u.lungeT = -1;
    }
    var flash = u.flashT > 0 && now - u.flashT < 260;
    var dying = u.dead && u.fallT > 0;
    var fall = dying ? Math.min(1, (now - u.fallT) / 700) : 0;
    g.save();
    g.translate(x + lunge, y);
    if (fall > 0) { g.rotate(fall * Math.PI / 2 * (u.side === 'a' ? 1 : -1)); g.globalAlpha = 1 - fall * 0.85; }
    if (flash) { g.globalAlpha = 0.55; }
    // 主将：披风+盔缨的小像
    g.fillStyle = side;
    g.beginPath();
    g.moveTo(-12, 18); g.lineTo(0, -6); g.lineTo(12, 18); g.closePath(); g.fill();
    g.fillStyle = '#f0d9a8';
    g.beginPath(); g.arc(0, -14, 7, 0, 6.2832); g.fill();
    g.fillStyle = side;
    g.beginPath(); g.arc(0, -20, 4, 0, 6.2832); g.fill();
    g.strokeStyle = '#d8cfa8'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(10, 8); g.lineTo(26, -14); g.stroke();
    if (flash) { g.globalAlpha = 0.9; g.fillStyle = '#fff'; g.fillRect(-14, -26, 30, 48); }
    g.restore();
    // 随队小兵：兵力折算，最多 12 个
    var count = Math.min(12, Math.ceil((u.dead ? 0 : u.cur) / Math.max(1, u.troops / 10)));
    for (var i = 0; i < count; i++) {
      var sx = x + (u.side === 'a' ? -1 : 1) * (26 + (i % 4) * 12);
      var sy = y + 20 + Math.floor(i / 4) * 11;
      g.fillStyle = side; g.globalAlpha = 0.75;
      g.beginPath(); g.arc(sx, sy, 3.4, 0, 6.2832); g.fill();
      g.strokeStyle = '#d8cfa8'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(sx, sy - 3); g.lineTo(sx + (u.side === 'a' ? 5 : -5), sy - 12); g.stroke();
      g.globalAlpha = 1;
    }
    // 名字与兵力条
    if (!u.dead || fall < 1) {
      g.fillStyle = '#e8dcc0'; g.font = '12px "Microsoft YaHei",sans-serif'; g.textAlign = 'center';
      g.fillText(u.name, x, y - 34);
      var w = 74;
      g.fillStyle = '#22252b'; g.fillRect(x - w / 2, y + 34, w, 5);
      g.fillStyle = side; g.fillRect(x - w / 2, y + 34, w * Math.max(0, u.cur / Math.max(1, u.troops)), 5);
      g.fillStyle = '#c8b88a'; g.font = '11px "Microsoft YaHei",sans-serif';
      g.fillText(fmt(u.cur) + '/' + fmt(u.troops), x, y + 56);
      if (u.stateText && now - u.stateT < 2500) {
        g.fillStyle = '#b07ce8';
        g.fillText(u.stateText, x, y - 48);
      }
    }
  }

  function draw(now, ctxState) {
    if (!canvas || !anim) return;
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width; canvas.height = rect.height;
    var g = canvas.getContext('2d');
    g.fillStyle = '#101216'; g.fillRect(0, 0, rect.width, rect.height);
    g.strokeStyle = 'rgba(200,180,130,0.18)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, rect.height * 0.78); g.lineTo(rect.width, rect.height * 0.78); g.stroke();
    var slots = [0.34, 0.58, 0.82];
    for (var k in units) {
      var u = units[k];
      u.x = rect.width * (u.side === 'a' ? 0.26 : 0.74);
      u.y = rect.height * slots[u.slot % 3];
      drawFigure(g, u, now);
    }
    // 粒子文字
    particles = particles.filter(function (p) { return now - p.t0 < 1100; });
    particles.forEach(function (p) {
      var dt = (now - p.t0) / 1100;
      g.globalAlpha = 1 - dt;
      g.fillStyle = p.color;
      g.font = 'bold 15px "Microsoft YaHei",sans-serif';
      g.fillText(p.text, p.x, p.y - dt * 26);
      g.globalAlpha = 1;
    });
    if (ctxState.roundBanner) {
      g.fillStyle = 'rgba(20,18,12,0.75)';
      g.fillRect(rect.width / 2 - 90, 16, 180, 34);
      g.fillStyle = '#e8c670'; g.font = 'bold 17px "Microsoft YaHei",sans-serif'; g.textAlign = 'center';
      g.fillText(ctxState.roundBanner, rect.width / 2, 40);
    }
    if (ctxState.skillBanner && now < (ctxState.skillUntil || 0)) {
      g.fillStyle = 'rgba(30,24,10,0.85)';
      g.fillRect(rect.width / 2 - 170, rect.height * 0.16, 340, 44);
      g.strokeStyle = '#e8c670'; g.lineWidth = 1.5;
      g.strokeRect(rect.width / 2 - 170, rect.height * 0.16, 340, 44);
      g.fillStyle = '#ffe9b0'; g.font = 'bold 19px "Microsoft YaHei",sans-serif'; g.textAlign = 'center';
      g.fillText(ctxState.skillBanner, rect.width / 2, rect.height * 0.16 + 30);
    }
    if (ctxState.resultBanner) {
      g.fillStyle = 'rgba(16,14,8,0.7)'; g.fillRect(0, 0, rect.width, rect.height);
      g.fillStyle = ctxState.resultColor || '#e8c670';
      g.font = 'bold 52px "KaiTi","Microsoft YaHei",sans-serif'; g.textAlign = 'center';
      g.fillText(ctxState.resultBanner, rect.width / 2, rect.height / 2);
      g.font = '15px "Microsoft YaHei",sans-serif'; g.fillStyle = '#c8b88a';
      var sa = 0, sd = 0;
      for (var k in units) { if (units[k].side === 'a') sa += units[k].cur; else sd += units[k].cur; }
      g.fillText('我军余 ' + fmt(sa) + ' · 敌军余 ' + fmt(sd), rect.width / 2, rect.height / 2 + 34);
    }
  }

  window.__slgPlayBattle = function (data) {
    if (!data || !data.rounds) return;
    play(data);
  };
})();`;


/** 城池面板 v2：完整实现（样式/布局/六页/全局面板/HUD/抉择弹窗） */
const CITY_WINDOW_V2_IMPL = `;(function () {
  if (typeof document === 'undefined') return;
  var cache = null, tab = 'overview', currentCity = 0, neighbors = {};
  /* ★ 出征面板状态：出发城 / 目标城 / 队伍 / 比例 / 页签。玩家在面板里选一次就记住。 */
  var war = { from: 0, target: 0, armyId: 0, frac: 1, tab: 'go' };
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
    '#slgUIv2 .win{position:fixed;top:12px;right:244px;bottom:12px;width:520px;z-index:100000;'
    + 'background:linear-gradient(180deg,#1b1d16,#141610);border:1px solid #8a7038;border-radius:10px;'
    + 'color:#e2d6b8;font:13px/1.8 "Microsoft YaHei",sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.7);display:none;}',
    '#slgUIv2 .win-head{position:relative;padding:12px 16px 8px;border-bottom:1px solid #4a4030;background:rgba(60,48,24,.35);}',
    '#slgUIv2 .win-head b{font-size:17px;color:#f0d998;letter-spacing:2px;}',
    '#slgUIv2 .win-head .sub{opacity:.85;font-size:12px;margin-top:2px;}',
    '#slgUIv2 .badge{display:inline-block;padding:0 6px;border-radius:3px;font-size:11px;margin-left:6px;vertical-align:2px;}',
    '#slgUIv2 .badge.cap{background:#7a2a20;color:#ffd9c0;}',
    '#slgUIv2 .badge.home{background:#7a5822;color:#ffe9b0;}',
    '#slgUIv2 .x{position:absolute;top:10px;right:12px;cursor:pointer;color:#a89f86;font-size:16px;padding:2px 8px;}',
    '#slgUIv2 .tabs{display:flex;border-bottom:1px solid #4a4030;}',
    '#slgUIv2 .tabs button{flex:1;background:#20221c;border:none;border-right:1px solid #33302a;color:#a89f86;',
    'padding:7px 0;cursor:pointer;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgUIv2 .tabs button.on{background:#5c4318;color:#ffe9b0;font-weight:bold;}',
    '#slgUIv2 .body{position:absolute;top:98px;left:0;right:0;bottom:0;overflow-y:auto;padding:12px 16px;}',
    '#slgUIv2 .card{background:rgba(255,255,255,.04);border:1px solid #3a3428;border-radius:6px;padding:10px 12px;margin-bottom:10px;}',
    '#slgUIv2 .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;}',
    '#slgUIv2 .kv{display:flex;justify-content:space-between;border-bottom:1px dashed #33302a;padding:4px 0;}',
    '#slgUIv2 .kv span:last-child{color:#f0d998;}',
    '#slgUIv2 .res{display:flex;gap:10px;flex-wrap:wrap;}',
    '#slgUIv2 .res .r{background:rgba(255,255,255,.05);border:1px solid #3a3428;border-radius:6px;',
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
    '#slgUIv2 .toast{position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:100003;',
    'padding:8px 22px;border-radius:6px;font:13px "Microsoft YaHei",sans-serif;',
    'box-shadow:0 4px 16px rgba(0,0,0,.6);opacity:0;transition:opacity .25s;}',
    '#slgUIv2 .toast.ok{background:#2c3e28;color:#a9e2a0;border:1px solid #4a6a42;}',
    '#slgUIv2 .toast.bad{background:#41241f;color:#ffb3a7;border:1px solid #7a4038;}',
    '#slgUIv2 .modal{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.55);display:flex;',
    'align-items:center;justify-content:center;}',
    '#slgUIv2 .modal .box{width:430px;background:#1b1d16;border:1px solid #8a7038;border-radius:8px;padding:18px 20px;}',
    '#slgUIv2 .modal .box p{margin:0 0 14px;line-height:1.9;}',
    '#slgUIv2 .modal .bar{display:flex;justify-content:flex-end;gap:8px;}',
    '#slgUIv2 .seg{display:inline-flex;border:1px solid #4a4436;border-radius:4px;overflow:hidden;}',
    '#slgUIv2 .seg button{background:#20221c;color:#a89f86;border:none;padding:3px 12px;cursor:pointer;',
    'font:12px "Microsoft YaHei",sans-serif;border-right:1px solid #33302a;}',
    '#slgUIv2 .seg button.on{background:#5c4318;color:#ffe9b0;}',
    '#slgUIv2 input.n{width:80px;background:#101208;color:#f0d998;border:1px solid #4a4436;',
    'border-radius:4px;padding:3px 8px;font:13px "Microsoft YaHei",sans-serif;}',
    '#slgUIv2 .empty{opacity:.6;padding:20px 0;text-align:center;}',
    '#slgUIv2 h4{color:#c8b88a;font-size:12px;margin:10px 0 6px;letter-spacing:2px;}',
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

  function makeWindow(id, title, subHtml, tabs, active, onTab, onClose) {
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
      renderCity(s);
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
    var tabs = [
      ['go', '出击'],
      ['queue', '行军队列' + (queue.length ? '（' + queue.length + '）' : '')],
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
    else warLogPanel(s, body);
    /* ★ #18：面板每次重绘都把「选到一半的输入」落一次，切走再回来原样还在 */
    saveWar();
  }

  function warGoPanel(s, fromCity, idle, body) {
    var own = warOwnCities(s);
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
    idle.forEach(function (a) {
      var on = a.id === war.armyId;
      var row = el('div', 'row');
      row.style.cssText = 'cursor:pointer;padding:8px;border-radius:5px;'
        + (on ? 'background:rgba(240,217,152,.10);border:1px solid #8a7038;' : 'border:1px solid #33302a;');
      row.innerHTML = '<span><b style="color:' + (on ? '#ffe9b0' : '#e2d6b8') + '">队伍#' + a.order + '</b>'
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

    sum.appendChild(mkBtn('出征 ' + target.name, '', function () {
      warConfirmAttack(s, fromCity, army, target, route);
    }));
    body.appendChild(sum);
    body.appendChild(warPreviewCard(s, fromCity, army, target));
  }

  /* ★ 验收 #10 战前推演：服务端 previewAssault 走 structuredClone 沙盒 + 与正式结算同一套
     resolveBattle / defenseFor / battleSeedFor(…, arriveDay)，所以推演与真打逐位一致。
     这里允许多次点：每次重掷都是同一结果（同种子），点「改比例」再推演才变——可无限次回退重试，
     因为 preview 动作在 index.js 里被明确要求不 save()，绝不写存档。 */
  function warPreviewCard(s, fromCity, army, target) {
    var card = el('div', 'card', '<h4 style="margin-top:0">战前推演</h4>');
    card.appendChild(el('div', 'cost',
      '沙盒推演：与正式结算同一战斗内核、同一战斗种子，不耗粮、不动兵、不写存档；换出兵比例后可反复推演。'));
    var out = el('div', '');
    card.appendChild(out);
    var btn = mkBtn('推演一次', 'ghost', function () {
      btn.disabled = true; btn.textContent = '推演中…';
      out.innerHTML = '<div class="cost">按现行比例于沙盒内演算一次…</div>';
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
    card.appendChild(btn);
    return card;
  }

  function warSum3(a) {
    return (a || []).reduce(function (n, v) { return n + Math.max(0, Number(v) || 0); }, 0);
  }

  function warPreviewHtml(r) {
    var tone = r.win ? '#a9e2a0' : (r.draw ? '#e0c56a' : '#ff6b5e');
    var tag = r.win ? '预计可下' : (r.draw ? '预计相持' : '预计难下');
    var seedHex = (Number(r.seed) >>> 0).toString(16).toUpperCase();
    return [
      kv('判定', '<span style="color:' + tone + '">' + tag + '</span>　战报码 ' + r.code
        + '　' + r.rounds + ' 回合'),
      kv('投入兵力', '我军 ' + fmt(r.aTotal) + ' / 守军 ' + fmt(r.dTotal)),
      kv('预计折损', '我军 −' + fmt(r.aLoss) + ' / 守军 −' + fmt(r.dLoss)),
      kv('战后残余', '我军 ' + fmt(warSum3(r.remain)) + ' / 守军 ' + fmt(warSum3(r.dRemain))),
      kv('抵达', '第 ' + r.arriveDay + ' 日（程 ' + fmt(r.km) + ' 里 · ' + r.days + ' 日行）'),
      kv('兵种关系', esc(r.counterNote)),
      kv('战斗种子', '0x' + seedHex + '（同种子必得同战报）'),
      '<div style="margin-top:8px;color:#e8d9a8">归因：' + esc(r.attribution) + '</div>',
      '<div class="cost" style="margin-top:4px;opacity:.75">' + esc(r.caveat) + '</div>',
    ].join('');
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
      '<span class="cost">到达日自动开战；战败折损、溃兵归营。出征后可在「行军队列」页撤回。</span>',
    ], '出征', '取消', function () {
      postJSON('/__slg/strategy/action', {
        action: 'attack', cityId: target.id, armyId: army.id,
        frac: war.frac, fromCityId: fromCity.id,
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
    fetchState().then(function (s) {
      cache = s; buildNeighbors(s);
      currentCity = s.playerCity;
      tab = 'overview';
      renderCity(s);
    }).catch(function () {});
  };

  function renderCity(s) {
    var c = cityOf(s, currentCity);
    if (!c) { window.__slgCityClose(); return; }
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
      function (t) { tab = t; renderCity(s); },
      window.__slgCityClose);
    body.innerHTML = '';
    if (tab === 'overview') tabOverview(s, c, body, isHome);
    else if (tab === 'home') tabInteriorView(c, body);
    else if (tab === 'base') tabHome(body, c);
    else if (tab === 'army') tabArmy(body, c);
    else if (tab === 'gens') { if (isHome) renderGensInto(body); else tabGeneralView(c, body); }
    else if (tab === 'tavern') { if (isHome) renderTavernInto(body); else tabTavernView(c, body); }
    else if (tab === 'reports') renderReportsInto(body, c);
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
                fetchState().then(function (s2) { cache = s2; renderCity(s2); });
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
                fetchState().then(function (s2) { cache = s2; renderCity(s2); });
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
                fetchState().then(function (s2) { cache = s2; renderCity(s2); });
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
      body.appendChild(el('div', 'cost',
        '民心的作用：影响人口增长（+2%~6%/月）与粮金产量（×0.85~1.10）。'
        + '治安越高灾害越少。开发度到 100 以上收益递减，别把一座城堆到顶。'));

      /* ★ 修 bug-6：分城也有自己的一套设施（举义时逐城建立），在此可查看与升级 */
      var facCard = el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 设施</h4>'
        + '<div class="empty">读取中…</div>');
      body.appendChild(facCard);
      send('city.facilities', { cityId: clientCityId(), realCityId: c.id }, true).then(function (rsp) {
        var list2 = (rsp.msg && rsp.msg.facilities) || [];
        facCard.innerHTML = '<h4 style="margin-top:0">' + c.name + ' · 设施</h4>';
        if (!list2.length) { facCard.appendChild(el('div', 'empty', '本城暂无设施数据。')); return; }
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
                fetchState().then(function (s2) { cache = s2; renderCity(s2); });
              });
            }));
          }
          facCard.appendChild(row);
        });
      }).catch(function () {
        facCard.innerHTML = '<h4 style="margin-top:0">' + c.name + ' · 设施</h4>'
          + '<div class="cost">设施读取失败，稍后再试。</div>';
      });
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
                renderCity(cache);
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

  function tabHome(body, c) {
    /* ★ P7：兵营/设施属于「本地主城」（原客户端 cityId），不是战略城的 id；
       两者是两套编号。队伍归属才用战略城 id（tabArmy 的 cid）。 */
    var cid = (c && c.id) || (cache && cache.playerCity) || 1;
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

        var facCard = el('div', 'card', '<h4 style="margin-top:0">设施</h4>');
        (rs[0].msg && rs[0].msg.facilities || []).forEach(function (f) {
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
                tabHome(body, c);
              });
            }));
          }
          facCard.appendChild(row);
        });
        body.appendChild(facCard);

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

        body.appendChild(el('div', 'card',
          '<b style="color:#f0d998">' + esc((c && c.name) || '本城') + ' · 编队与征兵</b>　'
          + '<span class="winTag">人口 ' + fmt((c && c.pop) || 0) + ' · '
          + (c && c.owner === 'player' ? '驻城兵 ' + fmt(c.troopSum || 0) + ' · 城防 ' : '守军 ')
          + fmt((c && c.troops) || 0) + '</span>'
          + '<div class="cost" style="margin-top:4px">一支队伍最多三将，'
          + '<b style="color:#f0d998">一将只能带一槽</b>：先配将，再征兵。'
          + '每兵吃 1 人口，由名下各城分摊；人口不足则征不满。'
          + (c && c.id !== (cache && cache.playerCity) ? '分城照样能征兵、能从这里出征。' : '') + '</div>'));
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
            + fmt((r.analysis.dRemain || []).reduce(function (a, b) { return a + Number(b || 0); }, 0))
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

  /** 战报详情（DOM）：胜负、双方兵力、逐回合动作与战法名，全部来自同一份确定性事件流。 */
  function openReportDetail(r) {
    var tag = r.result === 2 ? ['胜', '#6fcf97'] : (r.result === 0 ? ['败', '#ff6b5e'] : ['平', '#c8b88a']);
    var anim = r.anim || { a: { units: [] }, d: { units: [] }, rounds: [] };
    var body = makeWindow('slgRepDetail',
      '战报 #' + r.id + ' · <span style="color:' + tag[1] + '">' + tag[0] + '</span>',
      '<div class="sub">' + (anim.place || ('(' + r.x + ',' + r.y + ')'))
      + (r.ctime ? ' · ' + new Date(r.ctime).toLocaleString('zh-CN') : '') + '</div>',
      null, null, null,
      function () { var w = document.getElementById('slgRepDetail'); if (w) w.remove(); });
    var sum = el('div', 'card');
    sum.innerHTML = '<h4 style="margin-top:0">战果</h4><div>' + (r.summary || '（无摘要）') + '</div>'
      + (r.analysis ? ('<div class="cost">我军 ' + r.analysis.aTotal + ' → ' + r.analysis.aRemain.reduce(function (a, b) { return a + b; }, 0)
        + '　守军 ' + r.analysis.dTotal + '</div>') : '');
    body.appendChild(sum);

    [['我军', anim.a, '#c0392b'], ['守军', anim.d, '#2c5f8a']].forEach(function (side) {
      var card = el('div', 'card');
      card.innerHTML = '<h4 style="margin-top:0">' + side[0] + '：' + (side[1].name || '') + '</h4>';
      (side[1].units || []).forEach(function (u) {
        card.appendChild(el('div', 'kv', '<span>' + (u.name || '武将') + '</span><span>'
          + u.troops + ' → ' + u.remain + '</span>'));
      });
      body.appendChild(card);
    });

    // ★ P3：技能发动统计——回答「我的战法到底发挥了几成」
    var skillStat = {};
    (anim.rounds || []).forEach(function (rd) {
      (rd.acts || []).forEach(function (act) {
        if (act.t === 'skill' && act.skill) {
          var row = skillStat[act.skill] || (skillStat[act.skill] = { count: 0, loss: 0 });
          row.count += 1;
          row.loss += act.loss || 0;
        }
      });
    });
    var skeys = Object.keys(skillStat);
    if (skeys.length) {
      var totalLoss = skeys.reduce(function (a, k) { return a + skillStat[k].loss; }, 0) || 1;
      var statCard = el('div', 'card');
      statCard.innerHTML = '<h4 style="margin-top:0">技能发动统计</h4>'
        + '<div class="muted">按确定性事件流汇总；伤害占比 = 该技能歼敌 / 双方技能总歼敌。</div>'
        + skeys.map(function (k) {
          var st0 = skillStat[k];
          var pct = Math.round(st0.loss / totalLoss * 100);
          return '<div class="kv"><span>「' + esc(k) + '」</span><span>发动 ' + st0.count
            + ' 次 · 伤害占比 ' + pct + '%</span></div>';
        }).join('');
      body.appendChild(statCard);
    }

    (anim.rounds || []).slice(0, 12).forEach(function (rd) {
      var card = el('div', 'card', '<h4 style="margin-top:0">第 ' + rd.round + ' 回合</h4>');
      (rd.acts || []).forEach(function (act) {
        var who = function (u) {
          var list = u.s === 'a' ? (anim.a.units || []) : (anim.d.units || []);
          var hit = list[u.i];
          return hit ? hit.name : (u.s === 'a' ? '我军' : '守军');
        };
        var text = '';
        if (act.t === 'skill') text = who(act.f) + ' 发动「' + act.skill + '」' + (act.loss ? '（歼 ' + act.loss + '）' : '');
        else if (act.t === 'prepare') text = who(act.f) + ' 准备「' + act.skill + '」';
        else if (act.t === 'hit') text = who(act.f) + ' → ' + who(act.to) + '　' + act.skill + ' 损 ' + act.loss;
        else if (act.t === 'control') text = who(act.f) + ' 使 ' + who(act.to) + ' 陷入「' + act.state + '」';
        else if (act.t === 'heal') text = who(act.f) + ' 回复 ' + Math.round(act.amount || 0);
        else if (act.t === 'down') text = who(act.unit) + ' 溃败';
        if (text) card.appendChild(el('div', 'cost', text));
      });
      body.appendChild(card);
    });
    body.appendChild(mkBtn('关闭', 'ghost', function () {
      var w = document.getElementById('slgRepDetail'); if (w) w.remove();
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
