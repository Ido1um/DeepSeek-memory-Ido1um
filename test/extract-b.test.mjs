import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classify, recordInbound } from '../src/scoring-runner.mjs';
import * as lt from '../src/longterm.mjs';

function tmpDir(tag = 'extract-b-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

const one = (text) => {
  const { candidates } = classify(text);
  return candidates[0];
};

test('抽取B：备注按内容去噪做键，「记住…」与「别忘了…要…」认成同一条', () => {
  const a = one('记住明天交物理报告');
  const b = one('别忘了明天要交物理报告');
  assert.equal(a.pattern, 'note');
  assert.equal(a.sig, b.sig);
  assert.ok(a.due, '应解析出日期');
});

test('抽取B：「记住…呢」是叮嘱不是疑问句，纯提问仍然跳过', () => {
  const t1 = '记住我下周三要交报告呢';
  const r1 = classify(t1);
  assert.equal(r1.signals.question, true, '该句确实带疑问语气');
  assert.equal(r1.candidates.length, 1, '但不该被疑问句规则吞掉');
  assert.equal(r1.candidates[0].sig.startsWith('user:note:'), true);

  const r2 = classify('我明天要交报告吗？');
  assert.equal(r2.candidates.length, 0);
});

test('抽取B：偏好按对象分主题，反话不会被记成正向', () => {
  const like = one('我喜欢吃香菜');
  const hate = one('我不吃香菜');
  assert.equal(like.class, 'pref');
  assert.equal(like.tier, 'general');
  assert.notEqual(like.sig, hate.sig, '喜欢与不喜欢是两条');
  assert.equal(hate.label, '不喜欢');
  assert.match(hate.topic, /pref:不喜欢:香菜/);
  assert.match(like.topic, /pref:喜欢:香菜/);

  // 代词/半句话不进候选
  assert.equal(classify('我喜欢你这个说法').candidates.length, 0);
  assert.equal(classify('我不太喜欢这样').candidates.length, 0);
});

test('抽取B：只有日期 + 动作词才记待办，泛泛的「明天要吃饭」不算', () => {
  const due = one('周五要交报告');
  assert.equal(due.pattern, 'task');
  assert.equal(due.class, 'task');
  assert.equal(due.task, true);
  assert.ok(due.dueAt > Date.now());
  assert.match(due.topic, /^user:task:\d{4}-\d{2}-\d{2}$/);

  assert.equal(classify('明天要吃饭').candidates.length, 0);
  assert.equal(classify('最近好忙').candidates.length, 0);
});

test('抽取B：在学/宠物映射到属性主题，两只宠物不是同一条', () => {
  const skill = one('我在学日语');
  assert.equal(skill.pattern, '在学');
  assert.match(skill.topic, /^user:skill/);

  const cat = one('我养了一只猫');
  const dog = one('我养了一只狗');
  assert.equal(cat.pattern, '宠物');
  assert.equal(cat.value, '猫');
  assert.match(cat.topic, /^user:pet:猫/);
  assert.notEqual(cat.sig, dog.sig);
});

test('抽取B：换用新备注键后仍能认回整句哈希写下的老事实', () => {
  const dir = tmpDir();
  const text = '记住下周三要交周报';
  const c = one(text);
  assert.ok(c.legacySig, '应给出老键');
  const ts = Date.now() - 86400000;

  lt.appendEvent(
    {
      ev: 'fact',
      id: 'h-legacy',
      sig: c.legacySig,
      key: 'private:1',
      about: 'user',
      pattern: 'note',
      label: '备注',
      value: text,
      text,
      quote: text,
      topic: 'user:note:legacy',
      class: 'note',
      tier: 'general',
      I: 0.8,
      s: 30,
      hits: 1,
      lastAt: ts,
      at: ts
    },
    dir
  );

  const r = recordInbound({
    key: 'private:1',
    text,
    ts,
    scoring: { mode: 'write' },
    dir
  });
  assert.equal(r.added.length, 0, '不应新建重复事实');
  assert.equal(r.mentioned.length, 1, '应记一次提及');
  assert.equal(r.mentioned[0].id, 'h-legacy');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('假待办：元讨论 / 疑问句 / 过去的日期都不生成 task', () => {
  const meta = classify('貌似记忆又有点混乱，是不是要给你加上时间戳，复习傅立叶和拉普拉斯是上个星期四的事了');
  assert.equal(meta.candidates.some((c) => c.task), false, '元讨论不该变待办');

  const past = classify('上个星期四交的报告');
  assert.equal(past.candidates.filter((c) => c.task).length, 0, '过去的日期不是待办');

  const real = classify('下周三要交报告');
  assert.ok(real.candidates.some((c) => c.task), '真正的待办仍要抽出来');
});
