#!/usr/bin/env node
/**
 * 迁移：给存量事实补 entities / major / exam / course。
 *
 * 用法：
 *   node scripts/migrate-fields.mjs                # 预览
 *   node scripts/migrate-fields.mjs --write        # 写盘（先备份 longterm.jsonl）
 *   node scripts/migrate-fields.mjs --json         # 机器可读
 *   node scripts/migrate-fields.mjs --dir <数据目录>
 *
 * 只追加 ev:'update'，不改历史行；映射不上的进 state/fields-migrate-review.jsonl。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as lt from '../src/longterm.mjs';
import { dataDir } from '../src/store.mjs';
import { planFieldUpdate, planReview } from '../src/fields-migrate.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const dir = arg('dir', dataDir());
const write = flag('write');
const asJson = flag('json');

const facts = lt
  .materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir))
  .filter((f) => (f.status || 'active') === 'active');

const updates = [];
const review = [];
for (const f of facts) {
  const up = planFieldUpdate(f);
  if (up) updates.push(up);
  const rv = planReview(f);
  if (rv) review.push(rv);
}

if (write && updates.length) {
  const backupDir = path.join(dir, 'backup', `fields-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(path.join(dir, 'state', 'longterm.jsonl'), path.join(backupDir, 'longterm.jsonl'));
  const now = Date.now();
  for (const up of updates) {
    lt.appendEvent(
      {
        ev: 'update',
        id: up.id,
        at: now,
        ...(up.topicId ? { topicId: up.topicId } : {}),
        ...(up.slot ? { slot: up.slot } : {}),
        ...(up.entities ? { entities: up.entities } : {})
      },
      dir
    );
  }
  if (review.length) {
    const file = path.join(dir, 'state', 'fields-migrate-review.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = review.map((r) => JSON.stringify({ at: new Date(now).toISOString(), ...r })).join('\n') + '\n';
    fs.appendFileSync(file, lines, 'utf8');
  }
}

const summary = {
  dir,
  active: facts.length,
  updates: updates.length,
  review: review.length,
  wrote: write ? updates.length : 0,
  byReason: updates.reduce((acc, u) => {
    for (const r of u.reasons) acc[r] = (acc[r] || 0) + 1;
    return acc;
  }, {}),
  samples: updates.slice(0, 8),
  reviewSamples: review.slice(0, 6)
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`数据目录：${dir}`);
  console.log(`active ${facts.length} 条 → 计划补字段 ${updates.length} 条，进 review ${review.length} 条`);
  console.log(`原因分布：${JSON.stringify(summary.byReason)}`);
  for (const u of summary.samples) console.log(`  + ${u.id} ${u.topicId || '-'}/${u.slot || '-'} [${u.reasons.join('，')}]`);
  for (const r of summary.reviewSamples) console.log(`  ? ${r.id} ${r.topicId}/${r.slot} ${r.notes.join('；')}`);
  console.log(write ? `已写入 ${updates.length} 条 update` : '（预览，未写盘；加 --write 落盘）');
}
