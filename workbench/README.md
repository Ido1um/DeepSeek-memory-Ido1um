# 记忆工作台

> 本地单页看板：左侧选功能，一次只看一个面板；展示记忆现状（真实数据），并可调控目标配置。
> 端口 `http://127.0.0.1:7351`，只监听本机，零依赖。

## 界面

| 项 | 说明 |
|---|---|
| 记忆星图 | **打开工作台固定落在星图**（全窗口，隐藏侧栏与顶栏）；左上「设置」= 退出全屏并回到「上下文与轮转」，Esc 同效；3D canvas2D 手写透视、零依赖；拖动转视角、滚轮缩放、自转、悬停高亮、点击详情 |
| 星图设置 | 右上角「设置」：自转开关、字号、主题、退出全屏（Esc 也可） |
| 布局 | 左侧固定导航 7 项，右侧只渲染当前选中的那一个面板（面板名同步到顶栏面包屑） |
| 深/浅色 | 顶栏右上有 `跟随系统 / 深色 / 浅色`，存 `localStorage.wb-theme`；跟随系统走 `prefers-color-scheme`，切换系统主题即时生效 |
| 字号 | `A−` / 百分比 / `A+`，`.app` 的 zoom 0.8–1.6，存 `localStorage.wb-font`；基础字号 15px |
| 记住上次面板 | `localStorage.wb-panel`；带 `?theme=light\|dark` 可临时预览某个主题（不写入） |
| 控制台入口 | 顶栏「控制台」按钮 → 新标签打开桥接控制台 `http://127.0.0.1:<consolePort>/?token=…`（令牌本机读取，只用于本机页面） |
| 开始菜单 | 「记忆工作台」快捷方式 → `open.vbs` → `open.mjs`：没起服务就后台起，就绪后开浏览器；图标 `icon.ico`（teal「忆」） |
| 自适应 | 9 档断点：≥2200 面板 1440 + 上下文三列 / ≥1920 面板 1320 + 侧栏 260 / ≥1600 面板 1240 + 上下文双列 + 参数四列 / ≥1440 面板 1120 / >1180 侧栏 236 / ≤1180 216 / ≤1024 200 / ≤820 侧栏变顶部横条 / ≤560 表单改单列；表格在容器内横滑，整页永不横滑 |

7 个面板：上下文与轮转 / 事实卡 / 记忆库 / 长期事实 / 会话与策略 / 调控台 / 记忆方案。

## 启动

**日常：开始菜单搜「记忆工作台」**（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\记忆工作台.lnk`）
→ `open.vbs`（无窗口）→ `open.mjs`：
- 7351 已在跑 → 直接开浏览器；
- 没在跑 → 后台起 `server.mjs`，等 `/api/state` 通了再开浏览器（最多等 20 秒）。

调试时可绕过浏览器/换端口：

```powershell
$env:WORKBENCH_NO_OPEN='1'   # 只起服务，不开浏览器
$env:WORKBENCH_PORT='7352'   # 换端口
& '\tools\node-runtime\bin\node.exe' `
  '\workbench\open.mjs'
```

停止后台服务：双击 `stop.cmd`（内部 `stop.ps1`，只杀 `workbench\server.mjs` 那个 node 进程）。

也可以前台跑（关窗口即停）：

```powershell
& '\tools\node-runtime\bin\node.exe' `
  '\workbench\server.mjs' --port 7351
```

## 展示什么

| 卡片 | 内容 | 数据来源 |
|---|---|---|
| 上下文与轮转 | 真实上下文 tokens、阈值、进度、窗口来源 | `logs\token-usage.jsonl`（只认 `k=turn` 行，取近 5 轮最大值） |
| 会话与策略 | key / 会话龄 / chars / tokens / 卡是否注入 / 轮转次数 / **记忆策略下拉** | `state\memory.json` + `workbench\config.json#policies` |
| 事实卡 | 字数与上限、27 条 bullet 预览 | `profile.md` |
| 记忆库 | 四档计数、作废数、日终时间、降级次数、体积、备份数 | `state\memory.json`、`logs`、目录扫描 |
| 长期事实 | 每条事实 + 档位 + 分数 + 作废/撤销按钮 | `state\longterm.jsonl`（没有则显示"引擎未实施"空态） |
| 记忆方案 | 二维遗忘模型 16 参数 + 模式（off/shadow/write）+ 影子采样计数 + 保守/均衡/激进预设 | `workbench\config.json#scoring`、`state\scoring-shadow*.json` |

## 能调控什么

**记忆策略**（每会话三态，落 `workbench\config.json#policies`）：
`full` 全开（记录+注入+轮转）/ `log` 只记（写日志、不注入不轮转）/ `off` 关（完全不记）。
未列出的会话默认 `full`。

**记忆方案**（落 `workbench\config.json#scoring`）：
模型选择（`two-dimensional` 二维 / `ebbinghaus` 经典）、`baseDefault`、`baseFact`、`mentionBonus`、`cap`、
`halfLifeLong/General/Temp`、`sameDayDecay`、`alpha`（复习增益）、`sMaxDays`（稳定度上限）、`promoteHits`、
`promoteScore`、`demoteFloor`、`tempTtlDays`、`negativePenalty`、`suspectAt`。
三个预设：**保守**（更爱留：半衰期长、降级慢）/ **均衡**（默认）/ **激进**（更易淡忘）。

**字号**：顶栏 `A−` / 百分比 / `A+`，范围 80%–160%，存 `localStorage.wb-font`，刷新保留。

**目标配置**（写入 `workbench\config.json`，即时保存）：

`enabled` / `autoRotate` / `inject` / `reinjectOnUpdate` / `rotationThresholdRatio` /
`rotationCooldownMs` / `minRotateTokens` / `contextWindowTokens`（0=自动）/ `windowDays` /
`dailyAt` / `maxEntriesPerKey` / `invalidateEnabled`

**应用到线上**：把 `MANAGED` 那批键（含 `scoring` 与 `policy.keys`）合并进桥接 `config.json` 的 `memory` 段。
写前备份到 `workbench\backup\config.json.bak-<时间戳>`；**重启桥接后生效**。

**数据目录**（`` 为默认）：输入路径 → 「测试」看 存在/可写/记忆子项 n/5/体积；「创建目录」会 `mkdir -p`；「恢复默认」填回默认值。保存到 `workbench\config.json#dir`，「应用到线上」时校验通过才写入桥接 `config.json` 的 `memory.dir`。改目录**不搬文件**，切前请手动复制。

**事实作废/撤销**：写 `state\facts-invalidated.json`（墓碑，不重写 `longterm.jsonl`），
同时 append `logs\facts-audit.jsonl`。可即时撤销。

## 诚实边界

- 四档打分、`longterm.jsonl`、作废连坐**都还没有实现**（v7 第 2–4 步）。现在事实表为空是正常的。
- 桥接的 7 天记忆还在用旧键 `maxSessionTokens=60000`；`scoring` 与 `policy.keys` 只有「应用到线上」写进 `config.json` 后桥接才读（写前自动备份，重启生效）。
- 打分引擎目前跑 `shadow`：只写 `state\scoring-shadow.jsonl` 与统计，**不写 `longterm.jsonl`**；观察 24h 无异常后切 `write` 才真正落长期记忆。
- `reinjectOnUpdate` 同理：机制已定义，等引擎实现。

## 已验证（2026-10-29 · v1.3）

- 读真实状态：窗口 1,000,000（目标配置）→ 阈值 700,000；会话 tokens 271,807（38.8%）；卡 1,382/1,500 字、27 条
- 改阈值：UI 改 0.6 → 阈值立即变 600,000 并落盘；已回滚 0.7
- 策略下拉：改成 `log` → `policies {"private:10001":"log"}` 落盘；已改回 `full`
- 记忆方案：预设「激进」→ `halfLifeLong=20 / alpha=0.8`；回「均衡」→ `30 / 0.9`
- 字号：两次 `A+` → `zoom 1.1 / 110%`；已回 100%
- 应用到线上：对配置副本演练，备份生成、`memory.scoring.model=two-dimensional` 与 `memory.policy.keys` 写入，旧键 `maxSessionTokens=60000 / windowDays=7 / profile.maxChars=1500` 与 `socialV2`/`consoleToken` 全保留；**生产 config 未改动**
- 作废/撤销：sidecar 写入 → 撤销后回到 `{}`，审计行已清空（`facts-audit.jsonl` 现为 3 字节空文件）
- 长期事实表：用 3 条临时事实（hard/long/general）验证渲染与按钮，**验证后已删除**，线上仍为空态
- 单面板导航：7 项点选，`hidden` 只留一个面板，面板名同步面包屑 ✅
- 主题：跟随系统 / 深色 / 浅色 三态即点即换；`?theme=dark` 临时预览 ✅
- `design_audit`：深色、浅色各 **0 violation**（4 档字号 13/14/15/17/32、4px 栅格、WCAG AA、行长 ≤46ch）
- 数据目录（2026-10-29）：默认目录 → 合法/可写/1.8 MB/子项 5/5；相对路径 → 提示且不写盘；不存在盘 → exists:false；`create` 建临时目录 → 可写；非法路径保存 → 400；apply 指向不存在的目录 → 400 且线上 config 未改
- 控制台：`http://127.0.0.1:3100/?token=…` 实测 200，标题「运行总览 · QQ 桥接控制台」

## 回滚

- 目标配置：删掉 `workbench\config.json` 即回默认值。
- 线上配置：从 `workbench\backup\` 挑一份盖回 ``。
- 作废记录：删 `state\facts-invalidated.json` 里对应键，或点「撤销」。

- **映射会话无记录时**（轮转后新会话还没聊过 / 映射指向了已被 DSH 清掉的会话）：`sessionTokens(sid, key)` 会退回「同一个 key 最近的真实会话」并在界面标「取自最近真实会话 / 映射异常」，避免大数字显示成 0；桥接下一条消息会用 `ensureSession` 的 `not-found` 分支自动重建映射。

### 事实卡面板（2026-10-30）

- **看全文**：面板直接显示 `profile.md` 全文（不是前 8 行摘要），带 23 条/收录数；
- **调长度**：输入框填目标字数 → 「预览」（调 `GET /api/card?maxChars=N` 现场重投影，不写盘，显示收录/挤出条数）→ 「保存并应用」（写 `profileMaxChars` 到目标配置 + 合并进桥接 `config.json`，写前备份；重启桥接后生效）；
- 挤出的事实仍在 `longterm.jsonl`，检索能找回，不是删除。

### 大屏对齐

≥1440px 时顶栏与面板共用同一内容宽度（`--pmax`），面包屑左边缘和卡片左边缘对齐；会话表用 `<colgroup>` 固定列宽，最大化后不会把「记忆」下拉挤变形。

### 表格对齐（2026-10-30 修）

- 数字列（龄 / chars / tokens / 轮转 / 分）的**表头也右对齐**（`th.num`）——之前只有 `td.num` 右对齐，宽屏上标题会飘到数值左边一大截，看着像「没对齐」；
- 会话表、长期事实表都用 `<colgroup>` 固定列宽（事实表 `table-layout:fixed`），最大化后列宽按比例走、不会被内容撑歪；
- `映射异常` 这种附注标签改成数字下面单独一行，不再把数字顶到左边；
- 截图/审计可直接开面板：`http://127.0.0.1:7351/?panel=sess|card|facts|ctx|tune|score`（默认仍是记忆星图）。

## 写令牌（默认开启）

- 首次启动生成 `workbench/.workbench-token`（48 位十六进制，权限 0600）；可用环境变量 `WORKBENCH_TOKEN` 覆盖，`--no-token` 只用于本地调试。
- 页面打开时服务端把令牌注入 index.html（同源才读得到响应，跨站读不到），前端所有 POST 自动带 `x-workbench-token`。
- 写请求三重闸门：Host 必须是回环地址（防 DNS rebinding）→ 同源（`origin` / `sec-fetch-site`）→ `Content-Type: application/json`。不带/带错令牌 401，跨站 403，非 JSON 415。
- `/api/state` **不下发**任何令牌；点「控制台」时走 `POST /api/console-url` 现取。

## apply 前的目录体检

`POST /api/apply` 先看目标目录：空目录放行（全新安装），已有 `profile.md`/`state/`/`rules.md`/`raw/` 放行；明显不是记忆目录（非空且没有这些）返回 400，确认后加 `{"force": true}` 才强制；磁盘根目录直接拒。写之前仍会备份桥接 config 到 `workbench/backup/`。
