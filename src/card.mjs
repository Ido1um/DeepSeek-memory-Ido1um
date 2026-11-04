// 事实卡 = 长期库的投影（v7 §5.4）。
//
// 卡片已饱和（1500 字上限、27 条），所以不再让模型自由重写，而是按确定规则投影：
//   hard 全留 → 高分 long（按 score 降序）→ 新近 long
// 额度：总 maxChars，hard 预留 hardReserveChars；bot 侧 ≤ botMaxChars（「我的事」）。
// 超限先丢低分 long，**永不丢 hard**；被挤出的仍在 longterm.jsonl，靠检索找回。
// 写盘前先备份 profile.md，保留 backupKeep 份。

import fs from 'node:fs';
import path from 'node:path';

import { scoreOf } from './score.mjs';

const TIER_RANK = { hard: 3, long: 2, general: 1, temp: 0 };

export const CARD_HEADER = '【长期记忆（事实卡）】\n（长期有效的事实与约定，按需参考；和用户最新的话冲突时以最新的话为准。）';

export function cardFile(dir) {
  return path.join(String(dir || ''), 'profile.md');
}

export function normalizeCardConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    enabled: c.enabled !== false,
    maxChars: num(c.maxChars, 1500, 200, 8000),
    hardReserveChars: num(c.hardReserveChars, 400, 0, 4000),
    botMaxChars: num(c.botMaxChars, 200, 0, 2000),
    backupKeep: num(c.backupKeep, 5, 0, 200),
    source: ['auto', 'projection', 'model'].includes(c.source) ? c.source : 'auto'
  };
}

function bulletOf(fact) {
  const text = String(fact?.value || fact?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const rawLabel = String(fact?.label || fact?.pattern || '').trim();
  // 内部标记算不上标签（回填/新记的普通事实用 profile/note 当 sig 前缀）
  const label = ['profile', 'note', 'user', 'bot', 'misc'].includes(rawLabel) ? '' : rawLabel;
  const head = label && !text.includes(label) ? `${label} ${text}` : text;
  return head.length > 160 ? `${head.slice(0, 160)}…` : head;
}

/**
 * 投影成卡片正文（不含 header）。
 * @param {Array} facts materialize() 出来的事实
 * @returns {{body:string, included:Array, dropped:Array, chars:number}}
 */
export function projectBody(facts = [], rawConfig = {}) {
  const cfg = normalizeCardConfig(rawConfig);
  const active = (Array.isArray(facts) ? facts : []).filter(
    (f) => f && f.status !== 'invalidated' && f.status !== 'expired' && f.status !== 'merged'
  );
  // v8 分类：event 走时间线，不进事实卡（否则一天一条把卡挤爆）；
  // 例外：里程碑（pattern==='first'）一年也没几条，值得进卡。
  // v11：chat 类（寒暄/临时状态）也不进卡，只在库里短暂留档。
  const forCard = active.filter(
    (f) => String(f.class || 'note') !== 'chat'
      && (String(f.class || 'note') !== 'event' || f.pattern === 'first')
  );
  const byScore = (a, b) => scoreOf(b) - scoreOf(a);
  const byNew = (a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0);

  const groups = [
    { title: '用户的事', about: 'user', budget: Math.max(0, cfg.maxChars - cfg.botMaxChars) },
    { title: '我的事', about: 'bot', budget: cfg.botMaxChars }
  ];

  const included = [];
  const dropped = [];
  const sections = [];
  let total = 0;

  for (const g of groups) {
    const mine = forCard.filter((f) => (f.about || 'user') === g.about);
    const hard = mine.filter((f) => f.tier === 'hard').sort(byScore);
    const long = mine.filter((f) => f.tier === 'long').sort((a, b) => byScore(a, b) || byNew(a, b));
    const rest = mine.filter((f) => f.tier !== 'hard' && f.tier !== 'long').sort(byScore);
    const lines = [];
    let used = 0;
    const take = (f, cap) => {
      const body = bulletOf(f);
      if (!body) return false;
      const len = body.length + 2; // "· " + 换行
      // cap 是「本组上限」；hard 传全局 maxChars（不受组预算限制，只受总长限制）。
      if (used + len > cap) return false;
      if (total + len > cfg.maxChars) return false;
      lines.push(`· ${body}`);
      used += len;
      total += len;
      included.push(f);
      return true;
    };
    // hard 先写：用户侧硬事实永不因预算被丢（只受全局 maxChars 限制），
    // 所以传 cfg.maxChars 而不是 maxChars - total（后者把 used 重复扣一次，
    // 结果 6 条硬事实就把额度吃光，后面的硬事实被静默丢弃）。
    // 「我的事」仍受 botMaxChars 限额（人设区刻意保持精简）。
    for (const f of hard) {
      if (!take(f, g.about === 'user' ? cfg.maxChars : g.budget)) dropped.push(f);
    }
    for (const f of long) if (!take(f, g.budget)) dropped.push(f);
    for (const f of rest) if (!take(f, g.budget)) dropped.push(f);
    if (lines.length) sections.push(`【${g.title}】\n${lines.join('\n')}`);
  }

  const body = sections.join('\n\n');
  return { body, included, dropped, chars: body.length };
}

export function buildCard(facts = [], rawConfig = {}) {
  const { body, included, dropped, chars } = projectBody(facts, rawConfig);
  if (!body) return { text: '', included, dropped, chars: 0 };
  return { text: `${CARD_HEADER}\n${body}`, included, dropped, chars };
}

/** 备份并写入；保留最近 backupKeep 份。返回 {chars, backup, pruned}。 */
export function writeCard(dir, text, rawConfig = {}) {
  const cfg = normalizeCardConfig(rawConfig);
  const file = cardFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = String(text || '').trim();
  if (!body) return { chars: 0, backup: '', pruned: 0 };

  let backup = '';
  try {
    if (fs.existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = `${file}.bak-${stamp}`;
      fs.copyFileSync(file, backup);
    }
  } catch {
    backup = '';
  }

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${body}\n`, 'utf8');
  fs.renameSync(tmp, file);

  let pruned = 0;
  if (cfg.backupKeep > 0) {
    try {
      const dirName = path.dirname(file);
      const prefix = `${path.basename(file)}.bak-`;
      const backups = fs
        .readdirSync(dirName)
        .filter((n) => n.startsWith(prefix))
        .sort();
      const extra = backups.slice(0, Math.max(0, backups.length - cfg.backupKeep));
      for (const name of extra) {
        fs.unlinkSync(path.join(dirName, name));
        pruned += 1;
      }
    } catch {
      /* 清理失败不影响写入 */
    }
  }
  return { chars: body.length, backup, pruned };
}

export function listBackups(dir) {
  const file = cardFile(dir);
  try {
    return fs
      .readdirSync(path.dirname(file))
      .filter((n) => n.startsWith(`${path.basename(file)}.bak-`))
      .sort()
      .map((n) => path.join(path.dirname(file), n));
  } catch {
    return [];
  }
}

export function rankOf(tier) {
  return TIER_RANK[String(tier)] ?? -1;
}
