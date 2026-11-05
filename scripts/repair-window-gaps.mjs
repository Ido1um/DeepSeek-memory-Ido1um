// 记忆 3.1 · P0b：窗口缺口回填
//
// 背景：2026-11-05 发现窗口账本漏了 11-04 的两整段（06:33 的 408 纠正、15:09 的课表），
// 旧对账只查「窗口里的消息在 raw 里有没有」，查不出「raw 有、窗口没有」。
// 这个脚本把 raw 里的缺口补成账本行（fidelity:'reconciled'、source:'raw-gap'）：
//   只补用户原话 + 她发出去的话；不伪造内部想法；不写 window（当时的注入块无从考证）。
//
// 用法：
//   node scripts/repair-window-gaps.mjs                 # 预览最近 2 天
//   node scripts/repair-window-gaps.mjs --days 5 --json
//   node scripts/repair-window-gaps.mjs --write         # 写盘（幂等）
// 开关：memory.window.gapRepair=false 可整体关掉（日终同样遵守）。
import fs from 'node:fs';
import path from 'node:path';
import { repairGapsForKey } from '../src/gapfill.mjs';
import { dataDir } from '../src/store.mjs';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const days = Math.max(1, Number(arg('days', 2)) || 2);
const write = process.argv.includes('--write');
const asJson = process.argv.includes('--json');
const dir = String(arg('dir', '') || dataDir());

function readSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'memory.json'), 'utf8'));
    return Object.entries(raw?.sessions || {})
      .map(([key, v]) => ({ key, sessionId: String(v && typeof v === 'object' ? v.sessionId || '' : v || '') }))
      .filter((x) => x.sessionId);
  } catch {
    return [];
  }
}

const sessions = readSessions();
const keys = [...new Set(sessions.map((x) => x.key))];
const out = [];
for (const key of keys) {
  const fallback = sessions.find((x) => x.key === key)?.sessionId || '';
  const r = repairGapsForKey({ dir, key, days, write, fallbackSessionId: fallback });
  out.push({
    key,
    fallbackSessionId: fallback.slice(0, 12),
    rawMessages: r.rawMessages,
    gapTurns: r.gapTurns,
    gapMessages: r.gapMessages,
    added: r.added,
    skipped: r.skipped,
    sessions: r.sessions,
    samples: r.samples.map((t) => ({ at: new Date(t.at).toISOString(), chars: t.chars, head: t.head }))
  });
}

if (asJson) {
  console.log(JSON.stringify({ dir, days, write, sessions: out }, null, 2));
} else {
  console.log(`数据目录：${dir}`);
  console.log(`范围：最近 ${days} 天${write ? '（写入）' : '（预览，不改数据）'}`);
  const totalGap = out.reduce((n, x) => n + x.gapTurns, 0);
  const totalAdded = out.reduce((n, x) => n + x.added, 0);
  for (const s of out) {
    console.log(`- ${s.key} ${s.sessionId} raw用户消息=${s.rawMessages} 缺口轮=${s.gapTurns} 缺口消息=${s.gapMessages} 写入=${s.added} 跳过=${s.skipped}`);
    for (const sample of s.samples) console.log(`    · ${sample.at} ${sample.head}`);
  }
  if (!out.length) console.log('（没有映射中的会话）');
  console.log(`合计：缺口 ${totalGap} 轮，写入 ${totalAdded} 轮`);
  if (!write && totalGap > 0) console.log('加 --write 才会真正补进窗口账本（写前已有备份/幂等，可重复跑）。');
}
