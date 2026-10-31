// 硬事实抽取 + 重要性信号。
//
// 硬事实（hard）：主语 + 硬词同时命中才算，例如「我生日 11 月 2 号」「以后叫我助手」「你生日几号？」。
// 归属分两类：主语是我/我妈/我爸/用户 → about:"user"（用户的事）；主语是你 → about:"bot"（我的事）。
// 纯函数，不读盘。

/** 主语 → 归属。长词优先匹配（"我妈" 不能被 "我" 抢走）。 */
const SUBJECTS = [
  { word: '我妈', about: 'user', label: '我妈' },
  { word: '我爸', about: 'user', label: '我爸' },
  { word: '我家', about: 'user', label: '我家' },
  { word: '用户', about: 'user', label: '用户' },
  { word: '咱', about: 'user', label: '咱' },
  { word: '俺', about: 'user', label: '俺' },
  { word: '我', about: 'user', label: '我' },
  { word: '你', about: 'bot', label: '你' },
];

/** 硬词 → 取值方式。 */
const PATTERNS = [
  {
    key: 'birthday',
    label: '生日',
    re: /(生日)/,
  },
  {
    key: 'name',
    label: '名字',
    re: /(名字|全名|叫什么名?)/,
  },
  {
    key: 'nickname',
    label: '称呼',
    re: /(以后叫我|叫我|称呼我|称呼)/,
    implicitSubject: '我', // 用户给自己起称呼；「以后叫你 X」靠最近主语判 bot
  },
  {
    key: 'residence',
    label: '住处',
    re: /(住址|住在|住哪)/,
  },
  {
    key: 'job',
    label: '工作',
    re: /(工作单位|上班|职业|做哪行)/,
    valueMode: 'before',
  },
  {
    key: 'name',
    label: '名字',
    re: /^我叫/,
    implicitSubject: '我',
  },
  {
    key: 'nickname',
    label: '称呼',
    re: /(以后叫你|叫你)/,
    implicitSubject: '你',
  },
  { key: 'skill', label: '在学', re: /(在学|正在学|开始学|学会|学习)/ },
  { key: 'pet', label: '宠物', re: /(养了|养的|养只|养了只)/ },
];

const PUNCT = /[，。！？；、,.!?;:\n\r]/;

// ---- 防御：真实语料回放（2026-10-29，171 条 user 消息）里唯二误判的形态 ----
// 「我在想要不要直接把你的名字助手写进人设卡」→ 被抽成 bot:名字=助手写进人设卡
// 「如果我的生日是 9 月 5 日」→ 假设句，不能当事实
/** 假设 / 商量 / 计划：整句不抽。 */
const HYPOTHETICAL = /(要不要|用不用|该不该|我在想|我想(要不要|是不是)|如果|假如|假设|是不是|可不可以|能不能|打算|计划|考虑|还没决定)/;
/** 值里出现动词短语，说明是「把 X 写进 Y」，不是取值。 */
const VERBY_VALUE = /(写进|写成|改成|换成|改到|放到|加进|记成|弄成|设置成|设为|直接)/;
/** bot 的名字只认陈述句「你的名字是 X」「你叫 X」。 */
const BOT_NAME_OK = /(你的名字(是|叫)|你叫|你名字(是|叫))/;
/** 出现这些词说明在说“改名字/写进卡”，不是报名字。 */
const BOT_NAME_BAD = /(要不要|想|要|改|写进|换|设)/;

export function aboutOf(subject) {
  const hit = SUBJECTS.find((s) => s.word === subject);
  return hit ? hit.about : 'user';
}

/** 从 pattern 结尾往后取一小段作为值（去掉连接词，遇到标点截止，最多 16 字）。 */
function valueAfter(text, index) {
  let rest = text.slice(index);
  rest = rest.replace(/^[是为:：在叫做的\s]+/, '');
  const m = rest.match(PUNCT);
  if (m) rest = rest.slice(0, m.index);
  rest = rest.trim();
  rest = rest.replace(/^[只条了]+/, '');
  rest = rest.replace(/[吧呀啊哦了呢哈嘛]+$/, '');
  return rest.length > 16 ? rest.slice(0, 16) : rest;
}

/** 在 pattern 附近找主语：左右各 14/8 字，离硬词最近优先，同距长词优先。 */
function subjectNear(text, start, end) {
  const left = text.slice(Math.max(0, start - 14), start);
  const right = text.slice(end, Math.min(text.length, end + 8));
  const hits = [];
  for (const s of SUBJECTS) {
    const li = left.lastIndexOf(s.word);
    if (li >= 0) hits.push({ s, dist: left.length - (li + s.word.length), side: 0 });
    const ri = right.indexOf(s.word);
    if (ri >= 0) hits.push({ s, dist: ri, side: 1 });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.dist - b.dist || b.s.word.length - a.s.word.length || a.side - b.side);
  return hits[0].s;
}

/** 从硬词往前取值（「我在 X 上班」→ X）。 */
function valueBefore(text, start) {
  const left = text.slice(Math.max(0, start - 18), start);
  const parts = left.split(/[，。！？；、,.!?;:（）()\s]+/).filter(Boolean);
  let seg = parts.length ? parts[parts.length - 1] : '';
  seg = seg.replace(/^.*(?:我在|在|是|做|干|到|去)/, '');
  seg = seg.replace(/[的吧呀啊哦了呢哈嘛]+$/, '').trim();
  if (seg.length < 2) return '';
  return seg.length > 16 ? seg.slice(-16) : seg;
}

/** 疑问句不当事实（"你生日几号" 只算提问）。 */
export function isQuestion(text = '') {
  return /[？?]\s*$/.test(text) || /[吗呢]\s*[？?。]?$/.test(text) || /^(你|他|她)?[^，。]{0,6}(多少|几号|哪天|什么)/.test(text);
}

/**
 * 抽取硬事实。
 * @returns {Array<{key,label,subject,about,pattern,value,text}>}
 */
export function extractHardFacts(text = '') {
  const s = String(text || '');
  if (!s.trim() || isQuestion(s)) return [];
  if (HYPOTHETICAL.test(s)) return [];
  const out = [];
  for (const p of PATTERNS) {
    const m = s.match(p.re);
    if (!m) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    let sub = subjectNear(s, start, end);
    if (!sub && p.implicitSubject) sub = SUBJECTS.find((x) => x.word === p.implicitSubject);
    if (!sub) continue;
    const value = p.valueMode === 'before' ? valueBefore(s, start) : valueAfter(s, end);
    if (!value || VERBY_VALUE.test(value)) continue;
    if (p.key === 'name' && sub.about === 'bot') {
      const around = s.slice(Math.max(0, start - 10), Math.min(s.length, end + 14));
      if (!BOT_NAME_OK.test(around) || BOT_NAME_BAD.test(around)) continue;
    }
    out.push({
      key: p.key,
      label: p.label,
      subject: sub.word,
      about: sub.about,
      pattern: p.label,
      value,
      text: s.length > 80 ? s.slice(0, 80) : s,
    });
  }
  return out;
}

/** 重要性/可靠性信号：给 score.mjs 的 importanceOf 用。 */
export function detectSignals(text = '') {
  const s = String(text || '');
  const facts = extractHardFacts(s);
  return {
    facts,
    hard: facts.length > 0,
    explicitRemember: /(记住|别忘|不要忘|记一下|帮我记|记牢)/.test(s) && !/(记不住|不记得|没记住|记不清|记不得|无法.{0,3}记|不能.{0,3}记|记不下来)/.test(s),
    activeStatement: /^(我|咱|俺|用户)[^？?]{0,20}(是|叫|住|喜欢|讨厌|想要|怕|在)/.test(s),
    negative: /(不对|记错了|不是这样|别瞎记|谁跟你说的|没说过)/.test(s),
    question: isQuestion(s),
  };
}

// 固定属性型事实：同一主题的多次陈述应当互相覆盖（v8 版本链）
// 抽取器给的是中文 label（生日/名字/…），这里归一成稳定的英文 key 当主题。
const ATTRIBUTE_PATTERNS = new Set(['birthday', 'name', 'nickname', 'residence', 'job']);
const LABEL_TO_KEY = { 生日: 'birthday', 名字: 'name', 称呼: 'nickname', 住处: 'residence', 工作: 'job' };

/** 自指主语：这类主语不带进 sig/topic（保持老数据 `user:生日` 不变，免迁移）。 */
const SELF_SUBJECTS = new Set(['我', '咱', '俺', '主人', '你']);

/**
 * 主语槽（v8 修订）：只有「我妈 / 我爸 / 我家」这类非自指主语才进 sig/topic。
 * 不加这一层时「我妈生日」和「我生日」会落到同一个 `user:生日` 上，
 * 后一句会被当成前一句的「提及」，值被静默吞掉。
 */
export function subjectTag(subject = '') {
  const s = String(subject || '').trim();
  if (!s || SELF_SUBJECTS.has(s)) return '';
  return s;
}

/**
 * 主题键（v8 §3）：只有「固定属性」才归一成稳定主题，别的内容按 sig 独立。
 * 关键作用：改生日时新旧两条落在同一主题上，能由 supersede 顶掉旧值。
 * @param {string} _text 原始消息（保留给未来按内容推断主题）
 * @param {{about?:string, subject?:string, pattern?:string, sig?:string}} fact
 * @returns {string} 形如 `user:birthday` / `user:我妈:birthday` / `user:note:5ap6qt`
 */
export function topicOf(_text = '', fact = {}) {
  const about = fact.about || 'user';
  const tag = subjectTag(fact.subject);
  const prefix = tag ? `${about}:${tag}` : about;
  const pattern = fact.pattern || 'note';
  const key = LABEL_TO_KEY[pattern] || pattern;
  if (ATTRIBUTE_PATTERNS.has(key)) return `${prefix}:${key}`;
  return fact.sig || `${prefix}:${pattern}`;
}

// v8 §2 记忆分类：决定衰减规则与是否进卡（不是语义分类，只看「这句话是什么性质」）
const CLASS_RULES = [
  { cls: 'rule', re: /(以后|永远|不许|别再|不要再|必须|只能|禁止|不准|一定要)/ },
  { cls: 'persona', re: /(你是|你的人设|你的名字|你叫|自称|助手|人设|设定)/ },
  { cls: 'event', re: /(昨天|今天|刚才|上周|上个月|去了|发生|然后|后来|当时|那天)/ },
  { cls: 'pref', re: /(喜欢|讨厌|爱吃|不吃|最爱|受不了|怕|习惯)/ }
];

/**
 * 给一条候选事实定类。task 由 due 决定，identity 由硬事实决定，其余按句子性质。
 * @param {string} text
 * @param {{hard?:boolean, dueAt?:boolean}} flags
 * @returns {'rule'|'persona'|'identity'|'task'|'event'|'pref'|'note'}
 */
export function classOf(text = '', flags = {}) {
  if (flags.dueAt) return 'task';
  if (flags.hard) return 'identity';
  const s = String(text || '');
  for (const r of CLASS_RULES) if (r.re.test(s)) return r.cls;
  return 'note';
}
