// 配置读取层：本包不要求 config.json 在自己目录里，而是读取宿主程序指定的 config.json。
//
// 优先级（路径）：
//   1. env `QQ_MEMORY_CONFIG` 指定的文件（测试、换机时用）
//
// 优先级（数据目录）：env `QQ_MEMORY_DIR` > config.memory.dir > DEFAULT_DIR。
//
// 注意：这里只读，不写配置文件；写回仍由桥接面板/用户手动做。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRef } from './miniyaml.mjs';

export const DEFAULT_DIR = path.join(os.homedir(), '.deepseek-memory', 'data');
export const DEFAULT_CONFIG_PATH = '';
export const DEFAULT_OWNER_QQ = '10001';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';

const CONFIG_TTL_MS = 60_000;
let configPath = '';
let cache = null;
let cacheAt = 0;

/** 覆盖 config.json 路径（测试用；传空串恢复默认）。 */
export function setConfigPath(p) {
  configPath = String(p || '').trim();
  cache = null;
  cacheAt = 0;
}

export function clearConfigCache() {
  cache = null;
  cacheAt = 0;
}

export function resolveConfigPath() {
  const envPath = String(process.env.QQ_MEMORY_CONFIG || '').trim();
  return configPath || envPath || DEFAULT_CONFIG_PATH;
}

/** 读 config.json（剥 BOM；失败回退旧缓存，不抛）。 */
export function loadConfig() {
  const now = Date.now();
  if (cache && now - cacheAt < CONFIG_TTL_MS) return cache;
  const file = resolveConfigPath();
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    cacheAt = now;
    return cache;
  } catch {
    return cache || {};
  }
}

export function memorySection() {
  const m = loadConfig()?.memory;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

export function webSearchSection() {
  const w = loadConfig()?.webSearch;
  return w && typeof w === 'object' && !Array.isArray(w) ? w : {};
}

export function ownerQQ() {
  const q = loadConfig()?.ownerQQ;
  const s = String(q ?? '').trim();
  return s || DEFAULT_OWNER_QQ;
}

/** webSearch 段归一化（与桥接 src/web-search.js 的 loadSearchConfig 语义一致）。 */
export function loadSearchConfig() {
  const raw = webSearchSection();
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    provider: raw.provider === 'deepseek' || raw.provider === 'bing' ? raw.provider : 'auto',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    timeoutMs: num(raw.timeoutMs, 35000, 5000, 120000)
  };
}

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** DSH 凭据：refs.<name> 明文。 */
export function readDshCredential(ref) {
  const name = String(ref ?? '').trim();
  if (!name) return '';
  try {
    const text = fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8');
    const value = readRef(text, name);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** 解析 DeepSeek key：config.webSearch.apiKey → env[apiKeyEnv] → DSH 凭据同名 ref。 */
export function resolveSearchApiKey(config = loadSearchConfig()) {
  const literal = String(config?.apiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(config?.apiKeyEnv || DEFAULT_API_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}
