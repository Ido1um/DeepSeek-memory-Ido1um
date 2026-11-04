#!/usr/bin/env node
// 发布前隐私扫描：确认仓库里没有本机路径、令牌、真实账号或私人词。
//
// 用法：
//   node scripts/scan-secrets.mjs            # 扫当前目录
//   node scripts/scan-secrets.mjs <dir>      # 扫指定目录
//   PRIVATE_WORDS="某某,某地" node scripts/scan-secrets.mjs
//
// 命中任何一条都以退出码 1 结束，方便接进 CI 或发布脚本。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist']);

// 允许出现在示例/测试里的占位账号（不是真实账号）
// 10001/10002：README 与测试夹具里的示例私聊对象
// 20002：测试夹具里的示例群号
const PLACEHOLDER_IDS = new Set(['10001', '10002', '20002', '123456']);

const RULES = [
  { name: 'Windows 用户目录', re: /[A-Za-z]:\\Users\\[^\\\s"']+/i },
  { name: '本机工作盘路径', re: /[A-Za-z]:\\(?:work|projects?|dev|code|src)\\[^\s"']+/i },
  { name: '本机绝对路径（正斜杠写法）', re: /[A-Za-z]:\/(?:work program|03生产|Users\/[^\/\s"']+)/i },
  { name: '会话 key 里的真实账号', re: /\b(?:private|group):(\d{5,12})\b/g, allow: (m) => PLACEHOLDER_IDS.has(m[1]) },
  { name: '疑似令牌（32+ 位十六进制）', re: /\b[0-9a-f]{32,}\b/i },
  { name: '疑似 API key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: '凭据赋值', re: /\b(?:api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i, allow: (m) => /process\.env|示例|your-|test-token|xxx|<.*>/i.test(m[0]) },
  { name: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const EXTRA = String(process.env.PRIVATE_WORDS || '')
  .split(/[,，\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function isText(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.subarray(0, n).includes(0)) return false;
    return true;
  } catch {
    return false;
  }
}

const hits = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (rel === 'scripts/scan-secrets.mjs' || rel === 'MANIFEST.json') continue;
  if (/(^|\/)\.workbench-token$/.test(rel)) {
    hits.push({ rel, line: 0, rule: '工作台令牌文件', sample: rel });
    continue;
  }
  if (!isText(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.allow && rule.allow(m)) continue;
      hits.push({ rel, line: i + 1, rule: rule.name, sample: String(m[0]).slice(0, 40) });
    }
    for (const word of EXTRA) {
      if (line.includes(word)) hits.push({ rel, line: i + 1, rule: 'PRIVATE_WORDS', sample: word });
    }
  }
}

if (!hits.length) {
  console.log(`隐私扫描通过：${walk(ROOT).length} 个文件，未发现本机路径/令牌/真实账号。`);
  process.exit(0);
}

console.error(`隐私扫描发现 ${hits.length} 处问题：`);
for (const h of hits.slice(0, 80)) console.error(`  ${h.rel}:${h.line}  [${h.rule}]  ${h.sample}`);
if (hits.length > 80) console.error(`  …还有 ${hits.length - 80} 处`);
process.exit(1);
