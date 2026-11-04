import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildDailyEpisodes, readEpisodes } from '../src/episode.mjs';

const SID = 'session-test0001';
const KEY = 'private:10001';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'episode-daily-'));
}

function writeWindow(dir, rows) {
  const d = path.join(dir, 'window', SID);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'turns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ v: 1, sessionId: SID, nextTurn: rows.length + 1 }), 'utf8');
}

function turnRow(turn, iso, text) {
  return {
    v: 1,
    turn,
    at: iso,
    sessionId: SID,
    key: KEY,
    userRaw: { text, msgIds: [], chars: text.length },
    spoken: [],
    reply: { text: '', chars: 0 },
    feels: [],
    window: { textSha1: '', chars: 0, blocks: [] }
  };
}

test('日终建段：两天的窗口都成段，重跑幂等', () => {
  const dir = tmpDir();
  const marks = [
    '2026-11-03T21:00:00+08:00',
    '2026-11-03T21:01:00+08:00',
    '2026-11-03T21:02:00+08:00',
    '2026-11-03T21:03:00+08:00',
    '2026-11-04T21:00:00+08:00',
    '2026-11-04T21:01:00+08:00',
    '2026-11-04T21:02:00+08:00',
    '2026-11-04T21:03:00+08:00'
  ];
  const rows = marks.map((iso, i) => turnRow(i + 1, iso, `第 ${i + 1} 句话`));
  writeWindow(dir, rows);

  const now = Date.parse('2026-11-04T23:00:00+08:00');
  const first = buildDailyEpisodes(dir, { now, days: 2 });
  assert.ok(first.added >= 2, '两天各应至少建出一段');
  const built = readEpisodes(dir);
  assert.equal(built.length, first.added);
  assert.ok(built.every((e) => (e.turns || []).length >= 4), '每段至少 4 轮');

  const again = buildDailyEpisodes(dir, { now, days: 2 });
  assert.equal(again.added, 0, '同一个日终重跑不应重复建段');
  assert.equal(again.updated, 0);
});

test('夜里补了尾巴：同一段变长时更新并重置摘要', () => {
  const dir = tmpDir();
  const marks = [
    '2026-11-04T21:00:00+08:00',
    '2026-11-04T21:01:00+08:00',
    '2026-11-04T21:02:00+08:00',
    '2026-11-04T21:03:00+08:00'
  ];
  const rows = marks.map((iso, i) => turnRow(i + 1, iso, `第 ${i + 1} 句话`));
  writeWindow(dir, rows);
  const now = Date.parse('2026-11-04T23:00:00+08:00');
  buildDailyEpisodes(dir, { now, days: 2 });

  const before = readEpisodes(dir).find((e) => e.day === '2026-11-04');
  assert.ok(before);
  // 模拟日终之后又聊了两句，第二天重建时这一段应该跟着变长
  writeWindow(dir, [...rows, turnRow(5, '2026-11-04T23:40:00+08:00', '睡前再说一句')]);
  const grown = buildDailyEpisodes(dir, { now: Date.parse('2026-11-05T23:00:00+08:00'), days: 2 });
  assert.equal(grown.updated, 1, '只更新变长的那一段');

  const after = readEpisodes(dir).find((e) => e.id === before.id);
  assert.ok(after);
  assert.equal((after.turns || []).length, 5);
  assert.equal(after.summarized, false, '尾巴变了要重写摘要');
});
