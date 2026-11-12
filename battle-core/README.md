# 战斗内核（slg-battle-core）

引擎无关、零运行时依赖的确定性回合制战斗内核（TypeScript）。可在 Node、浏览器、Cocos Creator 中运行同一份代码。

## 来源与保真度

数值与名录从 `D:\WorkBuddy\battle-kit\kernel\config\battle_config.json` **字节级原样复制**（83 个伤害率、58 组等级插值、188 效果术语、232 武将名、796 战法名、7 类 schema、9 个方法名），Python 侧配置指纹复核为 `f186e15d0c1f266b`。规则层与引擎层由 `battle-kit/kernel/{rules,engine,scenario}.py` 忠实移植。

移植时复刻了 CPython `random.Random` 的 MT19937 初始化与 `random()` 53 位合成，以及 `zlib.crc32`，因此：

- 同一 seed 的随机序列逐位一致；
- 基准战斗 **175 条事件逐条与 Python 参考实现一致**（round / phase / actor / kind / evidence / payload 全字段）；
- `winner=1`、`rounds=6`、`event_count=175`、`damage_event_count=48`、首个伤害结算的全部中间量一致；
- 纯函数黄金向量（`level_value` / `normalize_bonus` / `sum_terms_bonus` / `calc_damage` / `counter_factor` / `action_order` / `control_blocks`）逐项精确匹配。

## 快速开始

```bash
npm install
npm test          # 37 条单元测试（含 500 场随机对局、战位射程 4 条）
npm run golden    # 生成 golden/ts_vectors.json 回归快照
npm run stress    # 10000 场压测 -> reports/stress.json
```

Cocos / 浏览器使用编译产物 `build/src/index.js`（ESM），无需任何文件 IO：

```ts
import { runDemo, runBattle, DEFAULT_BATTLE_CONFIG } from './battle-core/index.js';

const result = runDemo({ seed: 20261106, perSide: 3, level: 10, troops: 1200, roundLimit: 8 });
console.log(result.winner, result.rounds, result.events.length);
```

修改 `config/battle_config.json` 后执行 `npm run export-config && npm run build` 重新生成内嵌默认配置。

## 目录

| 路径 | 作用 |
|---|---|
| `src/rules.ts` | 纯函数层：等级缩放、加减伤聚合、相克、伤害结算、先手、控制判定 |
| `src/engine.ts` | 回合状态机、四类战法、准备队列、事件溯源、胜负判定 |
| `src/scenario.ts` | 演示阵容构造（名字/战法/伤害率均取自配置） |
| `src/rng.ts` | MT19937（对齐 Python）+ 备用 mulberry32 |
| `src/hash.ts` | UTF-8 / crc32 / 稳定序列化 / 指纹 |
| `src/config.ts` | 配置校验、快照、指纹 |
| `src/report.ts` | 文字战报、不变量校验、事件摘要 |
| `golden/` | 纯函数黄金向量 + Python 参考事件流快照 |
| `tests/` | 37 条测试，含逐事件跨语言比对与战位射程语义 |

## 设计约束

- 数值全部经 `BattleConfig` 注入，内核不硬编码平衡数值；
- 规则层不读 UI / 网络 / 渲染，不修改入参；
- 输入深拷贝；配置在引擎构造时快照，外部后续修改不影响可复现性；
- 每次伤害事件带 `base / counter / bonus_total / raw / floored / final` 中间量与兵力对账字段；
- 同输入 + 同配置 + 同 seed → 完全相同的事件流。

## 战位与射程（P6/P7 语义，已回填到 TS 源）

参考实现只有「谁先出手」，没有「打得到谁」。单机版需要站位与射程才能让配将产生取舍，因此扩展了三处**可选**字段；**全部缺省时不改变任何既有行为**，基准 175 事件与黄金向量保持逐字节一致。

| 字段 | 位置 | 语义 | 缺省 |
|---|---|---|---|
| `UnitInput.pos` | 单位 | 战位 0=前锋 1=中军 2=大营（clamp 0~4） | 从 `unit_id` 末位数字推导，推不出当 0 |
| `UnitInput.attack_range` | 单位 | 普攻攻击距离（战位口径 1~9） | 9 = 不受限 |
| `Effect.range` | 战法效果 | 该战法有效距离 | 9 = 无远弗届 |

- 战位距离：同阵营 `|pos 差|`；跨阵营 `pos 相加 + 1`（前锋→前锋 1，大营→大营 5）。
- 普攻目标 = 攻击距离内**战位最近**的存活敌军；超出攻击距离则本回合不普攻（战法仍可越排释放）。
- 同距并列口径固定，避免重跑 build 后事件流漂移：普攻取 `unit_id` 字典序最小者；追击取敌方阵列首位（与 Python 参考的 `enemies.slice(0,1)` 一致）。
- 追击战法（`skill_class === '追击'`）目标 = 普攻目标，不吃射程表。
- `effectTargets` 先按 `range` 过滤再按 `_12` / `_13` 截取 2/3 人。

这四条语义由 `tests/engine.test.ts` 的「战位距离 / 普攻攻击距离 / 战法射程 / 缺省不改行为」四例锁死，**重跑 `npm run build` 不会再覆盖它们**（此前是直接手改 `build/src/engine.js` 与 `offline/kernel/`，一 build 就丢）。

## 已知问题（继承而来，已登记、未擅自改动）

1. **E2 减伤式方向反了**：参考实现 `mitigation = 1 - defence/(defence+200)`，导致防御越高反而受伤越多。默认保持 `legacy` 以维持与基准逐位一致；`config.defense_model = 'corrected'` 可切换为单调正确版本，测试 `corrected 模式修复减伤方向` 已锁住该行为。**数值微调阶段建议切换。**
2. **回合耗尽常判平局**：内核在双方都有存活单位时返回 `winner=null`。这是参考实现语义，游戏层可自行按剩余兵力裁定（单机版已在桥接层实现）。
3. `BaseDamage` 解析式、相克三档系数、发动概率均为参考包标注的 **E2 工程假设**，不是实证平衡数值，不能直接当作成品数值使用。
4. 原 slg 服务端 `AbsInt(force-defense)` 的"防御越高越秒杀"缺陷在本内核中不存在（结算式带保底且不作绝对值）。

## 合规提醒（上线前必做）

`battle-kit/export/完整原始版/` 内含反汇编 IL 与内部类结构，`data/` / `export/` 内的武将名、战法名、效果术语及 CSV 的 `context` / `table_file_ids` 列带有第三方来源痕迹。**本内核只复制了数值表与名录用于原型，未复制 IL 与类结构文件。** 商业发行前须整体换皮换名或取得授权，并不得把 `export/完整原始版/` 随包分发。
