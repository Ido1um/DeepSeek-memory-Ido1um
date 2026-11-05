// 记忆 3.1 · P0b（D1）：窗口缺口止血
//
// 事故（2026-11-05）：窗口账本 missing 了 11-04 的两整段对话，旧的 reconcile 只查
// 「窗口里的消息在聊天记录里有没有」（notInRaw），查不出「聊天记录里有、窗口里没有」。
// 这里补上反向核对，并能把 raw 里的缺口重建为账本行：
//   fidelity:'reconciled'、source:'raw-gap'，只放用户原话与「她发出去的话」，
//   不伪造内部想法，也不写 window（那一轮的注入块已经无从考证）。
//
// 读取：raw/hot/<YYYY-MM-DD>/<safeKey>.jsonl（当天）与 raw/archive/<YYYY-MM>/<safeKey>-<day>.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import { readTurns, nextTurnNumber, sha1, nowIso, stripFeels } from './window.mjs';

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayStr(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function safeKey(key) {
  return String(key ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** 列出最近 days 天可能含这个 key 的 raw 文件。只读、不依赖 store 的内部状态。 */
export function rawFiles({ dir = '', key = '', days = 2, now = Date.now() } = {}) {
  const root = String(dir || '');
  const k = safeKey(key);
  const out = [];
  const cutoff = dayStr(Number(now) - Math.max(1, Number(days) || 1) * 86400000);
  try {
    for (const day of fs.readdirSync(path.join(root, 'raw', 'hot'))) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < cutoff) continue;
      const file = path.join(root, 'raw', 'hot', day, `${k}.jsonl`);
      if (fs.existsSync(file)) out.push(file);
    }
  } catch {
    // 没有 hot 目录就是没有新消息
  }
  try {
    for (const month of fs.readdirSync(path.join(root, 'raw', 'archive'))) {
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      for (const name of fs.readdirSync(path.join(root, 'raw', 'archive', month))) {
        const m = new RegExp(`^${k}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`).exec(name);
        if (!m || m[1] < cutoff) continue;
        out.push(path.join(root, 'raw', 'archive', month, name));
      }
    }
  } catch {
    // 没有 archive 目录属正常
  }
  return out.sort();
}

/** 读 raw 行，统一成 {at, role, text, msgId}；坏行/空文本跳过。 */
export function readRawRows({ dir = '', key = '', days = 2, fromMs = 0, toMs = Date.now(), now = Date.now() } = {}) {
  const rows = [];
  for (const file of rawFiles({ dir, key, days, now })) {
    for (const line of readJsonl(file)) {
      const at = Date.parse(String(line?.ts ?? ''));
      if (!Number.isFinite(at)) continue;
      if (fromMs && at < fromMs) continue;
      if (toMs && at > toMs) continue;
      const text = String(line?.text ?? '').trim();
      if (!text) continue;
      rows.push({
        at,
        role: String(line?.role || (line?.source === 'incoming' ? 'user' : 'assistant')),
        text,
        msgId: String(line?.messageId ?? '')
      });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

function knownSets(rows = []) {
  const ids = new Set();
  const hashes = new Set();
  for (const r of rows) {
    for (const id of r?.userRaw?.msgIds || []) ids.add(String(id));
    for (const line of String(r?.userRaw?.text || '').split('\n')) {
      const t = line.trim();
      if (t) hashes.add(sha1(t));
    }
  }
  return { ids, hashes };
}

/**
 * 把 raw 行重新组轮：连续的用户消息为一轮（QQ 会合批），其间她发出去的话算 spoken。
 * 没有 reply（那批内部想法 raw 里没有），也不猜测。
 */
export function buildGapTurns(rawRows = [], { existingRows = [] } = {}) {
  const { ids, hashes } = knownSets(existingRows);
  const turns = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.users.length) turns.push(cur);
    cur = null;
  };
  for (const r of rawRows) {
    if (r.role === 'user') {
      const h = sha1(r.text);
      if ((r.msgId && ids.has(r.msgId)) || hashes.has(h)) continue;
      cur = cur || { at: r.at, users: [], msgIds: [], spoken: [] };
      // 上一段已经有她发出去的话 → 这是新的一轮
      if (cur.spoken.length) {
        flush();
        cur = { at: r.at, users: [], msgIds: [], spoken: [] };
      }
      cur.users.push(r.text);
      if (r.msgId) cur.msgIds.push(r.msgId);
    } else if (r.role === 'assistant' && cur) {
      const text = stripFeels(r.text).text.trim();
      if (text) cur.spoken.push(text);
    }
  }
  flush();
  return turns.map((t) => ({
    at: t.at,
    userText: t.users.join('\n'),
    msgIds: t.msgIds,
    spoken: t.spoken,
    chars: t.users.join('\n').length
  }));
}

/** 把重建出来的轮次追加进账本。幂等：同一 msgId / 同一原话 hash 已存在就跳过。 */
export function appendReconciledTurns({ dir = '', key = '', sessionId = '', turns = [] } = {}) {
  if (!dir || !sessionId || !Array.isArray(turns) || !turns.length) return { added: 0, skipped: turns.length, turns: [] };
  const existing = readTurns(dir, sessionId);
  const { ids, hashes } = knownSets(existing);
  const file = path.join(String(dir), 'window', String(sessionId), 'turns.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const added = [];
  let skipped = 0;
  for (const t of turns) {
    const lines = String(t.userText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const fresh = [];
    for (const line of lines) {
      if (hashes.has(sha1(line))) continue;
      fresh.push(line);
    }
    if (!fresh.length) {
      skipped += 1;
      continue;
    }
    const userText = fresh.join('\n');
    const turn = nextTurnNumber(dir, sessionId, { key: String(key || '') });
    const row = {
      v: 1,
      turn,
      at: nowIso(Number(t.at) || Date.now()),
      sessionId: String(sessionId),
      key: String(key || ''),
      mode: '',
      model: '',
      userRaw: { text: userText, msgIds: (t.msgIds || []).map(String), chars: userText.length, synthetic: false },
      spoken: (t.spoken || []).map((text) => ({ kind: 'send', tool: '', text })),
      reply: { text: '', chars: 0 },
      feels: [],
      window: { textSha1: '', chars: 0, blocks: [] },
      pressureTokens: 0,
      contextWindow: 0,
      incomplete: false,
      reason: 'raw-gap',
      elapsedMs: 0,
      fidelity: 'reconciled',
      source: 'raw-gap',
      savedAt: nowIso()
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    for (const line of fresh) hashes.add(sha1(line));
    for (const id of t.msgIds || []) ids.add(String(id));
    added.push(turn);
  }
  return { added: added.length, skipped, turns: added };
}

/** 缺口报告：days 天内 raw 用户消息里，有多少条还没进窗口。 */
export function gapReport({ dir = '', key = '', sessionId = '', days = 2, now = Date.now() } = {}) {
  const existing = readTurns(dir, sessionId);
  const rawRows = readRawRows({ dir, key, days, now });
  const turns = buildGapTurns(rawRows, { existingRows: existing });
  return {
    key,
    sessionId,
    rawMessages: rawRows.filter((r) => r.role === 'user').length,
    gapTurns: turns.length,
    gapMessages: turns.reduce((n, t) => n + String(t.userText).split('\n').length, 0),
    turns
  };
}

/** 追加一条缺口日志（排查用；不影响主流程）。 */
export function logGap(dir = '', entry = {}) {
  if (!dir) return;
  try {
    const file = path.join(String(dir), 'logs', 'window-gap.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: nowIso(), ...entry })}\n`, 'utf8');
  } catch {
    // 日志失败不阻断
  }
}

/** 一步到位：报告 + 可选写入 + 日志。 */
export function repairGaps({ dir = '', key = '', sessionId = '', days = 2, now = Date.now(), write = false } = {}) {
  const report = gapReport({ dir, key, sessionId, days, now });
  const res = write ? appendReconciledTurns({ dir, key, sessionId, turns: report.turns }) : { added: 0, skipped: report.turns.length, turns: [] };
  if (write && res.added) logGap(dir, { kind: 'backfill', key, sessionId, days, added: res.added, skipped: res.skipped });
  return { ...report, added: res.added, skipped: res.skipped };
}

/** 这个 key 的所有窗口会话（用于把缺口按时间归到正确的会话，而不是全都塞给当前映射会话）。 */
export function windowSessionsFor({ dir = '', key = '' } = {}) {
  const root = path.join(String(dir), 'window');
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const sid of names) {
    const rows = readTurns(dir, sid).filter((r) => String(r?.key || '') === String(key));
    if (!rows.length) continue;
    const times = rows.map((r) => Date.parse(r.at)).filter(Number.isFinite);
    if (!times.length) continue;
    out.push({ sessionId: sid, rows, from: Math.min(...times), to: Math.max(...times) });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** 一步到位（跨会话）：对整个 key 做缺口核对，按时间把缺口归到对应的窗口会话。 */
export function repairGapsForKey({ dir = '', key = '', days = 2, now = Date.now(), write = false, fallbackSessionId = '' } = {}) {
  const sessions = windowSessionsFor({ dir, key });
  const existingAll = sessions.flatMap((s) => s.rows);
  const rawRows = readRawRows({ dir, key, days, now });
  const turns = buildGapTurns(rawRows, { existingRows: existingAll });
  const buckets = new Map();
  for (const t of turns) {
    const candidates = sessions.filter((s) => t.at >= s.from - 2 * 3600000 && t.at <= s.to + 2 * 3600000);
    let target = candidates.length
      ? candidates.reduce((best, s) => {
          const d = t.at < s.from ? s.from - t.at : t.at > s.to ? t.at - s.to : 0;
          if (!best) return { s, d };
          if (d < best.d) return { s, d };
          // 距离相同（正好落在两段之间）时归给更晚的那段：缺口通常属于之后的新会话。
          if (d === best.d && s.from > best.s.from) return { s, d };
          return best;
        }, null).s
      : null;
    if (!target) {
      const latest = sessions[sessions.length - 1];
      target = latest || (fallbackSessionId ? { sessionId: fallbackSessionId } : null);
    }
    if (!target) continue;
    const sid = target.sessionId;
    if (!buckets.has(sid)) buckets.set(sid, []);
    buckets.get(sid).push(t);
  }
  let added = 0;
  let skipped = 0;
  const detail = [];
  for (const [sessionId, list] of buckets) {
    const res = write ? appendReconciledTurns({ dir, key, sessionId, turns: list }) : { added: 0, skipped: list.length };
    added += res.added;
    skipped += res.skipped;
    detail.push({ sessionId, gapTurns: list.length, added: res.added, skipped: res.skipped });
    if (write && res.added) logGap(dir, { kind: 'backfill', key, sessionId, days, added: res.added, skipped: res.skipped });
  }
  return {
    key,
    rawMessages: rawRows.filter((r) => r.role === 'user').length,
    gapTurns: turns.length,
    gapMessages: turns.reduce((n, t) => n + String(t.userText).split('\n').length, 0),
    added,
    skipped,
    sessions: detail,
    samples: turns.slice(0, 5).map((t) => ({ at: t.at, head: t.userText.slice(0, 40), chars: t.chars }))
  };
}
