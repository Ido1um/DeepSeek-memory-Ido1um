import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeGate } from '../src/gate.mjs';
import { classify, recordInbound } from '../src/scoring-runner.mjs';
import * as lt from '../src/longterm.mjs';

function tmpDir(tag = 'write-gate-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

const cand = (over = {}) => ({
  sig: 'user:note:x',
  about: 'user',
  class: 'note',
  value: '记住备用钥匙在抽屉里',
  ...over
});

test('写入门：转述/引用不是本人陈述，整条挡掉', () => {
  const r = writeGate('[引用 助手：行，那我这算 1.2 版鲸鱼]那就这样', cand());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quoted');
});

test('写入门：技术/元讨论不写，但待办放行', () => {
  const meta = writeGate('记住这个配置项要先改成注入预算', cand());
  assert.equal(meta.ok, false);
  assert.equal(meta.reason, 'meta');

  const task = writeGate('周三要交报告', cand({ class: 'task', value: '周三要交报告' }));
  assert.equal(task.ok, true, '待办里出现「报告」不该被 meta 挡');
});

test('写入门：机器人自己的口味是扮演，不写成用户事实', () => {
  const r = writeGate('你喜欢吃鱼对吧', cand({ class: 'pref', about: 'bot', value: '鱼' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'botPref');
});

test('写入门：不确定的话不写，明确叮嘱仍然放行', () => {
  const pref = writeGate('我好像喜欢吃辣的', cand({ class: 'pref', value: '辣' }));
  assert.equal(pref.ok, false);
  assert.equal(pref.reason, 'uncertain');

  const note = writeGate('记住我好像把钥匙放在门口垫子下了', cand({ value: '记住我好像把钥匙放在门口垫子下了' }));
  assert.equal(note.ok, true, '「记住」是明确指令，允许先记下来');
});

test('写入门：临时状态不写，长期事实照常过', () => {
  const t = writeGate('晚安了，小胖鱼', cand({ value: '晚安了，小胖鱼' }));
  assert.equal(t.ok, false);
  assert.equal(t.reason, 'transient');

  const ok = writeGate('我生日是 3 月 14 号', cand({ class: 'note', value: '我生日是 3 月 14 号' }));
  assert.equal(ok.ok, true);
});

test('写入门：内容太薄的不写', () => {
  const pref = writeGate('我喜欢鱼', cand({ class: 'pref', value: '鱼' }));
  assert.equal(pref.ok, false);
  assert.equal(pref.reason, 'thin');

  const note = writeGate('记住', cand({ value: '记住' }));
  assert.equal(note.ok, false);
  assert.equal(note.reason, 'thin');
});

test('写入门：开关关闭时不挡任何东西', () => {
  const r = writeGate('记住这个配置项要先改成注入预算', cand(), { cfg: { writeGate: false } });
  assert.equal(r.ok, true);
});

test('写入门接入 recordInbound：挡掉的原因写进 scoring.log，不落事实', () => {
  const dir = tmpDir();
  const r = recordInbound({
    key: 'private:1',
    text: '记住这个注入方案以后再改',
    ts: Date.now(),
    scoring: { mode: 'write' },
    dir
  });
  assert.equal(r.added.length, 0);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].reason, 'meta');

  const log = fs.readFileSync(path.join(dir, 'logs', 'scoring.log'), 'utf8').split(/\r?\n/).filter(Boolean);
  const last = JSON.parse(log[log.length - 1]);
  assert.deepEqual(last.blocked, ['meta']);
  assert.equal(lt.readEvents(dir).rows.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写入门：同义换词不新开一条（爱吃=喜欢），记成提及', () => {
  const dir = tmpDir();
  const ts = Date.now();
  const a = recordInbound({ key: 'private:1', text: '我喜欢吃火锅', ts, scoring: { mode: 'write' }, dir });
  assert.equal(a.added.length, 1);

  const b = recordInbound({ key: 'private:1', text: '我最爱吃火锅', ts: ts + 1000, scoring: { mode: 'write' }, dir });
  assert.equal(b.added.length, 0, '同值不该再开一条');
  assert.equal(b.mentioned.length, 1, '应记成对原事实的提及');
  assert.equal(b.mentioned[0].id, a.added[0].id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写入门：日常闲聊一条都不写（真实语料抽样）', () => {
  const dir = tmpDir();
  const ts = Date.now();
  const lines = [
    '晚安了，小胖鱼',
    '这张好看吗，别人家的鱼画的，你要不要也模仿这张画一张[图片]',
    '我觉得这张是你之前画的最好的[图片]',
    '今天刚到，已经翻了翻，感觉数学基础目前是够的'
  ];
  let added = 0;
  for (const text of lines) {
    added += recordInbound({ key: 'private:1', text, ts, scoring: { mode: 'write' }, dir }).added.length;
  }
  assert.equal(added, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
