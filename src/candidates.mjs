// 候选池（v11 宽进归并的第一站）。
//
// 为什么要有它：模型抽取的通过候选、以及写入门打标的「低置信」候选，
// 都不该直接写进长期事实库——事实库是卡片和检索的唯一来源，
// 一条错事实会污染性格卡、并且跟着复习机制被反复强化。
//
// 所以先落到 state/candidates.jsonl：
//   - 不进事实卡、不进检索、不参与打分与衰减；
//   - 日终由 merge 阶段（src/merge-model.mjs）配对、裁决，
//     合并/升级/否决之后才写 fact 事件；
//   - 工作台可以只读展示「候选池 / 待归并」。
//
// 文件按行追加（JSONL），每条候选是一条独立记录；status 用于后续状态机：
//   pending  → 等归并
//   merged   → 已并入某条事实（mergedInto）
//   rejected → 归并/人工否决
//   promoted → 直接升级成事实（promoteInto）
//
// 读写都是纯 Node、零依赖；坏行跳过不抛，避免一条坏数据卡住整个日终。

import fs from 'node:fs';
import path from 'node:path';

import * as lt from './longterm.mjs';

export const CANDIDATES_FILE = 'candidates.jsonl';

export function candidatesPath(dir = '') {
  return path.join(lt.paths(dir).state, CANDIDATES_FILE);
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 读候选池；坏行跳过并计数，不抛。 */
export function readCandidates(dir = '') {
  const file = candidatesPath(dir);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], bad: 0, path: file };
  }
  const rows = [];
  let bad = 0;
  for (const line of stripBom(raw).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && typeof row === 'object') rows.push(row);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { rows, bad, path: file };
}

/** 追加候选（单条或数组）。自动补 id/at/status，返回值即写进去的行。 */
export function appendCandidates(list, dir = '') {
  const arr = (Array.isArray(list) ? list : [list]).filter((x) => x && typeof x === 'object');
  if (!arr.length) return [];
  const file = candidatesPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = arr.map((row) => ({
    id: row.id || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Number(row.at) || Date.now(),
    status: row.status || 'pending',
    ...row
  }));
  fs.appendFileSync(file, `${out.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return out;
}

/** 整池重写（归并阶段改状态用）。先写临时文件再 rename，半途失败不留半截。 */
export function writeCandidates(rows, dir = '') {
  const file = candidatesPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = (Array.isArray(rows) ? rows : []).map((r) => JSON.stringify(r)).join('\n');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  fs.renameSync(tmp, file);
  return Array.isArray(rows) ? rows.length : 0;
}

/** 只读统计：供工作台/日终报告用。 */
export function summarizeCandidates(dir = '') {
  const { rows, bad, path: file } = readCandidates(dir);
  const byStatus = {};
  const byKind = {};
  const bySource = {};
  for (const r of rows) {
    const st = r.status || 'pending';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const k = r.kind || r.pattern || 'unknown';
    byKind[k] = (byKind[k] || 0) + 1;
    const src = (r.source && r.source.model) || r.sourceKind || 'rule';
    bySource[src === true ? 'model' : src] = (bySource[src === true ? 'model' : src] || 0) + 1;
  }
  const pending = rows.filter((r) => (r.status || 'pending') === 'pending');
  return {
    total: rows.length,
    pending: pending.length,
    bad,
    byStatus,
    byKind,
    bySource,
    recent: pending.slice(-12),
    file: { path: file, exists: fs.existsSync(file) }
  };
}

/** 今天（本地日）已进池的条数——每日封顶用这个数。 */
export function pooledToday(dir = '', now = Date.now()) {
  const day = new Date(now).toDateString();
  return readCandidates(dir).rows.filter((r) => new Date(Number(r.at) || 0).toDateString() === day).length;
}
