// 事实卡合并规则（记忆 3.0 §7 补充）。
//
// 目标：同一主题、同一槽位只呈现「一条能读的答案」，而不是把抽取残渣、截断值、
// 换个说法的重复值、跨槽位串味的器材清单全堆在一起。
//
// 全部是确定性规则（不调模型），所以可以单测、可以解释、可以回滚：
//   1. 清洗：去空白、去截断残句、去记忆系统自身的技术噪声；
//   2. 选值：单值槽位选「最完整的一条」，多值槽位去重后按 tier/新近排序并封顶；
//   3. 跨槽位去重：器材/游戏/版本这类「实体槽位」是权威，别的槽位里重复它们的内容丢掉；
//   4. 近似重复：编号重叠（Z8X / 2875ZA）、互相包含、中文二元组高重合都算同一条。
//
// 这里统一用 entry = { value, fact } 表示候选，避免字符串数组和事实数组下标错位。

export const META_NOISE_RE = /(记忆方案|记忆引擎|记忆系统|事实卡上限|注入预算|轮转阈值|上下文窗口|滚动窗口|7\s*天热备|冷备份方案|脱敏|影子测试)/;

const TIER_RANK = { hard: 3, long: 2, general: 1, temp: 0 };

export function tierOf(f) {
  return TIER_RANK[String(f?.tier || 'general')] ?? 1;
}

export function atOf(f) {
  return Number(f?.lastAt || f?.at) || 0;
}

/** 把一段值切成可比较的 token：拉丁词/数字 + 中文二元组。 */
export function tokensOf(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/[A-Za-z]+|\d+/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/[A-Za-z0-9]+(?:[\s\-_]+[A-Za-z0-9]+)*/g)) {
    const compact = m[0].replace(/[\s\-_]+/g, '').toLowerCase();
    if (compact.length >= 3) out.add(compact);
  }
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cjk.length - 1; i += 1) out.add(cjk.slice(i, i + 2));
  // 单字符片段（Z8X 被字母/数字拆出来的 a、7、r、3）只会稀释重合度。
  for (const t of [...out]) if (t.length < 2) out.delete(t);
  return out;
}

/** 括号是否配对（截断值常见「助手（小名小助手」这种）。 */
export function balanced(text) {
  const s = String(text || '');
  let depth = 0;
  for (const ch of s) {
    if ('（(['.includes(ch)) depth += 1;
    else if ('）)]'.includes(ch)) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * 清洗单条值。返回空串表示这条不该进卡。
 * - 去掉末尾被截断的括号尾巴（「助手（小名小助手」→「助手」）；
 * - 去掉记忆系统自身的技术噪声（那不是用户，也不是她）；
 * - 太短又没有实义（「画手生」）的残句丢掉。
 */
const OWNER_RE = /(用户|咱|俺|本人|我(?!们))/;
const BOT_RE = /(助手|小助手|人家)/;

/**
 * 判定一条值的主体：owner / bot / mixed / ''。
 * 用于把「助手的名字」从【用户】主题里挪回【助手】，避免卡上读成用户叫小助手。
 */
export function entityOf(text) {
  const s = String(text || '');
  const owner = OWNER_RE.test(s);
  const bot = BOT_RE.test(s);
  if (owner && bot) {
    // 混着两个人时看句子主语：开头是她 → 她的事；开头是用户/我 → 用户的事。
    // 并列主语（「助手和用户」）算 mixed；否则以句首主语为准。
    if (/^.{0,6}(和|与|跟|及)/.test(s.slice(0, 10))) return 'mixed';
    const head = s.slice(0, 4);
    if (BOT_RE.test(head) && !OWNER_RE.test(head)) return 'bot';
    if (OWNER_RE.test(head) && !BOT_RE.test(head)) return 'owner';
    return 'mixed';
  }
  if (bot) return 'bot';
  if (owner) return 'owner';
  return '';
}

const NOUN_SLOTS = new Set(['identity', 'nickname', 'birthday', 'residence', 'job', 'school', 'edition', 'game', 'gear', 'skill', 'food', 'pet', 'contact']);

export function cleanValue(raw, opts = {}) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (META_NOISE_RE.test(s)) return '';
  let repaired = false;
  if (!balanced(s)) {
    const cut = Math.max(s.lastIndexOf('（'), s.lastIndexOf('('));
    s = (cut > 0 ? s.slice(0, cut) : s).trim();
    if (!s) return '';
    repaired = true;
  }
  s = s.replace(/[，、；：,;:]+$/, '').trim();
  // 短名词（顶级版 / 5060 / Z8X）是正常值；叙事槽位里的两三个字残句才是噪声。
  const nouny = NOUN_SLOTS.has(String(opts.slot || ''));
  if (!repaired && !nouny && s.length < 4 && !/[A-Za-z0-9]/.test(s)) return '';
  return s;
}

/** a 被 b 覆盖的比例（0~1）。 */
export function coverage(a, b) {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / ta.size;
}

/** 两条值是不是「同一条」的两种说法。 */
/** 型号/编号（Z8X、2875ZA、100-400、5060）是强信号：两个值共享同一批型号，就是同一条。 */
function modelIds(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/[A-Za-z0-9]+(?:[\s\-_]+[A-Za-z0-9]+)*/g)) {
    const t = m[0].replace(/[\s\-_]+/g, '').toLowerCase();
    if (t.length >= 3 && /\d/.test(t)) out.add(t);
  }
  return out;
}

function idsNear(a, b) {
  const ia = modelIds(a);
  const ib = modelIds(b);
  if (!ia.size || !ib.size) return false;
  let hit = 0;
  for (const t of ia) if (ib.has(t)) hit += 1;
  return hit >= 2 && hit / Math.min(ia.size, ib.size) >= 0.6;
}

export function nearDup(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  if (idsNear(a, b)) return true;
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.size < 2 || tb.size < 2) return false;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit >= 2 && hit / Math.min(ta.size, tb.size) >= 0.5;
}

export function toEntries(values, facts = [], opts = {}) {
  return (Array.isArray(values) ? values : []).map((v, i) => ({ value: cleanValue(v, opts), fact: facts[i] || null })).filter((e) => e.value);
}

/** 去重：同一条说法只留更完整的那条（事实取更完整那条的）。 */
export function dedupeEntries(entries) {
  const out = [];
  for (const e of entries) {
    const idx = out.findIndex((x) => nearDup(x.value, e.value));
    if (idx >= 0) {
      if (e.value.length > out[idx].value.length) out[idx] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}

/** 排序：tier 高在前，其次新近。 */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => tierOf(b.fact) - tierOf(a.fact) || atOf(b.fact) - atOf(a.fact));
}

/** 单值槽位：在候选里挑「最完整、最新、tier 最高」的一条。 */
export function selectSingle(entries) {
  const list = entries.filter((e) => e.value);
  if (!list.length) return '';
  const score = (e) => e.value.length + tierOf(e.fact) * 12 + Math.min(20, atOf(e.fact) / 1e12);
  return [...list].sort((a, b) => score(b) - score(a))[0].value;
}

/**
 * 跨槽位去重：实体槽位（器材/游戏/版本）是「权威」，别的槽位里重复它的内容丢掉。
 * @param {Record<string, Array<{value:string,fact:object}>>} slotEntries
 * @param {string[]} canonical 权威槽位
 */
export function pruneCrossSlot(slotEntries, canonical = ['gear', 'game', 'edition']) {
  const out = {};
  const canon = canonical.flatMap((s) => (slotEntries[s] || []).map((e) => e.value)).filter(Boolean);
  for (const [slot, arr] of Object.entries(slotEntries)) {
    const entries = dedupeEntries(arr);
    out[slot] = entries.filter((e) => {
      if (canonical.includes(slot)) return true;
      return !canon.some((c) => (c && coverage(c, e.value) >= 0.8) || nearDup(c, e.value));
    });
  }
  return out;
}

/** 多值槽位封顶。 */
export function capEntries(entries, max = 3) {
  return sortEntries(entries).slice(0, Math.max(1, max));
}

/** 事件类槽位排序：越具体（有日期、够长）越靠前。 */
export function capEvents(entries, max = 2) {
  const score = (e) => {
    const dated = /(\d{1,2}\s*月\s*\d{1,2}|20\d{2})/.test(e.value) ? 40 : 0;
    return tierOf(e.fact) * 30 + dated + Math.min(40, e.value.length);
  };
  return [...entries].sort((a, b) => score(b) - score(a) || atOf(b.fact) - atOf(a.fact)).slice(0, Math.max(1, max));
}
