// 分层检索（P3）：近 7 天情境摘要 → 近 7 天原话 → 近 1 月情境摘要。
//
// 与 scoring 的事实检索并行：事实卡/事实检索解决「她记得什么」，
// 这里解决「她记得哪一段、当时是怎么说的」。
//
// 设计约束：
// 1) 只读：不写任何事件，不改账本；
// 2) 命中即停：每一层有固定字数上限，用满就不再往下走；
// 3) 原话层只取「用户原话 / 她真正发出的话 / 当时的想法」，注入块永不进检索；
// 4) 超过 30 天的一律不进注入，只能由工具按需展开（qq_memory_window）。

import fs from 'node:fs';
import path from 'node:path';
import { readEpisodes } from './episode.mjs';
import { readTurns } from './window.mjs';
import { loadV10, passesSalience, renderFact } from './v10.mjs';

const DAY_MS = 86400000;

// episode 的 atFrom/atTo 可能是毫秒数也可能是 ISO 字符串，统一成毫秒。
function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Date.parse(String(v || ''));
  return Number.isFinite(n) ? n : 0;
}

export const RETRIEVAL_DEFAULTS = {
  enabled: true,
  recentDays: 7,
  monthDays: 30,
  recentEpisodeChars: 400,
  recentWindowChars: 600,
  monthEpisodeChars: 500,
  maxEpisodeLines: 3,
  maxTurnLines: 2,
  replyChars: 120
};

function cfgOf(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const out = { ...RETRIEVAL_DEFAULTS };
  for (const k of Object.keys(RETRIEVAL_DEFAULTS)) {
    if (c[k] === undefined) continue;
    out[k] = typeof RETRIEVAL_DEFAULTS[k] === 'boolean' ? c[k] !== false : Number(c[k]) || RETRIEVAL_DEFAULTS[k];
  }
  return out;
}

// 查询词：中文二元组 + 拉丁词；与 v10 的 tokensOf 口径保持一致（不引依赖，避免循环）。
export function queryTokens(q) {
  const s = String(q || '');
  const out = new Set();
  for (const w of s.toLowerCase().match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    const chars = [...seg];
    if (chars.length === 1) out.add(chars[0]);
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  return [...out];
}

function scoreText(text, tokens) {
  const t = String(text || '');
  if (!t) return 0;
  let hit = 0;
  for (const tok of tokens) if (t.includes(tok)) hit += 1;
  return hit;
}

// 命中门槛：查询里带「具体词」（含数字或 ≥3 位拉丁/编号）时，命中一个就够——
// 「华光 081200」不该因为摘要只写了「华光」就整层落空；普通多词查询仍要求命中 2 个。
function minHits(tokens = []) {
  if (!Array.isArray(tokens) || tokens.length <= 1) return 1;
  return tokens.some((t) => /[0-9]/.test(t) || /^[a-z0-9]{3,}$/i.test(t)) ? 1 : 2;
}

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

export function readRecentEpisodes(dir, { now = Date.now(), days = 7 } = {}) {
  const since = now - days * DAY_MS;
  return (readEpisodes(dir) || [])
    .filter((e) => e && toMs(e.atTo) >= since)
    .sort((a, b) => toMs(b.atTo) - toMs(a.atTo));
}

function episodeLine(ep, max) {
  const day = String(ep.day || '').slice(5);
  const title = clip(ep.title || '', 40);
  const scene = clip(ep.scene || '', Math.max(20, max - 24));
  if (!title && !scene) return '';
  return `· [${day}] ${title}${scene ? `：${scene}` : ''}`;
}


// 同一 key 可能对应多个窗口会话（轮转/换会话后旧窗口仍在 window/ 下）。
// 原话检索必须能翻到它们，否则「只记得最近这个会话里的原话」。
export function sessionsOfKey(dir, key = '', preferred = '') {
  const out = [];
  if (preferred) out.push(preferred);
  const root = path.join(String(dir || ''), 'window');
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (out.includes(name)) continue;
    const turnFile = path.join(root, name, 'turns.jsonl');
    if (!fs.existsSync(turnFile)) continue;
    if (key) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(root, name, 'meta.json'), 'utf8'));
        if (meta?.key && meta.key !== key) continue;
      } catch {
        /* 没 meta 也当同一 key */
      }
    }
    out.push(name);
  }
  return out;
}

export function windowTurnLines(dir, sessionId, { query, tokens, now = Date.now(), since, maxTurnLines, maxChars, replyChars, minScore = 2, sessionIds = [] }) {
  const ids = Array.isArray(sessionIds) && sessionIds.length ? sessionIds : sessionId ? [sessionId] : [];
  if (!ids.length) return [];
  const rows = [];
  for (const sid of ids) {
    for (const row of readTurns(dir, sid, { limit: 400 })) {
      if (toMs(row?.at) >= since) rows.push(row);
    }
  }
  const scored = [];
  for (const r of rows) {
    const user = String(r?.userRaw?.text || '');
    const spoken = (r?.spoken || []).map((s) => String(s?.text || '')).join(' ');
    const reply = String(r?.reply?.text || '');
    const hay = `${user}\n${spoken}\n${reply}`;
    const sc = scoreText(hay, tokens);
    if (sc < minScore) continue;
    scored.push({ r, sc });
  }
  scored.sort((a, b) => b.sc - a.sc || toMs(b.r.at) - toMs(a.r.at));
  const lines = [];
  let used = 0;
  for (const { r } of scored) {
    if (lines.length >= maxTurnLines) break;
    const stamp = new Date(toMs(r.at) || now);
    const hh = `${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
    const parts = [];
    const user = clip(r.userRaw?.text || '', 80);
    if (user) parts.push(`用户：${user}`);
    const spoken = clip((r.spoken || []).map((s) => s?.text || '').join(' '), 100);
    if (spoken) parts.push(`助手：${spoken}`);
    const reply = clip(r.reply?.text || '', replyChars);
    if (reply && reply !== spoken) parts.push(`（当时的想法：${reply}）`);
    if (!parts.length) continue;
    const line = `· [${stamp ? hh : ''}] ${parts.join(' ')}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines;
}

// 分层检索主入口：返回 { lines, layers, chars }。
// 层序：近 N 天情境 → 近 N 天原话 → 近 M 天情境（每层用满预算即止）。
export function layeredRecall(dir, { query, sessionId = '', key = '', now = Date.now(), cfg } = {}) {
  const c = cfgOf(cfg);
  const q = String(query || '').trim();
  if (!c.enabled || !q) return { lines: [], layers: [], chars: 0 };
  const tokens = queryTokens(q);
  if (!tokens.length) return { lines: [], layers: [], chars: 0 };
  const lines = [];
  const layers = [];
  const sessionIds = sessionsOfKey(dir, key, sessionId);
  const need = minHits(tokens);

  // ① 近 7 天情境摘要
  {
    const eps = readRecentEpisodes(dir, { now, days: c.recentDays });
    const picked = [];
    let used = 0;
    for (const ep of eps) {
      if (picked.length >= c.maxEpisodeLines) break;
      const hay = `${ep.title || ''} ${ep.scene || ''} ${(ep.topics || []).join(' ')} ${(ep.thoughts || []).map((t) => t?.text || '').join(' ')}`;
      if (scoreText(hay, tokens) < need) continue;
      const line = episodeLine(ep, 90);
      if (!line || used + line.length > c.recentEpisodeChars) continue;
      picked.push(line);
      used += line.length;
    }
    if (picked.length) {
      lines.push(...picked);
      layers.push({ name: 'recentEpisodes', count: picked.length, chars: used });
    }
  }

  // ② 近 7 天原话：摘要命中后仍补一条「强命中」的原话（细节常只存在于原话里），
  //    摘要没命中时则取 2 条。强命中的门槛更高（>=3 个查询词），避免沾边就翻。
  if (layers.length) {
    const strong = windowTurnLines(dir, sessionId, {
      query: q,
      tokens,
      now,
      since: now - c.recentDays * DAY_MS,
      maxTurnLines: 1,
      maxChars: 260,
      replyChars: c.replyChars,
      minScore: need,
      sessionIds
    });
    if (strong.length) {
      lines.push(...strong);
      layers.push({ name: 'recentWindow', count: strong.length, chars: strong.join('').length });
    }
  } else {
    const turnLines = windowTurnLines(dir, sessionId, {
      query: q,
      tokens,
      now,
      since: now - c.recentDays * DAY_MS,
      maxTurnLines: c.maxTurnLines,
      maxChars: c.recentWindowChars,
      replyChars: c.replyChars,
      minScore: need,
      sessionIds
    });
    if (turnLines.length) {
      lines.push(...turnLines);
      layers.push({ name: 'recentWindow', count: turnLines.length, chars: turnLines.join('').length });
    }
  }

  // ③ 近 30 天情境摘要（7 天以前、30 天以内）
  if (lines.length < 2) {
    const since = now - c.monthDays * DAY_MS;
    const recentSince = now - c.recentDays * DAY_MS;
    const eps = (readEpisodes(dir) || [])
      .filter((e) => toMs(e.atTo) >= since && toMs(e.atTo) < recentSince)
      .sort((a, b) => toMs(b.atTo) - toMs(a.atTo));
    const picked = [];
    let used = 0;
    for (const ep of eps) {
      if (picked.length >= 2) break;
      const hay = `${ep.title || ''} ${ep.scene || ''} ${(ep.topics || []).join(' ')}`;
      if (scoreText(hay, tokens) < need) continue;
      const line = episodeLine(ep, 90);
      if (!line || used + line.length > c.monthEpisodeChars) continue;
      picked.push(line);
      used += line.length;
    }
    if (picked.length) {
      lines.push(...picked);
      layers.push({ name: 'monthEpisodes', count: picked.length, chars: used });
    }
  }

  return { lines, layers, chars: lines.join('\n').length };
}

export function formatLayered(result, { header = '【记得的片段】', maxChars = 900 } = {}) {
  const lines = (result && result.lines) || [];
  if (!lines.length) return '';
  const body = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > maxChars) break;
    body.push(line);
    used += line.length;
  }
  if (!body.length) return '';
  return `${header}\n${body.join('\n')}`;
}

/* ---------------- 注入行：显著性闸门 + 措辞 ---------------- */
// 2.1 退役第 2 步：引擎不再直接调用 v10 的注入相关函数，统一从这里进出。
// 语义与旧实现逐字节一致：passesSalience 过滤；emit 开 → renderFact，否则档位行。
export function isSalient(row, dir = '') {
  try {
    return passesSalience(row, loadV10(dir));
  } catch {
    return true;
  }
}

export function retrievalLine(row, dir = '') {
  // 过期的事实不隐藏，但必须读起来像「旧事」，不能像现在。
  if (row && row.expired) {
    const d = row?.dates?.[0]?.date || (row?.saidAt ? new Date(Number(row.saidAt) + 8 * 3600e3).toISOString().slice(0, 10) : '');
    const head = d ? `旧事 · ${d.slice(5)}` : '旧事';
    return `· ${head}：${String(row.value || '').slice(0, 60)}`;
  }
  let cfg = null;
  try {
    cfg = loadV10(dir);
  } catch {
    cfg = null;
  }
  if (cfg && cfg.enabled === true && cfg.emit === true) {
    try {
      return renderFact(row, { cfg });
    } catch {
      /* 降级到档位行 */
    }
  }
  return `· [${row.tier}] ${String(row.value).slice(0, 60)}`;
}
