// 3.1 P3：图片记忆的落盘与索引。
//
// 只做两件事：
//   1. 入站图片按 sha1 落盘（内容寻址，重复图片只存一份）；
//   2. 写一条索引（state/media.jsonl），供检索、工作台和 qq_memory_photo 使用。
//
// 不把 base64 写进事实、账本或注入文本——账本里只放 sha1 引用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MEDIA_DEFAULTS = {
  enabled: true,
  maxBytes: 8 * 1024 * 1024,
  maxPerTurn: 6,
  keepDays: 0 // 0 = 不自动清理
};

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/heic': 'heic'
};

export function normalizeMediaConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: cfg.enabled !== false,
    maxBytes: Number(cfg.maxBytes) > 0 ? Number(cfg.maxBytes) : MEDIA_DEFAULTS.maxBytes,
    maxPerTurn: Number(cfg.maxPerTurn) > 0 ? Number(cfg.maxPerTurn) : MEDIA_DEFAULTS.maxPerTurn,
    keepDays: Number(cfg.keepDays) > 0 ? Number(cfg.keepDays) : 0
  };
}

export function extOfMime(mimeType) {
  const m = String(mimeType || '').toLowerCase().split(';')[0].trim();
  return EXT_BY_MIME[m] || 'bin';
}

export function mimeOfExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  for (const [mime, candidate] of Object.entries(EXT_BY_MIME)) {
    if (candidate === e) return mime;
  }
  return 'application/octet-stream';
}

export function mediaRoot(dir) {
  return path.join(String(dir || ''), 'media');
}

export function indexPath(dir) {
  return path.join(String(dir || ''), 'state', 'media.jsonl');
}

export function sha1OfBuffer(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function readIndexRows(dir) {
  const file = indexPath(dir);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      rows.push(JSON.parse(text));
    } catch {
      // 半行（并发写）跳过
    }
  }
  return rows;
}

export function readMediaIndex(dir) {
  return readIndexRows(dir).filter((row) => row && row.sha1);
}

/** 该 sha1 是否已经落盘（只看文件，不信索引）。 */
export function hasMedia(dir, sha1) {
  const rows = readIndexRows(dir).filter((row) => row.sha1 === sha1);
  if (!rows.length) return false;
  const file = path.join(String(dir), rows[0].rel || '');
  return fs.existsSync(file);
}

/**
 * 保存一张图片。
 * @returns {{ok:true, ref:object, deduped:boolean} | {ok:false, error:string}}
 */
export function saveMediaBuffer({ dir, buffer, mimeType, kind = 'image', at = Date.now(), key = '', msgId = '', source = '', alt = '' } = {}) {
  if (!dir) return { ok: false, error: '缺少数据目录' };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: '图片为空' };
  const sha1 = sha1OfBuffer(buffer);
  const mime = String(mimeType || 'image/jpeg').split(';')[0].trim().toLowerCase();
  const ext = extOfMime(mime);
  const day = new Date(at);
  const month = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`;
  const rel = path.join('media', month, `${sha1}.${ext}`);
  const abs = path.join(String(dir), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const existing = readMediaIndex(dir).find((row) => row.sha1 === sha1);
  if (!existing) {
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, abs);
    const ref = {
      sha1,
      rel,
      ext,
      mime,
      bytes: buffer.length,
      kind: String(kind || 'image'),
      at,
      day: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
      key: String(key || ''),
      msgId: String(msgId || ''),
      source: String(source || ''),
      alt: String(alt || '').slice(0, 80)
    };
    fs.mkdirSync(path.dirname(indexPath(dir)), { recursive: true });
    fs.appendFileSync(indexPath(dir), JSON.stringify(ref) + '\n');
    return { ok: true, ref: toMediaRef(ref), deduped: false };
  }

  // 已存在：不重复落盘，但补一下缺的上下文（msgId/key）。
  const patch = {};
  if (!existing.msgId && msgId) patch.msgId = String(msgId);
  if (!existing.key && key) patch.key = String(key);
  if (!existing.alt && alt) patch.alt = String(alt).slice(0, 80);
  if (Object.keys(patch).length) appendPatch(dir, sha1, patch);
  return { ok: true, ref: toMediaRef(existing), deduped: true };
}

function appendPatch(dir, sha1, patch) {
  if (!fs.existsSync(indexPath(dir))) return;
  const rows = readIndexRows(dir);
  const next = rows.map((row) => (row.sha1 === sha1 ? { ...row, ...patch } : row));
  const tmp = `${indexPath(dir)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next.map((row) => JSON.stringify(row)).join('\n') + '\n');
  fs.renameSync(tmp, indexPath(dir));
}

/** 账本里只放这个：小、稳定、能反查。 */
export function toMediaRef(row) {
  if (!row) return null;
  return {
    sha1: row.sha1,
    kind: row.kind || 'image',
    mime: row.mime || mimeOfExt(row.ext),
    ext: row.ext || '',
    bytes: Number(row.bytes) || 0,
    at: Number(row.at) || 0,
    alt: row.alt || ''
  };
}

/** 读回图片字节（供 qq_memory_photo 使用）。 */
export function readMedia(dir, sha1) {
  const rows = readMediaIndex(dir).filter((row) => row.sha1 === String(sha1 || '').trim());
  if (!rows.length) return null;
  const row = rows[rows.length - 1];
  const abs = path.join(String(dir), row.rel || '');
  if (!fs.existsSync(abs)) return null;
  const buffer = fs.readFileSync(abs);
  return {
    buffer,
    mimeType: row.mime || mimeOfExt(row.ext),
    meta: toMediaRef(row),
    rel: row.rel,
    key: row.key || '',
    msgId: row.msgId || ''
  };
}

export function mediaStats(dir) {
  const rows = readMediaIndex(dir);
  const bytes = rows.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
  return { count: rows.length, bytes };
}
