// 二维遗忘模型（v7.1）：重要度 I × 保持度 R。
//
// 设计来自 docs/记忆方案-v7.md §4.5：
//   R = 0.5 ^ (未提及天数 / S)          —— 保持度，按档位给初始 S
//   S' = min(Smax, S × (1 + α(1−R)))    —— 复习拉长稳定度（间隔效应）
//   score = 100 × I × R                 —— 只用于排序/展示，档位由规则决定
//
// 纯函数，不读盘、不联网，全部可单测。调用方（引擎）负责落盘。

export const SCORING_DEFAULTS = Object.freeze({
  model: 'two-dimensional',
  baseDefault: 30,
  baseFact: 60,
  mentionBonus: 25,
  cap: 100,

  // 档位初始稳定度（天）；hard 不衰减
  halfLifeDays: { long: 30, general: 3, temp: 1.5 },

  sameDayDecay: 0.5, // 同日第 2 次 ×0.5、第 3 次 ×0.25
  alpha: 0.9, // 复习增益系数
  sMaxDays: 365, // 稳定度上限

  promote: { hits: 3, score: 55 },
  demoteLongAfterDays: 90, // 长期 90 天没提 → 降一般
  demoteLongFloor: 40, // 降级不归零：S 保留到 floor 天
  generalToTemp: 30, // 一般分数 <30 → 临时
  tempTtlDays: 7, // 临时 7 天没提 → 软删
  eventTtlDays: 7, // 事件（去过哪、发生了什么）7 天后软删，否则事件类 S=∞ 会永远挂着
  taskTtlDays: 7, // 待办截止后 7 天还没结掉 → 软删（不再提醒、不占卡；事件流仍在）
  writeGate: true, // 写入门：候选落库前再筛一道（技术讨论/转述/不确定/临时状态/太薄）
  // v11：前门分级。strict = 保持旧行为（五类全拦）；broad = 只拦确定错，
  // 其余打标进库（低置信 / chat 类 / bot 侧 / 太薄），交给后续归并收敛。
  gateMode: 'strict',
  // v11 观察期：broad 模式下被打标的候选先只进影子文件、不落事实库。
  // 观察 3 天确认没漏进坏数据，再把它关掉（false）让低置信事实真正落库。
  gateShadow: true,
  chatTtlDays: 7, // chat 类（寒暄/状态）保留天数；不进卡、不进检索

  negativePenalty: 0.3, // 每被否定一次 I −0.3
  suspectAt: 2, // 被否定 2 次标记 suspect
  // v8 分类稳定度：不写的类走 halfLifeDays；pref 单独给 90 天；chat 只活半天
  classStability: { rule: null, persona: null, identity: null, event: null, task: null, pref: 90, note: null, chat: 0.5 },
  suggestInvalidateAt: 3, // 3 次建议作废
});

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 扁平写法 → 嵌套键：配置文件里一直是 halfLifeLong/promoteHits 这种扁平键。 */
const FLAT_HALF = { halfLifeLong: 'long', halfLifeGeneral: 'general', halfLifeTemp: 'temp' };
const pos = (v) => (v != null && Number.isFinite(+v) && +v > 0 ? +v : null);

function withFlatAliases(patch = {}) {
  const p = { ...(patch || {}) };
  const half = {};
  for (const [flat, tier] of Object.entries(FLAT_HALF)) {
    const v = pos(p[flat]);
    if (v != null) half[tier] = v;
    delete p[flat];
  }
  if (Object.keys(half).length) p.halfLifeDays = { ...(p.halfLifeDays || {}), ...half };
  const promote = {};
  if (pos(p.promoteHits) != null) promote.hits = pos(p.promoteHits);
  if (pos(p.promoteScore) != null) promote.score = pos(p.promoteScore);
  delete p.promoteHits;
  delete p.promoteScore;
  if (Object.keys(promote).length) p.promote = { ...(p.promote || {}), ...promote };
  if (pos(p.demoteFloor) != null) p.demoteLongFloor = pos(p.demoteFloor);
  delete p.demoteFloor;
  return p;
}

/** 合并配置：只认认识的键，数值非法时回落默认。 */
export function normalizeConfig(patch = {}) {
  const c = { ...SCORING_DEFAULTS, halfLifeDays: { ...SCORING_DEFAULTS.halfLifeDays } };
  for (const [k, v] of Object.entries(withFlatAliases(patch))) {
    if (v == null) continue;
    if (k === 'halfLifeDays' && typeof v === 'object') {
      for (const [t, d] of Object.entries(v)) if (Number.isFinite(+d) && +d > 0) c.halfLifeDays[t] = +d;
    } else if (k === 'promote' && typeof v === 'object') {
      const merged = { ...c.promote };
      if (pos(v.hits) != null) merged.hits = pos(v.hits);
      if (pos(v.score) != null) merged.score = pos(v.score);
      c.promote = merged;
    } else if (k in SCORING_DEFAULTS && typeof SCORING_DEFAULTS[k] === typeof v) {
      // 数值键必须是正有限数，否则回落默认（防止 0 / 负数把衰减算崩）
      if (typeof v === 'number' && !(Number.isFinite(v) && v > 0)) continue;
      c[k] = v;
    }
  }
  return c;
}

/** 配置里出现但代码不认识的键（CLI/doctor 用；只提示，不炸）。 */
export function unknownScoringKeys(patch = {}) {
  // mode / versioning 不在 SCORING_DEFAULTS 里，但确实是 memory.scoring 的合法开关
  // （它们由 scoring-runner / facts 读，不进 normalizeConfig 的数值合并）。
  const ALLOWED_EXTRA = new Set(['mode', 'versioning']);
  const p = withFlatAliases(patch);
  return Object.keys(p).filter((k) => !(k in SCORING_DEFAULTS) && !ALLOWED_EXTRA.has(k));
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * 重要度 I ∈ [0,1]。
 * @param {{hard?:boolean, explicitRemember?:boolean, activeStatement?:boolean,
 *          corrections?:number, negatives?:number, I?:number}} signal
 */
export function importanceOf(signal = {}, cfg = SCORING_DEFAULTS) {
  if (Number.isFinite(signal.I)) return clamp01(signal.I);
  let I = 0.5; // 中性默认
  if (signal.activeStatement) I = 0.6;
  if (signal.explicitRemember) I = 0.8;
  if (signal.hard) I = 1;
  if (signal.corrections) I = clamp01(I + 0.2 * signal.corrections);
  if (signal.negatives) I = clamp01(I - cfg.negativePenalty * signal.negatives);
  return clamp01(I);
}

/** 稳定度 S（天）：hard / rule / persona / event = Infinity；pref 90 天；其余按档位。 */
export function stabilityOf(fact = {}, cfg = SCORING_DEFAULTS) {
  if (fact.tier === 'hard') return Infinity;
  const cls = String(fact.class || 'note');
  const byClass = cfg.classStability || {};
  if (cls in byClass) {
    const v = byClass[cls];
    // null 只对「永久类」表示不衰减；note/未识别类回落档位（否则备注也永不衰减）
    if (v === null) {
      if (cls !== 'note') return Infinity;
    } else if (v === Infinity) return Infinity;
    else if (Number.isFinite(v) && v > 0) return Math.min(cfg.sMaxDays, v);
  }
  if (Number.isFinite(fact.s) && fact.s > 0) return Math.min(cfg.sMaxDays, fact.s);
  const base = cfg.halfLifeDays[fact.tier] ?? cfg.halfLifeDays.general;
  return Math.min(cfg.sMaxDays, base);
}

/** 未提及天数（不足一天按小数）。 */
export function daysSince(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return Math.max(0, (now - ts) / DAY);
}

/** 保持度 R = 0.5^(天数/S)，hard 恒为 1。 */
export function retentionOf(fact = {}, now = Date.now(), cfg = SCORING_DEFAULTS) {
  const S = stabilityOf(fact, cfg);
  if (!Number.isFinite(S)) return 1;
  const days = daysSince(fact.lastAt ?? fact.since, now);
  return clamp01(Math.pow(0.5, days / S));
}

/** 分数 0–100：I × R × 100，四舍五入。 */
export function scoreOf(fact = {}, now = Date.now(), cfg = SCORING_DEFAULTS) {
  const I = clamp01(Number.isFinite(fact.I) ? fact.I : importanceOf(fact, cfg));
  return Math.round(100 * I * retentionOf(fact, now, cfg));
}

/** 同日重复提及的增益：第 1 次 1、第 2 次 ×0.5、第 3 次 ×0.25，跨日重置为 1。 */
export function mentionGain(fact = {}, at = Date.now(), cfg = SCORING_DEFAULTS) {
  const same = sameLocalDay(fact.lastAt, at);
  const n = same ? (fact.sameDayHits ?? 1) + 1 : 1;
  return Math.pow(cfg.sameDayDecay, Math.max(0, n - 1));
}

/** 复习：提及一次 → hits+1、S 按 (1 + α(1−R)·增益) 拉长、lastAt 更新。返回新对象。 */
export function applyMention(fact = {}, at = Date.now(), opts = {}) {
  const cfg = opts.cfg ?? SCORING_DEFAULTS;
  const same = sameLocalDay(fact.lastAt, at);
  const n = same ? (fact.sameDayHits ?? 1) + 1 : 1;
  const gain = mentionGain(fact, at, cfg);
  const R = retentionOf(fact, at, cfg);
  const S = stabilityOf(fact, cfg);
  const nextS = Number.isFinite(S)
    ? Math.min(cfg.sMaxDays, S * (1 + cfg.alpha * (1 - R) * gain))
    : Infinity;
  return {
    ...fact,
    I: clamp01(Number.isFinite(fact.I) ? fact.I : importanceOf(fact, cfg)),
    s: nextS === Infinity ? undefined : round2(nextS),
    hits: (fact.hits ?? 0) + 1,
    sameDayHits: n,
    lastHitAt: at,
    lastAt: at,
  };
}

/** 被否定一次：I 下降；达到 suspectAt 标 suspect；达到 suggestInvalidateAt 建议作废。 */
export function applyNegative(fact = {}, at = Date.now(), cfg = SCORING_DEFAULTS) {
  const negatives = (fact.negatives ?? 0) + 1;
  const I = clamp01((Number.isFinite(fact.I) ? fact.I : importanceOf(fact, cfg)) - cfg.negativePenalty);
  return {
    ...fact,
    I,
    negatives,
    suspect: negatives >= cfg.suspectAt,
    suggestInvalidate: negatives >= cfg.suggestInvalidateAt,
    lastAt: at,
  };
}

/** 下次复习时间 = 上次提及 + S 天；hard 返回 null。 */
export function nextReviewAt(fact = {}, cfg = SCORING_DEFAULTS) {
  const S = stabilityOf(fact, cfg);
  if (!Number.isFinite(S)) return null;
  const base = fact.lastHitAt ?? fact.lastAt ?? fact.since ?? 0;
  return base + Math.round(S * DAY);
}

/** 档位迁移：先看升档，再看降档/过期。 */
export function tierAfter(fact = {}, now = Date.now(), cfg = SCORING_DEFAULTS) {
  if (fact.tier === 'hard') return 'hard';
  // 待办（class=task）：截止日过去 taskTtlDays 天还没结掉 → 软删。
  // 不软删的话 task 类 stability 是 Infinity，会永远 active、永远进「进行中」，过期提醒又不会发。
  if (fact.task) {
    const dueAt = Number(fact.dueAt) || 0;
    if (dueAt && now > dueAt + (Number(cfg.taskTtlDays) || 7) * DAY) return 'expired';
  }
  const score = scoreOf(fact, now, cfg);
  const hits = fact.hits ?? 0;
  const days = daysSince(fact.lastHitAt ?? fact.lastAt ?? fact.since, now);

  // 事件有时效：超过 eventTtlDays 就软删。事件类 S=Infinity，
  // 不单独给 TTL 的话会永远 active、检索里一直占位。
  if (fact.class === 'event') {
    const ttl = Number(fact.ttlDays ?? cfg.eventTtlDays) || 7;
    if (days > ttl) return 'expired';
  }

  // 升：长期
  if (fact.tier !== 'long' && hits >= cfg.promote.hits && score >= cfg.promote.score) return 'long';
  if (fact.tier === 'long') {
    return days > cfg.demoteLongAfterDays ? 'general' : 'long';
  }
  // 临时：太久没提 → 过期（软删）
  if (fact.tier === 'temp') {
    return days > cfg.tempTtlDays ? 'expired' : 'temp';
  }
  // 一般：掉到阈值以下 → 临时
  return score < cfg.generalToTemp ? 'temp' : 'general';
}

/** 降级时把 S 收回到目标档的 floor，避免“一降就归零”。 */
export function demoted(fact = {}, tier, cfg = SCORING_DEFAULTS) {
  const floor = tier === 'long' ? cfg.halfLifeDays.long : tier === 'general' ? cfg.halfLifeDays.general : cfg.halfLifeDays.temp;
  return { ...fact, tier, s: round2(Math.max(floor, fact.s ?? 0)) };
}

/** 一次性算清，给 UI / 检索排序用。 */
export function describe(fact = {}, now = Date.now(), cfg = SCORING_DEFAULTS) {
  const I = clamp01(Number.isFinite(fact.I) ? fact.I : importanceOf(fact, cfg));
  const R = retentionOf({ ...fact, I }, now, cfg);
  const S = stabilityOf(fact, cfg);
  return {
    id: fact.id,
    tier: fact.tier,
    I: round2(I),
    R: round2(R),
    s: Number.isFinite(S) ? round2(S) : 'inf',
    score: Math.round(100 * I * R),
    daysSinceHit: round2(daysSince(fact.lastHitAt ?? fact.lastAt ?? fact.since, now)),
    nextReviewAt: nextReviewAt(fact, cfg),
    suspect: !!fact.suspect,
    suggestInvalidate: !!fact.suggestInvalidate,
    nextTier: tierAfter(fact, now, cfg),
  };
}

export function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/** 同一天判定（本地时区），用于同日重复提及的衰减。 */
export function sameLocalDay(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}
