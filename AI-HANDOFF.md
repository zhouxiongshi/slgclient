# AI 协作交接板（多会话共用）

> **任何 AI 会话在开始改动前必须先读本文件；结束改动后必须更新本文件并提交。**
> 本文件存在的意义：多个 AI 同时改本项目时，避免各改各的、互相覆盖、改动不合并。

## 当前基线

- 分支：`offline-standalone`
- 最新提交：见改动登记末行（P73 诸侯来犯＝抵达即守城战）
- 核对时间：2026-11-27 22:20（P73 收工）
- 核对结果：P73 全量验收通过；本轮为玩家报障修复（来犯军无声消失），只碰 `strategy.js` / `battle.js` / `handlers.js` / `skills.js` + 测试 + 文档
- 上次验收：单测 **913/913**、内核 42/42、双态 smoke 33×2、双态 UI 审计 77×2、双态鼠标 46×2、双态布局硬问题 0、pack `byteIdentical=true`（1582 文件）、术语覆盖 100%、性能双态全绿（PF-01a 545/522ms）、发布闸 **95/95 ready=true**（提交后复核）
- ★ P73 新经验：删代码块时连带删掉的 `continue` 会静默改语义——`applyOrders` 来犯分支少了 `continue` 就穿透到战略层占城逻辑，旬界把玩家的城判给诸侯。`tests/p73-assault-battle.test.js` P73-⑧ 与 `tests/strategy.test.js` 双闸锁死，删块前先看控制流出口。
- ★ P68 新经验：性能探针 PF-02/PF-07 假红的真凶是 Chromium Windows 原生遮挡计算（`CalculateNativeWinOcclusion`），前台有其它应用盖住探针窗口时 rAF 压到 1fps，`SLG_FORCE_TOP=1` 压不住；已在 `electron/main.cjs` 自动化模式统一追加 `disable-features=CalculateNativeWinOcclusion`（玩家正常游玩不受影响）。PF-01a 仍随系统负载波动，隔时复跑即绿，不放宽阈值。

## 协作规则（硬性，所有会话遵守）

1. **开工前必做**：`git fetch origin offline-standalone` → `git status --short` → 若本地落后则 `git pull --ff-only`。
2. **发现非本会话的未提交改动**：立即停下，在下方「待决/进行中」登记，并询问用户如何处理。**禁止直接覆盖、stash 掉、或替它做决定**（上一轮教训：另一个 AI 的月度行军回放改动差点被当成遗留垃圾）。
3. **改动中只碰自己认领的文件**。同一文件的并发修改是最危险的：开工前在「进行中」登记文件名，其他会话看到后避开。
4. **收工前必做**：跑全量验收 → `git add` → `git commit` → `git push` → 更新本文件基线并再提交一次（或并入同一提交）。
5. **推送失败**（TLS/502 常见）：重试 2~3 次；仍失败则本地提交保留，在本文件登记「待推送」，不要 force push。
6. **禁止 `git reset --hard` / `git checkout --` / `git stash`** 清理未知改动——那会永久丢失另一个 AI 的工作。
7. **`offline/web/` 逐字节冻结**（1582 文件），UI 一律运行时注入脚本（`skills.js` / `panels-ui.js` / `interaction-ui.js` / `ui-shell.js`）；领域逻辑进 `server/domain/`，`handlers.js` 只许变薄。
8. **`offline/reports/` 会被并行会话互盖**：取证前核对报告 mtime / `startedAt`，只清理自己 PID 的进程；性能探针红先确认是否窗口后台节流（`SLG_FORCE_TOP=1` 复跑），不放宽阈值。

## 改动登记

| 时间 | 会话 | 提交 | 内容 | 状态 |
|---|---|---|---|---|
| 2026-11-27 11:20 | WorkBuddy-A | `2697471` | P65 研习进度卡住修复 + 接手合并另一个 AI 的月度行军回放改动 | 已推送 |
| 2026-11-27 11:20 | — | — | 建立本交接板与协作纪律 | 已推送 `418eb1a` |
| 2026-11-27 14:29 | WorkBuddy-A | `cdfdfe0` | P66 研习完成不阻塞（装配引导+换战法+卷尽说明）+ 全局灰按钮悬浮提示 | 已推送 |
| 2026-11-27 15:36 | WorkBuddy-A | `d19c98a` | P67 出征自动接战：相遇/抵城即战，折损拆阵亡负伤且伤兵回撤周边/出生城 | 已推送 |
| 2026-11-27 15:42 | WorkBuddy-A | `4ce6263` | 交接板：登记 P67 基线、全量验收与推送状态 | 已推送 |
| 2026-11-27 16:52 | WorkBuddy-A | P68 | 战法升级成长全量覆盖：7 条平线战法修复（镜像控制 50→100 + 平线兜底 Lv1=Lv10/2）+ 自动化探针遮挡开关 | 已推送 |
| 2026-11-27 17:35 | WorkBuddy-B | P69 | 战法库数值曲线绕过成长层修复：面板投影改取运行时等级，反击 Lv1=37.5→Lv10=75，描述 %n 同源；补 P69 两条闸 | 已推送 |
| 2026-11-27 18:10 | WorkBuddy-B | `220b6af` | P70 反击玩家指定数值：Lv1 70%、每级 +5%、Lv10 115%；成长层加 manualOverride，生成器复跑不再冲回官方 37.5→75 | 已推送 |
| 2026-11-27 20:32 | WorkBuddy-B | `c22d213` | 玩家可见战法数值全局同源：三槽/战法库/研习统一取运行时表，P69「文案读 conf 原文」口径作废；新增全战法四路径一致性闸（6 条） | 已推送 |
| 2026-11-27 21:18 | WorkBuddy-B | `d6c8801` | 内政三事：民心/治安悬浮说明、太守只任本城官员（默认非主公）、兵源恢复（阵亡复员归农 + 在役户归一化 + 人口保底） | 已推送 |
| 2026-11-27 22:20 | WorkBuddy-B | P73 | 诸侯来犯＝抵达即守城战：`assaultBattleTick`/`settleDefenseBattle` 走同一内核结算并产出可回放战报、删掉「此战已写入战报」假战报、守方合并驻城部队与守将、来犯兵力不再 ÷6、客户端战报排队（标题带「还有 N 场待看」） | 已推送 |

### 进行中 / 待决

（无。P73 认领已收工：913/913 单测、内核 42/42、双态八套全绿、perf 双态通过、发布闸 95/95。）

留痕 P73：修 `applyOrders` 假战报块时连带丢了 `continue`，导致来犯分支穿透到战略层占城逻辑（旬界静默易主）。已由 `tests/strategy.test.js` 的归属断言抓出并修复，另补 `P73-⑧` 专锁该控制流出口。**改动 `strategy.js` 的来犯分支前务必保留 `continue`。**

留痕：P71 两笔曾因子网阻断滞留本地，本轮网络恢复后随 P72 一并推送成功；期间 fetch 失败（Empty reply from server），未做 pull、未 force push。

留痕：上一会话（11-25）的 P62 提交 `0a155e9` 已是当前 HEAD 的祖先，工作没丢；但其后未提交的 P62.1「撤掉道中遭遇」7 个文件改动不在工作树里，推测被另一会话的 P67 接战口径覆盖。本次 P69 未碰相遇相关文件，待用户决定是否重做。

## 热点文件（多会话最易冲突）

- `offline/server/domain/research.js`、`panels.js`、`strategy.js`、`strategy-brain.js`
- `offline/server/panels-ui.js`、`interaction-ui.js`、`skills.js`
- `offline/electron/ui-audit.cjs`
- `offline/tests/p63-ai-prey-and-research.test.js`、`p44-ai-static-march.test.js`
- `offline/docs/FIELD-CONTRACT.md`、`SDD-软件详细设计说明书.md`
- `offline/reports/*`（探针产物，非源码，但取证时互盖）

## 标准验收命令（在 `offline/` 下）

```bash
npm test                                   # 全量单测
node tools/smoke.js [--packaged]
node tools/ui-audit.js [--packaged]
node tools/mouse-playtest.js [--packaged]
node tools/layout-audit.js [--packaged]
node tools/perf-probe.js [--packaged]      # 红先用 SLG_FORCE_TOP=1 复跑，勿宽阈值
CODEBUDDY_SAFE_DELETE_ENABLED=0 node tools/pack.js
node tools/check-terms.js && node tools/check-compliance.js && node tools/compliance-report.js
node tools/check-release.js                # 期望 95/95 ready=true
```

改了 `server/` 或 `conf/` 必须重 pack 再跑打包态取证；报告新鲜度是硬闸，文档改动也要重跑相关报告。
