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
| 城日产金/粮 | `city-econ.js cityYield()` | 两·斛/日 | 整数（trunc） | ❌ | 城卡经济行 |
| 逐旬内政增量 | `interior-task.js taskView().perTick` | 点/旬 | 整数 | ❌ | 内政任务卡 |
| 内政工期档位阈值 | `interior-task.js OFFICER_TICKS_TOP=85 / OFFICER_TICKS_OK=68`（**百分制 0~100**） | 属性点 | 整数 | ❌ | 内政任务卡「预计 N 旬完工」 |
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
| 粮道连通/跳数/里程 | `supply.js supplyMap(state).byCity[id]`（视图 `city.supply`） | bool/跳/里 | 整数 | ❌ | 粮道透镜、出征面板、概览 |
| 出征耗粮 | `supply.js marchSupplyEstimate()` | 斛/日 | 0.1 | ❌ 必须调同一函数 | 出征面板补给行 |
| 行军 ETA | `strategy.js marchPlan()`（`arriveDay`） | 日 | 整数 | ❌ | 队列页、地图箭头 |
| 推演结论 | `strategy.js previewAssault()`（只读沙盒） | — | — | ❌ | 出征面板推演卡 |
| 战斗种子 | `battle.js battleSeedFor(armyId, x, y, arriveDay)` | uint32 | — | ❌ 只有一个公式 | 结算与推演共用 |
| 诸侯守将/名册等级 | `domain/ai-roster.js`（`state.strategy.rosters[fid]`；★ P16 名册优先于旧 hash，`defenseFor` 在 level≥2 城取真实等级/战法，1 级城保留 hash 守 P0-3） | 级 | 整数 | ❌ 只读显示 | 战报守将、遭遇页、天下日志（学战法/升级/招降/挖角/求援文案） |

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
| 招降率 | `captive-rules.js`（单一公式） | % | 整数 | ❌ | 俘虏面板 |
| 放归名望 | `captives.js releaseCaptive()`：`state.strategy.fame += FAME_PER_RELEASE(2)`（★ 2026-11-16，取事件系统既有 +1~+4 中位；处斩 −2） | 点 | 整数 | ❌ | 放归 toast、名望显示；消费见下行 |
| 名望→来投率 | `captive-reputation.js defectRateWithFame()`：`rate = min(0.45, base + min(40,fame)/700)`（★ 2026-11-16，城数/武将名望与放归名望同轴；封顶 40 点防刷） | 小数 | — | ❌ | `strategy.js defectTick()` 在野慕名来投判定 |
| 处斩恶名 | `state.role.infamy += INFAMY_PER_EXECUTE(1)`（★ 2026-11-16，旧实现只写不读；现同步对外态度，见下行） | 笔 | 整数 | ❌ | 处斩 toast |
| 处置对外态度 | `captive-reputation.js`：放归 −5、处斩 −15（董卓 `sili` 豁免）；全部经 `diplomacy.js adjustAttitudeByEvent()` 落 `eventAdj`，理由链标签「事件」，界面只显示不重算 | 点 | 整数 | ❌ | 外交面板态度理由链、劝降/停战门槛 |
| 相性/义理 | `relation.js xiangxingOf/yiliOf` + `conf/relations.json` | 1–149 / 0–100 | 整数 | ❌ | 武将卡、关系 chip |
| 忠诚 | `state.generals[].loyal`（运行期） | 0–100 | 整数 | ❌ | 武将卡、预警 |
| 战法槽位规则 | `slots.js slotBlock()`：自带不可替换；**学习槽 Lv5 开**；觉醒槽 Lv10 且自带 10 级 | 级 | 整数 | ❌ | 武将战法页、六府装配 |
| 战法装配上限 | `conf/skills.json` 原表 `ui.limit`（可研习 80 条分布 **1~6 人**）；协议层 `general.upSkill` 与六府 `learn` 同读此值 | 人 | 整数 | ❌ | 六府装配按钮、limit_reached 回执 |
| 武将升级经验 | `general-progress.js expToAdvance()`：`40 × 当前等级`，经验来自出征折损（`battle.js` 每槽损失 × 0.5）与 AI 月度人事（`ai-roster.js` 攻城/守城/内政按功勋发 exp）；玩家与 AI 同口径 | 点 | 整数 | ❌ | 武将卡「经验 x/y」 |
| 武将政治属性 | 第 6 项基础属性，键 `politics`／史载 `five.zheng`，0~100 百分制；`config.js` 归一化写入 `generalByCfg`，取数走 `gameStatOf(cfg,g,'politics')`；所有武将（含主公、官员、AI 名册）初始化即带 | 点 | 整数 | ❌ | 武将卡「政治」、内政官员政治加成、登庸、官职能力 |
| 官职能力加成 | `domain/official-rank.js`：功勋 `state.generals[].merit` 与 AI 名册 `generals[].merit` 同源累积，官阶 0~9 由功勋唯一决定；武将官阶越高统帅（defense，即统兵能力）越高，谋臣/政治家官阶越高政治越高；经 `general-stat.js effectiveStatOf` 叠加、封顶 100（不改史载原表） | 级/点 | 整数 | ❌ | 武将卡官阶、统帅/政治有效值、AI 名册 |
| 单槽带兵上限 | `official-rank.js slotCapOf(officer) = 5000 + 官阶×300 + 等级×200`（★ 2026-11-18 扩为「等级+官职」双因子：用户诉求「武将等级和官职决定可配备兵量」；`官阶 = rankOfMerit(merit)` 封顶 9、`等级 = clamp(1..10)`、每级 +200（Lv1 不加）；白身 Lv1=5000、三公 Lv10=9500）；`slotCapForRank(rank)` 保留为「不含等级」的兼容口径（0 阶 5000→9 阶 7700）。`strategyFormup`、出征裁剪、征兵 `army.conscript` 各按该槽武将 `slotCapOf` 取上限，空槽按基础 5000，超出退回驻城 | 兵/槽 | 整数 | ❌ | 编队弹窗逐槽上限、over_cap 动态提示、征兵上限提示 |
| 主公战法发动率 | `conf/campaign/protagonist-skill.json`：指挥战法**发动率恒 100%**（kernel `probability_init = probability_max = 1`，`ui.levels[].probability = 100`）；叙述文案 `开战即发动（发动率 100%）` | % | 整数 | ❌ | 战法面板发动率、推演触发说明 |
| 战法发动率区间 | `tools/skill-balance.mjs planProb()`（★ 2026-11-17 唯一平衡口径）：指挥/被动恒 **100%**；主动/追击按「伤害率越高、发动率越低」反推，Lv1 **30~45%**、Lv10 **32~50%**，且末级 > 首级。旧实现 27 条战法清一色 70% | % | 整数 | ❌ | 战法面板「发动率」、`tests/skill-balance.test.js` |
| 战法期望输出指数 | `tools/skill-balance.mjs`：`发动次数 × 发动率(Lv10) × 伤害率(Lv10) × 目标数`。主动/追击收敛在 **300~2000**（每目标 200~950）；指挥为功能型不强求下界，但 ≤2000 | 点 | 整数 | ❌ | 战法平衡验收、`tests/skill-balance.test.js` |
| 主公战法回击率 | 自身受击时的回击概率：Lv1=35%，每升 1 级 +5%（`ui.levels[].effect_value[1]` = 35+5×(lv−1)，kernel counter.chance 同源）；回击伤害率恒 87% | % | 整数 | ❌ | 战法面板效果是、战报「受击回击」 |
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
| 武将立绘与技能图标 | `server/portrait-map.json`（构建期由冻结 web/ 的 `card_<cfgId>.png.meta` uuid 生成）→ `/__slg/assets/portraits` → `window.__slgPortraitUrl()`；技能图标为冻结 web/ 的 tactics_1~4。缺失时退文字徽章，绝不显示碎图 | URL | — | ❌ 只展示 | 武将页、征兵槽、出征队伍、战斗将卡 |
| 事件逾期兜底 | `domain/strategy.js strategyEventTick()`：`pendingEvents[].sinceTurn` 距当前 ≥4 旬时自动取最后一个（保守）选项结算并清出队列，避免剧情永久冻结 | 旬 | 整数 | ❌ | 天下日志「事件·逾期」、事件系统继续出队 |

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

## 变更流程

1. 新数值：先在本表登记 → 再实现服务端权威源 → 最后接 UI。
2. 改口径：先改本文 → 跑 `npm test`（有测试锁死旧口径的会红）→ 按测试指引迁移。
3. 发现前端复算：立刻删除，改为消费权威字段；若服务端缺字段，走 `fieldGaps` 显式降级。
