/**
 * 压缩事件流：把「截止某时刻之前的旧事件」折叠成快照 state/base.json，
 * 再从 longterm.jsonl 里删掉它们，只保留新事件。
 *
 * 为什么对上层透明：readEvents() 会把快照还原成 fact 事件前置，
 * materialize / openIndex / CLI / 工作台都不用改读法。
 * 默认 dry-run，--apply 才写；写前备份 longterm.jsonl 与 base.json。
 */
import fs from 'node:fs';
import * as lt from './longterm.mjs';

export const KEEP_MS = 90 * 24 * 3600 * 1000;

const atOf = (ev) => {
  const t = Number(ev.at) || Date.parse(ev.at) || Number(ev.lastAt) || Date.parse(ev.lastAt) || 0;
  return Number.isFinite(t) ? t : 0;
};

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

export function planCompact(dir = '', { before, now = Date.now() } = {}) {
  const cutoff = Number(before) || (now - KEEP_MS);
  const p = lt.paths(dir);
  const { rows, bad } = lt.readJsonl(p.longterm);
  const keep = [];
  const drop = [];
  let oldest = 0;
  let newest = 0;
  for (const ev of rows) {
    if (!ev || typeof ev !== 'object' || !ev.id) continue;
    const at = atOf(ev);
    if (at) { oldest = oldest ? Math.min(oldest, at) : at; newest = Math.max(newest, at); }
    if (at && at <= cutoff) drop.push(ev); else keep.push(ev);
  }
  // 快照必须是「全量事件」折叠出的态（含旧快照），否则删旧事件就丢状态。
  const allEvents = lt.readEvents(dir).rows;
  const facts = lt.materialize(allEvents, lt.readInvalidated(dir));
  const payload = { at: cutoff, savedAt: now, version: 1, facts };
  const keepBytes = keep.length ? Buffer.byteLength(keep.map((e) => JSON.stringify(e)).join('\n') + '\n') : 0;
  return {
    cutoff, keep, drop, facts, payload, bad, oldest, newest,
    bytesBefore: sizeOf(p.longterm),
    bytesAfter: keepBytes,
    baseBytes: Buffer.byteLength(JSON.stringify(payload))
  };
}

export function applyCompact(dir = '', opts = {}) {
  const plan = planCompact(dir, opts);
  if (opts.dryRun) return { ...plan, applied: false };
  if (!plan.drop.length) return { ...plan, applied: false, reason: 'nothing-to-compact' };
  const p = lt.paths(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(p.state, { recursive: true });
  if (fs.existsSync(p.longterm)) fs.copyFileSync(p.longterm, p.longterm + '.bak-' + stamp);
  if (fs.existsSync(p.base)) fs.copyFileSync(p.base, p.base + '.bak-' + stamp);

  const tmpBase = p.base + '.tmp';
  fs.writeFileSync(tmpBase, JSON.stringify(plan.payload));
  fs.renameSync(tmpBase, p.base);

  const tmpLog = p.longterm + '.tmp';
  fs.writeFileSync(tmpLog, plan.keep.length ? plan.keep.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
  fs.renameSync(tmpLog, p.longterm);

  lt.dropIndex(dir);
  const afterFacts = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir)).length;
  return { ...plan, applied: true, stamp, after: { bytes: sizeOf(p.longterm), facts: afterFacts } };
}
