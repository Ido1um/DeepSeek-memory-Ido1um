// 端口探活：纯 TCP connect，不调用 netstat / 子进程。
//
// 为什么不用 `netstat -ano | findstr :3100`：本机 DSH 文件沙箱禁止子进程 pipe stdio，
// execSync 直接抛 EPERM（PIPE_FAIL spawnSync cmd.exe EPERM），health 就会把活着的服务
// 误报成 ✗。TCP connect 不依赖外部命令，也不依赖管理员权限，沙箱下同样可用。
//
// 三态（不抛异常）：
//   open    有进程在监听
//   refused 连接被拒 → 真没起
//   blocked 探测本身被环境拦住 / 超时 → 无法判定（不要据此判宕机）

import net from 'node:net';

export const PROBE_OPEN = 'open';
export const PROBE_REFUSED = 'refused';
export const PROBE_BLOCKED = 'blocked';

/**
 * 探一个本机端口。
 * @param {number|string} port
 * @param {{host?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{port:number, state:'open'|'refused'|'blocked', ok:boolean, code:string}>}
 */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    return Promise.resolve({ port: p, state: PROBE_BLOCKED, ok: false, code: 'EINVAL' });
  }
  return new Promise((resolve) => {
    let done = false;
    let sock;
    const finish = (state, code = '') => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ port: p, state, ok: state === PROBE_OPEN, code });
    };
    try {
      sock = net.connect({ host, port: p });
    } catch (e) {
      resolve({ port: p, state: PROBE_BLOCKED, ok: false, code: (e && e.code) || String(e) });
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(PROBE_OPEN));
    sock.once('timeout', () => finish(PROBE_BLOCKED, 'ETIMEDOUT'));
    sock.once('error', (e) => {
      const code = (e && e.code) || String(e);
      finish(code === 'ECONNREFUSED' ? PROBE_REFUSED : PROBE_BLOCKED, code);
    });
  });
}
