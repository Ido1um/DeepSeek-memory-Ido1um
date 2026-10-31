// 并发/原子写：两个写入者交错追加时，不能出现「半行」把整个库读坏。
// longterm.appendEvent 用 appendFileSync（一次 write，O_APPEND），这里验：
// 200 条并发追加后行数正确、每行可解析、末行完整（结尾有换行）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as longterm from '../src/longterm.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-concurrent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('并发追加 200 条：行数正确、无半行', async (t) => {
  const dir = tmpDir(t);
  const N = 200;
  await Promise.all(Array.from({ length: N }, (_, i) => Promise.resolve().then(() => {
    longterm.appendEvent({
      ev: 'fact',
      id: `h-20261031-${String(i).padStart(4, '0')}`,
      sig: `user:note:${i}`,
      about: 'user',
      label: '备注',
      value: `第 ${i} 条`,
      tier: 'general',
      I: 0.8,
      at: Date.now(),
    }, dir);
  })));

  const { rows, bad } = longterm.readEvents(dir);
  assert.equal(bad, 0, '不应有解析失败的行');
  assert.equal(rows.length, N);

  // 末行必须完整：文件最后一个字节是换行
  const raw = fs.readFileSync(path.join(dir, 'state', 'longterm.jsonl'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);

  // 折叠后不丢不重
  const facts = longterm.materialize(rows, {});
  assert.equal(facts.length, N);
});

test('并发写两份不同文件不互相干扰', async (t) => {
  const dir = tmpDir(t);
  await Promise.all([
    ...Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => longterm.appendEvent(
      { ev: 'fact', id: `h-a-${i}`, sig: `a:${i}`, about: 'user', label: 'A', value: 'a', tier: 'general', at: Date.now() }, dir))),
    ...Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => longterm.appendShadow(
      { ev: 'fact', id: `s-b-${i}`, sig: `b:${i}`, about: 'user', label: 'B', value: 'b', tier: 'general', at: Date.now() }, dir))),
  ]);
  assert.equal(longterm.readEvents(dir).rows.length, 50);
  assert.equal(longterm.readShadow(dir).rows.length, 50);
});
