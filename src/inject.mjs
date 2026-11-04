// 注入装配（v8 批 3）：把「规则 / 事实卡 / 待办 / 相关记忆」四段拼进 prompt，总字数有预算。
//
// 为什么要预算：卡 1500 字 + 交接摘要 3500 字 + 检索片段，长会话里每轮都在重复烧 token，
// 而 token 成本随 prompt 线性涨（KV 缓存不会给你 O(1)）。所以给定死预算，超了就按优先级丢。
//
// 优先级：规则（手写）> 硬事实 > 待办 > 其余卡的条目 > 检索补充。
// 铁律：**硬事实永远不因为预算被丢**；真的超了就让总长超一点，并在日志里记下来。
import { trimLines } from './rules.mjs';

export const INJECT_BUDGET = {
  rules: 600,
  card: 1500,
  tasks: 200,
  retrieval: 500,
  total: 2800
};

const clampInt = (v, lo, hi, dft) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dft;
  return Math.min(hi, Math.max(lo, n));
};

export function normalizeInject(raw = {}) {
  const b = raw && typeof raw.budget === 'object' ? raw.budget : raw || {};
  const budget = {
    rules: clampInt(b.rules, 0, 2000, INJECT_BUDGET.rules),
    card: clampInt(b.card, 0, 4000, INJECT_BUDGET.card),
    tasks: clampInt(b.tasks, 0, 1000, INJECT_BUDGET.tasks),
    retrieval: clampInt(b.retrieval, 0, 2000, INJECT_BUDGET.retrieval),
    total: clampInt(b.total, 200, 8000, INJECT_BUDGET.total)
  };
  return {
    enabled: raw?.enabled === true,
    budget,
    // 中文按 1.4 token/字做保守估计（实测口径见 docs，真实值用 usage 校准）
    charsPerToken: Number.isFinite(Number(raw?.charsPerToken)) && Number(raw.charsPerToken) > 0 ? Number(raw.charsPerToken) : 1.4
  };
}

export function estimateTokens(text, charsPerToken = 1.4) {
  const chars = String(text ?? '').length;
  return Math.ceil(chars / Math.max(0.2, Number(charsPerToken) || 1.4));
}

/**
 * 组装四段。每段先按自己的预算裁，再按总预算裁（从最低优先级的段开始丢）。
 * @param {{rulesText?:string, cardText?:string, taskLines?:string[], retrievalLines?:string[]}} parts
 */
export function assemble(parts = {}, rawBudget = INJECT_BUDGET) {
  const budget = { ...INJECT_BUDGET, ...(rawBudget || {}) };
  const sections = [];
  const used = { rules: 0, card: 0, tasks: 0, retrieval: 0 };

  const rulesTrim = trimLines(parts.rulesText || '', budget.rules);
  if (rulesTrim.text) {
    sections.push({ name: 'rules', text: rulesTrim.text, chars: rulesTrim.chars, truncated: rulesTrim.truncated });
    used.rules = rulesTrim.chars;
  }

  // 卡片：只按长度裁（卡内部已按 hard→高分→新近 排序，硬事实天然在最前）
  const cardTrim = trimLines(parts.cardText || '', budget.card, {
    note: (n) => `\n…（其余 ${n} 条已省略）`
  });
  if (cardTrim.text) {
    sections.push({ name: 'card', text: cardTrim.text, chars: cardTrim.chars, truncated: cardTrim.truncated });
    used.card = cardTrim.chars;
  }

  const taskList = (parts.taskLines || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (taskList.length) {
    const head = '【待办】\n';
    const body = trimLines(taskList.join('\n'), Math.max(0, budget.tasks - head.length));
    if (body.text) {
      const text = head + body.text;
      sections.push({ name: 'tasks', text, chars: text.length, truncated: body.truncated });
      used.tasks = text.length;
    }
  }

  const retrieval = (parts.retrievalLines || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (retrieval.length) {
    const head = '【相关记忆】\n';
    const body = trimLines(retrieval.join('\n'), Math.max(0, budget.retrieval - head.length));
    if (body.text) {
      const text = head + body.text;
      sections.push({ name: 'retrieval', text, chars: text.length, truncated: body.truncated });
      used.retrieval = text.length;
    }
  }

  // 总预算：从最低优先级开始丢整段（检索 → 待办 → 卡的非首段）
  let total = sections.reduce((n, s) => n + s.chars + 2, 0);
  const order = ['retrieval', 'tasks'];
  while (total > budget.total) {
    const victim = order.shift();
    const idx = victim ? sections.findIndex((s) => s.name === victim) : -1;
    if (idx >= 0) {
      total -= sections[idx].chars + 2;
      used[victim] = 0;
      sections.splice(idx, 1);
      continue;
    }
    break;
  }

  const shrunk = shrinkToTotal(sections, used, budget);
  const text = shrunk.sections.map((s) => s.text).join('\n\n');
  return {
    text,
    sections: shrunk.sections,
    used: shrunk.used,
    total: text.length,
    tokens: estimateTokens(text),
    overflow: Math.max(0, text.length - budget.total)
  };
}

/** 总预算真的不够时：先裁卡（保留头部=硬事实），再裁规则，最后才允许超。 */
function shrinkToTotal(sections, used, budget) {
  let total = sections.reduce((n, s) => n + s.chars + 2, 0);
  const shrink = (name, allowed) => {
    const idx = sections.findIndex((s) => s.name === name);
    if (idx < 0 || allowed <= 0) return;
    const trimmed = trimLines(sections[idx].text, allowed);
    total -= sections[idx].chars - trimmed.chars;
    sections[idx] = { ...sections[idx], text: trimmed.text, chars: trimmed.chars, truncated: trimmed.truncated + (sections[idx].truncated || 0) };
    used[name] = trimmed.chars;
  };
  // 规则是人工真值，优先保留；先裁卡到「总预算减去其它段已占用」
  if (total > budget.total) {
    const others = used.rules + used.tasks + used.retrieval;
    shrink('card', budget.total - others - 4);
  }
  if (total > budget.total) {
    shrink('tasks', 0);
    shrink('retrieval', 0);
  }
  if (total > budget.total) {
    shrink('rules', Math.max(0, budget.total - 8));
  }
  return { total, sections, used };
}