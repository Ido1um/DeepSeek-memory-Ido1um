#!/usr/bin/env node
/**
 * 审计：原文日志里「本该抽出事实」的消息，是否真的进了长期事实库。
 *
 * 只读。用当前抽取器把窗口内的主人消息重放一遍（classify 纯函数，不写任何东西），
 * 再和 longterm.jsonl 里已有的事实比对，列出：
 *   - 重放能抽出候选、但库里没有对应事实的（漏记）
 *   - 库里多出来的（回填/手工，原文窗口外或已归档），正常
 *
 * 用法：
 *   node scripts/audit-facts.mjs                 # 默认 7 天窗口
 *   node scripts/audit-facts.mjs --days 30
 *   node scripts/audit-facts.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';

import * as lt from '../src/longterm.mjs';
import { classify, normalizeScoring } from '../src/scoring-runner.mjs';
import { writeGate, GATE_REASONS } from '../src/gate.mjs';
import { memorySection } from '../src/config.mjs';
import { dataDir } from '../src/store.mjs';

const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const DAYS = Number(flag('days', 7)) || 7;
const AS_JSON = flag('json', false) === true;
const WITH_GATE = flag('gate', false) === true;
const DIR = String(flag('dir', '')) || dataDir();
const KEY = String(flag('key', '')) || `private:${memorySection()?.ownerQQ || '10001'}`;

const cfg = normalizeScoring(memorySection()?.scoring || {});
const now = Date.now();
const since = now - DAYS * 86400000;

function readJsonlSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 1) 窗口内的主人原文（只 user 角色；assistant 不参与抽事实）
const rawDir = path.join(DIR, 'raw', 'hot');
const messages = [];
const slug = KEY.replace(/[^a-z0-9]+/gi, '_');
if (fs.existsSync(rawDir)) {
  for (const day of fs.readdirSync(rawDir)) {
    const file = path.join(rawDir, day, `${slug}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const row of readJsonlSafe(file)) {
      if (row.role !== 'user') continue;
      const ts = new Date(row.ts).getTime();
      if (!Number.isFinite(ts) || ts < since) continue;
      messages.push({ ts, day, text: String(row.text || ''), messageId: row.messageId || '' });
    }
  }
}
messages.sort((a, b) => a.ts - b.ts);

// 2) 库里的事实
const facts = lt.materialize(lt.readEvents(DIR).rows || [], lt.readInvalidated(DIR));
const nv = (s) => String(s || '').replace(/[\s，。,.!！?？、；;：:“”"'`\[\]【】()（）]/g, '').toLowerCase();
const factVals = facts.map((f) => nv(`${f.value || ''}${f.text || ''}`)).filter((v) => v.length >= 4);
const has = (cand) => facts.some((f) => f.sig === cand.sig)
  || (nv(cand.value ?? cand.task ?? '').length >= 4 && factVals.some((v) => v.includes(nv(cand.value ?? cand.task ?? '')) || nv(cand.value ?? cand.task ?? '').includes(v)));

// 3) 重放
const missed = [];
let withCandidates = 0;
for (const m of messages) {
  let out;
  try { out = classify(m.text, cfg); } catch { out = { candidates: [] }; }
  const cands = out.candidates || [];
  if (!cands.length) continue;
  withCandidates += 1;
  const missing = cands.filter((c) => !has(c));
  if (missing.length) {
    missed.push({ ...m, candidates: missing.map((c) => ({ sig: c.sig, tier: c.tier, value: c.value ?? c.task ?? '' })) });
  }
}

// 4) 库里有、原文重放抽不出的（回填/手工）
const allSig = new Set();
for (const m of messages) {
  try { for (const c of classify(m.text, cfg).candidates || []) allSig.add(c.sig); } catch {}
}
const extra = facts.filter((f) => !allSig.has(f.sig));

// 5) 存量体检（--gate）：拿当前的写入门规则回扫库里已有事实，
//    看「如果按今天的标准，这些当初不会被写进来」的有哪些、各自什么理由。
//    只报告，不删除——要不要作废由人决定（工作台/ invalidate）。
const gateHits = [];
if (WITH_GATE) {
  for (const f of facts) {
    const text = String(f.text || f.quote || f.value || '');
    const g = writeGate(text, { about: f.about || 'user', class: f.class || 'note', value: String(f.value || '') }, { cfg });
    if (!g.ok) gateHits.push({ id: f.id, class: f.class || 'note', reason: g.reason, value: String(f.value || '').slice(0, 60) });
  }
}
const gateByReason = gateHits.reduce((m, h) => ({ ...m, [h.reason]: (m[h.reason] || 0) + 1 }), {});

const report = {
  dir: DIR,
  key: KEY,
  windowDays: DAYS,
  scoringMode: cfg.mode,
  userMessages: messages.length,
  messagesWithCandidates: withCandidates,
  factsInStore: facts.length,
  missedCount: missed.length,
  missed: missed.map((m) => ({
    at: new Date(m.ts).toISOString(),
    text: m.text.slice(0, 80),
    candidates: m.candidates,
  })),
  extraFacts: extra.map((f) => ({ id: f.id, sig: f.sig, tier: f.tier, value: String(f.value || '').slice(0, 50) })),
  ...(WITH_GATE ? { gate: { checked: facts.length, blocked: gateHits.length, byReason: gateByReason, hits: gateHits } } : {}),
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`数据目录   ${report.dir}`);
  console.log(`会话       ${report.key}    窗口 ${DAYS} 天    打分模式 ${report.scoringMode}`);
  console.log(`主人消息   ${report.userMessages} 条（其中 ${report.messagesWithCandidates} 条现在能抽出候选）`);
  console.log(`库中事实   ${report.factsInStore} 条`);
  if (!report.userMessages) {
    console.log('\n· 没有找到原文日志（检查 --dir / --key，或确认宿主确实在记原文）。');
  }
  if (!report.missed.length) {
    console.log('\n✓ 没有漏记：能抽出候选的消息，库里都有对应事实。');
  } else {
    console.log(`\n✗ 漏记 ${report.missed.length} 条（当时没进库，现在重放能抽出来）：`);
    for (const m of report.missed) {
      console.log(`  ${m.at}  ${m.text}`);
      for (const c of m.candidates) console.log(`      → ${c.sig} [${c.tier}] ${String(c.value).slice(0, 40)}`);
    }
  }
  if (report.extraFacts.length) {
    console.log(`\n· 库里另有 ${report.extraFacts.length} 条事实来自回填/手工（原文窗口外或已归档），正常：`);
    for (const f of report.extraFacts.slice(0, 5)) console.log(`  ${f.id} ${f.sig} [${f.tier}] ${f.value}`);
    if (report.extraFacts.length > 5) console.log(`  … 其余 ${report.extraFacts.length - 5} 条`);
  }
  if (report.gate) {
    const g = report.gate;
    console.log(`\n写入门体检：${g.checked} 条事实里，按今天的规则会被挡 ${g.blocked} 条` +
      (g.blocked ? `（${Object.entries(g.byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}）` : ''));
    for (const h of g.hits.slice(0, 15)) {
      console.log(`  [${h.reason}] ${h.reason === 'meta' ? '' : ''}${h.value}（${GATE_REASONS[h.reason] || h.reason}）`);
    }
    if (g.hits.length > 15) console.log(`  … 其余 ${g.hits.length - 15} 条`);
    console.log('  · 只报告不删除：要清的话在工作台作废，或跑 memory-cli invalidate <id>。');
  }
}
