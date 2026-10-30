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
