import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, isExpired, ymd, toMs, endOfDay, nextMorning, parseBirthday, birthdayWho } from '../src/timeparse.mjs';

// 基准：2026-11-04（周三）19:10 北京时间
const REF = toMs(2026, 11, 4, 19, 10);
const at = (text, opts = {}) => parseTime(text, { refMs: REF, ...opts });

test('今晚（计划）：日期是今天，有效期当天 23:59', () => {
  const r = at('今晚计划把傅里叶和拉普拉斯都看完', { slot: 'plan' });
  assert.equal(r.dates[0].date, '2026-11-04');
  assert.equal(r.validUntil, endOfDay(REF));
  assert.equal(r.phrase, '今晚');
});

test('今晚（事件）：次日 06:00 失效', () => {
  const r = at('今晚下雨', { kindHint: 'event', slot: 'event' });
  assert.equal(r.dates[0].date, '2026-11-04');
  assert.equal(r.validUntil, nextMorning(REF));
});

test('明天 / 后天 / 大后天 / 昨天', () => {
  assert.equal(at('明天交报告').dates[0].date, '2026-11-05');
  assert.equal(at('后天交报告').dates[0].date, '2026-11-06');
  assert.equal(at('大后天交报告').dates[0].date, '2026-11-07');
  assert.equal(at('昨天聊过').dates[0].date, '2026-11-03');
});

test('上个星期四 = 10-29（过去），不是 11-05', () => {
  const r = at('复习傅立叶是上个星期四的事了');
  assert.equal(r.dates[0].date, '2026-10-29');
  assert.equal(at('上上个星期四').dates[0].date, '2026-10-22');
});

test('本周 / 下周四 / 下下周一', () => {
  assert.equal(at('本周五开会').dates[0].date, '2026-11-06');
  assert.equal(at('下周四交报告').dates[0].date, '2026-11-12');
  assert.equal(at('下下周一交报告').dates[0].date, '2026-11-16');
});

test('周末 = 最近的周六', () => {
  assert.equal(at('这周末去拍极光').dates[0].date, '2026-11-07');
});

test('显式日期：2026-11-09 / 11月9日 / 2017年9月5日', () => {
  assert.equal(at('2026-11-09 交报告').dates[0].date, '2026-11-09');
  assert.equal(at('11月9日交报告').dates[0].date, '2026-11-09');
  assert.equal(at('2007年9月5日生').dates[0].date, '2007-09-05');
});

test('N 天后 / 还有 3 天', () => {
  assert.equal(at('三天后交报告').dates[0].date, '2026-11-07');
  assert.equal(at('还有3天就考试').dates[0].date, '2026-11-07');
});

test('每天是重复事项，不进 dates', () => {
  const r = at('我每天都会散步');
  assert.equal(r.recurring, true);
  assert.equal(r.dates.length, 0);
  assert.equal(r.validUntil, null);
});

test('无时间词：事实类不给有效期，事件类按当天并标低置信', () => {
  const f = at('我的相机是 Z8X', { slot: 'gear' });
  assert.equal(f.dates.length, 0);
  assert.equal(f.validUntil, null);
  assert.equal(f.confidence, 0.3);

  const e = at('把物理实验报告写完', { slot: 'event' });
  assert.equal(e.dates[0].date, '2026-11-04');
  assert.equal(e.confidence, 0.3);
  assert.ok(e.validUntil > 0);
});

test('who：用户 / 助手 分得开', () => {
  assert.equal(at('用户的生日是 9 月 5 日').dates[0].who, 'owner');
  assert.equal(at('助手生日是 3 月 15 日').dates[0].who, 'bot');
});

test('过期判断与边界（23:59 之后才算过期）', () => {
  const vu = endOfDay(REF);
  assert.equal(isExpired(vu, vu - 60000), false);
  assert.equal(isExpired(vu, vu + 60000), true);
  assert.equal(isExpired(null, Date.now()), false);
});

test('没有参考时间不崩，按现在算并标低置信', () => {
  const r = parseTime('明天交报告', {});
  assert.ok(r.dates[0].date);
  assert.equal(r.confidence, 0.95);
});

test('生日：能解析年/月/日与只写月日两种写法', () => {
  assert.deepEqual(parseBirthday('用户 2007 年 9 月 5 日生'), { y: 2007, m: 9, d: 5, key: '09-05', yearly: true, phrase: '2007年9月5日' });
  const md = parseBirthday('助手生日是3月15日');
  assert.equal(md.y, 0);
  assert.equal(md.key, '03-15');
  assert.equal(parseBirthday('11-02').key, '11-02');
  assert.equal(parseBirthday('今天天气不错'), null);
});

test('生日：who 看句子主语，不看 about', () => {
  assert.equal(birthdayWho('用户 2007 年 9 月 5 日生', 'bot'), 'owner');
  assert.equal(birthdayWho('助手生日是3月15日', 'user'), 'bot');
  assert.equal(birthdayWho('3 月 15 日小助手生日，用户答应饭管够', 'user'), 'bot');
});
