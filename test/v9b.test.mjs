// v9.1 回归：审计遗留项的第二批修复。
//   1) 待办（class=task）截止后 taskTtlDays 天软删，不再永久 active；
//   2) settle 给过期事件写对原因（task-overdue / temp-ttl）；
//   3) token 日志按会话过滤时，无 sid 的老行不混进别的会话；
//   4) doctor 的「作废墓碑可读」真的去校验原文存在，孤儿墓碑会报 ✗；
//   5) doctor 会报出打分配置里的未知键（拼错的开关不再静默失效）。
// 全部离线：临时目录 + 纯函数，不碰生产数据。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.mjs';
import * as lt from '../src/longterm.mjs';
import { tierAfter } from '../src/score.mjs';
import { settle } from '../src/scoring-runner.mjs';
import { readTurns, tokenLogPath } from '../src/token.mjs';
import { checkDataDir } from '../src/doctor.mjs';

const DAY = 86400_000;

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-v9b-'));
  const dir = path.join(root, 'data');
  process.env.QQ_MEMORY_DIR = dir;
  store.clearConfigCache();
  t.after(() => {
    delete process.env.QQ_MEMORY_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dir;
}

test('score：task 截止超过 7 天判 expired，未过期/无截止日不动', () => {
  const now = Date.parse('2026-10-31T12:00:00+08:00');
  const base = { tier: 'general', I: 0.8, s: 3, lastAt: now, task: true, hits: 1 };
  assert.equal(tierAfter({ ...base, dueAt: now - 10 * DAY }, now), 'expired');
  assert.equal(tierAfter({ ...base, dueAt: now - 1 * DAY }, now), 'general');
  assert.equal(tierAfter({ ...base, dueAt: 0 }, now), 'general');
  // hard 的待办仍然不衰减、不软删
  assert.equal(tierAfter({ ...base, tier: 'hard', dueAt: now - 30 * DAY }, now), 'hard');
});

test('settle：任务过期事件的原因写 task-overdue，普通临时过期仍是 temp-ttl', (t) => {
  const dir = tmp(t);
  const now = Date.parse('2026-10-31T12:00:00+08:00');
  lt.appendEvent(
    { ev: 'fact', id: 'h-task-1', at: now - 20 * DAY, about: 'user', pattern: 'due', text: '交物理实验报告', tier: 'general', I: 0.8, s: 3, task: true, due: '2026-10-20', dueAt: now - 10 * DAY, lastAt: now - 20 * DAY },
    dir
  );
  const summary = settle({ now, scoring: { mode: 'write' }, dir });
  const moved = summary.transitions.find((x) => x.id === 'h-task-1');
  assert.ok(moved, '应当有一条过期迁移');
  assert.equal(moved.to, 'expired');
  assert.equal(moved.reason, 'task-overdue');
  const ev = lt.readEvents(dir).rows.find((r) => r.ev === 'expire' && r.id === 'h-task-1');
  assert.equal(ev.reason, 'task-overdue');
});

test('token：按会话过滤时无 sid 的老行不会混进别的会话', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const lines = [
    { k: 'turn', t: 1, sid: 'session-A', b: { cacheMiss: 10, cacheHit: 0 } },
    { k: 'turn', t: 2, sid: 'session-B', b: { cacheMiss: 99, cacheHit: 0 } },
    { k: 'turn', t: 3, b: { cacheMiss: 5, cacheHit: 0 } }
  ];
  fs.writeFileSync(tokenLogPath(dir), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  assert.deepEqual(readTurns(dir, { sessionId: 'session-A' }).map((x) => x.tokens), [10]);
  // 该会话没有任何带 sid 的行 → 退回无 sid 老行，而不是拿 B 会话的数
  assert.deepEqual(readTurns(dir, { sessionId: 'session-C' }).map((x) => x.tokens), [5]);
  // 不传会话 → 全部
  assert.equal(readTurns(dir).length, 3);
});

test('doctor：孤儿墓碑（找不到原文）会被报出来', (t) => {
  const dir = tmp(t);
  const p = lt.paths(dir);
  fs.mkdirSync(path.dirname(p.invalidated), { recursive: true });
  fs.writeFileSync(p.invalidated, JSON.stringify({ 'h-missing': { at: new Date().toISOString(), by: 'test', reason: 'x' } }), 'utf8');
  lt.appendEvent({ ev: 'fact', id: 'h-ok', at: Date.now(), about: 'user', pattern: 'note', text: '正常一条', tier: 'general' }, dir);
  const report = checkDataDir(dir, { config: {} });
  const tomb = report.checks.find((c) => c.name === '作废墓碑可读');
  assert.equal(tomb.ok, false);
  assert.match(tomb.detail, /1 条没有原文/);
});

test('doctor：打分配置里的未知键会报错（拼错的开关不再静默失效）', (t) => {
  const dir = tmp(t);
  const bad = checkDataDir(dir, { config: { scoring: { bogusSwitch: 1 } } });
  assert.equal(bad.checks.find((c) => c.name === '打分配置无未知键').ok, false);
  // 扁平别名（halfLifeLong 等）是已知写法，不该误报
  const good = checkDataDir(dir, { config: { scoring: { halfLifeLong: 60, mode: 'write' } } });
  assert.equal(good.checks.find((c) => c.name === '打分配置无未知键').ok, true);
});
