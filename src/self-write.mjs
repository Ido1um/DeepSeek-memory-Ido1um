// 记忆 3.1 A：自写事实（她自己往记忆引擎里写事实，抽取器只作补充）
//
// 设计要点（见 docs/记忆方案-3.1-正式方案-20261105.md §4）：
//   1. 写进同一份 state/longterm.jsonl（ev:'fact'），不是第二套真源；
//   2. 字段带 author:'self' / voice:'first'，卡片与检索都用她的原句；
//   3. 同一「主题+槽位」单值已有她写的 → 重写走 supersede（旧值留在事件流里）；抽取器不得覆盖；
//   4. 配额：每天 maxPerDay 条、总量 maxTotal 条，只统计 author:'self' 的 fact 事件；
//   5. 时间锚沿用 3.0：saidAt 取她写这条时所在的那一轮，相对时间交给 timeparse。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as lt from './longterm.mjs';
import {
  SLOTS,
  SLOT_LABEL,
  SINGLE_VALUE_SLOTS,
  DEFAULT_TOPICS,
  readTopics,
  topicById,
  classifyFact
} from './topics.mjs';
import { parseTime, parseBirthday, birthdayWho } from './timeparse.mjs';
import { extractEntities } from './entities.mjs';
import { readTurns } from './window.mjs';

export const SELF_WRITE_DEFAULTS = {
  enabled: true,
  maxPerDay: 5,
  maxTotal: 300,
  maxValueChars: 60,
  maxTextChars: 400,
  initialI: 0.7,
  protectFromExtract: true
};

export function normalizeSelfWrite(raw = {}) {
  const out = { ...SELF_WRITE_DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (raw.enabled === false) out.enabled = false;
    for (const k of ['maxPerDay', 'maxTotal', 'maxValueChars', 'maxTextChars', 'initialI']) {
      const n = Number(raw[k]);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    if (raw.protectFromExtract === false) out.protectFromExtract = false;
  }
  out.maxValueChars = Math.max(8, Math.min(200, Math.round(out.maxValueChars)));
  out.maxTextChars = Math.max(40, Math.min(2000, Math.round(out.maxTextChars)));
  out.maxPerDay = Math.max(1, Math.min(50, Math.round(out.maxPerDay)));
  out.maxTotal = Math.max(10, Math.min(5000, Math.round(out.maxTotal)));
  out.initialI = Math.max(0.2, Math.min(1, out.initialI));
  return out;
}

const TIER_BY_SLOT = {
  identity: 'hard', nickname: 'hard', birthday: 'hard', residence: 'hard', job: 'hard',
  school: 'hard', gear: 'hard', pet: 'hard', skill: 'hard', edition: 'hard', game: 'hard',
  plan: 'long', progress: 'long', stance: 'long', intel: 'long', material: 'long',
  event: 'long', pref: 'long', routine: 'general', food: 'general', contact: 'general', note: 'general'
};

const DAY_MS = 86400000;

function dayKey(ms) {
  const t = Number(ms) || Date.now();
  return new Date(t + 8 * 3600000).toISOString().slice(0, 10);
}

export function shortHash(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 10);
}

/** 单值槽位按「主题+槽位」成一条；多值槽位按值区分。 */
export function sigFor(topicId, slot, value) {
  const base = `topic:${topicId}:${slot}`;
  return SINGLE_VALUE_SLOTS.has(slot) ? base : `${base}:${shortHash(value)}`;
}

function topicsOf(dir) {
  const rows = readTopics(dir);
  return Array.isArray(rows) && rows.length ? rows : DEFAULT_TOPICS;
}

function resolveTopicSlot({ value, text, topicId, slot }, dir) {
  const topics = topicsOf(dir);
  const listed = new Set(topics.map((t) => t.id));
  let tid = String(topicId || '').trim();
  let sl = String(slot || '').trim();
  if (tid && !listed.has(tid)) return { ok: false, code: 'unknown-topic', message: `没有这个主题：${tid}` };
  if (sl && !SLOTS.includes(sl)) return { ok: false, code: 'unknown-slot', message: `没有这个槽位：${sl}` };
  if (!tid) {
    const hit = classifyFact({ value, text });
    tid = hit.topicId || 't-life';
    if (!sl) sl = hit.slot || 'note';
  }
  if (!sl) sl = 'note';
  if (!listed.has(tid)) tid = 't-life';
  return { ok: true, topicId: tid, slot: sl, topic: topicById(topics, tid) };
}

export function selfStats(dir, now = Date.now()) {
  const { rows } = lt.readEvents(dir);
  let total = 0;
  let today = 0;
  for (const ev of rows) {
    if (ev?.ev !== 'fact' || ev.author !== 'self') continue;
    total += 1;
    if (dayKey(ev.saidAt || ev.at) === dayKey(now)) today += 1;
  }
  return { total, today };
}

/** 归一化引文（空白、全半角），用于「引文必须能在那一轮里查到」的校验。 */
function norm(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/["'“”‘’]/g, '')
    .replace(/\s+/g, '');
}

/** 从窗口账本里取这一轮的净文本（用于引文校验与锚点）。 */
function turnRowOf(dir, sessionId, turn) {
  if (!sessionId || !turn) return null;
  try {
    const rows = readTurns(dir, sessionId, { limit: 2000 });
    return rows.find((r) => Number(r?.turn) === Number(turn)) || null;
  } catch {
    return null;
  }
}

export function validateSelfWrite(input, { dir = '', now = Date.now(), cfg } = {}) {
  const c = normalizeSelfWrite(cfg);
  if (!c.enabled) return { ok: false, code: 'disabled', message: '自写事实已关闭' };
  const rawText = String(input.text ?? '').trim();
  let value = String(input.value ?? '').trim();
  if (!value && rawText) {
    value = rawText.split(/[。！？!?\n]/)[0].trim();
    if (value.length > c.maxValueChars) value = value.slice(0, c.maxValueChars);
  }
  if (!value) return { ok: false, code: 'empty', message: 'value 不能为空（或给 text，我会取第一句）' };
  if (value.length < 2) return { ok: false, code: 'value-short', message: 'value 至少 2 个字' };
  if (value.length > c.maxValueChars) {
    return { ok: false, code: 'value-long', message: `value 最多 ${c.maxValueChars} 字，长内容放 text` };
  }
  if (rawText.length > c.maxTextChars) {
    return { ok: false, code: 'text-long', message: `text 最多 ${c.maxTextChars} 字` };
  }
  const placement = resolveTopicSlot({ value, text: rawText, topicId: input.topicId, slot: input.slot }, dir);
  if (!placement.ok) return placement;
  const quote = String(input.quote ?? '').trim();
  let src = null;
  if (quote) {
    const row = turnRowOf(dir, input.sessionId, input.turn);
    const hay = row ? norm(`${row?.userRaw?.text || ''}${(row?.spoken || []).map((s) => s?.text || '').join('')}${row?.reply?.text || ''}`) : '';
    if (!hay || !hay.includes(norm(quote))) {
      return { ok: false, code: 'quote-unverified', message: '引文在那一轮里找不到；可以去掉 quote 重写' };
    }
    src = { kind: 'window', sessionId: String(input.sessionId), turnFrom: Number(input.turn), turnTo: Number(input.turn), quote: quote.slice(0, 200), sha1: crypto.createHash('sha1').update(norm(quote)).digest('hex') };
  }
  const stats = selfStats(dir, now);
  if (stats.today >= c.maxPerDay) return { ok: false, code: 'quota-day', message: `今天已经写了 ${stats.today} 条（上限 ${c.maxPerDay}）` };
  if (stats.total >= c.maxTotal) return { ok: false, code: 'quota-total', message: `总量已到上限 ${c.maxTotal} 条` };
  return {
    ok: true,
    value,
    text: rawText || value,
    quote,
    src,
    topicId: placement.topicId,
    slot: placement.slot,
    topicName: placement.topic?.name || placement.topicId,
    stats
  };
}

/**
 * 写一条自写事实。
 * @returns {{ok:boolean, action?:'created'|'superseded'|'duplicate', fact?:object, message?:string, code?:string}}
 */
export function writeSelfFact(input = {}, { dir = '', key = '', now = Date.now(), cfg } = {}) {
  const c = normalizeSelfWrite(cfg);
  const v = validateSelfWrite(input, { dir, now, cfg: c });
  if (!v.ok) return v;

  const saidAt = Number(input.at) || now;
  const tp = parseTime(`${v.value} ${v.text}`, { refMs: saidAt, slot: v.slot });
  const birthday = v.slot === 'birthday' ? parseBirthday(v.value || v.text) : null;
  const bWho = birthday ? birthdayWho(v.value || '', v.topicId === 't-bot' ? 'bot' : 'user') : '';
  const entities = extractEntities(`${v.value || ''} ${v.text || ''}`, { about: v.topicId === 't-bot' ? 'bot' : 'user' });
  const dates = birthday
    ? [{ date: birthday.y ? `${birthday.y}-${birthday.key}` : '', kind: 'birthday', who: bWho, yearly: true, phrase: birthday.phrase }]
    : tp.dates;

  const facts = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir), now);
  const same = facts.filter((f) => f.status === 'active' && f.topicId === v.topicId && f.slot === v.slot);
  const existingSelf = same.find((f) => f.author === 'self');
  const sameValue = same.find((f) => norm(f.value) === norm(v.value));

  const common = {
    value: v.value,
    text: v.text.slice(0, c.maxTextChars),
    quote: v.quote ? v.quote.slice(0, 200) : v.value,
    saidAt,
    dates,
    validUntil: tp.validUntil || 0,
    timePhrase: tp.phrase || '',
    timeConfidence: tp.confidence || 0,
    author: 'self',
    voice: 'first',
    at: now
  };
  if (birthday) {
    common.birthday = { ...birthday, who: bWho };
    common.source = { model: 'self', sessionId: String(input.sessionId || ''), turn: Number(input.turn) || 0 };
  }

  if (sameValue) {
    return { ok: true, action: 'duplicate', fact: sameValue, message: '这条已经在了，没重复写' };
  }

  if (SINGLE_VALUE_SLOTS.has(v.slot)) {
    const target = existingSelf || same[0] || null;
    if (target) {
      lt.appendEvent({
        ev: 'supersede',
        id: target.id,
        ...common,
        source: { model: 'self', sessionId: String(input.sessionId || ''), turn: Number(input.turn) || 0 },
        by: 'self',
        revision: (Number(target.versions) || 1) + 1,
        ...(v.src ? { src: v.src } : {})
      }, dir);
      const updated = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir), now).find((f) => f.id === target.id);
      return {
        ok: true,
        action: 'superseded',
        fact: updated || target,
        message: `已更新：${v.topicName} / ${SLOT_LABEL[v.slot] || v.slot}`
      };
    }
  }

  const id = lt.newId('h-self');
  const row = {
    ev: 'fact',
    id,
    sig: sigFor(v.topicId, v.slot, v.value),
    key,
    about: v.topicId === 't-bot' ? 'bot' : 'user',
    pattern: v.slot,
    label: SLOT_LABEL[v.slot] || v.slot,
    value: v.value,
    text: v.text.slice(0, c.maxTextChars),
    quote: v.quote ? v.quote.slice(0, 200) : v.value,
    topicId: v.topicId,
    slot: v.slot,
    class: String(input.kind || 'note'),
    source: { model: 'self', sessionId: String(input.sessionId || ''), turn: Number(input.turn) || 0 },
    src: v.src,
    tier: TIER_BY_SLOT[v.slot] || 'general',
    I: c.initialI,
    s: null,
    hits: 1,
    lastAt: now,
    at: now,
    saidAt,
    dates,
    validUntil: tp.validUntil || 0,
    timePhrase: tp.phrase || '',
    timeConfidence: tp.confidence || 0,
    author: 'self',
    voice: 'first',
    ...(birthday ? { birthday: { ...birthday, who: bWho } } : {}),
    ...(entities ? { entities } : {}),
    status: 'active'
  };
  lt.appendEvent(row, dir);
  const fact = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir), now).find((f) => f.id === id) || row;
  return {
    ok: true,
    action: 'created',
    fact,
    message: `记在：${v.topicName} / ${SLOT_LABEL[v.slot] || v.slot}`
  };
}

/**
 * 抽取器写库前的守卫：同一个「主题+槽位」已有她写的事实，就只允许补空槽/多值新值。
 * 返回 {skip:boolean, reason, id}
 */
export function shouldSkipExtract(dir, { topicId = '', slot = '', value = '' } = {}, { cfg } = {}) {
  const c = normalizeSelfWrite(cfg);
  if (!c.enabled || !c.protectFromExtract) return { skip: false };
  if (!topicId || !slot) return { skip: false };
  const facts = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir), Date.now());
  const same = facts.filter((f) => f.status === 'active' && f.author === 'self' && f.topicId === topicId && f.slot === slot);
  if (!same.length) return { skip: false };
  if (SINGLE_VALUE_SLOTS.has(slot)) return { skip: true, reason: 'self', id: same[0].id };
  const dup = same.find((f) => norm(f.value) === norm(value));
  if (dup) return { skip: true, reason: 'self', id: dup.id };
  return { skip: false };
}

/** 被挡下的抽取候选写进 staging，日终报告计数，不打扰她。 */
export function recordExtractSkip(dir, { topicId, slot, value, quote, source } = {}) {
  const file = path.join(dir, 'state', 'staging.jsonl');
  const row = {
    at: Date.now(),
    kind: 'extract-skip',
    reason: 'self',
    topicId: topicId || '',
    slot: slot || '',
    value: String(value || '').slice(0, 200),
    quote: String(quote || '').slice(0, 200),
    source: source || null
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    /* staging 写失败不影响抽取 */
  }
  return row;
}
