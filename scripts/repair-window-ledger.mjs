#!/usr/bin/env node
// 窗口账本修复（3.0 / S1）：重排轮次编号 + 修正「把提示词当用户原话」的旧行。
//
// 背景：
//   1) 回填把旧轮次追加到已有 live 行之后，turn 编号不再按时间顺序；
//   2) 早期的 ownerTextOf 兜底过宽，会把整段 wake prompt 记成 userRaw。
//
// 用法：
//   node scripts/repair-window-ledger.mjs            # 预览
//   node scripts/repair-window-ledger.mjs --write     # 落盘（写前留 .bak-repair-<ts>）
//   node scripts/repair-window-ledger.mjs --session 9ca88 --write
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_DIR } from '../src/config.mjs';
import { ownerTextOf, readTurns, readWindowText, sessionDir } from '../src/window.mjs';

function arg(name, dft) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dft;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dir = String(arg('dir', process.env.QQ_MEMORY_DIR || DEFAULT_DIR));
const only = String(arg('session', '') || '');
const write = process.argv.includes('--write');

function suspicious(text = '') {
  const t = String(text || '').trimStart();
  return (
    t.startsWith('【当前角色】') ||
    t.startsWith('Current runtime context') ||
    t.includes('完整角色卡请调用 qq_get_prompt')
  );
}

const winRoot = path.join(dir, 'window');
let sessions = [];
try {
  sessions = fs.readdirSync(winRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    .map((d) => d.name)
    .filter((n) => !only || n.includes(only));
} catch {
  console.log(`没有 window 目录：${winRoot}`);
  process.exit(0);
}

let totalFixed = 0;
let totalRenumbered = 0;

for (const sid of sessions) {
  const rows = readTurns(dir, sid);
  if (!rows.length) continue;
  let fixed = 0;
  let resynced = 0;
  for (const row of rows) {
    const before = String(row?.userRaw?.text || '');
    if (suspicious(before)) {
      let wtext = '';
      try {
        wtext = readWindowText(dir, row);
      } catch {
        wtext = '';
      }
      const owner = wtext ? ownerTextOf(wtext) : '';
      row.userRaw = { ...(row.userRaw || {}), text: owner, chars: owner.length, synthetic: !owner };
      fixed += 1;
      continue;
    }
    // synthetic 口径变过（旧代码把所有 wake prompt 都标成合成）：按「有没有用户原话」重算。
    const want = !String(row?.userRaw?.text || '').trim();
    if (row?.userRaw && row.userRaw.synthetic !== want) {
      row.userRaw.synthetic = want;
      resynced += 1;
    }
  }
  const ordered = [...rows].sort((a, b) => String(a.at).localeCompare(String(b.at)) || (Number(a.srcTurn) || 0) - (Number(b.srcTurn) || 0));
  let renumbered = 0;
  ordered.forEach((row, i) => {
    const want = i + 1;
    if (Number(row.turn) !== want) {
      row.turn = want;
      renumbered += 1;
    }
  });
  console.log(`${sid}  行 ${rows.length}  修正原话 ${fixed}  重算合成标记 ${resynced}  重排 ${renumbered}`);
  totalFixed += fixed;
  totalRenumbered += renumbered;
  if (!write) continue;
  const file = path.join(sessionDir(dir, sid), 'turns.jsonl');
  fs.copyFileSync(file, `${file}.bak-repair-${Date.now()}`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, ordered.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
  const metaPath = path.join(sessionDir(dir, sid), 'meta.json');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = {};
  }
  meta.nextTurn = ordered.length + 1;
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

console.log(`${write ? '已写入' : '预览'}：修正原话 ${totalFixed} 行，重排 ${totalRenumbered} 行`);
