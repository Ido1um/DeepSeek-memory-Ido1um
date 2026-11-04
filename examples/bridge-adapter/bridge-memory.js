// 最小宿主适配器示例：把记忆引擎接到一个「能存会话 id、能发消息」的宿主上。
//
// 这个文件不依赖任何具体平台，只演示三件事：
//   1) host 契约怎么实现；
//   2) 一轮里 onInbound / composePrompt / beginTurn / finishTurn 的调用顺序；
//   3) 轮转闸门怎么在宿主侧复现。
//
// 跑起来看效果（数据写在系统临时目录，不碰真实数据）：
//   node examples/bridge-adapter/bridge-memory.js

import os from 'node:os';
import path from 'node:path';

import { createMemoryEngine } from '../../src/engine.mjs';
import * as window from '../../src/window.mjs';

const DIR = process.env.QQ_MEMORY_DIR || path.join(os.tmpdir(), 'deepseek-memory-demo');
process.env.QQ_MEMORY_DIR = DIR; // 让引擎与示例写同一个目录

const KEY = 'private:10001';

// ── 1. host：引擎需要的 8 个方法 ────────────────────────────────────────────
const sessions = new Map([[KEY, 'demo-session-1']]);
const busy = new Set();

const host = {
  log: (msg) => console.log('[memory]', msg),
  listSessions: () => [...sessions.keys()],
  getSessionId: (key) => sessions.get(key) || '',
  retireSession: (key) => {
    sessions.delete(key);
    return true;
  },
  isBusy: (key) => busy.has(key),
  isDshReady: () => true,
  afterRotate: (key, info) => console.log(`[host] 会话已轮转：${key}`, info?.sessionId || ''),
  getOwnerKey: () => KEY,
  // 宿主能拿到真实上下文压力时再实现这个，否则引擎按日志估算：
  // pressureTokens: (sessionId) => ({ tokens: 0, window: 0 }),
};

const engine = createMemoryEngine({
  getConfig: () => ({ memory: { enabled: true, dir: DIR } }),
  host,
});

// ── 2. 一轮：记录 → 拼注入 → 开账本 → 发送 → 落账本 ─────────────────────────
async function oneTurn(userText) {
  const sessionId = host.getSessionId(KEY);

  // a) 打分/候选（每条用户消息都要过）
  engine.onInbound(KEY, userText, { ts: Date.now() });

  // b) 拼注入：引擎只返回文本，不负责送达
  const composed = engine.composePrompt(KEY, sessionId, userText);

  // c) 开账本：把「用户原话」和「拼好的完整窗口」记成草稿
  window.beginTurn({
    key: KEY,
    sessionId,
    userRaw: userText,
    windowText: composed.text,
    blocks: window.splitWindowBlocks(composed.text),
  });

  // d) 这里换成「真正发给模型、拿回回复」；示例直接编一句
  const raw = `收到：${userText} [[feel:calm]]这句话我先记着。[[/feel]]`;

  // e) 发出去之前剥掉感受标记（想法只留给自己）
  const { text: visible } = window.stripFeels(raw);
  console.log('[send]', visible);

  // f) 记下「真正发出去的话」，再落账本
  window.noteSpoken({ key: KEY, sessionId, tool: 'send_message', text: visible });
  window.finishTurn({ dir: engine.dataDir(), key: KEY, sessionId, reply: raw });

  // g) 送达之后再确认消费（否则模型没看到，注入却被标成已用）
  engine.commitInjections(KEY, sessionId, composed);
}

// ── 3. 轮转闸门：未达 70% 必须有人批准 ─────────────────────────────────────
async function resetSession({ approved = false } = {}) {
  const status = engine.rotationStatus(KEY, host.getSessionId(KEY));
  if (!approved && !status.due) {
    const used = status.real?.maxRecent || 0;
    console.log(`[reset] 未达阈值（${used}/${status.threshold || 0}），需要批准`);
    return false;
  }
  return engine.rotate(KEY, { force: true, approved, reason: approved ? 'user-approved' : 'pressure' });
}

await oneTurn('我叫阿明，喜欢喝乌龙茶。');
await oneTurn('下周三记得提醒我交报告。');

// 轮转后 host 会 retire 旧会话，先记住 id 再看账本
const before = host.getSessionId(KEY);
await resetSession();               // 未达阈值 → false
await resetSession({ approved: true });

console.log(`\n数据目录：${engine.dataDir()}`);
console.log(`窗口轮数：${window.readTurns(engine.dataDir(), before).length}`);
