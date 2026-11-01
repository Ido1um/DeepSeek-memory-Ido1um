// 影子对比（P2 阶段 B）：同样一批真实消息，比较「旧排序（档位+分数）」与
// 「激活值排序」选出的前 N 条是否一致。只读，不写 retrieved、不改线上配置。
// 用法：node scripts/rank-shadow.mjs [--n 200] [--top 4] [--dir <数据目录>]
import fs from 'node:fs';
import path from 'node:path';

import { memorySection } from '../src/config.mjs';
import { dataDir } from '../src/store.mjs';
import * as v10 from '../src/v10.mjs';
import { normalizeScoring, search } from '../src/scoring-runner.mjs';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) || def : def;
};
const n = argOf('--n', 200);
const top = argOf('--top', 4);
const dirArg = args.indexOf('--dir');
const dir = dirArg >= 0 ? args[dirArg + 1] : dataDir();

const mem = memorySection() || {};
const scoring = normalizeScoring(mem.scoring || {});
const cfg = v10.loadV10(dir);

// 最近 n 条「用户说的话」当查询（和线上真实输入同源）
const hotDir = path.join(dir, 'raw', 'hot');
const days = fs.existsSync(hotDir) ? fs.readdirSync(hotDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
const msgs = [];
for (const day of days.slice().reverse()) {
  const file = path.join(hotDir, day, `private_${mem.ownerQQ || '10001'}.jsonl`);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const row = JSON.parse(line);
      if (row.role === 'user' && row.text) msgs.push(row.text);
    } catch {
      /* 坏行跳过 */
    }
    if (msgs.length >= n) break;
  }
  if (msgs.length >= n) break;
}

console.log(`# 排序影子对比（v10 ${cfg.enabled ? '开' : '关'} · emit ${cfg.emit ? '开' : '关'} · rankInInject ${cfg.rankInInject ? '开' : '关'}）`);
console.log(`数据目录：${dir}`);
console.log(`消息 ${msgs.length} 条 · 每条取前 ${top} 条`);
if (!cfg.enabled) {
  console.log('');
  console.log('v10 未开启：search 不会计算 activation，无法对比。先把 v10.json 的 enabled 设为 true。');
  process.exit(0);
}

let used = 0;
let setChanged = 0;
let orderChanged = 0;
let zeroTok = 0;
let zeroSub = 0;
const examples = [];

for (const q of msgs) {
  let rows = [];
  try {
    rows = search({ query: q, limit: 6, dir, scoring, match: 'tokens' }) || [];
  } catch {
    rows = [];
  }
  rows = rows.filter((r) => r && r.value);
  if (!rows.length) zeroTok += 1;
  // 同时统计旧模式（substring）的命中情况：线上默认就是它，几乎整句都命中不了
  let subRows = [];
  try {
    subRows = search({ query: q, limit: 6, dir, scoring }) || [];
  } catch {
    subRows = [];
  }
  if (!subRows.some((r) => r && r.value)) zeroSub += 1;
  if (rows.length < 2) continue;
  used += 1;

  const base = rows.slice(0, top).map((r) => r.id);
  const act = [...rows]
    .sort((a, b) => (Number(b.activation) || 0) - (Number(a.activation) || 0))
    .slice(0, top)
    .map((r) => r.id);

  const baseSet = new Set(base);
  const actSet = new Set(act);
  const sameSet = base.length === actSet.size && base.every((id) => actSet.has(id));
  if (!sameSet) setChanged += 1;
  else if (base.join('|') !== act.join('|')) orderChanged += 1;

  if (!sameSet && examples.length < 5) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    examples.push({
      q: String(q).slice(0, 26),
      base: base.map((id) => {
        const r = byId.get(id);
        return `[${r.tier}]${String(r.value).slice(0, 14)}(${Number(r.activation || 0).toFixed(0)})`;
      }),
      act: act.map((id) => {
        const r = byId.get(id);
        return `[${r.tier}]${String(r.value).slice(0, 14)}(${Number(r.activation || 0).toFixed(0)})`;
      })
    });
  }
}

const pct = (x) => (used ? ((x / used) * 100).toFixed(1) : '0.0');
const pctAll = (x) => (msgs.length ? ((x / msgs.length) * 100).toFixed(1) : '0.0');
console.log('');
console.log(`| 指标 | 数量 | 占比 |`);
console.log(`|---|---|---|`);
console.log(`| 消息总数 | ${msgs.length} | - |`);
console.log(`| 可对比消息（≥2 条候选） | ${used} | - |`);
console.log(`| 前 ${top} 条集合不同 | ${setChanged} | ${pct(setChanged)}% |`);
console.log(`| 集合相同但顺序不同 | ${orderChanged} | ${pct(orderChanged)}% |`);
console.log(`| 完全一致 | ${used - setChanged - orderChanged} | ${pct(used - setChanged - orderChanged)}% |`);
console.log(`| 零命中（tokens 模式） | ${zeroTok} | ${pctAll(zeroTok)}% |`);
console.log(`| 零命中（substring 模式，线上默认） | ${zeroSub} | ${pctAll(zeroSub)}% |`);
console.log('');

if (examples.length) {
  console.log('## 差异样例');
  for (const e of examples) {
    console.log(`- 「${e.q}」`);
    console.log(`  - 旧：${e.base.join(' · ')}`);
    console.log(`  - 新：${e.act.join(' · ')}`);
  }
  console.log('');
}

const rate = used ? setChanged / used : 0;
console.log('## 建议');
if (rate < 0.15) console.log(`- 差异率 ${pct(setChanged)}% < 15%：可以先开 \`rankInInject:true\` 观察一轮。`);
else if (rate < 0.3) console.log(`- 差异率 ${pct(setChanged)}% 在 15–30%：先人工看上面样例，确认「新的更该被想起」再开。`);
else console.log(`- 差异率 ${pct(setChanged)}% > 30%：先别开关，多半是 base（100·I·R）压过了 topic/sig，需要调权重或先补属性。`);
console.log('- 本脚本只读：不写 retrieved、不改任何配置。');
