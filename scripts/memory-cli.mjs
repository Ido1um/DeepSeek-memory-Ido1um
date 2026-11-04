#!/usr/bin/env node
// 记忆库命令行（§10 步 6 的 CLI 入口；只服务本机手动操作）。
//
//   node scripts/memory-cli.mjs status
//   node scripts/memory-cli.mjs doctor
//   node scripts/memory-cli.mjs health       # 桥接/工作台/开关/日终（端口走 TCP 探测，退出码 0/1）
//   node scripts/memory-cli.mjs recall 生日          # 长期事实检索（四档排序）
//   node scripts/memory-cli.mjs recall --all         # 全量，按档位
//   node scripts/memory-cli.mjs card                 # 预览投影后的事实卡
//   node scripts/memory-cli.mjs invalidate <id|sig> --reason "记错了" [--cascade]
//   node scripts/memory-cli.mjs reinstate <id>
//   node scripts/memory-cli.mjs search 擂饭          # 聊天原文（7 天日志 + 归档）
//
// 约定：只加事件、永不物理删（作废=invalidate 事件 + 审计行）；默认 dry-run 之外的操作都会立刻落盘。

import fs from 'node:fs';
import path from 'node:path';

import * as longterm from '../src/longterm.mjs';
import * as inject from '../src/inject.mjs';
import * as rules from '../src/rules.mjs';
import * as card from '../src/card.mjs';
import * as store from '../src/store.mjs';
import * as inv from '../src/invalidate.mjs';
import { createMemoryEngine } from '../src/engine.mjs';
import { createNullHost } from '../src/host.mjs';
import { loadConfig, memorySection, ownerQQ } from '../src/config.mjs';
import { PROBE_BLOCKED, PROBE_REFUSED, probePort } from '../src/portprobe.mjs';
import { storageReport, summarizeStorage } from '../src/storage.mjs';
import { normalizeScoring, search as searchFacts, explainFact } from '../src/scoring-runner.mjs';
import { describe } from '../src/score.mjs';

const KEY = `private:${ownerQQ()}`;
const TIER = { hard: '硬事实', long: '长期', general: '一般', temp: '临时' };

function parse(argv) {
  const args = [...argv];
  const cmd = args.shift() || 'status';
  const pos = [];
  const flags = {};
  while (args.length) {
    const a = args.shift();
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (args[0] && !args[0].startsWith('--')) flags[k] = args.shift();
      else flags[k] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

function fmtFact(f) {
  const tier = TIER[f.tier] || f.tier;
  const label = f.label && !['profile', 'note'].includes(f.label) ? `${f.label}：` : '';
  const value = String(f.value || f.text || '').replace(/\s+/g, ' ').slice(0, 100);
  const status = !f.status || f.status === 'active' ? '' : ` [${f.status}]`;
  let score = Number(f.score);
  if (!Number.isFinite(score)) {
    try {
      score = describe(f, Date.now(), normalizeScoring(memorySection()?.scoring || {})).score;
    } catch { score = 0; }
  }
  return `· [${tier} ${Math.round(score)}] ${f.id}${status} ${label}${value}`;
}

function audit(row) {
  const p = longterm.paths();
  fs.mkdirSync(path.dirname(p.audit), { recursive: true });
  fs.appendFileSync(p.audit, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolveTarget(target) {
  const facts = longterm.materializeWithShadow();
  const byId = facts.find((f) => String(f.id) === String(target));
  if (byId) return [byId];
  const matched = facts.filter((f) => f.sig === target);
  return matched;
}

function cmdStatus() {
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  const facts = longterm.materializeWithShadow();
  const active = facts.filter((f) => f.status === 'active');
  const tiers = active.reduce((m, f) => ((m[f.tier] = (m[f.tier] || 0) + 1), m), {});
  const status = engine.rotationStatus(KEY, store.getSessionInfo(KEY)?.sessionId || '');
  const pol = engine.policyFor(KEY);
  const cardText = (() => {
    try { return fs.readFileSync(card.cardFile(engine.dataDir()), 'utf8'); } catch { return ''; }
  })();
  console.log(`数据目录   ${engine.dataDir()}`);
  console.log(`记忆开关   ${memorySection()?.enabled === false ? 'off' : 'on'}   打分模式 ${normalizeScoring(memorySection()?.scoring).mode}`);
  console.log(`会话策略   ${pol.state}（${pol.reason || '-'}）`);
  console.log(`长期事实   ${active.length} 条有效 / ${facts.length} 条总（硬 ${tiers.hard || 0} · 长期 ${tiers.long || 0} · 一般 ${tiers.general || 0} · 临时 ${tiers.temp || 0}）`);
  console.log(`事实卡     ${cardText.length} 字（上限 ${card.normalizeCardConfig(memorySection()?.profile).maxChars}）`);
  console.log(`轮转       ${status.due ? '现在就该转' : '还没到'}：真实 token ${status.real?.maxRecent ?? 0} / 阈值 ${status.threshold}（窗口 ${status.window?.tokens}，来源 ${status.window?.source}）`);
  if (status.reason) console.log(`           原因 ${status.reason}`);
}

function cmdRecall({ pos, flags }) {
  const query = flags.all ? '' : pos.join(' ').trim();
  const dir = longterm.paths().root;
  const rows = searchFacts({
    query,
    limit: Number(flags.limit) || 20,
    dir,
    scoring: normalizeScoring(memorySection()?.scoring || {}),
    includeInvalidated: Boolean(flags.invalidated)
  });
  if (!rows.length) {
    console.log(query ? `长期库里没有「${query}」的记录。` : '长期库还是空的。');
    return;
  }
  console.log(`命中 ${rows.length} 条${query ? `（关键词「${query}」）` : '（按档位/分数）'}：`);
  if (flags.explain) {
    const facts = longterm.materialize(longterm.readEvents(dir).rows, longterm.readInvalidated(dir));
    for (const f of rows) {
      const ex = explainFact(f, { query, facts, dir });
      console.log(fmtFact(f));
      console.log(`   激活 ${ex.activation}（${Object.entries(ex.parts).map(([k, v]) => `${k} ${v}`).join(' / ')}）`);
      console.log(`   Q ${ex.q} ${ex.qLevel}「${ex.qLabel}」· D ${ex.detail} · E ${ex.emotion} · C ${ex.consolidation} · 干扰 ${ex.interference}`);
      if (ex.belowFloor) console.log('   （低于 salienceFloor，不进注入）');
      if (ex.fragments.length) console.log(`   片段 ${ex.fragments.join('……')}`);
    }
    return;
  }
  for (const f of rows) console.log(fmtFact(f));
}

function cmdCard() {
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  const built = engine.buildProjectedCard();
  if (!built) {
    console.log('长期库没有事实，投影为空。');
    return;
  }
  console.log(built.text);
  console.log(`\n（${built.chars} 字 / 收录 ${built.included.length} 条 / 挤出 ${built.dropped.length} 条）`);
}

function cmdDoctor() {
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  const r = engine.doctor();
  for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  console.log(`\n${r.ok ? '全部通过' : `有 ${r.failed.length} 项异常：${r.failed.join('、')}`}`);
  if (!r.ok) process.exitCode = 1;
}

function cmdInvalidate({ pos, flags }) {
  const target = pos[0];
  if (!target) throw new Error('用法：invalidate <id|sig> [--reason 记错了] [--cascade]');
  const hits = resolveTarget(target);
  if (!hits.length) throw new Error(`没找到 ${target}（用 recall --all 看 id/sig）`);
  if (hits.length > 1) {
    throw new Error(`「${target}」命中 ${hits.length} 条，请改用 id：\n${hits.map((f) => fmtFact(f)).join('\n')}`);
  }
  const fact = hits[0];
  if (fact.status === 'invalidated') {
    console.log(`${fact.id} 已经是作废状态。`);
    return;
  }
  const r = inv.invalidateFact({
    id: fact.id,
    reason: String(flags.reason || '记错了'),
    by: 'cli',
    cascade: flags.cascade ? 'supersedes' : 'none',
  });
  if (!r.ok) throw new Error(r.reason || '作废失败');
  console.log(`已作废 ${r.ids.join(', ')}：${fact.value || fact.text}`);
  if (r.ids.length > 1) console.log(`  连坐 ${r.ids.length - 1} 条（supersedes 后代）`);
  console.log('（墓碑写 state/facts-invalidated.json，审计写 logs/facts-audit.jsonl；原文保留，reinstate 可撤销）');
}

function cmdReinstate({ pos }) {
  const target = pos[0];
  if (!target) throw new Error('用法：reinstate <id>');
  const hits = resolveTarget(target);
  if (!hits.length) throw new Error(`没找到 ${target}`);
  const fact = hits[0];
  const r = inv.reinstateFact({ id: fact.id, by: 'cli' });
  if (!r.ok) throw new Error(r.reason || '撤销失败');
  console.log(`已恢复 ${fact.id}：${fact.value || fact.text}`);
}

function cmdSearch({ pos, flags }) {
  const query = pos.join(' ').trim();
  const items = store.searchMessages({ key: KEY, query, from: flags.from || '', to: flags.to || '', limit: Number(flags.limit) || 8 });
  if (!items.length) {
    console.log(`没查到${query ? `「${query}」` : ''}的聊天原文。`);
    return;
  }
  for (const it of items) {
    const who = it.role === 'assistant' ? '小助手' : it.sender || '用户';
    console.log(`[${it.date || it.ts}] ${who}：${String(it.text || '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

function cmdDue() {
  const now = Date.now();
  const rows = longterm.materializeWithShadow().filter((f) => f.status === 'active' && f.dueAt);
  if (!rows.length) { console.log('没有带截止日期的事项。'); return; }
  for (const f of rows.sort((a, b) => a.dueAt - b.dueAt)) {
    const days = Math.round(((f.dueAt - now) / 86400000) * 10) / 10;
    const when = days >= 0 ? `剩 ${days} 天` : `已过 ${-days} 天`;
    console.log(`${f.due}  ${when}  ${f.notifiedAt ? '已提醒' : '未提醒'}  ${f.label || f.sig}：${String(f.value || '').slice(0, 60)}`);
  }
}
const { cmd, pos, flags } = parse(process.argv.slice(2));
try {
  switch (cmd) {
    case 'status': cmdStatus(); break;
    case 'recall': cmdRecall({ pos, flags }); break;
    case 'card': cmdCard(); break;
    case 'doctor': cmdDoctor(); break;
    case 'health': {
      // 一条命令看全家：桥接/工作台/记忆开关/日终/到期。退出码 0=健康，1=确实有问题。
      // 端口走纯 TCP 探测（src/portprobe.mjs）：沙箱里 execSync('netstat …') 会 EPERM，
      // 以前据此判 ✗，会把活着的服务误报成宕机。探测被环境拦住时输出 ?（无法判定），不计入失败。
      const cfg = loadConfig();
      const bridgePort = Number(cfg.consolePort) || 3100;
      const wbPort = Number(process.env.WORKBENCH_PORT) || 7351;
      const [bridge, wb] = await Promise.all([probePort(bridgePort), probePort(wbPort)]);
      const portRow = (name, r) => {
        if (r.state === 'open') return [name, true, ''];
        if (r.state === PROBE_REFUSED) return [name, false, '没在监听'];
        return [name, null, `无法判定（${r.code || PROBE_BLOCKED}）`]; // 不计入失败
      };
      const memSt = (() => { try { return JSON.parse(fs.readFileSync(path.join(store.dataDir(), 'state', 'memory.json'), 'utf8')); } catch { return {}; } })();
      const daily = memSt.lastDailyAt ? new Date(memSt.lastDailyAt) : null;
      const hours = daily ? (Date.now() - daily.getTime()) / 3600e3 : 999;
      // 数据体积与磁盘：只读告警（超限不算「坏」，用 ! 提示，不计入退出码）。
      const stg = (() => { try { return storageReport({ dir: store.dataDir(), storage: memorySection()?.storage }); } catch { return null; } })();
      const rows = [
        portRow(`桥接 ${bridgePort}`, bridge),
        portRow(`工作台 ${wbPort}`, wb),
        ['记忆开关', memorySection()?.enabled !== false, ''],
        [`日终新鲜（${hours === 999 ? '从未' : hours.toFixed(1) + ' 小时前'}）`, hours < 26, ''],
        // warn（!）只提示不判失败：体积/磁盘到阈值时该收拾，但服务与记忆本身没坏。
        [`数据体积（${stg ? stg.dataMb + ' MB / 上限 ' + stg.maxDataMb + ' MB；磁盘剩余 ' + (stg.freeGb == null ? '?' : stg.freeGb + ' GB') : '未知'}）`, stg ? (stg.level === 'ok' ? true : 'warn') : null, '']
      ];
      let bad = 0;
      for (const [name, ok, hint] of rows) {
        console.log(`${ok === true ? '✓' : ok === false ? '✗' : ok === 'warn' ? '!' : '?'} ${name}${hint ? `（${hint}）` : ''}`);
        if (ok === false) bad++;
      }
      try { cmdDue(); } catch {}
      process.exitCode = bad ? 1 : 0;
      break;
    }
    case 'invalidate': cmdInvalidate({ pos, flags }); break;
    case 'reinstate': cmdReinstate({ pos }); break;
    case 'manual': {
      const [id, tier, scoreRaw] = pos;
      const score = Number(scoreRaw);
      if (!id || !['hard', 'long', 'general', 'temp'].includes(String(tier)) || !Number.isFinite(score)) {
        console.error('用法：manual <id> <hard|long|general|temp> <1-100>');
        process.exitCode = 1;
        break;
      }
      const ev = { ev: 'manual', id, tier, score: Math.round(score), at: Date.now(), by: 'cli' };
      if (tier !== 'hard') ev.s = { long: 30, general: 3, temp: 1.5 }[tier];
      longterm.appendEvent(ev);
      console.log(`已调整 ${id} → ${TIER[tier] || tier} · ${ev.score} 分（之后按该档衰减，manual-reset 可还原）`);
      break;
    }
    case 'manual-reset': {
      const id = pos[0];
      if (!id) { console.error('用法：manual-reset <id>'); process.exitCode = 1; break; }
      longterm.appendEvent({ ev: 'manualReset', id, at: Date.now(), by: 'cli' });
      console.log(`已还原 ${id} 为自动衰减`);
      break;
    }
    case 'merge': {
      const pos2 = pos || [];
      const into = flags.into || pos2[0];
      const ids = String(flags.ids || pos2.slice(1).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
      if (!into || !ids.length) {
        console.error('用法：merge <保留的id> <并进来的id...> [--value 新值] [--label 标签] [--quote 原文]');
        console.error('  例：merge h-a h-b --value "摄影（Z8X、2875ZA）" --label 爱好');
        process.exitCode = 1;
        break;
      }
      const dir = longterm.paths().root;
      const before = longterm.materialize(longterm.readEvents(dir).rows, longterm.readInvalidated(dir));
      const dst = before.find((f) => f.id === into);
      if (!dst) { console.error(`没有这条事实：${into}`); process.exitCode = 1; break; }
      const missing = ids.filter((x) => !before.some((f) => f.id === x));
      if (missing.length) { console.error(`这些 id 不存在：${missing.join(', ')}`); process.exitCode = 1; break; }
      const at = Date.now();
      if (flags.value || flags.label || flags.quote) {
        const sv = { ev: 'supersede', id: into, at, by: 'cli' };
        if (flags.value) sv.value = flags.value;
        if (flags.label) sv.label = flags.label;
        if (flags.quote) sv.quote = flags.quote;
        longterm.appendEvent(sv);
      }
      longterm.appendEvent({ ev: 'merge', id: into, ids, into, at, by: 'cli', reason: flags.reason || '' });
      const after = longterm.materialize(longterm.readEvents(dir).rows, longterm.readInvalidated(dir));
      console.log(`已合并：${ids.join(', ')} → ${into}（源条目退出卡片与检索，原文与审计保留）`);
      console.log(`  ${fmtFact(after.find((f) => f.id === into))}`);
      break;
    }
    case 'unmerge': {
      const id = pos[0];
      if (!id) {
        console.error('用法：unmerge <被合并掉的id>');
        console.error('  例：unmerge h-20261102-63acd5   # 把它从合并里拆出来，恢复成普通事实');
        process.exitCode = 1;
        break;
      }
      const dir = longterm.paths().root;
      const before = longterm.materialize(longterm.readEvents(dir).rows, longterm.readInvalidated(dir));
      const src = before.find((f) => f.id === id);
      if (!src) { console.error(`没有这条事实：${id}`); process.exitCode = 1; break; }
      if (!src.mergedInto) {
        console.error(`这条没有被合并（status=${src.status}），不用拆。`);
        process.exitCode = 1;
        break;
      }
      const into = src.mergedInto;
      longterm.appendEvent({ ev: 'unmerge', id, at: Date.now(), by: 'cli', reason: flags.reason || '' });
      const after = longterm.materialize(longterm.readEvents(dir).rows, longterm.readInvalidated(dir));
      console.log(`已拆开：${id} 从 ${into} 恢复为普通事实（可再调档/调分）`);
      console.log(`  ${fmtFact(after.find((f) => f.id === id))}`);
      break;
    }
    case 'search': cmdSearch({ pos, flags }); break;
    case 'badhit': {
      const id = pos[0];
      if (!id) { console.error('用法：badhit <id> [--reason 说明]'); process.exitCode = 1; break; }
      const row = { ev: 'badHit', id, at: Date.now(), by: 'cli', reason: flags.reason || '' };
      longterm.appendEvent(row);
      console.log(`已记一次误召回：${id}（累计 2 次后检索降权）`);
      break;
    }
    case 'rules': {
      if (pos[0] === 'init') {
        const r = rules.ensureRules(longterm.paths().root, { force: Boolean(flags.force) });
        console.log(r.created ? `已生成模板：${r.file}` : `已存在：${r.file}（要覆盖加 --force）`);
      } else {
        const txt = rules.readRules(longterm.paths().root);
        console.log(txt || `还没有 rules.md（运行 rules init 生成模板）`);
      }
      break;
    }
    case 'budget': {
      const inj = inject.normalizeInject(memorySection()?.inject || {});
      const facts = longterm.materializeWithShadow();
      // 与线上一致：有主题表时按主题树投影（engine.buildProjectedCard 同款路径）
      const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
      const cardText = engine.buildProjectedCard()?.text || card.buildCard(facts, memorySection()?.profile || {}).text;
      const rulesText = rules.rulesSection(longterm.paths().root, inj.budget.rules).text;
      const now = Date.now();
      const tasks = facts.filter((x) => x.status === 'active' && Number(x.dueAt) > 0 && Number(x.dueAt) + 3 * 86400000 >= now)
        .sort((a, b) => a.dueAt - b.dueAt).slice(0, 5).map((x) => `· ${x.due || ''} ${String(x.value || '').slice(0, 40)}`);
      const built = inject.assemble({ rulesText, cardText, taskLines: tasks, retrievalLines: [] }, inj.budget);
      console.log(`开关：${inj.enabled ? '开' : '关（先影子对比）'}  预算：规则 ${inj.budget.rules} / 卡 ${inj.budget.card} / 待办 ${inj.budget.tasks} / 检索 ${inj.budget.retrieval} = 合计 ${inj.budget.total}`);
      console.log(`实际：${built.total} 字 / 约 ${built.tokens} tokens`);
      for (const sec of built.sections) console.log(`  ${sec.name.padEnd(10)} ${String(sec.chars).padStart(4)} 字${sec.truncated ? `（省略 ${sec.truncated} 行）` : ''}`);
      if (built.overflow > 0) console.log(`  超出总预算 ${built.overflow} 字`);
      break;
    }
    case 'feel': {
      const id = pos[0];
      const text = (pos.slice(1).join(' ') || flags.value || '').trim();
      if (!id || !text) { console.log('用法：node scripts/memory-cli.mjs feel <id> "当时的感觉（≤40 字）"'); process.exitCode = 1; break; }
      const row = longterm.materializeWithShadow().find((x) => x.id === id);
      if (!row) { console.log('没有这条事实：' + id); process.exitCode = 1; break; }
      longterm.appendEvent({ ev: 'feel', id, fact: id, feel: String(text).slice(0, 40), by: flags.by || 'human', derived: false, at: Date.now() }, store.dataDir());
      console.log('已记下：' + id + ' → 「' + String(text).slice(0, 40) + '」');
      break;
    }

    case 'due': cmdDue(); break;

    case 'trace': {
      const id = pos[0];
      if (!id) { console.log('用法：trace <id>'); break; }
      const rows = longterm.readEvents(longterm.paths().root).rows || [];
      let fact = null;
      let src = null;
      for (const r of rows) {
        if (r.ev === 'fact' && r.id === id) fact = r;
        if (r.ev === 'src' && r.id === id) src = r.src;
      }
      if (!fact) { console.log('没有这条事实：' + id); break; }
      const label = fact.label || fact.sig || '';
      const value = String(fact.value || fact.text || '').slice(0, 80);
      console.log(label + '：' + value);
      if (!src) { console.log('└ 来源：未记录（跑 scripts/link-sources.mjs 可回填）'); break; }
      if (src.kind === 'log') console.log('└ 来源：聊天原文 ' + (src.file || '') + (src.day ? '（' + src.day + '）' : ''));
      else if (src.kind === 'card') console.log('└ 来源：事实卡 ' + (src.file || 'profile.md') + (src.backup ? '，对应备份 ' + src.backup : '') + '\n└ 卡片原文：' + (src.quote || ''));
      else console.log('└ 来源：无聊天原文（' + (src.reason || '来自卡片投影') + '）');
      break;
    }
    case 'describe': {
      const f = longterm.materializeWithShadow().find((x) => x.id === pos[0]);
      if (!f) throw new Error(`没找到 ${pos[0]}`);
      console.log(JSON.stringify(describe(f, Date.now(), normalizeScoring(memorySection()?.scoring || {})), null, 2));
      break;
    }
    default:
      console.log('用法：node scripts/memory-cli.mjs <status|doctor|recall|card|due|feel|merge|invalidate|reinstate|search|describe> [参数]');
      console.log('  recall <关键词> [--explain]   检索；--explain 显示 v10 激活值/可信度明细');
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`失败：${error?.message ?? error}`);
  process.exitCode = 1;
}
