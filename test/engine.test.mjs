// 引擎契约测试：不需要网络、不连 DSH，全部在临时目录里跑。
// 覆盖：注入拼装与一次性、轮转（含忙/未就绪/会话变化）、新会话兜底、日终维护、启动日志。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryEngine } from '../src/engine.mjs';
import { createNullHost } from '../src/host.mjs';
import { clearConfigCache } from '../src/config.mjs';
import * as store from '../src/store.mjs';

const KEY = 'private:10001';
const DAY = 86400_000;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-engine-'));
}

// 每个用例：独立数据目录 + 独立 config，summary 关掉（不联网），profile 由用例决定。
function setup(t, { profileEnabled = false, dailyAt = '23:00', memory = {} } = {}) {
  const root = tmpRoot();
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    ownerQQ: '10001',
    memory: {
      enabled: true,
      dir: path.join(root, 'data'),
      windowDays: 7,
      dailyAt,
      summary: { enabled: false },
      profile: { enabled: profileEnabled, maxChars: 1500 },
      ...memory
    }
  }, null, 2));
  process.env.QQ_MEMORY_DIR = path.join(root, 'data');
  process.env.QQ_MEMORY_CONFIG = configPath;
  clearConfigCache();
  store.clearConfigCache();
  t.after(() => {
    delete process.env.QQ_MEMORY_DIR;
    delete process.env.QQ_MEMORY_CONFIG;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, configPath };
}

/** 造一份 token-usage.jsonl：每轮 cacheMiss+cacheHit = tokens。 */
function seedTokens(dir, sid, tokens, turns = 5, at = Date.now()) {
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const lines = [];
  for (let i = 0; i < turns; i += 1) {
    lines.push(JSON.stringify({
      k: 'turn', t: at - (turns - i) * 60000, sid, key: KEY, turn: i + 1, step: 1,
      b: { cacheMiss: 100, cacheHit: tokens - 100, cacheWrite: 0, output: 50 }
    }));
  }
  fs.writeFileSync(path.join(logs, 'token-usage.jsonl'), `${lines.join('\n')}\n`);
}

function seedLog(key = KEY, sid = 'session-test-0001', startedAt = Date.now()) {
  store.noteSession(key, sid, startedAt);
  // messageId 必须全局唯一：store 内部 seenIds 是进程级去重表，多个用例复用同一 id 会被当成重复消息丢掉。
  const tag = `${sid}-${startedAt}`;
  store.recordIncoming({ key, text: '用户：以后都叫我老板', sender: '用户', time: startedAt + 1000, messageId: `${tag}-m1` });
  store.recordIncoming({ key, text: '我记住了：用户喜欢擂饭', sender: '男友', time: startedAt + 2000, messageId: `${tag}-m2` });
  store.recordOutgoing({ key, text: '好，记下了', time: startedAt + 3000, messageId: `${tag}-m3` });
  return sid;
}

test('composePrompt：没有事实卡/交接时原文不动', (t) => {
  setup(t);
  const host = createNullHost();
  const engine = createMemoryEngine({ host });
  const composed = engine.composePrompt(KEY, 'session-x', '你好');
  assert.equal(composed.text, '你好');
  assert.equal(composed.profile, false);
  assert.equal(composed.handover, null);
});

test('composePrompt：事实卡 + 交接都拼进去，commit 后只消费一次', (t) => {
  setup(t, { profileEnabled: true });
  const sid = seedLog();
  store.writeProfile('- 用户喜欢擂饭\n- 用户希望叫小助手我');
  store.setHandover(KEY, '【7 天记忆交接】上一段聊了擂饭', { reason: 'age', sessionId: sid });
  const host = createNullHost();
  const engine = createMemoryEngine({ host });

  const first = engine.composePrompt(KEY, 'session-new', '在吗');
  assert.match(first.text, /长期记忆/);
  assert.match(first.text, /【7 天记忆交接】/);
  assert.match(first.text, /【当前对话】\n在吗$/);
  assert.equal(first.profile, true);
  // 账本记的是她当时真正看到的块：卡只能出现一次（预算装配已含卡时不能再 push 一遍）
  assert.equal(first.blocks.filter((b) => b.k === 'card').length, 1);
  assert.ok(first.blocks.every((b) => typeof b.text === 'string' && b.text.length > 0));
  assert.ok(first.blocks.some((b) => b.k === 'handover'));

  engine.commitInjections(KEY, 'session-new', first);
  assert.equal(store.peekHandover(KEY), null);
  assert.equal(store.profileInjectedFor('session-new'), true);

  const second = engine.composePrompt(KEY, 'session-new', '再问一句');
  assert.equal(second.text, '再问一句');
  assert.equal(second.profile, false);
  assert.deepEqual(second.blocks, []);
});

test('rotate：只认真实 token，不按会话年龄（v7 去掉年龄兜底）', async (t) => {
  setup(t);
  const oldStart = Date.now() - 30 * DAY;
  const sid = seedLog(KEY, 'session-old-0001', oldStart);
  const host = createNullHost({ ownerKey: KEY });
  host.setSession(KEY, sid);
  const engine = createMemoryEngine({ host });

  // 会话很老但没有 token 记录 → 不轮转
  assert.equal(await engine.rotate(KEY, { force: false }), false);
  assert.deepEqual(host.calls.retire, []);
  assert.equal(store.getSessionInfo(KEY).rotations, 0);

  // 人工强制（需用户批准）→ 生成摘要并退役
  assert.equal(await engine.rotate(KEY, { force: true, reason: 'manual' }), false);
  assert.deepEqual(host.calls.retire, []);
  assert.equal(await engine.rotate(KEY, { force: true, reason: 'manual', approved: true }), true);
  assert.deepEqual(host.calls.retire, [KEY]);
  assert.equal(host.getSessionId(KEY), '');
  const handover = store.peekHandover(KEY);
  assert.ok(handover?.text.includes('【7 天记忆交接】'));
  assert.equal(store.getSessionInfo(KEY).rotations, 1);
  assert.ok(fs.readdirSync(path.join(process.env.QQ_MEMORY_DIR, 'digests')).length >= 1);
});

test('rotate：交接摘要里带最近一天原话（窗口账本），总长不超 handoverMaxChars', async (t) => {
  setup(t, { memory: { handoverMaxChars: 1200, handover: { recentSlice: { maxChars: 600, perTurn: 120 } } } });
  const sid = seedLog(KEY, 'session-slice-0001', Date.now() - 2 * DAY);
  const host = createNullHost({ ownerKey: KEY });
  host.setSession(KEY, sid);
  store.noteSession(KEY, sid);
  const dir = process.env.QQ_MEMORY_DIR;
  const { beginTurn, noteSpoken, finishTurn } = await import('../src/window.mjs');
  beginTurn({ key: KEY, sessionId: sid, userRaw: '我极速谷6是预购冲的顶级版', windowText: 'w' });
  noteSpoken({ key: KEY, sessionId: sid, tool: 'qq_send_message', text: '代代都上顶级版，这就不是随便玩玩了' });
  finishTurn({ dir, sessionId: sid, reply: '记住了' });
  const engine = createMemoryEngine({ host });
  assert.equal(await engine.rotate(KEY, { force: true, reason: 'manual', approved: true }), true);
  const handover = store.peekHandover(KEY)?.text || '';
  assert.match(handover, /【最近一天的原话】/);
  assert.match(handover, /顶级版/);
  assert.ok(handover.length <= 1200, `handover 超长：${handover.length}`);
});

test('rotate：真实 token ≥ 0.7×窗口时轮转，冷却期内不再转', async (t) => {
  setup(t, { memory: { rotation: { contextWindowTokens: 100000 } } });
  const sid = seedLog(KEY, 'session-token-0001', Date.now() - 2 * DAY);
  seedTokens(path.join(process.env.QQ_MEMORY_DIR), sid, 80000); // 阈值 70,000
  const host = createNullHost({ ownerKey: KEY });
  host.setSession(KEY, sid);
  const engine = createMemoryEngine({ host });

  const status = engine.rotationStatus(KEY, sid);
  assert.equal(status.due, true);
  assert.equal(status.threshold, 70000);
  assert.equal(status.real.maxRecent, 80000);
  assert.equal(status.window.source, 'config');

  assert.equal(await engine.rotate(KEY), true);
  assert.equal(store.getSessionInfo(KEY).rotations, 1);

  // 冷却期内：同一会话再满足 token 也不转（10 分钟）
  const sid2 = seedLog(KEY, 'session-token-0002', Date.now());
  host.setSession(KEY, sid2);
  seedTokens(path.join(process.env.QQ_MEMORY_DIR), sid2, 90000);
  assert.equal(engine.rotationStatus(KEY, sid2).due, false);
  assert.equal(engine.rotationStatus(KEY, sid2).reason, 'cooldown');
});

test('rotate：token 低于阈值不转（含 minRotateTokens 保底）', async (t) => {
  setup(t, { memory: { rotation: { contextWindowTokens: 1000000, minRotateTokens: 20000 } } });
  const sid = seedLog(KEY, 'session-low-0001', Date.now() - 2 * DAY);
  seedTokens(path.join(process.env.QQ_MEMORY_DIR), sid, 15000); // 低于 20000 保底
  const host = createNullHost({ ownerKey: KEY });
  host.setSession(KEY, sid);
  const engine = createMemoryEngine({ host });
  const status = engine.rotationStatus(KEY, sid);
  assert.equal(status.tokensOk, false);
  assert.equal(status.due, false);
  assert.equal(await engine.rotate(KEY), false);
});

test('rotate：达到 70% 阈值时 force 无需批准，低于阈值才要批准', async (t) => {
  setup(t, { memory: { rotation: { contextWindowTokens: 100000, minRotateTokens: 20000 } } });
  const sid = seedLog(KEY, 'session-gate-0001', Date.now() - 2 * DAY);
  const host = createNullHost({ ownerKey: KEY });
  host.setSession(KEY, sid);
  const engine = createMemoryEngine({ host });

  // 低于阈值：force 不带 approved → 拦下
  seedTokens(path.join(process.env.QQ_MEMORY_DIR), sid, 30000);
  assert.equal(engine.rotationStatus(KEY, sid).due, false);
  assert.equal(await engine.rotate(KEY, { force: true, reason: 'manual' }), false);
  assert.deepEqual(host.calls.retire, []);

  // 达到阈值（80000 ≥ 70000）：force 不带 approved 也放行
  seedTokens(path.join(process.env.QQ_MEMORY_DIR), sid, 80000);
  assert.equal(engine.rotationStatus(KEY, sid).due, true);
  assert.equal(await engine.rotate(KEY, { force: true, reason: 'manual' }), true);
  assert.deepEqual(host.calls.retire, [KEY]);
});

test('rotate：会话忙或 DSH 未就绪时不动作', async (t) => {
  setup(t);
  const sid = seedLog(KEY, 'session-busy-0001', Date.now() - 8 * DAY);
  const host = createNullHost({ ownerKey: KEY });
  host.setSession(KEY, sid);
  const engine = createMemoryEngine({ host });

  host.setBusy(KEY, true);
  assert.equal(await engine.rotate(KEY), false);
  host.setBusy(KEY, false);
  host.setDshReady(false);
  assert.equal(await engine.rotate(KEY), false);
  assert.equal(host.calls.retire.length, 0);
  // 闸门：force 但没有用户批准 → 拒绝
  assert.equal(await engine.rotate(KEY, { force: true, reason: 'manual' }), false);
  assert.equal(host.calls.retire.length, 0);
  // 用户批准后 force 可以越过 DSH 未就绪
  assert.equal(await engine.rotate(KEY, { force: true, reason: 'manual', approved: true }), true);
});

test('ensureFallbackHandover：新会话没有交接时补一份，且每会话只生成一次', async (t) => {
  setup(t);
  seedLog(KEY, 'session-fallback-0001', Date.now() - 2 * DAY);
  const host = createNullHost({ ownerKey: KEY });
  const engine = createMemoryEngine({ host });

  const first = await engine.ensureFallbackHandover(KEY, 'session-new-0001');
  assert.ok(first?.includes('【7 天记忆交接】'));
  assert.equal(store.peekHandover(KEY)?.reason, 'new-session');
  // 同一会话第二次：noteAutoHandover 返回 false，直接跳过（即使 handover 已被消费）
  store.clearHandover(KEY);
  assert.equal(await engine.ensureFallbackHandover(KEY, 'session-new-0001'), null);
  // 已有现成交接时不生成
  store.setHandover(KEY, '现成的摘要', { reason: 'age', sessionId: 'session-other' });
  assert.equal(await engine.ensureFallbackHandover(KEY, 'session-new-0002'), null);
});

test('runDailyMaintenance：归档 + 标记，非日终/重复调用会跳过', async (t) => {
  setup(t, { dailyAt: '00:00' });
  const sid = seedLog(KEY, 'session-daily-0001', Date.now() - 1 * DAY);
  const host = createNullHost({ ownerKey: KEY });
  host.setSession(KEY, sid);
  const engine = createMemoryEngine({ host });

  const result = await engine.runDailyMaintenance();
  assert.equal(result.ok, true);
  assert.equal(result.profile.mode, 'skip');
  assert.equal(store.dailyDue(), false);

  const second = await engine.runDailyMaintenance();
  assert.equal(second.ok, false);
  assert.equal(second.skipped, true);

  const forced = await engine.runDailyMaintenance(Date.now(), { force: true });
  assert.equal(forced.ok, true);
});

test('startMaintenance：打印启用行并可停止', (t) => {
  setup(t);
  const lines = [];
  const host = createNullHost({ log: (m) => lines.push(m), ownerKey: KEY });
  const engine = createMemoryEngine({ host });
  const handle = engine.startMaintenance();
  assert.ok(handle);
  assert.ok(lines.some((l) => l.includes('7 天记忆已启用')));
  engine.stop();
});
