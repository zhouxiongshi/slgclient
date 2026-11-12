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
| 政策/官员加成 | `panels.js postBonusPct / yieldBonusByResource` | % | 整数 | ❌ | 内政页加成拆解 |

## B. 战略与行军

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 粮道连通/跳数/里程 | `supply.js supplyMap(state).byCity[id]`（视图 `city.supply`） | bool/跳/里 | 整数 | ❌ | 粮道透镜、出征面板、概览 |
| 出征耗粮 | `supply.js marchSupplyEstimate()` | 斛/日 | 0.1 | ❌ 必须调同一函数 | 出征面板补给行 |
| 行军 ETA | `strategy.js marchPlan()`（`arriveDay`） | 日 | 整数 | ❌ | 队列页、地图箭头 |
| 推演结论 | `strategy.js previewAssault()`（只读沙盒） | — | — | ❌ | 出征面板推演卡 |
| 战斗种子 | `battle.js battleSeedFor(armyId, x, y, arriveDay)` | uint32 | — | ❌ 只有一个公式 | 结算与推演共用 |

## C. 战斗

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 战斗伤害/回合事件 | `battle-core`（TS 内核，`offline/kernel/` 同步产物） | 点 | 整数 | ❌ | 回放、战报、推演 |
| 追击目标/损失 | 内核 `nearestFoe`（并列：普攻按 id、追击按阵列序） | — | — | ❌ | 回放 |
| 归因 | `settleArmyBattle` 的 `attribution/summary` | — | — | ❌ | 战报三句 |

## D. 人事

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 登庸率 | `relation.js talentRecruitRate()` | % | 整数 | ❌ | 在野名士卡、酒馆、探索 |
| 登庸五分项 | `talentRecruitRate()` 的 `parts` | % | 整数 | ❌ | 构成条（禁前端拆算） |
| 招降率 | `captive-rules.js`（单一公式） | % | 整数 | ❌ | 俘虏面板 |
| 相性/义理 | `relation.js xiangxingOf/yiliOf` + `conf/relations.json` | 1–149 / 0–100 | 整数 | ❌ | 武将卡、关系 chip |
| 忠诚 | `state.generals[].loyal`（运行期） | 0–100 | 整数 | ❌ | 武将卡、预警 |

## E. 交互层（P9/P10 契约延续）

| 数值 | 权威源 | 单位 | 精度 | 界面可否复算 | 消费方 |
|---|---|---|---|---|---|
| 决策预览/失败态 | `interaction/state` 聚合端点 | — | — | ❌ | 决策预览卡 |
| 撤销策略 | `interaction/state.undo`（depth/clearOnBattle/clearOnLoad） | 步 | — | ❌ | 注入层撤销栈 |
| 建言/议程 | `interaction/state.agenda` | — | — | ❌ | 当前事务抽屉 |
| 地图标注分级 | `strategy.js` 视图 `cities[].labelRank` + `labelPolicy` | 1–3 | — | ❌ 客户端只取档过滤 | 大地图 |
| 服务端缺失字段 | `interaction/state.fieldGaps` | — | — | — | 显式降级（禁编造） |

## 历史教训（写死，防回归）

1. **逐城经济只能取 `state.strategy.cityEcon`**：`state.cityEcon` 是空的历史对象，
   取错会让全城显示 0 粮（P9 踩过，测试 `p9-interaction.test.js` 已锁）。
2. **战斗种子只有 `battleSeedFor` 一个公式**：旧口径含 `battleLog.length`，导致
   「预演必错一档」（验收 #10 根因）。别处再拼种子 = 改所有战报。
3. **内政只改工期不改产出**：好官缩工期（1/2/3 旬），总产出恒定，否则变印钞机。
4. **撤回/撤销不在前端乐观执行**：批量撤回逐支发请求汇总结果，假批量会让
   退粮数字对不上账。

## 变更流程

1. 新数值：先在本表登记 → 再实现服务端权威源 → 最后接 UI。
2. 改口径：先改本文 → 跑 `npm test`（有测试锁死旧口径的会红）→ 按测试指引迁移。
3. 发现前端复算：立刻删除，改为消费权威字段；若服务端缺字段，走 `fieldGaps` 显式降级。
