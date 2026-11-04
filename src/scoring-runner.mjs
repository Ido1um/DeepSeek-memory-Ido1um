// 打分跑批（v7 §4）：入站判分 → 影子/写入 → 日终结算 → 检索排序。
//
// 三档模式（config.memory.scoring.mode）：
//   off     完全不跑（线上零行为）
//   shadow  只写 state/scoring-shadow.jsonl + 统计，**不碰 longterm.jsonl、不碰事实卡**
//   write   真写 longterm.jsonl 事件（fact / mention / tier / expire）
//
// 影子模式的目的：先用真实流量验证「抽得对不对、分数算得对不对、量有多大」，
// 一天没问题再把 mode 切成 write，代码路径完全一致，只是换个文件落地。

import { isMeta, isTemporal, confidenceOf, detectSignals, topicOf, classOf, subjectTag, milestoneOf, quotedMilestones, isQuestion, cleanValue, feelOf } from './facts.mjs';
import { parseDue } from './due.mjs';
import { parseTime } from './timeparse.mjs';
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
export function normalizeNote(text = '') {
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
  // 转述/引用了机器人原话里的里程碑：即使外层是疑问句，也要记
  const quotedMs = quotedMilestones(t);
  // 疑问句不当事实；但「记住…呢」是陈述式叮嘱，不该被问号规则误杀
  if (signals.question && !quotedMs.length && !(signals.explicitRemember && !/[？?]\s*$/.test(t))) {
    return { signals, candidates };
  }

  for (const f of signals.facts) {
    const about = f.about || 'user';
    const pattern = f.pattern || f.key || 'fact';
    const subject = f.subject || '';
    const soft = f.soft === true;
    const multi = f.multi === true && !soft;
    // 爱好/器材：多值属性走 long 档（不占 hard 永久位），重要度 0.85
    const attrLong = f.key === 'hobby' || f.key === 'gear';
    const value = String(f.value || '').trim();
    if ((soft || multi) && !value) continue;
    // A6：按模式置信度缩放重要度；置信度 <0.6 的只进一般档
    const conf = confidenceOf(f.key);
    let I = soft ? (signals.explicitRemember ? importanceOf({ explicitRemember: true }, cfg) : 0.6) : attrLong ? 0.85 : 1;
    I = Math.round(I * (0.6 + 0.4 * conf) * 100) / 100;
    let tier = soft ? 'general' : attrLong ? 'long' : 'hard';
    let cls = soft || attrLong ? 'pref' : classOf(t, { hard: true });
    // A4：聊记忆系统本身 / 未定事实 → 记 note + 一般档，I 封顶 0.4（只降档不丢）
    if (isMeta(t) || isTemporal(t)) { cls = 'note'; tier = 'general'; I = Math.min(I, 0.4); }
    if (conf < 0.6 && tier === 'hard') tier = 'general';
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
      class: cls,
      tier,
      I,
      confidence: conf
    });
  }

  // 里程碑：「第一次/头一回/首次 + 动作」——事件类，长期保存（这类不进 hard，但也不该 7 天就淡出）
  for (const q of quotedMs) {
    const value = String(q.value || '').slice(0, 24);
    const sig = sigOf(q.about, 'first', shortHash(value));
    candidates.push({
      sig, topic: topicOf(t, { about: q.about, pattern: 'first', sig }),
      about: q.about, pattern: 'first', label: '首次', value,
      text: t.slice(0, 200), quote: q.quote || t.slice(0, 200),
      class: 'event', tier: 'long', I: 0.8, confidence: 0.8
    });
  }

  if (!candidates.length) {
    const ms = milestoneOf(t);
    if (ms) {
      const value = String(ms.value || '').slice(0, 24);
      const sig = sigOf(ms.about, 'first', shortHash(value));
      candidates.push({
        sig,
        topic: topicOf(t, { about: ms.about, pattern: 'first', sig }),
        about: ms.about,
        pattern: 'first',
        label: '首次',
        value,
        text: t.slice(0, 200),
        quote: t.slice(0, 200),
        class: 'event',
        tier: 'long',
        I: 0.8,
        confidence: 0.8
      });
    }
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
      confidence: confidenceOf('note'),
      ...(due && due.dueAt > Date.now() - 12 * 3600e3
        ? { task: true, due: due.due, dueAt: due.dueAt, duePhrase: due.phrase }
        : {})
    });
  }

  // 没明说「记住」、但有明确日期和动作（「周三要交报告」「下周一面试」）→ 直接记待办。
  // 2026-11-04 教训：还要挡住三种「假待办」——①元讨论（记忆/时间戳/方案这类技术话）
  // ②疑问句/反思句（「是不是要…」「要不要…」）③已经过去的事（「上个星期四」）：
  // 过去的日期不该生成待办，它只是一句回忆，正确去处是备注或事件。
  const TASK_QUESTION = /(是不是|要不要|会不会|有没有|能不能|该不该)/;
  if (!candidates.length) {
    const due = parseDue(t);
    const pastGrace = 12 * 3600e3;
    const isPast = due && due.dueAt ? due.dueAt < Date.now() - pastGrace : false;
    if (due && due.dueAt && !isPast && TASK_ACTION.test(t) && !isMeta(t) && !isQuestion(t) && !TASK_QUESTION.test(t)) {
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
        confidence: confidenceOf('note'),
        task: true,
        due: due.due,
        dueAt: due.dueAt,
        duePhrase: due.phrase
      });
    }
  }

  // v10：候选补三个轻量属性 + 原文片段（关闭时不加字段，事件流逐字节不变）
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
  const active = (mode === 'shadow'
    ? lt.materialize([...lt.readEvents(dir).rows, ...lt.readShadow(0, dir).rows], lt.readInvalidated(dir))
    : lt.openIndex(dir).facts())
    .filter((f) => f.status === 'active')
    .reduce((m, f) => {
      if (!m.has(f.sig)) m.set(f.sig, f);
      return m;
    }, new Map());

  const added = [];
  const mentioned = [];
  const blocked = [];
  const marked = [];
  const markedShadow = [];

  // 同一件事换个说法（喜欢/最爱、同一句叮嘱）不该再开一条新事实。
  // 只在偏好与备注里做同值归并：属性类允许不同人/不同对象有相同的值。
  const byValue = new Map();
  for (const f of active.values()) {
    if (f.class !== 'pref' && f.class !== 'note') continue;
    const k = `${f.about}|${f.class}|${String(f.value || '').trim()}`;
    if (!byValue.has(k)) byValue.set(k, f);
  }

  // A5：值级去重的索引（同 about + 同族类，双向 includes 视为同一条）
  const normVal = (v) => String(v || '').toLowerCase().replace(/\s+/g, '').replace(/[，。！？；、,.!?;:、"'"'"'（）()【】\[\]]/g, '');
  const activeList = [...active.values()];

  for (const raw of candidates) {
    // 写入门：值不值得进长期库（技术讨论/转述/不确定/临时状态/太薄都挡在外面）
    const gate = writeGate(text, raw, { cfg });
    if (!gate.ok) {
      blocked.push({ sig: raw.sig, reason: gate.reason, value: String(raw.value || '').slice(0, 40) });
      continue;
    }
    // v11 broad 模式：mark 类放行，但降置信、加类目/归属标记，交给后续归并收敛
    const c = gate.mark
      ? {
        ...raw,
        conf: Number.isFinite(gate.conf) ? gate.conf : raw.conf,
        ...(gate.classHint ? { class: gate.classHint } : {}),
        ...(gate.tierHint ? { tier: gate.tierHint } : {}),
        ...(gate.aboutHint ? { about: gate.aboutHint } : {}),
        ...(gate.privateHint ? { private: true } : {})
      }
      : raw;
    if (gate.mark) {
      marked.push({ sig: c.sig, reason: gate.reason, value: String(c.value || '').slice(0, 40) });
    }
    // 老备注用的是整句哈希；新规则用「去噪后的内容 + 日期」，第一次换用新键时要认回老事实
    let prior = active.get(c.sig) || (c.legacySig ? active.get(c.legacySig) : null);
    // 同义换了说法（「爱吃」→「喜欢」）按提及处理，不再开第二条
    if (!prior && (c.class === 'pref' || c.class === 'note')) {
      prior = byValue.get(`${c.about || 'user'}|${c.class}|${String(c.value || '').trim()}`) || null;
    }
    // A5：属性类也做值级归并（「摄影」与「摄影（Z8X…）」→ 同一条提及）
    if (!prior) {
      const nv = normVal(c.value);
      if (nv && nv.length >= 3) {
        for (const f of activeList) {
          if (f.about !== c.about) continue;
          if (f.class !== c.class) continue;
          const fv = normVal(f.value);
          if (!fv) continue;
          if (fv === nv || fv.includes(nv) || nv.includes(fv)) { prior = f; break; }
        }
      }
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
      // 观察期：打了标的候选只进影子，不进事实库
      const toShadow = mode === 'shadow' || (gate.mark === true && cfg.gateShadow !== false);
      const row = {
        ev: 'fact',
        src: { kind: 'log', day: new Date(ts).toISOString().slice(0, 10), quote: String(text || '').replace(/\s+/g, ' ').slice(0, 80) },
        id: lt.newId(toShadow ? 's' : 'h'),
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
        ...(Number.isFinite(c.conf) ? { conf: round2(c.conf) } : {}),
        ...(c.private === true ? { private: true } : {}),
        ...(itemId ? { source: { id: itemId } } : {}),
        tier: c.tier,
        I: round2(c.I),
        s: Number.isFinite(s) ? round2(s) : null,
        hits: 1,
        lastAt: ts,
        at: ts,
        // 3.0 补丁：规则即时事实也带时间锚与有效期（基准 = 这条消息的 ts）
        saidAt: ts,
        ...(() => {
          const tp = parseTime(`${text} ${c.value || ''}`, { refMs: ts, kindHint: c.task ? 'event' : 'fact', slot: c.task ? 'event' : 'note' });
          if (!tp.dates.length && !tp.validUntil) return {};
          return { dates: tp.dates, validUntil: tp.validUntil || 0, timePhrase: tp.phrase || '', timeConfidence: tp.confidence || 0 };
        })(),
        // v10 属性（enabled=false 时 c.emo 为 undefined，事件里不会多字段）
        ...(c.emo != null ? { emo: c.emo, rel: c.rel || 0, scene: c.scene || [], fragments: c.fragments || [] } : {}),
        ...(c.task ? { task: true, due: c.due, dueAt: c.dueAt, duePhrase: c.duePhrase } : {})
      };
      if (toShadow) lt.appendShadow(row, dir);
      else lt.appendEvent(row, dir);
      if (toShadow && mode === 'write') markedShadow.push(row);
      else added.push(row);
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
    ...(marked.length ? { marked: marked.map((m) => m.reason) } : {}),
    ...(markedShadow.length ? { markedShadow: markedShadow.length } : {}),
    ids: [...added.map((r) => r.id), ...mentioned.map((r) => r.id)],
    text
  });

  return { mode, added, mentioned, blocked, marked, markedShadow, signals };
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
      ...(Array.isArray(row.marked) && row.marked.length ? { marked: row.marked } : {}),
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

  const facts = (cfg.mode === 'shadow'
    ? lt.materialize([...lt.readEvents(dir).rows, ...lt.readShadow(0, dir).rows], lt.readInvalidated(dir))
    : lt.openIndex(dir).facts()).filter((f) => f.status === 'active');
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
/**
 * 扫一天的原文日志，把「机器人自己说的第一次」补成事实（用户在提问里转述同一句时也能命中）。
 * 只认 assistant 行 + 里程碑词；按值去重；返回写入的条数。日终维护调用，失败不影响主流程。
 */
export function scanMilestones({ dir, day, now = Date.now() } = {}) {
  try {
    const base = path.join(dir, 'raw', 'hot', String(day || ''));
    if (!fs.existsSync(base)) return { added: 0, scanned: 0 };
    const events = lt.readEvents(dir).rows || [];
    const known = new Set(
      lt.materialize(events, lt.readInvalidated(dir))
        .filter((f) => f.status === 'active')
        .map((f) => String(f.value || '').trim())
    );
    let scanned = 0;
    let added = 0;
    for (const name of fs.readdirSync(base)) {
      if (!name.endsWith('.jsonl')) continue;
      const lines = fs.readFileSync(path.join(base, name), 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.role !== 'assistant' || !row.text) continue;
        scanned += 1;
        const ms = milestoneOf(row.text);
        if (!ms || ms.about !== 'bot') continue;
        const value = String(ms.value || '').trim();
        if (!value || known.has(value)) continue;
        const sig = sigOf('bot', 'first', shortHash(value));
        const at = Date.parse(row.ts || '') || now;
        lt.appendEvent({
          ev: 'fact', id: lt.newId('h'), sig, key: row.key, about: 'bot',
          pattern: 'first', label: '首次', value, text: String(row.text).slice(0, 200),
          quote: String(row.text).slice(0, 200), topic: 'bot:first',
          class: 'event', tier: 'long', I: 0.8, s: 365 * 3, hits: 1,
          source: { milestone: true, speaker: 'assistant' }, lastAt: at, at
        }, dir);
        const factId = lt.readEvents(dir).rows.filter((r) => r.ev === 'fact').slice(-1)[0]?.id;
        const feel = feelOf(String(row.text || ''));
        if (factId && feel) {
          lt.appendEvent({ ev: 'feel', fact: factId, id: factId, feel, quote: String(row.text).slice(0, 200), by: 'self', derived: false, at }, dir);
        }
        known.add(value);
        added += 1;
      }
    }
    return { added, scanned };
  } catch (e) {
    return { added: 0, scanned: 0, error: String(e && e.message ? e.message : e) };
  }
}

/** 机器人自述里值得记的那几类（比里程碑宽，但只认第一人称断言、不问句）。 */
const SELF_DECL = /(?:我)(?:是|叫|住|喜欢|爱吃|爱|讨厌|不喜欢|怕|养|在学|答应|保证|决定)/;
const SELF_NOISE = /(不是|没有|别看|你|吗|什么|怎么|为什么|如果|要是|的话|说过|说过可|记错)/;

/** 取动词后的第一个短句当值（去掉的/了/标点），太短或含噪声返回空。 */
function selfValue(text, m) {
  const rest = String(text).slice(m.index + m[0].length).replace(/^[的了哦呀啊，、\s]+/, '');
  const seg = rest.split(/[，。！？；\n]/)[0].trim();
  if (!seg || seg.length < 2 || seg.length > 20) return '';
  if (SELF_NOISE.test(seg)) return '';
  return cleanValue(seg, 20);
}

/**
 * 扫一天的原文日志，把「助手自己说的事」补成事实：
 *   - 里程碑（第一次…）：class=event / tier=long / I=0.8
 *   - 自述（我是/我叫/我喜欢/我答应…）：class=note / tier=general / I=0.55（低权重，可人工改）
 * includeSelf=false 时只扫里程碑。按值去重，失败不影响主流程。
 */
export function scanAssistantFacts({ dir, day, now = Date.now(), includeSelf = true, dryRun = false } = {}) {
  const out = { added: 0, scanned: 0, picked: [] };
  try {
    const base = path.join(dir, 'raw', 'hot', String(day || ''));
    if (!fs.existsSync(base)) return out;
    const events = lt.readEvents(dir).rows || [];
    const known = new Set(
      lt.materialize(events, lt.readInvalidated(dir))
        .filter((f) => f.status === 'active')
        .map((f) => String(f.value || '').replace(/\s+/g, '').trim())
    );
    const covered = (v) => {
      const nv = String(v || '').replace(/\s+/g, '');
      if (!nv) return true;
      for (const k of known) if (k && (k === nv || k.includes(nv) || nv.includes(k))) return true;
      return false;
    };
    for (const name of fs.readdirSync(base)) {
      if (!name.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(base, name), 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.role !== 'assistant' || !row.text) continue;
        out.scanned += 1;
        const text = String(row.text);
        const at = Date.parse(row.ts || '') || now;
        const ms = milestoneOf(text);
        const msVal = ms && ms.about === 'bot' ? String(ms.value || '').trim() : '';
        if (msVal && !covered(msVal)) {
          out.picked.push({ kind: 'first', value: msVal, quote: text.slice(0, 200), at, key: row.key || '' });
          known.add(msVal.replace(/\s+/g, ''));
          continue;
        }
        if (!includeSelf || isQuestion(text) || isMeta(text)) continue;
        const m = SELF_DECL.exec(text);
        if (!m) continue;
        const value = selfValue(text, m);
        if (!value || value.length < 3 || covered(value)) continue;
        out.picked.push({ kind: 'self', value, quote: text.slice(0, 200), at });
        known.add(value.replace(/\s+/g, ''));
      }
    }
    if (dryRun) return out;
    for (const p of out.picked) {
      const isFirst = p.kind === 'first';
      const sig = sigOf('bot', isFirst ? 'first' : 'note', shortHash(p.value));
      lt.appendEvent({
        ev: 'fact', id: lt.newId('h'), sig, key: p.key || 'private:', about: 'bot',
        pattern: isFirst ? 'first' : 'self',
        label: isFirst ? '首次' : '自述',
        value: p.value, text: p.quote, quote: p.quote,
        topic: isFirst ? 'bot:first' : 'bot:self',
        class: isFirst ? 'event' : 'note',
        tier: isFirst ? 'long' : 'general',
        I: isFirst ? 0.8 : 0.55,
        s: isFirst ? 365 * 3 : 3,
        hits: 1, source: { speaker: 'assistant', first: isFirst }, lastAt: p.at, at: p.at
      }, dir);
      out.added += 1;
    }
    return out;
  } catch (e) {
    return { ...out, error: String(e && e.message ? e.message : e) };
  }
}

export function search({
  query = '',
  limit = 5,
  now = Date.now(),
  scoring,
  includeInvalidated = false,
  facts: provided,
  dir = '',
  includeHistory = false,
  recordRetrieved: recordOpt = false,
  recordBy = 'search',
  match = 'substring'
} = {}) {
  const cfg = normalizeScoring(scoring);
  // limit<=0 表示“不要结果”，而不是悄悄回退成默认条数（CLI/HTTP 调用方会误判）
  const want = Number(limit);
  if (Number.isFinite(want) && want <= 0) return [];
  const q = String(query ?? '').trim();
  const source = Array.isArray(provided)
    ? provided
    : (cfg.mode === 'shadow'
      ? lt.materialize([...lt.readEvents(dir).rows, ...lt.readShadow(0, dir).rows], lt.readInvalidated(dir))
      : lt.openIndex(dir).facts());

  const TIER_RANK = { hard: 4, long: 3, general: 2, temp: 1 };
  const limitN = Math.max(1, Number(limit) || 5);
  // 版本链要跨「同主题」比较，必须先看全量；不开的时候只描述最终要返回的那几条
  const fastPath = !cfg.versioning || includeHistory;
  const topK = fastPath ? Math.max(limitN * 3, 30) : Infinity;

  // 命中判定：5 个字段任一包含关键词即可。不建数组、不转小写（中文无大小写，
  // 转小写会在 3 万条上产生大量临时字符串）。
  // match='tokens' 时改为「整句切成二元组，任一词命中」——真实聊天是整句话，
  // substring 模式几乎永远匹配不到（只有 CLI 拿关键词查时才有效）。
  // 短到切不出二元组（「鱼」「嗯」）时退回整句 substring，避免 tokens 模式反而查不到。
  // 3.0 补丁：结构化槽位兜底——问「生日」时，即使事实文案里没写这两个字，
  // 也要把 slot=birthday 的事实找出来（用户那条写的是「2007 年 9 月 5 日生」）。
  // 只做生日一个槽位；完整的「问法→槽位」路由留给 3.1。
  const SLOT_HINTS = [[/生日|出生|寿辰/, ['birthday']]];
  const hintSlots = SLOT_HINTS.filter(([re]) => re.test(q)).flatMap(([, slots]) => slots);
  // 「用户/我」问生日问的是用户的，「她/助手」问的是她的。只影响排序，不改变命中集合。
  const whoHint = /用户|我(?!们)|咱|俺/.test(q) ? 'owner' : (/助手|小助手|她|我/.test(q) ? 'bot' : '');
  const hitTokens = match === 'tokens' ? tokensOf(q) : null;
  const tokenHit = hitTokens && hitTokens.length ? hitTokens : null;
  const hitOf = (f) => {
    if (!q) return false;
    if (tokenHit) {
      for (const tk of tokenHit) {
        if ([f.text, f.value, f.label, f.sig, f.pattern].some((x) => typeof x === 'string' && x.includes(tk))) return true;
      }
      return false;
    }
    const t = f.text;
    if (t && typeof t === 'string' ? t.includes(q) : false) return true;
    const v = f.value;
    if (v && typeof v === 'string' ? v.includes(q) : false) return true;
    const l = f.label;
    if (l && typeof l === 'string' ? l.includes(q) : false) return true;
    const g = f.sig;
    if (g && typeof g === 'string' ? g.includes(q) : false) return true;
    const p2 = f.pattern;
    return Boolean(p2 && typeof p2 === 'string' && p2.includes(q));
  };

  // 第一遍只算排序键（scoreOf 是纯算术，不构造对象、不算下次复习时间）
  const scored = [];
  for (const f of source) {
    if (!includeInvalidated && f.status !== 'active') continue;
    // v11：chat 类（寒暄/临时状态）永不进检索，只留在库里等过期
    if (String(f.class || '') === 'chat') continue;
    const slotHit = hintSlots.length > 0 && hintSlots.includes(String(f.slot || ''));
    const hit = hitOf(f) || slotHit;
    if (q && !hit) continue;
    const bad = (Number(f.badHits) || 0) >= 2 ? 500 : 0;
    const whoBoost = slotHit && whoHint && f.birthday && f.birthday.who === whoHint ? 800 : 0;
    const rank = (TIER_RANK[f.tier] || 0) * 1000 + scoreOf(f, now, cfg) + (hit ? 500 : 0) + (slotHit ? 6000 : 0) + whoBoost - bad;
    scored.push({ f, rank, hit });
  }
  scored.sort((a, b) => b.rank - a.rank);

  // 第二遍：只把要返回的那几条做成完整描述
  const take = Number.isFinite(topK) ? scored.slice(0, topK) : scored;
  const ranked = take.map(({ f, rank, hit }) => ({
    ...describe(f, now, cfg),
    feel: (Array.isArray(f.feels) && f.feels.length) ? f.feels[f.feels.length - 1].feel : '',
    id: f.id,
    src: f.src || null,
    birthday: f.birthday || null,
    slot: f.slot || '',
    status: f.status,
    label: f.label,
    text: f.text,
    sig: f.sig,
    about: f.about,
    value: f.value,
    pattern: f.pattern,
    topic: f.topic || '',
    quote: f.quote || '',
    lastAt: f.lastAt || 0,
    versions: Number(f.versions) || 1,
    badHits: Number(f.badHits) || 0,
    accessCount: Number(f.accessCount) || 0,
    lastRetrievedAt: Number(f.lastRetrievedAt) || 0,
    emo: Number(f.emo) || 0,
    rel: Number(f.rel) || 0,
    scene: Array.isArray(f.scene) ? f.scene : [],
    fragments: Array.isArray(f.fragments) ? f.fragments : [],
    hit,
    rank
  }));

  let out = ranked;
  if (cfg.versioning && !includeHistory) {
    const latest = new Map();
    for (const r of ranked) {
      const k = r.topic || r.sig || r.id;
      const cur = latest.get(k);
      if (!cur || (r.lastAt || 0) > (cur.lastAt || 0)) latest.set(k, r);
    }
    out = ranked.filter((r) => latest.get(r.topic || r.sig || r.id) === r);
    const seen = new Map();
    for (const r of ranked) {
      const k = r.topic || r.sig || r.id;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    for (const r of out) {
      const k = r.topic || r.sig || r.id;
      r.versions = Math.max(Number(r.versions) || 1, seen.get(k) || 1);
    }
  }

  // v10：只在这条路径上补激活值/可信度；关闭时 out 与旧版逐字段一致（多出来的字段都不加）
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
  const rowsOut = out.slice(0, limitN);
  // 只有调用方显式声明「这次是要注入/被真正用到」时才记账：
  // CLI recall、MCP 工具、影子对比脚本默认不写，避免把人工查看和离线分析算成「被想起」。
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
      // 带上这次命中里线索触发（cue）的分值，便于回看「为什么想起」；
      // 没有算过激活值（v10 关闭 / 直接调用）时记 0，不影响旧数据。
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

/**
 * 只给「真正被用到」的调用方：声明这批行确实进了注入。
 * 引擎在过滤掉卡里已有的条目之后再调用，保证记的是最终展示的那几条。
 */
export function markRetrieved(rows, { dir = '', now = Date.now(), by = 'inject' } = {}) {
  const cfg = loadV10(dir);
  if (cfg.enabled !== true || cfg.recordRetrieved !== true) return 0;
  const before = rows.filter((r) => r && r.id && !(Number(r.lastRetrievedAt) > 0 && sameLocalDay(Number(r.lastRetrievedAt), now))).length;
  recordRetrieved(rows, { dir, now, by });
  return before;
}

/** CLI/HTTP：一条事实的 v10 解释（不走检索也能看；计算统一交给 v10.explain）。 */
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
