import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beginTurn, finishTurn, readTurns, readWindowText } from '../src/window.mjs';

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-media-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

test('一轮带图：账本只记 sha1 引用，不写图片字节', () => {
  const dir = tmpDir();
  const sid = 'session-test-media';
  beginTurn({
    key: 'private:1',
    sessionId: sid,
    userRaw: '看看这张图',
    windowText: '【当前对话】\n用户：看看这张图',
    media: [{ sha1: 'a'.repeat(40), kind: 'image', mime: 'image/png', bytes: 69, at: 1, alt: '[图片1]' }]
  });
  const done = finishTurn({ dir, sessionId: sid, reply: '看到了', reason: 'completed' });
  assert.ok(done && done.turn === 1);
  const rows = readTurns(dir, sid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mediaRefs.length, 1);
  assert.equal(rows[0].mediaRefs[0].sha1, 'a'.repeat(40));
  assert.equal(rows[0].mediaRefs[0].mime, 'image/png');
  const window = readWindowText(dir, rows[0]);
  assert.equal(window.includes('a'.repeat(40)), false);
  assert.equal(window.includes('看看这张图'), true);
});

test('没有图时账本不写 media 字段', () => {
  const dir = tmpDir();
  const sid = 'session-test-nomedia';
  beginTurn({ key: 'private:1', sessionId: sid, userRaw: '纯文字', windowText: '【当前对话】\n用户：纯文字' });
  finishTurn({ dir, sessionId: sid, reply: '好', reason: 'completed' });
  const rows = readTurns(dir, sid);
  assert.equal(rows.length, 1);
  assert.equal('mediaRefs' in rows[0], false);
});
