// 二维遗忘模型 + 硬事实抽取的单元测试（不需要网络、不碰生产数据）。
// 跑法：node --test test/score.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORING_DEFAULTS, DAY, normalizeConfig, importanceOf, stabilityOf, retentionOf,
  scoreOf, applyMention, mentionGain, applyNegative, nextReviewAt, tierAfter, demoted, describe,
  sameLocalDay,
} from '../src/score.mjs';
import { extractHardFacts, detectSignals, aboutOf, isQuestion } from '../src/facts.mjs';

const T0 = Date.parse('2026-10-29T10:00:00+08:00');
const at = (d) => T0 + d * DAY;

test('重要度：默认 0.5，主动陈述 0.6，明确要求记住 0.8，硬事实 1.0', () => {
  assert.equal(importanceOf({}), 0.5);
  assert.equal(importanceOf({ activeStatement: true }), 0.6);
  assert.equal(importanceOf({ explicitRemember: true }), 0.8);
  assert.equal(importanceOf({ hard: true }), 1);
  assert.equal(importanceOf({ hard: true, negatives: 1 }), 0.7); // 1 被否定 → −0.3
});

test('保持度：long 30 天剩一半，general 3 天剩一半，temp 1.5 天剩一半', () => {
  const long = { tier: 'long', I: 0.8, lastAt: T0 };
  assert.equal(Math.round(retentionOf(long, at(30)) * 100), 50);
  const general = { tier: 'general', I: 0.8, lastAt: T0 };
  assert.equal(Math.round(retentionOf(general, at(3)) * 100), 50);
  const temp = { tier: 'temp', I: 0.8, lastAt: T0 };
  assert.equal(Math.round(retentionOf(temp, at(1.5)) * 100), 50);
});

test('hard 档不衰减：400 天后仍是 100', () => {
  const hard = { tier: 'hard', I: 1, lastAt: T0 };
  assert.equal(retentionOf(hard, at(400)), 1);
  assert.equal(scoreOf(hard, at(400)), 100);
  assert.equal(stabilityOf(hard), Infinity);
  assert.equal(nextReviewAt(hard), null);
});

test('分数 = 100 × I × R（long 30 天 0.8 → 40）', () => {
  const fact = { tier: 'long', I: 0.8, lastAt: T0 };
  assert.equal(scoreOf(fact, at(30)), 40);
});

test('复习拉长稳定度 S：S 变大、分数变高', () => {
  const before = { tier: 'general', I: 0.6, s: 3, lastAt: T0, hits: 0 };
  const s0 = stabilityOf(before);
  const after = applyMention(before, at(1));
  assert.ok(stabilityOf(after) > s0, `S 应增长：${s0} → ${stabilityOf(after)}`);
  assert.equal(after.hits, 1);
  assert.equal(after.lastHitAt, at(1));
});

test('同日重复增益因子：1 → 0.5 → 0.25，跨日重置为 1', () => {
  const base = { tier: 'general', I: 0.6, s: 3, lastAt: at(0), sameDayHits: 1 };
  const same1 = mentionGain(base, at(0) + 3600_000); // 同日第 2 次
  const same2 = mentionGain({ ...base, sameDayHits: 2 }, at(0) + 7200_000); // 同日第 3 次
  const nextDay = mentionGain(base, at(1));
  assert.equal(same1, 0.5);
  assert.equal(same2, 0.25);
  assert.equal(nextDay, 1);
});

test('间隔复习比同日狂刷更能拉长稳定度', () => {
  const base = { tier: 'general', I: 0.6, s: 3, lastAt: at(0), sameDayHits: 1 };
  const spam = applyMention(base, at(0) + 3600_000); // 同日第二次
  const spaced = applyMention(base, at(3)); // 三天后复习（R≈0.5）
  assert.ok(spaced.s > spam.s, `间隔应更大：spam=${spam.s} spaced=${spaced.s}`);
});

test('升档：提及 ≥3 次且分数 ≥55 → long', () => {
  const fact = { tier: 'general', I: 0.9, s: 30, hits: 3, lastAt: at(0) };
  assert.ok(scoreOf(fact, at(0)) >= 55);
  assert.equal(tierAfter(fact, at(0)), 'long');
});

test('降档：长期 90 天没提 → 一般；一般掉到 30 分以下 → 临时', () => {
  const long = { tier: 'long', I: 0.8, s: 30, hits: 5, lastAt: T0 };
  assert.equal(tierAfter(long, at(89)), 'long');
  assert.equal(tierAfter(long, at(91)), 'general');
  const weak = { tier: 'general', I: 0.4, s: 3, lastAt: at(0) };
  assert.ok(scoreOf(weak, at(5)) < SCORING_DEFAULTS.generalToTemp);
  assert.equal(tierAfter(weak, at(5)), 'temp');
});

test('临时 7 天没提 → 过期（软删标记）', () => {
  const temp = { tier: 'temp', I: 0.5, s: 1.5, lastAt: T0 };
  assert.equal(tierAfter(temp, at(6)), 'temp');
  assert.equal(tierAfter(temp, at(8)), 'expired');
});

test('降级不归零：S 保留目标档 floor', () => {
  const f = demoted({ tier: 'long', s: 0.2, I: 0.8 }, 'general');
  assert.equal(f.s, SCORING_DEFAULTS.halfLifeDays.general);
});

test('负反馈：1 次降分、2 次 suspect、3 次建议作废', () => {
  const f0 = { tier: 'general', I: 0.8, lastAt: T0 };
  const f1 = applyNegative(f0, T0);
  const f2 = applyNegative(f1, T0 + 1000);
  const f3 = applyNegative(f2, T0 + 2000);
  assert.ok(f1.I < f0.I);
  assert.equal(f1.suspect, false);
  assert.equal(f2.suspect, true);
  assert.equal(f3.suggestInvalidate, true);
});

test('nextReviewAt = 上次提及 + S 天', () => {
  const f = { tier: 'general', s: 3, lastHitAt: T0 };
  assert.equal(nextReviewAt(f), T0 + 3 * DAY);
});

test('describe 一次给出 I/R/分数/下次复习/下一档', () => {
  const d = describe({ id: 'h-1', tier: 'long', I: 0.8, s: 30, hits: 4, lastAt: T0 }, at(30));
  assert.equal(d.I, 0.8);
  assert.equal(d.R, 0.5);
  assert.equal(d.score, 40);
  assert.equal(d.nextTier, 'long');
});

test('配置覆盖：只认已知键，非法值回落默认', () => {
  const c = normalizeConfig({ alpha: 0.5, halfLifeDays: { long: 20 }, bogus: 1, sMaxDays: -3 });
  assert.equal(c.alpha, 0.5);
  assert.equal(c.halfLifeDays.long, 20);
  assert.equal(c.halfLifeDays.general, SCORING_DEFAULTS.halfLifeDays.general);
  assert.equal(c.sMaxDays, SCORING_DEFAULTS.sMaxDays);
  assert.equal('bogus' in c, false);
});

test('硬事实抽取：用户生日 → user / birthday / 11月2号', () => {
  const [f] = extractHardFacts('我生日是11月2号');
  assert.equal(f.key, 'birthday');
  assert.equal(f.about, 'user');
  assert.equal(f.value, '11月2号');
});

test('硬事实抽取：你生日 → about=bot（我的事）', () => {
  const [f] = extractHardFacts('你生日是10月29号');
  assert.equal(f.about, 'bot');
  assert.equal(f.subject, '你');
});

test('硬事实抽取：以后叫我助手 → nickname', () => {
  const [f] = extractHardFacts('以后叫我助手就好');
  assert.equal(f.key, 'nickname');
  assert.equal(f.value, '助手就好');
});

test('疑问句不当事实：你生日几号？ / 我妈生日是哪天', () => {
  assert.equal(isQuestion('你生日几号？'), true);
  assert.deepEqual(extractHardFacts('你生日几号？'), []);
  assert.deepEqual(extractHardFacts('我妈生日是哪天'), []);
});

test('没有主语不算硬事实：生日 11 月 2 号（聊天里说别人的）', () => {
  assert.deepEqual(extractHardFacts('生日 11 月 2 号'), []);
});

test('信号：记住/别忘 → explicitRemember；不对/记错 → negative', () => {
  assert.equal(detectSignals('记住我不吃香菜').explicitRemember, true);
  assert.equal(detectSignals('这个记错了').negative, true);
  assert.equal(detectSignals('我喜欢喝酸奶').activeStatement, true);
  assert.equal(detectSignals('你生日几号？').hard, false);
});

test('aboutOf 兜底：未知主语按 user', () => {
  assert.equal(aboutOf('路人'), 'user');
  assert.equal(aboutOf('你'), 'bot');
});

test('sameLocalDay：同日为真，跨日为假', () => {
  assert.equal(sameLocalDay(T0, T0 + 3600_000), true);
  assert.equal(sameLocalDay(T0, T0 + DAY), false);
});
