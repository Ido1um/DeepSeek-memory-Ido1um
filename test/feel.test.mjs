import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize } from '../src/longterm.mjs';
import { feelOf } from '../src/facts.mjs';

const fact = (id, extra = {}) => ({ ev: 'fact', id, value: '首次：画画', about: 'bot', pattern: 'first', class: 'event', tier: 'long', at: 1000, ...extra });

test('feel：事件挂到事实，取最新一条', () => {
  const evs = [
    fact('h1'),
    { ev: 'feel', id: 'h1', fact: 'h1', feel: '手生', at: 2000 },
    { ev: 'feel', id: 'h1', fact: 'h1', feel: '笔不利索', at: 3000 }
  ];
  const [f] = materialize(evs, {});
  assert.equal(f.feels.length, 2);
  assert.equal(f.feels[f.feels.length - 1].feel, '笔不利索');
});

test('feel：同一条重复写不会堆叠', () => {
  const evs = [fact('h1'), { ev: 'feel', id: 'h1', feel: '手生', at: 2000 }, { ev: 'feel', id: 'h1', feel: '手生', at: 3000 }];
  assert.equal(materialize(evs, {})[0].feels.length, 1);
});

test('feel：挂到不存在的事实上不崩、也不产生条目', () => {
  const evs = [{ ev: 'feel', id: 'nope', feel: '手生', at: 2000 }];
  assert.equal(materialize(evs, {}).length, 0);
});

test('feel：超过 40 字截断', () => {
  const long = '手'.repeat(80);
  const evs = [fact('h1'), { ev: 'feel', id: 'h1', feel: long, at: 2000 }];
  assert.equal(materialize(evs, {})[0].feels[0].feel.length, 40);
});

test('feelOf：只取原文子串、太短或疑问句不取', () => {
  assert.equal(feelOf('唔……第一次画手生，我加了细节又画一张'), '第一次画手生');
  assert.equal(feelOf('那次手很紧张，怕它不出声'), '那次手很紧张');
  assert.equal(feelOf('今天天气不错'), '');
  assert.equal(feelOf('手生'), '');
});
