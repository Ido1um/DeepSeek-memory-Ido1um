import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-scale-"));
process.env.QQ_MEMORY_DIR = TMP;
const lt = await import("../src/longterm.mjs");

const stateDir = () => path.join(TMP, "state");
const eventsFile = () => path.join(stateDir(), "longterm.jsonl");
const invFile = () => path.join(stateDir(), "facts-invalidated.json");

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state", "longterm.jsonl"), "");
  return dir;
}
function write(dir, rows) {
  fs.writeFileSync(path.join(dir, "state", "longterm.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
function append(dir, rows) {
  fs.appendFileSync(path.join(dir, "state", "longterm.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
function fact(id, extra = {}) {
  return { ev: "fact", id, sig: "user:note:" + id, about: "user", label: "备注", value: "v-" + id, tier: "general", I: 0.8, s: 3, at: 1793000000000, ...extra };
}
function snapshot(facts) {
  return facts.map((f) => ({ id: f.id, status: f.status, tier: f.tier, I: f.I, hits: f.hits, versions: f.versions }));
}

test("索引与 materialize 等价（含 mention/tier/manual/supersede/作废/撤销）", () => {
  const dir = fresh("eq");
  const rows = [
    fact("a"), fact("b"), fact("c"),
    { ev: "mention", id: "a", hits: 2, s: 4.2, I: 0.9, at: 1793000100000 },
    { ev: "tier", id: "b", tier: "long", s: 12, at: 1793000200000 },
    { ev: "supersede", id: "c", value: "v2", versions: 2, at: 1793000300000 },
    fact("d", { tier: "hard", I: 1 }),
    { ev: "badHit", id: "d", at: 1793000400000 },
    { ev: "invalidate", id: "b", at: 1793000500000 },
    { ev: "reinstate", id: "b", at: 1793000600000 },
    { ev: "manual", id: "c", score: 66, tier: "long", at: 1793000700000 },
    { ev: "manualReset", id: "c", at: 1793000800000 }
  ];
  write(dir, rows);
  fs.writeFileSync(path.join(dir, "state", "facts-invalidated.json"), JSON.stringify({ d: { at: 1, by: "cli" } }));

  const viaMaterialize = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
  const viaIndex = lt.openIndex(dir).facts();
  assert.deepEqual(snapshot(viaIndex), snapshot(viaMaterialize));
  assert.equal(viaIndex.find((f) => f.id === "d").status, "invalidated");
  assert.equal(viaIndex.find((f) => f.id === "b").status, "active");
});

test("增量：只读新增字节，不重放全库", () => {
  const dir = fresh("inc");
  write(dir, Array.from({ length: 100 }, (_, i) => fact("i" + i)));
  const idx = lt.openIndex(dir);
  assert.equal(idx.facts().length, 100);
  const reads0 = idx.stats.reads;

  append(dir, Array.from({ length: 50 }, (_, i) => fact("n" + i)));
  const again = idx.facts();
  assert.equal(again.length, 150);
  assert.equal(idx.stats.reloads, 0, "增量不应触发全量重置");
  assert.ok(idx.stats.reads > reads0);
  assert.deepEqual(snapshot(again), snapshot(lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir))));
});

test("文件回滚变短时自动全量重置", () => {
  const dir = fresh("trunc");
  write(dir, Array.from({ length: 40 }, (_, i) => fact("t" + i)));
  const idx = lt.openIndex(dir);
  assert.equal(idx.facts().length, 40);

  write(dir, Array.from({ length: 5 }, (_, i) => fact("r" + i)));
  const after = idx.facts();
  assert.equal(after.length, 5);
  assert.ok(idx.stats.reloads >= 1);
});

test("墓碑撤销后状态回到 active，不被钉死", () => {
  const dir = fresh("inv");
  write(dir, [fact("x"), fact("y")]);
  fs.writeFileSync(path.join(dir, "state", "facts-invalidated.json"), JSON.stringify({ x: { at: 1 } }));
  const idx = lt.openIndex(dir);
  assert.equal(idx.facts().find((f) => f.id === "x").status, "invalidated");

  fs.writeFileSync(path.join(dir, "state", "facts-invalidated.json"), "{}");
  const after = idx.facts();
  assert.equal(after.find((f) => f.id === "x").status, "active");
});

test("性能：一万条事实首次折叠 + 后续命中缓存", () => {
  const dir = fresh("perf");
  const rows = [];
  for (let i = 0; i < 10000; i++) rows.push(fact("p" + i, { at: 1793000000000 + i }));
  write(dir, rows);

  const idx = lt.openIndex(dir);
  const t0 = Date.now();
  assert.equal(idx.facts().length, 10000);
  const firstMs = Date.now() - t0;

  const t1 = Date.now();
  for (let i = 0; i < 200; i++) idx.facts();
  const cachedMs = (Date.now() - t1) / 200;

  assert.ok(firstMs < 1500, `首次折叠太慢：${firstMs}ms`);
  assert.ok(cachedMs < 5, `缓存命中太慢：${cachedMs}ms/次`);
  console.log(`scale: 首次 ${firstMs}ms / 缓存 ${cachedMs.toFixed(2)}ms per call`);
});
