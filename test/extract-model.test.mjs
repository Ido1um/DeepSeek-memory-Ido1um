// 路线 A（日终模型抽取）回归：配置 / 取数 / 分批 / JSON 解析 / 硬校验 / 去重 / 影子写入 / 写入开关。
// 全部离线：假模型（callModel 注入）+ 临时数据目录，不联网、不碰生产数据。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.mjs';
import * as lt from '../src/longterm.mjs';
import {
  normalizeExtract,
  pickMessages,
  buildBatches,
  parseModelJson,
  validateCandidate,
  candidateToEvent,
  runModelExtract,
  readShadowLines,
  summarizeShadow,
  shadowPath
} from '../src/extract-model.mjs';

const KEY = 'private:10001';

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-extract-'));
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(root, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ownerQQ: '10001', memory: { enabled: true, dir, windowDays: 7 } }), 'utf8');
  process.env.QQ_MEMORY_CONFIG = cfgFile;
  process.env.QQ_MEMORY_DIR = dir;
  store.clearConfigCache();
  t.after(() => {
    delete process.env.QQ_MEMORY_CONFIG;
    delete process.env.QQ_MEMORY_DIR;
    store.clearConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dir;
}

function say(text, { at = Date.now(), role = 'user' } = {}) {
  if (role === 'assistant') store.recordOutgoing({ key: KEY, text, time: at });
  else store.recordIncoming({ key: KEY, text, isOwner: true, time: at });
}

function batchJson(items) {
  return JSON.stringify(items);
}

function futureDue(days = 3) {
  const d = new Date(Date.now() + days * 86400_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── 1. 配置 ────────────────────────────────────────────────────────────────
test('extract：配置默认关闭，非法值回落，数值夹取', () => {
  const d = normalizeExtract(null);
  assert.equal(d.enabled, false);
  assert.equal(d.modelWrite, false);
  assert.equal(d.batchSize, 24);
  assert.equal(d.maxFactsPerDay, 8);

  const bad = normalizeExtract({ enabled: 'yes', batchSize: 999, maxFactsPerDay: -3, minConfidence: 9, timeoutMs: 1 });
  assert.equal(bad.enabled, false); // 只认 true
  assert.equal(bad.batchSize, 40);
  assert.equal(bad.maxFactsPerDay, 1);
  assert.equal(bad.minConfidence, 1);
  assert.equal(bad.timeoutMs, 5000);

  const ok = normalizeExtract({ enabled: true, modelWrite: true, batchSize: 20, minConfidence: 0.7 });
  assert.equal(ok.enabled, true);
  assert.equal(ok.modelWrite, true);
  assert.equal(ok.batchSize, 20);
  assert.equal(ok.minConfidence, 0.7);
});

// ── 2. 取数 ────────────────────────────────────────────────────────────────
test('extract：取数只留当天用户侧、跳过附件与命令、连续重复只留一条', () => {
  const now = Date.now();
  const rows = [
    { role: 'user', text: '我生日是11月2号', ts: now },
    { role: 'assistant', text: '记下啦', ts: now },
    { role: 'user', text: '我生日是11月2号', ts: now },
    { role: 'user', text: '[图片]', ts: now },
    { role: 'user', text: '/status', ts: now },
    { role: 'user', text: '嗯', ts: now },
    { role: 'user', text: '下周要交课程报告', ts: now },
    { role: 'user', text: '昨天说的那句话', ts: now - 3 * 86400_000 }
  ];
  const picked = pickMessages(rows, now, normalizeExtract({}));
  assert.deepEqual(
    picked.map((m) => m.text),
    ['我生日是11月2号', '下周要交课程报告']
  );
});

// ── 3. 分批 ────────────────────────────────────────────────────────────────
test('extract：分批按条数与字符预算切，不丢消息', () => {
  const msgs = Array.from({ length: 25 }, (_, i) => ({ text: `第${i}条消息内容`, ts: Date.now() }));
  const cfg = normalizeExtract({ batchSize: 24 });
  const batches = buildBatches(msgs, cfg);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 24);
  assert.equal(batches[1].length, 1);

  const small = buildBatches(msgs.slice(0, 6), normalizeExtract({ batchSize: 10, maxCharsPerBatch: 2000 }));
  assert.equal(small.length, 1);
  const tiny = buildBatches(msgs, normalizeExtract({ batchSize: 3 }));
  assert.equal(tiny.length, 3); // batchSize 最小夹到 10
  assert.equal(tiny.flat().length, 25);
});

// ── 4. JSON 解析 ───────────────────────────────────────────────────────────
test('extract：模型输出解析容忍围栏/解释/单对象包装，坏 JSON 返回错误', () => {
  const items = [{ kind: 'note', about: 'user', subject: '我', topic: 'user:note', value: '喜欢吃鱼', quote: '我喜欢吃鱼', confidence: 0.8 }];
  assert.deepEqual(parseModelJson(batchJson(items)).candidates, items);
  assert.deepEqual(parseModelJson('```json\n' + batchJson(items) + '\n```').candidates, items);
  assert.deepEqual(parseModelJson(`好的，结果如下：\n${batchJson(items)}\n以上。`).candidates, items);
  assert.deepEqual(parseModelJson(JSON.stringify({ candidates: items })).candidates, items);
  assert.deepEqual(parseModelJson(JSON.stringify(items[0])).candidates, items);
  assert.equal(parseModelJson('not json').ok, false);
  assert.equal(parseModelJson('{"a":1}').ok, true); // 单对象 → 包成数组
});

// ── 5. 硬校验 ──────────────────────────────────────────────────────────────
test('extract：硬校验门（quote 子串 / value 形状 / topic 白名单 / kind 对应 / 置信度）', () => {
  const now = Date.now();
  const messages = [{ text: '我生日是11月2号，喜欢喝咖啡', ts: now }];
  const cfg = normalizeExtract({ minConfidence: 0.6 });
  const base = { about: 'user', subject: '我', confidence: 0.9 };

  const ok = validateCandidate({ ...base, kind: 'fact', topic: 'user:birthday', value: '11月2日', quote: '我生日是11月2号' }, { messages, now, cfg });
  assert.equal(ok.ok, true);
  assert.equal(ok.candidate.topic, 'user:birthday');

  const cases = [
    [{ ...base, kind: 'fact', topic: 'user:birthday', value: '11月2日', quote: '我生日是11月3号' }, 'quote'],
    [{ ...base, kind: 'fact', topic: 'user:birthday', value: '爱吃鱼', quote: '我生日是11月2号' }, 'value'],
    [{ ...base, kind: 'fact', topic: 'user:hobby', value: '咖啡', quote: '喜欢喝咖啡' }, 'topic'],
    [{ ...base, kind: 'pref', topic: 'user:note', value: '咖啡', quote: '喜欢喝咖啡' }, 'topic-kind'],
    [{ ...base, kind: 'event', topic: 'user:event', value: '咖啡', quote: '喜欢喝咖啡', confidence: 0.2 }, 'confidence'],
    [{ ...base, kind: 'fact', subject: '你', topic: 'user:birthday', value: '11月2日', quote: '我生日是11月2号' }, 'subject'],
    [{ ...base, kind: 'fact', topic: 'user:birthday', value: '11月2日', quote: '我生日是11月2号', about: 'bot' }, 'about']
  ];
  for (const [cand, reason] of cases) {
    const r = validateCandidate(cand, { messages, now, cfg });
    assert.equal(r.ok, false, `${reason} 应该被拒`);
    assert.equal(r.reason, reason);
  }

  // 写入门复用：元讨论/技术词被 gate:meta 挡
  const meta = validateCandidate(
    { ...base, kind: 'note', topic: 'user:note', value: '记忆方案', quote: '记忆方案定稿了' },
    { messages: [{ text: '记忆方案定稿了', ts: now }], now, cfg }
  );
  assert.equal(meta.ok, false);
  assert.equal(meta.reason, 'gate:meta');
});

// ── 6. 去重 ────────────────────────────────────────────────────────────────
test('extract：与已有事实按 topic+value 和相似度去重', async () => {
  const dir = tmp({ after() {} });
  const now = Date.now();
  lt.appendEvent({ ev: 'fact', id: 'h-1', sig: 'user:pref:火锅', about: 'user', topic: 'user:pref:火锅', class: 'pref', tier: 'general', I: 0.7, s: 90, value: '火锅', text: '我爱吃火锅', quote: '我爱吃火锅', hits: 1, lastAt: now, at: now }, dir);

  let calls = 0;
  const fake = async () => {
    calls += 1;
    return {
      ok: true,
      text: batchJson([
        { kind: 'pref', about: 'user', subject: '我', topic: 'user:pref:火锅', value: '火锅', quote: '我今天特别爱吃火锅', confidence: 0.9 },
        { kind: 'pref', about: 'user', subject: '我', topic: 'user:pref:咖啡', value: '咖啡', quote: '我也爱喝咖啡呀', confidence: 0.9 }
      ])
    };
  };
  say('我今天特别爱吃火锅', { at: now });
  say('我也爱喝咖啡呀', { at: now });
  const stats = await runModelExtract({ now, dir, cfg: { enabled: true, batchSize: 10, modelWrite: false }, ownerKey: KEY, callModel: fake });
  assert.equal(calls, 1);
  assert.equal(stats.candidates, 2);
  assert.equal(stats.passed, 1); // 火锅重复被挡
  assert.equal(stats.byReason.dup, 1);

  // 影子文件：batch + cand 行都在；不写 longterm
  const lines = readShadowLines(dir);
  assert.equal(lines.filter((l) => l.t === 'batch').length, 1);
  assert.equal(lines.filter((l) => l.t === 'cand').length, 2);
  assert.equal(lt.readEvents(dir).rows.filter((r) => r.ev === 'fact').length, 1);

  const sum = summarizeShadow(dir, { now, days: 7 });
  assert.equal(sum.totals.candidates, 2);
  assert.equal(sum.totals.passed, 1);
});

// ── 7. 任务抽取 + 封顶 + modelWrite ───────────────────────────────────────
test('extract：task 抽取走 modelWrite 时落事件，超过每日封顶的丢 cap', async () => {
  const dir = tmp({ after() {} });
  const now = Date.now();
  const due = futureDue(3);
  say('下周一要交课程报告', { at: now });
  say('周末想去吃火锅', { at: now });
  say('最近在学古典吉他', { at: now });

  const fake = async () => ({
    ok: true,
    text: batchJson([
      { kind: 'task', about: 'user', subject: '我', topic: `user:task:${due}`, due, value: '课程报告', quote: '下周一要交课程报告', confidence: 0.95 },
      { kind: 'pref', about: 'user', subject: '我', topic: 'user:pref:火锅', value: '火锅', quote: '周末想去吃火锅', confidence: 0.8 },
      { kind: 'fact', about: 'user', subject: '我', topic: 'user:skill', value: '古典吉他', quote: '最近在学古典吉他', confidence: 0.7 }
    ])
  });
  const stats = await runModelExtract({
    now,
    dir,
    cfg: { enabled: true, modelWrite: true, batchSize: 10, maxFactsPerDay: 2 },
    ownerKey: KEY,
    callModel: fake
  });
  assert.equal(stats.candidates, 3);
  assert.equal(stats.passed, 2);
  assert.equal(stats.written, 2);
  assert.equal(stats.byReason.cap, 1);

  const facts = lt.readEvents(dir).rows.filter((r) => r.ev === 'fact');
  assert.equal(facts.length, 2);
  assert.ok(facts.some((f) => f.task === true && f.due === due));
  assert.ok(facts.every((f) => f.source && f.source.model === 'extract'));

  // 再跑一次：同样候选应全部判重（影子里的 seen 只在单次运行内生效，这里靠已有事实去重）
  const stats2 = await runModelExtract({ now, dir, cfg: { enabled: true, modelWrite: false, batchSize: 10 }, ownerKey: KEY, callModel: fake });
  assert.equal(stats2.passed, 1); // 上一轮被 cap 掉的「古典吉他」这轮通过
  assert.ok(stats2.byReason.dup >= 2);
});

// ── 8. 失败隔离 ────────────────────────────────────────────────────────────
test('extract：模型抛错 / 返回坏 JSON 都不抛异常，影子记错误，事件流不变', async () => {
  const dir = tmp({ after() {} });
  const now = Date.now();
  say('我生日是11月2号', { at: now });

  const boom = async () => {
    throw new Error('network down');
  };
  const stats = await runModelExtract({ now, dir, cfg: { enabled: true, batchSize: 10 }, ownerKey: KEY, callModel: boom });
  assert.equal(stats.batches, 1);
  assert.equal(stats.passed, 0);
  assert.equal(stats.byReason.model, 1);

  const bad = async () => ({ ok: true, text: '模型开始胡说' });
  const stats2 = await runModelExtract({ now, dir, cfg: { enabled: true, batchSize: 10 }, ownerKey: KEY, callModel: bad });
  assert.equal(stats2.batch2 !== undefined, false);
  assert.equal(stats2.byReason.json, 1);

  assert.equal(lt.readEvents(dir).rows.filter((r) => r.ev === 'fact').length, 0);
  assert.ok(fs.existsSync(shadowPath(dir)));
});

// ── 9. 关闭时什么都不做 ────────────────────────────────────────────────────
test('extract：enabled=false 直接跳过，连影子文件都不创建', async () => {
  const dir = tmp({ after() {} });
  const stats = await runModelExtract({ now: Date.now(), dir, cfg: {}, ownerKey: KEY });
  assert.equal(stats.skipped, 'disabled');
  assert.equal(fs.existsSync(shadowPath(dir)), false);
});
