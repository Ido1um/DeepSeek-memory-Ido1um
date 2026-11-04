// 3.0 验收自检：按方案 §13/§14/§15 能自动查的条目逐项跑，只读。
// 用法：node scripts/acceptance-check.mjs [--dir 数据目录] [--json]
//
// 说明：涉及注入/轮转的检查会调用 composePrompt/rotate，这些函数会改运行态，
// 所以脚本先把数据目录复制到临时目录再跑，生产真源只读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] ?? '' : d;
};
const asJson = argv.includes('--json');
const srcDir = path.resolve(arg('dir', process.env.QQ_MEMORY_DIR || path.join(os.homedir(), '.deepseek-memory', 'data')));

const results = [];
const pass = (name, detail = '') => results.push({ name, ok: true, detail });
const fail = (name, detail = '') => results.push({ name, ok: false, detail });
const skip = (name, detail = '') => results.push({ name, ok: null, detail });

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (['backup', 'node_modules'].includes(ent.name)) continue;
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.name === 'logs' && ent.isDirectory()) {
      // 日志只带证据文件：jsonl（≤8MB）与对账日志，bridge.log 太大不带。
      fs.mkdirSync(d, { recursive: true });
      for (const log of fs.readdirSync(s)) {
        const lf = path.join(s, log);
        const st = fs.statSync(lf);
        if (!st.isFile()) continue;
        if (log.endsWith('.jsonl') && st.size <= 8 * 1024 * 1024) fs.copyFileSync(lf, path.join(d, log));
        else if (log === 'window-reconcile.log') fs.copyFileSync(lf, path.join(d, log));
      }
      continue;
    }
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-accept-'));
const dir = path.join(tmpRoot, 'data');
copyDir(srcDir, dir);

// 独立的 config：关掉所有联网步骤，避免自检触发模型调用。
const cfgPath = path.join(tmpRoot, 'config.json');
let prodMemory = {};
try {
  const prodCfg = process.env.QQ_ACCEPT_PROD_CONFIG || '';
  if (fs.existsSync(prodCfg)) prodMemory = JSON.parse(fs.readFileSync(prodCfg, 'utf8')).memory || {};
} catch {
  prodMemory = {};
}
fs.writeFileSync(cfgPath, JSON.stringify({
  ownerQQ: '10001',
  memory: {
    ...prodMemory,
    enabled: true,
    dir,
    summary: { ...(prodMemory.summary || {}), enabled: false },
    extract: { enabled: false },
    episode: { ...(prodMemory.episode || {}), summarize: false },
    entryExtract: { enabled: false }
  }
}));
process.env.QQ_MEMORY_DIR = dir;
process.env.QQ_MEMORY_CONFIG = cfgPath;

const { readTurns, readMeta, readWindowText, formatRecentSlice, isSyntheticPrompt } = await import('../src/window.mjs');
const { readEpisodes } = await import('../src/episode.mjs');
const { layeredRecall, formatLayered } = await import('../src/retrieval.mjs');
const { createMemoryEngine } = await import('../src/engine.mjs');
const { createNullHost } = await import('../src/host.mjs');
const { readTopics } = await import('../src/topics.mjs');
const { readEvents } = await import('../src/longterm.mjs');
const { materialize, readInvalidated } = await import('../src/longterm.mjs');

const KEY = 'private:10001';

/* ---------- 1. 窗口账本 ---------- */
const winRoot = path.join(dir, 'window');
let sids = [];
try {
  sids = fs.readdirSync(winRoot).filter((n) => fs.existsSync(path.join(winRoot, n, 'turns.jsonl')));
} catch {
  sids = [];
}
if (!sids.length) {
  fail('窗口账本存在', '没有任何 window/<session>/turns.jsonl');
} else {
  let bad = [];
  let total = 0;
  for (const sid of sids) {
    const rows = readTurns(dir, sid, { limit: 100000 });
    total += rows.length;
    const nums = rows.map((r) => Number(r.turn)).filter((n) => Number.isFinite(n));
    for (let i = 0; i < nums.length; i += 1) {
      if (nums[i] !== i + 1) {
        bad.push(`${sid.slice(0, 12)} 第 ${i + 1} 行 turn=${nums[i]}`);
        break;
      }
    }
    const meta = readMeta(dir, sid);
    if (Number(meta.nextTurn) !== rows.length + 1) bad.push(`${sid.slice(0, 12)} nextTurn=${meta.nextTurn} 行数=${rows.length}`);
  }
  if (bad.length) fail('窗口轮次连续 / nextTurn 正确', bad.slice(0, 3).join('；'));
  else pass('窗口轮次连续 / nextTurn 正确', `${sids.length} 个会话 / ${total} 轮`);
}

// 逐字还原：最新一轮的 window.textSha1 拼回后字数必须等于 chars
{
  const rows = sids.length ? readTurns(dir, sids[0], { limit: 1 }) : [];
  const r = rows[0];
  if (!r) skip('窗口逐字还原', '没有窗口行');
  else {
    const text = readWindowText(dir, r);
    if (text && text.length === Number(r.window?.chars || 0)) pass('窗口逐字还原', `${text.length} 字`);
    else fail('窗口逐字还原', `拼回 ${text.length} 字 ≠ 记录 ${r.window?.chars} 字`);
  }
}

// 合成提示不落成原话
{
  let leaked = 0;
  let checked = 0;
  for (const sid of sids) {
    for (const r of readTurns(dir, sid, { limit: 5000 })) {
      const t = String(r?.userRaw?.text || '');
      if (!t) continue;
      checked += 1;
      if (t.includes('【当前角色】') || t.startsWith('Current runtime context')) leaked += 1;
    }
  }
  if (!checked) skip('窗口里没有提示词泄漏', '没有用户原话行');
  else if (leaked) fail('窗口里没有提示词泄漏', `${leaked}/${checked} 行像整段 prompt`);
  else pass('窗口里没有提示词泄漏', `${checked} 行原话全部干净`);
}

/* ---------- 2. 情境段 ---------- */
const eps = readEpisodes(dir) || [];
if (!eps.length) fail('情境段存在', 'episodes/ 为空');
else {
  const summarized = eps.filter((e) => e.summarized).length;
  const fused = eps.filter((e) => Array.isArray(e.turns) && e.turns.some((t) => /【当前角色】|【唤醒|Current runtime/.test(String(t.head || '')))).length;
  if (fused) fail('情境段标题/摘要不来自提示词', `${fused} 段含提示词片段`);
  else pass('情境段存在', `${eps.length} 段，已摘要 ${summarized} 段`);
}

/* ---------- 3. 分层检索命中 ---------- */
{
  const hit = layeredRecall(dir, { query: '极速谷6 顶级版', sessionId: sids[0] || '', key: KEY });
  const block = formatLayered(hit, { maxChars: 900 });
  if (!hit.layers.length || !block) fail('分层检索能命中「极速谷6 顶级版」', '没有命中任何层');
  else pass('分层检索能命中「极速谷6 顶级版」', hit.layers.map((l) => `${l.name}:${l.count}`).join(' · ') + ` / ${block.length} 字`);
}

/* ---------- 4. 注入拼装（在副本上跑，会改运行态） ---------- */
{
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  const sid = sids[0] || 'session-accept-0001';
  const composed = engine.composePrompt(KEY, sid, '验收：检查注入结构');
  const text = String(composed.text || '');
  const blocks = composed.blocks || [];
  const issues = [];
  if (!text.includes('【当前对话】\n验收：检查注入结构')) issues.push('缺少【当前对话】或位置不对');
  if (text.length > 3800) issues.push(`总长 ${text.length} 超 3800`);
  if (blocks.length !== new Set(blocks.map((b) => b.k)).size) issues.push('注入块有重复 k');
  if (text.includes('〔语气备忘〕')) issues.push('仍带语气备忘（2.1 的 tone 未退役干净）');
  if (issues.length) fail('注入拼装结构', issues.join('；'));
  else pass('注入拼装结构', `${blocks.length} 块 / ${text.length} 字 / 块 [${blocks.map((b) => b.k).join(',')}]`);
}

/* ---------- 5. 事实卡 ---------- */
{
  const card = fs.existsSync(path.join(dir, 'profile.md')) ? fs.readFileSync(path.join(dir, 'profile.md'), 'utf8') : '';
  if (!card) fail('事实卡存在且成簇', 'profile.md 为空');
  else {
    const roots = [...card.matchAll(/^\s*【([^】]+)】/gm)].map((m) => m[1]).filter((x) => x !== '长期记忆（事实卡）');
    const chars = card.replace(/\s/g, '').length;
    const bad = [];
    if (chars > 1600) bad.push(`卡面 ${chars} 字超过 1600`);
    const expect = ['用户', '助手', '摄影', '极速谷6', '升学', '华光'];
    const missing = expect.filter((t) => !roots.includes(t));
    if (missing.length) bad.push(`缺根主题 ${missing.join('/')}`);
    const open = (card.match(/（/g) || []).length;
    const close = (card.match(/）/g) || []).length;
    if (open !== close) bad.push(`括号不闭合 ${open}/${close}`);
    const tone = fs.existsSync(path.join(dir, 'profile-tone.md'));
    if (tone) bad.push('profile-tone.md 仍在（2.1 tone 未关）');
    if (bad.length) fail('事实卡成簇与预算', bad.join('；'));
    else pass('事实卡成簇与预算', `${chars} 字 / ${roots.length} 个根主题`);
  }
}

/* ---------- 6. 主题挂载 ---------- */
{
  const topics = readTopics(dir);
  const facts = readEvents(dir).rows.filter((r) => r && r.ev === 'fact');
  const map = new Map();
  for (const f of facts) if (f.id && (f.status || 'active') === 'active') map.set(f.id, f);
  let orphan = 0;
  for (const f of map.values()) if (f.topicId && !topics.some((t) => t.id === f.topicId)) orphan += 1;
  if (!topics.length) fail('主题挂载', 'topics.jsonl 为空');
  else if (orphan) fail('主题挂载', `${orphan} 条事实指向不存在的主题`);
  else pass('主题挂载', `${topics.length} 个主题 / ${map.size} 条 active 事实全部可解析`);
}

/* ---------- 7. 轮转闸门（只验证状态判断，不真转） ---------- */
{
  const engine = createMemoryEngine({ host: createNullHost({ ownerKey: KEY }) });
  const st = engine.rotationStatus(KEY);
  const window = Number(st.window?.tokens || 0);
  const pressure = Number(st.real?.maxRecent || 0);
  const threshold = Number(st.threshold || 0);
  if (!window) skip('轮转闸门判据', '拿不到 contextWindow（副本里没有 DSH 压力，且 config 未配 contextWindowTokens）');
  else if (Math.abs(threshold - Math.round(window * 0.7)) > 1000) fail('轮转闸门判据', `阈值 ${threshold} ≠ 0.7×${window}`);
  else pass('轮转闸门判据', `窗口 ${window} / 阈值 ${threshold} / 当前 ${pressure}（${((pressure / window) * 100).toFixed(1)}%）/ due=${st.due} / 来源 ${st.window?.source || '?'}`);
}

/* ---------- 8. 记账与运维 ---------- */
{
  const usage = path.join(dir, 'logs', 'memory-usage.jsonl');
  const tok = path.join(dir, 'logs', 'token-usage.jsonl');
  if (!fs.existsSync(tok)) fail('聊天用量有账本', 'token-usage.jsonl 不存在');
  else pass('聊天用量有账本', 'token-usage.jsonl 存在');
  if (!fs.existsSync(usage)) skip('记忆用量有账本', 'memory-usage.jsonl 还没产生（今晚日终后会有）');
  else {
    const rows = fs.readFileSync(usage, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const callers = [...new Set(rows.map((r) => r.caller))];
    pass('记忆用量有账本', `${rows.length} 行，caller=[${callers.join(',')}]`);
  }
  const rec = path.join(dir, 'logs', 'window-reconcile.log');
  if (!fs.existsSync(rec)) skip('窗口对账无告警', '还没跑过 reconcile');
  else {
    const tail = fs.readFileSync(rec, 'utf8').split('\n').slice(-40).join('\n');
    const bad = /对不上 [1-9]/.test(tail);
    if (bad) fail('窗口对账无告警', '日志里有「对不上 N」');
    else pass('窗口对账无告警', '最近 40 行没有对不上');
  }
}

/* ---------- 9. 时间锚与旧事 ---------- */
{
  const facts = materialize(readEvents(dir).rows, readInvalidated(dir));
  const active = facts.filter((f) => f.status === 'active');
  const missing = active.filter((f) => !f.saidAt && !f.timeUnknown);
  if (missing.length) fail('每条事实都有说于时间', `${missing.length} 条既没有 saidAt 也没标 timeUnknown`);
  else pass('每条事实都有说于时间', `${active.length} 条，其中过期 ${active.filter((f) => f.expired).length} 条`);
﻿  // 生日必须落到结构化字段：slot=birthday 的事实要有 birthday.key 与 kind=birthday 的 dates。
  const bds = active.filter((f) => String(f.slot || '') === 'birthday');
  const badBd = bds.filter((f) => !f.birthday || !f.birthday.key || !(Array.isArray(f.dates) && f.dates.some((d) => d && d.kind === 'birthday')));
  if (!bds.length) skip('生日落日期字段', '库里没有生日事实');
  else if (badBd.length) fail('生日落日期字段', badBd.length + '/' + bds.length + ' 条缺 birthday.key 或 dates[kind=birthday]：' + badBd.map((f) => f.id).join(', '));
  else pass('生日落日期字段', bds.length + ' 条生日都有 ' + bds.map((f) => (f.birthday.y ? f.birthday.y + '-' : '') + f.birthday.key).join(' / '));
  const cardFile = path.join(dir, 'profile.md');
  const card = fs.existsSync(cardFile) ? fs.readFileSync(cardFile, 'utf8') : '';
  if (!active.some((f) => f.expired)) skip('卡片旧事行', '当前没有过期事实');
  else if (/旧事：/.test(card)) pass('卡片旧事行', '过期事实降级成「旧事：」行');
  else fail('卡片旧事行', '有过期事实，但卡里没有「旧事：」');
}

/* ---------- 输出 ---------- */ 
const okCount = results.filter((r) => r.ok === true).length;
const failCount = results.filter((r) => r.ok === false).length;
const skipCount = results.filter((r) => r.ok === null).length;
if (asJson) {
  console.log(JSON.stringify({ dir: srcDir, ok: okCount, fail: failCount, skip: skipCount, results }, null, 2));
} else {
  for (const r of results) {
    const mark = r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP';
    console.log(`${mark}  ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`);
  }
  console.log(`\n${okCount} 通过 / ${failCount} 失败 / ${skipCount} 跳过`);
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failCount ? 1 : 0);
