// 主动翻旧账（wander）：隔一阵子自己想起一段很久以前的事，说一句。
//
// 规则（2026-11-03 用户定案）：
//   1) 间隔随机，不固定触发：nextAt = now + uniform(36h, 96h) ± 90min 抖动；
//   2) 24 小时内最多 1 次；
//   3) 同一段情境 30 天内不重复提；
//   4) 候选只取「足够旧」的情境段（默认 30 天前；没有就取最旧的一批）；
//   5) 只注入一行（≤150 字），不调模型，记账在 state/wander.json。

import fs from 'node:fs';
import path from 'node:path';
import { readEpisodes } from './episode.mjs';

const HOUR = 3600000;
const DAY = 86400000;

export const WANDER_DEFAULTS = {
  enabled: true,
  minGapHours: 36,
  maxGapHours: 96,
  jitterMinutes: 90,
  maxPerDay: 1,
  episodeCooldownDays: 30,
  minAgeDays: 30,
  maxChars: 150,
  recentWindowHours: 6
};

export function stateFile(dir) {
  return path.join(String(dir || ''), 'state', 'wander.json');
}

export function readState(dir) {
  try {
    const raw = fs.readFileSync(stateFile(dir), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function writeState(dir, state) {
  const file = stateFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function cfgOf(cfg) {
  const out = { ...WANDER_DEFAULTS };
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  for (const k of Object.keys(WANDER_DEFAULTS)) {
    if (c[k] === undefined) continue;
    out[k] = typeof WANDER_DEFAULTS[k] === 'boolean' ? c[k] !== false : Number(c[k]) || WANDER_DEFAULTS[k];
  }
  return out;
}

export function planNext(now, cfg, rand = Math.random) {
  const c = cfgOf(cfg);
  const span = Math.max(1, c.maxGapHours - c.minGapHours);
  const hours = c.minGapHours + rand() * span;
  const jitter = (rand() * 2 - 1) * c.jitterMinutes * 60000;
  return Math.round(now + hours * HOUR + jitter);
}

export function isDue(state, now, cfg) {
  const c = cfgOf(cfg);
  if (c.enabled === false) return false;
  const nextAt = Number(state?.nextAt) || 0;
  if (!nextAt) return true;
  return now >= nextAt;
}

export function pickCandidate(dir, state, now, cfg) {
  const c = cfgOf(cfg);
  const episodes = readEpisodes(dir) || [];
  const history = Array.isArray(state?.history) ? state.history : [];
  const lastAtById = new Map();
  for (const h of history) {
    const id = String(h?.id || '');
    if (!id) continue;
    lastAtById.set(id, Math.max(lastAtById.get(id) || 0, Number(h?.at) || 0));
  }
  const cooldownMs = c.episodeCooldownDays * DAY;
  const usable = episodes
    .filter((e) => e && e.id && Number.isFinite(Number(e.atTo) || Date.parse(String(e.atTo || ''))))
    .filter((e) => {
      const last = lastAtById.get(String(e.id)) || 0;
      return !last || now - last > cooldownMs;
    });
  if (!usable.length) return null;
  const ageOf = (e) => now - (Number(e.atTo) || Date.parse(String(e.atTo || '')) || 0);
  // 只翻「足够旧」的段：没有就到下一次再说。宁可隔很久不提，也不把上周的事说成「忽然想起」。
  const pool = usable.filter((e) => ageOf(e) >= c.minAgeDays * DAY);
  if (!pool.length) return null;
  // 越老越容易被想起，但不至于永远是同一段：权重 ∝ exp(-age/180d) 反而压老？这里改成
  // 「越旧权重越高」的温和曲线，避免永远只翻最旧那一段。
  const weights = pool.map((e) => 1 + Math.min(3, ageOf(e) / (30 * DAY)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function wanderLine(ep, { maxChars = 150 } = {}) {
  if (!ep) return '';
  const day = String(ep.day || '').slice(5).replace('-', '月').replace(/^0/, '') + '日';
  const title = String(ep.title || '').trim();
  const scene = String(ep.scene || '').trim();
  const body = scene || title;
  if (!body) return '';
  const head = `· 忽然想起 ${day}${title && scene ? `「${title}」` : ''}：`;
  const room = Math.max(20, maxChars - head.length);
  const text = `${head}${body.length > room ? `${body.slice(0, room - 1)}…` : body}`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// 返回 { ok, line, episodeId, state }；ok=false 表示这次不该提。
export function maybeWander(dir, { now = Date.now(), cfg, state, rand = Math.random } = {}) {
  const c = cfgOf(cfg);
  if (c.enabled === false) return { ok: false, reason: 'disabled' };
  const st = state && typeof state === 'object' ? { ...state } : readState(dir);
  if (!isDue(st, now, c)) return { ok: false, reason: 'not-due', state: st };
  const history = Array.isArray(st.history) ? st.history : [];
  const lastAt = Math.max(0, ...history.map((h) => Number(h?.at) || 0));
  if (lastAt && now - lastAt < 24 * HOUR) {
    const next = planNext(lastAt + 24 * HOUR, c, rand);
    st.nextAt = next;
    writeState(dir, st);
    return { ok: false, reason: 'daily-cap', state: st };
  }
  const ep = pickCandidate(dir, st, now, c);
  if (!ep) {
    st.nextAt = planNext(now, c, rand);
    writeState(dir, st);
    return { ok: false, reason: 'no-candidate', state: st };
  }
  const line = wanderLine(ep, { maxChars: c.maxChars });
  if (!line) return { ok: false, reason: 'empty', state: st };
  history.push({ at: now, id: String(ep.id), day: ep.day || '' });
  st.history = history.slice(-40);
  st.lastAt = now;
  st.nextAt = planNext(now, c, rand);
  writeState(dir, st);
  return { ok: true, line, episodeId: ep.id, state: st };
}

export function forceNext(dir, { now = Date.now(), cfg } = {}) {
  const st = readState(dir);
  st.nextAt = now;
  writeState(dir, st);
  return st;
}
