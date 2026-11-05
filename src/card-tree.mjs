// 按主题树投影事实卡（记忆 3.0 §7）。
//
// 与 card.mjs 的区别：
// - card.mjs 按「用户的事 / 我的事」+ tier 排序，是扁平的；同一主题的事实会散落各处；
// - 这里按 topic 树分组：一个主题一行主条目，槽位按词表顺序排，
//   「极速谷6 → 版本：顶级版 / 最爱：M9 GT9RS」。
//
// 合并规则（2026-11-04 起走 card-hygiene）：
// - 单值槽位只留一条「最完整的」值，而不是盲取最新（截断值会毁掉整行）；
// - 多值槽位先清洗、去近似重复，再按 tier/新近封顶；
// - 器材/游戏/版本是实体槽位，别的槽位里复述它们的值直接丢弃；
// - 记忆系统自身的技术噪声（方案/注入/轮转…）不进卡。
//
// 不变量：
// - hard 事实永远优先，不会被主题排序挤掉；
// - 没有挂主题的事实按老方式兜底进「其他」，不丢；
// - 超预算时从最低优先级的主题整块丢弃，末行注明「（其余条目已省略）」。
import { SLOT_ORDER, SLOT_LABEL, SINGLE_VALUE_SLOTS, groupByTopic, rootOf } from './topics.mjs';
import { PARITY_LABEL, WEEK_LABEL } from './schedule.mjs';
import { toEntries, selectSingle, pruneCrossSlot, capEntries, capEvents, entityOf, cleanValue } from './card-hygiene.mjs';

export const TREE_HEADER = '【长期记忆（事实卡）】';

// 旧事行里每条值最多 40 字，尽量在标点处收口，别把一句话切成半个词。
function clipOldValue(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const p = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('。'), cut.lastIndexOf('、'), cut.lastIndexOf(' '));
  const body = p >= 12 ? cut.slice(0, p) : cut;
  return body + '…';
}

const TIER_RANK = { hard: 3, long: 2, general: 1, temp: 0 };

// 多值槽位默认封顶；mentionsPerSlot 只作为统一下限/上限兜底。
const SLOT_CAPS = {
  pref: 3, intel: 3, note: 3, event: 2, plan: 2, gear: 2, game: 2, edition: 2, skill: 2, material: 2,
};

function normalizeCfg(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    maxChars: num(c.maxChars, 1500, 300, 6000),
    mainLineChars: num(c.mainLineChars, 160, 40, 400),
    subLineChars: num(c.subLineChars, 120, 20, 300),
    // 单条值的显示上限：老 profile 里有一句 120 字的流水账，会把整段卡挤掉；
    // 卡是投影，逐字原文在窗口/事实里，显示时截断并标「…」即可。
    valueChars: num(c.valueChars, 48, 16, 160),
    mentionsPerSlot: num(c.mentionsPerSlot, 2, 1, 5)
  };
}

function activeFacts(facts = []) {
  return (Array.isArray(facts) ? facts : []).filter(
    (f) => f && f.status !== 'invalidated' && f.status !== 'expired' && f.status !== 'merged'
  );
}

function rankOf(f) {
  return TIER_RANK[String(f?.tier || 'general')] ?? 0;
}

function scoreOf(f) {
  return (Number(f?.I) || 0) * 1000 + rankOf(f) * 100 + Math.min(99, Number(f?.hits) || 0);
}

// 截断后可能留下半个括号（「…（小名」），补一个收尾：要么补全，要么切到括号前。
function balanceTail(text) {
  const t = String(text || '');
  let depth = 0;
  let lastOpen = -1;
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '（') {
      depth += 1;
      lastOpen = i;
    } else if (t[i] === '）') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) lastOpen = -1;
    }
  }
  if (depth === 0) return t;
  const cut = lastOpen >= 0 ? t.slice(0, lastOpen) : t.replace(/（/g, '');
  return cut.replace(/[，、；：\s]+$/, '') + '…';
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function slotRank(slot) {
  const i = SLOT_ORDER.indexOf(slot);
  return i < 0 ? 99 : i;
}

// 课程表按结构化字段渲染，避免卡里出现「周五早八…」这种没法算日期的自由文本。
function courseValueOf(f) {
  const c = f.course && typeof f.course === 'object' ? f.course : null;
  if (!c || !Array.isArray(WEEK_LABEL)) return f.value || f.text || '';
  const day = WEEK_LABEL[Number(c.day)];
  if (!day) return f.value || f.text || '';
  const time = c.start ? `${c.start}${c.end ? `–${c.end}` : ''}` : '';
  const parity = c.parity && c.parity !== 'all' ? `（${PARITY_LABEL[c.parity] || c.parity}）` : '';
  const loc = c.location ? ` · ${c.location}` : '';
  const name = c.name || String(f.value || '').split(/[：:]/)[0] || '课程';
  return `${name}：${day}${time ? ` ${time}` : ''}${parity}${loc}`;
}

/** 把一个主题下的事实按槽位收成 entry 列表，并做跨槽位去重。 */
function slotEntriesOf(topicFacts) {
  const bySlot = new Map();
  for (const f of topicFacts) {
    const slot = String(f.slot || 'note');
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(f);
  }
  const raw = {};
  for (const [slot, list] of bySlot) {
    const vals = list.map((f) => (slot === 'course' ? courseValueOf(f) : (f.value || f.text)));
    raw[slot] = toEntries(vals, list, { slot });
  }
  return pruneCrossSlot(raw);
}

/** @returns {{text:string, body:string, included:Array, dropped:Array, chars:number, groups:Array}} */
export function buildTreeCard(facts = [], rawCfg = {}, topics = []) {
  const cfg = normalizeCfg(rawCfg);
  const withTime = rawCfg.timeEnabled !== false;
  const all = activeFacts(facts).filter((f) => !(withTime && f.expired));
  // 过期的事实不删，只在主题末尾收一行「旧事」——过了那晚的「今晚计划」不该还在「现在」里。
  const expiredFacts = withTime ? activeFacts(facts).filter((f) => f.expired) : [];
  if (!all.length) return { text: '', body: '', included: [], dropped: [], chars: 0, groups: [] };

  // 主体纠偏：身份类槽位按值里的证据重新归到【用户】或【助手】。
  // 「助手的名字/生日」被抽成 t-identity 时，卡上会读成用户叫小助手 —— 这里挪回去。
  const IDENTITY_SLOTS = new Set(['identity', 'nickname', 'birthday', 'residence', 'job', 'school', 'pref']);
  const mapped = all.filter((f) => f.topicId).map((f) => {
    const slot = String(f.slot || '');
    // 生日这类结构化字段自带 who，以字段为准（比如「3月15日小助手生日，用户答应饭管够」
    // 句子里两个人都有，但它生日属于助手）。
    if (slot === 'birthday' && f.birthday && f.birthday.who) {
      return { ...f, topicId: f.birthday.who === 'bot' ? 't-bot' : 't-identity' };
    }
    if (!IDENTITY_SLOTS.has(slot)) {
      return entityOf(f.value || f.text || '') === 'mixed' ? { ...f, topicId: 't-us' } : f;
    }
    const e = entityOf(f.value || f.text || '');
    // 一句话里两个人都有（「3月15日小助手生日，用户答应饭管够」）→ 单独归到「我们之间」。
    if (e === 'mixed') return { ...f, topicId: 't-us' };
    if (e === 'bot' && f.topicId !== 't-bot') return { ...f, topicId: 't-bot' };
    if (e === 'owner' && f.topicId === 't-bot') return { ...f, topicId: 't-identity' };
    return f;
  });
  const orphans = all.filter((f) => !f.topicId);
  const grouped = groupByTopic(mapped, topics);
  const topicMeta = new Map(grouped.map((g) => [g.topicId, g.topic]));

  // 主题 → 事实（保留原始事实，槽位选择交给 card-hygiene）
  const factsByTopic = new Map();
  for (const f of mapped) {
    if (!factsByTopic.has(f.topicId)) factsByTopic.set(f.topicId, []);
    factsByTopic.get(f.topicId).push(f);
  }

  const byRoot = new Map();
  for (const [topicId, list] of factsByTopic) {
    const root = rootOf(topics, topicId) || { id: topicId, name: topicId };
    if (!byRoot.has(root.id)) byRoot.set(root.id, { root, parts: [] });
    byRoot.get(root.id).parts.push({ topicId, topic: topicMeta.get(topicId) || root, list });
  }

  const rootList = [...byRoot.values()].map(({ root, parts }) => {
    const facts = parts.flatMap((p) => p.list);
    const hard = facts.filter((f) => f.tier === 'hard').length;
    const last = Math.max(0, ...facts.map((f) => Number(f.lastAt || f.at) || 0));
    return { root, parts, hard, last };
  });
  rootList.sort((a, b) => {
    // 「用户」永远第一；其余按 hard 数量、最近活跃排。
    if (a.root.id === 't-identity') return -1;
    if (b.root.id === 't-identity') return 1;
    return b.hard - a.hard || b.last - a.last || String(a.root.name).localeCompare(String(b.root.name));
  });

  const included = [];
  const dropped = [];
  const cardGroups = [];
  let used = 0;
  const budget = cfg.maxChars - TREE_HEADER.length - 1;

  const pushBlock = (text, factList) => {
    const block = text.trim();
    if (!block) return false;
    const cost = block.length + 2;
    if (used + cost > budget) return false;
    blocks.push(block);
    used += cost;
    for (const f of factList) if (f) included.push(f);
    return true;
  };
  const blocks = [];

  /** 一个主题段：返回 [{text, entries}]。 */
  const renderTopic = (part, lineMax, maxSlots) => {
    const slots = slotEntriesOf(part.list);
    const keys = Object.keys(slots).sort((a, b) => slotRank(a) - slotRank(b));
    const items = [];
    const vclip = (v) => {
      const t = String(v || '').replace(/\s+/g, ' ').trim();
      return t.length > cfg.valueChars ? balanceTail(t.slice(0, cfg.valueChars - 1) + '…') : t;
    };
    for (const slot of keys.slice(0, maxSlots)) {
      const entries = slots[slot];
      if (!entries || !entries.length) continue;
      // 生日不渲染成长句：直接读结构化 birthday 字段，输出「生日：2007年9月5日」。
      if (slot === 'birthday') {
        const best = new Map();
        for (const e of entries) {
          const b = e.fact && e.fact.birthday;
          if (!b || !b.key) continue;
          const cur = best.get(b.key);
          if (!cur || (!cur.y && b.y)) best.set(b.key, { ...b, fact: e.fact });
        }
        if (best.size) {
          const texts = [...best.values()].map((b) => (b.y ? `${b.y}年${b.m}月${b.d}日` : `${b.m}月${b.d}日`));
          items.push({
            text: balanceTail(clip(`生日：${texts.join('、')}`, lineMax)),
            entries: [...best.values()].map((b) => ({ slot: 'birthday', value: b.key, fact: b.fact }))
          });
          continue;
        }
      }
      const label = SLOT_LABEL[slot] || slot;
      let picked;
      if (SINGLE_VALUE_SLOTS.has(slot)) {
        const value = selectSingle(entries);
        if (!value) continue;
        const fact = entries.find((e) => e.value === value)?.fact || entries[0].fact;
        picked = [{ value, fact }];
      } else {
        const cap = Math.max(1, Math.min(5, SLOT_CAPS[slot] || cfg.mentionsPerSlot));
        picked = slot === 'event' ? capEvents(entries, cap) : capEntries(entries, cap);
      }
      const line = balanceTail(clip(`${label}：${picked.map((e) => vclip(e.value)).join('、')}`, lineMax));
      if (!line) continue;
      items.push({ text: line, entries: picked.map((e) => ({ slot, value: e.value, fact: e.fact })) });
    }
    return { items };
  };

  // 先渲染每个根主题的完整候选，再按「每家至少一行 + 剩余预算按权重分配」落卡，
  // 这样【极速谷6】【升学】这种小簇不会被【助手】这类大段整块挤掉。
  const plans = [];
  for (const item of rootList) {
    const own = [];
    const rootName = String(item.root.name || '未命名');
    for (const part of item.parts.filter((p) => p.topicId === item.root.id)) {
      own.push(...renderTopic(part, cfg.subLineChars, 99).items);
    }
    const childHeads = [];
    const childRest = [];
    const children = item.parts
      .filter((p) => p.topicId !== item.root.id)
      .sort((a, b) => String(a.topic?.name || a.topicId).localeCompare(String(b.topic?.name || b.topicId)));
    for (const child of children) {
      const r = renderTopic(child, cfg.subLineChars, 6);
      if (!r.items.length) continue;
      // 标题和第一行绑成一个 item：预算只够一行时，不能只剩一个空【华光】标题。
      const headText = `  【${String(child.topic?.name || child.topicId).slice(0, 12)}】\n  ${r.items[0].text}`;
      childHeads.push({ text: headText, entries: r.items[0].entries });
      childRest.push(...r.items.slice(1).map((it) => ({ text: '  ' + it.text, entries: it.entries })));
    }
    // 子主题排在前面：预算被切成一两行时，【华光】【学业】这类子树也不会整段消失。
    const items = [...childHeads, ...own, ...childRest];
    if (!items.length) continue;
    plans.push({ root: item.root, rootName, items, rootId: item.root.id });
  }

  // 旧事行：每个根主题末尾一条，最多 3 件，带日期（10-29）。过期不等于删除，只是降级展示。
  if (expiredFacts.length) {
    const byRootOld = new Map();
    for (const f of expiredFacts) {
      const root = rootOf(topics, f.topicId) || { id: f.topicId || '' };
      if (!byRootOld.has(root.id)) byRootOld.set(root.id, []);
      byRootOld.get(root.id).push(f);
    }
    for (const p of plans) {
      const list = (byRootOld.get(p.rootId) || []).sort((a, b) => Number(b.saidAt || 0) - Number(a.saidAt || 0)).slice(0, 3);
      if (!list.length) continue;
      const parts = list.map((f) => {
        // 旧事行同样过清洗：技术噪声（记忆/日志/注入…）不进卡。
        const clean = cleanValue(f.value, { slot: 'event' }) || '';
        if (!clean) return '';
        const date = f?.dates?.[0]?.date || (f.saidAt ? new Date(Number(f.saidAt) + 8 * 3600e3).toISOString().slice(5, 10) : '');
        const val = clipOldValue(clean, 40);
        return date ? `${date.slice(5)} ${val}` : val;
      }).filter(Boolean);
      if (!parts.length) continue;
      p.items.push({ old: true, text: balanceTail(clip(`旧事：${parts.join('；')}`, cfg.subLineChars)), entries: list.map((f) => ({ slot: f.slot || 'event', value: f.value, fact: f })) });
    }
  }

  const blockLen = (p, n) => `【${p.rootName}】\n${p.items.slice(0, n).map((i) => i.text).join('\n')}`.length + 2;
  const lineLen = (p, i) => p.items[i].text.length + 1;
  let need = 0;
  for (const p of plans) need += Math.min(blockLen(p, 1), lineLen(p, 0) + p.rootName.length + 4);
  // 给「旧事」行预留位置：它们排在每个主题末尾，预算被第一遍的分额吃光时会被挤掉。
  let oldReserve = 0;
  for (const p of plans) {
    const oldIndex = p.items.findIndex((i) => i.old);
    if (oldIndex < 0) continue;
    oldReserve += blockLen(p, oldIndex + 1) - blockLen(p, oldIndex) + 1;
  }
  need += Math.min(oldReserve, Math.max(0, Math.floor(budget * 0.2)));
  let remaining = Math.max(0, budget - need);
  const weightOf = (p) => {
    const facts = p.items.flatMap((i) => i.entries.map((e) => e.fact));
    const hard = facts.filter((f) => f && f.tier === 'hard').length;
    const newest = Math.max(0, ...facts.map((f) => Number(f?.lastAt) || 0));
    return 1 + hard * 4 + facts.length * 0.5 + (Date.now() - newest < 86400000 * 3 ? 2 : 0);
  };
  const totalWeight = plans.reduce((a, p) => a + weightOf(p), 0) || 1;
  const keep = new Map();
  for (const p of plans) {
    const base = Math.max(1, Math.min(p.items.length, 1));
    let n = base;
    let cost = blockLen(p, n);
    const extra = Math.floor((remaining * weightOf(p)) / totalWeight);
    let extraLeft = extra;
    while (n < p.items.length && extraLeft > 0) {
      const add = lineLen(p, n) + 1;
      if (add > extraLeft) break;
      n += 1;
      extraLeft -= add;
      cost = blockLen(p, n);
    }
    keep.set(p, n);
  }

  // 第二遍：第一遍按权重分完后常有剩余预算（每个主题的行数被份额卡死），把旧事行和其他剩余行补回来。
  let usedAfter = plans.reduce((a, p) => a + (keep.get(p) ? blockLen(p, keep.get(p)) : 0), 0);
  let left = budget - usedAfter;
  for (const p of plans) {
    const n = keep.get(p) || 0;
    const oldIndex = p.items.findIndex((i) => i.old);
    if (oldIndex < 0 || oldIndex < n) continue;
    const add = blockLen(p, oldIndex + 1) - blockLen(p, n);
    if (add > left) continue;
    keep.set(p, oldIndex + 1);
    left -= add;
  }
  let guard = 0;
  while (left > 0 && guard++ < 500) {
    let grew = false;
    for (const p of plans) {
      const n = keep.get(p) || 0;
      if (n >= p.items.length) continue;
      const add = blockLen(p, n + 1) - blockLen(p, n);
      if (add > left) continue;
      keep.set(p, n + 1);
      left -= add;
      grew = true;
    }
    if (!grew) break;
  }

  for (const p of plans) {
    const n = keep.get(p) || 0;
    if (!n) continue;
    const picked = p.items.slice(0, n);
    const blockFacts = [];
    const cardSlots = [];
    for (const it of picked) {
      for (const e of it.entries) { blockFacts.push(e.fact); cardSlots.push(e); }
    }
    const block = `【${p.rootName}】\n${picked.map((i) => i.text).join('\n')}`;
    if (pushBlock(block, blockFacts)) cardGroups.push({ root: p.root, slots: cardSlots });
    else for (const f of blockFacts) dropped.push(f);
  }

  // 没挂主题的事：硬事实优先，按老格式兜底
  const orphanSorted = orphans
    .filter((f) => String(f.class || 'note') !== 'chat')
    .sort((a, b) => scoreOf(b) - scoreOf(a) || (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0));
  if (orphanSorted.length) {
    const lines = [];
    const list = [];
    for (const f of orphanSorted) {
      const body = clip(f.value || f.text || '', cfg.mainLineChars);
      if (!body) continue;
      lines.push(`· ${body}`);
      list.push(f);
      if (lines.join('\n').length > cfg.maxChars) break;
    }
    if (lines.length) {
      const block = `【其他】\n${lines.join('\n')}`;
      if (!pushBlock(block, list)) {
        const hardOnly = list.filter((f) => f.tier === 'hard');
        if (hardOnly.length) {
          const retry = `【其他】\n${hardOnly.map((f) => `· ${clip(f.value || '', cfg.subLineChars)}`).join('\n')}`;
          if (!pushBlock(retry, hardOnly)) hardOnly.forEach((f) => dropped.push(f));
        }
        list.filter((f) => !included.includes(f)).forEach((f) => dropped.push(f));
      }
    }
  }

  if (!blocks.length) return { text: '', body: '', included: [], dropped, chars: 0, groups: cardGroups };

  const partial = blocks.join('\n\n');
  const note = dropped.length ? '\n…（其余条目已省略）' : '';
  let body = `${partial}${note}`;
  if (body.length > cfg.maxChars) {
    // 兜底裁剪必须整行丢，不能从中间切断：切断会留下半个括号、半句话，
    // 卡面看上去像记忆本身残缺，而不是「这张卡放不下」。
    const lines = body.split('\n');
    lines.pop(); // 先去掉末尾的省略注记，稍后重写
    while (lines.length > 1 && `${lines.join('\n')}\n…（另有条目因字数上限未展开）`.length > cfg.maxChars) lines.pop();
    body = `${lines.join('\n')}\n…（另有条目因字数上限未展开）`;
  }
  return { text: `${TREE_HEADER}\n${body}`, body, included, dropped, chars: body.length, groups: cardGroups };
}

/** 卡片里用了哪些主题（工作台「主题簇」面板用）。 */
export function topicsInCard(result) {
  return (result?.groups || []).map((g) => ({
    topicId: g.root?.id || g.topicId,
    name: g.root?.name || g.topicId,
    slots: (g.slots || []).map((s) => ({ slot: s.slot || '', label: SLOT_LABEL[s.slot] || '', value: s.value || '' })).filter((s) => s.label)
  }));
}

export { SLOT_ORDER };
