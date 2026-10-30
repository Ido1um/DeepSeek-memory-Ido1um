// 最小接线示例：把记忆引擎接到任意宿主（这里用假 host，便于单跑）
//
//   node examples/bridge-adapter/index.mjs
//
// 真实项目里，把 fakeHost 换成你自己的 5 个回调即可。

import { createMemoryEngine } from '../../src/engine.mjs';
import { resolveDataDir, ensureDir } from '../../src/paths.mjs';

const dir = resolveDataDir({ explicit: process.env.QQ_MEMORY_DIR || '' });
ensureDir(dir);
console.log('[example] 数据目录：', dir);

// 宿主是否已经存在：fake host 用一个内存 map 假装有会话
const sessions = new Map();
const key = 'private:10001';

const engine = createMemoryEngine({
  getConfig: () => ({
    enabled: true,
    dir,
    scoring: { mode: 'write' },
    policy: { enabled: true, allowKeys: [key] },
  }),
  host: {
    log: (...a) => console.log('[memory]', ...a),
    listSessions: () => [...sessions.keys()],
    getSessionId: (k) => sessions.get(k) || '',
    retireSession: (id) => console.log('[host] 让宿主换新会话：', id),
    isDshReady: () => true,
    isBusy: () => false,
    onReminders: (list) => {
      for (const r of list) console.log('[提醒]', r.due, r.label || r.sig, r.value || '');
    },
  },
});

// ① 入站消息：先记
const text = '记住，我下周一要交物理实验报告，我生日是 11 月 2 日';
const rec = engine.onInbound(key, text);
console.log('[example] onInbound →', JSON.stringify(rec).slice(0, 200));

// ② 拼 prompt：取注入（首次会带事实卡；之后不再重复）
const inj = engine.composePrompt(key, text);
console.log('[example] 注入长度：', (inj.text || '').length, '字');

// ③ 查询
for (const f of engine.search?.('物理', { limit: 3 }) || []) {
  console.log('[recall]', f.tier, f.score, f.label || f.sig, '-', String(f.value || '').slice(0, 40));
}
