// 到期日解析：把「下下个星期一」「11 月 9 日」「明天下午三点」解析成确定的日期。
//
// 为什么单独一个文件：这是纯函数、规则明确、可穷举测试；放进 scoring-runner 会把
// 「抽事实」和「算日期」两件事搅在一起，出问题也不好定位。
//
// 支持：
//   · 绝对日期  2026-11-09 / 2026年11月9日 / 11月9日 / 11/9
//   · 相对日    今天 / 明天 / 后天 / 大后天 / 三天后
//   · 星期      （这|本|下|下下）(个)?(星期|周|礼拜)(一..日|天|1..7)
//   · 时刻      （上午|早上|中午|下午|晚上|夜里）N点(半|:MM)  —— 不写时刻默认 09:00
// 解析不出就返回 null（调用方保持原样，不要瞎猜）。

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };

const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 前缀必须包含「上上 / 上」：2026-11-04 说「上个星期四」是 10-29（过去），
// 不带前缀会被当成「下一个星期四」算成 11-05，这是 11-03 那次假待办的直接原因。
const WEEK_RE = /(上上|下下|上|下|这|本)?\s*个?\s*(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/;
const REL = [
  [/大后天/, 3], [/后天/, 2], [/明天|明日/, 1],
];
const MONTH_DAY_RE = /(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?/;
const MD_SHORT_RE = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/;
const TIME_RE = /(上午|早上|中午|下午|晚上|夜里)?\s*([0-9]{1,2}|[零一二三四五六七八九十两]{1,3})\s*[点时](?:\s*(半)|[:：]\s*(\d{2}))?/;
/** 只写时刻不写「点」：9:30 / 21:05（不能把日期里的 - 当分隔符）。 */
const BARE_CLOCK_RE = /(?<!\d)(\d{1,2})\s*[:：]\s*(\d{2})(?!\d)/;

// 中文数字：三点、十二点、两天后、三天后 —— 只处理 0–99，够用
function cnNum(s) {
  if (/^[0-9]+$/.test(s)) return Number(s);
  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s.length === 1) return s === '十' ? 10 : map[s] ?? NaN;
  if (s[0] === '十') return 10 + (map[s[1]] ?? 0);
  if (s[1] === '十') return (map[s[0]] ?? 0) * 10 + (map[s[2]] ?? 0);
  return NaN;
}

function applyTime(day, text) {
  const m = text.match(TIME_RE);
  const bare = !m ? text.match(BARE_CLOCK_RE) : null;
  const d = new Date(day);
  if (!m && !bare) { d.setHours(9, 0, 0, 0); return { at: d, hasTime: false }; }
  let hour; let minute;
  if (m) {
    const word = m[1] || '';
    hour = cnNum(m[2]);
    minute = m[3] ? 30 : (m[4] ? Number(m[4]) : 0);
    if ((word === '下午' || word === '晚上' || word === '夜里') && hour < 12) hour += 12;
    if (word === '中午' && hour < 11) hour += 12;
  } else {
    hour = Number(bare[1]);
    minute = Number(bare[2]);
  }
  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    d.setHours(9, 0, 0, 0);
    return { at: d, hasTime: false };
  }
  d.setHours(hour, minute, 0, 0);
  return { at: d, hasTime: true };
}

export function parseDue(text, now = Date.now()) {
  const s = String(text || '');
  if (!s) return null;
  const today = startOfDay(now);

  // 1) 绝对日期（带年 / 不带年；不带年且已过则算明年）
  let year = null; let month = null; let day = null; let phrase = '';
  let m = s.match(MONTH_DAY_RE);
  if (m) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
    phrase = m[0].trim();
  } else if ((m = s.match(MD_SHORT_RE))) {
    month = Number(m[1]); day = Number(m[2]);
    phrase = m[0].trim();
  }
  if (month && month >= 1 && month <= 12 && day && day >= 1 && day <= 31) {
    const y = year || today.getFullYear();
    let cand = new Date(y, month - 1, day);
    // JS 会把 2 月 30 日「顺延」成 3 月 2 日：这种不存在的日期宁可解不出，也不要瞎猜。
    if (cand.getFullYear() !== y || cand.getMonth() !== month - 1 || cand.getDate() !== day) return null;
    if (!year && cand < today) {
      const ny = y + 1;
      const nc = new Date(ny, month - 1, day);
      if (nc.getFullYear() === ny && nc.getMonth() === month - 1 && nc.getDate() === day) cand = nc;
    }
    const t = applyTime(cand, s);
    return { due: ymd(cand), dueAt: t.at.getTime(), phrase, hasTime: t.hasTime, source: 'date' };
  }

  // 2) 星期（这/本/下/下下 或无前缀）
  if ((m = s.match(WEEK_RE))) {
    const pre = m[1] || '';
    const target = WEEKDAY[m[2]];
    const dow = today.getDay() === 0 ? 7 : today.getDay(); // 1=Mon..7=Sun
    const monday = addDays(today, -(dow - 1));
    const thisWeek = addDays(monday, target - 1);
    let offset = 0;
    if (pre === '下') offset = 7;
    else if (pre === '下下') offset = 14;
    else if (pre === '上') offset = -7;
    else if (pre === '上上') offset = -14;
    let cand = addDays(thisWeek, offset);
    // 「上个星期四」可能是过去；只有无前缀的「星期四」才顺延到下一次。
    if (!pre && cand < today) cand = addDays(cand, 7);
    const t = applyTime(cand, s);
    return { due: ymd(cand), dueAt: t.at.getTime(), phrase: m[0].trim(), hasTime: t.hasTime, source: 'week' };
  }

  // 3) 今天/明天/后天/大后天
  for (const [re, delta] of REL) {
    if (re.test(s)) {
      const cand = addDays(today, delta);
      const t = applyTime(cand, s);
      return { due: ymd(cand), dueAt: t.at.getTime(), phrase: (s.match(re) || [''])[0], hasTime: t.hasTime, source: 'relative' };
    }
  }

  // 4) N 天后
  const after = s.match(/([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*天\s*(?:以后|之后|后)/);
  if (after) {
    const cand = addDays(today, cnNum(after[1]));
    const t = applyTime(cand, s);
    return { due: ymd(cand), dueAt: t.at.getTime(), phrase: after[0], hasTime: t.hasTime, source: 'relative' };
  }

  return null;
}

// 该不该今天提醒：进入「截止前 24 小时」窗口，且没提醒过；过点后仍留一段逾期窗口
// （默认 72 小时，期间提醒会带「已逾期」），否则 23:14 说「这周五要交」这种当天已过的
// 事项会永远静默 —— 它确实还没被提醒过。
export function reminderWindow(fact, now = Date.now(), { horizonMs = 24 * 3600e3, graceMs = 12 * 3600e3, overdueMs = 0 } = {}) {
  if (!fact || !fact.dueAt || fact.notifiedAt || !fact.task) return false;
  const left = fact.dueAt - now;
  const back = Math.max(graceMs, overdueMs);
  return left <= horizonMs && left >= -back;
}

export { ymd, addDays, startOfDay };
