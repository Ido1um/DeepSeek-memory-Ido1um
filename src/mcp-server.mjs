// 独立记忆 MCP server（stdio）：只做「查历史原文」这一件事。
//
// 与桥接内置的 memory-search 端点等价，但直接读本地日志（raw/hot + raw/archive），
// 不依赖 qq-bridge 常驻，也不需要在 DSH 里配置桥接令牌。
//
// 注意：stdio MCP 由 DSH 在启动时 spawn，改完这里要重启 DSH 才会出现新工具。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ownerQQ } from './config.mjs';
import { memorySection } from './config.mjs';
import { memoryStats, searchMessages, windowBounds } from './store.mjs';
import { materializeWithShadow } from './longterm.mjs';
import { normalizeScoring, search as searchFacts } from './scoring-runner.mjs';

const TIER_LABEL = { hard: '硬事实', long: '长期', general: '一般', temp: '临时' };

const server = new McpServer({ name: 'deepseek-memory', version: '0.1.0' });

function formatItem(it) {
  const who = it.role === 'assistant' ? `助手` : it.sender || '用户';
  const text = String(it.text || '').replace(/\s+/g, ' ').slice(0, 600);
  return `[${it.date || it.ts}] ${who}：${text}`;
}

server.tool(
  'qq_memory_search',
  [
    '检索 7 天记忆日志里的历史聊天原文（只查用户私聊；群聊不记录）。',
    '什么时候用：聊到很久以前、想不起具体细节；需要确认「以前说过/答应过什么」；用户问「你还记得…」。',
    '用法：query 用 2~3 个不同关键词（空格分隔，任一命中即返回，命中越多排越前）；',
    'from/to 可省略（默认最近 8 个日文件，自动包含归档）；limit 默认 5，最多 20。',
    '查到后引用时说明「查到以前的记录」；找不到就直说找不到，不要编造。'
  ].join('\n'),
  {
    key: z.string().optional().describe('会话 key，默认 private:<用户QQ>；本工具只允许用户私聊'),
    query: z.string().optional().describe('关键词，空格分隔多个（任一命中即算，最多 8 个）'),
    from: z.string().optional().describe('起始日期 YYYY-MM-DD'),
    to: z.string().optional().describe('结束日期 YYYY-MM-DD'),
    limit: z.number().optional().describe('最多返回几条，默认 5，上限 20')
  },
  async ({ key, query, from, to, limit }) => {
    try {
      const wantKey = String(key || `private:${ownerQQ()}`).trim();
      const allowed = `private:${ownerQQ()}`;
      if (wantKey !== allowed) {
        return { content: [{ type: 'text', text: `只允许检索 ${allowed}（群聊与他人私聊不落盘）。` }], isError: true };
      }
      const items = searchMessages({ key: wantKey, query: query || '', from: from || '', to: to || '', limit });
      const stats = memoryStats();
      if (!items.length) {
        return {
          content: [{
            type: 'text',
            text: `没有检索到「${query ? query : '(空)'}」对应记录（日志：${stats.hotFiles} 个热文件 / ${stats.archiveFiles} 个归档，窗口 ${windowBounds().startDay} 起）。找不到就直说找不到，不要编。`
          }]
        };
      }
      const header = `检索「${query || '(空)'}」命中 ${items.length} 条（窗口 ${windowBounds().startDay} 起，含归档）：`;
      const body = items.map(formatItem).join('\n');
      return { content: [{ type: 'text', text: `${header}\n${body}\n（以上是日志原文，引用时说明「查到以前的记录」，不要改写成新事实。）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `历史检索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_recall',
  [
    '在长期事实库里找「用户说过的事实/约定」（生日、喜好、答应过的事、我的设定等），按档位排序：硬事实 > 长期 > 一般 > 临时。',
    '什么时候用：要回答「我以前说过什么」「你记不记得我…」；回答关于用户偏好/约定/生日的问题之前。',
    '和 qq_memory_search 的分工：这个是**提炼过的事实**，那个是**聊天原文**。事实不够再翻原文。',
    'query 留空 = 按档位列最前面的几条；带 query = 只返回真命中（值/原文/标签/模式任一包含）。',
    '被作废的事实默认不返回；确有必要看墓碑时传 includeInvalidated=true。'
  ].join('\n'),
  {
    query: z.string().optional().describe('关键词，例如「生日」「酸奶」「婚纱照」'),
    limit: z.number().optional().describe('最多返回几条，默认 8，上限 20'),
    includeInvalidated: z.boolean().optional().describe('是否包含已作废的事实（默认 false）')
  },
  async ({ query, limit, includeInvalidated }) => {
    try {
      const now = Date.now();
      const scoring = normalizeScoring(memorySection()?.scoring || {});
      const facts = materializeWithShadow();
      const rows = searchFacts({
        query: query || '',
        limit: Math.max(1, Math.min(20, Number(limit) || 8)),
        now,
        scoring,
        includeInvalidated: Boolean(includeInvalidated),
        facts
      });
      if (!rows.length) {
        const active = facts.filter((f) => f.status === 'active').length;
        return {
          content: [{
            type: 'text',
            text: `长期库里没有${query ? `「${query}」的` : ''}记录（现有 ${active} 条有效事实）。可以再用 qq_memory_search 翻聊天原文。`
          }]
        };
      }
      const body = rows.map((f) => {
        const tier = TIER_LABEL[f.tier] || f.tier;
        const value = String(f.value || f.text || '').replace(/\s+/g, ' ').slice(0, 120);
        const label = f.label ? `${f.label}：` : '';
        return `· [${tier} ${Math.round(Number(f.score) || 0)}] ${label}${value}`;
      }).join('\n');
      const header = `长期库「${query || '(全部)'}」命中 ${rows.length} 条（按档位/分数排序）：`;
      return { content: [{ type: 'text', text: `${header}\n${body}\n（这些是长期事实，引用时保持一致；和用户最新的话冲突时以最新的话为准。）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `长期库检索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
