/**
 * 结构化字段迁移的「计划器」：只算「该补什么」，不写盘。
 *
 * 高精度优先：只有同时满足「槽位语义明确」和「值是单一对象」时才改 slot，
 * 其它情况（例如「本学期课程：数理方法、体育、理论力学…」这种拼句）只进 review，
 * 让用户决定要不要拆成多条，绝不自动把一句话拆碎。
 *
 * 返回：[{ id, topicId, slot, entities?, reasons[] }]，以及 review 列表。
 */

import { extractEntities, mergeEntities } from './entities.mjs';

const COURSE_RE = /^(?:周|星期)[一二三四五六日天]|教室|教学楼/;
const COURSE_WORD_RE = /(?:课|教室|教学楼|学期|导论|基础|原理|概论)/;
const EXAM_RE = /初试|复试|拟招|招生|考试科目|分数线|考\s*\d{3}|自命题/;
const LISTY_RE = /本学期课程|课程[:：]|课业[:：]|包括|以及/;
/** 列表句：至少两个顿号，或显式「课程/课业：」。单个顿号（「数据结构与模式识别」）不算。 */
function isListy(value) {
  if (LISTY_RE.test(value)) return true;
  return (value.match(/、/g) || []).length >= 2;
}
const MAJOR_RE = /应用物理|计算机|电子信息|人工智能|示例专业|软件工程|自动化/;

/** 单条事实 → 迁移建议（不含写盘）。 */
export function planFieldUpdate(fact) {
  const value = String(fact.value || '');
  const text = String(fact.text || '');
  const entities = extractEntities(`${value} ${text}`, { about: fact.about });
  const merged = mergeEntities(fact.entities || null, entities);
  const reasons = [];
  let topicId = fact.topicId || '';
  let slot = fact.slot || '';

  // 1) 课表单条：一句课表（周几 + 时间/地点 + 课程），改成 course 槽位。
  if (COURSE_RE.test(value) && COURSE_WORD_RE.test(value) && !isListy(value)) {
    if (!(topicId === 't-study' && slot === 'course')) {
      topicId = 't-study';
      slot = 'course';
      reasons.push('课表单条→course');
    }
  }

  // 2) 考试情报：初试科目/拟招/分数线，从 intel 归到 exam（主题保持原样）。
  if (EXAM_RE.test(value) && !isListy(value) && slot !== 'exam') {
    slot = 'exam';
    reasons.push('考试情报→exam');
  }

  // 3) 已经带 major 语义、且是单一对象的，归到 major；拼句只进 review。
  if (MAJOR_RE.test(value) && !isListy(value) && slot !== 'major' && MAJOR_RE.test(value.slice(0, 20))) {
    // 只处理「专业/方向」是句子主干的短事实；长计划句仍留在 plan/stance。
    if (value.length <= 24 && /专业|方向|本科|考研/.test(value)) {
      slot = 'major';
      reasons.push('专业→major');
    }
  }

  const changed =
    (topicId && topicId !== (fact.topicId || '')) ||
    (slot && slot !== (fact.slot || '')) ||
    (merged && JSON.stringify(merged) !== JSON.stringify(fact.entities || null));

  if (!changed) return null;
  return {
    id: fact.id,
    topicId,
    slot,
    ...(merged ? { entities: merged } : {}),
    reasons: reasons.length ? reasons : ['补 entities']
  };
}

/** 需要人工看的：拼句（可能要拆条）、或槽位语义模棱两可。 */
export function planReview(fact) {
  const value = String(fact.value || '');
  const notes = [];
  if (isListy(value) && /课程|课业|课表/.test(value)) notes.push('课程拼句，建议拆成多条 course');
  if (MAJOR_RE.test(value) && value.length > 24 && !fact.slot?.includes('major')) notes.push('可能含 major，但句子不单一');
  if (!notes.length) return null;
  return { id: fact.id, topicId: fact.topicId || '', slot: fact.slot || '', value: value.slice(0, 120), notes };
}
