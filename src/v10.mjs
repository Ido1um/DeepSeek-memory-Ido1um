// v10 · 识海启发：属性 / 细节衰减 / 情绪残留 / 干扰 / 线索 / 可信度。
//
// 设计见 docs/记忆方案-v10-识海启发.md（修订 2）。这里只做「读时计算 + 渲染」，
// 不引入向量、不生成新文本；关闭时（enabled=false）所有调用方都走旧路径。
//
// 与 v7/v8 的边界：
//   - 旧模型只有 I（意义强度）和 R（保持度）；v10 补 D（细节完整度）、E（情绪残留）、
//     C（巩固程度）、I_sim（干扰）和 cue（线索触发）。
//   - 事实卡（profile.md）不因 v10 改变；这里只影响「检索段」怎么排序、怎么措辞。
//   - 事件流只多写 retrieved 一条（同 fact 同一天只记一次），不删不改旧事件。

import fs from 'node:fs';
import path from 'node:path';
import { DAY, SCORING_DEFAULTS, stabilityOf } from './score.mjs';

export const V10_DEFAULTS = Object.freeze({
  enabled: false, // 总开关：关时所有函数返回旧行为
  emit: false, // 是否改变注入文本（三档模糊措辞 + 片段拼接）
  rankInInject: false, // 注入排序是否改用激活值（默认沿用档位+分数）
  recordRetrieved: false, // 检索命中是否写 retrieved 事件
  detailHalfLife: { note: 30, event: 30, pref: 90, long: 90, general: 30, temp: 30 },
  emotionHalfLife: 180,
  emotionHalfLifeStrong: 365,
  strongEmotion: 0.7,
  cueMax: 15,
  floorHard: 80,
  salienceFloor: 0, // 激活值下限：低于它的条目不进注入（0 = 不启用；本机开 20）
  weights: { topic: 12, sig: 8, kw: 5, affect: 6, recency: 4 },
  qLabels: { high: '比较确定', mid: '大概记得', low: '只记得片段' },
  fragmentsMax: 3,
  thresholds: { high: 0.7, mid: 0.4 }
});

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const num = (v, d) => (v != null && Number.isFinite(+v) ? +v : d);
const pos = (v, d) => (v != null && Number.isFinite(+v) && +v > 0 ? +v : d);
const daysSince = (at, now) => Math.max(0, (now - (Number(at) || now)) / DAY);

export function normalizeV10(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const c = {
    ...V10_DEFAULTS,
    detailHalfLife: { ...V10_DEFAULTS.detailHalfLife },
    weights: { ...V10_DEFAULTS.weights },
    qLabels: { ...V10_DEFAULTS.qLabels },
    thresholds: { ...V10_DEFAULTS.thresholds }
  };
  for (const k of ['enabled', 'emit', 'rankInInject', 'recordRetrieved']) {
    if (typeof src[k] === 'boolean') c[k] = src[k];
  }
  for (const k of ['emotionHalfLife', 'emotionHalfLifeStrong', 'strongEmotion', 'cueMax', 'floorHard', 'fragmentsMax']) {
    if (src[k] != null) c[k] = pos(src[k], c[k]);
  }
  if (src.salienceFloor != null) {
    const v = num(src.salienceFloor, c.salienceFloor);
    c.salienceFloor = Math.min(100, Math.max(0, v)); // 允许显式 0（= 不启用）
  }
  if (src.detailHalfLife && typeof src.detailHalfLife === 'object') {
    for (const [k, v] of Object.entries(src.detailHalfLife)) {
      if (pos(v, null) != null) c.detailHalfLife[k] = pos(v, null);
    }
  }
  if (src.weights && typeof src.weights === 'object') {
    for (const k of Object.keys(c.weights)) if (src.weights[k] != null) c.weights[k] = num(src.weights[k], c.weights[k]);
  }
  if (src.qLabels && typeof src.qLabels === 'object') {
    for (const k of Object.keys(c.qLabels)) if (typeof src.qLabels[k] === 'string') c.qLabels[k] = src.qLabels[k];
  }
  if (src.thresholds && typeof src.thresholds === 'object') {
    if (pos(src.thresholds.high, null) != null) c.thresholds.high = pos(src.thresholds.high, c.thresholds.high);
    if (pos(src.thresholds.mid, null) != null) c.thresholds.mid = pos(src.thresholds.mid, c.thresholds.mid);
  }
  return c;
}

// 配置放在数据目录的 v10.json：改完即生效（按 mtime 缓存），不用重启桥接。
const cache = new Map();
export function loadV10(dir = '') {
  const file = path.join(dir || '.', 'v10.json');
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return V10_DEFAULTS;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.cfg;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    raw = null;
  }
  const cfg = normalizeV10(raw);
  cache.set(file, { mtime, cfg });
  return cfg;
}

// ── 属性抽取：情绪 / 关系 / 场景（规则词表，宁缺毋滥） ─────────────────────

const EMO_NEG = ['难过', '伤心', '哭', '生气', '气死', '讨厌', '烦', '累', '疼', '痛', '害怕', '怕', '焦虑', '紧张', '崩溃', '委屈', '失望', '孤独', '恨', '糟', '难受', '病', '发烧', '摔', '吵', '失眠', '想她', '想他'];
const EMO_POS = ['开心', '高兴', '喜欢', '爱', '快乐', '幸福', '兴奋', '感动', '期待', '好吃', '美味', '棒', '哈哈', '嘿嘿', '笑', '甜'];
const INTENSIFY = ['特别', '超级', '超', '非常', '好', '太', '真', '最'];
const SOFTEN = ['有点', '稍微', '一点点', '有些', '略'];

const REL_WORDS = ['主人', '我妈', '我爸', '妈妈', '爸爸', '奶奶', '爷爷', '外婆', '外公', '弟弟', '妹妹', '姐姐', '哥哥', '室友', '朋友', '同学', '老师', '同事'];
const SCENE_WORDS = ['家里', '宿舍', '学校', '教室', '食堂', '机房', '医院', '实验室', '公司', '办公室', '路上', '地铁', '火车', '家里', '床上', '饭桌'];

function countHits(text, words) {
  let n = 0;
  for (const w of words) if (text.includes(w)) n += 1;
  return n;
}

/**
 * 抽三个轻量属性。情绪 = 0..1（有符号：负=难受，正=开心），关系 = 0..1，场景 = 词数组。
 * 只用于衰减速度和排序，不写进事实卡、不给模型看。
 */
export function attrsOf(text) {
  const t = String(text || '');
  if (!t) return { emo: 0, rel: 0, scene: [] };
  const neg = countHits(t, EMO_NEG);
  const pos = countHits(t, EMO_POS);
  let strength = 1;
  if (countHits(t, INTENSIFY)) strength *= 1.5;
  if (countHits(t, SOFTEN)) strength *= 0.6;
  const raw = (neg + pos) * 0.35 * strength;
  const emo = clamp01(raw);
  const signed = neg > pos ? -emo : pos > neg ? emo : 0;
  const rel = REL_WORDS.some((w) => t.includes(w)) ? 1 : 0;
  const scene = SCENE_WORDS.filter((w) => t.includes(w));
  return { emo: signed, rel, scene: [...new Set(scene)] };
}

/** 从原文切出 8–20 字的片段，要求是原文子串；最多 max 条。 */
export function fragmentsOf(text, value = '', max = V10_DEFAULTS.fragmentsMax) {
  const src = String(value || text || '').trim();
  if (!src) return [];
  // 只按标点切；不要把空格当分隔（中文里的日期/数字会被拆成「2023」「年」这种碎片）
  const clauses = src
    .split(/[，,。.；;、！!？?\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const c of clauses) {
    if (out.length >= max) break;
    if (c.length >= 8 && c.length <= 20) {
      if (String(text || src).includes(c) && !out.includes(c)) out.push(c);
    } else if (c.length > 20) {
      // 长句取前 20 字：仍然是原文子串，只是不再切在词中间之外的地方
      const head = c.slice(0, 20);
      if (String(text || src).includes(head) && !out.includes(head)) out.push(head);
    }
  }
  if (!out.length && src.length >= 8) out.push(src.slice(0, Math.min(20, src.length)));
  return out;
}

// ── 五变量与激活值 ────────────────────────────────────────────────────────

function baseDetailHalf(fact, cfg) {
  if (fact.tier === 'hard') return Infinity;
  const cls = String(fact.class || 'note');
  if (cls === 'rule' || cls === 'persona' || cls === 'identity') return Infinity;
  const byClass = cfg.detailHalfLife[cls];
  if (pos(byClass, null) != null) return pos(byClass, null);
  if (fact.tier === 'long') return pos(cfg.detailHalfLife.long, 90);
  if (fact.tier === 'temp') return pos(cfg.detailHalfLife.temp, 30);
  return pos(cfg.detailHalfLife.general, 30);
}

/** 巩固程度 C ∈ [0,1]：提得越多越牢（manual 额外加权）。 */
export function consolidationOf(fact = {}) {
  const hits = Math.max(1, Number(fact.hits) || 1);
  let c = 0.5 + 0.15 * (hits - 1);
  if (fact.manual) c += 0.2;
  return clamp01(c);
}

/** 情绪残留 E_t：有符号，按半衰期衰减；强烈情绪衰减更慢。 */
export function emotionOf(fact = {}, cfg = V10_DEFAULTS, now = Date.now()) {
  const e0 = clamp01(Math.abs(Number(fact.emo) || 0));
  if (!e0) return 0;
  const half = e0 >= cfg.strongEmotion ? cfg.emotionHalfLifeStrong : cfg.emotionHalfLife;
  return e0 * Math.pow(0.5, daysSince(fact.lastAt, now) / half);
}

/** 干扰 I_sim：同主题下还有几条 active 事实（不含自己）。 */
export function interferenceOf(fact = {}, facts = []) {
  const topic = fact.topic || '';
  if (!topic) return 0;
  let n = 0;
  for (const f of facts) {
    if (!f || f === fact || f.topic !== topic) continue;
    if (f.status && f.status !== 'active') continue;
    n += 1;
  }
  return n;
}

/** 细节 D ∈ [0,1]：按类别给半衰期，再按 C/E/干扰 调整快慢。 */
export function detailOf(fact = {}, cfg = V10_DEFAULTS, now = Date.now(), facts = []) {
  const base = baseDetailHalf(fact, cfg);
  if (!Number.isFinite(base)) return 1;
  const c = consolidationOf(fact);
  const e = emotionOf(fact, cfg, now);
  const inter = Math.min(interferenceOf(fact, facts), 3);
  const half = Math.max(1, (base * (1 + 0.6 * (c - 1)) * (1 + 0.4 * e)) / (1 + 0.3 * inter));
  return Math.pow(0.5, daysSince(fact.lastAt, now) / half);
}

function recencyOf(fact, now) {
  return Math.pow(0.5, daysSince(fact.lastAt, now) / 30);
}

function cueHits(fact, query) {
  const q = String(query || '');
  if (!q) return 0;
  let cue = 0;
  // 人物 6：当前消息提到与这条事实有关的人
  if (REL_WORDS.some((w) => (fact.rel && String(fact.text || '').includes(w) && q.includes(w)))) cue += 6;
  // 场景 6：当前消息提到这条事实的场景
  if ((fact.scene || []).some((w) => w && q.includes(w))) cue += 6;
  // 时段 4：今天/明天/周末/上午……
  if (/今天|明天|后天|昨天|周末|上午|下午|中午|晚上|早上|周[一二三四五六日天]|星期/.test(q)) cue += 4;
  // 情绪 4：这条有情绪残留，当前消息也在说情绪
  if (fact.emo && /难过|伤心|开心|高兴|怕|累|痛|生气|委屈/.test(q)) cue += 4;
  return cue;
}

/** 激活值 A：旧分数 + 线索 + 情绪 + 新鲜度 − 干扰。 */
export function activationOf(fact = {}, { query = '', facts = [], now = Date.now(), cfg = V10_DEFAULTS } = {}) {
  const c = consolidationOf(fact);
  const iEff = clamp01((Number(fact.I) || 0.2) * (0.6 + 0.4 * c));
  // S_eff = S_class × (0.6+0.4C)：巩固得越好，忘得越慢（只影响激活值，不改库里的 s）
  const sRaw = stabilityOf(fact, SCORING_DEFAULTS);
  const s = Number.isFinite(sRaw) ? Math.max(1, sRaw * (0.6 + 0.4 * c)) : Infinity;
  const r = Number.isFinite(s) ? Math.pow(0.5, daysSince(fact.lastAt, now) / s) : 1;
  const q = String(query || '');
  const inField = (v) => (q && typeof v === 'string' ? v.includes(q) : false);
  const hitTopic = inField(fact.topic) || inField(fact.label);
  const hitSig = inField(fact.sig);
  const hitKw = inField(fact.text) || inField(fact.value);
  const e = emotionOf(fact, cfg, now);
  const rel = Number(fact.rel) || 0;
  const cue = Math.min(cfg.cueMax, cueHits(fact, q));
  const penalty = 3 * Math.min(interferenceOf(fact, facts), 3);
  const w = cfg.weights;
  const parts = {
    base: 100 * iEff * r,
    topic: hitTopic ? w.topic : 0,
    sig: hitSig ? w.sig : 0,
    kw: hitKw ? w.kw : 0,
    affect: w.affect * e * rel,
    recency: w.recency * recencyOf(fact, now),
    cue,
    penalty
  };
  let A = parts.base + parts.topic + parts.sig + parts.kw + parts.affect + parts.recency + parts.cue - parts.penalty;
  if (fact.tier === 'hard') A = Math.max(A, cfg.floorHard);
  return { A, parts };
}

// ── 可信度 Q 与渲染 ───────────────────────────────────────────────────────

/** Q ∈ [0,1]：证据（原文/来源/用户确认/交叉印证）÷（1+拼装处数）。 */
export function qValueOf(fact = {}, { facts = [] } = {}) {
  const hasQuote = String(fact.quote || '').length >= 8 ? 1 : 0;
  const hasSrc = fact.source && (fact.source.id || fact.source.at) ? 1 : 0;
  const userConfirmed = fact.manual ? 1 : (Number(fact.hits) || 1) >= 3 ? 0.5 : 0;
  const topic = fact.topic || '';
  const cross = topic && facts.some((f) => f !== fact && f.topic === topic) ? 1 : 0;
  const joints = Math.min(2, Math.max(0, (Array.isArray(fact.fragments) ? fact.fragments.length : 0) - 1));
  let q = (0.4 * hasQuote + 0.2 * hasSrc + 0.2 * userConfirmed + 0.2 * cross) / (1 + 0.15 * joints);
  // 硬事实=用户明确说过/人工确认过，不因为回填缺 quote 就被判成「只记得片段」
  if (fact.tier === 'hard') q = Math.max(q, 0.8);
  return clamp01(q);
}

export function qLevelOf(q, cfg = V10_DEFAULTS) {
  if (q >= cfg.thresholds.high) return 'high';
  if (q >= cfg.thresholds.mid) return 'mid';
  return 'low';
}

export function qLabelOf(level, cfg = V10_DEFAULTS) {
  return cfg.qLabels[level] || V10_DEFAULTS.qLabels[level] || '';
}

function firstClause(s, max = 30) {
  const t = String(s || '').trim();
  const cut = t.split(/[，,。.；;、！!？?]/)[0] || t;
  return cut.slice(0, max);
}

/**
 * 渲染一条检索结果。
 * - **D（细节完整度）决定"说多细"**：D≥0.6 原文；0.3–0.6 原文+「（细节记不全了）」；
 *   D<0.3 只用原文碎片，拼不出来就报主题名+「（细节已经模糊）」。
 * - **Q（可信度）只决定前缀**：高档不加前缀；中/低档加 `qLabels` 里的措辞。
 * - hard / rule / persona / identity 永远原文，不加前缀、不模糊。
 * 不生成任何新内容：片段都是原文子串。
 */
export function renderFact(fact = {}, { cfg = V10_DEFAULTS, now = Date.now(), facts = [] } = {}) {
  const val = String(fact.value || fact.text || '').slice(0, 80);
  const tier = fact.tier ? `[${fact.tier}] ` : '';
  const special = fact.tier === 'hard' || ['rule', 'persona', 'identity'].includes(String(fact.class || ''));
  if (special) return `· ${tier}${val}`;

  const d = fact.detail != null ? Number(fact.detail) : detailOf(fact, cfg, now, facts);
  const q = fact.q != null ? Number(fact.q) : qValueOf(fact, { facts });
  const level = fact.qLevel || qLevelOf(q, cfg);
  const conf = level === 'high' ? '' : `${qLabelOf(level, cfg)}：`;

  if (d >= 0.6) return `· ${tier}${val}`;
  if (d >= 0.3) return `· ${tier}${conf}${firstClause(val, 40)}（细节记不全了）`;

  const fr = Array.isArray(fact.fragments) && fact.fragments.length
    ? fact.fragments
    : fragmentsOf(fact.text || val, val, cfg.fragmentsMax);
  const lowLabel = qLabelOf('low', cfg);
  if (fr.length) return `· ${tier}${lowLabel}：${fr.slice(0, cfg.fragmentsMax).join('、')}`;
  return `· ${tier}${lowLabel}：${fact.label || fact.topic || val.slice(0, 12)}（细节已经模糊）`;
}

/** CLI/调试用：一条事实的 v10 全量解释。 */
export function explain(fact = {}, { query = '', facts = [], now = Date.now(), cfg = V10_DEFAULTS } = {}) {
  const { A, parts } = activationOf(fact, { query, facts, now, cfg });
  const q = qValueOf(fact, { facts });
  const level = qLevelOf(q, cfg);
  return {
    id: fact.id,
    tier: fact.tier,
    value: fact.value,
    activation: Number(A.toFixed(1)),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Number(v.toFixed(1))])),
    q: Number(q.toFixed(2)),
    qLevel: level,
    qLabel: qLabelOf(level, cfg),
    detail: Number(detailOf(fact, cfg, now, facts).toFixed(2)),
    emotion: Number(emotionOf(fact, cfg, now).toFixed(2)),
    consolidation: Number(consolidationOf(fact).toFixed(2)),
    interference: interferenceOf(fact, facts),
    fragments: Array.isArray(fact.fragments) ? fact.fragments : fragmentsOf(fact.text, fact.value, cfg.fragmentsMax),
    rendered: renderFact(fact, { cfg, now, facts })
  };
}

/**
 * 注入下限：激活值低于 `salienceFloor` 的条目不投递（默认 0 = 不启用）。
 * 关闭 v10 时永远放行；行上没有 activation 时不拦截（fail-open）。
 */
export function passesSalience(row = {}, cfg = V10_DEFAULTS) {
  if (!cfg || cfg.enabled !== true) return true;
  const floor = Number(cfg.salienceFloor) || 0;
  if (floor <= 0) return true;
  const a = Number(row.activation);
  if (!Number.isFinite(a)) return true;
  return a >= floor;
}
