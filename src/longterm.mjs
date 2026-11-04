// 长期记忆落盘（v7 §6）：事件流 + 折叠。
//
// 为什么用「事件流」而不是「一条事实一行、原地改」：
// 1) 只追加，不重写历史，写失败最多丢最后一行；
// 2) 提及、升降档、作废、过期都是事件，审计时能还原「什么时候因为什么变成现在这样」；
// 3) 影子模式（scoring.mode=shadow）写的是同一套结构，只是换个文件，切写入时不用改代码。
//
// 事件类型（longterm.jsonl 每行一条）：
//   fact      新事实：{ev,id,sig,key,about,pattern,label,value,text,tier,I,s,hits,lastAt,at}
//   mention   被再次提及：{ev,id,at,hits,s,I}
//   tier      升降档结算：{ev,id,at,tier,s,score,from}
//   expire    临时记忆过期：{ev,id,at,reason}
//   invalidate 作废：{ev,id,at,by,reason}      （撤销用 reinstate）
//   reinstate  撤销作废：{ev,id,at}
//
// 影子文件 state/scoring-shadow.jsonl 结构相同，但多一个 `dry:true` 且 id 前缀 s-。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.mjs';
import { isExpired, parseBirthday, birthdayWho } from './timeparse.mjs';

export const LONGTTERM = 'longterm.jsonl';
export const SHADOW = 'scoring-shadow.jsonl';
export const DRYRUN = 'scoring-dryrun.json';
export const SHADOW_STATS = 'scoring-shadow-stats.json';
export const INVALIDATED = 'facts-invalidated.json';
export const BASE = 'base.json';

export function paths(dir = '') {
  const root = String(dir || '') || store.dataDir();
  const state = path.join(root, 'state');
  return {
    root,
    state,
    longterm: path.join(state, LONGTTERM),
    shadow: path.join(state, SHADOW),
    dryrun: path.join(state, DRYRUN),
    stats: path.join(state, SHADOW_STATS),
    invalidated: path.join(state, INVALIDATED),
    base: path.join(state, BASE),
    audit: path.join(root, 'logs', 'facts-audit.jsonl')
  };
}

/**
 * 事件时间统一成毫秒数：引擎写数字 epoch，工作台历史上写过 ISO 字符串。
 * 直接 Number("2026-10-30T…") = NaN，会让 lastAt 被重置成「现在」→ 永不衰减。
 */
export function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v) {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function newId(prefix = 'h') {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}-${day}-${rand}`;
}

/** 读 JSONL：容忍 BOM、空行、坏行（坏行计数返回，不抛）。 */
export function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], bad: 0 };
  }
  const rows = [];
  let bad = 0;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && typeof row === 'object') rows.push(row);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

/** 读压缩快照：{ at, facts:[...] }；不存在/损坏返回 null。 */
export function readBase(dir = '') {
  const { rows } = { rows: [] };
  try {
    const raw = fs.readFileSync(paths(dir).base, 'utf8').replace(/^\uFEFF/, '');
    const doc = JSON.parse(raw);
    if (!doc || !Array.isArray(doc.facts)) return null;
    return doc;
  } catch {
    return null;
  }
}

/** 把快照里的折叠态还原成 fact 事件（字段一一对应，materialize 后等价）。 */
function baseEvents(dir = '') {
  const doc = readBase(dir);
  if (!doc) return [];
  return doc.facts.map((f) => ({
    ev: 'fact',
    id: f.id,
    sig: f.sig,
    key: f.key,
    about: f.about,
    pattern: f.pattern,
    label: f.label,
    value: f.value,
    text: f.text,
    quote: f.quote,
    topic: f.topic,
    class: f.class,
    conf: f.conf,
    private: f.private,
    source: f.source,
    tier: f.tier,
    I: f.I,
    s: f.s,
    hits: f.hits,
    manual: f.manual,
    autoI: f.autoI,
    autoS: f.autoS,
    versions: f.versions,
    supersededAt: f.supersededAt,
    notifiedAt: f.notifiedAt,
    task: f.task,
    due: f.due,
    dueAt: f.dueAt,
    duePhrase: f.duePhrase,
    lastAt: f.lastAt,
    at: f.createdAt,
    _base: true
  }));
}

export function readEvents(dir = '') {
  const tail = readJsonl(paths(dir).longterm);
  const base = baseEvents(dir);
  if (!base.length) return tail;
  return { rows: [...base, ...tail.rows], bad: tail.bad };
}

export function appendEvent(row, dir = '') {
  appendJsonl(paths(dir).longterm, row);
  return row;
}

// 兼容 readShadow() / readShadow(limit) / readShadow(dir) / readShadow(limit, dir)
export function readShadow(limit = 0, dir = '') {
  if (typeof limit === 'string') { dir = limit; limit = 0; }
  const { rows, bad } = readJsonl(paths(dir).shadow);
  const list = limit > 0 ? rows.slice(-limit) : rows;
  return { rows: list, total: rows.length, bad };
}

export function appendShadow(row, dir = '') {
  appendJsonl(paths(dir).shadow, { ...row, dry: true });
  return row;
}

export function readJson(file, fallback) {
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 作废墓碑：{ id: {at,by,reason} }，由工作台 / CLI 维护。 */
export function readInvalidated(dir = '') {
  const j = readJson(paths(dir).invalidated, {});
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}

/**
 * 把事件流折叠成「当前事实」。
 * 返回 [{ id, sig, about, pattern, label, value, text, tier, I, s, hits, lastAt, createdAt, status }]
 * status: active | expired | invalidated
 */
/** 影子模式预览用：把已写入事件与影子事件合并折叠（id 前缀不同，不会互相覆盖）。 */
export function materializeWithShadow(dir = '') {
  return materialize([...readEvents(dir).rows, ...readShadow(0, dir).rows], readInvalidated(dir));
}

/**
 * 置信度：v11 起每条事实带 conf（0–1）。老事件没有这个字段，
 * 按档位推导——硬事实近乎确定，临时状态只是「可能记着」，chat 更低。
 * 读时推导、不迁移，保证旧数据不写库也能有新语义。
 */
export function confOfTier(tier) {
  const t = String(tier || '').trim();
  if (t === 'hard') return 0.95;
  if (t === 'long') return 0.8;
  if (t === 'temp') return 0.5;
  if (t === 'chat') return 0.3;
  return 0.6;
}

function applyEvent(map, ev) {
  const id = ev.id;
  if (ev.ev === 'fact') {
    map.set(id, {
      id,
      sig: ev.sig || '',
      key: ev.key || '',
      about: ev.about || 'user',
      pattern: ev.pattern || '',
      label: ev.label || '',
      value: ev.value || '',
      text: ev.text || '',
      src: ev.src || null,
      quote: ev.quote || '',
      topic: ev.topic || '',
      // 记忆 3.0：主题簇归属（缺省空串；老事件不迁移，读取时按空处理）
      topicId: String(ev.topicId || ''),
      slot: String(ev.slot || ''),
      class: ev.class || 'note',
      // v11：置信度与私密标记（老事件缺字段 → 按档推导 / false，不迁移）
      conf: Number.isFinite(Number(ev.conf)) ? Math.max(0, Math.min(1, Number(ev.conf))) : confOfTier(ev.tier),
      private: ev.private === true,
      badHits: 0,
      feels: [],
      // v10：属性与检索计数（老事件缺字段 → 0/空；读时按需推导，不迁移）
      emo: Number.isFinite(Number(ev.emo)) ? Math.max(-1, Math.min(1, Number(ev.emo))) : 0,
      rel: Number.isFinite(Number(ev.rel)) ? Math.max(0, Math.min(1, Number(ev.rel))) : 0,
      scene: Array.isArray(ev.scene) ? ev.scene.slice(0, 6) : [],
      fragments: Array.isArray(ev.fragments) ? ev.fragments.slice(0, 5) : [],
      accessCount: Number.isFinite(Number(ev.accessCount)) ? Number(ev.accessCount) : 0,
      lastRetrievedAt: toMs(ev.lastRetrievedAt) || 0,
      source: ev.source && typeof ev.source === 'object' ? ev.source : null,
      tier: ev.tier === 'hard' ? 'hard' : ev.tier || 'general',
      I: Number.isFinite(Number(ev.I)) ? Number(ev.I) : 0.2,
      s: ev.s != null && Number.isFinite(Number(ev.s)) ? Number(ev.s) : 3,
      hits: Number.isFinite(Number(ev.hits)) ? Number(ev.hits) : 1,
      manual: ev.manual === true,
      autoI: ev.autoI === undefined ? null : ev.autoI,
      autoS: ev.autoS === undefined ? null : ev.autoS,
      updatedAt: 0,
      lastAt: toMs(ev.lastAt) || toMs(ev.at) || Date.now(),
      createdAt: toMs(ev.at) || toMs(ev.lastAt) || Date.now(),
      task: Boolean(ev.task),
      due: ev.due || '',
      // 时间锚（3.0 补丁）：saidAt 是「这句话被说出的那一轮」，createdAt 才是写入时间；
      // 回填写入的条目两者能差好几天，卡片与检索只认 saidAt。
      saidAt: Number(ev.saidAt) || 0,
      dates: Array.isArray(ev.dates) ? ev.dates.slice(0, 4) : [],
      validUntil: Number(ev.validUntil) || 0,
      timePhrase: ev.timePhrase || '',
      timeConfidence: Number.isFinite(Number(ev.timeConfidence)) ? Number(ev.timeConfidence) : 0,
      timeUnknown: ev.timeUnknown === true,
      legacyRelative: ev.legacyRelative === true,
      dueAt: Number(ev.dueAt) || 0,
      duePhrase: ev.duePhrase || '',
      notifiedAt: Number(ev.notifiedAt) || 0,
      versions: Number.isFinite(Number(ev.versions)) ? Number(ev.versions) : 1,
      supersededAt: Number(ev.supersededAt) || 0,
      // 合并：被并进来的条目退场（status=merged），主条目记下并入了谁
      mergedInto: ev.mergedInto || '',
      mergedFrom: Array.isArray(ev.mergedFrom) ? ev.mergedFrom.slice(0, 8) : [],
      status: ev.status === 'invalidated' || ev.status === 'expired' || ev.status === 'merged' ? ev.status : 'active'
    });
    return;
  }
  if (ev.ev === 'merge') {
    // 一条事实并进另一条：源条目退场（保留原文与审计），目标条目吸收 mergedFrom
    const into = ev.into || ev.id || '';
    const at = toMs(ev.at) || Date.now();
    const ids = Array.isArray(ev.ids) ? ev.ids.filter((x) => x && x !== into) : [];
    for (const sid of ids) {
      const src = map.get(sid);
      if (!src || src.status === 'merged' || src.status === 'invalidated') continue;
      src.status = 'merged';
      src.mergedInto = into;
      src.updatedAt = at;
    }
    const dst = into ? map.get(into) : null;
    if (dst) {
      dst.mergedFrom = Array.from(new Set([...(dst.mergedFrom || []), ...ids]));
      dst.updatedAt = at;
    }
    return;
  }
  if (ev.ev === 'unmerge') {
    // 拆开合并：源条目回到 active（可再调档/调分），目标条目不再记这个来源。
    // 只追加、不物理删，历史里仍能看到当初怎么合的。
    const at = toMs(ev.at) || Date.now();
    const src = map.get(id);
    if (src) {
      const into = src.mergedInto;
      src.status = 'active';
      src.mergedInto = '';
      src.updatedAt = at;
      const dst = into ? map.get(into) : null;
      if (dst && Array.isArray(dst.mergedFrom)) {
        dst.mergedFrom = dst.mergedFrom.filter((x) => x !== id);
        dst.updatedAt = at;
      }
    }
    return;
  }
  const cur = map.get(id);
  if (!cur) return;
  if (ev.ev === 'mention') {
    cur.hits = Math.max(cur.hits, Number(ev.hits) || cur.hits + 1);
    if (ev.s != null && Number.isFinite(Number(ev.s))) cur.s = Number(ev.s);
    if (Number.isFinite(Number(ev.I))) cur.I = Number(ev.I);
    cur.lastAt = toMs(ev.at) || cur.lastAt;
    if (cur.status === 'expired') cur.status = 'active';
  } else if (ev.ev === 'retrieved') {
    // v10：检索命中只记「被想起来」，不涨分、不当提及（同 fact 每天最多一条，由调用方去重）
    cur.accessCount = (Number(cur.accessCount) || 0) + 1;
    cur.lastRetrievedAt = toMs(ev.at) || Date.now();
    cur.updatedAt = cur.lastRetrievedAt;

  } else if (ev.ev === 'src') {
    if (cur) cur.src = ev.src || null;  } else if (ev.ev === 'tier') {
    if (ev.tier) cur.tier = ev.tier;
    if (ev.s != null && Number.isFinite(Number(ev.s))) cur.s = Number(ev.s);
    cur.updatedAt = toMs(ev.at) || Date.now();
    if (cur.status === 'expired' && ev.tier !== 'temp') cur.status = 'active';
  } else if (ev.ev === 'expire') {
    cur.status = 'expired';
    cur.updatedAt = toMs(ev.at) || Date.now();
  } else if (ev.ev === 'invalidate') {
    cur.status = 'invalidated';
    cur.updatedAt = toMs(ev.at) || Date.now();
  } else if (ev.ev === 'reinstate') {
    cur.status = 'active';
    cur.updatedAt = toMs(ev.at) || Date.now();
  } else if (ev.ev === 'update') {
    const dueBefore = `${cur.dueAt}|${cur.due}`;
    if (ev.due) cur.due = ev.due;
    if (Number(ev.dueAt)) cur.dueAt = Number(ev.dueAt);
    if (typeof ev.task === 'boolean') cur.task = ev.task;
    if (ev.duePhrase) cur.duePhrase = ev.duePhrase;
    // 记忆 3.0：给已存在的事实补挂主题/槽位（迁移与归并都走这条，不重写历史行）。
    if (ev.topicId !== undefined) cur.topicId = String(ev.topicId || '');
    if (ev.slot !== undefined) cur.slot = String(ev.slot || '');
    // 3.0 补丁：时间锚迁移（迁移脚本与后续修订都走这条，同样是追加式）
    if (ev.saidAt !== undefined) cur.saidAt = Number(ev.saidAt) || 0;
    if (ev.dates !== undefined) cur.dates = Array.isArray(ev.dates) ? ev.dates.slice(0, 4) : [];
    if (ev.validUntil !== undefined) cur.validUntil = Number(ev.validUntil) || 0;
    if (ev.timePhrase !== undefined) cur.timePhrase = String(ev.timePhrase || '');
    if (ev.timeConfidence !== undefined) cur.timeConfidence = Number(ev.timeConfidence) || 0;
    if (ev.timeUnknown !== undefined) cur.timeUnknown = ev.timeUnknown === true;
    if (ev.legacyRelative !== undefined) cur.legacyRelative = ev.legacyRelative === true;
    // 3.0 补丁：生日结构化字段（{y,m,d,key,yearly,who}），迁移与后续修订都是追加式。
    if (ev.birthday !== undefined) cur.birthday = ev.birthday && ev.birthday.key ? ev.birthday : null;
    if (`${cur.dueAt}|${cur.due}` !== dueBefore) cur.notifiedAt = 0;
    cur.updatedAt = toMs(ev.at) || Date.now();
  } else if (ev.ev === 'notified') {
    cur.notifiedAt = toMs(ev.at) || Date.now();
  } else if (ev.ev === 'supersede') {
    if (ev.value !== undefined) cur.value = ev.value;
    if (ev.quote) cur.quote = ev.quote;
    if (ev.label) cur.label = ev.label;
    if (ev.source && typeof ev.source === 'object') cur.source = ev.source;
    // 新值可能带着新的时间锚（「今晚」换成另一晚）——跟着一起换，别让新值顶着旧有效期。
    if (Number(ev.saidAt)) cur.saidAt = Number(ev.saidAt);
    if (Array.isArray(ev.dates)) cur.dates = ev.dates.slice(0, 4);
    if (ev.validUntil !== undefined) cur.validUntil = Number(ev.validUntil) || 0;
    if (ev.timePhrase !== undefined) cur.timePhrase = ev.timePhrase || '';
    if (ev.timeConfidence !== undefined) cur.timeConfidence = Number(ev.timeConfidence) || 0;
    if (ev.birthday && typeof ev.birthday === 'object') cur.birthday = ev.birthday;
    cur.versions = (Number(cur.versions) || 1) + 1;
    cur.supersededAt = toMs(ev.at) || Date.now();
    cur.lastAt = toMs(ev.at) || cur.lastAt;
    if (cur.status === 'expired') cur.status = 'active';
  } else if (ev.ev === 'feel') {
    const feel = String(ev.feel || '').trim().slice(0, 40);
    if (cur && feel) {
      cur.feels = Array.isArray(cur.feels) ? cur.feels : [];
      if (!cur.feels.some((x) => x.feel === feel)) {
        cur.feels.push({ feel, quote: ev.quote || '', by: ev.by || 'self', derived: ev.derived === true, at: toMs(ev.at) || Date.now() });
      }
    }
  } else if (ev.ev === 'badHit') {
    cur.badHits = (Number(cur.badHits) || 0) + 1;
    cur.lastBadAt = toMs(ev.at) || Date.now();
  } else if (ev.ev === 'manual') {
    if (ev.tier) cur.tier = ev.tier;
    const target = Number(ev.score);
    if (Number.isFinite(target)) {
      if (!cur.manual) { cur.autoI = cur.I; cur.autoS = cur.s; }
      cur.manual = true;
      cur.I = Math.max(0, Math.min(1, target / 100));
      if (ev.tier !== 'hard' && ev.s != null && Number.isFinite(Number(ev.s))) cur.s = Number(ev.s);
      cur.lastAt = toMs(ev.at) || cur.lastAt;
    }
    cur.updatedAt = toMs(ev.at) || Date.now();
    if (cur.status === 'expired' && ev.tier !== 'temp') cur.status = 'active';
  } else if (ev.ev === 'manualReset') {
    if (cur.autoI !== null && Number.isFinite(Number(cur.autoI))) cur.I = Number(cur.autoI);
    if (cur.autoS !== null && Number.isFinite(Number(cur.autoS))) cur.s = Number(cur.autoS);
    cur.manual = false;
    cur.autoI = null;
    cur.autoS = null;
    cur.lastAt = toMs(ev.at) || cur.lastAt;
    cur.updatedAt = toMs(ev.at) || Date.now();
  }
}

export function materialize(events = readEvents().rows, invalidated = readInvalidated(), now = Date.now()) {
  const map = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (!ev.id) continue;
    applyEvent(map, ev);
  }
  for (const f of map.values()) {
    if (f.status === 'active' && invalidated[f.id]) f.status = 'invalidated';
    // 3.0 补丁：对外只暴露统一的「事件时间」at；过期不删数据，只降级。
    f.at = Number(f.saidAt) || Number(f.createdAt) || 0;
    f.expired = isExpired(f.validUntil, now);
    // 3.0 补丁：生日必须落到日期字段。老事实（value 里写「3 月 15 日」）在这里补算，
    // 这样卡片/检索不用读文案，直接读 birthday.key（MM-DD）与 birthday.y。
    if (String(f.slot || '') === 'birthday' && !f.birthday) {
      const b = parseBirthday(f.value || f.text || '');
      if (b) {
        f.birthday = { ...b, who: birthdayWho(f.value || '', f.about || '') };
        if (!(Array.isArray(f.dates) && f.dates.some((d) => d && d.kind === 'birthday'))) {
          f.dates = [{ date: b.y ? `${b.y}-${b.key}` : '', kind: 'birthday', who: f.birthday.who, yearly: true, phrase: b.phrase }];
        }
      }
    }
    f.effectiveStatus = f.expired && f.status === 'active' ? 'expired' : f.status;
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** 影子模式统计：按天累加，供工作台显示「影子跑得怎么样」。 */
export function bumpShadowStats(patch = {}, now = Date.now(), dir = '') {
  const file = paths(dir).stats;
  const cur = readJson(file, { startedAt: 0, total: 0, days: {}, lastAt: 0 });
  const day = new Date(now).toISOString().slice(0, 10);
  const d = (cur.days && cur.days[day]) || { messages: 0, facts: 0, mentions: 0, hard: 0 };
  for (const [k, v] of Object.entries(patch || {})) {
    if (typeof v === 'number') d[k] = (Number(d[k]) || 0) + v;
  }
  cur.days = cur.days || {};
  cur.days[day] = d;
  cur.startedAt = cur.startedAt || now;
  cur.total = (Number(cur.total) || 0) + (Number(patch.facts) || 0) + (Number(patch.mentions) || 0);
  cur.lastAt = now;
  const days = Object.keys(cur.days).sort();
  for (const old of days.slice(0, Math.max(0, days.length - 14))) delete cur.days[old];
  writeJson(file, cur);
  return cur;
}

export function readShadowStats(dir = '') {
  return readJson(paths(dir).stats, { startedAt: 0, total: 0, days: {}, lastAt: 0 });
}

export function readDryrun(dir = '') {
  return readJson(paths(dir).dryrun, null);
}

export function writeDryrun(obj, dir = '') {
  writeJson(paths(dir).dryrun, obj);
}

/**
 * 事件流内存索引：进程内只读新增字节，避免每条消息把整库重放一遍。
 * - 只读、不写文件；文件变小（被删/回滚）时自动全量重置。
 * - invalidated 墓碑单独叠加，撤销后状态能回到 active（不会被钉死）。
 */
const INDEXES = new Map();

export function openIndex(dir = '') {
  const cacheKey = paths(dir).state;
  let idx = INDEXES.get(cacheKey);
  if (!idx) { idx = createIndex(dir); INDEXES.set(cacheKey, idx); }
  return idx;
}

export function dropIndex(dir = '') {
  INDEXES.delete(paths(dir).state);
}

function createIndex(dir) {
  const file = paths(dir).longterm;
  const baseFile = paths(dir).base;
  const invFile = paths(dir).invalidated;
  const map = new Map();
  const evStatus = new Map();
  let offset = 0;
  let leftover = '';
  let invSig = '';
  let baseSig = '';
  let invalidated = {};
  let cached = null;
  const stats = { events: 0, bytes: 0, reloads: 0, reads: 0, baseAt: 0 };

  function reset() {
    map.clear(); evStatus.clear(); offset = 0; leftover = '';
    stats.events = 0; stats.bytes = 0; cached = null;
  }

  /** 快照变更（重新压缩/被删）就整体重置：tail 必须重新叠。 */
  function syncBase() {
    let sig = 'none';
    try { const st = fs.statSync(baseFile); sig = st.size + ':' + st.mtimeMs; } catch { sig = 'none'; }
    if (sig === baseSig) return;
    baseSig = sig;
    reset();
    const evs = baseEvents(dir);
    for (const ev of evs) {
      applyEvent(map, ev);
      const cur = map.get(ev.id);
      if (cur) evStatus.set(ev.id, cur.status);
      stats.events++;
    }
    stats.baseAt = evs.length;
  }

  function sync() {
    stats.reads++;
    syncBase();
    let size = 0;
    try { size = fs.statSync(file).size; } catch { reset(); return; }
    if (size < offset) { reset(); stats.reloads++; }
    if (size === offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      offset = size;
      const parts = (leftover + buf.toString('utf8')).split('\n');
      leftover = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.replace(/^\uFEFF/, '').trim();
        if (!line) continue;
        let ev = null;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== 'object' || !ev.id) continue;
        applyEvent(map, ev);
        const cur = map.get(ev.id);
        if (cur) evStatus.set(ev.id, cur.status);
        stats.events++;
      }
    } finally {
      fs.closeSync(fd);
    }
    stats.bytes = offset;
    cached = null;
  }

  function loadInvalidated() {
    let sig = 'none';
    try {
      const st = fs.statSync(invFile);
      sig = st.size + ':' + st.mtimeMs;
    } catch { sig = 'none'; }
    if (sig === invSig) return;
    invSig = sig;
    try { invalidated = JSON.parse(fs.readFileSync(invFile, 'utf8')) || {}; } catch { invalidated = {}; }
    cached = null;
  }

  /**
   * 读时派生时间字段（与 materialize 保持一致）：
   * - at：那句话被说出的时间（saidAt），没有才退回 createdAt / lastAt；
   * - expired：validUntil 已过（按当前时间算，每次读都重算，不缓存）。
   *
   * 为什么不写进事件里：过期是「相对现在」的状态，写死就会在第二天变错；
   * 为什么不只在 materialize 里算：卡面/检索走的是这个索引，漏了就会出现
   * 「已过期的事实还挂在现在区、检索也不标旧事」——2026-11-04 日终体检发现。
   */
  function deriveTime(out) {
    const now = Date.now();
    for (const f of out) {
      const said = Number(f.saidAt) || 0;
      f.at = said || Number(f.createdAt) || Number(f.lastAt) || 0;
      f.expired = Boolean(f.validUntil) && isExpired(f.validUntil, now);
    }
  }

  function facts() {
    sync();
    loadInvalidated();
    if (!cached) {
      const out = [];
      for (const f of map.values()) {
        const own = evStatus.get(f.id) || f.status;
        const base = f.mergedInto && f.status !== 'active' ? 'merged' : own;
        f.status = base === 'active' && invalidated[f.id] ? 'invalidated' : base;
        out.push(f);
      }
      cached = out.sort((a, b) => b.lastAt - a.lastAt);
    }
    deriveTime(cached);
    return cached;
  }

  return { facts, sync, stats, invalidate: () => { cached = null; } };
}
