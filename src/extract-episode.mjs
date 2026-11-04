// 从情境段（episode）里抽 entry（记忆 3.0 P2/P3 的「模型主力抽取」）。
//
// 与 extract-model.mjs 的区别：
// - 输入是**情境段**（一段连续对话 + 它当时的摘要），不是一天里散落的消息；
// - 输出直接带 topicId + slot，天然成簇（「极速谷6 → 版本：顶级版 / 最爱：M9 GT9RS」）；
// - 只吃净对话（用户原话 + 她发出的话 + 她的想法），不把注入的记忆块当证据，避免「卡→窗口→抽取」自我繁殖；
// - 只产候选，写不写由调用方（--write）决定；quote 必须能在情境段的净对话里逐字找到。
import * as model from './model.mjs';
import {
  SLOTS,
  SLOT_LABEL,
  DEFAULT_TOPICS,
  SLOT_ORDER,
  readTopics
} from './topics.mjs';
import { episodeTranscript } from './episode-ai.mjs';
import { readTurns } from './window.mjs';
import { parseTime, parseBirthday, birthdayWho } from './timeparse.mjs';
import { readEvents, materialize, readInvalidated, appendEvent } from './longterm.mjs';

// 单值槽位：同一个主题下只保留最新一条（旧值会被 supersede 成「以前提过」）。
const SINGLE_SLOTS = new Set([
  'identity', 'nickname', 'birthday', 'residence', 'job', 'school',
  'game', 'edition', 'plan', 'progress', 'stance', 'routine', 'food', 'pet', 'contact'
]);

// 槽位 → (class, tier)，决定衰减与卡片位置
const SLOT_PROFILE = {
  identity: ['fact', 'hard'],
  nickname: ['fact', 'hard'],
  birthday: ['fact', 'hard'],
  residence: ['fact', 'long'],
  job: ['fact', 'long'],
  school: ['fact', 'long'],
  skill: ['fact', 'long'],
  gear: ['fact', 'long'],
  game: ['fact', 'long'],
  edition: ['fact', 'long'],
  pref: ['fact', 'general'],
  pet: ['fact', 'long'],
  food: ['fact', 'general'],
  routine: ['fact', 'general'],
  plan: ['plan', 'long'],
  progress: ['plan', 'general'],
  intel: ['intel', 'long'],
  material: ['material', 'long'],
  stance: ['stance', 'long'],
  event: ['event', 'general'],
  note: ['note', 'general'],
  contact: ['fact', 'long']
};

function hash32(s) {
  let h = 2166136261;
  const t = String(s || '');
  for (let i = 0; i < t.length; i += 1) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** 宽一点的「逐字」比较：去空白/标点后比对。 */
export function normalizeQuote(s) {
  return String(s || '')
    .replace(/[\s，。！？、；：""''（）()【】[\]…—\-·,\.!\?;:'"]+/g, '')
    .trim();
}

export function sigOf(topicId, slot, value) {
  const base = `topic:${topicId}:${slot}`;
  return SINGLE_SLOTS.has(slot) ? base : `${base}:${hash32(normalizeQuote(value))}`;
}

/** 提示词：把主题表 + 槽位表 + 净对话交给模型。 */
export function buildPrompt({ episode, transcript, topics }) {
  const topicLine = (topics.length ? topics : DEFAULT_TOPICS)
    .map((t) => `${t.id}（${t.name}${t.parentId ? `，父 ${t.parentId}` : ''}）`)
    .join('；');
  const slotLine = SLOT_ORDER.filter((s) => SLOTS.includes(s))
    .map((s) => `${s}（${SLOT_LABEL[s]}）`)
    .join('、');
  const system = [
    '你在替「助手」整理一段聊天里的长期记忆。只记录用户本人（和助手自己）稳定的事实、偏好、计划、态度、情报，不记录寒暄和一次性状态。',
    `可用主题：${topicLine}。优先复用这些 id；确实没有合适的才新建（2–6 字名词，id 用 t- 开头，最多 2 个）。`,
    `槽位只能从这些里选：${slotLine}。槽位是「一句话能问出来的面」，比如「极速谷6」主题下：版本=顶级版、偏好=M9 GT9RS。`,
    '每条给：topicId、slot、value（2–40 字、一句话、不要语气词）、quote（必须从对话里逐字摘一句作证据）、kind（fact/intel/plan/stance/material/event/note）、confidence（0~1）。',
    '同一件事只写一条；拿不准就别写（宁缺毋滥）。输出 JSON 数组，不要解释。'
  ].join('\n');
  const user = `【情境段】${episode?.day || ''} ${episode?.title || ''}（${episode?.turnFrom}–${episode?.turnTo} 轮）\n\n${transcript}\n\n请输出 JSON 数组。`;
  return { system, userContent: user };
}

const META_RE = /记忆引擎|记忆方案|注入|检索|事实卡|轮转|脚本|方案|测试|bug|白名单|压缩|上下文/;
const OWNER_EVIDENCE = /用户|我(?!们)|咱|俺|本人/;

// 用户的原话证据：事实只能从用户说过的话里来。她的推测/转述（spoken、reply）不能当证据，
// 否则「所以你最近在玩原神吧」这种她的归纳会被抽成用户事实。
export function ownerEvidence(dir, episode, { maxChars = 20000 } = {}) {
  try {
    const rows = readTurns(dir, String(episode?.sessionId || ''), { limit: 400 });
    const from = Number(episode?.turnFrom) || 0;
    const to = Number(episode?.turnTo) || 0;
    const texts = rows
      .filter((r) => {
        const n = Number(r?.turn) || 0;
        if (from && n < from) return false;
        if (to && n > to) return false;
        return true;
      })
      .map((r) => String(r?.userRaw?.text || '').trim())
      .filter(Boolean);
    return texts.join('\n').slice(0, maxChars);
  } catch {
    return '';
  }
}

/** 校验模型返回的一条 entry；不合法返回 {ok:false, reason}。 */
export 
// 引文证据判定：优先看用户原话；她的转述只有在「用户原话里确实出现过该条目的关键信息」时才算数。
function keyTokens(text) {
  const t = String(text || '').toLowerCase();
  const latin = (t.match(/[a-z0-9][a-z0-9.+\-]{1,}/g) || []).filter((x) => x.length >= 2);
  const cjk = [];
  const han = t.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const seg of han.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i += 1) cjk.push(seg.slice(i, i + 2));
  }
  return [...new Set([...latin, ...cjk])];
}

export function evidenceOk(quote, value, ownerText) {
  if (!ownerText) return true;
  const q = normalizeQuote(quote);
  const o = normalizeQuote(ownerText);
  if (q && o.includes(q)) return true;
  const toks = keyTokens(value);
  if (!toks.length) return false;
  const hit = toks.filter((t) => o.includes(t)).length;
  return hit >= 2 && hit / toks.length >= 0.3;
}

function validateEntry(raw, { transcript, ownerText, topics }) {
  const topicId = String(raw?.topicId || '').trim();
  const slot = String(raw?.slot || '').trim();
  const value = String(raw?.value || '').replace(/\s+/g, ' ').trim();
  const quote = String(raw?.quote || '').trim();
  if (!topicId || !/^t-[a-z0-9-]+$/i.test(topicId)) return { ok: false, reason: '主题 id 不合法' };
  if (!SLOTS.includes(slot)) return { ok: false, reason: `槽位不在词表：${slot}` };
  if (value.length < 2 || value.length > 60) return { ok: false, reason: `value 长度 ${value.length}` };
  if (!quote) return { ok: false, reason: '缺少 quote' };
  const hay = normalizeQuote(transcript);
  if (!hay.includes(normalizeQuote(quote))) return { ok: false, reason: 'quote 不在净对话里' };
  const known = new Set((topics.length ? topics : DEFAULT_TOPICS).map((t) => t.id));
  if (!known.has(topicId)) return { ok: false, reason: `主题不存在：${topicId}` };
  const kind = ['fact', 'intel', 'plan', 'stance', 'material', 'event', 'note'].includes(raw?.kind)
    ? raw.kind
    : SLOT_PROFILE[slot]?.[0] || 'fact';
  const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0.7));
  if (confidence < 0.45) return { ok: false, reason: `confidence ${confidence}` };
  // 记忆系统自身的元讨论不进长期库（会挤占事实卡、也不是稳定的事实）
  if (META_RE.test(value)) return { ok: false, reason: '元讨论' };
  // t-identity 的硬属性必须有用户本人证据，否则可能是把助手的事记到用户头上
  if (topicId === 't-identity' && ['identity', 'birthday', 'nickname', 'residence', 'job', 'school'].includes(slot)) {
    if (!OWNER_EVIDENCE.test(quote)) return { ok: false, reason: '缺用户证据' };
  }
  return { ok: true, entry: { topicId, slot, value, quote, kind, confidence } };
}

/** 毫秒或 ISO 字符串都收（episode.atFrom/atTo 是 ISO，用 Number 会变 NaN）。 */
function numAt(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const d = Date.parse(String(v || ''));
  return Number.isFinite(d) ? d : 0;
}

/** entry 的引文在窗口账本里对应哪一轮 —— 时间锚必须是这一轮，不是写入时间。 */
export function turnAtFor(quote, rows = [], episode = null) {
  const q = normalizeQuote(quote);
  if (q) {
    for (const r of rows) {
      const at = numAt(r?.at);
      if (!at) continue;
      const t = normalizeQuote(r?.userRaw?.text || '');
      if (t && (t.includes(q) || (q.length > 12 && q.includes(t.slice(0, 12))))) return at;
    }
  }
  return numAt(episode?.atTo) || numAt(episode?.atFrom) || 0;
}

/** 一条 entry → longterm 的 fact 事件（可直接 appendEvent）。 */
export function factOf(entry, { episode, now = Date.now(), key = '' } = {}) {
  const [cls, tier] = SLOT_PROFILE[entry.slot] || ['fact', 'general'];
  const about = entry.topicId === 't-bot' ? 'bot' : 'user';
  // 3.0 补丁：saidAt 取「那句话所在的那一轮」，validUntil 由相对时间解析给出
  const saidAt = numAt(entry.turnAt) || numAt(episode?.atTo) || numAt(episode?.atFrom) || now;
  const tp = parseTime(`${entry.quote || ''} ${entry.value || ''}`, { refMs: saidAt, slot: entry.slot });
  // 3.0 补丁：生日必须落到日期字段，而不是只在 value 里写「3 月 15 日」。
  const birthday = entry.slot === 'birthday' ? parseBirthday(entry.value || entry.quote || '') : null;
  const bWho = birthday ? birthdayWho(entry.value || '', about) : '';
  return {
    ev: 'fact',
    id: `h-ep-${hash32(`${episode?.id}:${entry.topicId}:${entry.slot}:${entry.value}`)}`,
    sig: sigOf(entry.topicId, entry.slot, entry.value),
    key,
    about,
    pattern: entry.slot,
    label: SLOT_LABEL[entry.slot] || entry.slot,
    value: entry.value,
    text: entry.quote.slice(0, 200),
    quote: entry.quote.slice(0, 200),
    topicId: entry.topicId,
    slot: entry.slot,
    class: entry.kind === 'fact' ? cls : entry.kind,
    source: { model: 'episode', episodeId: episode?.id || '', confidence: entry.confidence },
    tier,
    I: entry.confidence >= 0.85 ? 0.9 : 0.75,
    s: null,
    hits: 1,
    lastAt: now,
    at: now,
    saidAt,
    dates: tp.dates,
    validUntil: tp.validUntil || 0,
    timePhrase: tp.phrase || '',
    timeConfidence: tp.confidence || 0,
    ...(tp.recurring ? { recurring: true } : {}),
    ...(birthday ? { birthday: { ...birthday, who: bWho } } : {}),
    ...(birthday ? { dates: [{ date: birthday.y ? `${birthday.y}-${birthday.key}` : '', kind: 'birthday', who: bWho, yearly: true, phrase: birthday.phrase }] } : {}),
    ...(entry.kind === 'event' ? { ttlDays: 14 } : {}),
    ...(entry.kind === 'plan' ? {} : {})
  };
}

/** 对一段情境段跑一次模型抽取，返回 {ok, entries, dropped, error}。 */
export async function extractEpisode(dir, episode, { request = model.requestModel, topics, maxChars = 6000, timeoutMs = 60000 } = {}) {
  const built = episodeTranscript(dir, episode, { maxChars });
  const transcript = String(built?.text || '');
  if (transcript.length < 40) return { ok: false, entries: [], dropped: [], error: '净对话太短' };
  const known = topics || readTopics(dir);
  const ownerText = ownerEvidence(dir, episode);
  const { system, userContent } = buildPrompt({ episode, transcript, topics: known });
  const res = await request({ caller: 'entry', system, userContent, json: true, maxChars: 4000, timeoutMs });
  if (!res?.ok) return { ok: false, entries: [], dropped: [], error: res?.error || '模型调用失败' };
  const raw = String(res.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return { ok: false, entries: [], dropped: [], error: 'JSON 解析失败' };
  let arr = [];
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, entries: [], dropped: [], error: 'JSON 解析失败' };
  }
  const entries = [];
  const dropped = [];
  for (const item of Array.isArray(arr) ? arr : []) {
    const v = validateEntry(item, { transcript, ownerText, topics: known });
    if (v.ok) entries.push(v.entry);
    else dropped.push({ item, reason: v.reason });
  }
  // 同一段里同 topic+slot 的单值槽位只留置信度最高的一条
  const bySlot = new Map();
  for (const e of entries) {
    const k = SINGLE_SLOTS.has(e.slot) ? `${e.topicId}|${e.slot}` : `${e.topicId}|${e.slot}|${e.value}`;
    const prev = bySlot.get(k);
    if (!prev || e.confidence > prev.confidence) bySlot.set(k, e);
  }
  // 给每条 entry 打上「那句话所在的那一轮」的时间锚（后面 factOf 用它做相对时间基准）
  const from = Number(episode?.turnFrom) || 0;
  const to = Number(episode?.turnTo) || 0;
  let rows = [];
  try {
    rows = readTurns(dir, String(episode?.sessionId || ''), { limit: 400 })
      .filter((r) => { const n = Number(r?.turn) || 0; return (!from || n >= from) && (!to || n <= to); });
  } catch { rows = []; }
  for (const e of bySlot.values()) e.turnAt = turnAtFor(e.quote, rows, episode);
  return { ok: true, entries: [...bySlot.values()], dropped, transcriptChars: transcript.length };
}

/**
 * 把多段 episode 的抽取结果写进长期库（单值槽位复用原 id 追加 supersede，保留版本历史）。
 * @returns {{written:number, updated:number, skippedDup:number, results:Array}}
 */
export async function extractIntoStore(dir, episodes, { write = false, request = model.requestModel, log = () => {} } = {}) {
  const facts = materialize(readEvents(dir).rows, readInvalidated(dir));
  const bySig = new Map(facts.filter((f) => f.status !== 'invalidated' && f.status !== 'merged').map((f) => [f.sig, f]));
  const out = { written: 0, updated: 0, skippedDup: 0, results: [] };
  for (const ep of episodes) {
    const r = await extractEpisode(dir, ep, { request });
    if (!r.ok) {
      out.results.push({ episode: ep.id, day: ep.day, ok: false, error: r.error });
      log(`情境抽取：${ep.id} 跳过（${r.error}）`);
      continue;
    }
    const kept = [];
    for (const entry of r.entries) {
      const sig = sigOf(entry.topicId, entry.slot, entry.value);
      const prev = bySig.get(sig);
      const fact = factOf(entry, { episode: ep, key: 'private:10001' });
      if (prev) {
        if (prev.value === entry.value) {
          out.skippedDup += 1;
          continue;
        }
        if (SINGLE_SLOTS.has(entry.slot)) {
          if (write) {
            appendEvent(
              {
                ev: 'supersede',
                id: prev.id,
                value: entry.value,
                quote: entry.quote.slice(0, 200),
                label: SLOT_LABEL[entry.slot] || entry.slot,
                source: { model: 'episode', episodeId: ep.id, confidence: entry.confidence },
                at: Date.now()
              },
              dir
            );
          }
          out.updated += 1;
          kept.push({ ...entry, action: 'supersede', id: prev.id });
          continue;
        }
        out.skippedDup += 1;
        continue;
      }
      if (write) {
        appendEvent(fact, dir);
        out.written += 1;
      } else {
        out.written += 1;
      }
      bySig.set(sig, fact);
      kept.push({ ...entry, action: 'new', id: fact.id, sig });
    }
    out.results.push({ episode: ep.id, day: ep.day, title: ep.title, ok: true, entries: kept, dropped: r.dropped.length });
  }
  return out;
}
