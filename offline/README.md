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
| **天下沙盘** | 73 城（`conf/campaign/strategy/map.json`，东汉郡县 + 关隘底图），节点/路网/势力归属 |
| **回合推进** | 月制回合 `turnDays = 10`；服务端 500ms 时钟定时结算，**「推演一月」原子推进到下一回合日**（不足 10 天会给出「还差 N 天」提示） |
| **编队** | 三军 × 三槽，逐槽配将（同一武将全局唯一）、逐槽征兵；空槽位拒绝征兵 |
| **征兵** | 按兵种消耗木/铁/石/粮/金五种资源，工期压到 **2~30 秒**（`etaSec` 倒计时），资源不足返回错误码 16 并禁用按钮 |
| **出征** | 需相邻城池；可派 `frac`（0<frac≤1）比例的兵力；守军按城等级分档（Lv1≈1032、Lv2≈1810、Lv3 更高），守军将领数按等级 1/2/3 → 1 级城一队主力可下 |
| **战报** | 所有战斗写入 `state.warReports`（上限 100 条），含双方兵力、逐回合动作、`summary` / `analysis`，UI 可点开复盘 |
| **军情** | 来犯军可见（`threats`），可就地清剿（`strategy.clearThreat`），不再"看不见也清不掉" |
| **序章章节** | 40 日主线（`conf/campaign/chapter1.json`），结局后 `fired` 冻结、不再错误推进；首页提供「重开一局」（`POST /__slg/restart`） |
| **招贤 / 武将** | 招贤返回明确原因（`no_guest` / `not_enough_gold`）+ 今日名单时段状态；武将面板、战法装配、名将替身 |
| **战法** | 31 条真实战法（`conf/skills.json`，数据源 battle-kit 原文片段，可溯源；版本串 `battle-kit/original-fragments/v3`），四类战法 + 10 级真实数值成长 |
| **经济** | 产量三段合成（基础 + 设施 + 领地）、政令恢复、征收限额与 CD、集市转换、要塞建造/升级/拆除（有消耗有工期），满仓给出「已满仓」提示 |
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
│       ├── strategy.js      战略层：回合、守军分档、编队、征兵、出征结算、来犯军
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
│   ├── json/            原版服务端配置副本（地图/建筑/设施/武将/兵种…）
│   └── campaign/        章节、人物、命运、主角、战略层（strategy/map.json 73 城）
├── web/               原版客户端构建产物（web-desktop，磁盘逐字节不动）
├── electron/          Electron 壳（main.cjs + smoke.cjs 冒烟）
├── tests/             单测 96 条（node --test）
├── tools/             工具链
│   ├── pack.js            打包 exe → build/SLG-Offline-win32-x64/
│   ├── check-release.js   发行核查（70 项硬性验收，含画面指纹）
│   ├── smoke.js           运行时冒烟（21 项，源码态 / --packaged 打包态）
│   ├── explore-bugs.mjs   协议穷举探测（71 handler × 5 payload）
│   └── build-skills.js    战法表生成器（从 battle-kit 原文生成 skills.json）
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
node tools/smoke.js              # 源码态冒烟 21 项
node tools/smoke.js --packaged   # 打包态冒烟 21 项
node tools/check-release.js      # 发行核查 70 项
node --test tests/*.test.js      # 单元测试 96 条
node tools/explore-bugs.mjs      # 协议穷举探测
```

> 打包脚本会先清空 `build/SLG-Offline-win32-x64`。若在受限环境里删除被拦截，可先把旧目录改名挪开再打包。

## 五、当前验证状态

- ✅ 画面指纹 `ee987ec2…` 与原版逐字节一致（`pack.json`：`byteIdentical: true`，1582 个文件）
- ✅ 单元测试 **96/96**（含 `tests/playtest-fixes.test.js` 13 条针对实机试玩问题的回归）
- ✅ 运行时冒烟 **21/21**（源码态 `reports/smoke-original.json`、打包态 `reports/smoke-packaged.json`）
- ✅ 发行核查 **70/70**（含内核黄金向量、协议、画面指纹、工作区干净）
- ✅ 协议穷举：71 handler × 5 = 355 用例，**0 抛异常**（35 条 "null 字段" 为设计空值：空战法槽、未解锁天赋、未选章节分支、无在店客人）
- ✅ 战争闭环：出征 → 结算 → 战报入档 → 复盘（`[800,400,0]` 可下 1 级城，`[1000,600,600]` 可下 2 级城）

## 六、运行时注入说明（重要）

`offline/web/` **磁盘文件一个字节都不改**。所有 UI 扩展都在服务端启动时以字符串形式注入页面：

| 注入源 | 内容 |
|---|---|
| `STRATEGY_OVERLAY_SOURCE`（`server/skills.js`） | 战略层全屏面板：天下沙盘、编队/征兵、招贤、战报、军情、序章 |
| `BATTLE_ANIM_SOURCE` | 战斗过程动画与逐回合动作展示 |
| `CITY_WINDOW_V2_IMPL` | 城池窗口 v2（内政/军务/征兵入口） |

改完只看服务端即可，不需要重新构建 Cocos 工程；如果哪天真要改客户端资源，必须重新用 Cocos Creator 构建 `web-desktop` 覆盖 `offline/web/`，并重新打包核对指纹（否则 `check-release` 会红）。

## 七、开发约定

1. **客户端画面磁盘文件 100% 不动**——UI 一律走运行时注入；确需改 `web/` 时必须重新构建并更新指纹基线。
2. **协议层不动**——`{seq, name, msg}` + AES-128-CBC + GZIP，`name` 原样回显，`code` 恒 0，格式与原版一致。
3. **GM 改动只写覆盖层**——写入 `overrides`，`conf/json/` 原配置逐字节不动。
4. **`handlers.js` 只许变薄**——领域逻辑放 `server/domain/`，见 `docs/ARCHITECTURE.md`。
5. 提交前必须 `npm test` 全绿；动到 UI/打包再跑 `smoke.js` 与 `check-release.js`。

## 八、已知缺口（未完成项）

- **存档**：单档 `save.json`（`%APPDATA%\霜寒定九州\saves\`），无多档位/导出/导入。
- **GM 页**：`/__slg/gm`、`/__slg/board` 仍是白底调试页，与国风 UI 割裂，系数缺范围校验。
- **架构**：`server/skills.js` 仍同时承担资源注入与三套 DOM UI（2000+ 行），待按 `docs/ARCHITECTURE.md` 拆分。
- **接口开销**：`/__slg/strategy/state` 每次返回全部 73 城（含考据文本），前端 5 秒轮询，尚未做瘦身/增量。
- **内容**：796 条战法全量还原需原版 `Tcfg_skill` 数据行；NPC 无动态 AI（仅 8 条人格轴 + 指令单）。

## 九、设计文档

- `../../REPORT.md` —— 项目总报告
- `docs/DESIGN-loop.md` —— 设计基线：经济闭环、演义主线、名将替身、GM 覆盖层、序章 40 日
- `docs/ARCHITECTURE.md` —— 模块分层与依赖方向
- `docs/FEASIBILITY-v1.md` —— 一局完整流程的定义
- 与 `docs/DESIGN-loop.md` 冲突时以该文件为准
