# 《穿越·汉末》软件详细设计说明书（SDD）

> **文档性质**：实现事实说明书。回答「代码现在到底怎么跑」——运行时拓扑、协议帧、消息/端点全表、状态数据字典、模块接口、算法公式、状态机、错误码、注入层、确定性、测试与发布。
> **版本**：v1.0 · 2026-11-15
> **代码基线**：`offline-standalone` @ `3e4ccbd`（2026-11-15，`feat(M4-13)`）；核查时 `git status` 干净、`check-release` 92/92、`reports/pack.json byteIdentical=true`。
> **事实源**：本文所有数字与接口签名均取自 `offline/` 磁盘源码的静态读取与只读执行（`loadConfig()` / `SKILLS` / JSON 解析），不以历史文档记载为准。
> **与既有文档的分工**：需求范围听 `PRD-软件需求规格说明书.md`；玩法数值听 `GDD-顶配详细设计.md`；代码结构约束听 `ARCHITECTURE.md`；玩家可见数值登记在 `FIELD-CONTRACT.md`；**本文只描述已实现事实**，规划项一律标注「规划/未落地」，见 §17。
> **偏差登记**：本文 §17 专门记录「架构应然 vs 代码实然」「文档数字漂移」「实现与文案不一致」，不隐瞒、不静默改代码。
> **约定**：路径一律相对 `slgclient/offline/`，除非显式写「仓库根」。代码块中的引号均为 ASCII 直引号。

---

## 0. 阅读指南与文档控制

### 0.1 谁该读哪一章

| 角色 | 必读 | 选读 |
|---|---|---|
| 后端 / 协议开发 | §2、§3、§4、§5、§6、§7、§11 | §14、§15 |
| 内核 / 战斗开发 | §7.7、§7.8、§10、§14.2 | §5.4、§15.3 |
| 前端注入层开发 | §3.4、§9、§11、§12 | §4、§6 |
| QA / 发布 | §10、§12、§14、§15、§17 | §3、§7 |
| 策划 / 数值 | §4.4、§7、§8、§17 | §1.2 |
| 新接手者 | §0.3 → §1 → §2 → §6.3 → §16 → §17 | 全文 |

### 0.2 标记

| 标记 | 含义 |
|---|---|
| `【实测】` | 本次核查从代码/配置直接读到的事实 |
| `【应然】` | `ARCHITECTURE.md` / GDD 规定的约束，代码未必完全符合 |
| `【偏差】` | 已在 §17 登记的应然与实然差异 |
| `【规划】` | GDD 有设计但代码未落地 |
| `【红线】` | 违反即回归，通常有测试/发布闸锁定 |

### 0.3 五分钟上手

```text
进程启动
  ├─ HTTP 127.0.0.1:8088  ← 原版 web/ 静态资源 + 4 个注入脚本 + /__slg/* 端点
  ├─ WS  127.0.0.1:8004   ← {seq,name,msg} 协议（AES-128-CBC + gzip）
  ├─ 200ms tick：定时任务（pending[]）
  ├─ 500ms tick：settleWorld(ctx, Date.now())   ← 世界推进唯一真入口
  └─ Electron 窗口 → http://127.0.0.1:8088/（默认不置顶、可最小化）
```

改任何玩法前先查三件事：① 该数值在 `FIELD-CONTRACT.md` 有没有登记；② 该行为在 `PRD` 里对应哪个 `FR` / `AC`；③ 该模块在 §5 的依赖图里处于哪一层、是否零环。

---

## 1. 设计总览

### 1.1 系统目标与形态

把 2024 年 Cocos Creator 3.4 联网客户端的 `web-desktop` 构建产物，改造成**完全离线的 Windows 单机程序**：保留原画面与协议资产，用一个 Node ESM 进程复刻服务端，用 Electron 壳承载窗口，用「运行时注入」承载全部新 UI。所有状态落在本地 JSON 存档。

### 1.2 架构决策记录（ADR）

| 编号 | 决策 | 为什么 | 代价 / 约束 | 取证 |
|---|---|---|---|---|
| ADR-01 | `web/` 逐字节不改，新 UI 全走 HTTP 响应注入 | 原客户端无源码构建链，改产物不可维护；发行闸要求画面 100% 保留 | 注入层与客户端 bundle 靠字符串补丁耦合，`patchClientBundle` 替换不上会抛错 | `index.js:321-378`、`skills.js:889`、`pack.js:122` |
| ADR-02 | 自研零依赖 RFC6455 WS 实现 | 避免引入 `ws` 依赖，端口与帧行为需与原客户端完全一致 | 需自行处理粘包/续帧/掩码/64MB 上限 | `wsserver.js` |
| ADR-03 | 每连接一个 AES 密钥，握手帧明文下发 | 对齐原客户端 `WebSock.ts` 的 CryptoJS ZeroPadding 行为 | 无鉴权，仅靠回环隔离 | `codec.js`、`index.js:875-879` |
| ADR-04 | 单一世界推进入口 `settleWorld(ctx, now)` | 曾因模拟脚本手写日循环漏 `applyDays`、重复 `cityEconTick` 得出「玩家金恒 0」假阳性 | 所有长时模拟必须注入固定 `now` | `handlers.js:303-316`、`ARCH §9.20` |
| ADR-05 | 战略回合 = 旬（10 日），不是月 | 粮道/行军/内政 tick 都以 `TICK_DAYS=10` 为节拍 | 「月」只用于俸禄/季节/展示 | `factions.json turnDays:10`、GDD D-02 |
| ADR-06 | 关隘是路网边上的闸门，不是城池节点 | 避免新增 73 个节点；`detail.json` 已有 `gateStatus` | 关隘不产出、不驻官 | `march.js`、GDD D-03 |
| ADR-07 | 战斗内核独立 TS 工程，编译产物同步到 `offline/kernel/` | 内核需纯函数、可跑黄金向量；直接手改编译产物会被 build 冲掉 | 同步是人工步骤，靠文档 + 单测兜底 | `battle-core/package.json`、`check-release.js:96-100` |
| ADR-08 | 全部随机走 `rngFor(seed,turn,tag)` / MT19937 | 可复现、可回放、可跨机一致 | 禁 `Math.random()`；新增 tag 需登记避免冲突 | `strategy-rng.js`、`kernel/rng.js`、`WB-04` |
| ADR-09 | 双账本：逐城粮为实账，国库粮只读汇总 | 防止「国库粮一改，全城粮凭空消失」 | 静态闸禁止 `resources[..].grain =` | `strategy.js:647-728`、`WB-06` |
| ADR-10 | 生效设施单一清单 `facility-catalog.js` | 修「左上角内政与城池内页不一致、设施升了没用」 | 判据不硬编码 type，须查 `cfg.facilityAdditions` | `facility-catalog.js`、`ARCH §9.26` |
| ADR-11 | 武将属性统一 0~100 三国志11 百分制 | 修「属性上万、平衡崩坏」 | 原表逐字不动，只改派生层；交集人物以史载五维覆盖 | `general-stat.js`、`config.js:82-196` |
| ADR-12 | GM / 编辑器只写 `overrides.json` | 删覆盖即还原，测试可幂等 | 需 mtime 缓存失效与形状保护 | `gm/overrides.js` |
| ADR-13 | 内核 `mechanics` 不入 `bonus_terms` | 内核对攻击方 buffs 无差别求和，减伤/回击词会变成攻击加成 | 回击必须带 `noReaction` + `flat_rate` | `skills.js kernelSkillAt`、`kernel/engine.js` |
| ADR-14 | 默认永不置顶、弹窗非模态可静音 | 修「窗口霸屏、弹窗无限复活」 | 自动化也不许置顶；CI 逃生口仅取证用 | `electron/main.cjs`、`interaction-ui.js` |
| ADR-15 | 发布闸 = 单测 + 双态真机 + 静态合规 + 工作区干净 | 曾有 4 个 P0 故障因「26 项冒烟全绕开真实点击」漏到后期 | 文档入仓必须提交 | `check-release.js`、GDD §11.6 |

### 1.3 五层映射（`ARCHITECTURE.md §2` → 实际目录）

| 层 | 应然职责 | 实际落点 |
|---|---|---|
| 表现层 | 客户端画面、确认框、GM 页面 | `web/`（不可改）+ `server/{panels-ui,interaction-ui,ui-shell,editor-ui}.js`（注入）+ `server/gm/*.html` |
| 适配层 | 协议适配 / GM 适配 | `server/{codec,wsserver,handlers,index}.js`、`server/gm/overrides.js` |
| 命令层 | 唯一允许改世界状态处 | 实际由 `handlers.js switch` + `strategy.js` 动作函数共同承担【偏差：命令层未独立成 `command.js` 主体】 |
| 领域层 | 经济/地图/设施/军队/战斗/武将/宿命/剧情 | `server/domain/`（42 个模块，10031 行） |
| 状态层 | 存档 / 配置 / 时钟 | `server/{world,config,clock}.js`、`conf/`、`saves/` |
| 内核 | 只有部队/战法/随机数 | `battle-core/src/` → `offline/kernel/` |

**【应然 vs 实然】** `ARCHITECTURE.md §5` 要求「领域模块之间不互相 import」，实际 `server/domain/` 内存在大量单向 import，且 `world.js ↔ strategy.js` 形成 ESM 环。详见 §5.3 与 §17。新增模块仍应遵守「叶子零依赖、协作回到上层」的纪律。

### 1.4 全局不变量（违反即回归）

| 编号 | 不变量 | 守护位置 |
|---|---|---|
| INV-01 | `web/` 1582 文件 sha256 清单指纹 = `ee987ec2c30a6e99d12f14573d2d39bf1af44b8ff500acc73b0ee826e8150485` | `pack.js:122`、`check-release.js:58-60, 104-131` |
| INV-02 | 响应 `name/seq` 原样回显；字段名沿用 Go proto tag | `handlers.js:1-9`、`index.js:907-912` |
| INV-03 | 战斗种子只依赖 `(armyId,x,y,day)`，与 `battleLog.length` 解耦 | `battle.js battleSeedFor`、`WB-05` |
| INV-04 | 逐城经济只取 `state.strategy.cityEcon` | `p9-interaction.test.js` |
| INV-05 | 国库粮只读汇总，禁止直接赋值 | `WB-06` |
| INV-06 | `server/domain/`、`kernel/`、`tests/`、`tools/` 无 `Math.random()` | `WB-04`（剥注释后扫描） |
| INV-07 | 全库武将属性 ∈ [1,100] | `check-release` 7.9d |
| INV-08 | 设施生效判据与结算写入轴同表 | `facility-catalog.js` |
| INV-09 | 覆盖层不写 `conf/json/` | `m4-editor.test.js` |
| INV-10 | `git status` 干净才能过发布闸 | `check-release.js:134-139` |

---

## 2. 运行时拓扑与进程模型

### 2.1 进程与端口【实测】

| 项 | 值 | 证据 |
|---|---|---|
| 入口（源码态） | `node server/standalone.js` → `startOfflineServer()` | `standalone.js:4-15`、`index.js:98` |
| 入口（Electron） | `electron/main.cjs` 内部启动同一 server 并加载 `http://127.0.0.1:8088/` | `main.cjs` |
| HTTP | `http.Server` 绑 `127.0.0.1:8088` | `index.js:918-921` |
| WS | 独立 `http.Server` 绑 `127.0.0.1:8004`，普通 HTTP 请求回 404，只处理 `upgrade` | `index.js:872-879` |
| 静态根 | `resolveWebDir()`：优先 `offline/web/index.html`，否则 `../runtime/client-src/build/web-desktop` | `world.js:465-471` |
| 配置根 | `defaultConfDir()`：判 `conf/json/basic.json`，否则 `../slgserver/data/conf` | `config.js:15-20` |
| 存档 | `saveDir/save.json`（默认 `offline/saves/`） | `index.js:101-108` |

**覆盖参数**：`startOfflineServer({httpPort, wsPort, webDir, saveDir, confDir, travelMs, quiet})`；环境变量 `SLG_HTTP_PORT / SLG_WS_PORT / SLG_WEB_DIR / SLG_SAVE_DIR / SLG_TRAVEL_MS(默认3000)`。

### 2.2 启动顺序【实测】

```text
① loadConfig(confDir)                       // 读 76 份 JSON 的一部分，构建 cfg.generalByCfg 等索引
② createSkillAssets(webDir)                 // 准备资源拦截（不写磁盘）
③ loadWorld(savePath)                       // 旧档缺穿越者主公 → 归档 save.json.pre-prologue-*.json → 重开
④ normalizeWorld(state, cfg)                // 补字段、归一三槽、ensureTavern/Fates/Strategy/Panels、applyTileOverlay
⑤ 建立 ctx { state, cfg, push, schedule, log, save, flush, ... }
⑥ 启动 200ms 定时任务 tick（processTask）与 500ms 世界时钟 tick（settleWorld）
⑦ await listen(httpServer, 8088)
⑧ await listen(wsHttpServer, 8004)
⑨ 返回 { ctx, ports, status(), resetWorld(), getState(), close() }
```

`save()` 250ms 防抖；`flush()` 立即落盘。`ctx.push(name,msg)` 构造 `{seq:0,name,code:0,msg}` 遍历连接，跳过未握手（`!conn.meta.key`）的连接。

### 2.3 启动期注入（`GET /index.html`）【实测】

只在响应体尚未包含 `/__slg/panels/ui.js` 时注入，插在 `</body>` 前（无则追加末尾）：

| 序 | 内容 | 作用 |
|---|---|---|
| 1 | `errHook` `<script>` | `window.__slgErrors`（≤60 条），监听 `error` / `unhandledrejection` |
| 2 | `gateCss` `<style id="slgGateCss">` | `html[data-slg-phase="login"]` 时隐藏所有注入层 DOM |
| 3 | `gateBoot` `<script>` | 设 `data-slg-phase="login"`，1500ms 轮询 `/__slg/session` 切 phase |
| 4 | 4 个 `<script src>` | `/__slg/panels/ui.js`、`/__slg/interaction/ui.js`、`/__slg/shell/ui.js`、`/__slg/editor/ui.js` |

`/index.html` **永不走 304**（否则注入被缓存绕过）；静态资源 `ETag = size(16)-mtime(16)`、`Cache-Control:no-cache`，文本类 ≥32768B 且带 `Accept-Encoding:gzip` 时异步 gzip 并缓存（上限 500）；`readFile` 失败重试 5 次 ×250ms；路径越出 root 回 403。

### 2.4 另一条注入通道（客户端 bundle / 资源）【实测】

`createSkillAssets(webDir).intercept(urlPath)` 在 `index.js:849-861` 改写响应：

| URL | 改写 |
|---|---|
| `/assets/resources/config.json` | 注入战法 JsonAsset 路径映射 |
| `/assets/resources/import/xx/<uuid>.json` | 返回新战法 JsonAsset 内容 |
| 客户端主 bundle `.js` | `patchClientBundle(source)` = 原串补丁 + `STRATEGY_OVERLAY_SOURCE` + `BATTLE_ANIM_SOURCE` + `CITY_WINDOW_V2_IMPL` |

`skills.js:889` 把三段模板字符串追加到原 bundle；替换对不上会抛 `客户端补丁对不上`。这三段不是独立文件，是 `skills.js` 内的常量（`:893 / :2484 / :2944`）。

### 2.5 定时器与并发模型

| 定时器 | 周期 | 职责 |
|---|---|---|
| 定时任务 tick | 200ms | 消费 `state.pending[]`：`battle_arrive` / `conscript_done` / 建筑完成 |
| 世界时钟 tick | 500ms | `settleWorld(ctx, Date.now())` |
| gateBoot（浏览器） | 1500ms | 登录门禁 |
| ui-shell（浏览器） | 1200ms | 会话/一屏一窗 |
| interaction-ui（浏览器） | 20s | 聚合状态刷新 |
| panels-ui（浏览器） | 25s | 战报红点 |

单线程事件循环，无锁；`save()` 防抖避免高频写盘；`flush()` 用于关键节点。

---

## 3. 协议详细设计

### 3.1 帧编解码（`server/codec.js`）【实测】

```text
握手（服务端→客户端，唯一明文帧）：
  JSON{seq:0,name:'handshake',code:0,msg:{key}} → gzip(level 9) → WS Binary

业务响应（服务端→客户端）：
  JSON{seq,name,code,msg} → AES-128-CBC(key=iv, ZeroPadding) → 小写 hex → gzip(9) → WS Binary

业务请求（客户端→服务端）：
  gunzip → hex 文本 → AES 解密 → 去尾部 \0 → JSON.parse → {seq,name,msg}
```

| 参数 | 值 | 位置 |
|---|---|---|
| 算法 | `aes-128-cbc`，`createCipheriv('aes-128-cbc', k, k)`，`setAutoPadding(false)` | `codec.js:18-51` |
| 补齐 | CryptoJS ZeroPadding：`16 - len%16`，对齐时仍补满一整块（1..16 字节 `0x00`） | `codec.js:23-27` |
| 密钥 | 16 位 `[0-9a-zA-Z]`，`generateKey(Date.now() ^ remotePort)` 走 xorshift32 | `codec.js:72-84`、`index.js:876` |
| GZIP | `{level:9}`，`gzipSync` / `gunzipSync` | `codec.js:21` |
| 密文表示 | 小写 hex 字符串 | `codec.js:37,45` |
| 会话密钥存储 | `conn.meta.key`（每连接独立），不用于身份校验 | `index.js:875-879` |

**WS 传输层**（`wsserver.js`，零依赖 RFC6455 最小实现）：

- `onData(chunk)` 累积到 `this.buf`，`process()` 循环解析 `fin/opcode/masked/len`；`len===126` 读 2 字节、`len===127` 读 8 字节，>64MB 直接关闭。
- 长度不足即 `return` 等下一次 `data`——这就是粘包/半包处理；解掩码 `payload[i] ^= mask[i & 3]`。
- `OP.CONT(0x0)` 累积 `fragments`，`fin` 时按首帧 `fragmentOpcode` 合并交付；`PING` 回 `PONG`、`CLOSE` 关闭、`PONG` 忽略。
- 服务端发送帧不掩码；一条 WS Binary 帧 = 一条业务消息，**业务层无自定义长度前缀、无多消息合并**。
- 升级握手只校验 `Upgrade: websocket` 与 `Sec-WebSocket-Key`，回 `sha1(key+GUID)` 的 `Sec-WebSocket-Accept`；**不校验 token / cookie / Origin / IP**。

### 3.2 请求/响应组装与错误【实测】

```js
// index.js:907-912
out = { seq: out.seq ?? req.seq ?? 0, name: req.name, code: out.code ?? 0, msg: out.msg ?? {} };
```

| 情形 | 回包 |
|---|---|
| 成功 | `code 0` + 业务 `msg` |
| 玩法校验失败 | 数字 `code`（原版 `constant/code.go`）+ `msg.reason` 英文短串 |
| 业务失败但协议 OK | `code 0` + `msg.ok=false` / `msg.reason`（`general.drawGeneral`、`general.explore`、`strategy.attack` 等） |
| handler 抛异常 | `code 500` + `{reason:'internal', message}` |
| 未知消息名 | `code 404` + `{reason:'unknown_message', name}` |
| 解码失败 | **不回包**，仅记 `decode failed` 日志并静默丢弃 |
| 心跳 | 直接 `return {code:0, msg, seq:0}`，是唯一不回显 `seq` 的消息 |

`handlers.js` 头部「铁律」：`name/seq` 原样回显、字段名逐字沿用 Go proto json tag（大小写敏感）。每次请求前先 `sanitizeMsg(req.msg)`（数值字段非有限值归 0、数组数值化），再 `settleWorld(ctx)`。

**数字错误码表**（`handlers.js:123-136`）：

| 常量 | 值 | 含义 |
|---|---:|---|
| `OK` | 0 | 成功 |
| `InvalidParam` | 1 | 通用参数/归属校验失败 |
| `CityNotMe` | 11 | 非我方城（常量定义） |
| `UpError` | 12 | 设施升级失败 |
| `ResNotEnough` | 16 | 资源不足 |
| `BuildNotMe` | 21 | 领地不属我 |
| `DecreeNotEnough` | 25 | 政令不足 |
| `CanNotBuildNew` | 49 | 不可新建要塞 |
| `CanNotUpBuild` | 53 | 不可升级要塞 |
| `CanNotDestroy` | 54 | 不可拆除要塞 |
| `OutCollectTimesLimit` | 55 | 征收次数用尽 |
| `InCdCanNotOperate` | 56 | 冷却中 |
| `NotHasJiShi` | 58 | 无集市 |
| （字面量） | 5 | `general.explore` 金不足 |
| （字面量） | 404 / 500 | 未知消息 / handler 异常 |

**常见 `msg.reason`**（去重）：`no_city / not_own_city / facility_disabled / no_such_facility / max_level / upgrading / no_cost_table / res_not_enough / times_limit / cooldown / no_market / no_guest / not_enough_gold / invalid_skill / limit_reached / not_enough_jungong / bad_order / bad_pos / bad_general / marching / no_army / zero / empty_slot / not_found / unknown_message / internal / need_general_level`；另有领域函数动态返回的 `levyCheck.reason`、`exp.reason`、`strategy*.reason`、`slotBlock()/skillUpgradeBlock()`（未集中枚举）。

**主动推送名**（`ctx.push`，`seq:0`）共 8 个：`roleBuild.push`、`roleRes.push`、`general.push`、`army.push`、`skill.push`、`chat.push`、`warReport.push`、`campaign.pending`。

---

### 3.3 WS 消息全表（`handlers.js` switch，73 个 case）【实测】

> 回包 `name` 一律等于请求 `name`；下表只列 `msg` 主要字段。所有响应先经 `sanitizeMsg` + `settleWorld`。

#### 3.3.1 连接 / 账号（5）

| name | 主要入参 | 回包 msg | 备注 |
|---|---|---|---|
| `heartbeat` | `ctime` | `{ctime, stime}` | `seq` 强制 0；传输层 PING 被动回 PONG |
| `account.login` | `username, password` | `{username, session, uid}` | 删明文，存 `passHash`；置 `session.loggedInAt` |
| `account.reLogin` | `session` | `{session}` | — |
| `account.logout` | — | `{uid}` | 置 `session.logoutAt` |
| `account.serverList` | — | `{Lists: []}` | — |

#### 3.3.2 角色（10）

| name | 主要入参 | 回包 msg |
|---|---|---|
| `role.enterServer` | — | `{role, role_res, time, token}`（`token = state.account.session`）；置 `enteredAt` |
| `role.create` | `nickName, sex, headId` | `{role}` |
| `role.roleList` | — | `{Roles:[role]}` |
| `role.myProperty` | — | `{role_res, mr_builds, generals, citys, armys}` |
| `role.myCity` | — | `{citys}` |
| `role.myRoleRes` | — | `{role_res, guide}`（`guide = materialGuide(state)`） |
| `role.myRoleBuild` | — | `{mr_builds}` |
| `role.upPosition` | `x, y` | `{x, y}` |
| `role.posTagList` | — | `{pos_tags}` |
| `role.opPosTag` | `type, x, y, name` | `{type, x, y, name}`；`type=0` 删除，上限 10 |

#### 3.3.3 大地图 / 领地（7）

| name | 主要入参 | 回包 msg | 推送 / 失败码 |
|---|---|---|---|
| `nationMap.config` | — | `{Confs}` | — |
| `nationMap.scan` | `x, y, length(默认10)` | `{mr_builds, mc_builds, armys}` | 与 `scanBlock` 合并分支 |
| `nationMap.scanBlock` | 同上 | 同上 | 同上 |
| `nationMap.giveUp` | `x, y` | `{x, y}` | 推 `roleBuild.push`（`type 53` 清除标记） |
| `nationMap.build` | `x, y, type` | `{x, y, type}` | 推 `roleBuild.push`；失败 21/49/1/16/25 |
| `nationMap.upBuild` | `x, y` | `{x, y, build}` | 仅 `type 56` 可操作，与 `delBuild` 合并 |
| `nationMap.delBuild` | `x, y` | 同上 | 同上 |

#### 3.3.4 城池设施 / 内政（5）

| name | 主要入参 | 回包 msg | 备注 |
|---|---|---|---|
| `city.facilities` | `cityId, realCityId` | `{cityId, realCityId, facilities, allCount, hiddenCount, legacy}` | `cityId=0` 回落主城；未知城 `code 1 + no_city`；默认只回生效项 |
| `city.upFacility` | `cityId, realCityId, fType` | `{cityId, realCityId, facility, role_res}` | 推 `roleRes.push`；`facility_disabled` 不扣资源 |
| `interior.collect` | `cityId` | `{gold, limit, cityId, cur_times, next_time}` | 推 `roleRes.push`；按城独立次数/CD |
| `interior.openCollect` | `cityId` | `{limit, cur_times, next_time}` | — |
| `interior.transform` | `from[4], to[4]` | `{}` | 需集市(15)；推 `roleRes.push` |

#### 3.3.5 武将 / 人事（8）

| name | 主要入参 | 回包 msg | 推送 |
|---|---|---|---|
| `general.myGenerals` | — | `{generals}` | — |
| `general.drawGeneral` | `drawTimes(1..10), cityId, cfgId?`（★ P13 指名招募） | `{generals, reason(no_guest/not_enough_gold/**not_today/guest_left/not_arrived/refused**), cost, today, refused[], rate}` | `general.push`、`roleRes.push` |
| `general.composeGeneral` | `gIds[], compId` | `{generals}` | — |
| `general.addPrGeneral` | `compId, forceAdd, strategyAdd, defenseAdd, speedAdd, destroyAdd` | `{general}` | `general.push` |
| `general.convert` | `gIds[]` | `{gIds, gold, add_gold}` | `roleRes.push` |
| `general.upSkill` | `gId, cfgId, pos(0..2)` | `{gId, cfgId, pos, ok, reason, lv, cost, gold, jungong, hint}` | `skill.push` / `general.push` / `roleRes.push` |
| `general.downSkill` | 同上 | 同上 | 同上（与 upSkill 合并分支） |
| `general.lvSkill` | 同上（可不传 cfgId） | 同上 | 同上；消耗军功 |

#### 3.3.6 军队 / 出征（5）

| name | 主要入参 | 回包 msg | 备注 |
|---|---|---|---|
| `army.myList` | `cityId` | `{cityId, armys}` | — |
| `army.myOne` | `cityId+order` 或 `armyId` | `{army}` | — |
| `army.dispose` | `cityId, order(1..3), position(0..2), generalId` | `{army}` | 校验归属/槽位/武将/行军中；推 `army.push` |
| `army.conscript` | `armyId, cnts[3]` | `{army, role_res, etaSec, need, levy, levyCommit, farmConflict, levyNote}` | `ctx.schedule({type:'conscript_done'})`；推 `roleRes.push` / `army.push` |
| `army.assign` | `armyId, cmd, x, y` | `{army}` | `cmd=1` 攻击：排程 `{type:'battle_arrive', x,y,seed}`；推 `army.push` |

#### 3.3.7 战报（2）

| name | 入参 | 回包 msg |
|---|---|---|
| `war.report` | — | `{list: 最近 100 条 warReports}` |
| `war.read` | `id`（0 = 全部） | `{id}`；置 `a_is_read/d_is_read` |

#### 3.3.8 技能 / 客栈 / 探索 / 元信息（4）

| name | 入参 | 回包 msg |
|---|---|---|
| `skill.list` | — | `{list: state.skills}` |
| `tavern.guests` | `cityId` | `{now, today, cost, day, nextAt, cityId, exploredToday, exploreCost:100}`；`today` 含 `xiangxing/yili/xiangxingGap/recruitRate/state` |
| `general.explore` | `cityId` | 成功 `{general, rate, parts, cityId}`；失败 `{reason:'not_found', rate, cityId, name, favor, charged:0, parts, xiangxingGap, yili}`；金不足 `code 5` |
| `world.meta` | — | `{conscript:{wood,iron,grain,gold,timePer}, drawGeneralCost, collectLimit, collectIntervalSec}` |

#### 3.3.9 联盟（15，单机仅自己）

| name | 入参 | 回包 msg |
|---|---|---|
| `union.create` / `union.list` / `union.member` / `union.info` / `union.applyList` / `union.log` | `name` / — / `id` / `id` / `id` / — | `{id,name}` / `{list:[{id,name,cnt,notice,major}]}` / `{id,Members}` / `{id,info}` / `{id,applys:[]}` / `{logs:[]}` |
| `union.join` / `verify` / `exit` / `dismiss` / `notice` / `kick` / `appoint` / `abdicate` | 任意 | `{...m}` 原样回显（8 个 case 共用分支） |
| `union.modNotice` | `text` | `{id, text}` |

#### 3.3.10 聊天（6）

| name | 入参 | 回包 msg |
|---|---|---|
| `chat.login` | `rid, nickName` | `{rid, nickName}` |
| `chat.logout` | `RId`（大写） | `{RId}` |
| `chat.chat` | `type, msg` | `{rid, nickName, type, msg, time}`；推 `chat.push`，`state.chat` 上限 200 |
| `chat.history` | `type` | `{type, msgs}` |
| `chat.join` / `chat.exit` | `type, id` | `{type, id}`（合并分支） |

#### 3.3.11 战役 / 剧本（3）

| name | 入参 | 回包 msg |
|---|---|---|
| `campaign.status` | — | `{day, scale, drift, band, choice, ending, endingDay, chapter, frozen, blueprints, spearmanId}` |
| `campaign.choose` | `option`（`'lend'\|'refuse'\|0\|1`） | `{choice, ok}`；失败 `code 1` |
| `campaign.speed` | `scale` | `{scale}`（只允许 4 或 1） |

#### 3.3.12 战略（3）

| name | 入参 | 回包 msg |
|---|---|---|
| `strategy.attack` | `cityId, armyId, frac, fromCityId` | `{ok, marching, reason, marchId, arriveDay, need, city, grainCost, marchDays, km, speed, from, armyId, troops, deploy, frac}`；`frac∈(0,1]`，失败 `code 1`，**`ok` 是唯一判定** |
| `strategy.recallMarch` | `marchId` | `strategyRecallMarch()` 原样结果 |
| `strategy.clearThreat` | `garrisonId, armyId` | `clearThreat()` 原样结果 |

> **归属澄清**：WS 侧**没有**编辑器、六面板、事件点选消息；这些走 HTTP `/__slg/*`（§3.4）。`default` 分支回 `404 unknown_message`。

### 3.4 HTTP 端点全表【实测】

通用：`json()` → `Content-Type: application/json; charset=utf-8` + `Cache-Control:no-store`；`sendJson()` 在 ≥2048B 且带 `Accept-Encoding:gzip` 时压缩并附 `Vary`；`readJson(req, limit, done)` 超限/解析失败回调 `null`。所有响应统一 `Access-Control-Allow-Origin:*`、`Access-Control-Allow-Headers:*`，`OPTIONS` 回 204。

| # | 方法 | 路径 | 请求 | 响应 | 证据 |
|---|---|---|---|---|---|
| 1 | ANY | `/account/forgetpwd` | — | 纯文本 `forgetPwd` | `index.js:421` |
| 2 | ANY | `/account/resetpwd` | — | 纯文本 `resetPwd` | `:422` |
| 3 | ANY | `/account/*` | — | `{"code":0}` | `:420-425` |
| 4 | GET | `/__slg/panels/ui.js` | — | `PANELS_UI_SOURCE` | `:429-438` |
| 5 | GET | `/__slg/interaction/ui.js` | — | `IX_SOURCE`（内联 `window.SLG_TERMS`） | `:440-449` |
| 6 | GET | `/__slg/shell/ui.js` | — | `SHELL_UI_SOURCE` | `:451-460` |
| 7 | GET | `/__slg/editor/ui.js` | — | `EDITOR_UI_SOURCE` | `:462-471` |
| 8 | GET | `/__slg/editor/state` | — | `{...editorList(cfg), skills:[{cfgId,name}]}` | `:472-481` |
| 9 | POST | `/__slg/editor/save` | ≤16384B，武将编辑字段 | `{ok,cfgId,stateSynced,row}` | `:482-494` |
| 10 | POST | `/__slg/editor/reset` | ≤8192B `{cfgId}` | 重置结果 | `:495-507` |
| 11 | GET | `/__slg/interaction/state` | — | 聚合态（可 gzip） | `:508-515` |
| 12 | GET | `/__slg/panels/selfcheck` | — | `panelSelfCheck()` | `:516-519` |
| 13 | GET | `/__slg/panels/reports-head` | — | `{ok:true, latest, unread}` | `:520-526` |
| 14 | GET | `/__slg/panels/state` | — | `panelState(state,cfg)` | `:527-531` |
| 15 | POST | `/__slg/panels/action` | ≤65536B | `{...panelAction, view:panelState}`；体无效 400 | `:532-543` |
| 16 | GET | `/__slg/oath/options` | — | `{ok:true, ...oathOptions(state)}` | `:545-550` |
| 17 | POST | `/__slg/oath/choose` | ≤16384B | `chooseOath()` | `:551-560` |
| 18 | GET | `/__slg/session` | — | `{ok,ready,phase,loggedInAt,enteredAt,username,day}` | `:562-567` |
| 19 | GET | `/__slg/status` | — | 缩进 2 的服务状态 JSON（见 FR-32） | `:568-583` |
| 20 | GET | `/__slg/state` | — | 全量 `state`（可 gzip） | `:584-587` |
| 21 | GET | `/__slg/general-dossier?cfgId=&name=` | query | `dossierFor(state,{cfgId,name})` | `:588-594` |
| 22 | GET | `/__slg/strategy/state` | — | `strategyViewState(state,cfg)`（约 59KB） | `:595-598` |
| 23 | POST | `/__slg/strategy/action` | ≤16384B `{action\|act,...}` | 见下表；未知 act `{ok:false,reason:'bad_action'}` | `:600-673` |
| 24 | GET | `/__slg/strategy/panorama.png` | — | `image/png` 或 404 `no panorama` | `:674-683` |
| 25 | GET | `/__slg/strategy/detail` | — | `detail.json` 原文；读失败 `{}` | `:684-694` |
| 26 | GET | `/__slg/strategy/layers/<name>` | — | 图片（`public,max-age=604800`）；非法名 `404 bad layer` | `:695-716` |
| 27 | POST | `/__slg/strategy/tick` | 不读 body | `advanceToNextTurn(ctx,Date.now())` 结果 | `:717-724` |
| 28 | POST | `/__slg/restart` | — | `{ok:true, day}` | `:725-739` |
| 29 | GET | `/__slg/save/slots` | — | `{current, slots:[slot1..3]}` | `:740-749` |
| 30 | POST | `/__slg/save/slot` | `{slot:1\|2\|3, action:'save'\|'load'}` | `{ok:true, slots}`；400/404/500 见 §11 | `:750-778` |
| 31 | GET | `/__slg/save/export` | — | 附件 `shuanghan-save-<ts>.json` | `:779-789` |
| 32 | POST | `/__slg/save/import` | ≤40MB，须含 `role` | `{ok:true, day}`；`not_a_save` / `bad_save` | `:790-810` |
| 33 | GET | `/__slg/gm` | — | `server/gm/index.html` | `:811-816` |
| 34 | GET | `/__slg/board` | — | `server/gm/board.html` | `:817-822` |
| 35 | GET | `/__slg/gm/overrides` | — | `loadOverrides()` 全量 | `:823-827` |
| 36 | POST | `/__slg/gm/overrides` | 原始 JSON ≤100000B | `{ok:true, overrides}` | `:828-847` |
| 37 | ANY | 其它 | — | `serveStatic()`：200/304/403/404/500 | `:863-869` |

#### 3.4.1 `/__slg/strategy/action` 的 27 个 act【实测；2026-11-16 补 captiveRelease/captiveExecute】

| act | 领域函数 | 关键字段 |
|---|---|---|
| `formup` | `strategyFormup` | body 原样 |
| `transport` | `strategyTransport` | body 原样 |
| `reward` | `rewardGeneral` | body 原样 |
| `invest` | `strategyInvest` | body 原样 |
| `cancelInvest` | `cancelInvest` | `{taskId}` |
| `captive` | `recruitCaptive` | `{idx}`；300 金、率见 §7.11 |
| `captiveRelease` | `releaseCaptive` | `{idx}`；名望 +2、态度 −5（★ 2026-11-16，经组装层注入 `diplomacyApi`） |
| `captiveExecute` | `executeCaptive` | `{idx}`；恶名 +1、名望 −2、态度 −15 且董卓豁免（★ 2026-11-16） |
| `attack` | `strategyAttack` | `{cityId,armyId,frac,fromCityId,confirmBattle}`；`frac` 限 (0,1] 默认 1，`confirmBattle` 默认 true |
| `recall` | `strategyRecallMarch` | `{marchId}` |
| `battleConfirm` | `strategyConfirmBattle` | `{marchId}` |
| `battleRetreat` | `strategyRetreatBattle` | `{marchId}` |
| `digest` | `strategyDigestDone` | `{cityId}` |
| `disarm` | `disarmForGold` | `{armyId,count}` |
| `sellGrain` | `sellGrain` | `{grain}` |
| `craft` | `craftJungong` | `{count,drain}` |
| `smeltStone` | `smeltStone` | `{count,drain}` |
| `investDev` | `investDev` | `{cityId,field,count,drain}` |
| `emergencyConscript` | `emergencyConscript` | `{cityId,count,mercenary}` |
| `relocateCapital` | `relocateCapital` | `{cityId}` |
| `appoint` | `strategyAppoint` | `{cityId,goal}` |
| `cancelAppoint` | `strategyCancelAppointment` | `{apptId}` |
| `diplo` | `diplomacyAct` | `{diploAction\|sub, faction, target, gold}` |
| `scenario` | `strategySetScenario` | `{scenario\|id}` |
| `eventChoice` | `strategyEventChoice` | `{id,choice}` |
| `reorder` | `strategyReorderMarch` | `{marchId,dir}` |
| `preview` | `previewAssault` | `{cityId,fromCityId,armyId,frac}`；**纯只读沙盒，不落盘** |

落盘条件：`result.ok && act !== 'preview'` 才 `save()`。

### 3.5 HTTP 错误响应形状（与 WS 不同）

`{ok:false, message:<err.message>}` + 500（editor/面板/oath 异常）；`400 {ok:false,message:'请求体无效'}`；`{ok:false,reason:'bad_action'}`；`bad_request` / `empty_slot` / `io_error` / `not_a_save` / `bad_save`；纯文本 `404 no panorama` / `bad layer` / `no layer`；静态 `403 Forbidden` / `404 Not found` / `500 Internal error`。

---

## 4. 状态与数据设计

### 4.1 `state` 顶层字段（`createWorld` + `normalizeWorld`）【实测】

`SAVE_VERSION = 3`（`world.js:37`）。

| 字段 | 形状 / 初值 | 说明 |
|---|---|---|
| `version` | 3 | `loadWorld` 只接受 1/2/3 |
| `createdAt` / `savedAt` | `Date.now()` | 建档 / 最后保存 |
| `account` | `{username, password:'', uid:1, session:'offline-session'}` | 登录后删 `password` 改 `passHash` |
| `role` | `{rid:1, uid:1, nickName, sex, sid:1, balance:0, headId, profile:''}` | 沿用 Go proto tag |
| `roleRes` | `{wood,iron,stone,grain,gold,decree, *_yield, depot_capacity, jungong}` | 初值各 10000 / decree 20 / yield 1000 / cap 1e6 / jungong 0 |
| `citys` | `Array<makeCity>` | 本地城池（新档 1 座主城） |
| `builds` | `Array<makeBuild>` | 领地/要塞（主城周边 6 格） |
| `facilities` | `{[cityId]: Array<{name,level,type,up_time}>}` | 每城设施模板，初始全 0 级 |
| `generals` | `Array<makeGeneral>` | 新档仅主角 `cfgId 880001`、`isProtagonist:true`、skills `[19001,null,null]` |
| `armys` | `Array<makeArmy>`（3 支，id 2000~2002） | 第 0 队 `[主角,0,0] / [800,0,0]` |
| `skills` | `[{id:19001, cfgId:19001, generals:[1000]}]` | 已拥有战法登记表 |
| `warReports` | `[]`（上限 100） | 战报 |
| `posTags` / `union` / `chat` | `[]` / `null` / `[]`（上限 200） | 地图标记 / 联盟 / 聊天与系统播报 |
| `roleAttr` | `{collectTimes:0,lastCollectTime:0,parentId:0}` | 采集杂项 |
| `counters` | `{generalId:1001,armyId:2003,cityId:2,warReportId:1,unionId:1}` | `nextId(state,key)` 发号 |
| `pending` | `[]` | 定时任务（行军/征兵/建筑升级） |
| `battleLog` | `[]`（上限 200） | 确定性内核可复核记录 |
| `clock` | `{day:1, scale:1, lastRealMs, accMs:0}` | 游戏时钟 |
| `drift` | `{score:0, band:'canon', log:[]}` | 蝴蝶进度 |
| `campaign` | `{id:'chapter1', fired:{}, choice:null, waveFactor:null, blueprints:[], ending:null, spearmanId:0, pendingDay:0, lastPatrolDay:0, chapter:1}` | 序章状态 |
| `garrisons` / `chronicle` | `[]` / `[]` | 黄巾驻军 / 身故履历 |
| `oath` | `{done:false}` | 举义标记；旧档缺字段视为已举义 |
| `skillVersion` | 3 | 战法体系版本 |
| `tavern` / `fates` / `strategy` / `interior` / `items` / `equipment` / `panelBase` / `panelMerits` / `skillbook` / `panelBootstrapped` | 由 `ensureXxx` 补齐 | 见 §4.2 |

### 4.2 `state.strategy` 与 `state.interior` 结构【实测】

```text
state.strategy = {
  version, turn, lastTurnDay, events(≤200), scenarioId, scenarioYear,
  eventSys:{fired,cooldown}, pendingEvents, flags, everOwned, battleHistory, fame,
  cities:{[id]:{owner,troops,defense,besieged,...}}, relations, memory, chronicle, cityLogs,
  resources:{[faction]:{gold:8000, grain:12000}},   // grain 只读汇总
  // 运行期挂载：
  cityEcon:{[id]:{pop,devAgri,devTrade,devArms,devDef,morale,order,store,supplyCut,supplyDays,levied,lastLevyTurn,...}},
  interiorTasks, appointments, marches, draft, movements, intel, diplomacy, diploPrompt,
  lastEventTick, deadGenerals, brainRunner(可注入钩子), playerCity, capitals, scenarioGoal
}

state.interior = { posts:{...}, morale:70, order:70, corruption:5, appliedThisTurn:null, appliedTurn:-1 }
state.tavern   = { people:[], lastAnnouncedDay:0, schedule?, explores? }
state.skillbook= { unlocked:[], research:[] }
```

**懒建字段**（非 `createWorld`/`normalizeWorld` 顶层）：`state.seed`（**未在 createWorld 写入**，全代码 `?? 20261110` 兜底，仅工具/测试注入）、`captives`、`resLedger`（≤240）、`resLogs`、`market`、`events`、`knobs`、`standInSeq`、`strategyMapCache`。

### 4.3 存档与迁移【实测】

| 环节 | 实现 |
|---|---|
| 版本 | `SAVE_VERSION=3`；`loadWorld` 白名单 1/2/3，v1 自动换战法 |
| 归一 | `normalizeWorld` 补字段、`campaign.chapter ??=1`、`roleRes.jungong` 非有限→0、`armys` 三槽非负整数、`campaign.fired >80` 键只留 `'1'` + 最近 60 日、逐将 `applyGeneralExp(g,0)` + `innateOf` 补自带战法 |
| 原子写 | `writeFileSync(tmp) + renameSync(tmp, FILE)` |
| 三档 | `save.json` / `save.slot2.json` / `save.slot3.json`；`slotInfoOf()` 返回 `exists/bytes/updatedAt/day/roleName/chapter/ending` |
| 导入 | 上限 40MB，须含 `role`；旧档重命名 `save.json.before-import-<ts>.json` |
| 导出 | `Content-Disposition: attachment; filename="shuanghan-save-<ts>.json"` |
| 撤销栈 | 读档清空；GDD §11.4 的 `undoStack/migrationLog` 为**规划结构**，当前实现未采用统一迁移注册表【偏差】 |

### 4.4 配置加载链（`server/config.js`）【实测】

```text
defaultConfDir() → conf/json/basic.json 判定
  ├─ basic.json / map_build.json / general/general.json / general_basic.json /
  │  general_arms.json / npc/npc_army.json / facility/facility.json /
  │  facility_*.json(26) / map_build_custom.json / skill/skill_outline.json
  ├─ conf/mapRes_0.json（失败退化默认地形）
  ├─ conf/campaign/protagonist.json（主角并入 general.list，按 cfgId 去重）
  └─ conf/campaign/heroes-240.json（240 位史载五维）
        ↓
PCT_KEYS(五维) >100 → toPercentFromRaw(v/100)
heroes-240 与原表交集 → 史载五维覆盖主属性；非交集生成派生条目（cfgId 240001+）
        ↓
索引：confs(43) / facilityByType(26) / buildCustomByType(1) / generalByCfg(505)
      / generalOriginal(覆盖前深拷贝) / armsByType(9) / tileAt(x,y) / baseTileAt
      / facilityMaxLevel|Need|Time|Values|Additions / buildCustomCfg
```

`loadConfig()` 是纯函数、每次重新读盘；但全工程唯一调用点是 `index.js:111`，因此进程生命周期内是事实上的单例 `cfg`。

**覆盖层**（`gm/overrides.js`）：`emptyOverrides() = {tiles:[],facilities:[],city:null,rules:{},story:{},generals:{}}`；`loadOverrides()` 以 `statSync(FILE).mtimeMs` 为缓存键，读失败回退空覆盖；`saveOverrides()` 走 `sanitize → tmp → renameSync → 刷缓存`。`sanitizeOverrides` 上限：tiles ≤200、facilities ≤40、generals ≤600、city `{x,y∈[0,200],name≤16}`、story 仅 lend/refuse ≤200 字；`RULE_RANGES = {upkeepPerSoldier:0~100, lendGrain:0~100000, realMsPerDay:1000~3600000, blueprintBonus:0~10}`。

**生效点**：`rules → chapterRules()`（缓存键 `chapter1.json mtime : overrides.json mtime`）→ `clock.js / economy.js / campaign.js / strategy.js / tavern.js`；`story → campaign.js` 序章播报；`city/facilities → createWorld()`；`tiles → cfg.tileAt + applyTileOverlay`；`generals → cfg.generalByCfg + world.innateOf + current state.skill sync`。

### 4.5 内容资产清单【实测】

| 分类 | 数量 | 主要文件 |
|---|---:|---|
| `conf/**/*.json` | **76** | 另有 18 张 PNG/JPG 图层 |
| 运行时武将 | **505** | `general.json` 368 + 主角 1 + `heroes-240.json` 新增 136（交集 104） |
| 运行时战法 | **177** | `skills.json` 31 + `library-skills.json` 20 + `library-skills-extra.json` 29 + `protagonist-skill.json` 1 + `innate-skills.json` 96 |
| 初始战法映射 | **424** | `campaign/hero-skills.json`；审计 `w0Linked 139 / derived 237 / authored 1` |
| 官网名录（未实装） | 796 | `campaign/skill-source.json` |
| 战法配方 | 80 | `panels/skill-recipes.json` |
| 城池 / 路网 / 州 / 关隘 | 72 / 117 / 13 / 8 | `campaign/strategy/map.json`、`detail.json` |
| 剧本 | 6 | `scenarios/*.json`（184/190/200/208/221/229） |
| 事件 | 150 | `events.json` 52 + `events-extra.json` 98 |
| 宿命组 / 关系 bonds | 24 / 30 | `fate-groups.json`、`relations.json` |
| 术语 | 134 | `interaction/terms.json` |
| 设施类型 | 26（生效 7） | `json/facility/facility.json` + 26 张等级表 |
| 装备 / 官职 / 列传 / 人物 | 18 / 5 / 120 / 8 | `panels/items.json`、`posts.json`、`generals-lore.json`、`campaign/people.json` |
| 地图格 | 40,000 | `mapRes_0.json`（200×200） |
| 原版画面 | 1,582 文件 / 179,831,865 B | `web/`，指纹 `ee987ec2…50485` |

**口径纪律**：README「战法 80」= M3-8 快照；P0「48 条战法」= 已废弃第一版；当前运行时是 177。三套数字不可混用（§17）。

---

## 5. 模块详细设计

### 5.1 `server/domain/` 42 个模块全表【实测，核查快照合计约 10,031 行】

> 「上游」= 静态 `import` 本模块的文件。行数会因并行开发微调，以接口签名为准。

| 文件 | 行数 | 职责 | 主要导出（签名 → 返回形状） | 上游 |
|---|---:|---|---|---|
| `appointment.js` | 191 | 委任对象化：每旬自动派单真实内政任务 | `GOALS`；`appointments(state)→Array`；`appointmentView(state,a)`；`appointmentListView(state)`；`strategyAppoint(state,cfg,ctx,{cityId,goal})→{ok,appointment,first}`；`appointmentTick(state,cfg,ctx)→{started,blocked,resumed,ended}`；`strategyCancelAppointment(state,ctx,{apptId})` | `city-econ.js`、`strategy.js` |
| `aptitude.js` | 41 | 兵种适性唯一权威（展示/结算同源） | `ARMS_STAT`；`armsApt(g,armsIdx)→1.00~1.15`；`aptTriple(g)→number[3]`；`bestArms(g)→{arms,pct}` | `battle.js`、`city-econ.js`(re-export) |
| `armory.js` | 187 | 物资去处：军工督造/折石/开发度/府库材料说明 | 常量 `JUNGONG_WOOD=80 / JUNGONG_IRON=40 / STONE_PER_JUNGONG=200 / DEV_CAP=120`；`ensureJungong(state)`；`craftJungong / smeltStone / investDev`；`materialGuide(state)` | `handlers.js`、`index.js`、`panels.js` |
| `battle-narrative.js` | 337 | 结构化战斗数据 → 中文战报/推演人话（只读） | `skillByName(name)`；`skillProfile(key,lv)`；`desText(s,level)`；`skillExplain(profile)`；`actSentence(a)`；`previewNarrative(p)→{verdict,verdictTone,headline,rows,tips,myNotes,defenderNotes,ratio}`；`reportVerdict(r)` | `battle.js`、`handlers.js`、`panels.js`、`strategy.js` |
| `campaign.js` | 373 | 序章节拍：推时钟、入账、按日触发剧情/黄巾波次/结局 | `chapterRules()`；`sayDrift`；`applyChoice`；`noticeRecruit`；`pendingPayload`；`settleCampaign(state,cfg,ctx,now)→{days,day}`；`chooseChapter`；`onTileCleared` | `handlers.js`、`strategy.js` |
| `captive-rules.js` | 43 | 招降成功率唯一权威公式 | `CAPTIVE_COST=300`；`captiveRecruitRate(state,cap)→0~0.95`；`captiveRateParts(state,cap)→{parts,final}` | `interaction.js`、`panels.js`、`strategy.js` |
| `captive-reputation.js` | 48 | ★ 2026-11-16 俘虏处置后果的零依赖叶子 | `FAME_PER_RELEASE=2`、`INFAMY_PER_EXECUTE=1`、`ATTITUDE_ON_RELEASE=-5`、`ATTITUDE_ON_EXECUTE=-15`、`EXEMPT_FACTION_ON_EXECUTE='sili'`、`FAME_DEFECT_CAP=40`、`defectRateWithFame(base,fame)` | `captives.js`、`strategy.js` |
| `captives.js` | 85 | 俘虏链路统一入口：战报确定性俘虏 + 释放/处斩 | `captureFromBattle(state,cfg,{report,place,day,seed})→Array`；`releaseCaptive(state,{idx})`；`executeCaptive(state,{idx})` | `handlers.js`、`index.js`、`strategy.js` |
| `chronicle.js` | 18 | 身故履历，只记录不改数值 | `recordDeath(state,entry)→{generalId,cfgId,name,day,band,official,played}` | `command.js` |
| `city-econ.js` | 443 | 逐城产量/人口/城库/灾害/忠诚/俸禄/粮道接入的统一旬入口 | `cityName`；`ensureCityEcon`；`devLevel`；`conscriptFactor`；`cityYield(state,cityId)`；`playerStockYield / playerGrainYield / playerGoldYield`；`cityLayer`；`popTick`；`disasterTick`；`cityDevTick`；`loyaltyTick`；`cityEconTick`；`consumeMarchGrain`；`deliverGrain`；`armsCounter`；re-export `armsApt/aptTriple/bestArms` | `armory.js`、`handlers.js`、`interaction.js`、`panels.js`、`strategy.js` |
| `diplomacy.js` | 494 | 外交：态度理由链 + 8 动作门槛与后果 | `PLAYER_ID`；`ACTIONS`；`factionNameOf`；`factionList`；`attitudeOf(state,a,b)→{value,factors}`；`diplomacyView`；`diplomacyAct`；`adjustAttitudeByEvent`；`noteCityCaptured`；`truceActive` | `strategy.js` |
| `dossier.js` | 66 | 武将详情两页：历史传记 + 本局画像 | `dossierFor(state,{cfgId,name})→{name,cfgId,official,portrait:{...}}` | `index.js` |
| `drift.js` | 24 | 蝴蝶进度：只记 0~100 与段落 | `bandOf(score,bands)`；`addDrift(state,amount,reason,bands)` | `campaign.js` |
| `economy.js` | 120 | 日产与军饷、收支流水（唯一记账形状） | `countSoldiers`；`projectGrain`；`recordRes`；`applyDays(state,cfg,days,rules)→{days,upkeepPaid,salaryPaid,soldiers}`；`facilityBonus` | `armory/campaign/city-econ/handlers/interior-task/panels/strategy` |
| `event-dsl.js` | 257 | 事件条件 DSL：字段/算子白名单求值、schema 校验、效果词解析 | `WHEN_FIELDS / OPS / LAYERS / EFFECT_KINDS`；`evaluateEvent(when,ctx)→boolean`；`validateEventSchema(e,heroNames)→string[]`；`parseEffect(fx)` | `event-engine.js`、`check-events.mjs`、`tests` |
| `event-engine.js` | 116 | 每旬筛选（上限 2 条）、互斥冷却、效果落账 | `ensureEventState`；`eventCooldownTick`；`selectEvents(events,ctx,state,opts)→{selected,deferred}`；`applyEffects(state,event,choiceId,api)→Array` | `strategy.js` |
| `facility-catalog.js` | 94 | 生效设施单一权威清单 | `EFFECTIVE_ADDITIONS / GATE_FACILITIES / AXIS_LABEL`；`effectiveAxes(cfg,f)`；`isActiveFacility`；`facilityEffectText`；`legacyFacilitiesEnabled`；`facilityView(cfg,list,opts)→{rows,allCount,hiddenCount,legacy}` | `handlers.js`、`panels.js` |
| `failstate.js` | 226 | 四失败态 + 每条至少一条出路 + 结局判定 | `failstates(state)→{bankrupt,troopsStarved,noGeneral,capitalLost,actions}`；`disarmForGold / sellGrain / emergencyConscript / makeStandInGeneral / relocateCapital`；`evaluateEnding(state)` | `index.js`、`strategy.js`、`system-audit.mjs` |
| `fate-groups.js` | 102 | 宿命 24 组：结构校验、相性环距、组合评估 | `XIANGXING_RING=149`；`loadFateGroups`；`validateFateGroups`；`groupById`；`fatesOfHero`；`xiangxingGap`；`evaluateFates`；`xiangxingBonus` | `strategy.js`、`tests` |
| `fate.js` | 45 | 宿命链状态机，只回答「这一站写谁的名字」 | `chainDef`；`ensureFates`；`fateState`；`transitionFate`；`actorName` | `campaign.js`、`dossier.js`、`world.js` |
| `garrison.js` | 78 | 城池守将确定性分配（FNV-1a，同城恒定跨城不重） | `garrisonPool(cfg,{preferNames,exclude})`；`garrisonCfgIds(cfg,{cityId,owner,level,exclude,preferNames})→number[]`；`garrisonLabel` | `battle.js`、`strategy.js` |
| `general-editor.js` | 184 | 武将编辑器领域层，只写覆盖层 | `EDIT_RANGES / EDIT_KEYS`；`sanitizeGeneralEdit`；`editorList(cfg)→{ok,total,rows,ranges}`；`editorSave(cfg,state,input)`；`editorReset`；`editorRowOf`；`overridesFreshStamp` | `index.js` |
| `general-progress.js` | 69 | 武将等级：经验只来自出征折损，上限 10 | `GENERAL_LEVEL_CAP=10`；`expToAdvance(lv)=40*lv`；`applyGeneralExp`；`generalProgress`；`grantBattleExp`；`levelUpSentence` | `handlers.js`、`panels.js`、`strategy.js`、`world.js` |
| `general-stat.js` | 90 | 0~100 百分制守门人（零依赖叶子） | `clampFive`；`toGameStat`；`toPercentFromRaw`；`toGameGrow`；`toDestroyStat`；`toCostStat`；`gameStatOf(cfg,g,key,fallback=60)`；`charmStatOf` | `config.js`、`city-econ/diplomacy/interior-task/panels/strategy` |
| `interaction.js` | 279 | 交互增强层只读聚合（单一事实源） | `interactionState(state,cfg)→{ok,day,turn,month,undo,season,treasury,salary,cities,generals,captives,marches,alerts,agenda,turnPreview,fieldGaps,pendingEvents}` | `index.js` |
| `interior-task.js` | 337 | 内政任务状：工期与每旬增量唯一口径 | `TICK_DAYS=10`；`KINDS`；`interiorTasks`；`officerStat`；`pickOfficer`；`planTicks(kind,stat)→{ticks,perTick}`；`taskView`；`interiorTaskView`；`beginInteriorTask`；`advanceInteriorTasks`；`cancelInteriorTask` | `appointment/city-econ/interaction/strategy` |
| `knobs.js` | 72 | 全局 30 个可调参数表（零依赖叶子） | `KNOBS`；`knobGet(state,name)`；`knobSet`；`knobSnapshot` | `battle/city-econ/economy/interaction/strategy/supply` |
| `levy.js` | 156 | 户役制唯一权威源 | 常量 `HOUSEHOLD_SIZE=5 / ADULT_MALE_RATE=0.62 / POP_PER_SOLDIER=4 / TURN_CAP_RATE=0.05 / SEASON_FACTOR`；`seasonOf`；`levyTurnOf`；`levyLedger`；`levyView`；`checkLevy`；`commitLevy`；`farmConflictOf` | `handlers.js`、`panels.js`、`strategy.js` |
| `map-lod.js` | 49 | 地图标注分级（零依赖叶子） | `ZOOM_TIERS`；`cityLabelRank`；`labelTierForZoom`；`labelPolicy`；`shouldLabel` | `strategy.js` |
| `march.js` | 143 | 行军校验：只读 `detail.json` 路网，BFS 判可通行 | `marchGraph`；`isGateBlocked`；`setGateStatus`；`edgePassable`；`canMarchBetween(from,to)→{ok,path,edges,routeId,via}`；`marchableNeighbors`；`resetMarchCache` | `diplomacy/panels/strategy/strategy-brain/strategy-log/supply` |
| `oath.js` | 125 | 举义助手 + 史载/主角五维（刻意只依赖 `node:fs`） | `factionsConf`；`factionById`；`strategyCity`；`oathOf`；`oathPending`；`oathFactionOf`；`factionTraitOf`；`loreStat(cfgId,dim)`；`protagonistStat(state,dim)` | `campaign/captive-rules/handlers/interior-task/panels/relation/strategy` |
| `panels.js` | 886 | 六面板领域层纯函数聚合 | `PANEL_CONF`；`ensurePanels`；`postBonusPct`；`yieldBonusByResource`；`filledPostCount`；`careerOf`；`panelState(state,cfg)`；`panelAction(state,cfg,action)`；`panelSelfCheck()`；`interiorFacilities` | `campaign/index/world` |
| `people.js` | 19 | 只读 `people.json` 的人物档案查询 | `peopleById(id)`；`peopleByTitle(title)` | `campaign/command/dossier` |
| `relation.js` | 160 | 相性/义理/关系网/登庸成功率构成条 | `relationConf`；`xiangxingOf`；`xiangxingGap`；`yiliOf`；`xiangxingBonus`；`bondsOf`；`relationSummary`；`talentRecruitRate(state,cfg,person)→{rate,parts,gap,yili}`；`relationGraph` | `handlers.js`、`panels.js` |
| `slots.js` | 57 | 3 战法格 + 天赋格的解锁/费用/拦截理由（零依赖） | `SKILL_LEVEL_CAP=10`；`skillUpgradeCost(lv)=20*lv²`；`skillUpgradeBlock`；`skillActionHint`；`slotBlock`；`unlockTalent` | `handlers.js`、`panels.js` |
| `story.js` | 13 | 按偏离段选一稿（零依赖） | `lineFor(band,drafts)`；`nodeDraft(band)` | `campaign.js` |
| `strategy-brain.js` | 539 | 诸侯战役规划脑：只产指令单，绝不改世界 | `PERSONA_AXES`；`readBrainMemory`；`commitBrainGoal`；`noteBattleOutcome`；`noteCityLost`；`planCampaign(faction,snapshot,state)→{protocol:'slg-ai-orders-v1',turn,season,faction,personality,difficulty,seed,goal,internal_orders,strategy_orders,explain}` | `strategy.js` |
| `strategy-log.js` | 251 | 出征账与天下日志：里程/汉里/粮饷报价、月度大事记、财报 | `marchSpan`；`horseShare`；`quoteMarch`；`ensureChronicle`；`openMonth`；`noteMove`；`noteCity`；`closeMonth`；`booksOf` | `panels.js`、`strategy-brain.js`、`strategy.js` |
| `strategy-map.js` | 122 | 战略地图规范化：稳定 ID 注册表、道路 ID 端点解析（零依赖） | `emptyRegistry`；`reconcileRegistry`；`buildStrategyMap(incomingCities,routesRaw,registryIn)` | 构建期工具（`server/` 内未发现 import） |
| `strategy-rng.js` | 19 | 战略层确定性随机：xorshift32 + crc32 种子 | `rngFor(seed,turn,tag)→{random():[0,1)}` | `captives/city-econ/diplomacy/handlers/strategy` |
| `strategy.js` | 2668 | 战略层世界状态与唯一执行口（最大模块） | `listScenarios / scenarioConf / strategySetScenario / strategyMap / strategyTurnDays / ensureStrategy / oathOptions / chooseOath / strategySnapshot / strategyTick / applyOrders / strategyAttack / strategyResolveMarches / strategyConfirmBattle / strategyRetreatBattle / strategyRecallMarch / strategyReorderMarch / previewAssault / recruitCaptive / captivesTick / defectTick / campaignEvents / strategyEventTick / strategyEventChoice / fateComboDefMul / strategyViewState` 等；转发 `strategyAppoint / strategyCancelAppointment / diplomacyAct` | `handlers.js`、`index.js`、`world.js` |
| `supply.js` | 301 | 粮道连通与断粮惩罚、军级补给线、出征粮道预估 | `grainForTurn`；`supplyMap`；`supplyFor`；`marchSupplyEstimate`；`supplyLineForArmy`；`armySupplyTick`；`supplyTick` | `city-econ/interaction/strategy` |
| `tavern.js` | 152 | 在野武将酒馆：籍贯散列、确定性来访时辰、探索登庸 | `cityNameOf`；`ensureTavern`；`dayFraction`；`todaysGuests`；`guestsNow`；`exploreTalent`；`announceTavern` | `handlers.js`、`strategy.js`、`world.js` |

### 5.2 `server/` 根模块与 `kernel/`【实测】

| 文件 | 行数 | 职责 |
|---|---:|---|
| `index.js` | ~952 | 进程组装：双 HTTP server、静态服务、注入、37 类端点、双 tick、存档防抖、`ctx` 组装 |
| `handlers.js` | ~1554 | 协议适配：73 消息 switch、`settleWorld`、`tryUseNeed`、`tickFacilities/totalYield/tickBuilds`、`processTask`、错误码 |
| `battle.js` | 662 | 战斗外层：组队、兵种适性、兵力折算、`battleSeedFor`、调内核、写 `battleLog`、追击与经验 |
| `skills.js` | ~5849 | 战法数据层 + 三段浏览器 IIFE 模板 + 资源拦截（`createSkillAssets` / `patchClientBundle` / `kernelSkillAt`） |
| `world.js` | 472 | 存档：`createWorld / loadWorld / normalizeWorld / saveWorld`、`makeGeneral/makeArmy/makeCity/makeBuild`、`innateOf` |
| `config.js` | 239 | 配置：`loadConfig`、索引构建、百分制归一、覆盖层应用 |
| `codec.js` | 90 | AES-128-CBC + ZeroPadding + gzip 帧编解码 |
| `wsserver.js` | 179 | 零依赖 RFC6455：握手、粘包/续帧/掩码、PING/PONG、发送 |
| `clock.js` | 45 | `advanceClock(state, now, rules)`：真实毫秒 → 游戏日 |
| `command.js` | 32 | 系统播报与身故提示（`noteIfGeneralDown`） |
| `standalone.js` | 27 | 命令行入口与 `SLG_*` 环境变量 |
| `panels-ui.js` / `interaction-ui.js` / `ui-shell.js` / `editor-ui.js` | ~88K / ~88K / ~20K / ~13K 字节 | 四个浏览器注入 IIFE（§9） |
| `gm/overrides.js` / `gm/index.html` / `gm/board.html` | 123 / — / — | 覆盖层读写与两个 GM 页面 |

**内核**（仓库根 `battle-core/src/` → `offline/kernel/`，10 个 JS + 10 个 `.d.ts`）：

| 模块 | 行数(TS) | 职责 |
|---|---:|---|
| `config.ts` | 76 | `validateConfig`、`configFingerprint`、配置快照 |
| `default-config.ts` | 2504 | 内嵌默认 `BattleConfig`（由 `config/battle_config.json` 生成） |
| `engine.ts` | 596 | 回合状态机、四类战法、准备队列、事件溯源、胜负判定、mechanics（洞察/回击/减伤） |
| `hash.ts` | 72 | UTF-8 / crc32 / 稳定序列化 / 指纹 |
| `index.ts` | 42 | 公共入口 `runBattle` + `runDemo` |
| `report.ts` | 134 | 文字战报、`validateInvariants`、事件摘要 |
| `rng.ts` | 132 | `PythonRandom`（MT19937，对齐 CPython）+ `Mulberry32Rng`，均带 `calls` |
| `rules.ts` | 190 | 纯函数层：`heroAttr / levelValue / sumTermsBonus / counterFactor / baseDamage / calcDamage / rollTrigger / actionOrder` |
| `scenario.ts` | 198 | 演示阵容构造 |
| `types.ts` | 286 | 类型定义（`Effect.mechanics`、`UnitState.reactions`、`TargetType.self_and_ally_single`） |

构建：`cd battle-core && npm run build`（`tsc -p tsconfig.json`，`target ES2020 / module NodeNext / outDir build / declaration true / strict`），产物 `build/src/*.js` 与 `.js.map/.d.ts`；**人工复制**到 `offline/kernel/`。核查时 10 份 `.js` 与 `build/src` 逐字节一致。无自动同步脚本，靠 `ARCHITECTURE.md §9.22` 约定 + `check-release` 出厂源码清单 + 单测兜底。

### 5.3 依赖方向与已核实的环

**主方向（简化）**：

```text
index.js ──> handlers / world / config / skills / clock / command / domain/*
handlers ──> battle / world / skills / clock / domain/*
battle   ──> kernel/index.js, world, skills, domain/{battle-narrative,knobs,aptitude,garrison}
world    ──> skills, gm/overrides, domain/{tavern,fate,strategy,panels,general-progress}
config   ──> domain/general-stat, gm/overrides
strategy ──> world, battle, skills, domain/*（26 个）
city-econ──> domain/{economy,general-stat,strategy-rng,interior-task,supply,appointment,knobs}
supply   ──> domain/{march,knobs}
interaction ─> domain/{captive-rules,knobs,city-econ,supply,interior-task}
event-engine ─> event-dsl
```

**已核实的 ESM 环（3 条，均为静态 import）**【偏差】：

1. `world.js ↔ strategy.js`（`world.js` import `ensureStrategy`；`strategy.js` import `makeBuild/makeGeneral/makeFacilityList/nextId/mainCity`）。
2. `strategy.js → battle.js → world.js → strategy.js`。
3. `strategy.js → campaign.js → world.js → strategy.js`。

代码里多处主动规避成环的注释可佐证纪律仍在：`panels.js:19-26`（不 import strategy）、`interaction.js:11-12`、`supply.js:10-11`、`city-econ.js:14-20`、`oath.js:3-6`（只依赖 `node:fs`）、`captive-rules.js:3-7`、`garrison.js:2`。**结论**：`ARCHITECTURE.md §5` 的「领域模块不互相 import」是当前架构债，登记在 §17，本版不重构；新增模块继续按零环写。

**零依赖叶子**：

- 完全无 `import`（15 个）：`story / chronicle / drift / map-lod / slots / knobs / garrison / general-stat / aptitude / facility-catalog / failstate / levy / strategy-map / general-progress / event-dsl`。
- 只依赖 `node:` 内置（6 个）：`people / fate / fate-groups / march / oath / tavern`。
- 只依赖外部内核（1 个）：`strategy-rng`（`crc32Utf8`）。

---

## 6. 关键流程与时序

### 6.1 启动与登录

```text
Electron main.cjs
  ├─ requestSingleInstanceLock()（失败 → 退出；已运行实例 → restore + showInactive）
  ├─ BrowserWindow：alwaysOnTop:false / min 900×540 / contextIsolation:true /
  │                 nodeIntegration:false / preload:preload.cjs / backgroundThrottling:false
  ├─ 启动 offline server（同进程）→ 8088 / 8004
  └─ loadURL('http://127.0.0.1:8088/')
        ↓  GET /index.html  → 注入 errHook / gateCss / gateBoot / 4 个 script
浏览器
  ├─ gateBoot 每 1500ms GET /__slg/session；ready=false → data-slg-phase=login（隐藏全部注入层）
  ├─ 玩家在原版登录页点登录 → WS account.login → handlers 置 loggedInAt、删明文、存 passHash
  ├─ WS role.enterServer → 置 enteredAt；回包 token = state.account.session
  └─ ready=true → phase=game → 注入层可见；ui-shell.js 另以 1200ms 独立轮询兜底
```

### 6.2 一次「玩家点一下」的完整链路

```text
客户端 UI（注入层）
  ├─ WS:  原版交互仍走 {seq,name,msg}（例如 city.upFacility）
  └─ HTTP: 新功能走 POST /__slg/strategy/action 或 /panels/action
        ↓
index.js → readJson(body, limit) → 领域函数（或 handlers.handleRequest）
        ↓
handlers.handleRequest：sanitizeMsg → settleWorld(ctx) → switch(name) → 领域函数 → {code,msg}
        ↓
副作用三选一：ctx.push(推送) / ctx.schedule(定时) / save()（防抖 250ms）
        ↓
index.js 组装 {seq,name,code,msg} → encodeFrame(AES+hex+gzip) → WS Binary
        ↓
客户端 Proxy 更新 → Logic 重绘（只显示，不计算）
```

**【红线】** 界面层不得复算任何玩家可见数值；服务端缺字段走 `/__slg/interaction/state.fieldGaps` 显式降级。

### 6.3 世界推进唯一链 `settleWorld(ctx, now)`【实测】

> 位置 `handlers.js:303-316`。调用者：`index.js:262`（500ms tick）、`handlers.js:350` `advanceToNextTurn`、`handlers.js:517` `handleRequest` 开头。

```js
export function settleWorld(ctx, now = Date.now()) {
  const { state, cfg } = ctx;
  tickFacilities(state, cfg);                              // ① 设施被动升级（up_time 到点 level+1）
  totalYield(state, cfg);                                 // ② 重算总产量并回写 roleRes
  const settled = settleCampaign(state, cfg, ctx, now);   // ③ 序章/时钟/日产/剧情
  strategyResolveMarches(state, cfg, ctx);                // ④ 行军到达结算（在诸侯推演之前）
  strategyTick(state, cfg, ctx, now);                     // ⑤ 旬界：城市经营/俘虏/出仕/事件/诸侯
  ensureTavern(state, cfg);                               // ⑥ 酒馆兜底
  announceTavern(state, ctx, chapterRules().realMsPerDay);// ⑦ 当日来访播报
  const finishedBuilds = tickBuilds(state, cfg);          // ⑧ 领地建筑工期
  for (const b of finishedBuilds) ctx.push?.('roleBuild.push', b);
  return { days: settled.days, day: state.clock.day, builds: finishedBuilds.length };
}
```

**③ 内部顺序**（`campaign.js:307-336`）：

```js
const rules = chapterRules(); const from = state.clock.day;
const { days } = advanceClock(state, now, rules);        // 真实毫秒 → 游戏日
if (days > 0) {
  const trait = factionTraitOf(state);
  const resBonus = yieldBonusByResource(state);
  for (const [k,v] of Object.entries(trait.yields || {})) resBonus[k] = (resBonus[k]||0) + v;
  applyDays(state, cfg, days, { ...rules, resBonus, upkeepPct: trait.upkeepPct });
}
if (!state.campaign.ending && !state.campaign.fired['1']) runDay(state,cfg,ctx,1,rules);
if (!state.campaign.ending)
  for (let d = from + 1; d <= state.clock.day; d += 1) runDay(state,cfg,ctx,d,rules);
if (!ending && 处于 choice 窗口 && 未决 && pendingDay !== clock.day)
  ctx.push?.('campaign.pending', pendingPayload(state, rules));
if (state.campaign.ending) runPatrols(state,cfg,ctx,rules);
if (days > 0) ctx.push?.('roleRes.push', state.roleRes);
return { days, day: state.clock.day };
```

**⑤ 内部顺序**（`strategy.js:553-635`）：

```js
const turnDays = knobGet(state,'turnDays') ?? conf.turnDays ?? 10;
if (state.clock.day - st.lastTurnDay < turnDays) return null;   // 未到旬
st.lastTurnDay = state.clock.day; st.turn += 1; openMonth(state);
cityEconTick(state, cfg, ctx);        // 城市经营
captivesTick(state, ctx);             // 俘虏思归/越狱
defectTick(state, cfg, ctx);          // 在野出仕
const evTick = strategyEventTick(state); if (evTick) st.lastEventTick = evTick;
for (const f of conf.factions) {      // 有地才决策
  const tax = accrueFactionGrain(state, f.id); noteMove(state,{kind:'田赋',...tax});
  const sheet = state.brainRunner ? state.brainRunner(f, strategySnapshot(state,f.id))
                                  : localBrain(...);
  if (sheet?.goal) commitBrainGoal(...);
  // diploPrompt：把「请求攻击」塞进本旬指令单
  applyOrders(state, cfg, ctx, f, sheet);
}
closeMonth(state);
return { turn: st.turn, results };
```

**【红线】** 长时模拟/平衡脚本（`system-audit.mjs`、`sim-60turns.mjs`）只准注入固定 `now` 调 `settleWorld`，**不许自己拼结算链**（`ARCH §9.20`、`check-release` 7.9d）。

### 6.4 旬界城市经营 `cityEconTick`【实测】

```js
const day = Math.floor(Number(state.clock?.day) || 1);
ensureCityEcon(state);
const tasks      = advanceInteriorTasks(state, cfg, ctx);                  // 每日推进，旬界到账
const supply     = day % 10 === 0 ? supplyTick(state, cfg, ctx)        : {isolated:[],recovered:[],hits:[]};
const armySupply = day % 10 === 0 ? armySupplyTick(state, ctx)         : {fed:[],cut:[]};
const appts      = day % 10 === 0 ? appointmentTick(state, cfg, ctx)   : {started:[],blocked:[],resumed:[],ended:[]};
const dev        = day % 10 === 0 ? cityDevTick(state, cfg, ctx)       : {gains:[],upsets:[]};
const fired      = day % 10 === 0 ? disasterTick(state, cfg, ctx)      : [];
const loyalty    = day % 10 === 0 ? loyaltyTick(state, cfg, ctx)       : null;
if (day % 30 === 0) popTick(state, ctx);
return { fired, loyalty, dev, tasks, supply, armySupply, appts };
```

### 6.5 出征八环（真实点击 E2E，`check-release` 7.11）【实测】

```text
① 切城（选目标城 / 出发城）
② 推演：POST /__slg/strategy/action {action:'preview'} → previewAssault()（只读沙盒）
③ 决策预览：交互层展示耗粮/ETA/胜面/构成条
④ 出兵确认：POST ... {action:'attack', confirmBattle:true} → strategyAttack()
        → consumeMarchGrain → 扣资源 → marches.push（含 lockedSeed / arriveDay / km / speed）
⑤ 行军队列：GET /__slg/strategy/state 轮询，可 recall / reorder
⑥ 抵达：strategyResolveMarches → 挂 pendingBattle / pendingSinceDay → 推「遭遇」页
⑦ 玩家点「确认开战」：POST ... {action:'battleConfirm'} → settleArmyBattle → runBattle
⑧ 结算写战报：warReport.push + battleLog（含指纹） + 城池归属 + 俘虏 + 经验
```

`pendingBattle` 超 30 日自动 `strategyRetreatBattle`；`battleRetreat` 主动撤退；`digest` 消化占领结果。`ui-audit.cjs` 必须先渲染遭遇页再断言按钮可点，否则 E2E 假红。

### 6.6 战斗结算链【实测】

```text
strategyAttack / strategyResolveMarches
  → settleArmyBattle（commit = before.map(v=>round(v*frac))；兵种克制/宿命折算守军）
  → battle.js resolveBattle
       ├─ makeUnits：makeHero（属性 0~100，成长封顶 Lv10≤100）+ makeUnit（适性加成）
       ├─ troopStrikeMul / attackerOddsMul 折算 attack_base
       ├─ 守方 wall(siegeWallMul) × terrainMul 折算 defence_base
       ├─ battleSeedFor(armyId,x,y,day)
       └─ runBattle({units, seed, config:{...DEFAULT_BATTLE_CONFIG, round_limit, troop_factor:0.45}})
  → kernel：指挥 → 逐回合[被动→准备到期→行动(普攻/主动/追击)] → 回合末递减 reactions
  → 返回 {events, final_troops, winner, event_fingerprint, config_fingerprint, rng_calls}
  → 外层：追击 cut、经验 exp、写 warReports / battleLog / generals 折损
  → battle-narrative.js 渲染三句归因 + 展开
```

### 6.7 武将编辑器保存链【实测】

```text
editor-ui.js 点「保存」
  → POST /__slg/editor/save {cfgId, force, ..., skillCfgId}
  → general-editor.editorSave(cfg,state,input)
       ├─ sanitizeGeneralEdit（白名单 + 范围钳位）
       ├─ saveOverrides({...ov, generals:{...ov.generals, [cfgId]:patch}})   // tmp + renameSync
       ├─ applyToConfig(cfg,cfgId,patch)      // 立即更新 cfg.generalByCfg；原值存 cfg.generalOriginal
       └─ syncStateSkill(state,cfgId,skillCfgId)  // 同步当前存档 state.generals[].skills[0]
  → 返回 {ok,cfgId,stateSynced,row}；save() 落盘
```

`editorReset` 从 `cfg.generalOriginal` 恢复并删除覆盖条目。`world.innateOf(cfg,cfgId)` 优先取 `overrides.generals[cfgId].skillCfgId`（`0` = 白板），否则按 `generalByCfg.get(cfgId).name` 查 `hero-skills.json`。

### 6.8 存档导入链【实测】

```text
POST /__slg/save/import (≤40MB)
  → 校验含 role 字段，否则 400 not_a_save
  → 把现有 save.json 重命名为 save.json.before-import-<ts>.json
  → loadWorld / normalizeWorld（补字段、归一三槽、ensure*）
  → save() + 返回 {ok:true, day}
  → 撤销栈清空（读档语义）
```

---

## 7. 算法与数值设计（代码实测口径）

> 本章所有公式逐字取自源码，变量名保持一致。**GDD 与本文冲突时，玩法目标听 GDD，当前实现数值听本文**；差异登记在 §17。

### 7.1 时钟与时间

```js
// clock.js：一游戏日 = rules.realMsPerDay（默认 60000ms，覆盖层 1000~3600000）
// seasonOf(state) = SEASONS[floor(((day-1) % 360) / 90)]   // 春/夏/秋/冬
levyTurnOf(state) = floor(num(st.turn, floor((day-1)/turnDays)))  // turnDays 默认 10
year = (st.scenarioYear || 184) + floor((day-1)/360)
month = floor((day-1)/30) + 1
```

### 7.2 日产、军饷与总量（`handlers.js` + `economy.js`）

```js
// facilityAdditions (handlers.js:210)
y = { wood:0, iron:0, stone:0, grain:0, gold:0, capacity:0 }
for (const list of Object.values(state.facilities || {}))
  for (const f of list) {
    const lv = facilityGetLevel(cfg, f); if (lv <= 0) continue;
    const values = cfg.facilityValues(f.type, lv);
    cfg.facilityAdditions(f.type).forEach((aType, i) => {
      const bonus = facilityBonus(state, aType, chapterRules());
      const v = Math.floor((values[i] || 0) * (1 + bonus));
      const axis = EFFECTIVE_ADDITIONS[aType];   // 见 §7.15
      if (axis) y[axis] += v;
    });
  }
// buildYield：y.wood/iron/stone/grain += b.wood/iron/stone/grain
// totalYield
r.wood_yield  = playerStockYield(state,'wood', base.wood_yield ?? 1000, fa.wood,  by.wood);
r.iron_yield  = playerStockYield(state,'iron', base.iron_yield ?? 1000, fa.iron,  by.iron);
r.stone_yield = playerStockYield(state,'stone',base.stone_yield?? 1000, fa.stone, by.stone);
r.grain_yield = playerGrainYield(state, base.grain_yield ?? 1000, fa.grain, by.grain);
r.gold_yield  = playerGoldYield(state, base.gold_yield ?? 1000, fa.gold);
r.depot_capacity = (base.depot_capacity ?? 1000000) + fa.capacity;
r.city_layer = cityLayer(state);

// applyDays（逐日，economy.js:46）
cap = r.depot_capacity || 1000000;
limit = cfg.basic.role?.decree_limit ?? 20;
decreePerDay = rules.decreePerDay ?? 2;
ownsCity = Object.values(state.strategy?.cities || {}).some(row => row?.owner === 'player');
perSoldier = ownsCity ? (knobGet(state,'grainPerSoldierDay') || 0.1)
                      : (rules.upkeepPerSoldier ?? 0);
cost = floor(countSoldiers(state) * perSoldier * (1 + (Number(rules.upkeepPct)||0)/100));
for (let i=0;i<days;i++) {
  for (const k of ['wood','iron','stone','grain','gold']) {
    const base = floor(r[`${k}_yield`] || 0);
    const gain = base > 0 ? floor(base * (1 + (Number(resBonus[k])||0)/100)) : base;
    if (k === 'gold' && gain > 0) goldYielded += max(0, min(gain, cap - (r.gold||0)));
    r[k] = min(cap, (r[k]||0) + gain);
  }
  const pay = min(r.grain||0, cost); r.grain -= pay; upkeepPaid += pay;
  r.decree = min(limit, (r.decree||0) + decreePerDay);
}
if (ownsCity && goldYielded > 0) {
  const due = Math.round(goldYielded * 0.35);       // 固定支出闸（反通胀）
  maintainPaid = min(r.gold||0, due); r.gold -= maintainPaid;
}
// ★ OP-01 国库沉淀税（GDD §5.10.1）：金侧缺的「随存量增长」支出口
taxPct = knobGet(state,'goldHoardTaxPct') || 0;     // 默认 4，0 = 关闭阀门
if (ownsCity && goldYielded > 0 && taxPct > 0) {
  turnDays = max(1, knobGet(state,'turnDays') || 10);
  exempt   = floor((goldYielded/days) * turnDays * 10);  // 10 旬周转金免税
  excess   = max(0, (r.gold||0) - exempt);
  hoardTaxPaid = min(r.gold||0, floor(excess * taxPct/100 * (days/turnDays)));
  r.gold -= hoardTaxPaid;
}
// 流水：gold 的 delta 要加回 salaryPaid + maintainPaid + hoardTaxPaid；
//       沉淀税另记一笔 reason='国库沉淀税'，玩家在府库面板可查。
```

### 7.3 逐城经济（`city-econ.js`）

```js
// cityYield (:107-136)
grainMod  = (e.mod && day <= e.mod.until) ? e.mod.grain : 1;
besieged  = state.strategy?.cities?.[cityId]?.besieged ? 0.5 : 1;
moraleMod = 0.85 + (Number(e.morale ?? 60) / 400);          // 0.85 ~ 1.10
cut       = e.supplyCut ? 0.55 : 1;                          // 断粮只砍粮产
grain = round(30 * (e.devAgri/50) * grainMod * besieged * moraleMod * cut);
gold  = round(20 * (e.devTrade/50) * besieged * moraleMod);
extra = 特产关键词 → 铁 iron+80 / 木 wood+80 / 粟 grain+120 /
                    盐 gold+100 / 茶 gold+80 / 马·玉 gold+60

// playerStockYield (:146)
diff  = knobGet(state,'difficultyRes') || 1;
local = max(0,floor(facility)) + max(0,floor(build));
city  = round((cityLayer(state)[key] || 0) * diff);
return ownedCityCount(state) > 0 ? city + local
                                 : round(((base||0) + local) * diff);

// devLevel = clamp(floor(dev/24)+1, 1, 5)
// conscriptFactor = clamp((1-(arms-1)*0.06) * (0.9+(100-morale)/200), 0.7, 1.3)

// cityDevTick（五项官职）
stat = gameStatOf(cfg,g,conf.stat,60) + (Number(g[`${key}_added`])||0);
soft = cur >= 100 ? 0.3 : (cur >= 80 ? 0.6 : 1);
half = marching.has(gid) ? 0.5 : 1;
gain = max(0.1, conf.gain * (0.5 + stat/100) * soft * half);
next = min(conf.field === 'morale' ? 100 : 120, cur + gain);

// popTick（每 30 日）
rate  = 0.02 + (e.morale/100)*0.04;
e.pop = min(100000, round(pop*(1+rate)));
e.store = min(20000, store + 3*(cityYield?.grain||0));

// disasterTick（每 10 日，确定性）
riskVal = c.attrs?.灾害风险 ?? c.disasterRisk ?? 50;
risk = riskVal/100 + 0.5;                  // 0.5~1.5
roll = rngFor(state.seed ?? 20261110, day, `disaster:${id}`).random();
civic = hasCivic ? 0.8 : 1;
orderK = 1 - (order/100)*0.3;
if (roll < 0.03*risk*civic*orderK)              → 蝗灾：store*=0.6, mod={grain:0.5,until:day+10}, morale-=5
else if (roll < 0.05*risk*civic*orderK)         → 瘟疫：troops*=0.9, pop*=0.95, morale-=3
else if (roll < 0.09*civic*orderK)              → 丰收：mod={grain:1.5,until:day+10}, morale+=3
   // 注意第三段阈值不含 risk【偏差：与注释「风险 × 政务官 × 治安」略有出入】

// loyaltyTick（每旬）
在岗 loyal = min(100, loyal+0.5)；否则 max(0, loyal-1)
salaryDue = Σ 20*star; salaryPaid = min(gold, salaryDue); gold -= salaryPaid
欠饷 → 全军 loyal -= 5
p = loyal<40 ? 0.10 : (loyal<70 ? 0.03 : 0)
if (p>0 && rngFor(seed,day,`defect:${g.id}`).random()<p) → 叛逃

// 兵种克制 armsCounter：骑(3)→盾(1)→弓(2)→骑(3)，克制 +1 / 被克 -1 / 否则 0
```

### 7.4 内政、委任与面板加成

```js
// interior-task.planTicks（阈值仍为旧量纲，见 §17）
ticks = !stat ? ceil(K.ticks*1.5)
      : stat >= 8600 ? 1 : stat >= 6800 ? K.ticks : K.ticks + 1;
ticks = clamp(ticks, 1, 6);
perTick = round((K.total/ticks)*100)/100;
// KINDS：agri/trade/barracks total=3 ticks=2；defense total=2；relief instant；populate popGain=0.08

// panels.postBonusPct
stat = lore?.historyStats?.[p.stat] || 50;
pct  = min(c.maxBonusPct=30, round2(stat/100*30 - (cityCount-1)*c.decayPerCity=2));
if (isDeployed(state,gId)) pct = round2(pct/2);
bonusPct[p.id] = max(0, pct);
// yieldBonusByResource 按 posts[].resource 累加，再叠 factionTraitOf(state).yields
```

### 7.5 户役制征兵（`levy.js`）

```js
HOUSEHOLD_SIZE=5; ADULT_MALE_RATE=0.62; POP_PER_SOLDIER=4; TURN_CAP_RATE=0.05;
SEASON_FACTOR = { 春:0.8, 夏:1.0, 秋:1.1, 冬:0.7 };
households   = floor(pop/5);
adultMales   = floor(households*0.62);
exempt       = max(0, households-adultMales);
houseBalance = max(0, adultMales-levied);
armsFactor   = clamp(0.7 + (e?.devArms ?? 50)/250, 0.7, 1.2);
rate         = clamp(opts.rate ?? 0.06, 0.01, 0.2);
seasonalCap  = max(0, floor(pop*rate*armsFactor*seasonFactor));
turnCap      = max(0, floor(pop*0.05));
quota        = max(0, min(houseBalance, seasonalCap, turnCap));
reason 优先级：no_population → levy_cooldown → levy_exhausted → need_population

// commitLevy（资源扣除成功后调用一次）
popAfter = max(5, popBefore - want*4);
ledger.levied += want; ledger.lastLevyTurn = levyTurnOf(state);
bite = (want*4 / max(1,popBefore))*60; e.morale = max(0, round((morale-bite)*10)/10);

// farmConflictOf：春季 && count/seasonalCap > 0.5 → penaltyPct 15
// 旧征兵工期：conscriptSec(total, secPerTroop=1) = clamp(2,30, ceil(total*max(0.001,secPerTroop)*0.02))
```

### 7.6 武将属性 0~100（`general-stat.js` + `config.js` + `battle.js`）

```js
clampFive(v)     = isFinite(Number(v)) ? clamp(round(v), 1, 100) : 50;
toGameStat(five) = clampFive(five);
toPercentFromRaw(raw) = (!isFinite(raw) || raw<=0) ? 1 : clamp(round(raw/100), 1, 100);
toGameGrow(five) = round(25 + clampFive(five)*0.55);                  // 25~80
toDestroyStat(tong,wu) = clamp(round((tong*0.6+wu*0.4)*0.2), 5, 70);
toCostStat(fiveSum)    = clamp(round(10 + fiveSum/14), 10, 45);
gameStatOf(cfg,g,key,fallback=60):
  v = Number(cfg.generalByCfg.get(Number(g.cfgId))?.[key]);
  if (!isFinite(v) || v <= 0) return fallback;
  return v > 100 ? toPercentFromRaw(v) : v;

// config.js:85 原表 >100 值归一；:126-145 交集人物以史载五维覆盖；:146-173 非交集派生
// battle.js makeHero.attr()（Lv10 ≤100）
b   = round(base ?? 60);
raw = round(((grow ?? 30)/100)*10*100)/100;
cap = max(0, (100-b)/9);
return { base:b, grow: min(raw, floor(cap*100)/100) };
```

### 7.7 战斗公式（`battle.js` + `kernel/rules.js` + `kernel/engine.js` + `strategy.js`）

```js
// 外层换算（battle.js）
ROUT_RATIO = 0.1; TROOP_SCALE = 1;
troopStrikeMul(troops) = clamp(pow(max(1,troops)/800, 0.55), 0.5, 3.2);
attackerOddsMul(a,d)   = (a/max(1,d)) < 1.15 ? 1 : min(6.5, 1 + (a/max(1,d)-1)*11.2);
judgeBattle({winner,aStart,dStart,aLeft,dLeft}):
  aRout = aStart>0 && aLeft/aStart <= 0.1; dRout 同理;
  dRout&&!aRout → 2；aRout&&!dRout → 0；都溃败 → aLeft>=dLeft?2:0；
  winner===1 → 2；winner===2 → 0；否则 1（未决，不占城）
battleSeedFor(armyId,x,y,day) = crc32Utf8(`${armyId}:${x}:${y}:${max(1,floor(day))}`);
battleConfig() = structuredClone(DEFAULT_BATTLE_CONFIG) + { defense_model:'corrected', troop_factor:0.2 };
// resolveBattle 实际覆盖 fightCfg.troop_factor = 0.45、round_limit = knobGet('roundMax') ?? 8
// 追击 cut = (winnerBegin[2]/start) * (knobGet('pursuitRate')/100)
exp = max(0, round((beginSoldiers[slot]-attackRemain[slot])*0.5));

// 内核纯函数（kernel/rules.js）
heroAttr(hero,key) = (h[`${key}_base`] ?? 0) + (h[`${key}_grow`] ?? 0)*(hero.level-1);
levelValue(v1,level,span=9) = level<=1 ? v1 : v1*(1+(level-1)/span);   // Lv10 = 2×Lv1
normalizeBonus(value,op=0) = op!==0 ? value : value/100;
sumTermsBonus(terms) = Σ normalizeBonus(t.value,t.op);
skillProbability(skill) = level<=1 ? probability_init
                        : probability_init + (probability_max-probability_init)*min(1,(level-1)/9);
attributeFor(type,hero) = type==='STRATEGY_DAMAGE' ? heroAttr(hero,'intel') : heroAttr(hero,'attack');
baseDamage(cfg,effect,attacker,defender):
  rate = (effect.flat_rate ? effect.rate_pct : levelValue(effect.rate_pct, attacker.hero.level))/100;
  attr = attributeFor(effect.effect_type, attacker.hero).value;
  defense = heroAttr(defender.hero,'defence');
  mitigation = cfg.defense_model==='corrected' ? defense/(defense+200) : max(0,1-defense/(defense+200));
  value = attr*rate*cfg.troop_factor*(1-0.5*mitigation);
  return { value:max(0,value), rate_pct_at_level, attribute, evidence:'E2' };
calcDamage(base,counter,bonusTotal,minDamage):
  raw = base*counter*(1+bonusTotal);
  final = max(floor(raw), trunc(minDamage));
  return { base,counter,bonus_total,after_counter,one_plus_bonus,raw,floored,min_damage,
           final, evidence:'E0', il:'Game.Map.dll::CalcDamageByTerms' };
actionOrder(units) = speed 降序，同速 unit_id 升序

// 内核编排（kernel/engine.js）
bonuses = [...effect.bonus_terms, ...attacker.buffs];   // mechanics 不进 buffs【红线】
reduce = min(0.9, max(0, Σ target.reactions.filter(kind==='damage_reduce').value));
mitigated = reduce>0 ? max(0, trunc(calc.final*(1-reduce))) : calc.final;
HEAL：amount = trunc(attributeFor('STRATEGY_DAMAGE',hero)*rate)，troops 不超 max_troops
CONTROL：ok = rng.random() < effect.control_probability（无论 p 多少都消耗一次随机数）
normalAttackEffect：rate = cfg.damage_rates_pct[crc32Utf8(unit.unit_id) % rates.length]
run 顺序：指挥(battle_start) → 每回合[被动(round_start) → 准备到期 → 行动阶段
          （普攻最近且在 attack_range 内 → 主动 → 追击） → 回合末清犹豫/怯战、递减 reactions]
slotDist(a,b) = 同阵营 |pos差|，跨阵营 pos_a+pos_b+1
winner = 存活阵营唯一 ? 该阵营 : null
event_fingerprint = hash16(stableStringify(this.events))；range_trace 不进 events

// 战略层城战折算（strategy.js:1101-1171）
commit = before.map(v => max(0, round(v*frac)));           // frac ∈ [0.05,1]
counter = armsCounter(mainArms(commit)+1, mainArms(defRows)+1);
defense2.soldiers = defRows.map(v => round(v*defMul*fate.mul*(counter>0?0.87:counter<0?1.15:1)));
recovered[i] = result!==2 && commit[i]>0 && remain[i]===0 ? max(1, ceil(commit[i]*0.1)) : 0;
fateComboDefMul：队内 ≥2 名同组宿命 → mul *= 0.95/组（最多 2 条 note）
```

### 7.8 主角战法 19001 的 mechanics【实测】

配置 `conf/campaign/protagonist-skill.json`：`name:「坐镇中军」`、`trigger 4`、`skill_class:'指挥'`、`probability_init=probability_max=1`、`prepare 0`、`target_type:'self_and_ally_single'`、3 个 BUFF effect。

| detail_id | mechanics | `ui.levels[lv-1].effect_value[i]` |
|---|---|---|
| 9001901 | `{insight_rounds:3}` | 槽 0 恒 3（洞察 3 回合，免疫控制） |
| 9001902 | `{counter:{chance:0.3, rate_pct:87, damage_type:'STRATEGY_DAMAGE'}}` | 槽 1 `30+5*(lv-1)`（30→75） |
| 9001903 | `{damage_taken_reduce:0.3}` | 槽 2 恒 30 → 0.30 |

```js
// skills.js kernelSkillAt (:190-224)
now = s.ui.levels[level-1].effect_value[i];
mechanics.insight_rounds      = max(0, trunc(Number(now)||0));
mechanics.counter.chance      = (Number(now)||0)/100;      // 30 → 0.30 … 75 → 0.75
mechanics.damage_taken_reduce = (Number(now)||0)/100;      // 30 → 0.30
rate_pct = rated ? now : (e.rate_pct||0);
bonus_terms[].value = (b.value||0) * growth;              // growth = now/base[i]
// 回击伤害率 87% 固定（flat_rate=true 在内核注入），不随武将等级二次成长

// kernel/engine.js 落地
mechanics 单独记 target.reactions（三类：insight / counter / damage_reduce），同源战法只刷新不堆叠
洞察：CONTROL 命中且目标有 insight → control_immune 事件
回击：伤害后按 chance 掷 rng.random()（无论概率都消耗随机数），构造
      flat_rate:true + 87% STRATEGY_DAMAGE 的 counterEffect 且 noReaction:true 防递归
减伤：reduce = min(0.9, Σ damage_reduce.value)
```

**【红线】** `mechanics` 绝不写进 `bonus_terms`；旧战法事件 payload 不新增字段；洞察在 `round_end` 递减。

### 7.9 内政 / 外交 / 行军 / 适性四系统公式

```js
// 内政（city-econ.cityDevTick）
gain = max(0.1, conf.gain * (0.5 + stat/100) * soft * half);
// 面板 postBonusPct = min(30, stat/100*30 - (cityCount-1)*2)

// 外交（diplomacy.js）
base = (djb2Hash([a,b].sort().join('|')) % 81) - 40;
factors：履约 +5*fulfill / 背约 -10*betray / 联姻 +15 / 赠礼 min(30,round(gifts/200))
       / 边境摩擦 -3*friction(≤6) / 共同敌人 +10*common / 占其城池 -20*occupied
       / 离间失手 -15*sowFail / 事件 eventAdj
value = clamp(Σ, -100, 100)
离间 chance = clamp(0.3+(bestIntellect-60)/100, 0.2, 0.8)
劝降门槛：value>=0 && myTroops >= hisTroops*3
ACTIONS 门槛(态度/金)：truce -30/1500、pass 20/800、ally 55/0、marriage 40/3000、
                       requestAttack 60/2000、surrender 0/0、sow 0/800、gift 0/0

// 行军（strategy.js）
MARCH_KM_BASE=55; MARCH_DAYS_MIN=1; MARCH_DAYS_MAX=40;
SLOT_CAP=5000（白身基准）；每槽上限 = SLOT_CAP + 官阶×300（0 阶 5000 → 9 阶 7700）;
generalSpeed = clamp(60 + (gameStatOf(cfg,g,'speed',60) + g.speed_added), 20, 200);
armySpeed = 队内最慢 generalSpeed（空队 100），round(v*10)/10;
marchKmBetween = route.km>0 ? route.km : round(hypot(dx,dy)*1.2);
marchDaysBy(km,speed) = clamp(ceil(km/(55*(max(20,speed)/100))), 1, 40);
marchPlan.days = clamp(marchDaysBy + factionTraitOf(state).marchDelta, 1, 40);
marchGrainCost = ceil(max(1,deploy)*(knobGet('grainPerSoldierDay')||0.1)*max(1,floor(days)))
                 × (冬季渡河 ? knobGet('crossRiverWinterCost') : 1);
截击 p = min(0.4, (knobGet('interceptPerEdge')/100)*hostile.length);
      roll = rngFor(seed, arriveDay, `intercept:${mm.id}`).random();
      loss = max(1, round(total*0.12)); abort = remain < 200;
// NPC 出征账（strategy-log.quoteMarch）
horseShare = /骑/.test(arms) ? 0.4 : 0; horses = round(n*horseShare); foot = n-horses;
grain = round(foot*days*0.12 + horses*days*0.1); horseGrain = round(horses*days*0.28);
gold  = round(foot*days*0.04 + horses*days*0.05); horseGold = round(horses*days*0.08);
ok = (totalGrain+400 <= haveG) && (totalGold+150 <= haveM) && n >= 400;

// 适性（aptitude.js）
ARMS_STAT = {1:'defense', 2:'strategy', 3:'force'};   // 4~9 归入最近主兵种
armsApt(g,i) = clamp(0.85 + 0.3*(Number(g[key])||0)/100, 1.00, 1.15);   // 下限锁 1.00
aptTriple(g) = [1,2,3].map(i => round(armsApt(g,i)*100));
// battle.js makeUnit 生效点
hero.attack_base  = clamp(round(hero.attack_base  * apt), 1, 100);
hero.defence_base = clamp(round(hero.defence_base * apt), 1, 100);
```

### 7.10 粮道 / 双账本（`supply.js` + `strategy.js`）

```js
grainForTurn(state,troops) = round(max(0,troops) * (knobGet('grainPerSoldierDay')||0.1)
                                  * (knobGet('turnDays')||10));
// supplyMap：以都城 st.playerCity 为根，己方城 + 未封锁关隘做 BFS
// supplyTick 断粮城每旬：
e.supplyCut = true; e.supplyDays += 10;
e.morale = max(0, round((morale-3)*10)/10);
e.order  = max(0, round((order-1)*10)/10);
row.troops = round(troops*0.98);
// armySupplyTick：断绝 supplyCutDays += 10；===10 警告；>=30 逃兵 max(1,ceil(troops*0.02))
// 运输队 kind==='transport' 不吃补给判定
// 出征扣粮（city-econ.consumeMarchGrain）：先扣 e.store，不足吃全局池
fromPool = min(r.grain, ceil(remain*1.25));      // +25% 损耗
// deliverGrain：e.store = min(20000, store + floor(grain))

// 双账本
实账 = state.strategy.cityEcon[id].store（上限 20000）
国库粮 = state.strategy.resources[factionId].grain（只读汇总）
唯一写入口：refreshGrainSummary / spendFactionGrain / creditFactionGrain / accrueFactionGrain
// accrueFactionGrain 每旬按城征赋
g    = 140 + round((c.attrs?.农业 ?? 40)*3);
gold =  60 + round((c.attrs?.商业 ?? 40)*1.2);
e.store = min(20000, e.store+g); grain += g; res.gold += gold;
// WB-06 逐行禁止 resources[..].grain = 直接赋值
```

### 7.11 登庸 / 招降 / 宿命 / 俘虏

```js
// 招降（captive-rules.js）
CAPTIVE_COST = 300;
captiveRecruitRate(state,cap) = min(0.95, 0.45 + days*0.05 + protagonistStat(state,'政治')*0.002);
captiveRateParts：base 45 + dayBonus days*5 + polBonus 政治*0.2 → final = min(95, raw)
// strategy.js:2410 实际掷骰（2026-11-16 校准：旧文档写 2111）
success = rngFor(seed, st.turn ?? day, `captive:${i}:${cap.cfgId}`).random() < rate;
失败 cap.loyal -= 10；<0 越狱除名（不扣费）
成功 扣 300 金；g.loyal = min(100, 70 + round(主角魅力/25))
// captivesTick 每旬：days+1、loyal-2；loyal<30 且 rng<0.3 → 越狱
// captureFromBattle
ratio  = dStart>0 ? clamp((dStart-dLeft)/dStart,0,1) : 1;
chance = 0.6+0.4*ratio; roll = rngFor(seed, day, `capture:${place}:${cand}`).random();
maxPick = ratio>=0.75 ? 2 : 1;
// 相性/义理（relation.js / fate-groups.js）
xiangxingGap(a,b) = 环形距离，0~74（环长 149）
xiangxingBonus(myXx,targetXx) = 25 | 18 | 10 | 0
fateComboDefMul：队内 ≥2 名同组宿命 → 守军防御 ×0.95/组
```

### 7.12 NPC 同规则与战役脑

```js
// 田赋（strategy.accrueFactionGrain，每旬每城）
g = 140 + round(农业*3); gold = 60 + round(商业*1.2);
// planCampaign 只产指令单：{protocol:'slg-ai-orders-v1', goal, internal_orders,
//                            strategy_orders, explain, seed, personality, difficulty}
// applyOrders 统一执行；brainRunner 可注入替换本地脑
// 月度：openMonth → noteMove/noteCity → closeMonth（天下大事 + 财报 booksOf）
```

### 7.13 事件条件 DSL（`event-dsl.js`）

```js
WHEN_FIELDS (18) = turnMin/turnMax/yearMin/yearMax/turn/year/season/faction/
  cityOwned/cityLost/resource/flag/relation/generalAlive/generalDead/generalInTeam/
  battleLost/battleWon
OPS (8) = = != > >= < <= in not_in
LAYERS (3) = 史实节点 / 条件 / 关系
EFFECT_KINDS (8) = flag / flag- / gold / morale / loyalty / attitude / fame / nothing
cmpValue(opObj, actual)：单键对象、键必须在 OPS；in/not_in 的 want 必须 Array；
                        其余 want 必须 number；actual 非有限数 → false
evaluateEvent(when,ctx)：未知字段 throw（白名单强拒）；逐项短路；season 支持标量或数组；
                        flag:{has:[],not:[]}；relation 缺 a/b throw；battleLost/Won withinTurn 默认 4
validateEventSchema：id 以 'evt.' 开头；title 必填；layer ∈ LAYERS；priority 整数；
  text[] 非空；choices[] 非空且 effects 过 parseEffect、id 不重复；
  source.id / source.confidence 必填；引用武将必须在 heroNames；exclusive 必须是数组
parseEffect：'nothing' / flag|flag- 两段 / gold|morale|fame 两段且 n≠0 /
             loyalty|attitude 三段
// event-engine.selectEvents
once/cooldown 排除 → evaluateEvent → priority 降序 + id 字典序 →
exclusive 组只取第一条其余进 1 旬冷却 → maxPerTurn = opts.maxPerTurn || 2
// strategyEventCtx 注入 14 个回调；year/season/resource/relation/battleHistory
```

### 7.14 失败态与结局（`failstate.js` + `campaign.js`）

```js
// 四态
bankrupt = gold<=0 && grain<500;
troopsStarved = 己方城 troops<200;
noGeneral = 所有队伍 generals 全空;
capitalLost = st.cities[st.playerCity]?.owner !== 'player';
// 出路
disarmForGold 返还 n*2*0.3；sellGrain 1 粮=0.5 金（每旬上限 2000）；
emergencyConscript 金 2*(mercenary?3:1) 且民心 -10；
makeStandInGeneral 五维 50；relocateCapital 保留 50% 资源
// evaluateEnding
if (!st || st.oathPending===true) return null;
owned = 城池中 owner==='player'; factionsWithLand = 有地且非 player/han 的势力集合;
decisions = 最近 5 条含 举义/攻陷/迁都/背盟/结盟/裁军/招抚 的事件文本;
owned.length===0 → {type:'fallen', title:'败亡'}
unified = capitals 全归玩家 && factionsWithLand.size===0
       （无 capitals 时退化为 factionsWithLand.size===0 && owned.length>=8）
       → {type:'unified', title:'天下归一'}
scenarioGoal 达成 → {type:'partial', title:'偏安'}
否则 null
// 章节结局（另一套）
held = playerLands(state).length >= (rules.finale.holdLands ?? 3) && !!mainCity(state);
ending = held ? 'held' : 'lost'（不 held 时移走最远 2 块田）；
结局后 settleCampaign 冻结 fired、改跑 runPatrols
```

### 7.15 生效设施清单（`facility-catalog.js`）【实测】

```js
EFFECTIVE_ADDITIONS = Object.freeze({
  17:'wood', 18:'iron', 19:'grain', 20:'stone', 21:'gold', 23:'capacity'
});
GATE_FACILITIES = Object.freeze({ 15: '解锁府库资源兑换' });
AXIS_LABEL = { wood:'木材产量', iron:'铁矿产量', grain:'粮草产量',
               stone:'石料产量', gold:'金币产量', capacity:'府库容量' };
effectiveAxes(cfg,f) = cfg.facilityAdditions(type).map(a=>EFFECTIVE_ADDITIONS[a]).filter(Boolean).去重;
isActiveFacility(cfg,f) = effectiveAxes.length>0 || Object.hasOwn(GATE_FACILITIES, String(type));
facilityEffectText(cfg,f) = axes.join(' / ') || '未参与本版本结算';
facilityView(cfg,list,opts) → { rows, allCount, hiddenCount, legacy };
legacyFacilitiesEnabled() = process.env.SLG_LEGACY_FACILITIES === '1';
```

**【键空间警告】** `EFFECTIVE_ADDITIONS` 的键是**加成类型 aType**（`conf/json/facility/facility_addition.json`：17 木材产量 / 18 铁矿产量 / 19 粮食产量 / 20 石矿产量 / 21 税收 / 23 府库容量），`GATE_FACILITIES` 的键是**设施 type**。两者数字大多巧合相等（伐木场 type 17 的加成恰为 aType 17），但不是同一张表：集市 `type 15` 的加成是 `aType 16`（交易兑换率，不进产量），仓库 `type 25` 的加成是 `aType 23`（府库容量）。判据先 `cfg.facilityAdditions(f.type)` 取 aType 数组，再映射到资源轴。

**生效 7 项（设施 type）**：`15, 17, 18, 19, 20, 21, 25` = 集市（门槛）、伐木场、炼铁场、磨坊、采石场、民居、仓库。**过度 19 项**：疾风营/铁壁营/军机营/尚武营/兵营/预备役所/五势力点将台/封禅台/校场/统帅厅/募兵所/社稷坛/城墙/女墙/主城等。实测 `facilityView(cfg, 全26项)` → `rows.length=7, allCount=26, hiddenCount=19`。曲辕犁加成：`additionType === facilityAddition(19) && blueprints.includes(id)` → `bonus = 0.2`（磨坊 +20% 粮产）。

---

## 8. 状态机

### 8.1 战斗（`kernel/engine.js`）

```text
[构造] validateConfig → cloneUnits（unit_id 唯一、0<troops<=max_troops）→ PythonRandom(seed)
  ↓
[指挥阶段] battle_start 类战法（含主角 19001：给 self+ally 挂 insight/counter/damage_reduce reactions）
  ↓
[每回合 r=1..round_limit]
  ├─ round_start 被动
  ├─ prepare_ready：到期的准备战法
  ├─ 行动阶段（actionOrder：speed 降序，同速 unit_id 升序）
  │    ├─ 普攻：nearestFoe（slotDist + unit_id 字典序），须在 attack_range（默认 9）内
  │    ├─ 主动战法：rollTrigger（被动恒 fired）→ applyEffect（DAMAGE/HEAL/CONTROL/BUFF）
  │    └─ 追击：按 'order' 稳定排序
  ├─ 伤害链：baseDamage → calcDamage → damage_reduce → 扣 troops
  ├─ 回击：若目标有 counter reaction 且本次未 noReaction → 掷 chance →
  │        构造 flat_rate 87% STRATEGY_DAMAGE 的 counterEffect（noReaction:true）→ 递归一次
  └─ round_end：清除 犹豫/怯战、递减有期限 reactions（洞察 −1）
  ↓
[结束] winner = 存活阵营唯一 ? 该阵营 : null
       event_fingerprint = hash16(stableStringify(events))
```

**控制免疫**：`CONTROL` 命中目标且目标 `reactions` 有 `insight` → 写 `control_immune` 事件，不施加控制。

### 8.2 出征 / 行军（`strategy.js`）

```text
[idle] --attack--> [marching]
  march = { id, kind:'assault'|'transport', from, to, armyId, frac, troops,
            km, speed, days, arriveDay, lockedSeed, confirmBattle, resolved:false }
[marching] --arriveDay 到达 & confirmBattle & !confirmed--> [pendingBattle]
[pendingBattle] --battleConfirm--> [resolving] --> [settled]
[pendingBattle] --battleRetreat / >30 日超时--> [retreating] --> [idle]
[marching] --recall--> [retreating] --> [idle]
[marching] --reorder--> [marching]（队列顺序变化）
[transport] --到达--> deliverGrain(to, grain) --> [settled]
```

`strategyResolveMarches` 对非玩家侧只标 `resolved=true`（战在 `applyOrders` 抽象结算）；对玩家侧走完整链路。

### 8.3 事件（`event-engine.js`）

```text
[候选池 150] --每旬 strategyEventTick--> 过滤 once/cooldown → evaluateEvent →
  排序(priority↓, id↑) → exclusive 组取第一条、其余进 1 旬 cooldown →
  取前 maxPerTurn(2) --> [pendingEvents]
[pendingEvents] --玩家点选项--> applyEffects(api) → 记 es.choices[id] → [已决]
[pendingEvents] --UI 静音--> dismissedEvents[id]=true（不写服务端状态，仅本会话显示层）
```

### 8.4 宿命 / 序章 / 世界层

| 状态机 | 状态 | 迁移 |
|---|---|---|
| 宿命链 `fate.js` | `在册 / 归玩家 / 替身在岗 / 断链` | `transitionFate(state,action,id)`；只回答「这一站写谁的名字」 |
| 序章 `campaign.js` | `未举义 → 借粮/拒粮抉择 → 黄巾波次1/2 → 巡逻 → 终局 held/lost` | 按 `day` 触发 `fired[day]`；结局后冻结 fired、改跑 `runPatrols` |
| 蝴蝶进度 `drift.js` | `canon(史实) / shift(偏移) / rewrite(改写)` | `addDrift(state,amount,reason,bands)`，剧情模块不自己加分 |
| 世界层归属 | `owner` 变更 | **不可逆**，只能通过后续玩法（复国/再攻）改变 |

### 8.5 窗口与弹层（`ui-shell.js` + `interaction-ui.js`）

```text
[login phase] ──session.ready──> [game phase]
[game] 主窗口判定：city > panels > win > modal > drawer
  ├─ 有 main（data-slg-window=main）→ 隐藏浮窗/按钮坞（display:none!important）
  ├─ 多个 .win → 只留最后一个
  ├─ data-slg-dialog=1 → 图例/开关给弹窗让位
  └─ 事件卡 .slgIxEvent 不计入 modal（非模态右下角）
[事件卡] --稍后处理 / ESC / Shift+ESC / 点空白--> dismissedEvents[id]=true →
          显示「未决事件 N」徽标 --点击--> 清 dismissedEvents 并重新拉状态
```

---

## 9. 表现层注入详细设计

### 9.1 两条通道与四个 IIFE【实测】

| 通道 | 注入点 | 内容 | 幂等守卫 |
|---|---|---|---|
| A. `/index.html` 响应 | `</body>` 前插 4 个 `<script src>` | `panels-ui.js`、`interaction-ui.js`、`ui-shell.js`、`editor-ui.js` | `window.__slgPanels / __slgIX / __slgShell / __slgEditor` |
| B. 客户端 bundle / 资源 | `createSkillAssets().intercept()` | `STRATEGY_OVERLAY_SOURCE`、`BATTLE_ANIM_SOURCE`、`CITY_WINDOW_V2_IMPL` + 战法 JsonAsset | 各模板内部自有守卫 |

四个 IIFE 互不引用局部变量，只通过 `window.__slg*` 公开入口协作；启动期一次性读入源码常量（`index.js:52-71`），HTTP 下发带 `no-store`。

### 9.2 四个注入脚本

| 脚本 | 字节 | 职责 | DOM 容器 id | 轮询 | 全局对象 |
|---|---:|---|---|---|---|
| `panels-ui.js` | ~88,551 | 六府面板 + 举义页 + 战报红点 | `slgPanelsDock / Btns / Mask / Win / Nav / Title / Sub / Body / Toast`、`slgRepDot`、`slgFormup`、`slgTransportBox`、`slgOath*` | 战报 25s；举义页 1s；toast 3200ms | `window.__slgPanels = {open,close,refresh,state,ui,render,setData}` |
| `interaction-ui.js` | ~87,675 | 术语/百科/预览/撤销/建言/六透镜/队列/引导/设置/常驻入口 | `slgIxCss / IxRoot / IxToast / IxPhase / IxAgenda / IxLens / IxQueue / IxQuick / IxDrawer / IxEventBadge / IxGuide / .slgIx-tip` | 聚合状态 20s；术语 MutationObserver debounce 220ms | `window.__slgIX = {state,refresh,tip,encyclopedia,keys,guide,drawer,lens,terms,undo,closeAll,...}` |
| `ui-shell.js` | ~19,512 | 登录门禁 + 一屏一窗 + 浮窗收束 | `slgShellCss / slgShellToggle`；其余靠选择器治理别的模块创建的节点 | `/__slg/session` 1200ms；MutationObserver 30ms / 点击 40ms / Esc 60ms | `window.__slgShell = {phase,window,floaters,reconcile,session,float,toggleFloat,floatState,floats,attachFloaters}` |
| `editor-ui.js` | ~13,223 | 武将编辑器浮层 | `slgEdCss / .slgEd-modal / .box.slgEd`；复用 `slgIxToast` | **无定时轮询**（事件驱动）；toast 3200ms | `window.__slgEditorOpen`、`window.__slgEditor = {open}` |

**六府 NAV 七项**：`general / strategy / war / interior / depot / equip / library`；Dock 常驻 6 个（过滤 `war`）+ `__reports 战报`。武将页四子页签 `attr/skill/equip/story`。

**交互层常量**：`LENSES = faction/supply/stock/general/intel/terrain`（六透镜）、`GUIDE = g1..g6`、`FONT_TIERS=[85,100,120]`、`S.alwaysOnTop=false`、`S.dismissedEvents={}`、`S.eventPending=0`。

### 9.3 z-index 阶梯（全表）【实测，低 → 高】

| 值 | 归属 | 证据 |
|---:|---|---|
| 3 / 4 / 6 | 战略层内部 head / dock / foot / side / logPanel | `skills.js:2515,1232,1284,1680,1019` |
| 99000 | `slgLocalCover` | `skills.js:1165` |
| 99998 | `slgStrategyOverlay` | `skills.js:1169` |
| 99999 | `slgPanelsDock` | `panels-ui.js:195` |
| 100002 | `slgLegend` | `skills.js:1276` |
| 100004 | 编队/运输遮罩 | `panels-ui.js:110,161` |
| 100100 | `slgPanelsMask` / `slgIxAgenda` / `slgIxLens` | `panels-ui.js:212`；`interaction-ui.js:168,176` |
| 100110 | `slgIxQueue` | `interaction-ui.js:183` |
| 100120 | `slgIxPhase` / `#slgIxQuick`（常驻入口条） | `interaction-ui.js:151,291` |
| 100130 | `slgPanelsToast` | `panels-ui.js:268` |
| 100150 | `slgIxDrawer` | `interaction-ui.js:187` |
| 100240 / 100250 | Guide（ui-shell game 态 / IX 基础） | `ui-shell.js:61`；`interaction-ui.js:228` |
| 100420 | 城内页（注释约定） | `interaction-ui.js:194` |
| 100500 | `slgShellToggle` | `ui-shell.js:104` |
| 100560 | `#slgUIv2 .win` 主窗 | `skills.js:2979` |
| 100600 | `slgIxEventBadge` | `interaction-ui.js:220` |
| 100700 | `slgBattleOverlay` 全屏战斗回放（★ 2026-11-19：原 99997 低于主窗，回放被战报窗盖住） | `skills.js` `ensureOverlay()` |
| 100760 | `.slgIx-modal` 决策预览 | `interaction-ui.js:199` |
| 100780 | `.slgIx-tip` 术语 | `interaction-ui.js:156` |
| 100820 | `#slgUIv2 .modal` 确认框 | `skills.js:3025` |
| 100840 | `.slgEd-modal` 编辑器 | `editor-ui.js:48` |
| 100880 | `#slgUIv2 .toast` | `skills.js:3018` |
| 100900 | `#slgIxToast` | `interaction-ui.js:148` |
| 2147483646 | `slgOath` 举义全屏页 | `panels-ui.js:1106` |

**【红线】** 改任一层级或弹窗行为，必须跑 `tools/mouse-playtest.js`（源码态 + `--packaged` 各一轮）。

### 9.4 一屏一窗与浮窗治理

`ui-shell.snapshot()` 统计 `slgCityPage / slgPanelsMask / #slgUIv2 .win / .slgIx-modal:not(.slgIxEvent) / #slgUIv2 .modal / slgIxDrawer`；`reconcile()` 按 `city > panels > win > modal > drawer` 定 `data-slg-window`。FLOATS 四张：`side→slgStratSide`（图层与检索）、`lens→slgIxLens`、`agenda→slgIxAgenda`、`legend→slgLegend`；支持 `data-slg-float-*` 单张开关、`data-slg-floaters="off"` 一键全收、拖拽并用 `localStorage('slgPos:<id>')` 记位置。

### 9.5 事件卡非模态（M4-6）【实测】

```css
.slgIx-modal.slgIxEvent {
  inset:auto; right:16px; bottom:92px;
  background:transparent; pointer-events:none;   /* 只有 .box 可点 */
}
```

三层垂直排布：外壳开关 `bottom:12` / 徽标 `52` / 卡片 `92`。`dismissEvent(id,mask)` 写 `S.dismissedEvents[id]` 并移除 mask；`buildEventCards` 跳过已静音 id；「稍后处理」按钮、点空白、ESC、Shift+ESC 四条路径都走静音；徽标点击清空静音并 `loadState()` 重新打开。取证：`check-release.js:412-418` 断言 `eventCard.pointerEvents==='none'`。

### 9.6 Electron 窗口契约【实测】

| 参数 | 值 |
|---|---|
| `width/height` | `min(1280, workArea-40)` / `min(720, workArea-40)` |
| `minWidth/minHeight` | `min(900,width)` / `min(540,height)` |
| `alwaysOnTop` | `false`（默认永不置顶） |
| `minimizable/maximizable/resizable/fullscreenable` | 全部 `true` |
| `show` | `false`，`ready-to-show` 再 `show()` |
| `webPreferences` | `contextIsolation:true`、`nodeIntegration:false`、`spellcheck:false`、`webgl:true`、`preload:electron/preload.cjs`、`backgroundThrottling:false` |
| 导航 | `will-navigate` 只放行 `http://127.0.0.1:8088/`；`setWindowOpenHandler → deny`；`did-fail-load` 最多重试 3 次 |
| 二次启动 | `restore() + showInactive()`，不抢焦点；`requestSingleInstanceLock()` |
| 菜单 | `Menu.setApplicationMenu(null)` |

自动化分支（`SLG_SMOKE / AUDIT / MOUSE / PERF / LAYOUT / DIAG = 1`）只 `win.focus()` 一次 + `setBackgroundThrottling(false)`；**仅 `SLG_FORCE_TOP=1` 才 `setAlwaysOnTop(true,'floating')`**（不用 `screen-saver` 层）。

`preload.cjs` 全文 19 行，`contextBridge.exposeInMainWorld('__slgWin', {...})` 只 4 项：`isElectron:true`、`isAlwaysOnTop()`、`setAlwaysOnTop(on)`、`minimize()`；主进程 IPC：`app:status / win:is-always-on-top / win:always-on-top / win:minimize`。**renderer 不暴露 `ipcRenderer / fs / node / shell`**。

---

## 10. 确定性与可复核设计

### 10.1 随机数

```js
// strategy-rng.js：战略层
let state = (Number(seed)>>>0) + (Number(turn)>>>0)*1000 + (crc32Utf8(String(tag))>>>0);
state ^= state<<13; state>>>=0; state ^= state>>17; state ^= state<<5; state>>>=0;
random() = state / 4294967296;      // xorshift32
// 调用点：handlers:1343 / city-econ:212(disaster),350(defect) / diplomacy:348(sow)
//        / captives:47(capture) / strategy:742,1285,2124,2157,2182
// 兜底 seed：state.seed ?? 20261110（createWorld 未写入，见 §17）

// kernel/rng.js：PythonRandom（MT19937 + init_by_array，对齐 CPython）
random() = (a*67108864.0 + b)/9007199254740992.0;   // 53 位合成
// 备用 Mulberry32Rng；二者均带 calls 计数
```

**【红线】** 新增 `Math.random()` 即回归。`whitebox-architecture.test.js WB-04` 先 `stripComments` 剥注释（否则注释里写个 `Math.random` 会假红），再扫描 `interaction-ui.js / panels-ui.js / skills.js / ui-shell.js`。核查时 `server/ kernel/ domain/ tests/ tools/` 全部零命中；仅 `web/` 第三方引擎包内存在。

### 10.2 种子与指纹

| 指纹 | 定义 | 用途 |
|---|---|---|
| `webFingerprint` | `sha256(排序后的 "相对路径:文件sha256" 行以 \n 拼接)` | 原画面 1582 文件保全（`pack.js:122`、`check-release.js:58-60`） |
| `config_fingerprint` | `hash16(stableStringify(config excluding provenance/unresolved))` | 内核配置变更检测（`kernel/config.js:45`） |
| `event_fingerprint` | `hash16(stableStringify(engine.events))` | 战报逐事件复核（`kernel/engine.js`） |
| `battleSeedFor` | `crc32Utf8("armyId:x:y:day")` | 唯一战斗种子（`battle.js`，`WB-05` 强制只定义于此） |

`range_trace` 与 `events` 物理分离（`engine.js:69-71,376-393`），保证射程调试信息不污染事件指纹。

### 10.3 不变量校验

`kernel/config.js validateConfig`：`damage_rates_pct` 非空、`hero_names/skill_names` 非空、`il_methods` 含 `CalcDamageByTerms`、`level_pairs` 中 `exactly_double` 58/58 满足 `|ratio-2|<1e-9`、`Tcfg_hero` schema 含 `attack_base`、`min_damage>=0`、`round_limit>0`、`troop_factor>0`、伤害率有限非负、`counter_tiers` 有限非负。

`kernel/report.js validateInvariants(result, units, roundLimit)`：回合数 ≤ 上限、`rng_calls` 有限非负、事件 `round` 越界、payload 数字非有限、`calc` 九字段有限、`final>=min_damage>=0`、兵力对账 `|before-after-applied|<=1e-9`、`applied∈[0,before]`、**兵力守恒** `finalTotal===initialTotal-(Σdamage-Σheal)`、`aliveSides` 与 `winner` 一致。

`battle.js:644-658` 写 `state.battleLog`：`{seed, event_fingerprint, config_fingerprint, rng_calls, skillSystem:'battle-kit/original-fragments/v3', loadout, reportSkillIds}`。

### 10.4 结构与口径校验

| 校验 | 位置 |
|---|---|
| 事件 schema（白名单、算子、choices、source、武将引用） | `event-dsl.js validateEventSchema`、`tools/check-events.mjs`、`WB` 测试 |
| 宿命 24 组结构 | `fate-groups.js validateFateGroups`（加载即抛错） |
| 面板自检（战法 ≥2 获取途径且含 research、文案未改、装备单件 ≤8%） | `panels.js panelSelfCheck` |
| 请求消息净化（NaN/Infinity → 0、数组数值化） | `handlers.js sanitizeMsg`、`normalizeTriple` |
| knob 越界钳位 | `knobs.js knobGet/knobSet`（未知名返回 `undefined`，宁可显式失败） |
| 双账本写入切断 | `WB-06` 逐行禁止 `resources[..].grain =` |
| 战斗输入合法性 | `kernel/engine.js cloneUnits`：unit_id 唯一、`0<troops<=max_troops`、深拷贝 |
| 内核编译产物一致 | 10 份 `.js` 与 `battle-core/build/src` 逐字节比对（人工同步 + 发布闸） |

---

## 11. 错误处理与降级设计

### 11.1 分层错误形状

| 层 | 形状 | 示例 |
|---|---|---|
| WS 协议 | 顶层 `code`（数字）+ `msg.reason` | `code 1 + not_own_city`；`code 404 + unknown_message` |
| WS handler 异常 | `code 500 + {reason:'internal', message}` | `index.js:892-897` 捕获 |
| WS 解码失败 | **无回包**，静默丢弃 + 日志 | `decode failed: ...` |
| HTTP 领域异常 | `{ok:false, message}` + 500 | editor / panels / oath |
| HTTP 参数错误 | `{ok:false, reason}` + 400/404/500 | `bad_request / empty_slot / io_error / not_a_save / bad_save / bad_action` |
| HTTP 静态 | 纯文本 + 状态码 | `403 Forbidden` / `404 Not found` / `500 Internal error` |
| 业务失败但协议 OK | `code 0 + msg.ok=false / reason` | `general.drawGeneral no_guest`、`strategy.attack ok:false` |

`handlers.js:1511-1513` 明确：`strategy.attack` 的 **`ok` 是唯一判定**，`code` 只作协议层错误码同步。

### 11.2 错误优先级（不得打乱）

`city.upFacility`：`not_own_city` > `no_such_facility` > `facility_disabled` > `max_level / upgrading / no_cost_table / res_not_enough`。M4-12 曾因把升级拦截放得太早破坏错误优先级，已修回。

### 11.3 降级路径

| 场景 | 降级 |
|---|---|
| 服务端字段缺失 | `/__slg/interaction/state.fieldGaps` 显式登记，UI 显示「暂无数据」而非编造 |
| 配置单文件损坏 | `facilityByType` 逐文件 try/catch，单文件失败不阻塞启动 |
| `mapRes_0.json` 读失败 | 退化为默认地形 |
| `overrides.json` 非法 | `loadOverrides()` 回退 `emptyOverrides()` |
| `detail.json` 读失败 | `/__slg/strategy/detail` 回 `{}` |
| 存档版本未知 | 安全模式（只读 + 提示导出）【规划项，当前 `loadWorld` 白名单 1/2/3】 |
| 静态资源读失败 | 重试 5 次 ×250ms 后 500 |
| 打包删除受限 | `pack.js` 把旧目录改名 `.stale-<ts>` 而非强删 |

### 11.4 性能降级顺序（GDD §11.5，不许反着来）

1. 先降表现：关动画、降 LOD、合并飘字（不影响数值）。
2. 再降预计算：地图 token 改可见区渲染。
3. 再分帧结算：72 城拆 3 帧（田赋/内政/敌情），每帧 ≤16ms，给进度条。
4. 最后才对**非战斗**数值做整数近似；**战斗与粮道禁止近似**。
5. 禁止：为性能减少信息种类、跳过校验、延迟结算（会「数字对不上」）。

触发：结算 >2.5s 或单帧 >32ms 连续 3 次 → 自动降级并写日志，恢复后自动退出；首次触发必须给一次提示，不得静默。

---

## 12. 性能设计

### 12.1 预算（GDD §11.5 修订版）【实测口径】

| 项 | 预算 | 测法 |
|---|---|---|
| 首屏（冷启动到沙盘可点） | <7s，且必须三段分解 | `tools/perf-probe.js` |
| ├ ① 登录页出现 | **<600ms（硬闸 PF-01a）** | 同上 |
| ├ ② Cocos 首场景创建 | 不设上限，只记录（PF-01b） | 同上 |
| └ ③ 登录后到沙盘可点 | **<800ms（硬闸 PF-01c）** | 同上；实测 154ms |
| 面板打开 | <100ms | `performance.now()` |
| 回合结算 | <2.5s（72 城 + 8 势力） | 服务端计时 |
| 推演单次 | <50ms（5 次同参中位；首次冷启动只记录 PF-04b） | 端点计时 |
| 注入层 DOM 增量 | ≤400 节点/视角 | `MutationObserver` |
| 内存（主 + 渲染进程） | <700MB | `getAppMetrics()` |

**修订依据**：原版 Cocos 3D 客户端首场景自身需 4.6~6.0s、渲染进程常驻 380MB+，A/B 实测（`git stash` 回 HEAD 复测 6715ms vs 带改动 6459ms）证明注入层不是瓶颈；GPU 进程 WebGL 纹理镜像实测 628MB，单列入档不计入判定，避免「口径一换结论就变」却不留痕。

### 12.2 服务端已有的性能措施

- 静态资源 `ETag + 304`（`/index.html` 永不 304）、gzip 缓存上限 500、`sendJson` ≥2048B 才压缩。
- `loadConfig` 进程级单例；`chapterRules` / `loadOverrides` 用 mtime 缓存。
- `save()` 250ms 防抖；`strategyViewState` 约 59KB 由前端 5s 轮询而非每次点击全量拉。
- 日志/数组全有上限（见 PRD NFR-24），避免长时间挂机内存膨胀。
- 推演为只读沙盒，不复制整份 state。

---

## 13. 安全与合规设计

### 13.1 威胁模型与现状【实测】

| 项 | 现状 |
|---|---|
| 监听 | 两个 server 均 `127.0.0.1`；端口与原客户端 `GameConfig.ts` 一致 |
| CORS | `Access-Control-Allow-Origin:*`、`Headers:*`，`OPTIONS` 回 204 |
| HTTP 鉴权 | **无**（`/account/*` 任意路径回成功占位） |
| WS 升级鉴权 | **无**（只校验 Upgrade 头与 `Sec-WebSocket-Key`） |
| WS 消息鉴权 | **无**（`conn.meta.key` 只用于加解密） |
| 静态路径穿越 | `target.startsWith(root)` 否则 403 |
| 导航 | `will-navigate` 只放行本机 8088；`setWindowOpenHandler → deny` |
| renderer 隔离 | `contextIsolation:true`、`nodeIntegration:false`、`__slgWin` 4 项白名单 |
| 口令 | `account.login` 后删明文，存 `sha256` 摘要前 32 位 |

**结论**：单机威胁模型下「本机回环 + 单实例 + 无外部导航」是安全边界；**若未来开放局域网/端口转发/浏览器跨域访问，必须先补鉴权**（PRD `OP-07`，列为阻塞项）。

### 13.2 合规与数据溯源【实测】

| 资产 | 内容 |
|---|---|
| `conf/compliance/provenance.json` | 10 类第三方派生数据台账，字段 `path/kind/status/origin/count/evidence/action_before_release/confidence`；`forbidden_artifacts` 定义禁止扩展名/路径模式与策略 |
| `conf/compliance/map-declaration.json` | `type:'schematic_projection'`、`projection:'equirectangular'`，声明地图为示意图 |
| `reports/data-provenance.json` | 554 条 `source+confidence`，`missing:0` |
| `heroes-240.json` | 逐人 `source{ref,level,dbRow,override,confidence}`；源 `D:/WorkBuddy/three-kingdoms/characters.csv`（936 行） |
| `innate-skill-audit.json` | `totals{officialSkills:642, translatable:610, signatures:227, representatives:96, heroes:424, w0Linked:139, derived:237, authored:1}` + `caveat` 声明派生非史实 |
| `innate-skill-overrides.json` | 50 位专属战法人工证据 + 2 位拒绝名单（孙权/貂蝉） |

**红线**：公开可见 ≠ 可复制/商业再发布；每个数据源登记许可与授权状态；素材默认不下载；跨游戏同名实体不可自动合并；AI 不得无证据编造游戏属性。发行前必查 `docs/合规与换皮清单.md`；7 项 `requires_user` 由用户处理，不冒充通过。

---

## 14. 测试与质量保障设计

### 14.1 命令与参数【实测】

```json
// offline/package.json scripts
{
  "serve": "node server/standalone.js",
  "test":  "node --test --test-concurrency=4 --test-timeout=60000 tests/*.test.js",
  "smoke": "node tools/smoke.js",
  "check": "node tools/check-release.js",
  "pack":  "node tools/pack.js"
}
```

`tests/` 下 `*.test.js` 共 **73 个** + 夹具 `client.js`（README 的「70 个文件 / 471 条」为旧快照）。

### 14.2 单测文件全表（73 个，按前缀分组）

| 组 | 文件 |
|---|---|
| 协议/编解码/注入/HTTP/架构白盒（6） | `codec.test.js`、`protocol.test.js`、`inject-syntax.test.js`、`http-endpoints.test.js`、`contract-matrix.test.js`、`whitebox-architecture.test.js` |
| 基础域 / 回归 / 玩法（22） | `battle-anim.test.js`、`bugfix.test.js`、`building.test.js`、`campaign.test.js`、`domain-coverage.test.js`、`dossier.test.js`、`empire.test.js`、`followup.test.js`、`general-progress.test.js`、`innate-skills-and-stats.test.js`、`library-skills.test.js`、`loop-balance.test.js`、`march.test.js`、`march-queue.test.js`、`oath.test.js`、`panels.test.js`、`playtest-fixes.test.js`、`protagonist-save.test.js`、`save-slots.test.js`、`skills.test.js`、`tavern.test.js`、`ux-shortcuts.test.js` |
| M2（7） | `m2-appoint.test.js`、`m2-army-supply.test.js`、`m2-diploma.test.js`、`m2-failstate.test.js`、`m2-interior-kinds.test.js`、`m2-ledger.test.js`、`m2-tension.test.js` |
| M3（7） | `m3-event-ui.test.js`、`m3-events.test.js`、`m3-heroes-fates.test.js`、`m3-runtime-wiring.test.js`、`m3-scenario-runtime.test.js`、`m3-scenarios.test.js`、`m3-skills-80.test.js` |
| M4（10） | `m4-13-distance-garrison-captives.test.js`、`m4-a11y.test.js`、`m4-compliance.test.js`、`m4-editor.test.js`、`m4-facility-catalog.test.js`、`m4-general-balance.test.js`、`m4-layout.test.js`、`m4-protagonist-skill.test.js`、`m4-system-audit.test.js`、`m4-window-behavior.test.js` |
| P6/P7/P8/P9（5） | `p6-city-recruit.test.js`、`p7-city-depth.test.js`、`p8-war-panel.test.js`、`p9-interaction.test.js`、`p9-npc-march.test.js` |
| P10（9） | `p10-console-level.test.js`、`p10-interior-task.test.js`、`p10-map-lod.test.js`、`p10-preview-consistency.test.js`、`p10-preview.test.js`、`p10-queue.test.js`、`p10-relation.test.js`、`p10-supply.test.js`、`p10-undo.test.js` |
| P11（3） | `p11-levy-and-gates.test.js`、`p11-session-gate.test.js`、`p11-ui-integrity.test.js` |
| 战略 / AI（4） | `strategy.test.js`、`strategy-brain.test.js`、`strategy-layers.test.js`、`strategy-map.test.js` |

内核另有 `battle-core/tests/*.test.ts` 4 份（golden vectors / 175 条事件 / 10000 场压测 / 配置指纹），`npm run build && node --test build/tests/*.test.js`。

### 14.3 Electron 执行体（9 个 `.cjs`）

`main.cjs`（主进程）、`preload.cjs`（白名单桥）、`console-level.cjs`（console 级别归一化，与 smoke/ui-audit 共用口径）、`smoke.cjs`（33 项）、`ui-audit.cjs`（72 路径）、`mouse-playtest.cjs`（54 步真鼠标）、`perf-probe.cjs`、`layout-audit.cjs`、`ui-probe.cjs`。

### 14.4 `tools/` 33 个脚本 + 1 个公共库

| 类别 | 脚本 |
|---|---|
| 内容构建 | `build-skills.js`、`build-skill-source.js`、`build-heroes.mjs`、`build-scenarios.mjs`、`build-innate-skills.mjs`、`build-library-skills.js`、`build-library-skills-extra.js`、`build-panel-conf.mjs`、`build-strategy-tmx.js`、`normalize-hero-stats.mjs` |
| 合规 / 静态核查 | `check-release.js`、`check-compliance.js`、`check-contrast.js`、`check-events.mjs`、`check-terms.js`、`compliance-report.js`、`design-audit.mjs`、`token-converge.mjs` |
| 模拟 / 平衡 / 日志 | `system-audit.mjs`、`sim-60turns.mjs`、`hero-balance.mjs`、`dump-strategy-log.mjs`、`live-log-audit.mjs`、`diag-bugs.mjs`、`explore-bugs.mjs`、`playtest.js` |
| 真机取证启动器 | `smoke.js`、`ui-audit.js`、`mouse-playtest.js`、`perf-probe.js`、`layout-audit.js`、`ui-probe.js` |
| 打包 | `pack.js` |
| 公共库 | `lib/port-guard.js`（`assertPortsFree([8088,8004], tag)`） |

### 14.5 双态取证链

`smoke.js` / `ui-audit.js` / `mouse-playtest.js` / `perf-probe.js` / `layout-audit.js` / `ui-probe.js` 都遵循：

1. 用 `lib/port-guard.js` 断言 8088/8004 空闲；
2. 清 `ELECTRON_RUN_AS_NODE / NODE_OPTIONS / WORKBUDDY_CLIENT_USER_AGENT`；
3. 设 `SLG_*` 触发标志 + `SLG_SMOKE_EXIT=1` + `SLG_SMOKE_TAG=original|packaged` + `SLG_SMOKE_REPORT_DIR`；
4. Electron 侧执行体写 `reports/<name>-<tag>.json`；
5. 启动器**以报告判定通过**，Electron 收尾非 0 退出码只警告。

**真鼠标**与 UI 审计的区别：`mouse-playtest.cjs` 用 `webContents.sendInputEvent` 派发 `mouseMove/mousePressed/mouseReleased`，点击前 `elementFromPoint` 校验目标未被遮挡。

### 14.6 `check-release.js` 检查项分组【实测】

| 组 | 内容 | 行号 |
|---|---|---|
| 1 交付文件完整性 | `required` 27 项逐文件 `existsSync` | `:91-102` |
| 2 原画面 100% 保留 | 逐字节复制 / 指纹可复现 / 无自绘 Canvas UI / index.html 未注入 / 工作区干净 | `:104-138` |
| 3 内核稳定性 | 内核单测 / 175 黄金向量 / 10000 场压测 / 协议层测试 | `:141-159` |
| 4 / 4b 内核接入与战法替换 | 战报链路 / 31 战法 / 占位 UUID 移除 / 运行时注入 / 装配协议 | `:162-197` |
| 5 完全离线 | 零外网地址 / 只监听回环 / 无 Go+MySQL / 导航拦截 | `:200-231` |
| 6 壳健壮性与存档 | 单实例 / 日志 / 隔离 / 窗口行为 / 原子写 | `:234-254` |
| 7 打包产物 | exe 存在 / pack 可复现 | `:259-264` |
| 7.7.4 报告自举 | 报告缺失或工具源码更新就地重跑（60 旬双跑约 1.8s） | `:266-356` |
| 7.7.5 报告新鲜度 | `newestShippedSource()` + `reportStale()`；`web/` 排除（指纹单独兜）；`STATIC_SHIPPED` 含 3 份静态 conf 与 `kernel/` | `:358-400` |
| 7.8 双态冒烟 | 两态 × 9 项动态断言 = 18 项（含 M4-6 窗口取证） | `:402-435` |
| 7.9 / 7.9b / 7.9c / 7.9d | 合规台账 / 数据溯源 / 对比度 / 系统性验收（60 旬零异常、灭国闭环、真链路、百分制判据等） | `:437-594` |
| 7.10 / 7.11 | 术语覆盖 134 条 100% / 出征 8 环真实点击 E2E 零未捕获异常 | `:598-633` |
| 8 需用户处理 | 7 项 `requiresUser` 单列 | `:639-648` |

核查时 `reports/release-check.json = {achieved:92, failed:0, ready_for_steam_basics:true}`。历史项数递增 67→69→70→71→72→77/78→92；README 的「70 项」为旧快照。

### 14.7 报告新鲜度与并行竞态【红线】

- `newestShippedSource()` 扫描 `SHIPPED_DIRS = ['electron','server','conf','kernel']`；`conf/campaign` 因存档/覆盖层运行时回写被整体跳过，仅 `protagonist-skill.json` / `hero-skills.json` / `innate-skill-overrides.json` 列入 `STATIC_SHIPPED`。
- 报告缺失 / 早于出厂源码 / 早于工具源码任一 → `reportStale()` 触发自愈重算。
- **同仓多 agent 竞态教训**：两个会话同时跑验收会互相覆盖 `reports/`、抢 8004/8088、清空 `build/`。取证必须核 `reports/*.json` 的 mtime 与内部 `startedAt`，不能只信 stdout 的 `passed` 行；用 `SLG_SMOKE_REPORT_DIR` 指独立目录；只清理自己启动的 PID。

---

## 15. 构建、打包与部署

### 15.1 手工 portable 打包（`tools/pack.js`，145 行）【实测】

```text
① 校验 ELECTRON_DIST/electron.exe 与 WEB_SRC/index.html 存在
② 旧 OUT（build/SLG-Offline-win32-x64）先 rmSync；删除保护拦下则改名 .stale-<ts>
③ cpSync(ELECTRON_DIST, OUT)，**复制时过滤 locales**，只保留
   zh-CN / zh-TW / en-US / en-GB 四个 .pak（先过滤再复制，否则触发宿主删除保护限流 50）
   并删 default_app.asar
④ 复制 server/ kernel/ conf/ electron/ tools/ 五个目录 + tests/client.js
⑤ 逐字节复制 web/（1582 文件）
⑥ 写 resources/app/package.json（main: electron/main.cjs）
⑦ electron.exe → SLG-Offline.exe
⑧ 生成 reports/pack.json + reports/web-manifest.json：
   逐文件 sha256 比对；byteIdentical 必须为 true，否则抛错
```

`webFingerprint = sha256(排序后的 "相对路径:文件sha256" 行以 \n 拼接)`，定义于 `pack.js:122`，校验定义于 `check-release.js:58-60`。核查值：1582 文件 / 179,831,865 B / `ee987ec2c30a6e99d12f14573d2d39bf1af44b8ff500acc73b0ee826e8150485` / `byteIdentical=true` / `diff=[]`。

### 15.2 产物目录树

```text
build/SLG-Offline-win32-x64/
├── SLG-Offline.exe                 （由 electron.exe 改名，约 250MB）
├── LICENSE / LICENSES.chromium.html / version
├── chrome_100_percent.pak / chrome_200_percent.pak / resources.pak
├── icudtl.dat / snapshot_blob.bin / v8_context_snapshot.bin
├── d3dcompiler_47.dll / dxcompiler.dll / electron_wer.dll / ffmpeg.dll
├── vk_swiftshader.dll / vk_swiftshader_icd.json / vulkan-1.dll
├── locales/  en-GB.pak  en-US.pak  zh-CN.pak  zh-TW.pak   （仅 4 个）
└── resources/app/
    ├── package.json
    └── server/  kernel/  conf/  electron/  tools/  web/  tests/client.js
```

`build/` 不入库（`.gitignore` 排除 `node_modules/ build/ reports/ *.log`）；受限环境删不掉旧目录时 pack 自动改名 `.stale-*`，需人工清理。

### 15.3 最小必需文件（`check-release.js:92-101`，27 项）

`package.json`；`server/{codec,wsserver,config,world,battle,handlers,index,standalone,skills}.js`；`electron/{main,smoke}.cjs`；`kernel/{index,engine,rules,rng}.js`；`conf/{mapRes_0.json, skills.json, json/basic.json}`；`tools/{pack,smoke,check-release,build-skills}.js`；`tests/{client,codec.test,protocol.test,skills.test}.js`。pack 实际复制整目录，上述只是最小验收子集。

### 15.4 环境变量全表【实测】

| 变量 | 默认 / 取值 | 用途 |
|---|---|---|
| `SLG_HTTP_PORT` | 8088 | HTTP 端口 |
| `SLG_WS_PORT` | 8004 | WS 端口 |
| `SLG_WEB_DIR` | `offline/web` | 静态根覆盖 |
| `SLG_SAVE_DIR` | `offline/saves` | 存档目录 |
| `SLG_TRAVEL_MS` | 3000 | 行军时长（源码态） |
| `SLG_SMOKE` | `1` | 触发 `electron/smoke.cjs` |
| `SLG_AUDIT` | `1` | 触发 `ui-audit.cjs` |
| `SLG_MOUSE` | `1` | 触发 `mouse-playtest.cjs` |
| `SLG_PERF` | `1` | 触发 `perf-probe.cjs` |
| `SLG_LAYOUT` | `1` | 触发 `layout-audit.cjs` |
| `SLG_DIAG` | `1` | 触发 `ui-probe.cjs` |
| `SLG_FORCE_TOP` | 未设 | 仅 CI 取证允许 `setAlwaysOnTop(true,'floating')` |
| `SLG_SMOKE_EXIT` | `1` | Electron 侧按报告结论退出 |
| `SLG_SMOKE_TAG` | `original` / `packaged` | 报告名后缀 |
| `SLG_SMOKE_REPORT_DIR` | `reports/` | 并行验收隔离报告目录 |
| `SLG_ELECTRON` | — | 指定 Electron 可执行文件（启动器第一优先） |
| `SLG_ELECTRON_DIST` | — | 覆盖打包用 Electron dist |
| `SLG_LEGACY_FACILITIES` | 未设 | `=1` 时 `city.facilities` 取回全量 26 项作 GM 对照 |
| `SLG_OVERRIDES_FILE` | 未设（= `conf/campaign/overrides.json`） | **仅测试用**：并行测试进程把 `gm/overrides.js` 的写入路径指向自己的临时副本，避免多进程抢同一个文件造成 `editorSave` 偶发假红；生产与 GM 页不设此值 |

`window.SLG_TERMS` 是浏览器全局变量（术语内联），不是环境变量；`SLG_UI_START` 是 `check-release.js:130` 正则里的历史自绘 UI 禁用特征串，也不是环境变量。

### 15.5 启动脚本

| 脚本 | 行为 |
|---|---|
| `start-game.bat` | 清 `ELECTRON_RUN_AS_NODE` → 源码态启动 |
| `start-packaged.bat` | 清 `ELECTRON_RUN_AS_NODE` → 双击运行 `build/.../SLG-Offline.exe` |
| `npm install` | 装 `electron@45.2.3`（`devDependencies`）等 |

**注意**：不清 `ELECTRON_RUN_AS_NODE` 时 Electron 会退化为纯 Node，窗口不会出现。

---

## 16. 可维护性与扩展规程

### 16.1 新增玩家可见数值

1. 先在 `FIELD-CONTRACT.md` 登记「数值 / 权威源 / 单位 / 精度 / 界面可否复算 / 消费方」。
2. 在服务端实现唯一计算函数（放 `server/domain/` 的合适叶子模块）。
3. UI 只消费该字段，禁止前端乘一次、加一次。
4. 服务端暂缺 → 写入 `/__slg/interaction/state.fieldGaps`，UI 显式降级。
5. 补 `tests/` 断言「UI 构成条逐项相加 === 最终值」。

### 16.2 新增 WS 消息

1. 确认原客户端确实会发此 `name`；不改字段名大小写。
2. 在 `handlers.js switch` 加 case，**只做翻译**：`sanitizeMsg` → 调领域函数 → 组装 `{code,msg}`；不许在 switch 里写天数判断、产量公式、剧情分支。
3. 需要异步后果 → `ctx.schedule()`；需要广播 → `ctx.push()`（用白名单推送名）。
4. 补 `tests/protocol.test.js` 与 `tools/explore-bugs.mjs` 的非法 payload 覆盖。

### 16.3 新增 HTTP 端点

1. 在 `index.js:410-870` 的 `urlPath` 顺序匹配里加分支（注意 `/account/*` 在前、兜底静态在最后）。
2. 用 `readJson(req, limit, cb)` 并给明确上限；统一 `json()/sendJson()`；异常回 `{ok:false,message}` + 500。
3. 只读端点一律 `no-store`；动作端点 `result.ok` 才 `save()`。
4. 补 `tests/http-endpoints.test.js`。

### 16.4 改战斗内核【红线】

```text
改 battle-core/src/{types,rules,engine,...}.ts
  → cd battle-core && npm run build（tsc → build/src/*.js + *.d.ts）
  → 同步 10 份 .js 与 .d.ts 到 offline/kernel/
  → 跑 battle-core npm test（黄金向量 175 条 / 10000 场压测）
  → 跑 offline npm test 与 check-release（出厂源码清单含 kernel/ 与
     conf/campaign/protagonist-skill.json，改内核必须重跑全部报告）
```

**禁止**直接手改 `offline/kernel/*.js`（编译产物），否则下次 build 丢失。旧战法事件 payload 不许新增字段（会漂黄金向量与事件指纹）；`mechanics` 不许写进 `bonus_terms`。

### 16.5 改 `web/` 与注入层

- `web/` 磁盘文件**一个字节都不改**；所有 UI 走 §9 两条注入通道。
- 改注入层时注意四个 IIFE 的幂等守卫、`z-index` 阶梯（§9.3）、一屏一窗排除项、事件卡静音逻辑。
- 改完必须跑 `npm test` + 双态 `smoke/ui-audit/mouse-playtest` + `check-release`。
- `pack.js` 任何改动都要重新验证 `byteIdentical`。

### 16.6 改数值 / 配置

| 改什么 | 先改哪 | 再跑什么 |
|---|---|---|
| 玩法公式 | GDD 对应章节 → 本文 §7 | `npm test`、`system-audit.mjs`、`sim-60turns.mjs`、`hero-balance.mjs` |
| `conf/json/` 原表 | **不许改** | 走 GM/编辑器覆盖层 |
| `conf/campaign/` 派生表 | 先跑对应 `tools/build-*.js` | 相关 `m3/m4` 测试、`check-release` 7.7.5 报告新鲜度 |
| `knobs` 参数 | `domain/knobs.js` + 视图 | `knobGet` 越界钳位测试 |
| 玩家可见数值 | `FIELD-CONTRACT.md` | 同源断言测试 |

### 16.7 写每段代码前先填的四格（`ARCHITECTURE.md §7`）

| 格 | 问题 |
|---|---|
| 1 | 它属于五层里的哪一层？ |
| 2 | 它只回答哪一个问题？ |
| 3 | 它读入什么、写出什么？（形状写清楚） |
| 4 | 谁测试它、用哪条 `AC`？ |

**新增玩法代码前**：先在 `ARCHITECTURE.md §10` 文档地图里找到它属于哪本文档；找不到说明规格缺失，先补文档再动手——本项目已出现过「代码与设计各说各话」的返工。

### 16.8 提交前清单

```text
□ npm test 全绿（73 文件）
□ npm run pack（byteIdentical=true）
□ smoke.js + --packaged（33×2）
□ ui-audit.js 双态（72×2）、mouse-playtest.js 双态（54×2）
□ check-release.js（92/92、requires_user 单列）
□ git status 干净（文档入仓必须提交）
□ 本次改动涉及内核 → 已回填 TS 源并同步 offline/kernel/
□ 本次改动涉及 UI 层级 → 已跑真鼠标双态
□ 报告 mtime 与 startedAt 晚于最后一次源码改动，且确认是自己这一轮生成的
```

---

## 17. 偏差登记（应然 vs 实然 / 文档漂移 / 已知缺口）

> **本章是本文最重要的章节之一**。设计完整性不等于「假装一致」：把已核实的差异逐条登记，才不会让下一位维护者按过时文档改出回归。所有条目都**未在本版擅自修改代码**；处置列写明默认行为与拍板归属。

### 17.1 架构应然 vs 代码实然

| 编号 | 应然 | 实然 | 影响 | 默认处置 |
|---|---|---|---|---|
| `DEV-01` | `ARCH §5`：领域模块之间不互相 import | `server/domain/` 内大量单向 import；`strategy.js` 一个文件 import 26 个同层模块 | 分层约束事实放宽 | 新增模块继续按零环写；已有环登记为架构债，不重构 |
| `DEV-02` | `ARCH §5`：无 ESM 环 | 3 条静态 import 环：`world↔strategy`、`strategy→battle→world→strategy`、`strategy→campaign→world→strategy`（§5.3） | 重构风险 | ESM 目前可正常加载；若拆环须单独立项并跑全套回归 |
| `DEV-03` | `ARCH §2`：命令层是唯一改世界状态处 | 实际由 `handlers.js switch` + `strategy.js` 动作函数共同承担，`command.js` 仅 32 行播报 | 写入点分散 | `handlers.js` 继续只许变薄；新逻辑进 `domain/` |
| `DEV-04` | GDD §11.1 分层铁律：领域模块互不 import | 同 `DEV-01` | 同上 | 同上 |

### 17.2 文档数字漂移（历史快照 vs 实测）

| 编号 | 位置 | 历史值 | 实测值（基线 `3e4ccbd`） | 处置 |
|---|---|---|---|---|
| `DEV-05` | `GDD §0.2` 现状基线 | 战法 51 / 术语 67 / 测试 38 文件 | 177 / 134 / 73 文件 | GDD 追加「附录 D 基线校准」说明历史快照，正文保留以便追溯 |
| `DEV-06` | `GDD §11.6`、附录 B E4 | 「现有 38 → 新增 8」「38+8 全绿」 | 73 个测试文件 | 同上 |
| `DEV-07` | `GDD §11.7`、附录 B E5 | `check-release` 70 项 / 70/70 | 92 项 | 同上 |
| `DEV-08` | `README.md:33/76/127` | 战法 80 条 / 单测 471 条 / 70 个文件 | 运行时 177 / 73 文件（单测条数以 `npm test` 输出为准） | README 为 M3-8 阶段快照；本文 §4.5 给统一口径 |
| `DEV-09` | `ARCH §9.22/§9.23/§9.25` 等 | 431 / 443 / 460 单测、90/92 发布闸 | 随迭代变化，核查时 92/92 | 迭代日志按当时快照保留，不作现值引用 |
| `DEV-10` | `skills.js` 头注释 / P0 文档 | 「注入 48 个新战法」 | 第一版战法表已废弃；现 177 条运行时表 | 注释属历史残留；不改代码以免引入无关变更 |
| `DEV-11` | `offline/docs/FEASIBILITY-v1.md` | README §9 引用该文档 | 文档在**仓库外** `slg/docs/FEASIBILITY-v1.md`，`offline/docs/` 下确实没有 | 已在 `2f07bc0` 修复：README 引用改为 `../../docs/FEASIBILITY-v1.md` 并注明位置；不是文档缺失 |
| `DEV-12` | `README.md:51` 提到 `server/kernel.js` | 文件不存在 | 真实接入是 `server/battle.js:16 → ../kernel/index.js` | 已在 `2f07bc0` 修复：目录树删掉该行，接入点写进 `battle.js` 说明 |

### 17.3 设计规格与实现的口径差异

| 编号 | 差异 | 证据 | 影响 / 处置 |
|---|---|---|---|
| `DEV-13` | **军队士气未实装**（已定性）：`knobs.js` 曾定义 `moraleRout=20` 但零消费，`army.drillMorale` 只有 `delete`；溃败由 `battle.js ROUT_RATIO=0.1` 兵力比判定 | `knobs.js`、`battle.js:27`、`strategy.js` | 已在 `5b551f7` 按产品决策**删除该 knob 占位**（槽位换给 `goldHoardTaxPct`，参数表仍 30 项）；GDD §6.6 标注为保留草案、本版不实装（PRD `OP-02` 已关闭） |
| `DEV-14` | **UI 文案与实现不一致**（已修）：`interaction-ui.js` 曾写「粮尽后每旬士气 −5」，`supply.js` 实际是「民心 −3、治安 −1，第 3 旬起逃散 2%」 | `interaction-ui.js` 失败态·粮道断、`supply.js:7` | 已在 `5b551f7` 按实现校准文案，**不改任何数值**；`tests/op01-economy-and-morale.test.js` 剥注释后静态断言锁死 |
| `DEV-15` | **内政阈值量纲未同步**（已修）：`interior-task.js planTicks` 曾用 `8600/6800`，官员属性自 M4-10 起已是 0~100 | `interior-task.js` 的 `OFFICER_TICKS_TOP/OK`、`general-stat.js` | 已在 `5b551f7` 按产品决策校准为 **85 / 68** 并导出为常量；旧测试用 9000/7000/4000 恰好掩盖了失配，现补 85/84/68/67 边界断言（PRD `OP-03` 已关闭） |
| `DEV-16` | **公式口径偏差**：M4-10 迭代记录写内政 `0.5+stat/200`、适性 `0.85+0.3*v/200`；代码为 `0.5+stat/100`、`armsApt=clamp(0.85+0.3*v/100,1.00,1.15)` | `city-econ.js:282`、`aptitude.js:20-40` | 以代码为当前事实；若要改回记录口径须重跑平衡脚本（PRD R-11.6） |
| `DEV-17` | **国库粮语义**：GDD §11.4 注 1 曾写「`resources.grain` 在 v2 里保留但恒为 0」，实际 `accrueFactionGrain` 会 `grain += g`、`refreshGrainSummary` 写汇总值（只读汇总但**非零**） | `strategy.js:647-728`、GDD §11.4 | 已在 `2f07bc0` 修复：GDD §11.4 注 1 与 JSON 示例按实测改为「城库汇总的只读显示值，非实账、非恒 0」；`WB-06` 只禁止直接赋值，不禁止四个唯一写入口 |
| `DEV-18` | **存档结构**：GDD §11.4 规划 `{saveVersion, undoStack, migrationLog, migrations[v] 注册表, validateSave 安全模式}`；实际是 `version=3 + normalizeWorld` 语义补字段 + 版本白名单 1/2/3，无统一迁移注册表、无 `undoStack` 入档 | `world.js:37,331-431` | 当前靠 `ensureXxx` 兜底；统一迁移链属规划项（PRD FR-04 标 ✅ 但口径以此为准） |
| `DEV-19` | **推演台模块名**：GDD §11.1 规划 `domain/battle-preview.js` / `attribution.js` / `battle-preview-ui.js` / `advice.js` / `faction-special.js`；实际由 `strategy.previewAssault` + `battle-narrative.js` + `interaction.js.agenda` 承担 | `server/domain/` 文件清单 | 能力已落地但文件归属不同；不建空壳模块，追溯以本文为准（PRD `OP-08`） |
| `DEV-20` | `previewNarrative` JSDoc 曾声明 `odds` / `verdictTone`，return 实际是 `tone` / `ratio` 且无 `odds` | `battle-narrative.js:265,319` | 已在 `2f07bc0` 修复：JSDoc 对齐实际返回；**不补 `odds` 胜率定值**——与 PRD R-16.3 / GDD §6.7「情报不足给区间不给定值」冲突，区间由 rows 与 tips 表达 |
| `DEV-21` | **主角战法命名**：`protagonist-skill.json` 名「坐镇中军」，`ARCH §9.22` 记「后世之识」 | 配置 + 架构文档 | 一律以 `cfgId 19001` 引用；命名待产品统一（PRD `OP-04`） |
| `DEV-22` | **`state.seed` 未写入**：`createWorld/normalizeWorld/index.js` 均无赋值，全代码 `?? 20261110` 兜底，仅工具/测试注入 | `world.js`、`strategy-rng.js` 调用点 | 正常游玩随机序列恒定（可复现但缺变化）；如要每局不同须先定存档兼容（PRD `OP-09`） |
| `DEV-23` | `strategy-map.js` 在 `server/` 目录内未发现任何 import | 静态 import 扫描 | 疑为构建期工具专用模块；保留，不删 |
| `DEV-24` | **无鉴权**：HTTP/WS 均无 token/session 校验，CORS `*` | `index.js:415-426,883-915`、`wsserver.js:150-155` | 单机回环威胁模型可接受；开放局域网前必须补鉴权（PRD `OP-07`） |
| `DEV-25` | **设施两张表键空间不同**：`EFFECTIVE_ADDITIONS` 键是加成类型 aType，`GATE_FACILITIES` 键是设施 type | `facility-catalog.js`、§7.15 | 本文已在 §7.15 显式警告；误读会导致「仓库 25 无效果」的错误结论 |
| `DEV-26` | **内核同步无自动化脚本**：TS 源 `battle-core/src/` → `build/src/` → `offline/kernel/` 靠人工拷贝 | `battle-core/package.json`、`pack.js` | **已收口（2026-11-16，P12）**：`offline/tools/kernel-sync.js`（构建+逐字节校验，`--write` 同步、`--json` 供机读），并接入 `check-release` 发行闸（build 缺失/过期给指引，比对逐字节）。当前 20/20 一致 |
| `DEV-27` | **battle-core 双副本**：`slgclient/battle-core/`（当前，engine.ts 25346B）与外层 `slg/battle-core/`（历史副本，12631B）内容 DIFF | 文件比对 | 一律以**仓库根 `slgclient/battle-core/`** 为准；外层副本不维护 |
| `DEV-28` | **原版客户端吞掉操作结果**：`GeneralCommand.onUpSkill/onLvSkill/onDownSkill` 只 `console.log`，`SkillInfoLogic.onClickLearn` 发完即关弹窗 —— 服务端拒绝（学习槽未开/未解锁/名额满）玩家零反馈 | 客户端源码（`web/assets/main/index.js`，只读） | **已修（2026-11-16，`P12`）**：服务端 `notice-bus.js` 回执总线 → `/__slg/session?since=N` → 外壳 `slg:notice` → 交互层 toast；`web/` 不动、协议不动。另补 `not_unlocked` 校验（协议层与六府装配同口径）与装配上限读原表 `ui.limit`（1~6 人，旧代码写死 2）。见 ARCHITECTURE §9.28、`tests/p12-skill-learn-feedback.test.js` |

### 17.4 已知缺口（规划 / 部分实现）

| 编号 | 缺口 | 状态 |
|---|---|---|
| `GAP-01` | `interaction/state.fieldGaps` 3 项：玩家主动结亲/结义、敌方侦察精确值、逐将战前 delta | ✅ **已定性，不是缺口**（2026-11-15 产品裁决，落地 `5b551f7`）：刻意降级的设计特性，撤销「待排期」；`interaction.js` 章节 K 注释逐条写明为何不补，PRD FR-24 已升 ✅ |
| `GAP-02` | 无鼠标完成一次出征的独立键盘 E2E；灰度截图区分粮道状态为人工判据 | 🟡 部分覆盖 |
| `GAP-03` | GDD §11.4 的统一迁移注册表与「安全模式」 | 📐 规划 |
| `GAP-04` | GDD §6.6 军队士气与 `moraleRout` 消费点 | ⛔ **本版不做**（2026-11-15 产品裁决）：删占位 knob、修误导文案，承认按兵力比判定；如将来实现须先恢复参数并登记 FIELD-CONTRACT（见 DEV-13） |
| `GAP-05` | 7 项 `requires_user`（Steamworks 账号费、商店素材、内容分级、第三方换皮、法务版号、代码签名多机实测、SDK 可选） | ⏳ 由用户处理，发布闸单列 |

### 17.5 使用本章的规则

1. 发现新偏差 → 在对应小节追加一行，给证据坐标与默认处置，**不许静默改代码掩盖**。
2. 偏差被修复 → 不删行，把「处置」改为「已在 `<提交号>` 修复，本文 §x 已同步」。
3. 下结论前先做「真链路 vs 旧链路」反向对照（`ARCH §9.20` 教训）：历史上「玩家挂机金恒 0」是手写日循环漏 `applyDays` 造成的假阳性。
4. 本文与 GDD 冲突时：玩法目标听 GDD，当前实现事实听本文；需要改哪一边由产品拍板。

### 17.6 P13 实测反馈修复（2026-11-16 用户实机试玩）

| 编号 | 用户反馈 | 根因 | 处置 |
|---|---|---|---|
| `P13-1` | 「每次招募成功都不是我鼠标选中的武将」 | `general.drawGeneral` 只收 `drawTimes/cityId`，服务端取 `guestsNow().slice(0,1)` 的「此刻在店第一个人」，与点选无关 | ✅ 协议加 `cfgId` 指名参数（§3.3 已同步）；`skills.js` 两处酒馆按钮带 `cfgId`；`tests/p13-recruit-select.test.js` 锁「点谁招谁」 |
| `P13-2` | 「继续招募提示过时、不友好；可以让武将拒绝；每回合第一次几乎 100% 成功」 | 旧实现无掷骰（在店即 100% 入营）；失败文案只有含混的「过时辰」 | ✅ 招募改走 `talentRecruitRate` 同源掷骰（武将可拒绝、失败不扣金、三顾好感 +1/次）；回执细分 `not_today/guest_left/not_arrived/refused` 四种可读原因，toast 全部改友好文案 |
| `P13-3` | 「挥军直进看着像技能」 | `battle-narrative.js` 普攻动作叙述用词花哨 | ✅ 改为 `普攻 → X`，字面即语义 |
| `P13-4` | 「主公技能初始概率改 35%」（P13 当时的口径） | 19001 `probability_init/max = 1` | ✅ 当时按用户指定改 `0.35`、`ui.levels[].probability = 35`；指挥叙述「开战阶段判定（发动率 35%）」。**2026-11-16 用户更正为「指挥 100% 发动 + 回击 35% 起」**，本行已被 `DEV-38`（§17.12）取代，以最新口径为准 |
| `P13-5` | 「城市初始人口太低，提升 3-7 倍并联动平衡」 | map.json 人口 0~10.2 万，且运行时硬上限 10 万 | ✅ map.json 72 城阶梯 ×3~7（大城少提、小城多提，边陲 0 人口显式 3 万）；上限 10 万 → 100 万（`city-econ.js`/`interior-task.js`）；城库上限随人口 `storeCapOf(pop×0.12, 2万~24万)`。**平衡口径**：粮/金产量不随人口变（守 OP-01 已校准的金流），人口只放大兵源与城库——征兵仍受木铁粮金成本闸门约束，不会资源过剩；行军大军的城库瓶颈同步放宽，不会匮乏。NPC 守军公式（`garrisonOf`）基于城池属性而非人口，难度不受影响 |
| `P13-6` | 「检查运行日志，漏洞与报错全部修复」 | `crash.log` 仅 8 条且全部来自 **2026-11-07 旧版应用路径**（`D:\WorkBuddy\slg\offline`，重构前）：①CSP 警告（dev 态才有，打包后消失）②原版 Cocos 客户端 `getComponent/name` 未捕获异常（web/ 资产逐字节冻结，属原版自带时序噪声，非注入层引入） | ✅ 现行 `slgclient` 应用（11-12 运行）零新增报错；`npm test` 全量重跑确认无回归。两条历史噪声登记为已知无害项，不触碰 web/ |

### 17.7 P14 纯单机审计 / AI 智能化 / UX 简化（2026-11-16 用户指示）

| 诉求 | 落地 |
|---|---|
| 「去掉与服务端的交互，做成纯单机客户端」 | 审计确认**本就是纯单机**：所谓 server 是 Electron 内嵌本机进程（`127.0.0.1:8088/8004`），协议层与 `web/` 资产属冻结红线不可拆。全仓扫描零外网端点（web 资产仅 `ws://127.0.0.1:8004` 与文档注释 URL）；`electron/main.cjs` 已有 `will-navigate` 拦截 + `setWindowOpenHandler deny`。断网可玩成立 |
| 「友军 AI 不主动支援」 | 新增驰援系统（`strategy.js` `factionReliefTick`，接入 `settleWorld` 每日结算）：玩家大军在途 → 守城势力（含盟友）从可达邻城发援军（多城合援 ≤2 城、`quoteMarch` 扣粮饷、轻骑速度 130 且保证不晚于来犯军抵城、每支来犯军每势力至多援一次）；到达即并兵入守（真实抬高 `defenseFor` 守军折算），城易主则扑空折返七成。人格轴 `defense<0.25`（吕布）见死不救 |
| 「AI 内政笨」 | `pushRecruit` 威胁感知：兵压境按敌我兵力比上浮征兵（≤1.8×），刚失城 1.25×；安稳期按 economy 人格基线 |
| 「全程没有挑战性」 | ①制衡：`balanceOfPower`（玩家城数 ≥3 或占比 ≥25% 入选；占比 ≥40% 连稳健派也出手）+ `playerOption`（need 减压 0.85/0.7 + `sendMul 1.35` 倾巢而出）；`attackPlan` 对玩家目标**同门槛复查**（修 chooseGoal 选中却发不出兵的集成缺口）；②`alliancePlan` 玩家势大时优先结盟制衡玩家 |
| 「优化操作体验」 | ①「推演三月」按钮（连推三旬，遇待决自动停）；②「自动推旬 ▶」挂机开关（2.4s/旬；`pendingEvents>0` 或前锋抵城 `pendingBattle` 自动暂停并 toast）。`marches` 视图补 `pendingBattle` 字段。回归：`tests/p14-ai-smarts.test.js` 6 用例 |
| 灭国闭环回归（发行闸 7.9d） | 制衡首版会让讨伐玩家的出征无限重选（玩家城在战略层永不易主、fails 不记账）→ 加 `mem.lastPlayerAtk` **6 旬冷却**（`strategyTick` commit 时记账）；另 `system-audit.mjs` 灭国 runner 的「目标守军=1」GM 构造改为**每旬维持**（AI 威胁感知征兵起守军会被残方逐旬补回，固定 1500 兵的 runner 永远打不穿）。灭国 T63 达成、灭后 10 旬正常、零异常零不变量、确定性通过。`SLG_AUDIT_DEBUG=1` 可采样征服者目标/残城/同盟定位灭国停滞 |

### 17.8 P16 诸侯 AI 人事层 / 测试覆盖补强（2026-11-16 用户指示）

**核对结论（先登记事实，不动手前先说清）**：审计 `strategy-brain.js` `compile()` 只产出征兵/屯田/出征/固守/结盟五类指令（`strategy.js:901` 其余忽略）；诸侯守将由 `defenseFor` 按城池 hash **临时生成**（`id=950000+cityId*10+k`、`exp:0`、战法按 `level*7+k*11` 取模），**无持久实体**。故「AI 学战法 / 武将升级 / 招募武将 / 俘虏 / 挖墙脚 / 求援」在审计前**均未实现**（玩家侧六项全有）。测试侧：80 战法仅 6 个跑过真实战斗、稳定性最长 73 旬脚本模拟（单测仅 8 旬）、平衡性只查数值合法性无对战胜率。

| 编号 | 诉求 | 落地方案（本轮） |
|---|---|---|
| `P16-1` | 诸侯武将持久名册 | 新增 `domain/ai-roster.js`：`state.strategy.rosters[fid] = { generals:[{cfgId,level,exp,skills,cityId,loyal}], captives:[] }`，开局按 `startGenerals` + 确定性池播种；`defenseFor` 优先取名册武将（保留 hash 兜底与确定性和 cfgId 白名单） |
| `P16-2` | AI 学战法 / 升级 | 每旬 `aiRosterTick` 按人格 economy/tempo 给 ≥5 级武将学战法（花势力金、复用 `skillById` 白名单）、战斗胜利给参战名册武将发经验（`applyGeneralExp` 同源，≤10 级） |
| `P16-3` | AI 自动招募 | `aiRecruitTick` 用 `tavern.people` 未出仕池按势力魅力/金确定性登庸入名册（玩家与 AI 共用同一在野池，`recruited` 标记防重复） |
| `P16-4` | AI 俘虏流程 | AI 攻占城池时按歼敌比确定性俘守城名册武将，入势力 `captives`；每旬按政治判定招降（入名册）/ 满 N 旬释放，全程记天下日志 |
| `P16-5` | AI 挖墙脚 | `aiPoachTick`：政治/魅力高的势力对**他势力或玩家**低忠诚（<阈值）武将发起挖角，掷骰成功则忠诚下降 / 转籍，记日志；玩家武将用现有 `loyal` 字段，AI 用名册 `loyal` |
| `P16-6` | AI 打不过求援 | 区分于被动驰援：新增**主动求援**——势力城池 ≤2 且兵力 <阈值时，向盟友/亲近势力发 `求援` 记录，`factionReliefTick` 之外由 `aiAidTick` 从盟友富余城派援军（复用 `dispatchRelief` 同款 march），弱方人格 defense 高才肯求、盟友 economy 高才肯救 |
| `P16-7` | 测试覆盖补强 | ①`all-skills-live.test.js`：80 战法逐个 `runBattle` 实跑 + 效果事件断言；②`ai-career-balance.test.js`：名册成长/招降/挖角/求援行为断言 + 中规模对战强度分布；③长时稳定性：system-audit 报告新增 100+ 旬标注 |

**落地结果（本轮完成）**：`domain/ai-roster.js` 已建（名册播种/守将顶替/学战法/升级/登庸/俘虏/挖角/求援，全部 `rngFor(seed,turn,tag)` 确定性）；`strategy.js` 在 `ensureStrategy` 播种、`strategyTick` 每旬每势力跑名册人事、`applyOrders` 攻城胜利发经验+俘将、`defenseFor` level≥2 城用名册真武将（**1 级城保留 hash 守将**——张飞/夏侯惇这类开国名将顶替 3 级弱将会破坏 P0-3「首战可胜」，实测复跑确认）。新增 `tests/p16-ai-officers.test.js`（9 例）、`tests/all-skills-live.test.js`（177 战法逐个真战斗，此前仅 6 个）、`tests/ai-career-balance.test.js`（对战强度分布 + 120 旬名册有界/确定性）；全量 525/525、system-audit 灭国 T63+10 旬零异常确定性通过。

**纪律**：新增名册只在 `state.strategy` 内、旧档缺字段走 ensure 兜底（存档兼容）；人格轴决定行为强度但**不改五维数值、不破 0~100 量纲**；求援/挖角均有确定性种子与冷却（可回放、不无限循环）；改完必须重打包双态取证 + check-release 全绿。

### 17.9 读档备份与俘虏处置后果（2026-11-16 用户问答核查）

**核查缘起**：用户问「如何主动存档、如何读取历史存档、武将招降机制是否完整」。代码级核查发现两处「文案/需求承诺与实现不符」，本轮修复并登记。

| 编号 | 问题 | 根因 | 修复 |
|---|---|---|---|
| `DEV-29` | 读档确认框写「旧档会自动备份」，实际直接覆盖当前档 | `index.js /save/slot load` 分支旧实现 `state=normalizeWorld(data,cfg); flush()`；`flush()` 写 `savePath`，当前档被就地覆盖；只有 `/save/import` 分支做了 `renameSync` 备份 | 先 `const next=normalizeWorld(data,cfg)` 成功后再 `renameSync(savePath, savePath+'.before-load-<ts>.json')`，再 `state=next; flush()`；1 号档即 `savePath` 自身时跳过备份。归一化失败时当前档原封不动。`tests/save-slots.test.js` 新增备份内容断言 |
| `DEV-30` | 处斩记 `role.infamy+1` 但外交、来投、结局全不读；放归完全没有后果，与 PRD R-21.5 / GDD §7.3 承诺不符 | 两字段都是「只写不读」的死字段，且无单一权威口径 | 新增零依赖叶子 `captive-reputation.js` 统一常量；放归 `st.fame+=2` / 处斩 `st.fame-=2, infamy+=1`；名望进入 `defectTick` 来投率（封顶 40 点防刷）；处置态度经 `diplomacy.js adjustAttitudeByEvent` 落 `eventAdj`——放归 −5、处斩 −15 且董卓 `sili` 豁免（GDD §7.3 / §5.9 原文）。数值取事件系统既有 `fame:+1~+4` 中位，不自创 |

**接线边界（诚实登记）**：

- 战报 `b_d_general` 只有 `[cfgId, ...]`，不带原属势力；态度后果按「对所有 NPC 势力」统一落账，**不定向到单一势力**。若要定向，需先扩展战报字段——未做，登记为已知简化。
- `captives.js` 保持零依赖叶子（只依赖 `strategy-rng.js` 与新叶子 `captive-reputation.js`）；态度落账的 `diplomacyApi` 由 `index.js` 组装层注入，领域层不反向 import `diplomacy.js`，不成环。
- 名望 `FAME_DEFECT_CAP=40` 是防刷闸：反复放归也只贡献 `40/700≈5.7%` 来投率，剩余仍靠城数/武将/魅力，不可线性刷满。
- **存档入口可发现性仍不足**：存/读档卡只在「本城→府库」页，无全局按钮、无快捷键——本次只修备份数据安全，未改入口（属 UX 决策，不擅动）。

**验证**：`npm test` **527/527**（新增 2 条：读档备份内容、处置四源同源）；`save-slots`、`m4-13`、`m2-diploma`、`p7-city-depth` 交叉 39/39；全量后重打包双态取证见发布闸。

### 17.10 俘虏按钮呈现与来源提示清理（2026-11-16 用户实机反馈）

**核查缘起**：用户反馈「俘虏处置按钮上的字体看不清，按钮和整体操作界面不协调」以及「界面上有很多区域显示机制借鉴某款游戏或某个地址，产品不应提示玩家功能来源」。

| 编号 | 问题 | 根因 | 修复 |
|---|---|---|---|
| `DEV-31` | 六府武将页「放归／处斩」按钮外观与整体界面不协调、文字难辨 | `panels-ui.js` 只用 `class="ghost"`，但六府窗口 `#slgPanelsWin` 的样式表没有 `.ghost` 定义；同名样式只存在于另一作用域 `#slgUIv2 .btn.ghost`，实际落回浏览器默认按钮外观。俘虏行小字沿用低对比度 `#8f8676` | 新增 `#slgPanelsWin .capbtn`（13px `Microsoft YaHei` / 前景 `#e8d7a8` / 底色 `#2c2f22` / 描边 `#7a6a42`），处斩用 `.danger` 危险色 `#f0b39b`；俘虏行改为 `.card.caprow` 并把小字提亮到 `#b3a88f`；标题回归六府统一 `#cbb477` |
| `DEV-32` | 术语提示、百科、决策预览、军师建言、战法图鉴等处出现外部游戏名、外部名录、内部规格编号与工程溯源字段 | 玩家可见文案直接复用了工程元数据：`terms.json` 的 `证据级别` 写「借鉴三国志11/14」「设计规格 6.4」「借鉴 CK3」，`简述` 写「三国志14 官方口径」；`interaction-ui.js` 把 `数值来源`／`source_id`／`confidence` 整块渲染；`panels-ui.js` 写「逐字取自 battle-kit 原文」 | 界面层停止渲染溯源字段；术语可见字段改为本作措辞（35 条证据级别、6 条简述），工程溯源字段保留以满足 `check-terms.js`／`check-compliance.js`；面板与交互层文案去掉游戏名、规格编号与源码路径；注入层源码注释中的来源标注一并移除 |

**边界（诚实登记）**：

- `conf/interaction/terms.json` 的 `数值来源`／`source_id`／`confidence`、`conf/compliance/provenance.json`、`innate-skills.json` 的 `license` 等**工程合规元数据保留不改**，只是不再进入玩家界面；否则 554 条溯源零缺口的合规闸会破。
- `conf/campaign/events*.json`、`heroes-240.json` 中「三国志·某某传／演义·第几回」是**游戏内史实 citations**，属于剧情内容而非借鉴来源提示，不在本次清理范围。
- 本轮只改运行时注入脚本与术语文案，磁盘 `offline/web/` 1582 文件未动，协议层与 `handlers.js` 未动。

**验证**：`tests/ui-presentation-hygiene.test.js` 3 条（按钮样式与类名、注入层来源词零命中、术语可见字段零命中且溯源字段完整）；`check-terms` 134 条覆盖 100%，`check-compliance` 554 条零缺口。

### 17.11 源码注释中的来源标注清理（2026-11-16 用户补充要求）

| 编号 | 现象 | 根因 | 处置与现状 |
|---|---|---|---|
| `DEV-33` | 上一轮只清了玩家可见文案，源码注释与开发者字符串仍大量写「三国志11/14」「率土之滨口径」「battle-kit 原文」「GDD §x.y」「设计规格 6.2」「章节 K」 | 当时按「工程内部注释可保留」处理，但产品方要求代码里也不出现借鉴来源 | 清理 `server/`、`tools/`、`tests/`、`electron/` 共 77 个文件的 281 行注释与文案，统一改为本作措辞或删去章节号；批量替换后逐项修正 `/14 口径`、`经典避险操作（）`、`本作设计-§8.3` 等断句 |

**保留白名单（不是来源提示，不得删除，否则破坏合规与协议）**：

- 构建脚本的真实路径与合规字段：`battle-kit/skill-library`、`battle-kit/data`、`source`、`descSource`、`nameSource`、`LICENSE`；
- 运行时协议字段值 `skillSystem: 'battle-kit/original-fragments/v3'` 及其测试断言；
- 校验脚本的台账字段名 `数值来源`／`source_id`／`confidence`／`证据级别`／`可信度`——只禁止渲染到界面，代码与数据必须保留；
- 事件剧情里的史书引用（`三国志·武帝纪`、`后汉书`、`三国演义` 回目）与本地地址 `http://127.0.0.1`。

`conf/campaign/innate-skill-audit.json` 等 1214 行 conf 命中属于合规审计台账，未改动。`tools/build-innate-skills.mjs` 的 `note` 会写入审计表，已从批量替换中恢复并逐行精修，避免污染数据。

**回归锁**：`tests/ui-presentation-hygiene.test.js` 第四用例扫描 `server/`/`tools/`/`tests/`/`electron/` 全部 `.js/.cjs/.mjs`，按白名单过滤后断言零来源词；借鉴对象与内部规格编号在界面和源码两侧同时受控。

### 17.12 玩家体验五项修复（2026-11-16 用户实机反馈）

| 编号 | 现象 | 根因 | 处置与现状 |
|---|---|---|---|
| `DEV-34` | 给主公学第二战法（学习槽）时鼠标点击没反应 | 注入武将战法页 `renderGensInto` 的空学习/觉醒槽只是一段文字，没有可点控件；原版客户端响应只 console.log | 空槽补可点按钮：锁槽点「为何不能学？」直接给条件提示，开槽点「去学习/装配战法」给引导；协议层拒绝回执（P12 notice-bus）保留。主公 Lv1 点学习→`slot_locked`+「5 级」提示，Lv5 后可真实学到第二战法 |
| `DEV-35` | 酒馆招募提示「何时到店」、列出未到店武将；拒绝理由像读游戏数值 | UI 渲染 `today` 全三态（含 upcoming/passed）与 `when`/成功率；拒绝是固定「婉拒了延揽（成功率 X%）」，无人物性格 | 酒馆只列 `guestsNow` 此刻在座者，去掉时辰/到店/「今日可见」提示；新增零依赖叶子 `recruit-refusal.js`，按 `type`（莽夫/名将/名士/谋士/诸侯）+ 五维分五种口吻，谋略 ≥78 用更圆融版本、三顾多次换软话；响应带 `line`/`persona`，界面不再显示概率。工程字段 `rate/parts` 保留供审计 |
| `DEV-36` | 玩家越打越强，诸侯兵力/武将停滞；AI 武将不封官 | AI 经验只在攻城胜利发；`state.panelMerits.merits` 是死字段、无累积；名册无功勋/官阶；官职只影响城池开发度不影响能力；征兵无追赶系数 | 新增零依赖叶子 `official-rank.js`：功勋只增、官阶 0~9 由功勋唯一决定。玩家战斗立功（`grantBattleExp` win 加一笔）与 AI 每旬治政（`aiRosterCultivateTick`）+ 攻城（+功勋）同源晋官；官阶经 `general-stat.effectiveStatOf` 反哺统帅（每阶 +2）、谋臣/政治家政治（每阶 +3），封顶 100。`strategy-brain.pushRecruit` 加 `catchUp`（玩家城/兵远超时征兵上浮，封顶 2×，仍受城库粮硬闸）。面板「经历」显示官阶/功勋进度 |
| `DEV-37` | 所有武将初始化没有政治属性；GM 编辑器/面板无政治维度 | `config.loadConfig` 只归一化 5 个战斗维度，`five.zheng` 仅用于算 cost，未写入 `politics` | 政治作为第六维：原表武将从谋略确定性派生，`heroes-240` 交集与新增武将取史载 `five.zheng`，主公 93；全表 505 人 0~100 无缺失。`world.makeGeneral` 补 `politics_added`，面板 `STAT_LABEL`/装备加成 `EQUIP_KEYS`/GM 编辑器同步；取数仍走 `gameStatOf(cfg,g,'politics')` |
| `DEV-38` | 主公属性偏弱；玩家可见「防御」标签；坐镇中军实为「35% 发动 + 30% 回击」双随机，与「指挥必发动 + 35% 回击/级 +5%」设计不符 | 主公六维沿用旧设定；`ui.levels[].probability=35` 驱动内核 `rollTrigger` 二次掷骰；`kernel.probability_init/max=0.35` | 主公六维改为武力 99/谋略 96/统帅 91/速度 87/政治 93（内部键 `defense` 不变，玩家标签统一改「统帅」）；`probability_init=max=1`、`ui.levels[].probability=100`（指挥战法开战必发动），受击回击概率 `effect_value[1]=35+5×(lv−1)`（Lv1=35%/Lv10=80%），内核 `counter.chance` 同源。数值登记先改 FIELD-CONTRACT，测试 `m4-protagonist-skill` 同步迁移 |

| `DEV-39` | 官阶只抬高统帅值，单支部队带兵上限仍写死 5000，「官高统兵多」在兵力上无感 | `SLOT_CAP=5000` 硬上限；`strategyFormup` 与出征裁剪 `army.soldiers` 均按常量截断 | `official-rank.js` 加零依赖纯函数 `slotCapForRank/slotCapOf`：每槽上限 = 5000 + 官阶×300（0 阶 5000 → 9 阶 7700，越界钳制，按累计功勋唯一决定）；编队与出征裁剪改按该槽武将官阶取上限，空槽回退 5000；`over_cap` 回执带该槽真实 `cap/caps`；`panels.js allGenerals` 带出 `rank/slotCap`，编队弹窗逐槽显示上限与官阶。白身武将行为完全不变（`SLOT_CAP` 常量保留为契约基准） |

**回归锁**：`tests/ui-player-experience.test.js`（15 条）锁政治覆盖/官阶闭环/AI 成长/拟人拒绝/学习反馈/带兵上限（含真链路出征截断对照：白身 7600→退 2600、三公 7600→退 0）；`tests/loop-balance.test.js` 锁白身 5000 基准与官阶浮动上限；`tests/m4-protagonist-skill.test.js` 锁 100% 发动与 35%→80% 回击；`tests/p10-interior-task.test.js` 测试夹具把主公谋略钳回中值（96 跨过 85 阈值会让 2 旬工期塌成 1 旬，测的是任务状机制非主公数值）；`tests/ui-presentation-hygiene.test.js` 锁文案不泄来源。全量 `npm test` 546/546。

### 17.13 调防 / 招募文案 / 战法平衡 / 城防攻城（2026-11-17 用户四项反馈）

| 编号 | 现象 | 根因 | 处置与现状 |
|---|---|---|---|
| `DEV-40` | 新招募的武将全是「闲置」，无法派到其他城 | `g.cityId`（武将所在城）与 `army.cityId`（队伍驻地）是两份真相：招募写死 `mainCity(state)`（恒 =1 = 长安），出征/撤退/到达结算只搬 `army`，从不回写队内武将的 `cityId`；也没有「调防」这条动作 | 新增 `strategy.js dispatchGeneral()`（唯一调城口，校验 `no_general/no_city/same_city/not_own_city/marching`），HTTP `POST /__slg/strategy/action {action:'dispatchGeneral'}` 接入；`syncGeneralsCity()` 在出征/到达结算/临阵撤军/撤回四处随 `army.cityId` 同步队内武将；招募落城改为「招募所在城」；`panels.js` 武将视图与 `allGenerals` 带 `cityId/cityName`，`panels-ui.js` 加「所在城 + 目标城下拉 + 调防」 |
| `DEV-41` | 酒馆招募失败仍提示「已离开酒馆」这类机械文案，探索已改招募没改 | `domain/recruit-refusal.js` 只覆盖「拒绝」一类场面话；`drawGeneral` 的 `guest_left/not_arrived/absent/not_enough_gold/no_guest` 五个分支仍回英文 `reason`，界面把 `reason` 直接拼进 toast | 新增 `failLine(kind, opt)` 五类场面台词（离席/未到/不在本城/座上无人/盘缠不够），`drawGeneral` 四类分支补 `name/line/short`；两处酒馆 toast 优先消费 `m2.line`，不再暴露英文 reason；`p13-recruit-select` 静态闸改为锁「必须消费 line、不得出现旧文案」 |
| `DEV-42` | 所有战法发动率清一色 70%，输出相差悬殊 | `conf/*skills*.json` 的 177 条战法概率是分批手写的历史残留（27 条都是 35→70）；伤害率与发动率无关联，期望输出指数实测 18~4050（200 倍）；控制槽还有 200% 命中率 | 新增 `tools/skill-balance.mjs`（唯一平衡口径，幂等，保留原文件排版）：指挥/被动恒 100%，主动/追击按「伤害率越高、发动率越低」反推 Lv10 32~50 / Lv1 30~45，控制槽 ≤100% 且保持 Lv10=Lv1×2；输出指数收敛到 25~1997（主动/追击 300~2000）。新增 `tests/skill-balance.test.js` 6 条闸，**重新生成战法表后不重跑该工具就会红** |
| `DEV-43` | 武将「攻城」属性没有任何用处；城防在攻占中没有实际意义 | 城墙只有一处 `wall = knob(siegeWallMul)` 恒 1.5，全服每城同值，与城防属性、与玩家 `destroy` 都无关；`st.cities[].defense` 只被 AI 战力估算和面板读取 | 新增零依赖叶子 `domain/city-wall.js`：`wallMax = 300 + 等级×450 + 城防×6`、`wallDefMul = 1+(倍率−1)×完好比例`；`battle.js siegeDamageOf()` 把「攻城值 × 投入兵力」换成破墙伤害，`resolveBattle` 逐场读写 `wallHp`、破城当阵守军再折 12%；`strategy.js` 新增 `cityWall/applySiegeResult/repairCityWalls`（每旬 2%，被围不修）；战报/推演/城池页/城池窗四处显示城墙耐久与「本波攻城打掉 N」。**`judgeBattle` 的占城语义不动**（否则「首战可胜」契约整体作废） |
| `DEV-44` | 招募成功或失败都没有日志 | `drawGeneral` 的成功分支只有 `noticeRecruit`（即时通知卡），失败分支只有当帧 toast/回执，都不进 `state.strategy.events`——招募历史无处可查（探索登庸早有 `recordEvent` 先例） | `drawGeneral` 八类分支全部补 `recordEvent`（成功记花费与落籍城、婉拒记好感、离席/未到/不在本城/金不足/座上无人/连抽逐人）；文案与探索同口径（拟人、无英文 reason）。`p18-base-editor.test.js` 真链路 + 源码闸双锁 |
| `DEV-45` | 武将/战法没有新增与编辑功能；要的不是存档编辑而是初始编辑 | M4-11 编辑器只能改既有武将属性（且战法槽同步进当前存档）；战法完全没有编辑入口——玩家想自己创建/修改基础数据无处下手 | 新增「初始数据编辑器」（interaction 设置旁入口改名）：**武将页签**新增 `editorCreate`（cfgId 890001+，写 `overrides.json` generals 段 `__custom__`，`loadConfig` 注入 generalByCfg → 酒馆客池/新开局自动可见，**不写当前存档**）与 `editorDeleteCustom`（只删自建）；**战法页签**新增 `domain/skill-editor.js`（cfgId 29001+，唯一写入口 `conf/campaign/custom-skills.json`，skills.js 五表之后合并、保存即 `upsertRuntimeSkill` 三路同源；重置=删覆盖层并还原原表）。编辑器侧校验与 skill-balance 平衡闸同口径（指挥/被动恒 100%、主动/追击 32~50、输出指数 300~2000、控制 Lv10=Lv1×2≤100），越界保存即拒并给可读原因 |

**边界（诚实登记）**：

- 破城**不改变占城判定**：`result === 2` 仍直接占城。这是刻意取舍——把占城改成必须破城，会让 `loop-balance`／`p7`／`p8` 等既有验收的「未决不占城」「首战可胜」全部作废，收益不抵风险。城防的实际作用落在「守军据城加成 1.5→1.0」与「下一波更好打」。
- `wallHp` 是新增存档字段，旧档缺失时**一律按完整城墙**处理（与升级前逐位相同），不写迁移脚本。
- `conf/library-skills.json` 由 `tools/build-library-skills.js` 从 battle-kit 原文生成，**重新生成会冲掉平衡后的概率**——所以把闸做在测试里（`skill-balance.test.js`），而不是靠口头约定。
- 本轮未改 `offline/web/` 磁盘产物（1582 文件逐字节不动），未改协议消息计数（`contract-matrix` 72 条不受影响：`dispatchGeneral` 走 HTTP 动作口）。

### 17.14 编辑器 bug / 技能结算核查 / 平衡 / 向导 / 石头闭环 / 招募文案（2026-11-18 用户六项反馈）

| 编号 | 用户反馈 | 根因 | 修复 |
|---|---|---|---|
| `DEV-46` | 「检查编辑器是否有 bug，是否每个技能释放时都能正常结算伤害」 | ① 新建战法重名按 `name` 命中 `upsertRuntimeSkill` → 整条覆盖原表战法（10001 凭空消失）；② 编辑已有战法走 `buildCustomSkill` **从零重建**，丢掉多效果槽/`prepare`/`mechanics`/`bonus_terms`；③ `skillList` 只认伤害槽 → 控制战法显示 `0→0`，表单预填 0 被服务端 clamp 成 1%，命中率被清空；④ `editorSave` 无条件 `syncStateSkill` 把自带战法 `lv` 清零；⑤ UI 输出指数用 Lv1、服务端用 Lv10 口径不一；⑥ 重置未重套 `applyRangeNote` 丢有效距离 | 编辑器**入口加同名拦截**（新建重名拒绝）；新增 `patchExistingSkill()`：编辑走增量 patch —— 以运行时原条目深拷贝为基底，只覆盖 name/概率序列/主效果槽数值与控制状态，其余效果槽/准备回合/机制/溯源/`trigger/dir/detail_id` 逐字保留；`skillList` 控制槽取真实命中率并回传 `controlState`；`upsertRuntimeSkill` 与装载覆盖层改为**只按 cfgId 命中**（纵深防重名）；`syncStateSkill` 保留原 `lv`，且仅当编辑确实涉及 `skillCfgId` 时才动存档槽；UI 指数改用 Lv10、`controlState` 回填实际值、复选框状态保留、切页签清搜索；`resetSkill` 按 cfgId 精确还原并重套 `applyRangeNote`。新增 9 条回归 + 1 条端到端（自建战法真战斗产生 damage 事件，非 `rate_pct` 空结算） |
| `DEV-47` | 「现在游戏平衡性很差，需要持续优化→检查→优化」 | 核查确认技能侧已平衡（177 条、70% 清零、主动/追击 32~50/指挥被动 100%、输出指数闸 300~1843、`all-skills-live` 全战法真战斗通过）；伤害率"二次放大"（Lv10 技能×Lv10 武将 = ×2）是**全局统一**机制，所有技能一视同仁、不改（改则推翻 177 条平衡）；真正问题是 `troop_factor` 三处漂移（默认 0.2 / 实际 0.45 / 注释 1.25）与 `difficultyAi` 旋钮只有定义无消费点 | `battleConfig().troop_factor` 统一为**唯一真源 0.45**，`resolveBattle` 不再覆盖（数值未变，消除"改配置不生效"隐患）；`difficultyAi` 接入 AI 征兵量缩放（默认 1.0 = 原样，1.4 → AI 多征 40%），配 P16-10 测试。诚实边界：`attackerOddsMul` 兵力比斜率 11.2、`difficultyDiplo` 无量化点，本轮未改（见下） |
| `DEV-48` | 「游戏需要提供一个向导，否则第一次接触都玩不下去」 | 旧 `interaction-ui.js` 已有 6 关教学，但 `done` 情境标记全部未接线，实际是"加载即弹、点 6 次确认"；g3 残留"成功率 +12%"过期口径（当前招募不显示概率）；进度存 localStorage 不随存档 | 向导重做为 **7 关**（新增举义开场），每关「看说明 → **去操作**（jumpTo 直跳对应面板）→ **我已完成**」闭环；`done` 标记落到 `S.guideDone` 并持久化；保留跳过/稍后/按 h 重看；修正 g3/g6 文案与过期概率口径。`GUIDE`/`buildGuide` 静态闸锁闭环 |
| `DEV-49` | 「游戏中的石头、城池设施都没闭环」 | 石头有采石场/领地石矿产出与设施/城防投资消耗，但：① 玩家城修墙**凭空 +2%** 不花石头（最直觉用途缺位）；② 原表 `cost_stone=0`，征兵完全不用石头；③ 逐城层零产石（特产表无石、`cityYield` 只出粮金），`cityLayer().stone` 恒 0 | ① `repairCityWalls` 玩家城修墙按 `WALL.stonePerHp=3` 石/点扣 `roleRes.stone`、不足按比例少修不透支、走 `recordRes` 流水，NPC 城仍自然修复（不花玩家石头）；② 派生征兵石耗 `max(5, ⌊铁/兵÷2⌋)`（不改原表）；③ `cityYield().extra.stone = 12 + 等级×8 + 城防开发度/50×16`，汇入 `cityLayer().stone` → `playerStockYield`，形成"投石→城防开发→石产↑→修墙"闭环。p17/playtest-fixes 补 4 条测试 |
| `DEV-50` | 「招募失败提示词不符合要求，拒绝理由非常不和谐」 | `recruit-refusal.js` 莽夫句含"拿刀说话/别费话/少绕弯子"、诸侯句"休要再提/阵前一见高下"、名士三顾"若再相逼…不识抬举"（语义矛盾），带威胁/贬低；探索兜底 `'探索失败：'+reason || '未知'` 优先级错误且直弹英文 reason | 改写莽夫/诸侯/名士三顾与 poor 场面话为"给台阶、留余地、不威胁"的汉末口吻；探索金不足/无人/兜底分支补拟人 `line`，兜底修 `||` 优先级 bug、不暴露英文 reason；婉拒事件日志去掉"（好感 N）"系统播报。ui-player-experience 加"全人设不和谐词"扫描闸 |

**边界（诚实登记）**：

- **技能二次放大不改**：Lv10 技能在 Lv10 武将手上实际伤害率 = 面板 ×2（`kernelSkillAt` 按技能等级注入 → `rules.js levelValue` 再按武将等级放大）。这是所有 177 条技能统一的既有机制，`skill-balance` 与平衡闸都建立在"名义指数"上，单独改一条或整体改都会推翻现有平衡与战报哈希，故本轮只核查确认、不做数值改动。
- **集市兑换率 / 民居税收语义**：排查确认集市升级加成（addition16）未被 `interior.transform` 读取（当前 1:1）、民居 `type21=税收` 被当金币日产。改兑换率会凭空增产破坏经济平衡、且 `building.test.js` 锁 1:1；民居改口径牵动征收链路。两项为**设计取舍，本轮不改**，在此留痕待产品裁决。
- **`attackerOddsMul` 斜率 11.2 / `difficultyDiplo`**：兵力比 1.15 倍以上伤害陡增是"人多碾压"的敏感点，但调整会改变大量战斗结果、影响回合数验收；`difficultyDiplo` 无明确量化点。两项本轮未改（旋钮定义保留）。
- 本轮未改 `offline/web/` 磁盘产物，未改协议消息计数（`contract-matrix` 72 条不受影响：全部改动走既有 HTTP 端点与领域层）。（★ 注：该口径为 §17.11 当时状态；§17.12 新增 3 条 WS 协议后计数变为 75 条。）

---

### 17.12 BUG审计修复 / 征兵队伍改造 / 主公身份归一（2026-11-18 用户指示）

**缘起**：用户要求「修复所有漏洞和bug」+ 三条玩法改造（解甲归田/兵种差异化/主公身份矛盾）。先做五路只读审计 + 动态复现（报告见仓库外 `D:\WorkBuddy\slg\slgclient-全量BUG与漏洞审计报告.md`），再逐条修复。用户裁决：两处战法数值 P1（被动 buff 叠加、减伤词条误入 bonus_terms）**本轮不修**（守住 177 战法平衡闸与战报哈希）；集市**只禁净增产**（不碰 transform_rate 比例）；主公身份走**显示层归一 + 外交去重**；**新增自建势力**（局内达条件解锁 + 输入国号）。

| 编号 | 问题 | 修复 |
|---|---|---|
| `BUG-P1-1` | 剧本开局未举义即误判「败亡」：`evaluateEnding` 读从未写入的 `st.oathPending` | 改调 `oathPending(state)` 函数（`oath.js` 零环叶子） |
| `BUG-P1-2/3` | 事件 `resource('grain')` 恒 0（误取 `st.resources['player']`，无该键）；`min_loyalty/prisoners/besieged_cities/supply_cut_armies` 无数据源 | grain 取 `roleRes.grain`；四字段接真实域（名册忠诚最小值/俘虏数/被围城/断粮在途军） |
| `BUG-P1-4` | `addMorale` 漏 owner 过滤，改全地图城民心 | 加 `owner==='player'` 过滤 |
| `BUG-P1-5` | 月份口径漏网：`interaction.js`/`panels.js` 仍 `turn%12+1`/`turnOf+1` | 统一 `Math.max(1,turn)`（契约 §A 已登记权威口径） |
| `BUG-P1-6` | 集市 `interior.transform` 可凭空复制资源 | 禁净增产：`to总量≤from总量`、from/to 不同索引、均为正；不碰比例口径（UI 发 to=from×rate/100 仍通过） |
| `P17-1` | 玩家协议层无解甲归田；剔除武将后空槽残留幽灵兵力 | 新增 `army.disarm`（三槽遣散退驻城+返 30% 兵值金，领域 `conscript.planDisarm`）；`army.dispose` 摘将/清空槽位时该槽兵力退回驻城并清零 |
| `P17-2` | 征兵无法选兵种、消耗无差异、一键征满全塞单槽、带兵上限只看官阶 | 新增 `domain/conscript.js`：兵种差异化单价（骑最贵）、`checkSlotCaps` 征兵也校验上限、`splitEven` 一键平分（服务端算，UI 只发总量）、`world.meta` 下发三兵种单价+石耗；带兵上限扩为 `5000+官阶×300+(等级−1)×200`（`official-rank.slotCapOf`，契约已登记） |
| `P18-1` | 举义曹操后玩家扛曹旗/用曹将，却仍可单独与曹操外交 | 新增 `domain/faction-identity.js` 唯一权威：显示名归一（举义=所举势力名、旧档=我军）、`diplomacyView` 过滤所举义势力、`diplomacyAct` 拒绝 `self_faction`；底层 `owner='player'` 不动 |
| `P18-2` | 无自建势力（用户裁决要求新增） | `nation.foundStatus`/`nation.found` 协议 + `foundNation` 领域：占城≥6 解锁、输入国号（1~12 字）、落盘 `state.founded`；建国后显示国号、原举义势力重回外交列表（已脱离） |

**纪律与取舍**：
- 玩家可见数值（带兵上限公式、兵种单价、集市约束）**先改 FIELD-CONTRACT 再改服务端最后接 UI**；UI 全部运行时注入（`server/skills.js` / `strategy.js` 视图），`web/` 磁盘逐字不动。
- 新增领域模块 `conscript.js` / `faction-identity.js` 均为零环叶子（后者仅依赖 `oath.js`），handlers 只做参数校验+写回（变薄）。
- 存档兼容：`state.founded` 旧档缺失走可选链兜底（`playerIdentity` 三态自动降为举义/我军），无需迁移。
- 契约矩阵 case 数 72→75（新增 `army.disarm`/`nation.foundStatus`/`nation.found`）；两处战法数值 P1 本轮明确不修，留待单独产品裁决。
- 新增测试 `p17-conscript-reforms.test.js`（11 例）、`p18-faction-identity.test.js`（6 例）；改完必须重打包双态取证 + check-release 全绿。

---

### 17.16 核算口径本地化 / 武将人物卡大图（2026-11-19 用户反馈）

| 编号 | 用户反馈 | 根因 / 现状 | 本轮处理 |
|---|---|---|---|
| `DEV-51` | 「所有核算都暂时做成本地核算，纯单机，不做服务端」 | 本作 Node 进程本就跑在本机（离线单机），但玩家可见层残留 8 处"服务端"字样：征兵卡"服务端核算：本旬可征 X 丁"、"服务端无响应"×5、交互层"服务端数据/服务端拒绝/已提交服务端/检查服务端/服务端未提供"、domain 下发 `disasterBasis` 的"服务端未逐城下发依据" | **只改玩家可见字符串、不动任何结算逻辑**：统一改为"本地核算/本机无响应/本地校验拦截/已生效/本地暂无/本地数据"等口径；`interaction.js` 下发值同步改。`ui-presentation-hygiene` 加静态闸：剔除行/块注释后扫描注入层字符串字面量，禁止出现"服务端/服务器"。结算真值源、协议、存档结构零改动 |
| `DEV-52` | 「武将界面，武将头像和武将介绍面板很丑，需要优化」 | 六府武将页（`panels-ui.js viewGeneral`）是纯文字列表 + 属性表格，完全没有头像；原版 350×480 立绘虽已由资产桥下发（`window.__slgPortraitUrl`），但只用在出征面板/战场，六府页未接入 | 重做人物卡大图：`heroCardHtml(g)` 用原版立绘做主视觉 + 阵营色描边 + 星级 + 史载五维条（`lore.historyStats`，不编造）+ 生平，`portraitThumb()` 给帐下与在野列表加缩略头像，在野预览同样上卡；立绘异步就绪监听 `slg:portraits-ready` 重绘占位。`web/` 磁盘逐字节不动，全部运行时注入 |

**纪律与取舍**：
- 本轮是**呈现层改动**：结算逻辑、协议、存档、配置表零修改；DEV-51 只换玩家可见文案，验证方法为"注释剔除后字符串字面量扫描"，避免误伤源码中的工程术语（服务端 = 本机 Node 进程，注释保留）。
- 人物卡五维只展示史载五维 `lore.historyStats`（0~100 同源口径），主角无史载时诚实显示"—/史无明载"，**不编造数值、不把本局六维伪装成史载五维**；阵营配色沿用战场红/蓝基调扩到多势力，取 `camp` 取模。
- 资产桥异步：`img[data-slgcid]` 由 `skills.js` 回填，`span/div` 占位由 `panels-ui.js` 的 `slg:portraits-ready` 监听重绘替换，两条路径都只读取原版静态 PNG，`web/` 零改动。
- 新增测试：`ui-presentation-hygiene` 本地口径闸、`p11-ui-integrity` 人物卡契约闸；真机取证（`probe-herocard-herocard3.png`）确认在野名士立绘/五维 98-72-96-98-92/13 个缩略头像全部上屏，0 页面错误、0 控制台错误。
- 改完重打包 + 双态取证 + perf/layout/terms/compliance + check-release 全绿；未改协议消息计数、未改 byteIdentical 基线。

### 17.17 严重 bug 全量修复 / 0 兵力战斗画面根因（2026-11-19 深度测试）

| 编号 | 根因 | 修复落点 |
|---|---|---|
| `BUG-01` | 战斗回放 `createStage.buildUnits()` 把战后余兵 `remain` 当开局 `cur`，并把 `remain<=0` 预标记 `dead`，败方第一帧即 0 兵 | 开局改取战前 `troops`、`dead=false`；events 逐击扣血；结果横幅前用 `remain` 终态校准（含追击/破城额外折损） |
| `BUG-02` | 内核零 damage 事件时兜底 hit 缺 `a_bs/a_as/d_as`，`resolveBattle` 汇总 `reportSkillIds` 抛 `TypeError` | 兜底 hit 与 `mkHit` 同形，三条技能数组恒为空数组 |
| `BUG-03` | 普攻/战法未按 actor side 分流，守军打我军被写成「我军攻击守军」，歼敌虚高且攻守颠倒 | `kernelEventsToRounds()` 按 `a*/d*` 分流：守军普攻不进 legacy hit；守军战法只进 `d_as.kill`，`d_loss` 只统计我军伤害 |
| `BUG-04` | E0 控制分支 `control_probability` 固定取原表值，Lv1→Lv10 不成长，与编辑器「Lv10=Lv1×2」冲突 | 按等级倍率放大并夹在 `[0,1]`，Lv1 保留原表值，Lv10 双倍封顶 |
| `BUG-05` | `makeOfficer` 已滤空战法槽，但 `rosterDefenders` 反查名册时仍 `null.id` 崩溃，旧档守军整城消失 | 同一过滤口径补到 `rosterDefenders` |
| `BUG-06` | `strategySetScenario` 清 `strategy.marches` 但不清 `armys[].marchId`，切剧本后队伍永久锁死 | 切剧本后遍历 `armys` 删除 `marchId` |
| `BUG-07` | `strategyAttack` 先按带兵上限压兵并回补守军，再因缺粮返回 `no_grain`，失败动作污染存档 | 钳兵/回补改为局部计算，粮检通过后才写回；`marchPlan` 用局部快照 |
| `BUG-08` | `fromState.owner==='player' || home===st.playerCity` 是无条件逃生门，举义后都城失守仍可出征 | 逃生门限定为「未举义的指定起点城」，失守都城不再放行 |
| `BUG-09` | 运输在途时城池被攻陷，`deliverGrain` 不查归属仍入库，等于资敌 | 到达时按 `strategy.cities[id].owner` 拒绝，触发既有「粮车折返」分支 |
| `BUG-10` | `facilityAdditions` 不查城池归属，失守城设施继续给玩家日产/仓容加成 | 按 `s<id>` / 数字键反解 cityId，明确归属他方即跳过；序章本地主城沿用旧语义 |
| `BUG-11` | 瘟疫分支 `Array.isArray(row.troops)` 恒 false，文案称「守军折损一成」却从未生效 | 城池守军权威类型为 number，改为数字打折并保持有限非负 |

**纪律与取舍**：
- 10 项缺陷 + 0 兵力画面根因全部落在既有真链路函数内；`settleWorld` 仍是世界推进唯一入口，没有新增任何手写结算链。
- 战斗内核结算数值、战报哈希、协议字段、存档结构、`web/` 磁盘产物零改动；本次修正的是错误的字段初始化、side 归属与失败动作写状态。
- 新增 `tests/bugfix-regression.test.js` 11 条回归锁；`FIELD-CONTRACT.md` 同步登记回放初态/终态、`d_loss` 语义与 E0 控制命中率。

---

### 17.18 玩法缺陷全量修复 / 沙盘压力与扩张闭环（2026-11-19 用户「修复所有问题」）

诊断阶段用官方入口实跑（`settleWorld` / `advanceToNextTurn` / `strategyAttack`），脚本在仓外 `D:\WorkBuddy\slg\_probe\`。**其中两条诊断结论在实施时被实测推翻，记录在此以免后人对错案再做一遍。**

| 编号 | 根因（含实测证据） | 修复落点 |
|---|---|---|
| `GAME-01` | 出征把「有兵但该槽无将」的兵力当折损扔掉：`attackRemain` 对所有槽位按内核余兵回填，未上阵槽位记 0。实测 4000 兵出征只有 1333 真正上阵，战报却报「折损 3141」 | `settleArmyBattle()` 记 `fielded` 集合，未上阵槽位原样带回兵力；折损只算真实参战 |
| `GAME-02` | 兵力优势只放大攻方攻击力（`attackerOddsMul`），不改「攻方挨打」，以多打少仍按高比例折损 | 新增 `suppressionOf(atk,def)=clamp(0.88×(1−守/攻),0,0.5)`，作为攻方开局常驻 `damage_reduce` 注入内核（`UnitInput.initial_reactions`，缺省空数组，黄金向量不变） |
| `GAME-03` | 序章坞堡领地建筑（「土地 Lv.7」石 7000/日）举义后继续供资源，实测 10 旬把石头顶到 74 万、20 旬撞 100 万上限 | `buildYield()` 在 `state.oath.done` 后返回零；序章阶段照旧 |
| `GAME-04` | 城产过低：金 20/日系数下 5 城仅 274/旬，不够付 380 武将旬俸，占城是负收益 | `cityYield()` 金 20→60、粮 30→38；维持费仍按毛产 35%，5 城净 +150/旬 |
| `GAME-05` | 府库上限固定 100 万，木/铁/石 20 旬内全部封顶 | `totalYield()` 改为 `10 万 + 城数×2 万 + 仓廪`（5 城约 20 万），无城沿用配置 |
| `GAME-06` | 向导 `GUIDE` 把「编队出征」排在「征兵」之前，默认 800 兵撞 1750 守军必全灭，且战败不提示下一步 | 顺序改为 征兵(g4) → 粮道(g5) → 出征(g6)；战败 summary 在守军 >1.2 倍时加「先征兵补足」 |
| `GAME-07` | 武将编辑器只有「自带战法」一个下拉，第 2/3 槽无入口，12 槽只装 4 条 | `SKILL_SLOT_KEYS` 三槽可编辑；`editorSave` 只同步被编辑的槽；编辑器表单只提交「改动过」的字段（`data-orig`），避免改武力把战法清空 |
| `GAME-08` | 存档 `skills` 含半残对象（`{id:0}`、字符串、lv>10），下游 `.map(s=>s.name)` 抛 `TypeError`（ai-roster 同源） | `normalizeWorld` 统一清成 `null` 或 `{id,lv,cfgId}`，lv 钳到 1~10 |
| `GAME-09` | 诸侯来犯只是家门口摆一支野战军，玩家不理也没有任何后果——挂机 130 旬 5 城不失，世界零压力 | 新增 `assaultEscalationTick()`：40 日不清剿即围城（`besieged`，产出减半），每旬守军 −2%/民心 −3；守军归零则城陷；120 日粮尽自退；同势力场上限 2 支 |
| `GAME-10` | AI 讨伐玩家门槛为「城数 ≥3 或占比 ≥25%」，5 城时永远进不了池子，AI 全程只互殴 | `strategy-brain.playerOption` 门槛降为「≥2 城」，仍受「打得过」与 6 旬冷却约束 |
| `GAME-11` | 八幕仅序章可玩，沙盘期无目标锚点；`scenarioGoal` 恒 null，偏安结局不可达 | 新增 `STAGE_GOALS`（6/10/18 城）与 `stageGoalTick()`，跨阈值记里程碑并发军情 |
| `GAME-12` | 纯内政武将永不成长（经验只来自战斗，`exp` 恒 0）；`loyal` 只是 UI 数字 | 内政每旬 +5 经验；`makeUnit` 按 `loyal<80` 折攻（最低 0.88） |

**被实测推翻的两条（不要再按旧诊断改）**：
- 「战斗回放 1302 回合」：`warReport.rounds` 是 **JSON 字符串**，1302 是字符数；真实回合看 `state.battleLog[-1].rounds`，实测 7 回合/57 事件。
- 「战法强度 190 倍极差」：那是「概率×伤害率×目标数」的粗口径，未计入发动次数；`tests/skill-balance.test.js` 已有闸门（主动/追击 300~2000、极差 ≤7 倍）且全绿，**不改战法数值**。

**纪律与取舍**：
- 内核只加「可选初始 reaction/buff」两个向后兼容字段（缺省空数组），`battle-core` 37/37 黄金向量不变；未改伤害公式、未改 `troop_factor`、未改 `Lv10=Lv1×2`。
- 围城只读 `state.garrisons` 与 `strategy.cities`，不新建实体、不加协议字段；`settleWorld` 仍是唯一入口（新增 `assaultEscalationTick` / `stageGoalTick` 两次调用）。
- `web/` 磁盘产物零改动；新增 `tests/p20-gameplay-fixes.test.js` 13 条回归锁。

### 17.19 自迭代第二轮：忠诚可持续 / 围城可破城 / 编制上限 / 里程碑兑现（2026-11-20）

触发方式：不预设问题清单，直接用官方入口跑**挂机长局**（`_probe/p12-longrun.mjs` 150 旬、`p13c` 逐将追踪、`p15c` 编年史统计、`p17` 用 `defineProperty` 抓 `cleared` 写入栈），从「玩家实际会遇到的坏结果」反推根因。以下每条的数值都是跑出来的，不是估的。

| 编号 | 根因（实测证据） | 修复落点 |
|---|---|---|
| `LIVE-01` | **主角会叛逃**。`loyaltyTick` 对所有 `state.generals` 一视同仁：未委任 −1/旬、无下限。实测挂机到第 62 旬，主角（`id=1000, cfgId=880001, isProtagonist`）忠诚跌破 40，掷骰出走，整局叙事断裂且不可恢复 | `loyaltyTick` 对 `isProtagonist` 直接 `continue`：不衰减、不叛逃、不吃欠饷罚 |
| `LIVE-02` | **忠诚是倒计时不是状态**。岗位全图固定 5 个（`conf/panels/posts.json`），第 6 名武将起注定流失——「招到人」= 惩罚。实测 T15/T30 各来投 1 人，反而加速崩盘 | 改为「可管理状态」：委任 +0.6/旬；未委任向基线 70 回落 −0.3/旬、低于基线 +0.2 回血；欠饷 −5；民心崩再 −1（下限 45）；叛逃阈值降至 `<40` 10%、`40~55` 3%；首次跌破 55 给一次「离心」预警（赏赐/委任两条低成本补救路） |
| `LIVE-03` | **名声正反馈**。「名士来投」名声含「帐下武将×2」，人越多名声越高 → 来投越快。实测只剩 1 座城时帐下 19 人，旬俸 1140 金 vs 单城旬入约 200，欠饷 → 忠诚崩 → 出走，名单还在涨 | 新增 `generalCapacity = max(4, 4+城数×2+bonusSeats)`；编制满不再来投；名声里的武将项封顶 10。**招降（花钱）不受限**——刻意留的口子 |
| `LIVE-04` | **围城是死机制**。损耗写死 2%/旬，但 120 日就粮尽自退 → 最多 8 旬、累计掉 15% 守军，1800 守军的城永远破不了，`fallen` 分支是死代码。实测 80 旬内 AI 对玩家出兵 2 次（刘备），两次都是「围一下就走」 | 三条并行压力：兵力 `clamp(3%+6%×攻方兵力占比,3%,9%)`/旬；民心 −4/旬（叠 `cityDevTick` 被围 −3，实际约 −7）；治安 −1。**城破两条线**：守军归零 或 民心 ≤20 开城。撤围放宽 120→180 日；解围补民心 +8 |
| `LIVE-05` | **围错城**。`spawnFactionAssault` 把营地摆在 `target.x+2`，围城却用 `nearestPlayerCity` 现算——两城相邻时战报说打定陶、实际围陈留 | 来犯军记 `targetCity`，围城以出发目标为准，查不到才回落近邻；视图新增 `targetName/daysToSiege/daysToWithdraw/besieging/targetMorale` |
| `LIVE-06` | **都城丢了 playerCity 还指着敌城**。实测陈留第 121 旬被袁绍攻破，此后 `failstate.capitalLost` 恒真，`makeGeneral` 把新武将塞进敌国城。`ensureStrategy` 只在城墙编号失效时重绑 | 新增 `rebindCapitalIfLost()`，`assaultEscalationTick` 末尾兜一次：迁到「守军最多的己方城」并播报；无己方城不迁（交 failstate） |
| `LIVE-07` | **事件流被背景音淹没**。150 旬 480 条事件里大半是「某某晋为中郎将」「某某按兵」，玩家自己的战事被 shift 出去 | `recordEvent(state, text, {quiet:true})` → `strategy.dynamics`（120 条）；NPC 官阶/学艺/积功/登庸/按兵/招降/挖角（非玩家）走此通道。战略页新增「势力动态」栏 |
| `LIVE-08` | **战报把人名打成 id**：`俘获……将100121` | 改为 `nameOfCfg(state, cfg, c.cfgId)` |
| `LIVE-09` | **18 城之后无目标**。`STAGE_GOALS` 只到 18 城且只播一行字，沙盘没有终局 | 常量抽到零依赖叶子 `domain/stage-goals.js`（panels 与结算同源）；补 30 城「霸业」；达成发**实际收益**（金/名望/编制）；新增一统线 45 城 → `strategy.sandboxEnding`，只结算一次、不硬中断 |
| `LIVE-10` | **养人成本不可见**：玩家看不到「帐下 12 人每旬 720 金」，只会突然发现府库见底 | `salaryDueOf()` 与 `loyaltyTick` 同源上屏；战略页新增「帐下武将 x/y」「旬俸合计」两卡 |
| `LIVE-11` | **部队驻地悬空 = 永久软锁**。`army.cityId` 只在 `strategyResolveMarches` 的四个分支里赋值，城被攻破时无人处理：部队驻陈留 → 陈留被围破 → `playerCity` 迁走（`LIVE-06` 已修）但 `army.cityId` 仍是那座敌城 → 之后每次 `strategyAttack` 都在 `fromOk` 返回 `{code:6,not_own_city}`。实测「主动出征 150 旬」：地图上还有 4 城、帐下 10 将、府库充盈，**95 次出征请求全部被拒，一次都没能出兵** | 新增 `rebindArmiesIfStranded()`，在 `assaultEscalationTick` 末尾与迁都同批兜底：驻地失效的部队退回「都城或守军最多的己方城」，同步武将 `cityId` 并播报；行军中跳过。修复后同一探针 5→15 城、兵力 7200、金 32 万 |
| `LIVE-12` | **事件冷却字段是死配置**。`events.json` 给条件事件配了 `cooldown: 8`，但 `selectEvents()` 只在 exclusive 挤掉时写 1 旬冷却，配置里的值从没被读过。条件长期成立的事件（流民就食 / 金盈库满 / 仓廪充盈）每 4~5 旬重新触发，150 旬同一条刷 33 次、每次连播三行（触发 + 抉择 + 逾期），占满 418 条事件流的 96 条 | `selectEvents()` 选中即写冷却：有配置按配置，非 `once` 未配置走默认 6 旬。修复后同一探针该事件 33 → 18 次（150÷8） |

**踩坑记录（给后人省一次调试）**：`export { X } from './x.js'` **只转出、不建立本地绑定**。把 `STAGE_GOALS` 搬走后只写 `export ... from`，文件内 `stageGoalTick` 引用 `STAGE_GOALS` 即 `ReferenceError`——而 `node -e "import(...)"` 不会报错（模块能加载，函数没被调用）。表现是 90 个与忠诚无关的测试集体失败。必须 `import` 后再 `export`。

**纪律**：`settleWorld` 仍是唯一世界推进入口；`web/` 零改动；未动伤害公式、`troop_factor`、`Lv10=Lv1×2`；新增 `tests/p21-loyalty-siege.test.js` **22 条** + `tests/p22-event-cooldown.test.js` **5 条**回归锁（每条对应上表一个缺陷）。

**对照实验（同一缺陷的不同玩法）**：`LIVE-01~03` 修完后，用两支探针对比同一份代码——「挂机不动」150 旬丢掉 4 座城、府库见底；「正常管理」120 旬**零武将流失**、帐下 17 人、忠诚 71~100。这说明忠诚的表现是**玩法选择的结果**，不是数值把人耗死。唯一需要修的是 `LIVE-11` 那种「玩家想做但做不到」的软锁。

### 17.20 自迭代第三轮：外交入口 / 事件降噪 / 终局可达（2026-11-20）

继续用官方入口长跑（`_probe/p33`~`p40`），把上一轮有意留白的三件事逐条实测。本轮**两条诊断被实测推翻**，按惯例明确撤回而不是静默丢弃。

| 编号 | 留白原话 | 实测结果 | 处置 |
|---|---|---|---|
| `ITER3-01` | 「外交系统能力齐但没有 UI 入口」 | **误判，撤回**。外交视图完整存在于出征窗第 5 个页签（`skills.js warDiploPanel`），协议 `act:'diplo'` 也早就接通。真实问题是入口藏得太深：400 旬劝降探针一次都没点开 | 战略页加「外交 · 诸侯态度」直达按钮，复用 `window.__slgWarWindow({tab:'diplo'})`；不新建视图、不改协议、不动 `web/` |
| `ITER3-02` | 「事件弹窗约 6 旬一次，偏密」 | **数字错，方向对**。游标统计 150 旬：38 个旬有事件（约 4 旬一次）、76 次触发；真正的问题是未决事件自动结案时写「触发 + 抉择 + 逾期」三行，事件日志 224 行里 148 行是这种噪音 | 逾期走 `quiet:true` 只留一行并写明所取选项；另给条件事件加 4 旬全局间隔（史实 `once` 节点不受限）。实测事件日志 224 → 150 行 |
| `ITER3-03` | 「45 城一统线约 400 旬偏长」 | **误判，撤回**。45 城不是慢，是**够不到**：主动打 400 旬峰值 15 城并跌回 5；会打+会管理 400 旬峰值 24 城。根因是军粮硬约束（1 兵 1 旬 1 粮，10 城粮产只够养 3800 兵） | 一统线改为 24 城（实测第 330 旬达成）、末档里程碑 30 → 22 城「封王」。**未动军粮参数**——那会牵动 30 项参数表与全部战报哈希，属产品裁决范围 |

**附带修掉的真缺陷**：劝降兵力比只算城池守军、不算在编部队（`diplomacy.js totalTroops`）。实测玩家带 2 万大军，劝降判定里仍等于没有兵，400 旬劝降 0 次——「整片归附」的加速路径形同虚设。改为玩家 = 城守军 + 在编部队，与界面「在编兵力」同源；NPC 仍只算城守军。

**仍留作设计取舍（未擅自改）**：劝降还要求态度 ≥0，而占他城会 −20/座、赠礼封顶 +30，玩家扩张后很难把态度拉回非负。这是既有门槛表的一部分，要改需产品裁决。

**对照实验**（三种玩家，同一份代码，400 旬）：

| 玩家 | 峰值城数 | 结局 | 兵力 |
|---|---|---|---|
| 挂机不动 | 5 → 1 | 丢城、府库见底 | 初始 |
| 会打不管理 | 15（T128） | 跌回 5，粮 0 | 卡在 10347 |
| 会打 + 会管理 | 24（T331） | **第 330 旬触发「定鼎」终局**，之后跌回 18 | 22488，后期粮 0 |

粮 0 在后期仍会出现——这是军粮参数（`grainPerSoldierDay = 0.1`）与城产粮的真实平衡结果，不是 bug。终局在粮尽之前已达成，玩法闭环成立。

**纪律**：`settleWorld` 仍是唯一世界推进入口；`web/` 零改动；未动伤害公式、`troop_factor`、`Lv10=Lv1×2`、军粮参数；新增 `tests/p23-selfiteration3.test.js` 4 条回归锁（含「UI 必须落到既有页签」的静态闸）。


---

## 18. 需求 → 设计 → 实现 → 验证 全链路追溯

| 需求组（PRD） | 本文设计章节 | 主要实现 | 验证证据 |
|---|---|---|---|
| FR-01 启动/门禁 | §2.2、§6.1、§9.6 | `index.js`、`ui-shell.js` | `p11-session-gate`、双态冒烟 |
| FR-02 协议 | §3.1~§3.3 | `codec/wsserver/handlers` | `codec/protocol/contract-matrix` |
| FR-03 时钟 | §6.3、§7.1 | `clock.js`、`settleWorld` | `check-release` 7.9d |
| FR-04 存档 | §4.1~§4.3、§6.8 | `world.js`、`index.js /save/*` | `save-slots`、`protagonist-save` |
| FR-05 领地 | §3.3.3、§7.2 | `handlers nationMap.*` | `building`、`bugfix` |
| FR-06 设施 | §7.15、§6.4 | `facility-catalog.js`、`panels.js` | `m4-facility-catalog`（7 条） |
| FR-07 经济 | §7.2、§7.10 | `economy.js`、`strategy.js` | `m2-ledger`、`WB-06` |
| FR-08 逐城经济 | §6.4、§7.3 | `city-econ.js` | `p6-city-recruit`、`m4-system-audit` |
| FR-09 内政委任 | §7.4 | `interior-task.js`、`appointment.js` | `m2-appoint`、`p10-interior-task` |
| FR-10 征兵 | §7.5 | `levy.js` | `p11-levy-and-gates` |
| FR-11 武将属性 | §7.6 | `general-stat.js`、`config.js`、`battle.js` | `m4-general-balance`、`hero-balance.mjs` |
| FR-12 战法 | §7.7、§7.8、§10 | `skills.js`、`kernel/`、`battle-core/` | `m4-protagonist-skill`、黄金向量 |
| FR-13 人事 | §7.11 | `tavern/relation/fate-groups` | `m3-heroes-fates`、`tavern` |
| FR-14 出征 | §6.5、§7.9、§8.2 | `strategy.js`、`march.js` | 7.11 八环、真鼠标 54×2 |
| FR-15 战斗 | §6.6、§7.7、§8.1、§10.3 | `battle.js`、`kernel/` | `protocol`、`domain-coverage` |
| FR-16 推演 | §6.5、§6.6、DEV-19/20 | `previewAssault`、`battle-narrative.js` | `p10-preview*` |
| FR-17 大地图/AI | §4.5、§7.12 | `strategy-brain.js`、`map.json` | `strategy-map`、`m3-scenarios` |
| FR-18 粮道 | §7.10 | `supply.js` | `p10-supply`、`m2-army-supply` |
| FR-19 外交 | §7.9 | `diplomacy.js` | `m2-diploma`、`m2-tension` |
| FR-20 事件 | §7.13、§8.3 | `event-dsl/event-engine/strategy` | `m3-events`、`check-events.mjs` |
| FR-21 俘虏 | §7.11 | `captives/captive-rules/garrison` | `m4-13-*` |
| FR-22 失败结局 | §7.14、§8.4 | `failstate.js`、`campaign.js` | `m2-failstate`、灭国闭环 |
| FR-23 六府面板 | §9.2 | `panels.js`、`panels-ui.js` | `panels`、`http-endpoints` |
| FR-24 交互层 | §9.2、§9.5、§11.3 | `interaction.js`、`interaction-ui.js` | `p9-interaction`、`check-terms.js` |
| FR-25 窗口治理 | §9.5、§9.6 | `electron/main.cjs`、`preload.cjs`、`ui-shell.js` | `m4-window-behavior`、7.8 |
| FR-26 常驻入口 | §9.2 | `#slgIxQuick` | `m4-editor` 入口断言 |
| FR-27 编辑器 | §6.7、§9.2 | `general-editor.js`、`editor-ui.js` | `m4-editor` 14 条 |
| FR-28 GM 覆盖层 | §4.4、§6.7 | `gm/overrides.js` | `contract-matrix`、`http-endpoints` |
| FR-29 无障碍 | §12、§14.3 | `layout-audit.cjs`、`check-contrast.js` | `m4-a11y/m4-layout`、7.9c |
| FR-30 合规 | §13.2 | `conf/compliance/*` | `m4-compliance`、7.9/7.9b |
| FR-31 发布闸 | §14 | `tools/check-release.js`、`pack.js` | `release-check.json`、`pack.json` |
| FR-32 可观测 | §3.4、§11.1 | `index.js /__slg/*` | `http-endpoints` |

### 17.15 闭环修复 / 原版美术资产上屏 / 千军万马与技能动画（2026-11-19 用户实机反馈）

- **用户原话**：「全流程还是跑不通，游戏没有闭环；画面太过粗糙，武将图片没用起来；战斗不气派，不要压缩成兵马三两只；释放技能要有动画。这些都实现需要你给我来设计。」
- **设计确权**：仓外 `D:/WorkBuddy/slg/slgclient-全流程闭环与视觉战斗设计方案.md`（v1.0）。本轮先修断点再上美术；`offline/web/` 逐字节不动。
- **闭环**：`army.conscriptPreview`（石耗+兵种倍率，UI 零复算）/ 解甲令牌作废旧征兵任务 / 事件 `sinceTurn` 4 旬保守自动结案 / 向导 g3 跳酒馆 / 自立与赏赐改页面内输入框（Electron 无 `prompt`）/ `war.digest.done` 真点「进城治理」。check-release 7.11 改为**条件闸**：本次占城（`digest>0`）才强制消化步骤；未占城按败局放行但报告留痕，不再无条件假绿。
- **美术资产**：构建期 `tools/build-portrait-map.js` 从冻结 `generalpic/card_*.png.meta` 生成 `server/portrait-map.json`（448 条）；新增只读端点 `/__slg/assets/portraits`；`window.__slgPortraitUrl()` 在武将页 / 征兵槽 / 出征队伍 / 战斗将卡统一上屏。战场底图用冻结 `war_bg.png`，技能图标用 tactics_1~4。
- **战斗表现**：`drawFigure()` 从「6 个点 + 三角小人」改为「方阵 + 军旗 + 立绘将卡」；大屏每槽最多 96 个像素兵（1 像素兵代表数十~上百人），双方合计上限 576，仍是纯表现映射，不改 `soldiers`、不参与结算。新增 `drawEffects()` 消费 `act.t` 发放蓄力/光弹/冲击环/斩击/控制链/治疗/溃散特效。全屏回放 z-index 由 99997 抬到 100700（原值低于主窗 100560，回放被战报窗整块盖住）。
- **地图**：全景合成图以 28% multiply 叠在水墨底图之上，只补纹理不覆盖路网/城池图层。
- **验证**：`tests/p19-loop-visual.test.js` 9 条；`npm test` 全绿；源码态冒烟 / UI 审计 / 真鼠标全绿；打包态报告另行重取。

**红线速查（改前必看）**：INV-01~INV-10（§1.4）、ADR-01/04/07/08/13/14（§1.2）、§7.15 键空间警告、§9.3 z-index 阶梯（含回放层 100700）、§10 确定性、§14.7 报告归属、§16.4 内核改法、§17 偏差登记。

---

## 19. 附录

### 19.1 命令速查

```bash
# 源码态（cd offline）
npm install
node server/index.js                 # HTTP 8088 / WS 8004
node electron/main.cjs                # Electron 壳
npm test                              # 73 个测试文件

# 内核（cd battle-core）
npm run build                         # tsc → build/src/*.js
npm test                              # 内核单测 + 黄金向量
npm run golden / stress / export-config

# 取证（cd offline）
node tools/smoke.js [ --packaged ]
node tools/ui-audit.js [ --packaged ]
node tools/mouse-playtest.js [ --packaged ]
node tools/perf-probe.js
node tools/layout-audit.js
node tools/check-release.js
node tools/pack.js

# 内容/合规
node tools/check-events.mjs
node tools/check-terms.js
node tools/check-compliance.js
node tools/compliance-report.js
node tools/system-audit.mjs
node tools/sim-60turns.mjs
node tools/hero-balance.mjs
node tools/explore-bugs.mjs
```

### 19.2 文件索引（按用途）

| 用途 | 路径 |
|---|---|
| 进程组装 / 端点 | `server/index.js` |
| 协议帧 / WS | `server/codec.js`、`server/wsserver.js` |
| 消息路由 / 世界推进 | `server/handlers.js` |
| 战斗外层 / 内核 | `server/battle.js`、`offline/kernel/`、`battle-core/src/`（仓库根） |
| 战法数据与 bundle 注入 | `server/skills.js` |
| 状态 / 存档 / 配置 / 时钟 | `server/world.js`、`config.js`、`clock.js` |
| 领域逻辑 | `server/domain/`（42 个） |
| 浏览器注入层 | `server/{panels-ui,interaction-ui,ui-shell,editor-ui}.js` |
| GM / 覆盖层 | `server/gm/`、`conf/campaign/overrides.json` |
| Electron | `electron/*.cjs` |
| 配置数据 | `conf/`（76 JSON + 18 图片） |
| 原版画面（不可改） | `web/`（1582 文件） |
| 测试 / 工具 | `tests/`、`tools/`、`tools/lib/port-guard.js` |
| 报告 | `reports/`（不入库） |
| 文档 | `docs/`（本文 + PRD + GDD + ARCH + FIELD-CONTRACT + 变更/合规文档） |

### 19.3 术语对照

| 术语 | 代码中的对应 |
|---|---|
| 旬 | `turnDays=10`、`TICK_DAYS=10` |
| 双账本 | `state.strategy.cityEcon[id].store` / `resources[faction].grain` |
| 生效设施 | `facility-catalog.js facilityView()` 的 `rows`（7 项） |
| 过度设施 | `hiddenCount`（19 项） |
| 三源合一 | 描述（`ui`/战法表）= 计算（domain/kernel）= 战报（`battle-narrative.js`） |
| 出厂源码 | `check-release.js SHIPPED_DIRS = electron/server/conf/kernel` |
| 双态 | `SLG_SMOKE_TAG=original|packaged` |
| 黄金向量 | `battle-core/golden/*.json` + 175 条事件一致性测试 |
| 指纹 | `webFingerprint` / `config_fingerprint` / `event_fingerprint` |
| 覆盖层 | `conf/campaign/overrides.json` |
| 注入层 | `/__slg/*/ui.js` + `patchClientBundle` |

### 19.4 版本记录

| 版本 | 日期 | 基线 | 变更 |
|---|---|---|---|
| v1.0 | 2026-11-15 | `3e4ccbd` | 首版。建立运行时拓扑、73 消息 / 37 类端点全表、state 数据字典、42 领域模块接口、15 组算法公式、7 类状态机、注入层 z-index 全表、确定性规范、92 项发布闸分组、打包部署、扩展规程、27 条偏差登记与全链路追溯矩阵。 |

### 19.5 维护约定

1. 基线提交号变更 → 更新文首「代码基线」、复核 §4.5 全部数字、复核 §17 偏差是否已被修复。
2. 新增模块 → 更新 §5.1/§5.2 表格与 §5.3 依赖图，标注是否零依赖叶子。
3. 新增端点/消息 → 更新 §3.3/§3.4 全表，补 §18 追溯行。
4. 改 z-index → 更新 §9.3 全表并跑真鼠标双态。
5. 发现「文档说 A、代码做 B」→ **只往 §17 追加，不静默改代码**；修复后保留行并注明提交号。
6. 本文入仓即提交，保证 `check-release` 的「工作区干净」硬闸不因文档变红。

---

**文档结束** · 《穿越·汉末》软件详细设计说明书 v1.0 · 2026-11-15

