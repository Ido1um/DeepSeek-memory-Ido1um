import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-compact-"));
process.env.QQ_MEMORY_DIR = TMP;
const lt = await import("../src/longterm.mjs");
const cp = await import("../src/compact.mjs");

const DAY = 86400000;

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state", "longterm.jsonl"), "");
  return dir;
}
const log = (dir) => path.join(dir, "state", "longterm.jsonl");
const base = (dir) => path.join(dir, "state", "base.json");
const inv = (dir) => path.join(dir, "state", "facts-invalidated.json");
const append = (dir, rows) => fs.appendFileSync(log(dir), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const fact = (id, at, extra = {}) => ({ ev: "fact", id, sig: "user:note:" + id, about: "user", label: "备注", value: "v-" + id, tier: "general", I: 0.8, s: 3, at, ...extra });
const snap = (facts) => facts.map((f) => ({ id: f.id, status: f.status, tier: f.tier, I: f.I, hits: f.hits, versions: f.versions })).sort((a, b) => a.id.localeCompare(b.id));

function seed(dir) {
  const now = Date.now();
  const old = [];
  for (let i = 0; i < 60; i++) old.push(fact("o" + i, now - 200 * DAY + i));
  old.push({ ev: "mention", id: "o1", hits: 3, s: 5, at: now - 190 * DAY });
  old.push({ ev: "tier", id: "o2", tier: "long", s: 20, at: now - 180 * DAY });
  old.push({ ev: "invalidate", id: "o3", at: now - 170 * DAY });
  const recent = [fact("n1", now - 2 * DAY), { ev: "reinstate", id: "o3", at: now - DAY }];
  append(dir, [...old, ...recent]);
  return { old, recent };
}

test("压缩前后事实态完全一致，且文件变小", () => {
  const dir = fresh("eq");
  seed(dir);
  const before = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
  const plan = cp.planCompact(dir, { before: Date.now() - 90 * DAY });
  assert.ok(plan.drop.length > 0, "应有可折叠的旧事件");

  const res = cp.applyCompact(dir, { before: Date.now() - 90 * DAY });
  assert.equal(res.applied, true);
  assert.ok(fs.existsSync(base(dir)));
  const after = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
  assert.deepEqual(snap(after), snap(before));
  assert.ok(fs.statSync(log(dir)).size < plan.bytesBefore, "事件文件应变小");
});

test("压缩后索引与全量折叠一致（快照播种 + tail 增量）", () => {
  const dir = fresh("idx");
  seed(dir);
  cp.applyCompact(dir, { before: Date.now() - 90 * DAY });
  const viaIndex = lt.openIndex(dir).facts();
  const viaMat = lt.materialize(lt.readEvents(dir).rows, lt.readInvalidated(dir));
  assert.deepEqual(snap(viaIndex), snap(viaMat));
});

test("快照里的作废能被后续 reinstate 事件翻转", () => {
  const dir = fresh("flip");
  seed(dir);
  // o3 在快照里是 invalidated，tail 里有一条 reinstate
  cp.applyCompact(dir, { before: Date.now() - 90 * DAY });
  const facts = lt.openIndex(dir).facts();
  assert.equal(facts.find((f) => f.id === "o3").status, "active");
});

test("dry-run 不写任何文件", () => {
  const dir = fresh("dry");
  seed(dir);
  const beforeLog = fs.readFileSync(log(dir), "utf8");
  const plan = cp.applyCompact(dir, { before: Date.now() - 90 * DAY, dryRun: true });
  assert.equal(plan.applied, false);
  assert.equal(fs.readFileSync(log(dir), "utf8"), beforeLog);
  assert.equal(fs.existsSync(base(dir)), false);
});

test("重复压缩幂等：第二次没有可折叠事件", () => {
  const dir = fresh("idem");
  seed(dir);
  cp.applyCompact(dir, { before: Date.now() - 90 * DAY });
  const second = cp.applyCompact(dir, { before: Date.now() - 90 * DAY });
  assert.equal(second.applied, false);
  assert.equal(second.reason, "nothing-to-compact");
});

test("备份文件保留原事件流，可手工回滚", () => {
  const dir = fresh("bak");
  seed(dir);
  const original = fs.readFileSync(log(dir), "utf8");
  const res = cp.applyCompact(dir, { before: Date.now() - 90 * DAY });
  const bak = log(dir) + ".bak-" + res.stamp;
  assert.equal(fs.readFileSync(bak, "utf8"), original);
});
