// 预设折叠审计（preset-audit）单元测试：只读文件，不碰真实预设。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditPresets } from '../src/preset-audit.mjs';

function fixture(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-audit-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
  }
  return base;
}

test('preset-audit：只有 tool-result-pruner 时通过', () => {
  const base = fixture({
    'dsh/agent-presets/qq-chat-v2/agent.cordis.yml': "- id: tool-result-pruner\n  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'\n"
  });
  const r = auditPresets({ base });
  assert.equal(r.ok, true);
  assert.deepEqual(r.hits, []);
  assert.equal(r.files[0].exists, true);
});

test('preset-audit：命中 compaction-basic / command-compact 就报警', () => {
  const base = fixture({
    'dsh/agent-presets/qq-chat-v2/agent.cordis.yml': "- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'\n- id: command-compact\n  name: '@deepseek-ai/dsh-command-compact'\n"
  });
  const r = auditPresets({ base });
  assert.equal(r.ok, false);
  assert.deepEqual(r.hits.sort(), ['command-compact', 'compaction-basic']);
});

test('preset-audit：文件缺失不算命中', () => {
  const base = fixture({});
  const r = auditPresets({ base });
  assert.equal(r.ok, true);
  assert.ok(r.files.every((f) => !f.exists));
});
