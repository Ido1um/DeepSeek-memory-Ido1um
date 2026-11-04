// 规则「按会话只注入一次」的回归：判定函数 + 记账 + 哈希变化 + 轮数/压力兜底。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rules-inject-"));
process.env.QQ_MEMORY_DIR = TMP;
const rules = await import("../src/rules.mjs");
const store = await import("../src/store.mjs");

const RULES = "# 规则\n- 用户称呼：用户\n- 不许叫助手「小助手」\n";

function writeRules(text) {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, "rules.md"), text, "utf8");
}

test("always 模式每轮都带全文", () => {
  for (let i = 0; i < 5; i++) {
    const d = rules.decideRules({ mode: "always", sameSession: true, sameHash: true, turns: i });
    assert.equal(d.inject, true);
    assert.equal(d.reason, "always");
  }
});

test("session 模式：新会话带全文", () => {
  const d = rules.decideRules({ mode: "session", sameSession: false });
  assert.deepEqual(d, { inject: true, reason: "new-session" });
});

test("session 模式：同会话同规则且不超轮数 → 只发占位", () => {
  const d = rules.decideRules({ mode: "session", sameSession: true, sameHash: true, turns: 3, pressure: 0.2 });
  assert.deepEqual(d, { inject: false, reason: "session-once" });
  assert.ok(rules.RULES_PLACEHOLDER.includes("首条"));
});

test("session 模式：规则改过 → 重注全文", () => {
  const d = rules.decideRules({ mode: "session", sameSession: true, sameHash: false, turns: 1 });
  assert.deepEqual(d, { inject: true, reason: "rules-changed" });
});

test("session 模式：到 20 轮兜底重注（19 轮仍占位）", () => {
  assert.equal(rules.decideRules({ mode: "session", sameSession: true, sameHash: true, turns: 19 }).inject, false);
  assert.deepEqual(
    rules.decideRules({ mode: "session", sameSession: true, sameHash: true, turns: 20 }),
    { inject: true, reason: "turn-refresh" }
  );
});

test("压力口径 = 真实 token / 轮转阈值（700k → 420k 触发）", () => {
  assert.equal(rules.pressureRatio(419999, 700000) < 0.6, true);
  assert.equal(rules.pressureRatio(420000, 700000), 0.6);
  assert.equal(rules.pressureRatio(500000, 700000) > 0.6, true);
  assert.equal(rules.pressureRatio(123, 0), 0);
});

test("session 模式：压力 ≥ 轮转阈值的 60% 重注", () => {
  assert.equal(rules.decideRules({ mode: "session", sameSession: true, sameHash: true, turns: 2, pressure: 0.59 }).inject, false);
  assert.deepEqual(
    rules.decideRules({ mode: "session", sameSession: true, sameHash: true, turns: 2, pressure: 0.6 }),
    { inject: true, reason: "pressure" }
  );
});

test("rulesHash 随内容变化，空文件为空串", () => {
  writeRules(RULES);
  const h1 = rules.rulesHash(TMP);
  assert.match(h1, /^[0-9a-f]{8}$/);
  writeRules(RULES + "- 新增一条\n");
  const h2 = rules.rulesHash(TMP);
  assert.notEqual(h1, h2);
  writeRules("");
  assert.equal(rules.rulesHash(TMP), "");
});

test("记账：mark 后同会话命中，turns 自增，换会话不命中", () => {
  writeRules(RULES);
  const hash = rules.rulesHash(TMP);
  assert.equal(store.rulesInjectedFor("s-1"), null);
  store.markRulesInjected("s-1", hash);
  const rec = store.rulesInjectedFor("s-1");
  assert.equal(rec.hash, hash);
  assert.equal(rec.turns, 0);
  assert.equal(store.bumpRulesTurns("s-1"), 1);
  assert.equal(store.bumpRulesTurns("s-1"), 2);
  assert.equal(store.rulesInjectedFor("s-1").turns, 2);
  assert.equal(store.bumpRulesTurns("s-2"), 0);
  assert.equal(store.rulesInjectedFor("s-2"), null);
  assert.equal(store.rulesInfo().sessionId, "s-1");
});
