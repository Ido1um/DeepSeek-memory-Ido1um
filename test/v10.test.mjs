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
    qLabels: { mid: '我记得个大概' },
    thresholds: { high: 0.8 },
    emotionHalfLife: -5,
    quiet: 1
  });
  assert.equal(c.enabled, true);
  assert.equal(c.qLabels.mid, '我记得个大概');
  assert.equal(c.qLabels.low, '只记得片段');
  assert.equal(c.thresholds.high, 0.8);
  assert.equal(c.emotionHalfLife, 180);
  assert.equal('quiet' in c, false);
});

test('v10：loadV10 从数据目录读 v10.json，缺文件回默认', (t) => {
  const dir = tmp(t);
  assert.equal(v10.loadV10(dir).enabled, false);
  writeV10(dir, { enabled: true, qLabels: { low: '唔……我就剩点零碎印象了' } });
  const c = v10.loadV10(dir);
  assert.equal(c.enabled, true);
  assert.equal(c.qLabels.low, '唔……我就剩点零碎印象了');
});

// ── 2. 属性 ────────────────────────────────────────────────────────────────
test('v10：attrsOf 抽情绪/关系/场景（带强度词与场景词）', () => {
  const sad = v10.attrsOf('用户今天特别难过，一个人在家里哭了很久');
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
  const cfg = v10.normalizeV10({ qLabels: { mid: '我记得个大概', low: '唔……我就剩点零碎印象了' } });
  const strong = { id: 'a', tier: 'long', quote: '用户下周一要交物理实验报告', source: { id: 1 }, manual: true, topic: 'user:report', hits: 2 };
  const qa = v10.qValueOf(strong, { facts: [strong] });
  assert.equal(v10.qLevelOf(qa, cfg), 'high');
  const bare = { id: 'b', tier: 'general' };
  assert.equal(v10.qLevelOf(v10.qValueOf(bare, { facts: [bare] }), cfg), 'low');

  assert.equal(v10.renderFact({ tier: 'hard', value: '用户不吃香菜' }, { cfg }), '· [hard] 用户不吃香菜');
});

test('v10：渲染按 D 决定说多细，Q 只加前缀（细节完好时不说"只记得片段"）', () => {
  const cfg = v10.normalizeV10({ qLabels: { mid: '我记得个大概', low: '唔……我就剩点零碎印象了' } });
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
  assert.ok(oldLine.includes('零碎印象'), oldLine);
  assert.ok(oldLine.includes('用户养了一条叫小鲸的鱼'), oldLine);

  // 中间态：D 0.3–0.6 → 原文 + 「细节记不全了」，Q 高不加前缀
  const half = { tier: 'long', class: 'note', lastAt: NOW - 30 * DAY, hits: 1, manual: true, value: '用户下个月要去兰州出差', text: '用户下个月要去兰州出差', quote: '用户下个月要去兰州出差', source: { id: 2 } };
  const midLine = v10.renderFact(half, { cfg, now: NOW, facts: [half] });
  assert.ok(midLine.includes('细节记不全了'), midLine);
  assert.equal(midLine.includes('我记得'), false, 'Q 高时不加前缀');
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

// v10.2：retrieved 事件带上这次命中里的 cue 分值，便于回看「为什么想起」
test('v10.2：retrieved 事件记录 cue（场景/时段/情绪线索），没有激活值时记 0', (t) => {
  const dir = tmp(t);
  writeV10(dir, { enabled: true, recordRetrieved: true });
  lt.appendEvent(
    {
      ev: 'fact', id: 'h-cue', sig: 'user:home', topic: 'user:home',
      value: '周末在家里有点难过，把书架重新摆了一遍', text: '周末在家里有点难过，把书架重新摆了一遍',
      tier: 'general', class: 'event', I: 0.6, s: 3, hits: 1, lastAt: NOW, at: NOW,
      scene: ['家里'], rel: 0, emo: -0.4
    },
    dir
  );
  // 命中场景（家里）+ 时段（周末）+ 情绪（难过）：cue 至少 6+4+4
  search({ query: '周末在家里有点难过', limit: 2, scoring: { mode: 'write' }, dir, now: NOW, recordRetrieved: true, recordBy: 'inject' });
  let ev = lt.readEvents(dir).rows.find((r) => r.ev === 'retrieved');
  assert.ok(ev, '应写一条 retrieved');
  assert.equal(typeof ev.cue, 'number');
  assert.ok(ev.cue >= 14, 'cue 应包含场景/时段/情绪线索，实际 ' + ev.cue);

  // 关闭 v10 时根本不记账（与旧行为一致），不会写没有 cue 的事件
  const dirOff = tmp(t);
  writeV10(dirOff, { enabled: false });
  lt.appendEvent(
    { ev: 'fact', id: 'h-off', sig: 'user:x', topic: 'user:x', value: '测试记忆', text: '测试记忆', tier: 'general', class: 'note', I: 0.6, s: 3, hits: 1, lastAt: NOW, at: NOW },
    dirOff
  );
  search({ query: '测试', limit: 1, scoring: { mode: 'write' }, dir: dirOff, now: NOW, recordRetrieved: true });
  assert.equal(lt.readEvents(dirOff).rows.filter((r) => r.ev === 'retrieved').length, 0);
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

// ── 8. 情绪残留 → 语气提示（P2 阶段 C） ─────────────────────────────
test('v10.3：toneResidue 关闭不提示；强情绪 + 细节模糊 + 近 7 天提过才提示', () => {
  const now = NOW;
  const faint = {
    id: 't-1', topic: 'user:搬家', label: '搬家', tier: 'general', class: 'event',
    value: '上个月搬家那几天有点难过，行李堆了一地', text: '上个月搬家那几天有点难过，行李堆了一地',
    emo: -0.8, rel: 0, lastAt: now - 60 * DAY, hits: 1, I: 0.6, s: 3
  };
  const off = v10.normalizeV10({ enabled: true, toneResidue: false });
  assert.equal(v10.toneHintOf([faint], { query: '搬家', cfg: off, now }), null, '关闭时不提示');
  const on = v10.normalizeV10({ enabled: true, toneResidue: true });
  const hint = v10.toneHintOf([faint], { query: '搬家', cfg: on, now });
  assert.ok(hint, '应生成一条语气提示');
  assert.equal(hint.topic, 'user:搬家');
  assert.ok(hint.text.includes('搬家'));
  assert.ok(hint.text.startsWith('〔语气提示〕'));
  assert.ok(hint.text.length <= on.tone.maxChars, `超长：${hint.text.length}`);

  // 细节还清楚（今天刚聊过）不提示
  const fresh = { ...faint, id: 't-2', lastAt: now };
  assert.equal(v10.toneHintOf([fresh], { query: '搬家', cfg: on, now }), null);

  // 情绪不够强不提示
  const mild = { ...faint, id: 't-3', emo: -0.2 };
  assert.equal(v10.toneHintOf([mild], { query: '搬家', cfg: on, now }), null);

  // 当前没提到、也不在 7 天窗口内 → 不翻旧账
  assert.equal(v10.toneHintOf([faint], { query: '今天吃什么', cfg: on, now }), null);

  // 高兴的强情绪不该被说成「气氛偏低」
  const happy = { ...faint, id: 't-4', emo: 0.8 };
  assert.equal(v10.toneHintOf([happy], { query: '搬家', cfg: on, now }), null);
});

test('v10.3：同一 topic 在冷却窗口内只提示一次，过了冷却可以再提示', () => {
  const now = NOW;
  const faint = {
    id: 't-5', topic: 'user:搬家', label: '搬家', tier: 'general', class: 'event',
    value: '搬家那几天有点难过', text: '搬家那几天有点难过',
    emo: -0.8, lastAt: now - 60 * DAY, hits: 1, I: 0.6, s: 3
  };
  const cfg = v10.normalizeV10({ enabled: true, toneResidue: true });
  const last = (topic) => (topic === 'user:搬家' ? now - 3600_000 : 0);
  assert.equal(v10.toneHintOf([faint], { query: '搬家', cfg, now, lastToneAt: last }), null, '1 小时前刚提示过');
  const earlier = (topic) => (topic === 'user:搬家' ? now - 25 * 3600_000 : 0);
  assert.ok(v10.toneHintOf([faint], { query: '搬家', cfg, now, lastToneAt: earlier }), '25 小时后可再提示');
});

test('v10.3：tone 事件不被 materialize 当成事实，也不影响事实数', (t) => {
  const dir = tmp(t);
  lt.appendEvent({ ev: 'fact', id: 'f-1', sig: 'user:搬家', topic: 'user:搬家', value: '搬家那几天有点难过', text: '搬家那几天有点难过', tier: 'general', class: 'event', I: 0.6, s: 3, hits: 1, lastAt: NOW - 60 * DAY, at: NOW - 60 * DAY, emo: -0.8 }, dir);
  lt.appendEvent({ ev: 'tone', topic: 'user:搬家', at: NOW, by: 'inject' }, dir);
  const facts = lt.materialize(lt.readEvents(dir).rows);
  assert.equal(facts.length, 1, 'tone 事件不应产生事实');
  assert.equal(facts[0].id, 'f-1');
});

test('v10.3：tone 配置支持部分覆盖并夹取范围', () => {
  const c = v10.normalizeV10({ tone: { minEmotion: 2, maxDetail: -1, cooldownHours: 12 } });
  assert.equal(c.tone.minEmotion, 1);
  assert.equal(c.tone.maxDetail, 0);
  assert.equal(c.tone.cooldownHours, 12);
  assert.equal(c.tone.windowDays, 7, '未覆盖的保持默认');
});

// ── P2 阶段 D：人格语气摘要（profile-tone.md） ─────────────────────────────
test('v10.4：buildToneSummary 只用最近强情绪事件，没有就返回空', () => {
  const now = NOW;
  const cfg = v10.normalizeV10({ enabled: true, toneSummary: true });
  const neg = {
    id: 's-1', topic: 'user:搬家', label: '搬家', emo: -0.8, lastAt: now - 2 * DAY,
    scene: ['家里'], value: '搬家那几天很难过', text: '搬家那几天很难过'
  };
  const pos = {
    id: 's-2', topic: 'user:生日', label: '生日', emo: 0.9, lastAt: now - 1 * DAY,
    scene: ['家里'], value: '生日那天很开心', text: '生日那天很开心'
  };
  const old = { id: 's-3', topic: 'user:旧事', label: '旧事', emo: -0.9, lastAt: now - 30 * DAY, value: '很久以前很难过', text: '很久以前很难过' };
  const mild = { id: 's-4', topic: 'user:小事', label: '小事', emo: -0.2, lastAt: now - DAY, value: '有点烦', text: '有点烦' };

  const text = v10.buildToneSummary([neg, pos, old, mild], { cfg, now });
  assert.ok(text.length > 0, '有强情绪事件就应生成');
  assert.ok(text.includes('偏沉') || text.includes('2/2'), text);
  assert.ok(text.includes('最近') && text.includes('天'), text);
  assert.ok(!text.includes('旧事'), '窗口外的不算进来');
  assert.ok(v10.buildToneSummary([], { cfg, now }) === '');
  assert.ok(v10.buildToneSummary([mild], { cfg, now }) === '', '情绪不够强不生成');
});

test('v10.4：writeToneSummary 幂等、变内容先备份，readToneSummary 按 mtime 生效', (t) => {
  const dir = tmp(t);
  const now = NOW;
  const r1 = v10.writeToneSummary(dir, '最近 7 天情绪偏沉。', { now });
  assert.equal(r1.written, true);
  assert.equal(v10.readToneSummary(dir), '最近 7 天情绪偏沉。');

  const r2 = v10.writeToneSummary(dir, '最近 7 天情绪偏沉。', { now });
  assert.equal(r2.written, false, '内容没变不重写');

  const r3 = v10.writeToneSummary(dir, '最近 7 天情绪不错。', { now: now + 1000 });
  assert.equal(r3.written, true);
  assert.ok(r3.backup && fs.existsSync(r3.backup), '改内容要先备份旧文件');
  assert.equal(v10.readToneSummary(dir), '最近 7 天情绪不错。');

  // 人工直接改文件（模拟）→ 下一次读取生效
  fs.writeFileSync(v10.toneSummaryPath(dir), '人工改过的语气备忘。', 'utf8');
  assert.equal(v10.readToneSummary(dir), '人工改过的语气备忘。');
});

test('v10.4：摘要注入是一行且受开关与长度限制', (t) => {
  const dir = tmp(t);
  const off = v10.normalizeV10({ enabled: true, toneSummary: false });
  const on = v10.normalizeV10({ enabled: true, toneSummary: true, tone: { summaryInjectMaxChars: 20 } });
  v10.writeToneSummary(dir, '最近 7 天聊得多，情绪偏沉（2/3）；常谈到家里、机房；提到「搬家」时语气沉，记得放轻一点。', { now: NOW });

  assert.equal(v10.toneSummaryLine(dir, off), '', '关闭时不注入');
  const line = v10.toneSummaryLine(dir, on);
  assert.ok(line.startsWith('〔语气备忘〕'), line);
  assert.ok(line.length <= 20 + '〔语气备忘〕'.length, line);
  assert.ok(!line.includes('\n'));
});

test('v10.4：没有 profile-tone.md 时行为回旧版（不注入、不报错）', (t) => {
  const dir = tmp(t);
  const on = v10.normalizeV10({ enabled: true, toneSummary: true });
  assert.equal(v10.readToneSummary(dir), '');
  assert.equal(v10.toneSummaryLine(dir, on), '');
});

// ── 检索匹配：整句切词（阶段 B 前置） ─────────────────────────────────────
test('v10.5：tokens 模式能让整句检索到事实，substring 模式不能', (t) => {
  const dir = tmp(t);
  const facts = [
    { id: 'f1', tier: 'hard', class: 'note', status: 'active', value: '用户爱吃鱼和莲藕排骨汤', text: '用户爱吃鱼和莲藕排骨汤', sig: 'user:food', topic: 'user:food', I: 1, lastAt: NOW, hits: 1 },
    { id: 'f2', tier: 'general', class: 'note', status: 'active', value: '用户下周一要交实验报告', text: '用户下周一要交实验报告', sig: 'user:report', topic: 'user:report', I: 0.7, lastAt: NOW, hits: 1 }
  ];
  const q = '今天回家路上突然想吃鱼';
  assert.equal(search({ query: q, facts, dir, scoring: { mode: 'write' }, limit: 5, now: NOW }).length, 0, 'substring 模式匹配不到整句');
  const tok = search({ query: q, facts, dir, scoring: { mode: 'write' }, limit: 5, now: NOW, match: 'tokens' });
  assert.ok(tok.some((r) => r.id === 'f1'), 'tokens 模式应命中「吃鱼」');

  const none = search({ query: '今天怎么样', facts, dir, scoring: { mode: 'write' }, limit: 5, now: NOW, match: 'tokens' });
  assert.equal(none.length, 0, '停用词不应把事实全捞出来');
});

// ── v10.6 审计回归：短查询回退 / 注入长度 / 备份唯一 / 措辞 / topic 兜底 ─────
test('v10.6：tokens 模式对切不出二元组的短查询回退整句', (t) => {
  const dir = tmp(t);
  const facts = [
    { id: 'f1', tier: 'hard', class: 'note', status: 'active', value: '用户爱吃鱼', text: '用户爱吃鱼', sig: 'user:food', topic: 'user:food', I: 1, lastAt: NOW, hits: 1 }
  ];
  const tok = search({ query: '鱼', facts, dir, scoring: { mode: 'write' }, limit: 5, now: NOW, match: 'tokens' });
  assert.equal(tok.length, 1, '「鱼」切不出二元组时应退回 substring，而不是 0 条');
  const long = search({ query: '今天路上想吃鱼', facts, dir, scoring: { mode: 'write' }, limit: 5, now: NOW, match: 'tokens' });
  assert.equal(long.length, 1, '长句仍按二元组命中');
});

test('v10.6：摘要注入一行的长度上限包含前缀', (t) => {
  const dir = tmp(t);
  const cfg = v10.normalizeV10({ enabled: true, toneSummary: true, tone: { summaryInjectMaxChars: 20 } });
  v10.writeToneSummary(dir, '一一一一一一一一一一一一一一一一一一一一一一一一一一一一', { now: NOW });
  const line = v10.toneSummaryLine(dir, cfg);
  assert.ok(line.length <= 20, `总长度应 <= 20，实际 ${line.length}`);
  assert.ok(line.startsWith('〔语气备忘〕'), line);
});

test('v10.6：摘要放太久不再冒充近况', (t) => {
  const dir = tmp(t);
  const cfg = v10.normalizeV10({ enabled: true, toneSummary: true });
  v10.writeToneSummary(dir, '最近 7 天聊得多，情绪偏沉（2/3）', { now: NOW });
  const file = v10.toneSummaryPath(dir);
  const old = new Date(NOW - 30 * 86400000);
  fs.utimesSync(file, old, old);
  assert.equal(v10.toneSummaryLine(dir, cfg), '', '30 天前的摘要不应再注入');
  const fresh = new Date(NOW);
  fs.utimesSync(file, fresh, fresh);
  assert.ok(v10.toneSummaryLine(dir, cfg).startsWith('〔语气备忘〕'));
});

test('v10.6：同一秒内两次写入不会互相覆盖备份', (t) => {
  const dir = tmp(t);
  v10.writeToneSummary(dir, '第一版', { now: NOW });
  v10.writeToneSummary(dir, '第二版', { now: 1800000000000 });
  v10.writeToneSummary(dir, '第三版', { now: 1800000000000 });
  const baks = fs.readdirSync(dir).filter((n) => n.startsWith('profile-tone.md.bak-'));
  assert.equal(baks.length, 2, `同秒两次应留下 2 份备份，实际 ${baks.length}`);
  assert.equal(v10.readToneSummary(dir), '第三版');
});

test('v10.6：只有 1–2 次情绪时不说「聊得多」', (t) => {
  const dir = tmp(t);
  const cfg = v10.normalizeV10({ enabled: true });
  const facts = [
    { id: 'a', tier: 'long', status: 'active', value: '搬家那天很难过', label: '搬家', topic: 'user:a', emo: -0.8, lastAt: NOW, hits: 2, I: 0.8 }
  ];
  const text = v10.buildToneSummary(facts, { cfg, now: NOW });
  assert.ok(text.includes('有 1 次情绪起伏'), text);
  assert.ok(!text.includes('聊得多'), text);
});

test('v10.6：toneCandidate 对没有 topic 的旧事实用 sig 兜底', (t) => {
  tmp(t);
  const cfg = v10.normalizeV10({ enabled: true, toneResidue: true });
  const facts = [
    { id: 'old', tier: 'general', class: 'note', status: 'active', value: '搬家那天很难过，把书架重新摆了一遍', label: '搬家', topic: '', sig: 'user:move', emo: -0.8, lastAt: NOW - 45 * DAY, hits: 1, I: 0.8 }
  ];
  const cand = v10.toneCandidate(facts, { query: '今天又想到搬家的事了', cfg, now: NOW });
  assert.ok(cand, 'sig 兜底后应能成为候选');
  assert.equal(cand.topic, 'user:move');
});
