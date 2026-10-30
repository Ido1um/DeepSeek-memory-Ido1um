// 作废/撤销通道（v7 §4.3 / v6.3 §5.4）。
//
// 语义区分：
//   改口（supersede）——有替代值，新条顶替旧条，旧条保留历史；
//   作废（invalidate）——没有替代值（记错了、听错了、张冠李戴），打墓碑。
//
// 不变式：
//   1) 永不物理删除：sidecar（state/facts-invalidated.json）打墓碑，原文与事件都在；
//   2) 检索/卡片/摘要/统计默认过滤墓碑（materialize 负责），审计时可按 id 取回；
//   3) 连坐：作废一条时，它的 supersedes 后代一起作废；
//   4) 可撤销：reinstateFact 立刻恢复，不设时限。
//
// 每次操作都 append 到 logs/facts-audit.jsonl，带原文快照。

import fs from 'node:fs';
import path from 'node:path';

import { appendEvent, materialize, newId, paths, readEvents, readInvalidated, writeJson } from './longterm.mjs';

function auditPath(dir) {
  return paths(dir).audit;
}

function appendAudit(dir, row) {
  const file = auditPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return file;
}

function sidecarOf(dir) {
  const p = paths();
  return { file: p.invalidated, map: readInvalidated() };
}

function snapshotOf(fact) {
  if (!fact) return null;
  return {
    text: fact.text || '',
    value: fact.value || '',
    about: fact.about || '',
    pattern: fact.pattern || '',
    tier: fact.tier || '',
    sig: fact.sig || ''
  };
}

/** 找出这条事实的所有后代（谁 supersede 了它）。 */
export function descendantsOf(id, events = readEvents().rows) {
  const out = [];
  const queue = [String(id)];
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift();
    for (const row of events) {
      if (row?.ev !== 'fact') continue;
      if (String(row.supersedes || '') !== cur) continue;
      const child = String(row.id || '');
      if (!child || seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** 按 id 或语义匹配（about + pattern）找事实。返回 {found, candidates}。 */
export function resolveTargets({ id = '', match = null } = {}, facts) {
  const list = Array.isArray(facts) ? facts : materialize();
  if (id) {
    const hit = list.find((f) => String(f.id) === String(id));
    return { found: hit ? [hit] : [], candidates: hit ? [] : list.map((f) => f.id) };
  }
  if (match && (match.about || match.pattern)) {
    const hits = list.filter(
      (f) =>
        (!match.about || String(f.about) === String(match.about)) &&
        (!match.pattern || String(f.pattern || '').includes(String(match.pattern)) || String(f.label || '').includes(String(match.pattern)))
    );
    return { found: hits, candidates: hits.map((f) => ({ id: f.id, about: f.about, pattern: f.pattern, value: f.value, tier: f.tier })) };
  }
  return { found: [], candidates: [] };
}

/**
 * 作废。
 * @returns {{ok:boolean, ids?:string[], ambiguous?:boolean, candidates?:Array, reason?:string, audit?:string}}
 */
export function invalidateFact({ id = '', match = null, reason = '', by = 'cli', cascade = 'supersedes', now = Date.now() } = {}) {
  const facts = materialize();
  const { found, candidates } = resolveTargets({ id, match }, facts);
  if (!found.length) return { ok: false, reason: id ? `没有 id=${id} 的事实` : '没有匹配的事实', candidates: candidates.slice(0, 10) };
  if (!id && found.length > 1) {
    return { ok: false, ambiguous: true, reason: `匹配到 ${found.length} 条，请用 id 指定或用更精确的条件`, candidates: candidates.slice(0, 10) };
  }
  const target = found[0];
  const ids = [String(target.id)];
  if (cascade === 'supersedes') {
    for (const child of descendantsOf(target.id)) ids.push(child);
  }
  const { file, map } = sidecarOf('');
  const at = new Date(now).toISOString();
  for (const one of ids) {
    map[one] = { at, by: String(by), reason: String(reason || '记错了'), cascade: ids.slice(1) };
  }
  writeJson(file, map);
  const audit = appendAudit('', {
    at,
    op: 'invalidate',
    ids,
    id: target.id,
    by: String(by),
    reason: String(reason || '记错了'),
    cascade: ids.slice(1),
    snapshot: snapshotOf(target)
  });
  return { ok: true, ids, audit, snapshot: snapshotOf(target) };
}

/** 撤销作废。 */
export function reinstateFact({ id = '', by = 'cli', reason = '', now = Date.now() } = {}) {
  const key = String(id || '').trim();
  if (!key) return { ok: false, reason: 'id 不能为空' };
  const { file, map } = sidecarOf('');
  if (!map[key]) return { ok: false, reason: `id=${key} 没有被作废` };
  const before = map[key];
  delete map[key];
  writeJson(file, map);
  const at = new Date(now).toISOString();
  const fact = materialize().find((f) => String(f.id) === key) || null;
  const audit = appendAudit('', { at, op: 'reinstate', id: key, by: String(by), reason: String(reason || ''), snapshot: snapshotOf(fact), before });
  return { ok: true, id: key, audit };
}

/** 已作废清单（给工作台/doctor 用）。 */
export function invalidatedList() {
  const map = readInvalidated();
  return Object.entries(map).map(([id, meta]) => ({ id, ...meta }));
}

/** QQ 指令解析：「作废我生日」「生日记错了」「删掉这条」→ {match:{about,pattern}} 或 {id}。 */
export function parseCommand(text = '') {
  const s = String(text || '').trim();
  if (!s) return null;
  const idMatch = s.match(/\b([hs]-\d{8}-\d{4})\b/);
  if (idMatch) return { id: idMatch[1] };
  if (!/(作废|删掉|删除|记错|不对|撤销)/.test(s)) return null;
  const op = /(撤销|恢复)/.test(s) ? 'reinstate' : 'invalidate';
  const about = /(你|你的)/.test(s) && !/(我|用户)/.test(s) ? 'bot' : 'user';
  const patterns = [
    ['生日', '生日'],
    ['名字', '名字'],
    ['称呼', '称呼'],
    ['住', '住处'],
    ['工作', '工作']
  ];
  const hit = patterns.find(([needle]) => s.includes(needle));
  if (!hit) return null;
  return { op, match: { about, pattern: hit[1] }, text: s };
}
