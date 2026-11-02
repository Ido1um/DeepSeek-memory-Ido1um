// 数据体积与磁盘水位（P0：只检查、只告警，绝不自动删除）。
//
// 设计原则：
// - 记忆数据是「原文 + 事件流」，删掉就不可再生；所以本模块只读、只算、只报告。
// - 数据目录里的大头通常是 raw/hot（7 天原文）、logs（token 日志）、state（长期库/影子/候选池）。
// - 阈值放 config.memory.storage，缺省 200 MB / 剩余 10 GB；超限只返回 level='warn'。

import fs from 'node:fs';
import path from 'node:path';

export const STORAGE_DEFAULTS = { maxDataMb: 200, minFreeGb: 10 };

function num(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** 归一化 memory.storage 配置（缺省即默认值）。 */
export function normalizeStorage(raw = {}) {
  return {
    maxDataMb: num(raw?.maxDataMb, STORAGE_DEFAULTS.maxDataMb, 1, 100000),
    minFreeGb: num(raw?.minFreeGb, STORAGE_DEFAULTS.minFreeGb, 0, 10000)
  };
}

/** 递归统计目录字节数；读不到的子项跳过，不抛错。 */
export function dirSizeBytes(dir) {
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 8) return;
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of list) {
      const p = path.join(d, it.name);
      try {
        if (it.isDirectory()) walk(p, depth + 1);
        else if (it.isFile()) total += fs.statSync(p).size;
      } catch {
        // 单个文件读不到就跳过
      }
    }
  };
  walk(dir, 0);
  return total;
}

/** 量某个子路径的体积（不存在返回 0）。 */
function sizeOfSub(dir, sub) {
  const p = path.join(dir, sub);
  if (!fs.existsSync(p)) return 0;
  return dirSizeBytes(p);
}

/** 磁盘剩余字节；statfs 不可用时返回 null。 */
export function freeBytes(target) {
  try {
    const st = fs.statfsSync ? fs.statfsSync(target) : null;
    if (!st) return null;
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** raw/archive 下的月份目录（YYYY-MM），用于只读提示「归档保留多少个月」。 */
export function archiveMonths(dir) {
  const p = path.join(dir, 'raw', 'archive');
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 生成体积报告。
 * @param {{dir:string, storage?:object}} opts
 */
export function storageReport({ dir, storage } = {}) {
  const cfg = normalizeStorage(storage || {});
  const dataBytes = dirSizeBytes(dir);
  const hotBytes = sizeOfSub(dir, path.join('raw', 'hot'));
  const archiveBytes = sizeOfSub(dir, path.join('raw', 'archive'));
  const dataMb = +(dataBytes / 1048576).toFixed(2);
  const free = freeBytes(dir);
  const freeGb = free == null ? null : +(free / 1073741824).toFixed(2);
  const months = archiveMonths(dir);
  const alerts = [];
  if (dataMb > cfg.maxDataMb) alerts.push(`data>${cfg.maxDataMb}MB`);
  if (freeGb != null && freeGb < cfg.minFreeGb) alerts.push(`free<${cfg.minFreeGb}GB`);
  return {
    dir,
    dataBytes,
    dataMb,
    hotMb: +(hotBytes / 1048576).toFixed(2),
    archiveMb: +(archiveBytes / 1048576).toFixed(2),
    archiveMonths: months.length,
    archiveFrom: months[0] || '',
    archiveTo: months[months.length - 1] || '',
    freeBytes: free,
    freeGb,
    maxDataMb: cfg.maxDataMb,
    minFreeGb: cfg.minFreeGb,
    level: alerts.length ? 'warn' : 'ok',
    alerts
  };
}

/** 一行摘要（health/doctor 用）。 */
export function summarizeStorage(r) {
  const free = r.freeGb == null ? '磁盘剩余未知' : `剩余 ${r.freeGb} GB`;
  const arch = r.archiveMonths ? `归档 ${r.archiveMonths} 个月` : '无归档';
  return `数据 ${r.dataMb} MB（上限 ${r.maxDataMb} MB）、${free}（下限 ${r.minFreeGb} GB）、${arch}`;
}
