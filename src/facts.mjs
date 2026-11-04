// 硬事实抽取 + 重要性信号。
//
// 硬事实（hard）：主语 + 硬词同时命中才算，例如「我生日 11 月 2 号」「以后叫我小助手」「你生日几号？」。
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

/** 里程碑词：第一次/头一回/首次 + 动作，用来记「人生第一次」这类事件。 */
const FIRST_RE = /(第一次|头一回|首次|头一次)[，,]?\s*([^，。！？；\n]{2,24})/;

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
  {
    key: 'nickname',
    label: '称呼',
    re: /(以后叫我|叫我|称呼我|称呼)/,
    // 「以后叫我小林」是用户给自己起称呼 → user；
    // 「以后叫你小林」靠 nearest 主语「你」判成 bot。
    implicitSubject: '我',
  },
  {
    key: 'residence',
    label: '住处',
    re: /(住址|住在|住哪|我住|家住)/,
    implicitSubject: '我',
    implicitWhen: /(^|[，,。])(我|咱|俺)/,
  },
  {
    key: 'job',
    label: '工作',
    re: /(工作单位|上班|职业|做哪行)/,
    valueMode: 'before', // 「我在工业软件公司上班」→ 值在硬词前面
  },
  {
    key: 'skill',
    label: '在学',
    re: /(在学(?!校|院|期|生|的)|正在学|开始学|学会|学习)/,
  },
  {
    // 宠物可以有多只：按「宠物 + 名字/种类」做键，不然养第二只会被当成同一只
    key: 'pet',
    label: '宠物',
    re: /(养了|养的|养只|养了只)/,
    multi: true,
  },
  {
    // 爱好可以有多件（摄影 / 骑车）：跟宠物一样按值做键
    key: 'hobby',
    label: '爱好',
    re: /(我(?:平时|平常|业余)?(?:玩|爱好|喜欢玩)|我爱好|爱好是)/,
    multi: true,
    implicitSubject: '我',
  },
  {
    // 器材：只认「我有一台 X / 我的相机是 X」这种明确陈述，值取型号片段
    key: 'gear',
    label: '器材',
    re: /(我有(?:一台|一部|一把|一块)?|我的(?:相机|镜头|吉他|琴|车|耳机|键盘|电脑)(?:是|叫)?)\s*([A-Za-z0-9][A-Za-z0-9\-\s+.]{1,20})/,
    multi: true,
    valueFrom: 2,
    implicitSubject: '我',
  },
  {
    // A1：身份（职业/角色）。只在「我…」句子里隐式归属，避免路人闲聊被抓
    key: 'role',
    label: '身份',
    re: /(官方)?(摄影师|记者|工程师|设计师|主持人|老师|医生|护士|教练|画师|编辑|运营|程序员)/,
    multi: true,
    implicitSubject: '我',
    implicitWhen: /(^|[，,。])(我|咱|俺)/,
  },
  {
    // A1：组织 / 部门。值在关键词前面（「学校融媒体部门」「摄影协会」）
    key: 'org',
    label: '组织',
    re: /(部门|社团|协会|工作室|学生会|融媒体中心|实验室|编辑部|志愿者队)/,
    valueMode: 'before',
    includeMatch: true,
    multi: true,
    implicitSubject: '我',
    implicitWhen: /(^|[，,。])(我|咱|俺)/,
  },
  {
    // 明确偏好：只抽「动词 + 具体对象」，对象太长/是代词就不记
    key: 'pref',
    label: '偏好',
    re: /(不喜欢|不爱吃|不吃|讨厌|受不了|爱吃|喜欢|最爱)/,
    soft: true,
  },
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

/** A4：元讨论词表 —— 聊「记忆系统本身」的话不该进 hard。 */
const META_RE = /(记忆|事实库|注入|提示词|prompt|方案|脚本|测试|回归|bug|补丁|版本|接口|部署|仓库|轮转|日终|抽取)/;
/** A4：未定事实（打算/还没/如果…）只降档，不丢弃。 */
const TEMPORAL_RE = /(还没|没有|打算|准备|计划|如果|要是|万一|想过|以后再说|再等等|之前)/;

/** 是不是在讨论记忆系统本身（带第一人称的句子不算，那是在说自己）。 */
export function isMeta(text = '') {
  const s = String(text || '');
  if (!META_RE.test(s)) return false;
  return !/(^|[，,。！？])(我|咱|俺)/.test(s);
}

/** 是不是未定/将来时（「我打算考华光」不该当既成事实）。 */
export function isTemporal(text = '') {
  return TEMPORAL_RE.test(String(text || ''));
}

/** A6：每个抽取模式的先验置信度（进 I 与写入门）。 */
export const PATTERN_CONFIDENCE = {
  birthday: 0.95, name: 0.95, nickname: 0.95,
  gear: 0.85, pet: 0.85,
  job: 0.8, residence: 0.8,
  role: 0.75, org: 0.75,
  skill: 0.7,
  pref: 0.65,
  note: 0.5
};

/** 取某个模式的置信度（未知模式给 0.7）。 */
export function confidenceOf(key = '') {
  return PATTERN_CONFIDENCE[String(key || '')] ?? 0.7;
}

export function aboutOf(subject) {
  const hit = SUBJECTS.find((s) => s.word === subject);
  return hit ? hit.about : 'user';
}

/** A3：值边界清理 —— 去掉代词/连接词/方位词/语气词与表情尾巴，统一长度。 */
export function cleanValue(raw = '', max = 16) {
  let v = String(raw || '');
  v = v.replace(/\[表情\d*\]/g, '').replace(/[\[\]【】「」“”\"]/g, '');
  v = v.replace(/^(我|你|他|她|咱|俺)(的)?/, '');
  v = v.replace(/^(有|是|作为|担任|当|在|于|叫|叫做)+/, '');
  v = v.replace(/^(官方)?(的)?/, '$1');
  v = v.replace(/(里面|里头|当中|上面|的话|那种|这类|这种|之类|什么的|等等)+$/g, '');
  v = v.replace(/^[的了在是有]+/, '');
  v = v.replace(/[，。！？；、,.!?;:\s]+$/g, '');
  v = v.replace(/^[，。！？；、,.!?;:\s]+/g, '');
  v = v.replace(/\s{2,}/g, ' ').trim();
  return v.length > max ? v.slice(0, max) : v;
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
  return cleanValue(rest, 16);
}

/** 从 pattern 结尾往前取一小段作为值（「我在X上班」「我在X工作」）。 */
function valueBefore(text, start) {
  const left = text.slice(Math.max(0, start - 18), start);
  // 切掉连接词/标点后取最后一段
  const parts = left.split(/[，。！？；、,.!?;:（）()\s]+/).filter(Boolean);
  let seg = parts.length ? parts[parts.length - 1] : '';
  seg = seg.replace(/^.*(?:我在|在|是|做|干|到|去)/, '');
  seg = seg.replace(/[的吧呀啊哦了呢哈嘛]+$/, '').trim();
  seg = cleanValue(seg, 16);
  if (seg.length < 2) return '';
  return seg;
}

/** 在 pattern 附近找主语：左右各 14/8 字内，按「离硬词最近」优先，同距长词优先。 */
function subjectNear(text, start, end) {
  const LEFT = 14;
  const RIGHT = 8;
  const left = text.slice(Math.max(0, start - LEFT), start);
  const right = text.slice(end, Math.min(text.length, end + RIGHT));
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

/** 疑问句不当事实（"你生日几号" 只算提问）。 */
const FEEL_RE = /(手生|不习惯|有点慌|慌|发紧|发干|发抖|紧张|舍不得|心疼|开心|高兴|委屈|怕|累|酸|麻|空落落|愣住|心跳)/;
const FEEL_CUT = /[，。！？；\n]/;

/** 从一句话里找出「当时的体感」短句（≤40 字，必须原文子串）。 */
export function feelOf(text) {
  const s = String(text || '');
  if (!s) return '';
  const idx = s.search(FEEL_RE);
  if (idx < 0) return '';
  const left = Math.max(0, s.lastIndexOf('，', idx) + 1, s.lastIndexOf('。', idx) + 1);
  let seg = s.slice(left);
  const cut = seg.search(FEEL_CUT);
  if (cut > 0) seg = seg.slice(0, cut);
  seg = seg.replace(/^[的了哦呀啊…\s唔嗯哎哈噢诶]+/, '').trim();
  if (seg.length < 4 || seg.length > 40) return '';
  if (!s.includes(seg)) return '';
  return seg;
}

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
  const seen = new Set();
  for (const p of PATTERNS) {
    // A2：同一模式在一句里出现多次（「我养了猫，还养了狗」）时逐条抽，最多 3 条
    const re = p.multi && !p.re.global ? new RegExp(p.re.source, p.re.flags + 'g') : p.re;
    const matches = re.global ? [...s.matchAll(re)] : (() => { const m = s.match(re); return m ? [m] : []; })();
    for (const m of matches.slice(0, 3)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    let sub = subjectNear(s, start, end);
    if (!sub && p.implicitSubject && (!p.implicitWhen || p.implicitWhen.test(s))) sub = SUBJECTS.find((x) => x.word === p.implicitSubject);
    if (!sub) continue;
    // A1：职业词必须是「身份陈述」，不能是「老师把PPT发我们」这种主语
    if (p.key === 'role') {
      const pre = s.slice(Math.max(0, start - 6), start);
      const post = s.slice(end, end + 4);
      const okPre = /(官方|是|有|作为|担任|一名|一位|一个|当)$/.test(pre) || /(^|[，,。])(我|咱|俺)/.test(pre);
      const okPost = /^(身份|职位|职务|头衔)/.test(post);
      if (!okPre && !okPost) continue;
    }
    let value = p.valueMode === 'before' ? valueBefore(s, start) : valueAfter(s, end);
    if (p.includeMatch) value = cleanValue(value + m[0], 20);
    // 「学校的融媒体部门」只是位置修饰，不算加入某个组织
    if (p.key === 'org' && /的/.test(s.slice(Math.max(0, start - 6), start))) continue;
    if (p.key === 'role') {
      value = cleanValue(value.replace(/(身份|职位|职务|头衔)$/, ''), 16);
      if (!value) value = cleanValue(m[0], 16);
    }
    // 器材这类靠捕获组取值的模式（值是型号，不在硬词后面那段里）
    if (p.valueFrom && m[p.valueFrom]) value = String(m[p.valueFrom]).trim();
    let label = p.label;
    if (p.key === 'pet') {
      // 「养你还是养的起的」→ 会抓到「起的」这种动词碎片，先挡掉
      value = value.replace(/^(只|条|个|只小|一条|一只)/, '').trim();
      if (!value || value.length > 10) continue;
      if (/^[起了得的了吧呢啊吗不没就好才]/.test(value)) continue;
      if (/[的了吧呢吗什么怎么]/.test(value)) continue;
    }
    if (p.soft) {
      // 偏好的取值：去掉「吃/喝/玩/看/打」这类泛动词，只留对象；
      // 「不喜欢/讨厌」与「喜欢」分成两个主题，避免把反话记成正向。
      const negative = /^(不|讨厌|受不了)/.test(m[0]);
      label = negative ? '不喜欢' : '喜欢';
      value = value.replace(/^(吃|喝|玩|看|买|用|打|做)/, '').trim();
      // 代词、指示词、半天说不出对象、半句话都不记
      if (!value || value.length > 10) continue;
      if (/^(这|那|这么|那么|这样|那样|这个|那个|你|他|她|我|就|才|还|也|都|是|的|了)/.test(value)) continue;
      if (/[吗呢吧什么怎么]/.test(value)) continue;
    }
    if (!value || VERBY_VALUE.test(value)) continue;
    // 「在学校/在学院/在学期/在学员/在学的…」不是技能；正则已挡，这里兜一道值检查
    if (p.key === 'skill' && /^[校院期生的]/.test(value)) continue;
    if (p.key === 'name' && sub.about === 'bot') {
      const around = s.slice(Math.max(0, start - 10), Math.min(s.length, end + 14));
      if (!BOT_NAME_OK.test(around) || BOT_NAME_BAD.test(around)) continue;
    }
    const parts = p.multi && /[、和与及]/.test(value)
      ? value.split(/[、和与及]+/).map((x) => cleanValue(x)).filter((x) => x.length >= 1).slice(0, 3)
      : [value];
    for (const val of parts) {
      const sigKey = p.key + '|' + sub.word + '|' + val;
      if (seen.has(sigKey)) continue;
      seen.add(sigKey);
      out.push({
        key: p.key,
        label,
        subject: sub.word,
        about: sub.about,
        pattern: label,
        value: val,
        soft: p.soft === true,
        multi: p.multi === true,
        text: s.length > 80 ? s.slice(0, 80) : s,
      });
    }
    }
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
const ATTRIBUTE_PATTERNS = new Set(['birthday', 'name', 'nickname', 'residence', 'job', 'skill', 'pet', 'hobby', 'gear', 'role', 'org']);
const LABEL_TO_KEY = { 生日: 'birthday', 名字: 'name', 称呼: 'nickname', 住处: 'residence', 工作: 'job', 在学: 'skill', 宠物: 'pet', 爱好: 'hobby', 器材: 'gear', 身份: 'role', 组织: 'org' };

/** 自指主语：这类主语不带进 sig/topic（保持老数据 `user:生日` 不变，免迁移）。 */
const SELF_SUBJECTS = new Set(['我', '咱', '俺', '用户', '你']);

/**
 * 主语槽（v8 修订）：只有「我妈 / 我爸 / 我家」这类非自指主语才进 sig/topic。
 * 不加这一层时「我妈生日」和「我生日」会落到同一个 `user:生日` 上，
 * 后一句会被当成前一句的「提及」，值被静默吞掉。
 */
const ACTION_AFTER_FIRST = /(用|跟|和|给|开|说|讲|发|听|见|做|画|写|唱|吃|去|来|骑|飞|抱|亲|摸|睡|喝|玩|打|跑|赢|输|送|露|哭|笑)/;

/**
 * 「第一次/头一回/首次 + 动作」这类里程碑。返回 { phrase, value, about } 或 null。
 * 只认陈述句；用户转述机器人的话（[引用 助手：…]）归到 bot。
 */
export function milestoneOf(text = '') {
  const s = String(text || '').trim();
  if (!s || isQuestion(s)) return null;
  const m = FIRST_RE.exec(s);
  if (!m) return null;
  const tail = String(m[2] || '');
  if (!tail || tail.length < 3 || !ACTION_AFTER_FIRST.test(tail)) return null;
  // 「之前/上次」类回忆不算首次
  if (/(之前|上次|以前|上次已经|早就算)/.test(s.slice(Math.max(0, m.index - 6), m.index + 4))) return null;
  const quoted = /\[(?:引用|回复)\s*([^：:\]]{1,20})[：:]([\s\S]*?)\]/.exec(s);
  const hit = String(m[0]).trim();
  const inQuote = quoted ? quoted[2].includes(hit) : false;
  const about = inQuote ? 'bot' : (/^[^，。]{0,12}我/.test(s) ? 'user' : 'bot');
  return { phrase: s.slice(m.index, Math.min(s.length, m.index + hit.length + 6)).trim(), value: cleanValue(tail, 24), about };
}

/** 用户转发/引用机器人原话里的里程碑（"[引用 助手：…第一次…]"），归到 bot。 */
export function quotedMilestones(text = '') {
  const out = [];
  const src = String(text || '');
  const re = /\[(?:引用|回复)\s*([^：:\]]{1,20})[：:]([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(src))) {
    const inner = String(m[2] || '').trim();
    if (!inner) continue;
    const ms = milestoneOf(inner);
    if (ms) out.push({ about: 'bot', value: ms.value, quote: inner.slice(0, 160), speaker: m[1] });
  }
  return out;
}

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
  { cls: 'persona', re: /(你是|你的人设|你的名字|你叫|自称|机器人|人设|设定)/ },
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
