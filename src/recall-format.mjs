// 召回结果的可读化与空结果诊断（3.1 P2）。
//
// 单独成模块的原因：`qq_memory_recall` 的「怎么说」直接决定她能不能正确地
// 引用一条记忆、能不能顺着锚点去翻当时的窗口。逻辑放这里，MCP 层只负责拼装。
//
// 三条规则：
// 1) 自己写的事实要标出来（〔自己写的〕）——她看得到哪些是她亲口留下的。
// 2) 每条事实尽量给一个「窗口锚点」（哪一轮），没有锚点就不硬编。
// 3) 查不到时不要只说「没有」：给出路由解释、过期命中、词面相近，以及下一步。

import { readEpisodes } from './episode.mjs';
import { routeQuery, routeScore } from './route.mjs';
import { readTurns } from './window.mjs';

export const TIER_LABEL = { hard: '硬事实', long: '长期', general: '一般', temp: '临时' };

const TZ_OFFSET_MS = 8 * 3600 * 1000;

function dayOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n + TZ_OFFSET_MS);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function shortSid(sessionId = '') {
  return String(sessionId).replace(/^session-/, '').slice(0, 8);
}

export function authorTag(fact) {
  return fact?.author === 'self' ? '〔自己写的〕' : '';
}

/** 读一次 episodes，建 id → 情境段 的索引；读不到就返回空 Map（诊断不因此失败）。 */
export function episodeIndex(dir) {
  const map = new Map();
  try {
    for (const ep of readEpisodes(dir) || []) {
      if (ep?.id) map.set(ep.id, ep);
    }
  } catch {
    /* 情境段读失败不影响召回 */
  }
  return map;
}

/**
 * 一条事实对应的「当时那一轮窗口」。
 * - 她自写的事实：src = {kind:'window', sessionId, turnFrom, turnTo}
 * - 抽取的事实：source.episodeId → episodes 里的 sessionId/turnFrom/turnTo
 * - 来源只有旧日志：返回 null（MCP 会退回「原文 MM-DD」）
 */
export function anchorOf(fact, eps = null) {
  const src = fact?.src;
  if (src && src.kind === 'window' && src.sessionId && src.turnFrom) {
    return {
      kind: 'window',
      sessionId: String(src.sessionId),
      turnFrom: Number(src.turnFrom) || 0,
      turnTo: Number(src.turnTo || src.turnFrom) || 0,
      at: Number(fact.saidAt) || Number(fact.at) || 0
    };
  }
  const id = fact?.source?.episodeId;
  if (id && eps && eps.has(id)) {
    const ep = eps.get(id);
    return {
      kind: 'episode',
      episodeId: id,
      sessionId: String(ep.sessionId || ''),
      turnFrom: Number(ep.turnFrom) || 0,
      turnTo: Number(ep.turnTo) || 0,
      at: Date.parse(ep.atFrom) || Number(fact.saidAt) || 0
    };
  }
  return null;
}

export function anchorText(anchor) {
  if (!anchor || !anchor.sessionId || !anchor.turnFrom) return '';
  const day = dayOf(anchor.at);
  const turns = anchor.turnTo && anchor.turnTo !== anchor.turnFrom
    ? `${anchor.turnFrom}–${anchor.turnTo}`
    : String(anchor.turnFrom);
  return `窗口 ${day ? day + ' ' : ''}轮 ${turns}（${shortSid(anchor.sessionId)}）`;
}

/** 空结果时解释「我按什么找的」。 */
export function routeLine(route) {
  const parts = [];
  if (route?.slots?.length) parts.push(`槽位 ${route.slots.join('/')}`);
  if (route?.topics?.length) parts.push(`主题 ${route.topics.join('/')}`);
  if (route?.who === 'owner') parts.push('问的是用户');
  if (route?.who === 'bot') parts.push('问的是她自己');
  return parts.length ? `我把它当成：${parts.join(' · ')}` : '';
}

/** 给标题用的一句话路由解释（非空结果时也让调用方知道自己答的是哪一路）。 */
export function explainRoute(query = '') {
  return routeLine(routeQuery(query));
}

/**
 * 空结果诊断：不编答案，只把「为什么没找到」和「还能怎么找」说清楚。
 * 返回 { activeTotal, route, routeLine, expired:[], near:[] }。
 */
export function diagnoseRecall({ query = '', facts = [], now = Date.now(), limit = 3 } = {}) {
  const route = routeQuery(query);
  const active = facts.filter((f) => (f.status || 'active') === 'active');
  const expired = [];
  const near = [];
  for (const f of active) {
    const rs = routeScore(f, route);
    if (f.expired && (rs.slotHit || rs.topicHit)) expired.push(f);
    else if (!f.expired && rs.lexicalHits > 0) near.push({ f, n: rs.lexicalHits });
  }
  near.sort((a, b) => b.n - a.n);
  return {
    activeTotal: active.length,
    route,
    routeLine: routeLine(route),
    expired: expired.slice(0, limit).map((f) => ({ fact: f, when: dayOf(f.saidAt || f.at || now) })),
    near: near.slice(0, limit).map((x) => x.f)
  };
}

export function valueOf(fact, max = 120) {
  return String(fact?.value || fact?.text || '').replace(/\s+/g, ' ').slice(0, max);
}

/** 这一轮当时带的图片引用（只给 sha1 前 8 位，取原图用 qq_memory_photo）。 */
export function mediaAt(dir, anchor) {
  if (!dir || !anchor?.sessionId || !anchor.turnFrom) return [];
  try {
    const rows = readTurns(String(dir), String(anchor.sessionId), { limit: 500 });
    const row = rows.find((r) => Number(r?.turn) === Number(anchor.turnFrom))
      || rows.find((r) => Number(r?.turn) >= Number(anchor.turnFrom) && Number(r?.turn) <= Number(anchor.turnTo || anchor.turnFrom));
    return Array.isArray(row?.mediaRefs) ? row.mediaRefs : (Array.isArray(row?.media) ? row.media : []);
  } catch {
    return [];
  }
}

function mediaHintOf(media) {
  const list = (Array.isArray(media) ? media : []).filter((m) => m?.sha1);
  if (!list.length) return '';
  const first = list[0];
  const more = list.length > 1 ? ` 等 ${list.length} 张` : '';
  return ` 📎 有图${more}（sha1 ${String(first.sha1).slice(0, 8)}…，可用 qq_memory_photo 看）`;
}

export function rowLine(fact, { eps = null, maxValue = 120, media = [] } = {}) {
  const tier = TIER_LABEL[fact.tier] || fact.tier || '';
  const label = fact.label ? `${fact.label}：` : '';
  const value = valueOf(fact, maxValue);
  const when = fact.expired ? `（旧事 · ${dayOf(fact.saidAt || fact.at)}）` : '';
  const anchor = anchorOf(fact, eps);
  const tail = anchor ? ` ⟵ ${anchorText(anchor)}` : '';
  const head = `· [${tier} ${Math.round(Number(fact.score) || 0)}] ${authorTag(fact)}${label}${value}${when}${tail}${mediaHintOf(media)}`;
  const feel = String(fact.feel || '').replace(/\s+/g, ' ').slice(0, 40);
  if (feel) return `${head}\n  └ 我当时：${feel}`;
  const quote = String(fact.quote || '').replace(/\s+/g, ' ').slice(0, 40);
  return quote ? `${head}\n  └ 原话：${quote}` : head;
}

/** 多条结果的正文；anchors 用来提示「可以展开窗口」。 */
export function formatRecallBody(rows = [], { eps = null, dir = '' } = {}) {
  let anchors = 0;
  const body = rows.map((f) => {
    const anchor = anchorOf(f, eps);
    if (anchor) anchors++;
    const media = anchor ? mediaAt(dir, anchor) : [];
    // 来源只有旧日志的事实，保留原来的「⟵ 原文 MM-DD / 来自事实卡」
    const line = rowLine(f, { eps, media });
    if (anchors && line.includes(' ⟵ ')) return line;
    if (f.src && !anchor) {
      const src = f.src.kind === 'log'
        ? `原文 ${String(f.src.day || '').slice(5)}`
        : f.src.kind === 'card' ? '来自事实卡' : '';
      return src ? `${line} ⟵ ${src}` : line;
    }
    return line;
  }).join('\n');
  return { body, anchors };
}

export function emptyRecallText({ query = '', diag, limitWords = 3 } = {}) {
  const q = String(query || '').trim();
  const lines = [
    `长期库没有${q ? `「${q}」的` : ''}直接记录（现有 ${diag.activeTotal} 条有效事实）。`
  ];
  if (diag.routeLine) lines.push(diag.routeLine + '。');
  if (diag.expired.length) {
    lines.push(`- 有 ${diag.expired.length} 条相关但已过期：` + diag.expired.map((it) => `${it.when}「${valueOf(it.fact, 40)}」`).join('；') + '（可以当旧事说，别当现在）。');
  }
  if (diag.near.length) {
    lines.push(`- 另有 ${diag.near.length} 条只是词面相近：` + diag.near.map((f) => `「${valueOf(f, 24)}」`).join('；') + '（不够确定，别硬认）。');
  }
  lines.push(`还能怎么找：① 换更具体或同义的说法（比如把「${q || '那件事' }」拆成「谁 + 什么 + 什么时候」）；② 用 qq_memory_search 翻聊天原文；③ 记得大约哪一轮就用 qq_memory_window(sessionId, turnFrom, turnTo) 展开当时窗口。`);
  if (limitWords && diag.near.length + diag.expired.length === 0) {
    lines.push('如果确实没记过，就直接说没记过，不要编。');
  }
  return lines.join('\n');
}
