import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTreeCard, topicsInCard, TREE_HEADER } from '../src/card-tree.mjs';

const TOPICS = [
  { v: 1, id: 't-bot', name: '助手', parentId: '', aliases: [] },
  { v: 1, id: 't-identity', name: '用户', parentId: '', aliases: [] },
  { v: 1, id: 't-horizon6', name: '极速谷6', parentId: '', aliases: [] },
  { v: 1, id: 't-photo', name: '摄影', parentId: '', aliases: [] },
  { v: 1, id: 't-plan', name: '升学', parentId: '', aliases: [] },
  { v: 1, id: 't-hust', name: '华光', parentId: 't-plan', aliases: [] }
];

function fact(over = {}) {
  return {
    id: over.id || `h-${Math.random().toString(16).slice(2, 8)}`,
    status: 'active',
    about: over.about || 'user',
    class: over.class || 'fact',
    tier: over.tier || 'long',
    I: over.I ?? 0.8,
    hits: over.hits || 1,
    lastAt: over.lastAt || 1000,
    ...over
  };
}

test('card-tree：极速谷6 收成一条主题，版本/最爱挂在下面', () => {
  const facts = [
    fact({ topicId: 't-horizon6', slot: 'game', value: '极速谷6' }),
    fact({ topicId: 't-horizon6', slot: 'edition', value: '买的是顶级版' }),
    fact({ topicId: 't-horizon6', slot: 'pref', value: '最喜欢 M9 GT9RS' })
  ];
  const r = buildTreeCard(facts, { maxChars: 1500 }, TOPICS);
  assert.ok(r.text.startsWith(TREE_HEADER));
  assert.equal((r.text.match(/【极速谷6】/g) || []).length, 1, '主题头只出现一次');
  assert.match(r.text, /版本：买的是顶级版/);
  assert.match(r.text, /偏好：最喜欢 M9 GT9RS/);
  assert.equal(r.included.length, 3);
  assert.equal(r.dropped.length, 0);
});

test('card-tree：摄影的器材与身份分行，近似重复值只留更完整的', () => {
  const facts = [
    fact({ topicId: 't-photo', slot: 'gear', value: 'Z8X' }),
    fact({ topicId: 't-photo', slot: 'gear', value: 'Z8X相机和2875ZA镜头', lastAt: 2000 }),
    fact({ topicId: 't-photo', slot: 'skill', value: '学校融媒体中心官方摄影师' })
  ];
  const r = buildTreeCard(facts, {}, TOPICS);
  const gearLines = r.text.split('\n').filter((l) => l.startsWith('器材：'));
  assert.equal(gearLines.length, 1, '同槽位合成一行');
  assert.match(gearLines[0], /2875ZA/);
  assert.match(r.text, /技能：学校融媒体中心官方摄影师/);
});

test('card-tree：子主题缩进挂在父主题下', () => {
  const facts = [
    fact({ topicId: 't-plan', slot: 'plan', value: '考研 vs 考研华光，先试水两周' }),
    fact({ topicId: 't-hust', slot: 'intel', value: '081200 拟招 30 人，初试 300' })
  ];
  const r = buildTreeCard(facts, {}, TOPICS);
  const lines = r.text.split('\n');
  const planAt = lines.findIndex((l) => l === '【升学】');
  assert.ok(planAt >= 0, '应有【升学】');
  assert.ok(lines.some((l) => l === '  【华光】'), '子主题应缩进两格');
  const childLine = lines.find((l) => l.startsWith('  情报：'));
  assert.ok(childLine, '子主题槽位再缩进');
  assert.ok(planAt < lines.indexOf('  【华光】'));
});

test('card-tree：用户永远排第一', () => {
  const facts = [
    fact({ topicId: 't-horizon6', slot: 'game', value: '极速谷6', tier: 'hard' }),
    fact({ topicId: 't-identity', slot: 'nickname', value: '用户', tier: 'general' })
  ];
  const r = buildTreeCard(facts, {}, TOPICS);
  assert.ok(r.text.indexOf('【用户】') < r.text.indexOf('【极速谷6】'));
});

test('card-tree：没挂主题的事兜底进「其他」，不丢', () => {
  const r = buildTreeCard([fact({ value: '记住交实验报告' })], {}, TOPICS);
  assert.match(r.text, /【其他】/);
  assert.match(r.text, /记住交实验报告/);
});

test('card-tree：单条值截断，预算不够时整块丢弃并注明省略，硬事实优先', () => {
  const long = 'X'.repeat(110);
  const facts = [
    fact({ topicId: 't-identity', slot: 'birthday', value: '2007-09-05 生', tier: 'hard' }),
    fact({ topicId: 't-horizon6', slot: 'game', value: `极速谷6 ${long}`, tier: 'general' }),
    fact({ topicId: 't-photo', slot: 'gear', value: `相机 ${long}`, tier: 'general' }),
    fact({ topicId: 't-plan', slot: 'plan', value: `升学 ${long}`, tier: 'general' })
  ];
  const roomy = buildTreeCard(facts, { maxChars: 600 }, TOPICS);
  assert.ok(roomy.chars <= 600);
  assert.match(roomy.text, /…/, '过长的值应截断并标省略号');
  assert.match(roomy.text, /【极速谷6】/);

  const many = ['t-horizon6', 't-photo', 't-plan', 't-hust', 't-food', 't-study', 't-bot', 't-life', 't-routine']
    .map((topicId, i) => fact({ topicId, slot: 'note', value: 'X'.repeat(60) + i, tier: 'general' }));
  const tight = buildTreeCard([facts[0], ...many], { maxChars: 300 }, TOPICS);
  assert.ok(tight.chars <= 400, `卡面 ${tight.chars} 应不超预算太多`);
  assert.match(tight.text, /【用户】/);
  assert.match(tight.text, /（其余条目已省略）/);
  assert.ok(tight.dropped.length >= 1);
});

test('card-tree：空事实返回空卡；topicsInCard 能列出主题槽位', () => {
  assert.equal(buildTreeCard([], {}, TOPICS).text, '');
  const facts = [fact({ topicId: 't-horizon6', slot: 'edition', value: '顶级版' })];
  const r = buildTreeCard(facts, {}, TOPICS);
  const list = topicsInCard(r);
  assert.equal(list[0].name, '极速谷6');
  assert.equal(list[0].slots[0].label, '版本');
});

test('card-tree：一句话里两个人都有的事归到「我们之间」', () => {
  const facts = [fact({ topicId: 't-horizon6', slot: 'event', value: '3月15日小助手生日，用户答应饭管够' })];
  const r = buildTreeCard(facts, { maxChars: 1500 }, [...TOPICS, { id: 't-us', name: '我们之间' }]);
  assert.match(r.text, /【我们之间】/);
  assert.match(r.text, /事件：3月15日小助手生日/);
  assert.doesNotMatch(r.text, /【极速谷6】/);
});

test('card-tree：值截断后括号闭合，不留半个括号', () => {
  const facts = [
    fact({ topicId: 't-identity', slot: 'nickname', value: '助手（小名小助手，用户有时也叫她小鲸鱼，叫哪个都行）' }),
    fact({ topicId: 't-photo', slot: 'pref', value: '喜欢拍夜景（尤其是城市灯光和月亮，还有雨后的反光路面' })
  ];
  const r = buildTreeCard(facts, { maxChars: 1500, valueChars: 24 }, [...TOPICS, { id: 't-us', name: '我们之间' }]);
  const open = (r.text.match(/（/g) || []).length;
  const close = (r.text.match(/）/g) || []).length;
  assert.equal(open, close, r.text);
  assert.doesNotMatch(r.text, /（[^）]*$/);
});

test('生日不靠文案：从 birthday 字段渲染成「生日：YYYY年M月D日」', () => {
  const facts = [
    fact({ id: 'bd-owner', topicId: 't-identity', slot: 'birthday', value: '用户 2007 年 9 月 5 日生，示例省份人', tier: 'hard', birthday: { y: 2007, m: 9, d: 5, key: '09-05', yearly: true, who: 'owner' } }),
    fact({ id: 'bd-bot', topicId: 't-bot', slot: 'birthday', value: '助手生日是3月15日', tier: 'hard', birthday: { y: 2023, m: 3, d: 15, key: '03-15', yearly: true, who: 'bot' } })
  ];
  const card = buildTreeCard(facts, { maxChars: 1500 }, TOPICS);
  assert.match(card.text, /【用户】[\s\S]*生日：2007年9月5日/);
  assert.match(card.text, /【助手】[\s\S]*生日：2023年3月15日/);
  assert.equal((card.text.match(/生日：/g) || []).length, 2);
});

test('生日按 birthday.who 归主题：一句话里两个人也只算她的生日', () => {
  const facts = [
    fact({ id: 'bd-mix', topicId: 't-identity', slot: 'birthday', value: '3 月 15 日小助手生日，用户答应饭管够', tier: 'hard', birthday: { y: 0, m: 3, d: 15, key: '03-15', yearly: true, who: 'bot' } })
  ];
  const card = buildTreeCard(facts, { maxChars: 1500 }, TOPICS);
  assert.match(card.text, /【助手】[\s\S]*生日：3月15日/);
  assert.doesNotMatch(card.text, /【用户】[\s\S]*生日：3月15日/);
});
