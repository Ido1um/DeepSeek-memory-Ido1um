// v11 语义门 + 候选池的基础测试。
//
// 这些门存在的理由来自影子复查：6 批 18 候选里严格只有 3/8 是对的，
// 错法集中在四类（称呼当属性、拥有物当偏好、版本名当偏好、未来计划当事件）。
// 这里逐条钉住，避免以后 prompt 一改又退回去。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { semanticGate, validateCandidate } from '../src/extract-model.mjs';
import { appendCandidates, pooledToday, readCandidates, summarizeCandidates, writeCandidates } from '../src/candidates.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v11-sem-'));
}

function vc(raw, extra = {}) {
  return validateCandidate(raw, {
    messages: [{ text: raw.quote }],
    now: Date.now(),
    cfg: { minConfidence: 0.5 },
    ...extra
  });
}

test('gate-v11：称呼/祝福不能当用户的名字（bot-name）', () => {
  const raw = {
    kind: 'fact',
    about: 'user',
    subject: '用户',
    topic: 'user:name',
    value: '助手',
    quote: '生日快乐，助手',
    confidence: 0.9
  };
  assert.equal(semanticGate(raw), 'bot-name');
  const r = vc(raw);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bot-name');
});

test('gate-v11：属性类必须有本人自指（attr-evidence）', () => {
  const noSelf = {
    kind: 'fact',
    about: 'user',
    subject: '我',
    topic: 'user:skill',
    value: '古典吉他',
    quote: '最近在学古典吉他',
    confidence: 0.8
  };
  assert.equal(semanticGate(noSelf), 'attr-evidence');
  assert.equal(vc(noSelf).reason, 'attr-evidence');

  const withSelf = { ...noSelf, quote: '我最近在学古典吉他' };
  assert.equal(semanticGate(withSelf), '');
  assert.equal(vc(withSelf).ok, true);
});

test('gate-v11：偏好必须有偏好动词（pref-verb）', () => {
  const noVerb = {
    kind: 'pref',
    about: 'user',
    subject: '我',
    topic: 'user:pref:火锅',
    value: '火锅',
    quote: '周末想去吃火锅',
    confidence: 0.8
  };
  assert.equal(semanticGate(noVerb), 'pref-verb');
  assert.equal(vc(noVerb).reason, 'pref-verb');

  const withVerb = { ...noVerb, quote: '我特别喜欢吃火锅' };
  assert.equal(semanticGate(withVerb), '');
  assert.equal(vc(withVerb).ok, true);
});

test('gate-v11：版本/资料片/地图不算偏好对象（edition）', () => {
  const raw = {
    kind: 'pref',
    about: 'user',
    subject: '我',
    topic: 'user:pref:英国地图',
    value: '英国地图',
    quote: '我最喜欢英国地图',
    confidence: 0.9
  };
  assert.equal(semanticGate(raw), 'edition');
  assert.equal(vc(raw).reason, 'edition');
});

test('gate-v11：未来计划不当事件（event-future）', () => {
  const future = {
    kind: 'event',
    about: 'user',
    subject: '我',
    topic: 'user:event',
    value: '逛学校',
    quote: '周末想去逛学校',
    confidence: 0.8
  };
  assert.equal(semanticGate(future), 'event-future');
  assert.equal(vc(future).reason, 'event-future');

  const past = { ...future, quote: '昨天去逛了学校' };
  assert.equal(semanticGate(past), '');
  assert.equal(vc(past).ok, true);
});

test('candidates：进池/读回/统计/整池重写', () => {
  const dir = tmpDir();
  const now = Date.now();
  const rows = appendCandidates(
    [
      { kind: 'task', topic: 'user:task:2026-11-09', value: '物理实验报告', at: now },
      { kind: 'pref', topic: 'user:pref:火锅', value: '火锅', at: now, sourceKind: 'model' }
    ],
    dir
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.id && r.status === 'pending'));

  const read = readCandidates(dir);
  assert.equal(read.rows.length, 2);
  assert.equal(read.bad, 0);

  const sum = summarizeCandidates(dir);
  assert.equal(sum.total, 2);
  assert.equal(sum.pending, 2);
  assert.equal(sum.byKind.task, 1);
  assert.equal(pooledToday(dir, now), 2);
  assert.deepEqual(sum.recent.map((r) => r.value), ['物理实验报告', '火锅']);

  // 归并阶段整池改状态：原子重写后仍能读回
  const changed = read.rows.map((r, i) => (i === 0 ? { ...r, status: 'merged' } : r));
  assert.equal(writeCandidates(changed, dir), 2);
  const after = summarizeCandidates(dir);
  assert.equal(after.pending, 1);
  assert.equal(after.byStatus.merged, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});
