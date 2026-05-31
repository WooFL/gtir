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
