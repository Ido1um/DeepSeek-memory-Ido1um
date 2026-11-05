import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveMediaBuffer, readMedia, readMediaIndex, hasMedia, mediaRoot, indexPath, mediaStats } from '../src/media.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001' +
  '0d0a2db40000000049454e44ae426082',
  'hex'
);

test('保存一张图：落盘到 media/YYYY-MM/<sha1>.png 并写索引', () => {
  const dir = tmpDir();
  const at = Date.parse('2026-11-05T10:00:00+08:00');
  const saved = saveMediaBuffer({ dir, buffer: PNG, mimeType: 'image/png', at, key: 'private:1', msgId: '42' });
  assert.equal(saved.ok, true);
  assert.equal(saved.deduped, false);
  assert.equal(saved.ref.kind, 'image');
  assert.equal(saved.ref.mime, 'image/png');
  assert.equal(saved.ref.bytes, PNG.length);
  const abs = path.join(dir, 'media', '2026-11', `${saved.ref.sha1}.png`);
  assert.equal(fs.existsSync(abs), true);
  assert.equal(fs.readFileSync(abs).equals(PNG), true);
  assert.equal(hasMedia(dir, saved.ref.sha1), true);
  const rows = readMediaIndex(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].msgId, '42');
  assert.equal(rows[0].key, 'private:1');
});

test('同一张图重复保存：不重复落盘，补齐缺失的 msgId', () => {
  const dir = tmpDir();
  const a = saveMediaBuffer({ dir, buffer: PNG, mimeType: 'image/png', at: Date.now() });
  const b = saveMediaBuffer({ dir, buffer: PNG, mimeType: 'image/png', at: Date.now(), msgId: '99' });
  assert.equal(b.deduped, true);
  assert.equal(a.ref.sha1, b.ref.sha1);
  const rows = readMediaIndex(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].msgId, '99');
  const files = fs.readdirSync(path.join(dir, 'media', rows[0].day.slice(0, 7)));
  assert.equal(files.length, 1);
});

test('readMedia 能取回原字节与元数据', () => {
  const dir = tmpDir();
  const saved = saveMediaBuffer({ dir, buffer: PNG, mimeType: 'image/png', at: Date.now(), alt: '[图片1]' });
  const back = readMedia(dir, saved.ref.sha1);
  assert.ok(back);
  assert.equal(back.buffer.equals(PNG), true);
  assert.equal(back.mimeType, 'image/png');
  assert.equal(back.meta.alt, '[图片1]');
});

test('没有索引/文件时 readMedia 返回 null', () => {
  const dir = tmpDir();
  assert.equal(readMedia(dir, 'f'.repeat(40)), null);
  assert.equal(readMedia(dir, ''), null);
});

test('空内容拒绝保存；索引路径在 state/media.jsonl', () => {
  const dir = tmpDir();
  const bad = saveMediaBuffer({ dir, buffer: Buffer.alloc(0), mimeType: 'image/png' });
  assert.equal(bad.ok, false);
  assert.ok(indexPath(dir).endsWith(path.join('state', 'media.jsonl')));
});

test('mediaStats 汇总张数与字节', () => {
  const dir = tmpDir();
  saveMediaBuffer({ dir, buffer: PNG, mimeType: 'image/png', at: Date.now() });
  const stats = mediaStats(dir);
  assert.equal(stats.count, 1);
  assert.equal(stats.bytes, PNG.length);
});
