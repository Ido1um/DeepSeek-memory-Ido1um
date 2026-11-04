import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 记忆侧用量必须单独落盘，否则工作台分不清「聊天花销」和「记忆花销」。
test('记忆侧模型调用写成 logs/memory-usage.jsonl', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-usage-'));
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(root, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ownerQQ: '10001', memory: { dir, enabled: true } }));
  process.env.QQ_MEMORY_CONFIG = cfg;
  const { clearConfigCache } = await import('../src/config.mjs');
  clearConfigCache();
  const { recordUsage } = await import('../src/model.mjs');

  recordUsage({ caller: 'handover', model: 'deepseek-v4-flash', ok: true, ms: 12, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } });
  recordUsage({ caller: 'extract', model: 'deepseek-v4-flash', ok: false, ms: 5, error: 'boom' });

  const file = path.join(dir, 'logs', 'memory-usage.jsonl');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].caller, 'handover');
  assert.equal(rows[0].usage.cache_read_input_tokens, 300);
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].error, /boom/);
  delete process.env.QQ_MEMORY_CONFIG;
  fs.rmSync(root, { recursive: true, force: true });
});

// 沙箱/演练会把 QQ_MEMORY_DIR 指到副本；记账必须跟着走，不能漏回生产日志。
test('记忆侧用量跟随 QQ_MEMORY_DIR（沙箱不污染生产）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-usage-env-'));
  const sandbox = path.join(root, 'sandbox');
  const prod = path.join(root, 'prod');
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(prod, { recursive: true });
  const cfg = path.join(root, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ownerQQ: '10001', memory: { dir: prod, enabled: true } }));
  process.env.QQ_MEMORY_CONFIG = cfg;
  process.env.QQ_MEMORY_DIR = sandbox;
  const { clearConfigCache } = await import('../src/config.mjs');
  clearConfigCache();
  const { recordUsage } = await import('../src/model.mjs');

  recordUsage({ caller: 'episode', model: 'deepseek-v4-flash', ok: true, ms: 8, usage: { input_tokens: 5, output_tokens: 6 } });

  assert.ok(fs.existsSync(path.join(sandbox, 'logs', 'memory-usage.jsonl')));
  assert.ok(!fs.existsSync(path.join(prod, 'logs', 'memory-usage.jsonl')));
  delete process.env.QQ_MEMORY_CONFIG;
  delete process.env.QQ_MEMORY_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});
