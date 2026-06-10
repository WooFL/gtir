import { test } from "node:test";
import assert from "node:assert/strict";
import { setFrontmatterFields } from "../src/frontmatter.mjs";

test("existing fence: replaces a present key, inserts a missing one, leaves others untouched", () => {
  const src = "---\ntitle: Search\ntags: [a]\n---\n\n# body\n";
  const out = setFrontmatterFields(src, { stale: true, last_synced_sha: "abc" });
  assert.match(out, /title: Search/);
  assert.match(out, /tags: \[a\]/);
  assert.match(out, /stale: true/);
  assert.match(out, /last_synced_sha: abc/);
  assert.match(out, /# body/);
  const out2 = setFrontmatterFields(out, { stale: false });
  assert.match(out2, /stale: false/);
  assert.ok(!/stale: true/.test(out2));
});

test("no fence: prepends a frontmatter block", () => {
  const out = setFrontmatterFields("# body only\n", { stale: false });
  assert.match(out, /^---\nstale: false\n---\n/);
  assert.match(out, /# body only/);
});

test("idempotent: same fields twice is byte-identical", () => {
  const once = setFrontmatterFields("---\na: 1\n---\nx\n", { stale: true });
  const twice = setFrontmatterFields(once, { stale: true });
  assert.equal(twice, once);
});

test("CRLF note: updates in place, no double fence, idempotent", () => {
  const src = "---\r\ntitle: T\r\n---\r\n\r\n# body\r\n";
  const out = setFrontmatterFields(src, { stale: true });
  // exactly one fence = exactly two lines that are just '---'
  assert.equal((out.match(/^---\s*$/gm) || []).length, 2, "still exactly one frontmatter fence");
  assert.match(out, /title: T/);
  assert.match(out, /stale: true/);
  assert.equal(setFrontmatterFields(out, { stale: true }), out, "idempotent on CRLF");
});
