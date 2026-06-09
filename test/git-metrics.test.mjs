import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitLog } from "../src/git-metrics.mjs";
import { DEFAULTS } from "../src/config.mjs";

test("parseGitLog splits commits and collects their files", () => {
  const text = "\x01aaa\nsrc/a.ts\nsrc/b.ts\n\n\x01bbb\nsrc/b.ts\n\n\x01ccc\n\n";
  const commits = parseGitLog(text);
  assert.equal(commits.length, 3);
  assert.deepEqual(commits[0], { hash: "aaa", files: ["src/a.ts", "src/b.ts"] });
  assert.deepEqual(commits[1], { hash: "bbb", files: ["src/b.ts"] });
  assert.deepEqual(commits[2], { hash: "ccc", files: [] });
});

test("parseGitLog ignores the leading empty chunk and blank lines", () => {
  const text = "\x01h1\nf1\n\n";
  assert.deepEqual(parseGitLog(text), [{ hash: "h1", files: ["f1"] }]);
});

test("parseGitLog returns [] for empty input", () => {
  assert.deepEqual(parseGitLog(""), []);
});

import { coChange } from "../src/git-metrics.mjs";

const commits = [
  { hash: "1", files: ["a.ts", "b.ts"] },
  { hash: "2", files: ["a.ts", "b.ts"] },
  { hash: "3", files: ["a.ts", "b.ts", "c.ts"] },
  { hash: "4", files: ["a.ts", "b.ts"] },
  { hash: "5", files: ["a.ts", "c.ts"] },
];

test("coChange emits pairs at or above minSupport with confidence", () => {
  const r = coChange(commits, null, { minSupport: 3, maxCommitFiles: 25 });
  const ab = r.pairs.find((p) => p.a === "a.ts" && p.b === "b.ts");
  assert.ok(ab, "a,b pair present");
  assert.equal(ab.count, 4);
  assert.equal(ab.confidence, 1);
  assert.equal(ab.callEdge, null);
  assert.ok(!r.pairs.some((p) => p.count < 3), "below-support pairs dropped");
  assert.equal(r.commitsScanned, 5);
});

test("coChange pair keys are order-independent (a,b == b,a)", () => {
  const r = coChange([{ hash: "1", files: ["z.ts", "a.ts"] }, { hash: "2", files: ["a.ts", "z.ts"] },
    { hash: "3", files: ["a.ts", "z.ts"] }], null, { minSupport: 3 });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].a, "a.ts");
  assert.equal(r.pairs[0].b, "z.ts");
  assert.equal(r.pairs[0].count, 3);
});

test("coChange skips mega-commits over maxCommitFiles", () => {
  const big = { hash: "big", files: ["a.ts", "b.ts", "x.ts", "y.ts"] };
  const r = coChange([big, big, big], null, { minSupport: 1, maxCommitFiles: 3 });
  assert.equal(r.skippedLargeCommits, 3);
  assert.equal(r.pairs.length, 0);
});

test("coChange dedupes a file repeated within one commit", () => {
  const r = coChange([
    { hash: "1", files: ["a.ts", "a.ts", "b.ts"] },
    { hash: "2", files: ["a.ts", "b.ts"] },
  ], null, { minSupport: 2 });
  const ab = r.pairs.find((p) => p.a === "a.ts" && p.b === "b.ts");
  assert.equal(ab.count, 2);            // 2 commits, not 3 (the repeat didn't double-count)
  assert.equal(ab.confidence, 1);       // freq(a)=2, freq(b)=2
});

import { hotspots } from "../src/git-metrics.mjs";

test("hotspots scores revisions x loc and ranks desc", () => {
  const commits = [
    { hash: "1", files: ["a.ts", "b.ts"] },
    { hash: "2", files: ["a.ts"] },
    { hash: "3", files: ["a.ts", "b.ts"] },
  ];
  const locMap = new Map([["a.ts", 100], ["b.ts", 400]]);
  const r = hotspots(commits, locMap, { top: 10 });
  assert.equal(r.files[0].file, "b.ts");
  assert.equal(r.files[0].revisions, 2);
  assert.equal(r.files[0].loc, 400);
  assert.equal(r.files[0].score, 800);
  assert.equal(r.files[1].file, "a.ts");
  assert.equal(r.files[1].score, 300);
});

test("hotspots skips files with no LOC entry (deleted/binary) and applies top", () => {
  const commits = [{ hash: "1", files: ["a.ts", "gone.ts"] }, { hash: "2", files: ["a.ts"] }];
  const locMap = new Map([["a.ts", 50]]);
  const r = hotspots(commits, locMap, { top: 1 });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].file, "a.ts");
  assert.ok(!r.files.some((f) => f.file === "gone.ts"));
});

test("hotspots skips mega-commits", () => {
  const big = { hash: "b", files: ["a.ts", "b.ts", "c.ts", "d.ts"] };
  const r = hotspots([big], new Map([["a.ts", 10]]), { top: 5, maxCommitFiles: 3 });
  assert.equal(r.files.length, 0);
  assert.equal(r.commitsScanned, 0);    // the only commit was a skipped mega-commit
});

test("coChange annotates callEdge from the supplied edgePairs set and sorts hidden coupling first", () => {
  const cc = [
    { hash: "1", files: ["a.ts", "b.ts"] }, { hash: "2", files: ["a.ts", "b.ts"] },
    { hash: "3", files: ["a.ts", "b.ts"] }, { hash: "4", files: ["a.ts", "b.ts"] },
    { hash: "5", files: ["m.ts", "n.ts"] }, { hash: "6", files: ["m.ts", "n.ts"] },
    { hash: "7", files: ["m.ts", "n.ts"] },
  ];
  const edgePairs = new Set(["a.ts\x00b.ts"]);
  const r = coChange(cc, edgePairs, { minSupport: 3 });
  const ab = r.pairs.find((p) => p.a === "a.ts");
  const mn = r.pairs.find((p) => p.a === "m.ts");
  assert.equal(ab.callEdge, true);
  assert.equal(mn.callEdge, false);
  assert.equal(r.pairs[0].a, "m.ts");
});

test("config has git-metrics defaults", () => {
  assert.equal(DEFAULTS.metricsWindow, 1000);
  assert.equal(DEFAULTS.cochangeMinSupport, 3);
  assert.equal(DEFAULTS.metricsMaxCommitFiles, 25);
});

import { edgePairsFromEdges, locLinesOf } from "../src/git-metrics-run.mjs";

test("edgePairsFromEdges builds order-independent pair keys from resolved call edges only", () => {
  const edges = [
    { kind: "calls", conf: "resolved", from_path: "b.ts", to_path: "a.ts" },
    { kind: "calls", conf: "dispatch", from_path: "a.ts", to_path: null, candidates: ["c.ts", "e.ts"] },
    { kind: "calls", conf: "ambiguous", from_path: "a.ts", to_path: "z.ts" },
    { kind: "calls", conf: "external", from_path: "a.ts", to_path: null },
    { kind: "imports", conf: "resolved", from_path: "a.ts", to_path: "d.ts" },
    { kind: "calls", conf: "resolved", from_path: "s.ts", to_path: "s.ts" },
  ];
  const set = edgePairsFromEdges(edges);
  assert.ok(set.has("a.ts\x00b.ts"));   // resolved (from b.ts -> a.ts)
  assert.ok(set.has("a.ts\x00c.ts"));   // dispatch candidate
  assert.ok(set.has("a.ts\x00e.ts"));   // dispatch candidate
  assert.ok(!set.has("a.ts\x00z.ts"));  // ambiguous excluded
  assert.ok(!set.has("a.ts\x00d.ts"));  // import excluded
  assert.equal(set.size, 3);
});

test("locLinesOf counts lines of text (newline-terminated and not)", () => {
  assert.equal(locLinesOf("a\nb\nc\n"), 3);
  assert.equal(locLinesOf("a\nb\nc"), 3);
  assert.equal(locLinesOf(""), 0);
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cochangeQuery, hotspotsQuery } from "../src/git-metrics-run.mjs";

function gitAvailable() { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }

test("cochange/hotspots over a real temp git repo", { skip: !gitAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-gm-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  try {
    git("init"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\n");
    writeFileSync(join(dir, "src", "b.ts"), "x\ny\nz\n");
    git("add", "-A"); git("commit", "-m", "c1");
    writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, "src", "b.ts"), "x\ny\nz\nw\n");
    git("add", "-A"); git("commit", "-m", "c2");
    writeFileSync(join(dir, "src", "a.ts"), "line1\n");
    writeFileSync(join(dir, "src", "b.ts"), "x\n");
    git("add", "-A"); git("commit", "-m", "c3");

    const cfg = { repo: dir, metricsWindow: 100, cochangeMinSupport: 2, metricsMaxCommitFiles: 25 };
    const cc = await cochangeQuery(cfg, {});
    const ab = cc.pairs.find((p) => p.a.endsWith("a.ts") && p.b.endsWith("b.ts"));
    assert.ok(ab, "a.ts/b.ts coupled");
    assert.equal(ab.count, 3);
    assert.equal(ab.callEdge, null);

    const hs = await hotspotsQuery(cfg, { top: 5 });
    assert.ok(hs.files.some((f) => f.file.endsWith("a.ts")), "a.ts is a hotspot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cochangeQuery returns an error (not a throw) on a non-git directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-nogit-"));
  try {
    const r = await cochangeQuery({ repo: dir }, {});
    assert.equal(r.error, "not a git repository (or git unavailable)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
