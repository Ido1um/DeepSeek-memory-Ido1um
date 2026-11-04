import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendEvent, openIndex } from '../src/longterm.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longterm-time-'));
}

test('索引读时派生 at / expired，与 materialize 口径一致', () => {
  const dir = tmpDir();
  const saidAt = Date.parse('2026-11-03T19:10:00+08:00');
  const writtenAt = Date.parse('2026-11-04T23:10:00+08:00');
  appendEvent(
    {
      ev: 'fact',
      id: 'h-time-1',
      sig: 'user:event:test',
      key: 'private:10001',
      about: 'user',
      value: '今晚把傅里叶和拉普拉斯看完',
      text: '今晚把傅里叶和拉普拉斯看完',
      tier: 'general',
      I: 0.5,
      s: 3,
      hits: 1,
      at: writtenAt,
      lastAt: writtenAt,
      saidAt,
      validUntil: Date.parse('2026-11-03T23:59:59+08:00'),
      timePhrase: '今晚'
    },
    dir
  );

  const facts = openIndex(dir).facts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].at, saidAt, '说于时间优先于写入时间');
  assert.equal(facts[0].expired, true, '过了有效期就是旧事');
});

test('有效期内的事实不算旧事', () => {
  const dir = tmpDir();
  const now = Date.now();
  appendEvent(
    {
      ev: 'fact',
      id: 'h-time-2',
      sig: 'user:task:test',
      key: 'private:10001',
      about: 'user',
      value: '明天交实验报告',
      text: '明天交实验报告',
      tier: 'general',
      I: 0.8,
      s: 3,
      hits: 1,
      at: now,
      lastAt: now,
      saidAt: now,
      validUntil: now + 86400000,
      timePhrase: '明天'
    },
    dir
  );
  const facts = openIndex(dir).facts();
  assert.equal(facts[0].expired, false);
});

test('supersede 换值时时间锚跟着换（新值不该顶着旧值的过期日期）', () => {
  const dir = tmpDir();
  const oldAt = Date.parse('2026-10-29T19:10:00+08:00');
  const newAt = Date.parse('2026-11-04T20:35:00+08:00');
  appendEvent(
    {
      ev: 'fact',
      id: 'h-time-3',
      sig: 'topic:t-study:progress',
      key: 'private:10001',
      about: 'user',
      value: '今晚把傅里叶看完',
      text: '今晚把傅里叶看完',
      tier: 'general',
      I: 0.5,
      s: 3,
      hits: 1,
      at: oldAt,
      lastAt: oldAt,
      saidAt: oldAt,
      validUntil: Date.parse('2026-10-29T23:59:59+08:00'),
      timePhrase: '今晚'
    },
    dir
  );
  appendEvent(
    {
      ev: 'supersede',
      id: 'h-time-3',
      value: '补完体系结构和 CUDA 编程',
      quote: '体系结构和 CUDA 编程得自己补',
      at: Date.now(),
      saidAt: newAt,
      dates: [],
      validUntil: 0,
      timePhrase: '',
      timeConfidence: 0
    },
    dir
  );

  const fact = openIndex(dir).facts()[0];
  assert.equal(fact.value, '补完体系结构和 CUDA 编程');
  assert.equal(fact.saidAt, newAt, '时间锚跟着新值');
  assert.equal(fact.validUntil, 0, '旧的有效期要清掉');
  assert.equal(fact.expired, false, '新值不是旧事');
});
