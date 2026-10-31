// v7 新模块单测：token / policy / card / doctor + 引擎新行为（三态、投影、再注入、触发）。
// 不联网、不连 DSH，全部在临时目录。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as token from '../src/token.mjs';
import * as policy from '../src/policy.mjs';
import * as card from '../src/card.mjs';
import * as doctor from '../src/doctor.mjs';
import { appendEvent, paths, readEvents } from '../src/longterm.mjs';
import { createMemoryEngine } from '../src/engine.mjs';
import { createNullHost } from '../src/host.mjs';
import { clearConfigCache } from '../src/config.mjs';
import * as store from '../src/store.mjs';
import { classify, normalizeScoring } from '../src/scoring-runner.mjs';

const KEY = 'private:10001';
const DAY = 86400000;
const CFG = normalizeScoring({ mode: 'shadow' });

function mkTmp(prefix = 'dsh-v7-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 带 token 日志的目录。 */
function seedTokenLog(dir, sid, tokens, { turns = 5, at = Date.now(), key = KEY } = {}) {
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const rows = [];
  for (let i = 0; i < turns; i += 1) {
    rows.push(JSON.stringify({
      k: 'turn', t: at - (turns - i) * 60000, sid, key, turn: i + 1, step: 1,
      b: { cacheMiss: 100, cacheHit: Math.max(0, tokens - 100), cacheWrite: 0, output: 10 }
    }));
  }
  fs.appendFileSync(path.join(dir, 'logs', 'token-usage.jsonl'), `${rows.join('\n')}\n`);
}

/** 独立沙箱：临时 config + 独立数据目录 + store 环境变量。 */
function sandbox(t, memory = {}) {
  const root = mkTmp();
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    ownerQQ: '10001',
    memory: {
      enabled: true,
      dir,
      windowDays: 7,
      dailyAt: '23:00',
      summary: { enabled: false },
      profile: { enabled: true, maxChars: 1500 },
      ...memory
    }
  }, null, 2));
  process.env.QQ_MEMORY_DIR = dir;
  process.env.QQ_MEMORY_CONFIG = configPath;
  clearConfigCache();
  store.clearConfigCache();
  t.after(() => {
    delete process.env.QQ_MEMORY_DIR;
    delete process.env.QQ_MEMORY_CONFIG;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const engine = () => createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  return { root, dir, configPath, engine };
}

function factEvent(over = {}) {
  return {
    ev: 'fact',
    id: over.id || `h-test-${Math.random().toString(16).slice(2, 8)}`,
    sig: over.sig || 'user:birthday',
    key: KEY,
    about: over.about || 'user',
    pattern: over.pattern || 'birthday',
    label: over.label || '生日',
    value: over.value || '9 月 5 日',
    text: over.text || '用户 9 月 5 日生日',
    tier: over.tier || 'hard',
    I: over.I ?? 1,
    s: over.s ?? 365,
    hits: 1,
    lastAt: over.lastAt ?? Date.now(),
    at: over.at ?? Date.now()
  };
}

// ── token ────────────────────────────────────────────────────────────────
test('token：只认 k=turn，base 行与坏行都丢掉', () => {
  assert.equal(token.parseTurnLine(JSON.stringify({ k: 'base', b: { cacheMiss: 584381, cacheHit: 42871680 } })), null);
  assert.equal(token.parseTurnLine('not json'), null);
  const t = token.parseTurnLine(`\uFEFF${JSON.stringify({ k: 'turn', t: 100, sid: 's1', b: { cacheMiss: 20, cacheHit: 80 } })}`);
  assert.equal(t.tokens, 100);
  assert.equal(t.sid, 's1');
  assert.equal(token.parseTurnLine(JSON.stringify({ k: 'turn', b: { cacheMiss: 0, cacheHit: 0 } })), null);
});

test('token：maxRecent 取最近 5 轮，按 sessionId 过滤', (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seedTokenLog(dir, 's1', 1000, { turns: 3 });
  seedTokenLog(dir, 's2', 5000, { turns: 6 });
  const s1 = token.realTokens(dir, 's1');
  const s2 = token.realTokens(dir, 's2');
  assert.equal(s1.samples, 3);
  assert.equal(s1.maxRecent, 1000);
  assert.equal(s2.maxRecent, 5000);
  assert.equal(s2.recent.length, 5);
  assert.equal(token.observedMax(dir), 5000);
});

test('token：窗口三级取值（config > meta > observed×1.15 > unknown）', (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(token.readContextWindow({ dir }), { tokens: 0, source: 'unknown' });
  seedTokenLog(dir, 's1', 100000);
  const observed = token.readContextWindow({ dir });
  assert.equal(observed.source, 'observed');
  assert.equal(observed.tokens, 115000);
  assert.deepEqual(token.readContextWindow({ dir, modelWindow: 200000 }), { tokens: 200000, source: 'meta' });
  assert.deepEqual(token.readContextWindow({ dir, config: { contextWindowTokens: 300000 } }), { tokens: 300000, source: 'config' });
});

test('token：判据只有 0.7×窗口 + 保底 + 冷却，没有年龄', (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seedTokenLog(dir, 's1', 70000);
  const base = { dir, sessionId: 's1', config: { contextWindowTokens: 100000 }, lastRotateAt: 0, now: Date.now() };
  assert.equal(token.rotationDecision(base).due, true);
  assert.equal(token.rotationDecision({ ...base, sessionId: 's2' }).due, false); // 没有该会话的 token
  assert.equal(token.rotationDecision({ ...base, lastRotateAt: Date.now() - 1000 }).reason, 'cooldown');
  assert.equal(token.rotationDecision({ ...base, minRotateTokens: 80000 }).due, false);
});

// ── policy ───────────────────────────────────────────────────────────────
test('policy：deny > 白名单 > 暂停 > 显式 > 默认', (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  assert.equal(policy.resolveState(KEY, { config: {}, now }).state, 'full');
  assert.equal(policy.resolveState(KEY, { config: { defaultRecord: false }, now }).state, 'off');
  assert.equal(policy.resolveState(KEY, { config: { allowKeys: ['group:1'] }, now }).state, 'off');
  assert.equal(policy.resolveState(KEY, { config: { allowKeys: [KEY] }, now }).state, 'full');
  assert.equal(policy.resolveState(KEY, { config: { denyKeys: [KEY], allowKeys: [KEY] }, now }).state, 'off');
  // 工作台把 keys 写成字符串
  assert.equal(policy.resolveState(KEY, { config: { keys: { [KEY]: 'log' } }, now }).state, 'log');
  // state/policy.json 覆盖 config
  policy.setKeyState(dir, KEY, 'off', { now });
  assert.equal(policy.resolveState(KEY, { config: {}, state: policy.readPolicyState(dir), now }).state, 'off');
});

test('policy：暂停到期自动恢复', (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  policy.setKeyState(dir, KEY, 'full', { now });
  policy.pauseKey(dir, KEY, 2, { now });
  const paused = policy.resolveState(KEY, { config: {}, state: policy.readPolicyState(dir), now: now + 60000 });
  assert.equal(paused.state, 'off');
  assert.equal(paused.reason, 'paused');
  assert.equal(policy.resolveState(KEY, { config: {}, state: policy.readPolicyState(dir), now: now + 3 * 3600000 }).state, 'full');
  policy.resumeKey(dir, KEY);
  assert.equal(policy.resolveState(KEY, { config: {}, state: policy.readPolicyState(dir), now }).state, 'full');
});

test('policy：三态能力', () => {
  assert.deepEqual(policy.capabilities('off'), { record: false, inject: false, rotate: false });
  assert.deepEqual(policy.capabilities('log'), { record: true, inject: false, rotate: false });
  assert.deepEqual(policy.capabilities('full'), { record: true, inject: true, rotate: true });
});

// ── card ─────────────────────────────────────────────────────────────────
test('card：hard 永不丢，超预算先丢低分 long', () => {
  const hard = factEvent({ id: 'h1', tier: 'hard', I: 1, text: '用户 9 月 5 日生日', value: '9 月 5 日' });
  const longs = Array.from({ length: 8 }, (_, i) => factEvent({
    id: `l${i}`,
    tier: 'long',
    I: i === 0 ? 0.9 : 0.05,
    pattern: `p${i}`,
    label: `第${i}条`,
    value: `用户第 ${i} 次提到的一件很长的旧事，足够占满这一行的宽度用来测试预算挤出`,
    text: `旧事 ${i}`,
    lastAt: Date.now() - i * DAY
  }));
  const built = card.buildCard([hard, ...longs], { maxChars: 200, hardReserveChars: 60, botMaxChars: 40 });
  assert.ok(built.text.includes('【长期记忆（事实卡）】'));
  assert.ok(built.text.includes('9 月 5 日'));
  assert.ok(built.included.some((f) => f.id === 'h1'));
  assert.ok(built.dropped.length >= 1, '预算不够时应该有被挤出的条目');
  assert.ok(!built.dropped.some((f) => f.id === 'h1'), 'hard 不能被挤出');
  assert.ok(built.chars <= 200);
});

test('card：我的事单独限额', () => {
  const facts = [
    factEvent({ id: 'b1', about: 'bot', tier: 'hard', pattern: 'birthday', label: '我的生日', value: '11 月 2 日', text: '助手 11 月 2 日生日' }),
    factEvent({ id: 'b2', about: 'bot', tier: 'hard', pattern: 'name', label: '我的名字', value: '助手', text: '助手正式名助手' })
  ];
  const built = card.buildCard(facts, { maxChars: 1500, botMaxChars: 12 });
  assert.ok(built.text.includes('【我的事】'));
  assert.ok(built.dropped.length >= 1, 'bot 超预算要挤掉');
});

test('card：写盘前备份并保留 backupKeep 份', (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 4; i += 1) {
    card.writeCard(dir, `【长期记忆（事实卡）】\n第 ${i} 版`, { backupKeep: 2 });
  }
  const backups = card.listBackups(dir);
  assert.equal(backups.length, 2);
  assert.match(fs.readFileSync(card.cardFile(dir), 'utf8'), /第 3 版/);
});

// ── doctor ───────────────────────────────────────────────────────────────
test('doctor：健康目录全过，坏行会被指出', (t) => {
  const { dir } = sandbox(t);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  appendEvent(factEvent());
  seedTokenLog(dir, 's-doc', 50000);
  card.writeCard(dir, card.buildCard([factEvent()], { maxChars: 1500 }).text);
  card.writeCard(dir, card.buildCard([factEvent()], { maxChars: 1500 }).text);
  const ok = doctor.checkDataDir(dir, { config: { rotation: { contextWindowTokens: 100000 } } });
  assert.equal(ok.ok, true, `失败项：${ok.failed.join(',')}`);
  assert.ok(ok.checks.some((c) => c.name === '长期库可解析'));
  assert.ok(ok.checks.some((c) => c.name === '事实卡有备份'));

  fs.appendFileSync(paths(dir).longterm, '{"broken":\n');
  const bad = doctor.checkDataDir(dir, { config: {} });
  assert.equal(bad.ok, false);
  assert.ok(bad.failed.includes('长期库可解析'));
});

// ── engine：三态 / 投影 / 再注入 ──────────────────────────────────────────
test('engine：policy=off 时不记、不注入、不轮转', async (t) => {
  const { dir, engine } = sandbox(t, { policy: { keys: { [KEY]: 'off' } } });
  const e = engine();
  const composed = e.composePrompt(KEY, 's-off', '你好');
  assert.equal(composed.text, '你好');
  assert.equal(composed.profile, false);
  const inbound = e.onInbound(KEY, '我生日是 9 月 5 日');
  assert.equal(inbound.mode, 'off');
  assert.equal(inbound.skipped, 'policy-off');
  assert.equal(await e.rotate(KEY, { force: true }), false);
  assert.equal(fs.existsSync(paths(dir).longterm), false);
  assert.equal(fs.existsSync(paths(dir).shadow), false);
});

test('engine：policy=log 时只记日志，不注入不轮转', async (t) => {
  const { engine } = sandbox(t, { policy: { keys: { [KEY]: 'log' } }, scoring: { mode: 'write' } });
  const e = engine();
  assert.equal(e.composePrompt(KEY, 's-log', '你好').text, '你好');
  const inbound = e.onInbound(KEY, '我生日是 9 月 5 日');
  assert.equal(inbound.mode, 'write');
  assert.equal(inbound.added.length, 1);
  assert.equal(await e.rotate(KEY, { force: true }), false);
});

test('engine：write 模式日终用长期库投影事实卡并留备份', async (t) => {
  const { dir, engine } = sandbox(t, { scoring: { mode: 'write' }, profile: { enabled: true, source: 'projection' } });
  store.writeProfile('旧的模型摘要');
  appendEvent(factEvent({ id: 'h-a1', tier: 'hard', text: '用户 9 月 5 日生日', value: '9 月 5 日' }));
  appendEvent(factEvent({ id: 'h-a2', tier: 'long', I: 0.8, pattern: 'food', label: '爱吃', value: '草莓味酸奶', text: '用户爱喝酸奶' }));
  const e = engine();
  const result = await e.runDailyMaintenance(Date.now(), { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.profile.mode, 'projection');
  const text = fs.readFileSync(card.cardFile(dir), 'utf8');
  assert.ok(text.includes('【长期记忆（事实卡）】'));
  assert.ok(text.includes('9 月 5 日'));
  assert.ok(text.includes('草莓味酸奶'));
  assert.ok(card.listBackups(dir).length >= 1);
  assert.equal(result.profile.dropped, 0);
});

test('engine：卡更新后给老会话再注入一次，且只一次', async (t) => {
  const { engine } = sandbox(t, { profile: { enabled: true, reinjectAfterAgeMs: 3 * DAY, reinjectGapMs: 3 * DAY } });
  const sid = 's-reinject';
  store.noteSession(KEY, sid, Date.now() - 5 * DAY);
  store.writeProfile('- 用户喜欢火锅');
  const e = engine();

  const first = e.composePrompt(KEY, sid, '在吗');
  assert.equal(first.profile, true);
  e.commitInjections(KEY, sid, first);
  assert.equal(store.profileInjectedFor(sid), true);

  // 卡更新（写文件会让 store 清掉注入标记）→ 下一句应该重新带卡
  store.writeProfile('- 用户喜欢火锅\n- 用户爱喝草莓味酸奶');
  const second = e.composePrompt(KEY, sid, '再说一遍');
  assert.equal(second.profile, true);
  assert.match(second.text, /草莓味酸奶/);
  e.commitInjections(KEY, sid, second);

  const third = e.composePrompt(KEY, sid, '还有吗');
  assert.equal(third.profile, false);
  assert.equal(third.text, '还有吗');
});

test('engine：旋转状态与 doctor 报告可读', async (t) => {
  const { dir, engine } = sandbox(t, { rotation: { contextWindowTokens: 100000 } });
  const sid = 's-status';
  store.noteSession(KEY, sid, Date.now() - DAY);
  seedTokenLog(dir, sid, 80000);
  const e = engine();
  const status = e.rotationStatus(KEY, sid);
  assert.equal(status.due, true);
  assert.equal(status.threshold, 70000);
  const report = e.doctor();
  assert.equal(typeof report.ok, 'boolean');
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.checks.length >= 8);
});

// ---- 抽取防御：真实语料回放（2026-10-29，6 天 171 条 user 消息）里的误判形态 ----
test('facts：假设/商量句不抽事实', () => {
  const a = classify('我在想要不要直接把你的名字助手写进人设卡，你人设卡里目前的名字还是助手', CFG);
  assert.equal(a.candidates.length, 0, '「要不要…写进人设卡」不是事实');
  const b = classify('如果我的生日是 9 月 5 日', CFG);
  assert.equal(b.candidates.length, 0, '「如果…」是假设');
});

test('facts：陈述句照旧抽，称谓语气词会去掉', () => {
  const user = classify('我生日是 9 月 5 日', CFG);
  assert.equal(user.candidates[0].sig, 'user:生日');
  assert.equal(user.candidates[0].value, '9 月 5 日');
  const bot = classify('你的名字是助手', CFG);
  assert.equal(bot.candidates[0].sig, 'bot:名字');
  assert.equal(bot.candidates[0].value, '助手');
  const nick = classify('以后叫我助手吧', CFG);
  assert.equal(nick.candidates[0].value, '助手');
});
