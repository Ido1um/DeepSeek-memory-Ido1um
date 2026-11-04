// 手写「永不衰减的规则」——人工真值，优先级高于自动投影的事实卡。
//
// 为什么单独一个文件：事实卡是长期库的投影，会随打分进出、会被预算截断；
// 而「叫主公」「不许叫小助手」这类原则一旦丢一次，人格就崩一次。
// 所以把它放在手写文件里：改完保存即生效，不参与打分、不被截断（只在超预算时按行截尾并标注）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const RULES_FILE = 'rules.md';

export const RULES_TEMPLATE = `# 永不衰减的规则与设定（手写 · 改完保存即生效）

> 这里写「永远成立」的东西：称呼、禁区、说话风格、硬约束。
> 与自动投影的事实卡冲突时，**以本文件为准**。事实卡是自动生成的，这里是人工真值。

## 称呼与身份
- 用户称呼：用户 / 小助手（平时不用刻意叫，正常聊就行）
- 机器人名字：助手（小名「小助手」，用户叫哪个都行）
- 自称：我 / 人家

## 禁止
- 不许叫助手「小助手」（叫了会炸）；用户偶尔叫一句勉强能接受
- 不外传用户的照片与私事

## 风格
- 回话短，一两句就够；不列清单、不写小作文
- 允许嘴硬心软，但不阴阳怪气
`;

export function rulesFile(dir) {
  return path.join(dir, RULES_FILE);
}

export function readRules(dir) {
  try {
    return fs.readFileSync(rulesFile(dir), 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
}

export function writeRules(dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rulesFile(dir), String(text ?? ''), 'utf8');
  return { file: rulesFile(dir), chars: String(text ?? '').trim().length };
}

/** 首次使用时生成模板（默认不覆盖已有文件）。 */
export function ensureRules(dir, { force = false } = {}) {
  if (!force && fs.existsSync(rulesFile(dir))) return { created: false, file: rulesFile(dir) };
  writeRules(dir, RULES_TEMPLATE);
  return { created: true, file: rulesFile(dir), template: true };
}

/** 上一次截断留下的尾注；重新截断前先摘掉，否则会一层层叠上去。 */
const TAIL_RE = /\n…（(?:还有 \d+ 行未展开|其余 \d+ 条已省略|其余 \d+ 行已省略)）\s*$/;
const minTail = 18; // 尾注大概占多少字（"…（还有 123 行未展开）"）

/**
 * 按行截断（保留标题行），超出部分标注省略行数。
 * 关键：**必须是原文前缀**——遇到第一条放不下的行就停，不能跳过它去捡后面更短的行。
 * 旧实现是 `cut += 1; continue`，结果一张按「硬事实在前」排好的卡，超预算时
 * 后面的短软事实能挤进来、前面的长硬事实被跳过丢失，直接违反「硬事实永不因预算被丢」。
 * maxChars<=0 表示这一段预算为 0，正确行为是「不注入」，不是「全量注入」。
 */
export function trimLines(text, maxChars, opts = {}) {
  const raw = String(text ?? '').replace(/\uFEFF/g, '').replace(TAIL_RE, '').trim();
  if (!raw) return { text: '', chars: 0, truncated: 0 };
  const budget = Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 0;
  const lines = raw.split(/\r?\n/);
  if (budget <= 0) return { text: '', chars: 0, truncated: lines.length };
  if (raw.length <= budget) return { text: raw, chars: raw.length, truncated: 0 };

  const kept = [];
  let used = 0;
  for (const line of lines) {
    const add = (kept.length ? 1 : 0) + line.length;
    if (used + add > budget - minTail) break; // 前缀截断：放不下就停
    kept.push(line);
    used += add;
  }
  if (!kept.length) {
    // 第一行就超长（基本只会在预算很小时发生）：切一段，但不切断代理对
    let head = lines[0].slice(0, Math.max(0, budget - minTail));
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    return head ? { text: head, chars: head.length, truncated: lines.length } : { text: '', chars: 0, truncated: lines.length };
  }
  const cut = lines.length - kept.length;
  const body = kept.join('\n');
  if (cut <= 0) return { text: body, chars: body.length, truncated: 0 };
  const note = typeof opts.note === 'function' ? String(opts.note(cut) || '') : '';
  const tail = note || `\n…（还有 ${cut} 行未展开）`;
  const out = body.length + tail.length <= budget ? body + tail : body;
  return { text: out, chars: out.length, truncated: cut };
}

/** 注入用的规则段（带标题，标题也算字数）。 */
export function rulesSection(dir, maxChars) {
  const raw = readRules(dir);
  if (!raw) return { text: '', chars: 0, truncated: 0, empty: true };
  const head = '【规则（手写 · 优先级最高）】\n';
  const body = trimLines(raw, Math.max(0, maxChars - head.length));
  if (!body.text) return { text: '', chars: 0, truncated: 0, empty: true };
  const text = head + body.text;
  return { text, chars: text.length, truncated: body.truncated, empty: false };
}

/** 规则文件内容哈希（前 8 位）——判断「用户有没有改过规则」。 */
export function rulesHash(dir) {
  const raw = readRules(dir);
  if (!raw) return '';
  return createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 8);
}

/** 按会话只注入一次时，后续轮次用这一行占位（提醒「规则在首条」）。 */
export const RULES_PLACEHOLDER = '【规则】见本会话首条（手写 · 优先级最高）；有冲突以首条为准。';

/**
 * 决定这一轮要不要带完整规则。
 * - mode=always：每轮都带（现状，默认）
 * - mode=session：同会话 + 规则没改 + 未超轮数 + 上下文不紧 → 只发占位
 */
/** 压力 = 当前真实 token / 轮转阈值（不是 / 窗口）。700k 阈值时 420k 即 0.6。 */
export function pressureRatio(realTokens, threshold) {
  const t = Number(threshold) || 0;
  return t > 0 ? (Number(realTokens) || 0) / t : 0;
}

export function decideRules({
  mode = 'always',
  sameSession = false,
  sameHash = false,
  turns = 0,
  pressure = 0,
  everyTurns = 20,
  pressureAt = 0.6, // 占「轮转阈值」的比例
} = {}) {
  if (mode !== 'session') return { inject: true, reason: 'always' };
  if (!sameSession) return { inject: true, reason: 'new-session' };
  if (!sameHash) return { inject: true, reason: 'rules-changed' };
  if (Number(turns) >= Math.max(1, Number(everyTurns) || 20)) return { inject: true, reason: 'turn-refresh' };
  if (Number(pressure) >= (Number(pressureAt) || 0.6)) return { inject: true, reason: 'pressure' };
  return { inject: false, reason: 'session-once' };
}
