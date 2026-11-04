// 回放真实消息，看规则抽取器到底能命中多少（抽取B 扩面前后的对比工具，只读）。
// 用法：node scripts/extract-recall.mjs [--days 7] [--owner 10001] [--json] [--examples 8]
//
// 统计口径：
//   候选率 = 至少产出一条候选的消息数 / 有文字的用户消息数
//   去重后 = 按 sig 去重后的候选条数（同一条事实反复说只算一条）
//   写入门 = 候选里真正会落库的条数 / 被挡掉的条数与原因（--filter 打印明细）
// 只读 raw/hot 日志，不写任何事件、不改配置。
import fs from 'node:fs';
import path from 'node:path';

import { dataDir } from '../src/store.mjs';
import { classify } from '../src/scoring-runner.mjs';
import { writeGate, GATE_REASONS } from '../src/gate.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const days = Math.max(1, Number(opt('days', 7)) || 7);
const owner = String(opt('owner', '10001'));
const asJson = args.includes('--json');
const withFilter = args.includes('--filter');
const examples = Number(opt('examples', 8)) || 0;

const dir = dataDir();
const hotDir = path.join(dir, 'raw', 'hot');
if (!fs.existsSync(hotDir)) {
  console.error(`没有找到日志目录：${hotDir}`);
  process.exit(1);
}

const dayDirs = fs
  .readdirSync(hotDir)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .sort()
  .slice(-days);

const rows = [];
for (const day of dayDirs) {
  const file = path.join(hotDir, day, `private_${owner}.jsonl`);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // 半天写坏的行跳过
    }
    if (row.role !== 'user' || !row.text) continue;
    rows.push({ day, text: String(row.text), ts: row.ts || '' });
  }
}

const byPattern = new Map();
const bySig = new Map();
const samples = [];
const byReason = new Map();
const blockedSamples = [];
let withCand = 0;
let candTotal = 0;
let passTotal = 0;
let blockedTotal = 0;

for (const r of rows) {
  const { candidates } = classify(r.text);
  if (!candidates.length) continue;
  withCand += 1;
  candTotal += candidates.length;
  for (const c of candidates) {
    const key = c.pattern || '?';
    byPattern.set(key, (byPattern.get(key) || 0) + 1);
    bySig.set(c.sig, { sig: c.sig, pattern: key, value: c.value, topic: c.topic });
    // 写入门视角：候选抽出来之后，真正会落库的还剩几条、被什么理由挡掉
    const g = writeGate(r.text, c, { cfg: { writeGate: true } });
    if (g.ok) passTotal += 1;
    else {
      blockedTotal += 1;
      byReason.set(g.reason, (byReason.get(g.reason) || 0) + 1);
      if (blockedSamples.length < examples) {
        blockedSamples.push({ text: r.text.slice(0, 50), value: String(c.value || '').slice(0, 20), reason: g.reason });
      }
    }
  }
  if (samples.length < examples) {
    samples.push({
      text: r.text.slice(0, 60),
      got: candidates.map((c) => `${c.pattern}:${String(c.value || '').slice(0, 16)}`)
    });
  }
}

const rate = rows.length ? withCand / rows.length : 0;
const gateStats = {
  pass: passTotal,
  blocked: blockedTotal,
  byReason: Object.fromEntries([...byReason.entries()].sort((a, b) => b[1] - a[1])),
  blockedSamples
};
const summary = {
  dataDir: dir,
  days: dayDirs.length,
  window: dayDirs.length ? `${dayDirs[0]} ~ ${dayDirs[dayDirs.length - 1]}` : '',
  messages: rows.length,
  withCandidate: withCand,
  rate: `${(rate * 100).toFixed(1)}%`,
  candidates: candTotal,
  distinctSigs: bySig.size,
  byPattern: Object.fromEntries([...byPattern.entries()].sort((a, b) => b[1] - a[1])),
  writeGate: gateStats
};

if (asJson) {
  console.log(JSON.stringify({ summary, samples }, null, 2));
} else {
  console.log(`数据目录：${summary.dataDir}`);
  console.log(`窗口：${summary.window}（${summary.days} 天）`);
  console.log(`用户消息：${summary.messages} 条`);
  console.log(`命中候选：${summary.withCandidate} 条（${summary.rate}），共 ${summary.candidates} 个候选，去重后 ${summary.distinctSigs} 条`);
  console.log(`按类型：${Object.entries(summary.byPattern).map(([k, v]) => `${k} ${v}`).join(' · ') || '（无）'}`);
  console.log(
    `写入门：放行 ${gateStats.pass} 条 / 挡掉 ${gateStats.blocked} 条` +
      (gateStats.blocked ? `（${Object.entries(gateStats.byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}）` : '')
  );
  if (withFilter && blockedSamples.length) {
    console.log('\n被挡样例：');
    for (const b of blockedSamples) {
      console.log(`- [${b.reason}] ${b.text}  ->  ${b.value}  （${GATE_REASONS[b.reason] || ''}）`);
    }
  }
  if (samples.length) {
    console.log('\n样例：');
    for (const s of samples) console.log(`- ${s.text}  ->  ${s.got.join(' / ')}`);
  }
}
