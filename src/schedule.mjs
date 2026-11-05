// 3.1 P6：课表与学期——让「明天上什么课」有结构化答案，而不是一段旧印象。
// 约定：日期字符串一律 YYYY-MM-DD（+08:00 本地日）；周几用 1=周一 … 7=周日。
import fs from 'node:fs';
import path from 'node:path';
import { ymd } from './timeparse.mjs';

export const WEEK_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const PARITY_LABEL = { all: '每周', odd: '单周', even: '双周' };
export const SCHEDULE_TOPIC = 't-schedule';

export const DEFAULT_SEMESTER = {
  id: '2026秋',
  name: '2026–2027 秋',
  from: '2026-08-31',
  to: '2027-01-03',
  weeks: 18,
  inferred: true,
  anchor: { date: '2026-11-05', week: 10, parity: 'even' },
};

const DAY_MS = 86400000;

export function dayMs(dateLike) {
  if (typeof dateLike === 'number') return dateLike;
  const s = String(dateLike || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00+08:00');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

export function dayKey(dateLike) {
  const ms = dayMs(dateLike);
  return Number.isFinite(ms) ? ymd(ms) : '';
}

export function weekdayOf(dateLike) {
  const ms = dayMs(dateLike);
  if (!Number.isFinite(ms)) return 0;
  // +08:00 下：1970-01-01 是周四（4）
  return ((Math.floor((ms + 8 * 3600 * 1000) / DAY_MS) + 4) % 7 + 7) % 7 || 7;
}

export function calendarPath(dir) {
  return path.join(String(dir), 'state', 'calendar.json');
}

export function readCalendar(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(calendarPath(dir), 'utf8'));
    const semesters = Array.isArray(raw?.semesters) ? raw.semesters : [];
    return { semesters: semesters.length ? semesters : [DEFAULT_SEMESTER] };
  } catch {
    return { semesters: [DEFAULT_SEMESTER] };
  }
}

export function writeCalendar(dir, data) {
  const file = calendarPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function semesterOn(dir, dateLike) {
  const key = dayKey(dateLike);
  const { semesters } = readCalendar(dir);
  for (const sem of semesters) {
    if (!sem?.from || !sem?.to) continue;
    if (key >= sem.from && key <= sem.to) return sem;
  }
  // 不在任何学期内：用缺省学期推算，但标明 inferred
  return { ...DEFAULT_SEMESTER, inferred: true };
}

export function weekOf(dateLike, semester) {
  const sem = semester || DEFAULT_SEMESTER;
  const from = dayMs(sem.from);
  const d = dayMs(dateLike);
  if (!Number.isFinite(from) || !Number.isFinite(d)) return 0;
  return Math.floor((d - from) / (7 * DAY_MS)) + 1;
}

export function parityOfWeek(week) {
  return week % 2 === 0 ? 'even' : 'odd';
}

// 课程事实的 course 字段归一化：day 1–7、start/end 'HH:MM' 或 ''、parity all|odd|even。
export function normalizeCourse(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const day = Number(raw.day || raw.dayOfWeek || 0);
  if (!(day >= 1 && day <= 7)) return null;
  const hhmm = (v) => {
    const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
    return m && Number(m[1]) < 24 ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : '';
  };
  const parity = ['all', 'odd', 'even'].includes(raw.parity) ? raw.parity : 'all';
  return {
    day,
    start: hhmm(raw.start),
    end: hhmm(raw.end),
    parity,
    weekFrom: Number(raw.weekFrom) > 0 ? Number(raw.weekFrom) : 1,
    weekTo: Number(raw.weekTo) > 0 ? Number(raw.weekTo) : 18,
    location: String(raw.location || '').slice(0, 24),
    semester: String(raw.semester || '').slice(0, 16),
    name: String(raw.name || '').slice(0, 24),
    timeUnknown: raw.timeUnknown === true || !hhmm(raw.start),
  };
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.length === 1) return CN_NUM[s] || 0;
  if (s[0] === '十') return 10 + (CN_NUM[s[1]] || 0);
  if (s[1] === '十') return (CN_NUM[s[0]] || 0) * 10 + (CN_NUM[s[2]] || 0);
  return 0;
}

// 从一句话里抽课程字段（只抽能确定的；抽不到返回 null 字段）。
export function parseCourse(text, { semester, now } = {}) {
  const t = String(text || '');
  const out = { day: 0, start: '', end: '', parity: 'all', weekFrom: 1, weekTo: 18, location: '', semester: '', timeUnknown: true };
  const dayHit = t.match(/(?:周|星期|礼拜)([一二三四五六日天])/);
  if (dayHit) out.day = dayHit[1] === '天' ? 7 : CN_NUM[dayHit[1]] || 0;
  if (!out.day) {
    if (/明天/.test(t)) out.day = weekdayOf((now || Date.now()) + DAY_MS);
    else if (/今天|今早/.test(t)) out.day = weekdayOf(now || Date.now());
  }
  if (/单周/.test(t)) out.parity = 'odd';
  else if (/双周/.test(t)) out.parity = 'even';
  const wk = t.match(/(\d{1,2})\s*[-–~到至]\s*(\d{1,2})\s*周/);
  if (wk) { out.weekFrom = Number(wk[1]); out.weekTo = Number(wk[2]); }
  if (/早八/.test(t)) out.start = '08:00';
  const hm = t.match(/(?:上午|早上|下午|晚上)?\s*(\d{1,2})[:：](\d{2})/);
  if (!out.start && hm && Number(hm[1]) < 24) out.start = `${String(hm[1]).padStart(2, '0')}:${hm[2]}`;
  if (!out.start) {
    const pt = t.match(/(?:上午|早上|下午|晚上)?\s*([一二三四五六七八九十]{1,2})\s*点/);
    if (pt) {
      const h = cnNum(pt[1]);
      const pm = /下午|晚上/.test(t);
      if (h > 0) out.start = `${String(pm && h < 12 ? h + 12 : h).padStart(2, '0')}:00`;
    }
  }
  const loc = t.match(/(?:在|于)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12}(?:教室|教学楼|楼|馆))\s*([A-Z]\s*\d{3})?/)
    || t.match(/(?:在|于)\s*([\u4e00-\u9fa5]{1,8})\s*([A-Z]\s*\d{3})/);
  if (loc) out.location = ((loc[1] || '') + (loc[2] || '')).replace(/\s+/g, '');
  out.semester = (semester && semester.id) || '';
  out.timeUnknown = !out.start;
  return normalizeCourse(out);
}

export function courseOf(fact) {
  return normalizeCourse(fact && fact.course);
}

// 某一天实际要上的课：周几匹配、周次在范围、单双周匹配、学期匹配；全部按 start 排序。
export function coursesOn(dir, dateLike, { facts } = {}) {
  const key = dayKey(dateLike);
  if (!key) return [];
  const sem = semesterOn(dir, key);
  const week = weekOf(key, sem);
  if (!(week >= 1 && week <= (Number(sem.weeks) || 18))) return [];
  const parity = parityOfWeek(week);
  const day = weekdayOf(key);
  const active = (facts || []).filter((f) => (f.status || 'active') === 'active' && f.course);
  const out = [];
  for (const f of active) {
    const c = normalizeCourse(f.course);
    if (!c || c.day !== day) continue;
    if (c.semester && sem.id && c.semester !== sem.id) continue;
    if (week < c.weekFrom || week > c.weekTo) continue;
    if (c.parity !== 'all' && c.parity !== parity) continue;
    out.push({ fact: f, course: c });
  }
  out.sort((a, b) => String(a.course.start || '99:99').localeCompare(String(b.course.start || '99:99')));
  return out;
}

export function courseLine(course, fallbackName = '') {
  const c = normalizeCourse(course);
  if (!c) return fallbackName;
  const time = c.start ? c.start + (c.end ? '–' + c.end : '') : '时间未记';
  const loc = c.location ? ' · ' + c.location : '';
  return `${WEEK_LABEL[c.day]} ${time}${c.parity !== 'all' ? ' ' + PARITY_LABEL[c.parity] : ''}${loc}`;
}

export function scheduleAnswer(dir, dateLike, { facts } = {}) {
  const key = dayKey(dateLike);
  const sem = semesterOn(dir, key);
  const week = weekOf(key, sem);
  const items = coursesOn(dir, key, { facts });
  const head = `${key} ${WEEK_LABEL[weekdayOf(key)]} · 第 ${week} 周（${parityOfWeek(week) === 'even' ? '双' : '单'}周）`;
  if (!items.length) return { text: `${head}：没有课。`, items: [] };
  const lines = items.map((it) => {
    const name = it.course.name || String(it.fact.value || '').split(/[：:]/)[0] || '课程';
    return `- ${name}｜${courseLine(it.course, name)}${it.course.start ? '' : '（时间未记）'}`.trim();
  });
  return { text: `${head}：\n${lines.join('\n')}`, items };
}

// 问法里的相对日期：今天/明天/后天；没有则 null。
export function dayHintOf(query, now = Date.now()) {
  const q = String(query || '');
  if (/后天/.test(q)) return dayKey(now + 2 * DAY_MS);
  if (/明天|明早/.test(q)) return dayKey(now + DAY_MS);
  if (/今天|今早|今晚/.test(q)) return dayKey(now);
  return '';
}

export function isScheduleQuery(query) {
  return /课表|有课|什么课|哪节课|上课|几点的课|第几周/.test(String(query || ''));
}
