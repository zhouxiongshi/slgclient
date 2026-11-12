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
      `          EventMgr.on(LogicEvent.openGeneralRoster, this.onOpenGeneralRoster, this);
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
      if (lastState) draw(lastState);
    };
    document.getElementById('slgBtnZoomIn').onclick = function () { if (window.__slgZoom) window.__slgZoom(1); };
    document.getElementById('slgBtnZoomOut').onclick = function () { if (window.__slgZoom) window.__slgZoom(-1); };
    document.getElementById('slgBtnHome').onclick = function () {
      if (window.__slgHomeWindow && lastState) window.__slgHomeWindow();
    };
    document.getElementById('slgBtnGens').onclick = function () {
      if (window.__slgGeneralsWindow) window.__slgGeneralsWindow();
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
    if (ov.style.display === 'none') {
      ov.style.display = 'block';
      refresh();
      if (!timer) timer = setInterval(refresh, 5000);
    } else refresh();
  }

  window.__slgStrategyShow = showMap;
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

  function refresh() {
    fetch('/__slg/strategy/state').then(function (r) { return r.json(); }).then(function (s) {
      lastState = s; draw(s);
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
    hint.innerHTML = '滚轮缩放 · 拖动平移 · 点城看介绍 · 点关隘看扼守';
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
      + kvRow('驻军', String(c.troops || 0))
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
    if (LAYER.name) {
      s.cities.forEach(function (c) {
        var info = cityInfo(c) || {};
        var lf = c.level >= 3 ? 23 : (c.level === 2 ? 19 : 15);
        var on = !!(picked && picked.id === c.id);
        inkText(c.name, c.x, c.y + (info.h || 40) / 2 + 2, {
          size: lf, align: 'center', baseline: 'top', bold: on,
          fill: on ? '#c0392b' : (c.level >= 3 ? '#922c20' : (c.level === 2 ? '#704e26' : '#3a4c3a')),
          stroke: on ? '#fff4dc' : '#f7efdb',
          strokeWidth: on ? 4 : 3
        });
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
  var cache = null, tab = 'overview', currentCity = 0, neighbors = {}, attackMode = 'all';
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
  function buildNeighbors(s) {
    neighbors = {};
    s.routes.forEach(function (r) {
      (neighbors[r.from] = neighbors[r.from] || []).push(r.to);
      (neighbors[r.to] = neighbors[r.to] || []).push(r.from);
    });
  }

  window.__slgCityWindow = function (cityId) {
    currentCity = Number(cityId);
    tab = 'overview';
    fetchState().then(function (s) {
      cache = s; buildNeighbors(s);
      renderCity(s);
    }).catch(function () {});
  };
  window.__slgCityClose = function () {
    var w = document.getElementById('slgCityWin');
    if (w) w.remove();
  };
  window.__slgHomeWindow = function () {
    fetchState().then(function (s) {
      cache = s; buildNeighbors(s);
      currentCity = s.playerCity;
      tab = 'home';
      renderCity(s);
    }).catch(function () {});
  };

  function renderCity(s) {
    var c = cityOf(s, currentCity);
    if (!c) { window.__slgCityClose(); return; }
    var isHome = s.playerCity === c.id;
    var title = c.name + (c.level === 3 ? '<span class="badge cap">州治</span>' : '')
      + (isHome ? '<span class="badge home">本城</span>' : '');
    var body = makeWindow('slgCityWin', title,
      '<div class="sub">' + c.province + ' · <span style="color:' + c.color + '">' + c.ownerName
      + '</span> · 驻军 ' + fmt(c.troops) + '</div>',
      [['overview', '概览'], ['home', '内政'], ['army', '征兵'], ['gens', '武将'], ['tavern', '酒馆'], ['reports', '战报']],
      tab,
      function (t) { tab = t; renderCity(s); },
      window.__slgCityClose);
    body.innerHTML = '';
    if (tab === 'overview') tabOverview(s, c, body, isHome);
    else if (tab === 'home') { if (isHome) tabHome(body); else tabInteriorView(c, body); }
    else if (tab === 'army') { if (isHome) tabArmy(body); else tabConscriptView(c, body); }
    else if (tab === 'gens') { if (isHome) renderGensInto(body); else tabGeneralView(c, body); }
    else if (tab === 'tavern') { if (isHome) renderTavernInto(body); else tabTavernView(c, body); }
    else if (tab === 'reports') renderReportsInto(body, c);
  }

  function tabInteriorView(c, body) {
    body.appendChild(el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 内政</h4><div class="grid">'
      + kv('归属', c.ownerName)
      + kv('行政', c.adminLevel || c.levelName || ('Lv' + c.level))
      + kv('人口', fmt(c.population))
      + kv('农业', c.agri) + kv('商业', c.commerce)
      + kv('城防', c.cityDef) + kv('特产', c.specialty || '—')
      + kv('地形', c.terrain || '—')
      + '</div><div class="cost" style="margin-top:8px">设施升级与征收在本城办理。此城入版图后，内政并入本城府库。</div>'));
  }

  function tabConscriptView(c, body) {
    body.appendChild(el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 征兵</h4><div class="grid">'
      + kv('驻军', fmt(c.troops))
      + kv('主要兵种', c.arms || '—')
      + kv('城防', c.cityDef)
      + '</div><div class="cost" style="margin-top:8px">此城现属 ' + c.ownerName
      + '。我军征兵在本城军营办理，攻下此城后驻军并入版图。</div>'));
  }

  function tabGeneralView(c, body) {
    body.appendChild(el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 武将</h4>'
      + '<div class="grid">' + kv('守军', fmt(c.troops)) + kv('兵种', c.arms || '—') + '</div>'
      + '<div class="cost" style="margin-top:8px">敌将名册尚未探明。帐下武将在本城「武将」页编组。</div>'));
  }

  function tabTavernView(c, body) {
    body.appendChild(el('div', 'card', '<h4 style="margin-top:0">' + c.name + ' · 酒馆</h4>'
      + '<div class="cost">' + c.name + ' 的酒馆未对你开放。招募在本城酒馆，按辰光来访。</div>'));
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

    var adjCard = el('div', 'card', '<h4 style="margin-top:0">相邻城池</h4>');
    var list = neighbors[c.id] || [];
    if (!list.length) adjCard.appendChild(el('div', 'empty', '此地孤悬。'));
    list.forEach(function (id) {
      var n = cityOf(s, id);
      if (!n) return;
      var row = el('div', 'row');
      row.innerHTML = '<span><span class="dot" style="background:' + n.color + '"></span>'
        + n.name + ' <span class="winTag">（' + n.province + '·' + n.ownerName + '·驻' + fmt(n.troops) + '）</span></span>';
      var open = mkBtn('前往', 'ghost', function () { window.__slgCityWindow(n.id); });
      open.style.padding = '1px 10px';
      row.appendChild(open);
      adjCard.appendChild(row);
    });
    body.appendChild(adjCard);

    var canAttack = !isHome && ((s.marchable || []).indexOf(c.id) >= 0
      || (neighbors[s.playerCity] || []).indexOf(c.id) >= 0);
    // 行军校验：路网里没有直连行军段，或关隘封锁，都不能出征
    var marchOk = (s.marchable || []).indexOf(c.id) >= 0;
    if (!isHome && !marchOk && (neighbors[s.playerCity] || []).indexOf(c.id) >= 0) {
      var gate = ((s.gates || []).find(function (g) { return g.status === '封锁'; }) || {}).name;
      body.appendChild(el('div', 'card',
        '<h4 style="margin-top:0">行军受阻</h4><div class="cost">'
        + '此地与本城之间没有可通行军段'
        + (gate ? ('，<b style="color:#ff6b5e">' + gate + '</b> 已封锁') : '')
        + '。关隘是必经节点，须先解封或改走别路。</div>'));
    }
    if (canAttack && !marchOk) canAttack = false;
    if (canAttack) {
      var mine = (s.armies || []).reduce(function (sum, a) {
        return sum + (a.soldiers || []).reduce(function (x, y) { return x + (Number(y) || 0); }, 0);
      }, 0);
      var ratio = attackMode === 'all' ? 1 : (attackMode === 'half' ? 0.5 : 0.34);
      var deploy = Math.round(mine * ratio);
      var box = el('div', 'card', '<h4 style="margin-top:0">出征</h4>');
      box.appendChild(el('div', '', '出兵规模：'));
      var seg = el('div', 'seg');
      [['all', '全军'], ['half', '半军'], ['third', '三成']].forEach(function (m) {
        var b = document.createElement('button');
        b.textContent = m[1];
        if (attackMode === m[0]) b.className = 'on';
        b.onclick = function () {
          attackMode = m[0];
          Array.prototype.forEach.call(seg.children, function (x) { x.className = ''; });
          b.className = 'on';
          if (cache) renderCity(cache);
        };
        seg.appendChild(b);
      });
      box.appendChild(seg);
      // ★ P0-3：给出双方兵力与胜算提示，别让玩家拿 800 去打 1800
      var enough = deploy >= c.troops * 1.25;
      box.appendChild(el('div', 'cost',
        '我军可出 ' + fmt(deploy) + ' · 敌军驻军约 ' + fmt(c.troops) + '　'
        + (enough ? '<span style="color:#a9e2a0">兵力占优</span>'
          : '<span style="color:#ff6b5e">兵力偏少，建议先打小城或增兵</span>')
        + (ratio < 1 ? '　（按比例出击，其余留守）' : '')));
      box.appendChild(mkBtn('出兵攻打 ' + c.name, '', function () {
        confirmBox('出兵确认', [
          '目标：<b>' + c.name + '</b>（' + c.ownerName + '·驻军约 ' + fmt(c.troops) + '）',
          '规模：' + (attackMode === 'all' ? '全军' : attackMode === 'half' ? '半军' : '三成')
            + '，约 ' + fmt(deploy) + ' 人',
          '<span class="cost">战败会损兵，并留下溃兵归营；战胜城池入版图。</span>',
        ], '出征', '取消', function () {
          send('strategy.attack', {
            cityId: c.id,
            frac: ratio,
          }).then(function (rsp) {
            if (rsp.msg && rsp.msg.ok) {
              toast(rsp.msg.summary || '出兵！战况已展开。', rsp.msg.result === 2);
              window.__slgCityClose();
            } else {
              var rs = (rsp.msg && rsp.msg.reason) || '';
              toast('出兵失败：' + (rs === 'no_troops' ? '没有可出战的兵' : rs === 'no_general' ? '该队还没有武将'
                : rs === 'no_army' ? '没有队伍' : errText(rsp)), false);
            }
            fetchState().then(function (s2) { cache = s2; buildNeighbors(s2); });
          });
        });
      }));
      body.appendChild(box);
    }
  }

  function tabHome(body) {
    body.innerHTML = '<div class="empty">读取中…</div>';
    Promise.all([send('city.facilities', { cityId: 1 }), send('role.myRoleRes', {}), loadMeta()])
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
          send('interior.collect', {}).then(function (rsp) {
            if (rsp.code === 0) toast('征得 ' + fmt(rsp.msg.gold) + ' 金', true);
            else toast('征收失败：' + errText(rsp), false);
            tabHome(body);
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
              send('city.upFacility', { cityId: 1, fType: f.type }).then(function (rsp) {
                if (rsp.code === 0) toast(f.name + ' 开始升级', true);
                else toast('升级失败：' + errText(rsp), false);
                tabHome(body);
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
                  tabHome(body);
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
  function tabArmy(body) {
    body.innerHTML = '<div class="empty">读取中…</div>';
    Promise.all([send('army.myList', { cityId: 1 }), loadMeta(), send('role.myRoleRes', {}),
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
          '一支队伍最多三将。<b style="color:#f0d998">一将只能带一槽</b>：先配将，再征兵。'
          + '多一支部队上阵，就多一份输出——1 将打 3 将必败。'));
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
                cityId: 1, order: order, position: pos, generalId: Number(sel.value) || 0,
              }).then(function (rsp) {
                if (rsp.code === 0) toast('第 ' + order + ' 军 · ' + ['一', '二', '三'][pos] + ' 位已更新', true);
                else toast('编队失败：' + errText(rsp), false);
                tabArmy(body);
              });
            };
            left.appendChild(sel);
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
                    setTimeout(function () { tabArmy(body); }, (eta + 1) * 1000);
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
          + '<span>★' + (g.star || 0) + ' · Lv' + g.level + '</span></div>'
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
        row.innerHTML = '<span>#' + r.id + ' <b>' + place + '</b></span>'
          + '<span style="display:flex;align-items:center;gap:4px">'
          + '<b style="color:' + tag[1] + '">' + tag[0] + '</b></span>';
        var bar = el('div', '');
        if (r.anim) bar.appendChild(mkBtn('回放', 'ghost', function () {
          if (window.__slgPlayBattle) window.__slgPlayBattle(r.anim);
        }));
        // ★ P0-2：详情必须能在被遮住的 Cocos 面板之外打开，否则玩家永远看不到「为什么输」
        bar.appendChild(mkBtn('详情', 'ghost', function () { openReportDetail(r); }));
        row.appendChild(bar);
        hostEl.appendChild(row);
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
