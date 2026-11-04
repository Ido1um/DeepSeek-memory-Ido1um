// 给 episode 补模型摘要（标题/场景/主题/想法）。
//
//   node scripts/summarize-episodes.mjs                # 预览：列出待摘要的段
//   node scripts/summarize-episodes.mjs --write        # 真写（覆盖 episodes/*.jsonl 同 id 行）
//   node scripts/summarize-episodes.mjs --days 2 --limit 5 [--dir <数据目录>] [--json]
//
// 只读窗口账本、只写 episodes/，不碰长期记忆、事实卡、注入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEpisodes } from '../src/episode.mjs';
import { summarizeEpisode } from '../src/episode-ai.mjs';
import { upsertEpisodes } from '../src/episode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = process.env.QQ_MEMORY_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.deepseek-memory', 'data');

function arg(name, fallback = '') {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const dir = arg('dir', DEFAULT_DIR);
const write = has('write');
const json = has('json');
const days = Number(arg('days', '0')) || 0;
const limit = Math.min(60, Math.max(1, Number(arg('limit', '24')) || 24));

if (!fs.existsSync(dir)) {
  console.error(`数据目录不存在：${dir}`);
  process.exit(2);
}

const since = days ? Date.now() - days * 86400000 : 0;
let all = readEpisodes(dir);
if (since) all = all.filter((e) => Date.parse(String(e.atFrom)) >= since);
const pending = all.filter((e) => !e.summarized).slice(0, limit);

if (!pending.length) {
  if (json) console.log(JSON.stringify({ ok: true, pending: 0, dir }, null, 2));
  else console.log(`待摘要 episode：0 段（共 ${all.length} 段，已摘要 ${all.filter((e) => e.summarized).length} 段）`);
  process.exit(0);
}

if (!json) {
  console.log(`数据目录：${dir}`);
  console.log(`待摘要：${pending.length} 段（共 ${all.length} 段）${write ? '' : '  ← 预览模式，加 --write 才会写盘'}`);
}

const done = [];
const failed = [];
for (const ep of pending) {
  const res = await summarizeEpisode(dir, ep, { log: (m) => console.error(m) });
  if (!res.ok) {
    failed.push({ id: ep.id, error: res.error });
    if (!json) console.log(`  · ${ep.turnFrom}–${ep.turnTo}  ${ep.day}  ✗ ${res.error}`);
    continue;
  }
  done.push(res.episode);
  if (!json) {
    console.log(`  · ${ep.turnFrom}–${ep.turnTo}  ${ep.day}  ${res.episode.title}`);
    if (res.episode.scene) console.log(`      场景：${res.episode.scene}`);
    if (res.episode.topics?.length) console.log(`      主题：${res.episode.topics.join('、')}`);
    if (res.episode.thoughts?.length) console.log(`      想法：${res.episode.thoughts.map((t) => t.text).join(' / ')}`);
  }
}

if (write && done.length) {
  const written = upsertEpisodes(dir, done);
  if (json) console.log(JSON.stringify({ ok: true, summarized: done.length, failed, episodes: written }, null, 2));
  else console.log(`\n已写入：${done.length} 段（episodes/ 共 ${written} 行）${failed.length ? `，失败 ${failed.length} 段` : ''}`);
} else if (json) {
  console.log(JSON.stringify({ ok: true, preview: true, summarized: done.length, failed }, null, 2));
} else {
  console.log(`\n预览完成：可摘要 ${done.length} 段${failed.length ? `，失败 ${failed.length} 段` : ''}（未写盘）`);
}
