// 工作台写接口的回归测试：目标配置/桥接配置都指到临时目录，绝不碰生产。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const NODE = process.execPath;
const SRV = path.join(import.meta.dirname, '..', 'workbench', 'server.mjs');
const TOKEN = 'test-token-0123456789';

async function start() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-api-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'profile.md'), '# 卡\n', 'utf8');
  const bridgeCfg = path.join(tmp, 'bridge.json');
  fs.writeFileSync(bridgeCfg, JSON.stringify({ consolePort: 3199, consoleToken: 'secret-token-xyz', memory: { dir: dataDir } }), 'utf8');
  const desired = path.join(tmp, 'desired.json');
  fs.writeFileSync(desired, JSON.stringify({ dir: dataDir }), 'utf8');
  const port = 7400 + Math.floor(Math.random() * 200);
  const child = spawn(NODE, [SRV, '--port', String(port)], {
    env: { ...process.env, WORKBENCH_BRIDGE_CFG: bridgeCfg, WORKBENCH_DESIRED: desired, WORKBENCH_BRIDGE_LOG: path.join(tmp, 'bridge.log'), WORKBENCH_TOKEN: TOKEN },
    stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/state'); if (r.ok) return { base, child, tmp, desired, dataDir }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('工作台没起来');
}

const post = (base, p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-workbench-token': TOKEN, ...headers }, body: JSON.stringify(body) });

test('工作台：/api/state 不下发控制台令牌，但页面里带写令牌', async () => {
  const { base, child } = await start();
  try {
    const st = await (await fetch(base + '/api/state')).json();
    assert.equal(st.console.hasToken, true);
    assert.ok(!('path' in st.console) && !('url' in st.console));
    assert.ok(!JSON.stringify(st).includes('secret-token-xyz'));
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes(TOKEN), '同源页面应拿到写令牌');
  } finally { child.kill(); }
});

test('工作台：写请求必须带令牌与 JSON Content-Type', async () => {
  const { base, child } = await start();
  try {
    assert.equal((await post(base, '/api/config', { windowDays: 7 }, { 'x-workbench-token': '' })).status, 401);
    assert.equal((await post(base, '/api/config', { windowDays: 7 }, { 'x-workbench-token': 'wrong' })).status, 401);
    const form = await fetch(base + '/api/config', { method: 'POST', headers: { origin: base, 'x-workbench-token': TOKEN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'windowDays=7' });
    assert.equal(form.status, 415);
    assert.equal((await post(base, '/api/config', { windowDays: 7 })).status, 200);
  } finally { child.kill(); }
});

test('工作台：Host 不是回环地址就拒（DNS rebinding）', async () => {
  const { base, child } = await start();
  try {
    // fetch 不允许覆盖 Host，用 http.request 直接发
    const http = await import('node:http');
    const u = new URL(base);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: '/api/config', method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-workbench-token': TOKEN, host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(JSON.stringify({ windowDays: 7 }));
    });
    assert.equal(status, 403);
  } finally { child.kill(); }
});

test('工作台：目录必须已存在、未知键与错类型要 400', async () => {
  const { base, child } = await start();
  try {
    assert.equal((await post(base, '/api/config', { dir: 'relative/x' })).status, 400);
    assert.equal((await post(base, '/api/config', { dir: 'Z:\\definitely\\missing' })).status, 400);
    assert.equal((await post(base, '/api/config', { nope: 1 })).status, 400);
    assert.equal((await post(base, '/api/config', { windowDays: 'abc' })).status, 400);
    assert.equal((await post(base, '/api/config', { enabled: 'yes' })).status, 400);
  } finally { child.kill(); }
});

test('工作台：apply 拒绝不像记忆目录的路径（除非 force）', async () => {
  const { base, child, tmp, desired, dataDir } = await start();
  try {
    const junk = path.join(tmp, 'junk');
    fs.mkdirSync(junk, { recursive: true });
    fs.writeFileSync(path.join(junk, 'a.txt'), 'x', 'utf8');
    fs.writeFileSync(desired, JSON.stringify({ dir: junk }), 'utf8');
    assert.equal((await post(base, '/api/apply', {})).status, 400);

    // 恢复成合法目录后应 200，且不改生产
    fs.writeFileSync(desired, JSON.stringify({ dir: dataDir }), 'utf8');
    const okr = await post(base, '/api/apply', {});
    assert.equal(okr.status, 200);
  } finally { child.kill(); }
});

test('工作台：跨站写 403、幽灵 id 不写墓碑不写审计、非法 op 400', async () => {
  const { base, child, tmp, desired } = await start();
  try {
    const before = fs.readFileSync(desired, 'utf8');
    const r = await post(base, '/api/config', { windowDays: 9 }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
    assert.equal(fs.readFileSync(desired, 'utf8'), before);

    assert.equal((await post(base, '/api/fact', { id: 'ghost-1', op: 'invalidate' })).status, 404);
    const side = path.join(tmp, 'data', 'state', 'facts-invalidated.json');
    assert.ok(!fs.existsSync(side) || fs.readFileSync(side, 'utf8').replace(/\s/g, '') === '{}');
    assert.ok(!fs.existsSync(path.join(tmp, 'data', 'logs', 'facts-audit.jsonl')));

    assert.equal((await post(base, '/api/fact', { id: 'x', op: 'destroy' })).status, 400);
  } finally { child.kill(); }
});
