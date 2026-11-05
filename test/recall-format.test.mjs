import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anchorOf,
  anchorText,
  authorTag,
  diagnoseRecall,
  emptyRecallText,
  formatRecallBody,
  rowLine
} from '../src/recall-format.mjs';

const now = Date.parse('2026-11-05T04:00:00Z');

test('作者标记：self 与 extract 区分', () => {
  assert.equal(authorTag({ author: 'self' }), '〔自己写的〕');
  assert.equal(authorTag({ author: 'extract' }), '');
  assert.equal(authorTag({}), '');
});

test('窗口锚点：自写事实直接用 src', () => {
  const fact = {
    id: 'h-self-1',
    saidAt: Date.parse('2026-11-03T14:00:00Z'),
    src: { kind: 'window', sessionId: 'session-8c971ac7-155f-41a5-a3b9-22a19fa7102e', turnFrom: 12, turnTo: 14 }
  };
  const a = anchorOf(fact);
  assert.equal(a.kind, 'window');
  assert.equal(a.turnFrom, 12);
  assert.equal(a.turnTo, 14);
  assert.match(anchorText(a), /窗口 11-03 轮 12–14（8c971ac7）/);
});

test('窗口锚点：抽取事实经 episode 解析', () => {
  const eps = new Map([['ep-2026-11-01-9ca88752-25', {
    id: 'ep-2026-11-01-9ca88752-25',
    sessionId: 'session-9ca88752-fb27-43f5-a789-7d2191a81fc3',
    turnFrom: 25,
    turnTo: 36,
    atFrom: '2026-11-01T06:25:00.000Z'
  }]]);
  const fact = { id: 'h-ep-1', source: { model: 'episode', episodeId: 'ep-2026-11-01-9ca88752-25' }, saidAt: Date.parse('2026-11-01T06:25:00Z') };
  const a = anchorOf(fact, eps);
  assert.equal(a.kind, 'episode');
  assert.equal(a.turnFrom, 25);
  assert.equal(a.turnTo, 36);
  assert.match(anchorText(a), /轮 25–36/);
});

test('窗口锚点：没有来源返回 null，不硬编', () => {
  assert.equal(anchorOf({ id: 'x', source: { model: 'episode', episodeId: 'missing' } }, new Map()), null);
  assert.equal(anchorOf({ id: 'x', src: { kind: 'log', day: '2026-11-01' } }), null);
});

test('行格式：旧事标注、自己写的、锚点、原话', () => {
  const eps = new Map();
  const line = rowLine({
    tier: 'hard',
    score: 91,
    label: '生日',
    value: '2007 年 9 月 5 日',
    expired: true,
    saidAt: Date.parse('2026-11-04T01:00:00Z'),
    author: 'extract',
    quote: '我生日是九月五号'
  }, { eps });
  assert.match(line, /旧事 · 11-04/);
  assert.match(line, /└ 原话：我生日是九月五号/);

  const selfLine = rowLine({
    tier: 'long', score: 74, value: '以后记忆都自己写', author: 'self',
    src: { kind: 'window', sessionId: 'session-8c971ac7', turnFrom: 21, turnTo: 21 },
    saidAt: Date.parse('2026-11-03T14:00:00Z')
  }, { eps });
  assert.match(selfLine, /〔自己写的〕/);
  assert.match(selfLine, /⟵ 窗口 11-03 轮 21（8c971ac7）/);
});

test('formatRecallBody：统计锚点并保留旧日志来源', () => {
  const eps = new Map([['ep-1', { id: 'ep-1', sessionId: 'session-a04e9728', turnFrom: 40, turnTo: 43, atFrom: '2026-10-29T11:10:00Z' }]]);
  const rows = [
    { tier: 'long', score: 80, value: '傅里叶', source: { model: 'episode', episodeId: 'ep-1' }, saidAt: Date.parse('2026-10-29T11:10:00Z') },
    { tier: 'general', score: 60, value: '旧日志里的事', src: { kind: 'log', day: '2026-11-02' } }
  ];
  const out = formatRecallBody(rows, { eps });
  assert.equal(out.anchors, 1);
  assert.match(out.body, /⟵ 窗口 10-29 轮 40–43（a04e9728）/);
  assert.match(out.body, /⟵ 原文 11-02/);
});

test('诊断：过期命中 + 词面相近 + 路由解释', () => {
  const facts = [
    { id: 'a', status: 'active', expired: true, slot: 'birthday', about: 'user', value: '旧生日记录', saidAt: Date.parse('2026-10-29T00:00:00Z') },
    { id: 'b', status: 'active', expired: false, slot: 'note', about: 'user', value: '生日蛋糕买小了', saidAt: Date.parse('2026-11-01T00:00:00Z') },
    { id: 'c', status: 'invalidated', slot: 'birthday', about: 'user', value: '作废的生日', saidAt: Date.parse('2026-10-01T00:00:00Z') }
  ];
  const diag = diagnoseRecall({ query: '用户什么时候过生日', facts, now });
  assert.equal(diag.activeTotal, 2);
  assert.equal(diag.expired.length, 1);
  assert.equal(diag.expired[0].when, '10-29');
  assert.equal(diag.near.length, 1);
  assert.match(diag.routeLine, /槽位 birthday/);
  assert.match(diag.routeLine, /问的是用户/);

  const text = emptyRecallText({ query: '用户什么时候过生日', diag });
  assert.match(text, /没有「用户什么时候过生日」的直接记录/);
  assert.match(text, /相关但已过期/);
  assert.match(text, /词面相近/);
  assert.match(text, /qq_memory_window/);
});

test('诊断：什么都不沾时给出下一步且不强行解释', () => {
  const diag = diagnoseRecall({ query: '完全不存在的词', facts: [], now });
  assert.equal(diag.activeTotal, 0);
  const text = emptyRecallText({ query: '完全不存在的词', diag });
  assert.match(text, /qq_memory_search/);
  assert.match(text, /直接说没记过/);
});
