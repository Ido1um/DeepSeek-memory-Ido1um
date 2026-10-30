import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pressureOf, rotationDecision } from '../src/token.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pressure-'));

function list(items) {
  return { items };
}

test('pressureOf：取对应会话的上下文压力与窗口', () => {
  const l = list([
    { sessionId: 's1', projections: { values: { contextPressure: { pressureTokens: 394666, contextWindow: 1000000 } } } },
    { sessionId: 's2', projections: { values: {} } },
  ]);
  const p = pressureOf(l, 's1');
  assert.equal(p.tokens, 394666);
  assert.equal(p.window, 1000000);
  assert.equal(p.source, 'dsh');
});

test('pressureOf：会话不存在或没有压力值时返回 0', () => {
  const l = list([{ sessionId: 's1', projections: { values: { contextPressure: { pressureTokens: 0 } } } }]);
  assert.deepEqual(pressureOf(l, 'nope'), { tokens: 0, window: 0, source: '' });
  assert.equal(pressureOf(l, 's1').tokens, 0);
  assert.equal(pressureOf(null, 's1').tokens, 0);
});

test('rotationDecision：pressureTokens 优先于日志，窗口取 config', () => {
  const dir = tmp();
  const dec = rotationDecision({
    dir,
    sessionId: 's1',
    config: { contextWindowTokens: 1000000 },
    pressureTokens: 394666,
    thresholdRatio: 0.7,
  });
  assert.equal(dec.window.tokens, 1000000);
  assert.equal(dec.threshold, 700000);
  assert.equal(dec.real.maxRecent, 394666);
  assert.equal(dec.real.source, 'dsh');
  assert.equal(dec.due, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotationDecision：压力过阈值即应轮转', () => {
  const dir = tmp();
  const dec = rotationDecision({
    dir,
    sessionId: 's1',
    config: { contextWindowTokens: 1000000 },
    pressureTokens: 812345,
    thresholdRatio: 0.7,
  });
  assert.equal(dec.due, true);
  assert.equal(dec.tokensOk, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotationDecision：没有压力值时回落日志扫描，空目录不会误触发', () => {
  const dir = tmp();
  const dec = rotationDecision({ dir, sessionId: 's1', config: { contextWindowTokens: 1000000 } });
  assert.equal(dec.real.maxRecent, 0);
  assert.notEqual(dec.real.source, 'dsh');
  assert.equal(dec.due, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
