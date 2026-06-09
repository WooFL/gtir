import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitLog } from "../src/git-metrics.mjs";

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
