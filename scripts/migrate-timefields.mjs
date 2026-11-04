// 迁移：给现有事实补时间锚（saidAt）、绝对日期（dates）、有效期（validUntil）。
//
// 关键约束（2026-11-04 教训）：saidAt 必须是「那句话被说出的那一轮」，不是写入时间。
// 回填写入的条目 createdAt 是 11-03，但原话可能是 10-29 说的；所以先按 source.episodeId
// 找到情境段，再在窗口账本里按引文匹配轮次；匹配不到标 timeUnknown，绝不拿 createdAt 猜。
//
// 用法：
//   node scripts/migrate-timefields.mjs                 # 预览（默认，不写盘）
//   node scripts/migrate-timefields.mjs --write         # 写盘（先备份）
//   node scripts/migrate-timefields.mjs --dir <数据目录> --json

import fs from 'node:fs';
import path from 'node:path';

import * as lt from '../src/longterm.mjs';
import { readTurns } from '../src/window.mjs';
import { readEpisodes } from '../src/episode.mjs';
import { parseTime, isExpired } from '../src/timeparse.mjs';
import { turnAtFor } from '../src/extract-episode.mjs';

const DEFAULT_DIR = process.env.QQ_MEMORY_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.deepseek-memory', 'data');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const arg = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DIR = arg('dir', process.env.QQ_MEMORY_DIR || DEFAULT_DIR);
const WRITE = flag('write');
const JSON_OUT = flag('json');

function loadEpisodes(dir) {
  const map = new Map();
  for (const ep of readEpisodes(dir)) map.set(ep.id, ep);
  return map;
}

function turnAtFromSource(fact, episodes, cache) {
  const epId = fact?.source?.episodeId || '';
  if (epId && episodes.has(epId)) {
    const ep = episodes.get(epId);
    const sid = String(ep.sessionId || '');
    if (!cache.has(sid)) {
      try { cache.set(sid, readTurns(DIR, sid, { limit: 500 })); } catch { cache.set(sid, []); }
    }
    const from = Number(ep.turnFrom) || 0;
    const to = Number(ep.turnTo) || 0;
    const rows = cache.get(sid).filter((r) => {
      const n = Number(r?.turn) || 0;
      return (!from || n >= from) && (!to || n <= to);
    });
    const at = turnAtFor(fact.quote || fact.text || fact.value, rows, ep);
    if (at) return { at, from: 'episode-turn' };
    const atTo = Date.parse(String(ep.atTo || '')) || Date.parse(String(ep.atFrom || '')) || 0;
    if (atTo) return { at: atTo, from: 'episode-atTo' };
  }
  // 实时规则抽取：createdAt 就是消息时间（不是回填），可以用
  if (fact && !/^h-ep-/.test(String(fact.id || '')) && Number(fact.createdAt)) {
    return { at: Number(fact.createdAt), from: 'createdAt-live' };
  }
  return { at: 0, from: 'unknown' };
}

function backup(dir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(dir, 'backup', `timefields-${stamp}`);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ['state/longterm.jsonl', 'profile.md', 'state/memory.json']) {
    const src = path.join(dir, name);
    if (fs.existsSync(src)) {
      const out = path.join(dst, name.replace(/[\\/]/g, '_'));
      fs.copyFileSync(src, out);
    }
  }
  return dst;
}

function main() {
  const episodes = loadEpisodes(DIR);
  const rows = lt.readEvents(DIR).rows;
  const facts = lt.materialize(rows, lt.readInvalidated(DIR));
  const cache = new Map();
  const plan = [];
  const skipped = [];
  for (const f of facts) {
    if (f.status === 'invalidated' || f.status === 'merged') continue;
    const src = turnAtFromSource(f, episodes, cache);
    if (!src.at) { skipped.push({ id: f.id, reason: 'timeUnknown' }); plan.push({ f, saidAt: 0, unknown: true }); continue; }
    const tp = parseTime(`${f.quote || ''} ${f.value || ''}`, { refMs: src.at, slot: f.slot || '' });
    plan.push({ f, saidAt: src.at, from: src.from, tp });
  }

  const withDates = plan.filter((p) => p.tp && p.tp.dates.length);
  const withTtl = plan.filter((p) => p.tp && p.tp.validUntil);
  const expired = plan.filter((p) => p.tp && isExpired(p.tp.validUntil));

  const report = {
    dir: DIR, total: plan.length, needWrite: plan.length,
    fromEpisodeTurn: plan.filter((p) => p.from === 'episode-turn').length,
    fromEpisodeAtTo: plan.filter((p) => p.from === 'episode-atTo').length,
    fromCreatedAt: plan.filter((p) => p.from === 'createdAt-live').length,
    unknown: skipped.length,
    withDates: withDates.length, withValidUntil: withTtl.length, expired: expired.length,
    samples: plan.slice(0, 8).map((p) => ({
      id: p.f.id, value: String(p.f.value).slice(0, 40), saidAt: p.saidAt ? new Date(p.saidAt + 8 * 3600e3).toISOString().slice(0, 10) : 'unknown',
      from: p.from, dates: p.tp?.dates || [], validUntil: p.tp?.validUntil || 0, phrase: p.tp?.phrase || ''
    })),
    skipped: skipped.slice(0, 8)
  };

  if (!WRITE) {
    if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`[预览] ${report.total} 条事实；轮次锚 ${report.fromEpisodeTurn}，atTo 兜底 ${report.fromEpisodeAtTo}，实时 createdAt ${report.fromCreatedAt}，未知 ${report.unknown}`);
      console.log(`日期 ${report.withDates} 条；有效期 ${report.withValidUntil} 条；已过期 ${report.expired} 条`);
      for (const s of report.samples) console.log(` · ${s.id} ${s.value} | ${s.saidAt} (${s.from}) | ${s.phrase || '-'} | ttl=${s.validUntil ? new Date(s.validUntil + 8 * 3600e3).toISOString().slice(0, 10) : '-'}`);
      if (report.unknown) console.log(` ! 无法定时的 ${report.unknown} 条，会标 timeUnknown（不拿写入时间猜）`);
      console.log('（预览不写盘；要写入加 --write）');
    }
    return;
  }

  const dst = backup(DIR);
  let written = 0;
  for (const p of plan) {
    lt.appendEvent({
      ev: 'update',
      id: p.f.id,
      at: Date.now(),
      saidAt: p.saidAt || 0,
      dates: p.tp?.dates || [],
      validUntil: p.tp?.validUntil || 0,
      timePhrase: p.tp?.phrase || '',
      timeConfidence: p.tp?.confidence || 0,
      timeUnknown: !p.saidAt,
      note: 'migrate-timefields'
    }, DIR);
    written += 1;
  }
  console.log(`[写入] ${written} 条事实补时间字段；备份 ${dst}`);
  if (JSON_OUT) console.log(JSON.stringify({ ...report, written, backup: dst }, null, 2));
}

main();
