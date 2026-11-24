# 字段契约（单一权威源）

> 来源：GDD《顶配详细设计》§11.2。**硬规则：界面层只显示不计算。**
> 任何「前端自己也乘一下」的写法一律视为回归——前端复算与服务端口径一旦漂移，
> 「描述 = 计算 = 战报同源」三源合一就破了，玩家看到的数字开始互相矛盾。
>
> 本文是权威登记处：新增对玩家可见的数值前，先在这里登记；改口径前，先改本文再改代码。

## A. 资源与经济

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 金（国库） | `interaction/state.treasury.gold`（底层 `state.strategy.resources[faction].gold`） | 两 | 整数 | ❌ 只能显示 | 顶栏、任务确认、外交 |
| 逐城粮 | `state.strategy.cityEcon[id].store` | 斛 | 整数 | ❌ | 城卡、粮道透镜、出征面板 |
| 全国粮合计 | `interaction/state.treasury.grain`（城库汇总的显示值） | 斛 | 整数 | ❌ | 顶栏（仅显示，禁止参与判定） |
| 城日产金/粮 | `city-econ.js cityYield()`：金 `60 × 开发度/50 × 被围 × 民心`、粮 `38 × 开发度/50 × …`（★ 2026-11-19 上调：旧系数 20/30 下 5 城金产仅 274/旬，不够付 380 的武将旬俸，占城是纯负收益） | 两·斛/日 | 整数（trunc） | ❌ | 城卡经济行 |
| 春征秋收减产 | ★ 2026-11-20：`handlers.js army.conscript` 在春征超兵源上限 50% 时给城打 `cityEcon[id].farmPenaltyYear/Pct`；`cityYield()` 在该年秋季（复用 `levy.seasonOf`，1 年 360 日、90 日一季）粮产 ×(1−Pct/100)，跨年自动失效。旧实现只有 `farmConflictOf` 回包弹 toast、从不落账，玩家看到「秋收 −15%」警告但秋天田赋一分不少 | 斛/日 | 整数 | ❌ | 征兵回包 `farmConflict` 警告、城卡粮产（秋季实测 73→62） |
| 府库上限 | `handlers.totalYield`：有城后 `100000 + 城数×20000 + 仓廪设施`，无城沿用配置 100 万（★ 2026-11-19：旧值固定 100 万，木/铁/石 20 旬内全部封顶，采集失去意义） | 单位 | 整数 | ❌ | 府库条、`applyDays` 截顶 |
| 领地建筑产量 | `handlers.buildYield()`：**举义后不再计入**（`state.oath.done`），序章坞堡阶段照常（★ 2026-11-19：旧实现把坞堡「土地 Lv.7」的 7000 石/日一直发到战略层，实测 10 旬把石头从 1 万顶到 74 万） | 单位/日 | 整数 | ❌ | 物资去向页、序章坞堡面板 |
| 逐旬内政增量 | `interior-task.js taskView().perTick` | 点/旬 | 整数 | ❌ | 内政任务卡 |
| 内政工期档位阈值 | `interior-task.js OFFICER_TICKS_TOP=85 / OFFICER_TICKS_OK=68`（**百分制 0~100**） | 属性点 | 整数 | ❌ | 内政任务卡「预计 N 旬完工」 |
| 物资去处任务工期 | `material-task.js planMaterialTicks()` 复用上档阈值：≥85 → 1 旬、≥68 → 基准（单项 1 旬 / 余料 2 旬）、低于 68 → 基准+1、无人亲办 → 基准×1.5；**只改快慢，不改物资消耗与产出**。到期执行原 `armory.js` 动作，委派时不扣物资 | 旬 | 整数 | ❌ | 城池内页「物资去处」任务队列「第 N 日办结」 |
| 国库沉淀税 | `economy.js applyDays()` 的 `hoardTaxPct`（参数表 `goldHoardTaxPct`，默认 4%/旬）；免税额 = 10 × 每旬金毛产 | 两 | 整数（floor） | ❌ | 府库流水「国库沉淀税」、顶栏金 |
| 城市初始人口 | `conf/campaign/strategy/map.json population`（★ P13 阶梯 ×3~7：≥6 万×3 / ≥3 万×4 / ≥1 万×5 / 其余×7 / 边陲 0 人口显式 3 万）；运行时上限 **100 万**（`city-econ.js` / `interior-task.js`） | 人 | 整数 | ❌ | 城市画像、征兵兵源、城库上限 |
| 城库存粮上限 | `city-econ.js storeCapOf(e)`：`clamp(pop×0.12, 2万, 24万)`（★ P13 随人口缩放，小城与旧值 2 万一致） | 斛 | 整数 | ❌ | 城卡城库行、粮道、运输队 |
| 政策/官员加成 | `panels.js postBonusPct / yieldBonusByResource` | % | 整数 | ❌ | 内政页加成拆解 |
| 月份口径 | **第 N 月 = turn N**（★ 2026-11-16 统一：天下日志 `chronicle[].month`、城池日志 `cityLogs[].month`、事件流 `events[].month`、视图 `strategyViewState().month`、`advanceToNextTurn().month` 同源；turn 0 显示兜底为第 1 月。旧实现城池/事件/财报各处 `turn+1`，比整体日志快一旬） | 月 | 整数 | ❌ | HUD「第 N 月」、天下日志整体/城池/时序/财报、战略台国势 |
| 征兵石耗 | `handlers.js army.conscript` 派生层（★ 2026-11-18）：原表 `cost_stone=0` 不改，派生 `石/兵 = max(5, ⌊铁/兵 ÷2⌋)`（铁 10 → 石 5），显式配置 `cost_stone>0` 时以原表为准；四资源逐项扣、不足整笔拒绝 | 石/兵 | 整数 | ❌ | 征兵成本预览、府库石流水 |
| 一键征满可征数 | ★ 2026-11-19 `handlers.js army.conscriptPreview`，内部 `domain/conscript.js affordableConscript`（二分求最大可征）：与真实征兵共用 `splitEven + conscriptNeed`，含石耗与弓骑倍率。UI 只读 `msg.max/need/perSlot`，**不得自行拼单价** | 丁 | 整数 | ❌ 只能显示 | 征兵页「一键征满（N）」、缺资源提示 |

## B. 战略与行军

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 粮道连通/跳数/里程 | `supply.js supplyMap(state).byCity[id]`（视图 `city.supply`）。★ 2026-11-20：里程沿 path 逐段累加 `detail.json.march.edges[].km`（125 条边全带真实里程），旧版 `routeKm` 用「跳数×100」兜底，出征面板「约 X 里」是假数据（实测一跳真实 206 里却显示 100）；无路网 km 表时仍退回旧兜底 | bool/跳/里 | 整数 | ❌ | 粮道透镜、出征面板、概览 |
| 军级补给线 | `supply.js supplyLineForArmy()`（玩家/NPC 同函数）：补给节点 = 己方城且 `cityEcon[id].store >= 该部队一旬口粮 need`（`grainForTurn = 兵力×0.1×10`）。★ 2026-11-20 收紧：旧版只看 `store>0`，实测节点仅 1 粮、部队需 1000 粮/旬时仍判 `supplyOk=true`，连续 6 旬零逃兵（只扣 6 粮），与「第 3 旬起逃兵 2%」文案矛盾。现在 BFS 跳过不够粮的城找够粮节点，全找不到才走断粮链；第 1 旬警告、第 3 旬起逃兵 2%/旬在 `armySupplyTick()` | 粮/旬 | 整数 | ❌ | 军情推送「补给不足」、行军补给状态 |
| 驻军欠饷逃兵 | ★ 2026-11-20（用户裁决补闭环）：`economy.js applyDays()` 日结算，实付 `pay = min(grain, cost) < cost` 即累计 `roleRes.grainArrearsDays`；**连续欠饷满 30 日（3 旬）起，驻城军（`!army.marchId`）每 10 日逃散 2%**，逃兵后重算 cost，兵力自然收敛到城产粮养得起的规模；粮足即 `arrearsDays=0`、逃兵停止（恢复出口）。旧版粮不够只少扣粮、兵力一分不掉，实测 400 旬长局 14998 兵冻结 150 旬的「僵尸大军」。行军军走 `armySupplyTick` 的城库链，**不受全局池逃兵影响**（避免双重惩罚）。军粮参数 0.1 不变 | 日/%/兵 | 整数 | ❌ 唯一源 `applyDays` | 军饷欠付播报（首次警告/首次逃兵/每 10 旬/恢复）、事件簿留痕、府库军饷流水 |
| 出征耗粮 | `supply.js marchSupplyEstimate()` | 斛/日 | 0.1 | ❌ 必须调同一函数 | 出征面板补给行 |
| 行军总粮耗 | `strategy.js marchGrainCost(state, deploy, days, terrain)` = 实出兵 × 0.1 × 行程日（冬季走河路再乘 `crossRiverWinterCost`）。★ 2026-11-20：`previewAssault` 下发权威 `grainCost` 给界面，推演后定点回填；旧版 `skills.js` 前端自算 `Math.ceil(deploy*0.1)` 漏乘行程天数，实测 20 日行程显示 1000、实扣 20000。未推演时只显示「N 兵 × M 日 × 0.1」规则、不显示假数字 | 斛 | 整数 | ❌ 只能显示（禁前端复算） | 出征概览、确认框、推演卡、出征 toast |
| 行军 ETA | `strategy.js marchPlan()`（`arriveDay`） | 日 | 整数 | ❌ | 队列页、地图箭头 |
| 推演结论 | `strategy.js previewAssault()`（只读沙盒） | — | — | ❌ | 出征面板推演卡 |
| 战斗种子 | `battle.js battleSeedFor(armyId, x, y, arriveDay)` | uint32 | — | ❌ 只有一个公式 | 结算与推演共用 |
| 诸侯守将/名册等级 | `domain/ai-roster.js`（`state.strategy.rosters[fid]`；★ P16 名册优先于旧 hash，`defenseFor` 在 level≥2 城取真实等级/战法，1 级城保留 hash 守 P0-3） | 级 | 整数 | ❌ 只读显示 | 战报守将、遭遇页、天下日志（学战法/升级/招降/挖角/求援文案） |
| 来犯军围城 | `domain/strategy.js assaultEscalationTick()`（★ 2026-11-19 立，★ 2026-11-20 强化）：来犯军出现 **40 日**不清剿 → 目标城 `besieged`（产出减半）。围城每旬：守军按 `clamp(3% + 6%×围攻方兵力占比, 3%, 9%)` 逃散、**民心 −4**（另叠加 `cityDevTick` 的被围 −3，实际约 −7/旬）、治安 −1。**城破两条线**：守军归零，或民心 ≤ 20（城内开门）。**180 日**仍不破则客军粮尽自退；解围补民心 +8。同势力场上至多 2 支。目标城记在 `garrison.targetCity`（★ 2026-11-20：旧版按坐标取最近城，相邻城常围错）。威胁视图唯一源 `domain/threat-view.js threatRows()`（★ 2026-11-20：六府 `panelState.threats` 与沙盘 `strategyViewState.threats` 共用，含 `besieging/daysToSiege/daysToWithdraw/targetName/targetMorale`；旧版六府只留 5 字段致围城预警分支恒 false） | 日/% | 整数 | ❌ | 城卡「被围」标、军情推送（含剩几日围城 / 目标民心）、围城条、六府「边境威胁」 |
| 都城失陷迁都 | `domain/strategy.js rebindCapitalIfLost()`（★ 2026-11-20）：`strategy.playerCity` 一被攻破立即迁到「守军最多的己方城」，并播报；无己方城时不迁（亡国交 failstate）。旧版只在城墙编号失效时重绑，都城丢了 `playerCity` 一直指着敌城 | — | — | ❌ | 迁都推送、天下沙盘「本城」、新武将落城 |
| 部队驻地回收 | `domain/strategy.js rebindArmiesIfStranded()`（★ 2026-11-20）：`army.cityId` 指向的城一旦不再属于玩家，立即把该队（含武将 `cityId`）退回「都城（若在）或守军最多的己方城」并播报。**行军中（有 `marchId`）跳过**——抵达分支自会归位。无己方城时不动（亡国交 failstate）。旧版 `army.cityId` 只在行军抵达的四个分支里赋值，城破后悬空 → 之后每次出征都返回 `not_own_city`，属**永久软锁**（实测主动出征 150 旬、95 次请求全部被拒） | — | — | ❌ | 军情推送「残部退守 X 集结」、出征出发城校验 |
| 沙盘分段目标 | `domain/stage-goals.js STAGE_GOALS`（★ 2026-11-20 从 strategy.js 抽出为叶子，面板与结算同源）：**6 城「立足」/ 10 城「割据」/ 18 城「争雄」/ 22 城「封王」**。达成即发**实际收益**：金 3000/6000/12000/24000、名望 +2/+3/+5/+8、后两档另加帐下编制 +2/+4（`strategy.bonusSeats`）；`strategy.stages[id] = 达成日`。★ 2026-11-20 第三轮：末档原为 30 城，实测任何玩法 400 旬峰值只有 24 城，改为 22 城 | 城 | 整数 | ❌ | 战略页「霸业进程」进度条、里程碑推送、大事记 |
| 沙盘终局 | `domain/stage-goals.js UNIFY_CITIES = 24`（全图 72 城的 1/3；★ 2026-11-20 第三轮：原 45 城实测不可达，会打+会管理的玩家 400 旬峰值 24 城）、`SANDBOX_ENDING = {id:'unify',title:'定鼎'}`：达成即写 `strategy.sandboxEnding = {id,day,turn,cities,generals,battles}`，**只结算一次、不硬中断**，可继续经营。实测第 330 旬 / 24 城触发 | 城 | 整数 | ❌ | 战略页「霸业进程」结局横幅、终局推送 |

## C. 战斗

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 战斗伤害/回合事件 | `battle-core`（TS 内核，`offline/kernel/` 同步产物） | 点 | 整数 | ❌ | 回放、战报、推演 |
| 追击目标/损失 | 内核 `nearestFoe`（并列：普攻按 id、追击按阵列序） | — | — | ❌ | 回放 |
| 归因 | `settleArmyBattle` 的 `attribution/summary` | — | — | ❌ | 战报三句 |
| 城墙耐久上限 | `domain/city-wall.js wallMaxOf()` = `300 + 等级×450 + 城防属性×6`（★ 2026-11-17；1 级城约 1100、3 级约 2100，随城防属性单调） | 点 | 整数 | ❌ | 城池内页「城墙 x/y」、出征推演「城墙」行 |
| 城墙当前耐久 | `state.strategy.cities[id].wallHp`（视图 `cities[].wallHp/wallPct/wallBreached`；旧档缺字段按**完整城墙**，即升级前口径） | 点 | 整数 | ❌ | 城池内页、城池窗副标题、大地图城卡 |
| 攻城伤害（破墙） | `battle.js siegeDamageOf()` = Σ(武将攻城值 × `troopStrikeMul(投入兵力)` × `WALL.siegeK=6`)（★ 2026-11-17；零攻城值/零兵 → 0） | 点/波 | 整数 | ❌ | 战报 summary「城墙 a% → b%」、推演「本波攻城打掉 N」 |
| 守军据城加成 | `city-wall.js wallDefMul()` = `1 + (siegeWallMul−1) × 城墙完好比例`（★ 2026-11-17；满墙 = 旧口径 1.5，破城 = 1.0） | 倍 | 0.01 | ❌ | 战报 siege.defMul、推演「守军据城 ×N」 |
| 破城 | `wallHp` 归零即破：当阵守军再折损 `WALL.breachRout=12%`，城池 `defense`（AI 战力估算口径）−0.12 且**只扣一次**（修回一半以上才复位）；**不改变 judgeBattle 的占城判定** | — | — | ❌ | 战报「城墙已破」、天下日志「城墙崩塌」 |
| 城墙修复 | `strategy.js repairCityWalls()`：未被围的城每旬回 `WALL.repairPerTurn=2%` 上限，被围不修（★ 2026-11-18：**玩家城修复耗石** `WALL.stonePerHp=3` 石/点，石头不足按比例少修、不透支，走 `recordRes` 流水；NPC 城仍自然修复不花玩家石头） | %/旬 | 整数点 | ❌ | 城池内页城墙条（旬结算后变化）、府库石流水 |
| 逐城石产 | `city-econ.js cityYield().extra.stone`（★ 2026-11-18）：`12 + 等级×8 + 城防开发度/50×16`，汇入 `cityLayer().stone` → `playerStockYield`；城防开发度越高石产越高（投石→修城→石产闭环） | 石/日·城 | 整数 | ❌ | 物资去向页「采石」逐城明细 |
| 设施升级成本（★ 2026-11-21 P34） | `config.js facilityUpgradeNeed()` 是唯一派生成本：原表 `facility_*.json` 逐字不动（仍为木/铁/石/粮同量），派生层**删除粮耗**，木/铁/石/政令沿用原表。原料池见底时旧口径连「建集市→兑换粮食」自救链都点不动，实测集市/伐木场全报资源不足 | 木/铁/石 | 整数 | ❌ | 城内设施卡、六府府库页升级按钮与成本 chip |
| 设施升级工期（★ 2026-11-21 P34） | `config.js facilityUpgradeDays()` 把原表 `time`（10/20/30…）按**游戏日**解读；`handlers.js facilityProgress()` 用 `f.up_day + 工期` 判完成，`up_time` 只留作旧协议「升级中」标记；老存档只有秒级 `up_time` 时首次读取把起点迁到当前游戏日，不跳级。`city.facilities` 下发 `nextDays/upgradeRemainDays/upgradeStartDay`，界面只显示「N 日（M 旬）」 | 游戏日 | 整数 | ❌ 只展示 | 设施卡「工期 10 日（1 旬）」「升级中 · 还需 N 日」 |
| 战法加成乘区上限（★ 2026-11-23 P47#8） | `battle-core/src/rules.ts calcDamage()` → `offline/kernel/rules.js` 同源：`one_plus_bonus = min(2.0, 1 + Σ normalizeBonus(term))`。同名战法重复叠加时旧口径可到 6.75×，现统一封顶 2×；`bonus_total` 仍保留原始求和值供审计，不伪造来源。黄金向量最大 1.48×，不受影响 | 倍 | 0.01 | ❌ | 战报伤害拆解、推演 |
| 属性差乘区（★ 2026-11-23 P49 用户裁决） | `rules.attrDeltaFactor()`（TS/Python 参考同源）：`clamp(1 + (攻方属性 − 守方抗性)/span, min, max)`，缺省 `span=100、min=0.5、max=2.0`（`battleConfig().attr_delta` 可调）。物理攻对守方 `defence`、策略攻对守方 `intel`；武将五维百分制（0~100）下满差 → ×2，对标率土 /300 满差口径。用户裁决动机：武将属性对技能伤害的权重必须显著。在 `baseDamage()` 末尾乘入，事件不新增字段 | 倍 | 0.001 | ❌ | 战报 base 拆解、平衡推演 |
| bonus 词条语义分桶（★ 2026-11-23 P49） | `rules.classifyTerm()`（TS/Python 参考同源）：`受到…伤害降低` → 承受者 `damage_reduce` reaction；`受到…伤害提高` → 承受者 `damage_taken_increase` reaction（易伤）；其余词条维持旧口径进攻击方加成链。受伤净修正 = Σ减伤 − Σ易伤，`clamp ±0.9`；事件沿用 `damage_reduce` 字段（负值=易伤放大）。不带「受到」前缀的「攻击伤害降低」等是攻方输出减益，仍走 DEBUFF 负加成 | 比例 | 0.01 | ❌ | 战报减伤/易伤、战法一致性审计 |
| 920 系先天战法 bonus 数值（★ 2026-11-23 P49） | `build-innate-skills.mjs` 历史折半 `b.value/2` 废止；`conf/innate-skills.json` 34 条 920 系 bonus_terms 值 = 描述值（Lv1×等级成长），68 项「描述一半」差异归零。描述层不改 | % | 0.01 | ❌ | 战法描述审计、战斗结算 |
| 镜像层锋矢/犒劳回退（★ 2026-11-23 P49） | `mirror-official-skills.mjs` 新增 skip 规则：官方描述含无「受到」前缀的「伤害降低/伤害提高」且目标非敌军时，映射为 self 会反向作用（audit 判 P1 方向性错误）→ 不镜像，进 skip 台账，回退 `conf/innate-skills.json` 本地语义正确版本。镜像 12→10 条 | 条 | — | ❌ | skill-mirror 台账、战法审计 |
| 兵力压制减伤 | `battle.js suppressionOf(atk, def)`（★ 2026-11-19）：`clamp(0.88 × (1 − 守军/攻军), 0, 0.5)`，守军不占优时不生效；作为攻方**开局常驻 `damage_reduce`** 注入内核（`initial_reactions`），**不写进任何战法 bonus_terms**，不进原表 | 倍（减伤） | 0.01 | ❌ | 战报「攻方减伤」、推演 |
| 出征槽位回填 | `battle.js settleArmyBattle()`：未上阵的槽位（该槽无将）兵力**原样带回**，不记 0（★ 2026-11-19：旧实现记 0，等于出征顺手扔掉 2/3 的兵，战报还把没参战的兵算进折损——实测 4000 兵只有 1333 上阵却报「折损 3141」） | 兵 | 整数 | ❌ | 战报 summary、队伍余兵 |
| 忠诚对战力影响 | `battle.js makeUnit()`：`loyal < 80` 时攻方 `attack_base × (0.88 + loyal/80 × 0.12)`（★ 2026-11-19：此前 `loyal` 只是个 UI 数字，赏赐/忽略都没有反馈） | 倍 | 0.01 | ❌ | 战报、武将面板忠诚提示 |

## D. 人事

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 登庸率 | `relation.js talentRecruitRate()` | % | 整数 | ❌ | 在野名士卡、酒馆、探索 |
| 登庸五分项 | `talentRecruitRate()` 的 `parts` | % | 整数 | ❌ | 构成条（禁前端拆算） |
| 酒馆招募成功率 | 与登庸**同一条公式** `talentRecruitRate()`（★ P13：武将可拒绝；失败不扣金、三顾好感 +1；掷骰 `rngFor(seed, day, draw:城:cfgId:好感)`） | % | 整数 | ❌ | 城内酒馆「登庸 X%」标注、招募 toast |
| 招募指名 | `general.drawGeneral` 带 `cfgId` 时只招该人（★ P13）；不带时沿用「此刻在店」批量口径 | — | — | — | 城内/主城酒馆招募按钮 |
| 招募事件日志 | `drawGeneral` 八类分支（成功/婉拒/离席/未到/不在本城/金不足/座上无人/连抽逐人）全部 `recordEvent`（★ 2026-11-17）；文案与探索登庸同口径，无英文 reason | — | — | ❌ | 事件卡、战略事件流（最近 8 条） |
| 自建武将 | `editorCreate()`：cfgId 从 **890001** 起，写 `overrides.json` generals 段 `__custom__`；`config.js loadConfig` 注入 generalByCfg → 酒馆客池/新开局 `makeGeneral` 自动可见；**初始口径，不写当前存档 state**（★ 2026-11-17 FR-34） | — | — | ❌ | 初始数据编辑器（武将页签） |
| 自建/覆盖战法 | `skill-editor.js`：cfgId 从 **29001** 起（detail_id 9200001+），唯一写入口 `conf/campaign/custom-skills.json`，`skills.js` 五表装载之后合并（同 cfgId/同名覆盖）；保存即 `upsertRuntimeSkill`，UI JsonAsset 与 kernel 同源；编辑器校验与 skill-balance 平衡闸同口径 | — | — | ❌ | 初始数据编辑器（战法页签）、战法面板、内核 |
| 武将战法三槽 | `general-editor.js SKILL_SLOT_KEYS` = `skillCfgId / skillCfgId2 / skillCfgId3`（★ 2026-11-19）：三槽都可编辑，写 `overrides.generals`，同步 `skills[0..2]`；**只改被编辑的那个槽**（未动的槽保留原等级），新开局 `world.innateSlots()` 生效 | — | — | ❌ | 初始数据编辑器（武将页签「战法装配」）、武将详情 |
| 内政经验 | `interior-task.js advanceInteriorTasks()`：每旬 **12 点**给执行武将（`applyGeneralExp`；常量 `INTERIOR_EXP_PER_TICK` 唯一真源，原 5 点约 8 旬一级 → 现约 3~4 旬一级）（★ 2026-11-19 补内政来源，2026-11-22 提速） | 点/旬 | 整数 | ❌ | 武将面板经验条、成长推送 |
| 出征经验 | `battle.js resolveBattle()` → `expByGeneral[g.id] = BATTLE_EXP_PARTICIPATION(20) + round(折损兵 × BATTLE_EXP_PER_LOSS(0.8))`，经 `grantBattleExp()` 单入口入账并同步功勋；原公式仅 `折损×0.5`，低折损仗几乎不成长（★ 2026-11-22） | 点/战 | 整数 | ❌ | 战报升级句、武将面板经验条 |
| 战法三槽回读（★ 2026-11-22） | `config.js loadConfig()` 应用 `overrides.generals` 时把 `skillCfgId/skillCfgId2/skillCfgId3` 一起回读，自定义武将构造也带三槽；修「编辑器写第二槽后重启回显空槽、再改属性清空存档 skills[1..2]」。编辑器仍只改本次编辑的槽，19001 不参与槽同步 | 槽 | 0~3 | ❌ | 初始数据编辑器、武将详情 |
| 汉廷空城扩张（★ 2026-11-22） | `strategy-brain.js workable()` 对 `owner==='han'` 单独减压：门槛 ×0.28、派兵 ×1.6、下限 250（有主城仍 400/×1）；`capitalThreat()` 忽略汉城，开局 8 家中 7 家有扩张目标；`difficultyAi` 首次接入决策脑（只缩放门槛，不碰伤害） | 比值/兵力 | 小数/整数 | ❌ | 战役目标、天下日志出征令 |
| 汉城争夺驰援（★ 2026-11-22） | `strategy.js factionReliefTick()` 把汉廷城也纳入响应：`reliefResponders()` 按 `rngFor(seed,arriveDay,contest:...)` 从接壤诸侯中确定性选争夺者；`RELIEF_MIN_SEND=350`、邻城阈值 `+240`、`wantEach` 乘 `difficultyAi`。援军仍是 `side:'faction',kind:'relief'` 行军实体，到达后并兵入守 | 兵/行军 | 整数 | ❌ | 军情播报、遭遇页守军折算 |
| 战斗回放时间（★ 2026-11-22） | `skills.js BATTLE_ANIM_SOURCE` 统一 `TIME_SCALE=0.7` 与 `nowMs()`：cue、命中特效、粒子、震屏、暂停补偿、进度条共用一条虚拟时钟，整体比旧版慢约 30%；`state.speed` 的 ×1/×2/×4 档保留 | 倍率 | 0.7 | ❌ 只展示 | 战报内嵌画面、全屏回放 |
| 内政推荐一步（★ 2026-11-22） | `skills.js tabInteriorView()` 在治理卡后插入「当前推荐一步」（按农田/市集/兵营/城防/人口短板选，灾情优先赈灾），一键委派；六项委派收进「全部任务」折叠区，「去征兵/去府库」链接集中到推荐卡；拒绝原因统一 `errText()` 中文 | 交互 | — | ❌ 只展示 | 城池内页「内政」页签 |
| 招降率 | `captive-rules.js`（单一公式） | % | 整数 | ❌ | 俘虏面板 |
| 招降失败提示（★ 2026-11-22） | `strategy.js recruitCaptive()` 在 `no_captive/no_gold/refused/escaped` 四个失败分支下发同源中文 `text`（写明姓名、忠诚/越狱、把握、未扣金）；`reason` 仍是内部协议码，不渲染。`panels-ui.js strategyAction()` 优先 `r.text`/`r.hint`，`ACTION_REASON_TEXT` 兜底覆盖四个码，未知原因中文降级，禁止再拼 `'失败：' + reason` | 文 | 中文文本 | ❌ 只展示 | 六府武将页「招降」后的提示 |
| 放归名望 | `captives.js releaseCaptive()`：`state.strategy.fame += FAME_PER_RELEASE(2)`（★ 2026-11-16，取事件系统既有 +1~+4 中位；处斩 −2） | 点 | 整数 | ❌ | 放归 toast、名望显示；消费见下行 |
| 名望→来投率 | `captive-reputation.js defectRate(base,baseFame,releaseFame)`：`rate = min(0.45, 0.03 + baseFame/700 + min(40,releaseFame)/700)`（★ 2026-11-20 修：版图/实力名望 `baseFame = 城数×8 + 帐下武将×2(封顶10) + 魅力/100` **不封顶**；只封顶放归名望 40 点防刷。旧实现把两者相加后一起截断到 40，导致占 5 城就来投率恒 8.71%、扩张零正反馈；实测现为 1城5.39%→5城10.25%→24城31.96%）。旧 `defectRateWithFame(base,fame)` 保留为「仅放归名望」兼容包装 | 小数 | — | ❌ | `strategy.js defectTick()` 在野慕名来投判定 |
| 处斩恶名 | `state.role.infamy += INFAMY_PER_EXECUTE(1)`（★ 2026-11-16，旧实现只写不读；现同步对外态度，见下行） | 笔 | 整数 | ❌ | 处斩 toast |
| 处置对外态度 | `captive-reputation.js`：放归 −5、处斩 −15（董卓 `sili` 豁免）；全部经 `diplomacy.js adjustAttitudeByEvent()` 落 `eventAdj`，理由链标签「事件」，界面只显示不重算 | 点 | 整数 | ❌ | 外交面板态度理由链、劝降/停战门槛 |
| 相性/义理 | `relation.js xiangxingOf/yiliOf` + `conf/relations.json` | 1–149 / 0–100 | 整数 | ❌ | 武将卡、关系 chip |
| 忠诚 | `state.generals[].loyal`（运行期，`city-econ.js loyaltyTick()` 唯一写入口）。★ 2026-11-20 重定口径：**主角不参与**（`isProtagonist` 直接跳过，不衰减/不叛逃/不吃欠饷罚）；委任岗位 **+0.6/旬**（≤100）；未委任向**基线 70** 回落 **−0.3/旬**，已低于基线则 **+0.2** 回血（闲置不清队）；欠饷 **−5**（无下限，破产是真惩罚）；全境任一城民心 < 30 再 **−1**（下限 45）。叛逃掷骰：`< 40` → 10%/旬，`40~55` → 3%/旬；首次跌破 55 给一次「离心」预警。旧口径（未委任 −1/旬无下限）实测会清空全队，含主角 | 0–100 | 0.1 | ❌ | 武将卡忠诚色条、离心预警、赏赐按钮 |
| 帐下编制 | `city-econ.js generalCapacity(state) = max(4, 4 + 己方城数×2 + strategy.bonusSeats)`（★ 2026-11-20）。编制满则 `strategy.defectTick` 不再有「名士来投」（名声公式里的「帐下武将×2」封顶 10，掐掉「人越多来投越快」的正反馈）；**招降（花钱）不受此限**——钱可以买到编制外的人 | 人 | 整数 | ❌ | 战略页「帐下武将 x/y」、来投判定 |
| 旬俸合计 | `city-econ.js salaryDueOf(state) = Σ 20 × star`（★ 2026-11-20 上屏）：面板显示值与 `loyaltyTick` 实际扣款同源 | 金/旬 | 整数 | ❌ | 战略页「旬俸合计」、府库流水「武将旬俸」 |
| 势力动态 | `strategy.recordEvent(state, text, {quiet:true})` → `strategy.dynamics`（上限 120 条，★ 2026-11-20）。NPC 官阶晋升／习得战法／积功升级／登庸／按兵／招降／挖角（非玩家）等**背景音**走此通道，不再挤占 `strategy.events`（上限 480 条）的玩家军情流 | — | — | ❌ | 战略页「势力动态」栏（近 8 条）、天下沙盘月报 |
| 战法槽位规则 | `slots.js slotBlock()`：自带不可替换；**学习槽 Lv5 开**；觉醒槽 Lv10 且自带 10 级 | 级 | 整数 | ❌ | 武将战法页、六府装配 |
| 战法装配上限 | `conf/skills.json` 原表 `ui.limit`（可研习 80 条分布 **1~6 人**）；协议层 `general.upSkill` 与六府 `learn` 同读此值 | 人 | 整数 | ❌ | 六府装配按钮、limit_reached 回执 |
| 武将升级经验 | `general-progress.js expToAdvance()`：`40 × 当前等级`，经验来自出征折损（`general-progress.js BATTLE_EXP_PER_LOSS = 0.8`，经 `battle.js grantBattleExp()` 入账）与 AI 月度人事（`ai-roster.js` 攻城/守城/内政按功勋发 exp）；玩家与 AI 同口径 | 点 | 整数 | ❌ | 武将卡「经验 x/y」 |
| 武将政治属性 | 第 6 项基础属性，键 `politics`／史载 `five.zheng`，0~100 百分制；`config.js` 归一化写入 `generalByCfg`，取数走 `gameStatOf(cfg,g,'politics')`；所有武将（含主公、官员、AI 名册）初始化即带 | 点 | 整数 | ❌ | 武将卡「政治」、内政官员政治加成、登庸、官职能力 |
| 官职能力加成 | `domain/official-rank.js`：功勋 `state.generals[].merit` 与 AI 名册 `generals[].merit` 同源累积，官阶 0~9 由功勋唯一决定；武将官阶越高统帅（defense，即统兵能力）越高，谋臣/政治家官阶越高政治越高；经 `general-stat.js effectiveStatOf` 叠加、封顶 100（不改史载原表） | 级/点 | 整数 | ❌ | 武将卡官阶、统帅/政治有效值、AI 名册 |
| 单槽带兵上限 | `official-rank.js slotCapOf(officer) = 5000 + 官阶×300 + 等级×200`（★ 2026-11-18 扩为「等级+官职」双因子：用户诉求「武将等级和官职决定可配备兵量」；`官阶 = rankOfMerit(merit)` 封顶 9、`等级 = clamp(1..10)`、每级 +200（Lv1 不加）；白身 Lv1=5000、三公 Lv10=9500）；`slotCapForRank(rank)` 保留为「不含等级」的兼容口径（0 阶 5000→9 阶 7700）。`strategyFormup`、出征裁剪、征兵 `army.conscript` 各按该槽武将 `slotCapOf` 取上限，空槽按基础 5000，超出退回驻城 | 兵/槽 | 整数 | ❌ | 编队弹窗逐槽上限、over_cap 动态提示、征兵上限提示 |
| 主公战法发动率 | `conf/campaign/protagonist-skill.json`：指挥战法**发动率恒 100%**（kernel `probability_init = probability_max = 1`，`ui.levels[].probability = 100`）；叙述文案 `开战即发动（发动率 100%）` | % | 整数 | ❌ | 战法面板发动率、推演触发说明 |
| 战法发动率区间 | `tools/skill-balance.mjs planProb()`（★ 2026-11-17 唯一平衡口径）：指挥/被动恒 **100%**；主动/追击按「伤害率越高、发动率越低」反推，Lv1 **30~45%**、Lv10 **32~50%**，且末级 > 首级。旧实现 27 条战法清一色 70% | % | 整数 | ❌ | 战法面板「发动率」、`tests/skill-balance.test.js` |
| 战法期望输出指数 | `tools/skill-balance.mjs`：`发动次数 × 发动率(Lv10) × 伤害率(Lv10) × 目标数`。主动/追击收敛在 **300~2000**（每目标 200~950）；指挥为功能型不强求下界，但 ≤2000 | 点 | 整数 | ❌ | 战法平衡验收、`tests/skill-balance.test.js` |
| 主公战法回击率 | 自身受击时的回击概率：Lv1=35%，每升 1 级 +5%（`ui.levels[].effect_value[1]` = 35+5×(lv−1)，kernel counter.chance 同源）；回击伤害率恒 87% | % | 整数 | ❌ | 战法面板效果是、战报「受击回击」 |
| E0 控制命中率 | `skills.js kernelSkillAt()` E0 分支：`control_probability = min(1, 原表 Lv1 命中率 × (本等级 effect_value / Lv1 effect_value))`；即 Lv10 = Lv1×2（≤100%），与编辑器/原版 UI 口径同源；旧固定值不成长已废止 | % 小数 | 0.01 | ❌ | 控制战法面板、内核控制判定、战报 |
| 同名战法镜像（★ 2026-11-20） | `conf/skill-mirror.json` + `tools/mirror-official-skills.mjs`：本地 176 条逐字匹配官方公开战法库 648 条，**只镜像伤害/治疗/控制/增减益可忠实落地的 12 条**；官方 Lv1→Lv10 百分比线性插十级，发动率区间战法逐级成长、固定发动率战法十级同值；cfgId/detail_id 不变，编辑器覆盖层仍在最后装载。无同名 53 条、含本作内核不支持机制 111 条原样保留并写 skip 台账 | — | — | ❌ 只影响战法表 | 战法面板、战报推演、内核结算、`tests/p30-skill-mirror.test.js` |
| 同名战法成长方向（★ 2026-11-21） | `conf/skill-growth-direction.json` + `tools/sync-growth-direction.mjs`：从官方 Lv1/Lv10 两端文案按关键词提取**真正效果槽**的升降方向（「40% 几率」等释放条件不计入），对 43 条同名战法只改曲线形状：固定发动率→十级同值、区间→按官方端点比例成长、效果槽反向/停滞→按官方方向重设；**保留原 Lv10 终点、cfgId 与内核机制**，被动/指挥恒 100% 不受官方概率字段影响。已镜像 12 条与无同名 53 条不重复处理；装载在镜像层之后、玩家覆盖层之前 | 十级概率 % / 效果值 % | 0.01 | ❌ | 战法面板、内核 `kernelSkillAt`、战报推演、`tests/p31-growth-direction.test.js` |
| 战法描述展示口径（★ 2026-11-21） | `server/skills.js applyRangeNote()`：**只改展示、不改结算**——① 官方镜像百分号写作 `%n%%`，渲染后保留真实 `%`；② 内核 `prepare>0` 时描述前补「N回合准备」，官方文案已写则不重复；③ 描述末尾目标人数改由内核主伤害/治疗效果的 `target_type` 推导，旧 `ui.target` 只作无内核数据时的兜底。编辑器覆盖层仍是最终权威 | 文案 | — | ❌ | 战法面板、六府战法摘要、战报技能名提示、`tests/p32-description-presentation.test.js` |
| 武将人物卡（★ 2026-11-20） | `panels-ui.js heroCardHtml/portraitThumb`：立绘 176×246 主视觉 + 阵营色卡框 + 「史载/本局」印记 + Lv/职业/状态/忠诚胶囊；五维只展示 `lore.historyStats`（0~100），主角无史载显示「—」并在卡内注明「无史载五维、本局数值见属性页」；列表头像 35×47 带边框与选中高亮 | — | — | ❌ | 六府武将页、在野名士预览 |
| 主公初始属性 | `conf/campaign/protagonist.json`：武力 99／谋略 96／统帅(原 defense 键)91／速度 87／政治 93；玩家可见标签「防御」统一改为「统帅」，内部键 `defense` 不变 | 点 | 整数 | ❌ | 武将卡、编辑器（GM）、战报 |
| 招募拒绝台词 | `domain/recruit-refusal.js`：拒绝理由拟人化，按武将性格（莽夫/名将/名士等）与谋略高低选台词，汉末语境；不显示「成功率/概率」数字 | — | — | ❌ 只展示 | 酒馆招募 toast |
| 酒馆在店名单 | `tavern.js guestsNow()` 只返回此刻在店者；界面不再展示「何时到店 / 尚未到店」，不在店武将不出现在酒店 | — | — | ❌ | 城内/主城酒馆名单 |

## E. 交互层（P9/P10 契约延续）

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 决策预览/失败态 | `interaction/state` 聚合端点 | — | — | ❌ | 决策预览卡 |
| 撤销策略 | `interaction/state.undo`（depth/clearOnBattle/clearOnLoad） | 步 | — | ❌ | 注入层撤销栈 |
| 建言/议程 | `interaction/state.agenda` | — | — | ❌ | 当前事务抽屉 |
| 地图标注分级 | `strategy.js` 视图 `cities[].labelRank` + `labelPolicy` | 1–3 | — | ❌ 客户端只取档过滤 | 大地图 |
| 服务端缺失字段 | `interaction/state.fieldGaps` | — | — | — | 显式降级（禁编造） |
| 操作回执（P12） | `notice-bus.js notify()` → `/__slg/session?since=N` → 外壳 `slg:notice` 事件 → 交互层 toast | — | — | ❌ 只展示 | 被原版客户端静默吞掉的操作结果（`general.upSkill/lvSkill/downSkill` 的拒绝与学习成功） |
| 俘虏处置按钮视觉 | `panels-ui.js` `#slgPanelsWin .capbtn` | px / 色值 | 13px；常规 `#e8d7a8` on `#2c2f22`；危险 `#f0b39b` | ❌ 只展示 | 六府武将页「招降／放归／处斩」；小字说明 `#b3a88f` |
| 入门向导（★ 2026-11-18，2026-11-19 修 g3） | `interaction-ui.js GUIDE`（7 关：举义/内政/委任/登庸/出征/粮道/经济），每关「看说明 → 去操作（jumpTo 跳对应面板）→ 我已完成」闭环；g3「探索登庸」必须跳当前城「酒馆」页签，不再跳武将页；可跳过/稍后/按 h 重看，进度存 localStorage | — | — | ❌ 只展示 | 首次进入的分步引导浮窗 `#slgIxGuide` |
| 战场视觉密度（★ 2026-11-19，纯表现） | `skills.js BATTLE_ANIM_SOURCE drawFigure()`：单槽可视兵 = `min(行×列, ceil(剩余/初始 × 96))`，大屏 6×16、小屏 2~3×10；1 个像素兵代表数十~上百人。**只是表现映射，不改 `soldiers` 数值，不参与任何结算** | 像素兵/槽 | 整数 | ❌ 只展示 | 战斗回放、战报内嵌画面 |
| 战斗回放兵力初态/终态（★ 2026-11-20 第七轮修） | `skills.js BATTLE_ANIM_SOURCE createStage()`：`makeUnitState()` 是首帧与重播的唯一初态入口，`cur` 恒取战前 `troops`、`dead=false`；事件流逐击扣减，追击/破城溃散等内核事件外折损在结果横幅前用 `remain` 终态校准。**旧 reset 用战后余兵当初态（`cur=u.remain`），首帧就把败方守军画成 0 兵空阵** | 兵 | 整数 | ❌ 只展示 | 战报内嵌画面、全屏回放 |
| 战斗回放逐击反馈（★ 2026-11-20 第七轮，纯表现） | `skills.js BATTLE_ANIM_SOURCE applyAct()/drawSideTotals()`：每条 `hit` 读 `act.loss` 扣当前兵力，同步写 `lastLoss` / `sideHitLoss`；画面顶部显示双方「当前/战前」总数与 1.3 秒内「−本击折损」，血条右端保留本击数字，命中伴随突进、闪白、冲击环、火花与震屏。0 折损显示「未折卒」而非红色数字；所有数值只读战报脚本，不改 `soldiers`、不参与结算 | 兵 / px | 整数 | ❌ 只展示 | 战报内嵌画面、全屏回放 |
| 出征对阵对齐（★ 2026-11-21 P34，纯表现） | `skills.js warSideHtml()` + `.war-faceoff/.war-side`：遭遇页与战前推演结果均把「我军 / 守军」做成左右等宽、同字号、同基线的对阵卡，阵营色区分攻守；窄屏 ≤760px 自动单列。数值仍只读 `pending[].troops/enemyTroops` 与 `previewAssault` 的 `aTotal/dTotal/aLoss/dLoss`，前端不复算 | 兵 | 整数 | ❌ 只展示 | 出征窗「③ 遭遇」、推演结果卡 |
| 原版战报回合 `d_loss` | `battle.js kernelEventsToRounds()`：`d_loss` 恒为「攻方本回合造成的守军损失」。守军普攻不生成伪攻方 hit；守军战法伤害只写 `d_as[].kill`，不叠加 `d_loss`。守方动作完整记录仍在 `anim.rounds` / `battleLog.events` | 兵 | 整数 | ❌ | 原版战报逐回合文本、`battleLog.reportSkillIds` |
| 武将立绘与技能图标 | `server/portrait-map.json`（构建期由冻结 web/ 的 `card_<cfgId>.png.meta` uuid 生成）→ `/__slg/assets/portraits` → `window.__slgPortraitUrl()`；技能图标为冻结 web/ 的 tactics_1~4。缺失时退文字徽章，绝不显示碎图 | URL | — | ❌ 只展示 | 武将页、征兵槽、出征队伍、战斗将卡 |
| 事件逾期兜底 | `domain/strategy.js strategyEventTick()`：`pendingEvents[].sinceTurn` 距当前 ≥4 旬时自动取最后一个（保守）选项结算并清出队列，避免剧情永久冻结。★ 2026-11-20 第三轮：逾期走 `strategyEventChoice(..., {quiet:true})`，效果与流水照落但**不再另写「事件·抉择」行**；逾期行写明所取选项。旧实现一条未决事件占「触发/抉择/逾期」三行，实测 150 旬 224 行事件日志中 148 行是这种噪音 | 旬 | 整数 | ❌ | 天下日志「事件·逾期」、事件系统继续出队 |
| 事件卡投影新鲜度（★ 2026-11-21 P28） | `interaction-ui.js`：`/__slg/strategy/tick` 成功后立即 `loadState()`，不再等 20 秒轮询；事件点选前用 `fetchJSON(API)` 复核该 id 仍在 `pendingEvents`，过期则换卡并给中文提示；GET/POST 之间恰好被逾期结案时，`no_pending`/`unknown_event` 统一中文降级并刷新，禁把英文 reason 弹给玩家 | 事件 id | 字符串 | ❌ 只展示 | 右下「未决事件 N」、事件卡；服务端仍保守拒绝陈旧点击 |
| 事件全局间隔 | `domain/event-engine.js CONDITION_EVENT_GAP = 4`（★ 2026-11-20 第三轮）：**条件事件（非 `once`）之间至少隔 4 旬**，与每条自身的 `cooldown` 并行生效；`state.events.lastConditionTurn` 记上次触发旬，被间隔挡住的事件**不写单条冷却**（否则越挡越久）。史实节点（`once`）完全不受限——剧情该来就得来。测试可传 `opts.gap:0` 关闭 | 旬 | 整数 | ❌ | 事件触发频率 |
| 劝降兵力比 | `domain/diplomacy.js totalTroops()`（★ 2026-11-20 第三轮）：玩家 = **城池守军 + 在编部队**（`state.armys[].soldiers`），与界面「在编兵力」同源；NPC 仍只算城守军（用 garrisons，无 armys）。旧实现只算城守军，实测带 2 万大军仍判不出 3:1，400 旬劝降 0 次 | 兵 | 整数 | ❌ | 外交面板「我/彼 兵力比」、劝降门槛 |
| 事件冷却 | `domain/event-engine.js selectEvents()`（★ 2026-11-20）：**选中即写 `state.events.cooldown[id]`**——有 `cooldown` 配置按配置（如「流民就食」8 旬），非 `once` 且未配置走默认 **6 旬**；`eventCooldownTick()` 每旬递减。旧实现只在 exclusive 挤掉时写 1 旬冷却，`events.json` 里的 `cooldown` 是死配置，条件长期成立的事件每 4~5 旬重刷（实测 150 旬同一条刷 33 次、连播三行，占 418 条事件流的 96 条） | 旬 | 整数 | ❌ | 事件触发频率、天下日志事件流 |

| 围城损耗幂等键（★ 2026-11-22 P40） | `domain/strategy.js assaultEscalationTick()` 的 `garrison.lastSiegeDrainStep = floor((day - spawnDay) / 10)`：世界定时器每 500ms 调 `settleWorld`，同一天只允许扣一旬兵力/民心；跨步才推进。旧 `day % 10 === 0` 会一天扣 120 次 | 旬步 | 整数（内部） | ❌ | 围城压力、民心、城池归属 |
| 集市兑换流水（★ P40） | `handlers.js interior.transform()`：正负两侧逐条 `recordRes(..., '集市兑换')`，与税赋/招降/缴获同一本 `state.resLedger` | 金/粮/木/铁/石 | 整数 | ✅ 读写 | 府库「钱粮去哪了」 |
| 玩家可见 reason 兜底（★ P40） | `skills.js REASON_TEXT/reasonText()/warReason()`：自立、存档导入读取、出征/撤回未知码一律中文；英文 reason 只留协议与日志。解甲二次确认，征兵 <1 人中文拒绝 | 文案 | 字符串 | ❌ 只展示 | toast / 推演失败卡 |
| 布局双态硬闸（★ P40） | `check-release.js` 7.7.5 + 7.8b：`layout-original.json` 与 `layout-packaged.json` 都要求报告不早于出厂源码与生成工具，且五档分辨率零裁切/零硬问题/零页面异常 | 报告 | JSON | ❌ 只展示 | 发布检查 `release-check.json` |
| 太守制（★ P50，2026-11-23） | `domain/governor.js` 是太守任免/方针/旬界办政的唯一口径。每座己方城一条 `st.governors[cityId]`（officerId/policy/status），玩家可见操作只有「任免太守 + 六方针（太守自决/重农/重商/强兵/固防/安民）」；旬界 `governorTick` 走 `interior-task.beginInteriorTask` 派单——**金、工期、每旬增量与产出总量与旧手动派单逐字同源，零数值改动**。缺金 `blocked` 置顶、金到位自动续办；只赈真实减产（`e.mod.grain<1`，不碰丰收加成）；失城中止。旧 `st.appointments` 一次性迁移（develop→自决/recruit→强兵/defend→固防）。**同时废止**：旧长驻委任（appointment.js）、物资委派任务层（material-task.js）——物资去处回归 armory 即时动作，数值零改动。忠诚联动：太守纳入 `loyaltyTick` 的「委任在岗」集合（+0.6/旬，与六府岗位同口径） | 旬 | — | ❌ 只展示 | 城池内页「太守·方针」卡、六府·内政「天下太守总览」、忠诚旬结 |
| 武将页双栏滚动与批量调防（★ P51，2026-11-24） | 武将页 `.gen-body` 下左列表与右详情各自 `height:100%; overflow-y:auto; overscroll-behavior:contain`，互不带动；render 分栏记忆 scrollTop，换人只重置详情。批量调防走 `strategy.dispatchGenerals`（端点 `dispatchGenerals`）：多选→目标城→一次提交，**只改 `g.cityId`/`g.order` 并从在编队伍摘除，不动兵力、城池归属与岗位委任**；同城/行军中/不在营者跳过并在中文 `text` 写明原因，全体不可调时一人不动。单人调防保留且与批量共用 `dispatchCheck`/`applyDispatch` | 次（瞬发） | — | ❌ 只展示 | 六府·武将左栏批量条、人物卡「所在城」、事件流水 |
| 批量调防弹窗选城与地图联动（★ P52，2026-11-24） | 批量调防不再用 `<select>` 直选城市：点「目的城」或「批量调防」开 `#slgDispatchMask` 弹窗（确认框层 100820），左侧列己方城（州郡/驻军），右侧是与沙盘同坐标系的 2400×1350 小地图——金圈标目的城、浅金点标调出城、虚线标调遣方向；点选时 `window.__slgMapPreviewCity(cityId)` 让底层沙盘同步居中并高亮，**不调用会关闭六府的战报回跳入口**。底部明确写「已选 N 人 → 目的城：X（州）」，确认才走 `dispatchGenerals`；取消回滚本次选择。城市坐标只从 `panelState.strategy.cities[].x/y` 下发用于定位，不参与任何数值 | 次（瞬发） | — | ❌ 只展示 | 六府·武将批量选城弹窗、沙盘定位 |
| 战法描述↔实现一致性裁决（★ P53，2026-11-24） | 审计差异 74→2（剩余 2 项为 P49 锋矢镜像回退的已知数值口径，保留）。**内核补四类可忠实落地的词条语义**：`classifyTerm` 增 `purge`（镇静/净化/驱散→按几率清除自身负面状态）、`attr_bonus`（攻击/防御/谋略属性提高→计入对应属性并参与属性差乘区）、`probability_bonus`（发动率提高→计入战法触发概率）、条件易伤「处于…状态受伤害提高」并入 `damage_taken_increase`；九种负面状态统一单回合阻断/清除（失控类阻主动、怯战/暴走阻普攻）。**文案修正层** `conf/skill-consistency.json` 装在成长层之后、玩家覆盖之前：控制槽「伤害率%n%」改「几率%n%」，删内核无分支的分兵/逃兵/逐次递增/优先行动/两次普攻承诺，buff 的「持续 N 回合」改「整场有效」；「反击」用既有 `counter` 机制接线（`rate_from_ui` 表示 %n% 是反击伤害率，Lv1 37.5%→Lv10 75%，必定反击）。**全部等级数值、effect_value、bonus_terms 不动**，生成物原表不改 | 战斗结算 | — | ❌ 只展示 | 战法详情描述、战报事件（`purge` / `skill_blocked` / `skill_trigger`） |
| 编队同城与一人一队（★ P54，2026-11-24） | `domain/formation.js formationGeneralCheck()` 是唯一资格判据：**武将 `g.cityId` 必须等于队伍/当前城 `cityId`，且不得在另一支队伍**；同队换槽合法，跨队占用直接拒绝（不再静默搬将）；`syncGeneralOrders()` 统一重算派生字段 `g.order`。`army.dispose`（城内征兵页）与 `strategyFormup`（六府整编）共用该判据；`general.myGenerals` 新增可选 `cityId`，征兵页只拿本城候选，武将页不带参仍是全量。界面把「在编 / 他城 / 同弹窗重复」预先禁用，失败 reason 全中文（他城 `general_other_city`、跨队 `in_other_army`）。不动兵力、城池归属与驻地，调防仍只走 `dispatchGeneral(s)` | 次（即时判定） | — | ❌ 只展示 | 征兵页选将下拉、六府整编弹窗、中文拒绝提示 |

## 历史教训（写死，防回归）

1. **逐城经济只能取 `state.strategy.cityEcon`**：`state.cityEcon` 是空的历史对象，
   取错会让全城显示 0 粮（P9 踩过，测试 `p9-interaction.test.js` 已锁）。
2. **战斗种子只有 `battleSeedFor` 一个公式**：旧口径含 `battleLog.length`，导致
   「预演必错一档」（验收 #10 根因）。别处再拼种子 = 改所有战报。
3. **内政只改工期不改产出**：好官缩工期（1/2/3 旬），总产出恒定，否则变印钞机。
4. **撤回/撤销不在前端乐观执行**：批量撤回逐支发请求汇总结果，假批量会让
   退粮数字对不上账。
5. **注入层样式必须在本作用域内定义**：六府窗口是 `#slgPanelsWin`，战法外壳是
   `#slgUIv2`；只在后者定义的 `.ghost` 不能跨作用域复用，否则按钮落回浏览器默认外观。
6. **借鉴来源只留在合规台账，不进界面也不进注释**：玩家可见文案与源码注释都不得写
   外部游戏名、外部名录或内部规格编号；`source`／`descSource`／`LICENSE` 与史书回目
   属于必要溯源，保留。两侧都由 `tests/ui-presentation-hygiene.test.js` 锁定。
7. **城墙修复速度必须低于一波攻城能打掉的比**：`repairPerTurn` 曾设 5%/旬，而单波
   攻城只打掉 12%~15%，一旬修一半、城墙永远打不穿，城防与攻城属性又变回摆设
   （2026-11-17 实测：4 波后城墙回到 86%）。改这个参数前先跑
   `tests/p17-city-wall.test.js` 的「每旬修复」用例。
8. **占城判定不因城墙而变**：破城只影响「下一波更好打」与战报文案，`judgeBattle`
   的 2/1/0 语义与 `ROUT_RATIO` 溃败线不动——否则「首战可胜」等既有验收全部作废。

## P55 队伍权限与城池关系（写死，防回归）

1. **空槽不许带兵**：武将离开槽位（调防/撤将）必须走 `formation.js releaseSlot()` 清兵/清在途/作废令牌并退原驻城；`generals[i]=0 && soldiers[i]>0` 一律是 bug。
2. **行军锁是全入口的**：`assign/dispose/conscript/disarm/disarmForGold/conscript_done` 任一处都不得对 `marchId` 队伍改编制或补兵；出征兵力/军粮按出发快照锁定。
3. **队伍城权**：`army.*` 四个 handler 必须 `isOwnCity(state, army.cityId)`；敌城/失效驻地队伍不得征兵、预览、解甲或出兵。
4. **order 是派生的**：`g.order` 永远由 `syncGeneralOrders` 重算；同城 `(cityId, order)` 唯一，残部重编分配空号；新队 id 不得与老档碰撞（`counters.armyId`）。
5. **调防地图只能是真大地图**：全景底图 `/__slg/strategy/panorama.png` + 全城坐标落点 + 可点选己方城 + 城址搜索；坐标与沙盘同源，不重算任何战力/粮耗。
6. **六府内弹窗层级**：整编/运粮/调防弹窗一律 `z-index:100820`，高于六府窗 100100；低于此值视为遮挡 bug。

## P56 主公归队与队伍解散（写死，防回归）

1. **主公不可消失**：`ensureProtagonist()` 在读档时兜底；现代存档缺人原地补回（不归档整份存档），旧协议 `composeGeneral/convert` 不得把主公当材料，拒绝原因统一中文 `protagonist_locked`。
2. **主公本名可见**：主公不在常规武将配置表，`withGeneralNames`/`panelState.allGenerals`/整编与事件文案统一回退角色昵称（默认「主公」），禁止露出 `武将1000`/`武将880001`。
3. **批量调防不碰主公**：武将页「全选」只选闲置且非主公；主公在别城时，征兵页须显示所在城并提供「主公归队」，仍保留单人调防入口。
4. **解散是独立动作**：`formation.js disbandArmy()` 是唯一口径——逐槽走 `releaseSlot()` 退兵/清在途/作废令牌，武将转闲置（驻地不变），`syncGeneralOrders()` 后从 `state.armys` 删除该队；行军中拒绝。WS `army.disband` 与 HTTP `action:'disbandArmy'` 共用此口径。解散是 P55 城权闸的清理例外：敌城/失效驻地的残部队必须能撤销，兵由 `releaseSlot` 退到玩家主城，不允许借解散动用敌方资源。
5. **不许靠空编队冒充解散**：`strategyFormup` 三槽全 0 仍拒绝（`empty_formup`）；UI 必须提供显式「解散此队」按钮，征兵页与整编弹窗各一处。
6. **4~99 号队伍可管理**：新建队伍仍限 1~3；P55 残部重编生成的既有队号 4~99 必须可见、可撤将、可解散；`army.dispose` 仅对既有队伍放宽。

## P57 同城队号唯一（写死，防回归）

1. **一城一号**：`domain/formation.js normalizeArmyOrders()` 是去重唯一口径，按 `(cityId, order)` 判重；保留先建队伍的原号，重复队伍顺延到首个空号并重算 `g.order`，不动兵力、武将驻地或队伍归属。
2. **两处调用**：`normalizeWorld()` 读档时必跑；`settleWorld()` 在任意 WS 请求入口先跑，老档无需重启也能立刻恢复可见性。
3. **主公可见性**：同号队伍被 UI 按 order 建索引时互相覆盖，会让主公所在的真队伍整队消失、下拉里的主公又被标「在编」无法选择；去重后主公必须出现在其所属队伍的槽位且可在同队换槽。
4. **UI 不修数据**：征兵页仍按 order 渲染，但服务端保证 `(cityId, order)` 唯一；禁止靠前端挑第一支/最后一支来掩盖重复队号。

## P58 战法解锁条件可见（写死，防回归）

1. **门槛唯一口径**：`domain/slots.js slotUnlock(g,pos)` 是三个战法槽门槛的唯一实现，返回 `{open, replaceable, rules:[{key,label,need,have}], short, text}`。任何界面不得自己比较 `level>=5`／`innateLv>=10` 拼文案。
2. **文案必须带差额**：锁着的槽要写「武将 Lv5（当前 Lv3，还差 2 级）」这种可执行文案，不能只写「需武将 Lv5 解锁」；觉醒槽两条条件都要列出（武将等级 + 自带战法等级）。
3. **自带槽只升级不可换**：`pos 0` 恒 `replaceable:false`，无自带战法的武将写「该武将没有自带战法」，且觉醒槽直接说明「开不了」（不允许显示成「还差 10 级」这类能靠升级解决的假门槛）。
4. **装配目标槽按「已开且空」选**：六府武将页与战法库都用 `skillTargetSlot()`，顺序为学习槽→觉醒槽；不得死发 `pos:1` 把已学会的战法顶掉。没有空槽时要给出可执行原因（哪个槽占了、哪个槽还差什么），并把按钮置灰。
5. **战法两级门槛都要写**：`library[]` 里「解锁条件」分战法层（研习进度 need/progress、残卷现有数与每次上限 10 卷）与槽位层（武将 5/10 级），两条同屏可见。
6. **可卸下才能换装**：`panels.js panelAction({type:'downSkill'})` 与协议 `general.downSkill` 同一条 `slotBlock(g,pos,'remove')`；学习/觉醒槽可卸下腾槽，自带槽拒绝。
7. **原客户端同源**：`general.myGenerals` 每名武将下发 `slotRules`（三槽门槛），`skills.js` 只渲染不下算；空槽必须出现「解锁条件：」字样。

## 变更流程

1. 新数值：先在本表登记 → 再实现服务端权威源 → 最后接 UI。
2. 改口径：先改本文 → 跑 `npm test`（有测试锁死旧口径的会红）→ 按测试指引迁移。
3. 发现前端复算：立刻删除，改为消费权威字段；若服务端缺字段，走 `fieldGaps` 显式降级。
