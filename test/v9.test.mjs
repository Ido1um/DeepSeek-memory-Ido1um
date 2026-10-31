// v9 修复回归：把 2026-10-31 审计里确认的 8 个 bug 钉住，防止改回去。
// 全部离线：临时目录 + 纯函数，不碰生产数据。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.mjs';
import * as lt from '../src/longterm.mjs';
import * as card from '../src/card.mjs';
import { trimLines } from '../src/rules.mjs';
import { assemble } from '../src/inject.mjs';
import { classify } from '../src/scoring-runner.mjs';
import { parseDue, reminderWindow } from '../src/due.mjs';
import { normalizeConfig, unknownScoringKeys } from '../src/score.mjs';

const DAY = 86400_000;
const NOW = Date.parse('2026-10-30T23:14:00+08:00');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-v9-'));
  const dir = path.join(root, 'data');
  process.env.QQ_MEMORY_DIR = dir;
  store.clearConfigCache();
  t.after(() => {
    delete process.env.QQ_MEMORY_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dir;
}

// ── 1. 状态缓存竞态：脏数据不能被 1.5s 缓存重载覆盖 ──────────────────────────
test('store：noteSession 后跨过 1.5s 缓存 TTL 也不会丢会话映射', async (t) => {
  tmp(t);
  store.noteSession('private:1', 'session-A', Date.now());
  assert.equal(store.getSessionInfo('private:1')?.sessionId, 'session-A');
  await new Promise((r) => setTimeout(r, 1650));
  // 旧实现：getState 在 1.5s 后用磁盘旧值（sessions:{}）覆盖内存，这里会变 null
  assert.equal(store.getSessionInfo('private:1')?.sessionId, 'session-A');
  store.flushMemoryState();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.getSessionInfo('private:1')?.sessionId, 'session-A');
});

// ── 2. tier 结算不动 lastAt（降档不能「回春」） ──────────────────────────────
test('longterm：tier 事件不重置 lastAt，只写 updatedAt', (t) => {
  const dir = tmp(t);
  const born = NOW - 100 * DAY;
  lt.appendEvent({ ev: 'fact', id: 'h1', sig: 'user:生日', about: 'user', pattern: '生日', tier: 'long', I: 0.5, s: 3, at: born, lastAt: born }, dir);
  lt.appendEvent({ ev: 'tier', id: 'h1', tier: 'general', s: 3, score: 8, at: NOW }, dir);
  const f = lt.materialize(lt.readEvents(dir).rows, []);
  assert.equal(f[0].tier, 'general');
  assert.equal(f[0].lastAt, born);
  assert.equal(f[0].updatedAt, NOW);
});

// ── 3. 工作台 ISO 时间戳：manual 只认事件时间，解析不出回落旧值而不是 now ─────
test('longterm：manual 事件兼容 ISO at；manualReset 同时还原 I 与 S', (t) => {
  const dir = tmp(t);
  const born = NOW - 50 * DAY;
  lt.appendEvent({ ev: 'fact', id: 'h2', sig: 'user:note', about: 'user', pattern: 'note', tier: 'general', I: 0.5, s: 3, at: born, lastAt: born }, dir);
  const manualAt = NOW - 17 * 3600e3;
  lt.appendEvent({ ev: 'manual', id: 'h2', tier: 'long', score: 78, s: 30, at: new Date(manualAt).toISOString() }, dir);
  let f = lt.materialize(lt.readEvents(dir).rows, [])[0];
  assert.equal(f.lastAt, manualAt, 'lastAt 必须是事件时间，不能是 now');
  assert.equal(f.s, 30);
  assert.equal(f.I, 0.78);

  lt.appendEvent({ ev: 'manualReset', id: 'h2', at: NOW - 3600e3 }, dir);
  f = lt.materialize(lt.readEvents(dir).rows, [])[0];
  assert.equal(f.manual, false);
  assert.equal(f.I, 0.5);
  assert.equal(f.s, 3, 'manualReset 也要把 S 还原');
  assert.equal(f.lastAt, NOW - 3600e3);
});

test('longterm：s:null 不被当成 0；update 改期清掉 notifiedAt', (t) => {
  const dir = tmp(t);
  lt.appendEvent({ ev: 'fact', id: 'h3', about: 'user', pattern: 'note', s: null, at: NOW - DAY, lastAt: NOW - DAY, task: true, due: '2026-11-01', dueAt: NOW }, dir);
  lt.appendEvent({ ev: 'notified', id: 'h3', at: NOW - 1000 }, dir);
  let f = lt.materialize(lt.readEvents(dir).rows, [])[0];
  assert.equal(f.s, 3);
  assert.equal(f.notifiedAt, NOW - 1000);
  lt.appendEvent({ ev: 'update', id: 'h3', due: '2026-11-09', dueAt: NOW + 10 * DAY, at: NOW }, dir);
  f = lt.materialize(lt.readEvents(dir).rows, [])[0];
  assert.equal(f.notifiedAt, 0, '改期后必须重新提醒');
  assert.equal(f.due, '2026-11-09');
});

// ── 4. sig/topic 纳入非自指主语 ────────────────────────────────────────────
test('classify：我妈生日与我生日不再撞同一个 sig/topic', () => {
  const mine = classify('我生日是11月12号').candidates[0];
  const mom = classify('我妈生日是11月2号').candidates[0];
  assert.equal(mine.sig, 'user:生日', '自指主语保持老 sig，免迁移');
  assert.equal(mine.topic, 'user:birthday');
  assert.equal(mom.sig, 'user:我妈:生日');
  assert.equal(mom.topic, 'user:我妈:birthday');
  assert.notEqual(mine.sig, mom.sig);
});

// ── 5. due：逾期提醒 / HH:mm / 非法日期拒绝 ─────────────────────────────────
test('due：过点不久的事项仍在逾期窗口内提醒，overdueMs=0 时回到老行为', () => {
  const parsed = parseDue('这周五要交报告', NOW);
  assert.equal(parsed.due, '2026-10-30');
  const fact = { task: true, dueAt: parsed.dueAt, notifiedAt: 0 };
  assert.equal(reminderWindow(fact, NOW, { overdueMs: 72 * 3600e3 }), true);
  assert.equal(reminderWindow(fact, NOW), false);
});

test('due：支持只写时刻 9:30；不存在的日期返回 null', () => {
  const t = parseDue('明天 9:30 交报告', NOW);
  assert.equal(t.hasTime, true);
  const d = new Date(t.dueAt);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
  assert.equal(parseDue('2026-02-30 交报告', NOW), null);
  assert.equal(parseDue('2026-13-01 交报告', NOW), null);
});

// ── 6. 卡：hard 不再被 used 重复扣额度 ──────────────────────────────────────
test('card：20 条硬事实能进 10 条以上（旧实现只进 6 条）', () => {
  const facts = [];
  for (let i = 0; i < 20; i += 1) {
    facts.push({
      id: `hd${i}`, about: 'user', tier: 'hard', class: 'note', score: 100,
      value: `${i}`.padStart(2, '0') + 'x'.repeat(160), lastAt: NOW - i * 1000
    });
  }
  const built = card.buildCard(facts, { maxChars: 2000, botMaxChars: 0 });
  assert.ok(built.included.length >= 10, `只进了 ${built.included.length} 条`);
  assert.ok(built.chars <= 2000);
});

// ── 7. trimLines：前缀截断 + 预算 0 返回空 ───────────────────────────────────
test('rules：trimLines 必须前缀截断（不能跳过超长行去捡后面的短行）', () => {
  // 预算 100、尾注预留 18：第 1 行（60）放得下；第 2 行（30）放不下；第 3 行（2）放得下。
  // 旧实现会跳过第 2 行、把第 3 行的 BB 捡回来 —— 那就不是原文前缀了。
  const text = ['A'.repeat(60), 'B'.repeat(30), 'BB', 'C'.repeat(60)].join('\n');
  const out = trimLines(text, 100);
  assert.ok(out.text.startsWith('A'.repeat(60)));
  assert.ok(!out.text.includes('BB'));
  assert.equal(trimLines('x'.repeat(150), 0).text, '');
  assert.equal(trimLines('x'.repeat(150), -5).text, '');
});

test('inject：卡超预算时保留前面的硬事实，不再让后面的短行插队', () => {
  const hard = Array.from({ length: 8 }, (_, i) => `· H${i} ` + 'x'.repeat(180));
  const soft = Array.from({ length: 20 }, (_, i) => `· S${i}`);
  const cardText = [...hard, ...soft].join('\n');
  const r = assemble({ rulesText: '', cardText, taskLines: [], retrievalLines: [] }, { rules: 600, card: 600, tasks: 200, retrieval: 500, total: 2500 });
  assert.ok(r.used.card <= 600);
  assert.match(r.text, /H0/);
  assert.match(r.text, /H1/);
  assert.doesNotMatch(r.text, /· S0/, '溢出后不能跳过硬事实去捡软事实');
});

// ── 8. 配置：扁平键别名生效 ─────────────────────────────────────────────────
test('score：halfLifeLong/promoteHits/promoteScore/demoteFloor 别名生效', () => {
  const c = normalizeConfig({ halfLifeLong: 7, halfLifeGeneral: 2, promoteHits: 5, promoteScore: 70, demoteFloor: 25 });
  assert.equal(c.halfLifeDays.long, 7);
  assert.equal(c.halfLifeDays.general, 2);
  assert.equal(c.promote.hits, 5);
  assert.equal(c.promote.score, 70);
  assert.equal(c.demoteLongFloor, 25);
  assert.deepEqual(unknownScoringKeys({ halfLifeTemp: 2, totallyUnknownKey: 1 }), ['totallyUnknownKey']);
});

// ── 9. 注入：规则/待办/检索每轮都装，卡只首轮 ────────────────────────────────
test('engine：四段注入不再只在注入卡那一轮出现', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-v9e-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    ownerQQ: '10001',
    memory: {
      enabled: true,
      dir: path.join(root, 'data'),
      windowDays: 7,
      dailyAt: '23:00',
      summary: { enabled: false },
      profile: { enabled: true, maxChars: 1500 },
      inject: { enabled: true }
    }
  }, null, 2));
  process.env.QQ_MEMORY_DIR = path.join(root, 'data');
  process.env.QQ_MEMORY_CONFIG = configPath;
  const { clearConfigCache } = await import('../src/config.mjs');
  clearConfigCache();
  store.clearConfigCache();
  t.after(() => {
    delete process.env.QQ_MEMORY_DIR;
    delete process.env.QQ_MEMORY_CONFIG;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { createMemoryEngine } = await import('../src/engine.mjs');
  const { createNullHost } = await import('../src/host.mjs');
  const rules = await import('../src/rules.mjs');
  store.noteSession('private:10001', 'session-k', Date.now());
  store.writeProfile('- 用户喜欢喝咖啡');
  rules.writeRules(process.env.QQ_MEMORY_DIR, '# 规则\n- 叫主人');

  const engine = createMemoryEngine({ host: createNullHost() });
  const first = engine.composePrompt('private:10001', 'session-k', '在吗');
  assert.match(first.text, /【规则/);
  assert.match(first.text, /长期记忆/);
  engine.commitInjections('private:10001', 'session-k', first);

  const second = engine.composePrompt('private:10001', 'session-k', '第二句');
  assert.match(second.text, /【规则/, '规则每轮都要在');
  assert.doesNotMatch(second.text, /【长期记忆/, '卡只在首轮注入');
});
