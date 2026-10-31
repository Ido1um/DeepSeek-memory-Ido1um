// v8 批 4：人工调档 / 调分（manual 事件）+ 还原（manualReset）
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as lt from '../src/longterm.mjs';
import { describe } from '../src/score.mjs';
import { buildCard } from '../src/card.mjs';

const DAY = 86400000;

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8d-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

function seed(dir, extra = {}) {
  lt.appendEvent({
    ev: 'fact', id: 'h-1', sig: 'user:pref:酸奶', about: 'user', pattern: 'pref',
    label: 'pref', value: '喜欢草莓味酸奶', text: '喜欢草莓味酸奶',
    tier: 'general', I: 0.5, s: 3, at: Date.now() - 3 * DAY, ...extra,
  }, dir);
}

test('manual 事件：档位与分数立即生效', () => {
  const dir = tmpDir();
  seed(dir);
  lt.appendEvent({ ev: 'manual', id: 'h-1', tier: 'long', score: 90, s: 30, at: Date.now() }, dir);
  const f = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir)).find((x) => x.id === 'h-1');
  assert.equal(f.tier, 'long');
  assert.equal(f.manual, true);
  assert.equal(f.s, 30);
  assert.equal(f.I, 0.9);
  const d = describe(f, Date.now());
  assert.ok(d.score >= 88 && d.score <= 90, `期望 ~90，实得 ${d.score}`);
});

test('manual 之后仍按新档衰减（不是冻住）', () => {
  const dir = tmpDir();
  seed(dir);
  const t0 = Date.now();
  lt.appendEvent({ ev: 'manual', id: 'h-1', tier: 'general', score: 100, s: 3, at: t0 }, dir);
  const f = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir))[0];
  const now = describe(f, t0).score;
  const later = describe(f, t0 + 3 * DAY).score; // 一般档半衰期 3 天 → 约一半
  assert.equal(now, 100);
  assert.ok(later > 40 && later < 60, `3 天后应约 50，实得 ${later}`);
});

test('manualReset 还原自动分（I 回到人工前）', () => {
  const dir = tmpDir();
  seed(dir);
  const before = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir))[0].I;
  lt.appendEvent({ ev: 'manual', id: 'h-1', tier: 'long', score: 99, s: 30, at: Date.now() }, dir);
  assert.equal(lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir))[0].I, 0.99);
  lt.appendEvent({ ev: 'manualReset', id: 'h-1', at: Date.now() }, dir);
  const f = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir))[0];
  assert.equal(f.manual, false);
  assert.equal(f.I, before);
});

test('调成 hard 后分数不再随时间掉', () => {
  const dir = tmpDir();
  seed(dir);
  const t0 = Date.now();
  lt.appendEvent({ ev: 'manual', id: 'h-1', tier: 'hard', score: 100, at: t0 }, dir);
  const f = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir))[0];
  assert.equal(describe(f, t0 + 400 * DAY).score, 100);
});

test('调档后卡里按新档位/新内容排', () => {
  const dir = tmpDir();
  seed(dir);
  lt.appendEvent({ ev: 'manual', id: 'h-1', tier: 'hard', score: 100, at: Date.now() }, dir);
  const facts = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
  const card = buildCard(facts, { maxChars: 1500 });
  assert.ok(card.text.includes('酸奶'), '硬事实应进卡');
  assert.ok((card.included || []).length >= 1, '应至少收录 1 条');
});
