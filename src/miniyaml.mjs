// 极简 YAML 读取：只为了拿 `~/.dsh/.credentials.yaml` 里 `refs:` 下面那几行。
//
// 为什么不用 js-yaml：整个包只想依赖 Node 内置模块，而这份文件是 DSH 自己写的，
// 结构固定（`refs:` + 两空格缩进的 `KEY: value`），不需要一个完整 YAML 解析器。
// 只在解析结果为空时，才退化成「全文按 KEY: value 兜底扫一遍」。

const KEY_RE = /^([A-Za-z0-9_.\-\/]+):\s*(.*)$/;

function unquote(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
    if (v.includes('\\')) {
      v = v
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }
  // 去掉行尾注释（只有「空格 + #」才算，避免把值里的 # 切掉）
  v = v.replace(/\s+#.*$/, '');
  return v.trim();
}

/**
 * 解析 YAML 里某个顶层段的键值对（只支持一层缩进，够用）。
 * @param {string} text YAML 文本
 * @param {string} section 段名，默认 `refs`
 * @returns {Record<string,string>}
 */
export function parseSection(text = '', section = 'refs') {
  const out = {};
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length;
    const body = raw.trim();
    const m = body.match(KEY_RE);
    if (!m) continue;
    const [, key, val] = m;
    if (indent === 0) {
      inSection = key === section;
      continue;
    }
    if (!inSection) continue;
    // 段内只认一层：出现更深缩进（说明是嵌套对象）就跳过
    if (indent > 2) continue;
    const v = unquote(val);
    if (v) out[key] = v;
  }
  if (Object.keys(out).length) return out;

  // 兜底：整份文件按 `KEY: value` 扫一遍（容忍格式变动）
  for (const raw of lines) {
    const m = raw.trim().match(KEY_RE);
    if (!m) continue;
    const v = unquote(m[2]);
    if (v) out[m[1]] = v;
  }
  return out;
}

/** 取单个 ref 的值（找不到返回空串）。 */
export function readRef(text = '', name = '') {
  const key = String(name || '').trim();
  if (!key) return '';
  const refs = parseSection(text, 'refs');
  return Object.prototype.hasOwnProperty.call(refs, key) ? String(refs[key]) : '';
}
