import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as claims from '../src/claims.mjs';
import * as lt from '../src/longterm.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claims-test-'));
}

function windowTurn({ sid, turn, at, spoken = [], reply = '', key = 'private:10001' }) {
  return {
    v: 1,
    turn,
    at,
    sessionId: sid,
    key,
    mode: 'reserved2',
    model: 'deepseek-flash',
    userRaw: { text: '用户说话', msgIds: [], chars: 4 },
    spoken: spoken.map((text) => ({ kind: 'text', tool: 'qq_send_message', text })),
    reply: { text: reply, chars: reply.length },
    feels: [],
    incomplete: false
  };
}

function writeWindow(dir, sid, rows) {
  const wdir = path.join(dir, 'window', sid);
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, 'turns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('classifyClaim：408 归到 081200/085404，832 归到 081200/140600', () => {
  const a = claims.classifyClaim('计算机学院不走832：学硕081200和专硕085404都考408+数一');
  assert.equal(a.topicId, 't-hust');
  assert.equal(a.slot, 'exam');
  assert.ok(a.subjects.includes('408'));
  assert.ok(a.subjects.includes('数一'));

  const b = claims.classifyClaim('081200人工智能那边考301和832');
  assert.equal(b.topicId, 't-hust');
  assert.ok(b.subjects.includes('832'));
  assert.ok(b.subjects.includes('301'));
});

test('looksLikeCorrection：认纠正、不认寒暄', () => {
  assert.equal(claims.looksLikeCorrection('不是832，是408+数一'), true);
  assert.equal(claims.looksLikeCorrection('我记错了，应该是408'), true);
  assert.equal(claims.looksLikeCorrection('晚安'), false);
  assert.equal(claims.looksLikeCorrection('好的我知道啦'), false);
});

test('collectClaims：从窗口 spoken 捡纠正 → pending，重复扫幂等', () => {
  const dir = tmpDir();
  writeWindow(dir, 'session-aaaa', [
    windowTurn({
      sid: 'session-aaaa',
      turn: 5,
      at: '2026-11-05T10:00:00.000Z',
      spoken: ['不是832，应该是408和数一，计算机学院都考408']
    })
  ]);
  const r1 = claims.collectClaims(dir, { now: Date.parse('2026-11-05T12:00:00Z'), days: 3 });
  assert.equal(r1.added.length, 1);
  assert.equal(r1.pending.length, 1);
  const c = r1.pending[0];
  assert.equal(c.status, 'pending');
  assert.equal(c.slot, 'exam');
  assert.ok(c.subjects.includes('408'));
  assert.ok(c.quote.includes('408'));

  const r2 = claims.collectClaims(dir, { now: Date.parse('2026-11-05T12:30:00Z'), days: 3 });
  assert.equal(r2.added.length, 0);
  assert.equal(claims.readClaims(dir).length, 1);
});

test('collectClaims：每日封顶', () => {
  const dir = tmpDir();
  writeWindow(dir, 'session-bbbb', [
    windowTurn({ sid: 'session-bbbb', turn: 1, at: '2026-11-05T10:00:00.000Z', spoken: ['记错了，应该是408+数一'] }),
    windowTurn({ sid: 'session-bbbb', turn: 2, at: '2026-11-05T10:05:00.000Z', spoken: ['不是832，是301和832都考'] })
  ]);
  const r = claims.collectClaims(dir, { now: Date.parse('2026-11-05T12:00:00Z'), days: 3, maxPerDay: 1 });
  assert.equal(r.added.length, 1);
  assert.equal(claims.readClaims(dir).length, 1);
});

test('confirmClaim：写成 author:correction 的事实，并取代同 program 的旧 exam', () => {
  const dir = tmpDir();
  lt.appendEvent(
    {
      ev: 'fact',
      id: 'h-old-exam',
      sig: 'topic:t-hust:exam',
      key: 'private:10001',
      about: 'user',
      topicId: 't-hust',
      slot: 'exam',
      value: '华光计算机学硕考832',
      text: '华光计算机学硕考832',
      tier: 'long',
      I: 0.6,
      status: 'active',
      at: Date.parse('2026-10-28T08:00:00Z'),
      saidAt: Date.parse('2026-10-28T08:00:00Z')
    },
    dir
  );
  writeWindow(dir, 'session-cccc', [
    windowTurn({ sid: 'session-cccc', turn: 9, at: '2026-11-05T10:00:00.000Z', spoken: ['计算机学院不走832，学硕081200和专硕085404都考408+数一'] })
  ]);
  claims.collectClaims(dir, { now: Date.parse('2026-11-05T12:00:00Z'), days: 3 });
  const id = claims.readClaims(dir)[0].id;
  const r = claims.confirmClaim(dir, id, { by: 'owner' });
  assert.equal(r.ok, true);

  const facts = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
  const active = facts.filter((f) => f.topicId === 't-hust' && f.slot === 'exam' && f.status === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].author, 'correction');
  assert.equal(active[0].program, '081200/085404');
  assert.ok(active[0].subjects.includes('408'));
  assert.ok(active[0].value.includes('408') || active[0].value.includes('081200'));
});

test('rejectClaim：状态改成 rejected，不删审计', () => {
  const dir = tmpDir();
  writeWindow(dir, 'session-dddd', [
    windowTurn({ sid: 'session-dddd', turn: 1, at: '2026-11-05T10:00:00.000Z', spoken: ['我记错了，应该是408'] })
  ]);
  claims.collectClaims(dir, { now: Date.parse('2026-11-05T12:00:00Z'), days: 3 });
  const id = claims.readClaims(dir)[0].id;
  const r = claims.rejectClaim(dir, id, { reason: '测试驳回' });
  assert.equal(r.ok, true);
  const rows = claims.readClaims(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'rejected');
});
