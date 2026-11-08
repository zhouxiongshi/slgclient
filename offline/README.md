# SLG 离线单机包（offline-standalone 分支）

> 本分支挂载在客户端仓库（slgclient）上，是**三国 SLG 离线单机版**的完整基线快照。
> 后续开发完善请直接在本分支上进行，提交信息请以 `offline:` 为前缀。

## 一、这是什么

一款**可双击即玩的 Windows 离线单机游戏**，由三部分组装而成：

1. **原版客户端画面** —— 原页游 SLG 的 Cocos Creator 3.4.2 web-desktop 构建产物，**逐字节未改动**（画面指纹 `ee987ec2…` 可复现校验）；
2. **离线服务端** —— 用 Node.js 全新重写的游戏逻辑服务端（替换原 Go 服务端 + MySQL），复刻原版通信协议；
3. **Electron 壳** —— 把上述两者打包成一个 exe，无任何外部依赖（不需要 MySQL、不需要 Go 服务、不需要联网）。

战斗系统使用 **battle-core 确定性内核**（CPython MT19937 随机数复刻、事件流指纹、黄金向量回归），同一局战斗在任何机器上结果一致。

## 二、目录结构

```
offline/
├── server/          离线服务端（Node.js ESM，核心代码）
│   ├── index.js        HTTP/WS 入口、静态资源服务、存档加载
│   ├── handlers.js     全部消息处理（资源/建筑/设施/征收/转换/出征/战报…）
│   ├── world.js        世界状态、初始城池/领地/武将/战法装配、存档兼容
│   ├── battle.js       战斗结算（技能表驱动，战报为原版语义）
│   ├── skills.js       运行时技能资源注入（重写 config.json paths）
│   ├── config.js       配置加载（原版 json 全量 + facility 等级表）
│   ├── codec.js        协议加解密（AES-128-CBC + GZIP，与原版逐字节一致）
│   └── kernel.js       battle-core 内核接入
├── kernel/          确定性战斗内核 TS 移植（engine/rules/rng/config/types）
├── conf/            配置数据
│   ├── skills.json     31 条真实战法（数据源：battle-kit 原文片段，可溯源）
│   └── json/           原版服务端配置副本（地图/建筑/设施/武将/兵种…）
├── web/             原版客户端构建产物（web-desktop，画面 100% 保留）
├── electron/        Electron 壳（main.cjs 主进程 + smoke.cjs 冒烟测试）
├── tests/           测试套件（building/skills/codec/protocol… 31 条）
├── tools/           工具链
│   ├── pack.js          打包 exe（输出 build/SLG-Offline-win32-x64/）
│   ├── check-release.js 发行核查（70 项硬性验收）
│   ├── smoke.js         冒烟测试（21 项，支持源码态/打包态）
│   └── build-skills.js  战法表生成器（从 battle-kit 原文数据生成 skills.json）
└── package.json     开发依赖与脚本
```

## 三、如何运行

### 玩家（成品）
双击 `build/SLG-Offline-win32-x64/SLG-Offline.exe`（build 目录不入库，需自行打包生成）。

### 开发者（源码态）
```bash
cd offline
npm install                      # 安装依赖
node server/index.js             # 启动服务端（127.0.0.1:8088/8004）
node electron/main.cjs           # 或直接跑 Electron 壳
```

### 打包 / 验证
```bash
node tools/pack.js               # 打包 exe（自动拷贝 server/conf/web 进包）
node tools/smoke.js --packaged   # 打包态冒烟 21 项
node tools/check-release.js      # 发行核查 70 项
node --test tests/*.test.js      # 单元测试 31 条
```

## 四、当前状态（基线）

- ✅ 画面指纹 `ee987ec2…` 与原版逐字节一致（改客户端必须重新构建 web-desktop 并重新打包校验）
- ✅ 战斗内核：确定性、可回放，黄金向量回归通过
- ✅ 战法系统：31 条真实数据战法（主动/被动/追击/指挥四类，10 级真实数值成长），版本串 `battle-kit/original-fragments/v3`
- ✅ 经济系统：产量三段合成（基础+设施+领地）、政令恢复、征收限额、集市转换、要塞建造/升级/拆除有消耗有工期，错误码对齐原版
- ✅ 验证：单测 31/31、冒烟 21/21（源码态+打包态）、发行核查 70/70
- ⚠️ 已知缺口：796 战法全量还原需原版 Tcfg_skill 数据行；NPC 无动态 AI；无目标/剧情系统

## 五、设计文档（后续开发路线）

- `../../REPORT.md` —— 项目总报告
- `docs/DESIGN-loop.md` —— 当前设计基线：经济闭环、演义主线不可改道、名将替身、GM 覆盖层、序章 40 日。先设计，未落地
- `docs/ARCHITECTURE.md` —— 模块分层与依赖方向。新代码按此放置；`handlers.js` 只许变薄
- 早期构想（四层资源、七幕、GM 三阶段）仍可作素材，与 `docs/DESIGN-loop.md` 冲突时以该文件为准

## 六、开发约定（重要）

1. **客户端画面 100% 保留原版**——只改服务端逻辑和 Electron 壳；若必须改客户端，改完在 Cocos Creator 重新构建 web-desktop，覆盖 `offline/web/` 后重新打包并核对画面指纹。
2. **协议层不动**——客户端与服务端通过 `{seq, name, msg}` WebSocket 协议通信，加解密在 `server/codec.js`，格式与原版逐字节一致。
3. **GM 改动只写覆盖层**——后续 GM 模块对配置的修改一律写入 overrides 文件，原配置（conf/json/）逐字节不动。
4. 服务端所有逻辑改动必须跑 `node --test tests/*.test.js` 全绿再提交。

## 七、开发方式（本分支即主线）

**本分支（offline-standalone）就是离线包的开发主线**，`offline/` + 根目录 `battle-core/` 自包含全部开发所需：

```bash
git clone -b offline-standalone <仓库地址>
cd slgclient
cd battle-core && npm install && cd ../offline   # battle-core 需 typescript；offline 需 electron
npm test                                          # 单元测试 31 条
npm run pack                                      # 打包 exe → offline/build/SLG-Offline-win32-x64/
node tools/smoke.js --packaged                    # 打包态冒烟 21 项
npm run check                                     # 发行核查（含 battle-core 内核测试与黄金向量）
```

- Electron 由 devDependencies 提供（45.2.3，与历史打包版本一致），`npm install` 后自动就位；
- `offline/web/` 是原版构建产物副本，**只有重新用 Cocos Creator 构建后才需要整体覆盖它**；
- 历史副本 `D:\WorkBuddy\slg\offline\` 与 `D:\WorkBuddy\slg\runtime\client-src\` 保留作参考，不再同步维护；
- 工具链同时兼容旧目录布局（候选路径自动回退），但请以本分支为准。
