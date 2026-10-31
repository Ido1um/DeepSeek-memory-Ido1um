// v10（识海启发）回归：属性 / 细节衰减 / 情绪残留 / 干扰 / 线索 / 可信度 / 检索记账。
// 全部离线：临时目录 + 纯函数，不碰生产数据；enabled=false 时必须与旧行为一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as v10 from '../src/v10.mjs';
import * as lt from '../src/longterm.mjs';
import * as store from '../src/store.mjs';
import { search, recordInbound, explainFact } from '../src/scoring-runner.mjs';

const DAY = 86400_000;
const NOW = Date.parse('2026-10-31T12:00:00+08:00');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-v10-'));
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  process.env.QQ_MEMORY_DIR = dir;
  store.clearConfigCache();
  t.after(() => {
    delete process.env.QQ_MEMORY_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dir;
}

function writeV10(dir, obj) {
  const file = path.join(dir, 'v10.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  const future = Date.now() / 1000 + 5;
  fs.utimesSync(file, future, future);
}

// ── 1. 配置 ────────────────────────────────────────────────────────────────
test('v10：配置默认关闭，只认认识的键，非法数值回落', () => {
  const d = v10.normalizeV10(null);
  assert.equal(d.enabled, false);
  assert.equal(d.emit, false);
  assert.equal(d.qLabels.mid, '大概记得');
  const c = v10.normalizeV10({
    enabled: true,
    emit: true,
    qLabels: { mid: '大概记得' },
    thresholds: { high: 0.8 },
    emotionHalfLife: -5,
    quiet: 1
  });
  assert.equal(c.enabled, true);
  assert.equal(c.qLabels.mid, '大概记得');
  assert.equal(c.qLabels.low, '只记得片段');
  assert.equal(c.thresholds.high, 0.8);
  assert.equal(c.emotionHalfLife, 180);
  assert.equal('quiet' in c, false);
});

test('v10：loadV10 从数据目录读 v10.json，缺文件回默认', (t) => {
  const dir = tmp(t);
  assert.equal(v10.loadV10(dir).enabled, false);
  writeV10(dir, { enabled: true, qLabels: { low: '只记得片段' } });
  const c = v10.loadV10(dir);
  assert.equal(c.enabled, true);
  assert.equal(c.qLabels.low, '只记得片段');
});

// ── 2. 属性 ────────────────────────────────────────────────────────────────
test('v10：attrsOf 抽情绪/关系/场景（带强度词与场景词）', () => {
  const sad = v10.attrsOf('室友今天特别难过，一个人在家里哭了很久');
  assert.ok(sad.emo < 0, '负情绪应为负值');
  assert.ok(Math.abs(sad.emo) > 0.3);
  assert.equal(sad.rel, 1);
  assert.ok(sad.scene.includes('家里'));
  const happy = v10.attrsOf('今天食堂的饭好好吃，嘿嘿');
  assert.ok(happy.emo > 0);
  assert.equal(happy.rel, 0);
  assert.deepEqual(v10.attrsOf(''), { emo: 0, rel: 0, scene: [] });
});

test('v10：fragmentsOf 只切原文子串、限长 8–20、最多 3 条', () => {
  const text = '我妈的生日是十一月二号，她说今年想在家里过，还想要一个蓝莓蛋糕，不要太甜。';
  const fr = v10.fragmentsOf(text, '我妈的生日是十一月二号，她说今年想在家里过，还想要一个蓝莓蛋糕', 3);
  assert.ok(fr.length >= 1 && fr.length <= 3);
  for (const x of fr) {
    assert.ok(x.length >= 8 && x.length <= 20, `片段长度 ${x.length}：${x}`);
    assert.ok(text.includes(x), '片段必须是原文子串');
  }
});

// ── 3. 衰减与激活值 ───────────────────────────────────────────────────────
test('v10：细节 D 按类别衰减，hard 不衰减，情绪拖慢衰减', () => {
  const cfg = v10.normalizeV10(null);
  assert.equal(v10.detailOf({ tier: 'hard', lastAt: NOW - 300 * DAY }, cfg, NOW, []), 1);
  const note = { tier: 'general', class: 'note', lastAt: NOW - 30 * DAY, hits: 1 };
  const d = v10.detailOf(note, cfg, NOW, []);
  assert.ok(d > 0.35 && d < 0.65, `30 天细节应约半衰：${d}`);
  const emotional = { ...note, emo: -0.9 };
  assert.ok(v10.detailOf(emotional, cfg, NOW, []) > d, '强情绪应让细节掉得慢');
  assert.ok(v10.detailOf({ ...note, hits: 4 }, cfg, NOW, []) > d, '反复提及（C 高）应更牢');
});

test('v10：情绪残留按半衰期衰减，强情绪更慢', () => {
  const cfg = v10.normalizeV10(null);
  assert.equal(v10.emotionOf({ emo: 0 }, cfg, NOW), 0);
  const weak = v10.emotionOf({ emo: 0.4, lastAt: NOW - 30 * DAY }, cfg, NOW);
  const strong = v10.emotionOf({ emo: 0.9, lastAt: NOW - 30 * DAY }, cfg, NOW);
  assert.ok(Math.abs(weak - 0.4 * Math.pow(0.5, 30 / 180)) < 1e-9);
  assert.ok(strong > weak);
});

test('v10：激活值 hard 有保底，线索命中加分，干扰同主题扣分', () => {
  const cfg = v10.normalizeV10(null);
  const hard = { id: 'h1', tier: 'hard', value: '用户不吃香菜', lastAt: NOW - 300 * DAY, I: 1 };
  assert.ok(v10.activationOf(hard, { facts: [hard], now: NOW, cfg }).A >= 80);

  const cue = { id: 'h2', tier: 'general', class: 'note', value: '周末去机房加班', text: '周末去机房加班', scene: ['机房'], topic: 'user:work', lastAt: NOW, I: 0.6 };
  const noQuery = v10.activationOf(cue, { facts: [cue], now: NOW, cfg }).A;
  const withQuery = v10.activationOf(cue, { facts: [cue], query: '机房', now: NOW, cfg }).A;
  assert.ok(withQuery > noQuery, '线索命中应提高激活值');

  const twin = { ...cue, id: 'h3', value: '周末去机房加班' };
  const alone = v10.activationOf(cue, { facts: [cue, twin], now: NOW, cfg }).A;
  const crowded = v10.activationOf(cue, { facts: [cue, { ...twin, id: 'h4' }, { ...twin, id: 'h5' }], now: NOW, cfg }).A;
  assert.ok(crowded < alone, '同主题越多，干扰越大');

  // 时段线索（4 分）也算 cue；巩固度高（C 大）的旧条目 R 掉得更慢
  const aged = { id: 'h6', tier: 'general', class: 'note', value: '周末去机房', text: '周末去机房', lastAt: NOW - 20 * DAY, I: 0.6, hits: 1 };
  const withTime = v10.activationOf(aged, { facts: [aged], query: '周末', now: NOW, cfg }).A;
  const noCue = v10.activationOf(aged, { facts: [aged], query: '机房', now: NOW, cfg }).A;
  assert.ok(withTime > noCue, '时段线索应加分');
  const consolidated = v10.activationOf({ ...aged, hits: 4 }, { facts: [{ ...aged, hits: 4 }], now: NOW, cfg }).A;
  assert.ok(consolidated > v10.activationOf(aged, { facts: [aged], now: NOW, cfg }).A, 'C 高时旧条目衰减更慢');
});

// ── 4. 可信度与渲染 ───────────────────────────────────────────────────────
test('v10：Q 由证据多少决定，三档可配措辞', () => {
  const cfg = v10.normalizeV10({ qLabels: { mid: '大概记得', low: '只记得片段' } });
  const strong = { id: 'a', tier: 'long', quote: '用户下周一要交物理实验报告', source: { id: 1 }, manual: true, topic: 'user:report', hits: 2 };
  const qa = v10.qValueOf(strong, { facts: [strong] });
  assert.equal(v10.qLevelOf(qa, cfg), 'high');
  const bare = { id: 'b', tier: 'general' };
  assert.equal(v10.qLevelOf(v10.qValueOf(bare, { facts: [bare] }), cfg), 'low');

  assert.equal(v10.renderFact({ tier: 'hard', value: '用户不吃香菜' }, { cfg }), '· [hard] 用户不吃香菜');
});

test('v10：渲染按 D 决定说多细，Q 只加前缀（细节完好时不说"只记得片段"）', () => {
  const cfg = v10.normalizeV10({ qLabels: { mid: '大概记得', low: '只记得片段' } });
  // B：今天刚说、细节完好，但没有 quote/source（老数据样式）→ 必须原文直说，不能加"只记得片段"
  const fresh = { tier: 'long', value: '用户爱吃鱼和莲藕排骨汤', text: '用户爱吃鱼和莲藕排骨汤', lastAt: NOW - DAY, hits: 1, class: 'note' };
  assert.equal(v10.renderFact(fresh, { cfg, now: NOW, facts: [fresh] }), '· [long] 用户爱吃鱼和莲藕排骨汤');

  // A：细节已经很模糊（60 天没提），即使 Q 高也只用碎片
  const old = {
    tier: 'general', class: 'note', lastAt: NOW - 60 * DAY, hits: 1,
    value: '用户养了一条叫小鲸的鱼，养了三年', text: '用户养了一条叫小鲸的鱼，养了三年',
    quote: '用户养了一条叫小鲸的鱼，养了三年', source: { id: 'm1' },
    fragments: ['用户养了一条叫小鲸的鱼', '养了三年']
  };
  const oldLine = v10.renderFact(old, { cfg, now: NOW, facts: [old] });
  assert.ok(oldLine.includes('只记得片段'), oldLine);
  assert.ok(oldLine.includes('用户养了一条叫小鲸的鱼'), oldLine);

  // 中间态：D 0.3–0.6 → 原文 + 「细节记不全了」，Q 高不加前缀
  const half = { tier: 'long', class: 'note', lastAt: NOW - 30 * DAY, hits: 1, manual: true, value: '用户下个月要去外地出差', text: '用户下个月要去外地出差', quote: '用户下个月要去外地出差', source: { id: 2 } };
  const midLine = v10.renderFact(half, { cfg, now: NOW, facts: [half] });
  assert.ok(midLine.includes('细节记不全了'), midLine);
  assert.equal(midLine.includes('比较确定'), false, 'Q 高时不加前缀');
});

// ── 5. 检索集成：关闭不加字段，开启加解释并按需记账 ──────────────────────
test('v10：关闭时 search 结果与旧版一致（不多字段）', (t) => {
  const dir = tmp(t);
  const facts = [{ id: 'h1', tier: 'general', class: 'note', status: 'active', value: '用户不吃香菜', text: '用户不吃香菜', sig: 'user:food', topic: 'user:food', I: 0.6, lastAt: NOW, hits: 1 }];
  const rows = search({ query: '香菜', facts, dir, scoring: { mode: 'write' }, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activation, undefined);
  assert.equal(rows[0].qLevel, undefined);
});

test('v10：开启后 search 每条带激活值/可信度解释', (t) => {
  const dir = tmp(t);
  writeV10(dir, { enabled: true });
  const facts = [{ id: 'h1', tier: 'long', class: 'note', status: 'active', value: '用户不吃香菜', text: '用户不吃香菜', sig: 'user:food', topic: 'user:food', I: 0.8, lastAt: NOW, hits: 2, quote: '用户不吃香菜' }];
  const rows = search({ query: '香菜', facts, dir, scoring: { mode: 'write' }, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0].activation, 'number');
  assert.ok(rows[0].q >= 0 && rows[0].q <= 1);
  assert.ok(['high', 'mid', 'low'].includes(rows[0].qLevel));
  const ex = explainFact(rows[0], { query: '香菜', facts, dir, now: NOW });
  assert.equal(typeof ex.activation, 'number');
  assert.ok(ex.parts.base >= 0);
});

test('v10：retrieved 同一条同一天只记一次，且不涨分', (t) => {
  const dir = tmp(t);
  writeV10(dir, { enabled: true, recordRetrieved: true });
  lt.appendEvent(
    { ev: 'fact', id: 'h-x', sig: 'user:food', value: '用户不吃香菜', text: '用户不吃香菜', tier: 'general', class: 'note', I: 0.6, s: 3, hits: 1, lastAt: NOW, at: NOW },
    dir
  );
  search({ query: '香菜', scoring: { mode: 'write' }, dir, now: NOW, recordRetrieved: true });
  search({ query: '香菜', scoring: { mode: 'write' }, dir, now: NOW + 3600_000, recordRetrieved: true });
  const rows = lt.readEvents(dir).rows.filter((r) => r.ev === 'retrieved');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].by, 'search');
  const fact = lt.materialize(lt.readEvents(dir).rows, {}).find((f) => f.id === 'h-x');
  assert.equal(fact.I, 0.6);
  assert.equal(fact.accessCount, 1);
});

test('v10：只有调用方显式 opt-in 且只记返回的条数（CLI 查看不污染 accessCount）', (t) => {
  const dir = tmp(t);
  writeV10(dir, { enabled: true, recordRetrieved: true });
  for (let i = 0; i < 20; i++) {
    lt.appendEvent(
      { ev: 'fact', id: 'h-' + i, sig: 'user:t' + i, topic: 'user:t' + i, value: '测试记忆第' + i + '条', text: '测试记忆第' + i + '条', tier: 'general', class: 'note', I: 0.6, s: 3, hits: 1, lastAt: NOW, at: NOW },
      dir
    );
  }
  // 不 opt-in（CLI recall / MCP / 影子对比的默认行为）：一条都不写
  search({ query: '测试', limit: 5, scoring: { mode: 'write' }, dir, now: NOW });
  assert.equal(lt.readEvents(dir).rows.filter((r) => r.ev === 'retrieved').length, 0);

  // opt-in 且 limit=2：只写 2 条（不是内部 topK 的 20 条）
  search({ query: '测试', limit: 2, scoring: { mode: 'write' }, dir, now: NOW, recordRetrieved: true, recordBy: 'inject' });
  const rows = lt.readEvents(dir).rows.filter((r) => r.ev === 'retrieved');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.by === 'inject'));
});

// ── 6. 入站：开启才写属性字段 ─────────────────────────────────────────────
test('v10：开启时 fact 事件带 emo/rel/scene/fragments，关闭时不带', (t) => {
  const dirOn = tmp(t);
  writeV10(dirOn, { enabled: true });
  recordInbound({ key: 'private:1', text: '我妈生日是十一月二号', ts: NOW, scoring: { mode: 'write' }, dir: dirOn });
  const on = lt.readEvents(dirOn).rows.find((r) => r.ev === 'fact');
  assert.ok(on, '应抽出一条硬事实');
  assert.equal(typeof on.emo, 'number');
  assert.ok(Array.isArray(on.scene));
  assert.ok(Array.isArray(on.fragments));

  const dirOff = tmp(t);
  recordInbound({ key: 'private:1', text: '我妈生日是十一月二号', ts: NOW, scoring: { mode: 'write' }, dir: dirOff });
  const off = lt.readEvents(dirOff).rows.find((r) => r.ev === 'fact');
  assert.ok(off);
  assert.equal('emo' in off, false);
  assert.equal('fragments' in off, false);
});

// ── 7. 注入下限 salienceFloor（v10.1） ────────────────────────────────
test('v10.1：salienceFloor 默认 0（不启用），可显式开、低于阈值不投递', () => {
  assert.equal(v10.V10_DEFAULTS.salienceFloor, 0);
  const off = v10.normalizeV10({ enabled: false, salienceFloor: 20 });
  assert.equal(v10.passesSalience({ activation: 1 }, off), true, '关闭时永远放行');
  const on = v10.normalizeV10({ enabled: true, salienceFloor: 20 });
  assert.equal(on.salienceFloor, 20);
  assert.equal(v10.passesSalience({ activation: 19.9 }, on), false);
  assert.equal(v10.passesSalience({ activation: 20 }, on), true);
  assert.equal(v10.passesSalience({}, on), true, '没有激活值时不拦截（fail-open）');
  assert.equal(v10.normalizeV10({ salienceFloor: 0 }).salienceFloor, 0);
  assert.equal(v10.normalizeV10({ salienceFloor: -3 }).salienceFloor, 0);
  assert.equal(v10.normalizeV10({ salienceFloor: 500 }).salienceFloor, 100);
});

test('v10.1：explainFact 复用 v10.explain，并标出低于注入阈值', (t) => {
  const dir = tmp(t);
  writeV10(dir, { enabled: true, salienceFloor: 30 });
  const stale = {
    id: 'x-1', tier: 'general', class: 'note', value: '很久以前的一条小事',
    text: '很久以前的一条小事', lastAt: NOW - 200 * DAY, hits: 1, I: 0.6
  };
  const ex = explainFact(stale, { dir, now: NOW });
  assert.equal(typeof ex.rendered, 'string');
  assert.ok(ex.rendered.length > 0);
  assert.equal(ex.belowFloor, true, `激活 ${ex.activation} 应低于 30`);
  assert.ok(ex.activation < 30);
});
