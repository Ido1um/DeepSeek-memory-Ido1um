// v8 批 1：溯源字段（quote / topic / source）+ 版本链（supersede）
// 铁律：`versioning` 不传 = 关闭。关闭时行为与今天一致（改口不会覆盖旧值）。
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { topicOf } from '../src/facts.mjs';
import * as lt from '../src/longterm.mjs';
import { classify, recordInbound, search } from '../src/scoring-runner.mjs';

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

function factEvent(over = {}) {
  const at = over.at || Date.now();
  return {
    ev: 'fact',
    id: over.id || lt.newId('h'),
    sig: over.sig || 'user:生日',
    key: 'private:10001',
    about: over.about || 'user',
    pattern: over.pattern || '生日',
    label: over.label || '生日',
    value: over.value || '9月5日',
    text: over.text || '我生日是 9 月 5 日',
    quote: over.quote,
    topic: over.topic,
    source: over.source,
    tier: over.tier || 'hard',
    I: 1,
    s: null,
    hits: 1,
    lastAt: at,
    at
  };
}

test('topicOf：中文 label 归一成英文主题；非属性类按 sig 独立', () => {
  assert.equal(topicOf('', { about: 'user', pattern: '生日' }), 'user:birthday');
  assert.equal(topicOf('', { about: 'user', pattern: '名字' }), 'user:name');
  assert.equal(topicOf('', { about: 'bot', pattern: '称呼' }), 'bot:nickname');
  assert.equal(topicOf('', { about: 'user', pattern: '住处' }), 'user:residence');
  assert.equal(topicOf('', { about: 'user', pattern: '工作' }), 'user:job');
  // 普通备注不共享主题，避免两条不同待办被合并
  assert.equal(topicOf('', { about: 'user', pattern: 'note', sig: 'user:note:abc123' }), 'user:note:abc123');
});

test('classify：硬事实带 quote 与归一主题', () => {
  const { candidates } = classify('我生日是 9 月 5 日');
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.sig, 'user:生日');
  assert.equal(c.topic, 'user:birthday');
  assert.ok(c.quote.includes('生日'));
});

test('classify：备注类带 quote，topic 跟 sig 走', () => {
  // 抽取B 起：「记住我不吃香菜」命中偏好，落成 pref 主题（偏好对象可被检索/干扰计算）
  const { candidates } = classify('记住我不吃香菜');
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].quote.includes('香菜'));
  assert.ok(candidates[0].topic.startsWith('user:pref:'));
});

test('classify：普通叮嘱仍是备注，topic 跟 sig 走', () => {
  const { candidates } = classify('记住那把备用钥匙在抽屉里');
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].topic.startsWith('user:note:'));
});

test('materialize：保留 quote / topic / source，老行缺字段不炸', () => {
  const dir = tmpDir();
  lt.appendEvent(factEvent({ quote: '我生日是 9 月 5 日', topic: 'user:birthday', source: { id: 12345 } }), dir);
  const legacy = factEvent({ id: 'h-legacy-1', sig: 'user:名字', pattern: '名字', label: '名字', value: '助手' });
  delete legacy.quote;
  delete legacy.topic;
  delete legacy.source;
  lt.appendEvent(legacy, dir);

  const rows = lt.readEvents(dir).rows;
  assert.equal(rows.length, 2);
  const m = lt.materialize(rows, lt.readInvalidated(dir));
  const birthday = m.find((f) => f.sig === 'user:生日');
  const legacyRow = m.find((f) => f.sig === 'user:名字');
  assert.equal(birthday.quote, '我生日是 9 月 5 日');
  assert.equal(birthday.topic, 'user:birthday');
  assert.deepEqual(birthday.source, { id: 12345 });
  assert.equal(legacyRow.quote, '');
  assert.equal(legacyRow.topic, '');
  assert.equal(legacyRow.source, null);
  assert.equal(legacyRow.versions, 1);
});

test('versioning 关闭（默认）：改口只加提及，旧值不变', () => {
  const dir = tmpDir();
  const ts = Date.now();
  recordInbound({ key: 'private:10001', text: '我生日是 9 月 5 日', ts, scoring: { mode: 'write' }, dir });
  recordInbound({ key: 'private:10001', text: '我生日 3 月 15 日', ts: ts + 1000, scoring: { mode: 'write' }, dir });

  const out = search({ query: '生日', dir, scoring: { mode: 'write' } });
  assert.equal(out.length, 1);
  assert.equal(out[0].value.replace(/\s+/g, ''), '9月5日');
  assert.equal(out[0].versions, 1);
});

test('versioning 打开：改口写入 supersede，检索拿到新值 + 版本数', () => {
  const dir = tmpDir();
  const ts = Date.now();
  recordInbound({ key: 'private:10001', text: '我生日是 9 月 5 日', ts, scoring: { mode: 'write', versioning: true }, dir });
  recordInbound({ key: 'private:10001', text: '我生日 3 月 15 日', ts: ts + 1000, scoring: { mode: 'write', versioning: true }, dir });

  const events = lt.readEvents(dir).rows;
  assert.ok(events.some((e) => e.ev === 'supersede'), '应当写入 supersede 事件');

  const out = search({ query: '生日', dir, scoring: { mode: 'write', versioning: true } });
  assert.equal(out.length, 1);
  assert.equal(out[0].value.replace(/\s+/g, ''), '3月15日');
  assert.equal(out[0].versions, 2);
});

test('versioning 打开：同值重复提及不会刷版本号', () => {
  const dir = tmpDir();
  const ts = Date.now();
  recordInbound({ key: 'k', text: '我生日是 9 月 5 日', ts, scoring: { mode: 'write', versioning: true }, dir });
  recordInbound({ key: 'k', text: '我生日是 9 月 5 日', ts: ts + 1000, scoring: { mode: 'write', versioning: true }, dir });

  const out = search({ query: '生日', dir, scoring: { mode: 'write', versioning: true } });
  assert.equal(out.length, 1);
  assert.equal(out[0].versions, 1);
});

test('版本链不合并不同主题的待办', () => {
  const dir = tmpDir();
  const ts = Date.now();
  recordInbound({ key: 'k', text: '记住我要交物理实验报告', ts, scoring: { mode: 'write', versioning: true }, dir });
  recordInbound({ key: 'k', text: '记住买牛奶回家', ts: ts + 1000, scoring: { mode: 'write', versioning: true }, dir });

  const out = search({ dir, scoring: { mode: 'write', versioning: true } });
  assert.equal(out.length, 2);
  assert.equal(new Set(out.map((r) => r.sig)).size, 2);
});
