// 情境段 → entry 的落库规则（不调模型：request 用桩）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractIntoStore } from '../src/extract-episode.mjs';
import { readEvents, materialize } from '../src/longterm.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entry-extract-'));
}

function seedWindow(dir, sessionId) {
  const d = path.join(dir, 'window', sessionId);
  fs.mkdirSync(d, { recursive: true });
  const row = {
    v: 1,
    turn: 1,
    at: Date.now(),
    sessionId,
    key: 'private:1',
    userRaw: { text: '极速谷6我买的是顶级版，最喜欢M9 GT9RS', chars: 24 },
    spoken: [{ kind: 'text', tool: 'qq_send_message', text: '代代都上顶级版' }],
    reply: { text: '记住了', chars: 3 },
    feels: [],
    window: { textSha1: 'x', chars: 10, blocks: [] }
  };
  fs.writeFileSync(path.join(d, 'turns.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  return row;
}

const EP = { id: 'ep-test-1', day: '2026-11-03', sessionId: 's1', turnFrom: 1, turnTo: 1, title: '极速谷' };

test('extractIntoStore：把模型条目写成带 topicId/slot 的事实', async () => {
  const dir = tmpdir();
  seedWindow(dir, 's1');
  const request = async () => ({
    ok: true,
    text: JSON.stringify([
      { topicId: 't-horizon6', slot: 'edition', value: '顶级版', quote: '极速谷6我买的是顶级版', kind: 'fact', confidence: 0.9 },
      { topicId: 't-horizon6', slot: 'pref', value: '最喜欢M9 GT9RS', quote: '最喜欢M9 GT9RS', kind: 'fact', confidence: 0.9 }
    ])
  });
  const r = await extractIntoStore(dir, [EP], { write: true, request });
  assert.equal(r.written, 2);
  const facts = materialize(readEvents(dir).rows, []);
  assert.equal(facts.length, 2);
  assert.ok(facts.every((f) => f.topicId === 't-horizon6'));
  assert.deepEqual(facts.map((f) => f.slot).sort(), ['edition', 'pref']);
});

test('extractIntoStore：单值槽位复用原 id 追加 supersede，不新开一条', async () => {
  const dir = tmpdir();
  seedWindow(dir, 's1');
  const first = { id: 'ep-a', day: '2026-11-03', sessionId: 's1', turnFrom: 1, turnTo: 1 };
  const second = { ...first, id: 'ep-b' };
  const mk = (value, quote) => async () => ({
    ok: true,
    text: JSON.stringify([{ topicId: 't-horizon6', slot: 'edition', value, quote, kind: 'fact', confidence: 0.9 }])
  });
  await extractIntoStore(dir, [first], { write: true, request: mk('顶级版', '极速谷6我买的是顶级版') });
  const before = materialize(readEvents(dir).rows, []);
  assert.equal(before.length, 1);
  const r2 = await extractIntoStore(dir, [second], { write: true, request: mk('标准版', '最喜欢M9 GT9RS') });
  assert.equal(r2.updated, 1);
  const after = materialize(readEvents(dir).rows, []);
  assert.equal(after.length, 1, '仍是同一条事实');
  assert.equal(after[0].id, before[0].id, 'id 不变，版本历史留在事件流里');
  assert.equal(after[0].value, '标准版');
});
