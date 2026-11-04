# 记忆工作台

本地单页看板：左边选功能，右边只渲染一个面板。展示记忆的真实状态，也能改目标配置（写操作要令牌）。

- 地址：`http://127.0.0.1:7351`
- 只监听本机，零第三方依赖（只用 Node 内置模块）
- 数据目录默认 `~/.deepseek-memory/data`，可用 `WORKBENCH_DIR` 或页面上的「记忆文件路径」改

## 面板

| 面板 | 看什么 |
|---|---|
| 记忆星图 | 事实的三维分布（按主题/档位/激活值），拖动转视角、滚轮缩放、点击看详情 |
| 上下文与轮转 | 当前会话 token 压力、轮转阈值、上次轮转与交接摘要 |
| 事实卡 | 注入用的事实卡正文、字数、被省略的条目数 |
| 记忆库 | 原文日志、按天浏览、关键词搜索 |
| 长期事实 | 事实事件流折叠后的当前状态，可改档、改分、作废、恢复 |
| 会话与策略 | 每个会话 key 的开关（记录/注入/暂停） |
| 调控台 | 目标配置与运行时差异（只列不一致项，不直接改宿主配置） |
| 记忆方案 | 方案文档索引与当前参数说明 |
| 窗口回放 | 窗口账本：每轮用户原话、助手发言、当时的想法（`[[feel]]`） |
| 情境索引 | 按 90 分钟切出的话题段（标题/场景/主题/想法） |
| 主题簇 | 主题树与槽位，看每个主题下有哪些事实 |
| 消费账单 | 记忆侧模型调用的 token 与费用（按分时价格） |

## 启动

```bash
# 前台（关窗口即停）
node workbench/server.mjs --port 7351
```

Windows：双击 `start.cmd`（前台）或 `open.vbs`（无窗口，起服务 + 开浏览器）。

停止后台进程：`stop.cmd`（内部 `stop.ps1`，只杀带 `workbench\server.mjs` 的 node）。

同时起多个实例时：

```powershell
$env:WORKBENCH_PORT='7352'
$env:WORKBENCH_DESIRED='C:\tmp\wb-desired.json'   # 别写正式配置
node workbench/open.mjs
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `WORKBENCH_PORT` | 端口，默认 7351 |
| `WORKBENCH_DIR` | 记忆数据目录（等价于页面里的路径） |
| `WORKBENCH_DESIRED` | 目标配置文件路径，默认 `workbench/config.json` |
| `WORKBENCH_TOKEN` | 写操作令牌；不设则读 `workbench/.workbench-token`，没有就自动生成 |
| `WORKBENCH_NO_OPEN=1` | 只起服务，不开浏览器 |
| `WORKBENCH_BRIDGE_CFG` | 可选：宿主 config.json（读 `memory` 段与轮转参数） |
| `WORKBENCH_BRIDGE_LOG` | 可选：宿主日志（统计降级次数） |
| `WORKBENCH_PRICE_MODULE` | 可选：价格表模块 URL（`file:///...`），用于账单计价 |

## 只读还是可写

- 读：所有 `/api/*` 的 GET 都是只读投影，不会改数据目录。
- 写：只有少数端点（改目标配置、v10 开关、事实档位）需要令牌，且写前备份、tmp+rename 原子替换。
- 令牌只在本机用；`/api/state` 不会回传令牌。

`--no-token` 会关掉写操作校验，只适合本机临时调试（启动日志会警告）。
