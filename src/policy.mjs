// 会话三态：off / log / full（v7 §4 / 选择性记忆方案）。
//
//   off  ：不记、不注入、不轮转
//   log  ：只记日志（raw/），不注入、不轮转
//   full ：记日志 + 注入事实卡/交接 + 参与轮转
//
// 判定顺序（v6 §4.3）：denyKeys > allowKeys 白名单 > 暂停 > 显式设置 > 默认。
// 状态存在 `<dir>/state/policy.json`；为兼容旧数据，读不到时也认 memory.json 里的 policies 段。

import fs from 'node:fs';
import path from 'node:path';

export const STATES = ['off', 'log', 'full'];

function clampNum(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function toList(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

export function normalizePolicy(raw = {}) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: c.enabled !== false,
    defaultRecord: c.defaultRecord !== false,
    defaultInject: c.defaultInject !== false,
    allowKeys: toList(c.allowKeys),
    denyKeys: toList(c.denyKeys),
    pauseDefaultHours: clampNum(c.pauseDefaultHours, 2, 0, 720),
    maxPauseHours: clampNum(c.maxPauseHours, 168, 1, 720),
    keys: c.keys && typeof c.keys === 'object' && !Array.isArray(c.keys) ? { ...c.keys } : {}
  };
}

export function policyStatePath(dir) {
  return path.join(String(dir || ''), 'state', 'policy.json');
}

export function readPolicyState(dir) {
  const file = policyStatePath(dir);
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!parsed.keys || typeof parsed.keys !== 'object') parsed.keys = {};
      return parsed;
    }
  } catch {
    /* 落下面兜底 */
  }
  // 兼容：早期把策略写在 state/memory.json 的 policies 段。
  try {
    const mem = JSON.parse(fs.readFileSync(path.join(String(dir || ''), 'state', 'memory.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (mem && typeof mem === 'object' && mem.policies && typeof mem.policies === 'object') {
      const keys = {};
      for (const [k, v] of Object.entries(mem.policies)) {
        if (v && STATES.includes(v.state)) keys[k] = { state: v.state, note: v.note || '', updatedAt: v.updatedAt || 0 };
      }
      return { keys };
    }
  } catch {
    /* 没有就算了 */
  }
  return { keys: {} };
}

export function writePolicyState(dir, state) {
  const file = policyStatePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ version: 1, updatedAt: Date.now(), keys: state?.keys || {} }, null, 2);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${body}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 显式设置某个会话的状态。state 必须是三态之一；传 pauseHours 则顺带暂停。 */
export function setKeyState(dir, key, state, { note = '', pauseHours = 0, now = Date.now() } = {}) {
  const name = String(key || '').trim();
  if (!name) throw new Error('key 不能为空');
  if (!STATES.includes(state)) throw new Error(`state 必须是 ${STATES.join('/')} 之一`);
  const cur = readPolicyState(dir);
  const entry = { state, note: String(note || ''), updatedAt: now };
  if (Number(pauseHours) > 0) entry.pausedUntil = now + Math.round(Number(pauseHours) * 3600000);
  cur.keys[name] = { ...(cur.keys[name] || {}), ...entry };
  writePolicyState(dir, cur);
  return cur.keys[name];
}

/** 暂停：N 小时后自动恢复（不删 state）。 */
export function pauseKey(dir, key, hours, { now = Date.now(), maxHours = 168 } = {}) {
  const name = String(key || '').trim();
  if (!name) throw new Error('key 不能为空');
  const h = clampNum(hours, 2, 0, Math.max(1, maxHours));
  const cur = readPolicyState(dir);
  const entry = { ...(cur.keys[name] || {}), pausedUntil: now + Math.round(h * 3600000), updatedAt: now };
  cur.keys[name] = entry;
  writePolicyState(dir, cur);
  return entry;
}

export function resumeKey(dir, key, { now = Date.now() } = {}) {
  const cur = readPolicyState(dir);
  const entry = cur.keys[String(key || '')];
  if (entry) {
    delete entry.pausedUntil;
    entry.updatedAt = now;
    writePolicyState(dir, cur);
  }
  return cur.keys[String(key || '')] || null;
}

/**
 * 最终判定。
 * @returns {{state:'off'|'log'|'full', reason:string, pausedUntil?:number, entry?:object}}
 */
export function resolveState(key, { config = {}, state = { keys: {} }, now = Date.now() } = {}) {
  const p = normalizePolicy(config);
  if (!p.enabled) return { state: 'full', reason: 'policy-disabled' };
  const name = String(key || '');
  if (!name) return { state: 'off', reason: 'no-key' };
  if (p.denyKeys.includes(name)) return { state: 'off', reason: 'deny' };
  if (p.allowKeys.length && !p.allowKeys.includes(name)) return { state: 'off', reason: 'not-allowlisted' };
  // 两处都可能是显式设置：config.memory.policy.keys（工作台写）与 state/policy.json（运行时改）。
  const raw = { ...(p.keys || {}), ...(state?.keys || {}) }[name];
  const entry = typeof raw === 'string' ? { state: raw } : raw && typeof raw === 'object' ? raw : {};
  const pausedUntil = Number(entry.pausedUntil) || 0;
  if (pausedUntil > now) return { state: 'off', reason: 'paused', pausedUntil, entry };
  if (STATES.includes(entry.state)) return { state: entry.state, reason: 'explicit', entry };
  const fallback = p.defaultRecord ? (p.defaultInject ? 'full' : 'log') : 'off';
  return { state: fallback, reason: 'default', entry };
}

/** 三态 → 能干什么。 */
export function capabilities(state) {
  return {
    record: state !== 'off',
    inject: state === 'full',
    rotate: state === 'full'
  };
}

/** doctor / 工作台用：所有人（配置 + 状态覆盖）的最终态。 */
export function listStates(keys = [], { config = {}, state = { keys: {} }, now = Date.now() } = {}) {
  const all = new Set([...(config.allowKeys || []), ...(config.denyKeys || []), ...keys, ...Object.keys(state.keys || {})]);
  const out = [];
  for (const key of all) {
    const r = resolveState(key, { config, state, now });
    out.push({ key, state: r.state, reason: r.reason, pausedUntil: r.pausedUntil || 0 });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
