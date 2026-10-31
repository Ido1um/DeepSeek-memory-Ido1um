// 摘要路径（模型分支）与降级：以前三个测试文件里 summary.enabled 恒为 false，
// digest.summarizeProfile 的「成功 / 抛错 / 超时」三条分支从来没被跑过。
// 这里注入假 digest，不联网。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryEngine } from '../src/engine.mjs';
import { createNullHost } from '../src/host.mjs';
import { clearConfigCache } from '../src/config.mjs';
import * as store from '../src/store.mjs';
import * as longterm from '../src/longterm.mjs';

const KEY = 'private:10001';

function setup(t, memory = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-digest-'));
  const dir = path.join(root, 'data');
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    ownerQQ: '10001',
    memory: {
      enabled: true,
      dir,
      windowDays: 7,
      dailyAt: '23:00',
      summary: { enabled: true, maxChars: 1800 },
      profile: { enabled: true, maxChars: 1500 },
      ...memory,
    },
  }, null, 2));
  process.env.QQ_MEMORY_DIR = dir;
  process.env.QQ_MEMORY_CONFIG = configPath;
  clearConfigCache();
  store.clearConfigCache();
  t.after(() => {
    delete process.env.QQ_MEMORY_DIR;
    delete process.env.QQ_MEMORY_CONFIG;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dir };
}

function seedFacts() {
  longterm.appendEvent({
    ev: 'fact', id: longterm.newId('h'), sig: 'user:生日', about: 'user',
    label: '生日', value: '9 月 5 日', tier: 'hard', I: 1, at: Date.now(),
  });
}

test('日终：模型摘要成功时写进 profile.md', async (t) => {
  const { dir } = setup(t, { profile: { enabled: true, maxChars: 1500, source: 'model' } });
  seedFacts();
  let called = 0;
  const digest = {
    summarizeProfile: async ({ previousProfile, maxChars }) => {
      called += 1;
      assert.ok(maxChars > 0);
      assert.equal(typeof previousProfile, 'string');
      return { ok: true, text: '【长期记忆（事实卡）】\n· 主人 9 月 5 日生\n', mode: 'model' };
    },
  };
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }), digest });
  const out = await engine.runDailyMaintenance(Date.now(), { force: true });
  assert.equal(called, 1, '模型摘要应被调用一次');
  assert.ok(out.profile.chars > 0);
  assert.match(fs.readFileSync(path.join(dir, 'profile.md'), 'utf8'), /9 月 5 日/);
});

test('日终：模型不可用时保留旧卡，不丢数据', async (t) => {
  const { dir } = setup(t, { profile: { enabled: true, maxChars: 1500, source: 'model' } });
  seedFacts();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.md'), '【长期记忆（事实卡）】\n· 旧的一行\n', 'utf8');
  const digest = {
    summarizeProfile: async () => ({ ok: false, error: 'model timeout', mode: 'skip' }),
  };
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }), digest });
  const out = await engine.runDailyMaintenance(Date.now(), { force: true });
  assert.equal(out.profile.mode, 'skip');
  // 旧卡原样还在（降级不写坏文件）
  assert.match(fs.readFileSync(path.join(dir, 'profile.md'), 'utf8'), /旧的一行/);
});

test('日终：模型摘要返回空串时不覆盖旧卡', async (t) => {
  const { dir } = setup(t, { profile: { enabled: true, maxChars: 1500, source: 'model' } });
  seedFacts();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.md'), '【长期记忆（事实卡）】\n· 不能丢\n', 'utf8');
  const digest = { summarizeProfile: async () => ({ ok: false, text: '', error: 'empty', mode: 'skip' }) };
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }), digest });
  await engine.runDailyMaintenance(Date.now(), { force: true });
  assert.match(fs.readFileSync(path.join(dir, 'profile.md'), 'utf8'), /不能丢/);
});

test('日终：投影模式不调用模型（source=projection）', async (t) => {
  setup(t, { profile: { enabled: true, maxChars: 1500, source: 'projection' } });
  seedFacts();
  let called = 0;
  const digest = { summarizeProfile: async () => { called += 1; return { ok: true, text: '不该用到', mode: 'model' }; } };
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }), digest });
  const out = await engine.runDailyMaintenance(Date.now(), { force: true });
  assert.equal(called, 0);
  assert.equal(out.profile.mode, 'projection');
});
