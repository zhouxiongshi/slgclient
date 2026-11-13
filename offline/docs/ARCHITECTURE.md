# 《穿越·汉末》模块架构

> 状态：架构基线（2026-11-08），先约束以后的写法，不在这一步搬文件、不改玩法。
> 玩法设计以 `docs/GDD-顶配详细设计.md`（系统 / 数值 / 验收的权威源）为准；`docs/DESIGN-loop.md` 保留为序章循环基线。本文只回答：代码放哪、谁可以调用谁。
> 工程主线：`slgclient/offline/`。

---

## 1. 为什么要先定这个

现在能玩的逻辑几乎都在 `server/handlers.js` 的一个 `switch` 里：资源结算、设施升级、占地、征兵、出征、战报排程、联盟和聊天放在一起。`battle.js` 负责一场战斗，`world.js` 负责存档，`config.js` 负责读表，`codec.js` 负责协议。这个形状能撑住现有循环。

剧情、图纸、替身、GM 若再写进这个 `switch`，天数判断会和产量公式、战报拼装缠在一起。以后改军饷会碰到关羽，改一句台词会碰到行军。模块关系要在写序章之前定死。

定死的方式不是立刻拆成十几个文件，而是：**新代码只许沿下面的方向长；旧的 `handlers.js` 只许变薄，不许变厚。**

---

## 2. 五层，箭头只朝下

```text
表现层     客户端画面、确认框、聊天、GM 页面
              │  只发消息 / 只改覆盖层文件
适配层     协议适配（现有消息名）    GM 适配（编辑覆盖层）
              │  把外部输入变成命令
命令层     唯一允许改世界状态的地方
              │  按命令名字调用下面的模块
领域层     经济  地图  设施  军队  战斗  武将  宿命  剧情
              │  模块之间不互相 import
状态层     世界存档    原版配置 + 覆盖层    游戏时钟
              │
内核       battle-core（只有部队、战法、随机数，没有地图和剧情）
```

上层可以调用下层。下层不知道上层的存在。同一层的领域模块不互相调用，需要协作时，把事情交回命令层。

---

## 3. 每个模块只回答一个问题

| 模块 | 只回答 | 可以读 | 不许做 |
|---|---|---|---|
| 时钟 | 现在是第几游戏日，倍速是多少 | 真实时间 | 扣粮、触发剧情、改坐标 |
| 存档 | 这份状态怎么读、怎么写、怎么从旧版本补字段 | 整份存档 | 结算产量、判断胜负 |
| 配置 | 原表加上覆盖层之后，这一格、这栋设施、这条剧情的数据是什么 | `conf/json/` 与 `conf/campaign/` | 写原表、改存档 |
| 经济 | 这段游戏日里资源变多少 | 产量、设施等级、图纸加成、兵力、军饷系数 | 刷黄巾、发武将、算伤害 |
| 地图 | 这一格是谁的，扫描这块区域返回哪些城、地、军 | 建筑和军队的坐标 | 产量公式、对话选项 |
| 设施 | 这座设施现在几级、升级何时完成 | 设施配置和截止时间 | 决定哪张图纸能不能换 |
| 军队 | 这支队伍谁在带、兵多少、何时走到 | 编制、征兵、行军起止 | 战斗公式、剧情标记 |
| 战斗 | 给定双方，战报是什么 | 已经组好的双方、战法表、内核 | 占领土地、改名册、读剧情 |
| 武将 | 名册里有谁，技能怎么装 | 武将数组 | 他在不在蜀汉宿命里，也不写悼词 |
| 人物 | 性情、欲求、底线、口吻、正史短评 | 人物配置 | 改偏离条、改存档 |
| 偏离 | 蝴蝶进度现在是多少，落在旧史、偏移还是改写 | 已入账的偏离事件 | 自己改地图、自己换台词 |
| 履历 | 这个人死时，正史轨迹和本局轨迹各写什么 | 正史短评、死亡事实、当时的偏离段 | 重算战斗、重算产量 |
| 宿命 | 这个历史人物现在是在册、归玩家、替身在岗，还是断链；这一站该写谁的名字 | 宿命表和人物标记 | 坐标、资源、伤害数字 |
| 剧情 | 今天有没有事件到期；按偏离段选哪一稿；列出要执行的命令 | 游戏日、标记、偏离段、宿命给出的「谁上场」 | 直接改 `roleRes`、直接调用战斗内核、自己累加进度条 |
| 章节 | 序章的事件表、系数、文案 | JSON | 把「第 20 日借粮」写成散落的 `if` |
| 协议适配 | 客户端的 `{name, msg}` 对应哪条命令，回复和推送长什么样 | 命令的结果 | 业务公式 |
| GM | 作者改了哪一格、哪一句、哪个系数 | 配置和覆盖层 | 被经济或战斗 import |
| 客户端 | 把推送画出来，把点击变成消息 | 协议字段 | 自己算产量、自己判宿命 |

客户端内部保持它已经有的三层，不和服务器模块混名：

- **Command** 发请求、收消息。
- **Proxy** 记住这份数据。
- **Logic** 只画控件。序章的借粮框是 Logic：显示两句文案，把确认或取消发回去。它不知道军饷公式，也不知道陆昭。

---

## 4. 两条主路径

### 玩家点一下

```text
确认框「借粮」
  → 协议 campaign.choose
  → 命令 Choose
       → 剧情核对这一日确实在等这个选择
       → 命令 SpendGrain   （经济改粮）
       → 命令 GrantGeneral （武将入册）
       → 命令 SetFlag      （下一波兵力系数写进标记）
  → 协议把 roleRes.push、general.push、chat.push 推回原界面
```

剧情不自己减粮。经济不自己发武将。协议不自己判断「借粮对不对」。

### 游戏日走到

```text
时钟跨过一日
  → 命令 Accrue     （经济结算日产和军饷）
  → 剧情查询「今日到期的事件」
  → 每条事件变成命令：刷一格守军、写一条聊天、或挂上替身名
  → 若事件要开打：命令 ScheduleBattle
       → 军队提供双方
       → 战斗只返回战报
       → 地图根据战报结果决定这一格归谁
  → 协议推送战报和地块
```

战斗内核始终不知道这是黄巾还是麦城。麦城之所以写「陆昭」，是宿命模块先回答了名字，命令层再把这个名字送进战报。

### GM 保存

```text
GM 页面改一格的类型和等级
  → 只写 conf/campaign/overrides.json
  → 下次读配置时，配置模块把覆盖层叠在原表上
  → 地图和经济读到的已经是叠好的数据
```

GM 不调用地图函数去改内存里的格子。玩法模块里不出现「如果是 GM 则……」。

---

## 5. 不许出现的依赖

| 不许 | 原因 |
|---|---|
| 剧情 import 战斗内核或 `battle.js` | 剧情只发「开打」命令，伤害规则留在战斗 |
| 剧情自己改偏离数值 | 偏离只接受命令 `AddDrift`，避免每个事件各加各的 |
| 经济 import 剧情 | 图纸加成是存档上的一个数，经济只读这个数 |
| 履历 import 战斗或经济 | 履历只读已经记下的死亡事实 |
| 宿命 import 地图或经济 | 宿命只管人在不在链上 |
| 战斗 import GM、剧情、协议 | 同一份输入必须永远得到同一份战报 |
| 领域模块互相 import | 协作一律回到命令层，避免经济↔剧情↔战斗绕成环 |
| 客户端写存档字段或复算军饷 | 画面只显示服务器推来的数 |
| 在 `handlers.js` 里新增天数判断、产量公式、替身分支 | 新规则进对应模块；`handlers.js` 只做消息翻译 |
| 覆盖层写回 `conf/json/` | 原表保持只读，删覆盖层即可还原 |

现有代码里 `battle.js` 会读取世界里的武将来组队。这是历史写法，序章不必为了形式先拆开。新写的剧情和宿命不要再学这个样子去直接翻世界。组队输入由命令层准备好，再交给战斗。

---

## 6. 目标目录（现在不搬）

等序章开始写代码时，新文件按这个位置加。旧文件留在原地，直到对应规则真的迁出为止。

```text
server/
  codec.js  wsserver.js  index.js     适配层里的外壳，保持不动
  config.js                            状态层：原表
  world.js                             状态层：存档
  clock.js                             状态层：游戏日（新）
  command.js                           命令层（新，所有改状态的入口）
  domain/economy.js                    日产、军饷、图纸乘数
  domain/map.js                        格子与扫描
  domain/facility.js                   设施等级与工期
  domain/army.js                       编制、征兵、行军
  domain/battle.js                     由现有 battle.js 逐步成为「只吃双方、只吐战报」
  domain/general.js                    名册
  domain/people.js                     性情与正史短评（只读配置）
  domain/drift.js                      蝴蝶进度 0–100 与三段
  domain/chronicle.js                  身故时的正史轨迹与本局轨迹
  domain/fate.js                       在册 / 归玩家 / 替身 / 断链
  domain/story.js                      按偏离段选稿，输出命令列表
  handlers.js                          瘦成协议适配，不再长公式
  gm/                                  以后的本地编辑页，只写覆盖层
conf/
  json/                                原版，只读
  campaign/chapter1.json               章节表
  campaign/fates.json                  关羽—陆昭这种链
  campaign/people.json                 性情、口吻、正史短评、偏离分值
  campaign/overrides.json              GM 手改
```

客户端仍只改 `runtime` 里的源工程（本分支若只带 `offline/web` 构建产物，改界面时要回到 Cocos 源工程再覆盖 `web/`）。协议信封 `{seq, name, msg}` 不变。

---

## 7. 写每一段代码之前先填的四格

对得上才写，对不上就还没分清模块。

| 格 | 填什么 |
|---|---|
| 属于 | 上表里的一个模块。出现两个模块，就说明它是一条命令，不是一个新函数乱放 |
| 输入 | 读哪些状态，不读哪些 |
| 输出 | 要么是只读结果，要么是一条具名命令的结果。不直接改别人的字段 |
| 测试 | 这个模块自己的测试。经济测试不启动剧情，宿命测试不启动战斗内核，协议测试只断言消息字段 |

序章落地时的顺序也按层来，避免一上来就把七幕写进 `handlers.js`：

1. 时钟和存档字段。
2. 经济的日结算和军饷。
3. 命令 `Accrue`、`ScheduleBattle`，协议仍走现有推送。
4. 剧情只对序章那几日输出命令。
5. 偏离模块先只记分和分段。序章的借粮、胜仗用 `AddDrift` 加个位数，保证进不了偏移段。
6. 履历在有人死亡时记两本轨迹。枪兵的正史是「史无此人」。
7. 宿命模块先空着，用虚构枪兵的「发一名武将」命令即可。关羽链接入时再启用宿命，不改经济和战斗的接口。
8. GM 最后接，而且只写覆盖层。

这样序章、关羽、以后的官渡，走的是同一条命令管道。新增的是章节 JSON 和宿命表，不是一套新的调用关系。

---

## 8. 交互增强层（P9，纯注入，不改原画面）

设计规格《三国SLG交互原型设计提示词》的落地层。原则是**不碰原版 `web/` 磁盘、不改协议、不往 `skills.js` 里塞新逻辑**，全部以独立 IIFE 注入，出问题可以整段摘掉。

```text
index.html 响应末尾追加两个 script
  ├── /__slg/panels/ui.js       六府面板（原有，panels-ui.js）
  └── /__slg/interaction/ui.js  交互增强层（新增，interaction-ui.js）

数据来源只有一个只读端点
  └── GET /__slg/interaction/state
        └── server/domain/interaction.js
              ├── captive-rules.js（招降成功率：描述=计算=预览 同一公式）
              ├── city-econ.js（逐城城库/开发度/灾害风险）
              └── strategy 视图（行军、内政冷却、回合预览）
```

| 文件 | 职责 | 边界 |
|---|---|---|
| `server/interaction-ui.js` | 术语提示（嵌套/锁定/面包屑/Esc 逐级）、离线百科、决策预览、撤销、当前事务·军师建言、就地抽屉、地图六透镜、进度队列、渐进引导、快捷键 | 只读 `window.__slg*` 与 `/__slg/*`，**不 import 任何领域模块**，不写存档 |
| `server/domain/interaction.js` | 把「玩家现在能做什么」聚合成一个只读快照 | 不 import `strategy.js` / `panels.js`（它们成环）；只 import `captive-rules.js` 与 `city-econ.js` |
| `server/domain/captive-rules.js` | 招降成功率与费用，零依赖纯函数 | 服务端结算、面板显示、建言预览三处共用，禁止各算一份 |
| `conf/interaction/terms.json` | 67 条术语的唯一定义（名称/分类/简述/关联/证据级别/source_id/confidence） | 提示框与百科同源；新增术语只改这一份 |

三条硬约束：

1. **逐城经济只从 `state.strategy.cityEcon` 取**。`state.cityEcon` 是历史遗留空对象，取错会让全城显示 0 粮（已在 `tests/p9-interaction.test.js` 锁住）。
2. **服务端不提供的数据必须显式降级**。`interaction/state.fieldGaps` 只列**当前真空**的缺口，前端照实标注，不允许编造。P9 时列的五项里，「相性（含关系网）」「粮道连通」「内政任务状」已在 P10 落地并从此表移除，现存缺口见 §9 与 `interaction.js` 的 `fieldGaps`。
3. **随机必须可复现**。招降、俘虏越狱、探索、出仕、灾害、叛逃统一走 `strategy-rng.js` 的 `rngFor(seed, turn, tag)`；新代码里出现 `Math.random()` 即视为回归。

---

## 9. P10 加的三个叶子模块与两条不变量

P10 新增的领域模块**全部是零环叶子**：只 import 地图/配置/纯函数，**不 import `strategy.js`、`city-econ.js`、`panels.js`**（它们互相已经成环，再挂进来就是把环焊死）。需要写事件时各文件自带 `recordEvent` 副本（写 `state.strategy.events`，上限 480），不为一行日志去反向依赖战略层。

| 文件 | 职责 | 依赖禁令 |
|---|---|---|
| `server/domain/interior-task.js` | 内政任务状：`planTicks`（好官 1 旬 / 中 2 旬 / 差 3 旬）、`beginInteriorTask`、`advanceInteriorTasks`、`cancelInteriorTask` | 不 import `strategy.js`；城池显示名由调用方回写 |
| `server/domain/supply.js` | 粮道 BFS（己方城 + 未封锁关隘 → 都城）、`supplyTick` 断粮旬罚、行军粮估算 | 自带 `cityName`（读 `map.json`），不 import `strategy.js` |
| `server/domain/relation.js` | 相性 1~149 环形、义理、关系网、登庸成功率构成条 | 零依赖纯函数，服务端掷骰 / 面板构成条 / 酒馆来访三处同源 |
| `server/domain/map-lod.js` | 城池标注分级 `cityLabelRank` + 缩放档位 `labelPolicy` | 纯函数；「哪座城算要城」只此一处口径，客户端不再自判 |

两条不变量（改动前先读）：

1. **战斗种子只有一个公式** `battleSeedFor(armyId, x, y, arriveDay)`（`server/battle.js`）。它同时被正式结算与战前推演使用，**不许在别处再拼一个**——旧口径含 `battleLog.length`，导致「预演必错一档」，这是验收 #10 的根因。改这个公式等于改所有战报。
2. **内政只改工期不改产出**。`interior-task.planTicks` 用官员属性决定 1/2/3 旬，总产出恒定（开垦/招商/募兵 +3、修城 +2），否则好官就会变成印钞机。

---

## 9.1 M2-2 双账本与粮道 L2（GDD §5.2/§5.3 落地）

三条只认这里的口径（改动前先读）：

1. **双账本切断写入**：NPC 田赋粮按城写入 `cityEcon.store`（满仓 20000 截断），金上缴国库；
   `resources[faction].grain` 是**只读汇总**（= 己方城库之和），唯一写入口 `refreshGrainSummary`，
   NPC 支出只准走 `spendFactionGrain` / `creditFactionGrain`。玩家侧 `roleRes.grain` 有自己的日产体系，
   属 M3 迁移范围，不许在本批混改。
2. **军级补给线只有 `supplyLineForArmy` 一个判定**（补给节点 = 己方城 store>0；锚点 = 行军行出发城）。
   通畅每旬就地取粮 0.1/兵扣节点城库；断绝第 1 旬警告（带运输队/撤军两个应对）、第 3 旬起逃兵 2%/旬。
   玩家与 NPC 同一入口（§9.4 同函数判据），运输队（kind:'transport'）豁免。
3. **内政 12 类共用一个任务对象**（GDD §5.4）：新增兴学/招抚/屯田/练兵/修路/侦察/离间，
   效果只在 `advanceInteriorTasks` 完工分支结算；练兵充能接 `battle.js` 攻击 +5%
   （`army.drillMorale`，previewAssault 同口径，推演与正式逐位一致）；
   修路写 `st.roadWorks`（`marchPlan` 行军 −1 日，双向，最低 1 日）；
   侦察写 `st.intel`（0 传闻/1 估算/2 精确，张力守恒 #1 的情报底座）；
   离间写敌城 `unrest` + 守军 −3%。招抚 90 日内叛逃概率 ×0.7（`loyaltyTick` 消费 `appeaseUntil`）。

---

## 9.2 M2-4 委任对象化 / 外交 / M2-5 张力守恒（GDD §5.6 / §5.8 / §6.7.1）

| 件 | 口径 |
|---|---|
| `server/domain/appointment.js` | 委任对象化（§5.6）：`appointment = {id, officerId, cityId, goal: develop/recruit/defend/transport, status, blockedReason, lastTaskId}`。**每旬自动派一条真实内政任务**（走 `interior-task.beginInteriorTask`，与手动同源同价同工期）——不做一键结算。缺金 `blocked` 置顶报告、金到位自动续办；失城 `done` + `blockedReason=城失`；取消只停后续派单、在施任务不动（不静默吞钱）。旬界由 `cityEconTick` 调 `appointmentTick`。视图 `appointments`（blocked 置顶）；动作 appoint / cancelAppoint。 |
| `server/domain/diplomacy.js` | 外交（§5.8）：每对势力 `attitude ∈ [-100,100]` = 基础(史实占位哈希) + 履约×5 − 背约×10 + 联姻 15 + 赠礼(200金/1 封顶 30) − 边境摩擦×3(邻接城数封顶 6) + 共同敌人×10 − 占城×20 − 离间失手×15。**factors[] 就是理由链**：任何动作（成败都带）返回 `{text, factors}`，拒绝文案含「未达 N」——没有理由链的外交回复视为 bug。8 动作（7 门槛表 + 赠礼）：停战 90 日（NPC 守约由 `applyOrders` 出征前 `truceActive` 拦截）、通行权、结盟（写 `st.relations` 供 `isAllied`）、联姻、请求攻击（付定金 → `st.diploPrompt` 在 strategyTick 注入一单真实出征）、劝降（兵力比 3:1 + 态度 ≥0，拒绝则开战）、离间（都城情报 ≥估算 + 智力判定，失败 `sowFail` −15）、赠礼。占城登记 `noteCityCaptured`（攻城结算处调用，**归属变更前取旧主**；停战期攻城=毁约记背约）。自包含叶子：自读 conf、邻接自建（复用 marchGraph），只依赖 march/strategy-rng/oath。 |
| M2-5 张力守恒（§6.7.1，在 strategy.js 内） | ① **推演只对已知量精确**：`previewAssault` 按 `st.intel` 档位给守军区间（0 传闻 ±40% / 1 估算 ±15% / 2 精确 ±0），下发 `spreadLines` 最坏/最好两条线 + `intelNote`；推演不写 `st.intel`（不产情报）。② **敌将变招**：`counterVariantFor(state, cityId, arriveDay)`（`rngFor(seed, arriveDay, 'counter')` 三预案 `COUNTER_VARIANTS`：坚守 1.12 / 逆袭 0.88 / 常规 1.0）；defMul 在 `settleArmyBattle` 内与兵种克制**同一处相乘**（战报 dLoss 基线保持 raw 守军数，推演与正式逐位一致——基线错位会直接打挂 p10 一致性测试，踩过）；推演下发 `variantLines` 两条「若敌方变招则…」。③ **确认即锁**：`strategyAttack` 落 `march.lockedSeed`，结算 `mm.lockedSeed ?? battleSeedFor(...)`；推演不限次、确认后只能撤军重来。 |

---

## 9.3 M2-3 参数表 / 失败态 / 结局 / 平衡脚本（GDD §9.2 / §3.4 / §3.5 / §9.5）

| 件 | 口径 |
|---|---|
| `server/domain/knobs.js` | 全局参数表 30 knob（默认 + 允许区间）。读参一律 `knobGet(state, 名)`：存档 `state.knobs` 覆盖 > 默认，越界钳区间。已接线：`turnDays`（strategyTick）、`grainPerSoldierDay`（出征粮 + L2 军粮）、`conscriptGoldPer`（NPC 征兵）、`undoDepth`（interaction 下发）。旧魔法数字改到时切换，新代码必须走这里。 |
| `server/domain/failstate.js` | 失败态四出路（§3.4）：`failstates` 判定（破产/兵尽/无将/都城失陷）+ 出路动作（`disarmForGold` 返 30% 兵值金、`sellGrain` 0.5 金/粮每旬 2000 上限、`emergencyConscript` 民心 −10、雇佣兵 ×3、`makeStandInGeneral` 代将五维 50、`relocateCapital` 保留 50% 资源）。**恢复感原则：每个失败态至少一条出路**。无将不再返回 `no_general`——`strategyAttack` 自动生成代将入空槽。`evaluateEnding`（§3.5）：败亡（零城）/ 统一（全州治+诸侯出局）/ 偏安（脚手架，剧本目标未落地恒 null），结局必须带 5 条关键决定回放。视图下发 `fail` / `ending`；四动作走 `/__slg/strategy/action`（disarm / sellGrain / emergencyConscript / relocateCapital）。 |
| `tools/sim-60turns.mjs` | 平衡脚本（§9.5）：举义世界按真实路径（resolveMarches → cityEconTick → strategyTick）推进 N 旬，逐旬输出城/兵/金/粮；`runSim` / `simHash` 供测试调用，确定性由 tests/m2-failstate 锁（同种子两跑逐旬一致 + NPC 决策聊天逐字一致）。 |
| `electron/ui-audit.cjs` | 真实点击 E2E（GDD §14.2-7）：Electron 里逐页签真点。M2 收官新增「推演→确认→战报」六步链（切城→推演→决策预览→出兵确认→队列→推进→战报），**两层弹窗协议**：出征按钮被交互层 `interceptCosts`（COST_WORDS 捕获阶段）拦截出决策预览（`.slgIx-modal`），确认后 0.9s 自动放行；出兵确认弹窗（`.modal`）的「出征」二字也是成本词，会被**再拦一次**。链路接入 check-release 7.11（审计报告必须存在且全链 ok + 零异常）。 |

### 9.4 E2E 取证机制（M2 收官）

- 错误钩子随服务端注入脚本安装（`index.js` 注入段，`window.__slgErrHookInstalled` 防重）：页面重载后依然活着，抓未捕获异常的**完整栈**；审计/冒烟进程只在钩子缺失时兜底安装，且不清空已有采集。
- 主 bundle 经 `patchClientBundle` 运行时改写后行号会偏移——定位崩溃栈时要用改写后的文本找行（踩过：直接读磁盘 bundle 对不上行号）。
- 已修的上游崩溃：`onCityFacilities` 里 `getMyCityById` 回 null 时直接 `.cityId` 抛 TypeError（登录竞态/异城查询），补丁为空引用整段跳过。原版 `ArmySelectNodeLogic.setData` 也有同款未防护写法，尚未触发，暂不处理。

### 9.5 M3-1 武将数据层与宿命 24 组（GDD §7.1 / §7.5）

- `tools/build-heroes.mjs`：外部资料库 `three-kingdoms/characters.csv`（936 位，仓库外）确定性选层 → `conf/campaign/heroes-240.json` 入仓。分层 60 核心（宿命成员强制 + 高光战法武将 + 均值补足，候选限卒年 ≤281 且非部族首领）/ 100 重要 / 80 在野。资料库缺项走脚本内 `OVERRIDES`（7 位：太史慈/黄盖/孙尚香/甄洛/祝融/蔡文姬/黄月英），这是唯一允许手工加人的地方。
- 字段映射：`yili = 政×0.6+魅×0.4`（复用 `conf/relations.json` 规则）；相性 = 势力锚点 + 名字 FNV-1a 散列 ±12 环形 1..149；兵种适性按五维/籍贯/势力派生（界面须标「本作设定」）。包内已有武将复用原 cfgId，新武将从 240001 起分配。
- `server/domain/fate-groups.js`：零依赖叶子，读 `conf/campaign/fate-groups.json`（24 组，8 组 fullChain 事件链，每组带史实依据与置信度）。`evaluateFates(heroAlive, {heroInCourt})` 回 active/dormant/broken 三档；加成数值由调用方换算（描述=计算=战报同源）。**一人可属多组**（曹操 5 组、赵云 3 组）：`fate` 字段记首个组 id，bonds 全量铺边。
- 测试 `tests/m3-heroes-fates.test.js` 7 条：含子进程重跑 `build-heroes.mjs --check`（V1..V6 校验失败即构建失败）。运行期接线（招募/关系网渲染/宿命加成落战斗）属 M3-4。

### 9.6 M3-2 事件系统（GDD §8.1-§8.3）

- `server/domain/event-dsl.js`（叶子）：条件求值 `evaluateEvent(when, ctx)`。字段白名单 turn/year/season/faction/cityOwned/cityLost/resource/flag/relation/generalAlive/generalDead/generalInTeam/battleLost/battleWon——**未知字段与未知算子一律 throw**（GDD §13.1「事件 DSL 不做通用脚本」的闸门）；比较只走单算子对象 `{">=": 500}`；ctx 全部由调用方注入，本模块不知道 state 形状。
- `server/domain/event-engine.js`（叶子）：`selectEvents(events, ctx, state)` 每旬一次——once 排除 → 冷却排除 → 条件过滤 → priority 降序（同分按 id 字典序，确定性）→ exclusive 组内只出 1（其余冷却 1 旬）→ 每旬最多 2 条。`applyEffects(state, event, choiceId, api)` 效果词白名单（flag/flag-/gold/morale/loyalty/attitude/fame/nothing），落账走调用方注入的 api，选择记录写 `state.events.choices`（结局回放用）。**本模块不掷随机数**。
- `conf/campaign/events.json`：第一批 52 条（37 史实节点 / 9 条件 / 6 关系），城 id 对齐 map.json 72 城、势力 id 对齐 factions.json 8 势力、武将名对齐 heroes-240。`reviewed:false` 表示待人工签核（出戏防线第 4 闸），check-events 只警告不阻塞。
- `tools/check-events.mjs`：构建期校验（失败即构建失败）——schema/引用有效性/资源 kind 白名单/once-flag 一设一清冲突/exclusive 引用完整/禁入词（eval、Function、require 等）。
- **tick 接线待 M3-4**：strategy 旬循环里调 `eventCooldownTick` + `selectEvents`（ctx 适配器从 strategy state 取 turn/year/season/faction/resource/flag/general），弹窗呈现走 interaction 层。当前引擎只被测试与冒烟消费。

### 9.7 M3-3 六剧本城池分配（GDD §4.5 / §12.1）

- `tools/build-scenarios.mjs`：内嵌「史实归属表」（州级基准 + 城级修正）→ 生成 `conf/campaign/strategy/scenarios/*.json` 六份（黄巾 184 / 讨董 190 / 官渡 200 / 赤壁 208 / 夷陵 221 / 三分 229）。**四条开局校验失败即构建失败**：V1 每城必有主；V2 有脑势力 1..12 城（汉廷 han 是无主归集，豁免上限——GDD §12.1 规则 1「无主城默认归汉廷」）；V3 玩家可选势力开局邻接 ≥2 非己方城；V4 任意两势力路网连通（含汉廷，BFS）。
- 剧本 JSON 是自包含的：`factions` 带剧本期人格（如 221 的 sunquan persona 是陆逊、229 的 liubei persona 是诸葛亮）、`cityOwner` 72 城归属、`playerDefault`/`playerOptions`、`opening`（开局三旬必做的决定：grain/siege/ally）、`specialRules`、`source`+`confidence`+`reviewed:false`（出戏防线第 4 闸）。复用既有 8 势力 id（sili/yanzhou/jizhou/youzhou/bingzhou/xuzhou/yangzhou/jingzhou）以便 M3-4 接线时 trait 查找走 factionConf 回退；剧本专属势力（huangjin/sunjian/sunce）为局部 id。
- 踩坑：州级基准整州划给一方极易撞 12 城上限（190 董卓、200 袁绍都曾 21 城）——归属表一律「基准归 han、修正给有脑势力」；92 城 id 键类型是数字，测试里 `delete('72')` 删不掉 Map 数字键。
- **运行期接线待 M3-4**：`ensureStrategy` 初始归属按激活剧本的 `cityOwner` 生成（现在是州→诸侯映射）；`factionConf` 在有剧本时优先用 `scenario.factions`；开局决策弹窗消费 `scenario.opening`。

### 9.8 M3-4 运行期接线（GDD §8.3 / §7.5）

- **heroes-240 入包**（`config.js`）：heroes-240.json 并入 general.list——包内同名/同 cfgId 沿用原条目，新武将（240001+）从五维确定性派生 general.json 形状的模板条目（star 按层 5/4/3、arms 按适性加权取前三、五维×100 映射四维统计）；战法按名字走 hero-skills 表（`world.js innateOf`），无需重复登记。酒馆/出仕池随之扩到 505。
- **事件系统接线**（`strategy.js` M3-4 段）：`strategyEventTick` 每旬一次——冷却递减（引擎落在 `st.eventSys`，与 chronicle 数组 `st.events` 物理分开，避免引擎把数组当事件域改写）→ `selectEvents`（ctx 由 `strategyEventCtx` 适配：turn/year=184+⌊(day−1)/360⌋/season/城归属/资源/flag/关系=同宿命组即 80/胜负窗=`st.battleHistory`）→ `st.pendingEvents` 队列（未决不堆叠）。点选走 `/strategy/action eventChoice`（`strategyEventChoice`），效果词落账：gold→府库、morale→逐城民心、loyalty→全军/最低者/点名、attitude→`diplomacy.adjustAttitudeByEvent`（pairData.eventAdj，attitudeOf 新增「事件」因子）、fame→`st.fame`。
- **宿命组合落战斗**（GDD §7.5）：`fateComboDefMul(state, cfg, army)`——队内 ≥2 名同组武将 → 守军折算 ×0.95/组（上限 2 组）。`settleArmyBattle` 与 `previewAssault` **同调此函数**（与 M2-5 defMul 同一处相乘，dLoss 基线保持 raw），推演 `fateNotes` 与战报 `analysis.fateNotes` 同源。口径：只看队内成员，不查全局生死（战略层尚无武将死亡结算，注释防后来者加戏）。
- **cityLost 口径**：`st.everOwned` 在三处入账（bindPlayerHome / chooseOath 划拨 / 克城），ctx.cityLost() = everOwned − 当前玩家城。胜负窗 `st.battleHistory`（cap 60）由 settleArmyBattle 写。
- 测试 `tests/m3-runtime-wiring.test.js` 7 条。事件弹窗 UI 呈现（interaction 层卡片）见 §9.10。

### 9.9 M3-5 六剧本运行期接入（GDD §12.1）

- **切换**：`strategySetScenario(state, id)`（路由 `/strategy/action scenario`）——校验 id → `state.scenarioId` 置位 → 整删 `state.strategy` 重建归属（新游戏语义）→ 开局决策伪事件进 `pendingEvents`（效果全 nothing，`strategyEventChoice` 从 pendingEvents 现场合成事件对象落账，不查 events.json）。
- **归属**：`ensureStrategy` 新建分支——`state.scenarioId` 在建档前设置时，72 城按剧本 `cityOwner` 落位，`st.scenarioId / st.scenarioYear` 入档。剧本激活且无举义记录时 `bindPlayerHome` 不夺城（剧本城是史实布局，玩家从举义页拿地；基础模式老行为不变）。
- **势力集**：`factionConfFor(state)` 剧本优先——剧本 factions **整体替换** 8 诸侯（NPC 决策/田赋/快照/显示名全走它）；局部 id 缺 trait/startGenerals 时按 name 从基础诸侯继承（`scenarioFactionsEnriched`）。`oath.js` 是防循环叶子，自带剧本目录读取做同款降级（`oathFactionOf` 回退链）。
- **年份**：`strategyEventCtx` 年份基准改 `(st.scenarioYear || 184) + ⌊(day−1)/360⌋`。注意：events.json 史实节点用绝对年份条件，非 184 起点的剧本下错位——补量批次再按剧本改写条件。
- 测试 `tests/m3-scenario-runtime.test.js` 6 条（切换/势力集/举义/开局事件/ctx 年份+NPC tick/视图）。

### 9.10 M3-6 事件弹窗卡（GDD §8.3，interaction 层）

- **数据链**：`strategyEventTick` 排队 → `domain/interaction.js` 在聚合返回里加 `pendingEvents` 只读投影（text 归一数组、choices 归一并带 preview；本模块零 IO，点选不在这层落账）→ `interaction-ui.js buildEventCards` 在 `loadState` 后消费。
- **交互协议**：每次只弹第一条（`slgIx-modal slgIxEvent`，`dataset.evtId` 去重；服务端消费后换下一条）；**抉择必答**——点遮罩不关闭、无关闭按钮，Esc 关掉也会在下轮 20s 轮询重弹；点选 POST `/__slg/strategy/action {act:'eventChoice'}`，成功 toast 效果摘要（服务端 `res.applied` 过滤 nothing）并 `loadState()` 拉下一条。
- **两层弹窗协议**：选项按钮带 `data-ix-allow="1"`——事件选项文案（如「征兵讨贼」）会命中 `interceptCosts` 的成本词表，不加会被决策预览二次拦截。
- 测试 `tests/m3-event-ui.test.js` 3 条：聚合投影 shape、UI 静态纪律（含禁 Math.random 查代码行非注释）、opening 伪事件点选入档（`st.eventSys.choices`）。

### 9.11 M3-7 事件补量至 150 条（GDD §8 上限）

- **数据**：`events-extra.json` 第二批 98 条（62 史实节点 / 20 条件 / 16 关系），与 `events.json` 合计恰 150 条。覆盖 184-280 全时序（宛城/虎牢/岘山/水灌下邳/帝号之僭/仓亭/邺城/白狼山/定军山/受禅台/卤城/淮南三叛/甘露之变/六路伐吴等）+ 经营/战争/内政条件层 + 宿命关系层。每条带 `source.id` 与 `confidence`，全部 `reviewed:false` 待签核。
- **加载**：`campaignEvents()` 双文件合并（eventsCache 一次读齐）；`check-events.mjs` 默认校验两文件，id 跨文件唯一、once-flag/exclusive 跨文件查冲突；`--events` 可退回单文件模式。
- **剧本前史过滤**（真口径债修正）：`yearMin` 是下限语义——190 剧本 day=1 时 ctx.year=190，184 黄巾（yearMin 184）会立即触发。`strategyEventTick` 现按 `st.scenarioYear` 过滤：`when.yearMin < scenarioYear` 的史实节点视为前史不重演。条件层（yearMin 无）/关系层不受影响。
- 引用纪律：条件里的武将名一律 ∈ heroes-240（袁谭/袁尚/曹爽/法正/甄洛/曹植不在 240 内——前者删条件字段、后者整条裁掉）。
- 测试 `tests/m3-events.test.js` 新增 1 条：两批合计 150、跨文件 id 唯一、`campaignEvents().length === 150`；`tests/m3-scenario-runtime.test.js` 补断言：221 剧本不得触发 184 黄巾。

### 9.12 M3-8 战法补量至 80 条（GDD §9 / §16）

- **为什么必须扩签名**：主线 31 条已用尽 damage_rates.csv 全部真实片段模式；skill-library 128 条 = 20 种效果签名的改名皮肤（数值全同，build-library-skills.js 去重后 20 条）。新增 29 条全部来自 **patterns.csv（P01~P16）语义内的新机制组合**，cfgId 910100~910128。
- **数据**：`tools/build-library-skills-extra.js` → `conf/library-skills-extra.json`（29 条：主动 12 / 被动 6 / 追击 5 / 指挥 6）。生成器内置自检：签名跨三表唯一（skill_class+prepare+槽序[类型/目标/控制词/增益词/available_round]）、占位对齐、lv1→lv10 双倍成长、概率纪律、效果纪律。
- **内核生效面纪律**（battle-core/src/{rules,engine}.ts 逐条核对，generator 头注有全文）：
  1. BUFF 词不做名字匹配，attacker.buffs 全求和进伤害链——新战法只用「攻击伤害提高/策略攻击伤害提高/防御属性提高」；
  2. DEBUFF 挂到敌方身上后不参与任何结算（既有内核债务）——本批零 DEBUFF；
  3. 控制状态只有「犹豫」真封锁主动——纯控制是空效果，本批控制槽一律伴随伤害，真封锁（犹豫）控制率 ≤0.3；
  4. 追击目标强制普攻目标（nearestFoe 单目标）——追击不做群体；
  5. available_round =「仅前 N 回合可用」真实生效（逆锋决胜/沧海横流/深沟高垒/阵前擂鼓）。
- **内核修复（连带缺陷）**：`engine.ts cast()` 引导战法每回合重复判定/重复 push、`prepare_ready` 释放时再走 prepare 分支 → **准备战法永不释放**（一雷惊蛰同样带病）。修复：引导期间不重复 cast、释放必发（概率在引导开始判定时消耗）。battle-core 37/37 与黄金向量不受影响（向量不含 prepare 事件）。
- **合并点**：`server/skills.js`（运行时表 81=31+1 主角+20+29）、`server/domain/panels.js PANEL_CONF.libExtraSkills`（面板层战法库）、`tools/build-panel-conf.mjs`（配方 51→80 全量重生成）。
- **武将装配**：`build-heroes.mjs` core 60 位每人 ≥2 条 ≤3 条——专属（hero-skills.json）+ 按五维倾向从新池确定性选取（谋士配谋略/治疗、武将配兵刃；fnv1a(名字) 散列，禁随机）+ 五维总和 ≥340 配指挥/被动光环（无专属者兜底凑满 2 条）。important/minor 维持专属 1 条，缺省走 defaultLoadout 全表轮转。
- 测试 `tests/m3-skills-80.test.js` 6 条：总量 80/81 口径、签名全局唯一、ui-kernel 同源（占位/双倍成长/目标映射）、内核纪律、装配有效性（core 全覆盖 + 引用零无效 + 新池使用 ≥15 条）、内核实跑（prepare/治疗/犹豫控制/被动/光环五类事件 + 同种子指纹）。连带更新 `tests/skills.test.js`（名录白名单加 skill-library-extra）、`tests/panels.test.js` / `tests/http-endpoints.test.js`（配方库 51→80）、`electron/smoke.cjs`（战法库 51→80）。

### 9.13 M4-1 数据溯源合规扫描（GDD §10.8 / 验收 G5、G6）

- **定位**：与 `tools/compliance-report.js`（素材台账 + 禁入物）互补——本工具管**数据条目级溯源**。`tools/check-compliance.js` 扫描 554 条（事件 150 / 宿命 24 / 武将 240 / 剧本 6 / 术语 134），输出 `reports/data-provenance.json`，缺口 exit 1。
- **溯源口径**：source + confidence（高/中/低），事件与宿命用 `{id, confidence}` 对象；武将 `source={ref, level, dbRow, override, confidence}`（史实→高、虚构/传说→低，confidence=高 必须.level=史实——口径矛盾也抓）；剧本顶层 `source` 字符串 + `confidence` + `reviewed:false`（人工签核闸）；术语表每条 `数值来源` 非空数组。
- **地图声明（§10.8 双向核对）**：`conf/compliance/map-declaration.json` 登记 type=schematic_projection + statement；`server/skills.js` 战略覆盖层图例真实渲染「本图为游戏示意图（等距圆柱投影），非标准行政地图。」——扫描器同时查两处，登记未渲染或渲染未登记都算缺口。
- **测试钩子**：`COMPLIANCE_ROOT` 环境变量可把扫描器指到临时最小 conf 结构，负例测试不碰真实文件。
- **check-release 7.9b**：两项新检查（溯源无缺口且 ≥500 条、地图声明登记且 UI 渲染），未通过不得发布。
- 测试 `tests/m4-compliance.test.js` 4 条：全量 exit 0 / 武将口径分布（高 233 + 低 7）/ 声明双向存在 / 负例精确抓出 exit 1。

### 9.14 M4-2 无障碍与表现档位（GDD §10.7 / 验收 G1-G4）

- **字号三档制**：`interaction-ui.js` 的 fontScale 从 ±10 连续缩放（80~150，无法验收）改为 **3 档**（小 85 / 中 100 / 大 120），设置面板单按钮循环切换；旧存档的连续值在初始化时归档到最近档。**陷阱记录**：FONT_TIERS 必须定义在 IIFE 顶部（var 不提升赋值，初始化 try 块在 section 11 之前就要归档）。
- **G4 无鼠标出征**：`war: 'w'` 快捷键触发战略层 dock 出征按钮（`slgBtnWar.click()`）；出征窗内是原生 select/button，Tab+方向键+Enter 即可走完一次出征；`button:focus-visible` 金色轮廓已在（焦点可见）。
- **G1 跳过动画不影响结算**：本作战斗「先算后演」——战报渲染（renderReportsInto）只读协议 `war.report` 的服务端结算结果，UI 层不掷骰不复算（断言渲染函数体无 runBattle/Math.random）。
- **G2 关闭音效不丢失信息**：本作预算内音效未实装，三个注入 UI（interaction-ui / skills / panels-ui）断言零 `<audio`/`new Audio`/`.play(`——信息全部文字/图形传递，静音零损失。
- **G3 灰度仍可区分**：粮道断绝带文字标签「断绝 N 日」+ 后果说明（非仅颜色）；军标行军线已走实线/未走 `setLineDash` 虚线（形状双编码）；减少动效开关（`.reduce` 强制 `transition:none!important;animation:none!important`）延续 P9。
- 测试 `tests/m4-a11y.test.js` 5 条：三档定义位置+归档+循环、G4 快捷键链+原生控件+焦点可见、G1 战报数据源纯只读、G2 三文件零 Audio、G3 文字标签+虚线+减少动效。静态断言一律剥注释行后匹配（防字样撞注释）。

### 9.15 M4-3 布局矩阵与对比度（GDD §10.1 / §10.7）

- **对比度检测 `tools/check-contrast.js`**：9 对注入 UI 色彩（正文/标题/次级/金强调/来源绿/暖警示/成功/失败 × 两级面板底）按 WCAG 相对亮度公式实测——全部达标，最低 muted 灰 6.82:1（要求 4.5）。半透明前景/面板底先 alpha 合成到近似场景底 #0d0f0a 再算（从严）。报告 reports/contrast.json，不达标 exit 1；check-release 7.9c 一项硬检查。
- **抽屉五档断点**（GDD §10.1 表）：interaction-ui 抽屉从固定 372px 改 CSS media query 五档——≤1279:360 / ≤1365:380 / ≥1920:420 / ≥2560:460 / ≥3440:480（fallback 380）；≥2560 时事务面板加宽 300px。
- **dock 防溢出**（原已达标，断言固化）：战略 overlay 按钮条 `flex-wrap:wrap` + `max-width:calc(100% - 780px)` 右侧资源条让位——窄屏自动换行不溢出。
- **分层口径**：用户字号三档（M4-2，偏好层）× 分辨率断点（本批，布局层）解耦并存，互不覆盖。
- 测试 `tests/m4-layout.test.js` 4 条：对比度工具 exit 0 + 最低 ≥4.5、五档断点存在、dock 结构、两层解耦。坑：测试里 `new URL('.', import.meta.url)` 是当前文件目录不是包根——HERE 要取 `..`。

---

## 10. 文档地图（读哪本、信哪本）

| 文档 | 管什么 | 权威性 |
|---|---|---|
| `docs/GDD-顶配详细设计.md` | 系统怎么运作、数值怎么定、字段契约、验收清单、分阶段实施 | **玩法权威源**（与本文冲突时，代码结构听本文，玩法数值听 GDD） |
| `docs/ARCHITECTURE.md`（本文） | 代码放哪、谁调用谁、依赖禁令 | **架构权威源** |
| `docs/DESIGN-loop.md` | 序章循环（借粮/偏离/宿命）的历史基线 | 局部有效，与 GDD 冲突时以 GDD 为准 |
| `docs/P7-城市纵深与战法距离.md` / `P8-出征面板与试玩修复.md` | 已交付批次的变更记录 | 只作追溯，不作规格 |
| `docs/合规与换皮清单.md` | 素材、地图、命名的合规红线 | **发布前必查** |
| `slgclient-三国SLG交互原型设计提示词.md`（仓库外） | 界面组件行为规格（九要素、46 条验收） | 交互权威源，落地在 `server/interaction-ui.js` |

**新增玩法代码前**：先在本表找到它属于哪本文档，再动手。找不到，说明规格缺失，先补文档——这条比任何编码规范都重要，因为本项目已经出现过「代码与设计各说各话」的返工。
