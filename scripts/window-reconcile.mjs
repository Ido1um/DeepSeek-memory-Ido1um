#!/usr/bin/env node
// 窗口账本对账（3.0 / S0）：窗口原文 vs 聊天记录备份。
// 只读，不改任何文件；结论写 logs/window-reconcile.log，也打到 stdout。
//
// 用法：
//   node scripts/window-reconcile.mjs                # 最近 7 天，全部会话
//   node scripts/window-reconcile.mjs --days 30
//   node scripts/window-reconcile.mjs --json         # 机器可读
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_DIR } from '../src/config.mjs';
import { readTurns, reconcileSession } from '../src/window.mjs';

function arg(name, dft) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dft;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dir = String(arg('dir', process.env.QQ_MEMORY_DIR || DEFAULT_DIR));
const days = Math.max(1, Number(arg('days', 7)) || 7);
const asJson = process.argv.includes('--json');
const sinceMs = Date.now() - days * 86400000;

function readRawUserTexts(key, since) {
  const out = [];
  const hot = path.join(dir, 'raw', 'hot');
  let dayDirs = [];
  try {
    dayDirs = fs.readdirSync(hot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    return out;
  }
  const digits = String(key || '').split(':')[1] || '';
  for (const day of dayDirs) {
    const dayStart = Date.parse(`${day}T00:00:00+08:00`);
    if (Number.isFinite(dayStart) && dayStart + 86400000 < since) continue;
    const file = path.join(hot, day, `private_${digits}.jsonl`);
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.role !== 'user') continue;
        if (row.key && key && row.key !== key) continue;
        const ts = Date.parse(row.ts);
        if (Number.isFinite(ts) && ts < since) continue;
        const text = String(row.text || '').trim();
        if (text) out.push(text);
      } catch {
        // 半行（备份/断电）跳过
      }
    }
  }
  return out;
}

function listSessions() {
  const root = path.join(dir, 'window');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'blocks')
      .map((d) => d.name);
  } catch {
    return [];
  }
}

const reports = [];
for (const sessionId of listSessions()) {
  const rows = readTurns(dir, sessionId).filter((r) => {
    const at = Date.parse(r.at);
    return !Number.isFinite(at) || at >= sinceMs;
  });
  if (!rows.length) continue;
  let key = '';
  for (let i = rows.length - 1; i >= 0 && !key; i--) key = String(rows[i].key || '');
  const rawTexts = key ? readRawUserTexts(key, sinceMs) : [];
  reports.push(reconcileSession({ dir, sessionId, sinceMs, rawTexts }));
}

const line = (r) =>
  `${r.sessionId}: 窗口 ${r.turns} 轮（不完整 ${r.incomplete}）· 她说出去 ${r.spoken} 条 · 感受 ${r.feels} 条 · 聊天记录 ${r.rawUsers} 条 · 不在聊天记录里的原话 ${r.notInRawCount} 条`;

const summary = {
  at: new Date().toISOString(),
  dir,
  days,
  sessions: reports.length,
  totals: reports.reduce(
    (acc, r) => ({
      turns: acc.turns + r.turns,
      incomplete: acc.incomplete + r.incomplete,
      spoken: acc.spoken + r.spoken,
      feels: acc.feels + r.feels,
      rawUsers: acc.rawUsers + r.rawUsers,
      notInRaw: acc.notInRaw + r.notInRawCount
    }),
    { turns: 0, incomplete: 0, spoken: 0, feels: 0, rawUsers: 0, notInRaw: 0 }
  ),
  reports
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  process.stdout.write(`窗口账本对账（最近 ${days} 天，${dir}）\n`);
  if (!reports.length) process.stdout.write('  （还没有窗口记录）\n');
  for (const r of reports) {
    process.stdout.write(`  ${line(r)}\n`);
    for (const m of r.notInRaw.slice(0, 3)) {
      process.stdout.write(`    · 第 ${m.turn} 轮（${m.chars} 字）：${m.head}…\n`);
    }
  }
  const t = summary.totals;
  process.stdout.write(
    `合计：窗口 ${t.turns} 轮 · 不完整 ${t.incomplete} · 说出 ${t.spoken} 条 · 感受 ${t.feels} 条 · 聊天记录 ${t.rawUsers} 条 · 对不上 ${t.notInRaw} 条\n`
  );
}

try {
  const logFile = path.join(dir, 'logs', 'window-reconcile.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(
    logFile,
    `${JSON.stringify({ at: summary.at, sessions: summary.sessions, totals: summary.totals })}\n`,
    'utf8'
  );
} catch {
  // 日志写不了不影响对账结果
}
