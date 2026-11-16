# 《穿越·汉末》软件需求规格说明书（SRS / PRD）

> **文档性质**：需求基线。回答「这个产品要做什么、做到什么程度、怎么算做完了」，不规定代码怎么放、函数怎么写。
> **版本**：v1.0 · 2026-11-15
> **代码基线**：`offline-standalone` @ `3e4ccbd`（2026-11-15，`feat(M4-13)`），核查时 `git status` 干净、`tools/check-release.js` 92/92 全绿。
> **适用工程**：`slgclient/offline/`（离线单机分支），不含 `main` 分支的 2024 原版联网客户端。
> **配套文档**：`docs/SDD-软件详细设计说明书.md`（代码怎么实现）、`docs/GDD-顶配详细设计.md`（玩法数值权威）、`docs/ARCHITECTURE.md`（分层与依赖禁令）、`docs/FIELD-CONTRACT.md`（玩家可见数值的单一权威源）。
> **证据分级**：`【现状】` 已从代码/配置实测；`【设计】` 来自 GDD 等规格文档但尚未完全落地；`【待决】` 需产品拍板；`【不采纳】` 明确不做。
> **状态标记**：✅ 已实现 ｜ 🟡 部分实现 ｜ 📐 规划中 ｜ ⛔ 不做。每条需求都带状态，**没有状态的需求不许进开发排期**。

---

## 0. 文档控制

### 0.1 这几份文档怎么裁决

| 顺序 | 文档 | 管什么 | 不管什么 |
|---|---|---|---|
| 1 | 本文 | **要不要做、做多大、怎么验收**（需求与验收标准） | 代码结构、函数签名 |
| 2 | `docs/GDD-顶配详细设计.md` | 玩法系统怎么运作、数值怎么定 | 需求优先级、发布范围 |
| 3 | `docs/ARCHITECTURE.md` | 代码放哪、谁可以调用谁 | 玩法数值、需求范围 |
| 4 | `docs/SDD-软件详细设计说明书.md` | 当前代码实际怎么实现（接口/数据/算法/错误码） | 重新定义玩法目标 |
| 5 | `docs/FIELD-CONTRACT.md` | 玩家可见数值的权威登记 | 系统规则 |
| 6 | `slgclient-三国SLG交互原型设计提示词.md`（仓库外） | 界面组件行为规格 | 系统数值 |

**冲突规则**：需求范围听本文；玩法数值听 GDD；代码结构听 ARCHITECTURE；「代码现在到底怎么跑」听 SDD；玩家看到的数字以 FIELD-CONTRACT 登记的权威源为准。四者不一致时，**先在 SDD §17「偏差登记」记录，再决定改哪一边**，不许静默改代码。

### 0.2 需求编号与状态

| 前缀 | 含义 | 编号示例 |
|---|---|---|
| `UC-xx` | 用例（玩家/GM/QA 的目标） | `UC-07` 出征并确认开战 |
| `FR-xx` | 功能需求（产品必须提供的能力） | `FR-10` 征兵 |
| `R-xx.y` | 单条业务规则（可测试的最小陈述） | `R-10.3` 每旬配额上限 |
| `AC-xx.y` | 验收标准（可勾选、可自动化） | `AC-10.2` 冷却期内征兵被拒 |
| `NFR-xx` | 非功能需求 | `NFR-01` 确定性 |
| `DR-xx` | 数据/内容需求 | `DR-03` 六剧本 |
| `IF-xx` | 外部接口需求 | `IF-02` WS 帧 |
| `CN-xx` | 约束 | `CN-01` `web/` 逐字节不可改 |
| `OP-xx` | 未决问题 | `OP-01` 金币通胀 |

**状态定义**：

| 状态 | 判据 |
|---|---|
| ✅ 已实现 | 代码存在、有测试锁、发布闸覆盖；可在当前构建中操作到 |
| 🟡 部分实现 | 主链路可用但存在已登记的缺口（字段、UI、阈值、文案） |
| 📐 规划中 | GDD 有完整设计，代码未落地或未接线 |
| ⛔ 不做 | 明确排除，写清理由，防止后人重新提案 |

### 0.3 变更流程

1. 新增/修改需求：先改本文（编号不复用、不重排）→ 同步 GDD 或 SDD 的对应章节 → 再排期实现。
2. 改玩家可见数值：**先改 `FIELD-CONTRACT.md`**，再改服务端权威源，最后接 UI；顺序反了视为回归。
3. 改玩法数值：先改 GDD，再改 `conf/`，跑 `npm test` 与 `tools/check-release.js`。
4. 本文入仓必须提交：`check-release` 第 2 组含「`git status` 干净」，只放文件不提交会让发行检查变红。

### 0.4 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-11-15 | 首版。以 `3e4ccbd` 为基线建立 32 组功能需求、24 条非功能需求、用例集、验收矩阵与全链路追溯；登记 GDD 历史数字漂移与 5 项未决问题。 |

---

## 1. 产品定位与范围

### 1.1 一句话定义

**一款完全离线、单机买断、不联网不抽卡的三国 SLG**：玩家扮演穿越者，在东汉末年的州郡路网上经营城池、募兵征粮、结交武将、推演战局、逐鹿天下；游戏对每一个数字给出可查的解释，且关键结果可复现、可回放。

### 1.2 背景与要解决的问题

原工程是 2024 年的 Cocos Creator 3.4 联网客户端（`web-desktop` 构建产物）。本分支要把它改造成**无需服务端集群、无需 MySQL、无需外网**的离线单机版，同时保留原版画面与协议资产，不允许重做渲染层。由此产生三条硬约束（详见 §9）：画面磁盘产物逐字节不改、所有新 UI 走运行时注入、协议字段名逐字兼容 Go proto。

产品要解决的玩家痛点（来自实机反馈，逐条对应需求）：

| 痛点 | 对应需求 |
|---|---|
| 游戏窗口永远压在最上层、无法最小化/切到其他应用 | FR-25、NFR-18 |
| 找不到设置界面、找不到武将修改页 | FR-26、FR-27 |
| 左上角内政设施的列表和点城池看到的设施对不上，有些设施升了没用 | FR-06 |
| 武将属性上万、互相碾压，平衡崩坏 | FR-11 |
| 主角技能效果与玩家指定不符 | FR-12 |
| 弹窗反复复活、必答卡死 | FR-25 |
| 数值「点完才知道」，战报看不懂为什么输 | FR-16、FR-24 |

### 1.3 目标用户与场景

| 角色 | 描述 | 主要目标 | 用例前缀 |
|---|---|---|---|
| 玩家（主） | PC 键鼠、单台 Windows 机器、可离线长时间游玩 | 通过一个剧本统一天下 / 体验不同开局 | `UC-01`~`UC-20` |
| 作者 / GM（次） | 调参、验数、复现问题 | 不碰原表即可改数值、看全量状态、导档 | `UC-21`~`UC-25` |
| QA / 发布（次） | 提交前验收 | 双态回归、发布闸全绿、可追溯 | `UC-26`~`UC-30` |

**不做**：移动端、手柄、多人联网、账号系统实义、云存档、内购/抽卡、赛季制、PvP 匹配、Mod 商店。

### 1.4 设计支柱（需求的裁决依据）

| 支柱 | 含义 | 冲突时的优先级 |
|---|---|---|
| P1 可解释 | 每个数字有唯一权威源，界面只显示不计算；描述 = 计算 = 战报同源 | 高于表现 |
| P2 可复现 | 同一种子、同一输入必得同一结果；禁用 `Math.random()` | 高于便利 |
| P3 可逆分层 | 战术层无限回退、战略层本旬 5 步、世界层不可逆 | 高于自由度 |
| P4 无坑 | 代价性操作必须先给预览；断粮/灾害/叛逃提前预警 | 高于节奏紧凑 |
| P5 原画面保全 | 不改 `web/` 磁盘，一切扩展走注入 | 高于 UI 整洁度 |

### 1.5 范围边界

| 纳入 | 不纳入 |
|---|---|
| 原版协议全部 73 个消息名的兼容实现 | 真实账号校验、密码找回的实义 |
| 72 城 / 117 路战略沙盘、6 剧本、8 势力 AI | 六边形格地图、18 棋子棋盘 |
| 505 位武将 / 177 条战法 / 150 事件 / 24 宿命组 | 全量 796 条官网战法名录的实装 |
| 三档存档 + 导入导出 + GM 覆盖层 + 武将编辑器 | 联网同步、跨设备云档 |
| 确定性战斗内核 + 黄金向量 + 指纹 | 服务端战斗、战报云校验 |
| Windows portable Electron 包 | macOS / Linux / Steamworks SDK 集成（列为待用户处理） |

### 1.6 成功指标（可量化）

| 指标 | 目标 | 取证 |
|---|---|---|
| 发布闸 | `check-release` 92/92 全绿且工作区干净 | `reports/release-check.json` |
| 单元测试 | 73 个 `*.test.js` 全绿 | `npm test` |
| 双态冒烟 | 源码态 + 打包态各 33/33 | `tools/smoke.js` / `--packaged` |
| 画面保全 | `byteIdentical=true`，1582 文件 / 指纹 `ee987ec2…50485` | `reports/pack.json` |
| 真实点击 | 出征 8 环 E2E 零未捕获异常 | `check-release` 7.11 |
| 确定性 | 175 条黄金向量逐条一致、10000 场压测通过 | `check-release` 第 3 组 |
| 合规 | 554 条 `source+confidence` 无缺口、地图声明齐备 | `reports/data-provenance.json` |

---

## 2. 运行与交付形态需求（FR-01 组的上下文）

### 2.1 交付物

| 交付物 | 内容 |
|---|---|
| 可执行程序 | `build/SLG-Offline-win32-x64/SLG-Offline.exe`（portable，免安装） |
| 源码态 | `node server/index.js` + `node electron/main.cjs` |
| 数据 | `conf/`（76 份 JSON + 18 张图层）、`web/`（1582 个原版文件） |
| 文档 | `offline/docs/` 全部规格、设计、变更与合规文档 |
| 工具 | `tools/` 33 个构建/审计/打包脚本、`tests/` 73 个测试文件 |

### 2.2 运行时拓扑（需求视角）

玩家启动一个进程，进程内同时提供：

- **HTTP 服务** `127.0.0.1:8088`：原版静态资源、注入脚本、只读状态端点、动作端点、GM 页面；
- **WS 服务** `127.0.0.1:8004`：兼容原客户端的 `{seq,name,msg}` 协议；
- **Electron 窗口**：加载 `http://127.0.0.1:8088/`，可最小化、可缩放、默认不置顶；
- **本地存档**：`offline/saves/save.json` + `save.slot2.json` / `save.slot3.json`。

**R-2.1** 全流程不得发起任何外网请求；**R-2.2** 两个端口只监听回环地址；**R-2.3** 不依赖 Go 服务端、MySQL 或任何常驻后台服务。

### 2.3 三层时间尺度（贯穿全部需求）

| 层 | 尺度 | 可逆性 | 需求含义 |
|---|---|---|---|
| 战术层 | 单场战斗 | 无限回退（只读沙盒） | 推演不写世界状态 |
| 战略层 | 1 旬 = 10 游戏日 | 本旬内撤销最近 5 步，跨旬清空 | 撤销不得穿越旬界 |
| 世界层 | 全局（归属/城址/死亡） | 不可逆 | 只能靠后续玩法改变 |

**R-2.4** 任何一个「撤销」入口必须能回答「撤的是哪一层」；答不出即视为设计缺漏（GDD §0.4）。

---

## 3. 参与者与用例集

### 3.1 玩家用例（UC-01 ~ UC-20）

| 编号 | 用例 | 主成功路径 | 关联 FR |
|---|---|---|---|
| `UC-01` | 冷启动进入游戏 | 启动 → 登录门禁 → 进入服务器 → 沙盘可点 | FR-01 / FR-02 |
| `UC-02` | 开局举义 | 选诸侯 → 选起兵城 → 序章播报 → 拿到主城与主角 | FR-17 / FR-20 |
| `UC-03` | 查看家底 | 顶栏/六府看金粮木铁石、政令、逐城粮 | FR-07 / FR-23 |
| `UC-04` | 升级设施 | 城池内页点生效设施 → 扣资源 → 工期到点自动升级 | FR-06 |
| `UC-05` | 征收与兑换 | 城内征收（次数/CD）→ 集市解锁府库资源互换 | FR-06 / FR-07 |
| `UC-06` | 派内政任务 | 选城 + 任务类型 + 官员 → 工期逐旬推进 → 到账 | FR-09 |
| `UC-07` | 征兵 | 选队 + 数量 → 户役校验 → 扣资源/人口 → 定时完成 | FR-10 |
| `UC-08` | 编队 | 三槽位放武将 → 换兵种 → 看到适性与速度 | FR-14 |
| `UC-09` | 出征并确认开战 | 选目标 → 推演 → 决策预览 → 确认出兵 → 队列 → 抵达 → 遭遇确认 → 战报 | FR-14 / FR-16 / FR-15 |
| `UC-10` | 读战报 | 三句归因 + 展开逐回合事件 + 指纹可复核 | FR-15 / FR-16 |
| `UC-11` | 招揽武将 | 酒馆来访 → 探索登庸 → 相性/义理构成条 → 入册 | FR-13 |
| `UC-12` | 培养武将 | 战法装卸/升级、装备、等级经验、列传 | FR-11 / FR-12 / FR-23 |
| `UC-13` | 处置俘虏 | 战后入押 → 招降（成功率构成条）/ 释放 / 处斩 | FR-21 |
| `UC-14` | 外交 | 选势力与动作 → 态度理由链 → 门槛判定 → 后果 | FR-19 |
| `UC-15` | 应对事件 | 事件卡弹出 → 看条件与后果 → 选项 → 落账 | FR-20 |
| `UC-16` | 管理粮道 | 透镜看连通/断点 → 运粮/迁都 → 解除断粮 | FR-18 |
| `UC-17` | 从失败态翻盘 | 破产/兵尽/无将/失都 → 裁军/卖粮/代将/迁都 | FR-22 |
| `UC-18` | 达成结局 | 天下归一 / 败亡 / 偏安 → 结局卡 → 重开 | FR-22 |
| `UC-19` | 查术语与百科 | 悬停术语 → 解释卡 → 跳转百科/关联词条 | FR-24 / FR-29 |
| `UC-20` | 调整窗口与设置 | 最小化、缩放、字号、动画、音效、置顶开关、快捷键 | FR-25 / FR-26 |

### 3.2 作者 / GM 用例（UC-21 ~ UC-25）

| 编号 | 用例 | 关联 FR |
|---|---|---|
| `UC-21` | 用 GM 页覆盖地形/设施/开局城/规则/剧情文案 | FR-28 |
| `UC-22` | 用武将编辑器改任一武将五维、成长、统御、星级、自带战法 | FR-27 |
| `UC-23` | 从 `/__slg/state` 看全量存档、`/__slg/status` 看服务状态与日志 | FR-32 |
| `UC-24` | 三档存取 / 导出导入存档（导入前自动备份旧档） | FR-04 |
| `UC-25` | 用固定种子跑 60 旬模拟 / 平衡曲线 / 灭国闭环 | FR-31 |

### 3.3 QA 用例（UC-26 ~ UC-30）

| 编号 | 用例 | 关联 FR |
|---|---|---|
| `UC-26` | `npm test` 全绿、`check-release` 92/92 | FR-31 |
| `UC-27` | 源码态 + 打包态各跑冒烟 / UI 审计 / 真鼠标 | FR-31 |
| `UC-28` | 校验 `web/` 指纹与 `byteIdentical` | FR-31 / CN-01 |
| `UC-29` | 校验数据溯源、术语覆盖、对比度、合规台账 | FR-30 / FR-29 |
| `UC-30` | 校验报告新鲜度（不采信过期报告） | FR-31 |

### 3.4 玩家旅程（节奏需求）

| 阶段 | 必须发生的事 | 量化要求 | 来源 |
|---|---|---|---|
| 首 10 分钟 | 登录 → 举义 → 第一次经济决策 → 第一次内政指派 → 看见第一场可推演的战斗 | 分秒脚本落地，不允许空窗 >90s | GDD §2.1 |
| 首小时 | 出征六道门全部走完一遍 | 六门见 FR-14 | GDD §2.2 |
| 首 10 小时 | 一个剧本的五幕：立足 → 扩张 → 断粮危机 → 外交/宿命 → 会战 | 五幕均可触发 | GDD §2.3 |
| 百小时 | 6 剧本 × 4 难度 × 不同择主，重开理由成立 | 6 剧本全部可选 | GDD §2.4 / §12.1 |

**R-3.1** 任何时刻「无事可做」检测触发时，系统必须给出至少一条可执行建议（GDD §3.3）。

---

## 4. 功能需求总览

| 组 | 需求 | 状态 | 优先级 | 主要实现 | 验收脚本/测试 |
|---|---|---|---|---|---|
| FR-01 | 启动、登录门禁与会话 | ✅ | P0 | `index.js`、`ui-shell.js` | `p11-session-gate.test.js`、`smoke.cjs` |
| FR-02 | 协议兼容与消息路由 | ✅ | P0 | `codec.js`、`wsserver.js`、`handlers.js` | `codec/protocol/contract-matrix.test.js` |
| FR-03 | 世界时钟与时间尺度 | ✅ | P0 | `clock.js`、`campaign.js`、`knobs.js` | `campaign.test.js`、`m4-system-audit.test.js` |
| FR-04 | 存档、三档位、导入导出、迁移 | ✅ | P0 | `world.js`、`index.js` | `save-slots.test.js`、`protagonist-save.test.js` |
| FR-05 | 主城与领地（地图格、建造、放弃） | ✅ | P1 | `handlers.js`、`config.js` | `building.test.js`、`bugfix.test.js` |
| FR-06 | 生效设施单一清单与两处内政同源 | ✅ | P0 | `facility-catalog.js`、`handlers.js`、`panels.js` | `m4-facility-catalog.test.js` |
| FR-07 | 资源、日产、军饷、府库、双账本 | ✅ | P0 | `economy.js`、`strategy.js` | `m2-ledger.test.js`、`p10-supply.test.js` |
| FR-08 | 逐城经济（开发/人口/民心/治安/灾害/俸禄） | ✅ | P1 | `city-econ.js` | `p6-city-recruit.test.js`、`m4-system-audit.test.js` |
| FR-09 | 内政任务状与委任 | ✅ | P1 | `interior-task.js`、`appointment.js` | `m2-appoint.test.js`、`p10-interior-task.test.js` |
| FR-10 | 户役制征兵 | ✅ | P0 | `levy.js`、`handlers.js` | `p11-levy-and-gates.test.js` |
| FR-11 | 武将名册与百分制属性 | ✅ | P0 | `config.js`、`general-stat.js` | `m4-general-balance.test.js`、`innate-skills-and-stats.test.js` |
| FR-12 | 战法体系与主角指挥战法 | ✅ | P0 | `skills.js`、`kernel/`、`protagonist-skill.json` | `m4-protagonist-skill.test.js`、`skills.test.js` |
| FR-13 | 酒馆、登庸、关系网、宿命 | ✅ | P1 | `tavern.js`、`relation.js`、`fate-groups.js` | `tavern.test.js`、`m3-heroes-fates.test.js` |
| FR-14 | 军队编成与出征六门 | ✅ | P0 | `strategy.js`、`handlers.js`、`panels-ui.js` | `p8-war-panel.test.js`、`march-queue.test.js`、`p11-ui-integrity.test.js` |
| FR-15 | 确定性战斗内核与战报 | ✅ | P0 | `battle-core/`、`offline/kernel/`、`battle.js` | `protocol.test.js`、`domain-coverage.test.js` |
| FR-16 | 推演台与归因战报 | 🟡 | P0 | `strategy.js previewAssault`、`battle-narrative.js` | `p10-preview(-consistency).test.js` |
| FR-17 | 战略大地图、六剧本、诸侯脑 | ✅ | P1 | `strategy.js`、`strategy-brain.js`、`map.json` | `strategy*.test.js`、`m3-scenarios.test.js` |
| FR-18 | 粮道连通与补给 | ✅ | P1 | `supply.js`、`march.js` | `p10-supply.test.js`、`m2-army-supply.test.js` |
| FR-19 | 外交（8 动作、态度理由链） | ✅ | P1 | `diplomacy.js` | `m2-diploma.test.js` |
| FR-20 | 事件与叙事（150 条 + DSL） | ✅ | P1 | `event-dsl.js`、`event-engine.js`、`strategy.js` | `m3-events.test.js`、`m3-event-ui.test.js` |
| FR-21 | 俘虏与招降 | ✅ | P1 | `captives.js`、`captive-rules.js`、`strategy.js` | `m4-13-distance-garrison-captives.test.js` |
| FR-22 | 失败态与结局 | ✅ | P1 | `failstate.js`、`campaign.js` | `m2-failstate.test.js` |
| FR-23 | 六府面板 | ✅ | P0 | `panels.js`、`panels-ui.js` | `panels.test.js` |
| FR-24 | 交互增强层（P9 六透镜/预览/撤销/建言/术语） | ✅ | P1 | `interaction.js`、`interaction-ui.js` | `p9-interaction.test.js`、`p10-undo.test.js` |
| FR-25 | 窗口与弹层治理 | ✅ | P0 | `electron/main.cjs`、`preload.cjs`、`ui-shell.js` | `m4-window-behavior.test.js`、`check-release` 7.8 |
| FR-26 | 设置与常驻入口 | ✅ | P0 | `interaction-ui.js #slgIxQuick` | `m4-editor.test.js` |
| FR-27 | 武将编辑器（覆盖层） | ✅ | P0 | `general-editor.js`、`editor-ui.js` | `m4-editor.test.js` |
| FR-28 | GM 覆盖层 | ✅ | P1 | `gm/overrides.js`、`gm/index.html` | `contract-matrix.test.js`、`http-endpoints.test.js` |
| FR-29 | 无障碍、布局、反馈、术语 | 🟡 | P2 | `interaction-ui.js`、`panels-ui.js` | `m4-a11y.test.js`、`m4-layout.test.js`、`check-terms.js` |
| FR-30 | 合规与数据溯源 | ✅ | P0 | `conf/compliance/`、`provenance` 台账 | `m4-compliance.test.js`、`check-compliance.js` |
| FR-31 | 质量保障与发布闸 | ✅ | P0 | `tools/check-release.js`、`smoke.js`、`pack.js` | `check-release` 92 项 |
| FR-32 | 可观测 / 调试端点 | ✅ | P2 | `index.js /__slg/*`、`gm/board.html` | `http-endpoints.test.js` |

**需求状态统计**：✅ 已实现 30 组 ｜ 🟡 部分实现 2 组（FR-16 模块位置与 GDD 规划不一致——`OP-08` 已登记为「不建空壳」；FR-29 独立键盘 E2E 与灰度判据仍是人工/间接覆盖）｜ 📐 规划中 0 组（规划项统一登记在 §12 未决问题与 GDD §14 里程碑）｜ ⛔ 不做项见 §1.5。

> **2026-11-15 状态变更**：FR-24 由 🟡 升 ✅。产品裁决 `fieldGaps` 三项为**刻意降级的设计特性**而非缺口（见 `SDD §17.4 GAP-01`）：补「敌方侦察精确值」会违反 R-16.3 的情报区间规则，补「逐将战前 delta」等于无证据编造，而「主动结亲/结义」是新玩法。显式降级清单本身就是 FR-24.5 要求的能力，不该被当成欠账。

> **为什么几乎没有「规划中」的功能需求**：本文是**当前交付基线**的需求规格，只登记已经进入代码或在 GDD 中已被明确采纳并接线的能力。GDD §14 中尚未开工的 M5+ 条目属于路线图，不冒充现行需求；若要以需求方式排期，须先在本表新增编号并标 📐。

---

## 5. 功能需求详述

> 每条需求的「实现位置」是**验收时可核对的代码坐标**，不是设计建议。本文不复述 GDD 的玩法论证，只写「必须达到的行为 + 怎么验」。

### FR-01 启动、登录门禁与会话 ✅ P0

**描述**：程序启动后先显示登录门禁，账号登录与进入服务器完成后才允许注入层 UI 出现；登录态只用于显示门禁，不承担协议鉴权。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-01.1 | 启动时 `loadConfig → createSkillAssets → loadWorld → normalizeWorld → 建立 ctx → 启动 200ms/500ms 双 tick → listen(8088) → listen(8004)`，顺序不可颠倒。 |
| R-01.2 | `account.login` 成功置 `session.loggedInAt`；`role.enterServer` 成功置 `enteredAt`；`account.logout` 置 `logoutAt`；`ready = loggedInAt>0 && loggedInAt>logoutAt`。 |
| R-01.3 | `html[data-slg-phase="login"]` 时，所有注入层容器（`#slgUIv2`、`#slgPanelsDock`、`#slgOath`、`#slgStrategyOverlay`、`#slgBattleOverlay`、`#slgIxRoot`）必须隐藏。 |
| R-01.4 | 会话状态只存在进程内存，**不写入存档**；进程重启后回到未登录。 |
| R-01.5 | 门禁状态由两条独立轮询兜底：`index.js` 的 gateBoot 1500ms、`ui-shell.js` 的 1200ms。 |
| R-01.6 | 口令明文不得留存：`account.login` 后删除 `password`，改存 `sha256` 摘要前 32 位 `passHash`。 |

**输入 / 输出**：输入为 `account.login{username,password}`、`role.enterServer{}`；输出为同名回包 + `GET /__slg/session{ok,ready,phase,loggedInAt,enteredAt,username,day}`。

**异常与边界**：旧档缺「穿越者主公」时不得崩溃，须把旧档归档为 `save.json.pre-prologue-*.json` 后重开；`/index.html` 已被注入过时不得重复注入（防重复脚本导致双份 DOM）。

**验收标准**

- [ ] `AC-01.1` 未登录时 `fetch('/__slg/session').ready === false`，且页面 `data-slg-phase === 'login'`。
- [ ] `AC-01.2` 依次调用 `account.login` + `role.enterServer` 后 `ready === true`，注入层可见。
- [ ] `AC-01.3` `account.logout` 后 `ready === false`。
- [ ] `AC-01.4` 全量 `state` 中不存在 `session` 字段（会话不入档）。
- [ ] `AC-01.5` `index.html` 响应中四个 `<script src="/__slg/...">` 各出现且仅出现一次。

**实现位置**：`server/index.js:108-129, 321-377, 898-925`；`server/handlers.js` `account.login` / `role.enterServer`；`server/ui-shell.js`；`tests/p11-session-gate.test.js`。

---

### FR-02 协议兼容与消息路由 ✅ P0

**描述**：在不改原客户端的前提下，完整兼容原版 WebSocket 帧与 73 个消息名；任何新增能力不得破坏 `name/seq` 回显与 Go proto 字段大小写。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-02.1 | 业务帧形状恒为 `{seq,name,msg}`（请求）与 `{seq,name,code,msg}`（响应）；`name` 原样回显，`seq` 原样带回。 |
| R-02.2 | 握手帧 `{seq:0,name:'handshake',code:0,msg:{key}}` 为**明文 gzip**，不下发 AES；其后每帧为 `JSON → AES-128-CBC(ZeroPadding) → 小写 hex → gzip(9) → WS Binary`。 |
| R-02.3 | 每连接一个 16 字节密钥，密钥与 IV 同值；密钥由 `Date.now() ^ remotePort` 经 xorshift32 生成。 |
| R-02.4 | 字段名逐字沿用 Go proto json tag（`Confs / Wood / Members / Roles / Lists / RId` 等），大小写敏感。 |
| R-02.5 | 每次请求前先 `sanitizeMsg(req.msg)` 把数值字段的非有限值归 0，再 `settleWorld(ctx)` 保证读到最新世界。 |
| R-02.6 | 未知消息回 `code 404 + {reason:'unknown_message',name}`；handler 抛异常回 `code 500 + {reason:'internal',message}`；解码失败静默丢弃并记日志。 |
| R-02.7 | 心跳 `heartbeat{ctime}` 回 `{ctime,stime}` 且 `seq` 强制为 0；WS 传输层被动回 PONG。 |
| R-02.8 | 推送帧 `seq:0`，用**该连接自己的 key** 加密；推送名只允许 `roleBuild.push / roleRes.push / general.push / army.push / skill.push / chat.push / warReport.push / campaign.pending`。 |

**输入 / 输出**：见 SDD §3 的 73 消息全表与 27+ HTTP 端点全表。

**异常与边界**：TCP 粘包/半包由 `wsserver.js` 累积缓冲处理；单帧 >64MB 直接关闭连接；续帧按首帧 opcode 合并；一条 WS Binary 帧 = 一条业务消息，业务层无自定义长度前缀。

**验收标准**

- [ ] `AC-02.1` `codec.test.js` 覆盖握手明文、往返加解密、ZeroPadding 满块补齐。
- [ ] `AC-02.2` `protocol.test.js` 覆盖全部消息名可路由、回显 `name/seq`、推送 `seq=0`。
- [ ] `AC-02.3` `contract-matrix.test.js` 中字段名大小写不一致会导致测试失败。
- [ ] `AC-02.4` 未知消息名回 `404/unknown_message`，不抛未捕获异常。
- [ ] `AC-02.5` `tools/explore-bugs.mjs`（73 handler × 5 payload）零异常。

**实现位置**：`server/codec.js`、`server/wsserver.js`、`server/index.js:874-916`、`server/handlers.js:513-1554`、`tests/client.js`。

---

### FR-03 世界时钟与时间尺度 ✅ P0

**描述**：以「1 旬 = 10 游戏日」为战略节拍，日/旬/月/季/年各有明确职责；所有长时模拟只能通过唯一的世界推进入口。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-03.1 | `realMsPerDay` 默认 60000ms（可由 `overrides.rules` 在 1000~3600000 内覆盖）；倍速 `scale` 只允许 1 或 4。 |
| R-03.2 | 战略回合 = 旬（`turnDays=10`），不是月；`month = floor((day-1)/30)+1`，季节 = `SEASONS[floor(((day-1)%360)/90)]`（春/夏/秋/冬）。 |
| R-03.3 | **世界推进唯一真入口是 `handlers.js settleWorld(ctx, now)`**；长时模拟/平衡脚本只准注入固定 `now` 调它，不许自己拼结算链。 |
| R-03.4 | `settleWorld` 顺序固定：设施被动升级 → 总产量 → `settleCampaign/applyDays` → 行军到达 → `strategyTick` → 酒馆兜底/播报 → 建筑工期。 |
| R-03.5 | 每次 `handleRequest` 开头先结算，保证「读完即最新值」。 |
| R-03.6 | 单次结算最多推进 `chapter1.json.maxDaysPerSettle`（40 日），防止长时间挂机后一次性跑爆。 |
| R-03.7 | 撤销栈跨旬清空；战斗结算后清空；读档后清空。 |

**异常与边界**：`now` 回退、NaN、跨 40 日以上必须被夹住；旧手写日循环（漏 `applyDays`、重复 `cityEconTick`）已被判定为假阳性来源，禁止复活（见 `ARCHITECTURE.md §9.20`）。

**验收标准**

- [ ] `AC-03.1` `system-audit.mjs` / `sim-60turns.mjs` 中不存在手写 `for(day)` 结算链，只调 `settleWorld`。
- [ ] `AC-03.2` `check-release` 7.9d 断言「真链路玩家金随日增长」且 60 旬零异常。
- [ ] `AC-03.3` 固定 `now` 双跑 60 旬，两次结果 hash 一致。
- [ ] `AC-03.4` `campaign.speed` 传 2 被拒，仅 1/4 生效。

**实现位置**：`server/clock.js`、`server/handlers.js:303-366`、`server/domain/campaign.js:307-336`、`server/domain/knobs.js`、`tools/system-audit.mjs`、`tools/sim-60turns.mjs`。

---

### FR-04 存档、三档位、导入导出与迁移 ✅ P0

**描述**：单机存档必须可持久、可备份、可迁移、可跨档位切换；任何写盘不得产生半份存档。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-04.1 | `SAVE_VERSION = 3`；`loadWorld` 只接受版本 1/2/3，v1 自动换战法；未知版本进安全模式（只读 + 提示导出）。 |
| R-04.2 | `normalizeWorld(state,cfg)` 为所有新字段补**语义默认值**（不是 0）：缺 `clock/drift/campaign/facilities/counters` 等一律补齐；每支队伍三槽归一为 3 个非负整数。 |
| R-04.3 | 写盘走 `writeFileSync(tmp) + renameSync` 原子替换；`save()` 250ms 防抖，`flush()` 立即落盘。 |
| R-04.4 | 三档位：1 号 = `save.json`，2/3 号 = `save.slot2.json` / `save.slot3.json`；`GET /__slg/save/slots` 返回每档 `exists/bytes/updatedAt/day/roleName/chapter/ending`。 |
| R-04.5 | 导入存档前把旧档重命名为 `save.json.before-import-<ts>.json`；导入体上限 40MB，须含 `role` 字段，否则 `400 not_a_save`。 |
| R-04.6 | 导出为带 `Content-Disposition: attachment` 的全量 `state` JSON。 |
| R-04.7 | 结局后 `POST /__slg/restart` 重开一局；`overrides.city/facilities/tiles` 在 `createWorld` 时生效。 |
| R-04.8 | 读档后撤销栈清空；崩溃恢复用 `pending[]` 定时任务续跑。 |

**异常与边界**：存档损坏、字段 NaN、超长 `campaign.fired`（>80 键只留 `'1'` + 最近 60 日）都要能读；`save/slot` 参数非法 `400 bad_request`，空档 `404 empty_slot`，IO 失败 `500 io_error`。

**验收标准**

- [ ] `AC-04.1` 三档分别存/读，`day`、`roleName` 与存档内容一致。
- [ ] `AC-04.2` 导入前旧档备份文件存在且可解析。
- [ ] `AC-04.3` 手动删掉若干顶层字段后读档不崩溃，`normalizeWorld` 补齐且语义默认值正确。
- [ ] `AC-04.4` `save-slots.test.js` / `protagonist-save.test.js` 全绿。
- [ ] `AC-04.5` 原子写：写盘过程中不存在半份 `save.json`（`check-release` 第 6 组静态闸）。

**实现位置**：`server/world.js:37, 236-322, 331-431, 434-472`、`server/index.js:141-171, 740-810`。

---

### FR-05 主城与领地（地图格、建造、放弃）✅ P1

**描述**：保留原版 200×200 地图格交互，支持扫描、占地、建造、升级、放弃；覆盖层可改写地形但不得回写原表。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-05.1 | `mapRes_0.json` 提供 40000 格 `[地形,等级]`；`cfg.tileAt(x,y)` 优先取 `overrides.tiles` 命中项。 |
| R-05.2 | `nationMap.scan / scanBlock` 返回 `mr_builds/mc_builds/armys`；扫描长度默认 10。 |
| R-05.3 | `nationMap.build` 失败码固定：`21` 领地不属我、`49` 不可新建、`16` 资源不足、`25` 政令不足、`1` 参数非法。 |
| R-05.4 | 要塞（`type 56`）可升级/拆除；`upBuild/delBuild` 对非 56 类型拒绝。 |
| R-05.5 | 建筑工期由 `end_time/op_level/building` 驱动，`tickBuilds` 完成时推 `roleBuild.push`；拆除还原为地图资源地。 |
| R-05.6 | 地图标记 `posTagList/opPosTag`，上限 `pos_tag_limit`（默认 10）。 |

**验收标准**

- [ ] `AC-05.1` 建造 → 工期 → 完成 → 产量变化链路可复现。
- [ ] `AC-05.2` 在他人领地建造返回 21 且不扣资源。
- [ ] `AC-05.3` GM 覆盖地形后，`tileAt` 与 `state.builds` 同时变化，原表 `mapRes_0.json` 字节不变。
- [ ] `AC-05.4` `building.test.js`、`bugfix.test.js` 全绿。

**实现位置**：`server/handlers.js:610-701, 153-180`、`server/config.js:199-210`、`server/gm/overrides.js:111-123`。

---

### FR-06 生效设施单一清单与两处内政同源 ✅ P0

**描述**：原版 26 项设施中只有真正参与结算的项才允许出现在玩家界面并可升级；左上角六府·内政与直接点城池看到的设施列表必须同源。

> 来源：玩家实机反馈「有些设施没用上，属于过度设施」。M4-12 已收口。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-06.1 | **生效设施恰为 7 项**：集市(15，府库兑换门槛)、伐木场(17,木)、炼铁场(18,铁)、磨坊(19,粮)、采石场(20,石)、民居(21,金)、仓库(25,府库容量)；其余 19 项为「过度设施」。 |
| R-06.2 | 判据**不硬编码 type**：`isActiveFacility(cfg,f)` = `effectiveAxes(cfg,f).length>0` 或命中 `GATE_FACILITIES[type]`；`EFFECTIVE_ADDITIONS = {17:wood,18:iron,19:grain,20:stone,21:gold,23:capacity}`，`GATE_FACILITIES = {15:'解锁府库资源兑换'}`。**两张表的键空间不同**：前者是「加成类型 aType」（`facility_addition.json`），后者是「设施 type」；数字大多巧合相等，但仓库 `type 25` 的加成是 `aType 23 → capacity`，不可混为一谈。 |
| R-06.3 | 结算侧 `facilityAdditions` 只按 `EFFECTIVE_ADDITIONS[aType]` 写轴，与显示判据同表（描述 = 计算同源）。 |
| R-06.4 | `city.facilities` 默认只回生效项，并附 `allCount / hiddenCount / legacy / effectText`；`SLG_LEGACY_FACILITIES=1` 可取回全量 26 项作 GM 对照。 |
| R-06.5 | `city.upFacility` 对「配置内但未生效」的设施返回 `facility_disabled` 且**不扣资源**；错误优先级保持 `not_own_city` > `no_such_facility` > `facility_disabled`。 |
| R-06.6 | 六府·内政取设施必须用**本地主城键**（`state.citys[0].cityId`），不得误用战略 `state.strategy.playerCity`（两套编号不同）。 |
| R-06.7 | 曲辕犁图纸对磨坊(19) 额外 +20% 粮产，属结算内加成，不算新生效设施。 |
| R-06.8 | 原设施表与存档模板**逐字不动**，删掉覆盖即可还原。 |

**异常与边界**：`city.facilities` 对未知城回 `code 1 + no_city`；`max_level / upgrading / no_cost_table / res_not_enough` 等既有失败理由保持。

**验收标准**

- [ ] `AC-06.1` `facilityView` 返回 `rows.length === 7`、`allCount === 26`、`hiddenCount === 19`。
- [ ] `AC-06.2` 六府·内政表与城池内页 `city.facilities` 逐行一致（同源断言）。
- [ ] `AC-06.3` 对疾风营(1) 调 `city.upFacility` 返回 `facility_disabled`，资源前后不变。
- [ ] `AC-06.4` `SLG_LEGACY_FACILITIES=1` 时返回 26 项且 `legacy=true`。
- [ ] `AC-06.5` `m4-facility-catalog.test.js` 7 条全绿；`protocol.test.js` 用磨坊(19) 而非疾风营。

**实现位置**：`server/domain/facility-catalog.js`、`server/handlers.js:210-228, 702-808`、`server/domain/panels.js interiorFacilities`、`server/panels-ui.js`、`server/skills.js` 两处设施卡、`docs/ARCHITECTURE.md §9.26`。

---

### FR-07 资源、日产、军饷、府库与双账本 ✅ P0

**描述**：五种资源 + 政令 + 军功有唯一记账形状；逐城粮留城、金全额上缴国库，国库粮为只读汇总。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-07.1 | 资源轴为 `wood/iron/stone/grain/gold`，另有 `decree`（政令）、`jungong`（军功）、`depot_capacity`（府库容量）。 |
| R-07.2 | 日产由 `totalYield` 重算：`playerStockYield(state,key,base,facility,build)`；有城时 `city = round(cityLayer(state)[key] * difficultyRes)`，产量 `= city + max(0,facility) + max(0,build)`；无城时 `(base + local) * difficultyRes`。 |
| R-07.3 | 每日入库受 `depot_capacity` 上限；军饷 `cost = floor(soldiers * perSoldier * (1+upkeepPct/100))` 从粮扣；政令每日 +`decreePerDay`(2) 封顶 `decree_limit`(20)。 |
| R-07.4 | 有城时固定支出闸：当日金产 `goldYielded` 的 35% 作为维持费自动扣除（反通胀闸之一）。 |
| R-07.5 | **双账本**：实账 = `state.strategy.cityEcon[id].store`（上限 20000）；国库粮 `resources[faction].grain` 只读汇总，唯一写入口 `refreshGrainSummary / spendFactionGrain / creditFactionGrain / accrueFactionGrain`；禁止任何 `resources[..].grain =` 直接赋值。 |
| R-07.6 | 收支流水 `state.resLedger` 滚动 240 条 `{day,res,delta,reason}`；外交另有 `state.resLogs`；战略事件 `state.strategy.events` 滚动 200 条。 |
| R-07.7 | `interior.collect` 按城独立次数/CD；`interior.transform` 需要集市(15) 且按 `from[4]/to[4]` 兑换。 |
| R-07.8 | 军功去处：`craftJungong`（80 木 + 40  iron/个）、`smeltStone`（200 石/个）、`investDev`（开发度，上限 120）。 |

**异常与边界**：`tryUseNeed` 统一判 `政令不足→25`、`wood/iron/stone/grain/gold 任一不足→16`；`OutCollectTimesLimit=55`、`InCdCanNotOperate=56`、`NotHasJiShi=58`。

**验收标准**

- [ ] `AC-07.1` `whitebox-architecture.test.js WB-06` 逐行禁止国库粮直接赋值。
- [ ] `AC-07.2` 60 旬模拟中玩家金/粮单调性符合设计曲线且无 NaN。
- [ ] `AC-07.3` `m2-ledger.test.js`、`p10-supply.test.js` 全绿。
- [ ] `AC-07.4` 收支流水每一笔 `delta` 都能追到 `reason`。

**实现位置**：`server/domain/economy.js`、`server/handlers.js:210-290, 809-910`、`server/domain/strategy.js:647-728`、`server/domain/armory.js`、`docs/FIELD-CONTRACT.md §A`。

---

### FR-08 逐城经济（开发度 / 人口 / 民心 / 治安 / 灾害 / 俸禄）✅ P1

**描述**：每座城都有独立的经营账，旬界统一推进，玩家能看到每城的产量构成与变化原因。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-08.1 | 唯一入口 `cityEconTick(state,cfg,ctx)`；顺序固定为 `advanceInteriorTasks → (day%10===0 ? supplyTick/armySupplyTick/appointmentTick/cityDevTick/disasterTick/loyaltyTick : 空) → (day%30===0 ? popTick)`。 |
| R-08.2 | 逐城日产：`grain = round(30*(devAgri/50)*grainMod*besieged*moraleMod*cut)`，`gold = round(20*(devTrade/50)*besieged*moraleMod)`；`moraleMod = 0.85 + morale/400`；围城 0.5；断粮只砍粮产 ×0.55。 |
| R-08.3 | 特产映射累加 `extra`：铁 +80 iron、木 +80 wood、粟 +120 grain、盐 +100 gold、茶 +80 gold、马/玉 +60 gold。 |
| R-08.4 | 开发度等级 `devLevel(dev) = clamp(floor(dev/24)+1, 1, 5)`；`cityDevTick` 五项官职增量 `gain = max(0.1, conf.gain*(0.5+stat/100)*soft*half)`，`cur>=100 → soft=0.3`、`>=80 → 0.6`、行军中 ×0.5。 |
| R-08.5 | 人口每 30 日 `pop = min(100000, round(pop*(1+0.02+morale/100*0.04)))`，`store = min(20000, store+3*grainYield)`。 |
| R-08.6 | 灾害（每 10 日）确定性掷骰：蝗灾 `store×0.6` + 粮产减半 10 日、瘟疫 `troops×0.9 / pop×0.95`、丰收粮产 ×1.5 10 日；风险受灾害风险值/政务官/治安调节。 |
| R-08.7 | 俸禄每旬 `salaryDue = Σ 20*star`；欠饷则全军忠诚 −5；忠诚 <40 有 10% / <70 有 3% 叛逃概率（确定性 rng）。 |
| R-08.8 | 逐城经济**只从 `state.strategy.cityEcon` 取**；`state.cityEcon` 是空的历史对象，取错会让全城显示 0 粮。 |

**异常与边界**：所有掷骰走 `rngFor(state.seed ?? 20261110, day, tag)`；缺 `cityEcon` 行由 `ensureCityEcon` 补语义默认值。

**验收标准**

- [ ] `AC-08.1` `p9-interaction.test.js` 锁死「取错对象显示 0 粮」的历史回归。
- [ ] `AC-08.2` `fieldGaps` 对服务端缺失字段显式降级，UI 不编造数字。
- [ ] `AC-08.3` 同种子 60 旬的灾害/叛逃序列逐条一致。
- [ ] `AC-08.4` `p6-city-recruit.test.js`、`m4-system-audit.test.js` 全绿。

**实现位置**：`server/domain/city-econ.js`、`server/domain/supply.js`、`server/domain/levy.js`、`docs/FIELD-CONTRACT.md 历史教训 1`。

---

### FR-09 内政任务状与委任 ✅ P1

**描述**：内政不是「一键收菜」，而是可指派、可撤销、有工期、有官员影响的任务对象；委任把任务变成每旬自动派单。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-09.1 | 任务类型（`KINDS`）：开垦 / 招商 / 募兵整编 / 修城 / 赈灾 / 劝课生息等；`TICK_DAYS = 10`，一旬一 tick。 |
| R-09.2 | **内政只改工期不改产出**：好官缩短 `ticks`（1/2/3 旬），`perTick = round(K.total/ticks*100)/100`，总产出恒定，否则变印钞机。 |
| R-09.3 | `planTicks(kind,stat)` 依据官员属性定期数，`ticks` 钳位 1~6；`pickOfficer` 按目标属性选最优在城且未行军的武将。 |
| R-09.4 | `beginInteriorTask / cancelInteriorTask / advanceInteriorTasks` 分别负责开工、撤销、推进；撤销只影响未到账的余量。 |
| R-09.5 | 委任 `GOALS` 每旬自动派单真实内政任务；缺金置 `blocked`、失城自动结束；`appointmentView` 暴露 `status / blockedReason / doneCount / daysOn`。 |
| R-09.6 | 面板加成 `postBonusPct = min(maxBonusPct, stat/100*30 - (cityCount-1)*decayPerCity)`，在岗减半；`yieldBonusByResource` 按资源累加（FIELD-CONTRACT §A）。 |

**异常与边界**：`advanceInteriorTasks` 在 `cityEconTick` 中每日调用但旬界才到账；行军中官员 `half=0.5`；`appliedThisTurn` 防止同一旬重复加成。

**验收标准**

- [ ] `AC-09.1` 高属性官员只缩短工期，不改变 `total`。
- [ ] `AC-09.2` 委任缺金时状态为 `blocked` 且给出可读原因。
- [ ] `AC-09.3` `m2-appoint.test.js`、`m2-interior-kinds.test.js`、`p10-interior-task.test.js` 全绿。

**实现位置**：`server/domain/interior-task.js`、`server/domain/appointment.js`、`server/domain/panels.js:251`、`conf/panels/posts.json`。

> **已知口径偏差（登记，不在本版擅自改）**：`interior-task.js planTicks` 的比较阈值仍为 `8600/6800`（旧 0~10000 量纲），而官员属性已在 M4-10 改为 0~100 百分制，因此高属性分支实际不会命中。详见 SDD §17 与 §12 `OP-03`。

---

### FR-10 户役制征兵 ✅ P0

**描述**：征兵受人口、户数、壮丁、已征户、季节与旬冷却共同约束，且「预览 / 面板 / 结算」三处用同一份校验。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-10.1 | 常量：`HOUSEHOLD_SIZE=5`、`ADULT_MALE_RATE=0.62`、`POP_PER_SOLDIER=4`、`TURN_CAP_RATE=0.05`；季节系数 春 0.8 / 夏 1.0 / 秋 1.1 / 冬 0.7。 |
| R-10.2 | `households=floor(pop/5)`、`adultMales=floor(households*0.62)`、`houseBalance=max(0, adultMales-levied)`；`seasonalCap=floor(pop*rate*armsFactor*seasonFactor)`；`turnCap=floor(pop*0.05)`；`quota=min(houseBalance,seasonalCap,turnCap)`。 |
| R-10.3 | `checkLevy(state,cityId,count)` 是**唯一校验口**：`zero / no_population / levy_cooldown / levy_exhausted / need_population / over_quota`；同一旬重复征兵被 `levy_cooldown` 拒绝。 |
| R-10.4 | `commitLevy` 只在资源扣除成功后调用一次：`popAfter = max(5, popBefore - count*4)`、`ledger.levied += count`、民心按征兵占比下降。 |
| R-10.5 | 春季大征（`count/seasonalCap > 0.5`）触发 `farmConflictOf` 农时冲突 15% 罚，须在预览中显示。 |
| R-10.6 | 征兵完成是定时任务 `conscript_done`；`army.conscript` 回包含 `etaSec/need/levy/levyCommit/farmConflict/levyNote`。 |

**异常与边界**：`cnts[3]` 三槽归一为非负整数，NaN 归 0；行军中队伍禁止征兵（`marching`）。

**验收标准**

- [ ] `AC-10.1` 面板显示的 `quota/canLevy/reason` 与 `/__slg/strategy/action` 结算判定完全一致。
- [ ] `AC-10.2` 同旬第二次征兵返回 `levy_cooldown` 且人口不变。
- [ ] `AC-10.3` 超过 `quota` 返回 `over_quota`，不扣资源。
- [ ] `AC-10.4` `p11-levy-and-gates.test.js` 全绿。

**实现位置**：`server/domain/levy.js`、`server/handlers.js:1151-1231`、`server/domain/panels.js`、`docs/FIELD-CONTRACT.md §A`。

---

### FR-11 武将名册与三国志11 百分制属性 ✅ P0

**描述**：全库唯一量纲 0~100；史实五维为权威，原表派生层不得反向污染；所有系统取数走同一入口。

> 来源：玩家反馈「武将属性严重影响平衡」→ 参考《三国志 11》百分制重新设计。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-11.1 | 运行时武将 **505 位**（原表 368 + 主角 1 + 史载新增 136，交集 104）；唯一权威索引 `cfg.generalByCfg`。 |
| R-11.2 | 五维 `force/strategy/defense/speed/destroy` 恒在 **1~100**；`toGameStat(v)=clamp(round(v),1,100)`，缺值兜底 50；原表「×100」值经 `toPercentFromRaw(v)=clamp(round(v/100),1,100)` 归一。 |
| R-11.3 | 交集人物以 `heroes-240.json` 的史载五维覆盖原表主属性（原表吕布防御 97 > 诸葛 92 属失衡）；`star/arms/cost` 保留原设计。 |
| R-11.4 | 所有系统取数必须走 `gameStatOf(cfg,g,key,fallback=60)`；**禁止** `isProtagonist?7400`、`loreStat×80` 或任何 >100 的属性值。 |
| R-11.5 | 战斗成长 `grow = min(raw, floor(((100-base)/9)*100)/100)`，保证 Lv10 ≤100；`toGameGrow(five)=round(25+five*0.55)`（25~80）。 |
| R-11.6 | 派生公式以**代码实测**为准：内政 `0.5 + stat/100`（`cityDevTick`）、外交离间 `0.3+(bestIntellect-60)/100`、行军 `60+speed`、适性 `armsApt = clamp(0.85+0.3*v/100, 1.00, 1.15)`（下限锁 1.00，只奖励不惩罚）。M4-10 迭代记录中的 `0.5+stat/200`、`0.85+0.3*v/200` 属口径偏差，登记在 SDD §17，不在本版擅自改。 |
| R-11.7 | 武将等级上限 10，`expToAdvance(lv)=40*lv`，经验只来自出征折损；身故写 `chronicle` 不改数值。 |
| R-11.8 | 史实原表逐字不动，调平衡只准改派生层；`hero-balance.mjs` 的 31 条分层观感是 `designNotes`（`layer` 是剧情权重不是强度档），**不是 bug**，不得据此改史实数值。 |

**异常与边界**：虚构/演义人物（貂蝉、吕玲绮等）以「三国志11 官方数值优先、演义补位、来源标记」处理，缺史载兜底 50 并在 `heroes-240.json source.confidence` 标注；不得把派生值当史实。

**验收标准**

- [ ] `AC-11.1` `check-release` 7.9d 判据：505 位全部 1~100、中位落在 45~80。
- [ ] `AC-11.2` `m4-general-balance.test.js` 10 条全绿；`hero-balance.mjs` 无越界告警。
- [ ] `AC-11.3` 全库检索不存在 >100 的属性常量或 `?7400` 表达式。
- [ ] `AC-11.4` `innate-skills-and-stats.test.js` 全绿。

**实现位置**：`server/domain/general-stat.js`、`server/config.js:82-196`、`server/battle.js:117-164`、`server/domain/general-progress.js`、`conf/campaign/heroes-240.json`、`docs/ARCHITECTURE.md §9.24`。

---

### FR-12 战法体系与主角指挥战法 ✅ P0

**描述**：全量武将都有初始战法；战法的描述、内核参数、战报文本三者同源；主角专属指挥战法按玩家指定效果实现。

> 来源：玩家指定「自己和一名友军获得 3 回合洞察（免疫控制）；自身受击时 30% 概率回击一次、造成 87% 策略伤害，每升一级额外 +5% 回击概率；自身受到伤害降低 30%」。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-12.1 | 运行时战法 **177 条** = 主线真实片段 31 + 原创去重库 20 + 新机制组合 29 + 主角专属 1 + M4-9 初始战法代表 96（其中自带 48 / 通用 48）；面板配方 80 条；官网名录 796 条仅作名录，未实装。 |
| R-12.2 | 每条战法含 `ui`（描述/目标/距离/10 级成长）与 `kernel`（内核参数）双份；`kernelSkillAt` 把等级值逐槽注入 `Effect.mechanics`。 |
| R-12.3 | 全武将初始战法映射 `hero-skills.json` 覆盖 **424 位**；证据分级：`w0Linked` 139（官网可直连）、`derived` 237（按五维定位派生，**不是史实**）、`authored` 1（主角）；派生结论须在审计 `caveat` 与文档中写明。 |
| R-12.4 | 自带 vs 通用的判据 = `disassembleHero1/2/3` 全空；真人专属战法只归本人（`innate-skill-overrides.json` 证据表）。 |
| R-12.5 | 主角战法 `cfgId 19001`：配置名「坐镇中军」（需求讨论中曾称「后世之识」，见 SDD §17）；`trigger=4`、`skill_class=指挥`、`target_type=self_and_ally_single`、三 BUFF 槽 `ui.levels[*].effect_value = [3, 30+5n, 30]`。 |
| R-12.6 | 三效果：`insight_rounds=3`（免疫控制，`round_end` 递减）、`counter{chance:0.30+0.05*(lv-1), rate_pct:87, STRATEGY_DAMAGE}`（`flat_rate` 防二次成长、`noReaction` 防无限互击）、`damage_taken_reduce=0.30`。 |
| R-12.7 | **长期红线**：`mechanics` 绝不写进 `bonus_terms`（内核对攻击方 buffs 无差别求和，减伤/回击词会变成攻击加成）；旧战法事件 payload 不许新增字段（黄金向量与事件指纹会漂）。 |
| R-12.8 | 战法槽 3 个 + 天赋格；`SKILL_LEVEL_CAP=10`，升级费 `20*lv²`，消耗军功；`slotBlock/skillUpgradeBlock` 给可读拦截理由。 |
| R-12.9 | `tools/build-library-skills.js` 默认**不许再写** `hero-skills.json`（只有 51 人 A2 表，会覆盖 424 人表），需 `--force-hero-map` 显式授权。 |

**异常与边界**：非法 `skillCfgId` 在编辑器中归 0（白板）；`0` 表示无自带战法；同名战法按 `cfgId` 判定（率土真实表有同名「重斩」920015、「锋矢」920065），**不许按名字黑名单**。

**验收标准**

- [ ] `AC-12.1` `m4-protagonist-skill.test.js` 覆盖洞察免疫、回击概率逐级 +5%、减伤 30% 三条。
- [ ] `AC-12.2` 同种子重放，`event_fingerprint` / `config_fingerprint` / `rng_calls` 一致。
- [ ] `AC-12.3` 战报文本中出现的所有战法名都在「skills + protagonist + library + library-extra + innate」五份合法表内。
- [ ] `AC-12.4` `skills.test.js`、`m3-skills-80.test.js`、`innate-skills-and-stats.test.js` 全绿。
- [ ] `AC-12.5` `SKILLS.length === 177`，`Object.keys(hero-skills.json).length === 424`。

**实现位置**：`server/skills.js`、`conf/innate-skills.json`、`conf/campaign/hero-skills.json`、`conf/campaign/protagonist-skill.json`、`battle-core/src/{types,rules,engine}.ts` → `offline/kernel/`、`server/battle.js`、`docs/M4-9-全武将初始战法.md`、`docs/ARCHITECTURE.md §9.22`。

---

### FR-13 酒馆、登庸、关系网与宿命 ✅ P1

**描述**：无抽卡、无付费，武将通过来访、探索、登庸、俘虏招降等可解释途径入册；关系与宿命提供长线目标。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-13.1 | 在野武将来访按「籍贯散列 + 确定性时辰」生成；`todaysGuests / guestsNow / exploreTalent / announceTavern` 全部走 `rngFor`；探索固定 100 金/次（`exploreCost:100`）。 |
| R-13.2 | 登庸成功率 `talentRecruitRate()` 由相性环距、义理、关系、声望等构成，必须给出 `parts`（五分项）供 UI 显示，**禁止前端拆算**。 |
| R-13.3 | 相性 1~149 环形（`xiangxingGap` 取 0~74）；义理 0~100；关系网 8 种关系 + 阈值触发；`conf/relations.json` 30 条 bonds。 |
| R-13.4 | 宿命 **24 组**（8 组完整事件链）；`validateFateGroups` 加载即校验（id 唯一、成员≥2、组内不重名、effect/breakEffect/source 必填）；相性加成 25/18/10/0。 |
| R-13.5 | 队内 ≥2 名同组宿命触发 `fateComboDefMul`（守军防御 ×0.95/组，最多 2 条）；推演与正式结算必须同调。 |
| R-13.6 | `fates.json` 的 4 节点单链（关羽/替身陆昭）与 24 组并存，宿命状态机只回答「这一站写谁的名字」。 |
| R-13.7 | 忠诚与叛逃四条原因分别可查可处理；死亡/继承写 `chronicle`，不重算任何数值。 |

**异常与边界**：`fieldGaps` 中登记 3 项未实装字段：玩家主动结亲/结义、敌方侦察精确值、逐将战前 delta；UI 必须显式降级而非编造。

**验收标准**

- [ ] `AC-13.1` `m3-heroes-fates.test.js` 断言 24 组且结构校验通过。
- [ ] `AC-13.2` `tavern.test.js`、`p10-relation.test.js` 全绿。
- [ ] `AC-13.3` 登庸率 UI 构成条逐项相加 === 最终值。
- [ ] `AC-13.4` 同种子同旬来访名单一致。

**实现位置**：`server/domain/tavern.js`、`relation.js`、`fate-groups.js`、`fate.js`、`chronicle.js`、`conf/relations.json`、`conf/campaign/fate-groups.json`。

---

### FR-14 军队编成与出征六门 ✅ P0

**描述**：出征不是「点一下就打」，而是六道门构成的确认链；抵达后必须玩家确认才结算战斗。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-14.1 | 编制为 **3 槽位**（不是 18 棋子），每槽 `general + soldiers`；`army.dispose` 校验收属/槽位/武将/是否行军中。 |
| R-14.2 | 六门（P11）：① 切城/选目标 → ② 推演 → ③ 决策预览 → ④ 确认出兵 → ⑤ 行军队列 → ⑥ 抵达挂 `pendingBattle` 并弹出「遭遇」，玩家点「确认开战」才结算。 |
| R-14.3 | `strategyAttack` 入参 `{cityId,armyId,frac,fromCityId,confirmBattle}`；`frac ∈ (0,1]`，非法归 1；出征比例下限 0.05。 |
| R-14.4 | 行军必须沿 `detail.json` 路网 BFS 可通行（禁越野、关隘封锁时前后两段禁行、不穿第三座城）；`marchDaysBy = clamp(ceil(km/(55*(speed/100))),1,40)`；`armySpeed` 取队内最慢武将。 |
| R-14.5 | 出征耗粮 `ceil(deploy * grainPerSoldierDay * days)`，冬季渡河另乘 `crossRiverWinterCost`；先扣出发城 `store`，不足部分吃全局池并 +25% 损耗。 |
| R-14.6 | 抵达后 `pendingBattle` 超 30 日自动撤退；`battleRetreat / battleConfirm / recall / reorder` 四条队列动作可用。 |
| R-14.7 | 截击 `p = min(0.4, interceptPerEdge/100 * hostile.length)`，掷骰走 `rngFor`；`loss = max(1, round(total*0.12))`，剩余 <200 中止。 |
| R-14.8 | 兵种克制 骑→盾→弓→骑；守军在我克制时 ×0.87、被克时 ×1.15；兵种适性 `armsApt = clamp(0.85+0.3*v/100, 1.00, 1.15)` 同时作用于 `attack_base/defence_base`。 |

**异常与边界**：`no_army / zero / empty_slot / marching / bad_order / bad_pos / bad_general / res_not_enough` 均须返回可读 `reason`；`strategy.attack` 的 `ok` 是唯一判定，`code` 只作协议层同步。

**验收标准**

- [ ] `AC-14.1` `check-release` 7.11 的 E2E **8 环**（含门 4 遭遇 / 门 5 确认开战）全通且零未捕获异常。
- [ ] `AC-14.2` `ui-audit.cjs` 必须先渲染遭遇页再断言按钮可点。
- [ ] `AC-14.3` 真鼠标 `mouse-playtest.js` 源码态 + 打包态各 54 步全通。
- [ ] `AC-14.4` `p8-war-panel.test.js`、`march.test.js`、`march-queue.test.js`、`p11-ui-integrity.test.js` 全绿。

**实现位置**：`server/domain/strategy.js:1101-1677`、`server/domain/march.js`、`server/domain/supply.js`、`server/domain/aptitude.js`、`server/handlers.js:1075-1264, 1504-1543`、`server/index.js:600-673`、`docs/ARCHITECTURE.md §9.16`。

---

### FR-15 确定性战斗内核与战报 ✅ P0

**描述**：同一输入（编队 + 种子 + 配置）必得同一战报；内核只认部队/战法/随机数，不知道地图、剧情、阵营。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-15.1 | 内核 TS 源码在仓库根 `battle-core/src/`（10 个模块），`npm run build` 后逐字节同步到 `offline/kernel/`（10 份 `.js` + 10 份 `.d.ts`）；运行时 `server/battle.js` 只从 `../kernel/index.js` 导入。 |
| R-15.2 | RNG 为对齐 CPython `random.Random` 的 MT19937（`PythonRandom`），另有 `Mulberry32Rng` 备用，均带 `calls` 计数。 |
| R-15.3 | 战斗种子**只有一个公式**：`battleSeedFor(armyId,x,y,day) = crc32Utf8("armyId:x:y:day")`，与 `battleLog.length` 解耦。 |
| R-15.4 | 伤害链：`baseDamage = attr*rate*troop_factor*(1-0.5*mitigation)` → `calcDamage = max(floor(afterCounter*(1+Σbonus)), minDamage)` → 减伤 `mitigated = trunc(final*(1-reduce))`；`defense_model='corrected'` 时 `mitigation = defence/(defence+200)`。 |
| R-15.5 | 回合编排：指挥(battle_start) → 每回合[被动 → 准备到期 → 行动（按 speed 降序、同速按 unit_id）普攻 → 主动 → 追击] → 回合末清控制、递减 reactions。 |
| R-15.6 | 胜负：存活阵营唯一则该阵营胜；`judgeBattle` 用 `ROUT_RATIO=0.1` 判溃败，赢方(result 2) 占城、输方(0) 不占、1 为未决。 |
| R-15.7 | 每场写 `state.battleLog`（滚动 200）含 `seed / event_fingerprint / config_fingerprint / rng_calls / skillSystem / loadout / reportSkillIds`；`range_trace` 与 events 物理分离，不污染指纹。 |
| R-15.8 | `validateInvariants` 校验回合数、`rng_calls`、事件 round、九字段有限、兵力守恒、aliveSides 与 winner 一致。 |
| R-15.9 | 175 条黄金向量逐条一致、10000 场压测通过；`level_pairs` 中 `exactly_double` 58/58 组满足 `|ratio-2|<1e-9`。 |
| R-15.10 | 战报渲染 `reaction / control_immune` 事件；战法名必须落在五份合法表内（防冒烟假红，见 FR-12）。 |

**异常与边界**：`cloneUnits` 校验 unit_id 唯一、`0 < troops <= max_troops`、深拷贝不改入参；`validateConfig` 拒绝空伤害率表、缺 `il_methods`、非正 `round_limit/troop_factor`。

**验收标准**

- [ ] `AC-15.1` `protocol.test.js`、`domain-coverage.test.js`、`codec.test.js` 指纹断言全绿。
- [ ] `AC-15.2` 改 `battle-core/src/*.ts` 后必须 `npm run build` 并同步 `offline/kernel/`；10 份 `.js` 逐字节一致。
- [ ] `AC-15.3` `check-release` 第 3/4 组（内核稳定性、接入战报链路）全绿。
- [ ] `AC-15.4` 同种子预演与正式战报 hash 一致（100 组）。

**实现位置**：`battle-core/src/`、`offline/kernel/`、`server/battle.js`、`server/domain/battle-narrative.js`、`server/domain/garrison.js`、`tests/protocol.test.js`。

---

### FR-16 推演台与归因战报 🟡 P0

**描述**：出征前给出只读沙盒推演（不得写世界状态），战报给出「转折 / 决策 / 数值」三句归因 + 一层展开。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-16.1 | `POST /__slg/strategy/action {action:'preview',...}` → `previewAssault()` 是**纯只读沙盒**，`result.ok && act!=='preview'` 才 `save()`；推演不落盘。 |
| R-16.2 | 推演与正式结算必须共用 `settleArmyBattle` 的同一分母（真打与推演同 `dStart`）、同一 `fateComboDefMul`、同一 `battleSeedFor`。 |
| R-16.3 | 情报不足时给**区间**不给定值；确认出兵后 `lockedSeed` 写死，战斗内不可重推；敌方最多 3 套变招预案且由种子决定。 |
| R-16.4 | 战报三句齐全（转折 / 决策 / 数值），禁止「必胜 / 必败」文案；`previewNarrative` 返回 `verdict/headline/rows/tips/ratio`。 |
| R-16.5 | 推演台按「回合时间轴」呈现（3 槽位逐回合），**不是 18 棋子棋盘**（GDD D-01 纠偏）。 |
| R-16.6 | 推演单次 <50ms（5 次同参取中位），首次冷启动只记录不判定。 |

**当前缺口（🟡 的原因）**

| 缺口 | 现状 | 处置 |
|---|---|---|
| GDD §11.1 规划的 `domain/battle-preview.js` / `domain/attribution.js` / `battle-preview-ui.js` 独立模块 | 未落地，能力由 `strategy.js previewAssault` + `battle-narrative.js` 承担 | 保持现状，登记为「实现位置与 GDD 规划不一致」，不新建空壳模块 |
| `previewNarrative` 的 `odds` 字段 | JSDoc 曾声明，返回值未包含 | 已在 `2f07bc0` 关闭：JSDoc 对齐实际返回（`verdict/tone/headline/rows/tips/myNotes/defenderNotes/ratio`）。**刻意不补 `odds` 定值**——R-16.3 要求情报不足时给区间不给定值，见 `SDD §17 DEV-20` |
| 逐将战前 delta | `fieldGaps` 显式降级 | 已定性为刻意降级（`GAP-01`）：内核无逐将输出，补数字即编造，违反 FR-24.5 与合规红线；不排期 |

**验收标准**

- [ ] `AC-16.1` `p10-preview.test.js`、`p10-preview-consistency.test.js` 全绿。
- [ ] `AC-16.2` 连续推演 10 次，`state` 的 JSON hash 前后一致（只读证明）。
- [ ] `AC-16.3` 推演结论与同种子正式战报的胜负一致率满足脚本断言。
- [ ] `AC-16.4` `check-release` 7.11 包含推演→确认→战报链路。

**实现位置**：`server/domain/strategy.js previewAssault / settleArmyBattle`、`server/domain/battle-narrative.js`、`server/panels-ui.js` 出征页、`docs/GDD-顶配详细设计.md §6.7/§6.8`。

---

### FR-17 战略大地图、六剧本与诸侯脑 ✅ P1

**描述**：72 城 / 117 路的东汉十三州路网，6 个可选剧本，8 个有人格脑的诸侯按同一套规则推进。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-17.1 | `map.json` 含 72 城 / 117 路；`detail.json` 含 13 州 / 8 关隘 / 分层底图 / `march.nodes/edges/gateStatus`；ID 注册表 `id-registry.json` 提供稳定城池 ID（nextId 104）。 |
| R-17.2 | 关隘**不是城池**，是路网节点上的闸门（通行/封锁两态），不产出、不驻官（GDD D-03）。 |
| R-17.3 | 6 剧本：184 黄巾 / 190 讨董 / 200 官渡 / 208 赤壁 / 221 夷陵 / 229 三分；每份含 `year / playerDefault / playerOptions / factions / cityOwner{72} / opening / specialRules / source / confidence`。 |
| R-17.4 | 8 势力基础集在 `factions.json`，`trait` 只支持 4 个数值字段（`yields / recruitPct / upkeepPct / marchDelta`）；另有汉廷中立。 |
| R-17.5 | `strategy-brain.js planCampaign()` **只产出 `slg-ai-orders-v1` 指令单**（`goal / internal_orders / strategy_orders / explain / seed / personality / difficulty`），绝不直接改世界；由 `applyOrders` 统一执行。 |
| R-17.6 | 每旬各势力（有地才决策）：田赋入账 → 取指令单 → 记 `brainGoal` → 注入外交请托 → `applyOrders` → 记月度大事记 / 财报；`closeMonth` 汇总。 |
| R-17.7 | NPC 与玩家同规则：田赋 `grain=140+农业*3`、`gold=60+商业*1.2` 每旬按城计提；`accrueFactionGrain` 是唯一入账口。 |
| R-17.8 | 地图标注按 `cityLabelRank(1/2/3) × labelTierForZoom` 分级，`minGap=34`；客户端只取档过滤，不自行算重要性。 |
| R-17.9 | 举义：`GET /__slg/oath/options` 返回 8 诸侯 + 3 候选城，`POST /__slg/oath/choose` 落定；旧档缺 `oath` 字段视为已举义。 |

**异常与边界**：6 剧本的 `cityOwner` 必须覆盖全部 72 城；开局校验见 `tools/build-scenarios.mjs`（GDD §12.1 四条）；`brainRunner` 可注入以替换本地脑。

**验收标准**

- [ ] `AC-17.1` `strategy-map.test.js` 断言 72 城 / 117 路且路网连通。
- [ ] `AC-17.2` `m3-scenarios.test.js` / `m3-scenario-runtime.test.js` 6 剧本全部可加载并可推演。
- [ ] `AC-17.3` 60 旬模拟中至少出现一次 NPC 灭国，`tools/system-audit.mjs` 灭国闭环通过。
- [ ] `AC-17.4` `strategy-brain.test.js` 断言指令单不含直接写 state 的调用。

**实现位置**：`server/domain/strategy.js`、`strategy-brain.js`、`strategy-log.js`、`strategy-map.js`、`map-lod.js`、`server/domain/oath.js`、`conf/campaign/strategy/*`。

---

### FR-18 粮道连通与补给 ✅ P1

**描述**：粮道从「连通性」做成可断点、可惩罚、可修复的三级机制；军粮留城，出征前给出补给预估。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-18.1 | `supplyMap(state)` 以都城 `st.playerCity` 为根，己方城 + 未封锁关隘做 BFS；都城丢失时全城 `exempt=true`，不叠加断粮惩罚。 |
| R-18.2 | 句粮需求 `grainForTurn(state,troops) = round(troops * grainPerSoldierDay * turnDays)`，默认 0.1 粮/兵/日、10 日/旬 → **1 兵 1 旬 1 粮**。 |
| R-18.3 | 断粮城每旬：民心 −3、治安 −1、守军 −2%、粮产 ×0.55，`supplyDays += 10`；`supplyTick` 返回 `isolated/recovered/hits`。 |
| R-18.4 | 军队补给线断绝：`supplyCutDays += 10`，第 10 日警告，≥30 日逃兵 `max(1,ceil(troops*0.02))`；运输队 `kind='transport'` 不参与补给判定。 |
| R-18.5 | `marchSupplyEstimate(state,fromCityId,soldiers,days)` 给 `connected/hops/km/via/store/dailyNeed/daysCanHold/enough/note`，出征面板必须调同一函数（FIELD-CONTRACT §B）。 |
| R-18.6 | 运粮 `deliverGrain` 上限 20000；出征扣粮先扣出发城，不足吃全局池 ×1.25 损耗。 |

**验收标准**

- [ ] `AC-18.1` `p10-supply.test.js`、`m2-army-supply.test.js` 全绿。
- [ ] `AC-18.2` 人为封锁关隘后，下游城 `supplyCut=true` 且四項惩罚逐项可验。
- [ ] `AC-18.3` 面板耗粮数字与 `consumeMarchGrain` 实际扣除一致。
- [ ] `AC-18.4` 都城丢失时不出现「全城同时被断粮惩罚」的叠加。

**实现位置**：`server/domain/supply.js`、`server/domain/march.js`、`server/domain/city-econ.js:402-425`、`docs/FIELD-CONTRACT.md §B`。

---

### FR-19 外交（8 动作 + 态度理由链）✅ P1

**描述**：外交只对 NPC，全部可解释：态度值由可见因子链构成，动作有门槛、有代价、有后果。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-19.1 | 8 动作：停战 / 借道 / 结盟 / 联姻 / 请托攻击 / 劝降 / 离间 / 赠礼；门槛依次为 `-30/1500`、`20/800`、`55/0`、`40/3000`、`60/2000`、`0/0`、`0/800`、`0/0`（态度值/金）。 |
| R-19.2 | `attitudeOf(state,a,b)` 由 9 个因子构成：履约 +5/次、背约 −10/次、联姻 +15、赠礼 `min(30, gifts/200)`、边境摩擦 −3/城（上限 6）、共同敌人 +10、占其城池 −20、离间失手 −15、事件调整；基线为 `djb2Hash(pair) % 81 − 40`，最终钳位 −100~100。 |
| R-19.3 | 劝降额外门槛 `attitude >= 0 && myTroops >= hisTroops*3`；离间成功率 `clamp(0.3+(bestIntellect-60)/100, 0.2, 0.8)`，成功削敌方 5% 兵，失败态度 −15。 |
| R-19.4 | `truceActive` 停战期内不得互相攻伐；`noteCityCaptured` 更新边境摩擦与占城计数；`adjustAttitudeByEvent` 供事件落账。 |
| R-19.5 | 拒绝时必须给出 `factors`（≥1 条）理由链，不得只回「失败」。 |
| R-19.6 | 全部掷骰走 `rngFor(seed, day, 'diploSow:<fid>')`；赠礼金额钳位 100~20000。 |

**验收标准**

- [ ] `AC-19.1` `m2-diploma.test.js`、`m2-tension.test.js` 全绿。
- [ ] `AC-19.2` 每个动作的 `ACTIONS.gate/cost/fail` 都有对应测试。
- [ ] `AC-19.3` 态度构成条逐项相加 === `value`（前端不复算）。
- [ ] `AC-19.4` 停战期内 `strategyAttack` 被拒且理由可读。

**实现位置**：`server/domain/diplomacy.js`、`server/index.js:646-649`、`server/domain/strategy.js applyOrders`、`docs/GDD-顶配详细设计.md §5.8`。

---

### FR-20 事件与叙事（150 条 + 条件 DSL）✅ P1

**描述**：事件是带来源与证据分级的内容资产，按条件 DSL 筛选，有优先级、互斥、冷却与四道出戏防线。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-20.1 | 事件合计 **150 条**（`events.json` 52 + `events-extra.json` 98），三层 `史实节点 / 条件 / 关系`，id 全局唯一且以 `evt.` 开头。 |
| R-20.2 | 每条含 `id/title/layer/priority/when/once/speaker/text[]/choices[]/source{id,confidence}/reviewed/exclusive[]`；`validateEventSchema` 在构建期强校验（白名单字段、算子、choices、武将引用、source 必填）。 |
| R-20.3 | `WHEN_FIELDS` 18 项、`OPS` 8 个（`= != > >= < <= in not_in`）；`EFFECT_KINDS` 8 类（`flag/flag-/gold/morale/loyalty/attitude/fame/nothing`）；**不做通用脚本，禁止 eval**。 |
| R-20.4 | `selectEvents` 顺序：`once/cooldown` 排除 → `evaluateEvent` → priority 降序 + id 字典序 → `exclusive` 组只取第一条其余进 1 旬冷却 → `maxPerTurn=2`。 |
| R-20.5 | `applyEffects` 通过注入 `api{setFlag,clearFlag,addGold,addMorale,addLoyalty,addAttitude,addFame}` 落账，返回 `applied[]` 并记 `es.choices[event.id]`。 |
| R-20.6 | `strategyEventCtx` 注入 14 个字段回调：`year = scenarioYear + floor((day-1)/360)`、`season`、`resource(kind)`、`relation(a,b)`、`battleLost/Won(withinTurn=4)` 等。 |
| R-20.7 | 四道出戏防线：禁入词、证据级别、一次性标记、文案审阅（GDD §8.4）；6 剧本开局三回合必有一次决策。 |
| R-20.8 | 序章 `chapter1.json` 40 日主线：借粮/拒粮抉择、两波黄巾、巡逻、终局判定、曲辕犁图纸、蝴蝶进度三档（史实/偏移/改写）。 |

**异常与边界**：未知 `when` 字段必须 throw（白名单强拒）；`in/not_in` 的 want 必须是数组；时间字段支持裸数字（上下界/精确）与单算子对象两种写法。

**验收标准**

- [ ] `AC-20.1` `tools/check-events.mjs` 双文件 schema/引用/conflict 零错误。
- [ ] `AC-20.2` `m3-events.test.js` 断言合计 150 条、id 唯一、`campaignEvents().length === 150`。
- [ ] `AC-20.3` `m3-event-ui.test.js` 覆盖事件卡渲染与选项落账。
- [ ] `AC-20.4` 同种子同旬最多弹出 2 条且互斥组不重复。

**实现位置**：`server/domain/event-dsl.js`、`event-engine.js`、`server/domain/strategy.js:2238-2340`、`server/domain/campaign.js`、`conf/campaign/events*.json`、`conf/campaign/chapter1.json`。

---

### FR-21 俘虏与招降 ✅ P1

**描述**：战报确定性产生俘虏，俘虏可招降 / 释放 / 处斩，成功率由单一公式给出且显示构成条。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-21.1 | `captureFromBattle` 按守军折损比例 `ratio = (dStart-dLeft)/dStart` 得 `chance = 0.6+0.4*ratio`；`ratio>=0.75` 最多 2 人，否则 1 人；掷骰 `rngFor(seed,day,'capture:<place>:<cand>')`。 |
| R-21.2 | 招降率**唯一权威** `captiveRecruitRate = min(0.95, 0.45 + days*0.05 + protagonistStat(政治)*0.002)`；构成条 `base 45 + dayBonus days*5 + polBonus 政治*0.2`，逐项相加 === 最终百分点。 |
| R-21.3 | 招降消耗 300 金；成功后 `loyal = min(100, 70 + round(魅力/25))`；失败 `loyal -= 10`，<0 越狱除名且不扣费。 |
| R-21.4 | 每旬 `captivesTick`：`days+1`、`loyal-2`；`loyal<30` 且掷骰 <0.3 则越狱除名。 |
| R-21.5 | 释放 / 处斩分别影响名望：放归 `st.fame += 2`、处斩 `st.fame -= 2` 且 `role.infamy += 1`（★ 2026-11-16 落地，旧版只写 infamy 无消费）；守将分配 `garrisonCfgIds` 用 FNV-1a 哈希做到「同城恒定、跨城不重」，且排除已拥有/在押武将。 |
| R-21.6 | ★ 2026-11-16：名望必须有真实消费点——`defectTick` 来投率 `rate = min(0.45, 0.03 + (baseFame + min(40,st.fame))/700)`；名望贡献封顶 40 点，禁止靠反复放归刷满来投率（GDD §7.1「慕名来投」）。 |
| R-21.7 | ★ 2026-11-16：处置对外态度同源落账——放归对所有 NPC 势力 `attitude -5`，处斩 `attitude -15` 且董卓（`sili`）豁免（GDD §7.3 / §5.9 原文）；经 `diplomacy.js adjustAttitudeByEvent()` 写 `eventAdj`，理由链可见。战报不带原属势力字段，故不定向到单一势力。 |
| R-21.8 | ★ 2026-11-16：读档覆盖当前档前必须先备份（`.before-load-<ts>.json`）；先 `normalizeWorld` 成功再备份，归一化失败时当前档原封不动；1 号档即当前档本身，跳过备份。确认框「旧档会自动备份」文案自此属实。 |

**验收标准**

- [x] `AC-21.1` 招降率 UI 构成条与 `captiveRecruitRate` 完全一致（同源断言）。
- [x] `AC-21.2` `m4-13-distance-garrison-captives.test.js` 全绿。
- [x] `AC-21.3` 同种子同战报产生相同俘虏名单。
- [x] `AC-21.4` 两条占领路径（野战 / 攻城）都走同一个 `captureFromBattle`。
- [x] `AC-21.5` ★ 放归/处斩对名望、恶名、态度的影响与 `captive-reputation.js` 常量一致，名望进入来投率且封顶 40。
- [x] `AC-21.6` ★ `save-slots.test.js` 验证读档前留下 `.before-load-*` 备份且内容等于读档前进度。

**实现位置**：`server/domain/captives.js`、`captive-rules.js`、`captive-reputation.js`（★ 名望/恶名/态度口径）、`garrison.js`、`server/domain/strategy.js defectTick()`、`server/index.js`（态度组装层 + 读档备份）、`docs/M4-13-距离做实与守将俘虏出征.md`、`docs/FIELD-CONTRACT.md §D`。

---

### FR-22 失败态与结局 ✅ P1

**描述**：四种失败态各有至少一条可行出路，结局可达成、可解释、可重开。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-22.1 | 四态判定：`bankrupt = gold<=0 && grain<500`；`troopsStarved = 己方城 troops<200`；`noGeneral = 所有队 generals 全空`；`capitalLost = st.cities[playerCity].owner !== 'player'`。 |
| R-22.2 | 出路动作：裁军换金（`disarmForGold` 返还 `n*2*0.3`）、卖粮（1 粮 = 0.5 金，每旬上限 2000）、紧急募兵（金 `2*(mercenary?3:1)`，民心 −10）、代将（五维 50，不可培养）、迁都（保留 50% 资源）。 |
| R-22.3 | 全局结局 `evaluateEnding`：无城 → `fallen 败亡`；占全部州治且无敌对势力 → `unified 天下归一`；完成剧本阶段目标 → `partial 偏安`；否则继续。结局卡附最近 5 条关键决策文本。 |
| R-22.4 | 章节结局 `finishChapter`（序章 40 日）与全局结局是两套：持地 ≥`finale.holdLands`(3) 且保住主城 → `held`，否则 `lost` 并移走最远 2 块田；结局后 `settleCampaign` 冻结 fired、改跑巡逻。 |
| R-22.5 | `POST /__slg/restart` 结局后重开；难度 4 档只改数值，**不削减信息/预演/撤销**（GDD D3 红线）。 |

**验收标准**

- [ ] `AC-22.1` `m2-failstate.test.js` 构造四态并验证每态至少一条出路可执行。
- [ ] `AC-22.2` `tools/system-audit.mjs` 灭国闭环产出 `fallen/unified` 之一。
- [ ] `AC-22.3` 结局卡 `decisions` 非空且来自 `state.strategy.events`。
- [ ] `AC-22.4` 难度切换不改变推演/撤销可用性。

**实现位置**：`server/domain/failstate.js`、`server/domain/campaign.js:157-183`、`server/index.js:725-739`、`docs/GDD-顶配详细设计.md §3.4/§3.5/§9.3`。

---

### FR-23 六府面板 ✅ P0

**描述**：常驻 Dock 提供七个页签（含出征，Dock 常驻 6 个 + 战报红点），所有数据来自服务端聚合端点。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-23.1 | NAV 七项：`general 武将 / strategy 战略 / war 出征 / interior 内政 / depot 府库 / equip 兵刃 / library 战法库`；Dock 过滤 `war` 后显示 6 个 + `__reports 战报`。 |
| R-23.2 | 数据统一取 `GET /__slg/panels/state`，动作统一走 `POST /__slg/panels/action`；响应附最新 `view`，异常时 `view:null + viewError`。 |
| R-23.3 | 武将页四子页签 `attr / skill / equip / story`；`story` 取 `GET /__slg/general-dossier` 的 `dossierFor`。 |
| R-23.4 | 内政页「生效设施」表与城池内页同源（FR-06 R-06.6）。 |
| R-23.5 | 战报红点 `GET /__slg/panels/reports-head` 每 25s 轮询；未读判定 `a_is_read && d_is_read`。 |
| R-23.6 | 装备 4 槽 / 6 禁 / 18 件 / 4 材料，单件加成 ≤8%；`panelSelfCheck` 断言每条战法 ≥2 条获取途径且含 research。 |
| R-23.7 | 页签/选中态存 `sessionStorage`（`slg.panels.ui` 白名单），刷新可恢复。 |

**异常与边界**：`POST /__slg/panels/action` body 无效 → `400 {ok:false,message:'请求体无效'}`；领域异常 → `500 {ok:false,message}`。

**验收标准**

- [ ] `AC-23.1` `panels.test.js`、`http-endpoints.test.js` 全绿。
- [ ] `AC-23.2` 面板内所有玩家可见数字都能在 `FIELD-CONTRACT.md` 找到权威源。
- [ ] `AC-23.3` 面板打开 <100ms（性能预算）。

**实现位置**：`server/domain/panels.js`、`server/panels-ui.js`、`server/index.js:516-543, 588-594`、`conf/panels/*`。

---

### FR-24 交互增强层（P9：术语 / 百科 / 预览 / 撤销 / 建言 / 六透镜 / 队列 / 引导 / 快捷键）✅ P1

**描述**：在不动原画面的前提下，为玩家提供「看得懂、可预判、可反悔」的信息层。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-24.1 | 唯一数据端点 `GET /__slg/interaction/state`（只读聚合），返回 `day/turn/month/undo/season/treasury/salary/cities/generals/captives/marches/alerts/agenda/turnPreview/fieldGaps/pendingEvents`。 |
| R-24.2 | 术语表 **134 条**，构建期内联为 `window.SLG_TERMS`；悬停/焦点提示、`MutationObserver` 增量扫描（debounce 220ms）；覆盖率 100%（`check-terms.js` 下限 ≥120）。 |
| R-24.3 | 六透镜 `faction / supply / stock / general / intel / terrain`；六引导 `g1~g6`；字号三档 `[85,100,120]`。 |
| R-24.4 | 决策预览在代价性操作前给出结果与构成；撤销栈遵循三层可逆性（本旬最近 5 步、战斗后清空、读档清空），跨旬清空。 |
| R-24.5 | `fieldGaps` 显式登记服务端未提供的字段，UI 必须降级展示，**禁止编造数值**。 |
| R-24.6 | 顶层状态每 20s 轮询；事件卡为右下角非模态卡片，可「稍后处理」，未决事件用徽标聚合。 |
| R-24.7 | 快捷键：PC 键鼠优先，不做手柄；`?` 打开快捷键/设置；ESC / Shift+ESC / 点空白三条关闭路径都要走静音逻辑。 |
| R-24.8 | 注入层禁 `Math.random()`；`whitebox-architecture.test.js WB-04` 剥注释后逐文件扫描。 |

**原 🟡 原因已消除**：`fieldGaps` 3 项（玩家主动结亲/结义、敌方侦察精确值、逐将战前 delta）经 2026-11-15 产品裁决定性为**刻意降级的设计特性**，不是待补缺口——FR-24.5 要求的正是「显式登记 + UI 降级展示、禁止编造数值」，清单保持 `have:false` 与非空 `fallback` 即为达标。GDD §10.5「术语扩到 120」已超额完成（134）。百科深链仍以词表 `关联词条` 为主，属表现层细节，不影响本组验收。

**验收标准**

- [ ] `AC-24.1` `p9-interaction.test.js`、`p10-undo.test.js`、`p10-queue.test.js`、`ux-shortcuts.test.js` 全绿。
- [ ] `AC-24.2` `check-terms.js` 报 `terms=134, coverage=100%`。
- [ ] `AC-24.3` 撤销 5 步后状态 hash 与预期一致；第 6 步被拒。
- [ ] `AC-24.4` `fieldGaps` 中的字段在 UI 中显示降级文案而非数字。

**实现位置**：`server/domain/interaction.js`、`server/interaction-ui.js`、`conf/interaction/terms.json`、`docs/FIELD-CONTRACT.md §E`。

---

### FR-25 窗口与弹层治理 ✅ P0

**描述**：窗口默认永不置顶、可最小化/缩放；弹窗不得整屏霸屏、不得无限复活。

> 来源：玩家反馈「游戏一直压在最上层，无法缩小，点其他应用被游戏阻挡」。M4-6 已收口。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-25.1 | `BrowserWindow` 显式 `alwaysOnTop:false`、`minimizable/maximizable/resizable/fullscreenable:true`、`minWidth=900`、`minHeight=540`、`show:false` 待 `ready-to-show` 再显示。 |
| R-25.2 | **自动化分支也不许置顶**：遮挡节流已由 `backgroundThrottling:false` 解决；只有玩家在设置里显式开启才置顶，且只用 `floating` 层、不持久化、重启自动关；CI 逃生口 `SLG_FORCE_TOP=1` 仅用于取证。 |
| R-25.3 | `second-instance` 用 `restore() + showInactive()`，不抢焦点；`Menu.setApplicationMenu(null)`；`will-navigate` 只放行 `http://127.0.0.1:8088/`，`setWindowOpenHandler → deny`。 |
| R-25.4 | `electron/preload.cjs` 是唯一窗口 IPC 通道，`__slgWin` 只有 4 项白名单（`isElectron / isAlwaysOnTop / setAlwaysOnTop / minimize`）；**不许在 renderer 暴露 `ipcRenderer / node / fs`**。 |
| R-25.5 | 事件卡改非模态右下角（遮罩 `pointer-events:none`，只有 `.box` 可点），「稍后处理」写 `dismissedEvents`，ESC / Shift+ESC / 点空白三条关闭路径都走静音；徽标「未决事件 N」可重新打开。 |
| R-25.6 | 一屏一窗：主窗口优先级 `city > panels > win > modal > drawer`，同类 `.win` 只留最后一个；`data-slg-window` 为 main 时浮窗与按钮坞隐藏；**事件卡 `.slgIxEvent` 不计入模态统计**。 |
| R-25.7 | z-index 阶梯固定：城内页 100420 < 主窗 100560 < 决策预览 100760 < 术语 100780 < 确认框 100820 < 武将编辑器 100840 < toast 100900（完整表见 SDD §9）。 |

**异常与边界**：登录门禁期间注入层全部隐藏；`did-fail-load` 最多重试 3 次；窗口尺寸受主显示器工作区约束。

**验收标准**

- [ ] `AC-25.1` `electron/smoke.cjs.report.window` 双态 33/33，含 `alwaysOnTop===false`、`minimized/restored/smallSize`、事件卡 `pointerEvents==='none'` 取证。
- [ ] `AC-25.2` `check-release` 第 6 组静态闸 + 7.8 双态断言全绿。
- [ ] `AC-25.3` `m4-window-behavior.test.js` 全绿；`SLG_FORCE_TOP` 只在取证脚本中出现。
- [ ] `AC-25.4` 改层级或弹窗行为后必须跑 `tools/mouse-playtest.js`（源码态 + `--packaged` 各一轮）。

**实现位置**：`electron/main.cjs`、`electron/preload.cjs`、`server/interaction-ui.js`、`server/ui-shell.js`、`docs/ARCHITECTURE.md §9.21`。

---

### FR-26 设置与常驻入口 ✅ P0

**描述**：设置界面与武将编辑器必须有**常驻可见入口**，不允许只藏在 `?` 快捷键或二级菜单里。

> 来源：玩家反馈「游戏找不到设置界面，找不到武将修改页面」。教训：**入口不可见 = 功能不存在**。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-26.1 | `#slgIxQuick` 常驻入口条（`bottom:44px`、`z-index:100120`、非 `.slgIx-modal`），含「⚙ 设置 / 快捷键」与「武将编辑器」两个按钮。 |
| R-26.2 | 设置面板至少提供：窗口置顶开关、最小化到任务栏、字号三档、动画/音效开关、浮窗单张开关、快捷键说明、百科入口、武将编辑器入口。 |
| R-26.3 | 脚本未就绪时点击按钮必须给出明确失败提示，不许静默无响应。 |
| R-26.4 | 常驻入口条不得被一屏一窗规则误隐藏（它不是主窗口）。 |

**验收标准**

- [ ] `AC-26.1` 冷启动后无需任何快捷键即可在画面上看到设置与编辑器两个按钮。
- [ ] `AC-26.2` `m4-editor.test.js` 含入口存在性断言。
- [ ] `AC-26.3` 两个按钮在源码态与打包态的真鼠标脚本中都可点击。

**实现位置**：`server/interaction-ui.js #slgIxQuick` 与 `openKeys()`、`server/editor-ui.js window.__slgEditorOpen`。

---

### FR-27 武将编辑器（全武将属性与自带战法）✅ P0

**描述**：提供界面编辑**所有**武将的五维、成长、攻城、统御、星级与自带战法；只写覆盖层，原表不动、即时生效。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-27.1 | 可编辑范围：**505 位武将 × 177 条战法**；字段白名单 `EDIT_KEYS`：五维 / `*_grow` / `destroy` / `cost` / `star` / `skillCfgId`；范围 `EDIT_RANGES`：五维与成长 1~100、统御 1~45、星级 1~5。 |
| R-27.2 | 唯一写入目标是 `conf/campaign/overrides.json` 的 `generals` 段；`saveOverrides` 走 `tmp + renameSync` 原子写；编辑器**不得写任何原表文件**。 |
| R-27.3 | 保存后立即三处生效：① `applyToConfig` 更新 `cfg.generalByCfg`；② `cfg.generalOriginal` 存原值供 reset；③ `syncStateSkill` 同步当前存档 `state.generals[].skills[0]`（含 `innateOf` 覆盖优先）；无需重启。 |
| R-27.4 | `skillCfgId = 0` 表示白板；非法 cfgId 归 0；主角固定 `19001`。 |
| R-27.5 | 界面提供搜索（name/cfgId）、分页（`PAGE_SIZE=50`）、「只看已改」、单条重置。 |
| R-27.6 | `editor-ui.js` 类名 `slgEd-*` 不带 `.slgIx-modal`，**不计入 ui-shell 一屏一窗统计**；无 `Math.random()`、无定时轮询（事件驱动）。 |

**异常与边界**：`sanitizeGeneralEdit` 拒绝越界/非法形状；测试失败退出必须还原 `overrides.json`（历史教训：未还原导致 `general-balance` 假红）。

**验收标准**

- [ ] `AC-27.1` `m4-editor.test.js` 14 条全绿，含「不写原表」「只经 saveOverrides」「越界钳位」「非法战法归 0」「reset 还原」。
- [ ] `AC-27.2` 保存后不重启，`GET /__slg/editor/state` 与 `state.generals` 同时反映新值。
- [ ] `AC-27.3` 编辑器浮层打开时一屏一窗不误伤其它窗口。
- [ ] `AC-27.4` 测试结束后 `conf/campaign/overrides.json` 与测试前逐字节一致。

**实现位置**：`server/domain/general-editor.js`、`server/editor-ui.js`、`server/gm/overrides.js`、`server/config.js:179-196`、`server/world.js:22-34`、`server/index.js:472-507`、`docs/ARCHITECTURE.md §9.25`。

---

### FR-28 GM 覆盖层 ✅ P1

**描述**：作者可改地形、设施、开局城、规则、剧情文案，删掉覆盖即可还原，全程不碰 `conf/json/`。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-28.1 | `overrides.json` 结构固定 6 段：`tiles[] / facilities[] / city / rules{} / story{} / generals{}`；形状保护上限 tiles ≤200、facilities ≤40、generals ≤600、`city{x,y∈[0,200],name≤16字}`、story 仅 lend/refuse ≤200 字。 |
| R-28.2 | `RULE_RANGES` 钳位：`upkeepPerSoldier 0~100`、`lendGrain 0~100000`、`realMsPerDay 1000~3600000`、`blueprintBonus 0~10`；越界夹到边界而非报错。 |
| R-28.3 | `loadOverrides()` 用文件 mtime 做缓存键；读失败/解析失败回退 `emptyOverrides()`（不抛错、不阻塞启动）。 |
| R-28.4 | 生效链：`rules → chapterRules()`；`story → campaign.js` 序章播报；`city/facilities → createWorld()`；`tiles → cfg.tileAt + applyTileOverlay`；`generals → cfg.generalByCfg + innateOf`。 |
| R-28.5 | `GET /__slg/gm` 提供编辑页、`GET /__slg/board` 提供偏离/履历看板；`GET|POST /__slg/gm/overrides` 读写（POST 上限 100000 字节，超限直接 `req.destroy()`）。 |
| R-28.6 | 章节参数缓存键 = `chapter1.json mtime : overrides.json mtime`，改覆盖层后下次调用自动失效，无需重启。 |

**验收标准**

- [ ] `AC-28.1` `contract-matrix.test.js`、`http-endpoints.test.js` 覆盖 GM 端点。
- [ ] `AC-28.2` 改 `realMsPerDay` 后不重启，下一游戏日时长随之变化。
- [ ] `AC-28.3` 覆盖层写盘前后 `conf/json/` 全部文件 sha256 不变。
- [ ] `AC-28.4` 覆盖层损坏为非法 JSON 时服务仍能启动并回退空覆盖。

**实现位置**：`server/gm/overrides.js`、`server/gm/index.html`、`server/gm/board.html`、`server/index.js:811-847`、`server/config.js:184-210`、`server/domain/campaign.js:21-38`。

---

### FR-29 无障碍、布局、反馈与术语 🟡 P2

**描述**：5 档布局断点、字号三档、对比度达标、键盘可达、动效/音效可关且不影响结算。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-29.1 | 布局 5 档断点（GDD §10.1），`tools/layout-audit.js` 在 5 档分辨率 × 4 界面状态 × 3 档字号下取证。 |
| R-29.2 | 对比度：正文 ≥4.5:1、大字 ≥3:1（`tools/check-contrast.js` 覆盖 9 对色彩）。 |
| R-29.3 | 跳过动画不影响结算结果；关闭音效不丢失信息；灰度截图仍能区分粮道状态；无鼠标可完成一次出征（GDD 验收 G1~G4）。 |
| R-29.4 | 术语 134 条，每条带 `数值来源 / 关联词条 / 证据级别 / source_id / confidence`；UI 覆盖率 100%。 |
| R-29.5 | 反馈层：toast 3200ms、动效可关、飘字可合并；表现档位降级顺序见 NFR-07。 |
| R-29.6 | 文案规范：禁「必胜/必败」、玩家可见数字必须可追溯到权威源。 |

**当前缺口（🟡）**：`check-release` 7.9c 与 `m4-a11y.test.js` 覆盖主要项，但「无鼠标完成一次出征」的完整键盘链路由真鼠标脚本间接覆盖，未做独立键盘 E2E；灰度截图判据为人工项。

**验收标准**

- [ ] `AC-29.1` `m4-a11y.test.js`、`m4-layout.test.js` 全绿。
- [ ] `AC-29.2` `check-contrast.js` / `check-terms.js` 报告通过。
- [ ] `AC-29.3` `check-release` 7.9c、7.10 全绿。
- [ ] `AC-29.4` 5 档 × 4 状态布局报告无重叠/溢出告警。

**实现位置**：`server/interaction-ui.js`、`server/panels-ui.js`、`tools/layout-audit.js`、`tools/check-contrast.js`、`tools/check-terms.js`、`conf/interaction/terms.json`。

---

### FR-30 合规与数据溯源 ✅ P0

**描述**：公开可见 ≠ 可复制/商业再发布；每个数据源登记许可与授权状态，素材默认不下载。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-30.1 | `conf/compliance/provenance.json` 登记 10 类第三方派生数据（`path/kind/status/origin/count/evidence/action_before_release/confidence`）与 `forbidden_artifacts` 清单；`tools/compliance-report.js` 三向扫描（覆盖性 / 禁入物 / 发行包）。 |
| R-30.2 | 554 条内容数据带 `source + confidence`，`tools/check-compliance.js` 断言零缺口；`conf/compliance/map-declaration.json` 声明地图为 `schematic_projection / equirectangular` 示意图。 |
| R-30.3 | 武将史载五维来源 `D:/WorkBuddy/three-kingdoms/characters.csv`（936 行），`heroes-240.json` 逐条记 `source{ref,level,dbRow,override,confidence}`；派生不得冒充史实。 |
| R-30.4 | 全武将战法审计 `innate-skill-audit.json` 的 `caveat` 必须说明 237 条为按五维定位派生；`innate-skill-overrides.json` 记录人工证据与拒绝名单。 |
| R-30.5 | 发行前必查 `docs/合规与换皮清单.md`；7 项 `requires_user` 事项（Steamworks 账号费、商店素材、内容分级、第三方换皮、法务版号、代码签名多机实测、SDK 可选）由用户处理，不冒充已通过。 |
| R-30.6 | 跨游戏同名实体不可自动合并；AI 不得无证据编造游戏属性。 |

**验收标准**

- [ ] `AC-30.1` `m4-compliance.test.js` 全绿；`reports/data-provenance.json` = `{files:6, entries:554, missing:0}`。
- [ ] `AC-30.2` `check-release` 7.9 / 7.9b 全绿。
- [ ] `AC-30.3` 发行包内不含 IL 夹带物（`forbidden_artifacts` 扫描）。
- [ ] `AC-30.4` `reports/compliance.json` 无 `action_before_release` 未处理项硬阻塞（或明确列入 requires_user）。

**实现位置**：`conf/compliance/*`、`tools/check-compliance.js`、`tools/compliance-report.js`、`docs/合规与换皮清单.md`、`docs/GDD-顶配详细设计.md §10.8`。

---

### FR-31 质量保障与发布闸 ✅ P0

**描述**：提交前必须跑通单测、双态回归与发布闸；报告过期必须自举重算，不采信陈旧结论。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-31.1 | `npm test` = `node --test --test-concurrency=4 --test-timeout=60000 tests/*.test.js`（73 个文件）；`npm run smoke [-- --packaged]`、`npm run check`、`npm run pack`。 |
| R-31.2 | `check-release.js` 92 项分 8 组 + 7.7.4/7.7.5/7.8/7.9*/7.10/7.11 子组；含「`git status` 干净」硬闸；`requires_user` 单列不冒充通过。 |
| R-31.3 | 双态取证：冒烟 33×2、UI 审计 72×2、真鼠标 54×2；**以 `reports/*.json` 结论为准**，Electron 收尾非 0 退出码只警告。 |
| R-31.4 | 报告新鲜度：`newestShippedSource()` + `reportStale()` 自愈——报告缺失/早于出厂源码/早于工具任一即重算；`web/` 排除在新鲜度扫描外（由指纹单独兜）。 |
| R-31.5 | 并行/多会话取证纪律：核 `reports/*.json` 的 mtime 与内部 `startedAt`；`SLG_SMOKE_REPORT_DIR` 指向独立目录；只清理自己启动的 PID。 |
| R-31.6 | `pack.js` 必须**先过滤再复制**（Electron 自带 50+ `.pak`，先拷后删会触发宿主删除保护限流 50 而失败）。 |
| R-31.7 | 推演性能断言用 best-of-7 硬闸 + 中位粗闸，避免偶发抖动假红。 |
| R-31.8 | 同仓多 agent 竞态：`reports/` 与 8004/8088 端口是共享资源，取证前先确认归属。 |

**验收标准**

- [ ] `AC-31.1` `reports/release-check.json` = `achieved:92, failed:0, ready:true`。
- [ ] `AC-31.2` `reports/pack.json` = `byteIdentical:true, diff:[], webFileCount:1582`。
- [ ] `AC-31.3` 4 份双态报告（`smoke/ui-audit/mouse-playtest` × 2）全部通过且 `startedAt` 晚于最后一次源码改动。
- [ ] `AC-31.4` `npm test` 全绿；`check-release` 7.7.4/7.7.5 报告自举通过。

**实现位置**：`tools/check-release.js`、`tools/smoke.js`、`tools/ui-audit.js`、`tools/mouse-playtest.js`、`tools/pack.js`、`electron/*.cjs`、`tools/lib/port-guard.js`、`docs/ARCHITECTURE.md §9.19/§9.20`。

---

### FR-32 可观测 / 调试端点 ✅ P2

**描述**：开发者能只读地查看全量状态、服务状态、日志、履历与错误钩子。

**业务规则**

| 规则 | 内容 |
|---|---|
| R-32.1 | `GET /__slg/status` 返回 `ok/startedAt/uptimeMs/httpPort/wsPort/webDir/savePath/clock/connections/pending/warReports/battles/requestLog(最近80)/logs(最近40)/skills`。 |
| R-32.2 | `GET /__slg/state` 返回全量 `state`；`GET /__slg/general-dossier?cfgId=&name=` 返回武将履历与本局画像。 |
| R-32.3 | `window.__slgErrors` 收集 ≤60 条 `error / unhandledrejection`（`msg/stack/src`），注入在 `index.html` 的 errHook 中。 |
| R-32.4 | `GET /__slg/board` 看板取 `/__slg/state`；`GET /__slg/panels/selfcheck` 返回战法/装备自检。 |
| R-32.5 | 所有只读端点统一 `Cache-Control: no-store`；响应 ≥2048B 且客户端带 `Accept-Encoding: gzip` 时压缩并附 `Vary`。 |

**安全边界**：**当前实现无任何 HTTP/WS 鉴权**（仅监听 `127.0.0.1`，属于本机单机威胁模型）；如未来开放局域网或端口复用，必须补鉴权（见 NFR-11 与 SDD §13）。

**验收标准**

- [ ] `AC-32.1` `http-endpoints.test.js` 覆盖全部调试端点。
- [ ] `AC-32.2` `/__slg/status` 的 `requestLog` 与 `logs` 有上限，长时间挂机不无限增长。
- [ ] `AC-32.3` `window.__slgErrors` 上限 60，超出不内存泄漏。

**实现位置**：`server/index.js:323-333, 562-594, 172-199`、`server/domain/dossier.js`、`server/gm/board.html`。

---

## 6. 非功能需求

| 编号 | 类别 | 需求 | 指标 / 判据 | 取证 |
|---|---|---|---|---|
| NFR-01 | 确定性 | 同种子同输入必须逐位一致 | 175 条黄金向量一致；`event_fingerprint` / `config_fingerprint` / `rng_calls` 稳定；全库 `server/domain/kernel/tests/tools` 无 `Math.random()` | `WB-04/WB-05`、`protocol.test.js`、`check-release` 第 3 组 |
| NFR-02 | 确定性 | 战斗种子唯一公式 | `battleSeedFor` 只许定义在 `battle.js`，且只依赖 `(armyId,x,y,day)` | `WB-05` |
| NFR-03 | 性能 | 首屏三段分解 | 总 <7s；① 登录页 <600ms（硬闸）；② Cocos 首场景只记录不回退；③ 登录后到沙盘 <800ms（硬闸） | `tools/perf-probe.js` |
| NFR-04 | 性能 | 面板 / 结算 / 推演 | 面板 <100ms；回合结算 <2.5s（72 城 + 8 势力）；推演 <50ms（5 次中位，best-of-7 硬闸） | `perf-probe.js`、`check-release` 7.9d |
| NFR-05 | 性能 | 注入层 DOM 增量 | ≤400 节点/视角 | `MutationObserver` 计数 |
| NFR-06 | 资源 | 内存 | 主进程 + 渲染进程 <700MB（GPU 进程单列记录，不混入判定） | `getAppMetrics()` |
| NFR-07 | 降级 | 超预算降级顺序 | 先降表现 → 再降预计算 → 再分帧结算 → 最后才对**非战斗**数值做整数近似；战斗与粮道禁止近似；禁止减少信息种类/跳过校验/延迟结算；降级不得静默 | GDD §11.5 |
| NFR-08 | 可靠性 | 存档原子性 | `tmp + rename`，任何中断不产生半份存档；导入前自动备份 | `check-release` 第 6 组 |
| NFR-09 | 可靠性 | 崩溃恢复 | `pending[]` 定时任务在读档后续跑；`normalizeWorld` 补齐所有新字段 | `world.js`、`save-slots.test.js` |
| NFR-10 | 兼容性 | 完全离线 | 源码零外网地址；只监听 `127.0.0.1`；不依赖 Go + MySQL；导航拦截只放行本机 | `check-release` 第 5 组 |
| NFR-11 | 安全 | 本机威胁模型 | 默认无鉴权但仅回环可达；`preload` 白名单隔离；renderer 不暴露 `ipcRenderer/node/fs`；静态服务防路径穿越（非 root 前缀 403） | `check-release` 第 5/6 组 |
| NFR-12 | 可维护性 | 分层依赖 | 五层箭头朝下；`handlers.js` 只许变薄；领域模块不得引入表现层；新增叶子模块尽量零依赖 | `ARCHITECTURE.md §2/§5`、SDD §5 |
| NFR-13 | 可维护性 | 单一权威源 | 玩家可见数值登记在 `FIELD-CONTRACT.md`；界面只显示不计算；描述 = 计算 = 战报同源 | `WB-06`、`FIELD-CONTRACT.md` |
| NFR-14 | 可测试性 | 报告为准 | 冒烟/UI/真鼠标以 JSON 报告结论为准，不采信 Electron 退出码；报告过期自愈重算 | `smoke.js`、`check-release` 7.7.5 |
| NFR-15 | 可访问性 | 键鼠与视觉 | 5 档布局、3 档字号、对比度 4.5:1/3:1、键盘可达、灰度可辨 | `m4-a11y/m4-layout.test.js`、`check-contrast.js` |
| NFR-16 | 可移植 | 免安装 | `build/SLG-Offline-win32-x64/` 可直接双击运行；不写注册表、不装依赖 | `pack.js`、`start-packaged.bat` |
| NFR-17 | 合规 | 数据可追溯 | 554 条 `source+confidence` 零缺口；地图示意图声明；发行包无禁入物 | `check-compliance.js`、`compliance-report.js` |
| NFR-18 | 窗口行为 | 不霸屏 | 默认不置顶、可最小化/缩放、弹窗非模态可静音、二次启动不抢焦点 | `m4-window-behavior.test.js`、双态冒烟 |
| NFR-19 | 画面保全 | 原版逐字节不变 | 1582 文件 / `ee987ec2…50485` / `byteIdentical=true` / `containsCustomCanvasUI=false`；`index.html` 磁盘文件不含注入脚本 | `pack.js`、`check-release` 第 2 组 |
| NFR-20 | 可解释性 | 无黑箱 | 每个 delta 有 `source`；外交拒绝有理由链；登庸/招降有构成条；战报三句齐全 | `FIELD-CONTRACT.md`、GDD 附录 B C 组 |
| NFR-21 | 商业形态 | 无付费 | 无内购、无抽卡、无赛季、无广告；武将只靠玩法获取 | `conf/panels/skill-recipes.json` 双路径保证 |
| NFR-22 | 本地化 | 简体中文 | 全部 UI 文案、战报、文档为简体中文；术语含 `数值来源/证据级别` | `terms.json`、`docs/` |
| NFR-23 | 体积 | 发行包 | locales 只保留 4 个 `.pak`（瘦身约 45MB）；`build/` 不入库 | `pack.js:73-85`、`.gitignore` |
| NFR-24 | 可观测 | 日志上限 | `requestLog` 80 / `logs` 40 / `chat` 200 / `battleLog` 200 / `resLedger` 240 / `strategy.events` 200 / `warReports` 100 / `__slgErrors` 60 | `index.js`、`world.js` |

---

## 7. 数据与内容需求（DR）

### DR-01 内容资产清单（以运行时口径为权威）

| 指标 | 数值 | 来源 | 备注 |
|---|---:|---|---|
| 运行时武将 | **505** | `loadConfig().generalByCfg` | 原表 368 + 主角 1 + 史载新增 136；交集 104 |
| 初始战法映射名单 | **424** | `conf/campaign/hero-skills.json` | 139 官网直连 / 237 五维派生 / 1 主角 |
| 运行时战法 | **177** | `server/skills.js SKILLS` | 31 + 20 + 29 + 1 + 96 |
| ├ 初始战法代表 | 96 | `conf/innate-skills.json` | 自带 48 / 通用 48（`isOwn`） |
| ├ 官网名录（未实装） | 796 | `conf/campaign/skill-source.json` | 仅名录 |
| └ 面板战法配方 | 80 | `conf/panels/skill-recipes.json` | 每条 ≥2 条获取途径 |
| 城池 / 路网 | **72 / 117** | `strategy/map.json` | 13 州 / 8 关隘 |
| 剧本 | **6** | `strategy/scenarios/*.json` | 184/190/200/208/221/229 |
| 事件 | **150** | `events.json` 52 + `events-extra.json` 98 | 三层分类，id 全局唯一 |
| 宿命组 | **24** | `fate-groups.json` | 8 组完整事件链 |
| 术语 | **134** | `conf/interaction/terms.json` | 覆盖率 100% |
| 设施类型 | **26** | `conf/json/facility/facility.json` | 生效 7 / 过度 19 |
| 地图格 | 40,000 | `conf/mapRes_0.json` | 200×200 |
| 关系 bonds | 30 | `conf/relations.json` | 相性 1~149 / 义理 0~100 |
| 面板装备 / 官职 | 18 / 5 | `conf/panels/items.json`、`posts.json` | 4 槽 6 禁 |
| 武将列传 | 120 | `conf/panels/generals-lore.json` | 文本取自资料库 CSV |
| 人物台词档案 | 8 | `conf/campaign/people.json` | — |
| 配置 JSON 总数 | **76** | `conf/**/*.json` | 另有 18 张地图/图层图片 |
| 数据溯源条目 | 554 | `reports/data-provenance.json` | `missing:0` |
| 原版画面文件 | 1,582 / 179,831,865 B | `offline/web/` | 指纹 `ee987ec2…50485` |

> **口径纪律**：README 的「战法 80」是 M3-8 阶段快照，P0 文档中的「48 条战法表」是已废弃的第一版，`M4-9` 的 177 才是当前运行时值。三套数字不许混在同一张表里（SDD §17 登记）。

### DR-02 数据来源与证据分级

| 数据 | 来源 | 证据级别 | 处理规则 |
|---|---|---|---|
| 史载五维 | `D:/WorkBuddy/three-kingdoms/characters.csv`（936 行） | `A/B/C` 逐条标注 | 交集人物覆盖原表主属性；`heroes-240.json` 记 `dbRow/override/confidence` |
| 原版武将表 | `conf/json/general/general.json` | 原工程资产 | 逐字不动，>100 值只在派生层归一 |
| 战法描述 | battle-kit 原文片段 + 官网 W0 表 | 名录/直连/派生三级 | 派生值必须标 `caveat`，不得冒充史实 |
| 城池路网 | 东汉十三州模型图（TMX → JSON） | 示意图声明 | `map-declaration.json` 声明等距圆柱投影示意 |
| 事件文本 | 史实/条件/关系三层撰写 | `source{id,confidence}` | 四道出戏防线 |
| 术语 | 交互规格 + 代码字段 | `证据级别/source_id/confidence` | UI 覆盖率 100% |

### DR-03 内容不可改边界

| 资产 | 可否改 | 方式 |
|---|---|---|
| `offline/web/**` | ⛔ 逐字节不可改 | 一切扩展走运行时注入；确需改则重新构建并更新指纹基线 |
| `conf/json/**` 原表 | ⛔ 不改 | GM/编辑器只写 `conf/campaign/overrides.json` |
| 史实 CSV 与原表主属性 | ⛔ 不改 | 调平衡只改派生层 |
| `conf/campaign/*` | ✅ 可改 | 需重新跑构建脚本与对应测试 |
| `overrides.json` | ✅ 运行时回写 | 原子写 + mtime 缓存 + 形状保护 |
| 旧战法事件 payload | ⛔ 不新增字段 | 会漂黄金向量与事件指纹 |

---

## 8. 外部接口需求（IF）

### IF-01 进程内服务

| 接口 | 地址 | 用途 |
|---|---|---|
| HTTP | `127.0.0.1:8088` | 静态资源、注入脚本、动作端点、只读状态、GM 页面 |
| WS | `127.0.0.1:8004` | 原客户端协议；普通 HTTP 请求一律 404，仅处理 `upgrade` |

端口可由 `SLG_HTTP_PORT` / `SLG_WS_PORT` 覆盖；`startOfflineServer(options)` 亦支持 `httpPort/wsPort/webDir/saveDir/confDir/travelMs/quiet`。

### IF-02 WS 帧与消息

- 帧：握手明文 gzip；业务帧 `JSON → AES-128-CBC(ZeroPadding,key=iv) → hex → gzip(9) → WS Binary`。
- 73 个消息名分 12 组（连接/角色/大地图/城池内政/武将人事/军队出征/战报/技能客栈/联盟/聊天/战役/战略）；**完整表见 SDD §3.3**。
- 错误为顶层数字 `code` + `msg.reason`；**不是** `{err:'...'}`。
- 推送 `seq:0`；8 个推送名见 FR-02 R-02.8。

### IF-03 HTTP 端点

| 组 | 端点 | 数量 |
|---|---|---|
| 账号占位 | `/account/*` | 3 类 |
| 注入脚本 | `/__slg/{panels,interaction,shell,editor}/ui.js` | 4 |
| 编辑器 | `/__slg/editor/{state,save,reset}` | 3 |
| 面板 / 举义 | `/__slg/panels/*`、`/__slg/oath/*` | 6 + 2 |
| 交互 / 状态 | `/__slg/interaction/state`、`session`、`status`、`state`、`general-dossier` | 5 |
| 战略 | `/__slg/strategy/{state,action,panorama.png,detail,layers/<name>,tick}`、`/__slg/restart` | 7 |
| 存档 | `/__slg/save/{slots,slot,export,import}` | 4 |
| GM | `/__slg/gm`、`/__slg/board`、`/__slg/gm/overrides` | 3 |
| 兜底 | 静态资源（含 304/403/404/500） | 1 类 |

`POST /__slg/strategy/action` 的 `act` 白名单 **25 项**：`formup / transport / reward / invest / cancelInvest / captive / attack / recall / battleConfirm / battleRetreat / digest / disarm / sellGrain / craft / smeltStone / investDev / emergencyConscript / relocateCapital / appoint / cancelAppoint / diplo / scenario / eventChoice / reorder / preview`（其中 `preview` 纯只读、不落盘；逐项领域函数见 SDD §3.4）。

### IF-04 文件与配置接口

| 文件 | 方向 | 说明 |
|---|---|---|
| `offline/saves/save.json`、`save.slot2.json`、`save.slot3.json` | 读/写 | 三档存档 |
| `conf/campaign/overrides.json` | 读/写 | GM 与编辑器唯一写入目标 |
| `conf/**/*.json`（其余） | 只读 | 启动期 `loadConfig` 载入 |
| `reports/*.json` | 写 | 测试/审计/发布取证 |
| `battle-core/build/src/*.js` → `offline/kernel/*.js` | 同步 | 内核编译产物 |

### IF-05 Electron IPC

`__slgWin` 四项白名单：`isElectron` / `isAlwaysOnTop()` / `setAlwaysOnTop(on)` / `minimize()`；主进程对应 `app:status` / `win:is-always-on-top` / `win:always-on-top` / `win:minimize`。**不得新增暴露面**，新增窗口能力须先评审。

### IF-06 环境变量

`SLG_HTTP_PORT`、`SLG_WS_PORT`、`SLG_WEB_DIR`、`SLG_SAVE_DIR`、`SLG_TRAVEL_MS`、`SLG_SMOKE`、`SLG_AUDIT`、`SLG_MOUSE`、`SLG_PERF`、`SLG_LAYOUT`、`SLG_DIAG`、`SLG_FORCE_TOP`、`SLG_SMOKE_EXIT`、`SLG_SMOKE_TAG`、`SLG_SMOKE_REPORT_DIR`、`SLG_ELECTRON`、`SLG_ELECTRON_DIST`、`SLG_LEGACY_FACILITIES`（完整取值与默认值见 SDD §15.4）。

---

## 9. 约束与假设（CN）

| 编号 | 约束 | 理由 / 违反后果 |
|---|---|---|
| CN-01 | `offline/web/` 磁盘文件**逐字节不可改** | 发布闸第 2 组硬闸；改了会破坏 1582 文件指纹与 `byteIdentical` |
| CN-02 | UI 一律运行时注入 | 原客户端编译产物不可重建；所有扩展走 `index.html` 注入或 bundle 响应注入 |
| CN-03 | 协议层字段名、`name/seq` 回显、加解密链路不动 | 原客户端 `WebSock.ts` 硬编码 |
| CN-04 | `handlers.js` 只许变薄 | 领域逻辑必须进 `server/domain/` |
| CN-05 | 领域模块零环依赖（应然） | 见 SDD §17：当前 `world.js ↔ strategy.js` 仍有环，登记但不在本版重构 |
| CN-06 | 禁 `Math.random()` | 确定性红线；`WB-04` 剥注释后扫描 |
| CN-07 | 描述 = 计算 = 战报同源 | 界面只显示不计算；前端复算即回归 |
| CN-08 | 史实原表与 CSV 逐字不动 | 派生层可调，原层不可调 |
| CN-09 | 默认永不置顶 | M4-6 长期红线；自动化也不许置顶 |
| CN-10 | GM/编辑器只写覆盖层 | 删覆盖即还原，不许回写 `conf/json/` |
| CN-11 | 改内核必须回填 TS 源并同步 `offline/kernel/` | 直接手改编译产物会被 `npm run build` 冲掉 |
| CN-12 | 提交前 `npm test` + 双态回归 + `check-release` 全绿且 `git status` 干净 | 发行闸硬条件；文档入仓必须提交 |
| CN-13 | 简体中文交付 | 用户约定 |
| CN-14 | 只做 Windows portable | macOS/Linux/Steamworks SDK 列为 requires_user |

**假设**：玩家机器为 Windows 10+ x64、可用磁盘 ≥1GB、有可用回环端口 8088/8004；无外网；单实例运行；存档目录可写；不使用多会话并发验收（若并发须按 FR-31 R-31.5 隔离）。

---

## 10. 验收与发布

### 10.1 验收层级

| 层 | 内容 | 通过判据 | 命令 |
|---|---|---|---|
| L1 纯函数单测 | 73 个 `*.test.js` | 全绿 | `npm test` |
| L2 内核黄金向量 | 175 条 + 10000 场压测 + 58 组 level_pairs | 逐条一致 | `battle-core npm test` / `check-release` 第 3 组 |
| L3 协议 / 端点 | 73 消息 + 27+ HTTP | 零异常、字段齐备 | `protocol.test.js`、`http-endpoints.test.js`、`explore-bugs.mjs` |
| L4 注入层静态 | 语法 + 禁 `Math.random` + 指纹 | 全绿 | `inject-syntax.test.js`、`whitebox-architecture.test.js` |
| L5 源码态真机 | 冒烟 33 / UI 72 / 鼠标 54 | JSON 报告通过 | `smoke.js`、`ui-audit.js`、`mouse-playtest.js` |
| L6 打包态真机 | 同上 ×2 | JSON 报告通过 | 各脚本 `--packaged` |
| L7 发布闸 | 92 项 + 7 项 requires_user 单列 | `achieved:92, failed:0, ready:true` | `check-release.js` |
| L8 合规/溯源/术语/对比度 | 554 条 / 134 条 / 9 对 | 零缺口 | `check-compliance.js`、`check-terms.js`、`check-contrast.js` |

### 10.2 发布检查 92 项分组（对照 `check-release.js`）

| 组 | 内容 | 关键断言 |
|---|---|---|
| 1 | 交付文件完整性 | 27 项最小必需文件存在 |
| 2 | 原画面 100% 保留 | 逐字节复制、指纹可复现、无自绘 Canvas UI、`index.html` 未注入、工作区干净 |
| 3 | 内核稳定性 | 内核单测 / 175 黄金向量 / 10000 场压测 / 协议层测试 |
| 4 / 4b | 内核接入与战法替换 | 战报链路、31 战法、占位 UUID 移除、运行时注入 |
| 5 | 完全离线 | 零外网地址、只监听回环、无 Go+MySQL、导航拦截 |
| 6 | 壳健壮性与存档 | 单实例、日志、隔离、窗口行为、原子写 |
| 7 / 7.7.4 / 7.7.5 | 打包产物、报告自举、报告新鲜度 | exe 存在、报告可自举重算、报告晚于出厂源码 |
| 7.8 | 双态冒烟 | 两态 × 9 项动态断言（含窗口取证） |
| 7.9 / 7.9b / 7.9c / 7.9d | 合规台账、数据溯源、对比度、系统性验收 | 11 项左右（含 60 旬零异常、灭国闭环、真链路、百分制判据） |
| 7.10 / 7.11 | 术语覆盖、真实点击 E2E | 134 条 100% 覆盖；出征 8 环零未捕获异常 |
| 8 | 需用户处理 | 7 项单列，不冒充通过 |

### 10.3 需求验收矩阵（FR → 至少一条自动化证据）

| FR | 主证据 | 辅助证据 |
|---|---|---|
| FR-01 | `p11-session-gate.test.js` | 双态冒烟 window 段 |
| FR-02 | `codec.test.js` / `protocol.test.js` | `contract-matrix.test.js`、`explore-bugs.mjs` |
| FR-03 | `check-release` 7.9d 真链路 | `system-audit.mjs`、`sim-60turns.mjs` |
| FR-04 | `save-slots.test.js` | `protagonist-save.test.js`、`check-release` 第 6 组 |
| FR-05 | `building.test.js` | `bugfix.test.js` |
| FR-06 | `m4-facility-catalog.test.js` | `protocol.test.js`（磨坊） |
| FR-07 | `m2-ledger.test.js` | `WB-06`、`p10-supply.test.js` |
| FR-08 | `p6-city-recruit.test.js` | `m4-system-audit.test.js` |
| FR-09 | `m2-appoint.test.js` | `p10-interior-task.test.js` |
| FR-10 | `p11-levy-and-gates.test.js` | `interaction/state` 同源断言 |
| FR-11 | `m4-general-balance.test.js` | `hero-balance.mjs`、`check-release` 7.9d |
| FR-12 | `m4-protagonist-skill.test.js` | `skills.test.js`、`m3-skills-80.test.js` |
| FR-13 | `m3-heroes-fates.test.js` | `tavern.test.js`、`p10-relation.test.js` |
| FR-14 | `check-release` 7.11 8 环 | `p8-war-panel.test.js`、真鼠标 54×2 |
| FR-15 | `protocol.test.js` 指纹 | `domain-coverage.test.js`、`check-release` 第 3/4 组 |
| FR-16 | `p10-preview-consistency.test.js` | `p10-preview.test.js` |
| FR-17 | `strategy-map.test.js` | `m3-scenarios.test.js`、`strategy-brain.test.js` |
| FR-18 | `p10-supply.test.js` | `m2-army-supply.test.js` |
| FR-19 | `m2-diploma.test.js` | `m2-tension.test.js` |
| FR-20 | `m3-events.test.js` | `check-events.mjs`、`m3-event-ui.test.js` |
| FR-21 | `m4-13-distance-garrison-captives.test.js` | `captive-rules` 同源断言 |
| FR-22 | `m2-failstate.test.js` | `system-audit.mjs` 灭国闭环 |
| FR-23 | `panels.test.js` | `http-endpoints.test.js` |
| FR-24 | `p9-interaction.test.js` | `p10-undo.test.js`、`check-terms.js` |
| FR-25 | `m4-window-behavior.test.js` | `check-release` 7.8 双态窗口取证 |
| FR-26 | `m4-editor.test.js`（入口断言） | 真鼠标 54×2 |
| FR-27 | `m4-editor.test.js` 14 条 | `http-endpoints.test.js` |
| FR-28 | `contract-matrix.test.js` | `http-endpoints.test.js` |
| FR-29 | `m4-a11y.test.js` / `m4-layout.test.js` | `check-contrast.js`、`check-terms.js` |
| FR-30 | `m4-compliance.test.js` | `check-compliance.js`、`compliance-report.js` |
| FR-31 | `reports/release-check.json` | `reports/pack.json`、双态 4 报告 |
| FR-32 | `http-endpoints.test.js` | `gm/board.html` 人工抽查 |

---

## 11. 需求追踪矩阵（FR → 规格 → 设计 → 代码 → 测试）

> 「规格」= GDD / 变更文档；「设计」= 本文配套 SDD 章节；「代码」= 主要实现坐标。任何一行出现「—」即表示追溯断链，必须补齐后才能关闭该需求。

| FR | 规格出处 | SDD 章节 | 主要代码 | 主测试 |
|---|---|---|---|---|
| FR-01 | GDD §10.10 / ARCH §9.16 | §2、§6.1、§9 | `index.js`、`ui-shell.js` | `p11-session-gate` |
| FR-02 | ARCH §2/§4、GDD §11.3 | §3 | `codec.js`、`wsserver.js`、`handlers.js` | `codec/protocol/contract-matrix` |
| FR-03 | GDD §5.1 / ARCH §9.20 | §6.3、§7.1 | `clock.js`、`handlers.settleWorld` | `m4-system-audit`、7.9d |
| FR-04 | GDD §11.4 / ARCH §9.18 | §4.3、§6.7 | `world.js`、`index.js /save/*` | `save-slots` |
| FR-05 | DESIGN-loop | §3.3、§7.4 | `handlers.js nationMap.*` | `building` |
| FR-06 | ARCH §9.26 | §7.9、§6.4 | `facility-catalog.js`、`panels.js` | `m4-facility-catalog` |
| FR-07 | GDD §5.2/§5.10 | §7.2、§7.10 | `economy.js`、`strategy.js` | `m2-ledger`、`WB-06` |
| FR-08 | GDD §5.4 | §7.3 | `city-econ.js` | `p6-city-recruit` |
| FR-09 | GDD §5.4/§5.6 | §7.4 | `interior-task.js`、`appointment.js` | `m2-appoint` |
| FR-10 | GDD §5.5 / ARCH §9.16 | §7.5 | `levy.js` | `p11-levy-and-gates` |
| FR-11 | ARCH §9.24 | §7.6 | `general-stat.js`、`config.js` | `m4-general-balance` |
| FR-12 | ARCH §9.22 / M4-9 文档 | §7.7、§7.8 | `skills.js`、`kernel/`、`battle.js` | `m4-protagonist-skill` |
| FR-13 | GDD §7 | §7.11 | `tavern.js`、`relation.js`、`fate-groups.js` | `m3-heroes-fates` |
| FR-14 | GDD §6/§10.10 / M4-13 文档 | §6.5、§8.2 | `strategy.js`、`march.js` | `p8-war-panel`、7.11 |
| FR-15 | GDD §6.2/§6.3 | §7.7、§10 | `battle-core/`、`kernel/`、`battle.js` | `protocol`、黄金向量 |
| FR-16 | GDD §6.7/§6.8/§11.1 | §6.6、§17 | `previewAssault`、`battle-narrative.js` | `p10-preview*` |
| FR-17 | GDD §4/§12.1 | §4.4、§7.12 | `strategy.js`、`strategy-brain.js` | `strategy-map`、`m3-scenarios` |
| FR-18 | GDD §5.3 | §7.10 | `supply.js`、`march.js` | `p10-supply` |
| FR-19 | GDD §5.8 | §7.9 | `diplomacy.js` | `m2-diploma` |
| FR-20 | GDD §8 | §7.13、§8.3 | `event-dsl.js`、`event-engine.js` | `m3-events`、`check-events` |
| FR-21 | M4-13 文档 / FIELD-CONTRACT §D | §7.11 | `captives.js`、`captive-rules.js` | `m4-13-*` |
| FR-22 | GDD §3.4/§3.5/§9.3 | §7.14、§8.5 | `failstate.js`、`campaign.js` | `m2-failstate` |
| FR-23 | 交互提示词 v2 | §9.2 | `panels.js`、`panels-ui.js` | `panels` |
| FR-24 | 交互提示词 v2 §6.1~6.11 | §9.3、§11 | `interaction.js`、`interaction-ui.js` | `p9-interaction`、`p10-undo` |
| FR-25 | ARCH §9.21 | §9.5、§9.6 | `electron/main.cjs`、`preload.cjs`、`ui-shell.js` | `m4-window-behavior`、7.8 |
| FR-26 | ARCH §9.25（入口补丁） | §9.4 | `interaction-ui.js #slgIxQuick` | `m4-editor` |
| FR-27 | ARCH §9.25 | §6.8、§9.4 | `general-editor.js`、`editor-ui.js` | `m4-editor` |
| FR-28 | ARCH §4 GM 保存 | §4.5 | `gm/overrides.js` | `contract-matrix` |
| FR-29 | GDD §10.1/§10.7/§10.5 | §12 | `interaction-ui.js`、`tools/check-*` | `m4-a11y`、`m4-layout` |
| FR-30 | GDD §10.8 / 合规清单 | §13 | `conf/compliance/*` | `m4-compliance` |
| FR-31 | ARCH §9.19/§9.20 | §14 | `tools/check-release.js`、`smoke.js`、`pack.js` | `release-check.json` |
| FR-32 | —（工程便利） | §3.4、§11 | `index.js /__slg/*` | `http-endpoints` |

---

## 12. 未决问题与风险登记

> 本节是**需求基线的一部分**：凡标「待决」的都不许由实现者自行拍板，必须回到产品决策。历史教训：M4-4 曾把「假阳性」当成设计结论（ARCH §9.20），下结论前必须做「真链路 vs 旧链路」反向对照。

| 编号 | 问题 | 现状 / 证据 | 影响 | 默认处置（未拍板前） |
|---|---|---|---|---|
| `OP-01` | ~~**金币通胀**~~ **已由产品决策关闭** | 真链路 60 旬（5 城挂机）12,371 → 172,501，≈2,690 金/旬恒定线性；扩张后 ≈14,600 金/旬 vs NPC 田赋 600~800 | 中后期经济失去约束 | **2026-11-15 拍板「本版加支出阀门」**：新增 `goldHoardTaxPct=4%/旬` 国库沉淀税，免税额 = 10 旬周转金；只改存量，不动产量/原表/战斗数值，每笔进府库流水。实测末旬 172,501 → 104,130（−42.7%），净增中位 2,690 → 1,366 且逐旬递减。口径见 `GDD §5.10.1`、`FIELD-CONTRACT.md §A` |
| `OP-02` | ~~**军队士气字段缺失**~~ **已由产品决策关闭** | `moraleRout=20` 全仓零消费、`army.drillMorale` 只有 `delete`；实际生效的是城池民心/治安与 `ROUT_RATIO=0.1` 兵力比 | 玩家会误以为存在士气机制；UI 文案「粮尽后每旬士气 −5」与实现不符 | **2026-11-15 拍板「删 knob + 修文案」**：删 `moraleRout`（槽位换给 `goldHoardTaxPct`，参数表仍 30 项），UI 改为与 `supply.js` 同源的「民心 −3、治安 −1，第 3 旬起守军逃散 2%/旬」；GDD §6.6 标注为保留草案、本版不实装。零数值变化 |
| `OP-03` | ~~**内政阈值量纲未同步**~~ **已由产品决策关闭** | 旧 `planTicks` 用 `8600/6800`，官员属性已改 0~100，任何官员都命不中缩短工期分支 | 原本导致委任收益归零 | **2026-11-15 拍板「按百分制校准」**：阈值改 `OFFICER_TICKS_TOP=85 / OFFICER_TICKS_OK=68`（原值 ÷100），只动派生判据、原表逐字不动；`FIELD-CONTRACT.md` 已登记，`p10-interior-task.test.js` 补边界断言 |
| `OP-04` | **主角战法命名不一致** | `conf/campaign/protagonist-skill.json` 名为「坐镇中军」，`ARCHITECTURE.md §9.22` 记为「后世之识」 | 文档与 UI 文案对不上 | 一律以 `cfgId 19001` 为唯一引用键；命名待产品统一后一次性改 |
| `OP-05` | **文档数字漂移** | GDD §0.2 写「战法 51 / 术语 67 / 测试 38」、§11.7 写「70 项」，README 写「471 条 / 70 文件」；实测 177 / 134 / 73 文件 / 92 项 | 读者误判交付范围 | 本文与 SDD 统一采用实测运行时口径；GDD 追加「附录 D 基线校准」保留历史快照，不静默改正文 |
| `OP-06` | **`world.js ↔ strategy.js` 环依赖** | 静态 import 图存在 3 条环（详见 SDD §5.3），与 ARCH §5「领域模块不互相 import」冲突 | 增加重构风险，但不影响当前运行 | 登记为架构债，不在本版重构；新增模块继续遵守零环纪律 |
| `OP-07` | **无鉴权的本机接口** | HTTP/WS 均无 token/session 校验，仅靠 `127.0.0.1` 回环 | 若未来端口被复用/转发，存在本机任意页面调用 GM 写入的风险 | 维持现状（单机威胁模型）；**若要开放局域网，必须先补鉴权**（列为阻塞项） |
| `OP-08` | **推演台模块名与 GDD 规划不一致** | GDD §11.1 规划 `domain/battle-preview.js` / `attribution.js` / `battle-preview-ui.js`，实际由 `strategy.js previewAssault` + `battle-narrative.js` 承担 | 文档追溯断链 | 以 SDD §17 登记；不建空壳模块，若后续真拆分再更新 GDD |
| `OP-09` | **`state.seed` 未在 createWorld 写入** | 全代码用 `state.seed ?? 20261110` 兜底，只有工具/测试注入 | 正常游玩的随机序列恒定（可复现但缺变化） | 视为「确定性优先」的当前设计；若要每局不同种子，需先定存档兼容方案 |
| `OP-10` | **7 项 requires_user** | Steamworks 账号费、商店素材、内容分级、第三方换皮、法务版号、代码签名多机实测、SDK 可选 | 阻断正式发行，不阻断本地交付 | 单列在 `reports/release-check.json`，不冒充通过 |

### 12.1 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 并行会话在同一仓库跑验收，互相覆盖 `reports/`、抢 8004/8088 | 中 | 高（假绿/假红） | `SLG_SMOKE_REPORT_DIR` 隔离、核 mtime 与 `startedAt`、只清理自己启动的 PID |
| `web/` 被误改导致发行闸红 | 低 | 高 | 指纹 + `byteIdentical` + 第 2 组静态闸；UI 一律注入 |
| 改内核未回填 TS 源，build 后丢失 | 中 | 高 | 文档红线 + `check-release` 出厂源码清单 + 10 份产物逐字节比对 |
| `overrides.json` 测试污染导致平衡报告 / 发布闸假红 | 中 | 中 | `afterEach` 收敛 + **测试进程用 `SLG_OVERRIDES_FILE` 指向私有副本**（`npm test` 以 `--test-concurrency=4` 并行，`m4-editor` 与 `http-endpoints` 曾抢同一文件，表现为 `482 tests / 1 fail` 而单独重跑 483/483 全绿） |
| 覆盖层写入破坏原表 | 低 | 高 | 形状保护 + 原子写 + 「不写原表」单测 |
| 内容资产被当成史实二次发布 | 中 | 高（合规） | 证据分级 + `caveat` + `provenance.json` + 换皮清单 |
| 玩家找不到功能入口 | 中 | 中 | `#slgIxQuick` 常驻入口 + 真鼠标回归；教训「入口不可见 = 功能不存在」 |

---

## 13. 附录

### 13.1 术语与缩写

| 术语 | 含义 |
|---|---|
| 旬 | 10 游戏日，战略回合的基本节拍（`turnDays=10`） |
| 双账本 | 逐城粮 `cityEcon[id].store` 为实账，国库粮 `resources[faction].grain` 为只读汇总 |
| 过度设施 | 原版 26 项设施中未参与本版本结算的 19 项（M4-12 判定） |
| 三源合一 | 描述 = 计算 = 战报，同一数值只有一个权威源 |
| 出厂源码 | `SHIPPED_DIRS = ['electron','server','conf','kernel']` 中随包发布的代码/配置 |
| 双态 | 源码目录态（`original`）与打包产物态（`packaged`） |
| 黄金向量 | 内核确定性回归的期望输入输出对（175 条） |
| 指纹 | `web/` 文件清单哈希 / `event_fingerprint` / `config_fingerprint` 三类，用途不同 |
| GM 覆盖层 | `conf/campaign/overrides.json`，唯一允许运行时回写的配置 |
| 注入层 | 服务端在 HTTP 响应中追加的浏览器 IIFE 脚本，不改磁盘 |

### 13.2 命令速查

```bash
cd offline
npm install                       # 安装 electron@45.2.3 等依赖
node server/index.js               # 源码态：HTTP 8088 / WS 8004
node electron/main.cjs             # 源码态 Electron 壳
npm test                           # 73 个测试文件
node tools/smoke.js                # 源码态冒烟 33 项
node tools/smoke.js --packaged     # 打包态冒烟 33 项
node tools/ui-audit.js             # UI 全路径审计 72 项
node tools/mouse-playtest.js       # 真鼠标 54 步
node tools/perf-probe.js           # 性能六项
node tools/layout-audit.js         # 布局 5 档 × 4 状态
node tools/check-release.js        # 发行核查 92 项
node tools/pack.js                 # 打包 portable exe + 校验画面指纹
node tools/check-compliance.js     # 数据溯源 554 条
node tools/check-terms.js          # 术语覆盖 134 条
node tools/system-audit.mjs        # 60 旬长时模拟
```

内核单独构建（仓库根 `battle-core/`）：

```bash
cd battle-core
npm run build        # tsc → build/src/*.js + *.d.ts
npm test             # 内核单测 + 黄金向量
# 然后把 build/src/*.js 与 *.d.ts 同步到 offline/kernel/
```

### 13.3 需求状态统计（v1.0）

| 状态 | 组数 | 编号 |
|---|---:|---|
| ✅ 已实现 | 29 | FR-01~FR-15、FR-17~FR-23、FR-25~FR-28、FR-30~FR-32 |
| 🟡 部分实现 | 3 | FR-16（推演台模块划分/odds/逐将 delta）、FR-24（fieldGaps 3 项）、FR-29（键盘 E2E、灰度人工项） |
| 📐 规划中 | 0 | 路线图见 GDD §14，未冒充现行需求 |
| ⛔ 不做 | — | 联网 / 内购 / 云存档 / 18 棋子棋盘 / 手柄 / 移动端（§1.5） |

**非功能需求** 24 条（NFR-01~NFR-24）；**用例** 30 个（UC-01~UC-30）；**业务规则** 200+ 条（R-xx.y）；**验收标准** 120+ 条（AC-xx.y）；**未决问题** 10 项（OP-01~OP-10）。

### 13.4 本文与既有文档的关系图

```text
                 ┌─────────────────────────────┐
                 │  本文 PRD / SRS（需求基线）   │  ← 要不要做、做到什么程度、怎么验
                 └──────────────┬──────────────┘
                                │ 需求编号 FR/NFR/AC
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐      ┌───────────────┐      ┌──────────────────┐
│ GDD 顶配详细设计│      │ ARCHITECTURE  │      │ SDD 详细设计说明书 │
│ 玩法数值权威    │      │ 分层/依赖权威  │      │ 代码事实权威       │
└───────┬───────┘      └───────┬───────┘      └────────┬─────────┘
        │                      │                       │
        └──────────────┬───────┴───────────────────────┘
                       ▼
             ┌───────────────────┐
             │ FIELD-CONTRACT.md │ 玩家可见数值单一权威源
             └───────────────────┘
                       │
                       ▼
        conf/ + server/domain/ + kernel/ + tools/ + tests/
```

### 13.5 维护约定

1. 新增需求：分配新 `FR-xx`（**不复用、不重排编号**），同步 §4 总览表、§10.3 验收矩阵、§11 追踪矩阵、§13.3 统计。
2. 状态从 🟡 转 ✅：必须有新增测试与发布闸证据，并在 §0.4 版本记录追加一行。
3. `OP-xx` 拍板结论写进「默认处置」列并在 GDD / SDD 同步，不删除条目（保留决策痕迹）。
4. 每次基线提交号变更，更新文首「代码基线」并复核 §7 全部数字；数字变化必须写明新旧值与取证命令。
5. 本文入仓即提交，保证 `check-release` 的「工作区干净」硬闸不因文档变红。

---

**文档结束** · 《穿越·汉末》软件需求规格说明书 v1.0 · 2026-11-15

