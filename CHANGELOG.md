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

# 更新日志

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
