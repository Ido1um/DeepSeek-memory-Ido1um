# 更新日志

版本号约定：主版本 = 记忆算法/数据模型变更；次版本 = 向后兼容的新能力；修订号 = 修复与文案。
历史版本（1.0–2.1.1）见仓库 Releases 页。

## 3.1.0 — 2026-11-05

在 3.0 的分层之上，把「记忆」从只读投影推进到**可写、可查、可核对**：她自己能记、能改，检索按问法而不是按字面，图片和课表也有结构化落点。数据格式只增不改，3.0 库直接可用。

### 新增

- **自写事实**（`src/self-write.mjs`）：助手通过 MCP 工具 `qq_memory_write` 写一条 `author:'self'`、第一人称原句的事实，进同一套归并/衰减/卡片/检索；配额 `memory.selfWrite{maxPerDay:5, maxTotal:300, maxValueChars:60, maxTextChars:400, initialI:0.7, protectFromExtract:true}`，抽取器遇到同槽位自写单值只补不改。
- **修订留痕**（`src/revise.mjs`）：`qq_memory_edit` 只允许改自写事实，产生 `ev:'revise'` 与 `logs/fact-history.jsonl`（before/after/by/at/reason/revision）；回滚等于再修订一次。
- **问法路由**（`src/route.mjs`）：整句问法 → 槽位 / 主题 / 主体 / 科目 / 日期；`scoring-runner.search` 新增 `match:'smart'`，权重 槽位 8000 > 科目 7000 > 主题 6000 > 词法 ≤1200 > 主体 900，过期 −3000，主体或生日 who 不符再降。
- **召回格式**（`src/recall-format.mjs`）：命中行带 `⟵ 窗口 MM-DD 轮 a–b` 锚点、自写标〔自己写的〕；空结果给出「我把它当成什么 / 相关但已过期 / 只是词面相近 / 下一步」四段诊断。
- **图片记忆**（`src/media.mjs`）：入站图片按 sha1 存 `media/YYYY-MM/<sha1>.<ext>`，索引 `state/media.jsonl`；窗口账本只记 `mediaRefs`，图片字节不进注入。MCP `qq_memory_photo` 按 sha1 取原图，HTTP `GET /api/socialV2/memory-photo`，配置 `memory.media{enabled,maxBytes:8388608,maxPerTurn:6,keepDays:0}`。
- **结构化字段**（`src/entities.mjs`、`src/fields-migrate.mjs`）：事实可带 `entities{people,orgs,places}`（每类 ≤6、总 ≤12）；槽位扩展 `major / exam / course`；课表只在「周几 + 时间/教室 + 课程名」的单条上成立，拼句进 review。
- **课表**（`src/schedule.mjs`）：`state/calendar.json` 记学期/周次/锚点，课程事实带 `course{name,day,start,end,parity,weekFrom,weekTo,location,semester}`；`coursesOn()` 按周几 + 周次 + 单双周过滤，`scheduleAnswer()` 输出「YYYY-MM-DD 周X · 第 N 周（双周）：- 课程｜时间 · 地点」。配置 `memory.schedule.enabled`。
- **窗口缺口回填**（`src/gapfill.mjs`）：入站缓存 `noteInbound/peekInbound/consumeInbound`；日终按 `raw/` 反向核对，把「主人说了但没进账本」的连续消息补成一轮（`fidelity:'reconciled'`、`source:'raw-gap'`），日志 `logs/window-gap.log`；CLI `scripts/repair-window-gaps.mjs --days 3 --write`。配置 `memory.window.gapRepair`。
- **纠正候选**（`src/claims.mjs`）：她说的纠正（含科目/专业代码、非元讨论、非寒暄）落 `state/claims.jsonl` 待确认；确认后写成 `author:'correction'` 事实并退掉旧口径，驳回留审计。配置 `memory.claims`。
- **脚本**：`fix-fake-time.mjs`、`repair-window-gaps.mjs`、`route-preview.mjs`、`migrate-fields.mjs`、`window-reconcile.mjs`。
- **工作台**：`/api/history`、`/api/recall`、`/api/media`、`/api/claims`，新增「检索调试」页签、事实修订链、原图预览、待确认纠正卡片。

### 变更

- 检索结果行补 `source / author / voice / saidAt / expired / topicId`，锚点不再恒为空。
- v10 的 `rankInInject` 改为「结构 rank 优先、激活值 tiebreak」。
- 卡片：子主题的「标题 + 首行」合并为一条并按主题顺序排；「旧事」行预留至多 20% 预算，避免被分额吃光。

### 修复

- **无时间词的计划被编造失效**：旧规则把没有显式时间的事件/计划当成「当天生效、次日失效」，导致「考研目标」这类长期计划第二天变旧事；现在无显式时间词 → `dates: []`、`validUntil: null`，只留 `saidAt`。存量用 `scripts/fix-fake-time.mjs --write` 清理。
- 窗口账本漏记主人消息（尤其纠正与课表）：入站缓存 + 日终反向对账，补写 `fidelity:'reconciled'` 的轮次。
- `episode.segmentTurns` 改为按 `at` 升序，补写行（turn 号大、时间早）不再把情境段切乱。

### 测试

- 479 个用例（相对 3.0.0 新增 93 个，覆盖 13 个新测试文件：self-write / revise / route / route-eval / route-subjects / recall-format / media / window-media / entities / fields-migrate / schedule / gapfill / claims）、验收自检 17 项全部通过。

## 3.0.0 — 2026-11-04

首个正式版。相对 3.0.0-beta.2，修掉三处会让记忆「停在旧账上」的断档；数据格式不变，beta 库直接可用。

### 修复

- **日终不建段**：日终维护原来只摘要「已经存在的段」，从不把当天的窗口账本折叠成段，于是 `episodes/` 停在前一天、条目抽取无段可抽。现在 `src/episode.mjs` 提供 `buildDailyEpisodes(dir, { now, days = 2 })`，按今天和昨天建段（同 id 尾巴变长就合并、`summarized` 重置），`engine.runDailyMaintenance` 在摘要之前调用（`memory.episode.build`，默认开）；条目抽取的日期范围从「只今天」放宽到「今天或昨天」，补上跨夜的尾巴。
- **过期态没派生到卡面**：出卡走的是长期库索引，而索引的 `facts()` 不算 `expired`，于是过期事实仍挂在「现在」区。现在 `createIndex` 内置 `deriveTime()`，每次 `facts()` 都按 `saidAt / validUntil` 现算 `at` 与 `expired`（不缓存，跨天不会错）。
- **改口事件不带时间**：条目抽取产生的 `supersede` 事件原来没有时间字段，新值会顶着旧值的 `validUntil`（旧日期的事被当成今天说的）。现在 `supersede` 带上 `saidAt / dates / validUntil / timePhrase / timeConfidence / birthday`，`longterm` 的 supersede 分支接收这些字段；存量数据用 `scripts/repair-saidat.mjs` 按引文所在轮次重算。

### 新增

- `scripts/rebuild-card.mjs`：按修好的索引重建 `profile.md`（写前备份，打印字数/收录/挤出/主题数）。

### 测试

- 386 个用例（新增 5 个：日终建段 2、索引派生 2、supersede 时间锚 1），验收自检 15 项、沙箱自检 26 项全部通过。

## 3.0.0-beta.2 — 2026-11-04

Beta 2 只做一件事：**把事实的时间放回它被说出口的那一刻**，并让生日成为可查询的日期字段。不改变已有数据格式，老库可直接用。

### 新增

- **事实时间锚**（`src/timeparse.mjs`）：解析「今晚 / 明天 / 上周三 / 11 月 2 日 / 三天后 / 每天」，产出 `dates[]`、`validUntil`、`phrase` 与 `who`（时间词前后 10 字判断说的是谁），时区固定 `+08:00`。
- **生日结构字段**：事实可带 `birthday: { y, m, d, key: 'MM-DD', yearly, who }`，`parseBirthday()` 支持「2007 年 9 月 5 日」「11 月 2 日」「11-02」，`birthdayWho()` 按主语判断属于用户还是助手；句子里同时出现两个人时以助手为准。
- **迁移脚本**：`scripts/migrate-timefields.mjs`（按情境段轮次反查每句话的时间锚，查不到标 `timeUnknown`）与 `scripts/migrate-birthday.mjs`（把文案里的生日补成结构字段，幂等、只追加 `ev:'update'`、写前备份）。
- **验收自检**：`scripts/acceptance-check.mjs`，把数据目录复制到临时目录后逐项检查注入、轮转、卡面、检索、生日字段等 15 项，只读真源。

### 变更

- `materialize()` 用 `at = saidAt || createdAt` 派生事实时间与 `expired`，不再拿写库时间当事实时间。
- 事实卡：过期事实移出「现在」区，每个根主题末尾单列一行「旧事：MM-DD …；…」（最多 3 件）；生日按 `birthday` 字段渲染成「生日：2007年9月5日」，同一人同月日自动去重。
- 检索：`scoring-runner` 增加槽位提示（生日/出生/寿辰 → `birthday`）与 `whoHint`（问「主人/我」优先用户，问「她/助手」优先助手）；检索结果里的旧事标「旧事 · MM-DD」。
- 过期判定不再把生日算进去——生日每年都会回来。

### 修复

- 待办误判：`task` 判定加「元讨论词 / 疑问句 / 过去时间」三道门，过去时的事不再生成待办。
- 「上个 X」按过去、「下个 X」按未来解析，只有不带前缀的「X」才顺延。

### 测试

- 377 个用例全过（新增 `timeparse.test.mjs`、`search-birthday.test.mjs`，扩展 `card-hygiene`、`card-tree`、`due`、`engine`、`retrieval`、`window`）。

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
