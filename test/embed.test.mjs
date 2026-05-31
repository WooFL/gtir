import { test } from "node:test";
import assert from "node:assert/strict";
import { embedTexts, l2normalize } from "../src/embed.mjs";

function fakeFetch(vectorsByText) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const embeddings = body.input.map((t) => vectorsByText[t] ?? [0, 0, 0]);
    return { ok: true, json: async () => ({ embeddings }) };
  };
}

test("l2normalize yields unit length", () => {
  const v = l2normalize([3, 4]);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
});

test("embedTexts batches and normalizes via injected fetch", async () => {
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 2,
    fetchImpl: fakeFetch({ a: [3, 4], b: [0, 5], c: [1, 0] }),
  };
  const vecs = await embedTexts(["a", "b", "c"], cfg);
  assert.equal(vecs.length, 3);
  for (const v of vecs) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
});

test("embedTexts truncates inputs to maxEmbedChars before sending", async () => {
  let seen = null;
  const captureFetch = async (_url, opts) => {
    seen = JSON.parse(opts.body).input;
    return { ok: true, json: async () => ({ embeddings: seen.map(() => [1, 0, 0]) }) };
  };
  const cfg = { model: "m", ollamaUrl: "http://x", embedBatch: 32, maxEmbedChars: 50, fetchImpl: captureFetch };
  const long = "x".repeat(5000);
  await embedTexts([long], cfg);
  assert.equal(seen[0].length, 50, "input must be truncated to maxEmbedChars");
});

import { contentHash } from "../src/embed.mjs";

test("contentHash: stable sha256 hex; differs by input", () => {
  const a = contentHash("hello world");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(contentHash("hello world"), a);      // deterministic
  assert.notEqual(contentHash("hello world!"), a);  // input-sensitive
});
