/**
 * 3.1 B：问法路由（纯函数，不读文件）。
 *
 * 作用：把「她平时怎么问」翻译成结构化条件——槽位、主题、主体——
 * 再交给 scoring-runner 做排序加权。数据层不改，只影响命中与排序。
 *
 * 三层：
 *   1) 词法：tokensOf 切词，负责「提到过某个词」
 *   2) 结构：这条问法在问什么面（生日/器材/课表…）、哪个主题（摄影/华光…）
 *   3) 主体：问的是用户还是她自己
 */

/** 问法 → 槽位。一个问法可以同时指向多个槽位（例如「游戏里最喜欢什么车」）。 */
export const SLOT_HINTS = [
  [/生日|出生|寿辰|几号生|哪天生/, ['birthday']],
  [/称呼|怎么叫|叫啥|叫我什么|小名|昵称/, ['nickname', 'identity']],
  [/器材|相机|镜头|机身|设备/, ['gear']],
  [/版本|哪一版|顶配|顶级版|买的是哪/, ['edition']],
  [/游戏|赛车|车模|示例车厂|gt3|跑车/i, ['game', 'pref']],
  [/爱好|兴趣|喜欢什么|爱吃什么|讨厌什么/, ['pref', 'hobby']],
  [/喜欢(拍|看|玩|听)|爱(拍|看|玩|听)/, ['pref']],
  [/考什么|考试科目|初试|复试|科目|招多少|招生|分数线|报录比/, ['intel']],
  [/考研|升学|考公/, ['plan', 'progress']],
  [/考研|推免/, ['stance', 'progress']],
  [/住哪|住在|老家|哪里人|籍贯/, ['residence']],
  [/学校|大学|学院|哪个系/, ['school']],
  [/专业|工作|职业|干什么的/, ['job']],
  [/宠物|养了|猫|狗/, ['pet']],
  [/计划|打算|准备考|目标/, ['plan']],
  [/进度|学到哪|写到哪|做到哪/, ['progress']],
  [/课表|有课|什么课|哪节课|上课|几点的课|哪间教室|教室/, ['course']],
  [/技能|会什么|擅长/, ['skill']],
  [/态度|怎么看|觉得怎么样/, ['stance']]
];

/** 问法 → 主题。命中只加分，不改变「能不能查到」。 */
export const TOPIC_HINTS = [
  [/摄影|拍照|照片|相机|镜头/, ['t-photo']],
  [/极速谷|示例车厂|gt3|财富岛|赛车|车模/i, ['t-horizon6']],
  [/考研|华光|081200|832|初试|复试|计算机/, ['t-plan', 't-hust']],
  [/考研|推免|示例学院/, ['t-baoyan', 't-plan']],
  [/生日|称呼|名字|用户|身份/, ['t-identity']],
  [/助手|小助手|你自己|她的/, ['t-bot']],
  [/吃|饭|酸奶|火锅|外卖/, ['t-food']],
  [/作息|睡觉|早起|熬夜|几点睡/, ['t-routine']],
  [/课|作业|实验|考试|学业|学分/, ['t-study']],
  [/我们|一起|之间/, ['t-us']]
];

const OWNER_RE = /用户|我(?!们)|咱|俺|本人/;
const BOT_RE = /助手|小助手|她|你自己/;
const DAY_RE = /今天|今早|今晚|明天|明早|后天/;

// 纯日期工具（不依赖 schedule.mjs，避免 route 引入 fs）
const DAY_MS = 86400000;
function dayKey(ms) {
  const s = new Date(ms + 8 * 3600 * 1000);
  return s.toISOString().slice(0, 10);
}
function weekdayOfKey(key) {
  if (!key) return 0;
  const ms = Date.parse(key + 'T00:00:00+08:00');
  return ((Math.floor((ms + 8 * 3600 * 1000) / DAY_MS) + 4) % 7 + 7) % 7 || 7;
}

/** 中文二元组切词（与 scoring-runner 的 tokensOf 同源，这里只做「问法里出现了哪些词」）。 */
export function queryTokens(query = '') {
  const s = String(query || '').trim();
  if (!s) return [];
  const out = new Set();
  for (const part of s.replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/)) {
    if (!part) continue;
    if (/^[a-z0-9]+$/i.test(part)) {
      if (part.length >= 2) out.add(part.toLowerCase());
      continue;
    }
    for (let i = 0; i < part.length - 1; i += 1) out.add(part.slice(i, i + 2));
  }
  return [...out];
}

/**
 * @returns {{query:string,tokens:string[],slots:string[],topics:string[],subjects:string[],who:string,firstPerson:boolean}}
 *   who: 'owner' | 'bot' | ''
 */
export function routeQuery(query = '', { now = Date.now() } = {}) {
  const q = String(query || '').trim();
  const slots = new Set();
  const topics = new Set();
  for (const [re, list] of SLOT_HINTS) if (re.test(q)) list.forEach((x) => slots.add(x));
  for (const [re, list] of TOPIC_HINTS) if (re.test(q)) list.forEach((x) => topics.add(x));
  let who = '';
  if (OWNER_RE.test(q)) who = 'owner';
  else if (BOT_RE.test(q)) who = 'bot';
  // 科目维度：问「408 / 832 / 数一」时，命中 fact.subjects 的条目要排前面。
  const subjects = [...new Set((q.match(/\b(408|832|301|101|201)\b/g) || []).concat(/数一/.test(q) ? ['数一'] : []))];
  // 课表维度：问「明天/今天 有课吗」时，把相对日期解析成具体哪一天、周几。
  let day = '';
  if (DAY_RE.test(q)) {
    if (/后天/.test(q)) day = dayKey(now + 2 * DAY_MS);
    else if (/明天|明早/.test(q)) day = dayKey(now + DAY_MS);
    else day = dayKey(now);
  }
  return {
    query: q,
    tokens: queryTokens(q),
    slots: [...slots],
    topics: [...topics],
    subjects,
    who,
    day,
    weekday: day ? weekdayOfKey(day) : 0,
    schedule: /课表|有课|什么课|哪节课|上课|几点的课|第几周/.test(q),
    firstPerson: /^我|我记得|我当时|我说过/.test(q)
  };
}

/**
 * 单条事实的 route 得分（分项相加，调用方决定乘多少）。
 * @returns {{slotHit:boolean,topicHit:boolean,whoHit:boolean,expired:boolean,lexicalHits:number}}
 */
export function routeScore(fact, route) {
  const f = fact || {};
  const r = route || { slots: [], topics: [], tokens: [], who: '' };
  const slot = String(f.slot || '');
  const topic = String(f.topicId || '');
  const slotHit = r.slots.length > 0 && r.slots.includes(slot);
  const topicHit = r.topics.length > 0 && r.topics.includes(topic);
  const whoHit = Boolean(r.who) && String(f.about || '') === (r.who === 'owner' ? 'user' : 'bot');
  const expired = Boolean(f.expired);
  const qSubjects = Array.isArray(r.subjects) ? r.subjects : [];
  const subjects = Array.isArray(f.subjects) ? f.subjects.map(String) : [];
  const subjectHit = qSubjects.length > 0 && subjects.some((s) => qSubjects.includes(s));
  // 课表：问「明天有课吗」时，course.day 与那天周几一致才算命中。
  const course = f.course && typeof f.course === 'object' ? f.course : null;
  const courseDay = course ? Number(course.day || 0) : 0;
  const dayHit = Boolean(r.day) && courseDay > 0 && courseDay === Number(r.weekday || 0);
  const scheduleHit = Boolean(r.schedule) && slot === 'course';
  let lexicalHits = 0;
  if (r.tokens.length) {
    const hay = [f.text, f.value, f.label, f.sig, f.pattern]
      .filter((x) => typeof x === 'string' && x)
      .join('\n')
      .toLowerCase();
    for (const tk of r.tokens) if (hay.includes(String(tk).toLowerCase())) lexicalHits += 1;
  }
  return { slotHit, topicHit, whoHit, subjectHit, dayHit, scheduleHit, expired, lexicalHits };
}
