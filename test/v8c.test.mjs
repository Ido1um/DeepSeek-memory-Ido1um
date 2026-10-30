// v8 批 3：四段注入预算 + rules.md
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { INJECT_BUDGET, normalizeInject, assemble, estimateTokens } from '../src/inject.mjs';
import { ensureRules, readRules, rulesFile, rulesSection, trimLines, RULES_TEMPLATE } from '../src/rules.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v8c-'));
}

test('normalizeInject：夹住预算、默认关闭', () => {
  const d = normalizeInject({});
  assert.equal(d.enabled, false);
  assert.deepEqual(d.budget, INJECT_BUDGET);

  const wide = normalizeInject({ enabled: true, budget: { rules: 99999, card: -5, total: 10 } });
  assert.equal(wide.enabled, true);
  assert.equal(wide.budget.rules, 2000);
  assert.equal(wide.budget.card, 0);
  assert.equal(wide.budget.total, 200); // 下限 200
});

test('assemble：四段各自受预算约束，总长不超总预算', () => {
  const built = assemble(
    {
      rulesText: '【规则】\n' + '规则一行\n'.repeat(200),
      cardText: '【长期记忆（事实卡）】\n' + '· 卡片一行\n'.repeat(300),
      taskLines: Array.from({ length: 30 }, (_, i) => `· 2026-11-0${i % 9 + 1} 任务 ${i}`),
      retrievalLines: Array.from({ length: 30 }, (_, i) => `· [long] 相关 ${i}`)
    },
    INJECT_BUDGET
  );
  assert.ok(built.total <= INJECT_BUDGET.total, `总长 ${built.total} 应 ≤ ${INJECT_BUDGET.total}`);
  for (const sec of built.sections) {
    const cap = INJECT_BUDGET[sec.name];
    assert.ok(sec.chars <= cap, `${sec.name} ${sec.chars} 应 ≤ ${cap}`);
  }
});

test('assemble：硬事实在最前，预算再紧也留着', () => {
  const cardText = '【长期记忆（事实卡）】\n· 称呼：用户叫主公\n' + '· 很长的备注\n'.repeat(400);
  const built = assemble({ cardText, taskLines: [], retrievalLines: [] }, { ...INJECT_BUDGET, card: 120 });
  assert.ok(built.text.includes('主公'), '硬事实/首行不该被裁掉');
  assert.ok(built.text.length <= 140);
});

test('assemble：超总预算时先丢检索、再丢待办', () => {
  const built = assemble(
    {
      cardText: '【长期记忆（事实卡）】\n' + '· 卡片\n'.repeat(100),
      taskLines: ['· 2026-11-01 交报告'],
      retrievalLines: ['· [long] 相关记忆一', '· [long] 相关记忆二']
    },
    { rules: 0, card: 1200, tasks: 200, retrieval: 500, total: 400 }
  );
  const names = built.sections.map((s) => s.name);
  assert.ok(!names.includes('retrieval'), '检索段应先被丢掉');
  assert.ok(built.total <= 400 + 20);
});

test('trimLines：截断时保留标题并标注省略行数', () => {
  const src = ['# 标题', ...Array.from({ length: 50 }, (_, i) => `- 规则 ${i}`)].join('\n');
  const t = trimLines(src, 120);
  assert.ok(t.text.startsWith('# 标题'));
  assert.ok(t.chars <= 120);
  assert.ok(t.truncated > 0);
  assert.ok(t.text.includes('未展开'));
});

test('rules：模板生成一次、不覆盖人工修改；rulesSection 带标题', () => {
  const dir = tmpDir();
  assert.equal(readRules(dir), '');
  const first = ensureRules(dir);
  assert.equal(first.created, true);
  assert.equal(readRules(dir), RULES_TEMPLATE.trim());
  fs.writeFileSync(rulesFile(dir), '# 我自己的规则\n- 只叫主公\n', 'utf8');

  const second = ensureRules(dir);
  assert.equal(second.created, false);
  assert.ok(readRules(dir).includes('只叫主公'));

  const sec = rulesSection(dir, 600);
  assert.ok(sec.text.startsWith('【规则'));
  assert.ok(sec.text.includes('只叫主公'));
  assert.ok(sec.chars <= 600);
});

test('estimateTokens：1.4 字/token，误差在 20% 内', () => {
  const text = '主公'.repeat(700); // 1400 字
  const tok = estimateTokens(text);
  assert.ok(Math.abs(tok - 1000) / 1000 < 0.2, `估出 ${tok}，期望 ~1000`);
  assert.equal(estimateTokens(''), 0);
});
