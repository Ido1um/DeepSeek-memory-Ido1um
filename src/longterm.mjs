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

export const LONGTTERM = 'longterm.jsonl';
export const SHADOW = 'scoring-shadow.jsonl';
export const DRYRUN = 'scoring-dryrun.json';
export const SHADOW_STATS = 'scoring-shadow-stats.json';
export const INVALIDATED = 'facts-invalidated.json';

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

export function readEvents(dir = '') {
  return readJsonl(paths(dir).longterm);
}

export function appendEvent(row, dir = '') {
  appendJsonl(paths(dir).longterm, row);
  return row;
}

export function readShadow(limit = 0, dir = '') {
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

export function materialize(events = readEvents().rows, invalidated = readInvalidated()) {
  const map = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const id = ev.id;
    if (!id) continue;
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
        quote: ev.quote || '',
        topic: ev.topic || '',
        class: ev.class || 'note',
        badHits: 0,
        source: ev.source && typeof ev.source === 'object' ? ev.source : null,
        tier: ev.tier === 'hard' ? 'hard' : ev.tier || 'general',
        I: Number.isFinite(Number(ev.I)) ? Number(ev.I) : 0.2,
        s: ev.s != null && Number.isFinite(Number(ev.s)) ? Number(ev.s) : 3,
        hits: Number.isFinite(Number(ev.hits)) ? Number(ev.hits) : 1,
        manual: false,
        autoI: null,
        autoS: null,
        updatedAt: 0,
        lastAt: toMs(ev.lastAt) || toMs(ev.at) || Date.now(),
        createdAt: toMs(ev.at) || toMs(ev.lastAt) || Date.now(),
        task: Boolean(ev.task),
        due: ev.due || '',
        dueAt: Number(ev.dueAt) || 0,
        duePhrase: ev.duePhrase || '',
        notifiedAt: 0,
        versions: 1,
        supersededAt: 0,
        status: 'active'
      });
      continue;
    }
    const cur = map.get(id);
    if (!cur) continue;
    if (ev.ev === 'mention') {
      cur.hits = Math.max(cur.hits, Number(ev.hits) || cur.hits + 1);
      if (ev.s != null && Number.isFinite(Number(ev.s))) cur.s = Number(ev.s);
      if (Number.isFinite(Number(ev.I))) cur.I = Number(ev.I);
      cur.lastAt = toMs(ev.at) || cur.lastAt;
      if (cur.status === 'expired') cur.status = 'active';
    } else if (ev.ev === 'tier') {
      // 升降档是「打分结算」不是「又被提了一次」：不能动 lastAt，否则一降档就回春，
      // daysSinceHit 归零、分数反弹，长期记忆永远沉不下去。
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
      // 补正类事件：只改指定字段（用于给已存在的记忆补 due / 标记事项）。
      const dueBefore = `${cur.dueAt}|${cur.due}`;
      if (ev.due) cur.due = ev.due;
      if (Number(ev.dueAt)) cur.dueAt = Number(ev.dueAt);
      if (typeof ev.task === 'boolean') cur.task = ev.task;
      if (ev.duePhrase) cur.duePhrase = ev.duePhrase;
      // 改期后旧的「已提醒」标记必须失效，否则新日期永远不提醒。
      if (`${cur.dueAt}|${cur.due}` !== dueBefore) cur.notifiedAt = 0;
      cur.updatedAt = toMs(ev.at) || Date.now();
    } else if (ev.ev === 'notified') {
      cur.notifiedAt = toMs(ev.at) || Date.now();
    } else if (ev.ev === 'supersede') {
      // v8 版本链：同主题的新说法顶掉旧值，但历史留在事件流里（可审计、可回滚）。
      if (ev.value !== undefined) cur.value = ev.value;
      if (ev.quote) cur.quote = ev.quote;
      if (ev.source && typeof ev.source === 'object') cur.source = ev.source;
      cur.versions = (Number(cur.versions) || 1) + 1;
      cur.supersededAt = toMs(ev.at) || Date.now();
      cur.lastAt = toMs(ev.at) || cur.lastAt;
      if (cur.status === 'expired') cur.status = 'active';
    } else if (ev.ev === 'badHit') {
      // v8 反自强化：召回后被判无关 → 记一笔，累计 2 次检索降权（不删）。
      cur.badHits = (Number(cur.badHits) || 0) + 1;
      cur.lastBadAt = toMs(ev.at) || Date.now();
    } else if (ev.ev === 'manual') {
      // 人工调档/调分：给目标档位与目标分数，换算成 I（=目标/100）并重置为「现在」；
      // 之后仍按该档的正常规则衰减 —— 人工只是拉一下，不是冻住。
      if (ev.tier) cur.tier = ev.tier;
      const target = Number(ev.score);
      if (Number.isFinite(target)) {
        if (!cur.manual) { cur.autoI = cur.I; cur.autoS = cur.s; }
        cur.manual = true;
        cur.I = Math.max(0, Math.min(1, target / 100));
        if (ev.tier !== 'hard' && ev.s != null && Number.isFinite(Number(ev.s))) cur.s = Number(ev.s);
        // 工作台写的是 ISO 字符串：能解析就用它，解析不出才回落到上一次时间（不能用 now）。
        cur.lastAt = toMs(ev.at) || cur.lastAt;
      }
      cur.updatedAt = toMs(ev.at) || Date.now();
      if (cur.status === 'expired' && ev.tier !== 'temp') cur.status = 'active';
    } else if (ev.ev === 'manualReset') {
      // 撤销人工调整：I 与 S 都回到被人工改之前的值，继续按自动规则衰减。
      if (cur.autoI !== null && Number.isFinite(Number(cur.autoI))) cur.I = Number(cur.autoI);
      if (cur.autoS !== null && Number.isFinite(Number(cur.autoS))) cur.s = Number(cur.autoS);
      cur.manual = false;
      cur.autoI = null;
      cur.autoS = null;
      cur.lastAt = toMs(ev.at) || cur.lastAt;
      cur.updatedAt = toMs(ev.at) || Date.now();
    }
  }
  for (const f of map.values()) {
    if (f.status === 'active' && invalidated[f.id]) f.status = 'invalidated';
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
