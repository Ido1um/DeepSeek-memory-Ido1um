import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as lt from '../src/longterm.mjs';
import { routeQuery, routeScore } from '../src/route.mjs';
import { search } from '../src/scoring-runner.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'route-subj-'));
}

function fact(dir, row) {
  lt.appendEvent({
    ev: 'fact',
    key: 'private:10001',
    about: 'user',
    tier: 'long',
    I: 0.7,
    at: Date.now(),
    saidAt: Date.now(),
    ...row
  }, dir);
}

test('routeQuery：科目维度从问法里抽出来', () => {
  const r = routeQuery('计算机学院到底考408还是832');
  assert.ok(r.subjects.includes('408'));
  assert.ok(r.subjects.includes('832'));
  const r2 = routeQuery('初试要不要考数一');
  assert.ok(r2.subjects.includes('数一'));
  const r3 = routeQuery('我生日是哪天');
  assert.deepEqual(r3.subjects, []);
});

test('routeScore：fact.subjects 命中 query.subjects', () => {
  const route = routeQuery('考408还是832');
  const a = routeScore({ subjects: ['408', '数一'], slot: 'exam' }, route);
  assert.equal(a.subjectHit, true);
  const b = routeScore({ subjects: ['832', '301'], slot: 'exam' }, route);
  assert.equal(b.subjectHit, true);
  const c = routeScore({ subjects: [], slot: 'exam' }, route);
  assert.equal(c.subjectHit, false);
});

test('search：问 408 时按 program 拆出的条目排在旧 832 情报前', () => {
  const dir = tmpDir();
  fact(dir, {
    id: 'h-408',
    sig: 'topic:t-hust:exam:081200/085404',
    topicId: 't-hust',
    slot: 'exam',
    program: '081200/085404',
    subjects: ['408', '数一'],
    value: '华光计算机：学硕081200、专硕085404，初试考408+数一',
    text: '华光计算机：学硕081200、专硕085404，初试考408+数一'
  });
  fact(dir, {
    id: 'h-832',
    sig: 'topic:t-hust:exam:081200/140600',
    topicId: 't-hust',
    slot: 'exam',
    program: '081200/140600',
    subjects: ['832', '301'],
    value: '华光081200人工智能、140600：初试考301+832',
    text: '华光081200人工智能、140600：初试考301+832'
  });
  const rows = search({ query: '计算机学院考408还是832', dir, limit: 5, match: 'smart' });
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].id, 'h-408');
});
