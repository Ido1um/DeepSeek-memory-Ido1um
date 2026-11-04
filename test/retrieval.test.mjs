import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  layeredRecall,
  formatLayered,
  queryTokens,
  readRecentEpisodes
} from '../src/retrieval.mjs';

function mkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-retrieval-'));
}

function writeEpisodes(dir, rows) {
  fs.mkdirSync(path.join(dir, 'episodes'), { recursive: true });
  const byMonth = new Map();
  for (const r of rows) {
    const m = String(r.day).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  for (const [m, list] of byMonth) {
    fs.writeFileSync(path.join(dir, 'episodes', `${m}.jsonl`), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
}

function writeTurns(dir, sessionId, rows) {
  const d = path.join(dir, 'window', sessionId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'turns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ sessionId, nextTurn: rows.length + 1 }));
}

const NOW = Date.parse('2026-11-03T22:00:00+08:00');
const DAY = 86400000;

test('queryTokens 切中文二元组和拉丁词', () => {
  const t = queryTokens('极速谷6 顶级版 GT9RS');
  assert.ok(t.includes('极速'));
  assert.ok(t.includes('速谷'));
  assert.ok(t.includes('gt9rs'));
});

test('近 7 天情境命中即停：返回摘要行、不翻原话', () => {
  const dir = mkdir();
  writeEpisodes(dir, [
    {
      id: 'ep-2026-11-01-9ca88752-25',
      day: '2026-11-01',
      atFrom: NOW - 2 * DAY,
      atTo: NOW - 2 * DAY + 3600000,
      title: '生日前夜与极速谷',
      scene: '用户聊极速谷6预购顶级版，还聊到最喜欢的GT9RS',
      topics: ['极速谷6', '摄影'],
      thoughts: [{ turn: 30, text: '他说原厂 GT9RS 时很认真' }]
    }
  ]);
  writeTurns(dir, 's1', [
    {
      v: 1,
      turn: 1,
      at: NOW - 2 * DAY,
      sessionId: 's1',
      userRaw: { text: '我极速谷6是预购冲的顶级版' },
      spoken: [{ kind: 'send', tool: 'qq_send_message', text: '代代都上顶级版，这就不是随便玩玩了' }],
      reply: { text: '代代都上顶级版，这就不是随便玩玩了' },
      window: { textSha1: 'x', chars: 10, blocks: [] }
    }
  ]);
  const r = layeredRecall(dir, { query: '极速谷6我买的什么版本', sessionId: 's1', now: NOW });
  assert.equal(r.layers[0]?.name, 'recentEpisodes');
  // 摘要命中后仍会补一条强命中原话（细节常只在原话里），但不会退化成「翻 2 条」。
  const win = r.layers.find((l) => l.name === 'recentWindow');
  assert.ok(!win || win.count === 1);
  assert.ok(r.lines.some((l) => l.includes('顶级版')));
});

test('摘要不命中时回落到近 7 天原话，含当时的想法', () => {
  const dir = mkdir();
  writeEpisodes(dir, []);
  writeTurns(dir, 's2', [
    {
      v: 1,
      turn: 1,
      at: NOW - DAY,
      sessionId: 's2',
      userRaw: { text: '极速谷里面那么多车，我最喜欢的还是原厂示例车厂GT9RS' },
      spoken: [],
      reply: { text: '他每次说到 GT9RS 眼睛都亮，我要记住这个' },
      window: { textSha1: 'y', chars: 10, blocks: [] }
    }
  ]);
  const r = layeredRecall(dir, { query: '我最喜欢极速谷哪辆车', sessionId: 's2', now: NOW });
  assert.equal(r.layers[0]?.name, 'recentWindow');
  assert.ok(r.lines.some((l) => l.includes('GT9RS')));
  assert.ok(r.lines.some((l) => l.includes('当时的想法')));
});

test('超过 7 天但 30 天内的情境进第三层；更早的不进注入', () => {
  const dir = mkdir();
  writeEpisodes(dir, [
    { id: 'ep-old', day: '2026-10-10', atFrom: NOW - 24 * DAY, atTo: NOW - 24 * DAY + 3600000, title: '华光情报', scene: '081200 拟招 30 人，初试 300', topics: ['华光'], thoughts: [] },
    { id: 'ep-ancient', day: '2026-09-01', atFrom: NOW - 63 * DAY, atTo: NOW - 63 * DAY + 3600000, title: '更早的事', scene: '不该被注入', topics: ['旧事'], thoughts: [] }
  ]);
  const r = layeredRecall(dir, { query: '华光 081200 招多少人', sessionId: 's3', now: NOW });
  assert.equal(r.layers[0]?.name, 'monthEpisodes');
  assert.ok(r.lines.some((l) => l.includes('081200')));
  assert.ok(!r.lines.some((l) => l.includes('不该被注入')));
});

test('空查询与关闭开关都返回空；formatLayered 尊重字数上限', () => {
  const dir = mkdir();
  const r = layeredRecall(dir, { query: '   ', sessionId: 's', now: NOW });
  assert.deepEqual(r.lines, []);
  writeEpisodes(dir, [{ id: 'e1', day: '2026-11-02', atFrom: NOW - DAY, atTo: NOW - DAY + 1000, title: '摄影器材', scene: 'Z8X 配 2875ZA', topics: ['摄影'], thoughts: [] }]);
  const off = layeredRecall(dir, { query: '摄影器材', sessionId: 's', now: NOW, cfg: { enabled: false } });
  assert.deepEqual(off.lines, []);
  const on = layeredRecall(dir, { query: '摄影器材', sessionId: 's', now: NOW });
  const text = formatLayered(on, { maxChars: 12 });
  assert.ok(text.length <= 12 + 8);
});

test('readRecentEpisodes 按 atTo 过滤窗口', () => {
  const dir = mkdir();
  writeEpisodes(dir, [
    { id: 'a', day: '2026-11-02', atFrom: NOW - DAY, atTo: NOW - DAY, title: 'x', scene: '', topics: [], thoughts: [] },
    { id: 'b', day: '2026-10-01', atFrom: NOW - 30 * DAY, atTo: NOW - 30 * DAY, title: 'y', scene: '', topics: [], thoughts: [] }
  ]);
  const rows = readRecentEpisodes(dir, { now: NOW, days: 7 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a');
});

test('原话层跨会话：轮转后的旧窗口原话仍能检索到', () => {
  const dir = mkdir();
  const oldSid = 'session-old-0001';
  const newSid = 'session-new-0002';
  writeTurns(dir, oldSid, [
    {
      turn: 1,
      at: NOW - 3 * DAY,
      userRaw: { text: '我极速谷6是预购冲的顶级版，最喜欢的还是原厂示例车厂GT9RS' },
      spoken: [{ text: '代代都上顶级版，这就不是随便玩玩了' }],
      reply: { text: '他聊 GT9RS 时很认真' }
    }
  ]);
  writeTurns(dir, newSid, []);
  // 当前会话（新的）里没有这条原话，但同一个 key 的旧窗口里有
  const r = layeredRecall(dir, { query: '极速谷6 顶级版 GT9RS', sessionId: newSid, key: 'private:10001', now: NOW });
  const names = r.layers.map((l) => l.name);
  assert.ok(names.includes('recentWindow'), JSON.stringify(names));
  assert.ok(r.lines.some((l) => l.includes('GT9RS')));
});

test('带编号的查询：命中一个具体词也算（华光 081200）', () => {
  const dir = mkdir();
  writeEpisodes(dir, [
    { id: 'ep-k', day: '2026-11-01', atFrom: NOW - 2 * DAY, atTo: NOW - 2 * DAY + 3600000, title: '考研华光', scene: '聊了转专业、考研和复习', topics: ['华光'], thoughts: [] }
  ]);
  const r = layeredRecall(dir, { query: '华光 081200', sessionId: 's9', now: NOW });
  assert.ok(r.lines.some((l) => l.includes('考研华光')), '应命中只写了华光的摘要');
});

test('普通多词查询仍要求命中两个词，不只沾一个', () => {
  const dir = mkdir();
  writeEpisodes(dir, [
    { id: 'ep-p', day: '2026-11-01', atFrom: NOW - 2 * DAY, atTo: NOW - 2 * DAY + 3600000, title: '摄影器材', scene: 'Z8X 配 2875ZA', topics: ['摄影'], thoughts: [] }
  ]);
  const r = layeredRecall(dir, { query: '摄影 游戏', sessionId: 's10', now: NOW });
  assert.equal(r.lines.length, 0);
});
