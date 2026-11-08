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
  ];
  let out = source;
  for (const [from, to] of pieces) {
    if (!out.includes(from)) throw new Error(`客户端补丁对不上：${from.slice(0, 40)}`);
    out = out.replace(from, to);
  }
  return out;
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
