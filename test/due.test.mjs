import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDue, reminderWindow, ymd } from '../src/due.mjs';

// 固定「现在」：2026-10-29（周四）22:10，与本机日常口语一致
const NOW = new Date(2026, 9, 29, 22, 10, 0, 0).getTime();
const p = (text) => parseDue(text, NOW);

test('绝对日期：11 月 9 日 → 2026-11-09', () => {
  const d = p('记住 11 月 9 日交物理实验报告');
  assert.equal(d.due, '2026-11-09');
  assert.equal(new Date(d.dueAt).getHours(), 9); // 没写时刻默认 09:00
});

test('绝对日期带年：2027 年 1 月 3 日', () => {
  assert.equal(p('2027 年 1 月 3 日春游').due, '2027-01-03');
});

test('过去的月日算明年：1 月 3 日 → 2027-01-03', () => {
  assert.equal(p('1 月 3 日交报告').due, '2027-01-03');
});

test('下下个星期一 → 2026-11-09（用户原句）', () => {
  const d = p('记住我下下个星期一要交物理实验报告');
  assert.equal(d.due, '2026-11-09');
  assert.equal(d.source, 'week');
});

test('下星期一 → 2026-11-02；星期三（无前缀、已过）→ 2026-11-04', () => {
  assert.equal(p('下星期一开会').due, '2026-11-02');
  assert.equal(p('星期三交作业').due, '2026-11-04');
});

test('无前缀的星期日仍在今天之后：2026-11-01；下星期日 → 11-08', () => {
  assert.equal(p('星期日去取快递').due, '2026-11-01');
  assert.equal(p('下星期日去取快递').due, '2026-11-08');
});

test('相对日：明天/后天/大后天/三天后', () => {
  assert.equal(p('明天交').due, '2026-10-30');
  assert.equal(p('后天交').due, '2026-10-31');
  assert.equal(p('大后天交').due, '2026-11-01');
  assert.equal(p('三天后交').due, '2026-11-01');
});

test('时刻解析：下午三点 → 15:00；晚上八点 → 20:00；上午十点半 → 10:30', () => {
  assert.equal(new Date(p('明天下午三点开会').dueAt).getHours(), 15);
  assert.equal(new Date(p('明天晚上八点交').dueAt).getHours(), 20);
  const half = p('后天上午十点半交');
  assert.equal(new Date(half.dueAt).getHours(), 10);
  assert.equal(new Date(half.dueAt).getMinutes(), 30);
});

test('解析不出返回 null（不瞎猜）', () => {
  assert.equal(p('今天好累'), null);
  assert.equal(p('我记住啦'), null);
  assert.equal(p(''), null);
});

test('reminderWindow：24 小时内才提醒，提醒过不重复，非事项不提醒', () => {
  const now = Date.parse('2026-11-08T21:30:00+08:00');
  const dueAt = Date.parse('2026-11-09T09:00:00+08:00');
  const base = { task: true, dueAt, due: '2026-11-09', notifiedAt: 0 };
  assert.equal(reminderWindow(base, now), true); // 11.5 小时前 → 提醒
  assert.equal(reminderWindow(base, Date.parse('2026-11-07T09:00:00+08:00')), false); // 48 小时前 → 不提醒
  assert.equal(reminderWindow({ ...base, notifiedAt: 1 }, now), false); // 提醒过
  assert.equal(reminderWindow({ ...base, task: false }, now), false); // 普通事实
  assert.equal(reminderWindow({ ...base, dueAt: 0 }, now), false); // 没有日期
  assert.equal(reminderWindow(base, Date.parse('2026-11-09T15:00:00+08:00')), true); // 过期 6 小时内仍补一次
  assert.equal(reminderWindow(base, Date.parse('2026-11-10T09:00:00+08:00')), false); // 过期 24 小时不再补
});

test('ymd 用本地时区，不会因 UTC 偏差掉一天', () => {
  assert.equal(ymd(new Date(2026, 10, 9, 0, 30)), '2026-11-09');
  assert.equal(ymd(new Date(2026, 10, 9, 23, 30)), '2026-11-09');
});

test('上个星期四 → 过去（11-04 说 → 10-29），不会再被算成下周四', () => {
  const now1104 = new Date(2026, 10, 4, 12, 0, 0, 0).getTime();
  assert.equal(parseDue('复习傅立叶是上个星期四的事了', now1104).due, '2026-10-29');
  assert.equal(parseDue('上上个星期四的事', now1104).due, '2026-10-22');
  assert.equal(parseDue('下下个星期一交报告', now1104).due, '2026-11-16');
});
