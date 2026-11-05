// 记忆 3.1 · P0b：窗口缺口止血测试
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readTurns,
  beginTurn,
  finishTurn,
  noteInbound,
  peekInbound,
  reconcileSession
} from '../src/window.mjs';
import { buildGapTurns, appendReconciledTurns, repairGapsForKey, windowSessionsFor } from '../src/gapfill.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gapfill-'));
}

function writeRaw(dir, day, key, rows) {
  const file = path.join(dir, 'raw', 'hot', day, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const KEY = 'private:10001';
const SID = 'session-gap-test';

test('buildGapTurns：连续用户消息合成一轮，她发出去的话进 spoken，答完后再来用户消息另起一轮', () => {
  const turns = buildGapTurns([
    { at: 1000, role: 'user', text: '在吗', msgId: '1' },
    { at: 2000, role: 'user', text: '我买了顶级版', msgId: '2' },
    { at: 3000, role: 'assistant', text: '好，记住了' },
    { at: 4000, role: 'user', text: '明天几点上课', msgId: '3' }
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].userText, '在吗\n我买了顶级版');
  assert.deepEqual(turns[0].msgIds, ['1', '2']);
  assert.deepEqual(turns[0].spoken, ['好，记住了']);
  assert.equal(turns[1].userText, '明天几点上课');
});

test('buildGapTurns：已在窗口里的消息不再算缺口', () => {
  const existing = [{ userRaw: { text: '在吗', msgIds: ['1'] } }];
  const turns = buildGapTurns(
    [
      { at: 1000, role: 'user', text: '在吗', msgId: '1' },
      { at: 2000, role: 'user', text: '新的一句', msgId: '2' }
    ],
    { existingRows: existing }
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0].userText, '新的一句');
});

test('appendReconciledTurns：写入 fidelity/source 且幂等', () => {
  const dir = tmpDir();
  const turns = [{ at: 1000, userText: '第一条', msgIds: ['1'], spoken: ['收到'], chars: 3 }];
  const first = appendReconciledTurns({ dir, key: KEY, sessionId: SID, turns });
  assert.equal(first.added, 1);
  const rows = readTurns(dir, SID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fidelity, 'reconciled');
  assert.equal(rows[0].source, 'raw-gap');
  assert.equal(rows[0].userRaw.text, '第一条');
  assert.deepEqual(rows[0].spoken, [{ kind: 'send', tool: '', text: '收到' }]);
  const second = appendReconciledTurns({ dir, key: KEY, sessionId: SID, turns });
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 1);
});

test('repairGapsForKey：按时间把缺口归到对应的窗口会话', () => {
  const dir = tmpDir();
  writeRaw(dir, '2026-11-04', KEY, [
    { ts: '2026-11-04T06:33:00.000Z', role: 'user', text: '缺口一', messageId: '10' },
    { ts: '2026-11-04T06:33:30.000Z', role: 'assistant', text: '收到' },
    { ts: '2026-11-04T09:00:00.000Z', role: 'user', text: '缺口二', messageId: '11' }
  ]);
  // 会话 A 覆盖 07:00–08:00，会话 B 覆盖 11:00–12:00；缺口一在 A 附近、缺口二在 B 附近。
  appendReconciledTurns({ dir, key: KEY, sessionId: 'session-a', turns: [{ at: Date.parse('2026-11-04T07:00:00Z'), userText: '旧的一轮', msgIds: ['1'], spoken: [], chars: 4 }] });
  appendReconciledTurns({ dir, key: KEY, sessionId: 'session-b', turns: [{ at: Date.parse('2026-11-04T11:00:00Z'), userText: '另一轮', msgIds: ['2'], spoken: [], chars: 3 }] });
  const sessions = windowSessionsFor({ dir, key: KEY });
  assert.equal(sessions.length, 2);
  const r = repairGapsForKey({ dir, key: KEY, days: 5, now: Date.parse('2026-11-04T12:00:00Z'), write: true });
  assert.equal(r.gapTurns, 2);
  assert.equal(r.added, 2);
  const a = readTurns(dir, 'session-a');
  const b = readTurns(dir, 'session-b');
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.ok(a.some((x) => x.userRaw.text === '缺口一'));
  assert.ok(b.some((x) => x.userRaw.text === '缺口二'));
  // 再跑一次不重复
  const again = repairGapsForKey({ dir, key: KEY, days: 5, now: Date.parse('2026-11-04T12:00:00Z'), write: true });
  assert.equal(again.added, 0);
});

test('noteInbound：prompt 里没有原话时，beginTurn 用入站缓存兜底', () => {
  const dir = tmpDir();
  noteInbound({ key: KEY, text: '入站缓存里的原话', msgId: '77', at: Date.now() });
  assert.equal(peekInbound(KEY)?.text, '入站缓存里的原话');
  beginTurn({ key: KEY, sessionId: SID, userRaw: '【唤醒】看看有没有新消息', windowText: '窗口文本' });
  finishTurn({ dir, key: KEY, sessionId: SID, reply: '好' });
  const rows = readTurns(dir, SID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userRaw.text, '入站缓存里的原话');
  assert.deepEqual(rows[0].userRaw.msgIds, ['77']);
  assert.equal(peekInbound(KEY), null);
});

test('reconcileSession：反向核对能报出 raw 里有、窗口里没有的消息', () => {
  const dir = tmpDir();
  beginTurn({ key: KEY, sessionId: SID, userRaw: '窗口里的这句', windowText: '' });
  finishTurn({ dir, key: KEY, sessionId: SID, reply: '嗯' });
  const r = reconcileSession({
    dir,
    sessionId: SID,
    rawMessages: [
      { text: '窗口里的这句', msgId: '1' },
      { text: '掉出窗口的这句', msgId: '2' }
    ]
  });
  assert.equal(r.rawNotInWindowCount, 1);
  assert.equal(r.rawNotInWindow[0].head, '掉出窗口的这句');
});
