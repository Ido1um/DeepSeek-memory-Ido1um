// 写入门：候选事件真正落库前再过一层「配不配记」的筛子。
//
// 为什么单独一层：抽取器负责「能不能抽出来」（召回），这一层负责「值不值得写」（准入）。
// 两层分开的好处是——调宽/调窄抽取面时不用动准入规则，反过来也一样；
// 每条被挡住的原因会写进 logs/scoring.log，能直接看出「这个月挡了什么、是不是挡错」。
//
// 设计原则：只挡「明显不该进长期库」的，不追求把候选清空；宁可漏，不误记。
// 所有规则都是对文本/候选的纯函数，不读写文件、不依赖时间。
//
// v11（2026-11-03）起支持两种模式：
//   strict：保持旧行为——五类全部硬拦（默认，输出与旧版逐字节相同）
//   broad ：只拦「确定错」（quoted / meta），其余四类打标放行：
//           uncertain → conf 0.4
//           transient → class=chat（半衰期 0.5 天，不进卡不进检索）
//           botPref   → about=bot、private
//           thin      → conf 0.3
//           放行的候选进「候选池」，由日终归并继续收敛，不直接当事实。

/** 技术/元讨论：聊记忆系统本身、代码、配置、发布——不是关于这个人的长期事实。 */
const META = /(记忆|事实卡|注入|词表|正则|抽取|测试|脚本|方案|文档|仓库|接口|配置|日志|prompt|token|模型|版本|引擎|bug|修复|部署|依赖|代码|数据库|readme)/i;

/** 不确定/传闻：说了也不算数，先不写；等确认后再说是另一条。 */
const UNCERTAIN = /(可能|也许|好像|大概|说不定|估计|不确定|记不清|听说)/;

/** 转述/引用：里面是别人（多半是机器人自己）的话，不能当用户陈述。 */
const QUOTED = /(\[引用|\[转发|\[回复)/;

/** 临时状态：睡醒、吃饭、累、天气——过了就过了，不进长期库。 */
const TRANSIENT = /^(晚安|早安|午安|我去睡|吃了|吃饭|饿了|困了|好累|好困|下雨了|今天好热|今天好冷)/;

/** 备注去噪后至少要有这么多字；从 4 放宽到 3（「怕冷」这类短备注值得留）。 */
const NOTE_MIN_CHARS = 3;
/** 偏好对象至少 2 个字（「火锅」可以，「鱼」勉强，「嗯」不行）。 */
const PREF_MIN_CHARS = 2;

const R = {
  quoted: '转述/引用，不是本人的陈述',
  meta: '技术/元讨论，不是长期事实',
  uncertain: '不确定或传闻，先不写',
  transient: '临时状态，不值得长期记',
  botPref: '机器人的口味属于扮演，不是用户事实',
  thin: '内容太薄，记了也用不上'
};

/** 原因码 → 处置档：block 丢、mark 打标放行（仅 broad 模式）。 */
export const GATE_TIERS = {
  quoted: 'block',
  meta: 'block',
  uncertain: 'mark',
  transient: 'mark',
  botPref: 'mark',
  thin: 'mark'
};

/** broad 模式下 mark 类的默认处置（调用方可再覆盖）。 */
export const GATE_MARKS = {
  // 不确定：降置信，不改类目（「好像喜欢辣」仍是偏好，只是别当真）
  uncertain: { conf: 0.4 },
  // 临时状态：单独归 chat 类、temp 档，半天就淡出，永不进卡/检索
  transient: { conf: 0.2, classHint: 'chat', tierHint: 'temp' },
  botPref: { conf: 0.3, aboutHint: 'bot', privateHint: true },
  thin: { conf: 0.3 }
};

export function gateModeOf(cfg = {}) {
  return cfg && cfg.gateMode === 'broad' ? 'broad' : 'strict';
}

/**
 * @returns {{ok:true, reason:''}
 *   | {ok:false, reason:string, detail:string}
 *   | {ok:true, mark:true, reason:string, detail:string, conf:number,
 *      classHint?:string, tierHint?:string, aboutHint?:string, privateHint?:boolean}}
 */
export function writeGate(text, candidate, { cfg } = {}) {
  const enabled = cfg?.writeGate !== false;
  if (!enabled) return { ok: true, reason: '' };
  const mode = gateModeOf(cfg);

  const t = String(text ?? '').trim();
  const c = candidate || {};
  const cls = c.class || 'note';
  const value = String(c.value ?? '').trim();
  const reject = (reason) => ({ ok: false, reason, detail: R[reason] || reason });
  const mark = (reason) => ({
    ok: true,
    mark: true,
    reason,
    detail: R[reason] || reason,
    ...(GATE_MARKS[reason] || { conf: 0.3 })
  });

  // 空文本两种模式都算薄：broad 下 thin 也放行（进池），strict 仍是拒绝
  if (!t) return mode === 'broad' ? mark('thin') : reject('thin');

  // 1) 引用的内容不是用户自己说的
  if (QUOTED.test(t)) return reject('quoted');

  // 2) 聊系统的技术话，不写。待办不再一律豁免（2026-11-04 实测：「复习傅立叶…是上个星期四的事了」
  //    这类元讨论被当成待办，还带着「记忆/时间戳」词）；只有明确叮嘱（记住/提醒我）且不含
  //    强元信息词时才放行。
  const REMIND = /记住|别忘了|提醒我|记一下/;
  const META_STRONG = /(记忆|事实卡|注入|轮转|检索|时间戳|词表|正则|抽取|评分|衰减)/;
  const taskExempt = cls === 'task' && REMIND.test(t) && !META_STRONG.test(t);
  if (!taskExempt && META.test(t)) return reject('meta');

  // 3) 机器人自己的口味/习惯是扮演出来的，不写进用户事实
  if (cls === 'pref' && c.about === 'bot') {
    return mode === 'broad' ? mark('botPref') : reject('botPref');
  }

  // 4) 不确定的话不写；「记住…」这种明确叮嘱仍放行
  if (cls !== 'note' && UNCERTAIN.test(t)) {
    return mode === 'broad' ? mark('uncertain') : reject('uncertain');
  }

  // 5) 临时状态
  if (cls !== 'task' && TRANSIENT.test(t)) {
    return mode === 'broad' ? mark('transient') : reject('transient');
  }

  // 6) 内容太薄
  if (cls === 'pref' && value.length < PREF_MIN_CHARS) {
    return mode === 'broad' ? mark('thin') : reject('thin');
  }
  if (cls === 'task' && value.length < NOTE_MIN_CHARS) {
    return mode === 'broad' ? mark('thin') : reject('thin');
  }
  if (cls === 'note' && value.length < NOTE_MIN_CHARS) {
    return mode === 'broad' ? mark('thin') : reject('thin');
  }

  return { ok: true, reason: '' };
}

/** 给统计/日志用：所有原因码和中文说明。 */
export const GATE_REASONS = R;
