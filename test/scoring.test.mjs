// 打分跑批 + 长期记忆落盘的集成测试（影子 / 写入 / 日终结算 / 检索）。
//
// 隔离：QQ_MEMORY_DIR 指到临时目录，绝不碰生产数据目录。
// 时间：全部显式传 ts / now，不依赖真实时钟。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-scoring-'));
process.env.QQ_MEMORY_DIR = DIR;

const lt = await import('../src/longterm.mjs');
const run = await import('../src/scoring-runner.mjs');
const score = await import('../src/score.mjs');

const DAY = score.DAY;
const T0 = Date.parse('2026-10-29T10:00:00+08:00');
const stateFile = (name) => path.join(DIR, 'state', name);
const readLines = (name) => {
  try {
    return fs.readFileSync(stateFile(name), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const reset = () => {
  for (const f of ['longterm.jsonl', 'scoring-shadow.jsonl', 'scoring-dryrun.json', 'scoring-shadow-stats.json']) {
    try { fs.rmSync(stateFile(f), { force: true }); } catch { /* ignore */ }
  }
};

test('classify：硬事实抽取、疑问不抽、记住→备注', () => {
  const a = run.classify('我生日是11月2号');
  assert.equal(a.candidates.length, 1);
  assert.equal(a.candidates[0].tier, 'hard');
  assert.equal(a.candidates[0].about, 'user');
  assert.equal(a.candidates[0].I, 1);

  const b = run.classify('你生日几号？');
  assert.equal(b.candidates.length, 0);
  assert.equal(b.signals.question, true);

  const c = run.classify('记住我不吃香菜');
  assert.equal(c.candidates.length, 1);
  assert.equal(c.candidates[0].tier, 'general');
  assert.equal(c.candidates[0].I, 0.8);

  assert.equal(run.classify('今天天气不错').candidates.length, 0);
});

test('off 模式：什么都不写', () => {
  reset();
  const r = run.recordInbound({ key: 'private:1', text: '我生日是11月2号', ts: T0, scoring: { mode: 'off' } });
  assert.equal(r.mode, 'off');
  assert.equal(readLines('scoring-shadow.jsonl').length, 0);
  assert.equal(readLines('longterm.jsonl').length, 0);
});

test('shadow：只写影子文件 + 统计，不碰 longterm', () => {
  reset();
  const r = run.recordInbound({ key: 'private:1', text: '我生日是11月2号', ts: T0, scoring: { mode: 'shadow' } });
  assert.equal(r.mode, 'shadow');
  assert.equal(r.added.length, 1);
  assert.match(r.added[0].id, /^s-/);

  const shadow = readLines('scoring-shadow.jsonl');
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].dry, true);
  assert.equal(readLines('longterm.jsonl').length, 0);

  const stats = lt.readShadowStats();
  assert.equal(stats.total, 1);
  assert.ok(stats.startedAt > 0);
});

test('write：新事实落盘 + 再提及折成一条（S 变长、hits=2）', () => {
  reset();
  const cfg = { mode: 'write' };
  const first = run.recordInbound({ key: 'private:1', text: '我生日是11月2号', ts: T0, scoring: cfg });
  assert.equal(first.added.length, 1);
  assert.match(first.added[0].id, /^h-/);

  // 10 天后再说一次：应命中同一条 sig，不新增 fact
  const later = T0 + 10 * DAY;
  const second = run.recordInbound({ key: 'private:1', text: '我生日是11月2号', ts: later, scoring: cfg });
  assert.equal(second.added.length, 0);
  assert.equal(second.mentioned.length, 1);

  const events = readLines('longterm.jsonl');
  assert.equal(events.filter((e) => e.ev === 'fact').length, 1);
  assert.equal(events.filter((e) => e.ev === 'mention').length, 1);

  const [fact] = lt.materialize();
  assert.equal(fact.hits, 2);
  assert.equal(fact.lastAt, later);
  // hard 的 S 永远是无穷，不会被“拉长”
  assert.equal(score.stabilityOf(fact), Infinity);
});

test('write：普通记忆的 S 会随复习变长', () => {
  reset();
  const cfg = { mode: 'write' };
  run.recordInbound({ key: 'private:1', text: '记住我不吃香菜', ts: T0, scoring: cfg });
  run.recordInbound({ key: 'private:1', text: '记住我不吃香菜', ts: T0 + 6 * DAY, scoring: cfg });
  const [fact] = lt.materialize();
  assert.equal(fact.tier, 'general');
  assert.ok(fact.s > 3, `S 应大于初始 3，实际 ${fact.s}`);
  assert.ok(fact.s <= 365);
});

test('settle：shadow 只写预览，write 才追加 tier/expire', () => {
  reset();
  // 造一条 8 天没提的 temp：先写一条备注，再手动把 tier 事件改成 temp
  run.recordInbound({ key: 'private:1', text: '记住我不吃香菜', ts: T0, scoring: { mode: 'write' } });
  const [f] = lt.materialize();
  lt.appendEvent({ ev: 'tier', id: f.id, at: T0, tier: 'temp', from: 'general', s: 1.5, score: 60 });

  const preview = run.settle({ now: T0 + 8 * DAY, scoring: { mode: 'shadow' } });
  assert.equal(preview.mode, 'shadow');
  assert.ok(preview.transitionCount >= 1);
  assert.deepEqual(preview.transitions[0].to, 'expired');
  assert.ok(lt.readDryrun(), '影子应写 scoring-dryrun.json');
  assert.equal(readLines('longterm.jsonl').filter((e) => e.ev === 'expire').length, 0);

  const applied = run.settle({ now: T0 + 8 * DAY, scoring: { mode: 'write' } });
  assert.equal(applied.mode, 'write');
  assert.equal(readLines('longterm.jsonl').filter((e) => e.ev === 'expire').length, 1);
  assert.equal(lt.materialize()[0].status, 'expired');
});

test('settle：hits≥3 且分数≥55 → 升 long；静止 90 天以上 → 回 general', () => {
  reset();
  const cfg = { mode: 'write', promote: { hits: 3, score: 55 } };
  run.recordInbound({ key: 'private:1', text: '记住我不吃香菜', ts: T0, scoring: cfg });
  const [f] = lt.materialize();
  // 造 3 次提及，且都在 1 天内（分数保持在 80 左右）
  lt.appendEvent({ ev: 'mention', id: f.id, at: T0 + 1000, hits: 2, s: 4, I: 0.8 });
  lt.appendEvent({ ev: 'mention', id: f.id, at: T0 + 2000, hits: 3, s: 5, I: 0.8 });

  const up = run.settle({ now: T0 + DAY, scoring: cfg });
  assert.ok(up.transitions.some((t) => t.to === 'long'), JSON.stringify(up.transitions));
  assert.equal(lt.materialize()[0].tier, 'long');

  // 之后 200 天不提：90 天后应降回 general
  const down = run.settle({ now: T0 + 200 * DAY, scoring: cfg });
  assert.ok(down.transitions.some((t) => t.from === 'long' && t.to === 'general'), JSON.stringify(down.transitions));
  assert.equal(lt.materialize()[0].tier, 'general');
});

test('search：只返回命中事实，命中之间档位优先', () => {
  reset();
  const cfg = { mode: 'write' };
  run.recordInbound({ key: 'private:1', text: '我生日是11月2号', ts: T0, scoring: cfg });
  run.recordInbound({ key: 'private:1', text: '记住我不吃香菜', ts: T0, scoring: cfg });

  // 查「香菜」：只出香菜那条，生日（hard）不能被带出来
  const rows = run.search({ query: '香菜', limit: 5, now: T0 + 30 * DAY, scoring: cfg });
  assert.ok(rows.length >= 1, '应至少命中一条');
  assert.ok(rows.every((r) => r.hit), '返回的都必须真命中');
  assert.ok(rows.some((r) => r.text.includes('香菜')), '应命中香菜');
  assert.ok(!rows.some((r) => r.text.includes('生日')), '不相关的高档事实不能混进来');

  // 查「生日」：只出硬事实那一条
  const b = run.search({ query: '生日', limit: 5, now: T0, scoring: cfg });
  assert.equal(b.length, 1);
  assert.equal(b[0].tier, 'hard');

  // 不带关键词：全部返回，且 hard 排最前
  const all = run.search({ limit: 5, now: T0, scoring: cfg });
  assert.equal(all.length, 2);
  assert.equal(all[0].tier, 'hard');
});

test('坏行不影响折叠（容忍半行/非 JSON）', () => {
  reset();
  run.recordInbound({ key: 'private:1', text: '我生日是11月2号', ts: T0, scoring: { mode: 'write' } });
  fs.appendFileSync(stateFile('longterm.jsonl'), '{"ev":"fact","id":"bad"\n', 'utf8');
  const { rows, bad } = lt.readEvents();
  assert.equal(rows.length, 1);
  assert.equal(bad, 1);
  assert.equal(lt.materialize(rows).length, 1);
});
test('目录隔离：dir 参数决定写入哪个库，不串到 store 目录', () => {
  reset();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-other-'));
  run.recordInbound({ key: 'private:1', text: '我生日是11月2号', ts: T0, scoring: { mode: 'write' }, dir: other });
  const inOther = path.join(other, 'state', 'longterm.jsonl');
  assert.equal(fs.existsSync(inOther), true, '应写进 dir 指定的库');
  assert.equal(fs.existsSync(stateFile('longterm.jsonl')), false, '不应写进 store 的库');

  // 同一个 store 目录读到的仍是空的
  assert.equal(lt.readEvents().rows.length, 0);
  assert.equal(lt.readEvents(other).rows.length, 1);
});

test('观测日志：每条入站一行 logs/scoring.log，含候选/写入数', () => {
  reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-log-'));
  run.recordInbound({ key: 'private:1', text: '今天好累', ts: T0, scoring: { mode: 'write' }, dir });
  run.recordInbound({ key: 'private:1', text: '我生日是11月2号', ts: T0 + 1000, scoring: { mode: 'write' }, dir });
  const file = path.join(dir, 'logs', 'scoring.log');
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].cand, 0);
  assert.equal(lines[0].added, 0);
  assert.equal(lines[1].cand, 1);
  assert.equal(lines[1].added, 1);
  assert.equal(lines[1].mode, 'write');
  assert.ok(lines[1].ids.length >= 1);
});
