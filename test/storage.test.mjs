// storage.mjs 的边界：默认阈值、体积统计、归档月份、告警等级。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { archiveMonths, dirSizeBytes, normalizeStorage, storageReport, summarizeStorage } from '../src/storage.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-storage-'));
}

test('normalizeStorage：缺省 200MB / 10GB，非法值回落', () => {
  const d = normalizeStorage({});
  assert.equal(d.maxDataMb, 200);
  assert.equal(d.minFreeGb, 10);
  assert.deepEqual(normalizeStorage({ maxDataMb: 'x', minFreeGb: -3 }), { maxDataMb: 200, minFreeGb: 0 });
  assert.deepEqual(normalizeStorage({ maxDataMb: 50, minFreeGb: 2 }), { maxDataMb: 50, minFreeGb: 2 });
});

test('dirSizeBytes：递归累加文件，空目录为 0', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'state', 'b.txt'), 'x'.repeat(100));
  assert.equal(dirSizeBytes(dir), 105);
  assert.equal(dirSizeBytes(path.join(dir, 'missing')), 0);
});

test('storageReport：未超限为 ok，超体积为 warn', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
  const ok = storageReport({ dir, storage: { maxDataMb: 200, minFreeGb: 0 } });
  assert.equal(ok.level, 'ok');
  assert.equal(ok.dataMb, 2);
  assert.deepEqual(ok.alerts, []);

  const warn = storageReport({ dir, storage: { maxDataMb: 1, minFreeGb: 0 } });
  assert.equal(warn.level, 'warn');
  assert.deepEqual(warn.alerts, ['data>1MB']);
  assert.match(summarizeStorage(warn), /2 MB/);
});

test('archiveMonths：只认 raw/archive/YYYY-MM，按序返回', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'raw', 'archive', '2026-09'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'raw', 'archive', '2026-10'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'raw', 'archive', 'notes'), { recursive: true });
  assert.deepEqual(archiveMonths(dir), ['2026-09', '2026-10']);
  const r = storageReport({ dir, storage: {} });
  assert.equal(r.archiveMonths, 2);
  assert.equal(r.archiveFrom, '2026-09');
  assert.equal(r.archiveTo, '2026-10');
});
