#!/usr/bin/env node
/**
 * 3.1 P1：真实数据上的问法路由预览（只读）。
 *
 * 用法：
 *   node scripts/route-preview.mjs "我生日是什么时候" "摄影器材有哪些"
 *   node scripts/route-preview.mjs --json "华光考研初试考什么"
 *
 * 输出：route（槽位/主题/主体）+ 前 N 条事实（id/档位/槽位/主题/值）。
 * 不写任何文件，不改数据；用来肉眼验证「她这么问，能不能落到对的那条」。
 */
import { search } from '../src/scoring-runner.mjs';
import { routeQuery } from '../src/route.mjs';
import { dataDir } from '../src/store.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const queries = args.filter((a) => a !== '--json' && a !== '--limit');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 5 : 5;
const list = (limitIdx >= 0 ? queries.filter((q, i) => i !== limitIdx && i !== limitIdx + 1) : queries)
  .filter((q) => q && !/^\d+$/.test(q));

if (!list.length) {
  console.log('用法：node scripts/route-preview.mjs "问法" ["问法2" …] [--json] [--limit 5]');
  process.exit(1);
}

const dir = dataDir();
for (const q of list) {
  const route = routeQuery(q);
  const rows = search({ query: q, dir, limit, match: 'smart' });
  if (json) {
    console.log(JSON.stringify({ query: q, route, rows: rows.map((r) => ({ id: r.id, tier: r.tier, slot: r.slot, topicId: r.topicId, value: r.value, expired: r.expired })) }));
    continue;
  }
  console.log(`\n问法：${q}`);
  console.log(`路由：槽位=[${route.slots.join(',')}] 主题=[${route.topics.join(',')}] 主体=${route.who || '-'} 词=[${route.tokens.slice(0, 6).join(' ')}${route.tokens.length > 6 ? ' …' : ''}]`);
  if (!rows.length) console.log('  （没有命中）');
  rows.forEach((r, i) => {
    const flags = [r.expired ? '过期' : '', r.author === 'self' ? '自写' : ''].filter(Boolean).join(' ');
    console.log(`  ${i + 1}. [${r.tier}] ${r.id} ${r.slot || '-'} / ${r.topicId || '-'}${flags ? ` (${flags})` : ''} → ${String(r.value || r.text || '').slice(0, 70)}`);
  });
}
