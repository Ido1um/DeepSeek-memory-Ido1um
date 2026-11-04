// 主题（topic）+ 槽位（slot）：把扁平事实挂成一棵树。
//
// 目的（记忆 3.0 §3、§7）：
// - 「极速谷6」这条主题下面挂「版本：顶级版」「最爱：M9 GT9RS」，而不是三条互不相干的记忆；
// - 「摄影」下面挂「器材：Z8X / 2875ZA / 示例镜头厂100-400」「身份：学校融媒体中心官方摄影师」；
// - 事实卡按主题树投影（主行 + └ 子行），同主题同槽只留最新。
//
// 设计约束：
// - topic 是**独立真源**（state/topics.jsonl），事实只引用 topicId + slot，不改事实本身的 sig/value；
// - slot 受控词表，分类器只做「保守映射」：拿不准就留空并写进 review 文件，绝不硬塞；
// - 迁移是**追加式**的：给老事实补 ev:'update' 事件（topicId/slot），不重写历史行，随时可回滚。
import fs from 'node:fs';
import path from 'node:path';

export const TOPIC_VERSION = 1;

/** 受控槽位词表（写入前必须命中其一；review 里可以出现自由槽位供人工确认）。 */
export const SLOTS = [
  'identity', 'nickname', 'birthday', 'residence', 'job', 'school', 'skill',
  'gear', 'game', 'edition', 'pref', 'pet', 'plan', 'event', 'note',
  'intel', 'stance', 'material', 'progress', 'routine', 'food', 'contact'
];

/** 卡片投影时的排序：先人，再关系，再在做的事，最后杂项。 */
export const SLOT_ORDER = [
  'identity', 'nickname', 'birthday', 'residence', 'job', 'school', 'skill',
  'gear', 'game', 'edition', 'pref', 'pet', 'food', 'routine',
  'plan', 'progress', 'intel', 'material', 'stance', 'event', 'note', 'contact'
];

export const SLOT_LABEL = {
  identity: '身份', nickname: '称呼', birthday: '生日', residence: '住处', job: '工作',
  school: '学校', skill: '技能', gear: '器材', game: '游戏', edition: '版本', pref: '偏好',
  pet: '宠物', plan: '计划', event: '事件', note: '备注', intel: '情报',
  stance: '态度', material: '资料', progress: '进度', routine: '作息', food: '口味',
  contact: '联系方式'
};

export function topicsFile(dir) {
  return path.join(String(dir || ''), 'state', 'topics.jsonl');
}

export function readTopics(dir) {
  const file = topicsFile(dir);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && row.id) rows.push(row);
    } catch {
      // 半行/坏行跳过，不让一个坏字节毁掉整棵树
    }
  }
  return rows;
}

export function writeTopics(dir, rows = []) {
  const file = topicsFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(tmp, body ? `${body}\n` : '');
  fs.renameSync(tmp, file);
  return rows.length;
}

/** 追加/覆盖一个主题（按 id 幂等）。 */
export function upsertTopic(dir, topic) {
  const rows = readTopics(dir);
  const i = rows.findIndex((r) => r.id === topic.id);
  if (i >= 0) rows[i] = { ...rows[i], ...topic };
  else rows.push(topic);
  writeTopics(dir, rows);
  return topic;
}

export function topicById(topics, id) {
  return (topics || []).find((t) => t.id === id) || null;
}

/** 一条主题链（根 → 叶子），用于卡片分组。 */
export function topicPath(topics, id) {
  const out = [];
  let cur = topicById(topics, id);
  let guard = 0;
  while (cur && guard < 8) {
    out.unshift(cur);
    cur = cur.parentId ? topicById(topics, cur.parentId) : null;
    guard += 1;
  }
  return out;
}

export function rootOf(topics, id) {
  const p = topicPath(topics, id);
  return p[0] || null;
}

/** 新建主题（同名已存在则复用）。 */
export function ensureTopic(dir, { id, name, parentId = '', aliases = [], note = '' } = {}) {
  const tid = String(id || slugOf(name)).trim();
  if (!tid) return null;
  const rows = readTopics(dir);
  const found = rows.find((r) => r.id === tid || (name && r.name === name));
  if (found) return found;
  const row = {
    v: TOPIC_VERSION,
    id: tid,
    name: String(name || tid).slice(0, 12),
    parentId: String(parentId || ''),
    aliases: Array.isArray(aliases) ? aliases.map(String).slice(0, 8) : [],
    note: String(note || ''),
    createdAt: new Date().toISOString()
  };
  rows.push(row);
  writeTopics(dir, rows);
  return row;
}

export function slugOf(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

// ── 分类器：老事实 → (topicId, slot) ───────────────────────────────────────
// 只覆盖「已经确认存在的主题」；返回 confidence，低于阈值就交给 review。
const RULES = [
  // 学业（课业/作业/期中期末）先判：否则「华光」的学校关键词会把课业也算进考研主题
  { topic: 't-study', slot: 'event', re: /课业|作业|实验报告|期中|期末|听写|默写|课程|卷子|交\s*dsh/i },
  { topic: 't-study', slot: 'progress', re: /复习|刷题|备考|预习/i },
  { topic: 't-identity', slot: 'birthday', re: /生日|birthday/i },
  { topic: 't-identity', slot: 'nickname', re: /称呼|叫你|取名|名字|昵称/i },
  { topic: 't-identity', slot: 'identity', re: /身份|本人|专业|年级|大二|大三|物理/i },
  { topic: 't-identity', slot: 'school', re: /学校|大学|示例学院|学院|录取/i },
  { topic: 't-identity', slot: 'residence', re: /住在|宿舍|老家|城市|示例城市|示例省份/i },
  { topic: 't-photo', slot: 'gear', re: /摄影|相机|镜头|Z8X|2875|示例镜头厂|长焦|器材/i },
  { topic: 't-photo', slot: 'skill', re: /摄影|拍摄|摄影师|融媒体/i },
  { topic: 't-horizon6', slot: 'game', re: /极速谷\s*[456]|RacingX|赛车游戏/i },
  { topic: 't-horizon6', slot: 'edition', re: /顶级版|豪华版|标准版|预购/i },
  { topic: 't-horizon6', slot: 'pref', re: /GT9\s*RS|示例车厂|M9/i },
  { topic: 't-hust', slot: 'intel', re: /华光|081200|140600|300|考试科目|招生/i },
  { topic: 't-hust', slot: 'stance', re: /想考|目标|本来喜欢|榜样/i },
  { topic: 't-hust', slot: 'material', re: /参考书|教材|真题|资料/i },
  { topic: 't-hust', slot: 'progress', re: /复习|试水|进度|看完|刷题/i },
  { topic: 't-baoyan', slot: 'stance', re: /考研|示例专业|示例单位|示例学院/i },
  { topic: 't-baoyan', slot: 'plan', re: /考研|推免/i },
  { topic: 't-bot', slot: 'pref', re: /机器人|人设|形象|裙子/i },
  { topic: 't-bot', slot: 'identity', re: /助手|小助手|DeepSeek|机器人/i },
  { topic: 't-food', slot: 'food', re: /爱吃|不吃|口味|米饭|酸奶|西瓜|辣/i },
  { topic: 't-routine', slot: 'routine', re: /作息|早八|晚睡|几点|睡觉|起床/i },
  { topic: 't-life', slot: 'note', re: /./ }
];

export const DEFAULT_TOPICS = [
  { id: 't-identity', name: '用户', aliases: ['用户', '他'] },
  { id: 't-us', name: '我们之间', aliases: ['我们', '用户和小助手', '一起'] },
  { id: 't-study', name: '学业', parentId: 't-identity', aliases: ['课业', '作业', '上课'] },
  { id: 't-photo', name: '摄影', aliases: ['摄影', '拍照', '相机'] },
  { id: 't-horizon6', name: '极速谷6', aliases: ['极速谷', 'RacingX'] },
  { id: 't-hust', name: '华光', parentId: 't-plan', aliases: ['华光', '示例大学', '081200'] },
  { id: 't-baoyan', name: '考研', parentId: 't-plan', aliases: ['考研', '推免'] },
  { id: 't-plan', name: '升学', aliases: ['考研', '升学', '读研'] },
  { id: 't-bot', name: '助手', aliases: ['助手', '我', '小助手'] },
  { id: 't-food', name: '吃喝', aliases: ['吃', '喝', '口味'] },
  { id: 't-routine', name: '作息', aliases: ['作息', '早八', '睡觉'] },
  { id: 't-life', name: '杂事', aliases: [] }
];

/** 给事实猜 (topicId, slot)；返回 {topicId, slot, confidence, reason}。 */
export function classifyFact(fact = {}) {
  const text = [fact.value, fact.label, fact.sig, fact.pattern, fact.text].filter(Boolean).join(' ');
  if (!text.trim()) return { topicId: '', slot: '', confidence: 0, reason: '空事实' };
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      const confidence = rule.topic === 't-life' ? 0.3 : 0.75;
      return { topicId: rule.topic, slot: rule.slot, confidence, reason: `rule:${rule.slot}` };
    }
  }
  return { topicId: '', slot: '', confidence: 0, reason: '未命中' };
}

/** 单值槽位：同一主题下只该有一个当前值；其余槽位是多值（可并列多条）。 */
export const SINGLE_VALUE_SLOTS = new Set([
  'identity',
  'nickname',
  'birthday',
  'residence',
  'job',
  'school',
  'edition',
  'game',
  'plan',
  'progress',
  'stance',
  'routine',
  'food',
  'contact'
]);

/** 把事实按主题分组（卡片投影用）。单值槽位保留最后一条，多值槽位按时间并列（最多 3 条）。 */
export function groupByTopic(facts = [], topics = []) {
  const groups = new Map();
  for (const f of facts) {
    const tid = String(f.topicId || '');
    if (!tid) continue;
    const slot = String(f.slot || '') || 'note';
    if (!groups.has(tid)) groups.set(tid, { topicId: tid, slots: new Map() });
    const g = groups.get(tid);
    const ts = Number(f.lastAt || f.at || 0);
    const prev = g.slots.get(slot);
    if (SINGLE_VALUE_SLOTS.has(slot)) {
      if (!prev || ts >= prev.ts) g.slots.set(slot, { slot, fact: f, ts, facts: [f] });
      continue;
    }
    if (!prev) {
      g.slots.set(slot, { slot, fact: f, ts, facts: [f] });
    } else {
      prev.facts.push(f);
      prev.facts.sort((a, b) => Number(a.lastAt || a.at || 0) - Number(b.lastAt || b.at || 0));
      if (prev.facts.length > 2) prev.facts = prev.facts.slice(-2);
      prev.fact = prev.facts[prev.facts.length - 1];
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const topic = topicById(topics, g.topicId);
    const slots = [...g.slots.values()].sort(
      (a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || a.slot.localeCompare(b.slot)
    );
    out.push({ topicId: g.topicId, topic, slots });
  }
  out.sort((a, b) => String(a.topic?.name || a.topicId).localeCompare(String(b.topic?.name || b.topicId)));
  return out;
}

export function slotLabel(slot) {
  return SLOT_LABEL[slot] || slot;
}

// ── 存量纠偏：模型分类已经落盘后，按高精度信号修正明显放错主题的条目 ─────────
// 只处理「确定放错」的少量模式，不做全量重判（全量重判会把模型的好分类冲掉）。
const REFINE = [
  {
    // 课业类被挂到「华光/升学」：华光主题只放考研情报/态度/资料/进度，课业归学业
    when: (f, placement) =>
      /课业|实验报告|期中|期末|听写|默写|卷子|交\s*dsh|作业/i.test(String(f.value || '')) &&
      ['t-hust', 't-plan', 't-baoyan', 't-identity'].includes(placement.topicId),
    to: { topicId: 't-study', slot: 'event', reason: 'refine:课业归学业' }
  },
  {
    // 物理实验报告这类「要交的东西」如果被挂到杂事，也归学业事件
    when: (f, placement) => /实验报告|听写|默写|期中|期末/i.test(String(f.value || '')) && placement.topicId === 't-life',
    to: { topicId: 't-study', slot: 'event', reason: 'refine:课业归学业' }
  }
];

/** @returns {{topicId:string,slot:string,reason:string}|null} 需要纠正时返回目标，否则 null */
export function refinePlacement(fact = {}, placement = {}) {
  const current = { topicId: String(placement.topicId || ''), slot: String(placement.slot || '') };
  for (const rule of REFINE) {
    try {
      if (!rule.when(fact, current)) continue;
      if (rule.to.topicId === current.topicId && rule.to.slot === current.slot) return null;
      return { ...rule.to };
    } catch {
      /* 单条规则出错不影响其他 */
    }
  }
  return null;
}
