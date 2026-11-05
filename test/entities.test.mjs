import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, mergeEntities, normalizeEntities, entitiesLine } from '../src/entities.mjs';

test('extractEntities：人名/机构/地名各自收', () => {
  const e = extractEntities('用户 2007 年 9 月 5 日生，示例省份人，高考考入示例学院核科学与技术学院应用物理');
  assert.deepEqual(e.people, ['用户']);
  assert.ok(e.orgs.includes('示例学院'));
  assert.ok(e.places.includes('示例省份'));
});

test('extractEntities：华光 / 示例城市 / 亲戚', () => {
  const e = extractEntities('亲戚是华光网安毕业的，用户在示例城市上学');
  assert.ok(e.orgs.includes('华光'));
  assert.ok(e.places.includes('示例城市'));
});

test('extractEntities：全空返回 null，不写空对象', () => {
  assert.equal(extractEntities('今晚把傅里叶和拉普拉斯都看完'), null);
  assert.equal(extractEntities(''), null);
});

test('mergeEntities：去重且保序', () => {
  const m = mergeEntities({ people: ['用户'], places: ['示例城市'] }, { people: ['用户', '妈妈'], places: ['示例省份'] });
  assert.deepEqual(m.people, ['用户', '妈妈']);
  assert.deepEqual(m.places, ['示例城市', '示例省份']);
});

test('normalizeEntities：过滤脏值/非数组/超长', () => {
  assert.equal(normalizeEntities(null), null);
  assert.equal(normalizeEntities({ people: '用户' }), null);
  const n = normalizeEntities({ people: ['  用户  ', '', '用户', 'x'.repeat(40)], orgs: ['华光'] });
  assert.equal(n.people[0], '用户');
  assert.equal(n.people.length, 2);
  assert.ok(n.people.every((x) => x.length <= 24));
  assert.deepEqual(n.orgs, ['华光']);
});

test('entitiesLine：给卡片/工作台的一行摘要', () => {
  assert.equal(entitiesLine({ people: ['用户'], orgs: ['华光'], places: ['示例城市'] }), '人：用户；机构：华光；地：示例城市');
  assert.equal(entitiesLine(null), '');
});
