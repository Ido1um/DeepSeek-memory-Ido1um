// 真实 token 与窗口取值（v7 §5.1 / §6）。
//
// 为什么不用 chars/3：那是「桥接自己记下的消息正文」的估算，和 DSH 真正喂给模型的
// prompt 差一个数量级（实测 12,768 字 ≈ 4,256，而真实 prompt 是 271,807）。
// token-usage.jsonl 里 `k === 'turn'` 的行，`b.cacheMiss + b.cacheHit` 就是那一轮的真实输入。
//
// 窗口三级取值：config.contextWindowTokens > 模型元数据 > 已观测最大成功输入 × 1.15。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_RECENT_TURNS = 5;
export const OBSERVED_RATIO = 1.15;
const TAIL_BYTES = 512 * 1024;

export function tokenLogPath(dir) {
  return path.join(String(dir || ''), 'logs', 'token-usage.jsonl');
}

/** 只读文件尾部，避免整份日志（几十 MB）进内存。 */
export function readTail(file, maxBytes = TAIL_BYTES) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      // 从中间截断时，丢掉半行。
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      return text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** 解析一行 token-usage。只认 k==='turn'（`base` 行是累计值，混进来会算成几千万）。 */
export function parseTurnLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  try {
    const r = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!r || r.k !== 'turn') return null;
    const b = r.b || {};
    const cacheMiss = Number(b.cacheMiss) || 0;
    const cacheHit = Number(b.cacheHit) || 0;
    const tokens = cacheMiss + cacheHit;
    if (!(tokens > 0)) return null;
    return {
      ts: Number(r.t) || 0,
      sid: String(r.sid || ''),
      turn: Number(r.turn) || 0,
      step: Number(r.step) || 0,
      tokens,
      cacheMiss,
      cacheHit
    };
  } catch {
    return null;
  }
}

/**
 * 按时间顺序返回 turn 记录（可选按 sessionId 过滤）。
 *
 * 过滤语义：有 sid 的行只认本会话；老日志里没有 sid 的行不能混进别的会话（否则 A 会话的
 * 轮转判断会拿 B 会话的 token 去比阈值）。所以先取精确匹配；一条都没有时，才退回「无 sid 行」。
 */
export function readTurns(dir, { sessionId = '', limit = 4000 } = {}) {
  const text = readTail(tokenLogPath(dir));
  if (!text) return [];
  const all = [];
  for (const line of text.split(/\r?\n/)) {
    const t = parseTurnLine(line);
    if (t) all.push(t);
  }
  let out = all;
  if (sessionId) {
    const exact = all.filter((t) => String(t.sid || '') === String(sessionId));
    out = exact.length ? exact : all.filter((t) => !t.sid);
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/** 某会话最近 N 轮的真实 prompt token：{latest, maxRecent, recent[], samples}。 */
export function realTokens(dir, sessionId, { recent = DEFAULT_RECENT_TURNS } = {}) {
  const turns = readTurns(dir, { sessionId });
  const rows = turns.slice(-Math.max(1, recent));
  const values = rows.map((r) => r.tokens);
  return {
    latest: values.length ? values[values.length - 1] : 0,
    maxRecent: values.length ? Math.max(...values) : 0,
    recent: values,
    samples: turns.length,
    lastAt: rows.length ? rows[rows.length - 1].ts : 0
  };
}

/** 全库见过的最大真实输入（成功跑完的一轮就说明窗口至少这么大）。 */
export function observedMax(dir) {
  return readTurns(dir).reduce((max, r) => (r.tokens > max ? r.tokens : max), 0);
}

/** 窗口三级取值。 */
export function readContextWindow({ config = {}, dir = '', modelWindow = 0, ratio = OBSERVED_RATIO } = {}) {
  const configured = Math.round(Number(config.contextWindowTokens) || 0);
  if (configured > 0) return { tokens: configured, source: 'config' };
  const meta = Math.round(Number(modelWindow) || 0);
  if (meta > 0) return { tokens: meta, source: 'meta' };
  const observed = observedMax(dir);
  if (observed > 0) return { tokens: Math.round(observed * ratio), source: 'observed', observed };
  return { tokens: 0, source: 'unknown' };
}

/**
 * 从 DSH sessions.list 的结果里取某个会话的上下文压力（权威值）。
 * 比扫 token-usage.jsonl 更稳：一次 list 就能拿到全部会话，且不会因为
 * 「映射会话被 DSH 清掉」而读不到——那种情况这里返回 0，由调用方回落日志。
 */
export function pressureOf(list, sessionId) {
  const items = Array.isArray(list) ? list : (list?.items || []);
  if (!sessionId) return { tokens: 0, window: 0, source: '' };
  for (const it of items) {
    const id = it?.sessionId || it?.id;
    if (id !== sessionId) continue;
    const pressure = it?.projections?.values?.contextPressure || {};
    const tokens = Number(pressure.pressureTokens) || 0;
    const window = Number(pressure.contextWindow) || 0;
    return { tokens, window, source: tokens > 0 ? 'dsh' : '' };
  }
  return { tokens: 0, window: 0, source: '' };
}

/**
 * 轮转判据（v7 §5.1）：trigger = max(最近 5 轮真实 token) >= 0.7 × 窗口。
 * 没有任何年龄兜底。
 *
 * pressureTokens：DSH 报的上下文压力（权威）。>0 时直接用它，不再扫日志；
 * 拿不到（会话不存在 / DSH 未就绪）才回落 token-usage.jsonl 的 turn 行。
 */
export function rotationDecision({
  config = {},
  dir = '',
  sessionId = '',
  lastRotateAt = 0,
  now = Date.now(),
  modelWindow = 0,
  pressureTokens = 0,
  pressureWindow = 0,
  minRotateTokens = 20000,
  thresholdRatio = 0.7,
  cooldownMs = 600000,
  recent = DEFAULT_RECENT_TURNS
} = {}) {
  const window = readContextWindow({ config, dir, modelWindow: modelWindow || pressureWindow });
  const real = pressureTokens > 0
    ? { latest: pressureTokens, maxRecent: pressureTokens, recent: [], samples: 1, lastAt: now, source: 'dsh' }
    : realTokens(dir, sessionId, { recent });
  const threshold = window.tokens > 0 ? Math.round(window.tokens * thresholdRatio) : 0;
  const tokensOk = window.tokens > 0 && real.maxRecent >= threshold;
  const floorOk = real.maxRecent >= Math.max(0, Number(minRotateTokens) || 0);
  const coolOk = now - (Number(lastRotateAt) || 0) >= Math.max(0, Number(cooldownMs) || 0);
  return {
    due: tokensOk && floorOk && coolOk,
    reason: tokensOk && floorOk && !coolOk ? 'cooldown' : tokensOk && floorOk ? 'tokens' : '',
    threshold,
    window,
    real,
    tokensOk,
    floorOk,
    coolOk
  };
}

/** 给日志/doctor 用的一句话。 */
export function describeWindow({ config = {}, dir = '', modelWindow = 0, thresholdRatio = 0.7 } = {}) {
  const w = readContextWindow({ config, dir, modelWindow });
  const threshold = w.tokens > 0 ? Math.round(w.tokens * thresholdRatio) : 0;
  return { ...w, threshold, thresholdRatio };
}
