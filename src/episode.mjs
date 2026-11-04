// 情境段（episode）：把 window 账本的一串轮次切成「一段有头有尾的对话」。
// 只做结构化切段与既定字段填充；标题/场景/主题由模型在日终补写（见 summarizeEpisodes）。
// 设计约束见 docs/记忆方案-3.0-完整方案-20261103.md §2.2。

import fs from 'node:fs';
import path from 'node:path';
import { isSyntheticPrompt, readTurns, sha1 } from './window.mjs';

export const EPISODE_VERSION = 1;
export const MAX_GAP_MS = 90 * 60 * 1000;
export const MIN_TURNS = 4;
export const MAX_TURNS = 40;

/** 注入块在 userRaw 里的标记，切段取标题时先剥掉。 */
const INJECT_MARKERS = [
  /^[\s\S]*?【长期记忆（事实卡）】/,
  /^[\s\S]*?【\d+ 天记忆交接】/,
  /^[\s\S]*?【记忆交接】/,
  /^[\s\S]*?【当前时间】[^\n]*\n/
];

function plain(text = '') {
  let s = String(text || '');
  for (const re of INJECT_MARKERS) s = s.replace(re, '');
  return s.replace(/\s+/g, ' ').trim();
}

function head(text = '', n = 80) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function dayOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ms(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 切段：间隔 > 90min 断开；不足 4 轮并入前段；单段上限 40 轮。
 * @returns {Array<Array<object>>} 每段是一串 turn 行
 */
export function segmentTurns(rows = [], { maxGapMs = MAX_GAP_MS, minTurns = MIN_TURNS, maxTurns = MAX_TURNS } = {}) {
  const list = rows
    .filter((r) => r && r.turn)
    .slice()
    .sort((a, b) => (Number(a.turn) || 0) - (Number(b.turn) || 0));
  const raw = [];
  let cur = [];
  for (const row of list) {
    const gap = cur.length ? ms(row.at) - ms(cur[cur.length - 1].at) : 0;
    if (cur.length && (gap > maxGapMs || cur.length >= maxTurns)) {
      raw.push(cur);
      cur = [];
    }
    cur.push(row);
  }
  if (cur.length) raw.push(cur);

  // 太短的段往前并（最后一段太短就并到前一段，第一段太短就留给后一段）
  const out = [];
  for (const seg of raw) {
    if (out.length && seg.length < minTurns) out[out.length - 1] = out[out.length - 1].concat(seg);
    else out.push(seg.slice());
  }
  if (out.length > 1 && out[0].length < minTurns) {
    const first = out.shift();
    out[0] = first.concat(out[0]);
  }
  return out;
}

function episodeId(day, sessionId, turnFrom) {
  const sid = String(sessionId || '').replace(/^session-/, '').slice(0, 8);
  return `ep-${day || 'unknown'}-${sid}-${turnFrom}`;
}

/** 把一段 turn 行转成 episode 记录（模型字段留空，由日终补写）。 */
export function episodeFromTurns(seg, { fidelity = '', key = '' } = {}) {
  const first = seg[0] || {};
  const last = seg[seg.length - 1] || first;
  const day = dayOf(first.at);
  // 唤醒轮 = 没有用户原话的轮；不要信历史行里的 synthetic 标记（口径变过）。
  const isWakeTurn = (r) => !String(r?.userRaw?.text || '').trim();
  const real = seg.filter((r) => !isWakeTurn(r));
  const src = real.length ? real : seg;
  const userHeads = src.map((r) => plain(r?.userRaw?.text || '')).filter(Boolean);
  const title = real.length ? (userHeads[0] || '').slice(0, 24) || '一段对话' : '（唤醒/提醒回合）';
  const scene = real.length ? (userHeads[0] || '').slice(0, 60) : '';
  const syntheticTurns = seg.filter((r) => isWakeTurn(r)).map((r) => Number(r.turn) || 0);
  // 回填出来的轮次标 session-log（来自 DSH 会话日志），其余是实时账本。
  const imported = seg.filter((r) => r?.fidelity === 'session-log').length;
  const fid = fidelity || (imported * 2 >= seg.length ? 'session-log' : 'live');
  const thoughts = seg
    .map((r) => ({ turn: Number(r.turn) || 0, text: head(String(r?.reply?.text || '').trim(), 160) }))
    .filter((t) => t.text);
  const feelings = [];
  for (const r of seg) {
    for (const f of Array.isArray(r.feels) ? r.feels : []) {
      const text = String(f?.text || '').trim();
      if (text) feelings.push({ turn: Number(r.turn) || 0, text, src: String(f.src || 'reply') });
    }
  }
  return {
    v: EPISODE_VERSION,
    id: episodeId(day, first.sessionId, first.turn),
    day,
    key: String(key || first.key || ''),
    sessionId: String(first.sessionId || ''),
    turnFrom: Number(first.turn) || 0,
    turnTo: Number(last.turn) || 0,
    atFrom: String(first.at || ''),
    atTo: String(last.at || ''),
    title,
    scene,
    topics: [],
    turns: seg.map((r) => ({
      turn: Number(r.turn) || 0,
      at: String(r.at || ''),
      kind: isWakeTurn(r) ? 'wake' : 'user',
      head: head(plain(r?.userRaw?.text || r?.spoken?.[0]?.text || ''), 80)
    })),
    syntheticTurns,
    thoughts,
    feelings,
    feelingsKnown: feelings.length > 0,
    fidelity: fid,
    rawRefs: [],
    summarized: false,
    createdAt: new Date().toISOString()
  };
}

export function episodesFile(dir, month) {
  return path.join(String(dir || ''), 'episodes', `${month}.jsonl`);
}

function monthOf(day) {
  return String(day || '').slice(0, 7);
}

function readJsonl(file) {
  const out = [];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 半行/坏行跳过
    }
  }
  return out;
}

function writeJsonlAtomic(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

export function readEpisodes(dir, { month = '' } = {}) {
  const root = path.join(String(dir || ''), 'episodes');
  let files = [];
  try {
    files = fs.readdirSync(root).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(root, f));
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files) {
    const m = path.basename(f, '.jsonl');
    if (month && m !== month) continue;
    rows.push(...readJsonl(f));
  }
  return rows.sort((a, b) => ms(a.atFrom) - ms(b.atFrom) || String(a.id).localeCompare(String(b.id)));
}

/** 覆盖同 id 的旧记录（按 episodeId 幂等）。 */
export function upsertEpisodes(dir, rows = []) {
  const byMonth = new Map();
  for (const row of rows) {
    const m = monthOf(row.day);
    if (!m) continue;
    if (!byMonth.has(m)) byMonth.set(m, new Map(readJsonl(episodesFile(dir, m)).map((r) => [r.id, r])));
    byMonth.get(m).set(row.id, row);
  }
  let written = 0;
  for (const [m, map] of byMonth) {
    const list = [...map.values()].sort((a, b) => ms(a.atFrom) - ms(b.atFrom));
    writeJsonlAtomic(episodesFile(dir, m), list);
    written += list.length;
  }
  return written;
}

/**
 * 为某天（某会话）从窗口账本生成 episode。
 * @returns {{episodes: object[], turns: number}}
 */
export function buildEpisodesForDay(dir, { day, sessionId = '', fidelity = '' } = {}) {
  if (!dir || !day) return { episodes: [], turns: 0 };
  const root = path.join(String(dir), 'window');
  let sids = [];
  try {
    sids = fs.readdirSync(root).filter((n) => n.startsWith('session-'));
  } catch {
    return { episodes: [], turns: 0 };
  }
  if (sessionId) sids = sids.filter((s) => s === sessionId);
  const episodes = [];
  let turns = 0;
  for (const sid of sids) {
    const rows = readTurns(dir, sid).filter((r) => dayOf(r.at) === day);
    if (!rows.length) continue;
    turns += rows.length;
    for (const seg of segmentTurns(rows)) {
      episodes.push(episodeFromTurns(seg, { fidelity }));
    }
  }
  return { episodes, turns };
}

/**
 * 日终建段：把最近几天的窗口账本折叠成 episode（幂等）。
 *
 * 2026-11-04 体检发现的断档：日终只调 `summarizePendingEpisodes`（只处理已存在的段），
 * 而建段只在 `scripts/build-episodes.mjs` 里手动调用 —— 于是从当天起 episode 与
 * entry 两条链都空转。日终必须先建段，再摘要、再抽 entry。
 *
 * @param {string} dir 数据目录
 * @param {{now?: number, days?: number}} opts days 默认 2（今天 + 昨天；昨天的尾巴在
 *   第二天建段时补齐）
 * @returns {{added:number, updated:number, segments:number, days:string[]}}
 */
export function buildDailyEpisodes(dir, { now = Date.now(), days = 2 } = {}) {
  if (!dir) return { added: 0, updated: 0, segments: 0, days: [] };
  const wanted = [];
  const span = Math.max(1, Math.min(7, Number(days) || 2));
  for (let i = 0; i < span; i += 1) {
    const d = dayOf(new Date(now - i * 86400000).toISOString());
    if (d) wanted.push(d);
  }
  const existing = new Map(readEpisodes(dir).map((e) => [e.id, e]));
  let added = 0;
  let updated = 0;
  let segments = 0;
  for (const day of wanted) {
    let built;
    try {
      built = buildEpisodesForDay(dir, { day });
    } catch {
      continue;
    }
    segments += built.episodes.length;
    const fresh = [];
    for (const ep of built.episodes) {
      const old = existing.get(ep.id);
      if (!old) {
        fresh.push(ep);
        added += 1;
        continue;
      }
      // 同一段尾巴变长（夜里又聊了几句）：用新段覆盖，但保留旧标题/想法，
      // 并把 summarized 置回 false，让摘要步骤重写这一段。
      const grown = (old.turnTo || 0) !== (ep.turnTo || 0) || (old.turns || []).length !== (ep.turns || []).length;
      if (!grown) continue;
      fresh.push({
        ...old,
        ...ep,
        title: old.title || ep.title,
        scene: old.scene || ep.scene,
        topics: Array.isArray(old.topics) && old.topics.length ? old.topics : ep.topics,
        thoughts: Array.isArray(old.thoughts) && old.thoughts.length ? old.thoughts : ep.thoughts,
        summarized: false,
        updatedAt: new Date().toISOString()
      });
      updated += 1;
    }
    if (fresh.length) upsertEpisodes(dir, fresh);
  }
  return { added, updated, segments, days: wanted };
}

/** 给 episode 挂上模型补写的摘要字段（标题/场景/主题/想法），只覆盖非空项。 */
export function applySummary(episode, summary = {}) {
  const out = { ...episode };
  if (summary.title) out.title = String(summary.title).slice(0, 40);
  if (summary.scene) out.scene = String(summary.scene).slice(0, 80);
  if (Array.isArray(summary.topics)) out.topics = summary.topics.map((t) => String(t)).filter(Boolean).slice(0, 8);
  if (Array.isArray(summary.thoughts) && summary.thoughts.length) {
    out.thoughts = summary.thoughts.map((t) => ({
      turn: Number(t.turn) || 0,
      text: String(t.text || t).slice(0, 200)
    }));
  }
  out.summarized = true;
  out.summaryHash = sha1(JSON.stringify(summary)).slice(0, 16);
  out.updatedAt = new Date().toISOString();
  return out;
}
