# SLG 离线单机包《霜寒定九州》（offline-standalone 分支）

> 本分支挂在客户端仓库（slgclient）上，是**三国 SLG 离线单机版**的完整基线。
> 后续开发直接在本分支进行，提交信息以 `offline:` 为前缀。

## 一、这是什么

一款**双击即玩的 Windows 离线单机游戏**，由三部分组装而成：

1. **原版客户端画面** —— 原页游 SLG 的 Cocos Creator 3.4.2 `web-desktop` 构建产物，**磁盘文件逐字节未改动**（画面指纹 `ee987ec2c30a6e99d12f14573d2d39bf1af44b8ff500acc73b0ee826e8150485`，打包时校验 `byteIdentical: true`）；
2. **离线服务端** —— Node.js（ESM）全新实现，替换原 Go 服务端 + MySQL，复刻原版 `{seq,name,msg}` + AES-128-CBC + GZIP 协议；
3. **Electron 壳** —— 把两者打进一个 exe，无外部依赖（不需要 MySQL、不需要 Go、不需要联网）。

战斗使用 **battle-core 确定性内核**（CPython MT19937 随机数复刻、事件流指纹、黄金向量回归），同一场战斗在任何机器上结果一致。

## 二、玩法构成（当前可玩内容）

| 模块 | 现状 |
|---|---|
| **天下沙盘** | 72 城（`conf/campaign/strategy/map.json`，东汉郡县 + 关隘底图），节点/路网/势力归属；另有分层底图与城池详情数据 |
| **回合推进** | 月制回合 `turnDays = 10`；服务端 500ms 时钟定时结算，**「推演一月」原子推进到下一回合日**（不足 10 天会给出「还差 N 天」提示） |
| **编队** | 三军 × 三槽，逐槽配将（同一武将全局唯一）、逐槽征兵；空槽位拒绝征兵 |
| **征兵** | 按兵种消耗木/铁/石/粮/金五种资源，工期压到 **2~30 秒**（`etaSec` 倒计时），资源不足返回错误码 16 并禁用按钮 |
| **出征** | 需相邻城池；可派 `frac`（0<frac≤1）比例的兵力；守军按城等级分档（Lv1≈1032、Lv2≈1810、Lv3 更高），守军将领数按等级 1/2/3；1 级城在兵力 ≥1.25× 时可稳下，边际兵力先推演 |
| **战报** | 所有战斗写入 `state.warReports`（上限 100 条），含双方兵力、逐回合动作、`summary` / `analysis`，UI 可点开复盘 |
| **军情** | 来犯军可见（`threats`），可就地清剿（`strategy.clearThreat`），不再"看不见也清不掉" |
| **战前推演** | 出征面板可「推演一次」：与正式结算同一战斗内核、同一守军构造、同一战斗种子，只读沙盒不耗粮不动兵，可反复推演换比例；给折损/歼敌/回合/兵种克制归因与失效条件 |
| **内政任务状** | 开垦/招商/募兵/修城改为任务对象（执行武将 + 开工回合 + 每旬增量 + 预计完工），好官只缩短工期不改总产出；可撤销（已投入不退），城陷自动取消 |
| **粮道** | 沿己方城 + 未封锁关隘 BFS 到都城；断粮每旬民心 −3、治安 −1、守军逃散 2%、粮产 ×0.55，出征面板与透镜都能看到断粮预警 |
| **相性与关系网** | 相性 1~149 环形（势力锚点 ±12），义理 = 政治×0.6+魅力×0.4；登庸成功率拆成「基础/政治/相性/义理/三顾」构成条，与掷骰同源 |
| **序章章节** | 40 日主线（`conf/campaign/chapter1.json`），结局后 `fired` 冻结、不再错误推进；首页提供「重开一局」（`POST /__slg/restart`） |
| **招贤 / 武将** | 招贤返回明确原因（`no_guest` / `not_enough_gold`）+ 今日名单时段状态；武将面板、战法装配、名将替身 |
| **战法** | **80 条**（主线 31 条真实片段 `conf/skills.json` 可溯源 + 库 20 条原创去重 + M3-8 新机制组合 29 条 `conf/library-skills-extra.json` 逐条对照内核生效面；运行时另含主角专属共 81），四类战法 + 10 级数值成长，描述=计算 |
| **经济** | 产量三段合成（基础 + 设施 + 领地）、政令恢复、征收限额与 CD、集市转换、要塞建造/升级/拆除（有消耗有工期），满仓给出「已满仓」提示 |
| **六面板（P0 原型）** | 右上角「六府」折叠按钮（默认收起，点开竖排六页）：武将四页签 / 战略决策台 / 内政委任台 / 府库分类账 / 兵刃四槽 / 战法库全库＋配方；独立模块注入，`server/skills.js` 零改动；战略台与战略层同源数据（72 城实时守军 / 行军可达 / 关隘 / 战役意图 / 出征账） |
| **事件史** | 保留 200 条（原 50 条滚动会丢历史），带 `day`，攻陷文案写作「自XX手中攻陷XX」 |

## 三、目录结构

```
offline/
├── server/              离线服务端（Node.js ESM）
│   ├── index.js           HTTP/WS 入口、静态资源、世界时钟定时器、/__slg/* 管理口
│   ├── handlers.js        消息路由与全部 handler（保持变薄，逻辑下沉 domain/）
│   ├── world.js           世界状态、初始城池/领地/武将/战法装配、存档归一化与兼容
│   ├── battle.js          战斗结算（内核接入 + 动画数据 + 战报）
│   ├── skills.js          运行时资源注入 + 战略层/战斗动画/城池窗口 DOM 覆盖层
│   ├── config.js          配置加载（原版 json 全量 + facility 等级表）
│   ├── codec.js           协议加解密（AES-128-CBC + GZIP，与原版一致）
│   ├── clock.js           世界时钟（realMsPerDay=60000，scale 1/4，单次最多推 40 天）
│   ├── kernel.js          battle-core 接入
│   ├── wsserver.js        WebSocket 服务
│   ├── gm/                GM 覆盖层（只写 overrides，不动原配置）
│   └── domain/            领域模块
│       ├── strategy.js      战略层：回合、守军分档、编队、征兵、出征结算、来犯军、战前推演
│       ├── interior-task.js 内政任务状（执行武将/开工回合/每旬增量/预计完工/撤销）
│       ├── supply.js        粮道 BFS 连通判定与断粮旬罚（民心/治安/逃兵/粮产）
│       ├── relation.js      相性(1~149 环形)/义理/关系网与登庸成功率构成条
│       ├── map-lod.js       地图标注分级（要城/中城/小城，按缩放取档）
│       ├── strategy-map.js  沙盘地图装配
│       ├── strategy-rng.js  确定性随机（可回放）
│       ├── campaign.js      40 日章节、结局冻结
│       ├── tavern.js        招贤/时段/今日名单
│       ├── economy.js       产量/征收/转换
│       ├── slots.js         武将槽位/天赋
│       ├── dossier.js  people.js  fate.js  chronicle.js  drift.js  story.js
├── kernel/            确定性战斗内核 TS 移植（engine/rules/rng/config/types）
├── conf/              配置数据
│   ├── skills.json      31 条真实战法（battle-kit 原文片段可溯源）
│   ├── library-skills.json      20 条原创库战法（skill-library 去重适配）
│   ├── library-skills-extra.json 29 条 M3-8 新机制组合（内核生效面逐条核对）
│   ├── json/            原版服务端配置副本（地图/建筑/设施/武将/兵种…）
│   └── campaign/        章节、人物、命运、主角、战略层（strategy/map.json 72 城）、heroes-240.json / fate-groups.json / events.json
├── web/               原版客户端构建产物（web-desktop，磁盘逐字节不动）
├── electron/          Electron 壳（main.cjs + smoke.cjs 冒烟）
├── tests/             单测 368 条 / 55 个文件（node --test）
├── tools/             工具链
│   ├── pack.js            打包 exe → build/SLG-Offline-win32-x64/
│   ├── check-release.js   发行核查（75 项硬性验收，含画面指纹、合规台账与真实点击 E2E）
│   ├── compliance-report.js 合规台账三向扫描（覆盖性/禁入物/发行包）
│   ├── smoke.js           运行时冒烟（28 项，源码态 / --packaged 打包态）
│   ├── explore-bugs.mjs   协议穷举探测（73 handler × 5 payload）
│   ├── build-skills.js    战法表生成器（从 battle-kit 原文生成 skills.json）
│   ├── build-heroes.mjs   M3 武将数据层生成器（资料库 CSV → heroes-240.json，六项校验失败即构建失败）
│   ├── build-scenarios.mjs M3 六剧本生成器（史实归属表 → scenarios/*.json，GDD §12.1 四条开局校验）
│   └── check-events.mjs   事件构建期冲突检测（schema/引用有效性/once-flag 一致性/禁入词，默认双文件）
└── package.json
```

## 四、如何运行

### 玩家（成品）
双击 `build/SLG-Offline-win32-x64/SLG-Offline.exe`（`build/` 不入库，需自行打包）。

### 开发者（源码态）
```bash
cd offline
npm install
node server/index.js          # 服务端 127.0.0.1:8088（WS 8004）
node electron/main.cjs        # 或直接跑 Electron 壳
```

### 打包 / 验证
```bash
node tools/pack.js               # 打包 exe（自动拷贝 server/conf/web 进包，并校验画面指纹）
node tools/smoke.js              # 源码态冒烟 28 项
node tools/smoke.js --packaged   # 打包态冒烟 28 项
node tools/check-release.js      # 发行核查 75 项
node tools/compliance-report.js  # 合规扫描（资产台账 / 禁入物 / 发行包）
node --test tests/*.test.js      # 单元测试 331 条
node tools/explore-bugs.mjs      # 协议穷举探测
node tools/build-heroes.mjs      # 重新生成 M3 武将数据层（需外部资料库 characters.csv）
```

> 打包脚本会先清空 `build/SLG-Offline-win32-x64`。若在受限环境里删除被拦截，可先把旧目录改名挪开再打包。

## 五、当前验证状态

- ✅ 画面指纹 `ee987ec2…` 与原版逐字节一致（`pack.json`：`byteIdentical: true`，1582 个文件）
- ✅ 单元测试 **368/368**（含 `tests/panels.test.js` 11 条：六面板回归 + 与战略层的数据／层级对齐断言、`tests/playtest-fixes.test.js` 实机试玩回归、`tests/save-slots.test.js` 存档档位、`tests/m3-heroes-fates.test.js` 7 条：M3 武将数据层与宿命 24 组、`tests/m3-events.test.js` 8 条：事件 DSL/引擎/构建期校验/补量计数、`tests/m3-scenarios.test.js` 7 条：六剧本四条开局校验、`tests/m3-runtime-wiring.test.js` 7 条：M3 运行期接线、`tests/m3-scenario-runtime.test.js` 6 条：六剧本运行期接入、`tests/m3-event-ui.test.js` 3 条：事件弹窗投影与 UI 纪律、`tests/m3-skills-80.test.js` 6 条：M3-8 战法 80 条总量/签名唯一/ui-kernel 同源/内核纪律/武将装配/内核实跑）
- ✅ **M3-1 武将数据层**：`heroes-240.json` 240 位（60 核心 / 100 重要 / 80 在野，源 `three-kingdoms/characters.csv` 确定性选层 + 7 位补充条目）；`fate-groups.json` 宿命 24 组（8 组完整事件链、每组带史实依据与置信度）；`domain/fate-groups.js` 零依赖叶子（active/dormant/broken 三档判定、相性环形距离、登庸相性分项）
- ✅ **M3-2 事件系统**：`domain/event-dsl.js`（字段/算子白名单，未知字段即拒绝）+ `domain/event-engine.js`（priority 降序、每旬 ≤2 条、exclusive 组内只出 1 其余冷却、once 永久排除、效果词白名单落账）+ `events.json` 52 条（37 史实节点 / 9 条件 / 6 关系，全部带史实依据与置信度，待人工签核）+ `tools/check-events.mjs` 构建期冲突检测
- ✅ **M3-7 事件补量至 150 条（GDD §8 上限）**：`events-extra.json` 第二批 98 条（62 史实节点 / 20 条件 / 16 关系），`campaignEvents()` 合并加载、`check-events.mjs` 默认双文件校验（id 跨文件唯一）；剧本前史过滤——剧本起点之前的史实节点不重演（`strategyEventTick` 按 `scenarioYear` 过滤 yearMin）
- ✅ **M3-3 六剧本**：`strategy/scenarios/*.json` 六份（黄巾 184 / 讨董 190 / 官渡 200 / 赤壁 208 / 夷陵 221 / 三分 229），`tools/build-scenarios.mjs` 从史实归属表生成并通过 GDD §12.1 四条开局校验（每城必有主 / 有脑势力 1..12 城 / 玩家势力邻接 ≥2 非己城 / 任意两势力路网连通）；运行期接线属 M3-4
- ✅ **M3-4 运行期接线**：heroes-240 全员入包（`config.js` 并表，包内同名沿用原 cfgId、新武将 240001+ 从五维派生模板，酒馆/出仕池随之扩到 505）；事件系统接线（旬 tick → 冷却/筛选 → `pendingEvents` 队列随视图下发，`/strategy/action eventChoice` 点选落账，效果词 gold/morale/loyalty/attitude/fame 全通）；宿命组合落战斗（队内 ≥2 名同组武将 → 守军折算 ×0.95/组上限 2 组，推演与正式结算同调 `fateComboDefMul`）；外交新增「事件」态度因子与 `adjustAttitudeByEvent` 落账口
- ✅ **M3-5 六剧本运行期接入**：`/strategy/action scenario` 切换剧本（重建归属 + 势力集 + 开局决策伪事件）；`factionConfFor(state)` 剧本势力集整体替换 8 诸侯（局部 id 按 name 从基础诸侯继承 trait/startGenerals）；举义页只出剧本势力卡、`oathFactionOf` 剧本降级链保玩家特技；事件 ctx 年份从剧本起算；`strategyViewState.scenario` 下发激活剧本/清单/开局文案
- ✅ 运行时冒烟 **28/28**（源码态 `reports/smoke-original.json`、打包态 `reports/smoke-packaged.json`，含本城页存档卡 + 六面板逐一点开/零横向溢出/80 条战法获取途径 + 六府入口层级让位与不重叠 + 战略台情报卡可见）
- ✅ 发行核查 **74/75**（含内核黄金向量、协议、画面指纹、合规台账、真实点击 E2E；唯一红项=本批改动未提交）
- ✅ 协议穷举：73 handler × 5 = 365 用例，**0 抛异常**（35 条 "null 字段" 为设计空值：空战法槽、未解锁天赋、未选章节分支、无在店客人）
- ✅ 战争闭环：战前推演 → 出征 → 结算 → 战报入档 → 折叠/回跳复盘。
  **兵力口径（实测 40 个到达日）**：守军 1.46× 兵力 40 胜 0 负、1.17× 为 19 胜 21 负。
  也就是说「≥1.25× 才算兵力占优、0.9~1.25× 胜负参半」这条 UI 口径是**真的**，
  所以边际兵力请先点「战前推演」再决定加兵还是择日——推演与真打逐位一致（同种子）。

## 六、运行时注入说明（重要）

`offline/web/` **磁盘文件一个字节都不改**。所有 UI 扩展都在服务端启动时以字符串形式注入页面：

| 注入源 | 内容 |
|---|---|
| `STRATEGY_OVERLAY_SOURCE`（`server/skills.js`） | 战略层全屏面板：天下沙盘、编队/征兵、招贤、战报、军情、序章 |
| `BATTLE_ANIM_SOURCE` | 战斗过程动画与逐回合动作展示 |
| `CITY_WINDOW_V2_IMPL` | 城池窗口 v2（内政/军务/征兵入口） |
| `PANELS_UI_SOURCE`（`server/panels-ui.js`） | 六面板独立 UI（唯一一份浏览器 IIFE），运行时以 `<script src="/__slg/panels/ui.js">` 挂进 index.html **响应**（磁盘文件不变） |

改完只看服务端即可，不需要重新构建 Cocos 工程；如果哪天真要改客户端资源，必须重新用 Cocos Creator 构建 `web-desktop` 覆盖 `offline/web/`，并重新打包核对指纹（否则 `check-release` 会红）。

## 七、开发约定

1. **客户端画面磁盘文件 100% 不动**——UI 一律走运行时注入；确需改 `web/` 时必须重新构建并更新指纹基线。
2. **协议层不动**——`{seq, name, msg}` + AES-128-CBC + GZIP，`name` 原样回显，`code` 恒 0，格式与原版一致。
3. **GM 改动只写覆盖层**——写入 `overrides`，`conf/json/` 原配置逐字节不动。
4. **`handlers.js` 只许变薄**——领域逻辑放 `server/domain/`，见 `docs/ARCHITECTURE.md`。
5. 提交前必须 `npm test` 全绿；动到 UI/打包再跑 `smoke.js` 与 `check-release.js`。

## 八、已知缺口（六面板 P0 之后）

- **P1 成长闭环**：师承 / 拾遗 / 传承 / 事件战法尚未接实际触发，当前只有「战功研习」与「锻造」可操作；战报残卷尚未按战果自动结算。
- **P2 决策层**：内政三约束目前只显示、不驱动事件；战略台已接战略层实时守军与行军可达，但尚未接出征参数、盟约／背盟预警。
- **P3 叙事与关系**：可逆传承、事件战法、关系网／装备套装未接；天下日志已升级为战役规划脑 + 拟人月志 + 出征账（仍是确定性规则，非模型，见 `../../docs/天下日志-推演实录.md`）。
- **内容**：796 条战法全量还原需原版 `Tcfg_skill` 数据行；当前只接 51 条 battle-kit 原文。
- **架构**：`server/skills.js` 仍承担资源注入与三套 DOM UI；六面板已拆到独立模块，其余待按 `docs/ARCHITECTURE.md` 逐步迁出。

## 九、设计文档

- `../../REPORT.md` —— 项目总报告
- `docs/DESIGN-loop.md` —— 设计基线：经济闭环、演义主线、名将替身、GM 覆盖层、序章 40 日
- `docs/ARCHITECTURE.md` —— 模块分层与依赖方向
- `docs/FEASIBILITY-v1.md` —— 一局完整流程的定义
- `../../docs/体系设计方案-待确认.md` —— 六面板与战法六源的完整设计（8 项决策已按推荐采纳）
- `../../docs/P0原型-验收说明.md` —— P0 可点原型的范围、入口、验收数字与后续阶段
- 与 `docs/DESIGN-loop.md` 冲突时以该文件为准
