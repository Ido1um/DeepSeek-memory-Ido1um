# 更新日志

版本号约定：主版本 = 记忆算法/数据模型变更；次版本 = 向后兼容的新能力；修订号 = 修复与文案。
历史版本（1.0–2.1.1）见仓库 Releases 页。

## 3.0.0-beta.1 — 2026-11-04

首个 3.0 Beta。数据格式已可用，但 Beta 期间可能做向后兼容的微调。

### 新增

- **窗口账本**（`src/window.mjs`）：按轮记录用户原话、助手真正发出去的话、以及 `[[feel]]…[[/feel]]` 包起来的「当时的想法」；想法在发送前剥离，只留在账本里。块级去重（同一段文本只存一份），支持草稿回收与超时清扫。
- **情境段**（`src/episode.mjs` + `src/episode-ai.mjs`）：按 90 分钟间隔切段，少于 4 轮并入上一段，单段最多 40 轮；按 id 幂等 upsert；可选模型摘要（标题/场景/主题/想法）。
- **轮转契约**：`≥ 70% × 上下文窗口` 可自动或手动轮转；`< 70%` 必须人明确批准（`rotate(force, approved)` 与宿主的 reset 端点都做了闸门）。
- **交接首屏**：规则 600 + 事实卡 1500 + 最近一天原话 ≤2400 + 七天摘要，总量由 `handoverMaxChars`（默认 5000）兜底；没有原话时退回提取式摘要。
- **主题树事实卡**（`src/topics.mjs` + `src/card-tree.mjs`）：主题/子主题分组、24 个槽位、同槽留最新、超预算整块丢并注明省略条数。
- **事实卡清洗**（`src/card-hygiene.mjs`）：未闭合括号截断、技术噪声排除、残句过滤、型号归一、跨槽位去重、单值槽位选最完整、多值封顶、事件排序、主体纠偏。只清洗投影，不改真源。
- **写入门三档**（`src/gate.mjs`）：`pass / mark / block`，原因码 `quoted / meta / uncertain / transient / botPref / thin`；`gateMode: broad` 时低置信只写影子。
- **候选池**（`src/candidates.mjs`）：宽进候选先落 `state/candidates.jsonl`（`status=pending`），不进卡、不进检索、不参与打分；日终裁决后才写事实。
- **模型抽取**（`src/extract-model.mjs`）：日终把当天用户消息分批交模型，13 条硬规则 + 5 条语义门（称呼、属性证据、偏好动词、版本/系列、未来计划）过滤；默认关闭，可只写影子。
- **情境抽取**（`src/extract-episode.mjs`）：从情境段里抽候选事实，`quote` 必须是原文逐字子串。
- **分层检索**（`src/retrieval.mjs`）：近 7 天情境 → 近 7 天原话 → 近 30 天情境；二元组 + substring 回退，超短查询（单个汉字）也能命中。
- **v10 记忆属性**（`src/v10.mjs`）：细节/情绪/可信度/碎片与三档语气措辞，`emit` 默认关（关时注入文本与排序逐字节不变）。
- **消费记账**：记忆侧模型调用写 `logs/memory-usage.jsonl`，按 caller 区分（handover / profile / extract / episode / entry）。
- **工作台新面板**：窗口回放、情境索引、主题簇、消费账单（只读接口 `/api/window`、`/api/episodes`、`/api/topics`、`/api/usage`）。
- **隐私扫描**（`scripts/scan-secrets.mjs`）：本机路径、令牌、真实 `private:/group:` 账号、凭据赋值、私钥块；支持 `PRIVATE_WORDS` 追加私人词。

### 变更

- 配置默认值集中到 `src/engine.mjs` 的 `DEFAULTS`：`handoverMaxChars` 默认 5000、事实卡 1500、轮转阈值 0.7、冷却 10 分钟、最小轮转 20000 token。
- 数据目录默认 `~/.deepseek-memory/data`（可用 `QQ_MEMORY_DIR` / `memory.dir` 覆盖），不再从宿主程序目录推导。
- 事实卡优先走主题树投影；没有 `state/topics.jsonl` 或 `profile.tree=false` 时回退旧扁平投影。
- 注入预算与压力阈值按真实 token 计算，拿不到用量时用「已观测最大 × 1.15」估算。
- 工作台端口（7351）、令牌、数据目录、价格表、宿主配置与日志全部改为环境变量/页面可配，不再写死路径。

### 修复

- 超短查询（「鱼」「嗯」）切不出中文二元组时 0 命中 → 空 token 回退 substring。
- 语气摘要长度上限计入「〔语气备忘〕」前缀；同秒多次写备份不再互相覆盖。
- 事实卡省略尾注与卡头重复。
- 主题分类里「大学」等泛词抢先命中，导致具体学校主题永远不命中。

### 已知限制

- 没有随包发布旧日志回填工具；2.x 已有数据可直接读。
- 主题分类以规则为主，跨领域话题需要自己补主题表。
- 日终摘要与模型抽取默认关闭，需自备模型凭据。
- 工作台是单机工具，无多用户/权限模型。

### 测试

- `node --test`：355 个用例全部通过（Node 22 / 24，Windows / Linux）。
- `node scripts/scan-secrets.mjs`：发布树零命中。
