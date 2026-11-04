// 记忆 3.0 · 窗口账本（S0）
//
// 「原文」= 她那一侧看到的窗口上下文，不是聊天记录。每一轮记一行：
//   userRaw  用户原话（composePromptWithMemory 之前的 promptText，抽取的唯一证据）
//   spoken   她真正发出去的消息（工具发送成功的那几条，工具/参数已 sanitize）
//   reply    她的内部正文（reserved2 下文本不自动发送，属于「她当时的想法」）
//   feels    [[feel]]/[[心]] 隐藏块，逐字；只进她自己的阅览路径，不进卡、不发 QQ
//   window   拼好的完整窗口文本（内容寻址存 window/blocks/<sha1>.txt，行内只留 sha1）
//
// 为什么不内嵌正文：卡/摘要每轮都在重复，内嵌会让体积翻倍；内容寻址后同一段卡只存一份。
// 逐字可重建：blocks 里每段的 sha1 + 顺序 + userRaw 拼回去必须等于当轮实际发送的文本（对账抽查）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** [[feel]]…[[/feel]] 或 [[心]]…[[/心]]，id 可选（h-20261102-8c63be 这类事实 id）。 */
export const FEEL_RE = /\[\[(?:feel|心)(?::([0-9a-z-]+))?\]\]([\s\S]*?)\[\[(?:\/feel|\/心)\]\]/gi;

const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_USER_RAW = 20000;
const MAX_REPLY = 20000;

/** 进行中的回合草稿：sessionId -> draft。只放内存，进程重启丢掉即可（那一轮本来就 incomplete）。 */
const drafts = new Map();

export function sha1(text) {
  return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex');
}

export function nowIso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

/** 抽隐藏块，返回 { text: 去块后的正文, feels: [{text}] }。未闭合的 [[feel]] 不算（宁可丢，不误存）。 */
export function stripFeels(input) {
  const src = String(input ?? '');
  const feels = [];
  const text = src.replace(FEEL_RE, (_m, _id, body) => {
    const t = String(body ?? '').trim();
    if (t) feels.push({ text: t });
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), feels };
}

export function extractFeels(input) {
  return stripFeels(input).feels;
}

function readJson(file, dft) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dft;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function windowRoot(dir) {
  return path.join(String(dir || ''), 'window');
}

export function sessionDir(dir, sessionId) {
  return path.join(windowRoot(dir), 'blocks' === sessionId ? 'blocks' : String(sessionId || 'unknown'));
}

/** 内容寻址写块：已存在就不重写（同一段卡一天只写一次）。 */
export function writeBlock(dir, text) {
  const body = String(text ?? '');
  if (!body) return null;
  const h = sha1(body);
  const file = path.join(windowRoot(dir), 'blocks', `${h}.txt`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  }
  return { sha1: h, chars: body.length, file };
}

export function readBlock(dir, hash) {
  try {
    return fs.readFileSync(path.join(windowRoot(dir), 'blocks', `${String(hash)}.txt`), 'utf8');
  } catch {
    return '';
  }
}

function metaFile(dir, sessionId) {
  return path.join(windowRoot(dir), String(sessionId || 'unknown'), 'meta.json');
}

export function readMeta(dir, sessionId) {
  return readJson(metaFile(dir, sessionId), null);
}

export function ensureMeta(dir, sessionId, extra = {}) {
  const file = metaFile(dir, sessionId);
  const old = readJson(file, null);
  const meta = {
    sessionId: String(sessionId || ''),
    key: extra.key || old?.key || '',
    mode: extra.mode || old?.mode || '',
    model: extra.model || old?.model || '',
    preset: extra.preset || old?.preset || '',
    createdAt: Number(old?.createdAt) || Date.now(),
    updatedAt: Date.now(),
    nextTurn: Number(old?.nextTurn) || 1
  };
  if (!old) writeJsonAtomic(file, meta);
  return meta;
}

function turnsFile(dir, sessionId) {
  return path.join(windowRoot(dir), String(sessionId || 'unknown'), 'turns.jsonl');
}

export function readTurns(dir, sessionId, { limit = 0 } = {}) {
  const file = turnsFile(dir, sessionId);
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  if (limit > 0) lines = lines.slice(-limit);
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 断电/重启可能留下半行：跳过，不影响后面的行
    }
  }
  return rows;
}

/** 开始记录一轮。返回草稿（同 sessionId 覆盖，只保留最新一轮）。 */
/**
 * 桥接自己生成的提示（唤醒/提醒/回复检查）不是用户说的话，标题与抽取要能区分。
 */
/**
 * 桥接自己生成的提示（唤醒/提醒/回复检查）不是用户说的话，标题与抽取要能区分。
 * 判据不是「像不像 wake prompt」——每条 prompt 都带角色卡；而是「里面有没有用户的新消息」。
 */
export function isSyntheticPrompt(text = '') {
  const s = String(text || '').trimStart();
  if (!s) return true;
  if (s.startsWith('【唤醒】') || s.startsWith('【继续】') || /^（唤醒[:：]/.test(s)) return true;
  return !ownerTextOf(s);
}

/**
 * 从桥接拼好的整段 prompt 里取出「用户原话」。
 * 唤醒 prompt 是「角色卡 + 工具清单 + 消息快照 + 提示」一大坨，真要记的是最后那条用户消息；
 * 有【本次消息快照】就从快照 JSON 里取最后一条 text，退而求其次取【当前对话】之后，再退回原文。
 */
export function ownerTextOf(prompt = '') {
  const t = String(prompt || '');
  if (!t) return '';
  const snap = t.lastIndexOf('【本次消息快照】');
  if (snap >= 0) {
    const seg = t.slice(snap);
    const parsed = parseSnapshot(seg);
    if (parsed) {
      const lists = [parsed?.messages, parsed?.recent];
      for (const arr of lists) {
        if (!Array.isArray(arr) || !arr.length) continue;
        const mine = arr.filter((x) => x && x.isOwner === true && x.isSelf !== true && String(x.text ?? '').trim());
        if (mine.length) return String(mine[mine.length - 1].text).trim();
      }
    }
    const blocks = seg.split('},{');
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (!/"isOwner"\s*:\s*true/.test(blocks[i])) continue;
      if (/"isSelf"\s*:\s*true/.test(blocks[i])) continue;
      const m = /"text":"((?:[^"\\]|\\.)*)"/.exec(blocks[i]);
      if (m?.[1]) {
        try {
          return String(JSON.parse(`"${m[1]}"`)).trim();
        } catch {
          return m[1].trim();
        }
      }
    }
  }
  const dlg = t.lastIndexOf('【当前对话】');
  if (dlg >= 0) {
    let after = t.slice(dlg + '【当前对话】'.length).replace(/^\s+/, '');
    const cut = after.search(/\n\s*【/);
    if (cut > 0) after = after.slice(0, cut);
    after = after.trim();
    // 只认「一句话」的当前对话：太长、或本身就是另一段块/提示词时，宁可留空。
    if (after && after.length <= 1000 && !after.includes('完整角色卡') && !/^【/.test(after) && !/^Current runtime context\./.test(after)) {
      return after;
    }
  }
  // 旧记录里整段 wake prompt 被当成原话：它不含真正的用户消息时宁可返回空，也不要塞回提示词
  if (/^Current runtime context\./.test(t)) return '';
  if (t.includes('【当前角色】') || t.includes('完整角色卡请调用 qq_get_prompt')) return '';
  // 桥接自己拼的短提示（到期提醒/待办/唤醒/回复检查）会以【块头】开头：
  // 这是给她的指令，不是用户说的话，宁可留空也不要写进窗口原文。
  const trimmed = t.trim();
  if (/^【[^】\n]{2,12}】/.test(trimmed)) return '';
  if (/^(到期提醒|待办提醒|回复检查)/.test(trimmed)) return '';
  return trimmed;
}

/** 从「【本次消息快照】」后面抠出那个 JSON 对象（嵌套数组/字符串里的括号要跳过）。 */
function parseSnapshot(seg = '') {
  const start = seg.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < seg.length; i += 1) {
    const ch = seg[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(seg.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function beginTurn({
  key = '',
  sessionId = '',
  userRaw = '',
  msgIds = [],
  windowText = '',
  blocks = [],
  model = '',
  mode = '',
  at = Date.now()
} = {}) {
  if (!sessionId) return null;
  const promptText = String(userRaw ?? '');
  const rawText = ownerTextOf(promptText).slice(0, MAX_USER_RAW);
  // at 既能收毫秒数，也能收 ISO 字符串（导入/回填工具会传字符串）。
  const atMs = (() => {
    const n = Number(at);
    if (Number.isFinite(n) && n > 0) return n;
    const p = Date.parse(String(at));
    return Number.isFinite(p) ? p : Date.now();
  })();
  const draft = {
    key: String(key || ''),
    sessionId: String(sessionId),
    at: atMs,
    userRaw: rawText,
    synthetic: isSyntheticPrompt(promptText),
    msgIds: Array.isArray(msgIds) ? msgIds.map(String) : [],
    windowText: String(windowText ?? ''),
    blocks: Array.isArray(blocks) ? blocks : [],
    spoken: [],
    sendFeels: [],
    model: String(model || ''),
    mode: String(mode || ''),
    startedAt: Date.now()
  };
  drafts.set(draft.sessionId, draft);
  if (drafts.size > 20) {
    for (const [sid, d] of drafts) {
      if (Date.now() - d.startedAt > DRAFT_TTL_MS) drafts.delete(sid);
    }
  }
  return draft;
}

export function getDraft(sessionId) {
  const d = drafts.get(String(sessionId || ''));
  if (!d) return null;
  if (Date.now() - d.startedAt > DRAFT_TTL_MS) {
    drafts.delete(String(sessionId));
    return null;
  }
  return d;
}

/** 她真正发出去的一条（工具发送成功后调用）。text 已经过 feel 剥离；feels 是剥离时截下来的。 */
export function noteSpoken({ key = '', sessionId = '', tool = '', text = '', feels = [] } = {}) {
  const d = getDraft(sessionId);
  if (!d) return false;
  let added = false;
  for (const f of Array.isArray(feels) ? feels : []) {
    const t = String(f?.text ?? '').trim();
    if (!t) continue;
    if (!d.sendFeels.some((x) => x.text === t)) d.sendFeels.push({ text: t, src: 'send' });
    added = true;
  }
  const body = String(text ?? '').trim();
  if (!body) return added;
  if (d.spoken.some((s) => s.text === body && s.tool === String(tool || ''))) return added;
  d.spoken.push({ kind: 'tool', tool: String(tool || ''), text: body });
  if (!d.key && key) d.key = String(key);
  return true;
}

export function dropTurn(sessionId) {
  drafts.delete(String(sessionId || ''));
}

/** 列出仍在内存里的草稿（会话空闲/进程退出时用来补写 incomplete 行）。 */
export function listDrafts({ maxAgeMs = 0 } = {}) {
  const out = [];
  const now = Date.now();
  for (const [sessionId, d] of drafts) {
    if (maxAgeMs > 0 && now - d.startedAt < maxAgeMs) continue;
    out.push({ sessionId, key: d.key, at: d.at, startedAt: d.startedAt, userChars: (d.userRaw || '').length, spoken: d.spoken.length });
  }
  return out;
}

/** 超时未收尾的草稿写成 incomplete 行，避免长时间挂着的回合丢窗口。 */
export function sweepDrafts({ dir = '', maxAgeMs = 30 * 60 * 1000, reason = 'timeout' } = {}) {
  if (!dir) return [];
  const done = [];
  for (const item of listDrafts({ maxAgeMs })) {
    const d = drafts.get(item.sessionId);
    if (!d) continue;
    const res = finishTurn({
      dir,
      key: d.key,
      sessionId: item.sessionId,
      reply: '',
      reason,
      incomplete: true,
      model: d.model,
      mode: d.mode
    });
    if (res) done.push({ sessionId: item.sessionId, turn: res.turn });
    else drafts.delete(item.sessionId);
  }
  return done;
}

function nextTurnNumber(dir, sessionId, extra = {}) {
  const clean = Object.fromEntries(
    Object.entries(extra || {}).filter(([, v]) => v !== '' && v != null)
  );
  const meta = ensureMeta(dir, sessionId, clean);
  const rows = readTurns(dir, sessionId);
  const max = rows.reduce((n, r) => Math.max(n, Number(r?.turn) || 0), 0);
  const turn = Math.max(Number(meta.nextTurn) || 1, max + 1);
  const file = metaFile(dir, sessionId);
  const fresh = readJson(file, meta);
  writeJsonAtomic(file, { ...fresh, ...clean, nextTurn: turn + 1, updatedAt: Date.now() });
  return turn;
}

/**
 * 收尾并落盘一轮。reply 是她的内部正文（含 feel 块原文），这里统一剥离。
 * incomplete=true 表示缺 reply（断线/异常退出），抽取跳过、回放保留。
 */
export function finishTurn({
  dir = '',
  key = '',
  sessionId = '',
  reply = '',
  reason = '',
  pressureTokens = 0,
  contextWindow = 0,
  elapsedMs = 0,
  incomplete = false,
  model = '',
  mode = ''
} = {}) {
  if (!dir) return null;
  const draft = getDraft(sessionId) || { key, sessionId, at: Date.now(), userRaw: '', msgIds: [], windowText: '', blocks: [], spoken: [], model, mode };
  if (!draft.userRaw && !String(reply || '').trim()) {
    dropTurn(sessionId);
    return null;
  }
  const { text: replyText, feels: replyFeels } = stripFeels(String(reply ?? '').slice(0, MAX_REPLY));
  const windowBlock = writeBlock(dir, draft.windowText);
  const blocks = [];
  for (const b of draft.blocks) {
    const w = writeBlock(dir, b?.text ?? '');
    if (w) blocks.push({ k: String(b?.k || 'misc'), sha1: w.sha1, chars: w.chars });
  }
  const turn = nextTurnNumber(dir, sessionId, (() => {
    // meta 里的 key/mode/model 只在有值时才写，避免轮转新建会话后留下空字段
    const extra = {};
    if (String(key || draft.key || '')) extra.key = String(key || draft.key);
    if (String(mode || draft.mode || '')) extra.mode = String(mode || draft.mode);
    if (String(model || draft.model || '')) extra.model = String(model || draft.model);
    return extra;
  })());
  const feels = [];
  const seenFeel = new Set();
  for (const f of [...(draft.sendFeels || []), ...replyFeels]) {
    const t = String(f.text || '').trim();
    if (!t || seenFeel.has(t)) continue;
    seenFeel.add(t);
    feels.push({ text: t, src: String(f.src || 'reply') });
  }
  const row = {
    v: 1,
    turn,
    at: nowIso(draft.at || Date.now()),
    sessionId: String(sessionId || ''),
    key: String(key || draft.key || ''),
    mode: String(mode || draft.mode || ''),
    model: String(model || draft.model || ''),
    userRaw: { text: draft.userRaw, msgIds: draft.msgIds, chars: draft.userRaw.length, synthetic: draft.synthetic === true },
    spoken: draft.spoken.map((s) => ({ kind: s.kind, tool: s.tool, text: s.text })),
    reply: { text: replyText, chars: replyText.length },
    feels,
    window: {
      textSha1: windowBlock?.sha1 || '',
      chars: draft.windowText.length,
      blocks
    },
    pressureTokens: Number(pressureTokens) || 0,
    contextWindow: Number(contextWindow) || 0,
    incomplete: incomplete === true,
    reason: String(reason || ''),
    elapsedMs: Number(elapsedMs) || 0,
    savedAt: nowIso()
  };
  const file = turnsFile(dir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  try {
    recordFeels({ dir, key: row.key, sessionId, turn, feels, reply: replyText });
  } catch {
    // 感受落盘失败不影响账本
  }
  dropTurn(sessionId);
  return { turn, chars: row.window.chars, feels: feels.length, blocks: blocks.length };
}

export function feelsFile(dir) {
  return path.join(String(dir || ''), 'state', 'feels.jsonl');
}

/** 窗口文本切成已知的注入块（回填用）：只认顶层块头，卡内部的【用户的事】之类不切。 */
export const BLOCK_HEADERS = [
  ['rules', '【规则'],
  ['card', '【长期记忆（事实卡）】'],
  ['handover', '【7 天记忆交接】'],
  ['recent', '【最近一天的原话】'],
  ['retrieval', '【相关记忆】'],
  ['tasks', '【待办】'],
  ['current', '【当前对话】'],
  ['slang', '【黑话']
];

export function splitWindowBlocks(text = '') {
  const src = String(text ?? '');
  const hits = [];
  for (const [k, header] of BLOCK_HEADERS) {
    let from = 0;
    for (;;) {
      const i = src.indexOf(header, from);
      if (i < 0) break;
      hits.push({ k, i });
      from = i + header.length;
    }
  }
  hits.sort((a, b) => a.i - b.i);
  const out = [];
  const first = hits.length ? hits[0].i : src.length;
  if (first > 0 && src.slice(0, first).trim()) out.push({ k: 'pre', text: src.slice(0, first).trim() });
  for (let n = 0; n < hits.length; n += 1) {
    const end = n + 1 < hits.length ? hits[n + 1].i : src.length;
    const body = src.slice(hits[n].i, end).trim();
    if (body) out.push({ k: hits[n].k, text: body });
  }
  return out;
}

/**
 * 回填：把 DSH 会话日志里重建出来的轮次追加进账本（S1「旧记录回填」）。
 * 幂等：同一 window.textSha1 或同一 srcTurn 已存在就跳过。
 * rows: [{srcTurn, at, windowText, userRaw, synthetic, spoken, reply, reason, incomplete, model, mode}]
 */
export function appendImportedTurns({ dir = '', sessionId = '', key = '', mode = '', model = '', rows = [], startedAt = 0 } = {}) {
  if (!dir || !sessionId || !Array.isArray(rows) || !rows.length) return { added: 0, skipped: 0, turns: [] };
  const existing = readTurns(dir, sessionId);
  const seenHash = new Set(existing.map((r) => r?.window?.textSha1).filter(Boolean));
  const seenSrc = new Set(existing.map((r) => Number(r?.srcTurn) || 0).filter(Boolean));
  const file = turnsFile(dir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureMeta(dir, sessionId, { key, mode, model });
  let added = 0;
  let skipped = 0;
  const turns = [];
  for (const raw of rows) {
    const windowText = String(raw?.windowText ?? '');
    if (!windowText.trim()) {
      skipped += 1;
      continue;
    }
    const textSha1 = sha1(windowText);
    const srcTurn = Number(raw?.srcTurn) || 0;
    if (seenHash.has(textSha1) || (srcTurn && seenSrc.has(srcTurn))) {
      skipped += 1;
      continue;
    }
    const windowBlock = writeBlock(dir, windowText);
    const blocks = [];
    for (const b of raw?.blocks?.length ? raw.blocks : splitWindowBlocks(windowText)) {
      const w = writeBlock(dir, b?.text ?? '');
      if (w) blocks.push({ k: String(b?.k || 'window'), sha1: w.sha1, chars: w.chars });
    }
    const { text: replyText, feels } = stripFeels(String(raw?.reply ?? ''));
    const turn = nextTurnNumber(dir, sessionId, { key, mode, model: raw?.model || model });
    const row = {
      v: 1,
      turn,
      srcTurn,
      at: nowIso(Number(raw?.at) || Date.now()),
      sessionId: String(sessionId),
      key: String(key || ''),
      mode: String(raw?.mode || mode || ''),
      model: String(raw?.model || model || ''),
      userRaw: {
        text: String(raw?.userRaw ?? ''),
        msgIds: Array.isArray(raw?.msgIds) ? raw.msgIds : [],
        chars: String(raw?.userRaw ?? '').length,
        synthetic: raw?.synthetic === true
      },
      spoken: (raw?.spoken || []).map((s) => ({ kind: String(s?.kind || 'send'), tool: String(s?.tool || ''), text: String(s?.text || '') })),
      reply: { text: replyText, chars: replyText.length },
      feels,
      window: { textSha1: windowBlock?.sha1 || '', chars: windowText.length, blocks },
      pressureTokens: Number(raw?.pressureTokens) || 0,
      contextWindow: Number(raw?.contextWindow) || 0,
      incomplete: raw?.incomplete === true,
      reason: String(raw?.reason || ''),
      elapsedMs: 0,
      fidelity: 'session-log',
      source: 'dsh-session',
      savedAt: nowIso()
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    try {
      recordFeels({ dir, key: row.key, sessionId, turn, feels, reply: replyText });
    } catch {
      // 感受落盘失败不影响账本
    }
    seenHash.add(textSha1);
    if (srcTurn) seenSrc.add(srcTurn);
    added += 1;
    turns.push(turn);
  }
  if (startedAt) {
    const file2 = metaFile(dir, sessionId);
    const meta = readJson(file2, {}) || {};
    const old = Number(meta.startedAt) || 0;
    const started = old ? Math.min(old, Number(startedAt)) : Number(startedAt);
    writeJsonAtomic(file2, { ...meta, startedAt: started, updatedAt: Date.now() });
  }
  return { added, skipped, turns };
}

/** 感受逐字落盘：按 turn + sha1(text) 去重，append-only。 */
export function recordFeels({ dir = '', key = '', sessionId = '', turn = 0, feels = [], reply = '', src = 'reply' } = {}) {
  if (!dir || !Array.isArray(feels) || !feels.length) return 0;
  const file = feelsFile(dir);
  const seen = new Set();
  try {
    const old = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-500);
    for (const line of old) {
      try {
        const r = JSON.parse(line);
        seen.add(`${r.turn}|${r.sha1}`);
      } catch {}
    }
  } catch {
    // 没有旧文件就是第一次写
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let added = 0;
  for (const f of feels) {
    const text = String(f?.text ?? '').trim();
    if (!text) continue;
    const h = sha1(text);
    const id = `${turn}|${h}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = {
      at: nowIso(),
      key: String(key || ''),
      sessionId: String(sessionId || ''),
      turn: Number(turn) || 0,
      text,
      chars: text.length,
      sha1: h,
      src: String(f?.src || src),
      replyChars: String(reply || '').length,
      private: true
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    added += 1;
  }
  return added;
}

/** 一轮的逐字窗口（回放/展开用）：按块顺序拼回，拼不上就退回 blocks 原样。 */
export function readWindowText(dir, row) {
  if (!row) return '';
  const file = path.join(windowRoot(dir), 'blocks', `${row?.window?.textSha1 || ''}.txt`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    const parts = (row.window?.blocks || []).map((b) => readBlock(dir, b.sha1)).filter(Boolean);
    return [parts.join('\n\n'), '', row?.userRaw?.text || ''].join('\n');
  }
}

function sliceClock(at) {
  const d = new Date(Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clipLine(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (!(max > 0) || t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 保留原始换行的裁剪：合并连续空行、去掉行尾空白，超长才按字符截。
 * 原话里的换行、分段是语气的一部分（「嗯……」「算了」单独一行），压成一行会丢语境。
 */
function clipBlock(text, max) {
  const t = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!t) return '';
  if (!(max > 0) || t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 轮转后注入用的「最近一天原话」：只取净对话（用户原话 + 她真正发出的话），
 * 跳过唤醒/提醒轮，从最新往前累加，预算用完就停。没有可用记录时返回空串。
 */
export function formatRecentSlice(dir, sessionId, {
  hours = 24,
  maxChars = 2400,
  perTurn = 600,
  fallbackTurns = 6,
  includeReply = true,
  replyChars = 160,
  skipSynthetic = true,
  now = Date.now()
} = {}) {
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!dir || !sessionId || budget <= 0) return { text: '', chars: 0, turns: 0, fallback: false };
  const rows = readTurns(dir, sessionId).filter((r) => r && !r.incomplete);
  // 唤醒轮也是「用户原话 + 她的发言」：不按 synthetic 整轮丢掉，只丢既没原话也没发言的空转轮
  const usable = rows.filter((r) => Boolean(ownerTextOf(r?.userRaw?.text || '').trim()) || (r.spoken || []).length > 0);
  const cutoff = Number(now) - Math.max(1, Number(hours) || 24) * 3600 * 1000;
  let picked = usable.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t >= cutoff;
  });
  let fallback = false;
  if (!picked.length && fallbackTurns > 0) {
    picked = usable.slice(-Math.max(1, Math.floor(fallbackTurns)));
    fallback = picked.length > 0;
  }
  if (!picked.length) return { text: '', chars: 0, turns: 0, fallback: false };

  const lines = [];
  let used = 0;
  const head = '【最近一天的原话】';
  used += head.length + 1;
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const row = picked[i];
    const clock = sliceClock(row.at);
    const main = clipBlock(ownerTextOf(row?.userRaw?.text || ''), perTurn);
    const spokeText = (row.spoken || []).map((x) => x?.text).filter(Boolean).join('\n');
    const spoke = clipBlock(spokeText, Math.max(40, perTurn - 80));
    const add = [];
    if (main) add.push(`[${clock}] 用户：${main}`);
    if (spoke) add.push(`[${clock}] 助手：${spoke}`);
    // 她当时的念头（内部正文）：只在有真实往来时补；已发出去的不重复
    if (includeReply && replyChars > 0 && (main || spoke)) {
      const thought = clipBlock(row?.reply?.text || '', replyChars);
      const head12 = thought.slice(0, 12);
      if (thought && !(head12 && spokeText.includes(head12)) && !main.includes(head12)) {
        add.push(`[${clock}] 助手（当时的想法）：${thought}`);
      }
    }
    if (!add.length) continue;
    const chunk = add.join('\n');
    if (used + chunk.length + 1 > budget) break;
    lines.unshift(chunk);
    used += chunk.length + 1;
  }
  if (!lines.length) return { text: '', chars: 0, turns: 0, fallback };
  const note = `（以上是轮转前最后 ${lines.length} 轮的原话）`;
  const body = `${head}\n${lines.join('\n')}`;
  const text = used + note.length + 1 <= budget ? `${body}\n${note}` : body;
  return { text, chars: text.length, turns: lines.length, fallback };
}

/** 对账：窗口 vs 聊天记录（raw）。只读，返回差异报告。 */
export function reconcileSession({ dir = '', sessionId = '', sinceMs = 0, rawTexts = [] } = {}) {
  const rows = readTurns(dir, sessionId).filter((r) => !sinceMs || Date.parse(r.at) >= sinceMs);
  const hashSet = new Set(rawTexts.map((t) => sha1(String(t ?? '').trim())));
  const missing = [];
  for (const r of rows) {
    const t = ownerTextOf(String(r?.userRaw?.text ?? '')).trim();
    if (!t) continue;
    if (!hashSet.has(sha1(t))) missing.push({ turn: r.turn, chars: t.length, head: t.slice(0, 40) });
  }
  return {
    sessionId,
    turns: rows.length,
    incomplete: rows.filter((r) => r.incomplete).length,
    spoken: rows.reduce((n, r) => n + (r.spoken?.length || 0), 0),
    feels: rows.reduce((n, r) => n + (r.feels?.length || 0), 0),
    rawUsers: rawTexts.length,
    notInRaw: missing.slice(0, 20),
    notInRawCount: missing.length
  };
}
