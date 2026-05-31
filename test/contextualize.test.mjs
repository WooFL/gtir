import { test } from "node:test";
import assert from "node:assert/strict";
import { syntheticPrefix, contextualizeChunk, pathTokens, ftsText } from "../src/contextualize.mjs";

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

test("pathTokens splits separators and camelCase, lowercased", () => {
  assert.equal(pathTokens("auth/jwt.ts"), "auth jwt ts");
  assert.equal(pathTokens("src/userApi.ts"), "src user api ts");
  assert.equal(pathTokens("edge/node_c.py"), "edge node c py");
});

test("ftsText boosts path+scope+decl ahead of the body; boost 0 = raw text", () => {
  const c = { path: "auth/jwt.ts", scope: ["TokenService"], text: "function verifyToken(t) {\n  return ok;\n}" };
  const boosted = ftsText(c, { bm25Boost: 2 });
  // head repeated twice, then the body
  assert.ok(boosted.includes("auth jwt ts"));
  assert.ok(boosted.includes("TokenService"));
  assert.ok(boosted.includes("verifyToken"));
  assert.equal((boosted.match(/auth jwt ts/g) || []).length, 2, "head repeated bm25Boost times");
  assert.ok(boosted.endsWith(c.text), "body comes last, unchanged");
  assert.equal(ftsText(c, { bm25Boost: 0 }), c.text, "boost 0 indexes raw text");
});
