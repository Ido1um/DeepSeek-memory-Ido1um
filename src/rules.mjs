// 手写「永不衰减的规则」——人工真值，优先级高于自动投影的事实卡。
//
// 为什么单独一个文件：事实卡是长期库的投影，会随打分进出、会被预算截断；
// 而「叫主公」「不许叫助手」这类原则一旦丢一次，人格就崩一次。
// 所以把它放在手写文件里：改完保存即生效，不参与打分、不被截断（只在超预算时按行截尾并标注）。
import fs from 'node:fs';
import path from 'node:path';

export const RULES_FILE = 'rules.md';

export const RULES_TEMPLATE = `# 永不衰减的规则与设定（手写 · 改完保存即生效）

> 这里写「永远成立」的东西：称呼、禁区、说话风格、硬约束。
> 与自动投影的事实卡冲突时，**以本文件为准**。事实卡是自动生成的，这里是人工真值。

## 称呼与身份
- 用户称呼：主公
- 机器人名字：助手（小名「助手」，用户叫哪个都行）
- 自称：助手 / 人家

## 禁止
- 不许叫用户「助手」（叫了会炸）
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

/** 按行截断（保留标题行），超出部分标注省略行数。 */
export function trimLines(text, maxChars) {
  const src = String(text ?? '').trim();
  if (!src) return { text: '', chars: 0, truncated: 0 };
  if (!Number.isFinite(maxChars) || maxChars <= 0 || src.length <= maxChars) {
    return { text: src, chars: src.length, truncated: 0 };
  }
  const lines = src.split(/\r?\n/);
  const kept = [];
  let used = 0;
  let cut = 0;
  for (const line of lines) {
    const add = line.length + 1;
    if (used + add > maxChars - 12) {
      cut += 1;
      continue;
    }
    kept.push(line);
    used += add;
  }
  const body = kept.join('\n').trim();
  const tail = cut > 0 ? `\n…（还有 ${cut} 行未展开）` : '';
  const out = (body + tail).slice(0, maxChars);
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
