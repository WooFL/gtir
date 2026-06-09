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
