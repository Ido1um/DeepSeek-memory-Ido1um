# 接到 DSH（DeepSeek Harness）上

这份说明只讲「把记忆接进 DSH 会话」这一件事。不依赖任何 QQ 组件，纯本地。

> 前提：Node ≥ 22.13；DSH 桌面版能正常启动（记忆本身不需要改 DSH 源码）。

## 0. 三种接法，先选一个

| 接法 | 适合谁 | 要改什么 | 难度 |
|---|---|---|---|
| **A. MCP 只读检索** | 只想让模型能「查以前说过什么」 | 加一个 MCP server 配置 | ★ |
| **B. 外部宿主（推荐起步）** | 有自己的一层桥/机器人程序 | 在你的宿主里 import `engine` | ★★ |
| **C. DSH 插件直连** | 想让 DSH 会话自己就带记忆 | 写一个 host plugin（本仓库不含） | ★★★ |

A 十分钟能用，B 是完整能力（注入 + 轮转 + 提醒），C 仍在演进的方案（见 `docs/roadmap.md`）。

---

## A. MCP 只读检索（最小可用）

1. 建数据目录并导入：

```bash
dsh-memory init --dir "%USERPROFILE%\.deepseek-memory\data"
```

2. 在 DSH profile 的 `cordis.patch.yml` 里加一个 MCP server（路径换成你的实际位置）：

```yaml
- id: memory-mcp
  name: '@deepseek-ai/dsh-mcp'
  config:
    servers:
      deepseek-memory:
        command: node
        args: ['D:/path/to/deepseek-memory-ido1um/src/mcp-server.mjs']
        env:
          QQ_MEMORY_DIR: 'C:/Users/<你>/.deepseek-memory/data'
```

3. 重启 DSH，模型就多了两个工具：

- `qq_memory_recall` —— 查**长期事实**（生日、喜好、约定）
- `qq_memory_search` —— 查**聊天原文**（最近 7 天）

> MCP 子进程只在 DSH 启动时注册工具，改完必须重启 DSH。

---

## B. 外部宿主接入（完整能力）

你的宿主需要提供 6 个回调（都能用空实现先跑起来）：

```js
import { createMemoryEngine } from 'deepseek-memory-ido1um/engine';
import { createNullHost } from 'deepseek-memory-ido1um/host';

const engine = createMemoryEngine({
  getConfig: () => require('./config.json').memory,
  host: {
    ...createNullHost(),
    log: (...a) => console.log('[memory]', ...a),
    listSessions: () => Object.keys(sessions),          // 需要轮转的会话
    getSessionId: (key) => sessions[key]?.id || '',
    retireSession: (id) => { /* 让宿主换一个新会话 */ },
    onReminders: (list) => { /* 到点提醒：发给用户 */ },
  },
});
```

三个接入点（顺序重要）：

```js
// ① 收到消息：先记
engine.onInbound(key, text);

// ② 拼 prompt：取注入
const inj = engine.composePrompt(key, text);
const prompt = [inj.text, userText].filter(Boolean).join('\n\n');
// 宿主接受这条 prompt 之后：
engine.commitInjections(key, prompt);

// ③ 起定时器（日终维护 + 到点提醒）
engine.startMaintenance();
```

### 检查是否接对了

```bash
dsh-memory doctor          # 10 项：长期库可解析 / id 唯一 / 末行完整 / 卡未超限 / 备份 …
dsh-memory status          # 档位分布、日终时间、窗口、轮转阈值
dsh-memory health          # 服务在不在、日终是否新鲜（<26h）
```

第一周建议 `scoring.mode = "shadow"`：只采样、不写长期库，确认抽取质量后再改 `"write"`。

---

## C. DSH 会话直连（实验性）

思路：写一个 host plugin，在 DSH 会话的 `session/event` 里取用户消息、在发 prompt 前用 `agent.inject` 塞入事实卡、上下文到阈值时用 `sessions.open` 起新会话。

已核实的 DSH 接口：`session/event`、`agent.inject` / `agent.steer`、`ctx.agents.create`、客户端 `sessions.open`。**未做 POC**的两点：注入时序、自动切新会话。

在 POC 跑通前，建议停在 B。

---

## 常见问题

**Q：工作台打不开？**
`node workbench/server.mjs --port 7351`，然后看控制台有没有报错；端口被占它会自动 +1，日志里会写实际端口。

**Q：事实卡一直不更新？**
卡是「库的投影」，只在日终（默认 23:00）或手动 `dsh-memory refresh-card` 时重排。改完事实想立刻看到，跑一次 `refresh-card`。

**Q：客户端里看不到新注入？**
卡对每个会话只注入一次；长会话不会自动重注入，要靠 `profile.reinjectOnUpdate`（默认开）在卡变化后补一次，或等轮转。

**Q：换电脑要带走什么？**
带走**数据目录**（`raw/ state/ profile.md rules.md`）和 `config.json` 的 `memory` 段；代码重新 `git clone` 即可。
