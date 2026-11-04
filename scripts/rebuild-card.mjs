// 用修好的索引重建事实卡（旧事行现在应该出现）。
import fs from 'node:fs';
import path from 'node:path';
import { openIndex, readInvalidated } from '../src/longterm.mjs';
import { readTopics } from '../src/topics.mjs';
import { buildTreeCard } from '../src/card-tree.mjs';

const dir = process.env.QQ_MEMORY_DIR || `${process.env.HOME || process.env.USERPROFILE || '.'}/.deepseek-memory/data`;
const facts = openIndex(dir).facts();
const topics = readTopics(dir);
const card = buildTreeCard(facts, { maxChars: Number(process.env.CARD_MAX || 1500), timeEnabled: true }, topics);
const target = path.join(dir, 'profile.md');
const backup = `${target}.bak-rebuild-${Date.now()}`;
if (fs.existsSync(target)) fs.copyFileSync(target, backup);
fs.writeFileSync(target, card.text, 'utf8');
console.log('备份', backup);
const dropped = Array.isArray(card.dropped) ? card.dropped.length : Number(card.dropped || 0);
const included = Array.isArray(card.included) ? card.included.length : Number(card.included || 0);
console.log('字数', card.chars, '收录', included, '挤出', dropped, '主题', (card.groups || []).length);
console.log('旧事行', /旧事：/.test(card.text));
console.log(card.text.split('\n').filter((l) => l.includes('旧事')).join('\n'));
