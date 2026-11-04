#!/usr/bin/env node
// 情境段构建（3.0 / S1）：把窗口账本切段成 episodes/YYYY-MM.jsonl。
// 只做结构切段，标题/场景/主题/想法由日终模型补写；本脚本默认只预览。
//
// 用法：
//   node scripts/build-episodes.mjs                  # 预览最近 7 天
//   node scripts/build-episodes.mjs --days 30
//   node scripts/build-episodes.mjs --day 2026-11-02
//   node scripts/build-episodes.mjs --write          # 真正落盘（按 id 幂等）
//   node scripts/build-episodes.mjs --json
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_DIR } from '../src/config.mjs';
import { buildEpisodesForDay, readEpisodes, upsertEpisodes } from '../src/episode.mjs';

function arg(name, dft) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dft;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dir = String(arg('dir', process.env.QQ_MEMORY_DIR || DEFAULT_DIR));
const days = Math.max(1, Number(arg('days', 7)) || 7);
const dayArg = arg('day', '');
const asJson = process.argv.includes('--json');
const write = process.argv.includes('--write');

function localDay(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const daysList = [];
if (typeof dayArg === 'string' && dayArg) daysList.push(dayArg);
else {
  for (let i = 0; i < days; i += 1) daysList.push(localDay(Date.now() - i * 86400000));
}

const collected = [];
const report = [];
for (const day of daysList.reverse()) {
  const { episodes, turns } = buildEpisodesForDay(dir, { day });
  collected.push(...episodes);
  report.push({ day, turns, episodes: episodes.length });
}

let written = 0;
if (write && collected.length) written = upsertEpisodes(dir, collected);

if (asJson) {
  console.log(JSON.stringify({ dir, write, written, report, episodes: collected }, null, 2));
} else {
  console.log(`数据目录：${dir}`);
  console.log(`模式：${write ? '写入（按 id 幂等）' : '预览（加 --write 才落盘）'}`);
  for (const r of report) console.log(`  ${r.day}  轮次 ${r.turns}  情境段 ${r.episodes}`);
  console.log(`合计情境段 ${collected.length}${write ? `，文件内共 ${written} 条 ${''}` : ''}`);
  for (const ep of collected.slice(-5)) {
    console.log(`  · ${ep.id} ${ep.atFrom} → ${ep.atTo} 轮 ${ep.turnFrom}-${ep.turnTo}「${ep.title}」想法 ${ep.thoughts.length} 感受 ${ep.feelings.length}`);
  }
  if (!collected.length) console.log('  （窗口账本里还没有可切段的数据）');
  const files = path.join(dir, 'episodes');
  try {
    const list = fs.readdirSync(files).filter((f) => f.endsWith('.jsonl'));
    if (list.length) console.log(`已有文件：${list.join(', ')}，共 ${readEpisodes(dir).length} 条`);
  } catch {
    // 还没有 episodes 目录
  }
}
