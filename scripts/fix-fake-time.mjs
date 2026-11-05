// 清理 timeparse 旧规则留下的「假日期」。
//
// 旧规则：没有时间词的事件/计划会被写成「当天日期 + 当天/次日失效」（confidence 0.3、phrase 为空）。
// 结果「考研目标定为华光 081200」「还在想清楚要不要考华光」这类长期计划第二天就被标成旧事。
//
// 只处理 signature 明确的那一类（0.3 + 空 phrase），不碰显式说过「今晚/上周X/N月N日」的事实。
// 默认预览，`--write` 落盘（先备份 longterm.jsonl）。

import fs from 'node:fs';
import path from 'node:path';

import { dataDir } from '../src/store.mjs';
import { readEvents, materialize, readInvalidated, appendEvent } from '../src/longterm.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const write = Boolean(arg('write', false));
const dir = dataDir();
const events = readEvents(dir).rows;
const invalidated = readInvalidated(dir);
const facts = materialize(events, invalidated);

const fake = (f) => {
  if (!Array.isArray(f.dates) || !f.dates.length) return false;
  if (String(f.timePhrase || '')) return false;
  return f.dates.some((d) => Number(d.confidence) === 0.3 && !String(d.phrase || ''));
};

const targets = facts.filter((f) => (f.status || 'active') === 'active' && fake(f));
console.log(`数据目录：${dir}`);
console.log(`事件 ${events.length} 条 / 有效事实 ${facts.filter((f) => (f.status || 'active') === 'active').length} 条 / 命中假日期 ${targets.length} 条`);
for (const f of targets) {
  console.log(`- ${f.id} [${f.topicId || '-'}/${f.slot || '-'}] ${String(f.value || f.text || '').slice(0, 56)}  validUntil=${f.validUntil}`);
}

if (!write) {
  console.log('\n预览结束。加 --write 落盘（会先备份 longterm.jsonl）。');
  process.exit(0);
}
if (!targets.length) {
  console.log('没有要修的，跳过。');
  process.exit(0);
}

const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const backupDir = path.join(dir, 'backup', `fake-time-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
const src = path.join(dir, 'state', 'longterm.jsonl');
const dst = path.join(backupDir, 'longterm.jsonl');
fs.copyFileSync(src, dst);
console.log(`\n备份：${dst}`);

for (const f of targets) {
  appendEvent({
    ev: 'update',
    id: f.id,
    // 清空假日期：只留 saidAt 作为时间锚
    dates: [],
    validUntil: 0,
    timePhrase: '',
    timeConfidence: 0
  }, dir);
}
console.log(`已清理 ${targets.length} 条假日期。`);

const after = materialize(readEvents(dir).rows, readInvalidated(dir));
const active = after.filter((f) => (f.status || 'active') === 'active');
console.log(`复验：有效 ${active.length} 条，其中 marked-expired ${active.filter((f) => f.expired).length} 条（此前 ${facts.filter((f) => (f.status || 'active') === 'active' && f.expired).length} 条）。`);
