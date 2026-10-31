# CHANGELOG

## 2026-10-31 — v9.5：v10「细节与可信度」+ 第二批审计修复

> 把「记得多牢」和「记得多清楚」拆成两个轴。全部行为挂在 `v10.json` 开关后，默认 `enabled:false`，关闭时事件流与注入文本逐字节不变；数据格式只加字段，不回填不迁移。

- **细节完整度 D**：`D_half_eff = base × (1+0.6(C−1)) × (1+0.4E_t) / (1+0.3·min(I,3))`；`hard`/规则/人设/身份类恒为 1；注入时可据此决定说全文、说首句、还是只拼碎片。
- **情绪残留 E**：入站抽取 `emo`（−1..1）、`rel`（是否亲密关系）、`scene`（场景词）；`E_t = |emo|·0.5^(天/半衰期)`，强情绪（|emo|≥0.7）用 365 天半衰期。
- **激活值 A**：`100·I_eff·R + topic/sig/关键词/情绪/新鲜度/线索加分 − 3×同主题干扰`，`I_eff = I·(0.6+0.4C)`；`hard` 保底 80；`salienceFloor` 以下不进注入（默认 0=不启用）。
- **可信度 Q**：`(0.4 quote + 0.2 source + 0.2 人工确认 + 0.2 交叉印证) / (1+0.15 joints)`，三档措辞走 `qLabels`，可改成自己的口吻；`hard` 下限 0.8。
- **片段记忆**：低 D 时只拼 8–20 字的原文子串（不生成、不改写），最多 3 条。
- **检索记账**：只有显式 opt-in 且真正进入注入的条目才写 `retrieved`（同天去重、不涨分）；CLI / MCP 查询不再污染 accessCount。
- **附带修复**：`task` 类到期 +7 天后自动过期；`doctor` 墓碑检查改成真查孤儿、新增「打分配置无未知键」；`token.readTurns` 按会话过滤并兼容无 sid 老日志；`memory-cli status` 去掉死调用；`salienceFloor` 与 `explainFact` 复用 `v10.explain`。
- **测试**：本地全套 163；新增 `test/v10.test.mjs`（16 条，含开关关闭一致性、只记注入条数、D 三档渲染）。

## 2026-10-31 — v9.4：工作台写接口收紧（令牌 / 来源 / 目录体检）

> 写接口从「可选令牌」改成默认强校验，并把 apply 前的目录检查补齐。只动工作台与一处检索语义，数据格式不变。

- **写令牌默认开启**：首次启动生成 `workbench/.workbench-token`（48 位十六进制，0600），服务端注入页面、前端 POST 自动带 `x-workbench-token`；可用 `WORKBENCH_TOKEN` 覆盖，`--no-token` 仅供本地调试。
- **三重闸门**：写请求必须 ① Host 是回环地址（挡 DNS rebinding）② 同源（`origin`/`sec-fetch-site`）③ `Content-Type: application/json`（挡表单 CSRF）。缺令牌 401、跨站 403、错 Host 403、非 JSON 415。
- **`/api/state` 不再下发控制台令牌**：只回 `{port, hasToken}`；点「控制台」时走 `POST /api/console-url` 现取。
- **`/api/config` 校验**：目录必须已存在（先点「创建目录」）、未知键 400、数字/布尔类型错 400（之前 `windowDays:"abc"` 会存成 null）。
- **`/api/fact` 校验**：op 白名单 `invalidate/reinstate/manual/reset/badhit`；id 必须真实存在，否则 404，不写墓碑也不写审计。
- **apply 前目录体检**：空目录或含 `profile.md`/`state`/`rules.md`/`raw` 才放行；明显不是记忆目录 400（`force:true` 可覆盖）；磁盘根目录直接拒。
- **目录校验兼容 POSIX 绝对路径**：isAbsWinPath() 原来只认 C:\\ / \\\\server，Linux 上会把合法目录判成 400（CI 抓到，已修）。
- **检索**：`search({limit:0})` 现在返回空数组，不再静默回退默认条数。
- **测试**：新增 `test/workbench-api.test.mjs`（临时目录 + 随机端口真起服务），覆盖令牌/Host/Content-Type/目录体检/幽灵 id；本地全套 158。

## 2026-10-31 — v9.3：摘要兜底修一个真 bug

- **模型不可用时的提取式兜底会丢旧卡**：旧卡 bullet 是「· 」开头（`card.mjs` 的写法），而兜底只认 `[-*]` 前缀，导致模型失败时旧卡内容被静默丢弃。现在同时认 `·` 并归一成 `- `。
- **补两条从来没跑过的分支**：`summarizeHandover` 窗口内无记录（不联网、不落盘）；`rotate` 在摘要模型失败时**照样换会话**、交接退回提取式并落盘。测试 137 → **140**。

## 2026-10-31 — v9.2：外部评审反馈修复（接线与口径）

> 一位朋友拿 5000 行源码在干净环境实测后给的反馈。逐条核实：6 条成立、2 条需修正、
> 1 条是产品选择。这里修的是「接线」与「口径」，不改数据格式，也不改抽取器的定位。

- **核心真零依赖**：拆掉 `js-yaml`（只用它读 `~/.dsh/.credentials.yaml` 的 `refs.` 段），换成 80 行 `src/miniyaml.mjs`。现在 `node --test` 在**没有 node_modules** 的目录里也能全绿；MCP 服务仍需要 `@modelcontextprotocol/sdk` + `zod`，README 已注明。
- **`composePrompt` 向后兼容**：`(key, text)` 与 `(key, sessionId, text)` 都可用；两参数时自动取当前会话（文档与示例一直写的是两参数）。
- **抽取器四处接线修正**：
  - `以后叫我 X` 归 **user**（之前错记成机器人自己的称呼）；`以后叫你 X` 归 bot。
  - 补 `我叫 X`、`我在 X 上班`（值取硬词**前面**）；之前 `我在工业软件公司上班` 抽不出。
  - 附近主语改为按**距离**取最近（左右 14/8 字），不再按词表顺序。
  - 新增 `skill`（在学什么）、`pet`（养的宠物）；值首量词残留（`只猫叫布丁`）顺手清掉。
- **工作台**：事实卡副标题显示「本次挤出 N 条」；可选 `WORKBENCH_TOKEN` —— 设了以后写接口要带 `x-workbench-token`，没设会在启动日志里明确警告（之前 token 只是拿来拼控制台 URL，等于没有）。
- **测试**：126 → **137**（新增：摘要模型分支 4、到期提醒链路 5、并发追加 2）。
- **CI**：`.github/workflows/test.yml`（Node 22/24 矩阵，**不装依赖**直接 `node --test`，外加 `scan-secrets`）。
- **测试的时区独立性**：三处用例改成相对时间/本地中午锚点（GitHub runner 是 UTC，`+08:00` 字面量会在 UTC-4 下跨自然日）。本地 `TZ=UTC / Asia/Shanghai / America/New_York / Pacific/Kiritimati` 四时区均 137/137。
- **文档**：卡长度改回真实值（默认 1500，可调 200–8000）；补注入预算（规则 600 + 卡 1200 + 待办 200 + 检索 500，总 2500 字）。

## 2026-10-31 — v9.1：审计遗留项的第二批

> 同一轮审计里标为「中/低」但会静默失效的几项，趁热一起修掉。仍然只加行为、不改数据格式。

- **待办会过期了（中）**：`class=task` 截止后 `taskTtlDays`（默认 7 天）仍没结掉 → 软删（`task-overdue`）。此前 task 类稳定度是 Infinity，会永远 active、永远占「进行中」，而过期提醒又不会发。
- **doctor 的墓碑检查不再是 `true` 常量（中）**：真的去比对原文，孤儿墓碑（sidecar 被手改坏 / 事件被截断）会报 ✗；顺手把硬编码的 owner QQ 改成读配置。
- **doctor 会报打分配置的未知键（中）**：拼错的开关（如 `promoteHIt`）不再静默失效，`mode/versioning` 与扁平别名不误报。
- **token 日志按会话过滤不再串会话（低）**：没有 sid 的老行不再混进任何带 sid 的会话；本会话一条都没有时才退回无 sid 行。
- **CLI `status` 去掉对不存在函数的可选调用**：直接读卡文件，少一次 `undefined` 兜底。
- 测试：`node --test` → **126 全过**（新增 `test/v9b.test.mjs`）。

## 2026-10-31 — v9：一次审计后修的 8 个问题

> 上午对「当前方案是否存在 bug」做了一次只读审计（文档 + 代码 + 线上只读复现），
> 结论是线上在跑，但代码里有 1 条高危竞态和几条静默失效。完整记录见 `docs/修复记录-2026-10-31.md`。

- **修状态缓存竞态（高）**：`getState()` 1.5s 后无条件从磁盘重载，而 `saveStateSoon()` 去抖 2s——落在窗口里的写入会被旧值覆盖且不再重放（会话映射回退、注入标记丢失导致卡重复注入）。改为脏时不重载。
- **修降档「回春」（高）**：`tier` 事件不再改 `lastAt`（只写 `updatedAt`）。此前一条 100 天没提的 long 事实降档后会从 8 分反弹到 80，永远沉不下去。
- **修主语不进 sig（高）**：新增 `subjectTag()`，只有「我妈 / 我爸 / 我家」这类非自指主语进 sig/topic；「我妈生日」和「我生日」不再撞同一个键。自指主语保持老键，老数据免迁移。
- **修「这/本」星期与过点提醒（高）**：`reminderWindow` 增加逾期窗口（`reminders.overdueHours`，默认 72h，0=老行为）；不存在的日期（2026-02-30）返回 null；支持 `9:30` 这种只写时刻。
- **四段注入每轮装配（中）**：规则/待办/检索不再只在「注入卡那一轮」出现；卡仍只在首轮或卡更新后带。
- **工作台时间戳统一毫秒（中）**：`manual/manualReset` 事件 `at` 改数字；`materialize` 用 `toMs()` 兼容 ISO；`manualReset` 同时还原 I 与 S；`update` 改期清 `notifiedAt`。
- **卡 hard 额度不再双扣（中）**：hard 用全局 `maxChars` 记账（20 条硬事实从只能进 6 条恢复到 10+）；「我的事」仍受 `botMaxChars` 限额。
- **`trimLines` 改前缀截断（中）**：放不下的行直接停，不再跳过长行去捡后面的短行；预算 ≤0 返回空；摘掉旧尾注避免叠加；不切断代理对。
- 顺手：`s: null` 不再当 0；`fact` 的 `hits` 不再丢；`scoring` 扁平键（`halfLifeLong/promoteHits/promoteScore/demoteFloor`）真正生效；新增 `unknownScoringKeys()`。
- 健康检查的端口探测改为纯 Node TCP（三态 open/refused/blocked），不再用 `netstat` 子进程（受限环境会被沙箱拦住并误报「没在监听」）。
- 测试：`node --test` → **121 全过**（新增 `test/v9.test.mjs`、`test/portprobe.test.mjs`）。
- 截图清理：删除含真实记忆内容的 `facts.png` 与 `starmap.png`，README 只保留不含事实内容的界面截图。

## 2026-10-30 — 新增事实审计 + 修一个误判

- 新增 `scripts/audit-facts.mjs`：把窗口内的原文用当前抽取器重放一遍，和事实库比对，列出"能抽出来却没进库"的消息；按 sig 或值比对，避免回填事实（sig 不同）误报。
- README 增加「日常运维」一节：命令行速查表 + audit 的三种结果怎么读。
- 新增 `docs/排障.md`：它忘了 / 它记错了 / 它不提醒 / 工作台打不开，四类问题各一张流程图。
- 修 `src/facts.mjs` 的 `explicitRemember`：否定语境（记不住 / 不记得 / 无法记住 / 记不清…）不再当成"要求记住"，避免把「人类也无法记住所有事」记成一条备注。
- 测试 109 全过（含否定语境与审计比对的新增回归）。

## 1.0.0（未发布）

> 2026-10-30：项目定名 **DeepSeek-memory-Ido1um**；仓库与 npm 包名若发布只能用小写 `deepseek-memory-ido1um`；**2026-10-30 决定不发布 npm**，以源码方式使用。

首个公开版。

- 四层记忆：原文日志 / 长期事实 / 事实卡投影 / 到期提醒
- 事件流事实库：`fact / mention / tier / manual / expire / invalidate / reinstate`
- 二维打分：`score = 重要性 I × 保持度 R`，`R = 0.5^(未提及天数 / S)`，按类分半衰期
- 四档：`hard`（不衰减）/ `long`（30 天）/ `general`（3 天）/ `temp`（1.5 天）
- 三套预设：保守 / 均衡 / 激进
- 轮转：真实 token ≥ 0.7 × 上下文窗口（无年龄兜底），10 分钟冷却
- 会话三态：`off` / `log`（只记不注入不轮转）/ `full`
- 事实卡投影：硬事实全留 → 高分 long → 新近 long，超限只丢 low score
- 作废 / 恢复：墓碑 + 审计，永不物理删；支持按 id 或语义匹配（多条时拒绝自动决定）
- 到点提醒：`due` 抽取（含中文数字、星期、相对日），提前 24h 推一次、`notifiedAt` 去重
- MCP：`qq_memory_recall`（长期事实）+ `qq_memory_search`（原文）
- 工作台：3D 记忆星图、上下文与轮转、事实卡、长期事实（改档/改分/作废）、记忆方案（三预设）、调控台
- CLI：`status / doctor / recall / card / invalidate / reinstate / search / describe / due / rules / budget / health`
