import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-merge-"));
process.env.QQ_MEMORY_DIR = TMP;
const lt = await import("../src/longterm.mjs");
const card = await import("../src/card.mjs");

const DAY = 86400000;
const NOW = Date.now();

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state", "longterm.jsonl"), "");
  fs.writeFileSync(path.join(dir, "state", "facts-invalidated.json"), "{}");
  return dir;
}
const append = (dir, rows) =>
  fs.appendFileSync(path.join(dir, "state", "longterm.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const load = (dir) => lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
const fact = (id, extra = {}) => ({
  ev: "fact", id, sig: "user:hobby:" + id, key: "private:10001", about: "user",
  pattern: "hobby", label: "爱好", value: "v-" + id, text: "t-" + id, topic: "user:hobby",
  class: "pref", tier: "long", I: 0.85, s: 90, hits: 1, at: NOW - 2 * DAY, ...extra,
});

test("merge：源条目退场、目标条目记下并入了谁", () => {
  const dir = fresh("basic");
  append(dir, [fact("a"), fact("b")]);
  append(dir, [{ ev: "merge", id: "a", ids: ["b"], into: "a", at: NOW }]);
  const by = Object.fromEntries(load(dir).map((f) => [f.id, f]));
  assert.equal(by.a.status, "active");
  assert.deepEqual(by.a.mergedFrom, ["b"]);
  assert.equal(by.b.status, "merged");
  assert.equal(by.b.mergedInto, "a");
  assert.equal(by.b.value, "v-b", "源条目原文保留，不物理删");
});

test("merge：被并进来的条目不再进事实卡", () => {
  const dir = fresh("card");
  append(dir, [fact("a"), fact("b")]);
  append(dir, [{ ev: "merge", id: "a", ids: ["b"], into: "a", at: NOW }]);
  const built = card.buildCard(load(dir), { maxChars: 2000 });
  assert.ok(built.text.includes("v-a"), "目标条目在卡里");
  assert.ok(!built.text.includes("v-b"), "源条目不进卡");
});

test("merge：检索只回合并后的一条（源条目 status=merged 被过滤）", () => {
  const dir = fresh("search");
  append(dir, [fact("a"), fact("b")]);
  append(dir, [{ ev: "merge", id: "a", ids: ["b"], into: "a", at: NOW }]);
  const active = load(dir).filter((f) => f.status === "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].id, "a");
});

test("merge：可带 supersede 改写值/标签/原文，版本号 +1", () => {
  const dir = fresh("supersede");
  append(dir, [fact("a"), fact("b")]);
  append(dir, [{ ev: "supersede", id: "a", at: NOW, value: "摄影（Z8X、2875ZA）", label: "爱好", quote: "原话" }]);
  append(dir, [{ ev: "merge", id: "a", ids: ["b"], into: "a", at: NOW }]);
  const a = load(dir).find((f) => f.id === "a");
  assert.equal(a.value, "摄影（Z8X、2875ZA）");
  assert.equal(a.label, "爱好");
  assert.equal(a.quote, "原话");
  assert.equal(a.versions, 2);
});

test("merge：不存在的源 id 不报错、也不影响目标", () => {
  const dir = fresh("missing");
  append(dir, [fact("a")]);
  append(dir, [{ ev: "merge", id: "a", ids: ["nope"], into: "a", at: NOW }]);
  const a = load(dir).find((f) => f.id === "a");
  assert.equal(a.status, "active");
  assert.deepEqual(a.mergedFrom, ["nope"]);
});

test("merge：索引与全量重放结果一致", () => {
  const dir = fresh("index");
  append(dir, [fact("a"), fact("b"), fact("c")]);
  append(dir, [{ ev: "merge", id: "a", ids: ["b", "c"], into: "a", at: NOW }]);
  const full = load(dir).map((f) => ({ id: f.id, status: f.status }));
  const idx = lt.openIndex(dir).facts().map((f) => ({ id: f.id, status: f.status }));
  full.sort((x, y) => x.id.localeCompare(y.id));
  idx.sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(idx, full);
  lt.dropIndex(dir);
});

test("unmerge：拆开后源条目恢复普通事实，目标不再记它", () => {
  const dir = fresh("unmerge");
  append(dir, [fact("a"), fact("b")]);
  append(dir, [{ ev: "merge", id: "a", ids: ["b"], into: "a", at: NOW }]);
  append(dir, [{ ev: "unmerge", id: "b", at: NOW + 1000 }]);
  const by = Object.fromEntries(load(dir).map((f) => [f.id, f]));
  assert.equal(by.b.status, "active");
  assert.equal(by.b.mergedInto, "");
  assert.equal(by.b.value, "v-b");
  assert.deepEqual(by.a.mergedFrom, []);
});

test("unmerge：拆开后又进卡片与检索，索引与全量重放一致", () => {
  const dir = fresh("unmerge2");
  append(dir, [fact("a"), fact("b")]);
  append(dir, [{ ev: "merge", id: "a", ids: ["b"], into: "a", at: NOW }]);
  const before = card.buildCard(load(dir), { maxChars: 1500 });
  assert.ok(!before.text.includes("v-b"), "合并时 v-b 不该进卡");
  append(dir, [{ ev: "unmerge", id: "b", at: NOW + 1000 }]);
  const after = card.buildCard(load(dir), { maxChars: 1500 });
  assert.ok(after.text.includes("v-b"), "拆开后应回到卡片");

  const idx = lt.openIndex(dir).facts();
  const full = load(dir);
  const norm = (rows) => rows.map((r) => [r.id, r.status, r.value]).sort();
  assert.deepEqual(norm(idx), norm(full), "索引与全量重放必须一致");
});

test("unmerge：对没合并过的条目是 no-op（不改状态）", () => {
  const dir = fresh("unmerge3");
  append(dir, [fact("a")]);
  append(dir, [{ ev: "unmerge", id: "a", at: NOW }]);
  const a = load(dir).find((f) => f.id === "a");
  assert.equal(a.status, "active");
  assert.equal(a.mergedInto, "");
});
