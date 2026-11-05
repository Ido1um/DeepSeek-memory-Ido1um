import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canEdit, reviseFact, readFactHistory, validateRevision } from '../src/revise.mjs';
import { appendEvent, materialize, readEvents } from '../src/longterm.mjs';

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revise-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

const T0 = Date.parse('2026-11-05T10:00:00+08:00');

function seedFact(dir, over = {}) {
  const row = {
    ev: 'fact', id: 'h-test-1', key: 'private:10001', about: 'user', topicId: 't-photo',
    slot: 'gear', value: 'Z8X', text: 'Z8X', tier: 'long', I: 0.6, saidAt: T0 - 86400000,
    author: 'extract', at: T0 - 86400000, ...over
  };
  appendEvent(row, dir);
  return row;
}

test('canEdit：用户全可改；她自己只能改 self 或关于 bot 的', () => {
  assert.equal(canEdit({ author: 'extract', about: 'user' }, { role: 'owner' }).ok, true);
  assert.equal(canEdit({ author: 'extract', about: 'user' }, { role: 'self' }).ok, false);
  assert.equal(canEdit({ author: 'self' }, { role: 'self' }).ok, true);
  assert.equal(canEdit({ author: 'extract', about: 'bot' }, { role: 'self' }).ok, true);
});

test('validateRevision：空改/超长/坏时间都拦', () => {
  assert.equal(validateRevision({}).ok, false);
  assert.equal(validateRevision({ value: 'x'.repeat(500) }).ok, false);
  assert.equal(validateRevision({ validUntil: '不是时间' }).ok, false);
  assert.equal(validateRevision({ value: 'Z8X + 2875ZA' }).ok, true);
});

test('reviseFact：改值 → ev revise、版本+1、历史留 before/after', () => {
  const dir = tmpDir();
  seedFact(dir);
  const r = reviseFact(dir, 'h-test-1', { value: 'Z8X + 2875ZA', reason: '补上镜头' }, { by: 'owner', role: 'owner', now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.before.value, 'Z8X');
  assert.equal(r.after.value, 'Z8X + 2875ZA');
  const fact = materialize(readEvents(dir).rows).find((f) => f.id === 'h-test-1');
  assert.equal(fact.value, 'Z8X + 2875ZA');
  assert.equal(fact.versions, 2);
  assert.equal(fact.revisedBy, 'owner');
  assert.equal(fact.reason, '补上镜头');
  const hist = readFactHistory(dir, 'h-test-1');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].before.value, 'Z8X');
  assert.equal(hist[0].after.value, 'Z8X + 2875ZA');
});

test('reviseFact：她自己改抽取事实被拒；改自己写的通过', () => {
  const dir = tmpDir();
  seedFact(dir, { author: 'extract' });
  const denied = reviseFact(dir, 'h-test-1', { value: '乱改' }, { by: 'self', role: 'self', now: T0 });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'forbidden');

  seedFact(dir, { id: 'h-self-1', author: 'self', voice: 'first' });
  const ok = reviseFact(dir, 'h-self-1', { value: '我自己的写法' }, { by: 'self', role: 'self', now: T0 + 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.fact.author, 'self');
  assert.equal(ok.fact.revisedBy, 'self');
});

test('reviseFact：改 validUntil 能把旧事改回「现在」', () => {
  const dir = tmpDir();
  seedFact(dir, { validUntil: T0 - 3600000 });
  const before = materialize(readEvents(dir).rows, [], T0).find((f) => f.id === 'h-test-1');
  assert.equal(before.expired, true);
  const r = reviseFact(dir, 'h-test-1', { validUntil: T0 + 86400000, reason: '其实还没过期' }, { now: T0 });
  assert.equal(r.ok, true);
  const after = materialize(readEvents(dir).rows, [], T0).find((f) => f.id === 'h-test-1');
  assert.equal(after.expired, false);
});
