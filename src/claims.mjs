/**
 * 3.1 P0c：纠正候选（D3）
 *
 * 她在聊天里纠正过的内容（「计算机学院不走 832，是 408」这类）以前只在窗口账本里，
 * 抽取器只读『用户的话』，所以纠正永远进不了事实库。
 *
 * 这里做的是：从窗口账本的 spoken / reply 里捡出「纠正句式」，写成 pending 候选
 * （state/claims.jsonl），**不直接改事实**；用户确认后才落成 fact（author:'correction'）。
 *
 * 设计边界：
 * - 只捡、不判对错；pending 不参与注入、不进卡、不参与检索；
 * - 同一句（归一化后）只留一条；每天最多 maxPerDay 条；
 * - 确认时按 topic+slot(+program) 找旧条目：单值/同 program 用 supersede，其余新增；
 * - 拒绝只改状态，不删审计。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as lt from './longterm.mjs';
import { readTurns } from './window.mjs';
import { parseTime } from './timeparse.mjs';

export const CLAIM_DEFAULTS = {
  enabled: true,
  days: 3,
  maxPerDay: 10,
  minChars: 6
};

export function normalizeClaimConfig(raw = {}) {
  const c = { ...CLAIM_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  c.enabled = c.enabled !== false;
  c.days = Math.max(1, Math.min(7, Number(c.days) || CLAIM_DEFAULTS.days));
  c.maxPerDay = Math.max(1, Math.min(30, Number(c.maxPerDay) || CLAIM_DEFAULTS.maxPerDay));
  c.minChars = Math.max(2, Math.min(40, Number(c.minChars) || CLAIM_DEFAULTS.minChars));
  return c;
}

const CORRECTION_RE = /(纠正|更正|记错|说错|应该是|应该考|不是.{0,14}(而是|是)|改成|准确(?:地)?说|不走\s*\d{3}|走\s*\d{3}|不算|应该是.{0,20})/;

const SUBJECT_RE = /(\d{3})(?=\s*(?:和|\+|、|与)\s*(?:数一|数二|数三|英语|政治|\d{3}))|(?:\b|^|\s)(408|832|301|101|201)(?=$|[\s，。、；：！？)\]】]|和|与|\+)/g;
const PROGRAM_RE = /\b(081200|085404|081200|140600|080900|081000)\b/g;

const TIER_BY_SLOT = {
  exam: 'long',
  intel: 'long',
  plan: 'long',
  progress: 'long',
  material: 'general',
  note: 'general'
};

export function claimPath(dir = '') {
  return path.join(String(dir), 'state', 'claims.jsonl');
}

export function readClaims(dir = '') {
  const file = claimPath(dir);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 半行（正在写）跳过
    }
  }
  return out;
}

export function appendClaim(dir = '', claim = {}) {
  fs.mkdirSync(`${String(dir).replace(/[\\/]+$/, '')}/state`, { recursive: true });
  fs.appendFileSync(claimPath(dir), `${JSON.stringify(claim)}\n`, 'utf8');
  return claim;
}

export function updateClaim(dir = '', id = '', patch = {}) {
  const rows = readClaims(dir);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) return { ok: false, error: '没有这条候选' };
  rows[idx] = { ...rows[idx], ...patch, updatedAt: Date.now() };
  const file = claimPath(dir);
  const tmp = `${file}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, claim: rows[idx] };
}

export function sha1(text = '') {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

export function normText(text = '') {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[「」“”"'`]/g, '')
    .toLowerCase();
}

/** 从一句话里认出专业代码与考试科目。 */
export function classifyClaim(text = '') {
  const t = String(text);
  const programs = [...new Set((t.match(PROGRAM_RE) || []).map((x) => x))];
  const subjects = [...new Set((t.match(/\b(408|832|301|101|201)\b/g) || []).map((x) => x))];
  const kuoyi = /数一/.test(t) ? ['数一'] : [];
  const subj = [...new Set([...subjects, ...kuoyi])];
  let program = '';
  if (programs.length) program = programs.join('/');
  else if (/408/.test(t) || /计算机(学院|科学)|081200|085404/.test(t)) program = '081200/085404';
  else if (/832/.test(t) || /人工智能|081200|140600/.test(t)) program = '081200/140600';
  let topicId = /408|计算机(学院|科学)|081200|085404/.test(t) ? 't-hust' : /832|人工智能|081200|140600/.test(t) ? 't-hust' : '';
  // 同时提到 408 和 832 又没给专业代码/学院名 → 分不清是替谁纠正，宁可先不猜。
  if (!programs.length && /408/.test(t) && /832/.test(t) && !/(计算机|人工智能|081200|085404|081200|140600)/.test(t)) {
    topicId = '';
  }
  // 科目跟着专业走：081200/085404 只认 408+数一，081200/140600 只认 301+832。
  // 纠正句里常顺带提两个学院的科目（「不走832」），不能把 832 记到计算机头上。
  let finalSubjects = subj;
  if (program === '081200/085404') {
    finalSubjects = subj.filter((s) => s === '408' || s === '数一');
    if (!finalSubjects.includes('408')) finalSubjects.unshift('408');
  } else if (program === '081200/140600') {
    finalSubjects = subj.filter((s) => s === '832' || s === '301');
    if (!finalSubjects.includes('832')) finalSubjects.unshift('832');
  }
  return {
    topicId,
    slot: topicId ? 'exam' : '',
    program,
    subjects: [...new Set(finalSubjects)]
  };
}

/** 是不是「像纠正」的一句话。 */
export function looksLikeCorrection(text = '', { minChars = 6 } = {}) {
  const t = String(text || '').trim();
  if (t.length < minChars) return false;
  if (t.length > 200) return false;
  if (!CORRECTION_RE.test(t)) return false;
  // 必须真的在说考试科目/专业：至少出现一个科目号或专业代码
  if (!/(408|832|301|101|201|081200|085404|081200|140600)/.test(t)) return false;
  // 关于「记忆系统怎么做」的讨论不是纠正事实（她抱怨检索不到 ≠ 给出新口径）
  if (/(记忆|注入|检索|事实卡|轮转|方案|压缩|白名单|测试|脚本)/.test(t)) return false;
  // 排除纯寒暄/指令
  if (/^(晚安|早安|好|收到|知道了|我去|稍等)/.test(t)) return false;
  return true;
}

/**
 * 扫最近几天的窗口账本，把新的纠正句写成 pending 候选。
 * rows 来自 window/<sid>/turns.jsonl；只读 spoken / reply.text。
 */
export function collectClaims(dir = '', { now = Date.now(), days = 3, maxPerDay = 10 } = {}) {
  const since = now - days * 86400000;
  const existing = new Set(readClaims(dir).map((c) => c.hash).filter(Boolean));
  // 已经写进事实库的纠正不再重复进候选（例如 P1b 拆条时已把 408 那条落库）。
  let activeFacts = [];
  try {
    activeFacts = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir), now).filter((f) => f.status === 'active');
  } catch {
    activeFacts = [];
  }
  const alreadyKnown = (cls) => activeFacts.some((f) => f.topicId === cls.topicId && f.slot === cls.slot
    && (!cls.program || String(f.program || '') === cls.program));
  const added = [];
  let sessions = [];
  try {
    sessions = fs.readdirSync(`${String(dir).replace(/[\\/]+$/, '')}/window`).filter((n) => n.startsWith('session-'));
  } catch {
    return { added: [], pending: readClaims(dir).filter((c) => c.status === 'pending') };
  }
  for (const sid of sessions) {
    const rows = readTurns(dir, sid).filter((r) => (Number(r.at) || Date.parse(r.at) || 0) >= since);
    for (const row of rows) {
      const texts = [];
      for (const s of Array.isArray(row.spoken) ? row.spoken : []) {
        if (s && s.text) texts.push({ text: String(s.text), src: 'spoken' });
      }
      if (row.reply && row.reply.text) texts.push({ text: String(row.reply.text), src: 'reply' });
      for (const item of texts) {
        if (!looksLikeCorrection(item.text)) continue;
        const hash = sha1(normText(item.text).slice(0, 200));
        if (existing.has(hash)) continue;
        existing.add(hash);
        const cls = classifyClaim(item.text);
        if (!cls.topicId || alreadyKnown(cls)) continue;
        added.push({
          id: `cl-${hash.slice(0, 10)}`,
          at: Number(row.at) || Date.parse(row.at) || now,
          sessionId: sid,
          turn: Number(row.turn) || 0,
          key: row.key || '',
          quote: item.text.slice(0, 300),
          src: item.src,
          hash,
          topicId: cls.topicId,
          slot: cls.slot,
          program: cls.program,
          subjects: cls.subjects,
          suggestedValue: suggestValue(item.text, cls),
          status: 'pending',
          createdAt: now
        });
      }
    }
  }
  // 每天封顶：先数今天已写的
  const todayStart = startOfDay(now);
  const todayCount = readClaims(dir).filter((c) => (Number(c.createdAt) || 0) >= todayStart).length;
  const room = Math.max(0, maxPerDay - todayCount);
  const take = added.slice(0, room);
  for (const c of take) appendClaim(dir, c);
  return { added: take, dropped: Math.max(0, added.length - take.length), pending: readClaims(dir).filter((c) => c.status === 'pending') };
}

function suggestValue(text = '', cls = {}) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (cls.program && cls.subjects.length) {
    return `${cls.program}：${cls.subjects.join(' + ')}`.slice(0, 60);
  }
  return t.slice(0, 60);
}

function startOfDay(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600 * 1000;
}

/** 用户确认一条候选：写成 author:'correction' 的事实。 */
export function confirmClaim(dir = '', id = '', patch = {}) {
  const claim = readClaims(dir).find((c) => c.id === id);
  if (!claim) return { ok: false, error: '没有这条候选' };
  if (claim.status === 'confirmed') return { ok: false, error: '这条已经确认过了' };
  const topicId = String(patch.topicId || claim.topicId || 't-hust');
  const slot = String(patch.slot || claim.slot || 'exam');
  const program = String(patch.program || claim.program || '');
  const subjects = Array.isArray(patch.subjects) ? patch.subjects : claim.subjects || [];
  const value = String(patch.value || claim.suggestedValue || claim.quote || '').slice(0, 60);
  if (!value) return { ok: false, error: '没有可写入的内容' };
  const now = Date.now();
  const tp = parseTime(value, { refMs: claim.at || now, kindHint: 'fact', slot });
  const sig = program ? `topic:${topicId}:${slot}:${program}` : `topic:${topicId}:${slot}`;
  const base = {
    ev: 'fact',
    key: claim.key || '',
    about: topicId === 't-bot' ? 'bot' : 'user',
    pattern: slot,
    label: slot,
    value,
    text: claim.quote,
    quote: claim.quote,
    topicId,
    slot,
    program,
    subjects,
    class: 'fact',
    source: { kind: 'claim', claimId: claim.id, by: patch.by || 'owner' },
    src: { kind: 'window', sessionId: claim.sessionId, turn: claim.turn, at: claim.at },
    tier: TIER_BY_SLOT[slot] || 'general',
    I: 0.8,
    s: null,
    hits: 1,
    lastAt: now,
    at: now,
    saidAt: claim.at || now,
    dates: tp.dates || [],
    validUntil: tp.validUntil || 0,
    timePhrase: tp.phrase || '',
    timeConfidence: tp.confidence || 0,
    author: 'correction',
    voice: 'third',
    status: 'active'
  };
  // 同 sig 的旧条目退场（保留在事件流里）
  const active = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir), now);
  const old = active.find((f) => f.status === 'active' && f.topicId === topicId && f.slot === slot && (!program || !f.program || f.program === program));
  if (old) {
    lt.appendEvent({
      ev: 'supersede',
      id: old.id,
      ...base,
      sig,
      revision: (Number(old.versions) || 1) + 1,
      by: 'correction'
    }, dir);
    updateClaim(dir, claim.id, { status: 'confirmed', factId: old.id, confirmedAt: now, value });
    return { ok: true, action: 'superseded', id: old.id, value };
  }
  const factId = lt.newId('h-cor');
  lt.appendEvent({ ...base, id: factId, sig }, dir);
  updateClaim(dir, claim.id, { status: 'confirmed', factId, confirmedAt: now, value });
  return { ok: true, action: 'created', id: factId, value };
}

export function rejectClaim(dir = '', id = '', { reason = '用户驳回' } = {}) {
  const r = updateClaim(dir, id, { status: 'rejected', rejectedAt: Date.now(), rejectReason: reason });
  return r;
}

/** 日终挂载：捡纠正句 → pending。失败不影响日终。 */
export function runDailyClaims(dir = '', { now = Date.now(), cfg = {}, log = () => {} } = {}) {
  const c = normalizeClaimConfig(cfg);
  if (!c.enabled) return { skipped: true, added: 0 };
  try {
    const res = collectClaims(dir, { now, days: c.days, maxPerDay: c.maxPerDay });
    if (res.added.length) {
      log(`纠正候选：新增 ${res.added.length} 条（pending，等用户确认）`);
    }
    return { added: res.added.length, pending: res.pending.length, dropped: res.dropped || 0 };
  } catch (err) {
    log(`纠正候选失败（不影响日终）：${err?.message || err}`);
    return { added: 0, error: String(err?.message || err) };
  }
}
