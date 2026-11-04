// 2026-11-02 四项修复的回归：在学 / 规则侧爱好器材 / 事件 TTL / 写入门放宽
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractHardFacts } from '../src/facts.mjs';
import { classify } from '../src/scoring-runner.mjs';
import { tierAfter, SCORING_DEFAULTS, DAY } from '../src/score.mjs';
import { writeGate } from '../src/gate.mjs';
import { validateCandidate } from '../src/extract-model.mjs';

test('在学：学校/学院 不算技能，真学才抽', () => {
  assert.deepEqual(extractHardFacts('我在学校的融媒体部门里面'), []);
  assert.deepEqual(extractHardFacts('我在学院值班'), []);
  const ok = extractHardFacts('我在学吉他');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].key, 'skill');
  assert.equal(ok[0].value, '吉他');
});

test('规则侧：爱好多值、走 long 档 0.85', () => {
  const facts = extractHardFacts('我平时玩摄影');
  assert.equal(facts.length, 1, JSON.stringify(facts));
  assert.equal(facts[0].key, 'hobby');
  assert.equal(facts[0].multi, true);

  const { candidates } = classify('我平时玩摄影');
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.tier, 'long');
  // A6：置信度缩放后 0.85 × (0.6+0.4×0.7) ≈ 0.75
  assert.equal(c.I, 0.75);
  assert.equal(c.class, 'pref');
  // 多值：sig 带值，第二件不会被当成同一条
  assert.match(c.sig, /:摄影$/);

  const { candidates: c2 } = classify('我平时玩骑车');
  assert.notEqual(c2[0].sig, c.sig);
});

test('规则侧：器材取型号片段', () => {
  const facts = extractHardFacts('我有一台Z8X相机');
  assert.equal(facts.length, 1, JSON.stringify(facts));
  assert.equal(facts[0].key, 'gear');
  assert.equal(facts[0].value, 'Z8X');

  const mine = extractHardFacts('我的相机是Z8X');
  assert.equal(mine[0].key, 'gear');
  assert.equal(mine[0].value, 'Z8X');
});

test('事件：7 天后过期，3 天内还在', () => {
  const now = Date.parse('2026-11-02T12:00:00+08:00');
  const mk = (daysAgo, extra = {}) => ({
    class: 'event',
    tier: 'general',
    since: now - daysAgo * DAY,
    lastAt: now - daysAgo * DAY,
    I: 0.7,
    hits: 1,
    ...extra
  });
  assert.equal(tierAfter(mk(3), now), 'general');
  assert.equal(tierAfter(mk(8), now), 'expired');
  // 单条可覆盖 ttl
  assert.equal(tierAfter(mk(8, { ttlDays: 30 }), now), 'general');
  // 默认值在配置里
  assert.equal(SCORING_DEFAULTS.eventTtlDays, 7);
  // 非事件不受影响（note 8 天没提会掉到临时，这是原有行为；这里只验证没被过期规则吃掉）
  assert.equal(tierAfter({ class: 'note', tier: 'general', lastAt: now - 8 * DAY, I: 0.8, hits: 1 }, now), 'temp');
});

test('写入门：备注 3 个字也放行（原来要 4 个）', () => {
  const ok = writeGate('记住喝热水', { class: 'note', value: '喝热水', about: 'user' });
  assert.equal(ok.ok, true);
  const thin = writeGate('记住喝', { class: 'note', value: '喝', about: 'user' });
  assert.equal(thin.reason, 'thin');
});

test('模型抽取：纯版本词当垃圾值拒绝', () => {
  const messages = [{ text: '这台是顶级版，用着还行' }];
  const base = {
    kind: 'note',
    about: 'user',
    subject: '我',
    topic: 'user:note',
    quote: '这台是顶级版，用着还行',
    confidence: 0.9
  };
  const junk = validateCandidate({ ...base, value: '顶级版' }, { messages, now: Date.now() });
  assert.equal(junk.ok, false);
  assert.equal(junk.reason, 'junk');

  const fine = validateCandidate({ ...base, value: '三年没坏过' }, { messages, now: Date.now() });
  assert.equal(fine.ok, true, JSON.stringify(fine));
});
