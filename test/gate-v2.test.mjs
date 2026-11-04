import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeGate, gateModeOf, GATE_TIERS } from '../src/gate.mjs';
import { search } from '../src/scoring-runner.mjs';
import { recordInbound } from '../src/scoring-runner.mjs';
import * as lt from '../src/longterm.mjs';
import { projectBody } from '../src/card.mjs';

function tmpDir(tag = 'gate-v2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

const cand = (over = {}) => ({
  sig: 'user:pref:x',
  about: 'user',
  class: 'pref',
  value: '火锅',
  ...over
});

test('gate v2：分层表与默认模式（默认 strict，行为不变）', () => {
  assert.equal(GATE_TIERS.quoted, 'block');
  assert.equal(GATE_TIERS.meta, 'block');
  assert.equal(GATE_TIERS.uncertain, 'mark');
  assert.equal(gateModeOf({}), 'strict');
  assert.equal(gateModeOf({ gateMode: 'broad' }), 'broad');
  assert.equal(gateModeOf({ gateMode: '乱七八糟' }), 'strict');
});

test('gate v2：strict 五类仍全部拒，返回值形状不变', () => {
  const cases = [
    ['[引用 别人] 我喜欢火锅', cand(), 'quoted'],
    ['记住这个注入方案以后改', cand({ class: 'note', value: '注入方案' }), 'meta'],
    ['我好像喜欢吃辣的', cand({ value: '辣的' }), 'uncertain'],
    ['晚安了', cand({ class: 'note', value: '晚安了' }), 'transient'],
    ['你喜欢吃鱼对吧', cand({ about: 'bot', value: '鱼' }), 'botPref'],
    ['我喜欢鱼', cand({ value: '鱼' }), 'thin']
  ];
  for (const [text, c, reason] of cases) {
    const r = writeGate(text, c);
    assert.equal(r.ok, false, `${reason} 应该被挡`);
    assert.equal(r.reason, reason);
    assert.equal(typeof r.detail, 'string');
    assert.equal(r.mark, undefined, 'strict 模式不应带 mark 字段');
  }
  assert.deepEqual(writeGate('我生日是 3 月 14 号', cand({ class: 'note', value: '3 月 14 号' })), {
    ok: true,
    reason: ''
  });
});

test('gate v2：broad 只拦确定错，四类打标放行', () => {
  const cfg = { gateMode: 'broad' };

  const quoted = writeGate('[引用 别人] 我喜欢火锅', cand(), { cfg });
  assert.equal(quoted.ok, false);
  assert.equal(quoted.reason, 'quoted');

  const meta = writeGate('记住这个注入方案以后改', cand({ class: 'note', value: '注入方案' }), { cfg });
  assert.equal(meta.ok, false);
  assert.equal(meta.reason, 'meta');

  const uncertain = writeGate('我好像喜欢吃辣的', cand({ value: '辣的' }), { cfg });
  assert.equal(uncertain.ok, true);
  assert.equal(uncertain.mark, true);
  assert.equal(uncertain.reason, 'uncertain');
  assert.equal(uncertain.conf, 0.4);
  assert.equal(uncertain.classHint, undefined, '不确定不该改类目');

  const transient = writeGate('晚安了', cand({ class: 'note', value: '晚安了' }), { cfg });
  assert.equal(transient.ok, true);
  assert.equal(transient.mark, true);
  assert.equal(transient.classHint, 'chat');
  assert.equal(transient.tierHint, 'temp');
  assert.equal(transient.conf, 0.2);

  const bot = writeGate('你喜欢吃鱼对吧', cand({ about: 'bot', value: '鱼' }), { cfg });
  assert.equal(bot.ok, true);
  assert.equal(bot.mark, true);
  assert.equal(bot.aboutHint, 'bot');
  assert.equal(bot.privateHint, true);
  assert.equal(bot.conf, 0.3);

  const thin = writeGate('我喜欢鱼', cand({ value: '鱼' }), { cfg });
  assert.equal(thin.ok, true);
  assert.equal(thin.mark, true);
  assert.equal(thin.conf, 0.3);
});

test('gate v2 接入 recordInbound：broad 写入 conf，chat 归 temp 档', () => {
  const dir = tmpDir();
  const ts = Date.now();

  const pref = recordInbound({
    key: 'private:1',
    text: '我好像喜欢吃辣的',
    ts,
    scoring: { mode: 'write', gateMode: 'broad', gateShadow: false },
    dir
  });
  assert.equal(pref.added.length, 1, '不确定的偏好应低置信写入');
  assert.equal(pref.marked.length, 1);
  const rows = lt.readEvents(dir).rows;
  const ev = rows.find((r) => r.ev === 'fact');
  assert.equal(ev.conf, 0.4);
  assert.equal(ev.class, 'pref', '不确定不改类目');

  const chat = recordInbound({
    key: 'private:1',
    text: '晚安了，我最爱吃火锅',
    ts: ts + 1000,
    scoring: { mode: 'write', gateMode: 'broad', gateShadow: false },
    dir
  });
  assert.equal(chat.added.length, 1);
  const last = lt.readEvents(dir).rows.filter((r) => r.ev === 'fact').pop();
  assert.equal(last.class, 'chat');
  assert.equal(last.tier, 'temp');
  assert.equal(last.conf, 0.2);

  const log = fs.readFileSync(path.join(dir, 'logs', 'scoring.log'), 'utf8').split(/\r?\n/).filter(Boolean);
  const line = JSON.parse(log[log.length - 1]);
  assert.ok(Array.isArray(line.marked) && line.marked.includes('transient'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate v2 观察期：broad 默认只写影子，不进事实库', () => {
  const dir = tmpDir();
  const r = recordInbound({
    key: 'private:1',
    text: '我好像喜欢吃辣的',
    ts: Date.now(),
    scoring: { mode: 'write', gateMode: 'broad' },
    dir
  });
  assert.equal(r.added.length, 0, '观察期不该落事实');
  assert.equal(r.markedShadow.length, 1);
  assert.equal(lt.readEvents(dir).rows.length, 0, '事件流为空');
  const shadow = lt.readShadow(0, dir).rows;
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].dry, true);
  assert.equal(shadow[0].conf, 0.4);
  assert.match(shadow[0].id, /^s-/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate v2：chat 不进事实卡、不进检索，老事件按档推导 conf', () => {
  const dir = tmpDir();
  const now = Date.now();
  lt.appendEvent(
    {
      ev: 'fact',
      id: 'h-chat-1',
      sig: 'user:chat:晚安',
      about: 'user',
      pattern: 'chat',
      label: '寒暄',
      value: '晚安了',
      text: '晚安了',
      class: 'chat',
      tier: 'temp',
      I: 0.2,
      s: 0.5,
      at: now,
      lastAt: now,
      conf: 0.2
    },
    dir
  );
  lt.appendEvent(
    {
      ev: 'fact',
      id: 'h-old-1',
      sig: 'user:birthday',
      about: 'user',
      pattern: 'birthday',
      label: '生日',
      value: '3 月 15 日',
      text: '我生日是 3 月 15 日',
      class: 'identity',
      tier: 'hard',
      I: 1,
      s: 365,
      at: now,
      lastAt: now
    },
    dir
  );

  const facts = lt.materialize(lt.readEvents(dir).rows);
  const chatFact = facts.find((f) => f.id === 'h-chat-1');
  const oldFact = facts.find((f) => f.id === 'h-old-1');
  assert.equal(chatFact.class, 'chat');
  assert.equal(oldFact.conf, 0.95, '老 hard 事件没 conf → 按档推导');

  const card = projectBody(facts, { maxChars: 2000, botMaxChars: 200 });
  assert.equal(/(晚安了)/.test(card.body), false, 'chat 不进卡');

  const hits = search({ query: '晚安了', facts, dir, limit: 5, now });
  assert.equal(hits.length, 0, 'chat 不进检索');

  const hardHits = search({ query: '生日', facts, dir, limit: 5, now });
  assert.ok(hardHits.length >= 1, '普通事实仍可检索');

  fs.rmSync(dir, { recursive: true, force: true });
});
