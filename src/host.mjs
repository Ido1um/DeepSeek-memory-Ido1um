// 宿主接口：引擎（engine.mjs）与运行环境之间的契约。
//
// 桥接用自己的 host 实现（包一层 state.sessions / promptQueues），
// 独立进程/测试用 createNullHost()。引擎只依赖这 8 个方法。

/**
 * @typedef {Object} MemoryHost
 * @property {(msg: string) => void} log
 * @property {() => string[]} listSessions           有映射的 key（[private:10001]）
 * @property {(key: string) => string} getSessionId  当前映射的 DSH 会话 id
 * @property {(key: string) => boolean} retireSession 把旧会话退役
 * @property {(key: string) => boolean} isBusy       prompt 正在跑/排队
 * @property {() => boolean} isDshReady              DSH 就绪
 * @property {(key: string, info: object) => void} [afterRotate] 轮转后清宿主缓存
 * @property {() => string} [getOwnerKey]            事实卡归属 key（private:ownerQQ）
 */

// 内存版 host：给测试与独立 CLI 用，不连接任何真实会话。
export function createNullHost({ log = () => {}, ownerKey = '' } = {}) {
  /** @type {Map<string, string>} */
  const sessions = new Map();
  const calls = { retire: [], logs: [] };
  const busy = new Set();
  let dshReady = true;

  return {
    // ── 测试/CLI 控制面 ────────────────────────────────────────────
    setSession(key, sessionId) { sessions.set(key, sessionId); },
    clearSession(key) { sessions.delete(key); },
    setBusy(key, value) { if (value) busy.add(key); else busy.delete(key); },
    setDshReady(value) { dshReady = value; },
    get calls() { return calls; },
    get logs() { return calls.logs; },

    // ── 引擎契约 ───────────────────────────────────────────────────
    log(msg) {
      calls.logs.push(String(msg));
      log(msg);
    },
    listSessions() { return [...sessions.keys()]; },
    getSessionId(key) { return sessions.get(key) || ''; },
    retireSession(key) {
      calls.retire.push(key);
      sessions.delete(key);
      return true;
    },
    isBusy(key) { return busy.has(key); },
    isDshReady() { return dshReady; },
    afterRotate() {},
    getOwnerKey() { return ownerKey; }
  };
}
