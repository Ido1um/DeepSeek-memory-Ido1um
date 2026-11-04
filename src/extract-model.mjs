// 路线 A：日终模型抽取（影子优先，默认关）。
//
// 设计（见 docs/路线A-模型抽取方案.md）：
// - 只取「当天、用户说的」消息，分批交给模型，要求严格 JSON 候选；
// - 模型只产候选，规则做硬门：quote 逐字子串、value 形状、topic 白名单、去重、封顶；
// - 默认只写 state/extract-shadow.jsonl（不写事件流）；modelWrite=true 才落 fact 事件；
// - 任何失败都只记影子行与返回值，不抛异常、不阻塞日终。
import fs from 'node:fs';
import path from 'node:path';

import { recentMessages } from './store.mjs';
import * as lt from './longterm.mjs';
import { requestModel } from './model.mjs';
import { writeGate } from './gate.mjs';
import { normalizeConfig as normalizeScoring, stabilityOf } from './score.mjs';
import { classOf, subjectTag } from './facts.mjs';
import { attrsOf, fragmentsOf, loadV10 } from './v10.mjs';
import { normalizeNote } from './scoring-runner.mjs';
import { appendCandidates, readCandidates } from './candidates.mjs';

export const EXTRACT_DEFAULTS = {
  enabled: false,
  modelWrite: false,
  batchSize: 24,
  maxBatchesPerDay: 6,
  maxFactsPerDay: 8,
  minConfidence: 0.6,
  timeoutMs: 30000,
  promptVersion: 'a2',
  model: '',
  shadowFile: 'extract-shadow.jsonl',
  maxMessagesPerDay: 300,
  maxCharsPerBatch: 12000
};

const ATTR_KEYS = new Set(['birthday', 'name', 'nickname', 'residence', 'job', 'skill', 'pet', 'hobby', 'gear']);
const ATTR_LABEL = {
  birthday: '生日',
  name: '名字',
  nickname: '称呼',
  residence: '住处',
  job: '工作',
  skill: '在学',
  pet: '宠物',
  hobby: '爱好',
  gear: '器材'
};
// 爱好/器材可以有多件：按「值」再加一层键，避免第二台相机把第一台覆盖掉
const MULTI_VALUE_ATTRS = new Set(['hobby', 'gear']);
const TOPIC_ATTR_RE = /^user:(birthday|name|nickname|residence|job|skill|pet|hobby|gear)$/;
const TOPIC_PREF_RE = /^user:pref:.{1,16}$/;
const TOPIC_NOTE_RE = /^user:note$/;
const TOPIC_EVENT_RE = /^user:event$/;
const TOPIC_TASK_RE = /^user:task:\d{4}-\d{2}-\d{2}$/;
const KIND_SET = new Set(['fact', 'pref', 'note', 'event', 'task']);

// 主语白名单：只接受「用户侧」且不是「你」（你 = 机器人）。
const SELF_SUBJECTS = new Set(['我', '咱', '俺', '用户']);
const REL_SUBJECTS = new Set(['我妈', '我爸', '我家', '室友', '朋友', '同学', '同事', '老师', '哥哥', '姐姐', '弟弟', '妹妹', '家人']);

// value 开头的动词/代词/连词：命中就拒（中文没有分词器，只拦开头）。
const BAD_VALUE_START = /^(是|有|在|要|会|想|去|来|吃|喝|玩|看|买|用|打|做|养|学|住|工作|上班|上课|交|考|参加|喜欢|爱|讨厌|觉得|认为|感觉|记住|提醒|说|讲|问|告诉|答应|决定|计划|准备|我|你|他|她|它|这|那|就|才|还|也|都|的|了)/;
const BAD_VALUE_BODY = /[。！？!?…，,；;：:]/;
/** 纯版本/档位词：记下来没有任何信息量（影子报告里出现过「顶级版」）。 */
const JUNK_VALUE = /^(顶级|顶配|标准|高配|豪华|旗舰|入门|基础|普通|最新|高级|低配|中配|满配)(版|款|配)?$/;

// ── v2 语义门（v11 宽进归并：影子复查中精确率 37.5%，四类错因各配一道门）──
// 这些门只看原文，不做推断；宁可漏，不可错——错一条会被复习机制反复强化。
const SELF_REF = /(我|咱|俺|本人|用户)/;
/** 版本名/资料片/地图/单件型号：不是稳定的偏好大类。 */
const EDITION_VALUE = /(顶级版|豪华版|标准版|年度版|旗舰版|终极版|系列|版本|资料片|地图|DLC|原厂|改装)/i;
const PREF_VERB = /(喜欢|爱|讨厌|不爱|不吃|受不了|最爱|迷上|上瘾)/;
const GREETING_QUOTE = /(生日快乐|祝你|你好|早安|晚安|谢谢|辛苦|恭喜)/;
const FUTURE_QUOTE = /(要|会|打算|准备|计划|想去|想买|明天|下周|周末|以后|将来|下次)/;
const PAST_QUOTE = /(了|过|已经|昨天|上周|刚才|之前)/;

/**
 * 语义门：validateCandidate 的硬门之后、返回候选之前。
 * 返回 '' 表示通过，否则返回原因码（与 validateCandidate 的 reason 同格式）。
 */
export function semanticGate(cand = {}) {
  const kind = String(cand.kind || '');
  const topic = String(cand.topic || '');
  const value = String(cand.value || '');
  const quote = String(cand.quote || '');
  const attr = topic.match(TOPIC_ATTR_RE);

  // 1) 称呼/祝福被当成用户属性（影子事故：「生日快乐，助手」→ user:name 助手）
  if (kind === 'fact' && attr && attr[1] === 'name' && GREETING_QUOTE.test(quote)) return 'bot-name';

  // 2) 属性类事实必须有本人自指的明确陈述
  if (kind === 'fact' && attr && !SELF_REF.test(quote)) return 'attr-evidence';

  // 3) 偏好必须有偏好动词；4) 偏好对象不能是版本/系列/单件
  if (kind === 'pref') {
    if (!PREF_VERB.test(quote)) return 'pref-verb';
    if (EDITION_VALUE.test(value)) return 'edition';
  }

  // 5) 事件只记已发生；未来计划先放掉（要做的事交给 task）
  if (kind === 'event' && FUTURE_QUOTE.test(quote) && !PAST_QUOTE.test(quote)) return 'event-future';

  return '';
}

// ── 配置 ────────────────────────────────────────────────────────────────

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 把桥接 config.memory.extract 归一成可用配置（非法值回落默认，绝不抛）。 */
export function normalizeExtract(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: r.enabled === true,
    modelWrite: r.modelWrite === true,
    batchSize: Math.round(num(r.batchSize, EXTRACT_DEFAULTS.batchSize, 10, 40)),
    maxBatchesPerDay: Math.round(num(r.maxBatchesPerDay, EXTRACT_DEFAULTS.maxBatchesPerDay, 1, 24)),
    maxFactsPerDay: Math.round(num(r.maxFactsPerDay, EXTRACT_DEFAULTS.maxFactsPerDay, 1, 40)),
    minConfidence: num(r.minConfidence, EXTRACT_DEFAULTS.minConfidence, 0, 1),
    timeoutMs: Math.round(num(r.timeoutMs, EXTRACT_DEFAULTS.timeoutMs, 5000, 120000)),
    promptVersion: String(r.promptVersion || EXTRACT_DEFAULTS.promptVersion).slice(0, 16),
    model: String(r.model || '').slice(0, 80),
    shadowFile: String(r.shadowFile || EXTRACT_DEFAULTS.shadowFile).replace(/[\\/]/g, '').slice(0, 60) || EXTRACT_DEFAULTS.shadowFile,
    maxMessagesPerDay: Math.round(num(r.maxMessagesPerDay, EXTRACT_DEFAULTS.maxMessagesPerDay, 20, 600)),
    maxCharsPerBatch: Math.round(num(r.maxCharsPerBatch, EXTRACT_DEFAULTS.maxCharsPerBatch, 2000, 40000))
  };
}

// ── 取数与分批 ──────────────────────────────────────────────────────────

function startOfLocalDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const SKIP_MARKERS = /\[(图片|语音|视频|表情|动图|文件|位置|转发消息|回复|引用)/;

/** 当天用户侧、值得看的消息（按时间正序）；过滤附件/命令/太短/重复。 */
export function pickMessages(rows = [], now = Date.now(), cfg = EXTRACT_DEFAULTS) {
  const start = startOfLocalDay(now);
  const out = [];
  let lastText = '';
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.role !== 'user') continue;
    const ts = new Date(row.ts).getTime();
    if (!Number.isFinite(ts) || ts < start || ts > now) continue;
    const text = String(row.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 6 || text.length > 400) continue;
    if (SKIP_MARKERS.test(text)) continue;
    if (/^[/!.]/.test(text)) continue;
    if (text === lastText) continue;
    lastText = text;
    out.push({ text, ts });
  }
  const cap = Math.max(20, Number(cfg.maxMessagesPerDay) || EXTRACT_DEFAULTS.maxMessagesPerDay);
  return out.slice(-cap);
}

/** 按条数与字符预算切批。 */
export function buildBatches(messages = [], cfg = EXTRACT_DEFAULTS) {
  const size = Math.max(1, Number(cfg.batchSize) || EXTRACT_DEFAULTS.batchSize);
  const maxChars = Math.max(500, Number(cfg.maxCharsPerBatch) || EXTRACT_DEFAULTS.maxCharsPerBatch);
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const m of messages) {
    const add = m.text.length + 6;
    if (cur.length && (cur.length >= size || chars + add > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(m);
    chars += add;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ── Prompt 与解析 ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  '你是 QQ 私聊的记忆抽取器。下面是一天内用户的若干条消息，每条以 [n] 开头。',
  '只从消息原文里摘取「值得长期记住」的事实，不要推断、不要总结、不要改写。',
  '',
  '输出要求：只输出一个 JSON 数组，不要 Markdown 代码围栏，不要任何解释文字。',
  '每个元素字段：{kind, about, subject, topic, value, quote, confidence}（kind=task 时加 due）。',
  '',
  '规则：',
  '- 每条消息最多 1 条候选；没有值得记的就跳过。',
  '- quote 必须是某条消息里连续出现的原文，逐字复制，不改标点、不补字。',
  '- value 是 2–20 字的名词性短语（不要动词开头、不要句号问号）。',
  '- kind ∈ fact | pref | note | event | task。',
  '- kind=fact 只能配属性类 topic；kind=pref 配 user:pref:<对象>；kind=note 配 user:note；kind=event 配 user:event；kind=task 配 user:task:<YYYY-MM-DD> 并给 due（YYYY-MM-DD）。',
  '- about 只能是 user；subject 是消息里的主语（我 / 我妈 / 我爸 / 室友 …），不是「你」。',
  '- confidence 0–1，没把握就给低分。',
  '',
  'topic 白名单：',
  '  user:birthday | user:name | user:nickname | user:residence | user:job | user:skill | user:pet',
  '  user:hobby | user:gear | user:pref:<对象> | user:note | user:event | user:task:<YYYY-MM-DD>',
  '',
  '分类口径（重要）：',
  '- user:skill = 正在学的新技能（「在学吉他」）；不要用它记爱好。',
  '- user:hobby = 长期爱好、平时常做的事（摄影 / 骑车 / 摄影器材玩得深也算）→ value 就写爱好名（2–10 字，如「摄影」）。',
  '- user:gear = 自己拥有的器材/装备（相机、镜头、车、乐器）→ value 写名称（可到 24 字，如「Z8X 相机和 2875ZA 镜头」）。',
  '- user:pet 只放宠物（猫狗鸟…），不要把器材写进 pet。',
  '- 拿不准是爱好还是偏好时，优先用 user:hobby。',
  '',
  '严格边界（写错比漏记更糟）：',
  '- 属性类 fact（name/nickname/birthday/residence/job/skill/pet/hobby/gear）必须是用户本人对「自己」的明确陈述，quote 里要有「我 / 咱 / 俺 / 本人 / 用户」；问候、祝福、称呼别人（如「生日快乐，某名字」）不算。',
  '- kind=pref 必须在原文里有明确偏好动词（喜欢 / 爱 / 讨厌 / 不爱 / 不吃 / 受不了 / 最爱 / 迷上 / 上瘾）；只是「拥有/在用」的东西写 user:gear 或 user:hobby，不要写 pref。',
  '- pref 的 value 是稳定的偏好大类（火锅、游戏、摄影），不要写版本名/资料片/地图/单件型号（「顶级版」「极速谷6」「英国地图」「原厂示例车厂」都不算）。',
  '- kind=event 只记已经发生的事；「要/打算/准备/计划/想去/想买/明天/下周/周末/以后」这类未来安排不要记 event（要做的事走 task）。',
  '- 一条消息最多 1 条候选；同一兴趣不要拆成多条。',
  '',
  '示例：',
  '[{"kind":"fact","about":"user","subject":"我","topic":"user:birthday","value":"3月15日","quote":"我生日是11月2号","confidence":0.93},',
  ' {"kind":"task","about":"user","subject":"我","topic":"user:task:2026-11-09","value":"物理实验报告","quote":"下下个星期一要交物理实验报告","confidence":0.9,"due":"2026-11-09"}]'
].join('\n');

export function buildPrompt(messages = []) {
  const lines = messages.map((m, i) => `[${i + 1}] ${m.text}`).join('\n');
  return {
    system: SYSTEM_PROMPT,
    userContent: [`消息（共 ${messages.length} 条）：`, '', lines, '', '请只输出 JSON 数组。'].join('\n')
  };
}

/** 从模型输出里抠 JSON 数组：容忍代码围栏、前后解释、单个对象包装。 */
export function parseModelJson(text = '') {
  let raw = String(text || '');
  raw = raw.replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  try {
    let parsed = JSON.parse(raw);
    if (parsed && !Array.isArray(parsed)) {
      if (Array.isArray(parsed.candidates)) parsed = parsed.candidates;
      else if (Array.isArray(parsed.items)) parsed = parsed.items;
      else parsed = [parsed];
    }
    if (!Array.isArray(parsed)) return { ok: false, candidates: [], error: '不是数组' };
    return { ok: true, candidates: parsed.filter((x) => x && typeof x === 'object'), error: '' };
  } catch (error) {
    return { ok: false, candidates: [], error: String(error?.message ?? error) };
  }
}

// ── 硬校验 ──────────────────────────────────────────────────────────────

function normValue(v) {
  return String(v || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function bigrams(s) {
  const out = new Set();
  const t = String(s || '');
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function isValidDue(due, now = Date.now()) {
  const s = String(due || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ts = new Date(`${s}T00:00:00`).getTime();
  if (!Number.isFinite(ts)) return false;
  const dayStart = startOfLocalDay(now);
  return ts >= dayStart - 86400000 && ts <= now + 366 * 86400000;
}

/**
 * 校验单条候选。返回 { ok, reason, candidate }：ok 时 candidate 是归一后的候选。
 * ctx: { messages, now, cfg, existing, seen }
 */
export function validateCandidate(raw, ctx = {}) {
  const { messages = [], now = Date.now(), cfg = EXTRACT_DEFAULTS, scoring = null } = ctx;
  const c = raw && typeof raw === 'object' ? raw : {};
  const kind = String(c.kind || '').trim();
  const about = String(c.about || '').trim();
  const subject = String(c.subject || '').trim();
  const topic = String(c.topic || '').trim();
  const value = String(c.value || '').trim();
  const quote = String(c.quote || '').trim();
  const confidence = Number(c.confidence);

  const reject = (reason) => ({ ok: false, reason, candidate: null });

  if (!kind || !about || !subject || !topic || !value || !quote || !Number.isFinite(confidence)) return reject('shape');
  if (!KIND_SET.has(kind)) return reject('kind');
  if (about !== 'user') return reject('about');
  if (subject === '你' || !(SELF_SUBJECTS.has(subject) || REL_SUBJECTS.has(subject))) return reject('subject');

  if (quote.length < 4 || quote.length > 80) return reject('quote');
  const src = messages.find((m) => String(m.text || '').includes(quote));
  if (!src) return reject('quote');

  if (value.length < 2 || value.length > 20) return reject('value');
  if (value === quote) return reject('value');
  if (BAD_VALUE_START.test(value) || BAD_VALUE_BODY.test(value)) return reject('value');
  // 值太碎：纯版本/档位词（「顶级版」「标准版」），记了也用不上
  if (JUNK_VALUE.test(value)) return reject('junk');

  const attrMatch = topic.match(TOPIC_ATTR_RE);
  const isPref = TOPIC_PREF_RE.test(topic);
  const isNote = TOPIC_NOTE_RE.test(topic);
  const isEvent = TOPIC_EVENT_RE.test(topic);
  const isTask = TOPIC_TASK_RE.test(topic);
  if (!attrMatch && !isPref && !isNote && !isEvent && !isTask) return reject('topic');

  const kindTopicOk =
    (kind === 'fact' && Boolean(attrMatch)) ||
    (kind === 'pref' && isPref) ||
    (kind === 'note' && isNote) ||
    (kind === 'event' && isEvent) ||
    (kind === 'task' && isTask);
  if (!kindTopicOk) return reject('topic-kind');

  if (attrMatch) {
    const key = attrMatch[1];
    if (key === 'birthday' && !/(\d{1,2})\s*[月/-]\s*(\d{1,2})|(\d{4})\s*[-/年]/.test(value)) return reject('attr');
    // 爱好短值合法（摄影 / 骑摩托），器材名会长一些（Z8X 相机和 2875ZA 镜头）
    const limit = key === 'birthday' ? 24 : key === 'gear' ? 24 : key === 'hobby' ? 10 : 12;
    if (key !== 'birthday' && value.length > limit) return reject('attr');
  }

  if (isTask) {
    const due = String(c.due || (topic.split(':')[2] || '')).trim();
    if (!isValidDue(due, now)) return reject('due');
    if (topic !== `user:task:${due}`) return reject('topic-kind');
  }

  if (confidence < Number(cfg.minConfidence ?? EXTRACT_DEFAULTS.minConfidence)) return reject('confidence');

  // 属性类事实的 quote 往往是「这是我的相机」这种，按 note 判会误伤短值；统一按 pref 的口径过门
  const cls = attrMatch ? 'pref' : kind === 'fact' ? classOf(quote, { dueAt: false }) : kind === 'task' ? 'task' : kind === 'pref' ? 'pref' : kind === 'event' ? 'event' : 'note';
  const gate = writeGate(quote, { about, class: cls, value, text: quote, pattern: kind, label: kind }, { cfg: normalizeScoring(scoring || {}) });
  if (!gate.ok) return reject(`gate:${gate.reason}`);

  const sem = semanticGate({ kind, topic, value, quote });
  if (sem) return reject(sem);

  const cand = {
    kind,
    about,
    subject,
    topic,
    value,
    quote,
    confidence: Math.round(confidence * 100) / 100,
    class: cls,
    ...(isTask ? { due: String(c.due || topic.split(':')[2]) } : {})
  };
  return { ok: true, reason: '', candidate: cand };
}

// ── 去重与映射 ──────────────────────────────────────────────────────────

function shortHash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i += 1) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

function isDuplicate(cand, existing = []) {
  const cv = normValue(cand.value);
  const cbg = bigrams(cv);
  for (const f of existing) {
    const fv = normValue(f.value);
    if (!fv) continue;
    if (String(f.topic || '') === cand.topic) {
      if (fv === cv) return 'dup';
      if (fv.includes(cv) || cv.includes(fv)) return 'dup';
      if (jaccard(bigrams(fv), cbg) >= 0.6) return 'dup';
    }
    if ((cand.class === 'pref' || cand.class === 'note') && f.class === cand.class && fv === cv) return 'dup';
  }
  return '';
}

/** 候选 → fact 事件行（与规则版写事件保持同一套字段）。 */
export function candidateToEvent(cand, { now = Date.now(), cfg = EXTRACT_DEFAULTS, v10cfg = null } = {}) {
  const about = cand.about || 'user';
  const attr = cand.topic.match(TOPIC_ATTR_RE);
  let sig;
  let pattern;
  let label;
  if (attr) {
    pattern = attr[1];
    label = ATTR_LABEL[pattern] || pattern;
    const tag = subjectTag(cand.subject);
    const base = tag ? `${about}:${tag}:${pattern}` : `${about}:${pattern}`;
    sig = MULTI_VALUE_ATTRS.has(pattern) ? `${base}:${shortHash(cand.value)}` : base;
  } else if (cand.kind === 'pref') {
    pattern = 'pref';
    label = '偏好';
    sig = `${about}:pref:${cand.value}`;
  } else if (cand.kind === 'task') {
    pattern = 'task';
    label = '待办';
    sig = `user:task:${shortHash(normalizeNote(cand.value) + `|${cand.due}`)}`;
  } else if (cand.kind === 'event') {
    pattern = 'event';
    label = '事件';
    sig = `user:event:${shortHash(normalizeNote(cand.value))}`;
  } else {
    pattern = 'note';
    label = '备注';
    sig = `user:note:${shortHash(normalizeNote(cand.value))}`;
  }

  const tier = attr ? (MULTI_VALUE_ATTRS.has(pattern) ? 'long' : 'hard') : 'general';
  const sCfg = normalizeScoring({});
  const s = stabilityOf({ tier, class: cand.class }, sCfg);
  const I = attr ? (MULTI_VALUE_ATTRS.has(pattern) ? 0.85 : 1) : cand.kind === 'task' ? 0.9 : cand.kind === 'pref' ? 0.7 : cand.kind === 'event' ? 0.7 : 0.8;
  const dueAt = cand.due ? new Date(`${cand.due}T09:00:00`).getTime() : 0;

  const row = {
    ev: 'fact',
    id: lt.newId('h'),
    sig,
    key: '',
    about,
    pattern,
    label,
    value: cand.value,
    text: cand.quote.slice(0, 200),
    quote: cand.quote.slice(0, 200),
    topic: cand.topic,
    class: cand.class,
    source: { model: 'extract', promptVersion: cfg.promptVersion || 'a2', confidence: cand.confidence },
    tier,
    I,
    s: Number.isFinite(s) ? Math.round(s * 100) / 100 : null,
    hits: 1,
    lastAt: now,
    at: now,
    // 事件有时效：默认 7 天，到点由 settle 标 expire（score.tierAfter 读 ttlDays）
    ...(cand.kind === 'event' ? { ttlDays: Number(cfg.eventTtlDays) || 7 } : {}),
    ...(cand.due ? { task: true, due: cand.due, dueAt, duePhrase: cand.quote.slice(0, 40) } : {})
  };

  if (v10cfg && v10cfg.enabled) {
    const a = attrsOf(`${cand.quote} ${cand.value}`);
    if (a.emo != null) {
      row.emo = a.emo;
      row.rel = a.rel || 0;
      row.scene = a.scene || [];
      row.fragments = fragmentsOf(cand.quote, cand.value, v10cfg.fragmentsMax || 3);
    }
  }
  return row;
}

// ── 影子文件 ────────────────────────────────────────────────────────────

export function shadowPath(dir = '') {
  const base = lt.paths(dir).state;
  return path.join(base, EXTRACT_DEFAULTS.shadowFile);
}

function appendShadowLines(dir, lines = []) {
  if (!lines.length) return 0;
  try {
    const file = shadowPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    fs.appendFileSync(file, body, 'utf8');
    return lines.length;
  } catch {
    return 0;
  }
}

export function readShadowLines(dir = '') {
  const file = shadowPath(dir);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* 坏行跳过 */
    }
  }
  return rows;
}

/** 给工作台/报告用：按天汇总 + 最近候选（只读）。 */
export function summarizeShadow(dir = '', { now = Date.now(), days = 7, recent = 20 } = {}) {
  const rows = readShadowLines(dir);
  const since = startOfLocalDay(now) - (Math.max(1, days) - 1) * 86400000;
  const byDay = new Map();
  const recentRows = [];
  for (const r of rows) {
    const at = Number(r.at) || 0;
    if (at < since) continue;
    const day = String(r.day || '');
    if (!byDay.has(day)) byDay.set(day, { day, batches: 0, batchErrors: 0, candidates: 0, passed: 0, dropped: 0, byReason: {}, modelMs: 0 });
    const b = byDay.get(day);
    if (r.t === 'batch') {
      b.batches += 1;
      b.modelMs += Number(r.latencyMs) || 0;
      if (r.ok === false) b.batchErrors += 1;
    } else if (r.t === 'cand') {
      b.candidates += 1;
      if (r.verdict === 'pass') b.passed += 1;
      else {
        b.dropped += 1;
        const reason = String(r.reason || 'unknown');
        b.byReason[reason] = (b.byReason[reason] || 0) + 1;
      }
      const c = r.candidate || {};
      recentRows.push({ at, day, verdict: r.verdict, reason: String(r.reason || ''), topic: c.topic || '', value: c.value || '', confidence: c.confidence ?? null, quote: c.quote || '', kind: c.kind || '' });
    }
  }
  const daily = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  const totals = daily.reduce(
    (acc, d) => {
      acc.batches += d.batches;
      acc.candidates += d.candidates;
      acc.passed += d.passed;
      acc.dropped += d.dropped;
      for (const [k, v] of Object.entries(d.byReason)) acc.byReason[k] = (acc.byReason[k] || 0) + v;
      return acc;
    },
    { batches: 0, candidates: 0, passed: 0, dropped: 0, byReason: {} }
  );
  recentRows.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return { daily, totals, recent: recentRows.slice(0, Math.max(1, recent)), file: fileLabel(dir) };
}

function fileLabel(dir) {
  try {
    const file = shadowPath(dir);
    const st = fs.statSync(file);
    return { path: file, size: st.size, mtime: st.mtimeMs };
  } catch {
    return { path: shadowPath(dir), size: 0, mtime: 0 };
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────

function dayLabel(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 跑一次日终抽取。返回统计；不抛异常。
 * callModel 可注入（测试用假模型）。
 */
export async function runModelExtract({
  now = Date.now(),
  dir = '',
  cfg = {},
  ownerKey = '',
  scoring = null,
  log = () => {},
  callModel = requestModel
} = {}) {
  const startedAt = Date.now();
  const c = normalizeExtract(cfg);
  const empty = { skipped: 'disabled', batches: 0, messages: 0, candidates: 0, passed: 0, dropped: 0, written: 0, pooled: 0, byReason: {}, ms: 0 };
  if (!c.enabled) return empty;
  if (!ownerKey) return { ...empty, skipped: 'no-owner' };

  let rows = [];
  try {
    rows = recentMessages(ownerKey, Math.max(400, c.maxMessagesPerDay * 2));
  } catch (error) {
    log(`记忆抽取：读取消息失败（${error?.message ?? error}）`);
    return { ...empty, skipped: 'read-error' };
  }
  const messages = pickMessages(rows, now, c);
  if (!messages.length) return { ...empty, skipped: 'no-messages' };

  const batches = buildBatches(messages, c).slice(0, c.maxBatchesPerDay);
  let existing = [];
  try {
    const all = typeof lt.openIndex === 'function'
      ? lt.openIndex(dir).facts()
      : lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
    existing = all.filter((f) => !f.status || f.status === 'active');
  } catch {
    existing = [];
  }
  // 候选池里还没归并的也算「已有」：同一件事不必每天重新提一次
  try {
    for (const row of readCandidates(dir).rows) {
      if ((row.status || 'pending') !== 'pending') continue;
      existing.push({ topic: row.topic, value: row.value, class: row.class || 'note' });
    }
  } catch {
    /* 池子坏掉不影响抽取 */
  }
  const v10cfg = (() => {
    try {
      return loadV10(dir);
    } catch {
      return null;
    }
  })();

  const stats = { ...empty, skipped: '', messages: messages.length, batches: 0, candidates: 0, passed: 0, dropped: 0, written: 0, pooled: 0, byReason: {}, ms: 0 };
  const shadowRows = [];
  const passed = [];
  const seen = new Map();
  const day = dayLabel(now);

  for (let bi = 0; bi < batches.length; bi += 1) {
    const batch = batches[bi];
    const prompt = buildPrompt(batch);
    let res;
    try {
      res = await callModel({
        caller: 'extract',
        system: prompt.system,
        userContent: prompt.userContent,
        maxChars: 4000,
        timeoutMs: c.timeoutMs,
        json: true,
        temperature: 0,
        model: c.model
      });
    } catch (error) {
      res = { ok: false, error: String(error?.message ?? error), ms: 0 };
    }
    stats.batches += 1;
    shadowRows.push({
      t: 'batch',
      at: now,
      day,
      batch: bi + 1,
      msgs: batch.length,
      model: res?.model || c.model || '',
      promptVersion: c.promptVersion,
      ok: res?.ok === true,
      latencyMs: Number(res?.ms) || 0,
      usage: res?.usage || null,
      error: String(res?.error || '').slice(0, 200)
    });
    if (!res?.ok) {
      stats.byReason.model = (stats.byReason.model || 0) + 1;
      log(`记忆抽取：第 ${bi + 1} 批模型失败（${String(res?.error || '').slice(0, 120)}）`);
      continue;
    }

    const parsed = parseModelJson(res.text);
    if (!parsed.ok) {
      stats.byReason.json = (stats.byReason.json || 0) + 1;
      shadowRows.push({ t: 'cand', at: now, day, batch: bi + 1, parserError: parsed.error, verdict: 'drop', reason: 'json' });
      continue;
    }

    for (const raw of parsed.candidates) {
      stats.candidates += 1;
      const v = validateCandidate(raw, { messages: batch, now, cfg: c, scoring });
      let reason = v.reason;
      if (v.ok) {
        const srcIdx = batch.findIndex((m) => m.text.includes(v.candidate.quote));
        const dup = isDuplicate(v.candidate, existing);
        const key = `${v.candidate.topic}|${normValue(v.candidate.value)}`;
        if (dup) reason = dup;
        else if (seen.has(key)) reason = 'dup-batch';
        else seen.set(key, v.candidate);
        if (!reason) {
          v.candidate.srcMsgIndex = srcIdx + 1;
          passed.push(v.candidate);
        }
      }
      if (reason) stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
      shadowRows.push({
        t: 'cand',
        at: now,
        day,
        batch: bi + 1,
        promptVersion: c.promptVersion,
        candidate: v.ok ? v.candidate : raw,
        verdict: reason ? 'drop' : 'pass',
        reason: reason || '',
        srcMsgIndex: v.ok ? v.candidate.srcMsgIndex : 0
      });
    }
  }

  // 按置信度排序后封顶（每天最多 K 条）
  passed.sort((a, b) => b.confidence - a.confidence);
  const capped = passed.slice(0, c.maxFactsPerDay);
  for (const [i, cand] of passed.entries()) {
    if (i < c.maxFactsPerDay) continue;
    stats.byReason.cap = (stats.byReason.cap || 0) + 1;
    shadowRows.push({ t: 'cand', at: now, day, batch: 0, promptVersion: c.promptVersion, candidate: cand, verdict: 'drop', reason: 'cap', srcMsgIndex: cand.srcMsgIndex || 0 });
  }
  stats.passed = capped.length;
  stats.dropped = stats.candidates - stats.passed;

  // v11：抽取结果只进候选池，不直接写事实库。
  // 事实库的唯一入口是日终 merge 阶段（合并/升级/否决之后才写 fact），
  // 这样一条 37.5% 精确率的模型候选不会污染卡片和检索。
  if (capped.length) {
    try {
      const rows = capped.map((cand) => ({
        ...cand,
        status: 'pending',
        sourceKind: 'model',
        source: { model: 'extract', promptVersion: c.promptVersion, confidence: cand.confidence },
        day,
        at: now
      }));
      appendCandidates(rows, dir);
      stats.pooled = rows.length;
      for (const row of rows) shadowRows.push({ t: 'pool', at: now, day, topic: row.topic, value: row.value, confidence: row.confidence, kind: row.kind });
    } catch (error) {
      stats.byReason.pool = (stats.byReason.pool || 0) + 1;
      log(`记忆抽取：写候选池失败（${error?.message ?? error}）`);
    }
  }

  appendShadowLines(dir, shadowRows);
  stats.ms = Date.now() - startedAt;
  return stats;
}
