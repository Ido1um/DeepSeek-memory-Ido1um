// 端口探活三态：open / refused / blocked。health 依赖它，不能抛异常。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { probePort } from '../src/portprobe.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

test('端口探活：有进程监听 → open', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const port = await listen(server);
  try {
    const r = await probePort(port);
    assert.equal(r.state, 'open');
    assert.equal(r.ok, true);
    assert.equal(r.port, port);
  } finally {
    await close(server);
  }
});

test('端口探活：没人监听 → refused', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await close(server);
  const r = await probePort(port, { timeoutMs: 500 });
  assert.equal(r.state, 'refused');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ECONNREFUSED');
});

test('端口探活：端口号非法 → blocked，不抛', async () => {
  for (const bad of [0, -1, 70000, 'abc']) {
    const r = await probePort(bad);
    assert.equal(r.state, 'blocked');
    assert.equal(r.ok, false);
  }
});

test('端口探活：连不上时也只返回三态之一，不抛', async () => {
  const r = await probePort(9, { host: '192.0.2.1', timeoutMs: 150 });
  assert.ok(['open', 'refused', 'blocked'].includes(r.state));
  assert.equal(r.ok, r.state === 'open');
});
