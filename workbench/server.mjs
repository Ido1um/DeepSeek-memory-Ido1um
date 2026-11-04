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
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, normalizeConfig as normalizeScoring } from '../src/score.mjs';
import * as longterm from '../src/longterm.mjs';
import * as cardMod from '../src/card.mjs';
import * as v10 from '../src/v10.mjs';
import * as extractModel from '../src/extract-model.mjs';
import * as topicsMod from '../src/topics.mjs';
import { auditPresets } from '../src/preset-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
// 测试/多实例时可用 WORKBENCH_DESIRED 指向临时目标配置，避免写生产 workbench/config.json
const DESIRED_FILE = process.env.WORKBENCH_DESIRED || path.join(HERE, 'config.json');
const BRIDGE_CFG = process.env.WORKBENCH_BRIDGE_CFG || '';
const BRIDGE_LOG = process.env.WORKBENCH_BRIDGE_LOG || '';
const DEFAULT_DATA = path.join(os.homedir(), '.deepseek-memory', 'data');
// 写操作一律要令牌：优先环境变量，其次 workbench/.workbench-token（首次自动生成）；
// 只有同时显式传 --no-token 并设置 WORKBENCH_ALLOW_NO_TOKEN=1 才关闭
// （双重确认，避免误传 --no-token 就让写接口无认证；只用于本地调试，启动日志会警告）。
const TOKEN_FILE = path.join(HERE, '.workbench-token');
const NO_TOKEN = process.argv.includes('--no-token')
  && String(process.env.WORKBENCH_ALLOW_NO_TOKEN || '') === '1';
function loadToken() {
  const env = String(process.env.WORKBENCH_TOKEN || '').trim();
  if (env) return env;
  try {
    const cur = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (cur) return cur;
  } catch {}
  const made = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, made + '\n', { encoding: 'utf8', mode: 0o600 }); } catch (e) {
    console.warn('[工作台] 令牌文件写不了，本次用内存令牌：' + e.message);
  }
  return made;
}
const WORKBENCH_TOKEN = NO_TOKEN ? '' : loadToken();

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

/**
 * 写入门观测（v9.9）：从 logs/scoring.log 末尾取带 blocked 的记录，
 * 汇总今天各原因的条数与最近样例。只读，不写数据目录。
 */
function readBlockedStats(dataDir, limit = 8) {
  const out = { today: 0, total: 0, byReason: {}, lastAt: 0, recent: [] };
  const tail = tailBytes(path.join(dataDir, 'logs', 'scoring.log'), 600_000);
  if (!tail) return out;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const start = dayStart.getTime();
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(row.blocked) || !row.blocked.length) continue;
    const at = Date.parse(row.at) || 0;
    out.total += row.blocked.length;
    out.lastAt = Math.max(out.lastAt, at);
    for (const r of row.blocked) out.byReason[r] = (out.byReason[r] || 0) + 1;
    if (at >= start) out.today += row.blocked.length;
    out.recent.push({ at, reasons: row.blocked, text: String(row.text || '').slice(0, 60) });
  }
  out.recent = out.recent.slice(-limit).reverse();
  return out;
}

/* ---------------- state ---------------- */

function loadBridgeMemory() {
  const cfg = readJson(BRIDGE_CFG, {});
  return { cfg, mem: cfg.memory || {} };
}

/* ---- 数据目录：校验 / 探测 / 控制台地址 ---- */

const normDir = (p) => String(p ?? '').trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '');
const isAbsWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) || path.posix.isAbsolute(String(p));

function probeDir(input) {
  const dir = normDir(input);
  const out = { dir, valid: isAbsWinPath(dir), exists: false, writable: false, looksLikeMemory: false, sizeMB: 0, entries: {}, error: null };
  if (!dir) { out.error = '路径为空'; return out; }
  if (!out.valid) { out.error = '需要绝对路径，例如 ~/.deepseek-memory/data'; return out; }
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
  // 令牌只在 consoleUrl() 里现拼，/api/state 一律不带
  consoleInfo.token = token;
  return { port, hasToken: !!token };
}

function consoleUrl() {
  const info = consoleInfo();
  const token = String(consoleInfo.token || '');
  const path = token ? '/?token=' + encodeURIComponent(token) : '/';
  return { url: 'http://127.0.0.1:' + info.port + path, hasToken: info.hasToken };
}

function sessionTokens(sid, key) {
  if (!sid && !key) return { latest: 0, max5: 0, rounds: 0, stale: false, tokensSid: '' };
  const dir = (loadBridgeMemory().mem.dir || DEFAULT_DATA);
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
    ['名字/称呼', /名字|称呼|小名|叫我|自称|我|昵称/],
    ['住处', /住|示例省份|兰州|宿舍|老家|搬/],
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
  const dataDir = mem.dir || DEFAULT_DATA;
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
  const scfg = normalizeScoring(desired.scoring || {});
  // v10（识海启发）：开关放在数据目录 v10.json，热读；这里只做展示与受控修改。
  let v10cfg = null;
  try { v10cfg = v10.loadV10(dataDir); } catch { /* 配置坏了不影响页面 */ }
  const toneSummary = (() => {
    try { return { text: v10.readToneSummary(dataDir), path: v10.toneSummaryPath(dataDir) }; } catch { return { text: '', path: '' }; }
  })();
  const invalidatedMap = readJson(path.join(dataDir, 'state', 'facts-invalidated.json'), {});
  const tierCount = { hard: 0, long: 0, general: 0, temp: 0 };
  // 只数「还在用」的：作废/合并/过期的仍留在列表里可审计，但不计入档位分布
  for (const f of facts) {
    if ((f.status || 'active') !== 'active') continue;
    if (tierCount[f.tier] !== undefined) tierCount[f.tier]++;
  }
  const logTail = tailBytes(BRIDGE_LOG, 300_000);
  const degraded = (logTail.match(/memory-degraded/g) || []).length;
  const summaryFailed = (logTail.match(/summary-generation-failed/g) || []).length;

  const days = listDir(path.join(dataDir, 'raw', 'hot')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const backups = dedupe([
    ...listDir(dataDir).filter((f) => f.includes('.bak')),
    ...listDir(path.join(HERE, 'backup')),
    ...listDir(BRIDGE_CFG ? path.join(path.dirname(BRIDGE_CFG), 'backup') : '').filter((f) => f.startsWith('config.json.bak')),
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
    card: (() => {
      let dropped = 0;
      let included = 0;
      try {
        const facts = longterm.materialize(longterm.readEvents(dataDir).rows || [], longterm.readInvalidated(dataDir));
        const built = cardMod.buildCard(facts, { ...(mem.profile || {}), maxChars: (mem.profile && mem.profile.maxChars) || 1500 });
        dropped = (built.dropped || []).length;
        included = (built.included || []).length;
      } catch { /* 投影算不出来就不显示，不阻塞页面 */ }
      return {
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
      included,
      dropped,
      };
    })(),
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
      const now = Date.now();
      return facts.map((f) => {
        let d = {};
        try { d = describe(f, now, scfg); } catch {}
        // v10 指标：只读派生，不落库、不改分（D 细节 / E 情绪 / C 巩固 / Q 可信 / A 激活）
        let v10row = null;
        if (v10cfg && v10cfg.enabled) {
          try {
            const act = v10.activationOf(f, { query: '', facts, now, cfg: v10cfg });
            const q = v10.qValueOf(f, { facts });
            v10row = {
              d: +v10.detailOf(f, v10cfg, now, facts).toFixed(3),
              e: +v10.emotionOf(f, v10cfg, now).toFixed(3),
              c: +v10.consolidationOf(f).toFixed(3),
              a: +act.A.toFixed(1),
              q: +q.toFixed(3),
              qLevel: v10.qLevelOf(q, v10cfg),
              qLabel: v10.qLabelOf(v10.qLevelOf(q, v10cfg), v10cfg),
              frags: (f.fragments || []).length,
            };
          } catch { /* 单条算不出来不影响整页 */ }
        }
        return { ...f, tier: d.tier || f.tier, score: d.score ?? f.score ?? null, I: d.I ?? f.I, s: d.s ?? f.s, R: d.R ?? f.R, manual: Boolean(f.manual), invalidated: f.invalidated || invalidatedMap[f.id] || null, v10: v10row };
      });
    })(),
    v10: v10cfg ? { cfg: v10cfg, tone: toneSummary } : null,
    writeGate: { enabled: scfg.writeGate !== false, ...readBlockedStats(dataDir) },
    extract: (() => {
      try {
        return {
          cfg: extractModel.normalizeExtract((desired && desired.extract) || {}),
          shadow: extractModel.summarizeShadow(dataDir, { now: Date.now(), days: 7, recent: 12 }),
        };
      } catch (e) { return { cfg: null, shadow: null, error: String((e && e.message) || e) }; }
    })(),
    folds: foldsView(),
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

const V10_EDITABLE = ['enabled', 'emit', 'rankInInject', 'recordRetrieved', 'toneResidue', 'toneSummary', 'matchTokens', 'salienceFloor'];

/**
 * 保存 v10 开关（数据目录 v10.json）：白名单字段、写前备份、原子替换。
 * 引擎按 mtime 热读，不用重启桥接；写坏配置的风险由「只写 normalize 后的结果」兜住。
 */
function saveV10(body = {}) {
  const { mem } = loadBridgeMemory();
  const dataDir = mem.dir || DEFAULT_DATA;
  const file = path.join(dataDir, 'v10.json');
  const cur = readJson(file, {}) || {};
  const next = { ...cur };
  for (const k of V10_EDITABLE) {
    if (!(k in body)) continue;
    if (k === 'salienceFloor') {
      const n = Number(body[k]);
      next[k] = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    } else {
      next[k] = Boolean(body[k]);
    }
  }
  const normalized = v10.normalizeV10(next);
  const bakDir = path.join(dataDir, 'backup');
  fs.mkdirSync(bakDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(bakDir, `v10.json.bak-${stamp}`));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { savedAt: Date.now(), cfg: normalized };
}

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
    // 拼错的键直接拒绝：静默忽略会让人以为改成功了
    if (!(k in DEFAULT_DESIRED)) throw Object.assign(new Error('未知配置项：' + k), { status: 400 });
    if (k === 'dir') {
      const d = normDir(v);
  if (!isAbsWinPath(d)) throw Object.assign(new Error('数据目录必须是绝对路径，例如 ~/.deepseek-memory/data'), { status: 400 });
      let stat = null;
      try { stat = fs.statSync(d); } catch {}
      if (!stat || !stat.isDirectory()) throw Object.assign(new Error('数据目录不存在：' + d + '（先点「创建目录」）'), { status: 400 });
      cur.dir = d; continue;
    }
    if (k === 'scoring') { cur.scoring = mergeScoring({ ...cur.scoring, ...(v || {}) }); continue; }
    if (k === 'policies') { cur.policies = mergePolicies(v); continue; }
    if (typeof DEFAULT_DESIRED[k] === 'boolean') {
      if (typeof v !== 'boolean') throw Object.assign(new Error(k + ' 只接受 true/false'), { status: 400 });
      cur[k] = v; continue;
    }
    if (typeof DEFAULT_DESIRED[k] === 'number') {
      const num = Number(v);
      if (!Number.isFinite(num)) throw Object.assign(new Error(k + ' 必须是数字'), { status: 400 });
      if (num < 0) throw Object.assign(new Error(k + ' 不能为负'), { status: 400 });
      cur[k] = num; continue;
    }
    cur[k] = String(v);
  }
  writeJson(DESIRED_FILE, cur);
  return cur;
}

// 记忆目录体检：空目录可以，已有 profile.md/state/ 也可以；明显不是（比如 D:\ 根、系统目录）就拒
function assertMemoryDir(dir, { force = false } = {}) {
  if (!isAbsWinPath(dir)) throw Object.assign(new Error('数据目录必须是绝对路径'), { status: 400 });
  let st = null;
  try { st = fs.statSync(dir); } catch {}
  if (!st || !st.isDirectory()) throw Object.assign(new Error('数据目录不存在：' + dir), { status: 400 });
  if (force) return;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (e) { throw Object.assign(new Error('目录读不了：' + e.message), { status: 400 }); }
  if (path.dirname(dir) === dir) throw Object.assign(new Error('不能把磁盘根目录当记忆目录'), { status: 400 });
  const looks = entries.includes('profile.md') || entries.includes('state') || entries.includes('rules.md') || entries.includes('raw');
  const empty = entries.length === 0;
  if (!looks && !empty) {
    throw Object.assign(new Error('这个目录不像记忆目录（缺 profile.md / state/，且不为空）。确认后可用 force:true 强制应用'), { status: 400 });
  }
}

function applyToBridge(body = {}) {
  const cfg = readJson(BRIDGE_CFG, null);
  if (!cfg) throw new Error('读不到桥接 config.json');
  const desired = loadDesired();
  assertMemoryDir(desired.dir || (cfg.memory && cfg.memory.dir) || DEFAULT_DATA, { force: body.force === true });
  const dir = path.join(path.dirname(BRIDGE_CFG), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `config.json.bak-${stamp}`), fs.readFileSync(BRIDGE_CFG));
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

const FACT_OPS = ['invalidate', 'reinstate', 'manual', 'reset', 'badhit', 'unmerge', 'feel'];

function factOp({ id, op, reason, tier, score, feel }) {
  const dataDir = loadBridgeMemory().mem.dir || DEFAULT_DATA;
  if (!id) throw Object.assign(new Error('缺少 id'), { status: 400 });
  if (!FACT_OPS.includes(op)) throw Object.assign(new Error('op 只能是 ' + FACT_OPS.join('/')), { status: 400 });
  // 不存在的 id 不写墓碑/审计：否则库里会积攒指向空气的墓碑
  {
    const known = longterm.materialize(longterm.readEvents(dataDir).rows, longterm.readInvalidated(dataDir));
    if (!known.some((f) => f.id === id)) throw Object.assign(new Error('没有这条事实：' + id), { status: 404 });
  }
  // longterm 事件里的 at 必须是数字 epoch：引擎写的是毫秒数，混进 ISO 字符串会让
  // Number(at) 变 NaN，materialize 每次把 lastAt 重置成「现在」→ 被人工调过的事实永不衰减。
  const now = Date.now();
  const at = now;
  const auditAt = new Date(now).toISOString();
  const audit = (extra) => {
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'logs', 'facts-audit.jsonl'),
      JSON.stringify({ at: auditAt, op, id, by: 'workbench', reason: reason || '', ...extra }) + '\n', 'utf8');
  };

  // 体感印记：给某条事实记一行「当时的感受」（≤40 字，只追加）。
  if (op === 'feel') {
    const feelText = String(feel || '').trim().slice(0, 40);
    if (!feelText) throw Object.assign(new Error('feel 不能为空'), { status: 400 });
    fs.appendFileSync(path.join(dataDir, 'state', 'longterm.jsonl'),
      JSON.stringify({ ev: 'feel', id, fact: id, feel: feelText, by: 'workbench', derived: false, at }) + '\n', 'utf8');
    audit({ feel: feelText });
    return { id, op, at, feel: feelText };
  }

  // 拆开合并：把被并进别人的条目恢复成普通事实（可再调档/调分），只追加事件。
  if (op === 'unmerge') {
    const before = longterm.materialize(longterm.readEvents(dataDir).rows, longterm.readInvalidated(dataDir));
    const src = before.find((f) => f.id === id);
    if (!src.mergedInto) throw Object.assign(new Error('这条没有被合并（status=' + src.status + '）'), { status: 400 });
    const from = src.mergedInto;
    fs.appendFileSync(path.join(dataDir, 'state', 'longterm.jsonl'),
      JSON.stringify({ ev: 'unmerge', id, at, by: 'workbench', reason: reason || '' }) + '\n', 'utf8');
    audit({ from });
    return { id, op, at, from };
  }

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


/* ---------------- 3.0 视图：窗口 / 情境 / 主题 / 账单 ---------------- */

const PRICE_URL = process.env.WORKBENCH_PRICE_MODULE || '';
let priceMod = null;
if (PRICE_URL) { try { priceMod = await import(PRICE_URL); } catch (e) { console.warn('[工作台] 价格表不可用：' + e.message); } }

function wbDataDir() {
  try { const { mem } = loadBridgeMemory(); return mem.dir || DEFAULT_DATA; } catch { return DEFAULT_DATA; }
}
function readJsonl(p, limit) {
  let lines = [];
  try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行容错 */ }
  }
  return limit > 0 ? out.slice(-limit) : out;
}
function listNames(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

function tsMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Date.parse(String(v || ''));
  return Number.isFinite(n) ? n : 0;
}

function windowView(query = {}) {
  const root = path.join(wbDataDir(), 'window');
  const sessions = [];
  for (const name of listNames(root)) {
    if (!/^session-/.test(name)) continue;
    const rows = readJsonl(path.join(root, name, 'turns.jsonl'));
    const meta = readJson(path.join(root, name, 'meta.json'), {});
    let last = 0;
    for (const r of rows) last = Math.max(last, tsMs(r.at));
    sessions.push({
      sessionId: name, key: meta.key || '', turns: rows.length,
      nextTurn: meta.nextTurn || rows.length + 1,
      chars: rows.reduce((n, r) => n + (Number(r && r.window && r.window.chars) || 0), 0),
      lastAt: last,
    });
  }
  sessions.sort((a, b) => b.lastAt - a.lastAt || b.turns - a.turns);
  const mstate = readJson(path.join(wbDataDir(), 'state', 'memory.json'), {});
  const active = String((mstate.sessions && mstate.sessions['private:10001'] && mstate.sessions['private:10001'].sessionId) || '');
  for (const s of sessions) s.active = s.sessionId === active;
  const sid = String(query.session || active || (sessions[0] && sessions[0].sessionId) || '');
  const rows = sid ? readJsonl(path.join(root, sid, 'turns.jsonl')) : [];
  const from = Number(query.from) || 0;
  const to = Number(query.to) || 0;
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 40));
  const items = [];
  for (const r of rows) {
    const t = Number(r.turn) || 0;
    if (from && t < from) continue;
    if (to && t > to) continue;
    items.push({
      turn: t, at: r.at, reason: r.reason || '', incomplete: !!r.incomplete,
      synthetic: !!(r.userRaw && r.userRaw.synthetic),
      user: String((r.userRaw && r.userRaw.text) || ''),
      spoken: Array.isArray(r.spoken) ? r.spoken.map((s) => String((s && s.text) || '')).filter(Boolean) : [],
      reply: String((r.reply && r.reply.text) || ''),
      feels: Array.isArray(r.feels) ? r.feels.map((f) => String((f && f.text) || '')) : [],
      chars: Number(r.window && r.window.chars) || 0,
      blocks: Array.isArray(r.window && r.window.blocks) ? r.window.blocks.map((b) => ({ k: b.k, chars: b.chars })) : [],
    });
  }
  items.reverse();
  return { sessions, sessionId: sid, from, to, total: rows.length, items: items.slice(0, limit) };
}

function episodesView(query = {}) {
  const dir = path.join(wbDataDir(), 'episodes');
  const byId = new Map();
  for (const f of listNames(dir)) {
    if (!/\.jsonl$/.test(f)) continue;
    for (const ep of readJsonl(path.join(dir, f))) if (ep && ep.id) byId.set(ep.id, ep);
  }
  const days = Math.max(1, Math.min(365, Number(query.days) || 14));
  const since = Date.now() - days * 86400000;
  const items = [...byId.values()]
    .filter((ep) => (Date.parse(ep.atTo) || 0) >= since)
    .sort((a, b) => (Date.parse(b.atFrom) || 0) - (Date.parse(a.atFrom) || 0))
    .slice(0, 80)
    .map((ep) => ({
      id: ep.id, day: ep.day, title: ep.title || '', scene: ep.scene || '',
      topics: ep.topics || [], thoughts: (ep.thoughts || []).length,
      feelings: (ep.feelings || []).length, turnFrom: ep.turnFrom, turnTo: ep.turnTo,
      atFrom: ep.atFrom, atTo: ep.atTo, fidelity: ep.fidelity || '',
      summarized: !!ep.summarized, sessionId: ep.sessionId || '',
    }));
  return { days, count: items.length, items };
}

function topicsView() {
  const dir = wbDataDir();
  const topics = readJsonl(path.join(dir, 'state', 'topics.jsonl'));
  const facts = longterm.materialize(longterm.readEvents(dir).rows, longterm.readInvalidated(dir));
  const byTopic = new Map();
  for (const t of topics) if (t && t.id) byTopic.set(t.id, { ...t, count: 0, slots: {} });
  let orphan = 0;
  for (const f of facts) {
    if ((f.status || 'active') !== 'active') continue;
    const t = byTopic.get(f.topicId);
    if (!t) { orphan++; continue; }
    t.count++;
    const slot = f.slot || 'other';
    if (!t.slots[slot]) t.slots[slot] = [];
    t.slots[slot].push({ id: f.id, value: f.value || f.text || '', tier: f.tier });
  }
  const order = ['t-identity', 't-study', 't-photo', 't-horizon6', 't-hust', 't-baoyan', 't-plan', 't-bot', 't-food', 't-routine', 't-life'];
  const list = [...byTopic.values()].sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.count - a.count;
  }).map((t) => ({
    id: t.id, name: t.name || t.id, parentId: t.parentId || '', count: t.count,
    slots: Object.entries(t.slots).map(([slot, arr]) => ({ slot, label: (topicsMod.SLOT_LABEL && topicsMod.SLOT_LABEL[slot]) || slot, values: arr.slice(0, 4).map((x) => x.value), more: Math.max(0, arr.length - 4) })),
  }));
  return { count: list.length, orphan, items: list };
}

function usageView(query = {}) {
  const dir = wbDataDir();
  const days = Math.max(1, Math.min(90, Number(query.days) || 14));
  const scope = String(query.scope || 'private:10001');
  const sessionPick = String(query.session || 'all');
  const turnPick = String(query.turn || 'all');
  const since = Date.now() - days * 86400000;
  const raw = readJsonl(path.join(dir, 'logs', 'token-usage.jsonl'), 40000);
  const dayKey = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const costOf = (r, b) => {
    if (!priceMod || !priceMod.priceUsage) return 0;
    try {
      const p = priceMod.priceUsage(b, { model: r.model, at: Number(r.t) || 0 });
      return (p.cost && p.cost.total) || 0;
    } catch { return 0; }
  };
  // 轮次类型：把窗口账本里的 synthetic/无原话轮标成「唤醒/派生」，有用户原话的标「用户触发」。
  const ledger = new Map();
  for (const name of listNames(path.join(dir, 'window'))) {
    if (!/^session-/.test(name)) continue;
    const m = new Map();
    for (const row of readJsonl(path.join(dir, 'window', name, 'turns.jsonl'))) {
      m.set(Number(row.turn), !!(row.userRaw && String(row.userRaw.text || '').trim()));
    }
    ledger.set(name, m);
  }
  const kindOf = (r) => {
    if (r.turn == null) return 'setup';
    const m = ledger.get(String(r.sid || ''));
    if (!m || !m.has(Number(r.turn))) return 'unknown';
    return m.get(Number(r.turn)) ? 'owner' : 'wake';
  };
  const inScope = (r) => scope === 'all' || String(r.key || '(none)') === scope;
  const scopes = new Map();
  const sessionAgg = new Map();
  const byKind = new Map();
  const totals = { calls: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, cost: 0 };
  let baselineRows = 0;
  const byDay = new Map();
  const byModel = new Map();
  for (const r of raw) {
    const b0 = r && r.b; if (!b0) continue;
    // k=base 是会话基线快照（累计值），不是消费；只统计 k=turn 的逐轮采样。
    if (String(r.k || '') !== 'turn') { baselineRows++; continue; }
    const hit = Number(b0.cacheHit) || 0, miss = Number(b0.cacheMiss) || 0;
    const write = Number(b0.cacheWrite) || 0, out = Number(b0.output) || 0;
    const at = Number(r.t) || 0;
    if (at < since) continue;
    const cost = costOf(r, { cacheHit: hit, cacheMiss: miss, cacheWrite: write, output: out });
    const tokens = hit + miss + write + out;
    const key = String(r.key || '(none)');
    const sid = String(r.sid || '(none)');
    const kind = kindOf(r);
    const sc = scopes.get(key) || { key, calls: 0, tokens: 0, cost: 0 };
    if (!inScope(r)) { sc.calls++; sc.tokens += tokens; sc.cost += cost; scopes.set(key, sc); continue; }
    sc.calls++; sc.tokens += tokens; sc.cost += cost; scopes.set(key, sc);

    const kk = byKind.get(kind) || { kind, calls: 0, tokens: 0, cost: 0 };
    kk.calls++; kk.tokens += tokens; kk.cost += cost; byKind.set(kind, kk);

    const ss = sessionAgg.get(sid) || { sessionId: sid, calls: 0, tokens: 0, cost: 0, ownerCost: 0, wakeCost: 0, unknownCost: 0 };
    ss.calls++; ss.tokens += tokens; ss.cost += cost;
    if (kind === 'owner') ss.ownerCost += cost;
    else if (kind === 'wake') ss.wakeCost += cost;
    else if (kind === 'unknown') ss.unknownCost += cost;
    sessionAgg.set(sid, ss);

    if (sessionPick !== 'all' && sid !== sessionPick) continue;
    if (turnPick !== 'all' && kind !== turnPick) continue;
    const day = dayKey(at);
    const d = byDay.get(day) || { day, calls: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, cost: 0 };
    d.calls++; d.cacheHit += hit; d.cacheMiss += miss; d.cacheWrite += write; d.output += out; d.cost += cost;
    byDay.set(day, d);
    const model = String(r.model || 'unknown');
    const m = byModel.get(model) || { model, calls: 0, tokens: 0, cost: 0 };
    m.calls++; m.tokens += tokens; m.cost += cost;
    byModel.set(model, m);
    totals.calls++; totals.cacheHit += hit; totals.cacheMiss += miss; totals.cacheWrite += write; totals.output += out; totals.cost += cost;
  }
  // 记忆侧模型用量：logs/memory-usage.jsonl（caller = handover/profile/extract/episode/entry）
  const memRaw = readJsonl(path.join(dir, 'logs', 'memory-usage.jsonl'), 20000);
  const memByCaller = new Map();
  const memTotals = { calls: 0, fail: 0, input: 0, cacheHit: 0, output: 0, cost: 0 };
  for (const r of memRaw) {
    const at = Number(r.t) || 0;
    if (at < since) continue;
    const u = r.usage || {};
    const hit = Number(u.cache_read_input_tokens) || 0;
    const miss = Number(u.input_tokens) || 0;
    const write = Number(u.cache_creation_input_tokens) || 0;
    const out = Number(u.output_tokens) || 0;
    const cost = costOf({ model: r.model, t: at }, { cacheHit: hit, cacheMiss: miss, cacheWrite: write, output: out });
    const caller = String(r.caller || 'model');
    const row = memByCaller.get(caller) || { caller, calls: 0, fail: 0, input: 0, cacheHit: 0, output: 0, cost: 0 };
    row.calls += 1;
    if (r.ok === false) row.fail += 1;
    row.input += miss;
    row.cacheHit += hit;
    row.output += out;
    row.cost += cost;
    memByCaller.set(caller, row);
    memTotals.calls += 1;
    if (r.ok === false) memTotals.fail += 1;
    memTotals.input += miss;
    memTotals.cacheHit += hit;
    memTotals.output += out;
    memTotals.cost += cost;
  }

  const totalIn = totals.cacheHit + totals.cacheMiss + totals.cacheWrite;
  totals.tokens = totalIn + totals.output;
  totals.hitRate = totalIn ? totals.cacheHit / totalIn : 0;
  return {
    days, scope, session: sessionPick, turn: turnPick,
    totals,
    baselineRows,
    scopes: [...scopes.values()].sort((a, b) => b.cost - a.cost),
    bySession: [...sessionAgg.values()].sort((a, b) => b.cost - a.cost),
    byKind: [...byKind.values()].sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    memory: {
      totals: memTotals,
      byCaller: [...memByCaller.values()].sort((a, b) => b.cost - a.cost)
    },
    priceVersion: priceMod ? priceMod.PRICE_TABLE_VERSION : '',
  };
}


/* ---------------- 折叠检测（记忆 3.0 §17） ---------------- */

function foldsView() {
  const dir = wbDataDir();
  const mstate = readJson(path.join(dir, 'state', 'memory.json'), {});
  const presets = auditPresets();
  const sessions = [];
  for (const [key, rec] of Object.entries(mstate.sessions || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const sid = String(rec.sessionId || '');
    const rows = sid ? readJsonl(path.join(dir, 'window', sid, 'turns.jsonl')) : [];
    const imported = rows.filter((r) => r && r.fidelity === 'session-log').length;
    sessions.push({
      key, sessionId: sid,
      folded: Boolean(rec.folded), foldedAt: rec.foldedAt || 0, foldedReason: String(rec.foldedReason || ''),
      turns: rows.length, imported,
      lastAt: rows.length ? Math.max(0, ...rows.map((r) => tsMs(r.at))) : 0,
    });
  }
  sessions.sort((a, b) => (b.foldedAt || b.lastAt) - (a.foldedAt || a.lastAt));
  return {
    ok: presets.ok,
    presets,
    folded: sessions.filter((s) => s.folded),
    sessions,
    guard: { logFile: path.join(dir, 'logs', 'fold-guard.log'), exists: fs.existsSync(path.join(dir, 'logs', 'fold-guard.log')) },
  };
}

/* ---------------- 记忆数据导出 ---------------- */

function exportView(query = {}) {
  const dir = wbDataDir();
  const withWindow = String(query.window || '') === '1';
  const facts = longterm.materialize(longterm.readEvents(dir).rows, longterm.readInvalidated(dir));
  const profile = (() => { try { return fs.readFileSync(path.join(dir, 'profile.md'), 'utf8'); } catch { return '' } })();
  const topics = readJsonl(path.join(dir, 'state', 'topics.jsonl'));
  const episodes = [];
  for (const name of listNames(path.join(dir, 'episodes'))) {
    if (!/\.jsonl$/.test(name)) continue;
    for (const ep of readJsonl(path.join(dir, 'episodes', name))) if (ep && ep.id) episodes.push(ep);
  }
  episodes.sort((a, b) => String(a.atFrom || '').localeCompare(String(b.atFrom || '')));
  const sessions = [];
  if (withWindow) {
    for (const name of listNames(path.join(dir, 'window'))) {
      if (!/^session-/.test(name)) continue;
      const rows = readJsonl(path.join(dir, 'window', name, 'turns.jsonl'));
      sessions.push({ sessionId: name, meta: readJson(path.join(dir, 'window', name, 'meta.json'), {}), turns: rows });
    }
  }
  const bundle = {
    format: 'deepseek-memory-export/1',
    exportedAt: new Date().toISOString(),
    dataDir: dir,
    profile,
    facts,
    topics,
    episodes,
    counts: { facts: facts.length, topics: topics.length, episodes: episodes.length, windowSessions: sessions.length },
  };
  if (withWindow) bundle.window = sessions;
  return bundle;
}

const routes = {
  'GET /api/state': () => buildState(),
  'POST /api/config': (body) => ({ desired: saveDesired(body), savedAt: Date.now() }),
  'POST /api/apply': (body) => applyToBridge(body || {}),
  'POST /api/console-url': () => consoleUrl(),
  'POST /api/fact': (body) => factOp(body || {}),
  'POST /api/v10': (body) => saveV10(body || {}),
  'POST /api/checkdir': (body) => checkDir(body || {}),
  'GET /api/card': (body, query) => cardPreview(query),
  'GET /api/window': (body, query) => windowView(query),
  'GET /api/episodes': (body, query) => episodesView(query),
  'GET /api/topics': () => topicsView(),
  'GET /api/usage': (body, query) => usageView(query),
  'GET /api/folds': () => foldsView(),
  'GET /api/export': (body, query) => exportView(query),
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  const buf = Buffer.isBuffer(body) ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(buf);
};

const server = http.createServer((req, res) => {  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
        .replace('</head>', '<script>window.__WB_TOKEN__ = ' + JSON.stringify(WORKBENCH_TOKEN) + ';</script></head>');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
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

  // 写操作校验：设了 WORKBENCH_TOKEN 就必须带 x-workbench-token；
  // 没设则只监听 127.0.0.1（本来就是这样），启动日志里会给一句警告。
  // 浏览器跨站 + DNS rebinding 兜底
  if (req.method !== 'GET') {
    // Host 必须是本机：否则改个 hosts 把 evil.com 指到 127.0.0.1 就能伪装同源
    const host = String(req.headers.host || '').toLowerCase();
    const hostOk = host === '127.0.0.1:' + PORT || host === 'localhost:' + PORT || host === '[::1]:' + PORT;
    if (!hostOk) return send(res, 403, { error: 'Host 不被接受（只允许本机回环地址）' });
    const origin = String(req.headers.origin || '');
    const site = String(req.headers['sec-fetch-site'] || '');
    const allowed = origin === '' || origin === 'http://127.0.0.1:' + PORT || origin === 'http://localhost:' + PORT;
    if (!allowed || site === 'cross-site') return send(res, 403, { error: '跨站写请求被拒绝' });
    // 只收 JSON：杜绝表单类 CSRF（那类不带预检）
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.includes('application/json')) return send(res, 415, { error: '写请求必须是 application/json' });
  }
  if (req.method !== 'GET' && WORKBENCH_TOKEN) {
    const got = String(req.headers['x-workbench-token'] || url.searchParams.get('token') || '');
    if (got !== WORKBENCH_TOKEN) return send(res, 401, { error: '缺少或错误的 x-workbench-token' });
  }

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
  console.log(`会话        ${s.sessions.length} 个；事实 ${s.facts.length} 条；卡 ${s.card.chars}/${s.card.limit} 字（收录 ${s.card.included}，挤出 ${s.card.dropped}）`);
  if (!WORKBENCH_TOKEN) console.log('提示        未设 WORKBENCH_TOKEN：写接口只靠“仅监听 127.0.0.1”，本机其他程序可直接调');
});
