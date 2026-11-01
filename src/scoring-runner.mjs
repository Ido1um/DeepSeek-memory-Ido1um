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
import { writeGate } from './gate.mjs';
import { attrsOf, fragmentsOf, loadV10, normalizeV10, activationOf, qValueOf, qLevelOf, qLabelOf, detailOf, emotionOf, consolidationOf, interferenceOf, explain as v10Explain, passesSalience } from './v10.mjs';
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

/** 备注的内容键：去掉「记住/别忘」和语气词后再哈希，换一种说法也能认成同一条。 */
const NOTE_NOISE = /(记住|别忘记了|别忘记|别忘|不要忘|帮我记|记一下|记牢|提醒我)/g;
function normalizeNote(text = '') {
  return String(text || '')
    .replace(NOTE_NOISE, '')
    .replace(/[，。！？；、,.!?;:\s"'“”‘’（）()【】\[\]]/g, '')
    .replace(/[吧呀啊哦呢哈嘛啦著着了]/g, '')
    .replace(/[要得就还都也]/g, '')
    .trim();
}

/** 日程/承诺类动作词：没有这些词就不当待办（避免「明天要吃饭」这种噪声）。 */
const TASK_ACTION = /(交|考试|作业|报告|面试|开会|上课|值班|体检|去医院|报名|提交|答辩|汇报|见面|约好|截止|deadline|复习|预习)/i;

/**
 * 一条入站文本值不值得记：抽硬事实；抽不到但明确说「记住」→ 记一条备注；
 * 再抽不到但有明确日期 + 动作 → 记一条待办。
 * @returns {{signals:object, candidates:Array}}
 */
export function classify(text, cfg = SCORING_DEFAULTS, opts = {}) {
  const t = String(text ?? '').trim();
  const signals = detectSignals(t);
  const candidates = [];
  if (!t) return { signals, candidates };
  // 疑问句不当事实；但「记住…呢」是陈述式叮嘱，不该被问号规则误杀
  if (signals.question && !(signals.explicitRemember && !/[？?]\s*$/.test(t))) {
    return { signals, candidates };
  }

  for (const f of signals.facts) {
    const about = f.about || 'user';
    const pattern = f.pattern || f.key || 'fact';
    const subject = f.subject || '';
    const soft = f.soft === true;
    const multi = f.multi === true && !soft;
    const value = String(f.value || '').trim();
    if ((soft || multi) && !value) continue;
    const tag = subjectTag(subject);
    const sig = soft || multi ? sigOfSubject(about, pattern, subject) + `:${value}` : sigOfSubject(about, pattern, subject);
    const topic = soft
      ? `${about}:${tag ? `${tag}:` : ''}pref:${f.label || '偏好'}:${value}`
      : multi
        ? `${about}:${tag ? `${tag}:` : ''}${f.key || pattern}:${value}`
        : topicOf(t, { about, subject, pattern, sig });
    candidates.push({
      sig,
      topic,
      about,
      subject,
      pattern,
      label: f.label || '',
      value: f.value || '',
      text: t.slice(0, 200),
      quote: t.slice(0, 200),
      // 偏好是「喜欢什么」不是硬事实：走 general 档、pref 类，靠复习慢慢升
      class: soft ? 'pref' : classOf(t, { hard: true }),
      tier: soft ? 'general' : 'hard',
      // 偏好平时 0.6；明确说「记住」说明在意，抬到备注级
      I: soft ? (signals.explicitRemember ? importanceOf({ explicitRemember: true }, cfg) : 0.6) : 1
    });
  }

  if (!candidates.length && signals.explicitRemember) {
    const about = 'user';
    const due = parseDue(t); // 「下下个星期一要交…」→ 2026-11-09；解不出就保持普通备注
    const core = normalizeNote(t);
    const basis = `${core.length >= 4 ? core : t}${due && due.due ? `|${due.due}` : ''}`;
    const sig = sigOf(about, 'note', shortHash(basis));
    const legacySig = sigOf(about, 'note', shortHash(t));
    candidates.push({
      sig,
      legacySig: legacySig !== sig ? legacySig : undefined,
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

  // 没明说「记住」、但有明确日期和动作（「周三要交报告」「下周一面试」）→ 直接记待办
  if (!candidates.length) {
    const due = parseDue(t);
    if (due && due.dueAt && TASK_ACTION.test(t)) {
      const about = 'user';
      const core = t.replace(/^(记住|别忘了|提醒我)/, '').trim().slice(0, 60);
      const sig = sigOf(about, 'task', shortHash(normalizeNote(core) + `|${due.due}`));
      candidates.push({
        sig,
        topic: `${about}:task:${due.due}`,
        about,
        pattern: 'task',
        label: '待办',
        value: core,
        text: t.slice(0, 200),
        quote: t.slice(0, 200),
        class: 'task',
        tier: 'general',
        I: importanceOf({ explicitRemember: true }, cfg),
        task: true,
        due: due.due,
        dueAt: due.dueAt,
        duePhrase: due.phrase
      });
    }
  }

  // v10：候选补轻量属性与原文片段（关闭时不给候选加字段，事件流逐字节不变）
  if (opts.attrs && candidates.length) {
    const a = attrsOf(t);
    for (const c of candidates) {
      c.emo = a.emo;
      c.rel = a.rel;
      c.scene = a.scene;
      c.fragments = fragmentsOf(t, c.value, opts.fragmentsMax || 3);
    }
  }

  return { signals, candidates };
}

/**
 * 入站记一条（引擎在每条消息写入日志后调用）。
 * @returns {{mode:string, added:Array, mentioned:Array, skipped?:string}}
 */
export function recordInbound({ key = '', text = '', ts = Date.now(), scoring, dir = '', itemId = 0, v10: v10raw } = {}) {
  const cfg = normalizeScoring(scoring);
  const mode = cfg.mode;
  if (mode === 'off') return { mode, added: [], mentioned: [], skipped: 'off' };
  const v10cfg = v10raw && typeof v10raw === 'object' ? normalizeV10(v10raw) : loadV10(dir);

  const { signals, candidates } = classify(text, cfg, { attrs: v10cfg.enabled === true, fragmentsMax: v10cfg.fragmentsMax });
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
  const blocked = [];
  // 同值归并：偏好/备注换了个说法但说的仍是同一件事（爱吃火锅 → 最爱火锅），
  // 不该再开一条新事实，记成对已有那条的一次提及。
  const byValue = new Map();
  for (const f of active.values()) {
    if (f.class !== 'pref' && f.class !== 'note') continue;
    const k = `${f.about}|${f.class}|${String(f.value || '').trim()}`;
    if (!byValue.has(k)) byValue.set(k, f);
  }

  for (const c of candidates) {
    const gate = writeGate(text, c, { cfg });
    if (!gate.ok) {
      blocked.push({ sig: c.sig, reason: gate.reason, value: String(c.value || '').slice(0, 40) });
      continue;
    }
    // 老备注用的是整句哈希；新规则用「去噪后的内容 + 日期」，第一次换用新键时要认回老事实
    let prior = active.get(c.sig) || (c.legacySig ? active.get(c.legacySig) : null);
    if (!prior && (c.class === 'pref' || c.class === 'note')) {
      prior = byValue.get(`${c.about || 'user'}|${c.class}|${String(c.value || '').trim()}`) || null;
    }
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
        // v10：只有开启时才写属性（关闭时事件与旧版逐字节一致）
        ...(c.emo != null ? { emo: c.emo, rel: c.rel || 0, scene: c.scene || [], fragments: c.fragments || [] } : {}),
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
    ...(blocked.length ? { blocked: blocked.map((b) => b.reason) } : {}),
    ids: [...added.map((r) => r.id), ...mentioned.map((r) => r.id)],
    text
  });

  return { mode, added, mentioned, blocked, signals };
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
      ...(Array.isArray(row.blocked) && row.blocked.length ? { blocked: row.blocked } : {}),
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
 * 长句检索用的切词：中文按二元组、英文/数字按单词；丢掉常见虚词二元组，
 * 避免「今天怎么样」这种整句把一堆事实都捞出来。
 */
const STOP_TOKENS = new Set([
  '今天', '明天', '昨天', '现在', '刚才', '然后', '就是', '这个', '那个', '什么', '怎么',
  '可以', '一个', '我们', '你们', '他们', '还是', '因为', '所以', '但是', '如果', '时候',
  '感觉', '真的', '不是', '没有', '知道', '觉得', '这样', '那样', '一下', '已经', '可能',
  '应该', '需要', '自己', '出来', '起来', '回来', '过来', '下来', '还是', '有点', '一样'
]);

export function tokensOf(query = '') {
  const s = String(query || '').trim();
  if (!s) return [];
  const out = new Set();
  for (const part of s.replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/)) {
    if (!part) continue;
    if (/^[a-z0-9]+$/i.test(part)) {
      if (part.length >= 2) out.add(part.toLowerCase());
      continue;
    }
    for (let i = 0; i < part.length - 1; i += 1) {
      const tk = part.slice(i, i + 2);
      if (!STOP_TOKENS.has(tk)) out.add(tk);
    }
  }
  return [...out];
}

/**
 * 检索：档位优先（hard → long → general → temp），同档按分数；默认过滤作废/过期。
 * @returns {Array} describe() 结果 + text
 */
export function search({ query = '', limit = 5, now = Date.now(), scoring, includeInvalidated = false, facts: provided, dir = '', includeHistory = false, recordRetrieved: recordOpt = false, recordBy = 'search', match = 'substring' } = {}) {
  const cfg = normalizeScoring(scoring);
  // limit<=0 表示“不要结果”，而不是悄悄回退成默认条数
  const want = Number(limit);
  if (Number.isFinite(want) && want <= 0) return [];
  const q = String(query ?? '').trim();
  const eventsIn = cfg.mode === 'shadow'
    ? [...lt.readEvents(dir).rows, ...lt.readShadow(0, dir).rows]
    : lt.readEvents(dir).rows;
  const source = Array.isArray(provided) ? provided : lt.materialize(eventsIn, lt.readInvalidated(dir));
  const facts = source.filter((f) => includeInvalidated || f.status === 'active');
  // match='tokens'：整句切成二元组，任一词命中即可（真实聊天是整句话，substring 几乎匹配不到）
  const tokens10 = q && match === 'tokens' ? tokensOf(q) : null;
  // 切不出二元组的超短查询（「鱼」「嗯」）回退 substring，避免 tokens 模式反而查不到
  const hitTokens = tokens10 && tokens10.length ? tokens10 : null;
  const ranked = facts
    .map((f) => {
      const d = { ...describe(f, now, cfg), id: f.id, status: f.status, label: f.label, text: f.text, sig: f.sig, about: f.about, value: f.value, pattern: f.pattern, topic: f.topic || '', quote: f.quote || '', lastAt: f.lastAt || 0, versions: Number(f.versions) || 1, accessCount: Number(f.accessCount) || 0, lastRetrievedAt: Number(f.lastRetrievedAt) || 0, emo: Number(f.emo) || 0, rel: Number(f.rel) || 0, scene: Array.isArray(f.scene) ? f.scene : [], fragments: Array.isArray(f.fragments) ? f.fragments : [] };
      // 命中判定：值/原文/标签/sig/模式，任一包含关键词即可；tokens 模式按词命中
      const hit = q
        ? (hitTokens
          ? hitTokens.some((tk) => [f.text, f.value, f.label, f.sig, f.pattern].some((s) => String(s ?? '').includes(tk)))
          : [f.text, f.value, f.label, f.sig, f.pattern].some((s) => String(s ?? '').includes(q)))
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
  // v10：只在这条路径上补激活值/可信度；关闭时输出与旧版逐字段一致（不多加字段）
  const v10cfg = loadV10(dir);
  if (v10cfg.enabled) {
    const byId = new Map(source.map((f) => [f.id, f]));
    for (const r of out) {
      const f = byId.get(r.id) || r;
      const a = activationOf(f, { query: q, facts: source, now, cfg: v10cfg });
      r.activation = Number(a.A.toFixed(1));
      r.activationParts = Object.fromEntries(Object.entries(a.parts).map(([k, v]) => [k, Number(v.toFixed(1))]));
      r.q = Number(qValueOf(f, { facts: source }).toFixed(2));
      r.qLevel = qLevelOf(r.q, v10cfg);
      r.qLabel = qLabelOf(r.qLevel, v10cfg);
      r.detail = Number(detailOf(f, v10cfg, now, source).toFixed(2));
      r.emotion = Number(emotionOf(f, v10cfg, now).toFixed(2));
      if (!r.fragments || !r.fragments.length) r.fragments = fragmentsOf(f.text, f.value, v10cfg.fragmentsMax);
    }
    if (v10cfg.rankInInject) out = out.slice().sort((x, y) => (y.activation || 0) - (x.activation || 0));
  }
  const rowsOut = out.slice(0, Math.max(1, Number(limit) || 5));
  // 只有调用方显式声明「这次要注入/真正用到」时才记账：CLI、MCP、影子对比默认不写。
  if (recordOpt === true && v10cfg.enabled && v10cfg.recordRetrieved) {
    recordRetrieved(rowsOut, { dir, now, by: recordBy });
  }
  return rowsOut;
}

function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** v10：检索命中记一条 retrieved（同 fact 同一天只记一次）。只记事实、不涨分。 */
function recordRetrieved(rows, { dir = '', now = Date.now(), by = 'search' } = {}) {
  for (const r of rows) {
    if (!r || !r.id) continue;
    const last = Number(r.lastRetrievedAt) || 0;
    if (last && sameLocalDay(last, now)) continue;
    try {
      // 带上这次命中里线索触发（cue）的分值，便于回看「为什么想起」
      const cue = Number(r.activationParts && r.activationParts.cue) || 0;
      lt.appendEvent({ ev: 'retrieved', id: r.id, at: now, by, cue }, dir);
      r.lastRetrievedAt = now;
      r.lastCue = cue;
      r.accessCount = (Number(r.accessCount) || 0) + 1;
    } catch {
      /* 记不上不影响检索结果 */
    }
  }
}

/** 只给「真正被用到」的调用方：声明这批行确实进了注入（引擎在过滤卡重复之后调用）。 */
export function markRetrieved(rows, { dir = '', now = Date.now(), by = 'inject' } = {}) {
  const cfg = loadV10(dir);
  if (cfg.enabled !== true || cfg.recordRetrieved !== true) return 0;
  recordRetrieved(rows, { dir, now, by });
  return 0;
}

/** CLI/HTTP：一条事实的 v10 解释（计算统一交给 v10.explain）。 */
export function explainFact(fact, { query = '', facts = [], dir = '', now = Date.now() } = {}) {
  const cfg = loadV10(dir);
  const ex = v10Explain(fact, { query, facts, now, cfg });
  return {
    activation: ex.activation,
    parts: ex.parts,
    q: ex.q,
    qLevel: ex.qLevel,
    qLabel: ex.qLabel,
    detail: ex.detail,
    emotion: ex.emotion,
    consolidation: ex.consolidation,
    interference: ex.interference,
    fragments: ex.fragments,
    rendered: ex.rendered,
    belowFloor: !passesSalience({ activation: ex.activation }, cfg)
  };
}
