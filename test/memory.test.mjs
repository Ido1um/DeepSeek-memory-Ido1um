// 7 天滚动记忆的离线自测（不连 DSH、不发 QQ）。
//
// 用法：node scripts/test-memory.mjs
// 每个场景用独立的临时目录（QQ_MEMORY_DIR），不碰生产日志 ~/.deepseek-memory/data。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  archiveOld,
  buildHandover,
  clearHandover,
  dailyDue,
  flushMemoryState,
  getSessionInfo,
  markDailyDone,
  markProfileInjected,
  memoryStats,
  markRotation,
  noteAutoHandover,
  noteSession,
  peekHandover,
  profileInjectedFor,
  readProfile,
  recordIncoming,
  recordOutgoing,
  renderProfileCard,
  restoreHandover,
  saveDigest,
  searchMessages,
  setHandover,
  shouldRotate,
  windowBounds,
  writeProfile
} from '../src/store.mjs';
import { extractProfileFallback } from '../src/digest.mjs';

const KEY = 'private:10001';
const results = [];
let failed = 0;

function scenario(name, fn) {
  try {
    fn();
    results.push(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`FAIL  ${name}\n      ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-test-'));
  process.env.QQ_MEMORY_DIR = dir;
  return dir;
}

const pad = (n) => String(n).padStart(2, '0');
function dayStr(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hotFile(root, key = KEY, ts = Date.now()) {
  return path.join(root, 'raw', 'hot', dayStr(ts), `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
}
function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

// ── 1. 日志写入、去重、范围过滤 ──────────────────────────────────────────────
scenario('日志：用户私聊 user+assistant 各一条，同 messageId 不重复', () => {
  const root = tmpDir();
  assert.equal(recordIncoming({ key: KEY, text: '记住，以后白饭要加量', sender: '用户', isOwner: true, messageId: '1001' }), true);
  assert.equal(recordOutgoing({ key: KEY, text: '唔……记住了，用户真会点菜', messageId: '2001' }), true);
  // 同一条消息重投（DSH 重连/补投）不能写第二遍
  assert.equal(recordIncoming({ key: KEY, text: '记住，以后白饭要加量', sender: '用户', isOwner: true, messageId: '1001' }), false);
  const file = hotFile(root);
  const rows = readJsonl(file);
  assert.equal(rows.length, 2, `期望 2 行，实际 ${rows.length}`);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant']);
  assert.equal(rows[0].messageId, '1001');
  assert.equal(rows[1].sender, '助手');
});

scenario('日志：群聊与他人私聊不写入', () => {
  const root = tmpDir();
  assert.equal(recordIncoming({ key: 'group:10002', text: '群里说句话', sender: '群友' }), false);
  assert.equal(recordIncoming({ key: 'private:999', text: '陌生人私聊' }), false);
  assert.equal(fs.existsSync(path.join(root, 'raw', 'hot')), false, 'raw/hot 目录不该被创建');
});

scenario('日志：空文本且无媒体不写', () => {
  const root = tmpDir();
  assert.equal(recordIncoming({ key: KEY, text: '   ' }), false);
  assert.equal(fs.existsSync(path.join(root, 'raw', 'hot')), false);
});

// ── 2. 检索 ──────────────────────────────────────────────────────────────────
scenario('检索：关键词命中、无结果空数组、日期过滤', () => {
  const root = tmpDir();
  const now = Date.now();
  recordIncoming({ key: KEY, text: '明天想吃白饭和西瓜', sender: '用户', time: now, messageId: '11' });
  recordOutgoing({ key: KEY, text: '西瓜！用户带西瓜了吗？', time: now, messageId: '12' });
  recordIncoming({ key: KEY, text: '今天聊的是显存海啸', sender: '用户', time: now, messageId: '13' });

  const hit = searchMessages({ key: KEY, query: '西瓜' });
  assert.equal(hit.length, 2, `关键词「西瓜」应命中 2 条，实际 ${hit.length}`);
  assert.ok(hit.every((r) => r.text.includes('西瓜')));

  const multi = searchMessages({ key: KEY, query: '白饭 西瓜' });
  assert.ok(multi.length >= 2);

  assert.deepEqual(searchMessages({ key: KEY, query: '草莓蛋糕' }), []);

  const today = dayStr(now);
  assert.equal(searchMessages({ key: KEY, query: '西瓜', from: today, to: today }).length, 2);
  assert.equal(searchMessages({ key: KEY, query: '西瓜', from: '2000-01-01', to: '2000-01-02' }).length, 0);
  assert.equal(searchMessages({ key: KEY, query: '西瓜', limit: 1 }).length, 1);

  // 空 query = 最近记录
  assert.equal(searchMessages({ key: KEY, limit: 2 }).length, 2);
});

// ── 3. 轮转判定 ──────────────────────────────────────────────────────────────
scenario('轮转：会话跨出 7 天窗口 / tokens ≥ 60000 / 会话不匹配不轮转', () => {
  const eightDaysAgo = Date.now() - 8 * 24 * 3600 * 1000;
  const seed = (sessionId, startedAt, chars) => {
    const root = tmpDir();
    writeJson(path.join(root, 'state', 'memory.json'), { sessions: { [KEY]: { sessionId, startedAt, chars } }, handovers: {}, lastArchiveAt: 0 });
    return root;
  };

  seed('s1', eightDaysAgo, 1200);
  const byAge = shouldRotate(KEY, 's1');
  assert.equal(byAge.due, true);
  assert.equal(byAge.reason, 'window');
  assert.ok(byAge.windowStart, '应返回窗口起点');

  seed('s1', eightDaysAgo, 1200);
  assert.equal(shouldRotate(KEY, 'other-session').due, false, 'sessionId 不匹配时不该轮转');

  seed('s2', Date.now(), 200001);
  const byTokens = shouldRotate(KEY, 's2');
  assert.equal(byTokens.due, true);
  assert.equal(byTokens.reason, 'tokens');

  seed('s3', Date.now(), 3000);
  assert.equal(shouldRotate(KEY, 's3').due, false);
});

scenario('轮转边界：窗口内最后一刻不轮转、跨出窗口那刻轮转', () => {
  // 不写死日期：用「本地自然日 00:10」当作 now，让窗口边界跟运行环境时区无关
  const now0 = new Date();
  now0.setHours(0, 10, 0, 0);
  const now = now0.getTime();
  const root = tmpDir();
  const startedAt = now - 7 * 24 * 3600 * 1000 + 60 * 1000; // 7 天前多 1 分钟 → 落在窗口第一天内
  writeJson(path.join(root, 'state', 'memory.json'), { sessions: { [KEY]: { sessionId: 's-boundary', startedAt, chars: 3000 } }, handovers: {}, lastArchiveAt: 0 });
  const inside = shouldRotate(KEY, 's-boundary', now);
  assert.equal(inside.due, false, '窗口第一天内不该轮转');
  const outside = shouldRotate(KEY, 's-boundary', now + 24 * 3600 * 1000);
  assert.equal(outside.due, true, '跨出窗口就该轮转');
  assert.equal(outside.reason, 'window');
  assert.match(outside.windowStart, /^\d{4}-\d{2}-\d{2}$/, '窗口起点是自然日字符串');
});

scenario('轮转：noteSession 记录起点并累加 chars', () => {
  const root = tmpDir();
  const sess = noteSession(KEY, 'session-a');
  assert.equal(sess.sessionId, 'session-a');
  recordIncoming({ key: KEY, text: 'x'.repeat(100), sender: '用户' });
  const info = getSessionInfo(KEY);
  assert.ok(info.chars >= 120, `chars 应累加，实际 ${info.chars}`);
  // 同 sessionId 不重置 startedAt
  const again = noteSession(KEY, 'session-a');
  assert.equal(again.startedAt, sess.startedAt);
});

scenario('轮转：markRotation 计数 + 新会话继承', () => {
  const root = tmpDir();
  noteSession(KEY, 'session-old');
  assert.equal(markRotation(KEY, { reason: 'age', sessionId: 'session-old', handoverChars: 89 }), 1);
  const info = getSessionInfo(KEY);
  assert.equal(info.rotations, 1);
  assert.equal(info.lastRotationReason, 'age');
  // 轮转后新会话从 noteSession 出生，应当继承轮转计数（不是归零）。
  const fresh = noteSession(KEY, 'session-new');
  assert.equal(fresh.rotations, 1, '新会话应继承 rotations');
  assert.equal(markRotation(KEY, { reason: 'tokens', sessionId: 'session-new' }), 2);
});

// ── 4. 交接摘要 / digest / 只注入一次 ───────────────────────────────────────
scenario('交接：buildHandover 生成摘要并可写 digest', () => {
  const root = tmpDir();
  const now = Date.now();
  recordIncoming({ key: KEY, text: '以后都只保留私聊 10001，不要改白名单', sender: '用户', time: now - 3600_000 });
  recordIncoming({ key: KEY, text: '今天好累，聊天好无聊', sender: '用户', time: now - 1800_000 });
  recordOutgoing({ key: KEY, text: '唔……那人家陪用户聊', time: now - 1700_000 });
  const text = buildHandover(KEY);
  assert.ok(text.includes('【7 天记忆交接】'), text);
  assert.ok(text.includes('【身份与约定】'), '应包含身份与约定段');
  assert.ok(text.includes('白名单'), '身份与约定应命中白名单那条');
  const file = saveDigest(KEY, text, { reason: 'age', sessionId: 's1' });
  assert.ok(file && fs.existsSync(file), 'digest 文件应写入');
  assert.ok(fs.readFileSync(file, 'utf8').includes('【7 天记忆交接】'));
});

scenario('交接：未收尾的问句进入「未完成话题」', () => {
  const root = tmpDir();
  const now = Date.now();
  recordIncoming({ key: KEY, text: '正常的闲聊', sender: '用户', time: now - 7200_000 });
  recordIncoming({ key: KEY, text: '明天要不要一起看那个视频？', sender: '用户', time: now - 3600_000 });
  const text = buildHandover(KEY);
  assert.ok(text.includes('【未完成话题】'), text);
  assert.ok(text.includes('明天要不要一起看那个视频'), '问句应进入未完成话题');
});

scenario('交接：set → peek → clear/restore，消费后 24h 内可恢复', () => {
  const root = tmpDir();
  setHandover(KEY, '【7 天记忆交接】\n测试摘要');
  const peeked = peekHandover(KEY);
  assert.equal(peeked.text, '【7 天记忆交接】\n测试摘要');
  assert.equal(peekHandover(KEY).text, peeked.text, 'peek 不该清除');
  clearHandover(KEY);
  assert.equal(peekHandover(KEY), null, 'clear 后必须为空');
  // 不是删除而是标记已消费：投递失败可以恢复；落盘文件里仍保留文本。
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'memory.json'), 'utf8'));
  assert.ok(state.handovers[KEY] && state.handovers[KEY].consumedAt > 0, '应记录 consumedAt');
  assert.ok(restoreHandover(KEY), '应能恢复');
  assert.equal(peekHandover(KEY).text, '【7 天记忆交接】\n测试摘要', '恢复后应重新可取');
});

// ── 5. 归档 ──────────────────────────────────────────────────────────────────
scenario('归档：超保留期的 hot 日文件移到 raw/archive/YYYY-MM', () => {
  const root = tmpDir();
  const oldFile = path.join(root, 'raw', 'hot', '2020-01-01', 'private_10001.jsonl');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, `${JSON.stringify({ ts: '2020-01-01T10:00:00.000Z', key: KEY, role: 'user', text: '很旧的对话' })}\n`, 'utf8');
  const moved = archiveOld();
  assert.equal(moved, 1, `应移动 1 个文件，实际 ${moved}`);
  assert.equal(fs.existsSync(oldFile), false, '原热文件应已移走');
  const target = path.join(root, 'raw', 'archive', '2020-01', 'private_10001-2020-01-01.jsonl');
  assert.ok(fs.existsSync(target), '归档目标应存在');
  // 归档后的原文仍可检索
  assert.equal(searchMessages({ key: KEY, query: '很旧的对话' }).length, 1);
});

// ── 6. 7 天窗口 / 日终维护 / 事实卡 ─────────────────────────────────────────
scenario('窗口：windowBounds 从今天往回荡 7 天（自然日）', () => {
  tmpDir();
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const b = windowBounds(now);
  assert.equal(b.today, '2026-10-26');
  assert.equal(b.startDay, '2026-10-19');
  assert.equal(b.windowDays, 7);
  assert.equal(b.startMs, new Date('2026-10-19T00:00:00').getTime());
});

scenario('日终：首跑该维护、跑完不重复、到点再欠一次', () => {
  const root = tmpDir();
  const noon = new Date(2026, 9, 26, 12, 0, 0).getTime();
  writeJson(path.join(root, 'state', 'memory.json'), { sessions: {}, handovers: {}, recentIds: [], lastArchiveAt: 0, lastDailyAt: 0 });
  assert.equal(dailyDue(noon), true, '从没维护过 → 应该欠一次');
  markDailyDone(noon);
  assert.equal(dailyDue(noon + 60_000), false, '刚跑完不该立刻重复');
  assert.equal(dailyDue(new Date(2026, 9, 26, 23, 30, 0).getTime()), true, '当天 23:00 之后应再欠一次');
  markDailyDone(new Date(2026, 9, 26, 23, 30, 0).getTime());
  assert.equal(dailyDue(new Date(2026, 9, 27, 12, 0, 0).getTime()), false, '第二天中午不该补昨天那次');
});

scenario('归档：窗口外的日目录移走，窗口内的留下', () => {
  const root = tmpDir();
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const mk = (day) => {
    const file = path.join(root, 'raw', 'hot', day, 'private_10001.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ts: `${day}T10:00:00.000Z`, key: KEY, role: 'user', text: `记录 ${day}` })}\n`, 'utf8');
    return file;
  };
  const outside = mk('2026-10-18');
  const inside = mk('2026-10-19');
  const moved = archiveOld(now);
  assert.equal(moved, 1, `应只移动窗口外 1 个文件，实际 ${moved}`);
  assert.equal(fs.existsSync(outside), false, '窗口外日目录应已移走');
  assert.ok(fs.existsSync(inside), '窗口内（含 startDay 当天）必须保留');
  assert.ok(fs.existsSync(path.join(root, 'raw', 'archive', '2026-10', 'private_10001-2026-10-18.jsonl')));
});

scenario('事实卡：写入/读取/渲染，每个会话只注入一次', () => {
  tmpDir();
  const chars = writeProfile('- 用户叫助手「胖鱼」\n- 用户生日 11 月 2 日');
  assert.ok(chars > 0, '写入应返回字数');
  assert.ok(readProfile().includes('胖鱼'));
  const card = renderProfileCard();
  assert.ok(card.includes('【长期记忆（事实卡）】'), card);
  assert.ok(card.includes('胖鱼'), card);
  assert.equal(profileInjectedFor('session-x'), false);
  markProfileInjected('session-x');
  assert.equal(profileInjectedFor('session-x'), true);
  assert.equal(profileInjectedFor('session-y'), false, '换会话应重新注入');
  assert.equal(memoryStats().profile.chars > 0, true);
});

scenario('事实卡兜底：模型不可用时从原文提取并合并旧卡', () => {
  tmpDir();
  const transcript = '[2026-10-26] 用户：我的生日是 11 月 2 日，记住\n[2026-10-26] 助手：唔……人家记住了\n[2026-10-26] 用户：明天想吃白饭';
  const text = extractProfileFallback({ previousProfile: '- 用户称呼：用户', transcript, maxChars: 300 });
  assert.ok(text.includes('生日'), text);
  assert.ok(text.includes('- 用户称呼：用户'), '旧卡条目应保留');
  assert.ok(text.length <= 300, `不应超过上限，实际 ${text.length}`);
});

// ── 7. 跨进程持久化 ─────────────────────────────────────────────────────────
scenario('持久化：另一个进程能读到 handover 与统计', () => {
  const root = tmpDir();
  recordIncoming({ key: KEY, text: '重启后还要记得' });
  noteSession(KEY, 'session-persist');
  setHandover(KEY, '【7 天记忆交接】\n跨进程摘要');
  const probe = path.join(root, '_probe.mjs');
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/store.mjs')).href;
  fs.writeFileSync(probe, `import { peekHandover, memoryStats } from ${JSON.stringify(moduleUrl)};\nconsole.log(JSON.stringify({ handover: peekHandover('${KEY}'), stats: memoryStats() }));\n`, 'utf8');
  const run = spawnSync(process.execPath, [probe], { env: { ...process.env, QQ_MEMORY_DIR: root }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.handover.text, '【7 天记忆交接】\n跨进程摘要');
  assert.ok(out.stats.hotFiles >= 1);
  assert.ok(out.stats.sessions[KEY], '会话状态应持久化');
});

scenario('持久化：重启后的去重（跨进程同 messageId 不写第二遍）', () => {
  const root = tmpDir();
  assert.equal(recordIncoming({ key: KEY, text: '只应出现一次', messageId: 'restart-dup-1' }), true);
  assert.equal(recordIncoming({ key: KEY, text: '只应出现一次', messageId: 'restart-dup-1' }), false, '同进程去重');
  flushMemoryState();
  const probe = path.join(root, '_probe-dedupe.mjs');
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/store.mjs')).href;
  fs.writeFileSync(
    probe,
    `import { recordIncoming } from ${JSON.stringify(moduleUrl)};\n` +
    `const ok = recordIncoming({ key: '${KEY}', text: '只应出现一次', messageId: 'restart-dup-1' });\n` +
    `console.log(JSON.stringify({ ok }));\n`,
    'utf8'
  );
  const run = spawnSync(process.execPath, [probe], { env: { ...process.env, QQ_MEMORY_DIR: root }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.ok, false, '新进程读到落盘 recentIds 后不应重复写入');
  const hotDir = path.join(root, 'raw', 'hot');
  const day = fs.readdirSync(hotDir)[0];
  const lines = fs.readFileSync(path.join(hotDir, day, 'private_10001.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, `只应有 1 行，实际 ${lines.length}`);
});

scenario('兜底：新会话补摘要检查标记每个会话只返回一次 true', () => {
  const root = tmpDir();
  assert.equal(noteAutoHandover('sess-a'), true);
  assert.equal(noteAutoHandover('sess-a'), false, '同一会话第二次不应再检查');
  assert.equal(noteAutoHandover('sess-b'), true, '换了会话应重新检查');
});

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log(results.join('\n'));
const stats = memoryStats();
console.log(`\n最后使用的临时目录：${stats.dir}`);
console.log(failed === 0 ? `\n全部通过（${results.length} 个场景）` : `\n${failed} 个场景失败`);
process.exitCode = failed === 0 ? 0 : 1;