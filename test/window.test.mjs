import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FEEL_RE,
  beginTurn,
  dropTurn,
  extractFeels,
  formatRecentSlice,
  finishTurn,
  getDraft,
  noteSpoken,
  readBlock,
  readTurns,
  readWindowText,
  reconcileSession,
  recordFeels,
  stripFeels,
  writeBlock
} from '../src/window.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-window-'));
}

test('stripFeels：两种写法都切掉，正文保留', () => {
  const { text, feels } = stripFeels('先说正事。\n[[feel]]今天有点累。[[/feel]]\n[[心:hs-20261102-8c63be]]其实想她多问一句。[[/心]]');
  assert.equal(text, '先说正事。');
  assert.equal(feels.length, 2);
  assert.equal(feels[0].text, '今天有点累。');
  assert.equal(feels[1].text, '其实想她多问一句。');
  assert.match('[[feel]]x[[/feel]]', FEEL_RE);
});

test('stripFeels：未闭合不误吞', () => {
  const raw = '正常一句话 [[feel]]没闭合';
  const { text, feels } = stripFeels(raw);
  assert.equal(feels.length, 0);
  assert.equal(text, raw);
});

test('extractFeels 只取感受', () => {
  assert.deepEqual(extractFeels('a[[feel]]b[[/feel]]c').map((f) => f.text), ['b']);
});

test('writeBlock 内容寻址：同文只写一份', () => {
  const dir = tmpDir();
  const a = writeBlock(dir, '同一段卡');
  const b = writeBlock(dir, '同一段卡');
  assert.equal(a.sha1, b.sha1);
  assert.equal(readBlock(dir, a.sha1), '同一段卡');
  const files = fs.readdirSync(path.join(dir, 'window', 'blocks'));
  assert.equal(files.length, 1);
});

test('一轮落盘：字段齐全、轮次递增、块去重', () => {
  const dir = tmpDir();
  const sid = 'session-test-1';
  beginTurn({
    key: 'private:1',
    sessionId: sid,
    userRaw: '我买了极速谷6顶级版',
    msgIds: ['-12'],
    windowText: '【长期记忆】卡\n\n【当前对话】\n我买了极速谷6顶级版',
    blocks: [{ k: 'card', text: '【长期记忆】卡' }],
    model: 'deepseek-flash',
    mode: 'reserved2'
  });
  noteSpoken({ key: 'private:1', sessionId: sid, tool: 'send-message', text: '顶级版欸。' });
  const res = finishTurn({ dir, sessionId: sid, reply: '想了一下。[[feel]]有点羡慕。[[/feel]]', reason: 'completed' });
  assert.equal(res.turn, 1);
  assert.equal(res.feels, 1);

  const rows = readTurns(dir, sid);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.turn, 1);
  assert.equal(row.userRaw.text, '我买了极速谷6顶级版');
  assert.equal(row.spoken.length, 1);
  assert.equal(row.spoken[0].tool, 'send-message');
  assert.equal(row.reply.text, '想了一下。');
  assert.equal(row.feels[0].text, '有点羡慕。');
  assert.ok(row.window.textSha1);
  assert.equal(row.window.blocks.length, 1);

  // 第二轮
  beginTurn({ key: 'private:1', sessionId: sid, userRaw: '第二句', windowText: '窗口2' });
  finishTurn({ dir, sessionId: sid, reply: '好。', reason: 'completed' });
  const rows2 = readTurns(dir, sid);
  assert.deepEqual(rows2.map((r) => r.turn), [1, 2]);
  assert.equal(getDraft(sid), null);
});

test('感受落盘到 state/feels.jsonl 并按 turn+sha1 去重', () => {
  const dir = tmpDir();
  const added = recordFeels({ dir, key: 'private:1', sessionId: 's', turn: 3, feels: [{ text: '一句话' }, { text: '一句话' }] });
  assert.equal(added, 1);
  const again = recordFeels({ dir, key: 'private:1', sessionId: 's', turn: 3, feels: [{ text: '一句话' }] });
  assert.equal(again, 0);
  const rows = fs.readFileSync(path.join(dir, 'state', 'feels.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].private, true);
});

test('半行容错：坏行跳过不带崩', () => {
  const dir = tmpDir();
  const sid = 'session-test-2';
  beginTurn({ key: 'k', sessionId: sid, userRaw: 'a', windowText: 'w' });
  finishTurn({ dir, sessionId: sid, reply: 'b' });
  const file = path.join(dir, 'window', sid, 'turns.jsonl');
  fs.appendFileSync(file, '{"turn":99,"broken"\n');
  const rows = readTurns(dir, sid);
  assert.equal(rows.length, 1);
});

test('readWindowText 能逐字还原窗口', () => {
  const dir = tmpDir();
  const sid = 'session-test-3';
  const windowText = '【当前时间】x\n\n【长期记忆】卡\n\n【当前对话】\n原话';
  beginTurn({ key: 'k', sessionId: sid, userRaw: '原话', windowText });
  finishTurn({ dir, sessionId: sid, reply: '嗯' });
  const [row] = readTurns(dir, sid);
  assert.equal(readWindowText(dir, row), windowText);
});

test('noteSpoken 去重，且没有草稿时不记', () => {
  const dir = tmpDir();
  const sid = 'session-test-4';
  assert.equal(noteSpoken({ sessionId: sid, text: 'hi' }), false);
  beginTurn({ key: 'k', sessionId: sid, userRaw: 'x', windowText: 'w' });
  assert.equal(noteSpoken({ sessionId: sid, tool: 't', text: 'hi' }), true);
  assert.equal(noteSpoken({ sessionId: sid, tool: 't', text: 'hi' }), false);
  finishTurn({ dir, sessionId: sid, reply: 'r' });
  assert.equal(readTurns(dir, sid)[0].spoken.length, 1);
});

test('不完整回合保留但标记 incomplete', () => {
  const dir = tmpDir();
  const sid = 'session-test-5';
  beginTurn({ key: 'k', sessionId: sid, userRaw: '只有原话', windowText: 'w' });
  const res = finishTurn({ dir, sessionId: sid, reply: '', incomplete: true });
  assert.equal(res.turn, 1);
  assert.equal(readTurns(dir, sid)[0].incomplete, true);
});

test('reconcileSession：窗口原话不在聊天记录里要报出来', () => {
  const dir = tmpDir();
  const sid = 'session-test-6';
  beginTurn({ key: 'k', sessionId: sid, userRaw: '在 raw 里', windowText: 'w' });
  finishTurn({ dir, sessionId: sid, reply: 'r' });
  beginTurn({ key: 'k', sessionId: sid, userRaw: '不在 raw 里', windowText: 'w2' });
  finishTurn({ dir, sessionId: sid, reply: 'r2' });
  const rep = reconcileSession({ dir, sessionId: sid, rawTexts: ['在 raw 里'] });
  assert.equal(rep.turns, 2);
  assert.equal(rep.notInRawCount, 1);
  assert.equal(rep.notInRaw[0].turn, 2);
});

test('dropTurn 清掉草稿', () => {
  const sid = 'session-test-7';
  beginTurn({ key: 'k', sessionId: sid, userRaw: 'x', windowText: 'w' });
  dropTurn(sid);
  assert.equal(getDraft(sid), null);
});

const HOUR = 3600 * 1000;

function realTurn(dir, sid, { at, user, spoke, reply = '好的' }) {
  beginTurn({ key: 'k', sessionId: sid, userRaw: user, windowText: 'w', at });
  if (spoke) noteSpoken({ key: 'k', sessionId: sid, tool: 'qq_send_message', text: spoke });
  finishTurn({ dir, sessionId: sid, reply });
}

test('formatRecentSlice：只取窗口内、按时间正序、含双方原话', () => {
  const dir = tmpDir();
  const sid = 'session-slice-1';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  realTurn(dir, sid, { at: now - 30 * HOUR, user: '前天说的话', reply: '前几天的事' });
  realTurn(dir, sid, { at: now - 2 * HOUR, user: '第一句', spoke: '第一句的回复' });
  realTurn(dir, sid, { at: now - 1 * HOUR, user: '第二句', spoke: '第二句的回复' });
  const r = formatRecentSlice(dir, sid, { now, maxChars: 2000 });
  assert.match(r.text, /^【最近一天的原话】/);
  assert.ok(!r.text.includes('前天说的话'));
  assert.ok(r.text.indexOf('第一句') < r.text.indexOf('第二句'));
  assert.match(r.text, /用户：第一句/);
  assert.match(r.text, /助手：第一句的回复/);
  assert.equal(r.turns, 2);
  assert.equal(r.fallback, false);
});

test('formatRecentSlice：从唤醒 prompt 里取用户原话，不把提示词当对话', () => {
  const dir = tmpDir();
  const sid = 'session-slice-2';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  realTurn(dir, sid, { at: now - 3 * HOUR, user: '真实一句' });
  const wake = '【当前角色】助手（完整角色卡请调用 qq_get_prompt 查看）\n\n【本次消息快照】\n[{"sender":"我","text":"睡了吗","isOwner":true}]\n以上消息已提供，无需重复查询。';
  beginTurn({ key: 'k', sessionId: sid, userRaw: wake, windowText: 'w', at: now - 2 * HOUR });
  finishTurn({ dir, sessionId: sid, reply: '还没睡' });
  const r = formatRecentSlice(dir, sid, { now });
  assert.ok(r.text.includes('睡了吗'));
  assert.ok(!r.text.includes('完整角色卡'));
  assert.equal(r.turns, 2);
});

test('formatRecentSlice：对象快照只认用户那条，不把她自己的话当用户原话', () => {
  const dir = tmpDir();
  const sid = 'session-slice-2c';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  const snap = {
    messages: [{ sender: '私聊', userId: '10001', text: '窗口用了一半了', isOwner: true, ownerLabel: '管理员' }],
    recent: [
      { sender: '私聊', userId: '10001', text: '在吗', isOwner: true, ownerLabel: '管理员' },
      { sender: '我', text: '在，还活着', isOwner: true, ownerLabel: '我', isSelf: true }
    ]
  };
  const wake = `【当前角色】助手\n\n【本次消息快照】\n${JSON.stringify(snap)}\n以上消息已提供，无需重复查询。`;
  beginTurn({ key: 'k', sessionId: sid, userRaw: wake, windowText: 'w', at: now - 2 * HOUR });
  finishTurn({ dir, sessionId: sid, reply: '在' });
  const rows = readTurns(dir, sid);
  assert.equal(rows[0].userRaw.text, '窗口用了一半了');
  const r = formatRecentSlice(dir, sid, { now });
  assert.ok(r.text.includes('窗口用了一半了'));
  assert.ok(!r.text.includes('用户：在，还活着'), r.text);
  assert.ok(!r.text.includes('【当前角色】'));
});

test('formatRecentSlice：没有原话也没有发言的空转轮跳过', () => {
  const dir = tmpDir();
  const sid = 'session-slice-2b';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  realTurn(dir, sid, { at: now - 3 * HOUR, user: '真实一句' });
  beginTurn({ key: 'k', sessionId: sid, userRaw: '', windowText: 'w', at: now - 2 * HOUR });
  finishTurn({ dir, sessionId: sid, reply: '自己嘀咕两句' });
  const r = formatRecentSlice(dir, sid, { now });
  assert.equal(r.turns, 1);
  assert.ok(!r.text.includes('自己嘀咕'));
});

test('formatRecentSlice：超预算从旧往新裁', () => {
  const dir = tmpDir();
  const sid = 'session-slice-3';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  for (let i = 0; i < 6; i += 1) {
    realTurn(dir, sid, { at: now - (6 - i) * HOUR, user: `第${i}句`.padEnd(40, '啊') });
  }
  const full = formatRecentSlice(dir, sid, { now, maxChars: 5000 });
  const cut = formatRecentSlice(dir, sid, { now, maxChars: 200 });
  assert.equal(full.turns, 6);
  assert.ok(cut.turns < full.turns);
  assert.ok(cut.chars <= 200);
  assert.ok(!cut.text.includes('第0句'));
});

test('formatRecentSlice：24h 内没有记录时退最近几轮', () => {
  const dir = tmpDir();
  const sid = 'session-slice-4';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  realTurn(dir, sid, { at: now - 40 * HOUR, user: '很久以前的一句' });
  const r = formatRecentSlice(dir, sid, { now, fallbackTurns: 3 });
  assert.equal(r.fallback, true);
  assert.ok(r.text.includes('很久以前的一句'));
});

test('formatRecentSlice：跳过 incomplete，不越权读别的会话', () => {
  const dir = tmpDir();
  const sid = 'session-slice-5';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  beginTurn({ key: 'k', sessionId: sid, userRaw: '没写完的一轮', windowText: 'w', at: now - HOUR });
  finishTurn({ dir, sessionId: sid, reply: '', incomplete: true });
  realTurn(dir, sid, { at: now - 30 * 60 * 1000, user: '正常的一句' });
  const r = formatRecentSlice(dir, sid, { now });
  assert.ok(!r.text.includes('没写完'));
  assert.ok(r.text.includes('正常的一句'));
  assert.equal(formatRecentSlice(dir, '', { now }).text, '');
  assert.equal(formatRecentSlice(dir, 'session-other', { now }).turns, 0);
});

test('formatRecentSlice：保留用户原话里的换行，不压成一行', () => {
  const dir = tmpDir();
  const sid = 'session-slice-6';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  realTurn(dir, sid, { at: now - HOUR, user: '嗯……\n\n今天有点累\n先睡了', spoke: '晚安' });
  const r = formatRecentSlice(dir, sid, { now });
  assert.ok(r.text.includes('嗯……\n\n今天有点累\n先睡了'), r.text);
});

test('formatRecentSlice：带出她当时的想法，已发出去的不重复', () => {
  const dir = tmpDir();
  const sid = 'session-slice-7';
  const now = Date.parse('2026-11-03T12:00:00+08:00');
  realTurn(dir, sid, { at: now - 2 * HOUR, user: '你还记得第一次画画吗', spoke: '记得呀', reply: '记得呀（嘴上说得轻松，其实有点心虚）' });
  realTurn(dir, sid, { at: now - HOUR, user: '今天吃什么', spoke: '米饭', reply: '米饭' });
  const r = formatRecentSlice(dir, sid, { now });
  assert.match(r.text, /助手（当时的想法）：记得呀（嘴上说得轻松/);
  assert.equal((r.text.match(/当时的想法/g) || []).length, 1, '已发出去的想法不重复');
  const off = formatRecentSlice(dir, sid, { now, includeReply: false });
  assert.ok(!off.text.includes('当时的想法'));
});
