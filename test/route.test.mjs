import test from 'node:test';
import assert from 'node:assert/strict';
import { routeQuery, routeScore } from '../src/route.mjs';

test('生日问法：槽位 birthday、主题 t-identity、主体 owner', () => {
  const r = routeQuery('用户什么时候过生日');
  assert.ok(r.slots.includes('birthday'));
  assert.ok(r.topics.includes('t-identity'));
  assert.equal(r.who, 'owner');
});

test('问她的生日：主体 bot', () => {
  const r = routeQuery('助手的生日是哪天');
  assert.ok(r.slots.includes('birthday'));
  assert.equal(r.who, 'bot');
});

test('器材问法：gear + 摄影主题', () => {
  const r = routeQuery('我相机是什么型号');
  assert.ok(r.slots.includes('gear'));
  assert.ok(r.topics.includes('t-photo'));
  assert.equal(r.who, 'owner');
});

test('游戏版本：edition + 极速谷主题', () => {
  const r = routeQuery('极速谷6我买的是哪个版本');
  assert.ok(r.slots.includes('edition'));
  assert.ok(r.topics.includes('t-horizon6'));
});

test('考研问法：升学/华光主题 + 情报槽位', () => {
  const r = routeQuery('华光考研初试考什么');
  assert.ok(r.topics.includes('t-hust'));
  assert.ok(r.topics.includes('t-plan'));
  assert.ok(r.slots.includes('intel') || r.slots.includes('plan'));
});

test('空问法不产生任何结构条件', () => {
  const r = routeQuery('');
  assert.deepEqual([r.slots.length, r.topics.length, r.tokens.length, r.who], [0, 0, 0, '']);
});

test('routeScore 对同主题/同槽位/主体分别给信号', () => {
  const route = routeQuery('用户什么时候过生日');
  const rs = routeScore({ slot: 'birthday', topicId: 't-identity', about: 'user', expired: false }, route);
  assert.equal(rs.slotHit, true);
  assert.equal(rs.topicHit, true);
  assert.equal(rs.whoHit, true);
  assert.equal(rs.expired, false);
});
