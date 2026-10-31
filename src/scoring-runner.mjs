// 打分跑批（v7 §4）：入站判分 → 影子/写入 → 日终结算 → 检索排序。
//
// 三档模式（config.memory.scoring.mode）：
//   off     完全不跑（线上零行为）
//   shadow  只写 state/scoring-shadow.jsonl + 统计，**不碰 longterm.jsonl、不碰事实卡**
//   write   真写 longterm.jsonl 事件（fact / mention / tier / expire）
//
// 影子模式的目的：先用真实流量验证「抽得对不对、分数算得对不对、量有多大」，
// 一天没问题再把 mode 切成 write，代码路径完全一致，只是换个文件落地。

import { detectSignals, topicOf, classOf, subjectTag } from './facts.mjs';
import { parseDue } from './due.mjs';
import {
  SCORING_DEFAULTS,
  normalizeConfig,
  importanceOf,
  stabilityOf,
  scoreOf,
  mentionGain,
  applyMention,
  tierAfter,
  demoted,
  describe,
  round2
} from './score.mjs';
import * as lt from './longterm.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const MODES = ['off', 'shadow', 'write'];

/** 合并 scoring 配置：数值走 score.mjs 的 normalizeConfig，mode 单独校验。 */
export function normalizeScoring(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = MODES.includes(String(c.mode)) ? String(c.mode) : 'shadow';
  // v8 版本链默认关闭：关闭时检索行为与今天完全一致（同主题多条都会返回）
  return { ...normalizeConfig(c), mode, versioning: c.versioning === true };
}

function sigOf(about, pattern, extra = '') {
  const base = `${about || 'user'}:${pattern || 'note'}`;
  return extra ? `${base}:${extra}` : base;
}

/** 带主语槽的 sig：自指主语不带（保持老 sig 不变），「我妈/我爸/我家」才带。 */
function sigOfSubject(about, pattern, subject) {
  const tag = subjectTag(subject);
  return tag ? `${about || 'user'}:${tag}:${pattern || 'note'}` : sigOf(about, pattern);
}

function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

/**
 * 一条入站文本值不值得记：抽硬事实；抽不到但明确说「记住」→ 记一条备注。
 * @returns {{signals:object, candidates:Array}}
 */
export function classify(text, cfg = SCORING_DEFAULTS) {
  const t = String(text ?? '').trim();
  const signals = detectSignals(t);
  const candidates = [];
  if (!t || signals.question) return { signals, candidates };

  for (const f of signals.facts) {
    const about = f.about || 'user';
    const pattern = f.pattern || f.key || 'fact';
    const subject = f.subject || '';
    const sig = sigOfSubject(about, pattern, subject);
    candidates.push({
      sig,
      topic: topicOf(t, { about, subject, pattern, sig }),
      about,
      subject,
      pattern,
      label: f.label || '',
      value: f.value || '',
      text: t.slice(0, 200),
      quote: t.slice(0, 200),
      class: classOf(t, { hard: true }),
      tier: 'hard',
      I: 1
    });
  }

  if (!candidates.length && signals.explicitRemember) {
    const about = 'user';
    const due = parseDue(t); // 「下下个星期一要交…」→ 2026-11-09；解不出就保持普通备注
    const sig = sigOf(about, 'note', shortHash(t));
    candidates.push({
      sig,
      topic: topicOf(t, { about, pattern: 'note', sig }),
      about,
      pattern: 'note',
      label: '备注',
      value: t.slice(0, 120),
      text: t.slice(0, 200),
      quote: t.slice(0, 200),
      class: classOf(t, { dueAt: Boolean(due && due.dueAt) }),
      tier: 'general',
      I: importanceOf({ explicitRemember: true }, cfg),
      ...(due ? { task: true, due: due.due, dueAt: due.dueAt, duePhrase: due.phrase } : {})
    });
  }

  return { signals, candidates };
}

/**
 * 入站记一条（引擎在每条消息写入日志后调用）。
 * @returns {{mode:string, added:Array, mentioned:Array, skipped?:string}}
 */
export function recordInbound({ key = '', text = '', ts = Date.now(), scoring, dir = '', itemId = 0 } = {}) {
  const cfg = normalizeScoring(scoring);
  const mode = cfg.mode;
  if (mode === 'off') return { mode, added: [], mentioned: [], skipped: 'off' };

  const { signals, candidates } = classify(text, cfg);
  if (!candidates.length) {
    if (mode === 'shadow') lt.bumpShadowStats({ messages: 1, signals: signals.hard ? 1 : 0 }, ts, dir);
    logLine(dir, { at: ts, mode, key, cand: 0, added: 0, mentioned: 0, text });
    return { mode, added: [], mentioned: [], signals };
  }

  // 影子模式要「自己折自己」（否则同一条信息第二次出现会被当成新事实），
  // 同时也要看见已写入的事实，所以合并两路事件流。
  const events = mode === 'shadow'
    ? [...lt.readEvents(dir).rows, ...lt.readShadow(0, dir).rows]
    : lt.readEvents(dir).rows;
  const active = lt.materialize(events, lt.readInvalidated(dir))
    .filter((f) => f.status === 'active')
    .reduce((m, f) => {
      if (!m.has(f.sig)) m.set(f.sig, f);
      return m;
    }, new Map());

  const added = [];
  const mentioned = [];

  for (const c of candidates) {
    const prior = active.get(c.sig);
    if (prior) {
      const gain = mentionGain(prior, ts, cfg);
      const next = applyMention(prior, ts, { cfg });
      const row = {
        ev: 'mention',
        id: prior.id,
        at: ts,
        key,
        hits: next.hits,
        sameDayHits: next.sameDayHits,
        s: next.s,
        I: next.I,
        gain: round2(gain),
        text: String(text ?? '').slice(0, 120),
        quote: String(text ?? '').slice(0, 200),
        ...(itemId ? { source: { id: itemId } } : {})
      };
      if (mode === 'write') lt.appendEvent(row, dir);
      else lt.appendShadow(row, dir);

      // v8 版本链：固定属性（生日/名字/称呼/住处/工作）说了新值 → 记一条 supersede 顶掉旧值。
      // 旧值不丢：它还在事件流里，只是 materialize 后只剩最新一份。
      const isAttribute = c.pattern !== 'note' && String(c.topic || '').split(':').length === 2;
      const changed = c.value && prior.value && String(c.value) !== String(prior.value);
      if (cfg.versioning && isAttribute && changed) {
        const sup = {
          ev: 'supersede',
          id: prior.id,
          at: ts,
          key,
          field: 'value',
          value: c.value,
          quote: c.quote || String(text ?? '').slice(0, 200),
          previous: prior.value,
          ...(itemId ? { source: { id: itemId } } : {})
        };
        if (mode === 'write') lt.appendEvent(sup, dir);
        else lt.appendShadow(sup, dir);
      }
      mentioned.push({ id: prior.id, sig: c.sig, s: next.s, hits: next.hits });
    } else {
      const s = stabilityOf({ tier: c.tier, class: c.class }, cfg);
      const row = {
        ev: 'fact',
        id: lt.newId(mode === 'shadow' ? 's' : 'h'),
        sig: c.sig,
        key,
        about: c.about,
        pattern: c.pattern,
        label: c.label,
        value: c.value,
        text: c.text,
        quote: c.quote || c.text,
        topic: c.topic,
        class: c.class || 'note',
        ...(itemId ? { source: { id: itemId } } : {}),
        tier: c.tier,
        I: round2(c.I),
        s: Number.isFinite(s) ? round2(s) : null,
        hits: 1,
        lastAt: ts,
        at: ts,
        ...(c.task ? { task: true, due: c.due, dueAt: c.dueAt, duePhrase: c.duePhrase } : {})
      };
      if (mode === 'write') lt.appendEvent(row, dir);
      else lt.appendShadow(row, dir);
      added.push(row);
    }
  }

  if (mode === 'shadow') {
    lt.bumpShadowStats(
      {
        messages: 1,
        facts: added.length,
        mentions: mentioned.length,
        hard: added.filter((r) => r.tier === 'hard').length
      },
      ts,
      dir
    );
  }

  logLine(dir, {
    at: ts,
    mode,
    key,
    cand: candidates.length,
    added: added.length,
    mentioned: mentioned.length,
    ids: [...added.map((r) => r.id), ...mentioned.map((r) => r.id)],
    text
  });

  return { mode, added, mentioned, signals };
}

/** 观测日志：每收到一条消息追加一行到 <dir>/logs/scoring.log（出问题靠它复盘）。 */
function logLine(dir, row) {
  try {
    const file = path.join(lt.paths(dir).root, 'logs', 'scoring.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = {
      at: new Date(Number(row.at) || Date.now()).toISOString(),
      mode: row.mode,
      key: row.key,
      cand: row.cand || 0,
      added: row.added || 0,
      mentioned: row.mentioned || 0,
      ids: row.ids || [],
      text: String(row.text || '').replace(/\s+/g, ' ').slice(0, 80)
    };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    /* 观测日志失败不影响主流程 */
  }
}

/**
 * 日终结算：算当前档位与分数，得出该升/该降/该过期。
 * shadow → 写 scoring-dryrun.json（预览）；write → 追加 tier / expire 事件。
 */
export function settle({ now = Date.now(), scoring, dir = '' } = {}) {
  const cfg = normalizeScoring(scoring);
  if (cfg.mode === 'off') return { mode: 'off', skipped: true, transitions: [] };

  const eventsIn = cfg.mode === 'shadow'
    ? [...lt.readEvents(dir).rows, ...lt.readShadow(0, dir).rows]
    : lt.readEvents(dir).rows;
  const facts = lt.materialize(eventsIn, lt.readInvalidated(dir)).filter((f) => f.status === 'active');
  const transitions = [];
  const byTier = { hard: 0, long: 0, general: 0, temp: 0, expired: 0 };
  const events = [];

  for (const f of facts) {
    const score = scoreOf(f, now, cfg);
    const next = tierAfter(f, now, cfg);
    byTier[next] = (byTier[next] || 0) + 1;
    if (next === f.tier) continue;
    if (next === 'expired') {
      const reason = f.task && Number(f.dueAt) ? 'task-overdue' : 'temp-ttl';
      transitions.push({ id: f.id, sig: f.sig, from: f.tier, to: 'expired', score, reason });
      events.push({ ev: 'expire', id: f.id, at: now, reason, score });
      continue;
    }
    const moved = next === 'long' ? { tier: next, s: f.s } : demoted(f, next, cfg);
    transitions.push({ id: f.id, sig: f.sig, from: f.tier, to: next, score, s: moved.s });
    events.push({ ev: 'tier', id: f.id, at: now, tier: next, from: f.tier, s: moved.s, score });
  }

  const summary = {
    at: now,
    mode: cfg.mode,
    active: facts.length,
    byTier,
    transitions: transitions.slice(0, 40),
    transitionCount: transitions.length
  };

  if (cfg.mode === 'shadow') {
    lt.writeDryrun({ ...summary, generatedAt: new Date(now).toISOString() }, dir);
  } else {
    for (const ev of events) lt.appendEvent(ev, dir);
  }

  return summary;
}

/**
 * 检索：档位优先（hard → long → general → temp），同档按分数；默认过滤作废/过期。
 * @returns {Array} describe() 结果 + text
 */
export function search({ query = '', limit = 5, now = Date.now(), scoring, includeInvalidated = false, facts: provided, dir = '', includeHistory = false } = {}) {
  const cfg = normalizeScoring(scoring);
  const q = String(query ?? '').trim();
  const eventsIn = cfg.mode === 'shadow'
    ? [...lt.readEvents(dir).rows, ...lt.readShadow(0, dir).rows]
    : lt.readEvents(dir).rows;
  const source = Array.isArray(provided) ? provided : lt.materialize(eventsIn, lt.readInvalidated(dir));
  const facts = source.filter((f) => includeInvalidated || f.status === 'active');
  const ranked = facts
    .map((f) => {
      const d = { ...describe(f, now, cfg), id: f.id, status: f.status, label: f.label, text: f.text, sig: f.sig, about: f.about, value: f.value, pattern: f.pattern, topic: f.topic || '', quote: f.quote || '', lastAt: f.lastAt || 0, versions: Number(f.versions) || 1 };
      // 命中判定：值/原文/标签/sig/模式，任一包含关键词即可
      const hit = q
        ? [f.text, f.value, f.label, f.sig, f.pattern].some((s) => String(s ?? '').includes(q))
        : false;
      const tierRank = { hard: 4, long: 3, general: 2, temp: 1 }[f.tier] || 0;
      // v8 反自强化：被判定「无关」2 次以上的事实检索降权（不删、可恢复）
      const badPenalty = (Number(f.badHits) || 0) >= 2 ? 500 : 0;
      return { ...d, badHits: Number(f.badHits) || 0, hit, rank: tierRank * 1000 + d.score + (hit ? 500 : 0) - badPenalty };
    })
    // 有关键词时只返回真正命中的事实：档位再高也不能因为"hard"就混进无关结果
    .filter((r) => (q ? r.hit : true))
    .sort((a, b) => b.rank - a.rank);

  // v8 版本链（默认关）：同主题只保留最新一条；includeHistory=true 返回全量供审计
  let out = ranked;
  if (cfg.versioning && !includeHistory) {
    const latest = new Map();
    for (const r of ranked) {
      const k = r.topic || r.sig || r.id;
      const cur = latest.get(k);
      if (!cur || (r.lastAt || 0) > (cur.lastAt || 0)) latest.set(k, r);
    }
    out = ranked.filter((r) => latest.get(r.topic || r.sig || r.id) === r);
    for (const r of out) {
      const k = r.topic || r.sig || r.id;
      // 版本数 = max(库里记的 supersede 次数, 同主题当前可见条数)，不能覆盖成 1
      const seen = ranked.filter((x) => (x.topic || x.sig || x.id) === k).length;
      r.versions = Math.max(Number(r.versions) || 1, seen);
    }
  }
  return out.slice(0, Math.max(1, Number(limit) || 5));
}
