import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCourse, weekOf, parityOfWeek, coursesOn, dayKey, weekdayOf, dayHintOf, scheduleAnswer, DEFAULT_SEMESTER } from '../src/schedule.mjs';
import { routeQuery, routeScore } from '../src/route.mjs';

const SEM = { ...DEFAULT_SEMESTER, from: '2026-08-31', to: '2027-01-03', weeks: 18 };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
}

const facts = [
  { id: 'en', status: 'active', topicId: 't-schedule', slot: 'course', value: '英语：周四 10:00', saidAt: Date.parse('2026-11-04T15:15:00+08:00'), course: { name: '英语', day: 4, start: '10:00', parity: 'even', semester: '2026秋' } },
  { id: 'eb', status: 'active', topicId: 't-schedule', slot: 'course', value: '示例基础课：周五 08:00', saidAt: Date.parse('2026-10-29T14:52:00+08:00'), course: { name: '示例基础课', day: 5, start: '08:00', parity: 'all', semester: '2026秋' } },
  { id: 'old', status: 'active', topicId: 't-schedule', slot: 'course', value: '旧课：周四', course: { name: '旧课', day: 4, start: '14:00', parity: 'odd', semester: '2025秋' } }
];

test('parseCourse：周几 + 早八 + 教室', () => {
  const c = parseCourse('周五早八，示例基础课，在示例楼 A507', { semester: SEM });
  assert.equal(c.day, 5);
  assert.equal(c.start, '08:00');
  assert.equal(c.location, '示例楼A507');
  assert.equal(c.parity, 'all');
});

test('parseCourse：明天 + 十点 + 双周', () => {
  const now = Date.parse('2026-11-04T15:15:00+08:00'); // 周三
  const c = parseCourse('明天早上十点有英语课，这周是双周第十周', { semester: SEM, now });
  assert.equal(c.day, 4); // 明天是周四
  assert.equal(c.start, '10:00');
  assert.equal(c.parity, 'even');
  assert.equal(c.timeUnknown, false);
});

test('weekOf / parityOfWeek：2026-11-05 是第 10 周双周', () => {
  assert.equal(dayKey('2026-11-05'), '2026-11-05');
  assert.equal(weekdayOf('2026-11-05'), 4);
  assert.equal(weekOf('2026-11-05', SEM), 10);
  assert.equal(parityOfWeek(10), 'even');
  assert.equal(parityOfWeek(9), 'odd');
});

test('coursesOn：只挑当天、周次内、单双周匹配的课', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'calendar.json'), JSON.stringify({ semesters: [SEM] }));
  const thu = coursesOn(dir, '2026-11-05', { facts }); // 第 10 周双周周四
  assert.deepEqual(thu.map((x) => x.fact.id), ['en']);
  const fri = coursesOn(dir, '2026-11-06', { facts });
  assert.deepEqual(fri.map((x) => x.fact.id), ['eb']);
});

test('dayHintOf：今天/明天/后天', () => {
  const now = Date.parse('2026-11-05T19:10:00+08:00');
  assert.equal(dayHintOf('明天早上什么课', now), '2026-11-06');
  assert.equal(dayHintOf('今天有课吗', now), '2026-11-05');
  assert.equal(dayHintOf('后天呢', now), '2026-11-07');
  assert.equal(dayHintOf('课表发我', now), '');
});

test('scheduleAnswer：给出第几周与当天课程', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'calendar.json'), JSON.stringify({ semesters: [SEM] }));
  const r = scheduleAnswer(dir, '2026-11-05', { facts });
  assert.match(r.text, /第 10 周/);
  assert.match(r.text, /周四 10:00/);
  assert.match(r.text, /英语/);
});

test('routeQuery：明天问课能解析出具体日与周几', () => {
  const now = Date.parse('2026-11-05T19:10:00+08:00');
  const r = routeQuery('明天有课吗', { now });
  assert.equal(r.schedule, true);
  assert.equal(r.day, '2026-11-06');
  assert.equal(r.weekday, 5);
  assert.ok(r.slots.includes('course'));
});

test('routeScore：当天课程 dayHit，别的天不命中', () => {
  const now = Date.parse('2026-11-05T19:10:00+08:00');
  const r = routeQuery('明天有课吗', { now });
  const eb = routeScore(facts[1], r);
  assert.equal(eb.dayHit, true);
  const en = routeScore(facts[0], r);
  assert.equal(en.dayHit, false);
});
