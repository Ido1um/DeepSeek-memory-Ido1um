// 记忆引擎：轮转 / 兜底交接 / 注入拼装 / 日终维护 / 定时 tick / 自检。
//
// 宿主（桥接、测试、未来的独立进程）只提供 host 接口：
//   log(msg)              统一日志
//   listSessions()        当前有映射的 key 列表（如 ['private:10001']）
//   getSessionId(key)     这个 key 当前映射的 DSH 会话 id（没有返回 ''）
//   retireSession(key)    真正把旧会话退役（桥接专有；引擎不关心怎么退）
//   isBusy(key)           prompt 正在跑或排队中
//   isDshReady()          DSH 是否就绪（启动 5 秒的第一次维护要等它）
//   afterRotate(key)      轮转后清宿主侧缓存
//   getOwnerKey()         用户私聊 key（日终刷新卡用）
//   modelWindowTokens()   模型窗口（可选，未知返回 0）
//
// v7 变更（相对 2026-10-27 抽取版）：
//   1) 轮转只认真实 token：max(最近 5 轮 cacheMiss+cacheHit) >= 0.7 × 窗口，
//      没有年龄兜底；窗口三级取值见 token.mjs；
//   2) 会话三态 off/log/full（policy.mjs），off 不记不注入不轮转，log 只记日志；
//   3) 事实卡 = 长期库投影（card.mjs），写前备份、保留 backupKeep 份；
//      scoring.mode=write 时日终改用投影，model 时仍走模型摘要；
//   4) 卡更新后再注入一次（profile.reinjectOnUpdate，默认开）；
//   5) doctor() 自检（数据可解析 / id 唯一 / 末行完整 / 卡与备份 / token 日志）。
//
// 设计约束：
// 1) 引擎只调 store/digest 的纯函数，不直接读写桥接 state；
// 2) 注入「只消费一次」由宿主在 accepted 之后调用 commitInjections()；
// 3) 模型摘要失败必须回退提取式，轮转永远能完成。

import fs from 'node:fs';
import path2 from 'node:path';
import * as store from './store.mjs';
import * as digest from './digest.mjs';
import * as scoringRun from './scoring-runner.mjs';
import * as card from './card.mjs';
import * as cardTree from './card-tree.mjs';
import * as topicsMod from './topics.mjs';
import * as policy from './policy.mjs';
import * as token from './token.mjs';
import * as doctor from './doctor.mjs';
import { materialize, openIndex } from './longterm.mjs';
import * as lt from './longterm.mjs';
import * as due from './due.mjs';
import * as inject from './inject.mjs';
import * as rules from './rules.mjs';
import * as v10 from './v10.mjs';
import * as extractModel from './extract-model.mjs';
import { memorySection } from './config.mjs';
import * as windowLedger from './window.mjs';
import * as episodeAi from './episode-ai.mjs';
import * as episodeMod from './episode.mjs';
import * as entryExtract from './extract-episode.mjs';
import * as claims from './claims.mjs';
import * as retrieval from './retrieval.mjs';
import * as wander from './wander.mjs';
import * as gapfill from './gapfill.mjs';

const DAY_MS = 86400000;

const DEFAULTS = {
  enabled: true,
  windowDays: 7,
  dailyAt: '23:00',
  maxSessionTokens: 60000,
  handoverMaxChars: 5000,
  handover: { recentSlice: { enabled: true, hours: 24, maxChars: 2400, perTurn: 600, fallbackTurns: 6, includeReply: true, replyChars: 160 } },
  checkIntervalMs: 600000,
  rotation: { thresholdRatio: 0.7, cooldownMs: 600000, minRotateTokens: 20000, contextWindowTokens: 0 },
  summary: { enabled: true, maxChars: 1800, timeoutMs: 30000, maxInputChars: 30000 },
  profile: {
    enabled: true,
    maxChars: 1500,
    hardReserveChars: 400,
    botMaxChars: 200,
    backupKeep: 5,
    source: 'auto',
    reinjectOnUpdate: true,
    reinjectGapMs: 3 * DAY_MS,
    reinjectAfterAgeMs: 3 * DAY_MS
  },
  policy: { enabled: true, defaultRecord: true, defaultInject: true, allowKeys: [], denyKeys: [], pauseDefaultHours: 2, maxPauseHours: 168 },
  reminders: { enabled: true, horizonHours: 24, graceHours: 12, overdueHours: 72 },
  // v8 批 3：四段注入预算（默认关，先影子对比再开）
  inject: inject.normalizeInject({}),
  // 规则注入：always=每轮全文（现状）；session=同一会话只注入一次，靠 20 轮/60% 压力兜底重注
  rules: { mode: 'always', reinjectEveryTurns: 20, pressureAt: 0.6 }, // pressureAt 是「占轮转阈值」的比例
  // 路线 A：日终模型抽取（默认关，先影子观察）
  extract: extractModel.normalizeExtract({}),
  // S1：日终给 episode 补标题/场景/主题/想法（只写 episodes/，不进注入）
  episode: { build: true, summarize: true, maxPerDay: 24, maxInputChars: 6000, timeoutMs: 40000, minAgeMs: 600000 },
  // P3：分层检索（近 7 天情境 → 近 7 天原话 → 近 30 天情境），只注入不写库
  retrieval: { ...retrieval.RETRIEVAL_DEFAULTS },
  // 3.0 补丁：相对时间解析（enabled=false 即回旧行为：不解析、不显示旧事）
  time: { enabled: true, tz: '+08:00' },
  // P3：主动翻旧账（随机间隔，24h ≤1 次）
  wander: { ...wander.WANDER_DEFAULTS }
};

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const rotRaw = c.rotation && typeof c.rotation === 'object' ? c.rotation : {};
  // 兼容线上已有的扁平键（rotationThresholdRatio 等）。
  const pick = (k, flat, fallback, min, max) => num(rotRaw[k] ?? c[flat], fallback, min, max);
  return {
    ...DEFAULTS,
    ...c,
    enabled: c.enabled !== false,
    windowDays: num(c.windowDays, DEFAULTS.windowDays, 1, 30),
    maxSessionTokens: num(c.maxSessionTokens, DEFAULTS.maxSessionTokens, 1000, 2000000),
    handoverMaxChars: num(c.handoverMaxChars, DEFAULTS.handoverMaxChars, 500, 12000),
    handover: {
      recentSlice: {
        ...DEFAULTS.handover.recentSlice,
        ...(c.handover && typeof c.handover === 'object' && c.handover.recentSlice && typeof c.handover.recentSlice === 'object'
          ? c.handover.recentSlice
          : {})
      }
    },
    checkIntervalMs: num(c.checkIntervalMs, DEFAULTS.checkIntervalMs, 60000, 86400000),
    rotation: {
      thresholdRatio: Math.min(0.95, Math.max(0.1, Number(rotRaw.thresholdRatio ?? c.rotationThresholdRatio) || 0.7)),
      cooldownMs: pick('cooldownMs', 'rotationCooldownMs', DEFAULTS.rotation.cooldownMs, 0, 30 * DAY_MS),
      minRotateTokens: pick('minRotateTokens', 'minRotateTokens', DEFAULTS.rotation.minRotateTokens, 0, 5000000),
      contextWindowTokens: pick('contextWindowTokens', 'contextWindowTokens', 0, 0, 10000000)
    },
    summary: { ...DEFAULTS.summary, ...(c.summary && typeof c.summary === 'object' ? c.summary : {}) },
    profile: { ...DEFAULTS.profile, ...(c.profile && typeof c.profile === 'object' ? c.profile : {}) },
    policy: policy.normalizePolicy(c.policy),
    reminders: {
      enabled: !(c.reminders && c.reminders.enabled === false),
      horizonHours: num(c.reminders?.horizonHours, DEFAULTS.reminders.horizonHours, 1, 168),
      graceHours: num(c.reminders?.graceHours, DEFAULTS.reminders.graceHours, 0, 168),
      // 过点后还留多久的「逾期提醒」窗口（0 表示过点就不提醒，老行为）
      overdueHours: num(c.reminders?.overdueHours, DEFAULTS.reminders.overdueHours, 0, 720)
    },
    // 打分：mode 默认 shadow（只采样不写入），改成 write 才动 longterm.jsonl。
    scoring: scoringRun.normalizeScoring(c.scoring),
    rules: {
      mode: c.rules?.mode === 'session' ? 'session' : 'always',
      reinjectEveryTurns: num(c.rules?.reinjectEveryTurns, DEFAULTS.rules.reinjectEveryTurns, 1, 500),
      pressureAt: Math.min(0.99, Math.max(0.1, Number(c.rules?.pressureAt) || DEFAULTS.rules.pressureAt))
    },
    inject: inject.normalizeInject(c.inject),
    extract: extractModel.normalizeExtract(c.extract),
    episode: { ...DEFAULTS.episode, ...(c.episode && typeof c.episode === 'object' ? c.episode : {}) },
    retrieval: { ...DEFAULTS.retrieval, ...(c.retrieval && typeof c.retrieval === 'object' ? c.retrieval : {}) },
    time: { ...DEFAULTS.time, ...(c.time && typeof c.time === 'object' ? c.time : {}) },
    wander: { ...DEFAULTS.wander, ...(c.wander && typeof c.wander === 'object' ? c.wander : {}) }
  };
}

export function createMemoryEngine({
  getConfig = () => memorySection(),
  host = {},
  store: s = store,
  digest: d = digest,
  onReminders = null
} = {}) {
  const log = typeof host.log === 'function' ? host.log : () => {};
  const listSessions = typeof host.listSessions === 'function' ? host.listSessions : () => [];
  const getSessionId = typeof host.getSessionId === 'function' ? host.getSessionId : () => '';
  const retireSession = typeof host.retireSession === 'function' ? host.retireSession : () => false;
  const isBusy = typeof host.isBusy === 'function' ? host.isBusy : () => false;
  const isDshReady = typeof host.isDshReady === 'function' ? host.isDshReady : () => true;
  const afterRotate = typeof host.afterRotate === 'function' ? host.afterRotate : () => {};
  const modelWindowTokens = typeof host.modelWindowTokens === 'function' ? host.modelWindowTokens : () => 0;

  const rotating = new Set();
  const dailyRunning = { value: false };
  let timers = null;
  let rotationSkipLogged = '';

  function config() {
    return normalizeConfig(getConfig());
  }

  function dataDir() {
    // 优先级：QQ_MEMORY_DIR（测试/演练强制隔离）> config.dir（工作台可改）> store 解析值。
    // 之前只信 store.dataDir()，导致「引擎注入的 dir」被忽略——演练时把事实写进了线上库。
    const envDir = String(process.env.QQ_MEMORY_DIR || '').trim();
    if (envDir) return envDir;
    const cfgDir = String(config().dir || '').trim();
    if (cfgDir) return cfgDir;
    try {
      const d = s.dataDir();
      if (d) return String(d);
    } catch {
      // store 没准备好时就没有目录可用
    }
    return '';
  }

  function policyState() {
    try {
      return policy.readPolicyState(dataDir());
    } catch {
      return { keys: {} };
    }
  }

  /** 某个 key 的最终三态。 */
  function policyFor(key, now = Date.now()) {
    const c = config();
    try {
      return policy.resolveState(key, { config: c.policy, state: policyState(), now });
    } catch {
      return { state: 'full', reason: 'error' };
    }
  }

  // ── 摘要：模型优先，失败/关闭时回退提取式 ────────────────────────────────
  /** 轮转注入里的「最近一天原话」：只取净对话，读窗口账本；失败不影响交接摘要。 */
  function recentSliceFor(key, limitChars) {
    const c = config();
    const rs = c.handover?.recentSlice || {};
    if (rs.enabled === false) return '';
    if (!(limitChars > 200)) return '';
    const sid = String(s.getSessionInfo(key)?.sessionId || '');
    if (!sid) return '';
    try {
      const r = windowLedger.formatRecentSlice(dataDir(), sid, {
        hours: Number(rs.hours) || 24,
        maxChars: Math.min(Number(rs.maxChars) || 2400, Math.floor(limitChars)),
        perTurn: Number(rs.perTurn) || 600,
        fallbackTurns: Number(rs.fallbackTurns) || 6,
        includeReply: rs.includeReply !== false,
        replyChars: Number(rs.replyChars) || 160
      });
      if (r?.text) log(`7 天记忆：轮转注入附最近一天原话（${r.turns} 轮，${r.chars} 字${r.fallback ? '，24h 内无记录，退最近几轮' : ''}）`);
      return r?.text || '';
    } catch (error) {
      log(`7 天记忆：最近一天原话读取失败（${error?.message ?? error}）`);
      return '';
    }
  }

  function withRecentSlice(key, summaryText) {
    const c = config();
    const max = Number(c.handoverMaxChars) || 5000;
    const base = String(summaryText || '');
    const slice = recentSliceFor(key, max - base.length - 64);
    if (!slice) return { text: base, added: 0 };
    const out = `${slice}\n\n${base}`;
    return { text: out.length > max ? out.slice(0, max) : out, added: slice.length };
  }

  async function generateRotationHandover(key, { startMs } = {}) {
    const c = config();
    const summary = c.summary;
    // 摘要覆盖「这个会话开始到现在」，而不是硬性最近 7 天；startMs 可显式覆盖。
    const sessionStart = Number(startMs ?? s.getSessionInfo(key)?.startedAt) || 0;
    if (summary.enabled === false) {
      return { text: withRecentSlice(key, s.buildHandover(key, { startMs: sessionStart })).text, mode: 'extract' };
    }
    try {
      const result = await d.summarizeHandover({
        key,
        sinceMs: sessionStart,
        maxInputChars: Number(summary.maxInputChars) || 30000,
        maxChars: Math.min(Number(c.handoverMaxChars) || 3500, Number(summary.maxChars) || 1800),
        timeoutMs: Number(summary.timeoutMs) || 30000
      });
      if (result.ok && result.text) {
        log(`7 天记忆：模型摘要完成（${result.text.length} 字，${result.model}，${result.inputMessages} 条原文）`);
        return { text: withRecentSlice(key, result.text).text, mode: 'model' };
      }
      log(`7 天记忆：模型摘要不可用（${result.error}），回退提取式摘要`);
      return { text: withRecentSlice(key, s.buildHandover(key, { startMs: sessionStart })).text, mode: 'extract', degraded: true };
    } catch (error) {
      log(`7 天记忆：模型摘要异常（${error?.message ?? error}），回退提取式摘要`);
      return { text: withRecentSlice(key, s.buildHandover(key, { startMs: sessionStart })).text, mode: 'extract', degraded: true };
    }
  }

  // ── 兜底：新会话没有现成交接摘要时补一份（每会话只检查一次） ──────────────
  async function ensureFallbackHandover(key, sessionId) {
    if (!config().enabled || !sessionId) return null;
    if (!policy.capabilities(policyFor(key).state).inject) return null;
    try {
      if (!s.noteAutoHandover(sessionId)) return null;
      if (s.peekHandover(key)?.text) return null;
      const rows = s.recentMessages(key, 400);
      if (!rows.length) return null;
      // ts 是 ISO 字符串，必须 Date.parse；Number() 会得 NaN。
      const oldest = Date.parse(rows[0]?.ts) || 0;
      const sessionStart = Number(s.getSessionInfo(key)?.startedAt) || 0;
      const startMs = oldest && sessionStart ? Math.min(oldest, sessionStart) : oldest || sessionStart;
      const info = await generateRotationHandover(key, { startMs: startMs || oldest });
      if (!info?.text) return null;
      s.setHandover(key, info.text, { reason: 'new-session', sessionId, mode: info.mode });
      log(`7 天记忆：新会话没有现成交接摘要，已补生成（${info.text.length} 字，${info.mode}，${key}）`);
      return info.text;
    } catch (error) {
      log(`7 天记忆：新会话补摘要失败（${error?.message ?? error}，${key}）`);
      return null;
    }
  }

  // ── 轮转判据（v7 §5.1） ──────────────────────────────────────────────────
  function rotationStatus(key, sessionId = '', now = Date.now()) {
    const c = config();
    const st = s.getSessionInfo(key) || {};
    const lastRotateAt = Number(st.lastRotationAt) || 0;
    const sid = sessionId || String(st.sessionId || '');
    // 优先用 DSH 报的上下文压力（权威值）；宿主没提供或会话不存在时回落日志扫描。
    let pressure = { tokens: 0, window: 0 };
    try {
      if (typeof host.pressureTokens === 'function') pressure = host.pressureTokens(sid) || pressure;
    } catch { /* 拿不到就用日志 */ }
    const dec = token.rotationDecision({
      config: c.rotation,
      dir: dataDir(),
      sessionId: sid,
      lastRotateAt,
      now,
      modelWindow: Number(modelWindowTokens()) || 0,
      pressureTokens: Number(pressure.tokens) || 0,
      pressureWindow: Number(pressure.window) || 0,
      minRotateTokens: c.rotation.minRotateTokens,
      thresholdRatio: c.rotation.thresholdRatio,
      cooldownMs: c.rotation.cooldownMs
    });
    return { ...dec, lastRotateAt, sessionId: sid };
  }

  // ── 轮转 ────────────────────────────────────────────────────────────────
  async function rotate(key, { force = false, reason = '', approved = false } = {}) {
    const c = config();
    if (!c.enabled) return false;
    // 轮转闸门（2026-11-03 用户立规）：达到 70% 阈值可以直接转，不需要另行批准；
    // 没到阈值时，必须用户明确同意（approved）才能转。
    const sessionId = getSessionId(key);
    if (!sessionId) return false;
    const status = rotationStatus(key, sessionId);
    if (force && !approved) {
      if (!status.due) {
        log(
          `7 天记忆轮转被闸门拦下：${key}（未达 70% 阈值且没有用户批准，reason=${reason || 'manual'}` +
            `${status.reason ? `，status=${status.reason}` : ''}）`
        );
        return false;
      }
      log(`7 天记忆轮转：${key} 已达阈值（${status.reason || 'due'}），按规则直接执行，无需另行批准`);
    }
    if (rotating.has(key)) return false;
    // 启动 5 秒的第一次维护可能早于 DSH 就绪：那时退役会失败、留下孤儿会话。
    if (!force && !isDshReady()) return false;
    if (isBusy(key)) return false;
    const pol = policyFor(key);
    if (!policy.capabilities(pol.state).rotate) {
      if (rotationSkipLogged !== key) {
        rotationSkipLogged = key;
        log(`7 天记忆：${key} 处于 ${pol.state}（${pol.reason}），跳过轮转`);
      }
      return false;
    }
    const due = force
      ? { due: true, reason: reason || 'manual' }
      : status.due
        ? { due: true, reason: 'tokens' }
        : { due: false, reason: status.reason || '' };
    if (!due.due) return false;
    rotating.add(key);
    try {
      const handoverInfo = await generateRotationHandover(key);
      const handover = handoverInfo.text;
      // 摘要可能耗时几十秒；期间会话可能被换掉。
      if (getSessionId(key) !== sessionId) {
        log(`7 天记忆轮转取消：生成摘要期间会话已变化（${key}）`);
        return false;
      }
      if (isBusy(key)) {
        log(`7 天记忆轮转延后：${key} 正在处理消息`);
        return false;
      }
      if (handover) {
        s.saveDigest(key, handover, { reason: due.reason, sessionId, mode: handoverInfo.mode });
        s.setHandover(key, handover, { reason: due.reason, sessionId, mode: handoverInfo.mode });
      }
      s.markRotation(key, { reason: due.reason, sessionId, handoverChars: handover ? handover.length : 0 });
      afterRotate(key, { reason: due.reason, sessionId });
      retireSession(key);
      const why = status.threshold
        ? `真实 ${status.real.maxRecent} ≥ 阈值 ${status.threshold}（窗口 ${status.window.tokens}，${status.window.source}）`
        : '强制';
      log(`7 天记忆轮转：${key}（${due.reason}，${why}，${sessionId}）${handover ? ` 已生成交接摘要（${handoverInfo.mode}）` : ' 无可用摘要'}`);
      return true;
    } catch (error) {
      log(`7 天记忆轮转失败 ${key}：${error?.message ?? error}`);
      return false;
    } finally {
      rotating.delete(key);
    }
  }

  // ── 事实卡（投影） ──────────────────────────────────────────────────────
  function buildProjectedCard(now = Date.now()) {
    const c = config();
    if (c.profile?.enabled === false) return null;
    let facts = [];
    try {
      facts = openIndex(dataDir()).facts();
    } catch {
      facts = [];
    }
    if (!facts.length) return null;
    // 记忆 3.0 P2：有主题表就按主题树投影（一个主题一行、槽位缩进），
    // 没有主题表（老数据/迁移前）仍走扁平的 card.buildCard。
    if (c.profile?.tree !== false) {
      try {
        const topics = topicsMod.readTopics(dataDir());
        if (topics.length) {
          // 卡面预算不超过注入预算（默认 1500），否则注入时还要二次裁剪、容易把子主题拦腰截断
          const treeCfg = { ...c.profile, maxChars: Math.min(Number(c.profile?.maxChars) || 1500, 1500), timeEnabled: c.time?.enabled !== false };
          const tree = cardTree.buildTreeCard(facts, treeCfg, topics);
          if (tree.text) return { ...tree, facts: facts.length, mode: 'tree' };
        }
      } catch {
        /* 主题表坏了不影响出卡：回退扁平投影 */
      }
    }
    const built = card.buildCard(facts, c.profile);
    return { ...built, facts: facts.length, mode: 'flat' };
  }

  function shouldUseProjection(scoringMode) {
    const c = config();
    const source = String(c.profile?.source || 'auto');
    if (source === 'projection') return true;
    if (source === 'model') return false;
    // auto：长期库里已经有事实，就用投影（卡=长期库的投影，v7 §5.4），
    // 避免「库里有事实、卡却是另一套模型摘要」的二次维护。
    if (scoringMode === 'write') return true;
    try {
      return openIndex(dataDir()).facts().length > 0;
    } catch {
      return false;
    }
  }

  // v8 批 3：四段注入里的「待办」与「相关记忆」
  function taskLines(now = Date.now()) {
    let facts = [];
    try {
      facts = openIndex(dataDir()).facts();
    } catch {
      facts = [];
    }
    return facts
      .filter((f) => f.status === 'active' && Number(f.dueAt) > 0 && Number(f.dueAt) + 3 * DAY_MS >= now)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 5)
      .map((f) => `· ${f.due || ''} ${String(f.value || f.text || '').slice(0, 40)}${f.notifiedAt ? '（已提醒）' : ''}`);
  }

  function retrievalLines(query, cardText = '', sessionId = '', key = '') {
    const q = String(query || '').trim();
    const cfg10 = v10.loadV10(dataDir());
    // P2 阶段 D：语气摘要作为一行系统提示（开关关闭/文件为空时为空串）
    let summaryLine = '';
    try {
      summaryLine = v10.toneSummaryLine(dataDir(), cfg10);
    } catch {
      summaryLine = '';
    }
    if (!q) return summaryLine ? [summaryLine] : [];
    let rows = [];
    try {
      rows = scoringRun.search({
        query: q,
        limit: 6,
        dir: dataDir(),
        scoring: config().scoring,
        match: cfg10.matchTokens === true ? 'tokens' : 'substring'
      }) || [];
    } catch {
      rows = [];
    }
    const seen = String(cardText || '');
    const picked = rows
      .filter((r) => r && r.value && (!seen.includes(String(r.value).slice(0, 12)) || r.feel))
      .filter((r) => retrieval.isSalient(r, dataDir())) // 注入闸门（显著性下限，语义同旧 v10 路径）
      .slice(0, 4);
    // v10：只把这批真正进注入的条目录进 retrieved（CLI/MCP/影子对比不会走到这里）
    try {
      if (picked.length) scoringRun.markRetrieved(picked, { dir: dataDir(), by: 'inject' });
    } catch {
      /* 记账失败不影响注入 */
    }
    const feelOn = config().feel === undefined ? true : config().feel.enabled !== false;
    const lines = [];
    let felt = 0;
    for (const r of picked) {
      const inCard = seen.includes(String(r.value).slice(0, 12));
      if (!inCard) lines.push(retrieval.retrievalLine(r, dataDir()));
      if (feelOn && r.feel && felt < 2) {
        lines.push(`  └ ${inCard ? '' : ''}我当时：${String(r.feel).slice(0, 40)}`);
        felt += 1;
      }
    }
    // P3：分层检索（近 7 天情境摘要 → 近 7 天原话 → 近 30 天情境摘要）
    try {
      const rc = config().retrieval;
      if (rc && rc.enabled !== false) {
        const hit = retrieval.layeredRecall(dataDir(), { query: q, sessionId, key, cfg: rc });
        const block = retrieval.formatLayered(hit, { maxChars: Math.min(900, Number(rc.maxChars) || 900) });
        if (block) {
          lines.push(block);
          log('分层检索：' + hit.layers.map((l) => l.name + ' ' + l.count + ' 条/' + l.chars + ' 字').join(' · '));
        }
      }
    } catch (e) {
      log('分层检索失败（忽略）：' + (e && e.message ? e.message : e));
    }
    // P3：主动翻旧账——随机间隔到点、且 24h 内没提过时，补一行「忽然想起」
    try {
      const wc = config().wander;
      if (wc && wc.enabled !== false) {
        const w = wander.maybeWander(dataDir(), { cfg: wc });
        if (w.ok) {
          lines.push('【忽然想起】\n' + w.line);
          log('偶忆：' + w.episodeId);
        } else if (w.reason && w.reason !== 'not-due') {
          log('偶忆跳过：' + w.reason);
        }
      }
    } catch (e) {
      log('偶忆失败（忽略）：' + (e && e.message ? e.message : e));
    }
    // P2 阶段 C：情绪残留 → 末尾一句语气提示（不生成事实、不进卡、不参与打分）
    if (cfg10.enabled === true && cfg10.toneResidue === true) {
      try {
        const rows = lt.readEvents(dataDir()).rows || [];
        const facts = materialize(rows, lt.readInvalidated(dataDir()));
        const lastByTopic = new Map();
        for (const r of rows) {
          if (!r || r.ev !== 'tone' || !r.topic) continue;
          const at = Number(r.at) || 0;
          const prev = lastByTopic.get(String(r.topic)) || 0;
          if (at > prev) lastByTopic.set(String(r.topic), at);
        }
        const hint = v10.toneHintOf(facts, {
          query: q,
          cfg: cfg10,
          now: Date.now(),
          lastToneAt: (topic) => lastByTopic.get(String(topic)) || 0
        });
        if (hint) {
          lines.push(hint.text);
          try {
            lt.appendEvent({ ev: 'tone', topic: hint.topic, at: Date.now(), by: 'inject' }, dataDir());
          } catch {
            /* 记不上不影响注入 */
          }
        }
      } catch {
        /* 语气提示失败不影响注入 */
      }
    }
    if (summaryLine) lines.push(summaryLine);
    return lines;
  }

  // ── 注入拼装：事实卡（按会话一次 / 更新后再注入）+ 交接摘要（按 consumedAt 一次） ─
  // 兼容两种调用：composePrompt(key, promptText) 与 composePrompt(key, sessionId, promptText)。
  // 两参数时 sessionId 从 store 里按 key 取；取不到就当作「没有会话」（只拼交接摘要）。
  function composePrompt(key, a, b) {
    let sessionId = a;
    let promptText = b;
    if (b === undefined) {
      promptText = a;
      sessionId = '';
      try {
        sessionId = (s.getSessionId?.(key) || '').trim();
      } catch {
        sessionId = '';
      }
    }
    const c = config();
    const pol = policyFor(key);
    if (!policy.capabilities(pol.state).inject) {
      return { text: promptText, profile: false, handover: null, state: pol.state, blocks: [] };
    }
    const parts = [];
    // 3.0 窗口账本：把「这一轮她看到的记忆段」按来源记下来，正文内容寻址存块。
    // 只做账，不改变注入文本——blocks 与 text 必须能拼回原文（对账用）。
    const blocks = [];
    let profile = false;
    let reinjected = false;
    // v8 批 3：开了预算就走四段装配（规则/卡/待办/相关记忆），否则沿用旧拼法
    const inj = c.inject?.enabled ? c.inject : null;
    let cardForBudget = '';
    if (c.profile?.enabled !== false && sessionId) {
      const cardText = s.renderProfileCard();
      if (cardText && !s.profileInjectedFor(sessionId)) {
        if (inj) {
          cardForBudget = cardText; // 文本由 inject.assemble 的 card 段带出，blocks 也在那里记一次
        } else {
          parts.push(cardText);
          blocks.push({ k: 'card', text: cardText });
        }
        profile = true;
        log(`长期记忆：向会话 ${sessionId} 注入事实卡（${cardText.length} 字）`);
      } else if (cardText && c.profile?.reinjectOnUpdate !== false) {
        // 卡更新后再注入一次：会话够老 + 距上次再注入够久 + 卡比上次注入新。
        const st = s.getSessionInfo(key) || {};
        const ageMs = Date.now() - (Number(st.startedAt) || 0);
        const lastReinject = Number(s.profileReinjectedAt?.(sessionId)) || 0;
        const injectedAt = Number(s.profileInjectedAt?.()) || 0;
        const cardAt = Number(s.profileInfo?.().updatedAt) || 0;
        const gapOk = Date.now() - lastReinject >= Number(c.profile.reinjectGapMs || 0);
        const ageOk = ageMs >= Number(c.profile.reinjectAfterAgeMs || 0);
        const fresh = cardAt > Math.max(injectedAt, lastReinject);
        if (gapOk && ageOk && fresh) {
          parts.push(`${cardText}\n（这张卡有更新，再给你看一眼。）`);
          blocks.push({ k: 'card-resend', text: cardText });
          reinjected = true;
          log(`长期记忆：会话 ${sessionId} 已注入过旧卡，本次再注入一次（会话龄 ${Math.round(ageMs / 3600000)}h）`);
        }
      }
    }
    if (c.enabled) {
      const handover = s.peekHandover(key);
      if (handover?.text) {
        parts.push(handover.text);
        blocks.push({ k: 'handover', text: handover.text });
        log(`7 天记忆：向新会话注入交接摘要（${handover.text.length} 字，${key}）`);
      }
    }
    let injected = null;
    if (inj) {
      // 四段装配：规则（手写）> 卡 > 待办 > 相关记忆，总预算 2500 字。
      // 规则/待办/检索**每轮都装**（长会话里不能只在首轮出现一次就没下文）；
      // 卡只在首轮或「卡更新后」那一轮带，避免每轮重复烧 1200 字。
      // 规则注入策略：always=每轮全文；session=同会话只一次，轮数/压力/改规则时兜底重注
      const rcfg = c.rules || {};
      const dd = dataDir();
      const rh = rules.rulesHash(dd);
      const rec = sessionId ? s.rulesInjectedFor(sessionId) : null;
      const sameSession = !!(rec && sessionId);
      const turns = sameSession ? s.bumpRulesTurns(sessionId) : 0;
      let pressure = 0;
      let threshold = 0;
      try {
        const rs = rotationStatus(key, sessionId);
        threshold = Number(rs?.threshold) || 0;
        // 压力口径 = 真实 token / 轮转阈值（700k 阈值 → 420k 即 60%）
        pressure = rules.pressureRatio(rs?.real?.maxRecent, threshold);
      } catch {
        pressure = 0;
      }
      const dec = rules.decideRules({
        mode: rcfg.mode,
        sameSession,
        sameHash: sameSession && rec.hash === rh,
        turns,
        pressure,
        everyTurns: rcfg.reinjectEveryTurns,
        pressureAt: rcfg.pressureAt
      });
      const rulesSec = rules.rulesSection(dd, inj.budget.rules);
      if (rcfg.mode === 'session') log(`规则注入：${dec.inject ? '带全文' : '占位'}（${dec.reason}，第 ${turns} 轮，压力 ${(pressure * 100).toFixed(0)}% · 阈值 ${threshold}）`);
      if (dec.inject && sessionId && rulesSec.text) s.markRulesInjected(sessionId, rh);
      injected = inject.assemble(
        {
          rulesText: dec.inject ? rulesSec.text : rules.RULES_PLACEHOLDER,
          cardText: cardForBudget,
          taskLines: taskLines(),
          retrievalLines: retrievalLines(promptText, cardForBudget, sessionId, key)
        },
        inj.budget
      );
      if (injected.text) parts.unshift(injected.text);
      for (const sec of injected.sections || []) {
        const body = String(sec?.text || '').trim();
        if (body) blocks.push({ k: String(sec?.name || 'section'), text: body });
      }
      log(
        `注入预算：${injected.total} 字 / 约 ${injected.tokens} tokens（规则 ${injected.used.rules} · 卡 ${injected.used.card} · 待办 ${injected.used.tasks} · 检索 ${injected.used.retrieval}${injected.overflow > 0 ? ` · 超预算 ${injected.overflow} 字` : ''}）`
      );
    }
    return {
      text: parts.length ? `${parts.join('\n\n')}\n\n【当前对话】\n${promptText}` : promptText,
      profile,
      reinjected,
      handover: parts.length ? s.peekHandover(key) : null,
      state: pol.state,
      injected,
      blocks
    };
  }

  // accepted 之后调用：标记已消费，保证只注入一次。
  function commitInjections(key, sessionId, composed) {
    if (composed?.handover?.text) s.clearHandover(key);
    if (composed?.profile) s.markProfileInjected(sessionId);
    if (composed?.reinjected) s.markProfileReinjected?.(sessionId);
  }

  // ── 入站打分：影子只采样，write 才写 longterm.jsonl ────────────────────────
  function onInbound(key, text, { ts = Date.now(), itemId = 0 } = {}) {
    const c = config();
    if (!c.enabled) return { mode: 'off', skipped: 'disabled', added: [], mentioned: [] };
    const pol = policyFor(key, ts);
    if (!policy.capabilities(pol.state).record) {
      return { mode: 'off', skipped: `policy-${pol.state}`, added: [], mentioned: [], policy: pol };
    }
    try {
      const r = scoringRun.recordInbound({ key, text, ts, scoring: c.scoring, dir: dataDir(), itemId });
      if (r.mode === 'shadow' && (r.added.length || r.mentioned.length)) {
        log(`记忆影子：${key} 抽到 ${r.added.length} 条新事实、命中 ${r.mentioned.length} 条旧记忆（未写入）`);
      } else if (r.mode === 'write' && (r.added.length || r.mentioned.length)) {
        log(`长期记忆：${key} 写入 ${r.added.length} 条、命中 ${r.mentioned.length} 条`);
      }
      return { ...r, policy: pol };
    } catch (error) {
      log(`记忆打分失败（${error?.message ?? error}，${key}）`);
      return { mode: c.scoring.mode, added: [], mentioned: [], error: String(error?.message ?? error), policy: pol };
    }
  }

  // ── 日终维护（dailyAt）：归档 + 结算 + 卡投影 + 轮转检查 ───────────────────
  async function runDailyMaintenance(now = Date.now(), { force = false } = {}) {
    const c = config();
    if (!c.enabled) return { ok: false, error: '7 天记忆未启用' };
    if (!force && !s.dailyDue(now)) return { ok: false, skipped: true, reason: '今天还没到日终维护时间' };
    if (dailyRunning.value) return { ok: false, skipped: true, reason: '上一次日终维护还在跑' };
    dailyRunning.value = true;
    try {
      const st = s.memoryStats?.() || {};
      const lastDaily = Number(st.lastDailyAt) || 0;
      const bounds = s.windowBounds(now);
      const archived = s.archiveOld(now);

      let scoring = null;
      try {
        scoring = scoringRun.settle({ now, scoring: c.scoring, dir: dataDir() });
        if (scoring.mode === 'shadow') {
          log(`记忆影子·日终：${scoring.active} 条事实，将迁移 ${scoring.transitionCount} 条（预览见 state/scoring-dryrun.json）`);
        } else if (scoring.mode === 'write') {
          log(`长期记忆·日终：${scoring.active} 条事实，迁移 ${scoring.transitionCount} 条`);
        }
      } catch (error) {
        log(`记忆结算失败：${error?.message ?? error}`);
      }

      // 里程碑补扫：机器人自己说的「第一次…」不进 onInbound（那是用户消息专用），日终从原文补
      try {
        if (c.scoring?.mode === 'write') {
          const day = new Date(now).toLocaleDateString('sv-SE');
          const ms = scoringRun.scanAssistantFacts({ dir: dataDir(), day, now, includeSelf: true });
          if (ms.added > 0) log(`记忆自述：${day} 扫到 ${ms.scanned} 条，新增 ${ms.added} 条（首次 / 自述）`);
        }
      } catch (error) {
        log(`里程碑补扫失败：${error?.message ?? error}`);
      }

      // 路线 A + v11：日终模型抽取（默认关）。只产候选、规则做硬门；
      // 通过的选择进候选池 state/candidates.jsonl（不进卡、不进检索），
      // 由 merge 阶段裁决后才写事实库；失败绝不阻塞后续步骤。
      let extract = null;
      try {
        if (c.extract?.enabled === true) {
          const ownerKey = typeof host.getOwnerKey === 'function' ? host.getOwnerKey() : '';
          extract = await extractModel.runModelExtract({
            now,
            dir: dataDir(),
            cfg: c.extract,
            scoring: c.scoring,
            ownerKey,
            log
          });
          if (extract?.skipped) {
            log(`记忆抽取·跳过（${extract.skipped}）`);
          } else {
            const reasons = Object.entries(extract.byReason || {})
              .map(([k, v]) => `${k} ${v}`)
              .join(' / ');
            log(
              `记忆抽取（候选池）：${extract.batches} 批/${extract.messages} 条消息 → ${extract.candidates} 候选，` +
                `通过 ${extract.passed}${extract.pooled ? `、进池 ${extract.pooled}` : ''}，丢弃 ${extract.dropped}${reasons ? `（${reasons}）` : ''}`
            );
          }
        }
      } catch (error) {
        log(`记忆抽取失败（不影响日终）：${error?.message ?? error}`);
      }

      // P0b（D1）：先把聊天记录里掉出窗口的用户消息补回账本（只补原话 + 她发出去的话），
      // 再建情境段做摘要/抽取——否则缺口永远进不了记忆。
      let gapRepair = null;
      try {
        if (c.window?.gapRepair !== false) {
          gapRepair = { sessions: 0, added: 0, skipped: 0, details: [] };
          const keys = typeof s.listSessions === 'function' ? s.listSessions() : [];
          for (const key of keys) {
            const info = typeof s.getSessionInfo === 'function' ? s.getSessionInfo(key) : null;
            const sid = String(info?.sessionId || '');
            const r = gapfill.repairGapsForKey({ dir: dataDir(), key, days: 2, now, write: true, fallbackSessionId: sid });
            if (r.gapTurns) {
              gapRepair.sessions += 1;
              gapRepair.added += r.added;
              gapRepair.skipped += r.skipped;
              gapRepair.details.push({ key, gapTurns: r.gapTurns, added: r.added, sessions: r.sessions });
            }
            if (r.added) log(`窗口缺口：${key} 补写 ${r.added} 轮（聊天记录里有 ${r.gapMessages} 条原话没进窗口）`);
          }
        }
      } catch (error) {
        log(`窗口补写失败（不影响日终）：${error?.message ?? error}`);
      }

      // S1：先把窗口账本建成情境段（幂等），否则摘要与 entry 抽取都无段可做。
      // 2026-11-04 体检发现的断档：建段只在 scripts/build-episodes.mjs 手动跑，
      // 日终从不建段 → episode/entry 链从当天起空转。
      let episodeBuild = null;
      try {
        if (c.episode?.build !== false) {
          episodeBuild = episodeMod.buildDailyEpisodes(dataDir(), { now, days: 2 });
          if (episodeBuild.added || episodeBuild.updated) {
            log(
              `情境段：建段完成（新增 ${episodeBuild.added} 段，补尾巴 ${episodeBuild.updated} 段，覆盖 ${episodeBuild.segments} 段）`
            );
          }
        }
      } catch (error) {
        log(`情境段构建失败（不影响日终）：${error?.message ?? error}`);
      }

      // S1：给还没摘要的 episode 补标题/场景/主题/想法。只写 episodes/，不碰注入与卡。
      let episodeSummary = null;
      try {
        if (c.episode?.summarize !== false) {
          episodeSummary = await episodeAi.summarizePendingEpisodes(dataDir(), {
            now,
            cfg: c.episode,
            log
          });
        }
      } catch (error) {
        log(`情境摘要失败（不影响日终）：${error?.message ?? error}`);
      }

      // P2：从当天的情境段抽 entry（带 topic/slot），单值槽位复用原 id 走 supersede。
      let entryExtractResult = null;
      try {
        if (c.entryExtract?.enabled === true) {
          // 覆盖今天与昨天：今天的段可能还没结束（夜里再补尾巴），昨天是完整日。
          // 同为单值槽位走 supersede、多值按 sig 去重，重复抽不会重复写。
          const yday = episodeMod.dayOf(new Date(now - 86400000).toISOString());
          const dayEpisodes = episodeMod
            .readEpisodes(dataDir())
            .filter((e) => e.day === bounds.today || (yday && e.day === yday))
            .slice(-Math.max(1, Number(c.entryExtract.maxPerDay) || 12));
          if (dayEpisodes.length) {
            entryExtractResult = await entryExtract.extractIntoStore(dataDir(), dayEpisodes, { write: true, log });
            log(
              `情境抽取：${dayEpisodes.length} 段 → 新增 ${entryExtractResult.written} 条，更新 ${entryExtractResult.updated} 条，重复跳过 ${entryExtractResult.skippedDup} 条`
            );
          }
        }
      } catch (error) {
        log(`情境抽取失败（不影响日终）：${error?.message ?? error}`);
      }

      // P0c：她纠正过的话 → pending 候选（不直接改事实，等用户确认）
      let claimResult = null;
      try {
        claimResult = claims.runDailyClaims(dataDir(), { now, cfg: c.claims, log });
        if (claimResult?.added) {
          log(`纠正候选：新增 ${claimResult.added} 条（pending，等用户确认）`);
        }
      } catch (error) {
        log(`纠正候选失败（不影响日终）：${error?.message ?? error}`);
      }

      // 事实卡：write/投影模式 → 从长期库投影并备份；否则仍走模型摘要。
      let profile = { chars: 0, mode: 'skip', error: '' };
      if (c.profile?.enabled !== false) {
        if (shouldUseProjection(scoring?.mode || c.scoring.mode)) {
          const built = buildProjectedCard(now);
          if (built?.text) {
            const prev = typeof s.readProfile === 'function' ? s.readProfile() : '';
            const written = card.writeCard(dataDir(), built.text, c.profile);
            // 投影器已经写完文件；这里只补状态位，否则 profileUpdatedAt 永远停在旧值。
            if (prev.trim() !== built.text.trim()) {
              if (typeof s.markProfileChanged === 'function') s.markProfileChanged(built.text);
              else s.writeProfile(built.text);
            }
            profile = {
              chars: written.chars,
              mode: 'projection',
              backup: written.backup,
              dropped: built.dropped.length,
              facts: built.facts
            };
            log(`长期记忆：事实卡已按投影重排（${written.chars} 字，hard 预留 ${c.profile.hardReserveChars}，挤出 ${built.dropped.length} 条，备份 ${written.backup ? '有' : '无'}）`);
          } else {
            profile = { chars: 0, mode: 'projection', error: '长期库为空，跳过投影' };
          }
        } else {
          const ownerKey = typeof host.getOwnerKey === 'function' ? host.getOwnerKey() : '';
          if (ownerKey) {
            const previous = s.readProfile();
            const result = await d.summarizeProfile({
              key: ownerKey,
              previousProfile: previous,
              maxChars: Math.min(4000, Math.max(200, Number(c.profile.maxChars) || 1500)),
              maxInputChars: Number(c.summary?.maxInputChars) || 24000,
              timeoutMs: Number(c.summary?.timeoutMs) || 40000
            });
            if (result.ok && result.text) {
              const chars = s.writeProfile(result.text);
              profile = { chars, mode: result.mode, error: result.error || '' };
              log(`长期记忆：事实卡已更新（${chars} 字，${result.mode}${result.error ? `，模型不可用：${result.error}` : ''}）`);
            } else {
              profile = { chars: 0, mode: 'skip', error: result.error || '没有可用记录' };
              log(`长期记忆：事实卡未更新（${profile.error}）`);
            }
          }
        }
      }

      // P2 阶段 D：人格语气摘要（profile-tone.md）。默认关；没有强情绪事件就保留旧文件。
      let toneSummary = null;
      try {
        const cfg10 = v10.loadV10(dataDir());
        if (cfg10.enabled === true && cfg10.toneSummary === true) {
          const rows = lt.readEvents(dataDir()).rows || [];
          const facts = materialize(rows, lt.readInvalidated(dataDir()));
          const text = v10.buildToneSummary(facts, { cfg: cfg10, now });
          if (text) {
            const res = v10.writeToneSummary(dataDir(), text, { now });
            toneSummary = { chars: res.chars, written: res.written, backup: res.backup };
            log(`长期记忆：语气摘要已更新（${res.chars} 字${res.backup ? '，已备份旧文件' : ''}）`);
          } else {
            toneSummary = { chars: 0, skipped: true };
            log('长期记忆：语气摘要跳过（最近没有强情绪事件）');
          }
        }
      } catch (error) {
        log(`长期记忆：语气摘要失败（${error?.message ?? error}）`);
      }

      // 窗口对账：她那一侧看到的窗口 vs 聊天记录。只告警、不改数据。
      // 对账失败不阻塞日终，也不动 window/ 任何文件。
      let reconcile = null;
      try {
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const lines = [];
        const summary = [];
        for (const key of listSessions()) {
          let sid = '';
          try { sid = String(host.getSessionId(key) || ''); } catch { sid = ''; }
          if (!sid) continue;
          let raws = [];
          let rawMsgs = [];
          try {
            rawMsgs = store.recentMessages(key, 800)
              .filter((m) => m && m.role === 'user' && String(m.text || '').trim() && (Number(m.time) || Date.parse(m.ts) || 0) >= startOfDay.getTime())
              .map((m) => ({ text: String(m.text), msgId: String(m.messageId || ''), at: Number(m.time) || Date.parse(m.ts) || 0 }));
            raws = rawMsgs.map((m) => m.text);
          } catch { raws = []; }
          const r = windowLedger.reconcileSession({ dir: dataDir(), sessionId: sid, sinceMs: startOfDay.getTime(), rawTexts: raws, rawMessages: rawMsgs });
          summary.push({ key, sessionId: sid, ...r });
          lines.push(
            `${new Date(now).toISOString()} ${key} ${sid.slice(0, 12)} turns=${r.turns} incomplete=${r.incomplete} spoken=${r.spoken} feels=${r.feels} raw=${r.rawUsers} notInRaw=${r.notInRawCount} rawNotInWindow=${r.rawNotInWindowCount}`
          );
        }
        if (lines.length) {
          const logPath = path2.join(dataDir(), 'logs', 'window-reconcile.log');
          fs.mkdirSync(path2.dirname(logPath), { recursive: true });
          fs.appendFileSync(logPath, lines.join('\n') + '\n', 'utf8');
        }
        reconcile = { at: new Date(now).toISOString(), sessions: summary.length, summary };
        const mismatch = summary.reduce((a, r) => a + (Number(r.notInRawCount) || 0), 0);
        const gapCount = summary.reduce((a, r) => a + (Number(r.rawNotInWindowCount) || 0), 0);
        log(`窗口对账：${summary.length} 个会话，对不上 ${mismatch} 条，缺口 ${gapCount} 条${mismatch || gapCount ? '（见 logs/window-reconcile.log）' : ''}`);
      } catch (error) {
        log(`窗口对账失败（不影响日终）：${error?.message ?? error}`);
      }

      const doneAt = s.markDailyDone(now);
      if (lastDaily && now - lastDaily > 2 * DAY_MS) {
        log(`7 天记忆·补跑：上次日终 ${new Date(lastDaily).toISOString()}，已补跑一次（daily-catchup）`);
      }
      log(`7 天记忆·日终：${bounds.today} 已归档 ${archived} 个文件（保留 ${bounds.windowDays} 天：${bounds.startDay} 起），下次日终标记 ${new Date(doneAt).toISOString()}`);
      for (const key of listSessions()) void rotate(key, { reason: 'daily' });
      return { ok: true, today: bounds.today, windowStart: bounds.startDay, archived, profile, scoring, toneSummary, extract, gapRepair, episodeBuild, episodeSummary, entryExtract: entryExtractResult, claims: claimResult, reconcile };
    } catch (error) {
      log(`7 天记忆·日终日维护失败：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      dailyRunning.value = false;
    }
  }

  // ── 到期提醒 ────────────────────────────────────────────────────────────
  // 只负责「哪些该提醒了」和「记下已提醒」，发消息由宿主（桥接）做：
  // 包内不该知道 QQ 怎么发，宿主也不该知道 due 怎么算。
  //
  // 语义（v2.1 起写死）：到期提醒是「用户级」通道，**不受会话三态 policy 影响**——
  // 某个人把会话设成 log/off 只影响记录与注入，不该连带漏掉「下周交物理实验报告」。
  // 总开关只有 reminders.enabled；policy 只管记录/注入/轮转（见 composePrompt）。
  function dueReminders(now = Date.now(), opts = {}) {
    const c = config();
    try {
      if (!c.enabled) return [];
      if (c.reminders && c.reminders.enabled === false) return [];
      const facts = openIndex(dataDir()).facts();
      const win = {
        horizonMs: (c.reminders?.horizonHours ?? 24) * 3600e3,
        graceMs: (c.reminders?.graceHours ?? 12) * 3600e3,
        overdueMs: (c.reminders?.overdueHours ?? 72) * 3600e3,
        ...opts
      };
      return facts.filter((f) => due.reminderWindow(f, now, win)).map((f) => ({
        id: f.id,
        key: f.key || '',
        due: f.due || '',
        dueAt: f.dueAt,
        tier: f.tier,
        text: `${f.label || f.sig || '事项'}：${String(f.value || f.text || '').slice(0, 160)}`
      }));
    } catch (error) {
      log(`到期提醒检查失败：${error?.message ?? error}`);
      return [];
    }
  }

  function ackReminder(id, now = Date.now()) {
    if (!id) return false;
    try {
      lt.appendEvent({ ev: 'notified', id, at: now }, dataDir());
      return true;
    } catch (error) {
      log(`到期提醒确认失败：${error?.message ?? error}`);
      return false;
    }
  }

  // ── 定时维护 ────────────────────────────────────────────────────────────
  async function tick(now = Date.now()) {
    try {
      if (!config().enabled) return { ok: false, skipped: 'disabled' };
      if (s.dailyDue(now)) await runDailyMaintenance(now);
      else s.archiveOld(now);
      for (const key of listSessions()) void rotate(key);
      try {
        const swept = windowLedger.sweepDrafts({ dir: dataDir(), maxAgeMs: Number(config().window?.staleTurnMs) || 30 * 60 * 1000 });
        if (swept.length) log(`窗口账本：补写超时未收尾的回合 ${swept.length} 个`);
      } catch {
        // 补写失败不影响维护
      }
      const reminders = dueReminders(now);
      if (reminders.length) {
        log(`到期提醒：${reminders.length} 条待发（${reminders.map((r) => r.due).join(', ')}）`);
        // 引擎是纯逻辑：只把「该提醒谁」交出去，发消息由宿主决定（包不该知道 QQ 怎么发）。
        if (typeof onReminders === 'function') {
          Promise.resolve()
            .then(() => onReminders(reminders))
            .catch((error) => log(`到期提醒投递失败：${error?.message ?? error}`));
        }
      }
      return { ok: true, reminders };
    } catch (error) {
      log(`7 天记忆维护失败：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error), reminders: [] };
    }
  }

  function doctorReport() {
    const c = config();
    try {
      const report = doctor.checkDataDir(dataDir(), { config: c, modelWindow: Number(modelWindowTokens()) || 0 });
      const keys = listSessions();
      report.policyStates = keys.map((key) => ({ key, ...policyFor(key) }));
      return report;
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), checks: [] };
    }
  }

  function startMaintenance() {
    const c = config();
    if (!c.enabled) return null;
    const every = Math.max(60_000, Number(c.checkIntervalMs) || 600000);
    const first = setTimeout(() => { void tick(); }, 5_000);
    first.unref?.();
    const timer = setInterval(() => { void tick(); }, every);
    timer.unref?.();
    timers = { first, timer };
    const bounds = s.windowBounds();
    const win = token.describeWindow({ config: c.rotation, dir: dataDir(), modelWindow: Number(modelWindowTokens()) || 0, thresholdRatio: c.rotation.thresholdRatio });
    log(
      `7 天记忆已启用：${c.dir || ''}，窗口 ${bounds.windowDays} 天（${bounds.startDay} 起），日终维护 ${c.dailyAt}，` +
        `轮转：真实 token ≥ ${win.threshold}（${c.rotation.thresholdRatio} × 窗口 ${win.tokens || '未知'}，来源 ${win.source}），冷却 ${Math.round(c.rotation.cooldownMs / 60000)} 分钟，` +
        `记忆打分 ${c.scoring.mode}${c.scoring.mode === 'shadow' ? '（只采样不写入）' : ''}，` +
        `到期提醒 ${c.reminders.enabled ? `开（提前 ${c.reminders.horizonHours} 小时）` : '关'}`
    );
    return { stop };
  }

  function stop() {
    if (!timers) return;
    clearTimeout(timers.first);
    clearInterval(timers.timer);
    timers = null;
  }

  return {
    // 决策/执行
    rotate,
    rotationStatus,
    tick,
    runDailyMaintenance,
    composePrompt,
    commitInjections,
    onInbound,
    search: scoringRun.search,
    ensureFallbackHandover,
    generateRotationHandover,
    startMaintenance,
    stop,
    // 观测/运维
    config,
    getDataDir: dataDir,
    policyFor,
    policyState,
    buildProjectedCard,
    doctor: doctorReport,
    dueReminders,
    ackReminder,
    // 常量暴露（测试/诊断用）
    dataDir
  };
}

