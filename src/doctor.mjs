// 自检（doctor）：v7 §10 步 0 的四项内容校验 + 窗口/策略/卡片状态。
//
// 设计原则：只报告，不自动修。任何一项 ✗ 都说明数据可能坏了，先人工看。

import fs from 'node:fs';
import path from 'node:path';

import * as card from './card.mjs';
import * as policy from './policy.mjs';
import * as token from './token.mjs';
import { paths, readInvalidated, readJsonl, readShadow, readShadowStats } from './longterm.mjs';
import { unknownScoringKeys } from './score.mjs';
import { storageReport, summarizeStorage } from './storage.mjs';
import { auditPresets } from './preset-audit.mjs';

function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: String(detail || '') };
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 最后一行是否完整（没有换行结尾 = 可能写到一半被打断）。 */
function tailComplete(file) {
  try {
    const st = fs.statSync(file);
    if (!st.size) return true;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, st.size - 1);
      return buf[0] === 0x0a || buf[0] === 0x0d;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * @param {string} dir 数据目录
 * @param {{config?:object, modelWindow?:number}} opts
 */
export function checkDataDir(dir, { config = {}, modelWindow = 0 } = {}) {
  const p = paths(dir);
  const checks = [];

  // 1) 长期库可解析 + 重复 id
  const lt = readJsonl(p.longterm);
  const ids = new Map();
  let dup = 0;
  for (const row of lt.rows) {
    if (row?.ev !== 'fact') continue;
    const id = String(row.id || '');
    if (!id) continue;
    if (ids.has(id)) dup += 1;
    ids.set(id, true);
  }
  checks.push(check('长期库可解析', lt.bad === 0, `${lt.rows.length} 行，坏行 ${lt.bad}`));
  checks.push(check('长期库 id 唯一', dup === 0, dup ? `${dup} 个重复 id` : `${ids.size} 条唯一事实`));
  checks.push(check('长期库末行完整', !exists(p.longterm) || tailComplete(p.longterm), exists(p.longterm) ? `${sizeOf(p.longterm)} B` : '文件不存在（正常）'));

  // 2) 影子文件
  const sh = readJsonl(p.shadow);
  checks.push(check('影子文件可解析', sh.bad === 0, exists(p.shadow) ? `${sh.rows.length} 行，坏行 ${sh.bad}` : '文件不存在（正常）'));

  // 3) 事实卡
  const cardText = (() => {
    try {
      return fs.readFileSync(card.cardFile(dir), 'utf8').trim();
    } catch {
      return '';
    }
  })();
  const cfg = card.normalizeCardConfig(config.profile || {});
  const backups = card.listBackups(dir);
  const fresh = !cardText && !exists(path.join(dir, 'state', 'longterm.jsonl')) && !exists(path.join(dir, 'window'));
  checks.push(check('事实卡存在', Boolean(cardText) || fresh, cardText ? `${cardText.length} 字` : fresh ? '全新安装，还没有事实卡' : '还没有 profile.md'));
  checks.push(check('事实卡未超限', cardText.length <= cfg.maxChars + 200, `${cardText.length} / ${cfg.maxChars} 字`));
  checks.push(check('事实卡有备份', backups.length > 0 || !cardText, `${backups.length} 份`));

  // 4) token 日志与窗口
  const win = token.describeWindow({ config, dir, modelWindow, thresholdRatio: Number(config.rotation?.thresholdRatio ?? config.rotationThresholdRatio) || 0.7 });
  const turns = token.readTurns(dir).length;
  checks.push(check('token 日志可用', turns > 0 || fresh, fresh ? '全新安装，还没有轮次' : `${turns} 轮可读；窗口 ${win.tokens}（${win.source}），阈值 ${win.threshold}`));

  // 5) 策略与墓碑
  const st = policy.readPolicyState(dir);
  const ownerKey = `private:${config.ownerQQ || '10001'}`;
  const states = policy.listStates([ownerKey], { config: config.policy || {}, state: st });
  checks.push(check('会话策略可解析', states.length > 0, states.map((s) => `${s.key}=${s.state}`).join(', ')));
  const tombIds = Object.keys(readInvalidated(dir));
  // 墓碑必须能找到原文：找不到就是孤儿墓碑（sidecar 被手改坏 / 事件被截断）。
  const orphans = tombIds.filter((id) => !ids.has(String(id)));
  checks.push(check('作废墓碑可读', orphans.length === 0, `${tombIds.length} 条${orphans.length ? `，${orphans.length} 条没有原文` : ''}`));
  // 预设里不能挂对话压缩（compaction-basic / command-compact），否则窗口原文会被摘要替换（记忆 3.0 §17）。
  try {
    const preset = auditPresets();
    checks.push(check('预设未挂折叠组件', preset.ok, preset.ok ? '未检测到 compaction-basic / command-compact' : preset.hits.join('、')));
  } catch (e) {
    checks.push(check('预设未挂折叠组件', false, '检查失败：' + (e?.message || e)));
  }
  const unknownKeys = unknownScoringKeys(config.scoring || {});
  checks.push(check('打分配置无未知键', unknownKeys.length === 0, unknownKeys.length ? unknownKeys.join(', ') : 'ok'));

  // 6) 数据体积与磁盘（只告警不删除；超阈值算 ✗ 让人看见，但不影响解析类检查）
  let storage = null;
  try {
    storage = storageReport({ dir, storage: config.storage || config.memory?.storage });
    checks.push(check('数据体积与磁盘', storage.level === 'ok', summarizeStorage(storage) + (storage.alerts.length ? ` · ${storage.alerts.join(' ')}` : '')));
  } catch (e) {
    checks.push(check('数据体积与磁盘', false, `检查失败：${e?.message || e}`));
  }

  const shadowStats = readShadowStats();
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    dir,
    checks,
    failed: failed.map((c) => c.name),
    card: { chars: cardText.length, backups: backups.length, keep: cfg.backupKeep },
    window: win,
    policy: states,
    invalidated: tombIds.length,
    storage,
    shadow: { rows: readShadow().rows.length, stats: shadowStats }
  };
}

/** 一行摘要（日志用）。 */
export function summarize(report) {
  if (!report) return 'doctor：没有结果';
  const bad = report.checks.filter((c) => !c.ok).map((c) => `${c.name}（${c.detail}）`);
  return report.ok
    ? `doctor：${report.checks.length} 项全过；窗口 ${report.window.tokens}（${report.window.source}）阈值 ${report.window.threshold}`
    : `doctor：${report.checks.length - bad.length}/${report.checks.length} 过，异常：${bad.join('；')}`;
}
