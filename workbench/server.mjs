#!/usr/bin/env node
/**
 * 记忆工作台 · 本地只读展示 + 目标配置调控
 * 零依赖，仅监听 127.0.0.1。
 *
 *   node workbench/server.mjs [--port 7351]
 *
 * 数据来源：桥接 config.json 的 memory 段 + 数据目录（profile.md / state/memory.json /
 * logs/token-usage.jsonl）。控制项写入 workbench/config.json（目标配置），
 * 可用「应用到线上」把它合并进桥接 config.json（写前自动备份）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, normalizeConfig as normalizeScoring } from '../src/score.mjs';
import { resolveDataDir, DEFAULT_DATA_DIR } from '../src/paths.mjs';
import * as longterm from '../src/longterm.mjs';
import * as cardMod from '../src/card.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const DESIRED_FILE = path.join(HERE, 'config.json');
// 可选：想看「线上配置」时，把宿主 config.json 的路径塞进 env；没有就只看本地
const BRIDGE_CFG = process.env.WORKBENCH_BRIDGE_CFG || '';
const BRIDGE_LOG = process.env.WORKBENCH_BRIDGE_LOG || '';
const DEFAULT_DATA = DEFAULT_DATA_DIR;
const dataDirOf = (memDir = '') => resolveDataDir({ explicit: memDir });

const PORT_ARG = process.argv.indexOf('--port');
let PORT = PORT_ARG > 0 ? Number(process.argv[PORT_ARG + 1]) : 7351;

const MANAGED = [
  'dir',
  'enabled', 'windowDays', 'dailyAt', 'maxCharsPerMessage', 'handoverMaxChars',
  'rotationThresholdRatio', 'rotationCooldownMs', 'minRotateTokens',
  'contextWindowTokens', 'reinjectOnUpdate', 'maxEntriesPerKey', 'invalidateEnabled',
  'profileMaxChars',
];

const DEFAULT_SCORING = {
  model: 'two-dimensional',
  mode: 'shadow',
  baseDefault: 30, baseFact: 60, mentionBonus: 25, cap: 100,
  halfLifeLong: 30, halfLifeGeneral: 3, halfLifeTemp: 1.5,
  sameDayDecay: 0.5, alpha: 0.9, sMaxDays: 365,
  promoteHits: 3, promoteScore: 55, demoteFloor: 40, tempTtlDays: 7,
  negativePenalty: 0.3, suspectAt: 2,
};
const POLICY_STATES = ['off', 'log', 'full'];

const DEFAULT_DESIRED = {
  dir: DEFAULT_DATA,
  enabled: true,
  autoRotate: true,
  inject: true,
  reinjectOnUpdate: true,
  rotationThresholdRatio: 0.7,
  rotationCooldownMs: 600000,
  minRotateTokens: 20000,
  contextWindowTokens: 0,
  windowDays: 7,
  dailyAt: '23:00',
  maxCharsPerMessage: 8000,
  handoverMaxChars: 3500,
  profileMaxChars: 1500,
  maxEntriesPerKey: 5000,
  invalidateEnabled: true,
  scoring: DEFAULT_SCORING,
  policies: { 'private:10001': 'full' },
};

/* ---------------- helpers ---------------- */

const readJson = (p, fb) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
};
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
};
const tailBytes = (p, bytes) => {
  try {
    const st = fs.statSync(p);
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
};
const sizeOf = (p) => {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    return fs.readdirSync(p, { withFileTypes: true })
      .reduce((s, d) => s + sizeOf(path.join(p, d.name)), 0);
  } catch { return 0; }
};
const listDir = (p) => { try { return fs.readdirSync(p); } catch { return [] }; };
const dedupe = (a) => [...new Set(a)];

/* ---------------- state ---------------- */

function loadBridgeMemory() {
  const cfg = readJson(BRIDGE_CFG, {});
  return { cfg, mem: cfg.memory || {} };
}

/* ---- 数据目录：校验 / 探测 / 控制台地址 ---- */

const normDir = (p) => String(p ?? '').trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '');
const isAbsWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);

function probeDir(input) {
  const dir = normDir(input);
  const out = { dir, valid: isAbsWinPath(dir), exists: false, writable: false, looksLikeMemory: false, sizeMB: 0, entries: {}, error: null };
  if (!dir) { out.error = '路径为空'; return out; }
  if (!out.valid) { out.error = '需要绝对路径，例如 '; return out; }
  try { out.exists = fs.statSync(dir).isDirectory(); }
  catch (e) { if (e.code !== 'ENOENT') out.error = e.message; }
  if (!out.exists) return out;
  const probe = path.join(dir, `.wb-write-test-${process.pid}`);
  try { fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); out.writable = true; }
  catch (e) { out.error = '不可写：' + e.message; }
  for (const name of ['profile.md', 'raw', 'digests', 'state', 'logs']) out.entries[name] = fs.existsSync(path.join(dir, name));
  out.looksLikeMemory = !!(out.entries.raw && out.entries.state);
  try { out.sizeMB = +(sizeOf(dir) / 1048576).toFixed(1); } catch {}
  return out;
}

function checkDir({ dir, create } = {}) {
  const before = probeDir(dir);
  if (create && before.valid && !before.exists) {
    try { fs.mkdirSync(before.dir, { recursive: true }); }
    catch (e) { return { ...before, error: '创建失败：' + e.message }; }
    return { ...probeDir(before.dir), created: true };
  }
  return before;
}

function consoleInfo() {
  const cfg = readJson(BRIDGE_CFG, {});
  const port = Number(cfg.consolePort) || 3100;
  let token = String(cfg.consoleToken || '').trim();
  if (!token) {
    try { token = fs.readFileSync(path.join(path.dirname(BRIDGE_CFG), 'state', 'console-token'), 'utf8').trim(); } catch {}
  }
  return { port, hasToken: !!token, url: `http://127.0.0.1:${port}/${token ? '?token=' + encodeURIComponent(token) : ''}` };
}

function sessionTokens(sid, key) {
  if (!sid && !key) return { latest: 0, max5: 0, rounds: 0, stale: false, tokensSid: '' };
  const dir = dataDirOf(loadBridgeMemory().mem?.dir || '');
  const tail = tailBytes(path.join(dir, 'logs', 'token-usage.jsonl'), 600_000);
  const own = [];
  const byKey = [];        // 同一个 key 的 turn 行（映射失效时兜底）
  let lastKeyRow = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('"k":"turn"')) continue;
    try {
      const r = JSON.parse(line);
      // 只认每次模型调用的 turn 行；base 行是累计总量，会把数字放大百倍
      if (r.k !== 'turn' || !r.b) continue;
      const v = (r.b.cacheMiss || 0) + (r.b.cacheHit || 0);
      if (sid && r.sid === sid) own.push(v);
      if (key && r.key === key) { byKey.push({ sid: r.sid, v }); lastKeyRow = { sid: r.sid, v }; }
    } catch {}
  }
  const last5 = own.slice(-5);
  // 映射会话没有记录（轮转后新会话还没聊过 / 映射指向了不存在的会话）：
  // 退回同一个 key 最近的真实会话，避免大数字显示成 0 让人以为坏了。
  if (!own.length && lastKeyRow && lastKeyRow.sid !== sid) {
    const rows = byKey.filter((x) => x.sid === lastKeyRow.sid).map((x) => x.v);
    const tail5 = rows.slice(-5);
    return {
      latest: lastKeyRow.v, max5: Math.max(...tail5), rounds: 0,
      stale: true, tokensSid: lastKeyRow.sid,
    };
  }
  return {
    latest: own.length ? own[own.length - 1] : 0,
    max5: last5.length ? Math.max(...last5) : 0,
    rounds: own.length, stale: false, tokensSid: sid || '',
  };
}

// 关系图：纯派生。人物 / 主题 / 日期 三类「虚拟节点」把事实串起来，
// 只用于人眼观察（谁是谁、哪些是硬事实、哪条快到期），不参与检索与打分。
const TIER_COLORS = { hard: '#0f7a63', long: '#2f6f9f', general: '#8a6d2f', temp: '#8a8f98' };
function buildGraph(facts, { maxFacts = 240 } = {}) {
  const list = (facts || [])
    .filter((f) => f && f.id)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxFacts);
  const nodes = [];
  const links = [];
  const seen = new Set();
  const add = (n) => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } return n.id; };

  // 只放「真的有事实挂上来」的人物节点，否则图上会出现一个孤零零的点
  const abouts = new Set(list.map((f) => (f.about === 'bot' ? 'bot' : 'user')));
  const persons = { user: '用户', bot: '助手' };
  for (const who of Object.keys(persons)) {
    if (abouts.has(who)) add({ id: `p:${who}`, type: 'person', label: persons[who], size: 30 });
  }

  // 主题：回填事实的 pattern 一律是 profile（没信息量），所以先看正文关键词，
  // 认不出再退回 pattern/class。这里只影响图上怎么归类，不写库、不改档。
  const TOPIC_RULES = [
    ['生日', /生日|寿|蛋糕/],
    ['名字/称呼', /名字|称呼|小名|叫我|自称|助手|昵称/],
    ['住处', /住|湖北|兰州|宿舍|老家|搬/],
    ['学业/工作', /高考|大学|专业|学院|课|实验|论文|考试|报告|工作|上班|实习/],
    ['喜好', /喜欢|爱|讨厌|不吃|爱吃|受不了|怕|习惯|酸奶|鱼|橘子/],
    ['约定/规则', /答应|约定|不许|必须|只能|以后|别再|不能|规矩/],
    ['约定/规则', /照片|婚纱|外传|隐私/],
  ];
  const topicOf = (f) => {
    const text = String(f.value || '');
    for (const [name, re] of TOPIC_RULES) if (re.test(text)) return name;
    const m = String(f.sig || '').match(/^[^:]+:(.+)$/);
    const raw = String(f.label || f.pattern || (m ? m[1] : '') || f.class || '其他');
    if (raw.startsWith('note:')) return '待办/备注';
    const map = { birthday: '生日', name: '名字/称呼', nickname: '名字/称呼', residence: '住处', job: '学业/工作', profile: '其他' };
    return map[raw] || raw;
  };

  for (const f of list) {
    const fid = add({
      id: `f:${f.id}`, type: 'fact', factId: f.id,
      // 回填事实没有 label（pattern 一律 profile），退回正文前 8 个字更可读
      label: (f.label && !/^(profile|note|user|bot|misc)$/.test(f.label)) ? f.label : String(f.value || f.sig || '事实').slice(0, 8),
      value: String(f.value || '').slice(0, 120),
      tier: f.tier || 'general', score: f.score ?? null,
      invalid: Boolean(f.invalidated),
      size: f.tier === 'hard' ? 20 : Math.max(9, Math.min(18, (f.score ?? 40) / 6)),
    });
    const who = f.about === 'bot' ? 'p:bot' : 'p:user';
    links.push({ a: who, b: fid, kind: 'about' });
    const t = topicOf(f);
    const tid = add({ id: `t:${t}`, type: 'topic', label: t, size: 14 });
    links.push({ a: tid, b: fid, kind: 'topic' });
    if (f.due) {
      const did = add({ id: `d:${f.due}`, type: 'date', label: f.due, size: 13 });
      links.push({ a: fid, b: did, kind: 'due' });
    }
  }
  const byType = nodes.reduce((m, n) => ((m[n.type] = (m[n.type] || 0) + 1), m), {});
  return { nodes, links, byType, tiers: TIER_COLORS, truncated: (facts || []).length > list.length };
}

function buildState() {
  const { mem } = loadBridgeMemory();
  const dataDir = dataDirOf(mem && mem.dir ? mem.dir : '');
  const desired = loadDesired();
  const mstate = readJson(path.join(dataDir, 'state', 'memory.json'), {});
  const profilePath = path.join(dataDir, 'profile.md');
  const profile = (() => { try { return fs.readFileSync(profilePath, 'utf8'); } catch { return '' } })();
  // 卡里的条目用「· 」开头（旧版是「- 」），两种都算
  const bullets = profile.split(/\r?\n/).filter((l) => /^[-·]\s/.test(l.trim()));

  const sessions = Object.entries(mstate.sessions || {}).map(([key, s]) => {
    const tok = sessionTokens(s.sessionId, key);
    return {
      key, sessionId: s.sessionId, startedAt: s.startedAt,
      ageHours: +(((Date.now() - (s.startedAt || Date.now())) / 3.6e6).toFixed(1)),
      chars: s.chars || 0, rotations: s.rotations || 0,
      injected: mstate.profileInjectedFor === s.sessionId,
      tokens: tok.max5 || tok.latest, latestTokens: tok.latest, rounds: tok.rounds,
    stale: !!tok.stale, tokensSid: tok.tokensSid || '',
    };
  });

  // 窗口：目标配置 > 线上配置 > 已观测最大 × 1.15 > 兜底 1M
  const observed = Math.max(0, ...sessions.map((s) => s.tokens));
  let windowTokens = 0, source = 'fallback';
  if (desired.contextWindowTokens > 0) { windowTokens = desired.contextWindowTokens; source = 'config'; }
  else if (mem.contextWindowTokens > 0) { windowTokens = mem.contextWindowTokens; source = 'bridge'; }
  else if (observed > 0) { windowTokens = Math.round(observed * 1.15); source = 'observed'; }
  else { windowTokens = 1_000_000; source = 'fallback'; }
  const ratio = Number(desired.rotationThresholdRatio || 0.7);
  const threshold = Math.round(windowTokens * ratio);

  // 事实必须走「事件流折叠」：tier/mention/expire/invalidate/manual 都是事件，
  // 直接读 fact 行会得到没有调档、没有作废的旧快照（之前就是这样：改了档位页面不变）。
  const facts = longterm.materialize(longterm.readEvents(dataDir).rows, longterm.readInvalidated(dataDir));
  const invalidatedMap = readJson(path.join(dataDir, 'state', 'facts-invalidated.json'), {});
  const tierCount = { hard: 0, long: 0, general: 0, temp: 0 };
  for (const f of facts) if (tierCount[f.tier] !== undefined) tierCount[f.tier]++;
  const logTail = tailBytes(BRIDGE_LOG, 300_000);
  const degraded = (logTail.match(/memory-degraded/g) || []).length;
  const summaryFailed = (logTail.match(/summary-generation-failed/g) || []).length;

  const days = listDir(path.join(dataDir, 'raw', 'hot')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const backups = dedupe([
    ...listDir(dataDir).filter((f) => f.includes('.bak')),
    ...listDir(path.join(HERE, 'backup')),
    ...(BRIDGE_CFG ? listDir(path.dirname(BRIDGE_CFG)).filter((f) => f.startsWith('config.json.bak')) : []),
  ]);

  const desiredVsLive = MANAGED.filter((k) => {
    const live = mem[k];
    const want = desired[k];
    if (want === undefined) return false;
    return String(live ?? '') !== String(want);
  });

  const state = {
    now: Date.now(),
    dataDir,
    memoryDir: dataDir,
    defaultMemoryDir: DEFAULT_DATA,
    desiredDir: desired.dir,
    console: consoleInfo(),
    bridge: { cfgPath: BRIDGE_CFG, memory: mem },
    desired,
    diff: desiredVsLive,
    window: { tokens: windowTokens, threshold, ratio, source, observed },
    card: {
      chars: profile.replace(/\s/g, '').length,
      rawChars: profile.length,
      limit: (mem.profile && mem.profile.maxChars) || 1500,
      bullets: bullets.length,
      updatedAt: mstate.profileUpdatedAt || 0,
      injectedFor: mstate.profileInjectedFor || '',
      preview: bullets.slice(-8),
      text: profile,
      hardReserveChars: (mem.profile && mem.profile.hardReserveChars) || 400,
      botMaxChars: (mem.profile && mem.profile.botMaxChars) || 200,
    },
    daily: {
      lastDailyAt: mstate.lastDailyAt || 0,
      lastArchiveAt: mstate.lastArchiveAt || 0,
      at: mem.dailyAt || '23:00',
      days: days.length,
      latestDay: days[days.length - 1] || '',
      handovers: Object.keys(mstate.handovers || {}).length,
    },
    sessions,
    policies: (() => { const out = { ...desired.policies }; for (const s of sessions) if (!out[s.key]) out[s.key] = 'full'; return out; })(),
    scoring: desired.scoring,
    shadow: readShadowState(dataDir),
    write: readWriteState(dataDir),
    policyStates: POLICY_STATES,
    tokens: sessions.map((s) => ({ key: s.key, tokens: s.tokens, latest: s.latestTokens, threshold, pct: threshold ? +(100 * s.tokens / threshold).toFixed(1) : 0 })),
    facts: (() => {
      const scfg = normalizeScoring(desired.scoring || {});
      const now = Date.now();
      return facts.map((f) => {
        let d = {};
        try { d = describe(f, now, scfg); } catch {}
        return { ...f, tier: d.tier || f.tier, score: d.score ?? f.score ?? null, I: d.I ?? f.I, s: d.s ?? f.s, R: d.R ?? f.R, manual: Boolean(f.manual), invalidated: f.invalidated || invalidatedMap[f.id] || null };
      });
    })(),
    tiers: tierCount,
    health: {
      degraded, summaryFailed,
      sizeMB: +(sizeOf(dataDir) / 1048576).toFixed(1),
      backups: backups.length,
      invalidated: Object.keys(invalidatedMap).length,
    },
  };
  // 关系图：只做「给人看的投影」，节点/边都从事实派生，不新增任何真源。
  state.graph = buildGraph(state.facts);
  return state;
}

/* ---------------- write ops ---------------- */

function mergeScoring(patch) {
  const out = { ...DEFAULT_SCORING };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SCORING)) continue;
    if (k === 'mode') { out.mode = ['off', 'shadow', 'write'].includes(v) ? v : 'shadow'; continue; }
    out[k] = k === 'model'
      ? (['ebbinghaus', 'two-dimensional'].includes(v) ? v : 'two-dimensional')
      : (Number.isFinite(Number(v)) ? Number(v) : DEFAULT_SCORING[k]);
  }
  return out;
}

/** 影子采样现状：行数 / 最后一条时间 / 按天统计 / 最近一次结算预览。 */
function readShadowState(dir) {
  const stats = readJson(path.join(dir, 'state', 'scoring-shadow-stats.json'), null);
  const dryrun = readJson(path.join(dir, 'state', 'scoring-dryrun.json'), null);
  let rows = 0;
  let lastAt = 0;
  try {
    const txt = fs.readFileSync(path.join(dir, 'state', 'scoring-shadow.jsonl'), 'utf8').replace(/^\uFEFF/, '');
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      rows++;
      try { lastAt = Math.max(lastAt, Number(JSON.parse(s).at) || 0); } catch { /* 坏行跳过 */ }
    }
  } catch { /* 还没有影子文件 */ }
  const today = new Date().toISOString().slice(0, 10);
  return { rows, lastAt, stats, dryrun, today: (stats && stats.days && stats.days[today]) || null };
}

function readWriteState(dir) {
  const out = { facts: 0, todayAdded: 0, todayMentions: 0, lastAt: 0, last: null, lastTurn: null };
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  try {
    const txt = fs.readFileSync(path.join(dir, 'state', 'longterm.jsonl'), 'utf8').replace(/^\uFEFF/, '');
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let row = null;
      try { row = JSON.parse(s); } catch { continue; }
      const at = Number(row.at) || 0;
      if (row.ev === 'fact') {
        out.facts++;
        if (row.imported) out.imported = (out.imported || 0) + 1;
        else if (at >= dayStart) out.todayAdded++;
        if (at > out.lastAt) {
          out.lastAt = at;
          // 只把「真实写进来的」当最近入库；回填的 27 条不算今天的新增
          if (!row.imported) out.last = { id: row.id, sig: row.sig || '', label: row.label || '', value: row.value || '', tier: row.tier || '', at };
        }
      } else if (row.ev === 'mention' && at >= dayStart) {
        out.todayMentions++;
      }
    }
  } catch { /* 还没有长期库 */ }
  try {
    const lines = fs.readFileSync(path.join(dir, 'logs', 'scoring.log'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    out.lastTurn = JSON.parse(lines[lines.length - 1]);
  } catch { /* 还没有观测日志 */ }
  return out;
}

function mergePolicies(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const key = String(k).trim();
    if (!key) continue;
    out[key] = POLICY_STATES.includes(v) ? v : 'full';
  }
  return out;
}

function loadDesired() {
  const prev = readJson(DESIRED_FILE, {});
  return { ...DEFAULT_DESIRED, ...prev, scoring: mergeScoring(prev.scoring), policies: mergePolicies(prev.policies) };
}

function saveDesired(patch) {
  const cur = loadDesired();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_DESIRED)) continue;
    if (k === 'dir') {
      const d = normDir(v);
      if (!isAbsWinPath(d)) throw Object.assign(new Error('数据目录必须是绝对路径，例如 '), { status: 400 });
      cur.dir = d; continue;
    }
    if (k === 'scoring') { cur.scoring = mergeScoring({ ...cur.scoring, ...(v || {}) }); continue; }
    if (k === 'policies') { cur.policies = mergePolicies(v); continue; }
    cur[k] = typeof DEFAULT_DESIRED[k] === 'boolean' ? Boolean(v)
      : typeof DEFAULT_DESIRED[k] === 'number' ? Number(v) : String(v);
  }
  writeJson(DESIRED_FILE, cur);
  return cur;
}

function applyToBridge() {
  const cfg = readJson(BRIDGE_CFG, null);
  if (!cfg) throw new Error('读不到桥接 config.json');
  const dir = path.join(HERE, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `config.json.bak-${stamp}`), fs.readFileSync(BRIDGE_CFG));
  const desired = loadDesired();
  cfg.memory = cfg.memory || {};
  if (desired.dir !== undefined) {
    const p = probeDir(desired.dir);
    if (!p.valid) throw Object.assign(new Error('数据目录不是绝对路径：' + desired.dir), { status: 400 });
    if (!p.exists) throw Object.assign(new Error('数据目录不存在（先在调控台点「测试」或「创建」）：' + p.dir), { status: 400 });
    if (!p.writable) throw Object.assign(new Error('数据目录不可写：' + p.dir), { status: 400 });
    cfg.memory.dir = p.dir;
  }
  for (const k of MANAGED) if (k !== 'dir' && desired[k] !== undefined) cfg.memory[k] = desired[k];
  cfg.memory.profile = { ...(cfg.memory.profile || {}), maxChars: Math.max(200, Math.round(Number(desired.profileMaxChars) || 1500)) };
  cfg.memory.scoring = desired.scoring;
  cfg.memory.policy = { ...(cfg.memory.policy || {}), keys: desired.policies };
  writeJson(BRIDGE_CFG, cfg);
  return { backup: `backup/config.json.bak-${stamp}`, keys: [...MANAGED, 'profile.maxChars', 'scoring', 'policy.keys'] };
}

/**
 * 事实卡预览：按指定长度重新投影一次（不写文件），用来挑长度。
 * GET /api/card?maxChars=1200
 */
function cardPreview(query) {
  const dataDir = loadBridgeMemory().mem.dir || DEFAULT_DATA;
  const want = Number(query?.maxChars);
  const maxChars = Math.max(200, Math.min(8000, Math.round(want || 1500)));
  const facts = longterm.materialize(longterm.readEvents(dataDir).rows, longterm.readInvalidated(dataDir));
  const built = cardMod.buildCard(facts, { maxChars, hardReserveChars: 400, botMaxChars: 200 });
  return {
    maxChars,
    chars: built.chars,
    included: built.included.length,
    dropped: built.dropped.length,
    droppedIds: built.dropped.slice(0, 30).map((f) => f.id),
    text: built.text,
  };
}

const TIER_HALF_LIFE = { long: 30, general: 3, temp: 1.5 };

function factOp({ id, op, reason, tier, score }) {
  const dataDir = loadBridgeMemory().mem.dir || DEFAULT_DATA;
  if (!id) throw Object.assign(new Error('缺少 id'), { status: 400 });
  const at = new Date().toISOString();
  const audit = (extra) => {
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'logs', 'facts-audit.jsonl'),
      JSON.stringify({ at, op, id, by: 'workbench', reason: reason || '', ...extra }) + '\n', 'utf8');
  };

  // 人工调档 / 调分：写 longterm 事件（不是墓碑），保留历史、可撤销。
  if (op === 'manual' || op === 'reset') {
    if (op === 'manual') {
      const t = String(tier || '');
      if (!['hard', 'long', 'general', 'temp'].includes(t)) throw Object.assign(new Error('档位只能是 hard/long/general/temp'), { status: 400 });
      const n = Number(score);
      if (!Number.isFinite(n) || n < 1 || n > 100) throw Object.assign(new Error('分数要在 1-100 之间'), { status: 400 });
      const ev = { ev: 'manual', id, tier: t, score: Math.round(n), at, by: 'workbench' };
      if (t !== 'hard') ev.s = TIER_HALF_LIFE[t];
      fs.appendFileSync(path.join(dataDir, 'state', 'longterm.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
      audit({ tier: t, score: ev.score });
      return { id, op, at, tier: t, score: ev.score };
    }
    fs.appendFileSync(path.join(dataDir, 'state', 'longterm.jsonl'),
      JSON.stringify({ ev: 'manualReset', id, at, by: 'workbench' }) + '\n', 'utf8');
    audit({});
    return { id, op, at };
  }

  const file = path.join(dataDir, 'state', 'facts-invalidated.json');
  const map = readJson(file, {});
  if (op === 'invalidate') map[id] = { at, by: 'workbench', reason: reason || '' };
  else if (op === 'reinstate') delete map[id];
  else throw new Error('未知 op');
  writeJson(file, map);
  audit({ reason: reason || '' });
  return { id, op, at };
}

/* ---------------- http ---------------- */

const routes = {
  'GET /api/state': () => buildState(),
  'POST /api/config': (body) => ({ desired: saveDesired(body), savedAt: Date.now() }),
  'POST /api/apply': () => applyToBridge(),
  'POST /api/fact': (body) => factOp(body || {}),
  'POST /api/checkdir': (body) => checkDir(body || {}),
  'GET /api/card': (body, query) => cardPreview(query),
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  const buf = Buffer.isBuffer(body) ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(buf);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try { return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8'); }
    catch { return send(res, 500, { error: 'index.html 缺失' }); }
  }
  // /assets/* → public 下的静态文件（只放行前端资源扩展名，防目录穿越）
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const rel = decodeURIComponent(url.pathname.slice('/assets/'.length));
    const full = path.resolve(PUBLIC, rel);
    const okExt = /\.(js|css|svg|png|ico|woff2?)$/i.test(full);
    if (okExt && full.startsWith(path.resolve(PUBLIC) + path.sep) && fs.existsSync(full)) {
      const type = full.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : full.endsWith('.css') ? 'text/css; charset=utf-8'
        : full.endsWith('.svg') ? 'image/svg+xml'
        : full.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      return send(res, 200, fs.readFileSync(full), type);
    }
    return send(res, 404, { error: 'asset not found' });
  }
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: 'not found' });

  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
  req.on('end', () => {
    let body = {};
    if (raw.trim()) { try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'body 不是 JSON' }); } }
    try { send(res, 200, handler(body, Object.fromEntries(url.searchParams))); }
    catch (e) { send(res, e.status || 500, { error: String(e.message || e) }); }
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { PORT += 1; server.listen(PORT, '127.0.0.1'); }
  else { console.error(e); process.exit(1); }
});

server.listen(PORT, '127.0.0.1', () => {
  const s = buildState();
  console.log(`记忆工作台  http://127.0.0.1:${PORT}`);
  console.log(`数据目录    ${s.dataDir}`);
  console.log(`窗口        ${s.window.tokens.toLocaleString()} (${s.window.source})  阈值 ${s.window.threshold.toLocaleString()}`);
  console.log(`会话        ${s.sessions.length} 个；事实 ${s.facts.length} 条；卡 ${s.card.chars}/${s.card.limit} 字`);
});
