#!/usr/bin/env node
/**
 * 一键打开记忆工作台
 *   1) 7351 已在跑 → 直接开浏览器
 *   2) 没在跑 → 后台起一个 server.mjs，等它就绪后再开浏览器
 *
 * 由「记忆工作台.lnk」→ open.vbs → 本脚本 调用，全程无控制台窗口。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WORKBENCH_PORT || 7351);
const BASE = `http://127.0.0.1:${PORT}/`;

async function alive(timeout = 1200) {
  try {
    const r = await fetch(BASE + 'api/state', { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  const child = spawn('cmd.exe', ['/c', 'start', '', BASE], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

let started = false;
if (!(await alive())) {
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT)], {
    cwd: HERE,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  started = true;

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await alive(800)) break;
  }
}

if (!process.env.WORKBENCH_NO_OPEN) openBrowser();
if (process.env.WORKBENCH_VERBOSE) {
  console.log(`${started ? '已启动服务' : '服务已在运行'} · ${BASE} · ${(await alive(800)) ? 'ok' : 'unreachable'}`);
}
