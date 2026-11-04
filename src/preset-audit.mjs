// 预设折叠审计：确认 QQ 预设没有挂「对话压缩」组件（记忆 3.0 §17）。
//
// 背景：DSH 的 `compaction-basic` 会自动总结前文、`command-compact` 提供 /compact，
// 两者都会让「她那一侧的窗口上下文」被替换成摘要，破坏逐字原文。
// 这里只读文件、不修改任何配置，给工作台「折叠检测」和 doctor 共用。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PRESET_BASE = process.env.MEMORY_PRESET_BASE || '';

const FORBIDDEN = [
  { id: 'compaction-basic', re: /dsh-compaction-basic/ },
  { id: 'command-compact', re: /dsh-command-compact/ },
];

const PRESET_FILES = [
  'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
  'dsh/agent-presets/qq-chat/agent.cordis.yml',
  'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml',
  'plugins/qq-agent-presets/presets/qq-chat.patch.yml',
];

/**
 * @param {{base?:string, files?:string[]}} opts
 * @returns {{ok:boolean, hits:string[], files:Array<{path:string,exists:boolean,hits:string[]}>}}
 */
export function auditPresets({ base = DEFAULT_PRESET_BASE, files = PRESET_FILES } = {}) {
  const out = [];
  const allHits = new Set();
  for (const rel of files) {
    const full = path.join(base, rel);
    let text = '';
    let exists = false;
    try {
      text = fs.readFileSync(full, 'utf8');
      exists = true;
    } catch { /* 文件缺失按「未配置」处理，不算命中 */ }
    const hits = exists ? FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.id) : [];
    for (const h of hits) allHits.add(h);
    out.push({ path: rel, exists, hits });
  }
  return { ok: allHits.size === 0, hits: [...allHits], files: out };
}
