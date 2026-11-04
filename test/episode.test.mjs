import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beginTurn, finishTurn } from '../src/window.mjs';
import {
  applySummary,
  buildEpisodesForDay,
  episodeFromTurns,
  readEpisodes,
  segmentTurns,
  upsertEpisodes
} from '../src/episode.mjs';

const SID = 'session-test0001';
const KEY = 'private:10001';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'episode-test-'));
}

function row(turn, at, extra = {}) {
  const { user, spoken, reply, feels, ...rest } = extra;
  return {
    v: 1,
    turn,
    at,
    sessionId: SID,
    key: KEY,
    userRaw: { text: user ?? `第 ${turn} 轮`, msgIds: [], chars: 0 },
    spoken: spoken || [],
    reply: { text: reply || '', chars: 0 },
    feels: feels || [],
    window: { textSha1: '', chars: 0, blocks: [] },
    ...rest
  };
}

test('切段：间隔超过 90 分钟断开', () => {
  const rows = [
    row(1, '2026-11-03T01:00:00.000Z'),
    row(2, '2026-11-03T01:10:00.000Z'),
    row(3, '2026-11-03T03:00:00.000Z'),
    row(4, '2026-11-03T03:10:00.000Z')
  ];
  const segs = segmentTurns(rows, { minTurns: 1 });
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0].map((r) => r.turn), [1, 2]);
  assert.deepEqual(segs[1].map((r) => r.turn), [3, 4]);
});

test('切段：不足 4 轮并入前段', () => {
  const rows = [
    row(1, '2026-11-03T01:00:00.000Z'),
    row(2, '2026-11-03T01:05:00.000Z'),
    row(3, '2026-11-03T01:10:00.000Z'),
    row(4, '2026-11-03T01:15:00.000Z'),
    row(5, '2026-11-03T05:00:00.000Z')
  ];
  const segs = segmentTurns(rows);
  assert.equal(segs.length, 1, '5 轮单独成段太短，应并进前段');
  assert.equal(segs[0].length, 5);
});

test('切段：单段上限 40 轮', () => {
  const rows = Array.from({ length: 45 }, (_, i) => row(i + 1, `2026-11-03T01:${String(i).padStart(2, '0')}:00.000Z`));
  const segs = segmentTurns(rows, { minTurns: 1 });
  assert.equal(segs[0].length, 40);
  assert.equal(segs[1].length, 5);
});

test('episode 字段：标题剥掉注入标记，想法与感受带上轮次', () => {
  const seg = [
    row(1, '2026-11-03T01:00:00.000Z', {
      user: '【当前时间】2026-11-03 09:00\n我极速谷6是预购冲的顶级版',
      reply: '代代都上顶级版，这就不是随便玩玩了。',
      feels: [{ text: '他提起预购，我心里有点高兴', src: 'reply' }]
    }),
    row(2, '2026-11-03T01:05:00.000Z', { user: '那辆车呢', spoken: [{ kind: 'tool', tool: 'qq_send_message', text: '示例车厂 GT9RS 嘛' }] })
  ];
  const ep = episodeFromTurns(seg);
  assert.equal(ep.title, '我极速谷6是预购冲的顶级版');
  assert.equal(ep.turnFrom, 1);
  assert.equal(ep.turnTo, 2);
  assert.equal(ep.day, '2026-11-03');
  assert.equal(ep.fidelity, 'live');
  assert.equal(ep.feelingsKnown, true);
  assert.equal(ep.feelings[0].turn, 1);
  assert.equal(ep.summarized, false);
  assert.equal(ep.turns.length, 2);
  assert.ok(ep.turns[1].head.includes('那辆车呢') || ep.turns[1].head.includes('GT9RS'));
  assert.ok(ep.thoughts.some((t) => t.text.includes('代代都上顶级版')));
});

test('buildEpisodesForDay：从窗口账本生成并按 id 幂等落盘', () => {
  const dir = tmpDir();
  const at = '2026-11-03T02:00:00.000Z';
  for (let i = 1; i <= 6; i += 1) {
    beginTurn({
      key: KEY,
      sessionId: SID,
      userRaw: `第 ${i} 轮：我今天跑了两公里`,
      windowText: `【当前时间】…\n第 ${i} 轮：我今天跑了两公里`,
      blocks: [{ k: 'card', text: '【长期记忆】…' }],
      at: Date.parse(at) + i * 60 * 1000
    });
    finishTurn({ dir, key: KEY, sessionId: SID, reply: `回 ${i}`, reason: 'completed' });
  }

  const { episodes, turns } = buildEpisodesForDay(dir, { day: '2026-11-03' });
  assert.equal(turns, 6);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].turnFrom, 1);
  assert.equal(episodes[0].turnTo, 6);

  assert.equal(upsertEpisodes(dir, episodes), 1);
  assert.equal(upsertEpisodes(dir, episodes), 1, '重复导入不应翻倍');
  const back = readEpisodes(dir);
  assert.equal(back.length, 1);
  assert.equal(back[0].turnFrom, 1);
  assert.ok(fs.existsSync(path.join(dir, 'episodes', '2026-11.jsonl')));
});

test('episode 字段：唤醒轮（无用户原话）不当标题，标成 wake 轮次', () => {
  const seg = [
    row(1, '2026-11-03T01:00:00.000Z', { user: '', reply: '在忙。' }),
    row(2, '2026-11-03T01:05:00.000Z', { user: '我在写记忆方案' })
  ];
  seg[0].userRaw.synthetic = true;
  seg[1].userRaw.synthetic = false;
  const ep = episodeFromTurns(seg);
  assert.equal(ep.title, '我在写记忆方案');
  assert.deepEqual(ep.syntheticTurns, [1]);
  assert.equal(ep.turns[0].kind, 'wake');
  assert.equal(ep.turns[1].kind, 'user');
});

test('applySummary：模型字段覆盖标题/主题，标记已摘要', () => {
  const ep = episodeFromTurns([row(1, '2026-11-03T01:00:00.000Z', { user: '我买了顶级版' })]);
  const out = applySummary(ep, { title: '预购顶级版', scene: '聊极速谷6', topics: ['t-game', 't-horizon6'], thoughts: ['他很喜欢这游戏'] });
  assert.equal(out.title, '预购顶级版');
  assert.deepEqual(out.topics, ['t-game', 't-horizon6']);
  assert.equal(out.summarized, true);
  assert.equal(out.thoughts[0].text, '他很喜欢这游戏');
  assert.equal(ep.title, '我买了顶级版', '原对象不应被改');
});
