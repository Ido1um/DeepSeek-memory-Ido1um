#!/usr/bin/env node
// 发布前自检：在仓库里找不该出现的东西。
//
//   node scripts/scan-secrets.mjs            # 扫当前目录
//   node scripts/scan-secrets.mjs --dir ..   # 扫指定目录
//
// 退出码：0 = 干净，1 = 有命中。

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const root = path.resolve(dirFlag >= 0 ? args[dirFlag + 1] : process.cwd());

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'raw', 'state', 'logs', 'digests', 'shadow', 'scratch', '_private']);
const TEXT_EXT = /\.(mjs|js|cjs|ts|json|md|txt|yml|yaml|cmd|bat|ps1|vbs|html|css)$/i;

const PATTERNS = [
  { name: 'Windows 本机路径', re: /[A-Za-z]:\\\\(Users|work program|03生产)/ },
  { name: '会话 key 里的真实 QQ 号', re: /(?:private|group):\d{6,}/ },
  { name: '疑似令牌', re: /\b(?:[A-Fa-f0-9]{32,}|sk-[A-Za-z0-9]{20,}|token["'=:\s]{1,4}[A-Za-z0-9]{20,})/ },
  { name: '本机用户名', re: /C:\\Users\\(admin|administrator)\b/i },
  { name: '常见密钥字段', re: /"(?:consoleToken|apiKey|api_key|secret|password)"\s*:\s*"[^"$]{8,}"/ },
];

const findings = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name));
      continue;
    }
    if (!TEXT_EXT.test(e.name)) continue;
    if (e.name === 'scan-secrets.mjs') continue;
    if (/\.(png|jpg|jpeg|gif|webp)$/i.test(e.name)) continue;
    const file = path.join(dir, e.name);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      // 允许的自动生成内容：LICENSE / 版本号 / 截图文件名
      if (/^\s*(\/\/|#|\*)/.test(line) && /示例|example|例如/.test(line)) return;
      for (const p of PATTERNS) {
        if (p.re.test(line)) findings.push({ file: path.relative(root, file), line: i + 1, rule: p.name, text: line.trim().slice(0, 100) });
      }
    });
  }
}

walk(root);

if (!findings.length) {
  console.log('✓ 扫描干净：' + root);
  process.exit(0);
}
console.log(`✗ 命中 ${findings.length} 处：`);
for (const f of findings) console.log(`  ${f.file}:${f.line} [${f.rule}] ${f.text}`);
process.exit(1);
