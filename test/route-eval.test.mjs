/**
 * 3.1 P1：20 条问法评测集（离线、合成事实、不读生产数据）。
 *
 * 目的不是「证明模型聪明」，而是锁住路由行为：
 *   - 整句问法要能落到槽位/主题
 *   - 主体要分清用户 vs 她
 *   - 过期事实排在同槽位在期事实之后
 * 20 条全部通过才算 P1 验收线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/scoring-runner.mjs';

const NOW = Date.parse('2026-11-05T12:00:00+08:00');

function fact(o) {
  return {
    id: o.id,
    tier: o.tier || 'general',
    class: o.class || 'fact',
    text: o.text || o.value,
    value: o.value,
    label: o.label || '',
    sig: o.sig || `sig:${o.id}`,
    pattern: o.pattern || 'x',
    status: 'active',
    about: o.about || 'user',
    slot: o.slot || '',
    topicId: o.topicId || '',
    I: o.I ?? 0.7,
    s: o.s ?? 3,
    hits: 1,
    badHits: 0,
    lastAt: o.at || NOW,
    at: o.at || NOW,
    createdAt: o.at || NOW,
    quote: o.quote || '',
    expired: Boolean(o.expired)
  };
}

const FACTS = [
  fact({ id: 'birth-owner', slot: 'birthday', topicId: 't-identity', about: 'user', tier: 'hard', value: '生日是2007年9月5日', text: '用户生日：2007年9月5日，示例省份人', I: 1 }),
  fact({ id: 'birth-bot', slot: 'birthday', topicId: 't-bot', about: 'bot', tier: 'long', value: '生日是2023年3月15日', text: '助手生日：2023年3月15日', I: 0.8 }),
  fact({ id: 'gear-a7r3', slot: 'gear', topicId: 't-photo', about: 'user', tier: 'long', value: 'Z8X配2875ZA，备用56F1.4', text: '摄影器材：索尼Z8X机身，配24-70GM与56F1.4', I: 0.8 }),
  fact({ id: 'photo-pref', slot: 'pref', topicId: 't-photo', about: 'user', tier: 'general', value: '喜欢拍月亮和夜景', text: '摄影偏好：喜欢拍月亮堆栈和城市夜景' }),
  fact({ id: 'game-edition', slot: 'edition', topicId: 't-horizon6', about: 'user', tier: 'long', value: '极速谷系列每代都买顶级版', text: '极速谷6预购的顶级版，4和5也买顶级' }),
  fact({ id: 'game-pref', slot: 'pref', topicId: 't-horizon6', about: 'user', tier: 'general', value: '最喜欢原厂示例车厂GT9RS', text: '极速谷里最喜欢的车是原厂示例车厂GT9RS，喜欢财富岛极光' }),
  fact({ id: 'hust-intel', slot: 'intel', topicId: 't-hust', about: 'user', tier: 'long', value: '081200拟招49人（含推免），初试101/201/301/832', text: '华光081200情报：拟招49/学院307，初试101/201/301/832，不招同等学力' }),
  fact({ id: 'baoyan-stance', slot: 'stance', topicId: 't-baoyan', about: 'user', tier: 'general', value: '考研示例学院示例专业，大概率进示例单位', text: '考研：示例学院示例专业，大概率去示例单位，一眼望到头但不反感' }),
  fact({ id: 'nick-owner', slot: 'nickname', topicId: 't-identity', about: 'user', tier: 'hard', value: '称呼为用户或小助手', text: '用户称呼：用户/小助手' }),
  fact({ id: 'nick-bot', slot: 'nickname', topicId: 't-bot', about: 'bot', tier: 'long', value: '小名小助手，自称我', text: '助手小名小助手，自称我' }),
  fact({ id: 'course-fri', slot: 'course', topicId: 't-study', about: 'user', tier: 'general', value: '周五早八示例基础课，示例楼A507', text: '课表：周五早八示例基础课，示例楼A507' }),
  fact({ id: 'progress-fourier', slot: 'progress', topicId: 't-study', about: 'user', tier: 'general', value: '复习到傅里叶变换', text: '复习进度：数学物理方法复习到傅里叶变换' }),
  fact({ id: 'us-birthday', slot: 'stance', topicId: 't-us', about: 'user', tier: 'general', value: '一起过的第一个生日', text: '我们之间：一起过的第一个生日，她做了长寿面' }),
  fact({ id: 'residence', slot: 'residence', topicId: 't-identity', about: 'user', tier: 'long', value: '示例省份人', text: '籍贯：示例省份' }),
  fact({ id: 'pet-cat', slot: 'pet', topicId: 't-identity', about: 'user', tier: 'general', value: '养了一只猫', text: '宠物：养了一只叫团子的猫' }),
  fact({ id: 'food-pref', slot: 'pref', topicId: 't-food', about: 'user', tier: 'general', value: '爱吃大米饭和酸奶', text: '口味：爱吃大米饭、百合味酸奶' }),
  fact({ id: 'plan-expired', slot: 'plan', topicId: 't-study', about: 'user', tier: 'general', value: '今晚看完傅里叶和拉普拉斯', text: '计划：今晚看完傅里叶和拉普拉斯，说的是10月29日', expired: true, at: Date.parse('2026-10-29T12:00:00+08:00') }),
  fact({ id: 'plan-live', slot: 'plan', topicId: 't-study', about: 'user', tier: 'general', value: '周末复习拉普拉斯变换', text: '计划：这个周末复习拉普拉斯变换' })
];

/** 20 条：问法 → 期望 top1（或 topN 内的 id）。 */
const CASES = [
  ['用户什么时候过生日', 'birth-owner'],
  ['我生日是哪天', 'birth-owner'],
  ['助手的生日是哪天', 'birth-bot'],
  ['我的相机是什么型号', 'gear-a7r3'],
  ['摄影器材都有哪些', 'gear-a7r3'],
  ['我拍照喜欢拍什么', 'photo-pref'],
  ['极速谷6我买的是哪个版本', 'game-edition'],
  ['极速谷里我最喜欢什么车', 'game-pref'],
  ['华光考研初试考什么', 'hust-intel'],
  ['081200招多少人', 'hust-intel'],
  ['考研的事怎么样了', 'baoyan-stance'],
  ['用户怎么称呼', 'nick-owner'],
  ['助手小名是什么', 'nick-bot'],
  ['周五早八在哪上课', 'course-fri'],
  ['我现在复习到哪了', 'progress-fourier'],
  ['我们之间有什么难忘的事', 'us-birthday'],
  ['我老家在哪', 'residence'],
  ['我养了什么宠物', 'pet-cat'],
  ['我爱吃什么', 'food-pref'],
  ['周末复习计划', 'plan-live']
];

for (const [query, want] of CASES) {
  test(`eval: ${query} → ${want}`, () => {
    const rows = search({ query, facts: FACTS, now: NOW, limit: 3, match: 'smart' });
    assert.ok(rows.length > 0, `「${query}」应有结果`);
    assert.equal(rows[0].id, want, `「${query}」top1=${rows[0].id}，期望 ${want}`);
  });
}

test('过期事实排在同槽位在期事实之后', () => {
  const rows = search({ query: '复习计划', facts: FACTS, now: NOW, limit: 5, match: 'smart' });
  const live = rows.findIndex((r) => r.id === 'plan-live');
  const expired = rows.findIndex((r) => r.id === 'plan-expired');
  assert.ok(live >= 0);
  assert.ok(expired === -1 || live < expired, `live=${live} expired=${expired}`);
});
