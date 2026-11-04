import test from 'node:test';
import assert from 'node:assert/strict';

import { extractHardFacts } from '../src/facts.mjs';
import { validateCandidate, candidateToEvent } from '../src/extract-model.mjs';

const msgs = [
  { text: '我在学校的融媒体部门里面' },
  { text: '我在学吉他，刚开始两个月' },
  { text: '这是我的相机' },
  { text: '我的相机是Z8X和2875ZA，还有一颗示例镜头厂100-400mm长焦' }
];
const ctx = { messages: msgs, now: Date.parse('2026-11-02T12:00:00+08:00') };

const cand = (over) => ({
  kind: 'fact',
  about: 'user',
  subject: '我',
  topic: 'user:hobby',
  value: '摄影',
  quote: '这是我的相机',
  confidence: 0.8,
  ...over
});

test('规则抽取：在学校不算技能', () => {
  const facts = extractHardFacts('我在学校的融媒体部门里面');
  assert.equal(facts.filter((f) => f.key === 'skill').length, 0);
});

test('规则抽取：在学吉他仍能抽到技能', () => {
  const facts = extractHardFacts('我在学吉他');
  const skill = facts.find((f) => f.key === 'skill');
  assert.ok(skill, '应抽到 skill');
  assert.equal(skill.value, '吉他');
});

test('模型抽取：摄影记成 hobby 能过门', () => {
  const r = validateCandidate(cand({}), ctx);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.candidate.topic, 'user:hobby');
  assert.equal(r.candidate.class, 'pref');
});

test('模型抽取：器材记成 gear 能过门（值可到 24 字）', () => {
  const r = validateCandidate(
    cand({ topic: 'user:gear', value: 'Z8X相机和2875ZA镜头', quote: '我的相机是Z8X和2875ZA，还有一颗示例镜头厂100-400mm长焦', confidence: 0.85 }),
    ctx
  );
  assert.equal(r.ok, true, r.reason);
});

test('模型抽取：摄影写进 pet 仍被挡', () => {
  const r = validateCandidate(cand({ topic: 'user:pet', value: 'Z8X相机和2875ZA镜头', quote: '我的相机是Z8X和2875ZA，还有一颗示例镜头厂100-400mm长焦' }), ctx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'attr');
});

test('模型抽取：生日必须带日期', () => {
  const r = validateCandidate(cand({ topic: 'user:birthday', value: '很久以前', quote: '这是我的相机' }), ctx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'attr');
});

test('模型抽取：爱好超过 10 字被挡', () => {
  const r = validateCandidate(cand({ value: '非常非常喜欢摄影和骑车还有爬山' }), ctx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'attr');
});

test('写事件：hobby/gear 落 long 档、sig 带值哈希可多件共存', () => {
  const a = validateCandidate(cand({}), ctx).candidate;
  const b = validateCandidate(cand({ value: '骑摩托' }), ctx).candidate;
  const ea = candidateToEvent(a, { now: ctx.now });
  const eb = candidateToEvent(b, { now: ctx.now });
  assert.equal(ea.tier, 'long');
  // 模型抽取路径（candidateToEvent）的 I 不经过 A6 缩放
  assert.equal(ea.I, 0.85);
  assert.equal(ea.label, '爱好');
  assert.notEqual(ea.sig, eb.sig);
  assert.match(ea.sig, /^user:hobby:/);

  const g = validateCandidate(cand({ topic: 'user:gear', value: 'Z8X相机和2875ZA镜头', quote: '我的相机是Z8X和2875ZA，还有一颗示例镜头厂100-400mm长焦' }), ctx).candidate;
  const eg = candidateToEvent(g, { now: ctx.now });
  assert.equal(eg.tier, 'long');
  assert.equal(eg.label, '器材');
});

test('写事件：生日仍进 hard', () => {
  const c = validateCandidate(cand({ topic: 'user:birthday', value: '9月5日' }), ctx).candidate;
  const e = candidateToEvent(c, { now: ctx.now });
  assert.equal(e.tier, 'hard');
  // 同上：模型候选自带 I=1
  assert.equal(e.I, 1);
});
