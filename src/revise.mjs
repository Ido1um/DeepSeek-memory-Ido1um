// 3.1 P7：改记忆与留痕。
// 规则（用户 2026-11-04 拍板）：
//   - 用户可以改任何一条；她自己只能改 author:'self' 的事实、或 about:'bot'（关于她自己）的条目。
//   - 每次修改只追加 ev:'revise'，旧值留在事件流里；同时写 logs/fact-history.jsonl 供工作台/审计查看。
//   - 回滚不是删记录，而是再改一次（新的 revise 即可），历史永远保留。
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, materialize, readEvents, readInvalidated } from './longterm.mjs';

export const REVISE_DEFAULTS = { enabled: true, maxValueChars: 400 };

export function normalizeRevise(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    maxValueChars: Math.max(20, Math.min(1000, Number(raw.maxValueChars) || REVISE_DEFAULTS.maxValueChars))
  };
}

export function canEdit(fact, { role = 'owner' } = {}) {
  if (!fact) return { ok: false, code: 'not-found', reason: '没有这条记忆' };
  if (role === 'owner') return { ok: true };
  if (fact.author === 'self') return { ok: true };
  if (fact.about === 'bot') return { ok: true };
  return { ok: false, code: 'forbidden', reason: '这条是抽取器写的、且不是关于她自己的，只有用户能改' };
}

export function validateRevision({ value, text, validUntil, reason } = {}, { cfg = REVISE_DEFAULTS } = {}) {
  const cfgN = normalizeRevise(cfg);
  const v = String(value == null ? '' : value).trim();
  const t = String(text == null ? '' : text).trim();
  if (!v && !t && validUntil === undefined) return { ok: false, code: 'empty', reason: '至少给一个要改的值' };
  if (v && v.length > cfgN.maxValueChars) return { ok: false, code: 'value-too-long', reason: `值最多 ${cfgN.maxValueChars} 字` };
  if (t && t.length > 400) return { ok: false, code: 'text-too-long', reason: '正文最多 400 字' };
  let until = undefined;
  if (validUntil !== undefined && validUntil !== null && validUntil !== '') {
    const ms = Number(validUntil) || Date.parse(String(validUntil));
    if (!Number.isFinite(ms) || ms <= 0) return { ok: false, code: 'bad-until', reason: 'validUntil 不是合法时间' };
    until = ms;
  }
  return { ok: true, value: v || undefined, text: t || undefined, validUntil: until, reason: String(reason || '').slice(0, 200) };
}

function historyPath(dir) {
  return path.join(String(dir), 'logs', 'fact-history.jsonl');
}

function appendHistory(dir, row) {
  const file = historyPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

export function readFactHistory(dir, id) {
  const file = historyPath(dir);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.id === id) rows.push(row);
    } catch {}
  }
  return rows;
}

export function reviseFact(dir, id, patch = {}, { by = 'owner', role = 'owner', cfg = REVISE_DEFAULTS, now = Date.now() } = {}) {
  const cfgN = normalizeRevise(cfg);
  if (!cfgN.enabled) return { ok: false, code: 'disabled', reason: '改记忆功能已关闭' };
  const facts = materialize(readEvents(dir).rows, readInvalidated(dir), now);
  const fact = facts.find((f) => f.id === id);
  const perm = canEdit(fact, { role });
  if (!perm.ok) return perm;
  const v = validateRevision(patch, { cfg: cfgN });
  if (!v.ok) return v;
  if (!v.value && !v.text && v.validUntil === undefined) return { ok: false, code: 'no-change', reason: '这次修改没有实际内容' };

  const before = { value: fact.value, text: fact.text, validUntil: fact.validUntil || 0 };
  const at = now;
  const ev = {
    ev: 'revise',
    id,
    at,
    by: by === 'self' ? 'self' : 'owner',
    reason: v.reason || '',
    revision: (Number(fact.versions) || 1) + 1
  };
  if (v.value !== undefined) ev.value = v.value;
  if (v.text !== undefined) ev.text = v.text;
  if (v.validUntil !== undefined) ev.validUntil = v.validUntil;
  appendEvent(ev, dir);
  const after = { value: ev.value ?? fact.value, text: ev.text ?? fact.text, validUntil: (ev.validUntil ?? fact.validUntil) || 0 };
  appendHistory(dir, {
    at,
    id,
    by: ev.by,
    reason: ev.reason,
    revision: ev.revision,
    before,
    after,
    source: 'revise'
  });
  const updated = materialize(readEvents(dir).rows, readInvalidated(dir), now).find((f) => f.id === id);
  return { ok: true, action: 'revise', before, after, fact: updated };
}
