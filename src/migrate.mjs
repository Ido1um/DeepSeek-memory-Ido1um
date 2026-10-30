// 数据布局迁移：把旧布局（根下 hot/、archive/）搬到新布局（raw/hot、raw/archive）。
//
// 幂等：可以反复跑；旧目录不存在或已空时什么也不做。不删除任何日志内容，
// 只做「移动」；目标同名文件已存在时比较大小，保留较大者（避免半截文件覆盖完整文件）。
//
// 用法：node src/migrate.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIR, memorySection } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveRoot() {
  const envDir = String(process.env.QQ_MEMORY_DIR || '').trim();
  return envDir || String(memorySection().dir || DEFAULT_DIR).trim() || DEFAULT_DIR;
}

function moveFile(src, dst, stats) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) {
    const a = fs.statSync(src).size;
    const b = fs.statSync(dst).size;
    if (a <= b) {
      fs.unlinkSync(src);
      stats.skipped += 1;
      return;
    }
    fs.rmSync(dst, { force: true });
  }
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
  stats.moved += 1;
}

function moveDays(fromBase, toBase, stats) {
  let days = [];
  try { days = fs.readdirSync(fromBase, { withFileTypes: true }); } catch { return; }
  for (const ent of days) {
    if (!ent.isDirectory()) continue;
    const srcDir = path.join(fromBase, ent.name);
    let files = [];
    try { files = fs.readdirSync(srcDir); } catch { continue; }
    for (const file of files) {
      moveFile(path.join(srcDir, file), path.join(toBase, ent.name, file), stats);
    }
    try { if (fs.readdirSync(srcDir).length === 0) fs.rmdirSync(srcDir); } catch {}
  }
  try { if (fs.readdirSync(fromBase).length === 0) fs.rmdirSync(fromBase); } catch {}
}

export function migrateLayout({ root = resolveRoot(), dryRun = false } = {}) {
  const stats = { moved: 0, skipped: 0, dryRun };
  const oldHot = path.join(root, 'hot');
  const oldArchive = path.join(root, 'archive');
  const newHot = path.join(root, 'raw', 'hot');
  const newArchive = path.join(root, 'raw', 'archive');
  if (dryRun) {
    // dry-run 只统计，不动文件。
    const count = (base) => {
      let n = 0;
      try {
        for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          try { n += fs.readdirSync(path.join(base, ent.name)).length; } catch {}
        }
      } catch {}
      return n;
    };
    stats.wouldMove = count(oldHot) + count(oldArchive);
    return stats;
  }
  fs.mkdirSync(newHot, { recursive: true });
  fs.mkdirSync(newArchive, { recursive: true });
  moveDays(oldHot, newHot, stats);
  moveDays(oldArchive, newArchive, stats);
  return stats;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const dryRun = process.argv.includes('--dry-run');
  const root = resolveRoot();
  const stats = migrateLayout({ root, dryRun });
  console.log(JSON.stringify({ root, ...stats }, null, 2));
}
