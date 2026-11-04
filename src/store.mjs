// 7 天滚动记忆的持久化层。
//
// 设计约束：
// - 只负责「日志 / 归档 / 检索 / 交接摘要」这些纯文件操作，不碰 DSH 会话、不 import bridge.js；
//   轮转和 prompt 注入由 bridge.js 负责，避免两个模块互相依赖。
// - 日志必须同步落盘（appendFileSync），桥接崩溃/重启时最多丢最后一条，不丢历史。
// - 默认只允许 private:<owner> 使用；key 会做文件名 sanitize，防止路径穿越。
// - 7 天是「热日志目录」的保留期，不是删除期：更早的日文件移到 archive，默认永久保留。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_DIR, loadConfig, clearConfigCache, memorySection, ownerQQ } from './config.mjs';

const MAX_MESSAGE_CHARS = 8000;
const SEARCH_MIN_QUERY = 1;

export { clearConfigCache };

function cfg() {
  const c = memorySection();
  // 测试隔离：QQ_MEMORY_DIR 只覆盖当前进程的日志目录，生产环境不设置这个变量。
  const envDir = String(process.env.QQ_MEMORY_DIR || '').trim();
  const dir = envDir || String(c.dir || DEFAULT_DIR).trim() || DEFAULT_DIR;
  const dailyAt = String(c.dailyAt || '').trim();
  return {
    enabled: c.enabled !== false,
    dir,
    // 保留窗口按「自然日」算：今天减去 windowDays 天（含当天）也就是 7 天窗口。
    // 旧配置 retentionHours 仍兼容读取，但窗口/归档/轮转都以 windowDays 为准。
    windowDays: Math.min(30, Math.max(1, Number(c.windowDays) || 7)),
    // 日终维护时刻（本地时间 HH:MM）：归档 + 事实卡更新 + 轮转检查都在这个点做。
    dailyAt: /^([01]?\d|2[0-3]):[0-5]\d$/.test(dailyAt) ? dailyAt : '23:00',
    retentionHours: Math.min(24 * 365, Math.max(1, Number(c.retentionHours) || 168)),
    maxSessionTokens: Math.max(0, Number(c.maxSessionTokens) || 60000),
    maxCharsPerMessage: Math.min(20000, Math.max(500, Number(c.maxCharsPerMessage) || MAX_MESSAGE_CHARS)),
    archiveEnabled: c.archive !== false,
    handoverMaxChars: Math.min(12000, Math.max(500, Number(c.handoverMaxChars) || 3500)),
    searchLimit: Math.min(20, Math.max(1, Number(c.search?.limit) || 5)),
    archiveCheckIntervalMs: Math.min(24 * 3600 * 1000, Math.max(60000, Number(c.checkIntervalMs) || 600000)),
    // 长期记忆事实卡（memory/profile.md）：由模型把 7 天日志提炼成稳定事实，注入新会话。
    profileEnabled: c.profile?.enabled !== false,
    profileMaxChars: Math.min(4000, Math.max(200, Number(c.profile?.maxChars) || 1500))
  };
}

function dirs() {
  const root = cfg().dir;
  return {
    root,
    // 新布局：原文统一放 raw/ 下（raw/hot、raw/archive）；digests/profile/state 保持原位。
    raw: path.join(root, 'raw'),
    hot: path.join(root, 'raw', 'hot'),
    archive: path.join(root, 'raw', 'archive'),
    digests: path.join(root, 'digests'),
    state: path.join(root, 'state'),
    stateFile: path.join(root, 'state', 'memory.json')
  };
}

function ensureDirs() {
  const d = dirs();
  for (const p of [d.root, d.raw, d.hot, d.archive, d.digests, d.state]) fs.mkdirSync(p, { recursive: true });
}

/** 记忆数据根目录（长期记忆 / 影子采样等模块复用，已含 QQ_MEMORY_DIR 覆盖）。 */
export function dataDir() {
  return cfg().dir;
}

function pad(n) { return String(n).padStart(2, '0'); }

function dayStr(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStr(day) {
  return String(day).slice(0, 7);
}

function dayStartMs(day) {
  const t = new Date(`${day}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 在 YYYY-MM-DD 上加减天数（用本地时间正午做基准，避开夏令时/时区边界）。 */
function shiftDay(day, delta) {
  const d = new Date(`${day}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return day;
  d.setDate(d.getDate() + delta);
  return dayStr(d.getTime());
}

/**
 * 7 天窗口的边界：今天（含）往前数 windowDays 天。
 * 例：今天 2026-10-26、windowDays=7 → startDay=2026-10-19，保留 10-19 起的日目录。
 */
export function windowBounds(now = Date.now()) {
  const c = cfg();
  const today = dayStr(now);
  const startDay = shiftDay(today, -c.windowDays);
  return { today, startDay, startMs: dayStartMs(startDay), windowDays: c.windowDays };
}

/** 今天的日终时刻（本地 HH:MM）对应的毫秒时间戳。 */
export function dailyCutMs(now = Date.now()) {
  const [h, m] = cfg().dailyAt.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * 今天是否还欠一次日终维护：
 * - 到了今天的 dailyAt 之后 → 期望值是今天的日终时刻；
 * - 还没到 → 期望值是昨天的日终时刻（顺带补上昨天错过的）。
 * lastDailyAt 早于期望值就要跑一次；跑完 markDailyDone 记当前时间。
 */
export function dailyDue(now = Date.now()) {
  const cut = dailyCutMs(now);
  const expected = now >= cut ? cut : cut - 86400000;
  return (Number(getState().lastDailyAt) || 0) < expected;
}

export function markDailyDone(now = Date.now()) {
  const st = getState();
  st.lastDailyAt = Number(now) || Date.now();
  saveStateNow();
  return st.lastDailyAt;
}

function safeKey(key) {
  return String(key ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

function hotFile(key, ts = Date.now()) {
  return path.join(dirs().hot, dayStr(ts), `${safeKey(key)}.jsonl`);
}

function archiveFile(key, day) {
  return path.join(dirs().archive, monthStr(day), `${safeKey(key)}-${day}.jsonl`);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readState() {
  const raw = readJson(dirs().stateFile, null);
  if (!raw || typeof raw !== 'object') return { sessions: {}, handovers: {}, recentIds: [], lastArchiveAt: 0, lastDailyAt: 0, profileUpdatedAt: 0, profileInjectedFor: '', autoHandoverFor: '' };
  return {
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    handovers: raw.handovers && typeof raw.handovers === 'object' ? raw.handovers : {},
    // 去重标记也落盘：重启后 SnowLuma 重放事件时不会把同一条消息再写一遍。
    recentIds: Array.isArray(raw.recentIds) ? raw.recentIds.filter((v) => typeof v === 'string').slice(-500) : [],
    lastArchiveAt: Number(raw.lastArchiveAt) || 0,
    lastDailyAt: Number(raw.lastDailyAt) || 0,
    profileUpdatedAt: Number(raw.profileUpdatedAt) || 0,
    // 事实卡已注入到哪个会话（按 DSH sessionId 记；换会话后自然再注入一次）。
    profileInjectedFor: typeof raw.profileInjectedFor === 'string' ? raw.profileInjectedFor : '',
    // 已检查过「新会话是否缺交接摘要」的会话（每个会话只补一次，避免每轮都跑模型）。
    autoHandoverFor: typeof raw.autoHandoverFor === 'string' ? raw.autoHandoverFor : ''
  };
}

let stateCache = null;
let stateCacheAt = 0;
let stateCacheFile = '';
let stateDirty = false;
let stateSaveTimer = null;

function getState() {
  const now = Date.now();
  const file = dirs().stateFile;
  // 目录也算缓存键：测试用 QQ_MEMORY_DIR 切目录时不能读到上一个目录的缓存状态。
  // 脏的时候绝不重载：saveStateSoon 去抖 2s、缓存 TTL 1.5s，若这时重载会用磁盘旧值
  // 覆盖刚改的内存（丢会话映射/丢注入标记），而且定时器之后还会把旧值写回去。
  if (!stateCache || stateCacheFile !== file || (!stateDirty && now - stateCacheAt > 1500)) {
    stateCache = readState();
    stateCacheAt = now;
    stateCacheFile = file;
  }
  return stateCache;
}

function saveStateNow() {
  if (!stateCache) return;
  try {
    ensureDirs();
    atomicWriteJson(dirs().stateFile, stateCache);
    stateDirty = false;
    stateCacheAt = Date.now();
  } catch {
    // 状态文件写失败不能影响聊天；日志仍然是完整的。
  }
}

function saveStateSoon() {
  stateDirty = true;
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    if (stateDirty) saveStateNow();
  }, 2000);
  stateSaveTimer.unref?.();
}

/** 立即把内存里的状态落盘（测试/退出前用；平时 2 秒去抖就够）。 */
export function flushMemoryState() {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  if (stateDirty) saveStateNow();
}

function cleanText(value, maxChars) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxChars);
}

const seenIds = new Set();
function dedupeKey(key, role, messageId, text) {
  const id = String(messageId ?? '').trim();
  if (id) return `${key}|${role}|${id}`;
  return `${key}|${role}|${crypto.createHash('sha1').update(`${text}\u0000${Date.now()}`).digest('hex').slice(0, 16)}`;
}

function rememberSeen(id, st) {
  if (!id) return false;
  if (seenIds.has(id)) return true;
  const recent = Array.isArray(st.recentIds) ? st.recentIds : (st.recentIds = []);
  if (recent.includes(id)) return true;
  seenIds.add(id);
  recent.push(id);
  if (recent.length > 500) recent.splice(0, recent.length - 500);
  if (seenIds.size > 5000) {
    const first = seenIds.values().next().value;
    seenIds.delete(first);
  }
  saveStateSoon();
  return false;
}

/**
 * 追加一条完整消息。失败返回 false，不抛异常（聊天主链路不能被日志拖垮）。
 */
export function recordMessage({ key, role, text, sender = '', time = Date.now(), messageId = '', media = [], source = '' } = {}) {
  try {
    const c = cfg();
    if (!c.enabled || !key) return false;
    // 长期记忆只记 owner 私聊；群聊/其他人不进这个日志，避免把群聊内容带进后续上下文。
    const owner = ownerQQ();
    if (owner && String(key) !== `private:${owner}`) return false;
    const content = cleanText(text, c.maxCharsPerMessage);
    const hasMedia = Array.isArray(media) && media.length > 0;
    if (!content && !hasMedia) return false;
    const ts = Number(time) || Date.now();
    const st = getState();
    const id = dedupeKey(key, role, messageId, content);
    if (rememberSeen(id, st)) return false;
    const entry = {
      ts: new Date(ts).toISOString(),
      key: String(key),
      role: String(role || 'user'),
      sender: cleanText(sender, 80),
      text: content,
      media: Array.isArray(media) ? media.slice(0, 5).map((m) => {
      if (typeof m === 'string') return m.slice(0, 80);
      const kind = String(m?.type || m?.kind || m?.name || '').trim();
      const file = String(m?.file || m?.fileName || m?.file_name || m?.name || m?.url || '').trim();
      const label = kind ? `[${kind}]` : '';
      return `${label}${file}`.slice(0, 80) || '[媒体]';
    }) : [],
      messageId: String(messageId ?? '').slice(0, 80),
      source: cleanText(source, 40)
    };
    ensureDirs();
    // hot/<YYYY-MM-DD>/ 是每天新建的子目录，必须在 append 前自己建：appendFileSync 不建父目录。
    const file = hotFile(key, ts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    const sess = st.sessions[key];
    if (sess && sess.sessionId) {
      sess.chars = Number(sess.chars) || 0;
      sess.chars += content.length + 20;
      sess.lastAt = ts;
      saveStateSoon();
    }
    return true;
  } catch {
    return false;
  }
}

export function recordIncoming({ key, text, sender, isOwner = false, time, messageId, media } = {}) {
  return recordMessage({ key, role: 'user', text, sender: sender || (isOwner ? '用户' : ''), time, messageId, media, source: 'incoming' });
}

export function recordOutgoing({ key, text, time, messageId, source = 'assistant' } = {}) {
  return recordMessage({ key, role: 'assistant', text, sender: '小助手', time, messageId, source });
}

/** 把 7 天窗口之外的 hot 日目录移动到 archive；返回移动的文件数。 */
export function archiveOld(now = Date.now()) {
  try {
    const c = cfg();
    if (!c.enabled || !c.archiveEnabled) return 0;
    ensureDirs();
    // 按自然日算窗口：day < startDay 的日目录整目录移走（不按小时切）。
    const { startDay } = windowBounds(now);
    const d = dirs();
    let moved = 0;
    for (const hotRoot of [d.hot]) {
      let days = [];
      try { days = fs.readdirSync(hotRoot); } catch { continue; }
      for (const day of days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        if (day >= startDay) continue;
        const srcDir = path.join(hotRoot, day);
        let files = [];
        try { files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
        for (const file of files) {
          const src = path.join(srcDir, file);
          // 保持按月归档且不覆盖同名日文件。
          const target = path.join(d.archive, monthStr(day), `${file.replace(/\.jsonl$/, '')}-${day}.jsonl`);
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (fs.existsSync(target)) fs.unlinkSync(src);
            else fs.renameSync(src, target);
            moved += 1;
          } catch {
            // 单个文件失败不影响其它文件；下次归档会再试。
          }
        }
        try {
          if (fs.readdirSync(srcDir).length === 0) fs.rmdirSync(srcDir);
        } catch {}
      }
    }
    const st = getState();
    st.lastArchiveAt = now;
    saveStateSoon();
    return moved;
  } catch {
    return 0;
  }
}

function listJsonlFiles(key) {
  const d = dirs();
  const slug = safeKey(key);
  const out = [];
  const seen = new Set();
  const addDir = (folder) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) continue;
      if (!ent.name.endsWith('.jsonl')) continue;
      if (!ent.name.startsWith(`${slug}`)) continue;
      const full = path.join(folder, ent.name);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push(full);
    }
  };
  const addDayDirs = (base) => {
    let days = [];
    try { days = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
    for (const day of days) addDir(path.join(base, day));
  };
  const addMonthDirs = (base) => {
    let months = [];
    try { months = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
    for (const m of months) addDir(path.join(base, m));
  };
  addDayDirs(d.hot);
  addMonthDirs(d.archive);
  return out;
}

function readLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 检索当前会话的历史原文。query 为空时返回最近的记录。
 * 返回 [{ts,date,role,sender,text}]，按「匹配度 + 时间」排序。
 */
export function searchMessages({ key, query = '', from = '', to = '', limit } = {}) {
  try {
    const c = cfg();
    if (!c.enabled) return [];
    const q = String(query ?? '').trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean).slice(0, 8) : [];
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : 0;
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
    const rows = [];
    const seen = new Set();
    for (const file of listJsonlFiles(key)) {
      for (const row of readLines(file)) {
        if (String(row.key ?? '') !== String(key)) continue;
        const ts = new Date(row.ts).getTime();
        if (!Number.isFinite(ts) || ts < fromTs || ts > toTs) continue;
        const text = String(row.text ?? '');
        let score = 0;
        if (terms.length) {
          const hay = `${text} ${row.sender ?? ''}`.toLowerCase();
          for (const term of terms) if (hay.includes(term)) score += 2;
          if (score === 0) continue;
        } else {
          score = 1;
        }
        const id = `${ts}|${row.role}|${text.slice(0, 80)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({
          ts,
          date: dayStr(ts),
          role: row.role,
          sender: row.sender || '',
          text: text.length > 1200 ? `${text.slice(0, 1200)}…` : text,
          score
        });
      }
    }
    rows.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
    return rows.slice(0, Math.max(1, Number(limit) || c.searchLimit));
  } catch {
    return [];
  }
}

/** 最近 N 条日志（不检索），用于交接摘要。 */
export function recentMessages(key, limit = 80) {
  const rows = [];
  for (const file of listJsonlFiles(key)) for (const row of readLines(file)) rows.push(row);
  rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return rows.slice(-Math.max(1, limit));
}

export function noteSession(key, sessionId, now = Date.now()) {
  try {
    const st = getState();
    const prev = st.sessions[key];
    if (prev && prev.sessionId === sessionId) {
      if (!prev.startedAt) prev.startedAt = now;
      saveStateSoon();
      return prev;
    }
    const next = {
      sessionId: String(sessionId),
      startedAt: now,
      chars: 0,
      lastAt: now,
      rotations: Number(prev?.rotations) || 0,
      // 冷却要跨会话延续：轮转后 DSH 立刻换了新会话，若丢掉这个时间点，
      // 新会话刚起来就可能立刻再次触发轮转。
      lastRotationAt: Number(prev?.lastRotationAt) || 0
    };
    st.sessions[key] = next;
    saveStateSoon();
    return next;
  } catch {
    return null;
  }
}

export function getSessionInfo(key) {
  try { return getState().sessions[key] ?? null; } catch { return null; }
}

/**
 * 记一次轮转：rotations 加一，并留下最后一次轮转的元信息。
 * 新会话的 noteSession 会继承这个计数，所以 memory.json 里能看到「换过几次会话」。
 */
export function markRotation(key, { reason = '', sessionId = '', handoverChars = 0 } = {}) {
  try {
    const now = Date.now();
    const st = getState();
    if (!st.sessions || typeof st.sessions !== 'object') st.sessions = {};
    const name = String(key);
    const sess = st.sessions[name] || (st.sessions[name] = { sessionId: '', startedAt: now, chars: 0, lastAt: now, rotations: 0 });
    sess.rotations = (Number(sess.rotations) || 0) + 1;
    sess.lastRotationAt = now;
    sess.lastRotationReason = String(reason || '');
    st.lastRotation = { key: name, reason: String(reason || ''), sessionId: String(sessionId || ''), handoverChars: Number(handoverChars) || 0, at: now };
    saveStateSoon();
    return sess.rotations;
  } catch {
    return 0;
  }
}

/**
 * 判断是否该轮转。返回 {due, reason, ageMs, chars, tokens}。
 * chars 只统计 memory-store 记录到的文本；token 估算按 3 字符/token。
 */
export function shouldRotate(key, sessionId, now = Date.now()) {
  try {
    const c = cfg();
    if (!c.enabled) return { due: false };
    const st = getState().sessions[key];
    if (!st || String(st.sessionId) !== String(sessionId)) return { due: false };
    const startedAt = Number(st.startedAt) || now;
    const ageMs = now - startedAt;
    const chars = Number(st.chars) || 0;
    const tokens = Math.ceil(chars / 3);
    // 按 7 天窗口轮转：会话跨出了「最近 7 个自然日」就换新会话（交接摘要 + 事实卡注入）。
    const bounds = windowBounds(now);
    if (startedAt < bounds.startMs) {
      return { due: true, reason: 'window', ageMs, chars, tokens, windowStart: bounds.startDay };
    }
    if (c.maxSessionTokens > 0 && tokens >= c.maxSessionTokens) {
      return { due: true, reason: 'tokens', ageMs, chars, tokens };
    }
    return { due: false, ageMs, chars, tokens, windowStart: bounds.startDay };
  } catch {
    return { due: false };
  }
}

export function setHandover(key, text, meta = {}) {
  try {
    const st = getState();
    st.handovers[key] = {
      text: cleanText(text, cfg().handoverMaxChars),
      createdAt: Date.now(),
      ...meta
    };
    saveStateNow();
    return true;
  } catch {
    return false;
  }
}

/**
 * 取待注入的交接摘要；已消费的返回 null。
 * 消费后不立即删除：模型回合万一失败，24 小时内还能用 restoreHandover 再补一次。
 */
export function peekHandover(key) {
  try {
    const st = getState();
    const entry = st.handovers[key];
    if (!entry) return null;
    const consumedAt = Number(entry.consumedAt) || 0;
    if (consumedAt) {
      if (Date.now() - consumedAt > 24 * 3600 * 1000) {
        delete st.handovers[key];
        saveStateSoon();
      }
      return null;
    }
    return entry;
  } catch { return null; }
}

/** 标记交接摘要已消费（不是删除，便于失败重试）。 */
export function clearHandover(key) {
  try {
    const st = getState();
    const entry = st.handovers[key];
    if (!entry) return;
    entry.consumedAt = Date.now();
    saveStateNow();
  } catch {}
}

/** 把已消费的摘要恢复成待注入（投递失败重试用）。 */
export function restoreHandover(key) {
  try {
    const st = getState();
    const entry = st.handovers[key];
    if (!entry || !entry.consumedAt) return false;
    delete entry.consumedAt;
    saveStateNow();
    return true;
  } catch {
    return false;
  }
}

export function saveDigest(key, text, meta = {}) {
  try {
    ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dirs().digests, `${safeKey(key)}-${stamp}.md`);
    fs.writeFileSync(file, `---\nkey: ${key}\ncreatedAt: ${new Date().toISOString()}\n${Object.entries(meta).map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`).join('\n')}\n---\n\n${text}\n`, 'utf8');
    return file;
  } catch {
    return '';
  }
}

/**
 * 提取式交接摘要：不调用模型，保证轮转永远能完成。
 * 输出三段：身份与约定 / 未完成话题 / 最近对话 —— 只给事实，不复制整段对话，
 * 避免模型把摘要里的旧消息当成新消息逐条回应。
 */
export function buildHandover(key, { now = Date.now(), maxChars, startMs = 0 } = {}) {
  try {
    const c = cfg();
    const limit = Math.max(800, Number(maxChars) || c.handoverMaxChars);
    const rows = recentMessages(key, 200);
    if (!rows.length) return '';
    // 轮转时传会话开始时刻：摘要/清单要覆盖这个会话的全部内容，而不是只覆盖最近 7 天。
    const since = Number(startMs) > 0 ? Number(startMs) : windowBounds(now).startMs;
    const inWindow = rows.filter((r) => new Date(r.ts).getTime() >= since);
    const use = inWindow.length ? inWindow : rows;

    // 身份与约定：用户明确说过的规则/偏好，去重后最多 8 条。
    const conventionRe = /(记住|以后|不要|必须|约定|白名单|模型|路径|以后都|别再|只保留|只允许|称呼|叫我|喜欢|讨厌|不能|尽量)/;
    const conventions = [];
    const seenLine = new Set();
    for (const r of use) {
      if (r.role !== 'user') continue;
      const text = String(r.text ?? '').trim();
      if (!text || !conventionRe.test(text) || seenLine.has(text)) continue;
      seenLine.add(text);
      conventions.push(`${dayStr(new Date(r.ts).getTime())} ${r.sender || '用户'}：${text.slice(0, 160)}`);
    }

    // 未完成话题：换会话前最后几轮里用户问过、还没收尾的问句（最多 3 条）。
    const open = [];
    const tail = use.slice(-30);
    for (let i = tail.length - 1; i >= 0 && open.length < 3; i -= 1) {
      const r = tail[i];
      if (r.role !== 'user') continue;
      const text = String(r.text ?? '').trim();
      if (!/[?？]\s*$|吗$|呢$|待定|下次|明天/.test(text)) continue;
      open.unshift(`${dayStr(new Date(r.ts).getTime())}：${text.slice(0, 120)}`);
    }

    const recent = use.slice(-10).map((r) => {
      const role = r.role === 'assistant' ? '小助手' : (r.sender || '用户');
      return `[${dayStr(new Date(r.ts).getTime())}] ${role}：${String(r.text ?? '').slice(0, 140)}`;
    });

    const budgetConv = Math.floor(limit * 0.4);
    const budgetOpen = Math.floor(limit * 0.2);
    const budgetRecent = Math.max(200, limit - budgetConv - budgetOpen);
    const cut = (lines, budget) => {
      const s = lines.join('\n');
      if (s.length <= budget) return s;
      return `${s.slice(0, Math.max(0, budget - 24)).trimEnd()}\n…（本节已截断，细节用 qq_memory_search 查询）`;
    };

    let out = '';
    out += `【7 天记忆交接】\n`;
    out += `（上一段会话的摘要，只作背景参考：不要逐条回应，也不要把它当成新收到的消息。）\n`;
    out += `时间范围：${dayStr(new Date(use[0].ts).getTime())} ~ ${dayStr(new Date(use[use.length - 1].ts).getTime())}\n`;
    out += `日志条数：${use.length}\n`;
    if (conventions.length) out += `\n【身份与约定】\n${cut(conventions.slice(-8), budgetConv)}\n`;
    if (open.length) out += `\n【未完成话题】\n${cut(open, budgetOpen)}\n`;
    out += `\n【最近对话】\n${cut(recent, budgetRecent)}\n`;
    return out;
  } catch {
    return '';
  }
}

// ── 长期记忆事实卡（profile.md） ─────────────────────────────────────────────
// 和 7 天日志分开：日志是「原文」，事实卡是「模型提炼过的长期事实」（称呼、生日、口味、
// 约定、正在推进的事），每天 23:00 由日终维护刷新一次，新会话第一条 prompt 注入一次。
function profileFile() {
  return path.join(dirs().root, 'profile.md');
}

export function readProfile() {
  try {
    const text = fs.readFileSync(profileFile(), 'utf8');
    return text.slice(0, 8000).trim();
  } catch {
    return '';
  }
}

export function writeProfile(text) {
  try {
    ensureDirs();
    const body = String(text ?? '').trim().slice(0, cfg().profileMaxChars * 2);
    if (!body) return 0;
    const file = profileFile();
    const st = getState();
    // 内容没变就不动文件、也不清注入标记：避免同一张卡在同一个会话里被重复注入。
    if (readProfile().trim() === body) return body.length;
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${body}\n`, 'utf8');
    fs.renameSync(tmp, file);
    st.profileUpdatedAt = Date.now();
    // 卡片内容变了：清掉标记，让当前/下一个会话在下次 prompt 时收到一次新卡（只一次，之后标记回写成该会话）。
    st.profileInjectedFor = '';
    saveStateNow();
    return body.length;
  } catch {
    return 0;
  }
}

/** 事实卡注入块；没有事实卡返回空字符串。 */
/** 事实卡已被投影器从外部改写：只更新状态位（不重复写文件）。
 *  为什么需要：投影走 card.writeCard() 写文件，此时再调 writeProfile() 会因「内容相同」直接 return，
 *  profileUpdatedAt 就永远停在旧值，reinjectOnUpdate（卡更新后再注入）也就永远不触发。
 */
export function markProfileChanged(text = '') {
  try {
    const st = getState();
    st.profileUpdatedAt = Date.now();
    st.profileInjectedFor = '';
    saveStateNow();
    return String(text || '').trim().length;
  } catch {
    return 0;
  }
}
export function renderProfileCard() {
  const c = cfg();
  if (!c.profileEnabled) return '';
  const text = readProfile();
  if (!text) return '';
  let body = text.length > c.profileMaxChars ? `${text.slice(0, c.profileMaxChars - 20)}…` : text;
  // profile.md 里已经带标题行：渲染时先摘掉，避免卡头重复两遍
  body = body.replace(/^【长期记忆（事实卡）】\s*\n（[^\n]*）\s*\n?/, '').trim();
  return `【长期记忆（事实卡）】\n（长期有效的事实与约定，按需参考；和用户最新的话冲突时以最新的话为准。）\n${body}`;
}

export function profileInjectedAt() {
  return Number(getState().profileInjectedAt) || 0;
}

/** 卡更新后允许「再注入一次」的记账（按 sessionId + 最近一次时间）。 */
export function markProfileReinjected(sessionId) {
  try {
    const st = getState();
    st.profileReinjected = { sessionId: String(sessionId || ''), at: Date.now() };
    saveStateSoon();
    return true;
  } catch {
    return false;
  }
}

export function profileReinjectedAt(sessionId) {
  const r = getState().profileReinjected;
  return r && String(r.sessionId || '') === String(sessionId || '') ? Number(r.at) || 0 : 0;
}

export function profileInjectedFor(sessionId) {
  return String(getState().profileInjectedFor || '') === String(sessionId || '');
}

export function markProfileInjected(sessionId) {
  try {
    const st = getState();
    st.profileInjectedFor = String(sessionId || '');
    st.profileInjectedAt = Date.now();
    saveStateSoon();
    return true;
  } catch {
    return false;
  }
}

/**
 * 规则「按会话只注入一次」的记账（rules.mode=session 用）。
 * 只记录 sessionId + 规则哈希 + 注入时刻 + 之后的轮数，规则正文不落这里。
 */
export function rulesInjectedFor(sessionId) {
  const r = getState().rulesInjected;
  if (!r || String(r.sessionId || '') !== String(sessionId || '')) return null;
  return { sessionId: String(r.sessionId), hash: String(r.hash || ''), at: Number(r.at) || 0, turns: Number(r.turns) || 0 };
}

export function bumpRulesTurns(sessionId) {
  try {
    const st = getState();
    const r = st.rulesInjected;
    if (!r || String(r.sessionId || '') !== String(sessionId || '')) return 0;
    r.turns = (Number(r.turns) || 0) + 1;
    saveStateSoon();
    return r.turns;
  } catch {
    return 0;
  }
}

export function markRulesInjected(sessionId, hash) {
  try {
    const st = getState();
    st.rulesInjected = { sessionId: String(sessionId || ''), hash: String(hash || ''), at: Date.now(), turns: 0 };
    saveStateSoon();
    return true;
  } catch {
    return false;
  }
}

export function rulesInfo() {
  const r = getState().rulesInjected;
  if (!r) return null;
  return { sessionId: String(r.sessionId || ''), hash: String(r.hash || ''), at: Number(r.at) || 0, turns: Number(r.turns) || 0 };
}

/**
 * 新会话补摘要的检查标记：同一个会话只返回 true 一次。
 * 用途：state/sessions.json 丢失或新会话没有现成 handover 时，只补生成一次，不要每轮都调模型。
 */
export function noteAutoHandover(sessionId) {
  try {
    const st = getState();
    const id = String(sessionId || '');
    if (!id || st.autoHandoverFor === id) return false;
    st.autoHandoverFor = id;
    saveStateSoon();
    return true;
  } catch {
    return false;
  }
}

export function profileInfo() {
  const text = readProfile();
  return { chars: text.length, updatedAt: Number(getState().profileUpdatedAt) || 0, text };
}

export function memoryStats() {
  const c = cfg();
  const d = dirs();
  const countFiles = (base) => {
    let n = 0;
    const walk = (p) => {
      let entries = [];
      try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const child = path.join(p, e.name);
        if (e.isDirectory()) walk(child);
        else if (e.name.endsWith('.jsonl')) n += 1;
      }
    };
    walk(base);
    return n;
  };
  const st = getState();
  const bounds = windowBounds();
  return {
    enabled: c.enabled,
    dir: d.root,
    windowDays: bounds.windowDays,
    windowStart: bounds.startDay,
    dailyAt: c.dailyAt,
    lastDailyAt: st.lastDailyAt,
    retentionHours: c.retentionHours,
    maxSessionTokens: c.maxSessionTokens,
    handoverMaxChars: c.handoverMaxChars,
    hotFiles: countFiles(d.hot),
    archiveFiles: countFiles(d.archive),
    sessions: st.sessions,
    handovers: Object.keys(st.handovers).length,
    lastArchiveAt: st.lastArchiveAt,
    profile: { chars: readProfile().length, updatedAt: st.profileUpdatedAt, injectedFor: st.profileInjectedFor || '' }
  };
}
