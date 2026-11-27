# AI 协作交接板（多会话共用）

> **任何 AI 会话在开始改动前必须先读本文件；结束改动后必须更新本文件并提交。**
> 本文件存在的意义：多个 AI 同时改本项目时，避免各改各的、互相覆盖、改动不合并。

## 当前基线

- 分支：`offline-standalone`
- 最新提交：`4ce6263`（交接板基线更新）；功能提交 `d19c98a`（P67 出征自动接战 + 伤兵回撤）
- 核对时间：2026-11-27 15:45（P67 收工）
- 核对结果：工作区干净，本地与 `origin/offline-standalone` 同步（0 ahead / 0 behind）；推送中途 TLS/502 重试后成功
- 上次验收：单测 884/884、内核 42/42、双态 smoke 33×2、双态 UI 审计 77×2、双态鼠标 46×2、双态布局硬问题 0、双态性能全绿（PF-01a 548/536ms）、pack `byteIdentical=true`、术语覆盖 100%、发布闸 94/95（仅差工作区未提交）

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

### 进行中 / 待决

P67 已完成、待提交；本会话实际改动（另一会话收工后请勿覆盖）：
- 新增：`offline/server/domain/casualties.js`、`offline/server/domain/encounter.js`、`offline/tests/p67-auto-battle-and-casualties.test.js`
- 领域/协议：`offline/server/domain/strategy.js`、`clash.js`、`interaction.js`、`offline/server/handlers.js`、`index.js`
- 注入 UI：`offline/server/skills.js`、`interaction-ui.js`；配置：`offline/conf/interaction/terms.json`
- 取证：`offline/electron/{ui-audit,mouse-playtest,ui-probe}.cjs`、`offline/tools/check-release.js`
- 测试：`offline/tests/{m4-13-distance-garrison-captives,p11-levy-and-gates,p62-march-clash,p63-ai-prey-and-research,playtest-fixes}.test.js`
- 文档：`offline/docs/{FIELD-CONTRACT,SDD-软件详细设计说明书,GDD-顶配详细设计,PRD-软件需求规格说明书,P8-出征面板与试玩修复,M4-13-距离做实与守将俘虏出征}.md`
- `AI-HANDOFF.md`

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
