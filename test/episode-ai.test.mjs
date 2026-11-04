import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beginTurn, finishTurn } from '../src/window.mjs';
import { buildEpisodesForDay, readEpisodes, upsertEpisodes } from '../src/episode.mjs';
import { episodeTranscript, summarizeEpisode, summarizePendingEpisodes } from '../src/episode-ai.mjs';

const SID = 'session-epai0001';
const KEY = 'private:10001';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'episode-ai-test-'));
}

function seed(dir, turns) {
  for (const t of turns) {
    beginTurn({
      key: KEY,
      sessionId: SID,
      userRaw: t.user,
      windowText: `【当前时间】…\n【当前对话】\n${t.user}`,
      blocks: [{ k: 'card', text: '【长期记忆】…' }],
      at: t.at
    });
    if (t.spoken) {
      // finish 前没有 noteSpoken 的公开入口，这里直接依赖 finishTurn 的 reply
    }
    finishTurn({ dir, key: KEY, sessionId: SID, reply: t.reply || '', reason: 'completed' });
  }
}

test('episodeTranscript：只吃净对话，带轮次与她的想法', () => {
  const dir = tmpDir();
  seed(dir, [
    { at: '2026-11-01T06:00:00.000Z', user: '我极速谷6买的是顶级版', reply: '他真舍得，代代都上顶级。' },
    { at: '2026-11-01T06:05:00.000Z', user: '最喜欢的还是原厂GT9RS', reply: '' }
  ]);
  const { episodes } = buildEpisodesForDay(dir, { day: '2026-11-01' });
  assert.equal(episodes.length, 1);
  const t = episodeTranscript(dir, episodes[0]);
  assert.match(t.text, /\[轮 1\] 用户：我极速谷6买的是顶级版/);
  assert.match(t.text, /助手（心里的想法）：他真舍得/);
  assert.match(t.text, /\[轮 2\] 用户：最喜欢的还是原厂GT9RS/);
  assert.doesNotMatch(t.text, /【长期记忆】/);
});

test('summarizeEpisode：解析 JSON 并写回标题/主题/想法', async () => {
  const dir = tmpDir();
  seed(dir, [{ at: '2026-11-01T06:00:00.000Z', user: '我极速谷6买的是顶级版', reply: '他真舍得。' }]);
  const { episodes } = buildEpisodesForDay(dir, { day: '2026-11-01' });
  const fake = async () => ({
    ok: true,
    text: '```json\n{"title":"极速谷6预购","scene":"聊赛车游戏","topics":["极速谷6","游戏"],"thoughts":[{"turn":1,"text":"他很喜欢这个系列"}]}\n```',
    model: 'fake',
    ms: 12
  });
  const res = await summarizeEpisode(dir, episodes[0], { request: fake });
  assert.equal(res.ok, true);
  assert.equal(res.episode.title, '极速谷6预购');
  assert.deepEqual(res.episode.topics, ['极速谷6', '游戏']);
  assert.equal(res.episode.thoughts[0].text, '他很喜欢这个系列');
  assert.equal(res.episode.summarized, true);
  assert.ok(res.episode.summarizedAt);
});

test('summarizeEpisode：模型输出不是 JSON 时不算摘要', async () => {
  const dir = tmpDir();
  seed(dir, [{ at: '2026-11-01T06:00:00.000Z', user: '在吗', reply: '在。' }]);
  const { episodes } = buildEpisodesForDay(dir, { day: '2026-11-01' });
  const fake = async () => ({ ok: true, text: '好的，这段是在打招呼。', model: 'fake' });
  const res = await summarizeEpisode(dir, episodes[0], { request: fake });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'JSON 解析失败');
});

test('summarizePendingEpisodes：只补未摘要的段，幂等，可关', async () => {
  const dir = tmpDir();
  const at = (h, m) => `2026-11-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  seed(dir, [
    { at: at(6, 0), user: '第一段一', reply: '嗯。' },
    { at: at(6, 5), user: '第一段二', reply: '嗯。' },
    { at: at(6, 10), user: '第一段三', reply: '嗯。' },
    { at: at(6, 15), user: '第一段四', reply: '嗯。' },
    { at: at(9, 30), user: '第二段（间隔超过90分钟）', reply: '哦。' },
    { at: at(9, 35), user: '第二段二', reply: '哦。' },
    { at: at(9, 40), user: '第二段三', reply: '哦。' },
    { at: at(9, 45), user: '第二段四', reply: '哦。' }
  ]);
  const { episodes } = buildEpisodesForDay(dir, { day: '2026-11-01' });
  assert.equal(episodes.length, 2);
  upsertEpisodes(dir, episodes);

  let calls = 0;
  const fake = async () => {
    calls += 1;
    return { ok: true, text: `{"title":"第${calls}段","scene":"","topics":["测试"],"thoughts":[]}`, model: 'fake' };
  };
  const first = await summarizePendingEpisodes(dir, {
    now: Date.parse('2026-11-02T00:00:00.000Z'),
    cfg: { minAgeMs: 0 },
    request: fake
  });
  assert.equal(first.summarized, 2);
  const second = await summarizePendingEpisodes(dir, {
    now: Date.parse('2026-11-02T00:00:00.000Z'),
    cfg: { minAgeMs: 0 },
    request: fake
  });
  assert.equal(second.summarized, 0);
  const stored = readEpisodes(dir);
  assert.equal(stored.filter((e) => e.summarized).length, 2);

  const off = await summarizePendingEpisodes(dir, { cfg: { summarize: false }, request: fake });
  assert.equal(off.skipped, 'disabled');
});
