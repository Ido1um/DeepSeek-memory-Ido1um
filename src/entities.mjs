/**
 * entities：事实里「提到了谁/哪个组织/哪里」的轻量结构化字段。
 *
 * 设计约束：
 * - 可选字段，缺了不影响任何旧读方；写入时由抽取器/自写事实顺带算出来。
 * - 只收「有名字或明确关系」的人、明确机构、明确地名，宁缺勿滥——
 *   抽不到就空着，不要拿「学校」「公司」这种泛称充数。
 * - 只做规则，不调模型：这类词表小、误判代价低（只用于检索加分与展示）。
 */

export const ENTITY_DEFAULTS = { maxPeople: 6, maxOrgs: 6, maxPlaces: 6 };

/** 明确关系/有名字的人。助手一侧只在「她」被点名时收，避免每条都带她。 */
const PEOPLE = ['用户', '助手', '小助手', '小助手'];

/** 家人的称呼也算明确关系（不带名字时也收，因为关系本身是信息）。 */
const KIN = ['妈妈', '爸爸', '爷爷', '奶奶', '外婆', '外公', '姐姐', '妹妹', '哥哥', '弟弟', '姑姑', '舅舅', '阿姨'];

/** 机构：先用已知清单兜底，再补「XX大学/学院/公司/中心」这类后缀。 */
const ORG_WORDS = ['华光', '示例大学', '示例学院', '示例学院', '示例单位', '示例单位', '融媒体中心', '学生会', '实验室'];

const ORG_SUFFIX_RE = /([\u4e00-\u9fa5A-Za-z0-9]{2,10}(?:大学|学院|中学|公司|集团|研究院|研究所|医院|银行|中心|部门))/g;

/** 地名：已知清单 + 「X省/X市/X区/X县」后缀。楼名（示例楼）不进 places，避免把校区细节当地名。 */
const PLACE_WORDS = ['示例省份', '示例城市', '示例省份', '示例城市', '示例城市', '北京', '上海', '广州', '深圳', '成都', '重庆', '南京', '杭州'];

const PLACE_SUFFIX_RE = /([\u4e00-\u9fa5]{2,8}(?:省|市|区|县|镇|岛))/g;

function uniq(list, max) {
  const out = [];
  for (const raw of list) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function scan(text, words) {
  const hit = [];
  for (const w of words) if (text.includes(w)) hit.push(w);
  return hit;
}

function scanRe(text, re) {
  const hit = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) hit.push(m[1]);
    if (hit.length > 12) break;
  }
  return hit;
}

/**
 * 从一段文本里抽实体。返回对象只包含非空数组；全空时返回 null（不写空字段）。
 * @param {string} text
 * @param {{about?: string, value?: string}} opts
 */
export function extractEntities(text, opts = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const people = uniq([...scan(t, PEOPLE), ...scan(t, KIN)], ENTITY_DEFAULTS.maxPeople);
  const orgs = uniq([...scan(t, ORG_WORDS), ...scanRe(t, ORG_SUFFIX_RE)], ENTITY_DEFAULTS.maxOrgs);
  const places = uniq([...scan(t, PLACE_WORDS), ...scanRe(t, PLACE_SUFFIX_RE)], ENTITY_DEFAULTS.maxPlaces);
  const out = {};
  if (people.length) out.people = people;
  if (orgs.length) out.orgs = orgs;
  if (places.length) out.places = places;
  if (!Object.keys(out).length) return null;
  return out;
}

/** 合并两组实体（去重、截断）。 */
export function mergeEntities(a, b) {
  const out = {};
  for (const k of ['people', 'orgs', 'places']) {
    const list = uniq([...(a?.[k] || []), ...(b?.[k] || [])], ENTITY_DEFAULTS[`max${k[0].toUpperCase()}${k.slice(1)}`] || 6);
    if (list.length) out[k] = list;
  }
  return Object.keys(out).length ? out : null;
}

/** 规范化外部传入的实体（迁移/工具/手工写入都走这里，防止写进脏结构）。 */
export function normalizeEntities(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ['people', 'orgs', 'places']) {
    if (!Array.isArray(raw[k])) continue;
    const list = uniq(
      raw[k]
        .map((x) => String(x || '').trim().slice(0, 24))
        .filter(Boolean),
      ENTITY_DEFAULTS[`max${k[0].toUpperCase()}${k.slice(1)}`] || 6
    );
    if (list.length) out[k] = list;
  }
  return Object.keys(out).length ? out : null;
}

/** 给卡片/工作台用的一行摘要：「人：用户；机构：华光；地：示例城市」。 */
export function entitiesLine(entities) {
  if (!entities) return '';
  const parts = [];
  if (entities.people?.length) parts.push(`人：${entities.people.join('、')}`);
  if (entities.orgs?.length) parts.push(`机构：${entities.orgs.join('、')}`);
  if (entities.places?.length) parts.push(`地：${entities.places.join('、')}`);
  return parts.join('；');
}
