# DeepSeek-memory-Ido1um

> **3.0.0-beta.1** — 窗口账本、情境段、主题树事实卡、写入门与分层检索。
> Beta 意味着数据格式已可用但可能微调；升级前请备份数据目录。

一个给聊天机器人用的**可审计、会遗忘、能轮转**的长期记忆引擎。

它不把整段对话塞进 prompt，而是把「说过的话」拆成几层，每层只做一件事：

| 层 | 存什么 | 谁在读 |
|---|---|---|
| **窗口账本** `window/` | 每轮的用户原话、助手真正发出去的话、以及没发出去的「当时的想法」 | 轮转交接、情境切段、检索 |
| **原文日志** `raw/` | 最近 7 天逐条对话 | 关键词检索、审计 |
| **情境段** `episodes/` | 按 90 分钟切出的话题段（标题/场景/主题/想法），可补模型摘要 | 检索、主题归并 |
| **长期事实** `state/longterm.jsonl` | 一句话事实（生日、偏好、约定、待办…），带档位、分数、事件流 | 事实卡、检索、工作台 |
| **主题树** `state/topics.jsonl` | 主题与槽位（学业/摄影/设备…），把事实挂到树上 | 事实卡投影、检索 |
| **事实卡** `profile.md` | 事实库的投影，默认 1500 字，一个会话只注入一次 | 模型的「长期记忆」 |
| **候选池** `state/candidates.jsonl` | 宽进但还没裁决的候选，不进卡、不进检索 | 日终归并 |

## 3.0 做了什么

- **轮转有契约**：真实 token 达到上下文的 70% 才自动轮转；没到 70% 时必须是人明确要求。轮转后首屏固定是「规则 + 事实卡 + 最近一天原话 + 七天摘要」，总长有硬上限。
- **交接带原话**：轮转后不再只有摘要，会带最近 24 小时的真实对话（含助手当时的想法，已发出去的不重复），避免「一觉醒来只记得梗概」。
- **主题树出卡**：事实按主题分组、按槽位留最新，投影前先做确定性清洗（去残句、型号归一、跨槽位去重、主体纠偏），卡不会越写越乱。
- **宽进严出**：写入门分 `pass / mark / block` 三档；低置信与模型抽取的候选先落 `candidates.jsonl`，日终裁决后才进事实库。
- **分层检索**：近 7 天情境 → 近 7 天原话 → 近 30 天情境，按相关度取片段，注入有字数上限。
- **可观测**：工作台新增窗口回放、情境索引、主题簇、消费账单；记忆侧的模型调用也记账。

## 轮转契约

```
真实 token ≥ 70% × 上下文窗口   →  可以自动轮转（也允许手动）
真实 token < 70%               →  只有人明确批准才能轮转
```

轮转后注入的固定顺序与预算（`memory.handoverMaxChars`，默认 5000 字）：

| 段 | 上限 |
|---|---|
| 规则 | 600 |
| 事实卡 | 1500 |
| 最近一天的原话（24h） | 2400（单轮 600，含「当时的想法」≤160） |
| 七天摘要 | 剩余预算 |

上下文压力来自真实用量（`logs/token-usage.jsonl`）；拿不到时按「已观测最大值 × 1.15」估算。

## 快速开始

需要 **Node.js ≥ 22.13**。核心只依赖 Node 内置模块；`@modelcontextprotocol/sdk` 与 `zod` 只有跑 MCP server 时才需要。

```bash
git clone https://github.com/Ido1um/DeepSeek-memory-Ido1um.git
cd DeepSeek-memory-Ido1um
npm install            # 只用 MCP 时才必要

# 生成规则模板（rules.md）
node scripts/memory-cli.mjs rules init

# 看状态：档位分布、日终、窗口、轮转阈值
node scripts/memory-cli.mjs status

# 查事实 / 预览事实卡 / 查原文
node scripts/memory-cli.mjs recall 生日
node scripts/memory-cli.mjs card
node scripts/memory-cli.mjs search 火锅
```

默认数据目录是 `~/.deepseek-memory/data`，用 `QQ_MEMORY_DIR` 或配置里的 `memory.dir` 覆盖。

## 命令行

| 命令 | 作用 |
|---|---|
| `status` | 档位分布、最近日终、窗口与轮转阈值 |
| `doctor` | 数据目录体检（缺文件、坏行、权限、体积） |
| `health` | 宿主/工作台端口与开关（TCP 探测，退出码 0/1） |
| `recall [词] [--all]` | 长期事实检索（四档排序） |
| `card` | 预览投影后的事实卡（与线上同一路径） |
| `search <词>` | 聊天原文（7 天日志 + 归档） |
| `invalidate <id\|sig> --reason "…"` | 作废一条事实（墓碑 + 审计，不物理删） |
| `reinstate <id>` | 恢复被作废的事实 |
| `merge` / `unmerge` | 合并重复事实 / 撤销合并 |
| `budget` | 注入预算实算（规则/卡/检索各占多少） |
| `due` | 到期事项 |
| `trace` | 一条事实的完整来龙去脉 |
| `feel` | 窗口账本里的「当时的想法」 |
| `rules init` | 生成 `rules.md` 模板 |

## 接进宿主

引擎与宿主是解耦的：宿主负责「拿到消息、发消息、开新会话」，引擎只负责「记什么、怎么投影、什么时候轮转」。

最小接法（完整示例见 `examples/bridge-adapter/bridge-memory.js` 与 `docs/集成指南.md`）：

```js
import { createMemoryEngine } from './src/engine.mjs';
import * as window from './src/window.mjs';

const engine = createMemoryEngine({ host });

// 1) 入站：记录这条用户消息（打分 / 候选）
engine.onInbound(key, promptText, { ts: Date.now() });

// 2) 拼注入：引擎只返回文本，不负责送达
const composed = engine.composePrompt(key, sessionId, promptText);

// 3) 开账本：用户原话 + 拼好的完整窗口 + 分块
window.beginTurn({
  key, sessionId,
  userRaw: promptText,
  windowText: composed.text,
  blocks: window.splitWindowBlocks(composed.text),
});

// 4) 宿主发送，拿到回复；发出去之前剥掉 [[feel]]…[[/feel]]
const { text: visible } = window.stripFeels(reply);
window.noteSpoken({ key, sessionId, tool: 'send_message', text: visible });

// 5) 落账本：用户原话 / 助手发出去的话 / 当时的想法
window.finishTurn({ dir: engine.dataDir(), key, sessionId, reply });

// 6) 送达之后再确认消费（否则模型没看到，注入却被标成已用）
engine.commitInjections(key, sessionId, composed);
```

宿主契约（`host`）需要提供：`log / listSessions / getSessionId / retireSession / isBusy / isDshReady / afterRotate / getOwnerKey`。不需要的可以实现为空（见 `src/host.mjs` 的 `createNullHost`）。

## MCP server（可选）

```bash
DEEPSEEK_API_KEY=... node src/mcp-server.mjs
```

提供 `qq_memory_search` / `qq_memory_stats` 等工具，直接读本地日志与事实库，不依赖宿主常驻。stdio 模式下由客户端在启动时拉起，改代码后要重启客户端。

## 工作台

```bash
node workbench/server.mjs --port 7351
```

打开 `http://127.0.0.1:7351`。面板包括记忆星图、上下文与轮转、事实卡、记忆库、长期事实、会话与策略、调控台、窗口回放、情境索引、主题簇、消费账单。

只读投影 + 受控写入：写操作要令牌（`WORKBENCH_TOKEN` 或 `workbench/.workbench-token`），写前备份、原子替换。详见 `workbench/README.md`。

## 配置

复制 `config.example.json` 改成 `config.json`，用 `QQ_MEMORY_CONFIG` 指过去；也可以直接把 `memory` 段嵌进宿主自己的配置。

最常改的几项：

| 键 | 默认 | 说明 |
|---|---|---|
| `memory.dir` | `~/.deepseek-memory/data` | 数据目录 |
| `memory.windowDays` | 7 | 原文热窗口天数 |
| `memory.handoverMaxChars` | 5000 | 轮转后首屏总预算 |
| `memory.rotation.thresholdRatio` | 0.7 | 自动轮转阈值 |
| `memory.profile.maxChars` | 1500 | 事实卡上限 |
| `memory.profile.tree` | true | 有主题表时按主题树出卡 |
| `memory.scoring.gateMode` | `strict` | 写入门档位：strict / broad |
| `memory.extract.enabled` | false | 日终模型抽取（先影子观察） |
| `memory.retrieval.enabled` | true | 分层检索 |

## 目录结构

```
src/           引擎与各层实现（window/episode/topics/card-tree/retrieval/gate/…）
scripts/       CLI 与维护脚本（memory-cli、隐私扫描、主题迁移、情境构建…）
test/          node --test 单测（355 个）
workbench/     本地看板（server.mjs + 单页前端）
docs/          设计、集成、升级、排障
examples/      宿主适配器最小示例
```

## 版本号约定

| 变更 | 版本位 | 例子 |
|---|---|---|
| 记忆算法 / 数据模型（打分、遗忘、检索、注入策略、事实结构） | 主版本 | 2.x → 3.0.0 |
| 新增向后兼容的能力（新开关、新工具、新面板） | 次版本 | 3.0.0 → 3.1.0 |
| 修 bug、文案、文档、边界情况 | 修订号 | 3.0.0 → 3.0.1 |

1.0 是首个公开版本；2.0 引入 v10 记忆模型（细节/情绪/可信度/碎片）；3.0 引入窗口账本、情境段、主题树与轮转契约。

## Beta 已知限制

- 旧日志回填工具（`import-session-log`）没有随 Beta 发布，2.x 数据可直接读，但更早的会话不会自动补进窗口账本。
- 日终模型摘要与模型抽取默认关闭；打开前建议先跑影子模式观察 2–3 天。
- 主题分类以规则为主，主题表需要按自己的话题域调整（`state/topics.jsonl` 可直接编辑）。
- 工作台是单机工具：默认只监听 `127.0.0.1`，没有多用户与权限模型。

## 文档

- [设计：3.0 的分层与契约](docs/设计-3.0.md)
- [集成指南：宿主钩子、配置、MCP、工作台](docs/集成指南.md)
- [从 2.x 升级](docs/从-2.x-升级.md)
- [排障](docs/排障.md)

## 隐私

仓库里没有任何真实聊天记录、账号、令牌或本机路径；示例账号一律是占位符（`private:10001`）。发布前会跑 `node scripts/scan-secrets.mjs` 自检。你自己的 `config.json`、`workbench/.workbench-token` 与 `data/` 都已在 `.gitignore` 里。

## License

MIT
