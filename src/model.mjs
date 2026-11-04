// 通用模型入口：交接摘要 / 事实卡 / 日终抽取共用一份 key 解析与兼容端点实现。
//
// 与 digest.mjs 原有的 requestModel 完全同源（config.webSearch.apiKey → DEEPSEEK_API_KEY →
// DSH 凭据，Anthropic 兼容端点，thinking 关闭），额外提供两个选项给抽取用：
//   json: true        让调用方以更低温度、更短输出跑「结构化输出」，仍然沿用同一 key/超时链路
//   temperature       显式温度（默认不传，保持摘要行为逐字节不变）
// 任何失败都返回 { ok:false }，调用方永远能降级，不抛异常。
import fs from 'node:fs';
import path from 'node:path';
import { loadSearchConfig, resolveSearchApiKey, memorySection, DEFAULT_DIR } from './config.mjs';

// 记忆侧用量：与聊天共用同一份 logs/ 目录，但单独一个文件，便于把「聊天花销」和「记忆花销」拆开。
function usageFile() {
  // 目录优先级必须与引擎一致（QQ_MEMORY_DIR > config.memory.dir > 默认），
  // 否则沙箱自检/Dry-run 会把用量写进生产日志，污染「记忆花销」统计。
  let dir = '';
  try {
    dir = String(process.env.QQ_MEMORY_DIR || memorySection()?.dir || '');
  } catch {
    /* 配置坏了也落默认目录 */
  }
  return path.join(dir || DEFAULT_DIR, 'logs', 'memory-usage.jsonl');
}

export function recordUsage({ caller = 'model', model = '', ok = false, usage = null, ms = 0, error = '' } = {}) {
  try {
    const file = usageFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const u = usage && typeof usage === 'object' ? usage : {};
    const line = JSON.stringify({
      t: Date.now(),
      k: 'mem',
      caller,
      model,
      ok,
      ms,
      error: error ? String(error).slice(0, 160) : undefined,
      usage: {
        input_tokens: Number(u.input_tokens) || 0,
        output_tokens: Number(u.output_tokens) || 0,
        cache_read_input_tokens: Number(u.cache_read_input_tokens) || 0,
        cache_creation_input_tokens: Number(u.cache_creation_input_tokens) || 0
      }
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    /* 记账失败不能影响记忆本身 */
  }
}

export const DEFAULT_MODEL_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_OUTPUT_CHARS = 1800;

/**
 * 调一次模型，返回 { ok, text, model, source, error, usage, ms }；失败不抛异常。
 */
export async function requestModel({
  system = '',
  userContent = '',
  maxChars = DEFAULT_MAX_OUTPUT_CHARS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  json = false,
  temperature = null,
  maxTokens = 4000,
  model = '',
  caller = 'model'
} = {}) {
  const startedAt = Date.now();
  const searchConfig = loadSearchConfig();
  const { key: apiKey, source } = resolveSearchApiKey(searchConfig);
  if (!apiKey) return { ok: false, error: '没有可用的 DeepSeek API key（config.webSearch.apiKey / DEEPSEEK_API_KEY / DSH 凭据）' };

  const baseURL = String(searchConfig.baseURL || DEFAULT_MODEL_BASE_URL).replace(/\/+$/, '');
  const budget = Math.min(4000, Math.max(300, Number(maxChars) || DEFAULT_MAX_OUTPUT_CHARS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const payload = {
      model: String(model || searchConfig.model || ''),
      max_tokens: Math.min(8000, Math.max(200, Number(maxTokens) || 4000)),
      // 关闭思考：否则长 transcript 下 thinking 会把 max_tokens 吃光，返回里只有 thinking 没有 text。
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: userContent }]
    };
    if (json) {
      // 结构化输出：温度压低、要求只出 JSON（兼容端点不保证支持 response_format，靠 prompt 约束）。
      payload.temperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0;
      payload.system = `${system}\n\n只输出一个 JSON 数组，不要 Markdown 代码围栏，不要任何解释文字。`;
    } else if (Number.isFinite(Number(temperature))) {
      payload.temperature = Number(temperature);
    }

    const res = await fetch(`${baseURL}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = `HTTP ${res.status} ${String(body).replace(/\s+/g, ' ').slice(0, 200)}`;
      recordUsage({ caller, model: payload.model, ok: false, ms: Date.now() - startedAt, error });
      return { ok: false, error, ms: Date.now() - startedAt };
    }
    const data = await res.json().catch(() => null);
    const text = (Array.isArray(data?.content) ? data.content : [])
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
      .trim();
    if (!text) {
      const kinds = (Array.isArray(data?.content) ? data.content : []).map((b) => b?.type).filter(Boolean).join(',') || '空';
      const stop = data?.stop_reason ? `，stop_reason=${data.stop_reason}` : '';
      const error = `模型没有返回文本（blocks=${kinds}${stop}）`;
      recordUsage({ caller, model: payload.model, ok: false, usage: data?.usage, ms: Date.now() - startedAt, error });
      return { ok: false, error, ms: Date.now() - startedAt };
    }
    recordUsage({ caller, model: payload.model, ok: true, usage: data?.usage, ms: Date.now() - startedAt });
    return {
      ok: true,
      text: text.slice(0, budget),
      model: String(model || searchConfig.model || ''),
      source,
      usage: data?.usage || null,
      ms: Date.now() - startedAt
    };
  } catch (error) {
    const name = error?.name;
    recordUsage({ caller, model, ok: false, ms: Date.now() - startedAt, error: name === 'AbortError' ? `模型超时（${timeoutMs}ms）` : String(error?.message ?? error) });
    return {
      ok: false,
      error: name === 'AbortError' ? `模型超时（${timeoutMs}ms）` : String(error?.message ?? error),
      ms: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }
}
