import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  maybeWander,
  planNext,
  readState,
  wanderLine,
  forceNext,
  isDue
} from '../src/wander.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-11-03T23:00:00+08:00');

function mkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-wander-'));
}

function writeEpisodes(dir, rows) {
  fs.mkdirSync(path.join(dir, 'episodes'), { recursive: true });
  const byMonth = new Map();
  for (const r of rows) {
    const m = String(r.day).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  for (const [m, list] of byMonth) {
    fs.writeFileSync(path.join(dir, 'episodes', `${m}.jsonl`), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
}

test('planNext 间隔落在 36–96 小时并带 ±90 分钟抖动', () => {
  const lo = planNext(NOW, {}, () => 0);
  const hi = planNext(NOW, {}, () => 1);
  assert.ok(lo >= NOW + 36 * 3600000 - 90 * 60000);
  assert.ok(hi <= NOW + 96 * 3600000 + 90 * 60000);
});

test('没有 nextAt 时算到点；24 小时内提过则封顶', () => {
  assert.equal(isDue({}, NOW, {}), true);
  assert.equal(isDue({ nextAt: NOW + 1000 }, NOW, {}), false);
  const dir = mkdir();
  writeEpisodes(dir, [{ id: 'e1', day: '2026-09-01', atFrom: NOW - 60 * DAY, atTo: NOW - 60 * DAY, title: '旧事', scene: '很久以前的一段' }]);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'wander.json'), JSON.stringify({ nextAt: 0, history: [{ at: NOW - 3600000, id: 'x' }] }));
  const r = maybeWander(dir, { now: NOW, cfg: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'daily-cap');
  assert.ok(readState(dir).nextAt > NOW);
});

test('提到足够旧的情境并推进 nextAt；同段进入冷却', () => {
  const dir = mkdir();
  writeEpisodes(dir, [
    { id: 'ep-old', day: '2026-09-01', atFrom: NOW - 63 * DAY, atTo: NOW - 63 * DAY, title: '华光情报', scene: '081200 拟招 30 人，初试考 832' },
    { id: 'ep-new', day: '2026-11-02', atFrom: NOW - DAY, atTo: NOW - DAY, title: '昨天', scene: '刚聊过' }
  ]);
  const r = maybeWander(dir, { now: NOW, cfg: {} });
  assert.equal(r.ok, true);
  assert.equal(r.episodeId, 'ep-old');
  assert.ok(r.line.includes('081200'));
  const st = readState(dir);
  assert.equal(st.history.length, 1);
  assert.ok(st.nextAt > NOW);
  assert.ok(wanderLine({ day: '2026-09-01', scene: 'x'.repeat(500) }, { maxChars: 150 }).length <= 150);
});

test('没有足够旧的情境就不提；forceNext 立刻到期', () => {
  const dir = mkdir();
  writeEpisodes(dir, [
    { id: 'a', day: '2026-10-20', atFrom: NOW - 14 * DAY, atTo: NOW - 14 * DAY, title: '两周前', scene: '旧一点' },
    { id: 'b', day: '2026-11-02', atFrom: NOW - DAY, atTo: NOW - DAY, title: '昨天', scene: '新' }
  ]);
  const r = maybeWander(dir, { now: NOW, cfg: { minAgeDays: 30 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-candidate');
  forceNext(dir, { now: NOW });
  const r2 = maybeWander(dir, { now: NOW, cfg: { minAgeDays: 7 } });
  assert.equal(r2.ok, true);
  assert.equal(r2.episodeId, 'a');
  forceNext(dir, { now: NOW });
  assert.equal(isDue(readState(dir), NOW, {}), true);
});
