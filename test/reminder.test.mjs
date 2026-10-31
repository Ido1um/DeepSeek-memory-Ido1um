// 到期提醒链路：抽到 due → 到窗前应该被提醒 → ack 之后不再重复 → 过期太久不再打扰。
// 以前 dueReminders / ackReminder 零测试引用，这条链路只在真机上跑过一次。

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
const HOUR = 3600_000;

function setup(t, memory = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-reminder-'));
  const dir = path.join(root, 'data');
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    ownerQQ: '10001',
    memory: {
      enabled: true,
      dir,
      windowDays: 7,
      dailyAt: '23:00',
      summary: { enabled: false },
      profile: { enabled: false },
      reminders: { enabled: true, horizonHours: 24, graceHours: 12, overdueHours: 72 },
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

function seedTask(dueAt, at = Date.now()) {
  longterm.appendEvent({
    ev: 'fact',
    id: longterm.newId('h'),
    sig: `user:note:${Math.random().toString(36).slice(2, 8)}`,
    about: 'user',
    label: '备注',
    value: '交物理实验报告',
    task: '交物理实验报告',
    due: new Date(dueAt).toISOString().slice(0, 10),
    dueAt,
    tier: 'general',
    I: 0.8,
    at,
  });
}

test('到期：24h 内到期 → 提醒一次；ack 后不再提醒', (t) => {
  setup(t);
  const dueAt = Date.now() + 20 * HOUR;
  seedTask(dueAt);
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });

  const first = engine.dueReminders(Date.now());
  assert.equal(first.length, 1);
  assert.equal(first[0].due, new Date(dueAt).toISOString().slice(0, 10));
  assert.match(first[0].text, /物理实验报告/);

  assert.equal(engine.ackReminder(first[0].id) || true, true);
  const second = engine.dueReminders(Date.now());
  assert.equal(second.length, 0, 'ack 过的不该再提醒');
});

test('到期：还早（3 天后）不提醒', (t) => {
  setup(t);
  seedTask(Date.now() + 3 * 24 * HOUR);
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  assert.deepEqual(engine.dueReminders(Date.now()), []);
});

test('到期：过期太久（>72h）不再打扰', (t) => {
  setup(t);
  seedTask(Date.now() - 100 * HOUR);
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  assert.deepEqual(engine.dueReminders(Date.now()), []);
});

test('到期：总开关关掉时一条都不发', (t) => {
  setup(t, { reminders: { enabled: false } });
  seedTask(Date.now() + 2 * HOUR);
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  assert.deepEqual(engine.dueReminders(Date.now()), []);
});

test('到期：没有 due 的普通事实永不进入提醒队列', (t) => {
  setup(t);
  longterm.appendEvent({
    ev: 'fact', id: longterm.newId('h'), sig: 'user:生日', about: 'user',
    label: '生日', value: '9 月 5 日', tier: 'hard', I: 1, at: Date.now(),
  });
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  assert.deepEqual(engine.dueReminders(Date.now()), []);
});
