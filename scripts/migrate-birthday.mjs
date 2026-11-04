#!/usr/bin/env node
// 记忆 3.0：把「生日」落进日期字段。
//
// 以前生日只存在 value 文案里（「助手生日是3月15日」「用户 2007 年 9 月 5 日生…」），
// 检索问「生日」找不到用户那条、卡片也没法按日期展示。这个脚本给这类事实补：
//   birthday: { y, m, d, key: 'MM-DD', yearly: true, who: 'owner'|'bot' }
//   dates:    [{ date: 'YYYY-MM-DD'|'', kind: 'birthday', who, yearly: true, phrase }]
// 同时修正 topicId（人 → t-identity / t-bot）与 about。
//
// 只追加 ev:'update'，不改历史行；可反复跑（幂等）。
//
// 用法：
//   node scripts/migrate-birthday.mjs            # 预览
//   node scripts/migrate-birthday.mjs --write    # 写盘（先备份）
//   node scripts/migrate-birthday.mjs --json

import fs from 'node:fs';
import path from 'node:path';
import * as lt from '../src/longterm.mjs';
import { parseBirthday, birthdayWho } from '../src/timeparse.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const write = process.argv.includes('--write');
const asJson = process.argv.includes('--json');
const dir = String(arg('dir', process.env.QQ_MEMORY_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.deepseek-memory', 'data')));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const events = lt.readEvents(dir).rows;
const facts = lt.materialize(events, lt.readInvalidated(dir));
// 只认「生日这件事」本身：slot=birthday；或非事件/计划类事实里出现「生日」。
// 「3月15日生日当天下午逛校园」是事件，不在这里改。
const targets = facts.filter((f) => {
  if (f.status !== 'active') return false;
  if (String(f.slot || '') === 'birthday') return true;
  if (f.class === 'event' || f.class === 'plan') return false;
  return /生日/.test(String(f.value || f.text || ''));
});
// 已经持久化过 birthday 的事实不再重复写。
const persisted = new Map();
for (const ev of events) {
  if (!ev || !ev.id) continue;
  if (ev.birthday && ev.birthday.key) persisted.set(ev.id, ev.birthday);
}

const plan = [];
for (const f of targets) {
  const src = `${f.value || ''} ${f.text || ''}`.trim();
  const b = parseBirthday(f.value || '') || parseBirthday(f.text || '');
  if (!b) continue;
  const who = birthdayWho(f.value || '', f.about || '');
  const topicId = who === 'bot' ? 't-bot' : 't-identity';
  const about = who === 'bot' ? 'bot' : 'user';
  const prev = persisted.get(f.id);
  const same =
    prev &&
    prev.key === b.key &&
    Number(prev.y || 0) === Number(b.y || 0) &&
    prev.who === who &&
    String(f.topicId || '') === topicId;
  if (same) continue;
  plan.push({ id: f.id, value: (f.value || f.text || '').slice(0, 70), birthday: { ...b, who }, who, topicId, fromTopic: f.topicId || '', fromAbout: f.about || '', slot: f.slot || '' });
}

if (asJson) {
  console.log(JSON.stringify({ dir, write, total: plan.length, plan }, null, 2));
} else {
  console.log(`数据目录 ${dir}`);
  console.log(`待补生日字段 ${plan.length} 条${write ? '' : '（预览，加 --write 落盘）'}`);
  for (const p of plan) {
    const b = p.birthday;
    console.log(`· ${p.id}  ${b.y ? `${b.y}-` : ''}${b.key}  who=${p.who}  ${p.fromTopic || '-'}→${p.topicId}`);
    console.log(`    ${p.value}`);
  }
}

if (write && plan.length) {
  const bak = path.join(dir, 'backup', `birthday-${stamp()}`);
  fs.mkdirSync(bak, { recursive: true });
  for (const name of ['longterm.jsonl', 'facts-invalidated.json']) {
    const src = path.join(dir, 'state', name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(bak, name));
  }
  const at = Date.now();
  const lines = plan.map((p) =>
    JSON.stringify({
      ev: 'update',
      id: p.id,
      at,
      birthday: p.birthday,
      dates: [{ date: p.birthday.y ? `${p.birthday.y}-${p.birthday.key}` : '', kind: 'birthday', who: p.who, yearly: true, phrase: p.birthday.phrase }],
      topicId: p.topicId,
      about: p.who === 'bot' ? 'bot' : 'user',
      note: 'migrate-birthday'
    })
  );
  fs.appendFileSync(path.join(dir, 'state', 'longterm.jsonl'), lines.join('\n') + '\n', 'utf8');
  console.log(`\n已写盘 ${lines.length} 条 → backup/${path.basename(bak)}`);
  const after = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
  const bd = after.filter((f) => f.birthday);
  console.log(`复验：带 birthday 字段 ${bd.length} 条`);
  for (const f of bd) console.log(`· ${f.id} ${f.birthday.who} ${f.birthday.y || '----'}-${f.birthday.key} (${f.topicId})`);
}
