import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ms-"));
process.env.QQ_MEMORY_DIR = TMP;
const facts = await import("../src/facts.mjs");
const run = await import("../src/scoring-runner.mjs");
const lt = await import("../src/longterm.mjs");

const dir = path.join(TMP, "d1");
fs.mkdirSync(path.join(dir, "state"), { recursive: true });
fs.writeFileSync(path.join(dir, "state", "longterm.jsonl"), "");

test("milestoneOf：认出「第一次 + 动作」，归属按主语/引用", () => {
  const a = facts.milestoneOf("说完了，第一次用这个声音讲话，有点不习惯");
  assert.equal(a.about, "bot");
  assert.ok(a.value.includes("声音"));
  const b = facts.milestoneOf("今天是我第一次用语音跟你说话");
  assert.equal(b.about, "user");
});

test("milestoneOf：疑问句、回忆、无动作都不算", () => {
  assert.equal(facts.milestoneOf("你第一次开口说话是什么时候？"), null);
  assert.equal(facts.milestoneOf("之前我从来没第一次到过这种地方"), null);
  assert.equal(facts.milestoneOf("第一次见面"), null);
});

test("classify：转述机器人里程碑（引用 + 疑问句）也能抽", () => {
  const r = run.classify("[引用 助手：说完了，第一次用这个声音讲话，有点不习惯]这不是你第一次用这个声音吧");
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].about, "bot");
  assert.equal(r.candidates[0].class, "event");
  assert.equal(r.candidates[0].tier, "long");
});

test("scanMilestones：扫原文补机器人自述，且按值去重", () => {
  const day = "2026-11-02";
  const raw = path.join(dir, "raw", "hot", day);
  fs.mkdirSync(raw, { recursive: true });
  const rows = [
    { ts: "2026-11-02T07:46:48.000Z", key: "private:10001", role: "assistant", text: "说完了，第一次用这个声音讲话，有点不习惯" },
    { ts: "2026-11-02T07:47:00.000Z", key: "private:10001", role: "assistant", text: "你第一次开口说话是什么时候？" },
    { ts: "2026-11-02T07:48:00.000Z", key: "private:10001", role: "user", text: "这是我第一次用语音" }
  ];
  fs.writeFileSync(path.join(raw, "private_10001.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const first = run.scanMilestones({ dir, day, now: Date.now() });
  assert.equal(first.added, 1, "只收 assistant 的陈述句里程碑");
  const again = run.scanMilestones({ dir, day, now: Date.now() });
  assert.equal(again.added, 0, "重复扫描不应重复入库");
  const active = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir)).filter((f) => f.status === "active");
  assert.equal(active.filter((f) => f.pattern === "first").length, 1);
});
