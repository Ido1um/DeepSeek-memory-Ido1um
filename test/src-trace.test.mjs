// 来源索引：src 事件折叠进事实
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lt from '../src/longterm.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'src-trace-')); }

test('src 事件挂到事实，不改原文', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const lines = [
    { ev: 'fact', id: 'h-20261102-abcdef', value: '喜欢摄影', class: 'pref', tier: 'long' },
    { ev: 'src', id: 'h-20261102-abcdef', src: { kind: 'log', file: 'raw/hot/2026-11-02/private_10001.jsonl', quote: '我喜欢摄影' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'state', 'longterm.jsonl'), lines);
  const f = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir)).find((x) => x.id === 'h-20261102-abcdef');
  assert.equal(f.src.kind, 'log');
  assert.equal(f.value, '喜欢摄影');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('没有 src 时是 null，不伪造来源', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'longterm.jsonl'),
    JSON.stringify({ ev: 'fact', id: 'h-20261102-123456', value: '随便一条' }) + '\n');
  const f = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir))[0];
  assert.equal(f.src, null);
  fs.rmSync(dir, { recursive: true, force: true });
});