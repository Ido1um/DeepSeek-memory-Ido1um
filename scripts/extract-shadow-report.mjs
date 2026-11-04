#!/usr/bin/env node
// 路线 A 影子报告：读 state/extract-shadow.jsonl，按天汇总 + 抽样候选（只读，不改任何数据）。
//
// 用法：
//   node scripts/extract-shadow-report.mjs                 # 最近 7 天，抽 30 条
//   node scripts/extract-shadow-report.mjs --days 3 --sample 20
//   node scripts/extract-shadow-report.mjs --json          # 机器可读
//
// 人工验收口径（方案 §6）：抽样 30 条精确率 ≥90%、重复率 <10%、卡增长 <200 字/天。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readShadowLines, summarizeShadow } from '../src/extract-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const days = Math.max(1, Number(arg('days', 7)) || 7);
const sample = Math.max(1, Number(arg('sample', 30)) || 30);
const dir = String(arg('dir', '') || '');
const asJson = has('json');

const summary = summarizeShadow(dir, { days, recent: 200 });
const rows = readShadowLines(dir).filter((r) => r.t === 'cand');
const passes = rows.filter((r) => r.verdict === 'pass');
const drops = rows.filter((r) => r.verdict === 'drop');

// 卡增长：按「· [tier] value」的渲染长度估算（与注入检索段同一形状）。
function tierOf(candidate) {
  if (!candidate) return 'general';
  return candidate.kind === 'fact' ? 'hard' : 'general';
}
const cardGrowth = passes.reduce((sum, r) => {
  const value = String(r.candidate?.value || '');
  return sum + (value ? value.length + 8 : 0);
}, 0);

const dupReasons = new Set(['dup', 'dup-batch']);
const dupCount = drops.filter((r) => dupReasons.has(String(r.reason || ''))).length;
const passCount = Math.max(1, passes.length);

const report = {
  dir: dir || '(默认数据目录)',
  days,
  file: summary.file,
  daily: summary.daily,
  totals: summary.totals,
  passRate: passes.length / Math.max(1, passes.length + drops.length),
  dupRate: dupCount / passCount,
  cardGrowthPerDay: cardGrowth / days,
  sample: passes.slice(-sample).map((r) => ({
    day: r.day,
    topic: r.candidate?.topic || '',
    value: r.candidate?.value || '',
    quote: r.candidate?.quote || '',
    confidence: r.candidate?.confidence ?? null,
    srcMsgIndex: r.srcMsgIndex || 0
  })),
  recentDrops: drops.slice(-12).map((r) => ({ day: r.day, reason: r.reason, value: r.candidate?.value || '' }))
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`路线 A 影子报告 · 最近 ${days} 天`);
console.log(`文件：${report.file.path}（${report.file.size} B）`);
console.log('');
if (!report.daily.length) {
  console.log('还没有影子记录（把 memory.extract.enabled 打开、等一次日终后再来看）。');
  process.exit(0);
}
console.log(`${pad('日期', 12)}${pad('批次', 6)}${pad('候选', 6)}${pad('通过', 6)}${pad('丢', 4)}耗时`);
for (const d of report.daily) {
  console.log(`${pad(d.day, 12)}${pad(d.batches, 6)}${pad(d.candidates, 6)}${pad(d.passed, 6)}${pad(d.dropped, 4)}${Math.round(d.modelMs / 1000)}s`);
}
const t = report.totals;
console.log('');
console.log(`合计：${t.batches} 批 / ${t.candidates} 候选 / 通过 ${t.passed} / 丢弃 ${t.dropped}`);
console.log(`通过率 ${(report.passRate * 100).toFixed(1)}% · 重复率 ${(report.dupRate * 100).toFixed(1)}% · 卡增长约 ${report.cardGrowthPerDay.toFixed(0)} 字/天`);
console.log(`丢弃原因：${Object.entries(t.byReason || {}).map(([k, v]) => `${k} ${v}`).join(' / ') || '无'}`);
if (report.sample.length) {
  console.log('');
  console.log(`抽样（最近 ${report.sample.length} 条通过）：`);
  for (const s of report.sample) {
    console.log(`- [${s.day}] ${s.topic} = ${s.value}（信心 ${s.confidence}）`);
    console.log(`  原文：${s.quote}`);
  }
}
if (report.recentDrops.length) {
  console.log('');
  console.log('最近被挡：');
  for (const d of report.recentDrops) console.log(`- ${d.reason}：${d.value}`);
}
console.log('');
console.log(`提示：人工核对上面抽样后，按方案 §6 的口径判断（≥90% 精确率、<10% 重复、<200 字/天）。`);
console.log(`包根：${pkgRoot}`);
