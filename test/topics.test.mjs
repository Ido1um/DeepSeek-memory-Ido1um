import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_TOPICS,
  SLOTS,
  SLOT_LABEL,
  classifyFact,
  ensureTopic,
  groupByTopic,
  readTopics,
  refinePlacement,
  rootOf,
  topicPath,
  topicsFile,
  upsertTopic,
  writeTopics
} from '../src/topics.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'topics-test-'));
}

function topic(id, name, parentId = '') {
  return { v: 1, id, name, parentId, aliases: [], note: '', createdAt: '2026-11-01T00:00:00.000Z' };
}

test('topics：写入/读取往返，坏行跳过', () => {
  const dir = tmpDir();
  writeTopics(dir, [topic('t-a', '甲'), topic('t-b', '乙', 't-a')]);
  // 手工塞一行坏 JSON，读取时应该跳过而不是整份失败
  fs.appendFileSync(topicsFile(dir), '{"id":"t-broken",\n', 'utf8');
  const rows = readTopics(dir);
  assert.deepEqual(rows.map((r) => r.id), ['t-a', 't-b']);
  assert.equal(readTopics(path.join(dir, 'nope')).length, 0);
});

test('topics：upsert 按 id 覆盖，不产生重复', () => {
  const dir = tmpDir();
  upsertTopic(dir, topic('t-a', '甲'));
  upsertTopic(dir, { id: 't-a', name: '甲改名' });
  const rows = readTopics(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '甲改名');
});

test('topics：ensureTopic 同名复用，不留两份', () => {
  const dir = tmpDir();
  const a = ensureTopic(dir, { name: '摄影', parentId: '' });
  const b = ensureTopic(dir, { name: '摄影' });
  assert.equal(a.id, b.id);
  assert.equal(readTopics(dir).length, 1);
  assert.equal(a.name, '摄影');
});

test('topics：路径与根（华光 → 升学）', () => {
  const rows = [topic('t-plan', '升学'), topic('t-hust', '华光', 't-plan'), topic('t-x', '孤立')];
  assert.deepEqual(topicPath(rows, 't-hust').map((t) => t.id), ['t-plan', 't-hust']);
  assert.equal(rootOf(rows, 't-hust').id, 't-plan');
  assert.equal(rootOf(rows, 't-x').id, 't-x');
  assert.equal(rootOf(rows, 'missing'), null);
});

test('topics：同槽位只留最新（按 lastAt）', () => {
  const facts = [
    { topicId: 't-photo', slot: 'gear', value: 'Z8X', lastAt: 100 },
    { topicId: 't-photo', slot: 'gear', value: 'Z8X + 2875ZA', lastAt: 200 },
    { topicId: 't-photo', slot: 'identity', value: '融媒体摄影师', lastAt: 150 },
    { value: '没挂主题', slot: 'note' }
  ];
  const groups = groupByTopic(facts, [topic('t-photo', '摄影')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].topic.name, '摄影');
  const slots = Object.fromEntries(groups[0].slots.map((s) => [s.slot, s.fact.value]));
  assert.equal(slots.gear, 'Z8X + 2875ZA');
  assert.equal(slots.identity, '融媒体摄影师');
});

test('classifyFact：课业优先归学业，不被华光/学校关键词抢走', () => {
  assert.deepEqual(
    { topicId: classifyFact({ value: '用户课业：示例课程期中卷四页' }).topicId, slot: classifyFact({ value: '用户课业：示例课程期中卷四页' }).slot },
    { topicId: 't-study', slot: 'event' }
  );
  assert.equal(classifyFact({ value: '华光 081200 拟招 30 人，初试 300' }).topicId, 't-hust');
  assert.equal(classifyFact({ value: '华光 081200 拟招 30 人，初试 300' }).slot, 'exam');
  assert.equal(classifyFact({ value: '买的是顶级版，预购冲的' }).slot, 'edition');
  assert.equal(classifyFact({ value: '买的是顶级版，预购冲的' }).topicId, 't-horizon6');
  assert.equal(classifyFact({ value: '最喜欢原厂示例车厂 GT9RS' }).topicId, 't-horizon6');
  assert.equal(classifyFact({ value: '周五早八示例基础课，在示例楼A507' }).slot, 'course');
  assert.equal(classifyFact({ value: '' }).topicId, '');
});

test('refinePlacement：只纠正明显放错的，已经对的返回 null', () => {
  const fix = refinePlacement(
    { value: '用户课业：物理实验报告要交' },
    { topicId: 't-hust', slot: 'intel' }
  );
  assert.equal(fix.topicId, 't-study');
  assert.equal(fix.slot, 'event');
  assert.equal(refinePlacement({ value: '用户课业：光学' }, { topicId: 't-study', slot: 'event' }), null);
  assert.equal(refinePlacement({ value: '生日 2007-09-05' }, { topicId: 't-identity', slot: 'birthday' }), null);
});

test('topics：默认主题自带槽位标签，词表一致', () => {
  const ids = DEFAULT_TOPICS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '默认主题 id 不能重复');
  for (const t of DEFAULT_TOPICS) {
    if (t.parentId) assert.ok(ids.includes(t.parentId), `${t.id} 的父主题应存在`);
  }
  for (const slot of ['identity', 'gear', 'edition', 'pref', 'intel', 'stance', 'progress']) {
    assert.ok(SLOTS.includes(slot), `${slot} 应在槽位词表里`);
    assert.ok(SLOT_LABEL[slot], `${slot} 应有中文标签`);
  }
});
