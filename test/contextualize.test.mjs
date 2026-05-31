import { test } from "node:test";
import assert from "node:assert/strict";
import { syntheticPrefix, contextualizeChunk } from "../src/contextualize.mjs";

test("syntheticPrefix names the file and a symbol-ish first line", () => {
  const c = { path: "src/user.py", text: "def login(self, pw):\n    return ok" };
  const p = syntheticPrefix(c);
  assert.match(p, /src\/user\.py/);
  assert.match(p, /login/);
});

test("contextualizeChunk (synthetic) returns prefix + raw body, body unchanged", async () => {
  const c = { path: "a.ts", text: "export function f() { return 1; }" };
  const r = await contextualizeChunk(c, { contextTier: "synthetic" });
  assert.ok(r.embedText.startsWith(syntheticPrefix(c)));
  assert.ok(r.embedText.includes(c.text));
  assert.equal(r.text, c.text); // raw body preserved for snippets
});

test("contextualizeChunk honors a precomputed prefix (markdown chunks)", async () => {
  const c = { path: "p.md", text: "body text", prefix: "p.md › Title › Section" };
  const r = await contextualizeChunk(c, { contextTier: "synthetic" });
  assert.ok(r.embedText.startsWith("p.md › Title › Section\n"));
  assert.ok(r.embedText.includes("body text"));
  assert.equal(r.text, "body text"); // snippet stays raw
});

test("contextualizeChunk without prefix uses synthetic (code chunks unaffected)", async () => {
  const c = { path: "a.ts", text: "export function f() { return 1; }" };
  const r = await contextualizeChunk(c, { contextTier: "synthetic" });
  assert.ok(r.embedText.startsWith(syntheticPrefix(c)));
});
