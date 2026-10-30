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

import * as store from './store.mjs';
import * as digest from './digest.mjs';
import * as scoringRun from './scoring-runner.mjs';
import * as card from './card.mjs';
import * as policy from './policy.mjs';
import * as token from './token.mjs';
import * as doctor from './doctor.mjs';
import { materialize } from './longterm.mjs';
import * as lt from './longterm.mjs';
import * as due from './due.mjs';
import * as inject from './inject.mjs';
import * as rules from './rules.mjs';
import { memorySection } from './config.mjs';

const DAY_MS = 86400000;

const DEFAULTS = {
  enabled: true,
  windowDays: 7,
  dailyAt: '23:00',
  maxSessionTokens: 60000,
  handoverMaxChars: 3500,
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
  reminders: { enabled: true, horizonHours: 24, graceHours: 12 },
  // v8 批 3：四段注入预算（默认关，先影子对比再开）
  inject: inject.normalizeInject({})
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
      graceHours: num(c.reminders?.graceHours, DEFAULTS.reminders.graceHours, 0, 168)
    },
    // 打分：mode 默认 shadow（只采样不写入），改成 write 才动 longterm.jsonl。
    scoring: scoringRun.normalizeScoring(c.scoring),
    inject: inject.normalizeInject(c.inject)
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
  async function generateRotationHandover(key, { startMs } = {}) {
    const c = config();
    const summary = c.summary;
    // 摘要覆盖「这个会话开始到现在」，而不是硬性最近 7 天；startMs 可显式覆盖。
    const sessionStart = Number(startMs ?? s.getSessionInfo(key)?.startedAt) || 0;
    if (summary.enabled === false) {
      return { text: s.buildHandover(key, { startMs: sessionStart }), mode: 'extract' };
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
        return { text: result.text, mode: 'model' };
      }
      log(`7 天记忆：模型摘要不可用（${result.error}），回退提取式摘要`);
      return { text: s.buildHandover(key, { startMs: sessionStart }), mode: 'extract', degraded: true };
    } catch (error) {
      log(`7 天记忆：模型摘要异常（${error?.message ?? error}），回退提取式摘要`);
      return { text: s.buildHandover(key, { startMs: sessionStart }), mode: 'extract', degraded: true };
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
  async function rotate(key, { force = false, reason = '' } = {}) {
    const c = config();
    if (!c.enabled) return false;
    if (rotating.has(key)) return false;
    const sessionId = getSessionId(key);
    if (!sessionId) return false;
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
    const status = rotationStatus(key, sessionId);
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
      facts = materialize();
    } catch {
      facts = [];
    }
    if (!facts.length) return null;
    const built = card.buildCard(facts, c.profile);
    return { ...built, facts: facts.length };
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
      return materialize().length > 0;
    } catch {
      return false;
    }
  }

  // v8 批 3：四段注入里的「待办」与「相关记忆」
  function taskLines(now = Date.now()) {
    let facts = [];
    try {
      facts = materialize();
    } catch {
      facts = [];
    }
    return facts
      .filter((f) => f.status === 'active' && Number(f.dueAt) > 0 && Number(f.dueAt) + 3 * DAY_MS >= now)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 5)
      .map((f) => `· ${f.due || ''} ${String(f.value || f.text || '').slice(0, 40)}${f.notifiedAt ? '（已提醒）' : ''}`);
  }

  function retrievalLines(query, cardText = '') {
    const q = String(query || '').trim();
    if (!q) return [];
    let rows = [];
    try {
      rows = scoringRun.search({ query: q, limit: 6, dir: dataDir(), scoring: config().scoring }) || [];
    } catch {
      rows = [];
    }
    const seen = String(cardText || '');
    return rows
      .filter((r) => r && r.value && !seen.includes(String(r.value).slice(0, 12)))
      .slice(0, 4)
      .map((r) => `· [${r.tier}] ${String(r.value).slice(0, 60)}`);
  }

  // ── 注入拼装：事实卡（按会话一次 / 更新后再注入）+ 交接摘要（按 consumedAt 一次） ─
  function composePrompt(key, sessionId, promptText) {
    const c = config();
    const pol = policyFor(key);
    if (!policy.capabilities(pol.state).inject) {
      return { text: promptText, profile: false, handover: null, state: pol.state };
    }
    const parts = [];
    let profile = false;
    let reinjected = false;
    // v8 批 3：开了预算就走四段装配（规则/卡/待办/相关记忆），否则沿用旧拼法
    const inj = c.inject?.enabled ? c.inject : null;
    let cardForBudget = '';
    if (c.profile?.enabled !== false && sessionId) {
      const cardText = s.renderProfileCard();
      if (cardText && !s.profileInjectedFor(sessionId)) {
        if (inj) cardForBudget = cardText;
        else parts.push(cardText);
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
          reinjected = true;
          log(`长期记忆：会话 ${sessionId} 已注入过旧卡，本次再注入一次（会话龄 ${Math.round(ageMs / 3600000)}h）`);
        }
      }
    }
    if (c.enabled) {
      const handover = s.peekHandover(key);
      if (handover?.text) {
        parts.push(handover.text);
        log(`7 天记忆：向新会话注入交接摘要（${handover.text.length} 字，${key}）`);
      }
    }
    let injected = null;
    if (inj && cardForBudget) {
      // 四段装配：规则（手写）> 卡 > 待办 > 相关记忆，总预算 2500 字
      const rulesSec = rules.rulesSection(dataDir(), inj.budget.rules);
      injected = inject.assemble(
        {
          rulesText: rulesSec.text,
          cardText: cardForBudget,
          taskLines: taskLines(),
          retrievalLines: retrievalLines(promptText, cardForBudget)
        },
        inj.budget
      );
      if (injected.text) parts.unshift(injected.text);
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
      injected
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

      const doneAt = s.markDailyDone(now);
      if (lastDaily && now - lastDaily > 2 * DAY_MS) {
        log(`7 天记忆·补跑：上次日终 ${new Date(lastDaily).toISOString()}，已补跑一次（daily-catchup）`);
      }
      log(`7 天记忆·日终：${bounds.today} 已归档 ${archived} 个文件（保留 ${bounds.windowDays} 天：${bounds.startDay} 起），下次日终标记 ${new Date(doneAt).toISOString()}`);
      for (const key of listSessions()) void rotate(key, { reason: 'daily' });
      return { ok: true, today: bounds.today, windowStart: bounds.startDay, archived, profile, scoring };
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
  function dueReminders(now = Date.now(), opts = {}) {
    const c = config();
    try {
      if (!c.enabled) return [];
      if (c.reminders && c.reminders.enabled === false) return [];
      const facts = materialize(lt.readEvents(dataDir()).rows, lt.readInvalidated(dataDir()));
      const win = {
        horizonMs: (c.reminders?.horizonHours ?? 24) * 3600e3,
        graceMs: (c.reminders?.graceHours ?? 12) * 3600e3,
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
