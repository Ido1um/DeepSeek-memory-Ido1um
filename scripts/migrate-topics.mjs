// 把现有长期事实迁到「主题 + 槽位」结构（记忆 3.0 P2）。
//
//   node scripts/migrate-topics.mjs               # 预览：分类结果 + review 清单
//   node scripts/migrate-topics.mjs --write       # 写 topics.jsonl + 给事实补 ev:'update'
//   node scripts/migrate-topics.mjs --dir <目录> --json
//
// 规则：
// - 只做**保守映射**：命中规则才挂主题，拿不准的写进 state/topics-migrate-review.jsonl 等人确认；
// - 追加式：不重写 longterm.jsonl 的历史行，只 append ev:'update'（topicId/slot），可回滚；
// - 幂等：已经挂过同一 topicId+slot 的事实跳过；topics.jsonl 按 id 覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEvents, materialize, readInvalidated, appendEvent } from '../src/longterm.mjs';
import {
  DEFAULT_TOPICS,
  SLOTS,
  SLOT_LABEL,
  classifyFact,
  ensureTopic,
  readTopics,
  refinePlacement,
  upsertTopic,
  writeTopics
} from '../src/topics.mjs';
import { requestModel } from '../src/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = process.env.QQ_MEMORY_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.deepseek-memory', 'data');

function arg(name, fallback = '') {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const dir = arg('dir', DEFAULT_DIR);
const write = has('write');
const json = has('json');
const useModel = !has('rules');

/** 从模型回复里抠 JSON 数组（容忍代码围栏/前后废话）。 */
function parseArray(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

if (!fs.existsSync(dir)) {
  console.error(`数据目录不存在：${dir}`);
  process.exit(2);
}

const events = readEvents(dir).rows || [];
const facts = materialize(events, readInvalidated(dir)).filter((f) => f && f.status !== 'invalidated');
const known = readTopics(dir);
const seedMissing = DEFAULT_TOPICS.filter((t) => !known.some((k) => k.id === t.id));

const assigned = [];
const review = [];
const pendingFacts = facts.filter((f) => !(f.topicId && f.slot));

// --repair：只对「明显放错主题」的存量事实做高精度纠偏（课业被挂到华光之类）
const repair = has('repair');
const repaired = [];
if (repair) {
  for (const f of facts) {
    if (!f.topicId) continue;
    const fix = refinePlacement(f, { topicId: f.topicId, slot: f.slot });
    if (fix) repaired.push({ fact: f, ...fix });
  }
}

if (useModel && pendingFacts.length) {
  const existing = readTopics(dir).length ? readTopics(dir) : DEFAULT_TOPICS.map((t) => ({ ...t }));
  const topicLine = existing.map((t) => `${t.id}（${t.name}${t.parentId ? `，父 ${t.parentId}` : ''}）`).join('；');
  const slotLine = SLOTS.map((s) => `${s}（${SLOT_LABEL[s] || s}）`).join('、');
  const BATCH = 16;
  for (let i = 0; i < pendingFacts.length; i += BATCH) {
    const batch = pendingFacts.slice(i, i + BATCH);
    const lines = batch
      .map((f) => {
        const text = String(f.value || f.label || '').replace(/\s+/g, ' ').slice(0, 100);
        return `${f.id} | ${f.label || f.sig || ''} | ${text}`;
      })
      .join('\n');
    const res = await requestModel({
      system: [
        '你在整理「助手」的长期记忆。每条记忆要挂到一个主题（topic）和一个槽位（slot）上。',
        `现有主题：${topicLine}。`,
        `槽位词表：${slotLine}。`,
        '规则：主题优先复用现有 id；确实没有合适主题时可新建，命名用 2–8 字名词，最多新建 3 个；',
        '槽位必须从词表里选；一条记忆只挂一个主题；拿不准就 slot 留空（topicId 照填）。',
        '输出 JSON 数组，每项 {"id":"事实id","topicId":"t-xxx 或新主题id","slot":"槽位或空","confidence":0~1}，不要解释。'
      ].join('\n'),
      userContent: `记忆列表（id | 标签 | 内容）：\n${lines}\n\n请输出 JSON 数组。`,
      json: true,
      maxChars: 4000,
      timeoutMs: 60000
    });
    if (!res.ok) {
      console.error(`模型分类失败（${res.error}），这批退回规则映射`);
      for (const f of batch) {
        const g = classifyFact(f);
        if (g.topicId && SLOTS.includes(g.slot)) assigned.push({ fact: f, ...g, by: 'rule' });
        else review.push({ id: f.id, value: f.value, label: f.label, sig: f.sig, reason: `模型失败+${g.reason}` });
      }
      continue;
    }
    const arr = parseArray(res.text);
    const byId = new Map(batch.map((f) => [f.id, f]));
    const seen = new Set();
    for (const item of arr) {
      const f = byId.get(String(item?.id || ''));
      if (!f || seen.has(f.id)) continue;
      seen.add(f.id);
      let tid = String(item?.topicId || '').trim();
      let slot = String(item?.slot || '').trim();
      if (slot && !SLOTS.includes(slot)) slot = '';
      if (tid && !/^t-/.test(tid)) tid = `t-${tid}`;
      if (!tid) {
        review.push({ id: f.id, value: f.value, label: f.label, sig: f.sig, reason: '模型没给主题' });
        continue;
      }
      assigned.push({ fact: f, topicId: tid, slot, confidence: Number(item?.confidence) || 0.6, reason: 'model', by: 'model', topicName: String(item?.topicName || item?.topic || '') });
    }
    for (const f of batch) {
      if (!seen.has(f.id)) review.push({ id: f.id, value: f.value, label: f.label, sig: f.sig, reason: '模型漏项' });
    }
  }
} else {
  for (const f of pendingFacts) {
    const guess = classifyFact(f);
    if (!guess.topicId || !SLOTS.includes(guess.slot)) {
      review.push({ id: f.id, value: f.value, label: f.label, sig: f.sig, reason: guess.reason || '未命中' });
      continue;
    }
    assigned.push({ fact: f, ...guess, by: 'rule' });
  }
}

const now = new Date().toISOString();
if (write) {
  for (const t of seedMissing) {
    upsertTopic(dir, { v: 1, id: t.id, name: t.name, parentId: t.parentId || '', aliases: t.aliases || [], note: '', createdAt: now });
  }
  // 父主题可能比子主题后写，第二遍补齐 parentId（upsertTopic 按键覆盖）
  for (const t of DEFAULT_TOPICS) {
    if (t.parentId) upsertTopic(dir, { id: t.id, parentId: t.parentId });
  }
  // 模型新建的主题：按 id/name 补齐，父级先挂「杂事」，人工可在 topics.jsonl 里改
  for (const item of assigned) {
    const exists = readTopics(dir).some((t) => t.id === item.topicId);
    if (!exists) {
      ensureTopic(dir, {
        id: item.topicId,
        name: item.topicName || item.topicId.replace(/^t-/, '').slice(0, 8),
        parentId: 't-life',
        note: `由 migrate-topics 按模型建议新建（${item.reason}）`
      });
    }
  }
  for (const item of assigned) {
    appendEvent(
      {
        ev: 'update',
        id: item.fact.id,
        topicId: item.topicId,
        slot: item.slot,
        at: Date.now(),
        by: 'migrate-topics',
        reason: item.reason
      },
      dir
    );
  }
  for (const item of repaired) {
    appendEvent(
      {
        ev: 'update',
        id: item.fact.id,
        topicId: item.topicId,
        slot: item.slot,
        at: Date.now(),
        by: 'migrate-topics',
        reason: item.reason
      },
      dir
    );
  }
  const reviewFile = path.join(dir, 'state', 'topics-migrate-review.jsonl');
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
  if (review.length) fs.writeFileSync(reviewFile, review.map((r) => JSON.stringify(r)).join('\n') + '\n');
  else fs.rmSync(reviewFile, { force: true });
}

const byTopic = new Map();
for (const item of assigned) {
  if (!byTopic.has(item.topicId)) byTopic.set(item.topicId, []);
  byTopic.get(item.topicId).push(item);
}

if (json) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        write,
        dir,
        facts: facts.length,
        assigned: assigned.length,
        review: review.length,
        topicsSeeded: write ? seedMissing.length : 0,
        groups: [...byTopic.entries()].map(([topicId, list]) => ({
          topicId,
          items: list.map((x) => ({ id: x.fact.id, slot: x.slot, value: x.fact.value }))
        }))
      },
      null,
      2
    )
  );
} else {
  console.log(`数据目录：${dir}`);
  console.log(`事实 ${facts.length} 条；可挂主题 ${assigned.length} 条；待人工 ${review.length} 条${write ? '（已写盘）' : '  ← 预览，加 --write 才写盘'}`);
  if (repair) {
    console.log(`纠偏 ${repaired.length} 条${write ? '（已写盘）' : '  ← 加 --write 才写盘'}`);
    for (const x of repaired) console.log(`  · ${x.fact.topicId}→${x.topicId}  ${String(x.fact.value || '').slice(0, 40)}`);
  }
  for (const [topicId, list] of byTopic) {
    const name = DEFAULT_TOPICS.find((t) => t.id === topicId)?.name || topicId;
    console.log(`\n【${name}】${topicId}`);
    for (const x of list) console.log(`  · ${x.slot.padEnd(9)} ${String(x.fact.value || '').slice(0, 40)}`);
  }
  if (review.length) {
    console.log(`\n待人工确认（${review.length}）：`);
    for (const r of review.slice(0, 20)) console.log(`  · ${String(r.value || r.label || r.id).slice(0, 46)}  ← ${r.reason}`);
  }
}
