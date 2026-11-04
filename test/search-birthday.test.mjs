import test from 'node:test';
import assert from 'node:assert/strict';

import { search } from '../src/scoring-runner.mjs';

function fact(over = {}) {
  return {
    id: over.id,
    status: 'active',
    about: over.about || 'user',
    class: over.class || 'fact',
    tier: over.tier || 'hard',
    I: 1,
    hits: 1,
    lastAt: Date.now() - 86400000,
    label: over.label || '内容',
    sig: over.id,
    ...over
  };
}

const FACTS = [
  fact({
    id: 'bd-owner',
    topicId: 't-identity',
    slot: 'birthday',
    about: 'user',
    value: '用户 2007 年 9 月 5 日生，示例省份人',
    text: '用户 2007 年 9 月 5 日生，示例省份人',
    birthday: { y: 2007, m: 9, d: 5, key: '09-05', yearly: true, who: 'owner' }
  }),
  fact({
    id: 'bd-bot',
    topicId: 't-bot',
    slot: 'birthday',
    about: 'bot',
    value: '助手生日是3月15日',
    text: '助手生日是3月15日',
    birthday: { y: 0, m: 3, d: 15, key: '03-15', yearly: true, who: 'bot' }
  }),
  fact({
    id: 'born-other',
    topicId: 't-identity',
    slot: 'birthday',
    about: 'user',
    value: '小助手生日 2023 年 3 月 15 日（发布日）',
    text: '小助手生日 2023 年 3 月 15 日（发布日）',
    birthday: { y: 2023, m: 3, d: 15, key: '03-15', yearly: true, who: 'bot' }
  }),
  fact({ id: 'other', topicId: 't-photo', slot: 'gear', value: 'Z8X 配 2875ZA', text: 'Z8X 配 2875ZA', tier: 'long' })
];

test('问「生日」时，用户那条即使文案里没有「生日」两个字也能被找出来', () => {
  const rows = search({ query: '用户什么时候过生日', facts: FACTS, limit: 5 });
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].id, 'bd-owner');
  assert.equal(rows[0].birthday.key, '09-05');
});

test('问「生日」时只返回生日槽位，不把器材带进来', () => {
  const rows = search({ query: '生日', facts: FACTS, limit: 10 });
  assert.deepEqual(rows.map((r) => r.id).sort(), ['bd-bot', 'bd-owner', 'born-other']);
});

test('不问生日时，槽位兜底不生效（保持原检索行为）', () => {
  const rows = search({ query: 'Z8X', facts: FACTS, limit: 5 });
  assert.deepEqual(rows.map((r) => r.id), ['other']);
});
