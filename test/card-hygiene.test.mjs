// 事实卡合并规则（card-hygiene）单元测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanValue, balanced, nearDup, coverage, entityOf, toEntries, dedupeEntries,
  selectSingle, pruneCrossSlot, capEntries, tokensOf
} from '../src/card-hygiene.mjs';

const fact = (over = {}) => ({ id: 'x', value: 'v', tier: 'general', at: 1000, status: 'active', ...over });

test('card-hygiene：截断值去掉未闭合的括号尾巴', () => {
  assert.equal(balanced('助手（小名小助手'), false);
  assert.equal(cleanValue('助手（小名小助手'), '助手');
  assert.equal(cleanValue('助手（小名小助手）'), '助手（小名小助手）');
});

test('card-hygiene：记忆系统的技术噪声不进卡', () => {
  assert.equal(cleanValue('卡片上限2500字，采用7天热备加冷备份'), '');
  assert.equal(cleanValue('记忆方案定稿 v6.2，四档衰减'), '');
  assert.equal(cleanValue('喜欢拍火烧云和月亮'), '喜欢拍火烧云和月亮');
});

test('card-hygiene：叙事槽位的两字残句丢掉，名词槽位的短值保留', () => {
  assert.equal(cleanValue('画手', { slot: 'event' }), '');
  assert.equal(cleanValue('顶级版', { slot: 'edition' }), '顶级版');
  assert.equal(cleanValue('5060', { slot: 'gear' }), '5060');
});

test('card-hygiene：器材型号写法不同也算同一条（28-75 ZA ≡ 2875ZA）', () => {
  const a = 'Z8X配2875ZA，借ZVE10配100-400，备用56F1.4';
  const b = '索尼Z8X机身，配28-75 ZA和100-400镜头';
  assert.ok(nearDup(a, b), '应判为近似重复');
  const kept = dedupeEntries(toEntries([b, a]));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].value, a, '保留更完整的那条');
});

test('card-hygiene：近似重复不误合并不同事实', () => {
  assert.equal(nearDup('喜欢拍火烧云', '喜欢打篮球'), false);
  assert.ok(nearDup('Z8X 2875ZA', '索尼 Z8X，配 2875ZA 镜头'));
  assert.ok(tokensOf('配28-75 ZA和100-400镜头').has('2875za'));
});

test('card-hygiene：单值槽位选最完整的一条，而不是最新的一条', () => {
  const entries = toEntries(
    ['助手（小名小助手', '小助手正式名助手（沈：沉进海里；溟：深海），「小助手」是用户第一张身份卡上的名字，留作小名'],
    [fact({ at: 9000 }), fact({ at: 1000 })]
  );
  const v = selectSingle(entries);
  assert.match(v, /沉进海里/);
});

test('card-hygiene：跨槽位去重，偏好里复述器材的内容丢掉', () => {
  const pruned = pruneCrossSlot({
    gear: toEntries(['Z8X配2875ZA，借ZVE10配100-400']),
    pref: toEntries(['摄影（Z8X 相机、2875ZA 镜头、示例镜头厂 100-400mm 长焦）', '喜欢拍火烧云'])
  });
  assert.equal(pruned.gear.length, 1);
  assert.deepEqual(pruned.pref.map((e) => e.value), ['喜欢拍火烧云']);
});

test('card-hygiene：主体判定按句子主语而不是关键词出现', () => {
  assert.equal(entityOf('小助手正式名助手，用户叫哪个都行'), 'bot');
  assert.equal(entityOf('用户叫小助手小助手她会炸毛'), 'owner');
  assert.equal(entityOf('助手和用户都喜欢百合味酸奶'), 'mixed');
});

test('card-hygiene：多值封顶按 tier 优先', () => {
  const entries = toEntries(['一般事实一条', '硬事实一条', '一般事实二条'], [
    fact({ tier: 'general', at: 3000 }), fact({ tier: 'hard', at: 1000 }), fact({ tier: 'general', at: 2000 })
  ]);
  assert.deepEqual(capEntries(entries, 2).map((e) => e.value), ['硬事实一条', '一般事实一条']);
});

test('card-hygiene：覆盖度计算对短值不虚高', () => {
  assert.equal(coverage('', 'abc'), 0);
  assert.ok(coverage('Z8X', '索尼Z8X机身') >= 0.8);
});
