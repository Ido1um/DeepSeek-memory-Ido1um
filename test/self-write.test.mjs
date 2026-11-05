import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeSelfWrite,
  sigFor,
  selfStats,
  validateSelfWrite,
  writeSelfFact,
  shouldSkipExtract,
  recordExtractSkip
} from '../src/self-write.mjs';
import { readEvents } from '../src/longterm.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-self-'));
}

function factsOf(dir) {
  return readEvents(dir).rows.filter((r) => r.ev === 'fact');
}

function writeTurn(dir, sessionId, turn, userText) {
  const d = path.join(dir, 'window', sessionId);
  fs.mkdirSync(d, { recursive: true });
  const row = {
    turn,
    at: Date.now(),
    userRaw: { text: userText, msgIds: ['m1'], chars: userText.length },
    spoken: [{ text: '嗯，我记住了' }],
    reply: { text: '好' },
    feels: [],
    window: { textSha1: 'x', chars: 1, blocks: [] }
  };
  fs.appendFileSync(path.join(d, 'turns.jsonl'), JSON.stringify(row) + '\n', 'utf8');
}

test('自写事实：落进 longterm，带 author/voice/主题/槽位', () => {
  const dir = tmpDir();
  const r = writeSelfFact(
    { value: '我最喜欢原厂示例车厂GT9RS', text: '我最喜欢原厂示例车厂GT9RS，底盘操控好', topicId: 't-horizon6', slot: 'pref', kind: 'pref' },
    { dir, key: 'private:1', now: Date.now(), cfg: normalizeSelfWrite({}) }
  );
  assert.equal(r.ok, true);
  assert.equal(r.action, 'created');
  assert.match(r.message, /记在：/);
  const ev = factsOf(dir)[0];
  assert.equal(ev.author, 'self');
  assert.equal(ev.voice, 'first');
  assert.equal(ev.topicId, 't-horizon6');
  assert.equal(ev.slot, 'pref');
  assert.ok(ev.saidAt > 0);
  assert.equal(r.fact.author, 'self');
});

test('自写事实：单值槽位重写走 supersede，旧值留在事件流里', () => {
  const dir = tmpDir();
  const cfg = normalizeSelfWrite({});
  const a = writeSelfFact({ value: '用户喜欢喝乌龙茶', topicId: 't-identity', slot: 'identity' }, { dir, cfg });
  assert.equal(a.ok, true);
  const b = writeSelfFact({ value: '用户喜欢喝咖啡', topicId: 't-identity', slot: 'identity' }, { dir, cfg });
  assert.equal(b.ok, true);
  assert.equal(b.action, 'superseded');
  assert.equal(b.fact.value, '用户喜欢喝咖啡');
  assert.equal(b.fact.versions, 2);
  const rows = readEvents(dir).rows;
  assert.equal(rows.filter((x) => x.ev === 'fact').length, 1);
  assert.equal(rows.filter((x) => x.ev === 'supersede').length, 1);
});

test('自写事实：同值重复写不会多出一条', () => {
  const dir = tmpDir();
  const cfg = normalizeSelfWrite({});
  writeSelfFact({ value: '摄影用Z8X', topicId: 't-photo', slot: 'gear' }, { dir, cfg });
  const again = writeSelfFact({ value: '摄影用Z8X', topicId: 't-photo', slot: 'gear' }, { dir, cfg });
  assert.equal(again.ok, true);
  assert.equal(again.action, 'duplicate');
  assert.equal(factsOf(dir).length, 1);
});

test('自写事实：多值槽位允许并列不同值', () => {
  const dir = tmpDir();
  const cfg = normalizeSelfWrite({});
  writeSelfFact({ value: '最喜欢的车是示例车厂GT9RS', topicId: 't-horizon6', slot: 'pref' }, { dir, cfg });
  const r2 = writeSelfFact({ value: '最喜欢的地图是财富岛', topicId: 't-horizon6', slot: 'pref' }, { dir, cfg });
  assert.equal(r2.ok, true);
  assert.equal(r2.action, 'created');
  assert.equal(factsOf(dir).length, 2);
});

test('配额：每天超过上限拒绝', () => {
  const dir = tmpDir();
  const cfg = normalizeSelfWrite({ maxPerDay: 1 });
  writeSelfFact({ value: '今天的第一条', topicId: 't-life', slot: 'note' }, { dir, cfg });
  const r = writeSelfFact({ value: '今天的第二条', topicId: 't-life', slot: 'note' }, { dir, cfg });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'quota-day');
  assert.equal(selfStats(dir).today, 1);
});

test('校验：value 太长、槽位不存在、引文对不上都被拒', () => {
  const dir = tmpDir();
  const cfg = normalizeSelfWrite({ maxValueChars: 10 });
  assert.equal(validateSelfWrite({ value: '一二三四五六七八九十多出来的字', topicId: 't-life' }, { dir, cfg }).code, 'value-long');
  assert.equal(validateSelfWrite({ value: '正常值', topicId: 't-life', slot: 'nope' }, { dir, cfg }).code, 'unknown-slot');
  writeTurn(dir, 's1', 3, '我不太喜欢香菜');
  const bad = validateSelfWrite({ value: '我不喜欢香菜', quote: '完全对不上的引文', sessionId: 's1', turn: 3 }, { dir, cfg });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'quote-unverified');
});

test('引文能查到：写入时带窗口锚点', () => {
  const dir = tmpDir();
  const cfg = normalizeSelfWrite({});
  writeTurn(dir, 's1', 3, '我不太喜欢香菜，闻到就皱眉');
  const r = writeSelfFact(
    { value: '不喜欢香菜', quote: '闻到就皱眉', topicId: 't-food', slot: 'pref', sessionId: 's1', turn: 3, kind: 'pref' },
    { dir, cfg }
  );
  assert.equal(r.ok, true);
  assert.equal(r.fact.src.kind, 'window');
  assert.equal(r.fact.src.turnFrom, 3);
});

test('抽取器守卫：同主题同槽位的单值已被她写 → 跳过', () => {
  const dir = tmpDir();
  const cfg = normalizeSelfWrite({});
  writeSelfFact({ value: '最喜欢的游戏是极速谷6', topicId: 't-horizon6', slot: 'game' }, { dir, cfg: cfg });
  const same = shouldSkipExtract(dir, { topicId: 't-horizon6', slot: 'game', value: '极速谷5' }, { cfg });
  assert.equal(same.skip, true);
  assert.equal(same.reason, 'self');
  const other = shouldSkipExtract(dir, { topicId: 't-photo', slot: 'gear', value: 'Z8X' }, { cfg });
  assert.equal(other.skip, false);
});

test('抽取器被挡的候选写进 staging', () => {
  const dir = tmpDir();
  recordExtractSkip(dir, { topicId: 't-horizon6', slot: 'game', value: '极速谷5', quote: '极速谷5也不错' });
  const line = fs.readFileSync(path.join(dir, 'state', 'staging.jsonl'), 'utf8').trim();
  const row = JSON.parse(line);
  assert.equal(row.reason, 'self');
  assert.equal(row.kind, 'extract-skip');
  assert.equal(row.value, '极速谷5');
});

test('sig：单值槽位不随值变，多值槽位按值区分', () => {
  assert.equal(sigFor('t-identity', 'identity', 'a'), sigFor('t-identity', 'identity', 'b'));
  assert.notEqual(sigFor('t-photo', 'gear', 'Z8X'), sigFor('t-photo', 'gear', '2875ZA'));
});
