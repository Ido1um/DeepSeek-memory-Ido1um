// v8 批 2：记忆分类（rule/persona/identity/task/event/pref/note）+ 每类衰减 + 误召回降权
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classOf, detectSignals } from '../src/facts.mjs';
import { SCORING_DEFAULTS, stabilityOf } from '../src/score.mjs';
import * as lt from '../src/longterm.mjs';
import { classify, search } from '../src/scoring-runner.mjs';
import { buildCard } from '../src/card.mjs';

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8b-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

function factEvent(over = {}) {
  const at = over.at || Date.now();
  return {
    ev: 'fact',
    id: over.id || lt.newId('h'),
    sig: over.sig || 'user:note:aaa',
    key: 'private:10001',
    about: over.about || 'user',
    pattern: over.pattern || 'note',
    label: over.label || '备注',
    value: over.value || '随便说一句',
    text: over.text || '随便说一句',
    class: over.class || 'note',
    tier: over.tier || 'general',
    I: over.I ?? 0.8,
    s: over.s ?? 3,
    hits: 1,
    lastAt: at,
    at
  };
}

test('classOf：六类判定', () => {
  assert.equal(classOf('以后别叫我助手'), 'rule');
  assert.equal(classOf('你是助手，不是助手'), 'persona');
  assert.equal(classOf('昨天去了杭州西湖'), 'event');
  assert.equal(classOf('我喜欢草莓味酸奶'), 'pref');
  assert.equal(classOf('记住买牛奶回家'), 'note');
  assert.equal(classOf('记住下周一交报告', { dueAt: true }), 'task');
  assert.equal(classOf('我生日是 9 月 5 日', { hard: true }), 'identity');
});

test('stabilityOf：rule/persona/event 不衰减，pref 90 天，note 按档位', () => {
  assert.equal(stabilityOf({ tier: 'general', class: 'rule' }), Infinity);
  assert.equal(stabilityOf({ tier: 'general', class: 'persona' }), Infinity);
  assert.equal(stabilityOf({ tier: 'general', class: 'event' }), Infinity);
  assert.equal(stabilityOf({ tier: 'general', class: 'identity' }), Infinity);
  assert.equal(stabilityOf({ tier: 'general', class: 'pref' }), 90);
  assert.equal(stabilityOf({ tier: 'general', class: 'note' }), SCORING_DEFAULTS.halfLifeDays.general);
  assert.equal(stabilityOf({ tier: 'long', class: 'note' }), SCORING_DEFAULTS.halfLifeDays.long);
});

test('classify：规则类 / 备注类各自带 class', () => {
  const rule = classify('记住，以后不许熬夜').candidates[0];
  assert.equal(rule.class, 'rule');
  const note = classify('记住买牛奶回家').candidates[0];
  assert.equal(note.class, 'note');
  const task = classify('记住下周一交物理报告').candidates[0];
  assert.equal(task.class, 'task');
});

test('materialize：保留 class，老行默认 note', () => {
  const dir = tmpDir();
  lt.appendEvent(factEvent({ id: 'h-c1', class: 'rule', value: '以后不许叫我助手' }), dir);
  const legacy = factEvent({ id: 'h-c2', sig: 'user:note:bbb' });
  delete legacy.class;
  lt.appendEvent(legacy, dir);

  const m = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
  assert.equal(m.find((f) => f.id === 'h-c1').class, 'rule');
  assert.equal(m.find((f) => f.id === 'h-c2').class, 'note');
});

test('badHit：累计两次后检索降权（不删除）', () => {
  const dir = tmpDir();
  const now = Date.now();
  lt.appendEvent(factEvent({ id: 'h-good', sig: 'user:note:good', value: '买牛奶', text: '记住买牛奶', at: now - 100 }), dir);
  lt.appendEvent(factEvent({ id: 'h-bad', sig: 'user:note:bad', value: '买牛奶', text: '记住买牛奶', at: now - 200 }), dir);
  lt.appendEvent({ ev: 'badHit', id: 'h-bad', at: now }, dir);
  lt.appendEvent({ ev: 'badHit', id: 'h-bad', at: now }, dir);

  const out = search({ query: '牛奶', dir, scoring: { mode: 'write' } });
  const bad = out.find((r) => r.id === 'h-bad');
  const good = out.find((r) => r.id === 'h-good');
  assert.equal(bad.badHits, 2);
  assert.equal(bad.status, 'active'); // 只是降权，不删
  assert.ok(out.indexOf(good) < out.indexOf(bad), '被误召回两次的应排在后面');
});

test('事实卡：event 类不进卡', () => {
  const facts = [
    factEvent({ id: 'h-e1', class: 'event', value: '昨天去了杭州西湖', tier: 'general' }),
    factEvent({ id: 'h-e2', class: 'rule', value: '以后不许叫我助手', tier: 'general' })
  ];
  const built = buildCard(facts, { maxChars: 800, hardReserveChars: 100, botMaxChars: 100 });
  assert.ok(built.text.includes('助手'));
  assert.ok(!built.text.includes('杭州'), '事件类不该出现在卡里');
});

test('否定语境不算「要求记住」', () => {
  // 「无法记住发生过的所有事」里的「记住」不该生成备注事实
  assert.equal(classify('其实人类也无法记住发生过的所有事，那就过好每一个七天吧').candidates.length, 0);
  assert.equal(detectSignals('我记不住那么多').explicitRemember, false);
  assert.equal(detectSignals('记住我不吃香菜').explicitRemember, true);
});
